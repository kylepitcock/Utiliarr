import { jellyfin } from '../clients/jellyfin.js';
import { getBool } from '../settings.js';

let last = 0;

/** Tell Jellyfin to rescan so it picks up the replaced video / new subtitle. Debounced; never throws. */
export async function refreshJellyfin(reason: string) {
  if (!getBool('jellyfin.refreshOnChange') || !jellyfin.configured()) return;
  if (Date.now() - last < 15_000) return;
  last = Date.now();
  try {
    await jellyfin.refreshLibrary();
    console.log(`[jellyfin] library refresh requested (${reason})`);
  } catch (e) {
    console.warn(`[jellyfin] refresh failed: ${(e as Error).message}`);
  }
}
