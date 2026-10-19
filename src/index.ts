import { startBot } from './bot/index.js';
import { startWeb } from './web/server.js';
import { startWatcher } from './services/watcher.js';


startWeb();
startWatcher();
void startBot();
