import { db } from '../db.js';
import { jellyfin, JfSession } from '../clients/jellyfin.js';
import { radarr, sonarr, RadarrMovie, SonarrEpisode, SonarrSeries } from '../clients/arr.js';

export class UserFacingError extends Error {}

export interface Link {
  discord_id: string;
  jellyfin_user_id: string;
  jellyfin_user_name: string;
}
export const getLink = (discordId: string) =>
  db.prepare('SELECT * FROM user_links WHERE discord_id = ?').get(discordId) as Link | undefined;

export type Resolved =
  | { kind: 'movie'; title: string; movie: RadarrMovie; session: JfSession; subtitle?: SubInfo }
  | { kind: 'episode'; title: string; series: SonarrSeries; episode: SonarrEpisode; session: JfSession; subtitle?: SubInfo };

export interface SubInfo {
  language?: string; // Jellyfin 3-letter code
  forced?: boolean;
  hi?: boolean;
  label: string;
}

function activeSubtitle(session: JfSession): SubInfo | undefined {
  const idx = session.PlayState?.SubtitleStreamIndex;
  if (idx === undefined || idx < 0) return undefined;
  const s = session.NowPlayingItem?.MediaStreams?.find((m) => m.Index === idx && m.Type === 'Subtitle');
  if (!s) return undefined;
  return { language: s.Language, forced: s.IsForced, hi: s.IsHearingImpaired, label: s.DisplayTitle ?? s.Language ?? 'subtitle' };
}

/** Work out which Radarr/Sonarr item a Discord user is currently watching in Jellyfin. */
export async function resolveNowPlaying(discordId: string): Promise<Resolved> {
  const link = getLink(discordId);
  if (!link) throw new UserFacingError('Your Discord account is not linked to a Jellyfin user yet. Use `/link` first.');
  const session = await jellyfin.nowPlaying(link.jellyfin_user_id);
  const item = session?.NowPlayingItem;
  if (!session || !item) throw new UserFacingError(`Nothing is playing for **${link.jellyfin_user_name}** in Jellyfin right now. Start the video, then run the command again.`);
  const subtitle = activeSubtitle(session);

  if (item.Type === 'Movie') {
    if (!radarr.configured) throw new UserFacingError('Radarr is not configured.');
    const tmdb = Number(item.ProviderIds?.Tmdb);
    let movie = tmdb ? await radarr.movieByTmdb(tmdb) : undefined;
    if (!movie && item.ProviderIds?.Imdb) movie = await radarr.movieByImdb(item.ProviderIds.Imdb);
    if (!movie) throw new UserFacingError(`**${item.Name}** isn't managed by Radarr, so I can't replace it.`);
    return { kind: 'movie', title: `${movie.title} (${movie.year})`, movie, session, subtitle };
  }

  if (item.Type === 'Episode') {
    if (!sonarr.configured) throw new UserFacingError('Sonarr is not configured.');
    let series: SonarrSeries | undefined;
    const sj = item.SeriesId ? await jellyfin.item(item.SeriesId) : undefined;
    const tvdb = Number(sj?.ProviderIds?.Tvdb);
    if (tvdb) series = await sonarr.seriesByTvdb(tvdb);
    if (!series && item.SeriesName) series = await sonarr.seriesByTitle(item.SeriesName);
    if (!series) throw new UserFacingError(`**${item.SeriesName ?? item.Name}** isn't managed by Sonarr, so I can't replace it.`);
    const eps = await sonarr.episodes(series.id);
    const episode = eps.find((e) => e.seasonNumber === item.ParentIndexNumber && e.episodeNumber === item.IndexNumber);
    if (!episode) throw new UserFacingError(`Couldn't find S${item.ParentIndexNumber}E${item.IndexNumber} of **${series.title}** in Sonarr.`);
    const code = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
    return { kind: 'episode', title: `${series.title} ${code} - ${episode.title}`, series, episode, session, subtitle };
  }

  throw new UserFacingError(`Playing item type **${item.Type}** isn't supported (only movies and TV episodes).`);
}
