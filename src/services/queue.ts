import { radarr, sonarr, QueueRecord } from '../clients/arr.js';

export interface QueueItem {
  source: 'movie' | 'episode';
  title: string;
  status: string;
  percent: number;
  sizeLeft: number;
  secondsLeft: number | null;
  warning?: string;
}

/** Parses Radarr/Sonarr "d.hh:mm:ss" / "hh:mm:ss" into seconds. */
export function parseTimeleft(t?: string): number | null {
  if (!t) return null;
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s`;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export const formatBytes = (b: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
  return `${b.toFixed(i > 2 ? 1 : 0)} ${u[i]}`;
};

function toItem(q: QueueRecord, source: 'movie' | 'episode'): QueueItem {
  let title = q.title;
  if (source === 'movie' && q.movie) title = `${q.movie.title} (${q.movie.year})`;
  if (source === 'episode' && q.series) {
    const e = q.episode;
    title = e ? `${q.series.title} S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}` : q.series.title;
  }
  const warn = q.trackedDownloadStatus && q.trackedDownloadStatus !== 'ok' ? q.errorMessage ?? q.trackedDownloadStatus : undefined;
  return {
    source,
    title,
    status: q.trackedDownloadState ?? q.status,
    percent: q.size > 0 ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0,
    sizeLeft: q.sizeleft,
    secondsLeft: parseTimeleft(q.timeleft),
    warning: warn,
  };
}

export async function getQueue(which: 'all' | 'movies' | 'shows' = 'all') {
  const [movies, episodes] = await Promise.all([
    which !== 'shows' && radarr.configured ? radarr.queue().catch(() => []) : [],
    which !== 'movies' && sonarr.configured ? sonarr.queue().catch(() => []) : [],
  ]);
  const items = [...movies.map((q) => toItem(q, 'movie')), ...episodes.map((q) => toItem(q, 'episode'))];
  items.sort((a, b) => (a.secondsLeft ?? Infinity) - (b.secondsLeft ?? Infinity));
  const known = items.map((i) => i.secondsLeft).filter((s): s is number => s !== null);
  return {
    items,
    totalLeft: items.reduce((s, i) => s + i.sizeLeft, 0),
    // Downloads run in parallel, so "everything finished" is when the slowest one finishes.
    allDoneInSeconds: known.length ? Math.max(...known) : null,
  };
}
