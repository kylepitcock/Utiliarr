import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';

fs.mkdirSync(env.dataDir, { recursive: true });
export const db = new Database(path.join(env.dataDir, 'utiliarr.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'video' | 'subtitle'
  app TEXT NOT NULL,               -- 'radarr' | 'sonarr' | 'bazarr'
  media_type TEXT NOT NULL,        -- 'movie' | 'episode'
  media_id INTEGER NOT NULL,       -- radarr movie id / sonarr episode id
  series_id INTEGER,               -- sonarr series id (episodes)
  title TEXT NOT NULL,
  reason TEXT,
  discord_id TEXT,
  discord_name TEXT,
  status TEXT NOT NULL,            -- searching | downloading | completed | cancelled | gave_up | error
  attempts INTEGER NOT NULL DEFAULT 0,
  old_ref TEXT,                    -- old file id (video) / old subs_id (subtitle)
  language TEXT,                   -- subtitle language code2 (+ :forced / :hi)
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_search_at INTEGER
);
`);
