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

Security-sensitive module ownership, replay semantics, and network trust
boundaries are defined in [`docs/architecture-security.md`](docs/architecture-security.md).

## Current App Shape

The repository is a single full-stack app:

- Backend: Rust 2024, Axum 0.8, Tokio, Reqwest 0.13, and SQLite via `rusqlite` 0.39.
- Frontend: SolidJS with Vite 8 in multi-page app mode.
- Player: custom HTML5 video UI with direct playback, remux, HLS, subtitles, live streams, and source switching.
- Discovery: TMDB metadata, selected external embed fallbacks, and user-enabled Torrentio/Torznab magnet resolution with optional Real-Debrid acceleration.
- Local library: `assets/library.json` plus uploaded/managed videos under `assets/videos`.
- Persistence: two SQLite files — durable accounts/user data in `cache/users.sqlite`, and regenerable cache/resolver state in `cache/resolver-cache.sqlite` (the latter self-heals if corrupt; the former is never auto-wiped).
- Production target: a Mac mini runtime tree served locally on `127.0.0.1:5173` and exposed through Caddy.

Important paths:

- `src/` - Rust services, routes, static serving, auth, resolver, media processing, uploads, live/sports, persistence.
- `src/persistence/` - append-only migration and replay-safe user-state domains behind the persistence facade.
- `src-ui/entries/` - page entrypoints loaded by each HTML shell.
- `src-ui/pages/` - Solid page components for home, login, player, settings, live, and sports.
- `src-ui/player/` - player-specific helpers for sources, HLS, subtitles, episodes, fullscreen, resume, and live stream menus.
- `src-ui/lib/replay-safe-state.js` - persistent monotonic versions for offline/retried user-state mutations.
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
4. For default unpinned TMDB playback, the resolver starts with the highest-ranked eligible native HLS source using the same provider rank and learned health as the Server menu. Admin rank overrides apply to automatic selection as well as the menu. If a candidate fails or stalls, the resolver races subsequent eligible candidates with a staggered start. Unhealthy and manual-only sources are excluded from automatic selection; explicit source selections remain pinned.
5. The player probes tracks when needed through `/api/media/tracks`, selects audio/subtitle streams, and chooses direct, HLS, remux, local torrent, or local cache playback.
6. If the external HLS path fails in the browser, the player retries with `skipExternalEmbed=1`. Torrentio/Torznab sources are considered whenever the user enables Torrent streaming or explicitly enables Real-Debrid with a saved token. Standalone Torrent streaming resolves magnets through the Mini's local torrent engine; Real-Debrid remains an optional direct-download accelerator.
7. Playback progress is stored locally for responsiveness and synced to `/api/user/watch-progress`, `/api/user/continue-watching`, and `/api/session/progress` when enabled.

External movie/TV embed stack:

- Native HLS source order comes from measured provider tiers, admin overrides, and learned health. The [current-domain benchmark](docs/benchmarks/hls-providers-2026-09-24.json) places CineJoy Lisbon first for consistent 1080-class playback (2200), then faster-starting VixSrc (1800), CineJoy Solara (1600), CineJoy Nebula (1400), and VidLink (1000). Other built-ins share 500 and custom providers default to 300; no measured order is inferred among unsuccessful sources. Current CineJoy results supersede its obsolete-domain baseline failures. Automatic playback follows this order among eligible sources; Solara and Nebula remain manual choices. The first candidate gets a 2.5-second exclusive resolve window, then later candidates hedge every 1.2 seconds; a failed attempt advances immediately. Explicit pins and local-torrent timing are unchanged.
- Variants inherit their family's baseline unless an explicit compiled server tier exists (currently CineJoy Nebula and Solara). An admin family rank shifts every server equally, preserving each compiled server offset; advertised quality labels do not boost the score. Equal scores put automatically eligible sources first, then use alphabetical display order within each group; this does not imply a measured reliability difference. External source rows expose `automaticFallbackEligible` from the existing eligibility and health rules so mobile recovery can skip manual-only or unhealthy sources while keeping them selectable. Provider/source health is recorded from resolver and playback success/failure events, so healthier sources move up over time and unhealthy ones are skipped from auto-fallback. Enabling Torrent streaming makes Torrentio/Torznab magnet sources eligible without Real-Debrid and prioritizes the Mini's local torrent engine for automatic playback.
- Selectable sources include VidLink, VidRock, NoTorrent, VixSrc, LordFlix, Icefy, the VidEasy default source, and VidEasy server sources Yoru, Neon, Cypher, Sage, Breach, Vyse, and Raze, with original/alternate audio hints shown in the player server menu. Selected movie/TV external sources must resolve to native HLS; the resolver does not hand off to the provider iframe.
- VidEasy embeds are built from `https://player.videasy.to/movie/...` or `/tv/...`; the legacy `player.videasy.net` redirect is still accepted by the resolver. Extracted HLS playlists are accepted on public HTTPS hosts discovered by the trusted resolver.
- CineJoy **Lisbon** participates in ranked automatic playback for movies and series on web and iPhone. **Nebula** and **Solara** remain manual choices sharing the same provider budget and admin controls (`embed:cinejoy:enabled` / `embed:cinejoy:rank`), with separate source identities and health records. Explicit selections resolve only the chosen server; automatic requests use the same ranked fallback policy as other providers. CineJoy Nebula is separate from the configured NebulaStreams addon.
- CineJoy runs through the shared `resolve-external-embed-hls.mjs` entrypoint and its `lib/resolve-cinejoy-hls.mjs` adapter, using the existing Playwright installation, extraction switch, and deadline. The adapter pins one server, captures its master URL without downloading media, and closes Chromium. Rust checks the selected server's URL and validates `#EXTM3U` with the fixed CineJoy referer before signing the existing native HLS proxy path. The provider requires that referer, so playback stays proxied.
- CineJoy currently uses `cinejoy.pk` and `api.wing.st` (verified 2026-09-25). Lisbon masters use `ok.solarpanelcleaning.cc/playlist/*.m3u8`, Nebula uses `nebula.bright67.online/hls/*/master.m3u8`, and Solara uses `asm.solarpanelcleaning.cc/content?v=...`. Generated requests use the `.pk` referer; existing signed `.to` playback retains its full-quality behavior. The upstream lists Athens, but no pinned Athens playlist has been verified, so it is not exposed yet.
- CineJoy retains the source's full quality ladder, including 4K/HDR when available. The native Quality menu exposes browser-supported renditions; Auto remains adaptive. Signed child playlists and media requests retain the CineJoy referer. Other proxied providers keep the existing 1080p bandwidth cap.
- The iPhone app keeps CineJoy's full adaptive quality ladder and separate audio renditions together through its existing on-device proxy and VLC player.
- Automatic and manually selected external HLS sources use the same bounded playback cache, keyed separately by title/episode and selected server. Repeat plays skip source discovery and the resolver queue; `refreshResolve=1` invalidates every cached server for that title/episode. Admin provider benchmarks always resolve afresh without populating this cache. `RESOLVED_EMBED_CACHE_TTL_MS=0` disables reuse.
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
4. `/sports` fetches schedules for football, basketball, tennis, hockey, baseball, American football, and cricket through `src/football.rs`. Football uses ESPN's broad scoreboard as its fixture list, merges matching sources from Streamed, MatchStream, NTVS, and cdnlivetv, then shows only fixtures from the top five European leagues, major UEFA/FIFA competitions, and their leading domestic cups. A retained match can therefore appear before any stream is available.
5. Live sports streams still resolve only through protected `/api/sports/stream`; fixture metadata never becomes a playback URL. The server uses short-lived HLS resolution caching and bounded Playwright concurrency for the stream providers.

## Features

Authentication and user sync:

- Sign up, sign in, sign out.
- HttpOnly session cookie with 30-day max age.
- Protected app APIs via auth middleware.
- Server-backed preferences, watch progress, continue watching, and My List.
- Legacy localStorage migration on login.
- Browser localStorage remains a fast local mirror for UI state.

Home and browsing:

- Featured hero sourced from current TMDB/bootstrap data, with a muted official-trailer preview when TMDB provides one and a poster fallback otherwise.
- Dashboard rails use TMDB discovery with rating/vote-count thresholds, release-date guards, and artwork checks instead of raw popularity/trending lists.
- Rails for curated movies, series, critically acclaimed titles, local library, continue watching, and My List.
- Search movies, series, actors, and directors, with genre/year filters, paginated results, and account-scoped recent searches on web and iPhone.
- Title-specific recommendations prioritize titles the viewer has not started. Related-title cards open details before playback.
- Home becomes compact when Continue Watching is available; episode and resume captions stay visible. Web previews have a pause control, and iPhone Home Play opens or resumes the player directly.
- Web catalogue and search cards open title details with metadata, cast, Play/Resume, and My List actions. Continue Watching still resumes directly; desktop hover cards retain quick Play.
- Series details include a season picker and episode artwork, summaries, runtime, and saved-episode progress. Only the selected season loads, successful responses are cached briefly, failed loads can be retried, and future episodes show their air date. Local series use their own episode files. Closing details restores focus and the browsing position.
- Continue watching entries enriched from local library and server state.
- My List has a dedicated `/?view=my-list` grid with Movies/Series filters, recently added/title/release-year sorting, and a return path from playback that preserves those choices. Home retains a saved-title rail; unsaved local files appear separately under Local library.
- My List waits for account hydration before edits and confirms `/api/user/my-list` saves before changing its local cache. Failed loads/saves have retry/error states, and a full 100-title list asks for a removal instead of silently dropping the oldest title.
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
- NTV/CDNLive channels: BBC America, CNN, FOX News, ESPN 2, HBO, Discovery Channel,
  and National Geographic.
- ERT1.
- MEGA News.
- ANT1.
- Alpha TV.
- Top News through Twitch-backed resolving.

Sports:

- Tabs for football, basketball, tennis, hockey, baseball, American football, and cricket.
- Schedule grouping by date.
- Live/upcoming state.
- ESPN-backed football fixture discovery independent of stream availability.
- Stream source counts and stream selector handoff to the player.
- Server schedule cache with stale-if-error fallback.

PWA/offline behavior:

- Web app manifest with app icons and Live shortcut.
- Service worker app-shell caching.
- Offline page for navigation fallback.
- API and media streaming requests bypass the service worker cache.

Operational features:

- Authenticated `/api/health` reports uptime, streaming counters, resolver counters, sports resolver health, and cached ffmpeg/ffprobe capabilities. Forcing a capability refresh requires an administrator session.
- Authenticated `/api/config` reports configured integrations, resolver providers, upload limit, remux/HLS limits, and effective hardware acceleration.
- Administrator-only `/api/debug/cache` reports persistent and in-memory cache counts; its POST clear operation removes persistent resolver/TMDB/session/media caches and HLS cache data.
- Administrator-only `/api/debug/sports` reports sports schedule cache, stream resolver cache, and provider health details.
- Runtime sweeps stale DB/cache/upload/streaming state every minute.

## Pages

`/` and `/index.html`

- Home browse UI.
- Uses injected/fetched home bootstrap data.
- Requires authentication.

`/login.html`

- Public sign-in page. The account-creation control is shown only when an operator explicitly enables public signup.
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

- `GET /api/health/live`
- `GET /api/auth/config` (minimal signup-open flag only)
- `POST /api/auth/signup` (closed unless public signup or a valid invite is configured)
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/verify/{token}`
- `POST /api/auth/resend-verification`
- `POST /api/auth/forgot`
- `POST /api/auth/reset`

Protected API routes:

- `GET /api/health` (`refresh=1` additionally requires an administrator session)
- `GET /api/config`
- `GET /api/home/bootstrap`
- `GET /api/library`
- `GET /api/football/matches`
- `GET /api/basketball/matches`
- `GET /api/tennis/matches`
- `GET /api/hockey/matches`
- `GET /api/baseball/matches`
- `GET /api/american-football/matches`
- `GET /api/cricket/matches`
- `GET /api/twitch/stream`
- `GET /api/live/hls.m3u8`
- `GET /api/live/hls-resource`
- `GET /api/football/stream`
- `GET /api/basketball/stream`
- `GET /api/sports/stream`
- `GET|POST|DELETE /api/title/preferences`
- `POST /api/session/progress`
- `GET /api/tmdb/popular-movies`
- `GET /api/tmdb/search` — `query`, `mediaType=all|movie|tv`, `genre`, `year`, `personId`, and `page`; returns normalized titles, people, genres, and `hasMore`. Exact person names expand their filmography; an empty query browses the catalogue.
- `GET /api/tmdb/recommendations?tmdbId=...&mediaType=movie|tv` — authenticated, private recommendations ordered using the viewer's watch history.
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
- `GET|PUT /api/user/real-debrid`
- `GET|PUT /api/user/torrent-settings`
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

- Torrent streaming - enables magnet discovery and local torrent/cache playback through the Mini without requiring Real-Debrid.
- Real-Debrid cached streaming - an explicit per-user toggle, separate from the saved API token. New tokens are verified against the authenticated Real-Debrid `/user` endpoint and require an active Premium account before they are encrypted and stored. Disabling the toggle preserves the token but keeps it out of resolver requests; removing the token also disables the integration. Existing configured tokens default to enabled for compatibility.

Fresh unpinned playback prefers Real-Debrid when the user has enabled it, then
falls back to external HLS if the bounded torrent resolve does not produce a
playable file. Real-Debrid is also used when a user selects a torrent source or
explicitly requests the `real-debrid` resolver.
The resolver reuses an existing cloud torrent when possible, selects the exact
Torrentio file, and unrestricts its download URL. Resolved payloads include
`realDebridCached: true` only when the torrent becomes ready within the short
instant-selection window; the app does not send private tokens to Torrentio
or pre-add every listed magnet merely to estimate global cache availability.
Ready-torrent badges are refreshed in a deduplicated background request and
cached briefly, so a cold Real-Debrid API call never delays the source menu.
`fastest` gives Real-Debrid a 1.75-second cached-hit window, then hedges with the
local torrent engine and returns the first successful provider. Cancellation
guards stop the losing local path and delete a newly-added Real-Debrid cloud
torrent if the local path wins. Per-user cache keys include a truncated
SHA-256 credential fingerprint (never returned or logged), and replacing or
clearing a token invalidates that user's Real-Debrid playback sessions.

On a VPS/cloud deployment with `REAL_DEBRID_REMOTE_TRAFFIC=1`, unrestrict calls
use paid Remote Traffic. The unrestricted download URL (direct when the
container is browser-safe, otherwise server remux) stays on the startup path;
StreamArena does not wait for Real-Debrid's transcoding API before returning the
resolve. Streamable files also receive a short-lived, authenticated HLS fallback
ticket. Only if the player reaches that fallback does the server request
Real-Debrid's Apple HLS output and pass it through the existing signed byte
relay; neither the API token nor the raw HLS URL is exposed in the resolve
payload. The ticket is bound to the user, credential, expiry, and delivery mode;
every rewritten child playlist and resource remains bound to the exact browser
session and is served `private, no-store`. Identical retries are coalesced and
cached briefly, while distinct provider calls are globally and per-user bounded
to protect the provider quota. Existing playback sessions containing the
earlier raw-HLS form remain compatible. Delivery mode is also part of the
private playback-session scope, so switching the flag cannot reuse an IP-bound
URL produced by the other mode.

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

When Torznab is configured, its unique results supplement Torrentio in the
torrent source list and remain available as a resolver fallback. For Jackett,
configure only indexers that pass a real title search, then use the aggregate
`/api/v2.0/indexers/all/results/torznab/api` endpoint. A custom BitSearch
definition is included at `config/jackett/bitsearch.yml`. Authenticated
indexers such as RuTracker may return same-origin Jackett download links;
StreamArena resolves those redirects to magnets server-side and rejects links
that leave the configured Torznab origin.

Server:

- `HOST` - default `127.0.0.1`.
- `PORT` - default `5173`.
- `OPEN_SIGNUP` - public registration, disabled when the setting is missing. The private StreamArena deployment keeps it at `0`.
- `DIRECT_ORIGIN_HOSTS` - operator-only, comma-separated DNS-only hostnames used by the live-HLS Worker to reach the Mini directly. Keep this value in the Mini's mode-600 canonical environment; do not commit the hostnames.
- `SIGNUP_INVITE_CODE` - optional secret that permits viewer registration while public sign-up is closed.
- `BOOTSTRAP_ADMIN_EMAIL` - optional admin-bootstrap email. Bootstrap requires the matching email and `SIGNUP_INVITE_CODE`; remove this setting once the admin exists.
- `REAL_DEBRID_TOKEN_ENCRYPTION_KEYS` - comma-separated `key-id:base64url-key` ring for per-user Real-Debrid tokens. Each key is 32 random bytes; the first entry is active and retained entries support rotation.
- `REAL_DEBRID_REMOTE_TRAFFIC` - set to `1` only on a VPS/cloud deployment with paid Real-Debrid Remote Traffic. Unrestrict requests then use `remote=1`; local/home deployments default to `0`.
- `OUTBOUND_HTTP_PROXY` - optional HTTP/SOCKS proxy for server outbound requests.
- `SPORTS_HTTP_PROXY` - optional HTTP/SOCKS proxy only for sports provider schedule/stream requests and sports browser HLS extraction. For Cloudflare WARP proxy mode this is typically `socks5://127.0.0.1:40000`.
- `MAX_UPLOAD_BYTES` - default 10 GiB, clamped to at least 50 MiB.

Embed/live resolver helpers:

- `EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT` - default `scripts/resolve-external-embed-hls.mjs` when present, otherwise `bin/resolve-external-embed-hls.mjs`; set to `0`/`off` to disable native external HLS extraction.
- `EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS` - per-provider timeout budget for native HLS resolution; default 8000. Direct API providers are capped lower internally for quick rotation.
- `EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS` - total native HLS extraction budget before falling back to the normal resolver stack; default 26000. Movie/TV external embeds that do not expose native HLS are not returned as iframes.
- `LIVE_HLS_PROXY_SECRET` - shared signing secret for dynamic external HLS proxy URLs (32+ characters). Required when `LIVE_HLS_RESOURCE_WORKER_BASE` is set or `REQUIRE_LIVE_HLS_PROXY_SECRET=1`. Local `cargo run` still generates an ephemeral secret when both are unset. Pin this on the Mini and to the same Worker secret. Signed URLs use a four-hour TTL; backend and Worker allow 60 seconds of clock skew and reject expiries more than six hours in the future.
- `REQUIRE_LIVE_HLS_PROXY_SECRET` - `1` refuses startup unless `LIVE_HLS_PROXY_SECRET` is pinned. Default `0` for local development.
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
- `RESOLVER_PROVIDER_MAX_CONCURRENT` - per-upstream ceiling inside the global resolver budget; default 1.
- `RESOLVER_QUEUE_TIMEOUT_MS`
- `LOCAL_TORRENT_MAX_BYTES`
- `LOCAL_TORRENT_METADATA_TIMEOUT_MS`
- `LOCAL_TORRENT_READY_TIMEOUT_MS`
- `LOCAL_TORRENT_UPLOAD_BPS` - session-wide peer upload cap; default 524288 bytes/s, `0` disables uploads.
- `LOCAL_TORRENT_LISTEN_PORT_START` / `LOCAL_TORRENT_LISTEN_PORT_END` - inbound peer TCP range (exclusive end); defaults to the single deployment-mapped port 42501.
- `PLAYBACK_SESSIONS`

Torznab behavior:

- Torrentio remains the primary torrent discovery source when the user enables Torrent streaming or explicitly enables Real-Debrid with a saved API token.
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
- User-state deletion tombstones, preventing stale offline progress/continue-watching replays from resurrecting deleted rows.

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
- `bun run check:quality` - Rust format, Clippy, and a freshly updated dependency security audit. Install the CI-pinned tool with `cargo install cargo-audit --version 0.22.2 --locked`.
- `bun run check:architecture` - guardrails for app shape, frontend dependencies, entrypoints, source sizes, and bundle sizes.
- `bun run check` - the mandatory full gate: Rust format, Clippy, dependency audit, frontend lint/build, architecture check, Rust tests, live-HLS Worker tests, and frontend smoke test.

Benchmarks:

- `bun run bench:startup -- --samples 5 --max-p95-ms 2500` - isolated cold-start/database-scan benchmark with an enforced p95 budget.
- `bun run bench:playback:install` - install Playwright Chromium.
- `bun run bench:playback -- --source assets/videos/<file>.mp4 --max-startup-ms 5000` - browser playback benchmark with a startup gate.
- `bun run bench:load -- --source assets/videos/<file>.mp4 --max-p95-ms 5000` - concurrent HLS benchmark with a segment-latency gate.
- `bun run bench:resolve -- --tmdb-id <id> --max-p95-ms 30000` - concurrent resolver benchmark with a latency gate.

The [24–25 September 2026 HLS study](docs/benchmarks/hls-providers-2026-09-24.json)
retains each campaign phase separately. After deploying CineJoy's domain repair
`32d6411`, a matched seven-title, four-source run at Auto recorded **28/28
identity-verified video starts and 26/28 full playback-check passes**. Each attempt
included five seconds of continuous proof and a 15-second steady window.

- Lisbon passed 7/7 at 1080-class decoded output, with a 3.061-second median first
  frame; VixSrc passed 7/7 at 720-class output, with a 1.999-second median.
- Solara passed 7/7, with 1080-class output on five titles and 720-class on two,
  at a 4.492-second median. Nebula started 7/7 but passed 5/7: Oppenheimer and Dune
  buffered during steady playback. Its all-start median was 5.912 seconds and
  observed maximum 26.342 seconds; counting only full passes would hide those
  failures.
- The repaired CineJoy results supersede its old-domain failures for ranking.
  Other providers retain their unchanged-integration baseline evidence, including
  VidLink's 2/10 full passes. Source-filtered runs validate their declared matrix
  independently of the raw whole-inventory coverage gate.

Ranking release `d5ead419` is deployed and verified on the Mac mini; the full
local check, GitHub CI and `mini:check` passed. Nine stored rank overrides were
cleared, with zero remaining and all 11 provider families enabled. Exactly three
verified pre-domain-repair Lisbon title-health rows were backed up and removed;
provider aggregates, other health records and accounts data were preserved. Five
fresh unpinned checks all selected Lisbon and listed it first, with **API resolve**
times of 1.701–1.769 seconds (not decoded first-frame times). Two explicit
Interstellar pins also passed: VixSrc at 2.237 seconds / 1282 × 534 and Lisbon at
3.395 seconds / 1920 × 1080. These post-deployment checks are separate from the
240-trial campaign and its startup statistics.

Lisbon's forced-2160p Oppenheimer check, resumed at 900 seconds, passed a separate
120-second steady window at **1920 × 1080**, with
2,880 frames and zero drops or interruptions. The requested 2160p target was **not
achieved**: the same headless Chromium supported AVC through MSE but reported the
advertised HEVC/audio codec combination unsupported. The 4K/PQ playlist is
preserved, but decoded 4K/HDR remains unverified. This validation is excluded from
the Auto ranking statistics; these samples do not measure perceptual or audio fidelity.

`bun run check` executes the deterministic benchmark contract check and a cold
startup sample. Resolver and playback thresholds remain explicit live gates
because they require a running backend, a licensed provider path, and a local
media fixture; use the commands above before deployment.

Mac mini:

- `bun run mini:install-server` - on an existing tunnel installation, restart the existing backend system job while preserving its runner/plist and the active Caddy/cloudflared configuration. Installing the full direct-ingress stack is an explicit option.
- `bun run mini:install-agents` - install/update log rotation, disk monitor, and watchdog system timers.
- `bun run mini:map-ports` - for an explicit direct-ingress setup, create router UPnP forwards for web TCP 80/443 plus the canonical Mini `LOCAL_TORRENT_LISTEN_PORT_START..END` range (up to 16 torrent ports). Setting the start to `0` removes the managed default torrent forward and leaves BitTorrent inbound mapping disabled.
- `CF_API_TOKEN=... bun run mini:update-dns` - update Cloudflare-proxied A records for an explicit direct-ingress setup. The current tunnel does not need public origin port forwards or A records.
- `bun run mini:check` - verify runtime tree, protected API auth status, HTTPS/canonical redirects, no-index controls, the active tunnel/Caddy routes, system launchd timers, env permissions, closed public sign-up (`OPEN_SIGNUP=0`), sports WARP proxy, resolver helpers, disk space, and public response.
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

- `npm ci` - install the locked Expo SDK 57 dependency graph.
- `npm run typecheck` - TypeScript validation.
- `npm run lint` - Expo ESLint validation.
- `npm test` - metadata and signing-plugin regressions.
- `npm run doctor` - Expo project/dependency diagnostics.
- `npm run build:ios` - produce a clean iOS Metro export (also run in CI).
- `EXPO_IOS_DEVELOPMENT_TEAM=<team-id> npm run ios` - opt into automatic signing for a local device build. Without the variable, generated Xcode signing settings are left untouched.

Offline movie and episode downloads use an iOS background URL session, so an active
transfer continues while the app is backgrounded or the screen is locked. Returning to
the app reconciles completion and advances deferred queue work. Only the transfer already
handed to iOS is covered; additional queued episodes start when the app runs again. A user
force-quit stops background transfers by iOS policy, process termination may require a
restart from byte zero, and the live fragmented-MP4 export has no byte-range resume.

While a live channel, movie, or episode is playing on iOS, audio continues when the app
is backgrounded or the device is locked. Native AVPlayer sources also enter Picture in
Picture when the user leaves the app and publish title/playback controls on the lock
screen. VLC fallback sources continue audio in the background but cannot provide PiP.

## Mac Mini Infrastructure

Development machine:

- Checkout: `~/Developer/streamarena`.
- Source of truth is the git checkout.
- Large media should not be committed.
- `assets/videos` should contain symlinks or local-only files in development.

Server machine:

- Host: `hermes@m4mini.local`.
- Runtime path: `/Users/hermes/Developer/streamarena`.
- Public hosts: `streamarena.xyz` and `www.streamarena.xyz`.
- Ingress: Cloudflare edge -> the Mini's `com.cloudflare.cloudflared.streamarena` system tunnel -> loopback services.
- `streamarena.xyz` and `www.streamarena.xyz` route to Caddy at `127.0.0.1:5180`. Caddy redirects HTTP and the alias to canonical HTTPS, then proxies HTTPS requests to the backend.
- The separate Worker origin continues to reach `127.0.0.1:5173` directly. Its hostname remains in operator configuration.
- Music's existing tunnel route and Caddy listener at `127.0.0.1:5175` are shared infrastructure and must be preserved.
- The tunnel requires no public listeners on ports 80/443. An older `Caddyfile` describes the retired direct-ingress setup; the running Caddy daemon selects `Caddyfile-tunnel`.
- `scripts/configure-mini-tunnel.py` prepares the canonical loopback route repair and validates it before activation. It defaults to a dry run; `--apply` backs up the active configuration and verifies local/public routes. Run it on the Mini through SSH, as shown below.
- Backend listener: `127.0.0.1:5173`.
- Runtime tree only:
  - `assets`
  - `bin`
  - `cache`
  - `dist`

A `.release-commit` file containing the deployed full Git commit is allowed, along with `.deploy-staging`, `.deploy-rollback`, and `.deploy-failed` recovery directories. The health check rejects malformed release metadata and unexpected source/build directories.

The server deploy is intentionally not a git checkout. It should not contain `.git`, source folders, `node_modules`, `target`, `Cargo.toml`, `package.json`, or `.env`.
Resolver Node dependencies live outside this tree at `~/.local/share/streamarena-node`.

Prepare the tunnel-route repair from the development checkout; inspect the dry run before applying:

```bash
ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'python3 -' < scripts/configure-mini-tunnel.py
ssh -i ~/.ssh/id_ed25519_codex_m4mini -o BatchMode=yes hermes@m4mini.local \
  'python3 - --apply' < scripts/configure-mini-tunnel.py
```

`mini:check` defaults to `MINI_INGRESS_MODE=tunnel` and `STREAMARENA_CADDY_PORT=5180`. It reads the running Caddy process configuration, checks that Caddy owns only the expected loopback listener for StreamArena, validates the tunnel's selected main/alias routes, and probes redirects and protected requests both locally and publicly. Use `MINI_INGRESS_MODE=direct` only for an explicitly configured direct 80/443 deployment; other services may still require cloudflared in that mode.

Sports proxy/WARP:

- The Mac mini runs Cloudflare WARP in local proxy mode for blocked sports providers.
- WARP CLI: `/usr/local/bin/warp-cli`.
- Expected WARP status: `Connected`.
- Expected WARP mode: `WarpProxy on port 40000`.
- Server env file: `/Users/hermes/.config/streamarena/env`.
- Required sports env: `SPORTS_HTTP_PROXY=http://127.0.0.1:40000`.
- Existing full-backend proxy env may also point at the same listener: `OUTBOUND_HTTP_PROXY=http://127.0.0.1:40000`.
- Streamed may fail directly from the ISP path; the expected healthy path is through WARP's local proxy.
- `scripts/check-mini.sh` validates WARP status, WARP proxy mode, the `SPORTS_HTTP_PROXY` value, real proxied Streamed/NTVS requests, and a valid direct ESPN football fixture response. A valid empty schedule is healthy; transport failures and malformed responses fail.
- `scripts/deploy-mini.sh` deploys resolver helpers:
  - `bin/resolve-external-embed-hls.mjs` for movie/TV native HLS.
  - `bin/resolve-streamed-hls.mjs` for Streamed sports native HLS.
  - `bin/resolve-matchstream-hls.mjs` for MatchStream sports native HLS.
  - `bin/resolve-ntvs-hls.mjs` for NTVS sports native HLS.
  - `bin/lib/load-playwright.mjs` as the shared Playwright module loader used by
    every browser resolver.
- Deployment exercises the staged resolver import graph before activation, and
  `scripts/check-mini.sh` repeats that smoke test against the active `bin/`
  bundle so a missing relative import cannot pass on file-presence checks alone.

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
- Active config: `/Users/hermes/.config/caddy/Caddyfile-tunnel`, selected by the running daemon
- TLS: public TLS terminates at Cloudflare; tunnel origins use loopback HTTP
- Cloudflared config: `/Users/hermes/.cloudflared/config.yml`
- Changes must preserve the Music block and the separate Worker-origin route.

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
- Maintenance logs: `/private/var/db/streamarena-maintenance` (root-owned)

Maintenance system timers:

- Log rotation: `/Library/LaunchDaemons/com.fightingentropy.streamarena-log-rotation.plist`
- Disk monitor: `/Library/LaunchDaemons/com.fightingentropy.streamarena-disk-monitor.plist`
- Watchdog: `/Library/LaunchDaemons/com.fightingentropy.streamarena-watchdog.plist`
- Root-owned helper: `/Library/Application Support/StreamArena/maintenance.py`
- State/logs: `/private/var/db/streamarena-maintenance`

These jobs run without a logged-in GUI session. A loaded, enabled timer may be `not running` between intervals; its last completed run must exit successfully. The installer unloads duplicate GUI jobs and schedules initial runs. Verify each system job's last exit code after installation; `mini:check` also checks their loaded state and program arguments.

Current maintenance defaults:

- Log rotation runs daily at 03:17 and keeps compressed rotated logs.
- Disk monitor runs hourly, warning at 90 percent disk usage or below 50 GiB free.
- Watchdog probes `http://127.0.0.1:5173/api/health/live` every 60 seconds with a 10 second timeout and restarts the backend system job after 3 failed probes by default.

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
5. Restore the Cloudflare tunnel config/credentials and verify its system job. Preserve the Music and Worker-origin routes.
6. Run `bun run mini:install-server` and `bun run mini:install-agents`.
7. Verify the running Caddy daemon selects the tunnel configuration and its StreamArena listener is `127.0.0.1:5180`.
8. Run `bun run mini:check`. Public port forwards and A-record changes apply only to an intentional direct-ingress migration, not a tunnel restore.

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
- If using Torznab, check `TORZNAB_API_URL`, `TORZNAB_API_KEY`, category IDs, and timeout. `mini:check` validates authenticated capabilities; set `TORZNAB_CHECK_QUERY=Interstellar` for an additional search probe. Valid empty RSS passes, while API error XML, malformed responses, and non-200 status fail. Aggregate availability does not prove every indexer works: inspect individual indexer errors separately, including anti-bot challenges. Local Jackett system-job and credential-permission checks apply only when the configured endpoint is local Jackett.
- If local torrent is selected or auto-used, check the Torrent streaming setting, local disk budget, and `cache/local-torrents`.

Movie/TV external embed fails:

- Install Playwright Chromium with `scripts/deploy-mini.sh` or, for local development, `bun run bench:playback:install`.
- Check `EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT`, `EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS`, and `EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS`.
- Confirm the host is one of the supported native providers: VidLink, VidRock, NoTorrent, VixSrc, LordFlix, Icefy, or VidEasy.
- If running multiple backend instances, set a shared `LIVE_HLS_PROXY_SECRET` so resolver-signed HLS URLs verify on every instance.
- If a provider needs a VPN/proxy, set `EXTERNAL_EMBED_BROWSER_PROXY`; if server outbound requests also need the proxy, set `OUTBOUND_HTTP_PROXY`.

Live sports stream fails:

- Install Playwright Chromium with `bun run bench:playback:install`.
- Check `STREAMED_HLS_RESOLVER_SCRIPT`, `MATCHSTREAM_HLS_RESOLVER_SCRIPT`, or `NTVS_HLS_RESOLVER_SCRIPT`.
- If football fixtures fail to load, check the ESPN scoreboard in provider settings and `/api/debug/sports`; Auto falls back to the stream-provider inventories if ESPN is temporarily unavailable.
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
- Vite is updated to 8.x. Direct Rust dependency baselines are current for this app: Reqwest 0.13, Quick XML 0.40, Rusqlite 0.39, and Getrandom 0.4. Cargo may still report transitive crates held behind latest by upstream constraints.
- Live HLS, live HLS resources, and Twitch stream resolving routes are protected API routes.
- Upstream resolver/request errors are sanitized so TMDB, Torznab, Real-Debrid, live/embed, and Twitch failures do not echo secret-bearing URLs or tokens.
- Title track preferences are scoped by user and media type, with a migration for the old `tmdb_id`-only table.
- Hero-preview generation has been removed from package scripts, deployment, agent installation, and mini checks.
- `assets/hero-previews.json` and `scripts/refresh-hero-previews.py` are deleted in this worktree.
- The old one-off Interstellar mini helper scripts have been removed.
- `scripts/check-mini.sh` validates the current maintenance system timers: log rotation, disk monitor, and watchdog, including disabled jobs and failing runs.
- External movie/TV fallback cleanup is complete: VidLink, VidRock, NoTorrent, VixSrc, LordFlix, Icefy, and VidEasy native HLS remain the active provider stack; VidEasy's named server sources are selectable, and external iframe handoff is not used for movie/TV playback.
- Dead external providers and experiment knobs from the earlier investigation have been removed from resolver/provider lists, proxy allowlists, tests, and `.env.example`.
