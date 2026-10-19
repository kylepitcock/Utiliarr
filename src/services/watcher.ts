import { db } from '../db.js';
import { getNum } from '../settings.js';
import { radarr, sonarr } from '../clients/arr.js';
import { bazarr, latestSubtitle } from '../clients/bazarr.js';
import { searchSubtitle } from './report.js';
import { refreshJellyfin } from './notify.js';

interface Row {
  id: number; kind: string; app: string; media_type: string; media_id: number; series_id: number | null;
  status: string; attempts: number; old_ref: string | null; created_at: number; last_search_at: number | null;
}

let completed = false;
function update(id: number, fields: Record<string, unknown>) {
  if (fields.status === 'completed') completed = true;
  const keys = Object.keys(fields);
  db.prepare(`UPDATE reports SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...keys.map((k) => fields[k] as any), Date.now(), id);
}

/**
 * Keeps looking until a replacement lands. Radarr/Sonarr/Bazarr also retry on their own
 * (RSS sync, "redownload failed"), this loop covers the gaps: failed downloads that were
 * not retried, searches that found nothing, and Bazarr searches that errored.
 */
async function check(r: Row) {
  const retryMs = (getNum('watcher.retryMinutes') || 15) * 60_000;
  const maxAttempts = getNum('watcher.maxAttempts') || 24;
  const due = Date.now() - (r.last_search_at ?? r.created_at) >= retryMs;

  if (r.kind === 'video') {
    const isMovie = r.media_type === 'movie';
    const item = isMovie ? await radarr.movie(r.media_id) : await sonarr.episode(r.media_id);
    const fileId = isMovie ? (item as any).movieFile?.id : (item as any).episodeFileId || undefined;
    if ((item as any).hasFile && fileId && String(fileId) !== r.old_ref) return update(r.id, { status: 'completed' });

    const queue = await (isMovie ? radarr : sonarr).queue();
    const inQueue = queue.some((q) => (isMovie ? q.movieId === r.media_id : q.episodeId === r.media_id));
    if (inQueue) return update(r.id, { status: 'downloading' });

    // Not in queue and no new file: either the download failed or nothing was found yet.
    if (r.status === 'downloading') update(r.id, { status: 'searching' });
    // Keep it monitored (delete can unmonitor it, which stops RSS and auto-redownload).
    await (isMovie ? radarr.ensureMonitored(r.media_id) : sonarr.ensureMonitored(r.media_id));
    // A failed download since our last search means that attempt is dead: search again right away.
    const since = r.last_search_at ?? r.created_at;
    const history = await (isMovie ? radarr.history(r.media_id) : sonarr.history(r.media_id));
    const failed = history.some((h) => h.eventType === 'downloadFailed' && Date.parse(h.date) > since);
    if (!due && !failed) return;
    if (r.attempts >= maxAttempts) return update(r.id, { status: 'gave_up', note: 'Gave up after max automatic searches' });
    await (isMovie ? radarr.search(r.media_id) : sonarr.search(r.media_id));
    return update(r.id, { attempts: r.attempts + 1, last_search_at: Date.now() });
  }

  // subtitle
  const rows = r.media_type === 'movie' ? await bazarr.movieHistory(r.media_id) : await bazarr.episodeHistory(r.media_id);
  const latest = latestSubtitle(rows);
  if (latest?.subs_id && latest.subs_id !== r.old_ref && !latest.blacklisted) return update(r.id, { status: 'completed' });
  if (!due) return;
  if (r.attempts >= maxAttempts) return update(r.id, { status: 'gave_up', note: 'Gave up after max automatic searches' });
  update(r.id, { attempts: r.attempts + 1 });
  await searchSubtitle(r.id);
}

let running = false;
export async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = db.prepare(`SELECT * FROM reports WHERE status IN ('searching','downloading')`).all() as Row[];
    completed = false;
    for (const r of rows) {
      try {
        await check(r);
      } catch (e) {
        console.warn(`[watcher] report ${r.id}: ${(e as Error).message}`);
      }
    }
    if (completed) await refreshJellyfin('replacement finished');
  } finally {
    running = false;
  }
}

export function startWatcher() {
  setInterval(() => void tick(), 60_000).unref();
}
