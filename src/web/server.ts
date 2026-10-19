import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { env } from '../config.js';
import { db } from '../db.js';
import { FIELDS, getSetting, publicSettings, setSetting } from '../settings.js';
import { jellyfin } from '../clients/jellyfin.js';
import { radarr, sonarr } from '../clients/arr.js';
import { bazarr } from '../clients/bazarr.js';
import { getQueue } from '../services/queue.js';
import { botStatus, startBot } from '../bot/index.js';
import { tick } from '../services/watcher.js';

const COOKIE = 'utiliarr_session';
const TTL = 12 * 3600_000;
const secret = env.sessionSecret || crypto.randomBytes(32).toString('hex'); // random => sessions reset on restart

const sign = (v: string) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
const safeEq = (a: string, b: string) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2) as [string, string][]);
}
function authed(req: Request) {
  const [exp, sig] = (cookies(req)[COOKIE] ?? '').split('.');
  return !!exp && !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now();
}
const requireAuth = (req: Request, res: Response, next: NextFunction) =>
  authed(req) ? next() : void res.status(401).json({ error: 'Not logged in' });

const attempts = new Map<string, { n: number; until: number }>();

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => res.status(500).json({ error: (e as Error).message }));

export function startWeb() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'");
    next();
  });
  app.use(express.static(path.resolve('public')));

  app.post('/api/login', (req, res) => {
    const ip = req.ip ?? '?';
    const a = attempts.get(ip);
    if (a && a.n >= 5 && a.until > Date.now()) return void res.status(429).json({ error: 'Too many attempts, try later' });
    if (!env.adminPassword || !safeEq(String(req.body?.password ?? ''), env.adminPassword)) {
      attempts.set(ip, { n: (a?.n ?? 0) + 1, until: Date.now() + 5 * 60_000 });
      return void res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    const exp = String(Date.now() + TTL);
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}${env.secureCookie ? '; Secure' : ''}`);
    res.json({ ok: true });
  });
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  app.get('/api/session', (req, res) => res.json({ authed: authed(req) }));

  app.use('/api', requireAuth);

  app.get('/api/settings', (_req, res) => res.json(publicSettings()));
  app.put('/api/settings', wrap(async (req, res) => {
    const known = new Set(FIELDS.map((f) => f.key));
    let discordChanged = false;
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) {
      if (!known.has(k) || typeof v !== 'string') continue;
      const f = FIELDS.find((x) => x.key === k)!;
      if (f.secret && v === '') continue; // blank secret = keep existing
      if (getSetting(k) !== v.trim()) {
        setSetting(k, v.trim());
        if (k.startsWith('discord.')) discordChanged = true;
      }
    }
    if (discordChanged) await startBot();
    res.json({ ok: true });
  }));

  app.post('/api/test/:service', wrap(async (req, res) => {
    try {
      const s = req.params.service;
      let info = '';
      if (s === 'jellyfin') { const r = await jellyfin.ping(); info = `${r.ServerName} ${r.Version}`; }
      else if (s === 'radarr') info = `v${(await radarr.ping()).version}`;
      else if (s === 'sonarr') info = `v${(await sonarr.ping()).version}`;
      else if (s === 'bazarr') info = `v${(await bazarr.ping()).data?.bazarr_version ?? '?'}`;
      else if (s === 'discord') info = botStatus;
      else return void res.status(404).json({ error: 'Unknown service' });
      res.json({ ok: true, info });
    } catch (e) {
      res.json({ ok: false, info: (e as Error).message });
    }
  }));

  app.get('/api/status', wrap(async (_req, res) => {
    const out: Record<string, string> = { discord: botStatus };
    res.json({
      ...out,
      configured: {
        jellyfin: jellyfin.configured(), radarr: radarr.configured, sonarr: sonarr.configured, bazarr: bazarr.configured(),
      },
    });
  }));
  app.get('/api/queue', wrap(async (_req, res) => res.json(await getQueue('all'))));
  app.get('/api/nowplaying', wrap(async (_req, res) => {
    const s = await jellyfin.allNowPlaying();
    res.json(s.map((x) => ({ user: x.UserName, device: x.DeviceName, title: x.NowPlayingItem!.SeriesName ? `${x.NowPlayingItem!.SeriesName} - ${x.NowPlayingItem!.Name}` : x.NowPlayingItem!.Name })));
  }));

  app.get('/api/reports', (_req, res) => res.json(db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 200').all()));
  app.post('/api/reports/:id/cancel', (req, res) => {
    db.prepare(`UPDATE reports SET status='cancelled', updated_at=? WHERE id=? AND status IN ('searching','downloading','gave_up')`).run(Date.now(), req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/reports/:id/retry', wrap(async (req, res) => {
    // reset so the watcher searches again right away
    db.prepare(`UPDATE reports SET status='searching', attempts=0, last_search_at=0, updated_at=? WHERE id=? AND status IN ('gave_up','cancelled')`).run(Date.now(), req.params.id);
    void tick();
    res.json({ ok: true });
  }));

  app.listen(env.port, () => console.log(`[web] admin UI on :${env.port}`));
}
