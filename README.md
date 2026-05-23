# Netflix Clone (Rust + SolidJS)

This project is a local Netflix-style streaming app with:

- A browse/home UI (`index.html`)
- A full custom player (`player.html`)
- A settings UI (`settings.html`)
- A local upload workflow (`upload.html`)
- A Rust backend that handles metadata, stream resolving, remux/subtitles, caching, and local library management

## Table of Contents

1. Overview
2. Architecture
3. Features
4. Page-by-Page Behavior
5. API Reference
6. Environment Variables
7. Data, Cache, and Persistence
8. Local Development
9. Operational Notes
10. Troubleshooting
11. Clean URL Routing
12. Remux Pipeline Notes

## 1) Overview

The app combines two media paths:

- Remote resolver path:
  - TMDB metadata + Torrentio stream candidates + optional Torznab fallback + Real-Debrid unrestricted links
  - Server selects candidates, probes tracks, and returns a playable source
- Local media path:
  - You upload `.mp4` / `.mkv`
  - Server processes files into `assets/videos` and updates `assets/library.json`
  - Home and player can play those local sources

## 2) Architecture

### Runtime

- Backend: Rust (Axum) in `src/`
- Frontend: multi-page Solid + Vite app with page entries in `src-ui/`
- External tools: `ffmpeg`, `ffprobe`
- Caching: in-memory + persistent SQLite-backed cache data (managed by the Rust backend)

### Main files

- `src/`: Rust API, static serving, resolving, remux/subtitles, upload processing, caching, health/debug
- `src-ui/`: Solid page shells and entrypoints for the multi-page frontend
- `index.html` + `script.js`: home screen structure + browse behavior
- `player.html` + `player.js`: video playback UI, source selection, subtitles/audio handling, fallback logic
- `settings.html` + `settings.js`: quality/source/profile/remux preferences
- `upload.html` + `upload.js`: upload and metadata inference flow
- `assets/library.json`: local media catalog

## 3) Features

### Playback and streaming

- Custom HTML5 player controls (play/pause, seek ±10s, volume/mute, speed, captions, fullscreen)
- Multiple playback modes:
  - direct `src`
  - TMDB resolve flow (`/api/resolve/movie`, `/api/resolve/tv`)
  - fallback asset playback
- Server remux endpoint (`/api/remux`) with selectable audio/subtitle stream indexes
- Native HLS playback via browser-native `<video>` support (Chrome 142+, Safari, Edge 142+) with automatic remux fallback
- HLS endpoints for playlist + segment serving
- Subtitle extraction to VTT from embedded streams and external subtitle providers
- Automatic subtitle prewarm for selected subtitle streams on resolve responses

### Metadata and discovery

- TMDB popular movies
- TMDB details (movie/tv + credits)
- TMDB TV season episode metadata helper
- Details modal on home cards

### Source selection and quality filters

- Stored stream quality preference (`auto`, `2160p`, `1080p`, `720p`)
- Source filter settings:
  - minimum seeders
  - results limit (1-20)
  - language filter (`en`, `any`, `fr`, `es`, `de`, `it`, `pt`)
  - allowed container formats (MP4 and MKV)
- Preference-aware resolving (language/quality/filter params passed to resolve endpoints)

### Upload and local library

- Drag/drop upload UI
- Supported input: `.mp4`, `.mkv`
- Chunked upload session flow (start/chunk/finish)
- Post-upload compatibility probe using `ffprobe`
- Optional audio-only transcode to AAC (video stream copied) for browser-audio compatibility
- Upload metadata inference endpoint (`/api/upload/infer`) for movie/episode autofill
- Local catalog endpoint (`/api/library`) feeds uploaded media into browse/player flows

### Continue watching and resume

- Local resume storage (`netflix-resume:*`)
- Continue watching metadata store (`netflix-continue-watching-meta`)
- Server-side playback sessions supported via `/api/session/progress` when enabled

### User preferences

- Subtitle color preference
- Profile avatar preset or custom uploaded image
- Remux video mode preference (`auto`/`copy`/`normalize`)
- Per-title language preference persistence (`/api/title/preferences`)

### Operations and debugging

- Health endpoint with ffmpeg/ffprobe capability info
- Cache stats endpoint + cache clear action
- Settings page button to clear all server caches

## 4) Page-by-Page Behavior

### Home (`index.html` + `script.js`)

- Rotating featured hero sourced from current TMDB popular movies with:
  - play button -> opens player
  - info button -> opens details context
  - mute toggle
- Continue watching row built from resume metadata
- Popular/content rows hydrated from backend + local library items
- Uploaded local `/media/...` launches include `audioLang=en` by default
- Details modal for richer metadata and playback launch
- Account menu links to Upload and Settings

### Player (`player.html` + `player.js`)

- Accepts URL params including `tmdbId`, `mediaType`, `title`, `src`, `audioLang`, `quality`, `subtitleLang`
- Clean URL routing: `/watch/<slug>` and `/watch/<slug>/<episodeIndex>` via Vite middleware rewrite
- Slug-based library lookup on page load for clean URL refresh support
- Chooses source path based on params and resolver results
- Attaches subtitles/audio tracks and keeps selected preferences
- Explicit/local `src` playback can probe media tracks via `/api/media/tracks` and preselect audio/subtitle streams
- For uploaded local media, English audio is preferred when an English track exists
- Handles stream fallback and recovery behavior
- Uses native HLS, remux, and subtitle endpoints when needed (no hls.js dependency — relies on browser-native HLS support)
- On seek, the previous video source is explicitly torn down (pause + remove src + load) before setting the new source, ensuring the old HTTP stream connection is closed and the server-side ffmpeg process is killed

Keyboard controls:

- `Space`: play/pause
- `ArrowLeft` / `ArrowRight`: seek -10s / +10s
- `M`: mute
- `F`: fullscreen
- `[` / `]`: adjust audio sync (remux path)
- `Escape`: close overlays or exit flow/fullscreen state

### Settings (`settings.html` + `settings.js`)

- Stream quality preference
- Subtitle color picker/reset
- Source filters (seeders, result limit, language, formats)
- Remux mode preference
- Avatar style presets + custom image crop/resize pipeline
- Cache clear action hitting `/api/debug/cache?clear=1`

### Upload (`upload.html` + `upload.js`)

- Drag/drop or file picker
- Content type: movie or episode
- Filename inference call to `/api/upload/infer`
- Chunked transfer to:
  - `POST /api/upload/session/start`
  - `POST /api/upload/session/chunk`
  - `POST /api/upload/session/finish`

## 5) API Reference

All API routes are served by the Rust backend.

### Config, health, debug

- `GET /api/config`
- `GET /api/health[?refresh=1]`
- `GET /api/debug/cache`
- `GET /api/debug/cache?clear=1`

### Library and uploads

- `GET /api/library`
- `POST /api/upload`
- `POST /api/upload/infer`
- `POST /api/upload/session/start`
- `POST /api/upload/session/chunk?sessionId=...`
- `POST /api/upload/session/finish`

### TMDB

- `GET /api/tmdb/popular-movies?page=...`
- `GET /api/tmdb/details?tmdbId=...&mediaType=movie|tv`
- `GET /api/tmdb/tv/season?tmdbId=...&seasonNumber=...`

### Resolver

- `GET /api/resolve/sources?...` (candidate list)
- `GET /api/resolve/movie?...`
- `GET /api/resolve/tv?...`

Common resolver query params include:

- `tmdbId`
- `audioLang`
- `quality`
- `subtitleLang`
- `sourceHash`
- `minSeeders`
- `allowedFormats`
- `sourceLang`

TV-specific params:

- `seasonNumber` / `season`
- `episodeNumber` / `episodeOrdinal`

### Playback, subtitles, preferences, sessions

- `GET /api/media/tracks?input=...&audioLang=...&subtitleLang=...`
- `GET /api/remux?input=...&start=...&audioStream=...&subtitleStream=...&audioSyncMs=...&videoMode=...`
- `GET /api/hls/master.m3u8?input=...&audioStream=...`
- `GET /api/hls/segment.ts?input=...&index=...&audioStream=...`
- `GET /api/subtitles.vtt?input=...&subtitleStream=...`
- `GET /api/subtitles.external.vtt?download=...`
- `GET|POST|DELETE /api/title/preferences`
- `POST /api/session/progress`

## 6) Environment Variables

Copy `.env.example` to `.env` and fill required keys.

Required integrations:

- `TMDB_API_KEY` (TMDB v3 API key or v4 read access token)
- `REAL_DEBRID_TOKEN`

Runtime:

- `TORRENTIO_BASE_URL`
- `TORZNAB_API_URL` (optional fallback discovery endpoint; empty disables it)
- `TORZNAB_API_KEY` (optional)
- `TORZNAB_MOVIE_CATEGORIES` (default `2000,2040,2045`)
- `TORZNAB_TV_CATEGORIES` (default `5000,5040,5045`)
- `TORZNAB_LIMIT` (default `50`, max `100`)
- `TORZNAB_TIMEOUT_MS` (default `15000`)
- `HOST`
- `PORT`
- `MAX_UPLOAD_BYTES`
- `HLS_HWACCEL` (`none|auto|videotoolbox|cuda|qsv`)
- `HLS_MAX_TRANSCODE_JOBS` (default `1`)
- `HLS_MAX_SEGMENT_RENDERS` (default `2`)
- `HLS_SEGMENT_QUEUE_TIMEOUT_MS` (default `2000`)
- `AUTO_AUDIO_SYNC` (`0|1`)
- `REMUX_VIDEO_MODE` (`auto|copy|normalize`)
- `REMUX_MAX_CONCURRENT` (default `2`)
- `REMUX_QUEUE_TIMEOUT_MS` (default `2000`)
- `REMUX_PROCESS_TIMEOUT_SECONDS` (default `14400`)
- `RESOLVER_MAX_CONCURRENT` (default `2`)
- `RESOLVER_QUEUE_TIMEOUT_MS` (default `3000`)
- `PLAYBACK_SESSIONS` (`0|1`)

Torznab fallback notes:

- The primary discovery backend remains Torrentio. Torznab is only queried when Torrentio fails, returns no usable candidates, all Torrentio candidates fail to resolve, or a pinned `sourceHash` is missing from Torrentio.
- Use a generic Torznab URL from Prowlarr, Jackett, or another compatible indexer. Examples: `http://127.0.0.1:9696/1/api` for Prowlarr or `http://127.0.0.1:9117/api/v2.0/indexers/yts/results/torznab/api` for Jackett.
- Prefer a filtered/specific indexer endpoint over Jackett's broad `all` endpoint so searches stay fast and relevant.
- Torznab is discovery-only. Real-Debrid still resolves the selected magnet/info hash into a playable link.

## 7) Data, Cache, and Persistence

### LocalStorage keys

- `netflix-stream-quality-pref`
- `netflix-subtitle-color-pref`
- `netflix-source-filter-min-seeders`
- `netflix-source-filter-allowed-formats`
- `netflix-source-filter-language`
- `netflix-source-filter-results-limit`
- `netflix-remux-video-mode`
- `netflix-profile-avatar-style`
- `netflix-profile-avatar-mode`
- `netflix-profile-avatar-image`
- `netflix-audio-lang:movie:<tmdbId>`
- `netflix-subtitle-lang:movie:<tmdbId>`
- `netflix-subtitle-stream:movie:<tmdbId>`
- `netflix-resume:<sourceIdentity>`
- `netflix-continue-watching-meta`

### Server-managed persistence/caching

- In-memory TTL caches for TMDB responses, resolved streams, quick-start and lookup data
- Persistent cache tables used for resolved data/session/probe/source-health/title-preference retention
- Periodic cache sweeping and stale upload-session cleanup

### Local media files

- Upload temp files under `cache/uploads`
- Final media files under `assets/videos`
- Catalog metadata in `assets/library.json`

## 8) Local Development

Prerequisites:

- Rust toolchain
- Bun or another package runner if you want to use the `package.json` scripts
- `ffmpeg` and `ffprobe` on `PATH`
Setup:

```bash
cp .env.example .env
bun install
bun run dev
```

Open:

- `http://127.0.0.1:5173`

Scripts:

- `bun run dev` -> Rust server
- `bun run bench:playback:install` -> installs the Chromium browser used by the playback benchmark suite
- `bun run bench:playback -- --source assets/videos/<file>.mp4` -> runs a headless playback comparison across direct, remux, and native-HLS transport paths
- `bun run bench:load -- --source assets/videos/<file>.mp4` -> runs a multi-client HLS segment load benchmark against a running backend
- `bun run bench:resolve -- --tmdb-id <id>` -> runs a multi-client resolver coalescing benchmark against a running backend

### Playback Benchmark Suite

The repo includes a browser-driven playback benchmark that exercises the real `/player` page in headless Chromium.

It measures:

- cold-start playback latency
- pause/resume latency
- seek latency
- dropped-frame ratio
- effective decoded frame rate
- frame processing duration from `requestVideoFrameCallback`
- transport bytes received for remux/native-HLS/direct playback during startup, steady-state playback, and the full run

It can rank strategies for different goals:

- `balanced` -> general playback quality and responsiveness
- `latency` -> fastest startup / seek / resume
- `efficiency` -> lowest transport overhead while maintaining decode quality

Example:

```bash
bun run bench:playback:install
bun run bench:playback -- --source assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4
```

You can also compare explicit remux modes:

```bash
bun run bench:playback -- \
  --source assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4 \
  --strategy direct,remux:auto,remux:copy,remux:normalize,hls
```

JSON output is also supported:

```bash
bun run bench:playback -- \
  --source assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4 \
  --objective efficiency \
  --output tmp/playback-benchmark.json
```

For server-side pressure testing, run the HLS load benchmark against an already-running backend:

```bash
bun run bench:load -- \
  --base-url http://127.0.0.1:5173 \
  --source assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4 \
  --clients 4 \
  --segments 6 \
  --pattern staggered
```

Use `--pattern same` to verify duplicate clients collapse onto shared segment cache work, and `--output tmp/playback-load.json` to keep the full per-client report.

To pressure-test the resolver path, run concurrent identical resolve requests and compare `/api/health.resolver` before and after:

```bash
bun run bench:resolve -- \
  --base-url http://127.0.0.1:5173 \
  --media-type movie \
  --tmdb-id 4348 \
  --title "Pride & Prejudice" \
  --year 2005 \
  --clients 4 \
  --output tmp/resolver-load.json
```

The report includes success count, p50/p95 latency, unique resolved sources, and resolver deltas such as `coalescedWaits`, `externalStarted`, and `externalRejected`.
- `bun run dev:rust` -> Rust server
- `bun run dev:vite` -> frontend-only Vite dev server
- `bun run build` / `bun run preview` -> Vite build/preview flow

## 9) Operational Notes

- `bun run dev` is the full-stack runtime: Rust serves `/api/*` and the frontend.
- `bun run dev:vite` is frontend-only and does not replace the Rust backend APIs.
- Upload processing depends on ffmpeg availability.
- Upload compatibility handling:
  - media is probed after upload
  - audio-only AAC transcode can be applied when enabled and needed
- Cache clear from Settings applies globally (all titles/sources).

### Mac mini direct server deployment

The Mac mini at `m4mini.local` is the always-on server for this app. The MacBook
checkout remains the development repo.

Development machine:

- Path: `/Users/erlinhoxha/Developer/netflix`
- Git-tracked source of truth.
- Local media is stored under `/Users/erlinhoxha/Movies/...`.
- `assets/videos` should contain symlinks only and should not store real video files.
- Some full-catalog titles are intentionally not present on the MacBook to save space. For example, Requiem for a Dream and Hot Fuzz are kept on the Mac mini, not locally.

Server machine:

- Host: `hermes@m4mini.local`
- Runtime path: `/Users/hermes/Developer/netflix`
- Public hostnames: `fightingentropy.org` and `www.fightingentropy.org`
- Public ingress: Cloudflare DNS-only `A` records -> home public IP -> router TCP `80`/`443` -> Mac mini `192.168.1.189`
- Reverse proxy: Caddy on `:80` and `:443`
- Backend listener: `127.0.0.1:5173`
- Runtime tree only:
  - `assets`
  - `bin`
  - `cache`
  - `dist`
- The server deploy is not a git checkout and intentionally has no `.git`, source folders, `node_modules`, Rust `target`, `Cargo.toml`, or `package.json`.

Server processes are supervised by system LaunchDaemons:

- `/Library/LaunchDaemons/com.fightingentropy.netflix-app.plist`
- `/Library/LaunchDaemons/com.fightingentropy.netflix-caddy.plist`

The app daemon runs:

- Working directory: `/Users/hermes/Developer/netflix`
- Backend binary: `/Users/hermes/Developer/netflix/bin/netflix-rust-backend`
- Launcher script: `/Users/hermes/.local/bin/netflix-run-backend`

The Caddy daemon runs:

- Binary: `/usr/local/bin/caddy`
- Config: `/Users/hermes/.config/caddy/Caddyfile`
- TLS: Caddy-managed public certificates
- Data dir: `/var/db/netflix-caddy`

Secrets on the server live outside the deploy tree:

- Env file: `/Users/hermes/.config/netflix/env`
- Permissions: `600`
- Do not put server secrets back into `/Users/hermes/Developer/netflix/.env`.

Server logs:

- Backend stdout: `/Users/hermes/.local/state/netflix/backend.log`
- Backend stderr: `/Users/hermes/.local/state/netflix/backend.err.log`
- Caddy stdout: `/Users/hermes/.local/state/netflix/caddy.log`
- Caddy stderr: `/Users/hermes/.local/state/netflix/caddy.err.log`
- Caddy access log: `/Users/hermes/.local/state/netflix/caddy-access.log`
- Log rotation script: `/Users/hermes/.local/bin/netflix-rotate-logs`
- Log rotation LaunchAgent: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.netflix-log-rotation.plist`
- Rotation schedule: daily at `03:17`

Disk monitoring:

- Monitor script: `/Users/hermes/.local/bin/netflix-disk-monitor`
- LaunchAgent: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.netflix-disk-monitor.plist`
- Schedule: hourly
- Thresholds: warn at `90%` disk usage or below `50G` free
- Log: `/Users/hermes/.local/state/netflix/disk-monitor.log`

Watchdog/self-healing:

- Watchdog script: `/Users/hermes/.local/bin/netflix-watchdog`
- LaunchAgent: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.netflix-watchdog.plist`
- Schedule: every `60` seconds and at load
- Probe: `GET http://127.0.0.1:5173/api/library`
- Restart threshold: `3` consecutive failed probes
- Restart behavior: logs the failed probe reason, kills stale `ffmpeg` processes, stops the backend, then restarts it through the app LaunchDaemon or `/Users/hermes/.local/bin/netflix-run-backend`
- Log: `/Users/hermes/.local/state/netflix/watchdog.log`

MacBook helper scripts:

- `bun run mini:install-server` -> installs/updates Caddy, the backend runner, and the app/Caddy LaunchDaemons.
- `bun run mini:map-ports` -> creates router UPnP forwards for TCP `80` and `443` to the mini.
- `CF_API_TOKEN=... bun run mini:update-dns` -> sets DNS-only `A` records for the mini's current home public IP.
- `bun run mini:check` -> verifies the mini runtime, Caddy, public app response, app login, asset shape, env permissions, maintenance agents, disk space, and that the old Cloudflare Tunnel is gone.
- `bun run mini:deploy` -> builds locally, syncs `dist`, the backend binary, and non-video assets, restarts the mini backend, then runs `mini:check`.
- `bun run mini:deploy -- --skip-build` -> deploys existing local build artifacts and restarts/checks the mini.
- `bun run mini:deploy -- --video assets/videos/<file>.mp4` -> copies that symlink target as a real file to the mini.
- `bun run mini:install-agents` -> installs/updates the log rotation, disk monitor, and watchdog LaunchAgents on the mini.
- `bun run mini:backup -- <backup-root>` -> creates a timestamped full mini backup.
- `bun run mini:backup -- --config-only <backup-root>` -> backs up only secrets/config/plists/helper scripts.

Health checks:

```bash
ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'curl -sS -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:5173'

ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'curl -sS -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1/api/library'

curl -sSI --max-time 10 https://fightingentropy.org | sed -n '1,8p'
```

Expected results:

- Mini backend: `200`
- Mini Caddy proxy: `200`
- Public host: `HTTP/2 200`
- Public app auth when logged out: `401`

Deploying code changes from the MacBook:

```bash
bun run mini:deploy
```

`mini:deploy` intentionally does not sync `assets/videos`.

Deploying assets:

- Do not run `rsync --delete assets/` from the MacBook to the Mac mini. The MacBook no longer has the full catalog locally, and `--delete` would remove mini-only videos.
- To update non-video asset metadata, sync only the explicit files/directories:

```bash
rsync -a -e 'ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes' \
  assets/library.json hermes@m4mini.local:/Users/hermes/Developer/netflix/assets/library.json

rsync -a --delete -e 'ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes' \
  assets/images/ hermes@m4mini.local:/Users/hermes/Developer/netflix/assets/images/

rsync -a --delete -e 'ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes' \
  assets/icons/ hermes@m4mini.local:/Users/hermes/Developer/netflix/assets/icons/
```

- To add a new local symlinked video from the MacBook to the mini, follow symlinks and copy the target as a real file:

```bash
rsync -aL --partial -e 'ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes' assets/videos/<file>.mp4 \
  hermes@m4mini.local:/Users/hermes/Developer/netflix/assets/videos/<file>.mp4
```

If a future deploy should intentionally remove a title from the Mac mini, delete that specific file explicitly on the mini and update `assets/library.json`.

Backups:

- Use an external drive or another large volume for full backups. The mini assets are about `153G`.
- Full backup example:

```bash
bun run mini:backup -- /Volumes/Backup/netflix-mini
```

- Config-only backup example:

```bash
bun run mini:backup -- --config-only ~/Backups/netflix-mini-config
```

The backup script writes timestamped snapshots and maintains a `latest` symlink. Full backups use `rsync --link-dest` against the previous snapshot when available, so unchanged files can be hard-linked on backup volumes that support hard links.

Restore outline for a replacement Mac mini:

1. Copy `runtime/{assets,bin,cache,dist}` from the latest backup to `/Users/hermes/Developer/netflix`.
2. Restore `config/env` to `/Users/hermes/.config/netflix/env` and set permissions to `600`.
3. Restore `caddy/` to `/Users/hermes/.config/caddy`.
4. Restore `local-bin/netflix-run-backend`, `local-bin/netflix-rotate-logs`, `local-bin/netflix-disk-monitor`, and `local-bin/netflix-watchdog` to `/Users/hermes/.local/bin` and make them executable.
5. Run `bun run mini:install-server` and `bun run mini:install-agents` from the MacBook checkout.
6. Run `bun run mini:map-ports` or configure router forwards manually.
7. Verify Cloudflare DNS-only `A` records point at the current home public IP.
8. Run `bun run mini:check` from the MacBook checkout.

## 10) Troubleshooting

- `TMDB`/resolver errors:
  - verify `TMDB_API_KEY`, `REAL_DEBRID_TOKEN`, optional `TORZNAB_API_URL` / `TORZNAB_API_KEY`, and network access
- Upload fails:
  - ensure file is `.mp4`/`.mkv`
  - check `MAX_UPLOAD_BYTES`
  - ensure ffmpeg is installed
- Subtitles unavailable:
  - stream may not include text subtitle track
  - external subtitle provider may not have matching data
- Playback stutter/compatibility issues:
  - use remux mode `normalize` for toughest sources
  - check `/api/health` and `/api/config` for ffmpeg/hwaccel status and remux pressure
  - browser-safe Real-Debrid MP4 sources are tried directly first, with remux kept as a fallback
  - remux-prone MKV/WebM/AVI/WMV/TS sources prefer native HLS on browsers that support it, so seeks reuse cached HLS segments instead of restarting remux
  - `HLS_HWACCEL=auto` uses VideoToolbox on macOS when available
- Audio out of sync:
  - often caused by non-browser-safe audio codecs (AC3, DTS, TrueHD) that need re-encoding to AAC — the original audio start time offset can be lost during transcode
  - the server auto-detects audio/video start time offsets and applies `adelay` compensation when `AUTO_AUDIO_SYNC=1`
  - this applies to MKV sources, normalize mode, and any source with audio that needs re-encoding
  - manual sync can also be adjusted with `[` / `]` keys during remux playback
- Zombie ffmpeg processes / high CPU after seeking:
  - each seek on a remux stream may spawn a new server-side ffmpeg process
  - the backend caps simultaneous remux jobs with `REMUX_MAX_CONCURRENT` and returns HTTP 429 after `REMUX_QUEUE_TIMEOUT_MS`
  - `/api/health` exposes active, canceled, rejected, timed-out, and failed remux counters
  - the Mac mini watchdog restarts the backend after repeated failed `/api/library` probes and kills stale `ffmpeg` during restart
- Stale service worker causing page load failures or screen flashing:
  - if a `sw.js` was previously registered and the file no longer exists, the stale service worker will intercept fetches and fail
  - fix: Chrome DevTools -> Application -> Service Workers -> Unregister, then clear site data and hard refresh (Cmd+Shift+R)
- Clean URL icons/assets broken:
  - all asset paths in the player must be absolute (e.g. `/assets/icons/...`) since the page loads at `/watch/<slug>` — relative paths resolve incorrectly
  - similarly, navigation links must be absolute (`/` not `index.html`)

## 11) Clean URL Routing

The player supports clean URLs: `/watch/<slug>` and `/watch/<slug>/<episodeIndex>`.

### How it works

1. Vite middleware in `vite.config.js` rewrites `/watch/*` requests to `player.html`
2. On page load, the player parses the URL path to extract the slug and optional episode index
3. The slug is looked up against `assets/library.json` to resolve the media entry and populate query params
4. `history.replaceState` is called synchronously at module scope to avoid a visible URL flash from query params to the clean URL
5. Series resolution variables are re-derived after the async slug lookup completes (they use `let` not `const` to allow this)

### Important conventions

- All asset paths (icons, images) must be absolute — the page loads at `/watch/<slug>`, so relative paths break
- Navigation back to home must use `/` not `index.html`
- Do not use `<base href="/">` — it interferes with Vite HMR WebSocket connections

## 12) Remux Pipeline Notes

### Video modes

- `copy`: stream-copies video, re-encodes audio to AAC. Fast, low CPU. Used for MP4 sources.
- `normalize`: re-encodes video (H.264) + audio (AAC). High CPU but maximum compatibility. Used for MKV/WebM sources or when the video codec is not browser-safe.
- `auto` (default): picks `copy` or `normalize` based on container format and codec probing.

### Audio sync compensation

When audio needs re-encoding (AC3, DTS, etc.), the original audio start time offset may differ from the video start time. The server probes both timestamps and applies:
- `adelay` filter for positive offsets (audio starts after video)
- `atrim` + `asetpts` for negative offsets (audio starts before video)
- `aresample=async=1000:first_pts=0` when video PTS is also reset (normalize mode)
- `aresample=async=1000` when video is copied (preserves original video PTS)

### Seeking and process cleanup

Each seek on a remux stream starts a new ffmpeg process with `-ss <seconds>`. The frontend explicitly tears down the previous `<video>` source before setting the new URL, which closes the HTTP connection and allows the server to kill the old ffmpeg child process via `kill_on_drop(true)`.

### HEVC / 4K content

4K HEVC content in MP4 containers is stream-copied (no server-side re-encoding), but the browser must decode it — this is CPU-intensive and can cause fan noise. Hardware HEVC decoding depends on browser and GPU support.
