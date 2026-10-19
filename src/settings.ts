import { db } from './db.js';

export interface FieldDef {
  key: string;
  label: string;
  group: string;
  secret?: boolean;
  type?: 'text' | 'bool' | 'number';
  default?: string;
  help?: string;
}

export const FIELDS: FieldDef[] = [
  { key: 'jellyfin.url', label: 'URL', group: 'Jellyfin', help: 'e.g. http://jellyfin:8096' },
  { key: 'jellyfin.apiKey', label: 'API key', group: 'Jellyfin', secret: true },
  { key: 'radarr.url', label: 'URL', group: 'Radarr', help: 'e.g. http://radarr:7878' },
  { key: 'radarr.apiKey', label: 'API key', group: 'Radarr', secret: true },
  { key: 'sonarr.url', label: 'URL', group: 'Sonarr', help: 'e.g. http://sonarr:8989' },
  { key: 'sonarr.apiKey', label: 'API key', group: 'Sonarr', secret: true },
  { key: 'bazarr.url', label: 'URL', group: 'Bazarr', help: 'e.g. http://bazarr:6767' },
  { key: 'bazarr.apiKey', label: 'API key', group: 'Bazarr', secret: true },
  { key: 'discord.token', label: 'Bot token', group: 'Discord', secret: true },
  { key: 'discord.clientId', label: 'Application (client) ID', group: 'Discord' },
  { key: 'discord.guildId', label: 'Guild (server) ID', group: 'Discord', help: 'Optional. Set for instant slash-command registration in one server.' },
  { key: 'jellyfin.refreshOnChange', label: 'Ask Jellyfin to rescan its library after a video/subtitle is replaced or synced', group: 'Behaviour', type: 'bool', default: 'true', help: 'Requires the Jellyfin URL and API key above.' },
  { key: 'bot.deleteFileOnFail', label: 'Delete the bad file when a video is reported', group: 'Behaviour', type: 'bool', default: 'true', help: 'Needed so Radarr/Sonarr will accept a replacement even if the quality cutoff is already met.' },
  { key: 'watcher.maxAttempts', label: 'Max automatic re-searches per report', group: 'Behaviour', type: 'number', default: '24' },
  { key: 'watcher.retryMinutes', label: 'Minutes between automatic re-searches', group: 'Behaviour', type: 'number', default: '15' },
];

const byKey = new Map(FIELDS.map((f) => [f.key, f]));

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return row.value;
  return byKey.get(key)?.default ?? '';
}
export const getBool = (key: string) => getSetting(key) === 'true';
export const getNum = (key: string) => Number(getSetting(key)) || 0;

export function setSetting(key: string, value: string) {
  if (!byKey.has(key)) throw new Error(`Unknown setting ${key}`);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

/** Settings for the admin UI; secrets are masked. */
export function publicSettings() {
  return FIELDS.map((f) => {
    const v = getSetting(f.key);
    return { ...f, default: undefined, value: f.secret ? '' : v, isSet: !!v };
  });
}
