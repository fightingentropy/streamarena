# Netflix App

A private Netflix-style streaming app backed by a Rust/Axum server and a multi-page SolidJS/Vite frontend.

The app serves local library titles, resolves remote movie and TV sources, plays live channels, shows live sports schedules, tracks per-user progress, and deploys to an always-on Mac mini behind Caddy.

## Contents

1. Current App Shape
2. Quick Start
3. How The App Works
4. Features
5. Pages
6. Backend API
7. Configuration
8. Data And Persistence
9. Scripts
10. Mac Mini Infrastructure
11. Troubleshooting
12. Cleanup Notes

## Current App Shape

The repository is a single full-stack app:

- Backend: Rust 2024, Axum 0.8, Tokio, Reqwest 0.13, and SQLite via `rusqlite` 0.40.
- Frontend: SolidJS with Vite 8 in multi-page app mode.
- Player: custom HTML5 video UI with direct playback, remux, HLS, subtitles, live streams, and source switching.
- Discovery: TMDB metadata, selected external embed fallbacks, Torrentio source discovery, optional Torznab fallback, Real-Debrid unrestricted links, and local torrent streaming/cache.
- Local library: `assets/library.json` plus uploaded/managed videos under `assets/videos`.
- Persistence: SQLite cache and user data in `cache/resolver-cache.sqlite`.
- Production target: a Mac mini runtime tree served locally on `127.0.0.1:5173` and exposed through Caddy.

Important paths:

- `src/` - Rust services, routes, static serving, auth, resolver, media processing, uploads, live/sports, persistence.
- `src-ui/entries/` - page entrypoints loaded by each HTML shell.
- `src-ui/pages/` - Solid page components for home, login, player, settings, live, and sports.
- `src-ui/player/` - player-specific helpers for sources, HLS, subtitles, episodes, fullscreen, resume, and live stream menus.
- `assets/library.json` - local catalog. It currently contains empty `movies` and `series` arrays in this checkout.
- `public/` - PWA manifest, service worker, and offline page copied by Vite into `dist/`.
- `scripts/` - development checks, benchmarks, resolver helpers, and Mac mini deployment/maintenance tools.

## Quick Start

Prerequisites:

- Rust toolchain.
- Bun, or another package runner that can run the `package.json` scripts.
- Node.js, used by Vite and resolver helper scripts.
- `ffmpeg` and `ffprobe` on `PATH`.
- Playwright Chromium if you use frontend smoke tests, playback benchmarks, or embed HLS resolver scripts.

Setup:

```bash
cp .env.example .env
bun install
bun run bench:playback:install
```

Fill `.env` with at least:

```bash
TMDB_API_KEY=...
REAL_DEBRID_TOKEN=...
```

OpenSubtitles and Torznab are optional but improve subtitles and fallback source discovery.

Run the full app:

```bash
bun run dev
```

Then open:

```text
http://127.0.0.1:5173
```

The first visit should go through `login.html`. Create an account, then the app stores an HttpOnly `session` cookie and syncs profile/preferences/progress through the server.

Frontend-only development:

```bash
cargo run
bun run dev:vite
```

Then open:

```text
http://127.0.0.1:4173
```

Vite proxies `/api/*` to the Rust backend on `127.0.0.1:5173`. The Rust server is still required for auth, library data, resolving, uploads, remux, HLS, live/sports, and user sync.

## How The App Works

Startup flow:

1. `src/main.rs` loads `.env`, builds `Config`, initializes the SQLite database, and creates shared services.
2. The app creates a shared HTTP client. If `OUTBOUND_HTTP_PROXY` is set, server outbound HTTP uses that proxy.
   Sports provider traffic can instead use `SPORTS_HTTP_PROXY` so only sports schedules, sports stream API calls, and Streamed browser HLS extraction go through that proxy.
3. Services are wired into `AppState`: TMDB, media probing/subtitles, local torrent/cache, resolver, streaming/remux/HLS, uploads, runtime ffmpeg capabilities, sports schedule cache, and home bootstrap cache.
4. A background task runs every 60 seconds to sweep stale SQLite/cache data, upload sessions, and streaming jobs.
5. `HomeBootstrapCache` starts warming TMDB/home data as soon as the server boots.
6. Recent watched/listed TV series warm their TMDB details, season catalogs, external IDs, and current/next episode metadata into the persistent SQLite cache shortly after startup.
7. Axum serves public API routes, protected API routes behind auth middleware, and static frontend files.

Static file flow:

1. `bun run dev` runs `vite build`, producing `dist/`.
2. If `dist/` exists, the Rust server serves frontend files from `dist/`; otherwise it falls back to the repo root for local development.
3. `/assets/*` is served from the repo `assets/` directory so local library artwork and videos remain outside the Vite bundle.
4. `/watch/...` maps to `player.html`; extensionless page routes such as `/sports` map to their `.html` page.
5. `index.html` is special: Rust injects the current home bootstrap payload when possible, and the HTML also starts a fallback `/api/home/bootstrap` fetch before the home bundle loads.

Frontend page flow:

1. Each HTML shell loads a page entry from `src-ui/entries/`.
2. Authenticated entries call `mountAuthenticatedPage`, mount the UI immediately, hydrate browser storage from `/api/user/*`, and redirect to `login.html` if `/api/auth/me` returns `401`.
3. `login.html` uses `mountPublicPage`, handles sign in/sign up, and migrates old localStorage preferences/progress/list data to the server.
4. The service worker from `public/sw.js` is registered by `mount-page.js` and caches app shell files, icons, the manifest, and offline fallback pages. API calls and video files are not cached by the service worker.

Playback flow for TMDB titles:

1. The player reads URL params such as `tmdbId`, `mediaType`, `title`, `year`, `seasonNumber`, `episodeNumber`, `audioLang`, `quality`, `subtitleLang`, `sourceHash`, and `sessionKey`.
2. It applies stored quality/audio/subtitle preferences and remembered continue-watching source state.
3. It calls `/api/resolve/movie` or `/api/resolve/tv`.
4. For default unpinned TMDB playback, the resolver tries the native external HLS stack first: VidEasy Yoru, VidEasy default, then VidLink.
5. The player probes tracks when needed through `/api/media/tracks`, selects audio/subtitle streams, and chooses direct, HLS, remux, local torrent, or local cache playback.
6. If the external HLS path fails in the browser, the player retries with `skipExternalEmbed=1`; the resolver then uses persisted sessions, Torrentio, optional Torznab, Real-Debrid, local torrent/cache, and source health.
7. Playback progress is stored locally for responsiveness and synced to `/api/user/watch-progress`, `/api/user/continue-watching`, and `/api/session/progress` when enabled.

External movie/TV embed stack:

- Default order: VidEasy Yoru native HLS -> VidEasy default native HLS -> VidLink native HLS -> external iframe fallback -> Real-Debrid -> local torrent/cache.
- Selectable VidEasy server sources include Yoru, Neon, Cypher, Sage, Breach, Vyse, and Raze, with their original/alternate audio hints shown in the player server menu. Only Yoru and the default VidEasy source are part of automatic external fallback.
- VidEasy embeds are built from `https://player.videasy.net/movie/...` or `/tv/...`; extracted HLS playlists are accepted on public HTTPS hosts discovered by the trusted resolver.
- VidLink embeds are built from `https://vidlink.pro/movie/...` or `/tv/...`; extracted HLS playlist hosts include `storm.vodvidl.site` and `typhoontigertribe.net`.
- Native external HLS is resolved by `scripts/resolve-external-embed-hls.mjs` through Playwright in development. The mini deploy copies this helper to `bin/resolve-external-embed-hls.mjs` and keeps Playwright under `~/.local/share/netflix-node` outside the app runtime tree. The backend only accepts VidEasy/VidLink embed URLs, accepts public HTTPS `.m3u8` outputs discovered by that trusted resolver, and signs those proxy URLs before playback.
- Native external HLS playback is proxied through protected `/api/live/hls.m3u8` and `/api/live/hls-resource` so playlist child URLs, segment URLs, and required referers stay under backend control.
- Iframe-only movie/TV providers are intentionally excluded so playback stays inside the app's own controls.
- Older/failed and iframe-only providers such as VidKing, 2Embed, VidSrc, VidNest, AutoEmbed, SuperEmbed, Embed.su, and MoviesAPI are intentionally not part of the current stack.

Playback flow for local titles:

1. Home reads local library entries from `assets/library.json`.
2. A local movie or episode opens `/watch?...` with reproducible query params containing `src` or TMDB identity, title metadata, artwork, and optional audio/subtitle params.
3. The player treats explicit `src` URLs as local/direct playback, probes tracks, prefers the configured audio language when possible, and falls back to remux/HLS for browser-incompatible codecs.

Live and sports flow:

1. `/live` renders static live channels from `src-ui/lib/live-channels.js`.
2. HLS live channel playlists and segments are proxied through protected `/api/live/hls.m3u8` and `/api/live/hls-resource` with an allowlist in `src/live.rs`.
3. Twitch-backed live sources resolve through protected `/api/twitch/stream`.
4. `/sports` fetches schedules for football, basketball, tennis, hockey, baseball, American football, and cricket through `src/football.rs`; the default Auto source merges Streamed and MatchStream schedules so both providers show up in the live stream picker.
5. Live sports streams resolve through protected `/api/sports/stream`; the server uses short-lived HLS resolution caching, bounded Playwright concurrency, `scripts/resolve-streamed-hls.mjs` for Streamed, and `scripts/resolve-matchstream-hls.mjs` for MatchStream.

## Features

Authentication and user sync:

- Sign up, sign in, sign out.
- HttpOnly session cookie with 30-day max age.
- Protected app APIs via auth middleware.
- Server-backed preferences, watch progress, continue watching, and My List.
- Legacy localStorage migration on login.
- Browser localStorage remains a fast local mirror for UI state.

Home and browsing:

- Featured hero sourced from current TMDB/bootstrap data.
- Dashboard rails use TMDB discovery with rating/vote-count thresholds, release-date guards, and artwork checks instead of raw popularity/trending lists.
- Rails for curated movies, series, critically acclaimed titles, local library, continue watching, and My List.
- TMDB search across movies and TV.
- Details modal with metadata, cast, playback launch, and My List actions.
- Continue watching entries enriched from local library and server state.
- My List stored locally and synced to `/api/user/my-list`.
- Library editor mode via `netflix-library-edit-mode`, with edit/delete support for local movies and series entries.
- `/live` can be opened as a full page or as an in-home live view.
- `/sports` is linked from navigation.

Player:

- Custom controls: play/pause, seek, volume/mute, fullscreen, playback speed, captions, audio tracks, source selection, episodes, live stream selection, and return navigation.
- Keyboard controls:
  - `Space` - play/pause.
  - `ArrowLeft` / `ArrowRight` - seek backward/forward 10 seconds.
  - `M` - mute.
  - `F` - fullscreen.
  - `[` / `]` - manual audio sync offset for remux playback.
  - `Escape` - close overlays or leave transient UI states.
- Clean watch URLs with saved query params.
- Direct local/media playback.
- TMDB movie and TV resolving.
- Source list popover backed by `/api/resolve/sources`.
- Remembered source hash/session state through continue-watching metadata.
- Direct browser-safe source playback when possible.
- Native browser HLS where supported, with dynamic `hls.js` fallback where needed.
- Server HLS path through `/api/hls/master.m3u8` and `/api/hls/segment.ts`.
- Server remux path through `/api/remux`, including start offsets, audio stream selection, subtitle stream burn-in, manual sync, and video mode.
- Native external HLS from VidEasy/VidLink when those providers resolve cleanly.
- Local torrent streaming through `/api/local-torrent/stream`.
- Direct local cache streaming through `/api/local-cache/stream`.
- Live HLS and explicit live iframe playback.
- Playback recovery for buffering, server errors, offline state, source failure, and alternate source attempts.
- Progress and continue-watching sync.
- Optional `saveToGallery=1` flow through `/api/gallery/save-stream`.

Subtitles and tracks:

- Embedded audio and subtitle probing through `ffprobe`.
- Local sidecar subtitle discovery.
- Embedded subtitle extraction to VTT through `/api/subtitles.vtt`.
- OpenSubtitles search and download when configured.
- OpenSubtitles VTT serving through `/api/subtitles.opensubtitles.vtt`.
- Direct external subtitle conversion through `/api/subtitles.external.vtt`.
- Subtitle language and local subtitle stream preferences.
- Subtitle color preference in Settings.

Programmatic uploads and library management:

- The browser upload page has been removed; uploads are API-only.
- `.mp4` and `.mkv` inputs.
- Movie or episode metadata payloads.
- Filename metadata inference through `/api/upload/infer`.
- Chunked upload sessions:
  - `POST /api/upload/session/start`
  - `POST /api/upload/session/chunk?sessionId=...`
  - `POST /api/upload/session/finish`
- Direct upload fallback through `POST /api/upload`.
- Client-side thumbnail preview generation.
- Server-side probe and compatibility checks.
- MKV-to-MP4 remux during processing.
- Optional audio transcode to AAC for Chrome-compatible playback.
- Library metadata written back to `assets/library.json`.

Settings:

- Default audio language.
- Subtitle color with reset.
- Avatar preset colors or custom uploaded image.
- Preferences are saved to localStorage and `/api/user/preferences`.
- Old stream-quality, source-filter, and remux-mode preference keys are intentionally pruned by the settings page.

Live TV:

- Bloomberg TV US.
- BBC News with official and Roku stream options.
- Sky News.
- ERT1.
- MEGA News.
- ANT1.
- Alpha TV.
- Top News through Twitch-backed resolving.

Sports:

- Tabs for football, basketball, tennis, hockey, baseball, American football, and cricket.
- Schedule grouping by date.
- Live/upcoming state.
- Stream source counts and stream selector handoff to the player.
- Server schedule cache with stale-if-error fallback.

PWA/offline behavior:

- Web app manifest with app icons and Live shortcut.
- Service worker app-shell caching.
- Offline page for navigation fallback.
- API and media streaming requests bypass the service worker cache.

Operational features:

- `/api/health` reports uptime, streaming counters, resolver counters, sports resolver health, and ffmpeg/ffprobe capabilities.
- `/api/config` reports configured integrations, resolver providers, upload limit, remux/HLS limits, and effective hardware acceleration.
- `/api/debug/cache` reports persistent and in-memory cache counts.
- `/api/debug/cache?clear=1` clears persistent resolver/TMDB/session/media caches and HLS cache data.
- `/api/debug/sports` reports sports schedule cache, stream resolver cache, and provider health details.
- Runtime sweeps stale DB/cache/upload/streaming state every minute.

## Pages

`/` and `/index.html`

- Home browse UI.
- Uses injected/fetched home bootstrap data.
- Requires authentication.

`/login.html`

- Public sign-in/sign-up page.
- Migrates old localStorage data to server user tables after successful auth.

`/watch?...` and `/player.html`

- Custom player.
- Accepts direct `src`, TMDB movie/TV params, live params, saved legacy watch params, and source pins.

`/settings.html`

- Authenticated preferences page.

`/live` and `/live.html`

- Authenticated live channel page.

`/sports` and `/sports.html`

- Authenticated sports schedule page.

## Backend API

Public API routes:

- `GET /api/health[?refresh=1]`
- `GET /api/health/live`
- `GET /api/config`
- `GET /api/home/bootstrap`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/football/matches`
- `GET /api/basketball/matches`
- `GET /api/tennis/matches`
- `GET /api/hockey/matches`
- `GET /api/baseball/matches`
- `GET /api/american-football/matches`
- `GET /api/cricket/matches`

Protected API routes:

- `GET|PUT /api/library`
- `GET|POST /api/debug/cache`
- `GET /api/debug/sports`
- `GET /api/twitch/stream`
- `GET /api/live/hls.m3u8`
- `GET /api/live/hls-resource`
- `GET /api/football/stream`
- `GET /api/basketball/stream`
- `GET /api/sports/stream`
- `GET|POST|DELETE /api/title/preferences`
- `POST /api/session/progress`
- `GET /api/tmdb/popular-movies`
- `GET /api/tmdb/search`
- `GET /api/tmdb/details`
- `GET /api/tmdb/tv/season`
- `POST /api/upload/infer`
- `POST /api/upload`
- `POST /api/upload/session/start`
- `POST /api/upload/session/chunk?sessionId=...`
- `POST /api/upload/session/finish`
- `POST /api/gallery/save-stream`
- `GET /api/resolve/sources`
- `GET /api/resolve/movie`
- `GET /api/resolve/tv`
- `GET /api/resolve/local-upgrade`
- `GET|HEAD /api/local-torrent/stream`
- `GET|HEAD /api/local-cache/stream`
- `GET /api/remux`
- `GET /api/hls/master.m3u8`
- `GET /api/hls/segment.ts`
- `GET /api/media/tracks`
- `GET /api/subtitles.vtt`
- `GET /api/subtitles.opensubtitles.vtt`
- `GET /api/subtitles.external.vtt`
- `GET /api/auth/me`
- `GET|PUT /api/user/preferences`
- `GET|PUT|DELETE /api/user/watch-progress`
- `GET|PUT|DELETE /api/user/continue-watching`
- `GET|PUT /api/user/my-list`
- `POST /api/user/sync`

Common resolver query params:

- `tmdbId`
- `mediaType=movie|tv`
- `title`
- `year`
- `audioLang`
- `quality`
- `subtitleLang`
- `preferredContainer=mp4|mkv`
- `sourceHash`
- `sessionKey`
- `minSeeders`
- `allowedFormats`
- `sourceLang`
- `sourceAudioProfile`
- `resolverProvider=fastest|local-torrent|real-debrid`
- `skipExternalEmbed=1`

Title preference params:

- `tmdbId`
- `mediaType=movie|tv`
- `audioLang`
- `subtitleLang`

TV-specific resolver params:

- `seasonNumber` or `season`
- `episodeNumber` or `episodeOrdinal`

## Configuration

Copy `.env.example` to `.env`.

Required for the full remote-resolve experience:

- `TMDB_API_KEY` - TMDB v3 API key or v4 read access token.
- `REAL_DEBRID_TOKEN` - Real-Debrid API token.

Optional integrations:

- `OPENSUBTITLES_API_KEY`
- `OPENSUBTITLES_USER_AGENT`
- `TORRENTIO_BASE_URL`
- `TORZNAB_API_URL`
- `TORZNAB_API_KEY`
- `TORZNAB_MOVIE_CATEGORIES`
- `TORZNAB_TV_CATEGORIES`
- `TORZNAB_LIMIT`
- `TORZNAB_TIMEOUT_MS`

Server:

- `HOST` - default `127.0.0.1`.
- `PORT` - default `5173`.
- `OUTBOUND_HTTP_PROXY` - optional HTTP/SOCKS proxy for server outbound requests.
- `SPORTS_HTTP_PROXY` - optional HTTP/SOCKS proxy only for sports provider schedule/stream requests and Streamed browser HLS extraction. For Cloudflare WARP proxy mode this is typically `socks5://127.0.0.1:40000`.
- `MAX_UPLOAD_BYTES` - default 10 GiB, clamped to at least 50 MiB.

Embed/live resolver helpers:

- `EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-external-embed-hls.mjs` when present, otherwise `bin/resolve-external-embed-hls.mjs`; set to `0`/`off` to disable native external HLS extraction.
- `EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS` - per-provider timeout budget for VidEasy/VidLink native HLS extraction; default 30000.
- `EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS` - total native HLS extraction budget before falling back to the normal resolver stack; default 45000.
- `LIVE_HLS_PROXY_SECRET` - optional shared signing secret for dynamic external HLS proxy URLs; generated at startup when omitted. Set this for multi-instance deployments so signed URLs survive instance changes.
- `STREAMED_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-streamed-hls.mjs` when present, otherwise `bin/resolve-streamed-hls.mjs`; set to `0`/`off` to disable.
- `MATCHSTREAM_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-matchstream-hls.mjs` when present, otherwise `bin/resolve-matchstream-hls.mjs`; set to `0`/`off` to disable.
- `SPORTS_RESOLVER_MAX_CONCURRENT` - max concurrent sports Playwright HLS resolver jobs; default 2.
- `SPORTS_RESOLVER_QUEUE_TIMEOUT_MS` - max time a sports stream resolve waits for resolver capacity; default 3000.
- `EXTERNAL_EMBED_BROWSER_PROXY` - optional Playwright proxy override for external embeds.
- `STREAMED_EMBED_BROWSER_PROXY` - optional Playwright proxy override for Streamed sports embeds.
- `MATCHSTREAM_BROWSER_PROXY` - optional Playwright proxy override for MatchStream sports embeds.

Supported movie/TV native HLS hosts:

- Native HLS embeds: `player.videasy.net`, `vidlink.pro`.
- Native HLS playlist outputs: public HTTPS `.m3u8` URLs discovered from the trusted VidEasy/VidLink resolver. Localhost, IP-literal, and internal-style hosts are rejected.
- The protected live HLS proxy does not accept arbitrary user-supplied `.m3u8` hosts; dynamic external hosts require resolver-signed proxy URLs.

Remux/HLS:

- `HLS_HWACCEL` - `none`, `auto`, `videotoolbox`, `cuda`, or `qsv`.
- `HLS_MAX_TRANSCODE_JOBS`
- `HLS_MAX_SEGMENT_RENDERS`
- `HLS_SEGMENT_QUEUE_TIMEOUT_MS`
- `REMUX_HWACCEL`
- `AUTO_AUDIO_SYNC`
- `REMUX_VIDEO_MODE` - `auto`, `copy`, or `normalize`.
- `REMUX_MAX_CONCURRENT`
- `REMUX_QUEUE_TIMEOUT_MS`
- `REMUX_PROCESS_TIMEOUT_SECONDS`

Resolver/local cache:

- `RESOLVER_MAX_CONCURRENT`
- `RESOLVER_QUEUE_TIMEOUT_MS`
- `LOCAL_TORRENT_MAX_BYTES`
- `LOCAL_TORRENT_METADATA_TIMEOUT_MS`
- `LOCAL_TORRENT_READY_TIMEOUT_MS`
- `PLAYBACK_SESSIONS`

Torznab behavior:

- Torrentio remains the primary discovery source.
- Torznab is a fallback for missing/failed Torrentio results or pinned hashes absent from Torrentio.
- Torznab is discovery only. Real-Debrid or local torrent/cache still supplies the playable media path.
- Prefer filtered Prowlarr/Jackett endpoints over broad `all` endpoints.

## Data And Persistence

Server-managed files:

- `cache/resolver-cache.sqlite` - SQLite DB for auth, user sync, resolver/session/cache data.
- `cache/hls/` - generated HLS playlists/segments and transcode work.
- `cache/local-torrents/` - local torrent files and direct file cache.
- `cache/uploads/` - active upload sessions and temp files.
- `assets/library.json` - local library metadata.
- `assets/videos/` - local video files or symlinks in development.
- `assets/images/` and `assets/icons/` - library artwork, live channel art, and app icons.

SQLite stores:

- Users and auth sessions.
- User preferences.
- Watch progress.
- Continue watching entries.
- My List entries.
- TMDB response cache. General metadata defaults to a short TTL, while watched TV series details/seasons/episode metadata are kept for 30 days and refreshed in the background.
- Resolved stream cache.
- Movie quick-start cache.
- Playback sessions.
- Source health stats.
- Media probe cache.
- Per-user, movie/TV-scoped title track preferences. Older unscoped preference rows are migrated into a neutral legacy scope instead of being assigned to a real user.

Browser localStorage keys currently used:

- `netflix-default-audio-lang`
- `netflix-subtitle-color-pref`
- `netflix-profile-avatar-style`
- `netflix-profile-avatar-mode`
- `netflix-profile-avatar-image`
- `netflix-library-edit-mode`
- `netflix-audio-lang:movie:<tmdbId>`
- `netflix-subtitle-lang:movie:<tmdbId>`
- `netflix-subtitle-stream:movie:<tmdbId>`
- `netflix-subtitle-lang:local:<source>`
- `netflix-subtitle-stream:local:<source>`
- `netflix-source-audio-sync:<sourceHash>`
- `netflix-playback-speed`
- `netflix-resume:<sourceIdentity>`
- `netflix-continue-watching-meta`
- `netflix-my-list-v1`
- `netflix-watch-params:<slug>`
- `netflix-featured-hero-v2`

Deprecated keys intentionally pruned by the current app:

- `netflix-hero-trailer-muted-v2`
- `netflix-source-filter-allowed-formats`
- `netflix-source-filter-results-limit`
- `netflix-source-filter-min-seeders`
- `netflix-source-filter-language`
- `netflix-source-filter-audio-profile`
- `netflix-resolver-provider`
- `netflix-remux-video-mode`

## Scripts

Development and checks:

- `bun run dev` - build the frontend, then run the Rust server.
- `bun run dev:rust` - run `cargo run` only. Use after `dist/` exists or alongside `dev:vite`.
- `bun run dev:vite` - run the Vite dev server on `localhost:4173` with `/api` proxied to Rust.
- `bun run build` - Vite production build to `dist/`.
- `bun run preview` - Vite preview server.
- `bun run lint:frontend` - JavaScript syntax check for `src-ui`, `scripts`, and `vite.config.js`.
- `bun run test:rust` - Rust tests.
- `bun run test:frontend` - Playwright smoke test against a mocked API.
- `bun run check:architecture` - guardrails for app shape, frontend dependencies, entrypoints, source sizes, and bundle sizes.
- `bun run check` - frontend lint, build, architecture check, Rust tests, and frontend smoke test.

Benchmarks:

- `bun run bench:playback:install` - install Playwright Chromium.
- `bun run bench:playback -- --source assets/videos/<file>.mp4` - browser playback benchmark across direct/remux/HLS strategies.
- `bun run bench:load -- --source assets/videos/<file>.mp4` - HLS load benchmark against a running backend.
- `bun run bench:resolve -- --tmdb-id <id>` - concurrent resolver benchmark against a running backend.

Mac mini:

- `bun run mini:install-server` - install/update Caddy, backend runner, and LaunchDaemons.
- `bun run mini:install-agents` - install/update log rotation, disk monitor, and watchdog LaunchAgents; also removes obsolete hero-preview jobs/files.
- `bun run mini:map-ports` - create router UPnP forwards for TCP 80 and 443.
- `CF_API_TOKEN=... bun run mini:update-dns` - update Cloudflare DNS-only A records.
- `bun run mini:check` - verify runtime tree, protected API auth status, Caddy, launchd, env permissions, sports WARP proxy, resolver helpers, agents, disk space, and public response.
- `bun run mini:deploy` - build, deploy `dist`, backend binary, library metadata, images, and icons, then restart/check.
- `bun run mini:deploy -- --skip-build` - reuse existing `dist/` and release binary.
- `bun run mini:deploy -- --video assets/videos/<file>.mp4` - copy that symlink target as a real mini video file.
- `bun run mini:backup -- <backup-root>` - full timestamped backup.
- `bun run mini:backup -- --config-only <backup-root>` - backup secrets/config/plists/helper scripts only.

Internal resolver helpers:

- `scripts/resolve-external-embed-hls.mjs` - Playwright helper for VidEasy/VidLink movie/TV native HLS extraction.
- `scripts/resolve-streamed-hls.mjs` - Playwright helper for Streamed sports HLS extraction; mini deploy copies it to `bin/resolve-streamed-hls.mjs`.
- `scripts/resolve-matchstream-hls.mjs` - Playwright helper for MatchStream sports HLS extraction; mini deploy copies it to `bin/resolve-matchstream-hls.mjs`.

## Mac Mini Infrastructure

Development machine:

- Checkout: `/Users/erlinhoxha/Developer/netflix`.
- Source of truth is the git checkout.
- Large media should not be committed.
- `assets/videos` should contain symlinks or local-only files in development.

Server machine:

- Host: `hermes@m4mini.local`.
- Runtime path: `/Users/hermes/Developer/netflix`.
- Public hosts: `streamthatshit.com` and `www.streamthatshit.com`.
- Ingress: Cloudflare DNS-only A records -> home public IP -> router TCP 80/443 -> Mac mini.
- Reverse proxy: Caddy on ports 80 and 443.
- Backend listener: `127.0.0.1:5173`.
- Runtime tree only:
  - `assets`
  - `bin`
  - `cache`
  - `dist`

The server deploy is intentionally not a git checkout. It should not contain `.git`, source folders, `node_modules`, `target`, `Cargo.toml`, `package.json`, or `.env`.
Playwright resolver dependencies live outside this tree at `~/.local/share/netflix-node`.

Sports proxy/WARP:

- The Mac mini runs Cloudflare WARP in local proxy mode for blocked sports providers.
- WARP CLI: `/usr/local/bin/warp-cli`.
- Expected WARP status: `Connected`.
- Expected WARP mode: `WarpProxy on port 40000`.
- Server env file: `/Users/hermes/.config/netflix/env`.
- Required sports env: `SPORTS_HTTP_PROXY=http://127.0.0.1:40000`.
- Existing full-backend proxy env may also point at the same listener: `OUTBOUND_HTTP_PROXY=http://127.0.0.1:40000`.
- Streamed may fail directly from the ISP path; the expected healthy path is through WARP's local proxy.
- `scripts/check-mini.sh` validates WARP status, WARP proxy mode, the `SPORTS_HTTP_PROXY` value, and a real proxied `https://streamed.pk/api/matches/football` request.
- `scripts/deploy-mini.sh` deploys resolver helpers:
  - `bin/resolve-external-embed-hls.mjs` for movie/TV native HLS.
  - `bin/resolve-streamed-hls.mjs` for Streamed sports native HLS.
  - `bin/resolve-matchstream-hls.mjs` for MatchStream sports native HLS.

Useful sports proxy checks:

```bash
ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"; warp-cli --accept-tos status; warp-cli --accept-tos settings list | grep -E "Mode:|WARP tunnel protocol"'

ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'curl -sS --proxy http://127.0.0.1:40000 -o /dev/null -w "%{http_code}\n" --max-time 12 https://streamed.pk/api/matches/football'

curl -sS --max-time 60 \
  'https://streamthatshit.com/api/sports/stream?url=https%3A%2F%2Fstreamed.pk%2Fapi%2Fstream%2Fadmin%2Fppv-crystal-palace-vs-rayo-vallecano' \
  | python3 -m json.tool
```

LaunchDaemons:

- App: `/Library/LaunchDaemons/com.fightingentropy.netflix-app.plist`
- Caddy: `/Library/LaunchDaemons/com.fightingentropy.netflix-caddy.plist`

Backend daemon:

- Working directory: `/Users/hermes/Developer/netflix`
- Binary: `/Users/hermes/Developer/netflix/bin/netflix-rust-backend`
- Runner: `/Users/hermes/.local/bin/netflix-run-backend`

Caddy daemon:

- Binary: `/usr/local/bin/caddy`
- Config: `/Users/hermes/.config/caddy/Caddyfile`
- TLS: Caddy-managed public certs by default
- Data dir: `/var/db/netflix-caddy`

Secrets:

- Env file: `/Users/hermes/.config/netflix/env`
- Required permissions: `600`
- Do not put server secrets back into `/Users/hermes/Developer/netflix/.env`.

Logs:

- Backend stdout: `/Users/hermes/.local/state/netflix/backend.log`
- Backend stderr: `/Users/hermes/.local/state/netflix/backend.err.log`
- Caddy stdout: `/Users/hermes/.local/state/netflix/caddy.log`
- Caddy stderr: `/Users/hermes/.local/state/netflix/caddy.err.log`
- Caddy access log: `/Users/hermes/.local/state/netflix/caddy-access.log`
- Disk monitor log: `/Users/hermes/.local/state/netflix/disk-monitor.log`
- Watchdog log: `/Users/hermes/.local/state/netflix/watchdog.log`

Maintenance LaunchAgents:

- Log rotation: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.netflix-log-rotation.plist`
- Disk monitor: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.netflix-disk-monitor.plist`
- Watchdog: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.netflix-watchdog.plist`

Current maintenance defaults:

- Log rotation runs daily at 03:17 and keeps compressed rotated logs.
- Disk monitor runs hourly, warning at 90 percent disk usage or below 50 GiB free.
- Watchdog probes `http://127.0.0.1:5173/api/health/live` every 60 seconds with a 10 second timeout, restarts after 3 failed probes by default, kills stale `ffmpeg`, and restarts through launchd or the runner script.

Health checks:

```bash
ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'curl -sS -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:5173/api/health/live'

ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'curl -sS -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:5173/api/library'

curl -sSI --max-time 10 https://streamthatshit.com | sed -n '1,8p'
```

Expected results:

- Mini backend root: `200`
- Protected `/api/library` without login: `401`
- Public host root: `200`
- Public `/api/auth/me` without login: `401`

Deploying code:

```bash
bun run mini:deploy
```

Deploying assets:

- `mini:deploy` syncs `assets/library.json`, `assets/images/`, and `assets/icons/`.
- It does not sync all of `assets/videos`.
- Do not run `rsync --delete assets/` from the MacBook to the Mac mini, because the MacBook may not have the full mini video catalog.
- Use `bun run mini:deploy -- --video assets/videos/<file>.mp4` for an explicit video.

Backups:

```bash
bun run mini:backup -- /Volumes/Backup/netflix-mini
bun run mini:backup -- --config-only ~/Backups/netflix-mini-config
```

Full backups include runtime assets, binary, cache, dist, secrets/config, helper scripts, and launchd plists. The script maintains a `latest` symlink and uses `rsync --link-dest` when possible.

Restore outline:

1. Copy `runtime/{assets,bin,cache,dist}` from backup to `/Users/hermes/Developer/netflix`.
2. Restore `config/env` to `/Users/hermes/.config/netflix/env` and set permissions to `600`.
3. Restore Caddy config to `/Users/hermes/.config/caddy`.
4. Restore helper scripts to `/Users/hermes/.local/bin` and make them executable.
5. Run `bun run mini:install-server`.
6. Run `bun run mini:install-agents`.
7. Run `bun run mini:map-ports` or configure router forwards manually.
8. Verify Cloudflare DNS-only A records point at the current home public IP.
9. Run `bun run mini:check`.

## Troubleshooting

Cannot sign in or protected APIs return `401`:

- Create an account from `login.html`.
- Check that cookies are allowed for the host.
- On the public site, `GET /api/auth/me` should return `401` when logged out and `200` when logged in.

Home is empty or only shows local titles:

- Check `TMDB_API_KEY`.
- Check `/api/home/bootstrap`.
- Check `/api/health` and server logs for TMDB/network errors.

Resolver errors:

- Check `TMDB_API_KEY`, `REAL_DEBRID_TOKEN`, and network access.
- If using Torznab, check `TORZNAB_API_URL`, `TORZNAB_API_KEY`, category IDs, and timeout.
- If local torrent is selected or auto-used, check local disk budget and `cache/local-torrents`.

Movie/TV external embed fails:

- Install Playwright Chromium with `scripts/deploy-mini.sh` or, for local development, `bun run bench:playback:install`.
- Check `EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT`, `EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS`, and `EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS`.
- Confirm the host is one of the supported native providers: VidEasy or VidLink.
- If running multiple backend instances, set a shared `LIVE_HLS_PROXY_SECRET` so resolver-signed HLS URLs verify on every instance.
- If a provider needs a VPN/proxy, set `EXTERNAL_EMBED_BROWSER_PROXY`; if server outbound requests also need the proxy, set `OUTBOUND_HTTP_PROXY`.

Live sports stream fails:

- Install Playwright Chromium with `bun run bench:playback:install`.
- Check `STREAMED_HLS_RESOLVER_SCRIPT`.
- If the default sports source fails to load, switch the `/sports` source picker to MatchStream or leave it on Auto so the backend can fall back when Streamed is unreachable.
- If a sports provider needs a proxy, set `SPORTS_HTTP_PROXY`; use `STREAMED_EMBED_BROWSER_PROXY` only when the Streamed browser extractor needs a different proxy from the schedule/API requests.

Upload fails:

- Confirm file extension is `.mp4` or `.mkv`.
- Increase `MAX_UPLOAD_BYTES` for large files.
- Confirm `ffmpeg` and `ffprobe` are available.
- Check `cache/uploads` and backend logs.

Playback stutters or fails:

- Check `/api/health` for ffmpeg availability, streaming counters, and resolver counters.
- Use HLS or remux fallback for MKV/WebM/HEVC/audio-codec issues.
- `HLS_HWACCEL=auto` uses VideoToolbox on macOS when supported.
- `REMUX_VIDEO_MODE=normalize` is more expensive but can help difficult timestamp/container cases.

Audio is out of sync:

- Keep `AUTO_AUDIO_SYNC=1`.
- Use `[` and `]` in the player to adjust remux audio sync manually.
- Some sources lose timing metadata when audio must be transcoded to AAC.

Repeated seeking creates high CPU:

- Remux seeks can create new ffmpeg processes.
- `REMUX_MAX_CONCURRENT`, `REMUX_QUEUE_TIMEOUT_MS`, and `REMUX_PROCESS_TIMEOUT_SECONDS` cap the damage.
- The Mac mini watchdog kills stale ffmpeg processes during backend restart.

Stale service worker:

- Open browser DevTools -> Application -> Service Workers.
- Unregister `/sw.js`.
- Clear site data and hard refresh.

## Cleanup Notes

Current cleanup state:

- Ignored local artifacts such as `.DS_Store`, `tmp/`, `dist/`, and `target/` are disposable and can be regenerated. `cache/resolver-cache.sqlite*` is local app state, so do not delete it unless you intentionally want to reset local auth/user/cache data.
- Vite is updated to 8.x. Direct Rust dependency baselines are current for this app: Reqwest 0.13, Quick XML 0.40, Rusqlite 0.40, and Getrandom 0.4. Cargo may still report transitive crates held behind latest by upstream constraints.
- Live HLS, live HLS resources, and Twitch stream resolving routes are protected API routes.
- Upstream resolver/request errors are sanitized so TMDB, Torznab, Real-Debrid, live/embed, and Twitch failures do not echo secret-bearing URLs or tokens.
- Title track preferences are scoped by user and media type, with a migration for the old `tmdb_id`-only table.
- Hero-preview generation has been removed from package scripts, deployment, agent installation, and mini checks.
- `assets/hero-previews.json` and `scripts/refresh-hero-previews.py` are deleted in this worktree.
- The old one-off Interstellar mini helper scripts have been removed.
- `scripts/install-mini-agents.sh` removes any stale hero-preview LaunchAgent, helper, manifest, deployed script, and cached preview folder from the Mac mini.
- `scripts/check-mini.sh` now validates only the current maintenance agents: log rotation, disk monitor, and watchdog.
- External movie/TV fallback cleanup is complete: VidEasy/VidLink native HLS remains the active provider stack; VidEasy's named server sources are selectable, and external iframe is kept as a last-resort player handoff when native HLS extraction fails.
- Dead external providers and experiment knobs from the earlier investigation have been removed from resolver/provider lists, proxy allowlists, tests, and `.env.example`.
