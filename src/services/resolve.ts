import { radarr, sonarr, RadarrMovie, SonarrEpisode, SonarrSeries } from '../clients/arr.js';

export class UserFacingError extends Error {}

export type Resolved =
  | { kind: 'movie'; title: string; movie: RadarrMovie; subtitle?: SubInfo }
  | { kind: 'episode'; title: string; series: SonarrSeries; episode: SonarrEpisode; subtitle?: SubInfo };

export interface SubInfo {
  language?: string;
  label: string;
}

const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 60_000) return c.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** Autocomplete choices. Value is "m:<radarrId>" or "s:<sonarrSeriesId>". */
export async function searchTitles(query: string): Promise<{ name: string; value: string }[]> {
  const q = query.trim().toLowerCase();
  const [movies, series] = await Promise.all([
    radarr.configured ? cached('movies', () => radarr.allMovies()).catch(() => []) : [],
    sonarr.configured ? cached('series', () => sonarr.allSeries()).catch(() => []) : [],
  ]);
  const out = [
    ...movies.filter((m) => m.hasFile && m.title.toLowerCase().includes(q)).map((m) => ({ name: `🎬 ${m.title} (${m.year})`, value: `m:${m.id}` })),
    ...series.filter((s) => s.title.toLowerCase().includes(q)).map((s) => ({ name: `📺 ${s.title}`, value: `s:${s.id}` })),
  ];
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25).map((o) => ({ name: o.name.slice(0, 100), value: o.value }));
}

export async function resolveTitle(ref: string, season: number | null, episodeNo: number | null, language?: string): Promise<Resolved> {
  const [type, idStr] = ref.split(':');
  const id = Number(idStr);
  if (!id || (type !== 'm' && type !== 's')) throw new UserFacingError('Please pick a title from the autocomplete list.');
  const subtitle: SubInfo | undefined = language ? { language, label: language } : undefined;

  if (type === 'm') {
    const movie = await radarr.movie(id).catch(() => undefined);
    if (!movie) throw new UserFacingError('That movie no longer exists in Radarr.');
    if (!movie.hasFile) throw new UserFacingError(`**${movie.title}** has no file yet.`);
    return { kind: 'movie', title: `${movie.title} (${movie.year})`, movie, subtitle };
  }

  if (season === null || episodeNo === null) throw new UserFacingError('That is a TV show, so please also fill in the `season` and `episode` options.');
  const series = (await cached('series', () => sonarr.allSeries())).find((s) => s.id === id);
  if (!series) throw new UserFacingError('That show no longer exists in Sonarr.');
  const episode = (await sonarr.episodes(id)).find((e) => e.seasonNumber === season && e.episodeNumber === episodeNo);
  if (!episode) throw new UserFacingError(`Couldn't find S${season}E${episodeNo} of **${series.title}**.`);
  if (!episode.hasFile) throw new UserFacingError(`S${season}E${episodeNo} of **${series.title}** has no file yet.`);
  const code = `S${String(season).padStart(2, '0')}E${String(episodeNo).padStart(2, '0')}`;
  return { kind: 'episode', title: `${series.title} ${code} - ${episode.title}`, series, episode, subtitle };
}
