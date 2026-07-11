# StreamArena

A private streaming app backed by a Rust/Axum server and a multi-page SolidJS/Vite frontend.

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
- Discovery: TMDB metadata, selected external embed fallbacks, and user-enabled Torrentio/Torznab plus Real-Debrid torrent resolution.
- Local library: `assets/library.json` plus uploaded/managed videos under `assets/videos`.
- Persistence: two SQLite files — durable accounts/user data in `cache/users.sqlite`, and regenerable cache/resolver state in `cache/resolver-cache.sqlite` (the latter self-heals if corrupt; the former is never auto-wiped).
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
```

OpenSubtitles and Torznab are optional. Real-Debrid API tokens are saved per user in Settings.

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
   Sports provider traffic can instead use `SPORTS_HTTP_PROXY` so only sports schedules, sports stream API calls, and sports browser HLS extraction go through that proxy.
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
4. For default unpinned TMDB playback, the resolver ranks native HLS providers by quality and learned health, starts with VidLink on a neutral install, then quickly rotates through VidRock, NoTorrent, VixSrc, LordFlix, and VidEasy sources when a provider fails. Providers with poor health are skipped from auto-fallback; Icefy remains manually selectable only.
5. The player probes tracks when needed through `/api/media/tracks`, selects audio/subtitle streams, and chooses direct, HLS, remux, local torrent, or local cache playback.
6. If the external HLS path fails in the browser, the player retries with `skipExternalEmbed=1`; Torrentio/Torznab torrent sources are only considered when the current user has saved a Real-Debrid API token in Settings, and local torrent/cache playback stays off unless the user also enables Local torrent cache in Settings.
7. Playback progress is stored locally for responsiveness and synced to `/api/user/watch-progress`, `/api/user/continue-watching`, and `/api/session/progress` when enabled.

External movie/TV embed stack:

- Default neutral order: VidLink native HLS -> VidRock native HLS -> NoTorrent native HLS -> VixSrc native HLS -> LordFlix native HLS -> VidEasy native HLS. Provider/source health is recorded from resolver and playback success/failure events, so healthier sources move up over time and unhealthy ones are skipped from auto-fallback. Torrent sources require a Real-Debrid API token in Settings; local torrent/cache additionally requires the Local torrent cache setting.
- Selectable sources include VidLink, VidRock, NoTorrent, VixSrc, LordFlix, Icefy, the VidEasy default source, and VidEasy server sources Yoru, Neon, Cypher, Sage, Breach, Vyse, and Raze, with original/alternate audio hints shown in the player server menu. Selected movie/TV external sources must resolve to native HLS; the resolver does not hand off to the provider iframe.
- VidEasy embeds are built from `https://player.videasy.to/movie/...` or `/tv/...`; the legacy `player.videasy.net` redirect is still accepted by the resolver. Extracted HLS playlists are accepted on public HTTPS hosts discovered by the trusted resolver.
- VidLink embeds are built from `https://vidlink.pro/movie/...` or `/tv/...`; extracted HLS playlist hosts include `storm.vodvidl.site` and `typhoontigertribe.net`.
- VidLink HLS resolves through a native Node/WASM token path first, with Playwright kept as a fallback. VidEasy HLS still resolves through Playwright. The mini deploy copies `scripts/resolve-external-embed-hls.mjs` to `bin/resolve-external-embed-hls.mjs` and keeps resolver Node dependencies under `~/.local/share/streamarena-node` outside the app runtime tree. Icefy, VidRock, NoTorrent, VixSrc, and LordFlix are resolved by backend API adapters. All native providers must return a public HTTPS playlist that validates as `#EXTM3U`; the backend signs those proxy URLs before playback.
- Native external HLS playback is proxied through protected `/api/live/hls.m3u8` and `/api/live/hls-resource` so playlist child URLs, segment URLs, and required referers stay under backend control. Resolver-minted proxy URLs carry an expiry-bound HMAC; the same absolute expiry propagates to rewritten child playlists, keys, and segments. Authenticated allowlisted live-channel requests and browser-direct CDN URLs keep their existing unsigned/direct paths.
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
- Library editor mode via `streamarena-library-edit-mode`, with edit/delete support for local movies and series entries.
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
- User-enabled local torrent streaming through `/api/local-torrent/stream`.
- User-enabled direct local cache streaming through `/api/local-cache/stream`.
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

- The browser upload page has been removed; uploads are API-only and require an administrator session.
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

- `/api/health` reports uptime, streaming counters, resolver counters, sports resolver health, and cached ffmpeg/ffprobe capabilities. Forcing a capability refresh requires an administrator session.
- `/api/config` reports configured integrations, resolver providers, upload limit, remux/HLS limits, and effective hardware acceleration.
- Administrator-only `/api/debug/cache` reports persistent and in-memory cache counts; its POST clear operation removes persistent resolver/TMDB/session/media caches and HLS cache data.
- Administrator-only `/api/debug/sports` reports sports schedule cache, stream resolver cache, and provider health details.
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

- `GET /api/health` (`refresh=1` requires an administrator session)
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

- `GET /api/library`
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

Administrator API routes:

- `PUT /api/library`
- `GET|POST /api/debug/cache`
- `GET /api/debug/sports`
- `POST /api/upload/infer`
- `POST /api/upload`
- `POST /api/upload/session/start`
- `POST /api/upload/session/chunk?sessionId=...`
- `POST /api/upload/session/finish`
- `POST /api/gallery/save-stream`

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

Required for TMDB browsing and external embed playback:

- `TMDB_API_KEY` - TMDB v3 API key or v4 read access token.

Per-user Settings:

- Real-Debrid API token - enables Torrentio/Torznab torrent source discovery and Real-Debrid resolution for that user.
- Local torrent cache - separately enables local torrent/cache playback for that user, and still requires a saved Real-Debrid API token.

Real-Debrid tokens are encrypted at rest with AES-256-GCM. Configure an
operator-managed key ring before a user saves a token:

```bash
printf 'rd-2026-07:'
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Store the resulting `key-id:base64url-key` value in
`REAL_DEBRID_TOKEN_ENCRYPTION_KEYS`. The first comma-separated entry is the
active write key; later entries are decrypt-only rotation keys. On startup the
server authenticates every encrypted token, encrypts all legacy plaintext rows,
and rewrites rows using older keys before accepting traffic. Startup fails
closed when stored tokens exist but the key ring is absent, malformed, or
cannot authenticate every row.

To rotate, prepend a newly generated key with a new id, retain the old entries,
and restart once. After that startup succeeds and all rows have been rewritten,
the old entries can be removed on a subsequent restart. Back up the canonical
key ring separately from SQLite: losing every matching key makes the stored
tokens intentionally unrecoverable. Never reuse a key id with different bytes.

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
- `OPEN_SIGNUP` - public registration, disabled by default. Keep it `0` in production.
- `SIGNUP_INVITE_CODE` - optional secret that permits viewer registration while public sign-up is closed.
- `BOOTSTRAP_ADMIN_EMAIL` - optional admin-bootstrap email. Bootstrap requires the matching email and `SIGNUP_INVITE_CODE`; remove this setting once the admin exists.
- `REAL_DEBRID_TOKEN_ENCRYPTION_KEYS` - comma-separated `key-id:base64url-key` ring for per-user Real-Debrid tokens. Each key is 32 random bytes; the first entry is active and retained entries support rotation.
- `OUTBOUND_HTTP_PROXY` - optional HTTP/SOCKS proxy for server outbound requests.
- `SPORTS_HTTP_PROXY` - optional HTTP/SOCKS proxy only for sports provider schedule/stream requests and sports browser HLS extraction. For Cloudflare WARP proxy mode this is typically `socks5://127.0.0.1:40000`.
- `MAX_UPLOAD_BYTES` - default 10 GiB, clamped to at least 50 MiB.

Embed/live resolver helpers:

- `EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-external-embed-hls.mjs` when present, otherwise `bin/resolve-external-embed-hls.mjs`; set to `0`/`off` to disable native external HLS extraction.
- `EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS` - per-provider timeout budget for native HLS resolution; default 8000. Direct API providers are capped lower internally for quick rotation.
- `EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS` - total native HLS extraction budget before falling back to the normal resolver stack; default 26000. Movie/TV external embeds that do not expose native HLS are not returned as iframes.
- `LIVE_HLS_PROXY_SECRET` - optional shared signing secret for dynamic external HLS proxy URLs; generated at startup when omitted. Set this for multi-instance deployments and to the same Worker secret. Signed URLs use a four-hour TTL; backend and Worker allow 60 seconds of clock skew and reject expiries more than six hours in the future.
- `LIVE_HLS_EMIT_LEGACY_SIGNATURE` - deployment-transition switch only. `1` emits both the old v1 `sig` and expiry-bound `sigV2`; default `0` emits only expiry-bound v2 in `sig`.
- `LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL` - deployment-transition deadline only, expressed as absolute Unix seconds. Missing-expiry v1 URLs are rejected by default; when set, the deadline must be no more than six hours ahead and acceptance stops automatically after it (plus clock skew).
- `VIDLINK_NATIVE_ASSET_CACHE_TTL_MS` - TTL for cached VidLink native token assets fetched by the Node resolver; default 7200000.
- `STREAMED_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-streamed-hls.mjs` when present, otherwise `bin/resolve-streamed-hls.mjs`; set to `0`/`off` to disable.
- `MATCHSTREAM_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-matchstream-hls.mjs` when present, otherwise `bin/resolve-matchstream-hls.mjs`; set to `0`/`off` to disable.
- `NTVS_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-ntvs-hls.mjs` when present, otherwise `bin/resolve-ntvs-hls.mjs`; set to `0`/`off` to disable.
- `SPORTS_RESOLVER_MAX_CONCURRENT` - max concurrent sports Playwright HLS resolver jobs; default 2.
- `SPORTS_RESOLVER_QUEUE_TIMEOUT_MS` - max time a sports stream resolve waits for resolver capacity; default 3000.
- `EXTERNAL_EMBED_BROWSER_PROXY` - optional Playwright proxy override for external embeds.
- `STREAMED_EMBED_BROWSER_PROXY` - optional Playwright proxy override for Streamed sports embeds.
- `MATCHSTREAM_BROWSER_PROXY` - optional Playwright proxy override for MatchStream sports embeds.
- `NTVS_EMBED_BROWSER_PROXY` - optional Playwright proxy override for NTVS sports embeds.

Supported movie/TV native HLS hosts:

- Native HLS providers: `player.videasy.to`, `vidlink.pro`, `streams.icefy.top`, `vidrock.net`, `vixsrc.to`, and LordFlix servers.
- Native HLS playlist outputs: public HTTPS playlists discovered and validated by the trusted resolver. Localhost, IP-literal, and internal-style hosts are rejected.
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

- Torrentio remains the primary torrent discovery source when the current user has a Real-Debrid API token saved.
- Torznab is a fallback for missing/failed Torrentio results or pinned hashes absent from Torrentio.
- Torznab is discovery only. Real-Debrid or user-enabled local torrent/cache still supplies the playable media path.
- Prefer filtered Prowlarr/Jackett endpoints over broad `all` endpoints.

## Data And Persistence

Server-managed files:

- `cache/users.sqlite` - durable SQLite DB for accounts: users, auth sessions, preferences, watch progress, continue-watching, My List, password-reset/email-verification tokens, and service-health history. Never auto-quarantined.
- `cache/resolver-cache.sqlite` - regenerable SQLite cache: resolver/session/TMDB/probe caches. Self-heals from corruption (quarantine + rebuild). On first boot after the split, durable rows are migrated out of here into `users.sqlite`.
- `cache/hls/` - generated HLS playlists/segments and transcode work.
- `cache/local-torrents/` - local torrent files and direct file cache.
- `cache/uploads/` - active upload sessions and temp files.
- `assets/library.json` - local library metadata.
- `assets/videos/` - local video files or symlinks in development.
- `assets/images/` and `assets/icons/` - library artwork, live channel art, and app icons.

`cache/users.sqlite` (durable, never auto-wiped) stores:

- Users and auth sessions.
- User preferences.
- Watch progress.
- Continue watching entries.
- My List entries.
- Password-reset and email-verification tokens.
- Service-health history (health samples + restart log) backing the admin dashboard.

`cache/resolver-cache.sqlite` (regenerable, self-heals from corruption) stores:

- TMDB response cache. General metadata defaults to a short TTL, while watched TV series details/seasons/episode metadata are kept for 30 days and refreshed in the background.
- Resolved stream cache.
- Movie quick-start cache.
- Playback sessions.
- Source health stats.
- Media probe cache.
- Per-user, movie/TV-scoped title track preferences. Older unscoped preference rows are migrated into a neutral legacy scope instead of being assigned to a real user.

Browser localStorage keys currently used:

- `streamarena-default-audio-lang`
- `streamarena-subtitle-color-pref`
- `streamarena-profile-avatar-style`
- `streamarena-profile-avatar-mode`
- `streamarena-profile-avatar-image`
- `streamarena-library-edit-mode`
- `streamarena-audio-lang:movie:<tmdbId>`
- `streamarena-subtitle-lang:movie:<tmdbId>`
- `streamarena-subtitle-stream:movie:<tmdbId>`
- `streamarena-subtitle-lang:local:<source>`
- `streamarena-subtitle-stream:local:<source>`
- `streamarena-source-audio-sync:<sourceHash>`
- `streamarena-playback-speed`
- `streamarena-resume:<sourceIdentity>`
- `streamarena-continue-watching-meta`
- `streamarena-my-list-v1`
- `streamarena-watch-params:<slug>`
- `streamarena-featured-hero-v2`

Legacy `netflix-*` keys from before the rebrand are migrated to the
`streamarena-*` namespace once per browser (see `src-ui/lib/storage-migration.js`),
so existing users keep their resume positions, My List, and settings.

Deprecated keys intentionally pruned by the current app:

- `streamarena-hero-trailer-muted-v2`
- `streamarena-source-filter-allowed-formats`
- `streamarena-source-filter-results-limit`
- `streamarena-source-filter-min-seeders`
- `streamarena-source-filter-language`
- `streamarena-source-filter-audio-profile`
- `streamarena-resolver-provider`
- `streamarena-remux-video-mode`

## Scripts

Development and checks:

- `bun run dev` - build the frontend, then run the Rust server.
- `bun run dev:rust` - run `cargo run` only. Use after `dist/` exists or alongside `dev:vite`.
- `bun run dev:vite` - run the Vite dev server on `localhost:4173` with `/api` proxied to Rust.
- `bun run build` - Vite production build to `dist/`.
- `bun run preview` - Vite preview server.
- `bun run lint:frontend` - JavaScript syntax check for `src-ui`, `scripts`, and `vite.config.js`.
- `bun run test:rust` - Rust tests.
- `bun run test:worker` - live-HLS Worker signature/expiry contract tests.
- `bun run test:frontend` - Playwright smoke test against a mocked API.
- `bun run check:rust` - Rust formatting and Clippy with warnings denied.
- `bun run audit:rust` - RustSec dependency audit using the locally installed advisory database.
- `bun run check:quality` - Rust format, Clippy, and dependency security gates. Install `cargo-audit` first with `cargo install cargo-audit --locked`.
- `bun run check:architecture` - guardrails for app shape, frontend dependencies, entrypoints, source sizes, and bundle sizes.
- `bun run check` - frontend lint, build, architecture check, Rust tests, live-HLS Worker tests, and frontend smoke test.

Benchmarks:

- `bun run bench:playback:install` - install Playwright Chromium.
- `bun run bench:playback -- --source assets/videos/<file>.mp4` - browser playback benchmark across direct/remux/HLS strategies.
- `bun run bench:load -- --source assets/videos/<file>.mp4` - HLS load benchmark against a running backend.
- `bun run bench:resolve -- --tmdb-id <id>` - concurrent resolver benchmark against a running backend.

Mac mini:

- `bun run mini:install-server` - install/update Caddy, backend runner, and LaunchDaemons.
- `bun run mini:install-agents` - install/update log rotation, disk monitor, and watchdog LaunchAgents; also removes obsolete hero-preview jobs/files.
- `bun run mini:map-ports` - create router UPnP forwards for TCP 80 and 443.
- `CF_API_TOKEN=... bun run mini:update-dns` - update Cloudflare-proxied A records with automatic TTL.
- `bun run mini:check` - verify runtime tree, protected API auth status, Caddy, launchd, env permissions, sports WARP proxy, resolver helpers, agents, disk space, and public response.
- `bun run mini:deploy` - run quality/tests, stage a release while retaining the previous artifacts, deploy `dist`, backend binary, library metadata, images, and icons, then restart/check. Failed post-restart verification leaves the new binary active because database migrations can be forward-only; the retained artifacts are for deliberate, schema-aware recovery only.
- `bun run mini:deploy -- --skip-build` - reuse existing `dist/` and release binary.
- `bun run mini:deploy -- --video assets/videos/<file>.mp4` - copy that symlink target as a real mini video file.
- `bun run mini:backup -- <backup-root>` - full timestamped backup.
- `bun run mini:backup -- --config-only <backup-root>` - backup secrets/config/plists/helper scripts only.

Internal resolver helpers:

- `scripts/resolve-external-embed-hls.mjs` - VidLink native Node/WASM and VidEasy Playwright helper for movie/TV native HLS extraction.
- `scripts/resolve-streamed-hls.mjs` - Playwright helper for Streamed sports HLS extraction; mini deploy copies it to `bin/resolve-streamed-hls.mjs`.
- `scripts/resolve-matchstream-hls.mjs` - Playwright helper for MatchStream sports HLS extraction; mini deploy copies it to `bin/resolve-matchstream-hls.mjs`.
- `scripts/resolve-ntvs-hls.mjs` - Playwright helper for NTVS/Embed.st sports HLS extraction; mini deploy copies it to `bin/resolve-ntvs-hls.mjs`.

## Mobile app

The Expo app lives in `mobile/` and is checked independently in CI. From that directory:

- `npm ci` - install the locked Expo SDK 56 dependency graph.
- `npm run typecheck` - TypeScript validation.
- `npm run lint` - Expo ESLint validation.
- `npm test` - metadata and signing-plugin regressions.
- `npm run doctor` - Expo project/dependency diagnostics.
- `npm run build:ios` - produce a clean iOS Metro export (also run in CI).
- `EXPO_IOS_DEVELOPMENT_TEAM=<team-id> npm run ios` - opt into automatic signing for a local device build. Without the variable, generated Xcode signing settings are left untouched.

## Mac Mini Infrastructure

Development machine:

- Checkout: `/Users/erlinhoxha/Developer/streamarena`.
- Source of truth is the git checkout.
- Large media should not be committed.
- `assets/videos` should contain symlinks or local-only files in development.

Server machine:

- Host: `hermes@m4mini.local`.
- Runtime path: `/Users/hermes/Developer/streamarena`.
- Public hosts: `streamarena.xyz` and `www.streamarena.xyz`.
- Ingress: Cloudflare-proxied A records -> Cloudflare edge -> home public IP -> router TCP 80/443 -> Mac mini. Caddy accepts public origin traffic only from Cloudflare's published edge ranges.
- Reverse proxy: Caddy on ports 80 and 443.
- Backend listener: `127.0.0.1:5173`.
- Runtime tree only:
  - `assets`
  - `bin`
  - `cache`
  - `dist`

The server deploy is intentionally not a git checkout. It should not contain `.git`, source folders, `node_modules`, `target`, `Cargo.toml`, `package.json`, or `.env`.
Resolver Node dependencies live outside this tree at `~/.local/share/streamarena-node`.

Sports proxy/WARP:

- The Mac mini runs Cloudflare WARP in local proxy mode for blocked sports providers.
- WARP CLI: `/usr/local/bin/warp-cli`.
- Expected WARP status: `Connected`.
- Expected WARP mode: `WarpProxy on port 40000`.
- Server env file: `/Users/hermes/.config/streamarena/env`.
- Required sports env: `SPORTS_HTTP_PROXY=http://127.0.0.1:40000`.
- Existing full-backend proxy env may also point at the same listener: `OUTBOUND_HTTP_PROXY=http://127.0.0.1:40000`.
- Streamed may fail directly from the ISP path; the expected healthy path is through WARP's local proxy.
- `scripts/check-mini.sh` validates WARP status, WARP proxy mode, the `SPORTS_HTTP_PROXY` value, and real proxied Streamed/NTVS football schedule requests.
- `scripts/deploy-mini.sh` deploys resolver helpers:
  - `bin/resolve-external-embed-hls.mjs` for movie/TV native HLS.
  - `bin/resolve-streamed-hls.mjs` for Streamed sports native HLS.
  - `bin/resolve-matchstream-hls.mjs` for MatchStream sports native HLS.
  - `bin/resolve-ntvs-hls.mjs` for NTVS sports native HLS.

Useful sports proxy checks:

```bash
ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"; warp-cli --accept-tos status; warp-cli --accept-tos settings list | grep -E "Mode:|WARP tunnel protocol"'

ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'curl -sS --proxy http://127.0.0.1:40000 -o /dev/null -w "%{http_code}\n" --max-time 12 https://streamed.pk/api/matches/football'

curl -sS --max-time 60 \
  'https://streamarena.xyz/api/sports/stream?url=https%3A%2F%2Fstreamed.pk%2Fapi%2Fstream%2Fadmin%2Fppv-crystal-palace-vs-rayo-vallecano' \
  | python3 -m json.tool
```

LaunchDaemons:

- App: `/Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist`
- Caddy: `/Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist`

Backend daemon:

- Working directory: `/Users/hermes/Developer/streamarena`
- Binary: `/Users/hermes/Developer/streamarena/bin/streamarena-backend`
- Runner: `/Users/hermes/.local/bin/streamarena-run-backend`

Caddy daemon:

- Binary: `/usr/local/bin/caddy`
- Config: `/Users/hermes/.config/caddy/Caddyfile`
- TLS: Caddy-managed public certs by default
- Data dir: `/var/db/streamarena-caddy`

Secrets:

- Env file: `/Users/hermes/.config/streamarena/env`
- Required permissions: `600`
- Do not put server secrets back into `/Users/hermes/Developer/streamarena/.env`.

Logs:

- Backend stdout: `/Users/hermes/.local/state/streamarena/backend.log`
- Backend stderr: `/Users/hermes/.local/state/streamarena/backend.err.log`
- Caddy stdout: `/Users/hermes/.local/state/streamarena/caddy.log`
- Caddy stderr: `/Users/hermes/.local/state/streamarena/caddy.err.log`
- Caddy access log: `/Users/hermes/.local/state/streamarena/caddy-access.log`
- Disk monitor log: `/Users/hermes/.local/state/streamarena/disk-monitor.log`
- Watchdog log: `/Users/hermes/.local/state/streamarena/watchdog.log`

Maintenance LaunchAgents:

- Log rotation: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.streamarena-log-rotation.plist`
- Disk monitor: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.streamarena-disk-monitor.plist`
- Watchdog: `/Users/hermes/Library/LaunchAgents/com.fightingentropy.streamarena-watchdog.plist`

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

curl -sSI --max-time 10 https://streamarena.xyz | sed -n '1,8p'
```

Expected results:

- Mini backend root: `200`
- Protected `/api/library` without login: `401`
- Public host root: `302` to the login page
- Public `/api/auth/me` without login: `401`

### Live HLS signature rollout

The Worker and backend must move from timeless v1 signatures to expiry-bound v2
without stranding an active player. Normal operation is strict: leave
`LIVE_HLS_EMIT_LEGACY_SIGNATURE=0` and
`LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL` unset in both runtimes.

For the one-time rollout, prefer Worker first:

1. Choose one absolute deadline four hours ahead (`deadline=$(($(date +%s) + 14400))`). Never choose more than six hours ahead.
2. Put that value in the Worker's temporary binding before deploying the new Worker: `printf '%s' "$deadline" | npx wrangler secret put LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL --config workers/live-hls-proxy/wrangler.jsonc`. Wrangler secret updates deploy a Worker version immediately, so setting it while the old code is live is safe—the old code ignores it.
3. Deploy `workers/live-hls-proxy` with `npx wrangler deploy --config workers/live-hls-proxy/wrangler.jsonc`. It accepts old missing-expiry v1 URLs only until the deadline and accepts v2 immediately.
4. Set the same `LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL` in the mini's canonical env, keep `LIVE_HLS_EMIT_LEGACY_SIGNATURE=0`, then deploy/restart the backend. New URLs now contain only `expires` plus v2 `sig`; already-open v1 streams remain valid only for the bounded window.
5. After the deadline, verify a v1 URL without `expires` is rejected, remove the mini deadline, and run `npx wrangler secret delete LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL --config workers/live-hls-proxy/wrangler.jsonc`.

If operational constraints force backend-first order, temporarily set
`LIVE_HLS_EMIT_LEGACY_SIGNATURE=1` together with the same deadline. The backend
then emits v1 in `sig` for the old Worker and expiry-bound v2 in `sigV2` for the
new origin. Deploy the Worker next, immediately return the backend flag to `0`
and restart it, then perform step 5. Once the deadline passes, removing
`expires` cannot downgrade either dual-signed or strict URLs to v1.

The Worker uses Cloudflare's standard `crypto.subtle` Web Crypto binding for
HMAC verification; keep its constants and fixed-vector test aligned with
`src/live.rs`. See Cloudflare's [Web Crypto runtime documentation](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) and [Wrangler secret commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret).

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
bun run mini:backup -- /Volumes/Backup/streamarena-mini
bun run mini:backup -- --config-only ~/Backups/streamarena-mini-config
```

Full backups include runtime assets, binary, cache, dist, secrets/config, helper scripts, and launchd plists. SQLite databases are copied through consistent `.backup` snapshots and verified with `PRAGMA quick_check`; the script maintains a `latest` symlink and uses `rsync --link-dest` when possible.

Restore outline:

1. Copy `runtime/{assets,bin,cache,dist}` from backup to `/Users/hermes/Developer/streamarena`.
2. Restore `config/env` to `/Users/hermes/.config/streamarena/env` and set permissions to `600`.
3. Restore Caddy config to `/Users/hermes/.config/caddy`.
4. Restore helper scripts to `/Users/hermes/.local/bin` and make them executable.
5. Run `bun run mini:install-server`.
6. Run `bun run mini:install-agents`.
7. Run `bun run mini:map-ports` or configure router forwards manually.
8. Verify Cloudflare-proxied A records target the current home public IP.
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

- Check `TMDB_API_KEY`, the user's Real-Debrid token in Settings, and network access.
- If using Torznab, check `TORZNAB_API_URL`, `TORZNAB_API_KEY`, category IDs, and timeout.
- If local torrent is selected or auto-used, check the Local torrent cache setting, local disk budget, and `cache/local-torrents`.

Movie/TV external embed fails:

- Install Playwright Chromium with `scripts/deploy-mini.sh` or, for local development, `bun run bench:playback:install`.
- Check `EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT`, `EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS`, and `EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS`.
- Confirm the host is one of the supported native providers: VidLink, VidRock, NoTorrent, VixSrc, LordFlix, Icefy, or VidEasy.
- If running multiple backend instances, set a shared `LIVE_HLS_PROXY_SECRET` so resolver-signed HLS URLs verify on every instance.
- If a provider needs a VPN/proxy, set `EXTERNAL_EMBED_BROWSER_PROXY`; if server outbound requests also need the proxy, set `OUTBOUND_HTTP_PROXY`.

Live sports stream fails:

- Install Playwright Chromium with `bun run bench:playback:install`.
- Check `STREAMED_HLS_RESOLVER_SCRIPT`, `MATCHSTREAM_HLS_RESOLVER_SCRIPT`, or `NTVS_HLS_RESOLVER_SCRIPT`.
- If the default sports source fails to load, switch the `/sports` source picker to MatchStream or leave it on Auto so the backend can fall back when Streamed is unreachable.
- If a sports provider needs a proxy, set `SPORTS_HTTP_PROXY`; use provider-specific browser proxy overrides only when a browser extractor needs a different proxy from the schedule/API requests.

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

- Ignored local artifacts such as `.DS_Store`, `tmp/`, `dist/`, and `target/` are disposable and can be regenerated. `cache/resolver-cache.sqlite*` is regenerable cache and safe to reset, but `cache/users.sqlite*` holds accounts/user data — do not delete it unless you intentionally want to wipe local auth/user state.
- Vite is updated to 8.x. Direct Rust dependency baselines are current for this app: Reqwest 0.13, Quick XML 0.40, Rusqlite 0.40, and Getrandom 0.4. Cargo may still report transitive crates held behind latest by upstream constraints.
- Live HLS, live HLS resources, and Twitch stream resolving routes are protected API routes.
- Upstream resolver/request errors are sanitized so TMDB, Torznab, Real-Debrid, live/embed, and Twitch failures do not echo secret-bearing URLs or tokens.
- Title track preferences are scoped by user and media type, with a migration for the old `tmdb_id`-only table.
- Hero-preview generation has been removed from package scripts, deployment, agent installation, and mini checks.
- `assets/hero-previews.json` and `scripts/refresh-hero-previews.py` are deleted in this worktree.
- The old one-off Interstellar mini helper scripts have been removed.
- `scripts/install-mini-agents.sh` removes any stale hero-preview LaunchAgent, helper, manifest, deployed script, and cached preview folder from the Mac mini.
- `scripts/check-mini.sh` now validates only the current maintenance agents: log rotation, disk monitor, and watchdog.
- External movie/TV fallback cleanup is complete: VidLink, VidRock, NoTorrent, VixSrc, LordFlix, Icefy, and VidEasy native HLS remain the active provider stack; VidEasy's named server sources are selectable, and external iframe handoff is not used for movie/TV playback.
- Dead external providers and experiment knobs from the earlier investigation have been removed from resolver/provider lists, proxy allowlists, tests, and `.env.example`.
