import { db } from '../db.js';
import { getBool, getNum } from '../settings.js';
import { radarr, sonarr, HistoryRecord } from '../clients/arr.js';
import { bazarr, latestSubtitle, BazarrLang } from '../clients/bazarr.js';
import { Resolved, UserFacingError } from './resolve.js';
import { refreshJellyfin } from './notify.js';

export interface Reporter {
  discordId?: string;
  discordName?: string;
}
export interface ReportResult {
  reportId: number;
  summary: string;
}

const ACTIVE = `('searching','downloading')`;
const now = () => Date.now();

function assertNotActive(kind: string, mediaId: number, mediaType: string) {
  const dup = db
    .prepare(`SELECT id FROM reports WHERE kind=? AND media_type=? AND media_id=? AND status IN ${ACTIVE}`)
    .get(kind, mediaType, mediaId);
  if (dup) throw new UserFacingError('A replacement for this is already being searched for. Hang tight!');
}

function insertReport(r: {
  kind: string; app: string; media_type: string; media_id: number; series_id?: number; title: string;
  reason?: string; who: Reporter; old_ref?: string; language?: string; note?: string; status?: string;
}) {
  const t = now();
  return Number(
    db
      .prepare(
        `INSERT INTO reports(kind,app,media_type,media_id,series_id,title,reason,discord_id,discord_name,status,attempts,old_ref,language,note,created_at,updated_at,last_search_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(r.kind, r.app, r.media_type, r.media_id, r.series_id ?? null, r.title, r.reason ?? null, r.who.discordId ?? null,
        r.who.discordName ?? null, r.status ?? 'searching', r.status ? 0 : 1, r.old_ref ?? null, r.language ?? null, r.note ?? null, t, t, t).lastInsertRowid,
  );
}

/** Pick the grab that produced the currently-imported file, falling back to the newest grab. */
function pickGrab(history: HistoryRecord[]): HistoryRecord | undefined {
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  const imported = sorted.find((h) => h.eventType === 'downloadFolderImported' && h.downloadId);
  if (imported) {
    const g = sorted.find((h) => h.eventType === 'grabbed' && h.downloadId === imported.downloadId);
    if (g) return g;
  }
  return sorted.find((h) => h.eventType === 'grabbed');
}

export async function reportVideo(res: Resolved, reason: string | undefined, who: Reporter): Promise<ReportResult> {
  const isMovie = res.kind === 'movie';
  const mediaId = isMovie ? res.movie.id : res.episode.id;
  assertNotActive('video', mediaId, res.kind);

  const client = isMovie ? radarr : sonarr;
  const history = isMovie ? await radarr.history(mediaId) : await sonarr.history(mediaId);
  const grab = pickGrab(history);
  const fileId = isMovie ? res.movie.movieFile?.id : res.episode.episodeFileId || undefined;
  const notes: string[] = [];

  // 1. Mark the grabbed release failed -> blocklists it so it is never picked again.
  if (grab) {
    await client.markHistoryFailed(grab.id);
    notes.push(`blocklisted "${grab.sourceTitle ?? 'release'}"`);
  } else {
    notes.push('no grab history found (nothing blocklisted)');
  }
  // 2. Remove the bad file so a replacement is accepted regardless of quality cutoff.
  if (getBool('bot.deleteFileOnFail') && fileId) {
    await (isMovie ? radarr.deleteFile(fileId) : sonarr.deleteFile(fileId));
    notes.push('deleted file');
  }
  // 3. Radarr/Sonarr may have unmonitored it on delete; unmonitored items are never retried.
  if (await (isMovie ? radarr.ensureMonitored(mediaId) : sonarr.ensureMonitored(mediaId))) notes.push('re-monitored');
  // 4. Kick off a search.
  await (isMovie ? radarr.search(mediaId) : sonarr.search(mediaId));

  const reportId = insertReport({
    kind: 'video', app: client.app, media_type: res.kind, media_id: mediaId,
    series_id: isMovie ? undefined : res.series.id, title: res.title, reason, who,
    old_ref: fileId ? String(fileId) : undefined, note: notes.join('; '),
  });
  return { reportId, summary: notes.join(', ') };
}

async function findSubtitle(res: Resolved) {
  const isMovie = res.kind === 'movie';
  const mediaId = isMovie ? res.movie.id : res.episode.id;
  const rows = isMovie ? await bazarr.movieHistory(mediaId) : await bazarr.episodeHistory(mediaId);
  const target = latestSubtitle(rows, res.subtitle?.language);
  if (!target)
    throw new UserFacingError(
      res.subtitle
        ? `Bazarr has no downloaded **${res.subtitle.label}** subtitle for **${res.title}**.`
        : `Bazarr has no downloaded subtitle for **${res.title}** (it may be embedded in the video file, which Bazarr can't replace).`,
    );
  return { isMovie, mediaId, target };
}

export async function reportSubtitle(res: Resolved, reason: string | undefined, who: Reporter): Promise<ReportResult> {
  const { isMovie, mediaId, target } = await (async () => {
    const f = await findSubtitle(res);
    assertNotActive('subtitle', f.mediaId, res.kind);
    return f;
  })();
  const lang: BazarrLang = { ...target.language! };

  if (isMovie) await bazarr.blacklistMovieSub(mediaId, target);
  else await bazarr.blacklistEpisodeSub((res as Extract<Resolved, { kind: 'episode' }>).series.id, mediaId, target);

  const reportId = insertReport({
    kind: 'subtitle', app: 'bazarr', media_type: res.kind, media_id: mediaId,
    series_id: isMovie ? undefined : (res as Extract<Resolved, { kind: 'episode' }>).series.id, title: res.title, reason, who,
    old_ref: target.subs_id, language: JSON.stringify(lang), note: `blacklisted ${target.provider} subtitle (${lang.name})`,
  });
  // Bazarr's search can take a while; don't fail the report if it errors - the watcher retries.
  searchSubtitle(reportId).catch(() => undefined);
  return { reportId, summary: `blacklisted ${target.provider} ${lang.name} subtitle` };
}

/** Re-time the current subtitle with Bazarr instead of replacing it. Blocks until Bazarr finishes. */
export async function syncSubtitle(res: Resolved, reason: string | undefined, who: Reporter): Promise<ReportResult> {
  const { isMovie, mediaId, target } = await findSubtitle(res);
  if (!target.subtitles_path) throw new UserFacingError('Bazarr has no file path for that subtitle, so it cannot be synced.');
  const lang = target.language?.name ?? 'subtitle';
  try {
    await bazarr.syncSubtitle(isMovie ? 'movie' : 'episode', mediaId, target);
  } catch (e) {
    insertReport({
      kind: 'sync', app: 'bazarr', media_type: res.kind, media_id: mediaId, title: res.title, reason, who,
      note: `sync failed: ${(e as Error).message}`.slice(0, 300), status: 'error',
    });
    throw e;
  }
  const reportId = insertReport({
    kind: 'sync', app: 'bazarr', media_type: res.kind, media_id: mediaId, title: res.title, reason, who,
    note: `synced ${target.provider ?? ''} ${lang} subtitle`.replace('  ', ' '), status: 'completed',
  });
  void refreshJellyfin('subtitle synced');
  return { reportId, summary: `synced the ${lang} subtitle` };
}

export async function searchSubtitle(reportId: number) {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(reportId) as any;
  const lang = JSON.parse(r.language) as BazarrLang;
  try {
    if (r.media_type === 'movie') await bazarr.downloadMovieSub(r.media_id, lang);
    else await bazarr.downloadEpisodeSub(r.series_id, r.media_id, lang);
  } finally {
    db.prepare('UPDATE reports SET last_search_at=?, updated_at=? WHERE id=?').run(now(), now(), reportId);
  }
}

export const cooldowns = new Map<string, number>();
export function checkCooldown(discordId: string) {
  const secs = getNum('bot.cooldownSeconds');
  const last = cooldowns.get(discordId) ?? 0;
  const wait = Math.ceil((last + secs * 1000 - now()) / 1000);
  if (wait > 0) throw new UserFacingError(`Please wait ${wait}s before reporting again.`);
}
export const touchCooldown = (discordId: string) => cooldowns.set(discordId, now());
