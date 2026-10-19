import { HttpClient } from './http.js';
import { getSetting } from '../settings.js';

export interface QueueRecord {
  id: number;
  title: string;
  status: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  errorMessage?: string;
  size: number;
  sizeleft: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  movie?: { title: string; year: number };
  series?: { title: string };
  episode?: { seasonNumber: number; episodeNumber: number; title: string };
}
export interface HistoryRecord {
  id: number;
  eventType: string;
  date: string;
  downloadId?: string;
  sourceTitle?: string;
  movieId?: number;
  episodeId?: number;
}

export class ArrClient {
  readonly http: HttpClient;
  constructor(public readonly app: 'radarr' | 'sonarr') {
    this.http = new HttpClient(
      app === 'radarr' ? 'Radarr' : 'Sonarr',
      () => getSetting(`${app}.url`),
      () => ({ 'X-Api-Key': getSetting(`${app}.apiKey`) }),
    );
  }
  get configured() {
    return this.http.configured;
  }
  ping() {
    return this.http.request<{ version: string; instanceName?: string }>('/api/v3/system/status');
  }
  async queue(): Promise<QueueRecord[]> {
    const r = await this.http.request<{ records: QueueRecord[] }>('/api/v3/queue', {
      query: {
        page: 1,
        pageSize: 200,
        includeMovie: this.app === 'radarr',
        includeSeries: this.app === 'sonarr',
        includeEpisode: this.app === 'sonarr',
      },
    });
    return r.records;
  }
  command(body: Record<string, unknown>) {
    return this.http.request('/api/v3/command', { method: 'POST', body });
  }
  markHistoryFailed(historyId: number) {
    return this.http.request(`/api/v3/history/failed/${historyId}`, { method: 'POST' });
  }
}

export const radarr = Object.assign(new ArrClient('radarr'), {
  async movieByTmdb(tmdbId: number) {
    const r = await radarr.http.request<any[]>('/api/v3/movie', { query: { tmdbId } });
    return r[0] as RadarrMovie | undefined;
  },
  async movieByImdb(imdbId: string) {
    const all = await radarr.http.request<RadarrMovie[]>('/api/v3/movie');
    return all.find((m) => m.imdbId === imdbId);
  },
  allMovies() {
    return radarr.http.request<RadarrMovie[]>('/api/v3/movie');
  },
  movie(id: number) {
    return radarr.http.request<RadarrMovie>(`/api/v3/movie/${id}`);
  },
  history(movieId: number) {
    return radarr.http.request<HistoryRecord[]>('/api/v3/history/movie', { query: { movieId } });
  },
  deleteFile(fileId: number) {
    return radarr.http.request(`/api/v3/moviefile/${fileId}`, { method: 'DELETE' });
  },
  search(movieId: number) {
    return radarr.command({ name: 'MoviesSearch', movieIds: [movieId] });
  },
});
export interface RadarrMovie {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  imdbId?: string;
  hasFile: boolean;
  movieFile?: { id: number; relativePath?: string };
}

export const sonarr = Object.assign(new ArrClient('sonarr'), {
  async seriesByTvdb(tvdbId: number) {
    const r = await sonarr.http.request<SonarrSeries[]>('/api/v3/series', { query: { tvdbId } });
    return r[0];
  },
  allSeries() {
    return sonarr.http.request<SonarrSeries[]>('/api/v3/series');
  },
  async seriesByTitle(title: string) {
    const all = await sonarr.http.request<SonarrSeries[]>('/api/v3/series');
    return all.find((s) => s.title.toLowerCase() === title.toLowerCase());
  },
  episodes(seriesId: number) {
    return sonarr.http.request<SonarrEpisode[]>('/api/v3/episode', { query: { seriesId } });
  },
  episode(id: number) {
    return sonarr.http.request<SonarrEpisode>(`/api/v3/episode/${id}`);
  },
  history(episodeId: number) {
    return sonarr.http
      .request<{ records: HistoryRecord[] }>('/api/v3/history', {
        query: { page: 1, pageSize: 50, sortKey: 'date', sortDirection: 'descending', episodeId },
      })
      .then((r) => r.records);
  },
  deleteFile(fileId: number) {
    return sonarr.http.request(`/api/v3/episodefile/${fileId}`, { method: 'DELETE' });
  },
  search(episodeId: number) {
    return sonarr.command({ name: 'EpisodeSearch', episodeIds: [episodeId] });
  },
});
export interface SonarrSeries {
  id: number;
  title: string;
  tvdbId: number;
  imdbId?: string;
}
export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
  episodeFileId: number;
}
