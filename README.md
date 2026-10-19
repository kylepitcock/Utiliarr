# Utiliarr

Miscellaneous utilities for a Jellyfin setup: a **Discord bot** and an **admin web UI** that talk to **Radarr**, **Sonarr** and **Bazarr**.

## Features

- **`/report title:<name> issue:<video|subtitle>`** – type the name of the movie or show (autocomplete searches Radarr and Sonarr). For TV shows also give `season` and `episode`. Optional `reason`, and `language` for subtitle issues.
  - **Video**: Utiliarr marks the grabbed release as *failed* in Radarr/Sonarr (blocklisting it), optionally deletes the bad file, and starts a search for a different release.
  - **Subtitles are wrong or bad**: a popup offers **Sync timing (recommended)**, where Bazarr re-times the existing subtitle against the audio, or **Delete & download another**, which blacklists the current subtitle and fetches a different one. After a sync there is a "Still wrong" button that escalates to delete & download.
  - **Subtitles are out of sync**: skips the popup and goes straight to Bazarr's sync.
  - A Yes/Cancel button confirms before anything changes.
- **Jellyfin rescan** – when a replacement video/subtitle lands (or a sync finishes) Utiliarr asks Jellyfin to refresh its library so the new file shows up. Toggle in Settings; needs the Jellyfin URL and API key.
- **Keeps looking** – a background watcher tracks every report. If the replacement download fails, nothing is found, or Bazarr errors, it re-searches (default every 15 min, up to 24 times) until a new file/subtitle lands. Radarr/Sonarr's own "redownload failed" handling still applies on top.
- **`/queue [type]`** – Radarr + Sonarr queue in one embed: every item with progress and time left, plus total remaining size and "all done in ~X".
- **Admin web UI** – dashboard (live queue, who's watching in Jellyfin, active reports), report history with cancel/retry, and all settings with per-service "Test" buttons.

Subtitle reports only work for subtitles Bazarr downloaded (not ones embedded in the video file). Jellyfin is optional and only used for the dashboard's "now playing" panel.

## Quick start (Docker Compose)

```bash
git clone https://github.com/kylepitcock/Utiliarr.git && cd Utiliarr
docker compose up -d
```

Open <http://localhost:5757>. On first run you'll be asked to choose the admin password (open it promptly - whoever loads the page first sets it). Then fill in the **Settings** tab (URLs + API keys, Discord token); the password can be changed there too. Data (SQLite) lives in `./data`.

In **Settings**, point the service URLs at your server's address and each app's port (e.g. `http://192.168.1.10:7878`); no shared Docker network is needed.

### Sample `docker-compose.yml`

(service URLs, API keys and the Discord token are set in the dashboard, not here; also saved as [docker-compose.example.yml](docker-compose.example.yml)):

```yaml
# Sample compose. The admin password, Jellyfin/Radarr/Sonarr/Bazarr URLs, API keys and
# the Discord token are all set in the web dashboard.
services:
  utiliarr:
    image: ghcr.io/kylepitcock/utiliarr:latest
    container_name: utiliarr
    restart: unless-stopped
    ports:
      - "5757:5757"
    environment:
      COOKIE_SECURE: "false"      # "true" behind an HTTPS reverse proxy
      TZ: America/New_York
    volumes:
      - ./data:/data
```

### Discord bot setup

1. Create an application at <https://discord.com/developers/applications>, add a **Bot**, copy the token.
2. Invite it with the `applications.commands` and `bot` scopes (no special permissions needed).
3. Put the token and application ID in Settings. Set a Guild ID for instant command registration in one server (global commands can take up to an hour).

The image (`ghcr.io/kylepitcock/utiliarr`, amd64 + arm64) is built and published by GitHub Actions on every push to `main`. To build it yourself instead, run `docker build -t ghcr.io/kylepitcock/utiliarr:latest .`.

### Running without Docker

```bash
npm ci && npm run build
npm start      # or: npm run dev
```

Requires Node 20+.

## Configuration

All optional; the admin password and everything else is set in the dashboard.

| Env var | Purpose |
| --- | --- |
| `COOKIE_SECURE` | `true` when served over HTTPS. |
| `PORT`, `DATA_DIR` | Defaults `5757`, `./data` (`/data` in Docker). |

Behaviour toggles (Settings tab): delete-file-on-report, report cooldown, retry interval and max attempts.

## Notes & caveats

- Reporting a video **deletes the current file** by default so the replacement is accepted even if your quality cutoff is already met. Disable this in Settings if you prefer.
- Any Discord user who can see the commands can report any title. Restrict `/report` to a role or channel with Discord's Server Settings → Integrations.
- The admin UI has a single shared password and no TLS of its own: put it behind a reverse proxy (and set `COOKIE_SECURE=true`) before exposing it to the internet.
- Bazarr's API is lightly documented; the blacklist/download calls follow its `/api/movies|episodes/blacklist` and `/subtitles` endpoints, and sync uses `PATCH /api/subtitles?action=sync`. If your version behaves differently, check the container logs.

## Project layout

```
src/bot/        Discord slash commands
src/clients/    Jellyfin, Radarr/Sonarr, Bazarr API clients
src/services/   title lookup, report logic, retry watcher, queue formatting
src/web/        Express admin API
public/         Admin UI (vanilla JS)
```
