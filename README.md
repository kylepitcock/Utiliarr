# Utiliarr

Miscellaneous utilities for a Jellyfin setup: a **Discord bot** and an **admin web UI** that talk to **Radarr**, **Sonarr** and **Bazarr**.

## Features

- **`/report title:<name> issue:<video|subtitle>`** – type the name of the movie or show (autocomplete searches Radarr and Sonarr). For TV shows also give `season` and `episode`. Optional `reason`, and `language` for subtitle issues.
  - **Video**: Utiliarr marks the grabbed release as *failed* in Radarr/Sonarr (blocklisting it), optionally deletes the bad file, and starts a search for a different release.
  - **Subtitle**: blacklists the current subtitle in Bazarr (the latest one, or the given language) and asks Bazarr to download a different one.
  - A Yes/Cancel button confirms before anything changes.
- **Keeps looking** – a background watcher tracks every report. If the replacement download fails, nothing is found, or Bazarr errors, it re-searches (default every 15 min, up to 24 times) until a new file/subtitle lands. Radarr/Sonarr's own "redownload failed" handling still applies on top.
- **`/queue [type]`** – Radarr + Sonarr queue in one embed: every item with progress and time left, plus total remaining size and "all done in ~X".
- **Admin web UI** – dashboard (live queue, who's watching in Jellyfin, active reports), report history with cancel/retry, and all settings with per-service "Test" buttons.

Subtitle reports only work for subtitles Bazarr downloaded (not ones embedded in the video file). Jellyfin is optional and only used for the dashboard's "now playing" panel.

## Quick start (Docker Compose)

```bash
git clone https://github.com/kylepitcock/Utiliarr.git && cd Utiliarr
cp .env.example .env      # set ADMIN_PASSWORD (and optionally the rest)
docker compose up -d --build
```

Open <http://localhost:5757>, log in with `ADMIN_PASSWORD`, and fill in the **Settings** tab (URLs + API keys, Discord token). Data (SQLite) lives in `./data`.

Point the service URLs at your server's address and each app's port (e.g. `http://192.168.1.10:7878`); no shared Docker network is needed.

### Sample `docker-compose.yml`

Inline environment variables (also saved as [docker-compose.example.yml](docker-compose.example.yml)):

```yaml
# Sample: Utiliarr pointing at your existing Jellyfin/Radarr/Sonarr/Bazarr by host address.
# Copy to docker-compose.yml and adjust. Service URLs/API keys can also be
# entered later in the admin UI (Settings tab) instead of here.
services:
  utiliarr:
    build: .
    container_name: utiliarr
    restart: unless-stopped
    ports:
      - "5757:5757"
    environment:
      ADMIN_PASSWORD: change-me
      SESSION_SECRET: generate-with-openssl-rand-hex-32
      COOKIE_SECURE: "false"      # "true" behind an HTTPS reverse proxy
      TZ: America/New_York
      JELLYFIN_URL: http://192.168.1.10:8096
      JELLYFIN_API_KEY: ""
      RADARR_URL: http://192.168.1.10:7878
      RADARR_API_KEY: ""
      SONARR_URL: http://192.168.1.10:8989
      SONARR_API_KEY: ""
      BAZARR_URL: http://192.168.1.10:6767
      BAZARR_API_KEY: ""
      DISCORD_TOKEN: ""
      DISCORD_CLIENT_ID: ""
      DISCORD_GUILD_ID: ""
    volumes:
      - ./data:/data
```

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
| `PORT`, `DATA_DIR` | Defaults `5757`, `./data` (`/data` in Docker). |
| `JELLYFIN_*`, `RADARR_*`, `SONARR_*`, `BAZARR_*`, `DISCORD_*` | Optional first-run defaults; values saved in the UI take precedence. |

Behaviour toggles (Settings tab): delete-file-on-report, report cooldown, retry interval and max attempts.

## Notes & caveats

- Reporting a video **deletes the current file** by default so the replacement is accepted even if your quality cutoff is already met. Disable this in Settings if you prefer.
- Any Discord user who can see the commands can report any title. Restrict `/report` to a role or channel with Discord's Server Settings → Integrations.
- The admin UI has a single shared password and no TLS of its own: put it behind a reverse proxy (and set `COOKIE_SECURE=true`) before exposing it to the internet.
- Bazarr's API is lightly documented; the blacklist/download calls follow its `/api/movies|episodes/blacklist` and `/subtitles` endpoints. If your version behaves differently, check the container logs.

## Project layout

```
src/bot/        Discord slash commands
src/clients/    Jellyfin, Radarr/Sonarr, Bazarr API clients
src/services/   title lookup, report logic, retry watcher, queue formatting
src/web/        Express admin API
public/         Admin UI (vanilla JS)
```
