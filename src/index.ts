import { env } from './config.js';
import { startBot } from './bot/index.js';
import { startWeb } from './web/server.js';
import { startWatcher } from './services/watcher.js';

if (!env.adminPassword) {
  console.error('ADMIN_PASSWORD is required (it protects the admin web UI).');
  process.exit(1);
}
if (!env.sessionSecret) console.warn('SESSION_SECRET not set: admin sessions will reset on every restart.');

startWeb();
startWatcher();
void startBot();
