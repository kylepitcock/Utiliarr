import { HttpClient } from './http.js';
import { getSetting } from '../settings.js';

export interface BazarrLang {
  name: string;
  code2: string;
  code3: string;
  forced?: boolean;
  hi?: boolean;
}
export interface BazarrHistory {
  action: number;
  description?: string;
  language?: BazarrLang;
  provider?: string;
  subs_id?: string;
  subtitles_path?: string;
  timestamp?: string;
  blacklisted?: boolean;
}

const http = new HttpClient('Bazarr', () => getSetting('bazarr.url'), () => ({ 'X-API-KEY': getSetting('bazarr.apiKey') }));

const history = async (path: string, query: Record<string, number>) => {
  const r = await http.request<{ data: BazarrHistory[] }>(path, { query: { start: 0, length: 50, ...query } });
  return r.data ?? [];
};

export const bazarr = {
  configured: () => http.configured,
  ping: () => http.request<{ data?: { bazarr_version?: string } }>('/api/system/status'),
  movieHistory: (radarrId: number) => history('/api/movies/history', { radarrid: radarrId }),
  episodeHistory: (episodeId: number) => history('/api/episodes/history', { episodeid: episodeId }),

  blacklistMovieSub(radarrId: number, h: BazarrHistory) {
    return http.request('/api/movies/blacklist', {
      method: 'POST',
      query: { radarrid: radarrId, provider: h.provider, subs_id: h.subs_id, language: h.language?.code2, subtitles_path: h.subtitles_path },
    });
  },
  blacklistEpisodeSub(seriesId: number, episodeId: number, h: BazarrHistory) {
    return http.request('/api/episodes/blacklist', {
      method: 'POST',
      query: { seriesid: seriesId, episodeid: episodeId, provider: h.provider, subs_id: h.subs_id, language: h.language?.code2, subtitles_path: h.subtitles_path },
    });
  },
  /** Re-time an existing subtitle file against the video's audio (Bazarr's subtitle sync tool). */
  syncSubtitle(type: 'movie' | 'episode', id: number, h: BazarrHistory) {
    return http.request('/api/subtitles', {
      method: 'PATCH',
      query: {
        action: 'sync', type, id, language: h.language?.code2, path: h.subtitles_path,
        forced: !!h.language?.forced, hi: !!h.language?.hi, reference: 'a:0',
      },
      timeoutMs: 15 * 60_000, // syncing can take minutes
    });
  },
  /** Ask Bazarr to search + download a fresh subtitle (blacklisted ones are skipped by Bazarr). */
  downloadMovieSub(radarrId: number, l: BazarrLang) {
    return http.request('/api/movies/subtitles', {
      method: 'PATCH',
      query: { radarrid: radarrId, language: l.code2, forced: !!l.forced, hi: !!l.hi },
      timeoutMs: 120000,
    });
  },
  downloadEpisodeSub(seriesId: number, episodeId: number, l: BazarrLang) {
    return http.request('/api/episodes/subtitles', {
      method: 'PATCH',
      query: { seriesid: seriesId, episodeid: episodeId, language: l.code2, forced: !!l.forced, hi: !!l.hi },
      timeoutMs: 120000,
    });
  },
};

/** Most recent non-blacklisted downloaded subtitle, optionally for a language. */
export function latestSubtitle(rows: BazarrHistory[], lang?: string): BazarrHistory | undefined {
  const l = lang?.toLowerCase();
  return rows.find(
    (r) =>
      r.provider &&
      r.subs_id &&
      !r.blacklisted &&
      (!l || [r.language?.code2, r.language?.code3, r.language?.name].some((x) => x?.toLowerCase() === l)),
  );
}
