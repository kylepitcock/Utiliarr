# Utiliarr

Miscellaneous utilities for a Jellyfin setup: a **Discord bot** and an **admin web UI** that talk to **Radarr**, **Sonarr** and **Bazarr**.

## Features

- **`/report video`** – while watching something in Jellyfin, mark the current release as bad. Utiliarr finds the movie/episode in Radarr/Sonarr, marks the grabbed release as *failed* (so it is blocklisted and never picked again), optionally deletes the bad file, and starts a search for a different release.
- **`/report subtitle`** – blacklists the subtitle you're currently using in Bazarr and asks Bazarr to download a different one.
- **Keeps looking** – a background watcher tracks every report. If the replacement download fails, nothing is found, or Bazarr errors, it re-searches (default every 15 min, up to 24 times) until a new file/subtitle lands. Radarr/Sonarr's own "redownload failed" handling still applies on top.
- **`/queue [type]`** – Radarr + Sonarr queue in one embed: every item with progress and time left, plus total remaining size and "all done in ~X".
- **`/link`, `/unlink`, `/nowplaying`** – map a Discord user to a Jellyfin user (so the bot knows what *you* are watching) and verify it.
- **Admin web UI** – dashboard (live queue, who's watching, active reports), report history with cancel/retry, user-link management, and all settings with per-service "Test" buttons.

## How "current video" is detected

The bot looks up your linked Jellyfin user's active session (`/Sessions`), reads the playing item's TMDB/TVDB IDs and the selected subtitle track, and maps that to the Radarr movie / Sonarr episode. Movies and TV episodes are supported. Subtitle reports require a subtitle track to be turned on, and only work for subtitles Bazarr downloaded (not ones embedded in the file).

## Quick start (Docker Compose)

```bash
git clone https://github.com/kylepitcock/Utiliarr.git && cd Utiliarr
cp .env.example .env      # set ADMIN_PASSWORD (and optionally the rest)
docker compose up -d --build
```

Open <http://localhost:8080>, log in with `ADMIN_PASSWORD`, and fill in the **Settings** tab (URLs + API keys, Discord token). Data (SQLite) lives in `./data`.

If your other containers are on a shared Docker network, uncomment the `networks` lines in [docker-compose.yml](docker-compose.yml) so hostnames like `http://radarr:7878` resolve.

### Discord bot setup

1. Create an application at <https://discord.com/developers/applications>, add a **Bot**, copy the token.
2. Invite it with the `applications.commands` and `bot` scopes (no special permissions needed).
3. Put the token and application ID in Settings. Set a Guild ID for instant command registration in one server (global commands can take up to an hour).

### Running without Docker

```bash
npm ci && npm run build
ADMIN_PASSWORD=... npm start      # or: npm run dev
```

Requires Node 20+.

## Configuration

| Env var | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | **Required.** Admin UI password. |
| `SESSION_SECRET` | Signs login cookies; set it so sessions survive restarts. |
| `COOKIE_SECURE` | `true` when served over HTTPS. |
| `PORT`, `DATA_DIR` | Defaults `8080`, `./data` (`/data` in Docker). |
| `JELLYFIN_*`, `RADARR_*`, `SONARR_*`, `BAZARR_*`, `DISCORD_*` | Optional first-run defaults; values saved in the UI take precedence. |

Behaviour toggles (Settings tab): self-linking, delete-file-on-report, report cooldown, retry interval and max attempts.

## Notes & caveats

- Reporting a video **deletes the current file** by default so the replacement is accepted even if your quality cutoff is already met. Disable this in Settings if you prefer.
- Users self-link by Jellyfin username with no password check. On a trusted server that's fine; otherwise turn off self-linking and manage links in the **Users** tab.
- The admin UI has a single shared password and no TLS of its own: put it behind a reverse proxy (and set `COOKIE_SECURE=true`) before exposing it to the internet.
- Bazarr's API is lightly documented; the blacklist/download calls follow its `/api/movies|episodes/blacklist` and `/subtitles` endpoints. If your version behaves differently, check the container logs.

## Project layout

```
src/bot/        Discord slash commands
src/clients/    Jellyfin, Radarr/Sonarr, Bazarr API clients
src/services/   now-playing resolution, report logic, retry watcher, queue formatting
src/web/        Express admin API
public/         Admin UI (vanilla JS)
```
