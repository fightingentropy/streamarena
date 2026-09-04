use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::net::Ipv4Addr;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use aes::Aes256;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use dashmap::DashMap;
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use quick_xml::Reader;
use quick_xml::events::Event;
use regex::Regex;
use reqwest::header;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, oneshot};
use tokio::time::{sleep, timeout};
use url::Url;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::key_lock::key_lock;
use crate::local_torrent::{
    LocalTorrentResolveRequest, LocalTorrentResolvedSource, LocalTorrentService,
};
use crate::media::{
    MediaProbe, MediaService, choose_audio_track_from_probe, choose_subtitle_track_from_probe,
    merge_preferred_subtitle_tracks,
};
use crate::persistence::{
    Db, PLAYBACK_SESSION_CREDENTIAL_SCOPE_METADATA_KEY, PersistPlaybackSessionInput,
    PlaybackSession, PlaybackSessionValidationClaim, SourceHealthStats,
};
use crate::provider_budget::ProviderConcurrencyBudgets;
use crate::rate_limit::RateLimiter;
use crate::tmdb::TmdbService;
use crate::utils::now_ms;
use crate::utils::{
    normalize_preferred_audio_lang, normalize_preferred_stream_quality,
    normalize_subtitle_preference,
};

mod benchmark;
mod cinejoy;
mod external_embed;
mod real_debrid;
mod scoring;
use benchmark::BenchmarkExactSessionRequest;
pub(crate) use real_debrid::build_real_debrid_cache_scope;
pub(crate) use real_debrid::is_real_debrid_lazy_hls_input;
pub(crate) use real_debrid::pick_video_file_ids;
use real_debrid::{
    RealDebridLazyHlsControl, RealDebridRequestContext, RealDebridValidationControl,
    complete_real_debrid_attempt_with_lease, is_real_debrid_transcode_hls_url,
    real_debrid_api_key_required_error, refresh_real_debrid_lazy_hls_fallbacks,
    validate_real_debrid_user_payload,
};
#[cfg(test)]
use real_debrid::{
    RealDebridTorrentOwnership, acquire_owned_real_debrid_torrent_lease,
    authorize_real_debrid_lazy_hls_ticket, build_rd_torrent_cache_key,
    build_real_debrid_lazy_hls_playback_source_at, build_real_debrid_unrestrict_form,
    build_scoped_rd_torrent_cache_key, parse_ready_real_debrid_hashes,
    parse_ready_real_debrid_torrents, parse_strict_real_debrid_lazy_hls_query,
    ready_info_has_selected_file_id, real_debrid_apple_transcode_url,
    reusable_rd_torrent_ready_for_selected_file, user_facing_real_debrid_error,
};
use scoring::{
    build_episode_signature, collect_episode_signatures, extract_stream_title_lines,
    parse_seed_count, parse_vertical_resolution_from_text, prioritize_local_torrent_first_wave,
    select_top_episode_candidates, select_top_movie_candidates,
    summarize_stream_candidate_for_client,
};

#[cfg(test)]
use scoring::{
    parse_runtime_from_label_seconds, parse_size_label_bytes, score_stream_episode_match,
    sort_movie_candidates,
};

use external_embed::{
    ExternalEmbedSource, build_external_embed_source_summaries,
    combine_external_embed_source_summaries, default_external_embed_source,
    external_embed_playback_url, external_embed_source_filename,
    external_embed_source_for_source_hash, external_embed_source_hash, external_embed_sources,
    is_external_embed_hls_capable_source, preferred_external_embed_hls_sources,
    should_prefer_default_external_embed, should_resolve_torrent_candidates,
};

#[cfg(test)]
use external_embed::{
    EXTERNAL_EMBED_PROVIDERS, external_embed_source_rank_score, external_embed_url,
    is_default_external_embed_hls_fallback_source,
};

const REAL_DEBRID_API_BASE: &str = "https://api.real-debrid.com/rest/1.0";
const SOURCE_LANGUAGE_FILTER_DEFAULT: &str = "en";
const SOURCE_AUDIO_PROFILE_DEFAULT: &str = "single";
const RESOLVE_MAX_MS: i64 = 90_000;
// Bound a cold torrent to metadata plus initialization/startup-buffer windows.
// Candidate hedging keeps one dead swarm from serializing the whole budget.
const LOCAL_TORRENT_RESOLVE_MAX_MS: i64 = 150_000;
const FASTEST_RESOLVE_MAX_MS: i64 = 45_000;
const FASTEST_PROVIDER_HEDGE_STAGGER: Duration = Duration::from_millis(1_750);
/// How many top-ranked local-torrent candidates race (staggered hedge) for the
/// first successful resolve. One dead or swarm-slow torrent used to serialize
/// the whole resolve behind its metadata timeout; racing caps that cost.
const LOCAL_TORRENT_RACE_CANDIDATES: usize = 2;
/// Give the best-ranked swarm time to establish peers before starting one
/// bounded hedge. Fast failures still launch the second candidate immediately.
const LOCAL_TORRENT_RACE_STAGGER: Duration = Duration::from_secs(6);
const FASTEST_CANDIDATE_POOL_LIMIT: usize = 40;
const TORRENTIO_REQUEST_TIMEOUT_MS: u64 = 30_000;
const TORRENTIO_REQUEST_MAX_ATTEMPTS: usize = 2;
const TORRENTIO_REQUEST_RETRY_DELAY_MS: u64 = 1_200;
const TORRENTIO_RETRY_MAX_ELAPSED_MS: i64 = 25_000;
const TORRENTIO_CACHE_MAX_AGE_DEFAULT_SECONDS: i64 = 60 * 60;
const TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS: i64 = 4 * 60 * 60;
const TORZNAB_CACHE_MAX_AGE_SECONDS: i64 = 30 * 60;
const TORZNAB_CACHE_STALE_WINDOW_SECONDS: i64 = 2 * 60 * 60;
const TORZNAB_DOWNLOAD_MAGNET_CACHE_SECONDS: i64 = 24 * 60 * 60;
const TORZNAB_DOWNLOAD_LINK_HYDRATE_LIMIT: usize = 12;
const RD_TORRENT_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const RD_READY_HASH_CACHE_TTL_MS: i64 = 30 * 1000;
const RD_TORRENT_LIST_LIMIT: usize = 500;
const PLAYBACK_SESSION_REVALIDATE_TIMEOUT_MS: u64 = 3_000;
const PLAYBACK_SESSION_REVALIDATE_FOREGROUND_GRACE_MS: u64 = 200;
const SOURCE_HEALTH_AVOID_SCORE: i64 = -6_000;
const RD_SELECTED_FILE_MISMATCH_ERROR: &str =
    "Real-Debrid returned a cached torrent with a different selected file.";
const EXTERNAL_SUBTITLE_STREAM_INDEX_BASE: i64 = 2_000_000;
const RESOLVE_LOCK_MAX_ENTRIES: usize = 1024;
const DEFAULT_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://explodie.org:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://tracker.cyberia.is:6969/announce",
    "udp://tracker.dump.cl:6969/announce",
];
const TORRENT_FATAL_STATUSES: &[&str] =
    &["error", "magnet_error", "virus", "dead", "invalid_magnet"];
const BROWSER_SAFE_AUDIO_CODECS: &[&str] = &["aac", "mp3", "mp2", "opus", "vorbis", "flac", "alac"];
const BROWSER_UNSAFE_AUDIO_CODEC_PREFIXES: &[&str] =
    &["ac3", "eac3", "dts", "dca", "truehd", "mlp", "pcm_", "wma"];
const DEFAULT_ALLOWED_SOURCE_FORMATS: &[&str] = &["mp4", "mkv"];
const EXTERNAL_EMBED_RESOLVER_PROVIDER: &str = "external-embed";
const EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-external-embed-hls.mjs";
const EXTERNAL_EMBED_HLS_RESOLVER_RUNTIME_SCRIPT: &str = "bin/resolve-external-embed-hls.mjs";
const EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 8;
const EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS_ENV: &str = "EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS";
const EXTERNAL_EMBED_SERVER_ENV: &str = "EXTERNAL_EMBED_SERVER";
const EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS: u64 = 26_000;
const EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS_ENV: &str = "EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS";
const EXTERNAL_EMBED_DIRECT_RESOLVE_TIMEOUT_MS: u64 = 4_500;
/// Staggered-hedge delay for the external-embed candidate walk: the top-ranked
/// candidate runs alone first, and only if it hasn't resolved within this window is
/// the next candidate raced in parallel. Health-score ordering already puts the
/// best provider first, so a healthy resolve (~0.5–1.5s) usually wins before the
/// hedge fires; the occasional redundant attempt at the slow end of that band is
/// an accepted cost for firing the failover sooner, collapsing the cold worst
/// case from sum-of-dead-providers to roughly best-working-provider + one stagger.
const EXTERNAL_EMBED_HEDGE_STAGGER_MS: u64 = 1_200;
const EXTERNAL_EMBED_PROVIDER_HEALTH_KEY_PREFIX: &str = "external-embed-provider:";
const EXTERNAL_EMBED_POSITIVE_HEALTH_SCORE_CAP: i64 = 75;
const EXTERNAL_EMBED_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36";
const VIDROCK_AES_PASSPHRASE: &str = "x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9";
const VIDROCK_PROXY_PREFIX: &str = "https://proxy.vidrock.store/";

/// Upper bound on a single discovery (Torrentio/Torznab) response body. These
/// come from semi-trusted indexers; this guards against a misconfigured or
/// hostile endpoint forcing a huge allocation.
const MAX_DISCOVERY_RESPONSE_BYTES: u64 = 24 * 1024 * 1024;

static TEXT_NORMALIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9]+").expect("valid text normalize regex"));
static MULTI_AUDIO_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:multiaudio|dualaudio|multidub(?:bed)?|dualdub(?:bed)?|multilang(?:uage)?s?|duallang(?:uage)?s?|multiple\s+(?:audio|dub(?:bed)?|lang(?:uage)?s?)|multi\s+(?:audio|dub(?:bed)?|lang(?:uage)?s?)|dual\s+(?:audio|dub(?:bed)?|lang(?:uage)?s?)|(?:2|3|4)\s*(?:audio|dub(?:bed)?|lang(?:uage)?s?))\b",
    )
    .expect("valid multi audio release regex")
});
static VIXSRC_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"token["']\s*:\s*["']([^"']+)"#).expect("valid token regex"));
static VIXSRC_EXPIRES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"expires["']\s*:\s*["']([^"']+)"#).expect("valid expires regex"));
static VIXSRC_PLAYLIST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"url\s*:\s*["']([^"']+)"#).expect("valid playlist regex"));
static CONTAINER_MP4_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.mp4(?:$|[?#&/])").expect("valid mp4 regex"));
static CONTAINER_MKV_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.mkv(?:$|[?#&/])").expect("valid mkv regex"));
static FILENAME_YEAR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:19|20)\d{2}\b").expect("valid year regex"));

#[derive(Clone)]
pub struct ResolverService {
    config: Config,
    db: Db,
    client: reqwest::Client,
    provider_client: reqwest::Client,
    tmdb: TmdbService,
    media: MediaService,
    local_torrent: LocalTorrentService,
    resolve_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    resolve_metrics: Arc<ResolverMetrics>,
    external_resolver_permits: Arc<Semaphore>,
    provider_resolver_permits: ProviderConcurrencyBudgets,
    resolved_embed_cache: ResolvedEmbedCache,
    rd_ready_refreshes: Arc<DashMap<String, ()>>,
    rd_validation: RealDebridValidationControl,
    rd_lazy_hls: RealDebridLazyHlsControl,
}

pub struct LocalCacheUpgradeRequest<'a> {
    pub user_id: i64,
    pub tmdb_id: &'a str,
    pub preferred_audio_lang: &'a str,
    pub preferred_quality: &'a str,
    pub source_hash: &'a str,
    pub selected_file: &'a str,
    pub media_type: &'a str,
    pub season_number: i64,
    pub episode_number: i64,
}

struct LocalCacheSessionLookup<'a> {
    user_id: i64,
    tmdb_id: &'a str,
    audio_lang: &'a str,
    quality: &'a str,
    source_hash: &'a str,
    media_type: &'a str,
    season_number: i64,
    episode_number: i64,
}

#[derive(Default)]
struct ResolverMetrics {
    movie_requests: AtomicI64,
    tv_requests: AtomicI64,
    coalesced_waits: AtomicI64,
    active_resolves: AtomicI64,
    lock_prunes: AtomicI64,
    external_active: AtomicI64,
    external_started: AtomicI64,
    external_completed: AtomicI64,
    external_failed: AtomicI64,
    external_rejected: AtomicI64,
}

struct ResolverActiveGuard {
    metrics: Arc<ResolverMetrics>,
}

struct ResolverExternalGuard {
    metrics: Arc<ResolverMetrics>,
    _permit: OwnedSemaphorePermit,
    finished: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolverStats {
    movie_requests: i64,
    tv_requests: i64,
    coalesced_waits: i64,
    active_resolves: i64,
    lock_keys: usize,
    lock_prunes: i64,
    max_external_concurrent: usize,
    max_provider_concurrent: usize,
    external_queue_timeout_ms: u64,
    external_active: i64,
    external_started: i64,
    external_completed: i64,
    external_failed: i64,
    external_rejected: i64,
}

#[derive(Debug, Clone)]
pub(in crate::resolver) struct ResolveMetadata {
    pub(in crate::resolver) tmdb_id: String,
    pub(in crate::resolver) imdb_id: String,
    pub(in crate::resolver) display_title: String,
    pub(in crate::resolver) display_year: String,
    pub(in crate::resolver) runtime_seconds: i64,
    pub(in crate::resolver) season_number: i64,
    pub(in crate::resolver) episode_number: i64,
    pub(in crate::resolver) episode_title: String,
    pub(in crate::resolver) media_type: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Deserialize)]
pub(in crate::resolver) struct DiscoveryStream {
    #[serde(default)]
    pub(in crate::resolver) infoHash: String,
    #[serde(default)]
    pub(in crate::resolver) fileIdx: Option<usize>,
    #[serde(default)]
    pub(in crate::resolver) name: String,
    #[serde(default)]
    pub(in crate::resolver) title: String,
    #[serde(default)]
    pub(in crate::resolver) description: String,
    #[serde(default)]
    pub(in crate::resolver) behaviorHints: DiscoveryBehaviorHints,
    #[serde(default)]
    pub(in crate::resolver) sources: Vec<String>,
    #[serde(default)]
    pub(in crate::resolver) magnetUrl: String,
    #[serde(default)]
    pub(in crate::resolver) discoveryProvider: String,
    #[serde(skip)]
    pub(in crate::resolver) downloadUrl: String,
    #[serde(skip)]
    pub(in crate::resolver) real_debrid_cached: bool,
}

#[derive(Debug, Clone, Default)]
struct TorznabItem {
    title: String,
    link: String,
    enclosure_url: String,
    info_hash: String,
    magnet_url: String,
    seeders: i64,
    size_bytes: i64,
    release_group: String,
    indexer: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Deserialize)]
pub(in crate::resolver) struct DiscoveryBehaviorHints {
    #[serde(default)]
    pub(in crate::resolver) filename: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub(in crate::resolver) struct SourceSummary {
    pub(in crate::resolver) sourceHash: String,
    pub(in crate::resolver) infoHash: String,
    pub(in crate::resolver) provider: String,
    pub(in crate::resolver) primary: String,
    pub(in crate::resolver) filename: String,
    pub(in crate::resolver) qualityLabel: String,
    pub(in crate::resolver) container: String,
    pub(in crate::resolver) isTorrent: bool,
    pub(in crate::resolver) realDebridCached: bool,
    pub(in crate::resolver) seeders: i64,
    pub(in crate::resolver) size: String,
    pub(in crate::resolver) releaseGroup: String,
    pub(in crate::resolver) score: i64,
}

#[derive(Debug, Deserialize)]
struct ExternalEmbedHlsResolverOutput {
    #[serde(rename = "playbackUrl")]
    playback_url: String,
    #[serde(default)]
    referer: String,
}

struct ExternalEmbedHlsPlaybackSource {
    playback_url: Url,
    referer: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IcefyStreamResponse {
    #[serde(default)]
    stream: String,
}

#[derive(Debug, Deserialize)]
struct VixSrcApiResponse {
    #[serde(default)]
    src: String,
}

#[derive(Debug, Deserialize)]
struct VidRockStreamInfo {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VidRockCdnSource {
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct LordflixEncDecResponse {
    #[serde(default)]
    status: i64,
    #[serde(default)]
    result: Option<LordflixEncDecResult>,
}

#[derive(Debug, Deserialize)]
struct LordflixEncDecResult {
    #[serde(default)]
    url: String,
    #[serde(default)]
    sign: String,
    #[serde(default)]
    stream: Vec<LordflixStreamEntry>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LordflixStreamEntry {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    playlist: String,
}

#[derive(Debug, Deserialize)]
struct NoTorrentStreamResponse {
    #[serde(default)]
    streams: Vec<NoTorrentStreamEntry>,
}

#[derive(Debug, Deserialize)]
struct NoTorrentStreamEntry {
    #[serde(default)]
    url: String,
    #[serde(default, rename = "externalUrl")]
    external_url: String,
    #[serde(default, rename = "behaviorHints")]
    behavior_hints: NoTorrentBehaviorHints,
}

#[derive(Debug, Default, Deserialize)]
struct NoTorrentBehaviorHints {
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default, rename = "proxyHeaders")]
    proxy_headers: NoTorrentProxyHeaders,
}

#[derive(Debug, Default, Deserialize)]
struct NoTorrentProxyHeaders {
    #[serde(default)]
    request: HashMap<String, String>,
}

const LORDFLIX_API_BASE: &str = "https://snowhouse.lordflix.club";
const LORDFLIX_ENC_DEC_API: &str = "https://enc-dec.app/api";
const LORDFLIX_REFERER: &str = "https://lordflix.org/";
const LORDFLIX_SERVERS: &[&str] = &["Phoenix", "Rio", "Ativa"];
const NOTORRENT_API_BASE: &str = "https://addon-osvh.onrender.com";
// NebulaStreams is a Stremio stream addon with the same request/response shape as
// NoTorrent (`/stream/{movie,series}/<imdb>.json`). Its configured-install base URL
// embeds a private token, so it is supplied at runtime via the `NEBULA_ADDON_BASE`
// env var rather than committed to this (public) repo. Unset/blank/non-https =>
// the provider resolves to no sources (inert), exactly like an admin-disabled
// embed. Shown in the admin catalog under the public, token-free `nebula.work.gd`
// reference base. Lowest ranking tier — a fallback that only fires when our own
// first-party sources miss a title (its addon returns a mix of direct HLS and
// not-web-ready host pages, so its effective hit rate is modest).
const NEBULA_ADDON_BASE_ENV: &str = "NEBULA_ADDON_BASE";
static NEBULA_ADDON_BASE: LazyLock<Option<String>> = LazyLock::new(|| {
    normalize_nebula_addon_base(&std::env::var(NEBULA_ADDON_BASE_ENV).unwrap_or_default())
});
// Meridian + Gallic are aether's (a P-Stream fork) open resolve endpoints. They
// scrape obscure origins server-side (Meridian -> cdn.neuronix.sbs, Gallic ->
// senpai-stream.club) and hand back the stream wrapped in their own m3u8 proxy.
// We call them ONLY to resolve (cheap, then cached by ResolvedEmbedCache), unwrap
// the real origin URL + its Origin/Referer, and stream it through our own
// /api/live proxy — so aether carries the title->origin lookup, never the playback
// bandwidth. The Referer is mandatory; the endpoints Cloudflare-403 without it.
// Meridian is the preferred native-HLS default (see EMBED_DEFAULT_RANK); Gallic
// stays a lower movie-only aether sibling. Playback still goes through our live
// proxy so aether only does the title→origin lookup.
const MERIDIAN_API_BASE: &str = "https://meridian.aether.bar";
const GALLIC_API_BASE: &str = "https://gallic.aether.bar";
const AETHER_EMBED_REFERER: &str = "https://aether.bar/";
// The wrapper aether returns the upstream stream in: .../m3u8-proxy?url=<enc>&headers=<enc>
const AETHER_PROXY_URL_MARKER: &str = "m3u8-proxy?url=";
// Icefy proxies to play.xpass.top, which intermittently returns 429 for ~10s
// windows; Icefy then 500s. Retry enough (with linear backoff: 0/0.9/1.8/2.7/3.6s)
// to outlast a typical burst instead of giving up at ~2.7s. Paired with the
// full resolve budget in external_embed_source_resolve_timeout_ms.
const ICEFY_HLS_RETRY_ATTEMPTS: usize = 5;
const ICEFY_HLS_RETRY_DELAY_MS: u64 = 900;
// VixSrc's api/embed/playlist hosts (vixsrc.to + vix-content.net) fingerprint-
// block the rustls client; the real fix is the curl transport (see
// is_curl_fetch_external_embed_host). This light retry only rides over the
// occasional transient blip on top of that. The parsing itself is correct.
const VIXSRC_HLS_RETRY_ATTEMPTS: usize = 2;
const VIXSRC_HLS_RETRY_DELAY_MS: u64 = 700;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ResolvedSource {
    #[serde(rename = "playableUrl")]
    playable_url: String,
    #[serde(rename = "fallbackUrls")]
    fallback_urls: Vec<String>,
    filename: String,
    #[serde(rename = "sourceHash")]
    source_hash: String,
    #[serde(rename = "selectedFile")]
    selected_file: String,
    #[serde(rename = "selectedFilePath")]
    selected_file_path: String,
    #[serde(default, rename = "realDebridCached")]
    real_debrid_cached: bool,
}

#[derive(Debug, Clone)]
struct ResolvePreferences {
    audio_lang: String,
    subtitle_lang: String,
    quality: String,
}

#[derive(Debug, Clone)]
struct ResolveFilters {
    source_hash: String,
    preferred_container: String,
    source_filters: SourceFilters,
}

#[derive(Clone, Copy)]
struct CandidateResolutionContext<'a> {
    metadata: &'a ResolveMetadata,
    preferences: &'a ResolvePreferences,
    resolver_provider: ResolverProvider,
    real_debrid: Option<&'a RealDebridRequestContext>,
    user_id: i64,
    local_torrent_enabled: bool,
}

struct ExternalEmbedPlaybackRequest<'a> {
    client: &'a reqwest::Client,
    db: &'a Db,
    metadata: &'a ResolveMetadata,
    source: ExternalEmbedSource,
    preferences: &'a ResolvePreferences,
    allow_native_fallback: bool,
    health_scores: &'a HashMap<String, i64>,
    record_health_events: bool,
    live_hls_proxy_secret: &'a str,
    live_hls_worker_base: &'a str,
    provider_budgets: &'a ProviderConcurrencyBudgets,
    resolve_cache: &'a ResolvedEmbedCache,
    cache_key: &'a str,
}

fn torrent_playback_enabled(
    real_debrid: Option<&RealDebridRequestContext>,
    local_torrent_enabled: bool,
) -> bool {
    real_debrid.is_some() || local_torrent_enabled
}

/// Browser-friendly candidates are valuable whenever Real-Debrid participates
/// in automatic selection, even when the local torrent engine is also enabled.
/// An explicit local-torrent request still ranks for swarm performance alone.
fn prefer_mp4_default_candidates(
    resolver_provider: ResolverProvider,
    _local_torrent_enabled: bool,
    real_debrid: Option<&RealDebridRequestContext>,
) -> bool {
    if resolver_provider == ResolverProvider::LocalTorrent {
        return false;
    }
    real_debrid.is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolverProvider {
    RealDebrid,
    LocalTorrent,
    Fastest,
}

fn cache_reuse_provider_for_context(
    resolver_provider: ResolverProvider,
    real_debrid_configured: bool,
    local_torrent_enabled: bool,
) -> ResolverProvider {
    if !real_debrid_configured && local_torrent_enabled && resolver_provider.is_fastest() {
        ResolverProvider::LocalTorrent
    } else {
        resolver_provider.cache_reuse_provider()
    }
}

impl ResolverProvider {
    fn as_str(self) -> &'static str {
        match self {
            ResolverProvider::RealDebrid => "real-debrid",
            ResolverProvider::LocalTorrent => "local-torrent",
            ResolverProvider::Fastest => "fastest",
        }
    }

    fn is_real_debrid(self) -> bool {
        matches!(self, ResolverProvider::RealDebrid)
    }

    fn is_fastest(self) -> bool {
        matches!(self, ResolverProvider::Fastest)
    }

    fn cache_reuse_provider(self) -> ResolverProvider {
        match self {
            ResolverProvider::Fastest | ResolverProvider::RealDebrid => {
                ResolverProvider::RealDebrid
            }
            ResolverProvider::LocalTorrent => ResolverProvider::LocalTorrent,
        }
    }

    fn resolve_max_ms(self) -> i64 {
        match self {
            ResolverProvider::RealDebrid => RESOLVE_MAX_MS,
            ResolverProvider::LocalTorrent => LOCAL_TORRENT_RESOLVE_MAX_MS,
            ResolverProvider::Fastest => FASTEST_RESOLVE_MAX_MS,
        }
    }
}

impl ResolverService {
    pub fn new(
        config: Config,
        db: Db,
        client: reqwest::Client,
        provider_client: reqwest::Client,
        tmdb: TmdbService,
        media: MediaService,
        local_torrent: LocalTorrentService,
    ) -> Self {
        let external_resolver_permits = Arc::new(Semaphore::new(config.resolver_max_concurrent));
        let provider_resolver_permits =
            ProviderConcurrencyBudgets::new(config.resolver_provider_max_concurrent);
        Self {
            config,
            db,
            client,
            provider_client,
            tmdb,
            media,
            local_torrent,
            resolve_locks: Arc::new(DashMap::new()),
            resolve_metrics: Arc::new(ResolverMetrics::default()),
            external_resolver_permits,
            provider_resolver_permits,
            resolved_embed_cache: ResolvedEmbedCache::new(),
            rd_ready_refreshes: Arc::new(DashMap::new()),
            rd_validation: RealDebridValidationControl::new(),
            rd_lazy_hls: RealDebridLazyHlsControl::new(),
        }
    }

    /// Evict aged-out resolved-embed cache entries. Called from the periodic sweep.
    pub fn prune_resolve_cache(&self) {
        self.resolved_embed_cache.prune();
        self.provider_resolver_permits.prune_idle();
        self.rd_validation.prune();
        self.rd_lazy_hls.prune();
    }

    pub fn stats(&self) -> ResolverStats {
        ResolverStats {
            movie_requests: self.resolve_metrics.movie_requests.load(Ordering::Relaxed),
            tv_requests: self.resolve_metrics.tv_requests.load(Ordering::Relaxed),
            coalesced_waits: self.resolve_metrics.coalesced_waits.load(Ordering::Relaxed),
            active_resolves: self.resolve_metrics.active_resolves.load(Ordering::Relaxed),
            lock_keys: self.resolve_locks.len(),
            lock_prunes: self.resolve_metrics.lock_prunes.load(Ordering::Relaxed),
            max_external_concurrent: self.config.resolver_max_concurrent,
            max_provider_concurrent: self.config.resolver_provider_max_concurrent,
            external_queue_timeout_ms: self.config.resolver_queue_timeout_ms,
            external_active: self.resolve_metrics.external_active.load(Ordering::Relaxed),
            external_started: self
                .resolve_metrics
                .external_started
                .load(Ordering::Relaxed),
            external_completed: self
                .resolve_metrics
                .external_completed
                .load(Ordering::Relaxed),
            external_failed: self.resolve_metrics.external_failed.load(Ordering::Relaxed),
            external_rejected: self
                .resolve_metrics
                .external_rejected
                .load(Ordering::Relaxed),
        }
    }

    /// Verify a user-supplied credential before it is encrypted and stored.
    /// Only a boolean success/failure crosses this boundary; Real-Debrid
    /// account identity fields are deliberately discarded.
    pub async fn validate_real_debrid_api_key(
        &self,
        user_id: i64,
        client_ip: &str,
        api_key: &str,
    ) -> AppResult<()> {
        let real_debrid = RealDebridRequestContext::for_user(0, api_key)
            .ok_or_else(|| ApiError::bad_request("Enter a valid Real-Debrid API token."))?;
        self.rd_validation
            .validate(user_id, client_ip, api_key, || async {
                let payload = self
                    .rd_fetch_json(&real_debrid, "/user", reqwest::Method::GET, 8_000)
                    .await?;
                validate_real_debrid_user_payload(&payload)
            })
            .await
    }

    async fn acquire_external_resolve_permit(&self) -> AppResult<ResolverExternalGuard> {
        let wait = Duration::from_millis(self.config.resolver_queue_timeout_ms);
        match timeout(wait, self.external_resolver_permits.clone().acquire_owned()).await {
            Ok(Ok(permit)) => Ok(ResolverExternalGuard::new(
                self.resolve_metrics.clone(),
                permit,
            )),
            Ok(Err(_)) => {
                self.resolve_metrics
                    .external_rejected
                    .fetch_add(1, Ordering::Relaxed);
                Err(ApiError::internal("Resolver limiter closed unexpectedly."))
            }
            Err(_) => {
                self.resolve_metrics
                    .external_rejected
                    .fetch_add(1, Ordering::Relaxed);
                Err(ApiError::too_many_requests(
                    "Server is busy resolving other titles. Please retry in a moment.",
                ))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn try_build_external_embed_payload(
        &self,
        metadata: &ResolveMetadata,
        source: ExternalEmbedSource,
        preferences: &ResolvePreferences,
        allow_native_fallback: bool,
        health_scores: &HashMap<String, i64>,
        cache_key: &str,
        record_health_events: bool,
    ) -> AppResult<Option<Value>> {
        // A cache hit needs no resolve permit (no node subprocess / upstream work),
        // so serve it before acquiring one — this is what lets concurrent viewers of
        // a warm title skip the 2-permit bottleneck entirely.
        // Admin provider benchmarks measure discovery without reading or training this cache.
        if record_health_events && let Some(hit) = self.resolved_embed_cache.get_fresh(cache_key) {
            return Ok(Some(finalize_external_embed_payload(
                metadata,
                hit.source,
                preferences,
                &hit.playback_url,
                hit.referer.as_deref(),
                hit.embed_url,
                &self.config.live_hls_proxy_secret,
                &self.config.live_hls_resource_worker_base,
            )));
        }
        let mut external_guard = self.acquire_external_resolve_permit().await?;
        let payload =
            build_external_embed_resolved_playback_payload(ExternalEmbedPlaybackRequest {
                client: &self.provider_client,
                db: &self.db,
                metadata,
                source,
                preferences,
                allow_native_fallback,
                health_scores,
                record_health_events,
                live_hls_proxy_secret: &self.config.live_hls_proxy_secret,
                live_hls_worker_base: &self.config.live_hls_resource_worker_base,
                provider_budgets: &self.provider_resolver_permits,
                resolve_cache: &self.resolved_embed_cache,
                cache_key,
            })
            .await;
        if payload.is_some() {
            external_guard.mark_completed();
        }
        Ok(payload)
    }

    fn prune_idle_resolve_locks(&self) {
        if self.resolve_locks.len() <= RESOLVE_LOCK_MAX_ENTRIES {
            return;
        }
        let before = self.resolve_locks.len();
        self.resolve_locks
            .retain(|_, lock| Arc::strong_count(lock) > 1);
        let removed = before.saturating_sub(self.resolve_locks.len()) as i64;
        if removed > 0 {
            self.resolve_metrics
                .lock_prunes
                .fetch_add(removed, Ordering::Relaxed);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn list_sources(
        &self,
        user_id: i64,
        real_debrid_api_key: &str,
        local_torrent_enabled: bool,
        tmdb_id: &str,
        media_type: &str,
        title_fallback: &str,
        year_fallback: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_container: &str,
        source_hash: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
        limit: &str,
        resolver_provider: &str,
        season_number: &str,
        season_alias: &str,
        episode_number: &str,
        episode_alias: &str,
    ) -> AppResult<Value> {
        let normalized_audio_lang = normalize_preferred_audio_lang(preferred_audio_lang);
        let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
        let normalized_container = if media_type == "tv" {
            normalize_tv_preferred_container(preferred_container)
        } else {
            normalize_preferred_container(preferred_container)
        };
        let real_debrid = RealDebridRequestContext::for_user(user_id, real_debrid_api_key);
        let normalized_source_hash = normalize_source_hash(source_hash);
        let resolver_provider = normalize_resolver_provider(resolver_provider);
        let normalized_limit = limit.trim().parse::<i64>().ok().unwrap_or(10).clamp(1, 20);
        let source_filters = SourceFilters {
            min_seeders: normalize_minimum_seeders(min_seeders),
            allowed_formats: normalize_allowed_formats(allowed_formats),
            source_language: normalize_source_language_filter(source_language),
            source_audio_profile: normalize_source_audio_profile_filter(source_audio_profile),
        };
        let prefer_mp4_default = prefer_mp4_default_candidates(
            resolver_provider,
            local_torrent_enabled,
            real_debrid.as_ref(),
        );
        if media_type == "tv" {
            let season_number = normalize_episode_ordinal(
                if season_number.trim().is_empty() {
                    season_alias
                } else {
                    season_number
                },
                1,
            );
            let episode_number = normalize_episode_ordinal(
                if episode_number.trim().is_empty() {
                    episode_alias
                } else {
                    episode_number
                },
                1,
            );
            let metadata = self
                .fetch_tv_episode_metadata(
                    tmdb_id,
                    title_fallback,
                    year_fallback,
                    season_number,
                    episode_number,
                )
                .await?;
            let external_health_scores =
                self.compute_external_embed_health_scores(&metadata).await?;
            let external_sources =
                build_external_embed_source_summaries(&metadata, &external_health_scores);
            let has_external_sources = !external_sources.is_empty();
            if !torrent_playback_enabled(real_debrid.as_ref(), local_torrent_enabled) {
                return Ok(json!({
                    "mediaType": "tv",
                    "tmdbId": tmdb_id.trim(),
                    "resolverProvider": EXTERNAL_EMBED_RESOLVER_PROVIDER,
                    "seasonNumber": metadata.season_number,
                    "episodeNumber": metadata.episode_number,
                    "sources": external_sources
                }));
            }
            let mut external_guard = match self.acquire_external_resolve_permit().await {
                Ok(guard) => guard,
                Err(_) if has_external_sources => {
                    return Ok(json!({
                        "mediaType": "tv",
                        "tmdbId": tmdb_id.trim(),
                        "resolverProvider": resolver_provider.as_str(),
                        "seasonNumber": metadata.season_number,
                        "episodeNumber": metadata.episode_number,
                        "sources": external_sources
                    }));
                }
                Err(error) => return Err(error),
            };
            let (torrentio_result, torznab_result) = tokio::join!(
                self.fetch_torrentio_episode_streams(
                    &metadata.imdb_id,
                    metadata.season_number,
                    metadata.episode_number,
                ),
                self.fetch_torznab_episode_streams(&metadata),
            );
            let sources = match torrentio_result {
                Ok(torrentio_streams) => {
                    let torznab_streams = torznab_result.unwrap_or_default();
                    let mut streams = merge_discovery_streams(torrentio_streams, torznab_streams);
                    if resolver_provider != ResolverProvider::LocalTorrent {
                        self.mark_ready_real_debrid_sources(&mut streams, real_debrid.as_ref())
                            .await;
                    }
                    self.summarize_episode_sources_from_streams(
                        &streams,
                        &metadata,
                        &normalized_audio_lang,
                        &normalized_quality,
                        &normalized_container,
                        &normalized_source_hash,
                        normalized_limit as usize,
                        &source_filters,
                        prefer_mp4_default,
                    )
                    .await?
                }
                Err(error) => {
                    let torznab_streams = match torznab_result {
                        Ok(streams) => streams,
                        Err(torznab_error) => {
                            if has_external_sources {
                                Vec::new()
                            } else {
                                return Err(torznab_error);
                            }
                        }
                    };
                    let mut torznab_streams = torznab_streams;
                    if resolver_provider != ResolverProvider::LocalTorrent {
                        self.mark_ready_real_debrid_sources(
                            &mut torznab_streams,
                            real_debrid.as_ref(),
                        )
                        .await;
                    }
                    let torznab_sources = self
                        .summarize_episode_sources_from_streams(
                            &torznab_streams,
                            &metadata,
                            &normalized_audio_lang,
                            &normalized_quality,
                            &normalized_container,
                            &normalized_source_hash,
                            normalized_limit as usize,
                            &source_filters,
                            prefer_mp4_default,
                        )
                        .await?;
                    if torznab_sources.is_empty() && !has_external_sources {
                        return Err(error);
                    }
                    torznab_sources
                }
            };
            let sources = combine_external_embed_source_summaries(external_sources, sources);
            external_guard.mark_completed();
            return Ok(json!({
                "mediaType": "tv",
                "tmdbId": tmdb_id.trim(),
                "resolverProvider": resolver_provider.as_str(),
                "seasonNumber": metadata.season_number,
                "episodeNumber": metadata.episode_number,
                "sources": sources
            }));
        }

        let metadata = self
            .fetch_movie_metadata(tmdb_id, title_fallback, year_fallback)
            .await?;
        let external_health_scores = self.compute_external_embed_health_scores(&metadata).await?;
        let external_sources =
            build_external_embed_source_summaries(&metadata, &external_health_scores);
        let has_external_sources = !external_sources.is_empty();
        if !torrent_playback_enabled(real_debrid.as_ref(), local_torrent_enabled) {
            return Ok(json!({
                "mediaType": "movie",
                "tmdbId": tmdb_id.trim(),
                "resolverProvider": EXTERNAL_EMBED_RESOLVER_PROVIDER,
                "sources": external_sources
            }));
        }
        let mut external_guard = match self.acquire_external_resolve_permit().await {
            Ok(guard) => guard,
            Err(_) if has_external_sources => {
                return Ok(json!({
                    "mediaType": "movie",
                    "tmdbId": tmdb_id.trim(),
                    "resolverProvider": resolver_provider.as_str(),
                    "sources": external_sources
                }));
            }
            Err(error) => return Err(error),
        };
        let (torrentio_result, torznab_result) = tokio::join!(
            self.fetch_torrentio_movie_streams(&metadata.imdb_id),
            self.fetch_torznab_movie_streams(&metadata),
        );
        let sources = match torrentio_result {
            Ok(torrentio_streams) => {
                let torznab_streams = torznab_result.unwrap_or_default();
                let mut streams = merge_discovery_streams(torrentio_streams, torznab_streams);
                if resolver_provider != ResolverProvider::LocalTorrent {
                    self.mark_ready_real_debrid_sources(&mut streams, real_debrid.as_ref())
                        .await;
                }
                self.summarize_movie_sources_from_streams(
                    &streams,
                    &metadata,
                    &normalized_audio_lang,
                    &normalized_quality,
                    &normalized_source_hash,
                    normalized_limit as usize,
                    &source_filters,
                    prefer_mp4_default,
                )
                .await?
            }
            Err(error) => {
                let torznab_streams = match torznab_result {
                    Ok(streams) => streams,
                    Err(torznab_error) => {
                        if has_external_sources {
                            Vec::new()
                        } else {
                            return Err(torznab_error);
                        }
                    }
                };
                let mut torznab_streams = torznab_streams;
                if resolver_provider != ResolverProvider::LocalTorrent {
                    self.mark_ready_real_debrid_sources(&mut torznab_streams, real_debrid.as_ref())
                        .await;
                }
                let torznab_sources = self
                    .summarize_movie_sources_from_streams(
                        &torznab_streams,
                        &metadata,
                        &normalized_audio_lang,
                        &normalized_quality,
                        &normalized_source_hash,
                        normalized_limit as usize,
                        &source_filters,
                        prefer_mp4_default,
                    )
                    .await?;
                if torznab_sources.is_empty() && !has_external_sources {
                    return Err(error);
                }
                torznab_sources
            }
        };
        let sources = combine_external_embed_source_summaries(external_sources, sources);
        external_guard.mark_completed();
        Ok(json!({
            "mediaType": "movie",
            "tmdbId": tmdb_id.trim(),
            "resolverProvider": resolver_provider.as_str(),
            "sources": sources
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn resolve_movie(
        &self,
        user_id: i64,
        real_debrid_api_key: &str,
        local_torrent_enabled: bool,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_subtitle_lang: &str,
        source_hash: &str,
        session_key: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
        resolver_provider: &str,
        skip_external_embed: bool,
        refresh_resolve: bool,
        record_external_health_events: bool,
        benchmark_exact_session_reuse: bool,
    ) -> AppResult<Value> {
        self.resolve_metrics
            .movie_requests
            .fetch_add(1, Ordering::Relaxed);
        let resolver_provider = normalize_resolver_provider(resolver_provider);
        let real_debrid = RealDebridRequestContext::for_user(user_id, real_debrid_api_key);
        if benchmark_exact_session_reuse {
            if resolver_provider != ResolverProvider::RealDebrid {
                return Err(ApiError::failed_dependency(
                    "The exact benchmark playback session is unavailable.",
                ));
            }
            return self
                .resolve_benchmark_exact_session(
                    BenchmarkExactSessionRequest {
                        user_id,
                        media_type: "movie",
                        tmdb_id,
                        title: title_fallback,
                        year: year_fallback,
                        season_number: 0,
                        episode_number: 0,
                        audio_lang: preferred_audio_lang,
                        quality: preferred_quality,
                        subtitle_lang: preferred_subtitle_lang,
                        source_hash,
                        session_key,
                    },
                    real_debrid.as_ref(),
                )
                .await;
        }
        let lock_key = build_movie_resolve_lock_key(
            tmdb_id,
            preferred_audio_lang,
            preferred_quality,
            preferred_subtitle_lang,
            source_hash,
            session_key,
            min_seeders,
            allowed_formats,
            source_language,
            source_audio_profile,
            resolver_provider,
            skip_external_embed,
        );
        let lock = key_lock(&self.resolve_locks, &lock_key);
        let _guard = match lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                self.resolve_metrics
                    .coalesced_waits
                    .fetch_add(1, Ordering::Relaxed);
                lock.lock().await
            }
        };
        let _active_guard = ResolverActiveGuard::new(self.resolve_metrics.clone());
        self.prune_idle_resolve_locks();
        let mut payload = self
            .resolve_movie_inner(
                user_id,
                real_debrid.as_ref(),
                local_torrent_enabled,
                tmdb_id,
                title_fallback,
                year_fallback,
                preferred_audio_lang,
                preferred_quality,
                preferred_subtitle_lang,
                source_hash,
                session_key,
                min_seeders,
                allowed_formats,
                source_language,
                source_audio_profile,
                resolver_provider,
                skip_external_embed,
                refresh_resolve,
                record_external_health_events,
            )
            .await?;
        self.attach_external_subtitle_tracks_to_payload(&mut payload)
            .await;
        Ok(payload)
    }

    pub async fn check_local_cache_upgrade(
        &self,
        request: LocalCacheUpgradeRequest<'_>,
    ) -> AppResult<Value> {
        if !self.config.playback_sessions_enabled {
            return Ok(json!({ "ready": false }));
        }
        let tmdb_id = request.tmdb_id.trim();
        let normalized_hash = normalize_source_hash(request.source_hash);
        if tmdb_id.is_empty() || normalized_hash.is_empty() {
            return Ok(json!({ "ready": false }));
        }

        let stored_preference = self
            .db
            .get_title_preference(
                request.user_id,
                normalize_resolve_media_type(request.media_type),
                tmdb_id.to_owned(),
            )
            .await?;
        let effective_audio_lang = self
            .resolve_effective_preferred_audio_lang(
                request.user_id,
                request.media_type,
                tmdb_id,
                stored_preference
                    .as_ref()
                    .map(|value| value.audioLang.as_str())
                    .unwrap_or_default(),
                request.preferred_audio_lang,
            )
            .await?;
        let normalized_quality = normalize_preferred_stream_quality(request.preferred_quality);

        if let Some(upgrade) = self
            .find_local_cache_upgrade_from_session(LocalCacheSessionLookup {
                user_id: request.user_id,
                tmdb_id,
                audio_lang: &effective_audio_lang,
                quality: &normalized_quality,
                source_hash: &normalized_hash,
                media_type: request.media_type,
                season_number: request.season_number,
                episode_number: request.episode_number,
            })
            .await?
        {
            return Ok(upgrade);
        }

        if let Some(resolved) = self
            .local_torrent
            .try_direct_file_resolved_source(&normalized_hash, request.selected_file)
            .await?
        {
            return Ok(self.build_local_cache_upgrade_payload(resolved));
        }

        Ok(json!({ "ready": false }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_movie_inner(
        &self,
        user_id: i64,
        real_debrid: Option<&RealDebridRequestContext>,
        local_torrent_enabled: bool,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_subtitle_lang: &str,
        source_hash: &str,
        session_key: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
        resolver_provider: ResolverProvider,
        skip_external_embed: bool,
        refresh_resolve: bool,
        record_external_health_events: bool,
    ) -> AppResult<Value> {
        let stored_preference = self
            .db
            .get_title_preference(user_id, "movie".to_owned(), tmdb_id.trim().to_owned())
            .await?;
        let effective_audio_lang = self
            .resolve_effective_preferred_audio_lang(
                user_id,
                "movie",
                tmdb_id,
                stored_preference
                    .as_ref()
                    .map(|value| value.audioLang.as_str())
                    .unwrap_or_default(),
                preferred_audio_lang,
            )
            .await?;
        let preferences = ResolvePreferences {
            audio_lang: effective_audio_lang.clone(),
            subtitle_lang: resolve_effective_preferred_subtitle_lang(
                stored_preference
                    .as_ref()
                    .map(|value| value.subtitleLang.as_str())
                    .unwrap_or_default(),
                preferred_subtitle_lang,
            ),
            quality: normalize_preferred_stream_quality(preferred_quality),
        };
        let filters = ResolveFilters {
            source_hash: normalize_source_hash(source_hash),
            preferred_container: String::new(),
            source_filters: SourceFilters {
                min_seeders: normalize_minimum_seeders(min_seeders),
                allowed_formats: normalize_allowed_formats(allowed_formats),
                source_language: normalize_source_language_filter(source_language),
                source_audio_profile: normalize_source_audio_profile_filter(source_audio_profile),
            },
        };
        let metadata = self
            .fetch_movie_metadata(tmdb_id, title_fallback, year_fallback)
            .await?;
        let external_health_scores = self.compute_external_embed_health_scores(&metadata).await?;
        // Bust the resolved-embed cache when the client asks for a fresh resolve
        // (e.g. the player retrying after a playback failure), so a stale/dead
        // upstream URL can't be re-served on the recovery path.
        let resolve_cache_key = external_embed_resolve_cache_key(&metadata, "");
        if refresh_resolve {
            self.resolved_embed_cache.evict_title(&resolve_cache_key);
        }
        let pinned_external_source =
            external_embed_source_for_source_hash(&metadata, &filters.source_hash);
        let external_embed_only = !torrent_playback_enabled(real_debrid, local_torrent_enabled);
        let effective_skip_external_embed = skip_external_embed && !external_embed_only;
        let default_external_filters = if external_embed_only {
            ResolveFilters {
                source_hash: String::new(),
                preferred_container: filters.preferred_container.clone(),
                source_filters: filters.source_filters.clone(),
            }
        } else {
            filters.clone()
        };
        // The client may explicitly request a Real-Debrid-first automatic path
        // with skipExternalEmbed. Without it, an unpinned request retains the
        // external-HLS policy for compatibility and fallback.
        let default_external_resolver_provider = resolver_provider;
        if !effective_skip_external_embed
            && let Some(provider) = pinned_external_source
            && is_external_embed_hls_capable_source(provider)
        {
            let pinned_cache_key =
                external_embed_resolve_cache_key(&metadata, &filters.source_hash);
            if let Some(payload) = self
                .try_build_external_embed_payload(
                    &metadata,
                    provider,
                    &preferences,
                    false,
                    &external_health_scores,
                    &pinned_cache_key,
                    record_external_health_events,
                )
                .await?
            {
                return Ok(payload);
            }

            if !filters.source_hash.is_empty() {
                return Err(selected_external_embed_hls_unavailable_error());
            }
        }
        if !effective_skip_external_embed
            && should_prefer_default_external_embed(
                &default_external_filters,
                default_external_resolver_provider,
            )
            && let Some(provider) =
                default_external_embed_source(&metadata, &external_health_scores)
            && let Some(payload) = self
                .try_build_external_embed_payload(
                    &metadata,
                    provider,
                    &preferences,
                    true,
                    &external_health_scores,
                    &resolve_cache_key,
                    record_external_health_events,
                )
                .await
                .ok()
                .flatten()
        {
            return Ok(payload);
        }
        if !should_resolve_torrent_candidates(
            &filters,
            resolver_provider,
            effective_skip_external_embed,
        ) {
            return Err(external_embed_hls_unavailable_error());
        }
        if resolver_provider.is_real_debrid() && real_debrid.is_none() {
            return Err(real_debrid_api_key_required_error());
        }
        if real_debrid.is_none() && !local_torrent_enabled {
            return Err(external_embed_hls_unavailable_error());
        }
        if resolver_provider == ResolverProvider::LocalTorrent && !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
        let cache_reuse_provider = cache_reuse_provider_for_context(
            resolver_provider,
            real_debrid.is_some(),
            local_torrent_enabled,
        );
        if let Some(reused) = self
            .try_reuse_playback_session(
                user_id,
                &metadata,
                &preferences,
                &filters,
                cache_reuse_provider,
                session_key,
                real_debrid,
            )
            .await?
        {
            return Ok(reused);
        }
        if should_allow_latest_playback_session_fallback(&filters)
            && let Some(reused) = self
                .try_reuse_latest_healthy_playback_session(
                    user_id,
                    &metadata,
                    &preferences,
                    &filters,
                    cache_reuse_provider,
                    real_debrid,
                )
                .await?
        {
            return Ok(reused);
        }
        let mut external_guard = self.acquire_external_resolve_permit().await?;
        let candidate_context = CandidateResolutionContext {
            metadata: &metadata,
            preferences: &preferences,
            resolver_provider,
            real_debrid,
            user_id,
            local_torrent_enabled,
        };
        let mut last_error;
        match self.fetch_torrentio_movie_streams(&metadata.imdb_id).await {
            Ok(mut streams) => {
                if resolver_provider != ResolverProvider::LocalTorrent {
                    self.mark_ready_real_debrid_sources(&mut streams, real_debrid)
                        .await;
                }
                let health_scores = self.compute_source_health_scores(&streams).await?;
                let candidate_limit = if resolver_provider.is_fastest() {
                    FASTEST_CANDIDATE_POOL_LIMIT
                } else {
                    10
                };
                let prefer_mp4_default = prefer_mp4_default_candidates(
                    resolver_provider,
                    local_torrent_enabled,
                    real_debrid,
                );
                let candidates = select_top_movie_candidates(
                    &streams,
                    &metadata,
                    &preferences.audio_lang,
                    &preferences.quality,
                    &filters.source_hash,
                    candidate_limit,
                    &filters.source_filters,
                    &health_scores,
                    prefer_mp4_default,
                );
                let pinned_missing = !filters.source_hash.is_empty()
                    && !stream_list_contains_hash(&streams, &filters.source_hash);
                if pinned_missing
                    && let Ok(torznab_streams) = self.fetch_torznab_movie_streams(&metadata).await
                    && stream_list_contains_hash(&torznab_streams, &filters.source_hash)
                {
                    let health_scores = self.compute_source_health_scores(&torznab_streams).await?;
                    let torznab_candidates = select_top_movie_candidates(
                        &torznab_streams,
                        &metadata,
                        &preferences.audio_lang,
                        &preferences.quality,
                        &filters.source_hash,
                        candidate_limit,
                        &filters.source_filters,
                        &health_scores,
                        prefer_mp4_default,
                    );
                    if let Ok(result) = self
                        .resolve_movie_candidates(torznab_candidates, candidate_context)
                        .await
                    {
                        external_guard.mark_completed();
                        return Ok(result);
                    }
                }
                if !candidates.is_empty() {
                    match self
                        .resolve_movie_candidates(candidates, candidate_context)
                        .await
                    {
                        Ok(result) => {
                            external_guard.mark_completed();
                            return Ok(result);
                        }
                        Err(error) => last_error = Some(error),
                    }
                } else {
                    last_error = Some(ApiError::internal(
                        "No stream candidates were returned for this movie.",
                    ));
                }
            }
            Err(error) => last_error = Some(error),
        }

        // Pinned selections already targeted one exact torrent. Torznab cannot
        // substitute a different hash, and a Torznab outage must not mask the
        // real local-torrent / torrentio failure the player should surface.
        if !filters.source_hash.is_empty() {
            return Err(last_error.unwrap_or_else(|| {
                ApiError::bad_gateway(
                    "Selected torrent source is unavailable right now. Try another source.",
                )
            }));
        }

        match self.fetch_torznab_movie_streams(&metadata).await {
            Ok(torznab_streams) if !torznab_streams.is_empty() => {
                let health_scores = self.compute_source_health_scores(&torznab_streams).await?;
                let candidate_limit = if resolver_provider.is_fastest() {
                    FASTEST_CANDIDATE_POOL_LIMIT
                } else {
                    10
                };
                let prefer_mp4_default = prefer_mp4_default_candidates(
                    resolver_provider,
                    local_torrent_enabled,
                    real_debrid,
                );
                let torznab_candidates = select_top_movie_candidates(
                    &torznab_streams,
                    &metadata,
                    &preferences.audio_lang,
                    &preferences.quality,
                    &filters.source_hash,
                    candidate_limit,
                    &filters.source_filters,
                    &health_scores,
                    prefer_mp4_default,
                );
                if !torznab_candidates.is_empty() {
                    match self
                        .resolve_movie_candidates(torznab_candidates, candidate_context)
                        .await
                    {
                        Ok(result) => {
                            external_guard.mark_completed();
                            return Ok(result);
                        }
                        Err(error) => last_error = Some(error),
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                if last_error.is_none() {
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn resolve_tv(
        &self,
        user_id: i64,
        real_debrid_api_key: &str,
        local_torrent_enabled: bool,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        season_number: &str,
        season_alias: &str,
        episode_number: &str,
        episode_alias: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_subtitle_lang: &str,
        preferred_container: &str,
        source_hash: &str,
        session_key: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
        resolver_provider: &str,
        skip_external_embed: bool,
        refresh_resolve: bool,
        record_external_health_events: bool,
        benchmark_exact_session_reuse: bool,
    ) -> AppResult<Value> {
        self.resolve_metrics
            .tv_requests
            .fetch_add(1, Ordering::Relaxed);
        let resolver_provider = normalize_resolver_provider(resolver_provider);
        let real_debrid = RealDebridRequestContext::for_user(user_id, real_debrid_api_key);
        if benchmark_exact_session_reuse {
            if resolver_provider != ResolverProvider::RealDebrid {
                return Err(ApiError::failed_dependency(
                    "The exact benchmark playback session is unavailable.",
                ));
            }
            let benchmark_season_number = normalize_episode_ordinal(
                if season_number.trim().is_empty() {
                    season_alias
                } else {
                    season_number
                },
                1,
            );
            let benchmark_episode_number = normalize_episode_ordinal(
                if episode_number.trim().is_empty() {
                    episode_alias
                } else {
                    episode_number
                },
                1,
            );
            return self
                .resolve_benchmark_exact_session(
                    BenchmarkExactSessionRequest {
                        user_id,
                        media_type: "tv",
                        tmdb_id,
                        title: title_fallback,
                        year: year_fallback,
                        season_number: benchmark_season_number,
                        episode_number: benchmark_episode_number,
                        audio_lang: preferred_audio_lang,
                        quality: preferred_quality,
                        subtitle_lang: preferred_subtitle_lang,
                        source_hash,
                        session_key,
                    },
                    real_debrid.as_ref(),
                )
                .await;
        }
        let lock_key = build_tv_resolve_lock_key(
            tmdb_id,
            season_number,
            season_alias,
            episode_number,
            episode_alias,
            preferred_audio_lang,
            preferred_quality,
            preferred_subtitle_lang,
            preferred_container,
            source_hash,
            session_key,
            min_seeders,
            allowed_formats,
            source_language,
            source_audio_profile,
            resolver_provider,
            skip_external_embed,
        );
        let lock = key_lock(&self.resolve_locks, &lock_key);
        let _guard = match lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                self.resolve_metrics
                    .coalesced_waits
                    .fetch_add(1, Ordering::Relaxed);
                lock.lock().await
            }
        };
        let _active_guard = ResolverActiveGuard::new(self.resolve_metrics.clone());
        self.prune_idle_resolve_locks();
        let mut payload = self
            .resolve_tv_inner(
                user_id,
                real_debrid.as_ref(),
                local_torrent_enabled,
                tmdb_id,
                title_fallback,
                year_fallback,
                season_number,
                season_alias,
                episode_number,
                episode_alias,
                preferred_audio_lang,
                preferred_quality,
                preferred_subtitle_lang,
                preferred_container,
                source_hash,
                session_key,
                min_seeders,
                allowed_formats,
                source_language,
                source_audio_profile,
                resolver_provider,
                skip_external_embed,
                refresh_resolve,
                record_external_health_events,
            )
            .await?;
        self.attach_external_subtitle_tracks_to_payload(&mut payload)
            .await;
        Ok(payload)
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_tv_inner(
        &self,
        user_id: i64,
        real_debrid: Option<&RealDebridRequestContext>,
        local_torrent_enabled: bool,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        season_number: &str,
        season_alias: &str,
        episode_number: &str,
        episode_alias: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_subtitle_lang: &str,
        preferred_container: &str,
        source_hash: &str,
        session_key: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
        resolver_provider: ResolverProvider,
        skip_external_embed: bool,
        refresh_resolve: bool,
        record_external_health_events: bool,
    ) -> AppResult<Value> {
        let stored_preference = self
            .db
            .get_title_preference(user_id, "tv".to_owned(), tmdb_id.trim().to_owned())
            .await?;
        let preferences = ResolvePreferences {
            audio_lang: self
                .resolve_effective_preferred_audio_lang(
                    user_id,
                    "tv",
                    tmdb_id,
                    stored_preference
                        .as_ref()
                        .map(|value| value.audioLang.as_str())
                        .unwrap_or_default(),
                    preferred_audio_lang,
                )
                .await?,
            subtitle_lang: resolve_effective_preferred_subtitle_lang(
                stored_preference
                    .as_ref()
                    .map(|value| value.subtitleLang.as_str())
                    .unwrap_or_default(),
                preferred_subtitle_lang,
            ),
            quality: normalize_preferred_stream_quality(preferred_quality),
        };
        let normalized_preferred_container = normalize_tv_preferred_container(preferred_container);
        let filters = ResolveFilters {
            source_hash: normalize_source_hash(source_hash),
            preferred_container: normalized_preferred_container.clone(),
            source_filters: SourceFilters {
                min_seeders: normalize_minimum_seeders(min_seeders),
                allowed_formats: normalize_allowed_formats(allowed_formats),
                source_language: normalize_source_language_filter(source_language),
                source_audio_profile: normalize_source_audio_profile_filter(source_audio_profile),
            },
        };
        let season_number = normalize_episode_ordinal(
            if season_number.trim().is_empty() {
                season_alias
            } else {
                season_number
            },
            1,
        );
        let episode_number = normalize_episode_ordinal(
            if episode_number.trim().is_empty() {
                episode_alias
            } else {
                episode_number
            },
            1,
        );
        let metadata = self
            .fetch_tv_episode_metadata(
                tmdb_id,
                title_fallback,
                year_fallback,
                season_number,
                episode_number,
            )
            .await?;
        let external_health_scores = self.compute_external_embed_health_scores(&metadata).await?;
        // Bust the resolved-embed cache on a fresh-resolve request (e.g. player
        // recovery after a playback failure) so a stale/dead upstream URL can't be
        // re-served from cache.
        let resolve_cache_key = external_embed_resolve_cache_key(&metadata, "");
        if refresh_resolve {
            self.resolved_embed_cache.evict_title(&resolve_cache_key);
        }
        let pinned_external_source =
            external_embed_source_for_source_hash(&metadata, &filters.source_hash);
        let external_embed_only = !torrent_playback_enabled(real_debrid, local_torrent_enabled);
        let effective_skip_external_embed = skip_external_embed && !external_embed_only;
        let default_external_filters = if external_embed_only {
            ResolveFilters {
                source_hash: String::new(),
                preferred_container: filters.preferred_container.clone(),
                source_filters: filters.source_filters.clone(),
            }
        } else {
            filters.clone()
        };
        // The client may explicitly request a Real-Debrid-first automatic path
        // with skipExternalEmbed. Without it, initial playback retains the
        // external-HLS policy for compatibility and fallback.
        let default_external_resolver_provider = resolver_provider;
        if !effective_skip_external_embed
            && let Some(provider) = pinned_external_source
            && is_external_embed_hls_capable_source(provider)
        {
            let pinned_cache_key =
                external_embed_resolve_cache_key(&metadata, &filters.source_hash);
            if let Some(payload) = self
                .try_build_external_embed_payload(
                    &metadata,
                    provider,
                    &preferences,
                    false,
                    &external_health_scores,
                    &pinned_cache_key,
                    record_external_health_events,
                )
                .await?
            {
                return Ok(payload);
            }

            if !filters.source_hash.is_empty() {
                return Err(selected_external_embed_hls_unavailable_error());
            }
        }
        if !effective_skip_external_embed
            && should_prefer_default_external_embed(
                &default_external_filters,
                default_external_resolver_provider,
            )
            && let Some(provider) =
                default_external_embed_source(&metadata, &external_health_scores)
            && let Some(payload) = self
                .try_build_external_embed_payload(
                    &metadata,
                    provider,
                    &preferences,
                    true,
                    &external_health_scores,
                    &resolve_cache_key,
                    record_external_health_events,
                )
                .await
                .ok()
                .flatten()
        {
            return Ok(payload);
        }
        if !should_resolve_torrent_candidates(
            &filters,
            resolver_provider,
            effective_skip_external_embed,
        ) {
            return Err(external_embed_hls_unavailable_error());
        }
        if resolver_provider.is_real_debrid() && real_debrid.is_none() {
            return Err(real_debrid_api_key_required_error());
        }
        if real_debrid.is_none() && !local_torrent_enabled {
            return Err(external_embed_hls_unavailable_error());
        }
        if resolver_provider == ResolverProvider::LocalTorrent && !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
        let cache_reuse_provider = cache_reuse_provider_for_context(
            resolver_provider,
            real_debrid.is_some(),
            local_torrent_enabled,
        );
        if let Some(reused) = self
            .try_reuse_playback_session(
                user_id,
                &metadata,
                &preferences,
                &filters,
                cache_reuse_provider,
                session_key,
                real_debrid,
            )
            .await?
        {
            return Ok(reused);
        }
        if should_allow_latest_playback_session_fallback(&filters)
            && let Some(reused) = self
                .try_reuse_latest_healthy_playback_session(
                    user_id,
                    &metadata,
                    &preferences,
                    &filters,
                    cache_reuse_provider,
                    real_debrid,
                )
                .await?
        {
            return Ok(reused);
        }
        let mut external_guard = self.acquire_external_resolve_permit().await?;
        let candidate_context = CandidateResolutionContext {
            metadata: &metadata,
            preferences: &preferences,
            resolver_provider,
            real_debrid,
            user_id,
            local_torrent_enabled,
        };
        let mut last_error;
        match self
            .fetch_torrentio_episode_streams(
                &metadata.imdb_id,
                metadata.season_number,
                metadata.episode_number,
            )
            .await
        {
            Ok(mut streams) => {
                if resolver_provider != ResolverProvider::LocalTorrent {
                    self.mark_ready_real_debrid_sources(&mut streams, real_debrid)
                        .await;
                }
                let health_scores = self.compute_source_health_scores(&streams).await?;
                let candidate_limit = if resolver_provider.is_fastest() {
                    FASTEST_CANDIDATE_POOL_LIMIT
                } else {
                    10
                };
                let prefer_mp4_default = prefer_mp4_default_candidates(
                    resolver_provider,
                    local_torrent_enabled,
                    real_debrid,
                );
                let candidates = select_top_episode_candidates(
                    &streams,
                    &metadata,
                    &preferences.audio_lang,
                    &preferences.quality,
                    &normalized_preferred_container,
                    &filters.source_hash,
                    candidate_limit,
                    &filters.source_filters,
                    &health_scores,
                    prefer_mp4_default,
                );
                let pinned_missing = !filters.source_hash.is_empty()
                    && !stream_list_contains_hash(&streams, &filters.source_hash);
                if pinned_missing
                    && let Ok(torznab_streams) = self.fetch_torznab_episode_streams(&metadata).await
                    && stream_list_contains_hash(&torznab_streams, &filters.source_hash)
                {
                    let health_scores = self.compute_source_health_scores(&torznab_streams).await?;
                    let torznab_candidates = select_top_episode_candidates(
                        &torznab_streams,
                        &metadata,
                        &preferences.audio_lang,
                        &preferences.quality,
                        &normalized_preferred_container,
                        &filters.source_hash,
                        candidate_limit,
                        &filters.source_filters,
                        &health_scores,
                        prefer_mp4_default,
                    );
                    if let Ok(result) = self
                        .resolve_episode_candidates(torznab_candidates, candidate_context)
                        .await
                    {
                        external_guard.mark_completed();
                        return Ok(result);
                    }
                }
                if !candidates.is_empty() {
                    match self
                        .resolve_episode_candidates(candidates, candidate_context)
                        .await
                    {
                        Ok(result) => {
                            external_guard.mark_completed();
                            return Ok(result);
                        }
                        Err(error) => last_error = Some(error),
                    }
                } else {
                    last_error = Some(ApiError::internal(
                        "No stream candidates were returned for this episode.",
                    ));
                }
            }
            Err(error) => last_error = Some(error),
        }

        // Pinned selections already targeted one exact torrent. Torznab cannot
        // substitute a different hash, and a Torznab outage must not mask the
        // real local-torrent / torrentio failure the player should surface.
        if !filters.source_hash.is_empty() {
            return Err(last_error.unwrap_or_else(|| {
                ApiError::bad_gateway(
                    "Selected torrent source is unavailable right now. Try another source.",
                )
            }));
        }

        match self.fetch_torznab_episode_streams(&metadata).await {
            Ok(torznab_streams) if !torznab_streams.is_empty() => {
                let health_scores = self.compute_source_health_scores(&torznab_streams).await?;
                let candidate_limit = if resolver_provider.is_fastest() {
                    FASTEST_CANDIDATE_POOL_LIMIT
                } else {
                    10
                };
                let prefer_mp4_default = prefer_mp4_default_candidates(
                    resolver_provider,
                    local_torrent_enabled,
                    real_debrid,
                );
                let torznab_candidates = select_top_episode_candidates(
                    &torznab_streams,
                    &metadata,
                    &preferences.audio_lang,
                    &preferences.quality,
                    &normalized_preferred_container,
                    &filters.source_hash,
                    candidate_limit,
                    &filters.source_filters,
                    &health_scores,
                    prefer_mp4_default,
                );
                if !torznab_candidates.is_empty() {
                    match self
                        .resolve_episode_candidates(torznab_candidates, candidate_context)
                        .await
                    {
                        Ok(result) => {
                            external_guard.mark_completed();
                            return Ok(result);
                        }
                        Err(error) => last_error = Some(error),
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                if last_error.is_none() {
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
    }

    async fn resolve_movie_candidates(
        &self,
        candidates: Vec<&DiscoveryStream>,
        context: CandidateResolutionContext<'_>,
    ) -> AppResult<Value> {
        if context.resolver_provider.is_fastest() {
            return self
                .resolve_movie_candidates_auto(
                    candidates,
                    context.metadata,
                    context.preferences,
                    context.real_debrid,
                    context.user_id,
                    context.local_torrent_enabled,
                )
                .await;
        }
        self.resolve_movie_candidates_with_provider(candidates, context)
            .await
    }

    async fn resolve_movie_candidates_with_provider(
        &self,
        candidates: Vec<&DiscoveryStream>,
        context: CandidateResolutionContext<'_>,
    ) -> AppResult<Value> {
        if candidates.is_empty() {
            return Err(ApiError::internal(
                "No stream candidates were returned for this movie.",
            ));
        }
        if context.resolver_provider == ResolverProvider::LocalTorrent {
            let fallback_name = normalize_whitespace(
                format!(
                    "{} {}",
                    context.metadata.display_title, context.metadata.display_year
                )
                .trim(),
            );
            return self
                .resolve_local_torrent_candidates_raced(
                    candidates,
                    context,
                    fallback_name,
                    validate_resolved_movie_source,
                )
                .await;
        }
        let resolution_started_at = now_ms();
        let resolve_max_ms = context.resolver_provider.resolve_max_ms();
        let mut last_error = None;
        for candidate in candidates {
            let elapsed_ms = now_ms() - resolution_started_at;
            if elapsed_ms >= resolve_max_ms {
                break;
            }
            let fallback_name = normalize_whitespace(
                format!(
                    "{} {}",
                    context.metadata.display_title, context.metadata.display_year
                )
                .trim(),
            );
            let remaining_ms = (resolve_max_ms - elapsed_ms).max(1) as u64;
            let payload_result = match timeout(
                Duration::from_millis(remaining_ms),
                self.resolve_real_debrid_candidate_payload(
                    candidate,
                    &fallback_name,
                    context,
                    validate_resolved_movie_source,
                ),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(ApiError::bad_gateway("Resolving stream timed out.")),
            };
            match payload_result {
                Ok(payload) => return Ok(payload),
                Err(error) => {
                    self.record_source_resolve_failure(candidate, &error).await;
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
    }

    async fn resolve_movie_candidates_auto(
        &self,
        candidates: Vec<&DiscoveryStream>,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        real_debrid: Option<&RealDebridRequestContext>,
        user_id: i64,
        local_torrent_enabled: bool,
    ) -> AppResult<Value> {
        if let Some(real_debrid) = real_debrid
            && local_torrent_enabled
        {
            let rd_candidates = candidates.clone();
            let rd_attempt: BoxResolverAttempt<'_> = Box::pin(async {
                self.resolve_movie_candidates_with_provider(
                    rd_candidates,
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::RealDebrid,
                        real_debrid: Some(real_debrid),
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            });
            let local_attempt: BoxResolverAttempt<'_> = Box::pin(async {
                self.resolve_movie_candidates_with_provider(
                    candidates,
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::LocalTorrent,
                        real_debrid: Some(real_debrid),
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            });
            return match timeout(
                Duration::from_millis(FASTEST_RESOLVE_MAX_MS as u64),
                race_staggered_resolver_attempts(
                    vec![rd_attempt, local_attempt],
                    FASTEST_PROVIDER_HEDGE_STAGGER,
                ),
            )
            .await
            {
                Ok(Ok((_provider_index, payload))) => Ok(payload),
                Ok(Err(errors)) => Err(choose_auto_provider_error(errors)),
                Err(_) => Err(ApiError::gateway_timeout("Resolving stream timed out.")),
            };
        }

        let mut real_debrid_error = None;
        if let Some(real_debrid) = real_debrid {
            match self
                .resolve_movie_candidates_with_provider(
                    candidates.clone(),
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::RealDebrid,
                        real_debrid: Some(real_debrid),
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            {
                Ok(result) => return Ok(result),
                Err(error) => real_debrid_error = Some(error),
            }
        }

        if local_torrent_enabled {
            return match self
                .resolve_movie_candidates_with_provider(
                    candidates,
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::LocalTorrent,
                        real_debrid,
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            {
                Ok(result) => Ok(result),
                Err(local_torrent_error) => Err(match real_debrid_error {
                    Some(real_debrid_error)
                        if !is_persistent_source_resolve_error(&local_torrent_error) =>
                    {
                        real_debrid_error
                    }
                    _ => local_torrent_error,
                }),
            };
        }

        Err(real_debrid_error.unwrap_or_else(real_debrid_api_key_required_error))
    }

    async fn resolve_episode_candidates(
        &self,
        candidates: Vec<&DiscoveryStream>,
        context: CandidateResolutionContext<'_>,
    ) -> AppResult<Value> {
        if context.resolver_provider.is_fastest() {
            return self
                .resolve_episode_candidates_auto(
                    candidates,
                    context.metadata,
                    context.preferences,
                    context.real_debrid,
                    context.user_id,
                    context.local_torrent_enabled,
                )
                .await;
        }
        self.resolve_episode_candidates_with_provider(candidates, context)
            .await
    }

    async fn resolve_episode_candidates_with_provider(
        &self,
        candidates: Vec<&DiscoveryStream>,
        context: CandidateResolutionContext<'_>,
    ) -> AppResult<Value> {
        if candidates.is_empty() {
            return Err(ApiError::internal(
                "No stream candidates were returned for this episode.",
            ));
        }
        if context.resolver_provider == ResolverProvider::LocalTorrent {
            let fallback_name = if context.metadata.episode_title.is_empty() {
                format!(
                    "{} S{:02}E{:02}",
                    context.metadata.display_title,
                    context.metadata.season_number,
                    context.metadata.episode_number
                )
            } else {
                format!(
                    "{} S{:02}E{:02} {}",
                    context.metadata.display_title,
                    context.metadata.season_number,
                    context.metadata.episode_number,
                    context.metadata.episode_title
                )
            };
            return self
                .resolve_local_torrent_candidates_raced(
                    candidates,
                    context,
                    fallback_name,
                    validate_resolved_episode_source,
                )
                .await;
        }
        let resolution_started_at = now_ms();
        let resolve_max_ms = context.resolver_provider.resolve_max_ms();
        let mut last_error = None;
        for candidate in candidates {
            let elapsed_ms = now_ms() - resolution_started_at;
            if elapsed_ms >= resolve_max_ms {
                break;
            }
            let fallback_name = if context.metadata.episode_title.is_empty() {
                format!(
                    "{} S{:02}E{:02}",
                    context.metadata.display_title,
                    context.metadata.season_number,
                    context.metadata.episode_number
                )
            } else {
                format!(
                    "{} S{:02}E{:02} {}",
                    context.metadata.display_title,
                    context.metadata.season_number,
                    context.metadata.episode_number,
                    context.metadata.episode_title
                )
            };
            let remaining_ms = (resolve_max_ms - elapsed_ms).max(1) as u64;
            let payload_result = match timeout(
                Duration::from_millis(remaining_ms),
                self.resolve_real_debrid_candidate_payload(
                    candidate,
                    &fallback_name,
                    context,
                    validate_resolved_episode_source,
                ),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(ApiError::bad_gateway("Resolving stream timed out.")),
            };
            match payload_result {
                Ok(payload) => return Ok(payload),
                Err(error) => {
                    self.record_source_resolve_failure(candidate, &error).await;
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
    }

    /// Local-torrent candidate resolution with a staggered hedge: the top
    /// LOCAL_TORRENT_RACE_CANDIDATES race in parallel (next launched on fast
    /// failure or after LOCAL_TORRENT_RACE_STAGGER), first valid resolve wins
    /// and the losers are dropped. One dead/swarm-slow torrent can no longer
    /// serialize the whole resolve behind its metadata timeout. Remaining
    /// candidates fall back to the sequential walk below.
    async fn resolve_local_torrent_candidates_raced(
        &self,
        candidates: Vec<&DiscoveryStream>,
        context: CandidateResolutionContext<'_>,
        fallback_name: String,
        validate: fn(ResolvedSource, &ResolveMetadata) -> AppResult<ResolvedSource>,
    ) -> AppResult<Value> {
        let candidates = prioritize_local_torrent_first_wave(candidates);
        let resolution_started_at = now_ms();
        let resolve_max_ms = context.resolver_provider.resolve_max_ms();
        let metadata = context.metadata;
        let provider = context.resolver_provider;
        let real_debrid = context.real_debrid;
        let local_torrent_enabled = context.local_torrent_enabled;
        let fallback_name = Arc::new(fallback_name);

        let race_count = LOCAL_TORRENT_RACE_CANDIDATES.min(candidates.len());
        let (raced, rest) = candidates.split_at(race_count);
        let race_errors = Arc::new(tokio::sync::Mutex::new(Vec::<ApiError>::new()));
        let attempts = raced
            .iter()
            .copied()
            .map(|candidate| {
                let fallback_name = fallback_name.clone();
                let race_errors = race_errors.clone();
                async move {
                    let attempt = timeout(
                        Duration::from_millis(resolve_max_ms.max(1) as u64),
                        self.resolve_candidate_stream(
                            candidate,
                            &fallback_name,
                            provider,
                            real_debrid,
                            local_torrent_enabled,
                        ),
                    )
                    .await;
                    match attempt {
                        Ok(Ok(resolved)) => match validate(resolved, metadata) {
                            Ok(resolved) => Some(resolved),
                            Err(error) => {
                                tracing::warn!(
                                    hash = %get_stream_info_hash(candidate),
                                    error = error.message().unwrap_or("validation failed"),
                                    "local torrent candidate failed validation"
                                );
                                self.record_source_resolve_failure(candidate, &error).await;
                                race_errors.lock().await.push(error);
                                None
                            }
                        },
                        Ok(Err(error)) => {
                            tracing::warn!(
                                hash = %get_stream_info_hash(candidate),
                                error = error.message().unwrap_or("resolve failed"),
                                "local torrent candidate failed resolve"
                            );
                            self.record_source_resolve_failure(candidate, &error).await;
                            race_errors.lock().await.push(error);
                            None
                        }
                        Err(_) => {
                            let error = ApiError::bad_gateway("Resolving stream timed out.");
                            tracing::warn!(
                                hash = %get_stream_info_hash(candidate),
                                "local torrent candidate timed out"
                            );
                            self.record_source_resolve_failure(candidate, &error).await;
                            race_errors.lock().await.push(error);
                            None
                        }
                    }
                }
            })
            .collect::<Vec<_>>();

        let raced = timeout(
            Duration::from_millis(resolve_max_ms.max(1) as u64),
            race_staggered_first_success(attempts, LOCAL_TORRENT_RACE_STAGGER),
        )
        .await;
        if let Ok(Some((_index, resolved))) = raced {
            return self
                .build_resolved_response(
                    resolved,
                    context.metadata.clone(),
                    context.preferences.clone(),
                    context.resolver_provider,
                    context.user_id,
                    context.real_debrid,
                    true,
                    true,
                )
                .await;
        }

        let mut last_error = race_errors.lock().await.pop();
        for candidate in rest.iter().copied() {
            let elapsed_ms = now_ms() - resolution_started_at;
            if elapsed_ms >= resolve_max_ms {
                break;
            }
            let remaining_ms = (resolve_max_ms - elapsed_ms).max(1) as u64;
            let resolved_result = match timeout(
                Duration::from_millis(remaining_ms),
                self.resolve_candidate_stream(
                    candidate,
                    &fallback_name,
                    context.resolver_provider,
                    context.real_debrid,
                    context.local_torrent_enabled,
                ),
            )
            .await
            {
                Ok(result) => result.and_then(|resolved| validate(resolved, context.metadata)),
                Err(_) => Err(ApiError::bad_gateway("Resolving stream timed out.")),
            };
            match resolved_result {
                Ok(resolved) => {
                    return self
                        .build_resolved_response(
                            resolved,
                            context.metadata.clone(),
                            context.preferences.clone(),
                            context.resolver_provider,
                            context.user_id,
                            context.real_debrid,
                            true,
                            true,
                        )
                        .await;
                }
                Err(error) => {
                    self.record_source_resolve_failure(candidate, &error).await;
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            ApiError::bad_gateway("All local torrent stream candidates failed.")
        }))
    }

    async fn resolve_episode_candidates_auto(
        &self,
        candidates: Vec<&DiscoveryStream>,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        real_debrid: Option<&RealDebridRequestContext>,
        user_id: i64,
        local_torrent_enabled: bool,
    ) -> AppResult<Value> {
        if let Some(real_debrid) = real_debrid
            && local_torrent_enabled
        {
            let rd_candidates = candidates.clone();
            let rd_attempt: BoxResolverAttempt<'_> = Box::pin(async {
                self.resolve_episode_candidates_with_provider(
                    rd_candidates,
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::RealDebrid,
                        real_debrid: Some(real_debrid),
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            });
            let local_attempt: BoxResolverAttempt<'_> = Box::pin(async {
                self.resolve_episode_candidates_with_provider(
                    candidates,
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::LocalTorrent,
                        real_debrid: Some(real_debrid),
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            });
            return match timeout(
                Duration::from_millis(FASTEST_RESOLVE_MAX_MS as u64),
                race_staggered_resolver_attempts(
                    vec![rd_attempt, local_attempt],
                    FASTEST_PROVIDER_HEDGE_STAGGER,
                ),
            )
            .await
            {
                Ok(Ok((_provider_index, payload))) => Ok(payload),
                Ok(Err(errors)) => Err(choose_auto_provider_error(errors)),
                Err(_) => Err(ApiError::gateway_timeout("Resolving stream timed out.")),
            };
        }

        let mut real_debrid_error = None;
        if let Some(real_debrid) = real_debrid {
            match self
                .resolve_episode_candidates_with_provider(
                    candidates.clone(),
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::RealDebrid,
                        real_debrid: Some(real_debrid),
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            {
                Ok(result) => return Ok(result),
                Err(error) => real_debrid_error = Some(error),
            }
        }

        if local_torrent_enabled {
            return match self
                .resolve_episode_candidates_with_provider(
                    candidates,
                    CandidateResolutionContext {
                        metadata,
                        preferences,
                        resolver_provider: ResolverProvider::LocalTorrent,
                        real_debrid,
                        user_id,
                        local_torrent_enabled,
                    },
                )
                .await
            {
                Ok(result) => Ok(result),
                Err(local_torrent_error) => Err(match real_debrid_error {
                    Some(real_debrid_error)
                        if !is_persistent_source_resolve_error(&local_torrent_error) =>
                    {
                        real_debrid_error
                    }
                    _ => local_torrent_error,
                }),
            };
        }

        Err(real_debrid_error.unwrap_or_else(real_debrid_api_key_required_error))
    }

    /// Backfill external subtitle tracks on resolved payloads that have none.
    ///
    /// The external-embed pipeline builds its payload without a media probe or
    /// subtitle search (see build_external_embed_resolved_payload_with_playable_url),
    /// so embed playback — the most common VOD path — would otherwise always
    /// surface an empty Subtitles menu. Reads everything it needs back out of
    /// the payload, so it covers fresh resolves, embed-cache hits, and pinned
    /// sources alike.
    async fn attach_external_subtitle_tracks_to_payload(&self, payload: &mut Value) {
        if stringify_json(payload.get("resolverProvider")) != EXTERNAL_EMBED_RESOLVER_PROVIDER {
            return;
        }
        let has_subtitle_tracks = payload
            .get("tracks")
            .and_then(|tracks| tracks.get("subtitleTracks"))
            .and_then(Value::as_array)
            .map(|tracks| !tracks.is_empty())
            .unwrap_or(false);
        if has_subtitle_tracks {
            return;
        }
        let Some(metadata) = payload.get("metadata") else {
            return;
        };
        let imdb_id = stringify_json(metadata.get("imdbId"));
        let display_title = stringify_json(metadata.get("displayTitle"));
        let display_year = stringify_json(metadata.get("displayYear"));
        let season_number = metadata
            .get("seasonNumber")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let episode_number = metadata
            .get("episodeNumber")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let filename = stringify_json(payload.get("filename"));
        let preferred_subtitle_lang = stringify_json(
            payload
                .get("preferences")
                .and_then(|preferences| preferences.get("subtitleLang")),
        );
        if preferred_subtitle_lang == "off" {
            return;
        }

        let mut subtitle_tracks = self
            .media
            .search_opensubtitles_tracks(
                &imdb_id,
                &display_title,
                &display_year,
                &preferred_subtitle_lang,
                &filename,
            )
            .await;
        if subtitle_tracks.is_empty() {
            subtitle_tracks = self
                .media
                .search_stremio_addon_subtitle_tracks(
                    &imdb_id,
                    season_number,
                    episode_number,
                    &preferred_subtitle_lang,
                )
                .await;
        }
        if subtitle_tracks.is_empty() {
            return;
        }

        let probe = MediaProbe {
            subtitleTracks: subtitle_tracks,
            ..MediaProbe::default()
        };
        let selected_subtitle_stream_index =
            choose_subtitle_track_from_probe(&probe, &preferred_subtitle_lang)
                .map(|track| track.streamIndex)
                .unwrap_or(-1);
        payload["tracks"]["subtitleTracks"] = json!(probe.subtitleTracks);
        payload["selectedSubtitleStreamIndex"] = json!(selected_subtitle_stream_index);
    }

    #[allow(clippy::too_many_arguments)]
    async fn build_resolved_response(
        &self,
        resolved: ResolvedSource,
        metadata: ResolveMetadata,
        preferences: ResolvePreferences,
        resolver_provider: ResolverProvider,
        user_id: i64,
        real_debrid: Option<&RealDebridRequestContext>,
        include_session: bool,
        allow_cached_media_probe: bool,
    ) -> AppResult<Value> {
        // Lazy Real-Debrid HLS tickets are intentionally short-lived. Refresh
        // an authenticated session's still-valid signed identity before it is
        // normalized for this response, so a durable playback-session row does
        // not turn that recovery path into a long-lived bearer capability.
        // Legacy rows containing a raw Real-Debrid HLS URL are left untouched.
        let resolved = if resolver_provider == ResolverProvider::RealDebrid {
            refresh_real_debrid_lazy_hls_fallbacks(
                &resolved,
                real_debrid,
                &self.config.live_hls_proxy_secret,
            )
        } else {
            resolved
        };
        let source_input = extract_playable_source_input(&resolved.playable_url);
        // The piece-aware local stream is playable as soon as its startup
        // buffer is ready. ffprobe and subtitle providers are enrichment, not
        // prerequisites; running them here used to add 15-55 seconds before
        // the browser received a URL and made ffmpeg compete with startup I/O.
        let tracks_pending =
            should_defer_resolved_track_enrichment(resolver_provider, &resolved.playable_url);
        let (tracks, selected_audio_stream_index, selected_subtitle_stream_index) =
            if tracks_pending {
                // A prior play may already have populated the durable probe
                // cache. Reuse it immediately for RD so browser-incompatible
                // audio (for example AC-3) and explicit language choices route
                // straight to remux instead of starting direct playback and
                // restarting after deferred enrichment. A cache miss remains
                // fully non-blocking: no ffprobe runs in this resolve request.
                let cached_tracks = if resolver_provider == ResolverProvider::RealDebrid
                    && allow_cached_media_probe
                {
                    self.media.cached_media_probe(&source_input).await?
                } else {
                    None
                };
                if let Some(tracks) = cached_tracks {
                    let (selected_audio_stream_index, selected_subtitle_stream_index) =
                        select_resolved_track_indexes(&tracks, &preferences);
                    (
                        tracks,
                        selected_audio_stream_index,
                        selected_subtitle_stream_index,
                    )
                } else {
                    (
                        MediaProbe {
                            durationSeconds: metadata.runtime_seconds,
                            ..MediaProbe::default()
                        },
                        -1,
                        -1,
                    )
                }
            } else {
                let subtitle_lookup = async {
                    if preferences.subtitle_lang == "off" {
                        return Vec::new();
                    }
                    let mut external = self
                        .media
                        .search_opensubtitles_tracks(
                            &metadata.imdb_id,
                            &metadata.display_title,
                            &metadata.display_year,
                            &preferences.subtitle_lang,
                            &resolved.filename,
                        )
                        .await;
                    if external.is_empty() {
                        external = self
                            .media
                            .search_stremio_addon_subtitle_tracks(
                                &metadata.imdb_id,
                                metadata.season_number,
                                metadata.episode_number,
                                &preferences.subtitle_lang,
                            )
                            .await;
                    }
                    external
                };
                let (probe_result, external_subtitle_tracks) = tokio::join!(
                    self.media.probe_media_tracks(&source_input),
                    subtitle_lookup
                );
                let mut tracks = probe_result.unwrap_or_else(|_| MediaProbe {
                    durationSeconds: metadata.runtime_seconds,
                    ..MediaProbe::default()
                });
                if !external_subtitle_tracks.is_empty() {
                    tracks.subtitleTracks = merge_preferred_subtitle_tracks(
                        external_subtitle_tracks,
                        tracks.subtitleTracks,
                    );
                }
                let (selected_audio_stream_index, selected_subtitle_stream_index) =
                    select_resolved_track_indexes(&tracks, &preferences);
                (
                    tracks,
                    selected_audio_stream_index,
                    selected_subtitle_stream_index,
                )
            };
        let normalized = normalize_resolved_source_for_software_decode(
            &resolved,
            selected_audio_stream_index,
            selected_subtitle_stream_index,
        );
        // Real-Debrid's unrestricted download host is the fast path. Legacy
        // playback-session rows can still contain a raw Apple-HLS primary, so
        // retain the compatibility transform that prefers their download remux
        // and converts the raw HLS URL into a signed relay. New resolves already
        // carry an authenticated lazy-HLS fallback and pass through unchanged.
        let browser_normalized =
            proxy_real_debrid_hls_for_browser(&normalized, &self.config.live_hls_proxy_secret);
        let browser_source_input = if is_remux_playback_url(&browser_normalized.playable_url) {
            extract_playable_source_input(&browser_normalized.playable_url)
        } else {
            source_input.clone()
        };

        let response_filename = if browser_normalized.filename.is_empty() {
            resolved.filename.clone()
        } else {
            browser_normalized.filename.clone()
        };
        let mut response_metadata =
            build_resolved_metadata_payload(&metadata, &resolved, &response_filename);
        response_metadata["resolverProvider"] = json!(resolver_provider.as_str());
        response_metadata["realDebridCached"] = json!(resolved.real_debrid_cached);
        let response_source_hash = resolved.source_hash.clone();
        let response_selected_file = resolved.selected_file.clone();
        let response_selected_file_path = resolved.selected_file_path.clone();
        let response_audio_lang = preferences.audio_lang.clone();
        let response_subtitle_lang = preferences.subtitle_lang.clone();
        let response_quality = preferences.quality.clone();
        let mut payload = json!({
            "playableUrl": browser_normalized.playable_url.clone(),
            "fallbackUrls": browser_normalized.fallback_urls.clone(),
            "filename": response_filename.clone(),
            "sourceHash": response_source_hash.clone(),
            "selectedFile": response_selected_file.clone(),
            "selectedFilePath": response_selected_file_path.clone(),
            "resolverProvider": resolver_provider.as_str(),
            "realDebridCached": resolved.real_debrid_cached,
            "sourceInput": browser_source_input,
            "tracks": tracks,
            "tracksPending": tracks_pending,
            "selectedAudioStreamIndex": selected_audio_stream_index,
            "selectedSubtitleStreamIndex": selected_subtitle_stream_index,
            "preferences": {
                "audioLang": response_audio_lang.clone(),
                "subtitleLang": response_subtitle_lang.clone(),
                "quality": response_quality.clone()
            },
            "metadata": response_metadata.clone()
        });
        if include_session {
            payload["session"] =
                if self.config.playback_sessions_enabled && !metadata.tmdb_id.is_empty() {
                    let session_key = build_user_scoped_playback_session_key_for_metadata(
                        &metadata,
                        &response_audio_lang,
                        &response_quality,
                        resolver_provider,
                        user_id,
                    );
                    let mut persisted_metadata = response_metadata.clone();
                    if resolver_provider == ResolverProvider::RealDebrid
                        && let Some(real_debrid) = real_debrid
                    {
                        persisted_metadata[PLAYBACK_SESSION_CREDENTIAL_SCOPE_METADATA_KEY] =
                            json!(real_debrid.cache_scope.clone());
                    }
                    self.db
                        .persist_playback_session(PersistPlaybackSessionInput {
                            user_id,
                            session_key: session_key.clone(),
                            tmdb_id: metadata.tmdb_id.clone(),
                            audio_lang: response_audio_lang.clone(),
                            preferred_quality: response_quality.clone(),
                            source_hash: response_source_hash.clone(),
                            selected_file: response_selected_file.clone(),
                            filename: response_filename.clone(),
                            playable_url: normalized.playable_url.clone(),
                            fallback_urls: normalized.fallback_urls.clone(),
                            metadata: persisted_metadata,
                        })
                        .await?;
                    self.db
                        .get_playback_session(user_id, session_key.clone())
                        .await?
                        .map(|session| build_playback_session_payload(&session))
                        .unwrap_or_else(|| {
                            build_pending_playback_session_payload(
                                &session_key,
                                &response_source_hash,
                                &response_selected_file,
                                &response_quality,
                                resolver_provider,
                            )
                        })
                } else {
                    Value::Null
                };
        }
        Ok(payload)
    }

    async fn resolve_candidate_stream(
        &self,
        stream: &DiscoveryStream,
        fallback_name: &str,
        resolver_provider: ResolverProvider,
        _real_debrid: Option<&RealDebridRequestContext>,
        local_torrent_enabled: bool,
    ) -> AppResult<ResolvedSource> {
        if resolver_provider.is_real_debrid() {
            return Err(ApiError::internal(
                "Real-Debrid candidates must retain ownership through payload completion.",
            ));
        }
        if resolver_provider.is_fastest() {
            return Err(ApiError::internal(
                "Fastest resolver must race concrete providers.",
            ));
        }
        if !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
        self.resolve_local_torrent_candidate_stream(stream, fallback_name)
            .await
    }

    async fn resolve_real_debrid_candidate_payload(
        &self,
        stream: &DiscoveryStream,
        fallback_name: &str,
        context: CandidateResolutionContext<'_>,
        validate: fn(ResolvedSource, &ResolveMetadata) -> AppResult<ResolvedSource>,
    ) -> AppResult<Value> {
        let real_debrid = context
            .real_debrid
            .ok_or_else(real_debrid_api_key_required_error)?;
        let resolved_stream = self
            .resolve_real_debrid_candidate_stream(stream, fallback_name, real_debrid)
            .await?;
        let resolved = validate(resolved_stream.resolved, context.metadata)?;
        complete_real_debrid_attempt_with_lease(
            resolved_stream.owned_torrent,
            self.build_resolved_response(
                resolved,
                context.metadata.clone(),
                context.preferences.clone(),
                ResolverProvider::RealDebrid,
                context.user_id,
                Some(real_debrid),
                true,
                true,
            ),
        )
        .await
    }

    async fn find_local_cache_upgrade_from_session(
        &self,
        lookup: LocalCacheSessionLookup<'_>,
    ) -> AppResult<Option<Value>> {
        let session_key = if lookup.media_type == "tv" {
            format!(
                "local-torrent:{}",
                build_tv_playback_session_key(
                    lookup.tmdb_id,
                    lookup.season_number,
                    lookup.episode_number,
                    lookup.audio_lang,
                    lookup.quality,
                )
            )
        } else {
            format!(
                "local-torrent:{}",
                build_playback_session_key(lookup.tmdb_id, lookup.audio_lang, lookup.quality)
            )
        };
        let Some(session) = self
            .db
            .get_playback_session(lookup.user_id, session_key)
            .await?
        else {
            return Ok(None);
        };
        if session.tmdb_id != lookup.tmdb_id
            || session.health_state == "invalid"
            || normalize_source_hash(&session.source_hash) != lookup.source_hash
            || !is_local_playback_session_url(&session.playable_url)
        {
            return Ok(None);
        }
        if session.playable_url.contains("/api/local-cache/stream")
            && self
                .local_torrent
                .try_direct_file_resolved_source(&session.source_hash, &session.selected_file)
                .await?
                .is_none()
        {
            return Ok(None);
        }
        Ok(Some(
            self.build_local_cache_upgrade_payload_from_session(session),
        ))
    }

    fn build_local_cache_upgrade_payload(&self, resolved: LocalTorrentResolvedSource) -> Value {
        local_cache_upgrade_payload(resolved)
    }

    fn build_local_cache_upgrade_payload_from_session(&self, session: PlaybackSession) -> Value {
        json!({
            "ready": true,
            "playableUrl": session.playable_url,
            "sourceInput": extract_playable_source_input(&session.playable_url),
            "filename": session.filename,
            "sourceHash": session.source_hash,
            "selectedFile": session.selected_file,
            "resolverProvider": ResolverProvider::LocalTorrent.as_str(),
            "tracksPending": true,
            "session": build_playback_session_payload(&session),
        })
    }

    async fn resolve_local_torrent_candidate_stream(
        &self,
        stream: &DiscoveryStream,
        fallback_name: &str,
    ) -> AppResult<ResolvedSource> {
        let magnet = build_magnet_uri(stream, fallback_name)?;
        let resolved = self
            .local_torrent
            .resolve(LocalTorrentResolveRequest {
                info_hash: get_stream_info_hash(stream),
                magnet_uri: magnet,
                preferred_file_index: stream.fileIdx,
                preferred_filename: stream.behaviorHints.filename.clone(),
                fallback_name: fallback_name.to_owned(),
            })
            .await?;
        Ok(local_torrent_resolved_source_to_resolved_source(resolved))
    }

    async fn resolve_effective_preferred_audio_lang(
        &self,
        user_id: i64,
        media_type: &str,
        tmdb_id: &str,
        stored_preferred_audio_lang: &str,
        preferred_audio_lang: &str,
    ) -> AppResult<String> {
        let normalized = normalize_preferred_audio_lang(preferred_audio_lang);
        if normalized != "auto" {
            return Ok(normalized);
        }
        let stored = normalize_preferred_audio_lang(stored_preferred_audio_lang);
        if stored != "auto" {
            return Ok(stored);
        }
        let preference = self
            .db
            .get_title_preference(
                user_id,
                normalize_resolve_media_type(media_type),
                tmdb_id.trim().to_owned(),
            )
            .await?;
        Ok(preference
            .map(|value| normalize_preferred_audio_lang(&value.audioLang))
            .filter(|value| value != "auto")
            .unwrap_or_else(|| "auto".to_owned()))
    }

    /// Give a due persisted URL a brief chance to fail definitively without
    /// putting the full CDN validation timeout on the playback critical path.
    /// The database claim is compare-and-set, so differently-shaped resolve
    /// requests that converge on the same session cannot start a HEAD storm.
    async fn playback_session_revalidation_allows_reuse(
        &self,
        session: &PlaybackSession,
    ) -> AppResult<PlaybackSessionRevalidation> {
        let verifiable_url = extract_playable_source_input(&session.playable_url);
        let needs_revalidation = (session.next_validation_at < 0
            || (session.next_validation_at > 0 && session.next_validation_at <= now_ms()))
            && looks_like_http_url(&verifiable_url);
        if !needs_revalidation {
            return Ok(PlaybackSessionRevalidation::Fresh);
        }
        let claim_token = match self
            .db
            .try_claim_playback_session_validation(session.clone())
            .await?
        {
            PlaybackSessionValidationClaim::Claimed(claim_token) => claim_token,
            PlaybackSessionValidationClaim::Fresh | PlaybackSessionValidationClaim::Leased => {
                // This snapshot was due or leased when it was read. A newer
                // validation state now owns the row, so serve it without
                // re-persisting stale fields over that state.
                return Ok(PlaybackSessionRevalidation::StaleWhileRevalidate);
            }
            PlaybackSessionValidationClaim::Unavailable => {
                return Ok(PlaybackSessionRevalidation::Invalid);
            }
        };

        let resolver = self.clone();
        let validation_session = session.clone();
        let validation_user_id = session.user_id;
        let (result_tx, result_rx) = oneshot::channel();
        tokio::spawn(async move {
            let definitive_failure = resolver
                .verify_playable_url(&verifiable_url, PLAYBACK_SESSION_REVALIDATE_TIMEOUT_MS)
                .await
                .is_err();
            let update = if definitive_failure {
                resolver
                    .db
                    .invalidate_playback_session_validation_if_current(
                        validation_session,
                        claim_token,
                        "Playback session validation failed for the stored stream URL.".to_owned(),
                    )
                    .await
            } else {
                resolver
                    .db
                    .refresh_playback_session_validation_if_current(validation_session, claim_token)
                    .await
            };
            let revalidation = match update {
                Ok(true) if definitive_failure => PlaybackSessionRevalidation::Invalid,
                Ok(true) => PlaybackSessionRevalidation::Fresh,
                Ok(false) => PlaybackSessionRevalidation::Invalid,
                Err(error) => {
                    tracing::warn!(
                        user_id = validation_user_id,
                        error = error.message().unwrap_or("persistence update failed"),
                        "failed to persist playback-session validation result"
                    );
                    PlaybackSessionRevalidation::Invalid
                }
            };
            let _ = result_tx.send(revalidation);
        });

        // Most explicit CDN rejections arrive within one round trip. If the
        // validation is slower, return the stale session now and let the same
        // bounded check update or invalidate it for the next request.
        Ok(classify_playback_session_revalidation(
            result_rx,
            Duration::from_millis(PLAYBACK_SESSION_REVALIDATE_FOREGROUND_GRACE_MS),
        )
        .await)
    }

    #[allow(clippy::too_many_arguments)]
    async fn try_reuse_playback_session(
        &self,
        user_id: i64,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        filters: &ResolveFilters,
        resolver_provider: ResolverProvider,
        requested_session_key: &str,
        real_debrid: Option<&RealDebridRequestContext>,
    ) -> AppResult<Option<Value>> {
        if !self.config.playback_sessions_enabled
            || metadata.tmdb_id.trim().is_empty()
            || should_skip_playback_session_reuse(filters)
        {
            return Ok(None);
        }

        let mut session_keys = Vec::new();
        let requested_session_key = requested_session_key.trim();
        if !requested_session_key.is_empty()
            && requested_playback_session_key_allowed(
                requested_session_key,
                resolver_provider,
                user_id,
            )
        {
            session_keys.push(requested_session_key.to_owned());
        }
        session_keys.extend(build_playback_session_lookup_keys(
            metadata,
            &preferences.audio_lang,
            &preferences.quality,
            resolver_provider,
            user_id,
        ));
        session_keys.dedup();
        let mut session = None;
        for session_key in session_keys {
            if let Some(candidate) = self.db.get_playback_session(user_id, session_key).await? {
                session = Some(candidate);
                break;
            }
        }
        let Some(session) = session else {
            return Ok(None);
        };
        if session.tmdb_id != metadata.tmdb_id
            || session.playable_url.trim().is_empty()
            || session.health_state == "invalid"
        {
            return Ok(None);
        }
        if !playback_session_matches_source_hash(&session, filters) {
            return Ok(None);
        }
        if !playback_session_matches_preferred_container(&session, filters) {
            return Ok(None);
        }
        if !playback_session_matches_preferred_quality(&session, preferences, filters) {
            return Ok(None);
        }
        if !playback_session_matches_resolver_provider(&session, resolver_provider) {
            return Ok(None);
        }
        if !playback_session_matches_real_debrid_scope(&session, resolver_provider, real_debrid) {
            return Ok(None);
        }
        if should_skip_unpinned_torrent_session_reuse(&session, filters) {
            return Ok(None);
        }

        let match_name = playback_session_match_name(&session);
        let is_valid_match = if metadata.media_type == "tv" {
            does_filename_likely_match_tv_episode(
                &match_name,
                &metadata.display_title,
                &metadata.display_year,
                metadata.season_number,
                metadata.episode_number,
            )
        } else {
            does_filename_likely_match_movie(
                &match_name,
                &metadata.display_title,
                &metadata.display_year,
            )
        };
        if !is_valid_match {
            if metadata.media_type != "tv" {
                self.invalidate_playback_session(
                    &session,
                    "Playback session filename mismatched the requested title.",
                )
                .await;
            }
            return Ok(None);
        }

        let revalidation = self
            .playback_session_revalidation_allows_reuse(&session)
            .await?;
        if revalidation == PlaybackSessionRevalidation::Invalid {
            return Ok(None);
        }

        let persist_session = revalidation == PlaybackSessionRevalidation::Fresh;
        let mut payload = self
            .build_resolved_response(
                ResolvedSource {
                    playable_url: session.playable_url.clone(),
                    fallback_urls: session.fallback_urls.clone(),
                    filename: session.filename.clone(),
                    source_hash: session.source_hash.clone(),
                    selected_file: session.selected_file.clone(),
                    selected_file_path: playback_session_selected_file_path(&session),
                    real_debrid_cached: session
                        .metadata
                        .get("realDebridCached")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
                metadata.clone(),
                preferences.clone(),
                resolver_provider,
                user_id,
                real_debrid,
                persist_session,
                true,
            )
            .await?;
        if !persist_session {
            payload["session"] = build_playback_session_payload(&session);
        }
        Ok(Some(payload))
    }

    async fn try_reuse_latest_healthy_playback_session(
        &self,
        user_id: i64,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        filters: &ResolveFilters,
        resolver_provider: ResolverProvider,
        real_debrid: Option<&RealDebridRequestContext>,
    ) -> AppResult<Option<Value>> {
        if !self.config.playback_sessions_enabled || metadata.tmdb_id.trim().is_empty() {
            return Ok(None);
        }

        let sessions = self
            .db
            .get_latest_healthy_playback_sessions_for_tmdb(user_id, metadata.tmdb_id.clone(), 20)
            .await?;
        if sessions.is_empty() {
            return Ok(None);
        }

        for session in sessions {
            if !playback_session_key_allowed_for_user(
                &session.session_key,
                resolver_provider,
                user_id,
            ) {
                continue;
            }
            if session.tmdb_id != metadata.tmdb_id || session.playable_url.trim().is_empty() {
                continue;
            }
            if !playback_session_matches_source_hash(&session, filters) {
                continue;
            }
            if !playback_session_matches_preferred_container(&session, filters) {
                continue;
            }
            if !playback_session_matches_preferred_quality(&session, preferences, filters) {
                continue;
            }
            if !playback_session_matches_resolver_provider(&session, resolver_provider) {
                continue;
            }
            if !playback_session_matches_real_debrid_scope(&session, resolver_provider, real_debrid)
            {
                continue;
            }
            if should_skip_unpinned_torrent_session_reuse(&session, filters) {
                continue;
            }

            let match_name = playback_session_match_name(&session);
            let is_valid_match = if metadata.media_type == "tv" {
                does_filename_likely_match_tv_episode(
                    &match_name,
                    &metadata.display_title,
                    &metadata.display_year,
                    metadata.season_number,
                    metadata.episode_number,
                )
            } else {
                does_filename_likely_match_movie(
                    &match_name,
                    &metadata.display_title,
                    &metadata.display_year,
                )
            };
            if !is_valid_match {
                if metadata.media_type != "tv" {
                    self.invalidate_playback_session(
                        &session,
                        "Playback session filename mismatched the requested title.",
                    )
                    .await;
                }
                continue;
            }

            let revalidation = self
                .playback_session_revalidation_allows_reuse(&session)
                .await?;
            if revalidation == PlaybackSessionRevalidation::Invalid {
                continue;
            }

            let persist_session = revalidation == PlaybackSessionRevalidation::Fresh;
            let mut payload = self
                .build_resolved_response(
                    ResolvedSource {
                        playable_url: session.playable_url.clone(),
                        fallback_urls: session.fallback_urls.clone(),
                        filename: session.filename.clone(),
                        source_hash: session.source_hash.clone(),
                        selected_file: session.selected_file.clone(),
                        selected_file_path: playback_session_selected_file_path(&session),
                        real_debrid_cached: session
                            .metadata
                            .get("realDebridCached")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    },
                    metadata.clone(),
                    preferences.clone(),
                    resolver_provider,
                    user_id,
                    real_debrid,
                    persist_session,
                    true,
                )
                .await?;
            if !persist_session {
                payload["session"] = build_playback_session_payload(&session);
            }
            return Ok(Some(payload));
        }

        Ok(None)
    }

    async fn invalidate_playback_session(&self, session: &PlaybackSession, reason: &str) {
        let _ = self
            .db
            .update_playback_session_progress(
                session.user_id,
                session.session_key.clone(),
                session.last_position_seconds,
                "invalid".to_owned(),
                reason.to_owned(),
            )
            .await;
    }

    async fn fetch_movie_metadata(
        &self,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
    ) -> AppResult<ResolveMetadata> {
        let details = self
            .tmdb
            .fetch(
                &format!("/movie/{}", tmdb_id.trim()),
                BTreeMap::new(),
                20_000,
            )
            .await?;
        let imdb_id = stringify_json(details.get("imdb_id"));
        if imdb_id.is_empty() {
            return Err(ApiError::internal(
                "This TMDB movie does not expose an IMDb id.",
            ));
        }
        let runtime_minutes = details
            .get("runtime")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        Ok(ResolveMetadata {
            tmdb_id: tmdb_id.trim().to_owned(),
            imdb_id,
            display_title: normalize_whitespace(
                &stringify_json(details.get("title")).if_empty_then(|| title_fallback.to_owned()),
            )
            .if_empty_then(|| "Movie".to_owned()),
            display_year: normalize_whitespace(
                &stringify_json(details.get("release_date"))
                    .chars()
                    .take(4)
                    .collect::<String>()
                    .if_empty_then(|| year_fallback.to_owned()),
            ),
            runtime_seconds: if runtime_minutes > 0 {
                runtime_minutes * 60
            } else {
                0
            },
            season_number: 0,
            episode_number: 0,
            episode_title: String::new(),
            media_type: "movie".to_owned(),
        })
    }

    async fn fetch_tv_episode_metadata(
        &self,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        season_number: i64,
        episode_number: i64,
    ) -> AppResult<ResolveMetadata> {
        let series_path = format!("/tv/{}", tmdb_id.trim());
        let episode_path = format!(
            "/tv/{}/season/{}/episode/{}",
            tmdb_id.trim(),
            season_number,
            episode_number
        );
        let external_ids_path = format!("/tv/{}/external_ids", tmdb_id.trim());
        let series_details_fut = self.tmdb.fetch(&series_path, BTreeMap::new(), 20_000);
        let episode_details_fut = self.tmdb.fetch(&episode_path, BTreeMap::new(), 20_000);
        let series_external_ids_fut = self.tmdb.fetch(&external_ids_path, BTreeMap::new(), 20_000);
        let (series_details, episode_details, series_external_ids) = tokio::try_join!(
            series_details_fut,
            episode_details_fut,
            series_external_ids_fut
        )?;
        let imdb_id = stringify_json(series_external_ids.get("imdb_id"));
        if imdb_id.is_empty() {
            return Err(ApiError::internal(
                "This TMDB series does not expose an IMDb id.",
            ));
        }
        let runtime_minutes = episode_details
            .get("runtime")
            .and_then(Value::as_i64)
            .or_else(|| {
                series_details
                    .get("episode_run_time")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(Value::as_i64)
            })
            .unwrap_or_default();
        Ok(ResolveMetadata {
            tmdb_id: tmdb_id.trim().to_owned(),
            imdb_id,
            display_title: normalize_whitespace(
                &stringify_json(series_details.get("name"))
                    .if_empty_then(|| title_fallback.to_owned()),
            )
            .if_empty_then(|| "Series".to_owned()),
            display_year: stringify_json(series_details.get("first_air_date"))
                .chars()
                .take(4)
                .collect::<String>()
                .if_empty_then(|| year_fallback.to_owned()),
            runtime_seconds: if runtime_minutes > 0 {
                runtime_minutes * 60
            } else {
                0
            },
            season_number,
            episode_number,
            episode_title: normalize_whitespace(&stringify_json(episode_details.get("name")))
                .if_empty_then(|| format!("Episode {episode_number}")),
            media_type: "tv".to_owned(),
        })
    }

    async fn fetch_torrentio_movie_streams(
        &self,
        imdb_id: &str,
    ) -> AppResult<Vec<DiscoveryStream>> {
        self.fetch_torrentio_streams(&format!("/stream/movie/{}.json", imdb_id.trim()))
            .await
    }

    async fn fetch_torrentio_episode_streams(
        &self,
        imdb_id: &str,
        season_number: i64,
        episode_number: i64,
    ) -> AppResult<Vec<DiscoveryStream>> {
        self.fetch_torrentio_streams(&format!(
            "/stream/series/{}:{}:{}.json",
            url::form_urlencoded::byte_serialize(imdb_id.trim().as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(season_number.to_string().as_bytes())
                .collect::<String>(),
            url::form_urlencoded::byte_serialize(episode_number.to_string().as_bytes())
                .collect::<String>(),
        ))
        .await
    }

    async fn fetch_torrentio_streams(&self, path: &str) -> AppResult<Vec<DiscoveryStream>> {
        let torrentio_base = crate::provider_registry::resolve(
            crate::provider_registry::keys::INFRA_TORRENTIO,
            &self.config.torrentio_base_url,
        );
        let url = format!("{}{}", torrentio_base, path);
        let cache_key = build_torrentio_stream_cache_key(&torrentio_base, path);
        let cached = self.db.get_resolved_stream_cache(cache_key.clone()).await?;
        let now = now_ms();
        if let Some((payload, _, next_validation_at)) = cached.as_ref()
            && *next_validation_at > now
        {
            return parse_torrentio_streams_payload(payload);
        }

        let mut last_error = None;

        for attempt in 0..TORRENTIO_REQUEST_MAX_ATTEMPTS {
            let is_last_attempt = attempt + 1 == TORRENTIO_REQUEST_MAX_ATTEMPTS;
            let attempt_started_at = now_ms();
            let response = self
                .client
                .get(&url)
                .timeout(Duration::from_millis(TORRENTIO_REQUEST_TIMEOUT_MS))
                .send()
                .await;

            match response {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let attempt_elapsed_ms = now_ms() - attempt_started_at;
                        if !is_last_attempt
                            && is_retryable_torrentio_status(status)
                            && attempt_elapsed_ms <= TORRENTIO_RETRY_MAX_ELAPSED_MS
                        {
                            sleep(Duration::from_millis(TORRENTIO_REQUEST_RETRY_DELAY_MS)).await;
                            continue;
                        }
                        last_error = Some(ApiError::bad_gateway(format!(
                            "Torrentio request failed ({status})."
                        )));
                        break;
                    }

                    if let Some(len) = response.content_length()
                        && len > MAX_DISCOVERY_RESPONSE_BYTES
                    {
                        last_error = Some(ApiError::bad_gateway(
                            "Torrentio response exceeded the maximum allowed size.",
                        ));
                        break;
                    }
                    let payload = response
                        .json::<Value>()
                        .await
                        .map_err(|_| ApiError::bad_gateway("Invalid Torrentio response."))?;
                    let (expires_at, next_validation_at) =
                        compute_torrentio_cache_deadlines(&payload);
                    self.db
                        .set_resolved_stream_cache(
                            cache_key.clone(),
                            payload.clone(),
                            expires_at,
                            next_validation_at,
                        )
                        .await?;
                    return parse_torrentio_streams_payload(&payload);
                }
                Err(error) => {
                    let attempt_elapsed_ms = now_ms() - attempt_started_at;
                    if !is_last_attempt
                        && is_retryable_torrentio_transport_error(&error)
                        && attempt_elapsed_ms <= TORRENTIO_RETRY_MAX_ELAPSED_MS
                    {
                        sleep(Duration::from_millis(TORRENTIO_REQUEST_RETRY_DELAY_MS)).await;
                        continue;
                    }
                    last_error = Some(map_reqwest_error(error, "Torrentio request timed out."));
                    break;
                }
            }
        }

        if let Some((payload, expires_at, _)) = cached
            && expires_at > now_ms()
        {
            return parse_torrentio_streams_payload(&payload);
        }

        Err(last_error
            .unwrap_or_else(|| ApiError::bad_gateway("Torrentio request failed after retrying.")))
    }

    async fn fetch_torznab_movie_streams(
        &self,
        metadata: &ResolveMetadata,
    ) -> AppResult<Vec<DiscoveryStream>> {
        if !self.is_torznab_configured() {
            return Ok(Vec::new());
        }
        let imdb_id = metadata.imdb_id.trim();
        let categories = self.config.torznab_movie_categories.join(",");
        let limit = self.config.torznab_limit.to_string();
        let title_query = normalize_whitespace(
            format!("{} {}", metadata.display_title, metadata.display_year).trim(),
        );
        let search_params = vec![
            ("t", "search".to_owned()),
            ("q", title_query),
            ("cat", categories.clone()),
            ("limit", limit.clone()),
            ("extended", "1".to_owned()),
        ];
        if imdb_id.is_empty() {
            return self.fetch_torznab_streams(&search_params).await;
        }

        let primary_params = vec![
            ("t", "movie".to_owned()),
            ("imdbid", imdb_id.to_owned()),
            ("cat", categories),
            ("limit", limit),
            ("extended", "1".to_owned()),
        ];
        let (primary_result, search_result) = tokio::join!(
            self.fetch_torznab_streams(&primary_params),
            self.fetch_torznab_streams(&search_params),
        );
        merge_discovery_query_results(primary_result, search_result)
    }

    async fn fetch_torznab_episode_streams(
        &self,
        metadata: &ResolveMetadata,
    ) -> AppResult<Vec<DiscoveryStream>> {
        if !self.is_torznab_configured() {
            return Ok(Vec::new());
        }
        let imdb_id = metadata.imdb_id.trim();
        let categories = self.config.torznab_tv_categories.join(",");
        let limit = self.config.torznab_limit.to_string();
        let episode_query = format!(
            "{} S{:02}E{:02}",
            metadata.display_title, metadata.season_number, metadata.episode_number
        );
        let search_params = vec![
            ("t", "search".to_owned()),
            ("q", normalize_whitespace(&episode_query)),
            ("cat", categories.clone()),
            ("limit", limit.clone()),
            ("extended", "1".to_owned()),
        ];
        if imdb_id.is_empty() {
            return self.fetch_torznab_streams(&search_params).await;
        }

        let primary_params = vec![
            ("t", "tvsearch".to_owned()),
            ("imdbid", imdb_id.to_owned()),
            ("season", metadata.season_number.to_string()),
            ("ep", metadata.episode_number.to_string()),
            ("cat", categories),
            ("limit", limit),
            ("extended", "1".to_owned()),
        ];
        let (primary_result, search_result) = tokio::join!(
            self.fetch_torznab_streams(&primary_params),
            self.fetch_torznab_streams(&search_params),
        );
        merge_discovery_query_results(primary_result, search_result)
    }

    async fn fetch_torznab_streams(
        &self,
        params: &[(&str, String)],
    ) -> AppResult<Vec<DiscoveryStream>> {
        if !self.is_torznab_configured() {
            return Ok(Vec::new());
        }
        let cache_key = build_torznab_stream_cache_key(&self.config.torznab_api_url, params);
        let cached = self.db.get_resolved_stream_cache(cache_key.clone()).await?;
        let now = now_ms();
        if let Some((payload, _, next_validation_at)) = cached.as_ref()
            && *next_validation_at > now
        {
            return self.parse_and_hydrate_torznab_streams(payload).await;
        }

        let request_url = build_torznab_request_url(
            &self.config.torznab_api_url,
            &self.config.torznab_api_key,
            params,
        )?;
        let response = self
            .client
            .get(request_url)
            .timeout(Duration::from_millis(self.config.torznab_timeout_ms))
            .send()
            .await;
        match response {
            Ok(response) => {
                let status = response.status();
                if let Some(len) = response.content_length()
                    && len > MAX_DISCOVERY_RESPONSE_BYTES
                {
                    return Err(ApiError::bad_gateway(
                        "Torznab response exceeded the maximum allowed size.",
                    ));
                }
                let body = response
                    .text()
                    .await
                    .map_err(|_| ApiError::bad_gateway("Torznab response could not be read."))?;
                if !status.is_success() {
                    if let Some((payload, expires_at, _)) = cached
                        && expires_at > now_ms()
                    {
                        return self.parse_and_hydrate_torznab_streams(&payload).await;
                    }
                    return Err(ApiError::bad_gateway(format!(
                        "Torznab request failed ({status})."
                    )));
                }
                let payload = json!({ "xml": body });
                let (expires_at, next_validation_at) = compute_torznab_cache_deadlines();
                self.db
                    .set_resolved_stream_cache(
                        cache_key,
                        payload.clone(),
                        expires_at,
                        next_validation_at,
                    )
                    .await?;
                self.parse_and_hydrate_torznab_streams(&payload).await
            }
            Err(error) => {
                if let Some((payload, expires_at, _)) = cached
                    && expires_at > now_ms()
                {
                    return self.parse_and_hydrate_torznab_streams(&payload).await;
                }
                Err(map_reqwest_error(error, "Torznab request timed out."))
            }
        }
    }

    async fn parse_and_hydrate_torznab_streams(
        &self,
        payload: &Value,
    ) -> AppResult<Vec<DiscoveryStream>> {
        let streams = parse_torznab_streams_payload(payload)?;
        Ok(self.hydrate_torznab_download_links(streams).await)
    }

    async fn hydrate_torznab_download_links(
        &self,
        mut streams: Vec<DiscoveryStream>,
    ) -> Vec<DiscoveryStream> {
        let redirect_client = match reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_millis(self.config.torznab_timeout_ms))
            .build()
        {
            Ok(client) => client,
            Err(_) => return streams,
        };
        let mut unresolved = streams
            .iter()
            .enumerate()
            .filter(|(_, stream)| {
                discovery_stream_info_hash(stream).is_none()
                    && torznab_download_url_allowed(
                        &self.config.torznab_api_url,
                        &stream.downloadUrl,
                    )
            })
            .map(|(index, stream)| (index, parse_seed_count(&stream.title)))
            .collect::<Vec<_>>();
        unresolved.sort_by_key(|right| std::cmp::Reverse(right.1));
        unresolved.truncate(TORZNAB_DOWNLOAD_LINK_HYDRATE_LIMIT);

        let mut pending = FuturesUnordered::new();
        for (index, _) in unresolved {
            let download_url = streams[index].downloadUrl.clone();
            let client = redirect_client.clone();
            pending.push(async move {
                let magnet = self
                    .resolve_torznab_download_magnet(&client, &download_url)
                    .await;
                (index, magnet)
            });
        }
        while let Some((index, magnet_url)) = pending.next().await {
            if let Some(magnet_url) = magnet_url {
                streams[index].infoHash = extract_info_hash_from_magnet(&magnet_url);
                streams[index].magnetUrl = magnet_url;
            }
        }
        streams.retain(|stream| discovery_stream_info_hash(stream).is_some());
        streams
    }

    async fn resolve_torznab_download_magnet(
        &self,
        client: &reqwest::Client,
        download_url: &str,
    ) -> Option<String> {
        if !torznab_download_url_allowed(&self.config.torznab_api_url, download_url) {
            return None;
        }
        let cache_key = build_torznab_download_cache_key(download_url);
        if let Ok(Some((payload, _, next_validation_at))) =
            self.db.get_resolved_stream_cache(cache_key.clone()).await
            && next_validation_at > now_ms()
            && let Some(magnet_url) = payload.get("magnet").and_then(Value::as_str)
            && let Some(normalized) = normalize_magnet_url(magnet_url)
        {
            return Some(normalized);
        }

        let response = client.get(download_url).send().await.ok()?;
        if !response.status().is_redirection() {
            return None;
        }
        let magnet_url = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_magnet_url)?;
        let now = now_ms();
        let expires_at = now + TORZNAB_DOWNLOAD_MAGNET_CACHE_SECONDS * 1_000;
        let _ = self
            .db
            .set_resolved_stream_cache(
                cache_key,
                json!({ "magnet": magnet_url }),
                expires_at,
                expires_at,
            )
            .await;
        Some(magnet_url)
    }

    fn is_torznab_configured(&self) -> bool {
        !self.config.torznab_api_url.trim().is_empty()
    }

    #[allow(clippy::too_many_arguments)]
    async fn summarize_movie_sources_from_streams(
        &self,
        streams: &[DiscoveryStream],
        metadata: &ResolveMetadata,
        normalized_audio_lang: &str,
        normalized_quality: &str,
        normalized_source_hash: &str,
        limit: usize,
        source_filters: &SourceFilters,
        prefer_mp4_default: bool,
    ) -> AppResult<Vec<SourceSummary>> {
        let health_scores = self.compute_source_health_scores(streams).await?;
        let candidates = select_top_movie_candidates(
            streams,
            metadata,
            normalized_audio_lang,
            normalized_quality,
            normalized_source_hash,
            limit,
            source_filters,
            &health_scores,
            prefer_mp4_default,
        );
        Ok(candidates
            .iter()
            .filter_map(|candidate| {
                summarize_stream_candidate_for_client(
                    candidate,
                    metadata,
                    normalized_audio_lang,
                    normalized_quality,
                    source_filters,
                    &health_scores,
                )
            })
            .collect())
    }

    #[allow(clippy::too_many_arguments)]
    async fn summarize_episode_sources_from_streams(
        &self,
        streams: &[DiscoveryStream],
        metadata: &ResolveMetadata,
        normalized_audio_lang: &str,
        normalized_quality: &str,
        normalized_container: &str,
        normalized_source_hash: &str,
        limit: usize,
        source_filters: &SourceFilters,
        prefer_mp4_default: bool,
    ) -> AppResult<Vec<SourceSummary>> {
        let health_scores = self.compute_source_health_scores(streams).await?;
        let candidates = select_top_episode_candidates(
            streams,
            metadata,
            normalized_audio_lang,
            normalized_quality,
            normalized_container,
            normalized_source_hash,
            limit,
            source_filters,
            &health_scores,
            prefer_mp4_default,
        );
        Ok(candidates
            .iter()
            .filter_map(|candidate| {
                summarize_stream_candidate_for_client(
                    candidate,
                    metadata,
                    normalized_audio_lang,
                    normalized_quality,
                    source_filters,
                    &health_scores,
                )
            })
            .collect())
    }

    async fn compute_source_health_scores(
        &self,
        streams: &[DiscoveryStream],
    ) -> AppResult<HashMap<String, i64>> {
        let mut scores = HashMap::new();
        let mut seen = HashSet::new();
        for stream in streams {
            let info_hash = get_stream_info_hash(stream);
            if info_hash.is_empty() || !seen.insert(info_hash.clone()) {
                continue;
            }
            let Some(stats) = self.db.get_source_health_stats(info_hash.clone()).await? else {
                scores.insert(info_hash, 0);
                continue;
            };
            scores.insert(info_hash, compute_source_health_score(&stats));
        }
        Ok(scores)
    }

    async fn compute_external_embed_health_scores(
        &self,
        metadata: &ResolveMetadata,
    ) -> AppResult<HashMap<String, i64>> {
        let mut scores = HashMap::new();
        for source in external_embed_sources() {
            let source_hash = external_embed_source_hash(source, metadata);
            if source_hash.is_empty() {
                continue;
            }
            let mut score = 0;
            if let Some(stats) = self.db.get_source_health_stats(source_hash.clone()).await? {
                score += compute_external_embed_rank_health_score(&stats);
            }
            let provider_key = external_embed_provider_health_key(source);
            if let Some(stats) = self.db.get_source_health_stats(provider_key).await? {
                score += compute_external_embed_provider_rank_health_score(&stats);
            }
            scores.insert(source_hash, score);
        }
        Ok(scores)
    }
}

#[derive(Debug, Clone)]
pub(in crate::resolver) struct SourceFilters {
    pub(in crate::resolver) min_seeders: i64,
    pub(in crate::resolver) allowed_formats: Vec<String>,
    pub(in crate::resolver) source_language: String,
    pub(in crate::resolver) source_audio_profile: String,
}

fn local_torrent_resolved_source_to_resolved_source(
    source: LocalTorrentResolvedSource,
) -> ResolvedSource {
    ResolvedSource {
        playable_url: source.playable_url,
        fallback_urls: Vec::new(),
        filename: source.filename,
        source_hash: source.source_hash,
        selected_file: source.selected_file,
        selected_file_path: source.selected_file_path,
        real_debrid_cached: false,
    }
}

fn local_cache_upgrade_payload(resolved: LocalTorrentResolvedSource) -> Value {
    json!({
        "ready": true,
        "playableUrl": resolved.playable_url,
        "sourceInput": extract_playable_source_input(&resolved.playable_url),
        "filename": resolved.filename,
        "sourceHash": resolved.source_hash,
        "selectedFile": resolved.selected_file,
        "resolverProvider": ResolverProvider::LocalTorrent.as_str(),
        // Local playback starts before ffprobe/subtitle enrichment; upgrades
        // need the same deferred track pass as a fresh local resolve.
        "tracksPending": true,
    })
}

fn validate_resolved_movie_source(
    resolved: ResolvedSource,
    metadata: &ResolveMetadata,
) -> AppResult<ResolvedSource> {
    if !does_filename_likely_match_movie(
        &resolved.filename,
        &metadata.display_title,
        &metadata.display_year,
    ) {
        return Err(ApiError::internal(
            "Resolved stream filename did not match requested title.",
        ));
    }
    Ok(resolved)
}

fn validate_resolved_episode_source(
    resolved: ResolvedSource,
    metadata: &ResolveMetadata,
) -> AppResult<ResolvedSource> {
    let episode_match_name = if !resolved.selected_file_path.trim().is_empty() {
        resolved.selected_file_path.clone()
    } else {
        resolved.filename.clone()
    };
    if !does_filename_likely_match_tv_episode(
        &episode_match_name,
        &metadata.display_title,
        &metadata.display_year,
        metadata.season_number,
        metadata.episode_number,
    ) {
        return Err(ApiError::internal(
            "Resolved stream filename did not match requested episode.",
        ));
    }
    Ok(resolved)
}

#[allow(clippy::too_many_arguments)]
fn build_movie_resolve_lock_key(
    tmdb_id: &str,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    preferred_subtitle_lang: &str,
    source_hash: &str,
    session_key: &str,
    min_seeders: &str,
    allowed_formats: &str,
    source_language: &str,
    source_audio_profile: &str,
    resolver_provider: ResolverProvider,
    skip_external_embed: bool,
) -> String {
    format!(
        "movie|provider:{}|skipEmbed:{}|tmdb:{}|audio:{}|sub:{}|quality:{}|session:{}|hash:{}|{}",
        resolver_provider.as_str(),
        u8::from(skip_external_embed),
        tmdb_id.trim(),
        normalize_preferred_audio_lang(preferred_audio_lang),
        normalize_subtitle_preference(preferred_subtitle_lang),
        normalize_preferred_stream_quality(preferred_quality),
        session_key.trim(),
        normalize_source_hash(source_hash),
        build_source_filter_lock_key(
            min_seeders,
            allowed_formats,
            source_language,
            source_audio_profile,
        )
    )
}

#[allow(clippy::too_many_arguments)]
fn build_tv_resolve_lock_key(
    tmdb_id: &str,
    season_number: &str,
    season_alias: &str,
    episode_number: &str,
    episode_alias: &str,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    preferred_subtitle_lang: &str,
    preferred_container: &str,
    source_hash: &str,
    session_key: &str,
    min_seeders: &str,
    allowed_formats: &str,
    source_language: &str,
    source_audio_profile: &str,
    resolver_provider: ResolverProvider,
    skip_external_embed: bool,
) -> String {
    let season_number = normalize_episode_ordinal(
        if season_number.trim().is_empty() {
            season_alias
        } else {
            season_number
        },
        1,
    );
    let episode_number = normalize_episode_ordinal(
        if episode_number.trim().is_empty() {
            episode_alias
        } else {
            episode_number
        },
        1,
    );
    format!(
        "tv|provider:{}|skipEmbed:{}|tmdb:{}|s:{}|e:{}|audio:{}|sub:{}|quality:{}|container:{}|session:{}|hash:{}|{}",
        resolver_provider.as_str(),
        u8::from(skip_external_embed),
        tmdb_id.trim(),
        season_number,
        episode_number,
        normalize_preferred_audio_lang(preferred_audio_lang),
        normalize_subtitle_preference(preferred_subtitle_lang),
        normalize_preferred_stream_quality(preferred_quality),
        normalize_tv_preferred_container(preferred_container),
        session_key.trim(),
        normalize_source_hash(source_hash),
        build_source_filter_lock_key(
            min_seeders,
            allowed_formats,
            source_language,
            source_audio_profile,
        )
    )
}

fn build_source_filter_lock_key(
    min_seeders: &str,
    allowed_formats: &str,
    source_language: &str,
    source_audio_profile: &str,
) -> String {
    format!(
        "min:{}|formats:{}|lang:{}|profile:{}",
        normalize_minimum_seeders(min_seeders),
        normalize_allowed_formats(allowed_formats).join(","),
        normalize_source_language_filter(source_language),
        normalize_source_audio_profile_filter(source_audio_profile)
    )
}

impl ResolverActiveGuard {
    fn new(metrics: Arc<ResolverMetrics>) -> Self {
        metrics.active_resolves.fetch_add(1, Ordering::Relaxed);
        Self { metrics }
    }
}

impl Drop for ResolverActiveGuard {
    fn drop(&mut self) {
        self.metrics.active_resolves.fetch_sub(1, Ordering::Relaxed);
    }
}

impl ResolverExternalGuard {
    fn new(metrics: Arc<ResolverMetrics>, permit: OwnedSemaphorePermit) -> Self {
        metrics.external_started.fetch_add(1, Ordering::Relaxed);
        metrics.external_active.fetch_add(1, Ordering::Relaxed);
        Self {
            metrics,
            _permit: permit,
            finished: false,
        }
    }

    fn mark_completed(&mut self) {
        if !self.finished {
            self.metrics
                .external_completed
                .fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }
}

impl Drop for ResolverExternalGuard {
    fn drop(&mut self) {
        self.metrics.external_active.fetch_sub(1, Ordering::Relaxed);
        if !self.finished {
            self.metrics.external_failed.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn normalize_source_hash(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.len() == 40 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        normalized
    } else {
        String::new()
    }
}

fn normalize_resolve_media_type(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("tv") {
        "tv".to_owned()
    } else {
        "movie".to_owned()
    }
}

pub(crate) fn normalize_resolver_provider(value: &str) -> ResolverProvider {
    match value.trim().to_lowercase().as_str() {
        "real-debrid" | "real_debrid" | "realdebrid" | "debrid" | "rd" => {
            ResolverProvider::RealDebrid
        }
        "local-torrent" | "local_torrent" | "local" | "torrent" => ResolverProvider::LocalTorrent,
        "" | "default" | "fastest" | "race" | "auto" | "automatic" => ResolverProvider::Fastest,
        _ => ResolverProvider::Fastest,
    }
}

fn get_stream_info_hash(stream: &DiscoveryStream) -> String {
    normalize_source_hash(&stream.infoHash)
}

fn stream_list_contains_hash(streams: &[DiscoveryStream], source_hash: &str) -> bool {
    let normalized_hash = normalize_source_hash(source_hash);
    !normalized_hash.is_empty()
        && streams
            .iter()
            .any(|stream| get_stream_info_hash(stream) == normalized_hash)
}

/// Cache validated upstream HLS URLs to skip discovery on repeat plays. Title,
/// episode, and selected source isolate entries; automatic selection has its own
/// entry so manual-only servers cannot leak into automatic playback. Preferences
/// and signed proxy URLs are rebuilt for each caller. `refreshResolve` clears all
/// entries for the title/episode; `RESOLVED_EMBED_CACHE_TTL_MS=0` disables reuse.
const RESOLVED_EMBED_CACHE_MAX_ENTRIES: usize = 512;

fn resolved_embed_cache_ttl_ms() -> i64 {
    std::env::var("RESOLVED_EMBED_CACHE_TTL_MS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(25 * 60 * 1000)
        .max(0)
}

fn external_embed_resolve_cache_key(metadata: &ResolveMetadata, source_hash: &str) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        metadata.media_type,
        metadata.tmdb_id.trim(),
        metadata.season_number,
        metadata.episode_number,
        source_hash
    )
}

#[derive(Clone)]
struct CachedResolvedEmbed {
    source: ExternalEmbedSource,
    playback_url: String,
    referer: Option<String>,
    embed_url: String,
    cached_at_ms: i64,
}

#[derive(Clone, Default)]
pub struct ResolvedEmbedCache {
    entries: Arc<DashMap<String, CachedResolvedEmbed>>,
}

impl ResolvedEmbedCache {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(DashMap::new()),
        }
    }

    fn get_fresh(&self, key: &str) -> Option<CachedResolvedEmbed> {
        let ttl = resolved_embed_cache_ttl_ms();
        if ttl == 0 {
            return None;
        }
        let entry = self.entries.get(key)?;
        if now_ms() - entry.cached_at_ms > ttl {
            return None;
        }
        Some(entry.clone())
    }

    fn store(&self, key: String, value: CachedResolvedEmbed) {
        if resolved_embed_cache_ttl_ms() == 0 {
            return;
        }
        self.entries.insert(key, value);
        if self.entries.len() > RESOLVED_EMBED_CACHE_MAX_ENTRIES {
            let now = now_ms();
            let ttl = resolved_embed_cache_ttl_ms();
            self.entries
                .retain(|_, value| now - value.cached_at_ms <= ttl);
            if self.entries.len() > RESOLVED_EMBED_CACHE_MAX_ENTRIES {
                self.entries.clear();
            }
        }
    }

    fn evict_title(&self, title_prefix: &str) {
        self.entries.retain(|key, _| !key.starts_with(title_prefix));
    }

    pub fn prune(&self) {
        let now = now_ms();
        let ttl = resolved_embed_cache_ttl_ms();
        self.entries
            .retain(|_, value| now - value.cached_at_ms <= ttl);
    }
}

/// Build the resolved-payload JSON from a (freshly-resolved or cached) winning
/// candidate. Re-signs the proxied URL and applies the caller's current preferences,
/// so a cache hit produces an identical-shaped payload to a fresh resolve.
#[allow(clippy::too_many_arguments)]
fn finalize_external_embed_payload(
    metadata: &ResolveMetadata,
    source: ExternalEmbedSource,
    preferences: &ResolvePreferences,
    upstream_playback_url: &str,
    referer: Option<&str>,
    embed_url: String,
    live_hls_proxy_secret: &str,
    live_hls_worker_base: &str,
) -> Value {
    let proxied_url = crate::live::build_trusted_external_embed_hls_playback_source(
        upstream_playback_url,
        referer,
        live_hls_proxy_secret,
    );
    // For providers whose CDN serves the browser cross-origin (LordFlix:
    // tcloud.lordflix.club playlists + *.tiktokcdn.com segments, both CORS-open with
    // no Referer wall), hand the browser a direct-segment playlist (`&directSeg=1`)
    // so the heavy `.ts` bytes stream straight from the source CDN — off the mini's
    // home uplink — and keep the fully-proxied URL as a fallback the player switches
    // to if a direct fetch fails.
    //
    // Playlist URLs are routed via the Cloudflare Worker when configured, for the
    // same reason live/sports playlists are (2026-06-12 Interstellar incident): the
    // zone's always-on L7 DDoS ruleset intermittently swallows bursty `/api/live/*`
    // requests at the edge — the origin never sees them — and the player burns its
    // 20s-per-source fail-fast budget before recovering. workers.dev is outside the
    // zone, so the Worker hop dodges that layer entirely. The zone-routed URL stays
    // last in the queue as a worker-outage fallback.
    let route_via_worker =
        |url: String| crate::live::route_live_playback_source_via_worker(live_hls_worker_base, url);
    let mut candidates = if is_external_embed_direct_segment_provider(source) {
        let direct_url = format!("{proxied_url}&directSeg=1");
        vec![
            route_via_worker(direct_url.clone()),
            route_via_worker(proxied_url.clone()),
            direct_url,
            proxied_url,
        ]
    } else {
        vec![route_via_worker(proxied_url.clone()), proxied_url]
    };
    // With no worker base configured the routed and zone URLs are identical;
    // dedupe so the player's source queue keeps its pre-worker shape.
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|url| seen.insert(url.clone()));
    let playable_url = candidates.remove(0);
    let fallback_urls = candidates;
    build_external_embed_resolved_payload_with_playable_url(
        metadata,
        source,
        preferences,
        playable_url,
        fallback_urls,
        embed_url,
    )
}

async fn build_external_embed_resolved_playback_payload(
    request: ExternalEmbedPlaybackRequest<'_>,
) -> Option<Value> {
    // Another request may have populated the cache while this one waited for a permit.
    if request.record_health_events
        && let Some(hit) = request.resolve_cache.get_fresh(request.cache_key)
    {
        return Some(finalize_external_embed_payload(
            request.metadata,
            hit.source,
            request.preferences,
            &hit.playback_url,
            hit.referer.as_deref(),
            hit.embed_url,
            request.live_hls_proxy_secret,
            request.live_hls_worker_base,
        ));
    }

    let _ = external_embed_playback_url(request.source, request.metadata, request.preferences)?;
    let candidates = external_embed_hls_candidate_sources(
        request.source,
        request.metadata,
        request.allow_native_fallback,
        request.health_scores,
    );
    let hls_deadline_ms = now_ms() + external_embed_hls_total_timeout_ms() as i64;

    // Resolve candidates with an adaptive staggered hedge instead of a strict
    // sequential walk: the top-ranked candidate runs first; the next is raced in
    // parallel the moment the current one either fails or stalls past the stagger.
    // First success wins and the rest are dropped (their in-flight node/curl
    // subprocesses are killed on drop). When health recording is enabled, each
    // attempt records its own failure internally; the winner's success is recorded
    // here so a losing-but-successful racer can never double-count. Admin benchmark
    // requests use the identical path with both writes suppressed.
    let attempts = candidates
        .into_iter()
        .map(|candidate| {
            resolve_external_embed_candidate_attempt(&request, candidate, hls_deadline_ms)
        })
        .collect::<Vec<_>>();
    let (_index, (candidate, hls_source, embed_url)) = race_staggered_first_success(
        attempts,
        Duration::from_millis(EXTERNAL_EMBED_HEDGE_STAGGER_MS),
    )
    .await?;

    record_external_embed_health_event_if_enabled(
        request.record_health_events,
        record_external_embed_health_event(request.db, candidate, request.metadata, "success", ""),
    )
    .await;
    if request.record_health_events {
        request.resolve_cache.store(
            request.cache_key.to_owned(),
            CachedResolvedEmbed {
                source: candidate,
                playback_url: hls_source.playback_url.to_string(),
                referer: hls_source.referer.clone(),
                embed_url: embed_url.clone(),
                cached_at_ms: now_ms(),
            },
        );
    }
    Some(finalize_external_embed_payload(
        request.metadata,
        candidate,
        request.preferences,
        hls_source.playback_url.as_str(),
        hls_source.referer.as_deref(),
        embed_url,
        request.live_hls_proxy_secret,
        request.live_hls_worker_base,
    ))
}

/// One candidate's HLS resolve attempt. Returns the resolved source on success;
/// returns `None` after recording a `playback_error` health event on failure or
/// timeout, or immediately if the shared deadline is already spent. Kept side-effect
/// free except for the failure-event record so the hedge driver can decide the
/// winner and record success exactly once.
async fn resolve_external_embed_candidate_attempt<'a>(
    request: &ExternalEmbedPlaybackRequest<'a>,
    candidate: ExternalEmbedSource,
    hls_deadline_ms: i64,
) -> Option<(ExternalEmbedSource, ExternalEmbedHlsPlaybackSource, String)> {
    let remaining_ms = hls_deadline_ms - now_ms();
    if remaining_ms < 1_000 {
        return None;
    }
    // The outer semaphore caps all fresh resolver work; this provider-scoped
    // permit prevents one unhealthy upstream from monopolising that capacity.
    // Owned permits are cancellation-safe: dropping a losing hedged future
    // releases the provider slot immediately.
    let _provider_permit = request
        .provider_budgets
        .acquire(
            candidate.provider.id,
            Duration::from_millis(remaining_ms as u64),
        )
        .await?;
    let remaining_ms = hls_deadline_ms - now_ms();
    if remaining_ms < 1_000 {
        return None;
    }
    let embed_url = external_embed_playback_url(candidate, request.metadata, request.preferences)?;
    let hls_timeout_ms = external_embed_source_resolve_timeout_ms(candidate)
        .min(remaining_ms as u64)
        .max(1_000);
    let hls_result = timeout(
        Duration::from_millis(remaining_ms as u64),
        resolve_external_embed_hls_playback_source(
            request.client,
            candidate,
            &embed_url,
            request.metadata,
            hls_timeout_ms,
        ),
    )
    .await
    .ok()
    .flatten();
    match hls_result {
        Some(hls_source) => Some((candidate, hls_source, embed_url)),
        None => {
            record_external_embed_health_event_if_enabled(
                request.record_health_events,
                record_external_embed_health_event(
                    request.db,
                    candidate,
                    request.metadata,
                    "playback_error",
                    "Native HLS resolver failed.",
                ),
            )
            .await;
            None
        }
    }
}

async fn record_external_embed_health_event_if_enabled<F>(enabled: bool, event: F)
where
    F: std::future::Future<Output = ()>,
{
    if enabled {
        event.await;
    }
}

/// Drive a set of lazily-constructed attempt futures with an adaptive staggered
/// hedge and return the first success (with its index). The first future starts
/// immediately; each subsequent future is launched as soon as the previous attempt
/// resolves to `None` (fast failure) OR the `stagger` elapses with attempts still in
/// flight (slow/hung). Returns `None` only when every attempt yields `None`. Futures
/// are not started until pushed, so the common case (the first attempt succeeds
/// before the stagger) never runs a redundant attempt.
async fn race_staggered_first_success<Fut, T>(
    futures: Vec<Fut>,
    stagger: Duration,
) -> Option<(usize, T)>
where
    Fut: Future<Output = Option<T>>,
{
    let mut remaining = futures.into_iter().enumerate();
    let mut in_flight = FuturesUnordered::new();
    match remaining.next() {
        Some((index, fut)) => in_flight.push(tag_future_index(index, fut)),
        None => return None,
    }
    loop {
        if in_flight.is_empty() {
            match remaining.next() {
                Some((index, fut)) => in_flight.push(tag_future_index(index, fut)),
                None => return None,
            }
        }
        let stagger_timer = sleep(stagger);
        tokio::select! {
            biased;
            completed = in_flight.next(), if !in_flight.is_empty() => {
                match completed {
                    Some((index, Some(value))) => return Some((index, value)),
                    // Fast failure: launch the next candidate immediately.
                    Some((_index, None)) => {
                        if let Some((index, fut)) = remaining.next() {
                            in_flight.push(tag_future_index(index, fut));
                        }
                    }
                    None => {}
                }
            }
            // Current attempt(s) still pending past the stagger: hedge with the next.
            _ = stagger_timer => {
                if let Some((index, fut)) = remaining.next() {
                    in_flight.push(tag_future_index(index, fut));
                }
            }
        }
    }
}

async fn tag_future_index<Fut, T>(index: usize, fut: Fut) -> (usize, Option<T>)
where
    Fut: Future<Output = Option<T>>,
{
    (index, fut.await)
}

type BoxResolverAttempt<'a> = Pin<Box<dyn Future<Output = AppResult<Value>> + Send + 'a>>;

/// Provider-level hedge used by `fastest`: give Real-Debrid a short exclusive
/// window for a CDN/cache hit, then start the Mini's local torrent path. A fast
/// error starts the fallback immediately. Returning drops any still-running
/// local future (which activates its cleanup guards). If local wins after RD
/// has added a magnet, dropping RD's request future activates its asynchronous
/// cancellation guard, deleting the new cloud torrent and its local id cache.
async fn race_staggered_resolver_attempts(
    futures: Vec<BoxResolverAttempt<'_>>,
    stagger: Duration,
) -> Result<(usize, Value), Vec<(usize, ApiError)>> {
    let mut remaining = futures.into_iter().enumerate();
    let mut in_flight = FuturesUnordered::new();
    let mut errors = Vec::new();
    match remaining.next() {
        Some((index, future)) => in_flight.push(tag_resolver_attempt(index, future)),
        None => return Err(errors),
    }
    loop {
        if in_flight.is_empty() {
            match remaining.next() {
                Some((index, future)) => in_flight.push(tag_resolver_attempt(index, future)),
                None => return Err(errors),
            }
        }
        let stagger_timer = sleep(stagger);
        tokio::select! {
            biased;
            completed = in_flight.next(), if !in_flight.is_empty() => {
                match completed {
                    Some((index, Ok(value))) => return Ok((index, value)),
                    Some((index, Err(error))) => {
                        errors.push((index, error));
                        if let Some((next_index, future)) = remaining.next() {
                            in_flight.push(tag_resolver_attempt(next_index, future));
                        }
                    }
                    None => {}
                }
            }
            _ = stagger_timer => {
                if let Some((index, future)) = remaining.next() {
                    in_flight.push(tag_resolver_attempt(index, future));
                }
            }
        }
    }
}

async fn tag_resolver_attempt(
    index: usize,
    future: BoxResolverAttempt<'_>,
) -> (usize, AppResult<Value>) {
    (index, future.await)
}

fn choose_auto_provider_error(mut errors: Vec<(usize, ApiError)>) -> ApiError {
    let local_error = errors
        .iter()
        .position(|(index, _)| *index == 1)
        .map(|position| errors.swap_remove(position).1);
    let real_debrid_error = errors
        .into_iter()
        .find_map(|(index, error)| (index == 0).then_some(error));
    match (real_debrid_error, local_error) {
        (Some(real_debrid), Some(local)) if !is_persistent_source_resolve_error(&local) => {
            real_debrid
        }
        (_, Some(local)) => local,
        (Some(real_debrid), None) => real_debrid,
        (None, None) => ApiError::bad_gateway("All resolver providers failed."),
    }
}

fn external_embed_hls_candidate_sources(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    allow_native_fallback: bool,
    health_scores: &HashMap<String, i64>,
) -> Vec<ExternalEmbedSource> {
    let mut candidates = Vec::new();
    if allow_native_fallback {
        for candidate in preferred_external_embed_hls_sources(metadata, health_scores) {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    } else if is_external_embed_hls_capable_source(source) {
        candidates.push(source);
    }
    candidates
}

fn external_embed_source_resolve_timeout_ms(source: ExternalEmbedSource) -> u64 {
    match source.provider.id {
        // These providers need multiple sequential round-trips or a retry loop
        // (videasy/vidlink browser resolve; icefy retries past its upstream's
        // intermittent 429s; vixsrc does api -> embed page -> playlist), so they
        // get the full budget instead of the tight direct-resolve clamp that was
        // cutting their retries off mid-flight. They are ranked last, so the
        // wider budget only spends leftover time, never starves a better source.
        // meridian/gallic make two sequential round-trips (aether resolve -> unwrap
        // origin -> validate the upstream playlist), so they get the full budget too.
        "videasy" | "vidlink" | "icefy" | "vixsrc" | "meridian" | "gallic" | "cinejoy" => {
            external_embed_hls_resolve_timeout_ms()
        }
        _ => external_embed_hls_resolve_timeout_ms().min(EXTERNAL_EMBED_DIRECT_RESOLVE_TIMEOUT_MS),
    }
}

fn external_embed_provider_health_key(source: ExternalEmbedSource) -> String {
    format!(
        "{}{}:{}",
        EXTERNAL_EMBED_PROVIDER_HEALTH_KEY_PREFIX,
        source.provider.id,
        source.server.map(|server| server.id).unwrap_or("default")
    )
}

async fn record_external_embed_health_event(
    db: &Db,
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    event_type: &str,
    last_error: &str,
) {
    let source_hash = external_embed_source_hash(source, metadata);
    if !source_hash.is_empty() {
        let _ = db
            .record_source_health_event(source_hash, event_type.to_owned(), last_error.to_owned())
            .await;
    }
    let _ = db
        .record_source_health_event(
            external_embed_provider_health_key(source),
            event_type.to_owned(),
            last_error.to_owned(),
        )
        .await;
}

fn is_external_embed_direct_segment_provider(source: ExternalEmbedSource) -> bool {
    // Providers whose segment/playlist CDNs serve the browser cross-origin
    // (CORS `*`, no Referer wall) — verified by probe — so the player COULD fetch
    // them directly off the source CDN, bypassing the mini's uplink. The mini-side
    // plumbing (`directSeg` + `is_cors_direct_hls_host`) is wired and unit-tested.
    //
    // VERIFIED LIVE 2026-06-12 (Chrome): LordFlix plays direct with segments
    // fetched straight from p16-sg.tiktokcdn.com (off the mini uplink); the
    // player's PNG-prefix-stripping hls.js loader (hls-controller.js) handles the
    // PNG-disguised TS, and the fully-proxied fallback covers a direct fetch that
    // fails. Default ON; `EXTERNAL_EMBED_DIRECT_SEGMENTS=0` is a kill switch.
    if std::env::var("EXTERNAL_EMBED_DIRECT_SEGMENTS")
        .map(|value| value.trim() == "0")
        .unwrap_or(false)
    {
        return false;
    }
    matches!(source.provider.id, "lordflix")
}

fn build_external_embed_resolved_payload_with_playable_url(
    metadata: &ResolveMetadata,
    source: ExternalEmbedSource,
    preferences: &ResolvePreferences,
    playable_url: String,
    fallback_urls: Vec<String>,
    source_input: String,
) -> Value {
    let source_hash = external_embed_source_hash(source, metadata);
    let filename = external_embed_source_filename(source);
    let resolved = ResolvedSource {
        playable_url: playable_url.clone(),
        fallback_urls: fallback_urls.clone(),
        filename: filename.clone(),
        source_hash: source_hash.clone(),
        selected_file: String::new(),
        selected_file_path: String::new(),
        real_debrid_cached: false,
    };
    let mut response_metadata = build_resolved_metadata_payload(metadata, &resolved, &filename);
    response_metadata["resolverProvider"] = json!(EXTERNAL_EMBED_RESOLVER_PROVIDER);
    json!({
        "playableUrl": playable_url,
        "fallbackUrls": fallback_urls,
        "filename": filename,
        "sourceHash": source_hash,
        "selectedFile": "",
        "selectedFilePath": "",
        "resolverProvider": EXTERNAL_EMBED_RESOLVER_PROVIDER,
        "sourceInput": source_input,
        "tracks": MediaProbe {
            durationSeconds: metadata.runtime_seconds,
            ..MediaProbe::default()
        },
        "selectedAudioStreamIndex": -1,
        "selectedSubtitleStreamIndex": -1,
        "preferences": {
            "audioLang": preferences.audio_lang.clone(),
            "subtitleLang": preferences.subtitle_lang.clone(),
            "quality": preferences.quality.clone()
        },
        "metadata": response_metadata
    })
}

async fn resolve_external_embed_hls_playback_source(
    client: &reqwest::Client,
    source: ExternalEmbedSource,
    embed_url: &str,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    match source.provider.id {
        "icefy" => return resolve_icefy_hls_playback_source(client, embed_url, timeout_ms).await,
        "vixsrc" => return resolve_vixsrc_hls_playback_source(client, embed_url, timeout_ms).await,
        "vidrock" => {
            return resolve_vidrock_hls_playback_source(client, metadata, timeout_ms).await;
        }
        "lordflix" => {
            return resolve_lordflix_hls_playback_source(client, metadata, timeout_ms).await;
        }
        "notorrent" => {
            return resolve_stremio_addon_hls_playback_source(
                client,
                NOTORRENT_API_BASE,
                metadata,
                timeout_ms,
            )
            .await;
        }
        "nebula" => {
            return match nebula_addon_base() {
                Some(base) => {
                    resolve_stremio_addon_hls_playback_source(client, base, metadata, timeout_ms)
                        .await
                }
                None => None,
            };
        }
        "meridian" | "gallic" => {
            return resolve_aether_proxy_hls_playback_source(client, embed_url, timeout_ms).await;
        }
        id if crate::provider_registry::is_custom(id) => {
            return match crate::provider_registry::custom_base(id) {
                Some(base) => {
                    resolve_stremio_addon_hls_playback_source(client, &base, metadata, timeout_ms)
                        .await
                }
                None => None,
            };
        }
        _ => {}
    }

    let embed_url = Url::parse(embed_url.trim()).ok()?;
    if !is_supported_external_embed_hls_embed_url(&embed_url) {
        return None;
    }

    let script_path = external_embed_hls_resolver_script_path();
    if matches!(
        script_path.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "disabled"
    ) {
        return None;
    }

    let resolve_timeout_ms = timeout_ms.clamp(1_000, 120_000);
    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(embed_url.as_str())
        .env(
            EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS_ENV,
            resolve_timeout_ms.to_string(),
        )
        .env(
            EXTERNAL_EMBED_SERVER_ENV,
            source.server.map(|server| server.id).unwrap_or_default(),
        )
        .kill_on_drop(true);

    // One deadline covers browser startup, discovery, and backend validation.
    timeout(
        Duration::from_millis(resolve_timeout_ms.saturating_add(1_000)),
        async {
            let output = command.output().await.ok()?;
            if !output.status.success() {
                return None;
            }

            let resolver_output =
                serde_json::from_slice::<ExternalEmbedHlsResolverOutput>(&output.stdout).ok()?;
            let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
            if source.provider.id == "cinejoy" {
                return cinejoy::validate(
                    client,
                    &playback_url,
                    source.server.map(|server| server.id).unwrap_or("LISBON"),
                    resolve_timeout_ms,
                )
                .await;
            }
            if !is_supported_external_embed_hls_url(&playback_url) {
                return None;
            }
            let referer = normalize_external_embed_hls_referer(&resolver_output.referer)
                .or_else(|| normalize_external_embed_hls_referer(embed_url.as_str()));
            Some(ExternalEmbedHlsPlaybackSource {
                playback_url,
                referer,
            })
        },
    )
    .await
    .ok()?
}

async fn resolve_icefy_hls_playback_source(
    client: &reqwest::Client,
    api_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let referer = "https://streams.icefy.top/";
    for attempt in 0..ICEFY_HLS_RETRY_ATTEMPTS {
        if attempt > 0 {
            sleep(Duration::from_millis(
                ICEFY_HLS_RETRY_DELAY_MS.saturating_mul(attempt as u64),
            ))
            .await;
        }
        let Some(response) =
            fetch_external_json::<IcefyStreamResponse>(client, api_url, Some(referer), timeout_ms)
                .await
        else {
            continue;
        };
        if let Some(source) = validate_external_embed_hls_playlist(
            client,
            &response.stream,
            Some(referer),
            timeout_ms,
        )
        .await
        {
            return Some(source);
        }
    }
    None
}

async fn resolve_vixsrc_hls_playback_source(
    client: &reqwest::Client,
    api_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    for attempt in 0..VIXSRC_HLS_RETRY_ATTEMPTS {
        if attempt > 0 {
            sleep(Duration::from_millis(
                VIXSRC_HLS_RETRY_DELAY_MS.saturating_mul(attempt as u64),
            ))
            .await;
        }
        if let Some(source) =
            resolve_vixsrc_hls_playback_source_once(client, api_url, timeout_ms).await
        {
            return Some(source);
        }
    }
    None
}

async fn resolve_vixsrc_hls_playback_source_once(
    client: &reqwest::Client,
    api_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let response = fetch_external_json::<VixSrcApiResponse>(
        client,
        api_url,
        Some("https://vixsrc.to/"),
        timeout_ms,
    )
    .await?;
    let base_url = Url::parse("https://vixsrc.to").ok()?;
    let embed_url = base_url.join(response.src.trim()).ok()?;
    let html = fetch_external_text(
        client,
        embed_url.as_str(),
        Some("https://vixsrc.to/"),
        timeout_ms,
    )
    .await?;
    let token = VIXSRC_TOKEN_RE
        .captures(&html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_owned())?;
    let expires = VIXSRC_EXPIRES_RE
        .captures(&html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_owned())?;
    let expires_seconds = expires.parse::<i64>().ok()?;
    if expires_seconds <= (now_ms() / 1000) + 60 {
        return None;
    }
    let playlist = VIXSRC_PLAYLIST_RE
        .captures(&html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_owned())?;
    let mut playlist_url = Url::parse(&playlist)
        .or_else(|_| embed_url.join(&playlist))
        .ok()?;
    {
        let mut query = playlist_url.query_pairs_mut();
        query.append_pair("token", &token);
        query.append_pair("expires", &expires);
        query.append_pair("h", "1");
    }
    validate_external_embed_hls_playlist(
        client,
        playlist_url.as_str(),
        Some(embed_url.as_str()),
        timeout_ms,
    )
    .await
}

/// Resolve a Meridian/Gallic title through aether's open endpoint, then unwrap the
/// real upstream so playback rides our own `/api/live` proxy rather than aether's edge.
///
/// aether returns the stream double-wrapped: a JSON body containing
/// `https://<edge>/m3u8-proxy?url=<percent-encoded upstream playlist>&headers=<percent-
/// encoded {"Origin":..,"Referer":..}>`. We pull the upstream URL + its Referer back
/// out and validate it directly — the upstream answers our rustls client with that
/// Referer (verified for cdn.neuronix.sbs and senpai-stream.club) — so aether only
/// ever serves the cheap, cacheable lookup, never the segments.
async fn resolve_aether_proxy_hls_playback_source(
    client: &reqwest::Client,
    embed_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let body =
        fetch_external_text(client, embed_url, Some(AETHER_EMBED_REFERER), timeout_ms).await?;
    let (upstream_url, referer) = extract_aether_proxied_origin(&body)?;
    validate_external_embed_hls_playlist(client, &upstream_url, referer.as_deref(), timeout_ms)
        .await
}

/// Pull the real upstream URL (and its Referer) out of aether's
/// `m3u8-proxy?url=..&headers=..` wrapper. The upstream URL is percent-encoded, so
/// its own `?`/`&` never collide with the wrapper's `&headers=` separator. Returns
/// `None` when the body isn't a recognizable wrapper (missing title, CF challenge).
fn extract_aether_proxied_origin(body: &str) -> Option<(String, Option<String>)> {
    let marker_at = body.find(AETHER_PROXY_URL_MARKER)?;
    let after = &body[marker_at + AETHER_PROXY_URL_MARKER.len()..];
    // The wrapper lives inside a JSON string, so it ends at the first quote/backslash.
    let wrapper: String = after
        .chars()
        .take_while(|&c| c != '"' && c != '\\')
        .collect();
    let mut parts = wrapper.splitn(2, "&headers=");
    let upstream_url = percent_decode_lossy(parts.next()?);
    if !upstream_url.starts_with("https://") {
        return None;
    }
    let referer = parts
        .next()
        .map(percent_decode_lossy)
        .and_then(|headers| serde_json::from_str::<HashMap<String, String>>(&headers).ok())
        .and_then(|headers| {
            headers
                .get("Referer")
                .or_else(|| headers.get("Origin"))
                .cloned()
        });
    Some((upstream_url, referer))
}

async fn resolve_vidrock_hls_playback_source(
    client: &reqwest::Client,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let item_id = if metadata.media_type == "tv" {
        format!(
            "{}_{}_{}",
            metadata.tmdb_id, metadata.season_number, metadata.episode_number
        )
    } else {
        metadata.tmdb_id.clone()
    };
    let encrypted_id = encrypt_vidrock_item_id(&item_id)?;
    let api_url = format!(
        "https://vidrock.net/api/{}/{}",
        metadata.media_type, encrypted_id
    );
    let streams = fetch_external_json::<HashMap<String, VidRockStreamInfo>>(
        client,
        &api_url,
        Some("https://vidrock.net/"),
        timeout_ms,
    )
    .await?;

    for stream in streams.values() {
        let Some(stream_url) = stream
            .url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if stream_url.contains("hls2.vdrk.site") {
            if let Some(source) =
                resolve_vidrock_nested_hls_source(client, stream_url, timeout_ms).await
            {
                return Some(source);
            }
            continue;
        }
        if let Some(source) = validate_external_embed_hls_playlist(
            client,
            stream_url,
            Some("https://vidrock.net/"),
            timeout_ms,
        )
        .await
        {
            return Some(source);
        }
    }
    None
}

async fn resolve_vidrock_nested_hls_source(
    client: &reqwest::Client,
    source_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let sources = fetch_external_json::<Vec<VidRockCdnSource>>(
        client,
        source_url,
        Some("https://vidrock.net/"),
        timeout_ms,
    )
    .await?;
    for source in sources {
        let mut url = source.url.trim().to_owned();
        if let Some(encoded_path) = url.strip_prefix(VIDROCK_PROXY_PREFIX) {
            url = percent_decode_lossy(encoded_path.trim_start_matches('/'));
        }
        if let Some(source) = validate_external_embed_hls_playlist(
            client,
            &url,
            Some("https://lok-lok.cc/"),
            timeout_ms,
        )
        .await
        {
            return Some(source);
        }
    }
    None
}

fn lordflix_encode_quote(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
}

fn lordflix_source_url(metadata: &ResolveMetadata) -> Option<String> {
    let imdb_id = metadata.imdb_id.trim();
    let title = metadata.display_title.trim();
    if imdb_id.is_empty() || title.is_empty() {
        return None;
    }
    let type_param = if metadata.media_type == "tv" {
        "series"
    } else {
        "movie"
    };
    let mut url = format!(
        "{LORDFLIX_API_BASE}/?title={}&type={}&year={}&imdb={}&tmdb={}&server=Berlin",
        lordflix_encode_quote(title),
        type_param,
        metadata.display_year.trim(),
        imdb_id,
        metadata.tmdb_id.trim(),
    );
    if metadata.media_type == "tv" {
        url.push_str(&format!(
            "&season={}&episode={}",
            metadata.season_number, metadata.episode_number
        ));
    }
    Some(url)
}

fn build_lordflix_server_url(metadata: &ResolveMetadata, server: &str) -> Option<String> {
    let imdb_id = metadata.imdb_id.trim();
    let title = metadata.display_title.trim();
    if imdb_id.is_empty() || title.is_empty() {
        return None;
    }
    let type_param = if metadata.media_type == "tv" {
        "series"
    } else {
        "movie"
    };
    let mut url = format!(
        "{LORDFLIX_API_BASE}/?title={}&type={}&year={}&imdb={}&tmdb={}&server={server}",
        lordflix_encode_quote(title),
        type_param,
        metadata.display_year.trim(),
        imdb_id,
        metadata.tmdb_id.trim(),
    );
    if metadata.media_type == "tv" {
        url.push_str(&format!(
            "&season={}&episode={}",
            metadata.season_number, metadata.episode_number
        ));
    }
    Some(url)
}

async fn resolve_lordflix_hls_playback_source(
    client: &reqwest::Client,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    for server in LORDFLIX_SERVERS {
        let Some(server_url) = build_lordflix_server_url(metadata, server) else {
            continue;
        };
        if let Some(source) =
            resolve_lordflix_server_hls_playback_source(client, &server_url, timeout_ms).await
        {
            return Some(source);
        }
    }
    None
}

async fn resolve_lordflix_server_hls_playback_source(
    client: &reqwest::Client,
    server_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let enc_url = format!(
        "{LORDFLIX_ENC_DEC_API}/enc-lordflix?url={}",
        lordflix_encode_quote(server_url)
    );
    let enc_response =
        fetch_external_json::<LordflixEncDecResponse>(client, &enc_url, None, timeout_ms).await?;
    if enc_response.status != 200 {
        return None;
    }
    let enc_result = enc_response.result?;
    let proxy_url = enc_result.url.trim();
    let signature = enc_result.sign.trim();
    if proxy_url.is_empty() || signature.is_empty() {
        return None;
    }

    let encrypted_payload =
        fetch_external_text(client, proxy_url, Some(LORDFLIX_REFERER), timeout_ms).await?;
    if encrypted_payload.trim().is_empty() {
        return None;
    }

    let dec_url = format!("{LORDFLIX_ENC_DEC_API}/dec-lordflix");
    let dec_response = post_external_json::<LordflixEncDecResponse>(
        client,
        &dec_url,
        json!({
            "text": encrypted_payload,
            "sign": signature,
        }),
        None,
        timeout_ms,
    )
    .await?;
    if dec_response.status != 200 {
        return None;
    }
    let dec_result = dec_response.result?;
    if !dec_result.error.as_deref().unwrap_or("").trim().is_empty() {
        return None;
    }

    for stream in dec_result.stream {
        if stream.r#type.trim().eq_ignore_ascii_case("hls") {
            let playlist = stream.playlist.trim();
            if !playlist.is_empty()
                && let Some(source) = validate_external_embed_hls_playlist(
                    client,
                    playlist,
                    Some(LORDFLIX_REFERER),
                    timeout_ms,
                )
                .await
            {
                return Some(source);
            }
        }
    }
    None
}

/// Build the Stremio stream endpoint for a NoTorrent-shaped addon
/// (`<base>/stream/{movie,series}/<imdb>[:s:e].json`). Returns `None` when the
/// title has no IMDb id (the addons key on `tt…`, not TMDB).
fn stremio_addon_stream_url(base: &str, metadata: &ResolveMetadata) -> Option<String> {
    let imdb_id = metadata.imdb_id.trim();
    if imdb_id.is_empty() {
        return None;
    }
    let base = base.trim_end_matches('/');
    if metadata.media_type == "tv" {
        Some(format!(
            "{base}/stream/series/{imdb_id}:{}:{}.json",
            metadata.season_number, metadata.episode_number
        ))
    } else {
        Some(format!("{base}/stream/movie/{imdb_id}.json"))
    }
}

/// Normalize a configured Stremio install base read from env: trim, drop any
/// trailing slash / `manifest.json` suffix, and require https. Returns `None` for
/// blank or non-https values so an unset/misconfigured addon stays inert.
fn normalize_nebula_addon_base(raw: &str) -> Option<String> {
    let mut base = raw.trim().trim_end_matches('/').to_owned();
    if let Some(stripped) = base.strip_suffix("/manifest.json") {
        base = stripped.trim_end_matches('/').to_owned();
    }
    (base.starts_with("https://") && base.len() > "https://".len()).then_some(base)
}

fn nebula_addon_base() -> Option<&'static str> {
    NEBULA_ADDON_BASE.as_deref()
}

async fn resolve_stremio_addon_hls_playback_source(
    client: &reqwest::Client,
    base: &str,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let api_url = stremio_addon_stream_url(base, metadata)?;
    let response =
        fetch_external_json::<NoTorrentStreamResponse>(client, &api_url, None, timeout_ms).await?;

    for stream in response.streams {
        if !stream.external_url.trim().is_empty() {
            continue;
        }
        let stream_url = stream.url.trim();
        if stream_url.is_empty()
            || stream_url.contains("github.com")
            || stream_url.contains("googleusercontent")
        {
            continue;
        }
        let referer = stremio_addon_stream_referer(&stream);
        if let Some(source) =
            validate_external_embed_hls_playlist(client, stream_url, referer.as_deref(), timeout_ms)
                .await
        {
            return Some(source);
        }
    }
    None
}

fn stremio_addon_stream_referer(stream: &NoTorrentStreamEntry) -> Option<String> {
    let mut headers = stream.behavior_hints.headers.clone();
    headers.extend(stream.behavior_hints.proxy_headers.request.clone());
    headers
        .get("Referer")
        .or_else(|| headers.get("referer"))
        .cloned()
        .or_else(|| {
            headers
                .get("Origin")
                .or_else(|| headers.get("origin"))
                .cloned()
        })
}

async fn post_external_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    body: Value,
    referer: Option<&str>,
    timeout_ms: u64,
) -> Option<T> {
    let url = Url::parse(url.trim()).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let mut request = client
        .post(url)
        .header(header::USER_AGENT, EXTERNAL_EMBED_USER_AGENT)
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .header(header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(referer) = referer.and_then(normalize_external_embed_hls_referer) {
        request = request.header(header::REFERER, referer);
    }
    let response = timeout(
        Duration::from_millis(timeout_ms.clamp(1_000, 120_000)),
        request.json(&body).send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<T>().await.ok()
}

/// macOS system curl (SecureTransport TLS) used for resolve-time fetches to
/// hosts that fingerprint-block the shared rustls reqwest client. Same root
/// cause and binary as the live-HLS curl path; kept as a separate resolver-side
/// list because these are the resolve-time API/embed/playlist hosts. Playback of
/// the resolved stream is proxied through `/api/live/*`, which fingerprint-
/// bypasses via `crate::live::is_curl_fetch_live_hls_upstream` (the two host
/// lists must stay in sync for any host whose playback proxies through the mini).
const RESOLVER_CURL_BIN: &str = "/usr/bin/curl";
const RESOLVER_CURL_MAX_CONCURRENT: usize = 6;
static RESOLVER_CURL_SEMAPHORE: Semaphore = Semaphore::const_new(RESOLVER_CURL_MAX_CONCURRENT);

/// Hosts whose resolve-time HTTP(S) must go over the system curl instead of the
/// rustls reqwest client (Cloudflare TLS/HTTP2-fingerprint block: rustls 403/410s,
/// curl + browser UA passes). vixsrc.to gates its `/api/*`, `/embed/*`, and
/// `/playlist/*` endpoints this way.
fn is_curl_fetch_external_embed_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    host == "vixsrc.to" || host.ends_with(".vixsrc.to")
}

struct ResolverCurlResponse {
    status: u16,
    body: Vec<u8>,
}

/// GET `url` over the system curl with a browser UA. Does NOT follow redirects:
/// like the live-HLS curl path, the SSRF guard relies on the final host equalling
/// the already-validated request host, so a redirect must not silently retarget.
async fn fetch_external_via_curl(
    url: &Url,
    referer: Option<&str>,
    accept: &str,
) -> Option<ResolverCurlResponse> {
    let _permit = RESOLVER_CURL_SEMAPHORE.acquire().await.ok()?;
    let mut command = Command::new(RESOLVER_CURL_BIN);
    command
        .arg("-sS")
        .arg("--max-time")
        .arg("12")
        .arg("-A")
        .arg(EXTERNAL_EMBED_USER_AGENT)
        .arg("-H")
        .arg(format!("Accept: {accept}"))
        .arg("-H")
        .arg("Accept-Language: en-US,en;q=0.9")
        .arg("-D")
        .arg("/dev/stderr")
        .arg(url.as_str())
        .kill_on_drop(true);
    if let Some(referer) = referer {
        command.arg("-H").arg(format!("Referer: {referer}"));
    }
    let output = timeout(Duration::from_secs(16), command.output())
        .await
        .ok()?
        .ok()?;
    // curl exits non-zero only on transport errors; an HTTP 4xx/5xx still exits 0
    // and the status is parsed from the dumped headers by the caller.
    if !output.status.success() {
        return None;
    }
    let headers = String::from_utf8_lossy(&output.stderr);
    let (status, _content_type) = crate::live::parse_curl_response_headers(&headers);
    Some(ResolverCurlResponse {
        status,
        body: output.stdout,
    })
}

async fn fetch_external_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    referer: Option<&str>,
    timeout_ms: u64,
) -> Option<T> {
    let text = fetch_external_text(client, url, referer, timeout_ms).await?;
    serde_json::from_str(&text).ok()
}

async fn fetch_external_text(
    client: &reqwest::Client,
    url: &str,
    referer: Option<&str>,
    timeout_ms: u64,
) -> Option<String> {
    let url = Url::parse(url.trim()).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    // SSRF guard: only fetch public hostnames. External providers can return
    // relative/protocol-relative URLs (e.g. VixSrc `src`) that join into an
    // attacker-chosen host, so validate the resolved host before any request.
    let host = url.host_str()?.to_ascii_lowercase();
    if !is_public_external_embed_hls_hostname(&host) {
        return None;
    }
    // Fingerprint-blocked hosts (e.g. vixsrc.to) reject the rustls client; route
    // their resolve-time fetches over the system curl (SecureTransport) instead.
    if is_curl_fetch_external_embed_host(&host) {
        let referer = referer.and_then(normalize_external_embed_hls_referer);
        let response = fetch_external_via_curl(
            &url,
            referer.as_deref(),
            "application/json, text/plain, */*",
        )
        .await?;
        if !(200..300).contains(&response.status) {
            return None;
        }
        return Some(String::from_utf8_lossy(&response.body).into_owned());
    }
    let mut request = client
        .get(url)
        .header(header::USER_AGENT, EXTERNAL_EMBED_USER_AGENT)
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .header(header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(referer) = referer.and_then(normalize_external_embed_hls_referer) {
        request = request.header(header::REFERER, referer);
    }
    let response = timeout(Duration::from_millis(timeout_ms.max(1_000)), request.send())
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    timeout(
        Duration::from_millis(timeout_ms.max(1_000)),
        response.text(),
    )
    .await
    .ok()?
    .ok()
}

async fn validate_external_embed_hls_playlist(
    client: &reqwest::Client,
    playback_url: &str,
    referer: Option<&str>,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let playback_url = Url::parse(playback_url.trim()).ok()?;
    if !is_supported_external_embed_validated_playlist_url(&playback_url) {
        return None;
    }
    let referer = referer.and_then(normalize_external_embed_hls_referer);
    // Fingerprint-blocked hosts (e.g. vixsrc.to) reject the rustls client; fetch
    // the playlist for validation over the system curl. No redirects are followed,
    // so the final URL equals the already-validated playback URL.
    if playback_url
        .host_str()
        .is_some_and(is_curl_fetch_external_embed_host)
    {
        let response = fetch_external_via_curl(
            &playback_url,
            referer.as_deref(),
            "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        )
        .await?;
        if !(200..300).contains(&response.status) {
            return None;
        }
        let playlist = String::from_utf8_lossy(&response.body);
        if !playlist.trim_start().starts_with("#EXTM3U") {
            return None;
        }
        return Some(ExternalEmbedHlsPlaybackSource {
            playback_url,
            referer,
        });
    }
    let mut request = client
        .get(playback_url)
        .header(header::USER_AGENT, EXTERNAL_EMBED_USER_AGENT)
        .header(
            header::ACCEPT,
            "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        )
        .header(header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(referer) = referer.as_deref() {
        request = request.header(header::REFERER, referer);
    }
    let response = timeout(Duration::from_millis(timeout_ms.max(1_000)), request.send())
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let final_url = response.url().clone();
    if !is_supported_external_embed_validated_playlist_url(&final_url) {
        return None;
    }
    let playlist = timeout(
        Duration::from_millis(timeout_ms.max(1_000)),
        response.text(),
    )
    .await
    .ok()?
    .ok()?;
    if !playlist.trim_start().starts_with("#EXTM3U") {
        return None;
    }
    Some(ExternalEmbedHlsPlaybackSource {
        playback_url: final_url,
        referer,
    })
}

fn encrypt_vidrock_item_id(item_id: &str) -> Option<String> {
    type Aes256CbcEnc = cbc::Encryptor<Aes256>;
    let key = VIDROCK_AES_PASSPHRASE.as_bytes();
    let iv = VIDROCK_AES_PASSPHRASE.get(..16)?.as_bytes();
    let encrypted = Aes256CbcEnc::new(key.into(), iv.into())
        .encrypt_padded_vec_mut::<Pkcs7>(item_id.as_bytes());
    Some(URL_SAFE_NO_PAD.encode(encrypted))
}

fn percent_decode_lossy(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            output.push(byte);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn external_embed_hls_resolver_script_path() -> String {
    if let Some(value) = std::env::var("EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT).is_file() {
        return EXTERNAL_EMBED_HLS_RESOLVER_SCRIPT.to_owned();
    }

    EXTERNAL_EMBED_HLS_RESOLVER_RUNTIME_SCRIPT.to_owned()
}

fn external_embed_hls_resolve_timeout_seconds() -> u64 {
    std::env::var(EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|milliseconds| milliseconds.div_ceil(1000))
        .filter(|seconds| *seconds >= 1 && *seconds <= 120)
        .unwrap_or(EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS)
}

fn external_embed_hls_resolve_timeout_ms() -> u64 {
    external_embed_hls_resolve_timeout_seconds() * 1000
}

fn external_embed_hls_total_timeout_ms() -> u64 {
    std::env::var(EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|milliseconds| (1_000..=120_000).contains(milliseconds))
        .unwrap_or(EXTERNAL_EMBED_HLS_TOTAL_TIMEOUT_MS)
}

fn is_supported_external_embed_hls_embed_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    match host.as_str() {
        "cinejoy.to" => {
            url.path().starts_with("/watch/movie/") || url.path().starts_with("/watch/tv/")
        }
        "player.videasy.net" => url.path().starts_with("/movie/") || url.path().starts_with("/tv/"),
        "player.videasy.to" => url.path().starts_with("/movie/") || url.path().starts_with("/tv/"),
        "vidlink.pro" => url.path().starts_with("/movie/") || url.path().starts_with("/tv/"),
        _ => false,
    }
}

fn is_supported_external_embed_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    let is_m3u8 = url.path().to_ascii_lowercase().ends_with(".m3u8");
    is_m3u8 && is_public_external_embed_hls_hostname(&host)
}

fn is_supported_external_embed_validated_playlist_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    is_public_external_embed_hls_hostname(&host)
}

fn is_public_external_embed_hls_hostname(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host.contains(':')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.parse::<Ipv4Addr>().is_ok()
    {
        return false;
    }
    host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-'))
}

fn normalize_external_embed_hls_referer(value: &str) -> Option<String> {
    let mut url = Url::parse(value.trim()).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    url.host_str()?;
    url.set_fragment(None);
    Some(url.to_string())
}

fn merge_discovery_query_results(
    primary_result: AppResult<Vec<DiscoveryStream>>,
    search_result: AppResult<Vec<DiscoveryStream>>,
) -> AppResult<Vec<DiscoveryStream>> {
    match (primary_result, search_result) {
        (Ok(primary), Ok(search)) => Ok(merge_discovery_streams(primary, search)),
        (Ok(primary), Err(_)) if !primary.is_empty() => Ok(primary),
        (Err(_), Ok(search)) if !search.is_empty() => Ok(search),
        (Ok(_), Err(search_error)) => Err(search_error),
        (Err(primary_error), _) => Err(primary_error),
    }
}

fn merge_discovery_streams(
    mut primary: Vec<DiscoveryStream>,
    additional: Vec<DiscoveryStream>,
) -> Vec<DiscoveryStream> {
    let mut seen_hashes = primary
        .iter()
        .filter_map(discovery_stream_info_hash)
        .collect::<HashSet<_>>();
    for stream in additional {
        if let Some(info_hash) = discovery_stream_info_hash(&stream)
            && !seen_hashes.insert(info_hash)
        {
            continue;
        }
        primary.push(stream);
    }
    primary
}

fn discovery_stream_info_hash(stream: &DiscoveryStream) -> Option<String> {
    let direct = normalize_source_hash(&stream.infoHash);
    if !direct.is_empty() {
        return Some(direct);
    }
    let from_magnet = extract_info_hash_from_magnet(&stream.magnetUrl);
    (!from_magnet.is_empty()).then_some(from_magnet)
}

fn normalize_preferred_container(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "mp4" => "mp4".to_owned(),
        "mkv" => "mkv".to_owned(),
        _ => "auto".to_owned(),
    }
}

fn normalize_tv_preferred_container(value: &str) -> String {
    match normalize_preferred_container(value).as_str() {
        "mkv" => "mkv".to_owned(),
        _ => "mp4".to_owned(),
    }
}

fn normalize_minimum_seeders(value: &str) -> i64 {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .unwrap_or_default()
        .clamp(0, 50_000)
}

fn normalize_allowed_formats(value: &str) -> Vec<String> {
    let normalized = value
        .split([',', ' '])
        .filter_map(|item| {
            let normalized = item.trim().to_lowercase();
            if matches!(normalized.as_str(), "mp4" | "mkv") {
                Some(normalized)
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();
    let mut next = normalized.into_iter().collect::<Vec<_>>();
    next.sort();
    next
}

fn normalize_source_language_filter(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "en" | "eng" | "english" => SOURCE_LANGUAGE_FILTER_DEFAULT.to_owned(),
        "any" | "all" | "auto" | "*" => "any".to_owned(),
        "fr" | "es" | "de" | "it" | "pt" => value.trim().to_lowercase(),
        _ => SOURCE_LANGUAGE_FILTER_DEFAULT.to_owned(),
    }
}

fn normalize_source_audio_profile_filter(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "single" | "single-audio" | "single_audio" | "singleaudio" | "preferred" => {
            SOURCE_AUDIO_PROFILE_DEFAULT.to_owned()
        }
        "any" | "all" | "multi" | "multi-audio" | "multi_audio" | "multiaudio" => "any".to_owned(),
        _ => SOURCE_AUDIO_PROFILE_DEFAULT.to_owned(),
    }
}

fn compute_source_health_score(stats: &SourceHealthStats) -> i64 {
    let attempts = stats.success_count + stats.failure_count;
    if attempts <= 0 {
        return 0;
    }
    if stats.success_count == 0 && stats.playback_error_count > 0 {
        return SOURCE_HEALTH_AVOID_SCORE - (stats.playback_error_count * 1_000).min(4_000);
    }
    if stats.success_count == 0 && stats.failure_count > 0 {
        return SOURCE_HEALTH_AVOID_SCORE - 500;
    }
    let success_rate = stats.success_count as f64 / attempts as f64;
    let confidence_factor = (attempts as f64 / 6.0).min(1.0);
    let mut score = ((success_rate - 0.55) * 2800.0 * confidence_factor).round() as i64;
    score -= (stats.decode_failure_count * 1400).min(3200);
    score -= (stats.ended_early_count * 1000).min(2600);
    score -= (stats.playback_error_count * 900).min(2400);
    score
}

fn compute_external_embed_rank_health_score(stats: &SourceHealthStats) -> i64 {
    let score = compute_source_health_score(stats);
    if score > 0 {
        score.min(EXTERNAL_EMBED_POSITIVE_HEALTH_SCORE_CAP)
    } else {
        score
    }
}

/// Provider-level (cross-title aggregate) health is a weaker signal than per-title
/// health and must only nudge ordering WITHIN a tier — never bury a higher-tier
/// provider that merely has a spotty catalog. Per-title (`source_hash`) health,
/// which stays uncapped, already demotes the specific titles a provider fails. So
/// clamp the provider aggregate to ±the positive cap, EXCEPT when the provider is
/// broadly DEAD (the uncapped AVOID penalty, only reached with zero successes),
/// which should still sink it across tiers.
fn compute_external_embed_provider_rank_health_score(stats: &SourceHealthStats) -> i64 {
    let score = compute_source_health_score(stats);
    if score <= SOURCE_HEALTH_AVOID_SCORE {
        return score;
    }
    score.clamp(
        -EXTERNAL_EMBED_POSITIVE_HEALTH_SCORE_CAP,
        EXTERNAL_EMBED_POSITIVE_HEALTH_SCORE_CAP,
    )
}

fn stream_quality_target(value: &str) -> i64 {
    match value {
        "2160p" => 2160,
        "1080p" => 1080,
        "720p" => 720,
        _ => 0,
    }
}

fn tokenize_title_for_match(title: &str) -> Vec<String> {
    let normalized = normalize_text_for_match(title);
    if normalized.is_empty() {
        return Vec::new();
    }
    normalized
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !title_match_stopwords().contains(*token))
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_text_for_match(value: &str) -> String {
    TEXT_NORMALIZE_RE
        .replace_all(&value.to_lowercase(), " ")
        .trim()
        .to_owned()
}

fn normalize_episode_ordinal(value: &str, fallback: i64) -> i64 {
    value.trim().parse::<i64>().ok().unwrap_or(fallback).max(1)
}

fn count_matching_title_tokens(normalized_value: &str, title_tokens: &[String]) -> usize {
    if normalized_value.is_empty() || title_tokens.is_empty() {
        return 0;
    }
    let normalized_token_set = normalized_value.split_whitespace().collect::<HashSet<_>>();
    title_tokens
        .iter()
        .filter(|token| normalized_token_set.contains(token.as_str()))
        .count()
}

fn build_stream_text(stream: &DiscoveryStream) -> String {
    build_stream_text_raw(stream).to_lowercase()
}

fn build_stream_release_text(stream: &DiscoveryStream) -> String {
    normalize_text_for_match(
        &[
            stream.name.as_str(),
            stream.title.as_str(),
            stream.description.as_str(),
        ]
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" "),
    )
}

fn build_stream_text_raw(stream: &DiscoveryStream) -> String {
    [
        stream.name.as_str(),
        stream.title.as_str(),
        stream.description.as_str(),
        stream.behaviorHints.filename.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_explicit_multi_audio_marker(stream: &DiscoveryStream) -> bool {
    let release_text = build_stream_release_text(stream);
    !release_text.is_empty() && MULTI_AUDIO_RELEASE_RE.is_match(&release_text)
}

fn build_torrentio_stream_cache_key(base_url: &str, path: &str) -> String {
    format!(
        "torrentio:{}{}",
        base_url.trim().trim_end_matches('/'),
        path.trim()
    )
}

fn build_torznab_stream_cache_key(base_url: &str, params: &[(&str, String)]) -> String {
    let param_text = params
        .iter()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("apikey"))
        .map(|(key, value)| format!("{}={}", key.trim(), value.trim()))
        .collect::<Vec<_>>()
        .join("&");
    format!(
        "torznab:{}?{}",
        sanitize_torznab_base_url_for_cache(base_url),
        param_text
    )
}

fn build_torznab_download_cache_key(download_url: &str) -> String {
    format!(
        "torznab-download:{}",
        sanitize_torznab_base_url_for_cache(download_url)
    )
}

fn torznab_download_url_allowed(api_url: &str, download_url: &str) -> bool {
    let Ok(api_url) = Url::parse(api_url.trim()) else {
        return false;
    };
    let Ok(download_url) = Url::parse(download_url.trim()) else {
        return false;
    };
    matches!(download_url.scheme(), "http" | "https")
        && download_url.username().is_empty()
        && download_url.password().is_none()
        && api_url.scheme() == download_url.scheme()
        && api_url.host_str() == download_url.host_str()
        && api_url.port_or_known_default() == download_url.port_or_known_default()
}

fn sanitize_torznab_base_url_for_cache(base_url: &str) -> String {
    let trimmed = base_url.trim();
    let Ok(mut url) = url::Url::parse(trimmed) else {
        return trimmed.to_owned();
    };
    let retained_pairs = url
        .query_pairs()
        .filter(|(key, _)| {
            !key.eq_ignore_ascii_case("apikey") && !key.eq_ignore_ascii_case("jackett_apikey")
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    if !retained_pairs.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in retained_pairs {
            pairs.append_pair(&key, &value);
        }
    }
    url.to_string()
}

fn build_torznab_request_url(
    base_url: &str,
    api_key: &str,
    params: &[(&str, String)],
) -> AppResult<String> {
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|_| ApiError::internal("TORZNAB_API_URL is not a valid URL."))?;
    let retained_pairs = url
        .query_pairs()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("apikey"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in retained_pairs {
            pairs.append_pair(&key, &value);
        }
        if !api_key.trim().is_empty() {
            pairs.append_pair("apikey", api_key.trim());
        }
        for (key, value) in params {
            if !key.trim().is_empty() && !value.trim().is_empty() {
                pairs.append_pair(key.trim(), value.trim());
            }
        }
    }
    Ok(url.to_string())
}

fn parse_torrentio_streams_payload(payload: &Value) -> AppResult<Vec<DiscoveryStream>> {
    let streams = payload
        .get("streams")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let mut parsed = serde_json::from_value::<Vec<DiscoveryStream>>(streams)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    for stream in &mut parsed {
        if stream.discoveryProvider.trim().is_empty() {
            stream.discoveryProvider = "torrentio".to_owned();
        }
    }
    Ok(parsed)
}

fn parse_torznab_streams_payload(payload: &Value) -> AppResult<Vec<DiscoveryStream>> {
    let xml = payload
        .get("xml")
        .and_then(Value::as_str)
        .unwrap_or_default();
    parse_torznab_xml(xml)
}

fn compute_torrentio_cache_deadlines(payload: &Value) -> (i64, i64) {
    let now = now_ms();
    let fresh_seconds = torrentio_cache_seconds(
        payload,
        "cacheMaxAge",
        TORRENTIO_CACHE_MAX_AGE_DEFAULT_SECONDS,
    );
    let stale_seconds = torrentio_cache_seconds(
        payload,
        "staleError",
        torrentio_cache_seconds(
            payload,
            "staleRevalidate",
            TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS,
        ),
    )
    .max(torrentio_cache_seconds(
        payload,
        "staleRevalidate",
        TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS,
    ));
    let next_validation_at = now + fresh_seconds.max(1) * 1_000;
    let expires_at = next_validation_at + stale_seconds.max(0) * 1_000;
    (expires_at.max(next_validation_at), next_validation_at)
}

fn compute_torznab_cache_deadlines() -> (i64, i64) {
    let now = now_ms();
    let next_validation_at = now + TORZNAB_CACHE_MAX_AGE_SECONDS * 1_000;
    let expires_at = next_validation_at + TORZNAB_CACHE_STALE_WINDOW_SECONDS * 1_000;
    (expires_at, next_validation_at)
}

fn torrentio_cache_seconds(payload: &Value, key: &str, default_seconds: i64) -> i64 {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(default_seconds)
        .max(0)
}

fn parse_torznab_xml(xml: &str) -> AppResult<Vec<DiscoveryStream>> {
    if xml.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut current_item = None::<TorznabItem>;
    let mut current_element = String::new();
    let mut items = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(event)) => {
                let name = xml_event_name(event.name().as_ref());
                if name == "item" {
                    current_item = Some(TorznabItem::default());
                } else if name == "enclosure" {
                    if let Some(item) = current_item.as_mut() {
                        apply_torznab_enclosure(item, &collect_xml_attributes(&event));
                    }
                } else if is_torznab_attr_element(&name) {
                    if let Some(item) = current_item.as_mut() {
                        apply_torznab_attr(item, &collect_xml_attributes(&event));
                    }
                } else {
                    current_element = name;
                }
            }
            Ok(Event::Empty(event)) => {
                let name = xml_event_name(event.name().as_ref());
                if let Some(item) = current_item.as_mut() {
                    if name == "enclosure" {
                        apply_torznab_enclosure(item, &collect_xml_attributes(&event));
                    } else if is_torznab_attr_element(&name) {
                        apply_torznab_attr(item, &collect_xml_attributes(&event));
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(item) = current_item.as_mut()
                    && let Ok(decoded) = text.xml10_content()
                {
                    let value = quick_xml::escape::unescape(&decoded)
                        .map(|value| value.into_owned())
                        .unwrap_or_else(|_| decoded.into_owned());
                    apply_torznab_element_text(item, &current_element, &value);
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if let Some(item) = current_item.as_mut() {
                    let value = match &*reference {
                        b"amp" => "&",
                        b"lt" => "<",
                        b"gt" => ">",
                        b"apos" => "'",
                        b"quot" => "\"",
                        _ => "",
                    };
                    apply_torznab_element_text(item, &current_element, value);
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(item) = current_item.as_mut() {
                    let value = String::from_utf8_lossy(text.as_ref());
                    apply_torznab_element_text(item, &current_element, &value);
                }
            }
            Ok(Event::End(event)) => {
                let name = xml_event_name(event.name().as_ref());
                if name == "item"
                    && let Some(item) = current_item.take()
                {
                    items.push(item);
                }
                if current_element == name {
                    current_element.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(ApiError::internal(error.to_string())),
            _ => {}
        }
        buf.clear();
    }

    Ok(items
        .into_iter()
        .filter_map(torznab_item_to_stream)
        .collect())
}

fn xml_event_name(value: &[u8]) -> String {
    String::from_utf8_lossy(value).to_lowercase()
}

fn collect_xml_attributes(event: &quick_xml::events::BytesStart<'_>) -> HashMap<String, String> {
    let mut output = HashMap::new();
    for attr in event.attributes().with_checks(false).flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).to_lowercase();
        let value = attr
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map(|value| value.into_owned())
            .unwrap_or_default();
        output.insert(key, value);
    }
    output
}

fn is_torznab_attr_element(name: &str) -> bool {
    name == "torznab:attr" || name.ends_with(":attr") || name == "attr"
}

fn apply_torznab_enclosure(item: &mut TorznabItem, attrs: &HashMap<String, String>) {
    if let Some(url) = attrs.get("url") {
        item.enclosure_url = url.trim().to_owned();
    }
}

fn apply_torznab_attr(item: &mut TorznabItem, attrs: &HashMap<String, String>) {
    let attr_name = attrs
        .get("name")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    let attr_value = attrs.get("value").map(String::as_str).unwrap_or_default();
    match attr_name.as_str() {
        "infohash" | "info_hash" | "hash" => item.info_hash = attr_value.trim().to_owned(),
        "magneturl" | "magnet_url" | "magneturi" | "magnet_uri" => {
            item.magnet_url = attr_value.trim().to_owned()
        }
        "seeders" | "seeds" | "seed" => item.seeders = parse_i64(attr_value),
        "size" => item.size_bytes = parse_i64(attr_value),
        "team" | "releasegroup" | "release_group" | "group" => {
            item.release_group = normalize_whitespace(attr_value)
        }
        "indexer" | "tracker" => item.indexer = normalize_whitespace(attr_value),
        _ => {}
    }
}

fn apply_torznab_element_text(item: &mut TorznabItem, element: &str, value: &str) {
    let normalized = normalize_whitespace(value);
    if normalized.is_empty() {
        return;
    }
    match element {
        "title" => item.title.push_str(&normalized),
        "link" => item.link.push_str(&normalized),
        "size" => item.size_bytes = parse_i64(&normalized),
        "jackettindexer" | "prowlarrindexer" | "indexer" => item.indexer.push_str(&normalized),
        _ => {}
    }
}

fn torznab_item_to_stream(item: TorznabItem) -> Option<DiscoveryStream> {
    let candidate_magnet = [
        item.magnet_url.as_str(),
        item.link.as_str(),
        item.enclosure_url.as_str(),
    ]
    .into_iter()
    .find_map(normalize_magnet_url)
    .unwrap_or_default();
    let candidate_download_url = [item.link.as_str(), item.enclosure_url.as_str()]
        .into_iter()
        .find_map(normalize_torznab_download_url)
        .unwrap_or_default();
    let info_hash = [
        item.info_hash.as_str(),
        candidate_magnet.as_str(),
        item.link.as_str(),
        item.enclosure_url.as_str(),
    ]
    .into_iter()
    .find_map(extract_info_hash_from_source)
    .unwrap_or_default();
    if info_hash.is_empty() && candidate_magnet.is_empty() && candidate_download_url.is_empty() {
        return None;
    }

    let title = normalize_whitespace(&item.title).if_empty_then(|| "Torznab source".to_owned());
    let release_group = normalize_whitespace(&item.release_group);
    let mut title_lines = vec![title.clone()];
    if item.size_bytes > 0 {
        title_lines.push(format!("💾 {}", format_size_bytes(item.size_bytes)));
    }
    if !release_group.is_empty() {
        title_lines.push(format!("⚙ {release_group}"));
    }
    if item.seeders > 0 {
        title_lines.push(format!("👤 {}", item.seeders));
    }

    let provider = if item.indexer.trim().is_empty() {
        "Torznab".to_owned()
    } else {
        format!("Torznab - {}", normalize_whitespace(&item.indexer))
    };
    Some(DiscoveryStream {
        infoHash: info_hash,
        fileIdx: None,
        name: provider,
        title: title_lines.join("\n"),
        description: String::new(),
        behaviorHints: DiscoveryBehaviorHints { filename: title },
        sources: Vec::new(),
        magnetUrl: candidate_magnet,
        discoveryProvider: "torznab".to_owned(),
        downloadUrl: candidate_download_url,
        real_debrid_cached: false,
    })
}

fn normalize_torznab_download_url(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn normalize_magnet_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.to_lowercase().starts_with("magnet:?")
        && !extract_info_hash_from_magnet(trimmed).is_empty()
    {
        Some(trimmed.to_owned())
    } else {
        None
    }
}

fn extract_info_hash_from_source(value: &str) -> Option<String> {
    let direct = normalize_source_hash(value);
    if !direct.is_empty() {
        return Some(direct);
    }
    let from_magnet = extract_info_hash_from_magnet(value);
    if !from_magnet.is_empty() {
        return Some(from_magnet);
    }
    None
}

fn extract_info_hash_from_magnet(value: &str) -> String {
    let Ok(url) = url::Url::parse(value.trim()) else {
        return String::new();
    };
    if url.scheme() != "magnet" {
        return String::new();
    }
    for (key, value) in url.query_pairs() {
        if key != "xt" {
            continue;
        }
        let Some(hash) = value.strip_prefix("urn:btih:") else {
            continue;
        };
        let normalized = normalize_source_hash(hash);
        if !normalized.is_empty() {
            return normalized;
        }
    }
    String::new()
}

fn parse_i64(value: &str) -> i64 {
    value.trim().parse::<i64>().ok().unwrap_or_default().max(0)
}

fn format_size_bytes(bytes: i64) -> String {
    if bytes <= 0 {
        return String::new();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_index = 0;
    while size >= 1024.0 && unit_index + 1 < units.len() {
        size /= 1024.0;
        unit_index += 1;
    }
    if unit_index == 0 {
        format!("{} {}", bytes, units[unit_index])
    } else {
        format!("{size:.1} {}", units[unit_index])
    }
}

fn map_reqwest_error(error: reqwest::Error, timeout_message: &str) -> ApiError {
    if error.is_timeout() {
        ApiError::gateway_timeout(timeout_message)
    } else {
        ApiError::bad_gateway("Upstream resolver request failed.")
    }
}

fn external_embed_hls_unavailable_error() -> ApiError {
    ApiError::failed_dependency(
        "External HLS sources are unavailable right now. Try another server.",
    )
}

fn selected_external_embed_hls_unavailable_error() -> ApiError {
    ApiError::failed_dependency("Selected external HLS source is unavailable. Try another server.")
}

fn local_torrent_required_error() -> ApiError {
    ApiError::failed_dependency("Enable Torrent streaming in Settings to use magnet sources.")
}

fn is_retryable_torrentio_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429) || status.is_server_error()
}

fn is_retryable_torrentio_transport_error(error: &reqwest::Error) -> bool {
    error.is_connect()
}

fn stringify_json(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => {
            if *value {
                "true".to_owned()
            } else {
                "false".to_owned()
            }
        }
        _ => String::new(),
    }
}

fn title_match_stopwords() -> &'static HashSet<&'static str> {
    static STOPWORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        [
            "the", "a", "an", "and", "of", "in", "on", "to", "for", "vs", "v", "movie", "film",
        ]
        .into_iter()
        .collect()
    });
    &STOPWORDS
}

fn audio_language_tokens(lang: &str) -> &'static [&'static str] {
    match lang {
        "en" => &[
            "english",
            " eng ",
            "eng-",
            "eng]",
            "eng)",
            "en audio",
            "dubbed english",
        ],
        "fr" => &["french", " fran", "fra ", " fr ", "vf", "vff"],
        "es" => &["spanish", "espanol", "castellano", " spa ", "esp "],
        "de" => &["german", " deutsch", " ger ", "deu "],
        "it" => &["italian", " italiano", " ita "],
        "pt" => &["portuguese", " portugues", " por ", "pt-br", "brazilian"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlayableUrlVerification {
    Verified,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackSessionRevalidation {
    Fresh,
    StaleWhileRevalidate,
    Invalid,
}

async fn classify_playback_session_revalidation(
    result_rx: oneshot::Receiver<PlaybackSessionRevalidation>,
    foreground_grace: Duration,
) -> PlaybackSessionRevalidation {
    match timeout(foreground_grace, result_rx).await {
        Ok(Ok(revalidation)) => revalidation,
        Ok(Err(_)) | Err(_) => PlaybackSessionRevalidation::StaleWhileRevalidate,
    }
}

fn push_unique_tracker(trackers: &mut Vec<String>, tracker: &str) {
    let trimmed = tracker.trim();
    if trimmed.is_empty() {
        return;
    }
    if trackers
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(trimmed))
    {
        return;
    }
    trackers.push(trimmed.to_owned());
}

fn build_magnet_uri(stream: &DiscoveryStream, fallback_name: &str) -> AppResult<String> {
    let normalized_magnet = normalize_magnet_url(&stream.magnetUrl);
    let info_hash = {
        let from_stream = get_stream_info_hash(stream);
        if !from_stream.is_empty() {
            from_stream
        } else if let Some(magnet_url) = normalized_magnet.as_deref() {
            extract_info_hash_from_magnet(magnet_url)
        } else {
            String::new()
        }
    };
    if info_hash.is_empty() {
        return Err(ApiError::internal("Missing torrent info hash."));
    }

    let mut trackers = Vec::new();
    if let Some(magnet_url) = normalized_magnet.as_deref()
        && let Ok(url) = url::Url::parse(magnet_url)
    {
        for (key, value) in url.query_pairs() {
            if key == "tr" {
                push_unique_tracker(&mut trackers, value.as_ref());
            }
        }
    }
    for source in &stream.sources {
        if let Some(tracker) = source.strip_prefix("tracker:") {
            push_unique_tracker(&mut trackers, tracker);
        }
    }
    for tracker in DEFAULT_TRACKERS {
        push_unique_tracker(&mut trackers, tracker);
    }

    let display_name = {
        let fallback = fallback_name.trim();
        if !fallback.is_empty() {
            fallback.to_owned()
        } else if let Some(magnet_url) = normalized_magnet.as_deref()
            && let Ok(url) = url::Url::parse(magnet_url)
        {
            url.query_pairs()
                .find_map(|(key, value)| (key == "dn").then(|| value.into_owned()))
                .unwrap_or_default()
        } else {
            String::new()
        }
    };

    let mut parts = vec![format!("xt=urn:btih:{info_hash}")];
    if !display_name.is_empty() {
        parts.push(format!(
            "dn={}",
            url::form_urlencoded::byte_serialize(display_name.as_bytes()).collect::<String>()
        ));
    }
    for tracker in trackers {
        parts.push(format!(
            "tr={}",
            url::form_urlencoded::byte_serialize(tracker.as_bytes()).collect::<String>()
        ));
    }
    Ok(format!("magnet:?{}", parts.join("&")))
}

fn is_persistent_source_resolve_error(error: &ApiError) -> bool {
    let Some(message) = error.message() else {
        return false;
    };
    matches!(
        message,
        "Real-Debrid blocked this source."
            | RD_SELECTED_FILE_MISMATCH_ERROR
            | "No supported video file was found in this torrent."
            | "No playable Real-Debrid stream URL was available."
            | "Real-Debrid returned no downloadable link."
            | "Resolved stream filename did not match requested title."
            | "Resolved stream filename did not match requested episode."
    ) || message.starts_with("Resolved stream is unavailable")
}

fn has_url_like_container_extension(value: &str, container: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    match container {
        "mp4" => CONTAINER_MP4_RE.is_match(&normalized),
        "mkv" => CONTAINER_MKV_RE.is_match(&normalized),
        _ => false,
    }
}

fn is_supported_resolved_container_path(value: &str) -> bool {
    DEFAULT_ALLOWED_SOURCE_FORMATS
        .iter()
        .any(|container| has_url_like_container_extension(value, container))
}

fn container_preference_rank(path: &str) -> i64 {
    if has_url_like_container_extension(path, "mp4") {
        1
    } else {
        0
    }
}

fn resolve_effective_preferred_subtitle_lang(
    stored_preferred_subtitle_lang: &str,
    preferred_subtitle_lang: &str,
) -> String {
    let normalized = normalize_subtitle_preference(preferred_subtitle_lang);
    if !normalized.is_empty() {
        return normalized;
    }
    normalize_subtitle_preference(stored_preferred_subtitle_lang)
}

fn should_skip_playback_session_reuse(filters: &ResolveFilters) -> bool {
    filters.source_filters.min_seeders > 0
        || !filters.source_filters.allowed_formats.is_empty()
        || filters.source_filters.source_language != SOURCE_LANGUAGE_FILTER_DEFAULT
        || filters.source_filters.source_audio_profile != SOURCE_AUDIO_PROFILE_DEFAULT
}

fn should_allow_latest_playback_session_fallback(filters: &ResolveFilters) -> bool {
    filters.source_hash.is_empty() && !should_skip_playback_session_reuse(filters)
}

fn playback_session_is_local_torrent(session: &PlaybackSession) -> bool {
    playback_session_resolver_provider(session) == ResolverProvider::LocalTorrent
        || session.playable_url.contains("/api/local-torrent/stream")
        || session.playable_url.contains("/api/local-cache/stream")
}

fn should_skip_unpinned_torrent_session_reuse(
    session: &PlaybackSession,
    filters: &ResolveFilters,
) -> bool {
    filters.source_hash.is_empty() && playback_session_is_local_torrent(session)
}

fn looks_like_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn build_playback_session_key(tmdb_id: &str, audio_lang: &str, quality: &str) -> String {
    format!(
        "{}:{}:{}",
        tmdb_id.trim(),
        normalize_preferred_audio_lang(audio_lang),
        normalize_preferred_stream_quality(quality)
    )
}

fn build_tv_playback_session_key(
    tmdb_id: &str,
    season_number: i64,
    episode_number: i64,
    audio_lang: &str,
    quality: &str,
) -> String {
    format!(
        "tv:{}:s{}:e{}:{}:{}",
        tmdb_id.trim(),
        season_number.max(1),
        episode_number.max(1),
        normalize_preferred_audio_lang(audio_lang),
        normalize_preferred_stream_quality(quality)
    )
}

fn build_playback_session_key_for_metadata(
    metadata: &ResolveMetadata,
    audio_lang: &str,
    quality: &str,
    resolver_provider: ResolverProvider,
) -> String {
    let key = if metadata.media_type == "tv" {
        build_tv_playback_session_key(
            &metadata.tmdb_id,
            metadata.season_number,
            metadata.episode_number,
            audio_lang,
            quality,
        )
    } else {
        build_playback_session_key(&metadata.tmdb_id, audio_lang, quality)
    };
    if resolver_provider == ResolverProvider::RealDebrid {
        key
    } else {
        format!("{}:{key}", resolver_provider.as_str())
    }
}

fn real_debrid_playback_session_prefix(user_id: i64) -> String {
    format!("real-debrid:user:{}:", user_id.max(0))
}

fn build_user_scoped_playback_session_key_for_metadata(
    metadata: &ResolveMetadata,
    audio_lang: &str,
    quality: &str,
    resolver_provider: ResolverProvider,
    user_id: i64,
) -> String {
    let base =
        build_playback_session_key_for_metadata(metadata, audio_lang, quality, resolver_provider);
    if resolver_provider == ResolverProvider::RealDebrid {
        format!("{}{base}", real_debrid_playback_session_prefix(user_id))
    } else {
        base
    }
}

fn playback_session_key_allowed_for_user(
    session_key: &str,
    resolver_provider: ResolverProvider,
    user_id: i64,
) -> bool {
    resolver_provider != ResolverProvider::RealDebrid
        || session_key.starts_with(&real_debrid_playback_session_prefix(user_id))
}

fn requested_playback_session_key_allowed(
    session_key: &str,
    resolver_provider: ResolverProvider,
    user_id: i64,
) -> bool {
    !session_key.trim().is_empty()
        && playback_session_key_allowed_for_user(session_key, resolver_provider, user_id)
}

fn build_playback_session_lookup_keys(
    metadata: &ResolveMetadata,
    audio_lang: &str,
    quality: &str,
    resolver_provider: ResolverProvider,
    user_id: i64,
) -> Vec<String> {
    vec![build_user_scoped_playback_session_key_for_metadata(
        metadata,
        audio_lang,
        quality,
        resolver_provider,
        user_id,
    )]
}

fn build_playback_session_payload(session: &PlaybackSession) -> Value {
    let resolver_provider = playback_session_resolver_provider(session);
    json!({
        "key": session.session_key.clone(),
        "sourceHash": session.source_hash.clone(),
        "selectedFile": session.selected_file.clone(),
        "quality": normalize_preferred_stream_quality(&session.preferred_quality),
        "resolverProvider": resolver_provider.as_str(),
        "lastPositionSeconds": session.last_position_seconds,
        "health": {
            "state": session.health_state.clone(),
            "failCount": session.health_fail_count,
            "lastError": session.last_error.clone()
        }
    })
}

fn build_pending_playback_session_payload(
    session_key: &str,
    source_hash: &str,
    selected_file: &str,
    preferred_quality: &str,
    resolver_provider: ResolverProvider,
) -> Value {
    json!({
        "key": session_key,
        "sourceHash": source_hash,
        "selectedFile": selected_file,
        "quality": normalize_preferred_stream_quality(preferred_quality),
        "resolverProvider": resolver_provider.as_str(),
        "lastPositionSeconds": 0,
        "health": {
            "state": "unknown",
            "failCount": 0,
            "lastError": ""
        }
    })
}

fn build_resolved_metadata_payload(
    metadata: &ResolveMetadata,
    resolved: &ResolvedSource,
    filename: &str,
) -> Value {
    let subtitle_target_file_path = resolved.selected_file_path.trim().to_owned();
    let subtitle_target_filename = normalize_whitespace(filename);
    let subtitle_target_name = if !subtitle_target_file_path.is_empty() {
        subtitle_target_file_path.clone()
    } else {
        subtitle_target_filename.clone()
    };
    json!({
        "tmdbId": metadata.tmdb_id.clone(),
        "imdbId": metadata.imdb_id.clone(),
        "displayTitle": metadata.display_title.clone(),
        "displayYear": metadata.display_year.clone(),
        "runtimeSeconds": metadata.runtime_seconds,
        "seasonNumber": metadata.season_number,
        "episodeNumber": metadata.episode_number,
        "episodeTitle": metadata.episode_title.clone(),
        "mediaType": metadata.media_type.clone(),
        "subtitleTargetName": subtitle_target_name,
        "subtitleTargetFilename": subtitle_target_filename,
        "subtitleTargetFilePath": subtitle_target_file_path
    })
}

fn playback_session_selected_file_path(session: &PlaybackSession) -> String {
    stringify_json(session.metadata.get("subtitleTargetFilePath"))
}

fn playback_session_match_name(session: &PlaybackSession) -> String {
    let selected_file_path = playback_session_selected_file_path(session);
    if !selected_file_path.is_empty() {
        selected_file_path
    } else {
        session.filename.clone()
    }
}

fn playback_session_matches_preferred_container(
    session: &PlaybackSession,
    filters: &ResolveFilters,
) -> bool {
    match normalize_preferred_container(&filters.preferred_container).as_str() {
        "mp4" => playback_session_looks_like_container(session, "mp4"),
        "mkv" => playback_session_looks_like_container(session, "mkv"),
        _ => true,
    }
}

fn playback_session_matches_preferred_quality(
    session: &PlaybackSession,
    preferences: &ResolvePreferences,
    filters: &ResolveFilters,
) -> bool {
    if !normalize_source_hash(&filters.source_hash).is_empty() {
        return true;
    }

    let preferred_quality = normalize_preferred_stream_quality(&preferences.quality);
    if preferred_quality == "auto" {
        return true;
    }

    let session_quality = normalize_preferred_stream_quality(&session.preferred_quality);
    if session_quality == preferred_quality {
        return true;
    }

    let target_height = stream_quality_target(&preferred_quality);
    if target_height == 0 {
        return true;
    }

    let source_input = extract_playable_source_input(&session.playable_url);
    let selected_file_path = playback_session_selected_file_path(session);
    let session_text = [
        source_input.as_str(),
        session.playable_url.as_str(),
        session.filename.as_str(),
        session.selected_file.as_str(),
        selected_file_path.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let session_height = parse_vertical_resolution_from_text(&session_text);
    session_height == 0 || session_height == target_height
}

fn playback_session_matches_resolver_provider(
    session: &PlaybackSession,
    resolver_provider: ResolverProvider,
) -> bool {
    playback_session_resolver_provider(session) == resolver_provider
}

fn playback_session_matches_real_debrid_scope(
    session: &PlaybackSession,
    resolver_provider: ResolverProvider,
    real_debrid: Option<&RealDebridRequestContext>,
) -> bool {
    if resolver_provider != ResolverProvider::RealDebrid {
        return true;
    }
    let Some(real_debrid) = real_debrid else {
        return false;
    };
    session
        .metadata
        .get(PLAYBACK_SESSION_CREDENTIAL_SCOPE_METADATA_KEY)
        .and_then(Value::as_str)
        == Some(real_debrid.cache_scope.as_str())
}

fn playback_session_resolver_provider(session: &PlaybackSession) -> ResolverProvider {
    normalize_resolver_provider(
        session
            .metadata
            .get("resolverProvider")
            .and_then(Value::as_str)
            .unwrap_or("real-debrid"),
    )
}

fn playback_session_looks_like_container(session: &PlaybackSession, container: &str) -> bool {
    let normalized_container = container.trim().trim_start_matches('.').to_lowercase();
    if normalized_container.is_empty() {
        return true;
    }
    let needle = format!(".{normalized_container}");
    let source_input = extract_playable_source_input(&session.playable_url);
    let selected_file_path = playback_session_selected_file_path(session);
    [
        source_input.as_str(),
        session.playable_url.as_str(),
        session.filename.as_str(),
        selected_file_path.as_str(),
    ]
    .iter()
    .any(|value| value.to_lowercase().contains(&needle))
}

fn playback_session_matches_source_hash(
    session: &PlaybackSession,
    filters: &ResolveFilters,
) -> bool {
    let requested_hash = normalize_source_hash(&filters.source_hash);
    requested_hash.is_empty() || normalize_source_hash(&session.source_hash) == requested_hash
}

fn does_filename_likely_match_movie(filename: &str, movie_title: &str, movie_year: &str) -> bool {
    let normalized_filename = normalize_text_for_match(filename);
    if normalized_filename.is_empty() {
        return true;
    }
    let title_tokens = tokenize_title_for_match(movie_title);
    if title_tokens.is_empty() {
        return true;
    }
    let expected_year = movie_year.trim();
    let year_matches_in_filename = FILENAME_YEAR_RE
        .find_iter(&normalized_filename)
        .map(|value| value.as_str().to_owned())
        .collect::<Vec<_>>();
    let has_expected_year = !expected_year.is_empty()
        && year_matches_in_filename
            .iter()
            .any(|value| value == expected_year);
    let has_conflicting_year =
        !expected_year.is_empty() && !year_matches_in_filename.is_empty() && !has_expected_year;
    let matched_token_count = count_matching_title_tokens(&normalized_filename, &title_tokens);
    let required_matches = if title_tokens.len() == 1 {
        1
    } else {
        title_tokens.len().min(2)
    };
    if matched_token_count >= required_matches {
        if expected_year.is_empty() {
            return true;
        }
        if has_expected_year {
            return true;
        }
        return !has_conflicting_year;
    }
    matched_token_count >= 1 && has_expected_year
}

fn does_filename_likely_match_tv_episode(
    filename: &str,
    show_title: &str,
    show_year: &str,
    season_number: i64,
    episode_number: i64,
) -> bool {
    let normalized_filename = normalize_text_for_match(filename);
    if normalized_filename.is_empty() {
        return true;
    }
    let target_signature = build_episode_signature(season_number, episode_number);
    let episode_signatures = collect_episode_signatures(&normalized_filename, Some(season_number));
    if !episode_signatures.is_empty() {
        return episode_signatures.contains(&target_signature);
    }
    let title_tokens = tokenize_title_for_match(show_title);
    if title_tokens.is_empty() {
        return true;
    }
    let expected_year = show_year.trim();
    let year_matches_in_filename = FILENAME_YEAR_RE
        .find_iter(&normalized_filename)
        .map(|value| value.as_str().to_owned())
        .collect::<Vec<_>>();
    let has_expected_year = !expected_year.is_empty()
        && year_matches_in_filename
            .iter()
            .any(|value| value == expected_year);
    let has_conflicting_year =
        !expected_year.is_empty() && !year_matches_in_filename.is_empty() && !has_expected_year;
    let matched_token_count = count_matching_title_tokens(&normalized_filename, &title_tokens);
    let required_matches = if title_tokens.len() == 1 {
        1
    } else {
        title_tokens.len().min(2)
    };
    if matched_token_count >= required_matches {
        if expected_year.is_empty() {
            return true;
        }
        if has_expected_year {
            return true;
        }
        return !has_conflicting_year;
    }
    matched_token_count >= 1 && has_expected_year
}

fn stream_candidate_match_name(stream: &DiscoveryStream) -> String {
    let filename = normalize_whitespace(&stream.behaviorHints.filename);
    if !filename.is_empty() {
        return filename;
    }
    if let Some(line) = extract_stream_title_lines(stream).first() {
        return line.clone();
    }
    let title = normalize_whitespace(&stream.title);
    if !title.is_empty() {
        return title;
    }
    let name = normalize_whitespace(&stream.name);
    if !name.is_empty() {
        return name;
    }
    normalize_whitespace(&stream.description)
}

fn prefer_movie_title_matched_candidates<'a>(
    streams: Vec<&'a DiscoveryStream>,
    metadata: &ResolveMetadata,
) -> Vec<&'a DiscoveryStream> {
    let matched = streams
        .iter()
        .copied()
        .filter(|stream| {
            does_filename_likely_match_movie(
                &stream_candidate_match_name(stream),
                &metadata.display_title,
                &metadata.display_year,
            )
        })
        .collect::<Vec<_>>();
    if matched.is_empty() { streams } else { matched }
}

fn prefer_episode_title_matched_candidates<'a>(
    streams: Vec<&'a DiscoveryStream>,
    metadata: &ResolveMetadata,
) -> Vec<&'a DiscoveryStream> {
    let matched = streams
        .iter()
        .copied()
        .filter(|stream| {
            does_filename_likely_match_tv_episode(
                &stream_candidate_match_name(stream),
                &metadata.display_title,
                &metadata.display_year,
                metadata.season_number,
                metadata.episode_number,
            )
        })
        .collect::<Vec<_>>();
    if matched.is_empty() { streams } else { matched }
}

fn should_force_remux_for_audio_compatibility(
    probe: &MediaProbe,
    preferred_audio_stream_index: i64,
) -> bool {
    if probe.audioTracks.is_empty() {
        return false;
    }
    if preferred_audio_stream_index >= 0 {
        return probe
            .audioTracks
            .iter()
            .find(|track| track.streamIndex == preferred_audio_stream_index)
            .map(|track| !is_browser_safe_audio_codec(&track.codec))
            .unwrap_or(true);
    }
    probe
        .audioTracks
        .iter()
        .find(|track| track.isDefault)
        .or_else(|| probe.audioTracks.first())
        .map(|track| !is_browser_safe_audio_codec(&track.codec))
        .unwrap_or(false)
}

fn select_resolved_track_indexes(
    tracks: &MediaProbe,
    preferences: &ResolvePreferences,
) -> (i64, i64) {
    let preferred_audio_track = choose_audio_track_from_probe(tracks, &preferences.audio_lang);
    let mut selected_audio_stream_index = if preferences.audio_lang != "auto" {
        preferred_audio_track
            .as_ref()
            .map(|track| track.streamIndex)
            .unwrap_or(-1)
    } else {
        -1
    };
    let selected_subtitle_stream_index =
        choose_subtitle_track_from_probe(tracks, &preferences.subtitle_lang)
            .map(|track| track.streamIndex)
            .unwrap_or(-1);
    if should_force_remux_for_audio_compatibility(tracks, selected_audio_stream_index)
        && selected_audio_stream_index < 0
    {
        selected_audio_stream_index = preferred_audio_track
            .as_ref()
            .map(|track| track.streamIndex)
            .unwrap_or_else(|| get_fallback_audio_stream_index(tracks));
    }
    (selected_audio_stream_index, selected_subtitle_stream_index)
}

fn get_fallback_audio_stream_index(probe: &MediaProbe) -> i64 {
    probe
        .audioTracks
        .iter()
        .find(|track| track.isDefault)
        .or_else(|| probe.audioTracks.first())
        .map(|track| track.streamIndex)
        .unwrap_or(-1)
}

fn is_browser_safe_audio_codec(codec: &str) -> bool {
    let normalized = codec.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if BROWSER_SAFE_AUDIO_CODECS.contains(&normalized.as_str()) {
        return true;
    }
    !BROWSER_UNSAFE_AUDIO_CODEC_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
}

fn is_likely_html5_playable_url(playable_url: &str, filename: &str) -> bool {
    let value = playable_url.to_lowercase();
    let normalized_filename = filename.to_lowercase();
    if value.is_empty() {
        return false;
    }
    if normalized_filename.ends_with(".mkv")
        || normalized_filename.ends_with(".avi")
        || normalized_filename.ends_with(".wmv")
        || normalized_filename.ends_with(".ts")
        || normalized_filename.ends_with(".m3u8")
    {
        return false;
    }
    ![".m3u8", ".mkv", ".avi", ".wmv", ".ts"]
        .iter()
        .any(|needle| value.contains(needle))
}

fn should_prefer_software_decode(source: &str) -> bool {
    let value = source.to_lowercase();
    [".mkv", ".avi", ".wmv", ".ts", ".m3u8"]
        .iter()
        .any(|needle| value.contains(needle))
}

fn should_prefer_software_decode_source(source: &str, filename: &str) -> bool {
    if should_prefer_software_decode(source) {
        return true;
    }
    let normalized_filename = filename.to_lowercase();
    if is_likely_html5_playable_url(source, &normalized_filename) {
        return false;
    }
    [".mkv", ".avi", ".wmv", ".ts", ".m3u8"]
        .iter()
        .any(|needle| normalized_filename.ends_with(needle))
}

fn is_playback_proxy_url(value: &str) -> bool {
    let raw = value.trim().to_lowercase();
    raw.starts_with("/api/remux?") || raw.starts_with("/api/hls/master.m3u8?")
}

#[derive(Debug, Clone)]
struct PlaybackProxyMeta {
    input: String,
    audio_stream_index: i64,
    subtitle_stream_index: i64,
}

fn parse_playback_proxy_url(value: &str) -> Option<PlaybackProxyMeta> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let url = url::Url::parse(raw)
        .or_else(|_| url::Url::parse(&format!("http://localhost{raw}")))
        .ok()?;
    if !matches!(url.path(), "/api/remux" | "/api/hls/master.m3u8") {
        return None;
    }
    let input = url
        .query_pairs()
        .find_map(|(key, value)| (key == "input").then(|| value.into_owned()))
        .unwrap_or_default();
    if input.trim().is_empty() {
        return None;
    }
    let audio_stream_index = url
        .query_pairs()
        .find_map(|(key, value)| (key == "audioStream").then(|| value.into_owned()))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let subtitle_stream_index = url
        .query_pairs()
        .find_map(|(key, value)| (key == "subtitleStream").then(|| value.into_owned()))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    Some(PlaybackProxyMeta {
        input,
        audio_stream_index,
        subtitle_stream_index,
    })
}

fn normalize_internal_subtitle_stream_index(value: i64) -> i64 {
    if value < 0 {
        return -1;
    }
    let safe = value;
    if safe >= EXTERNAL_SUBTITLE_STREAM_INDEX_BASE {
        -1
    } else {
        safe
    }
}

fn build_remux_proxy_url(
    input: &str,
    audio_stream_index: i64,
    subtitle_stream_index: i64,
) -> String {
    let normalized_input = input.trim();
    if normalized_input.is_empty() {
        return String::new();
    }
    let existing_meta = parse_playback_proxy_url(normalized_input);
    let resolved_audio_stream_index = if audio_stream_index >= 0 {
        audio_stream_index
    } else {
        existing_meta
            .as_ref()
            .map(|meta| meta.audio_stream_index)
            .unwrap_or(-1)
    };
    let requested_subtitle_stream_index =
        normalize_internal_subtitle_stream_index(subtitle_stream_index);
    let fallback_subtitle_stream_index = existing_meta
        .as_ref()
        .map(|meta| normalize_internal_subtitle_stream_index(meta.subtitle_stream_index))
        .unwrap_or(-1);
    let resolved_subtitle_stream_index = if requested_subtitle_stream_index >= 0 {
        requested_subtitle_stream_index
    } else {
        fallback_subtitle_stream_index
    };
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair(
        "input",
        existing_meta
            .as_ref()
            .map(|meta| meta.input.as_str())
            .unwrap_or(normalized_input),
    );
    if resolved_audio_stream_index >= 0 {
        serializer.append_pair("audioStream", &resolved_audio_stream_index.to_string());
    }
    if resolved_subtitle_stream_index >= 0 {
        serializer.append_pair(
            "subtitleStream",
            &resolved_subtitle_stream_index.to_string(),
        );
    }
    format!("/api/remux?{}", serializer.finish())
}

fn extract_playable_source_input(source_url: &str) -> String {
    parse_playback_proxy_url(source_url)
        .map(|meta| meta.input)
        .unwrap_or_else(|| source_url.trim().to_owned())
}

fn is_local_playback_session_url(value: &str) -> bool {
    let input = extract_playable_source_input(value);
    input.contains("/api/local-cache/stream") || input.contains("/api/local-torrent/stream")
}

fn should_defer_resolved_track_enrichment(
    resolver_provider: ResolverProvider,
    playable_url: &str,
) -> bool {
    resolver_provider == ResolverProvider::RealDebrid || is_local_playback_session_url(playable_url)
}

fn normalize_resolved_source_for_software_decode(
    source: &ResolvedSource,
    audio_stream_index: i64,
    subtitle_stream_index: i64,
) -> ResolvedSource {
    let mut normalized = source.clone();
    let current_playable = normalized.playable_url.trim().to_owned();
    if current_playable.is_empty() {
        return normalized;
    }
    if is_real_debrid_transcode_hls_url(&current_playable) {
        let existing_fallbacks = std::mem::take(&mut normalized.fallback_urls);
        for fallback in existing_fallbacks {
            if is_real_debrid_transcode_hls_url(&fallback) || is_playback_proxy_url(&fallback) {
                push_unique_url(&mut normalized.fallback_urls, &fallback);
                continue;
            }
            if should_prefer_software_decode_source(&fallback, &normalized.filename) {
                let remux_fallback = build_remux_proxy_url(
                    &fallback,
                    audio_stream_index,
                    normalize_internal_subtitle_stream_index(subtitle_stream_index),
                );
                push_unique_url(&mut normalized.fallback_urls, &remux_fallback);
                continue;
            }
            push_unique_url(&mut normalized.fallback_urls, &fallback);
            if is_real_debrid_download_url(&fallback) {
                let remux_fallback = build_remux_proxy_url(&fallback, -1, -1);
                push_unique_url(&mut normalized.fallback_urls, &remux_fallback);
            }
        }
        return normalized;
    }
    let has_explicit_audio_selection = audio_stream_index >= 0;
    let normalized_subtitle_stream_index =
        normalize_internal_subtitle_stream_index(subtitle_stream_index);
    let has_explicit_subtitle_selection = normalized_subtitle_stream_index >= 0;
    if !has_explicit_audio_selection
        && !has_explicit_subtitle_selection
        && !should_prefer_software_decode_source(&current_playable, &normalized.filename)
    {
        let remux_fallback = build_remux_proxy_url(
            &current_playable,
            audio_stream_index,
            normalized_subtitle_stream_index,
        );
        if (is_real_debrid_download_url(&current_playable)
            || is_local_playback_session_url(&current_playable))
            && !remux_fallback.is_empty()
        {
            if is_real_debrid_download_url(&current_playable) {
                let existing_fallbacks = std::mem::take(&mut normalized.fallback_urls);
                push_unique_url(&mut normalized.fallback_urls, &remux_fallback);
                for fallback in existing_fallbacks {
                    push_unique_url(&mut normalized.fallback_urls, &fallback);
                }
            } else {
                push_unique_url(&mut normalized.fallback_urls, &remux_fallback);
            }
        }
        return normalized;
    }
    let proxy_meta = if is_playback_proxy_url(&current_playable) {
        parse_playback_proxy_url(&current_playable)
    } else {
        None
    };
    let source_input = proxy_meta
        .as_ref()
        .map(|meta| meta.input.as_str())
        .unwrap_or(&current_playable);
    let preferred_remux = build_remux_proxy_url(
        source_input,
        audio_stream_index,
        normalized_subtitle_stream_index,
    );
    if preferred_remux.is_empty() {
        return normalized;
    }
    let mut next_fallbacks = Vec::new();
    let filename_hint = normalized.filename.clone();
    let push_browser_safe_fallback = |target: &mut Vec<String>, value: &str| {
        if is_playback_proxy_url(value) || is_likely_html5_playable_url(value, &filename_hint) {
            push_unique_url(target, value);
        }
    };
    push_browser_safe_fallback(&mut next_fallbacks, &current_playable);
    if source_input != current_playable {
        push_browser_safe_fallback(&mut next_fallbacks, source_input);
    }
    for url in &normalized.fallback_urls {
        if url != &preferred_remux {
            push_browser_safe_fallback(&mut next_fallbacks, url);
        }
    }
    normalized.playable_url = preferred_remux;
    normalized.fallback_urls = next_fallbacks;
    normalized
}

fn proxy_real_debrid_hls_for_browser(
    source: &ResolvedSource,
    live_hls_proxy_secret: &str,
) -> ResolvedSource {
    let mut proxied = source.clone();
    let upstream = proxied.playable_url.trim();
    if upstream.is_empty() || !is_real_debrid_transcode_hls_url(upstream) {
        return proxied;
    }
    let hls_relay = crate::live::build_trusted_external_embed_hls_playback_source(
        upstream,
        None,
        live_hls_proxy_secret,
    );
    let preferred_remux = proxied
        .fallback_urls
        .iter()
        .find(|url| is_remux_playback_url(url))
        .cloned();

    // Real-Debrid's Apple-HLS segment host can stall from datacenter egress
    // even when the manifest succeeds. The unrestricted download host is both
    // faster and more reliable from the Grok server, and /api/remux only copies
    // browser-supported video while normalizing audio into fragmented MP4.
    // Prefer that route immediately instead of spending a full fragment timeout
    // before falling back. Retain the signed byte relay as recovery, but never
    // expose the raw HLS URL to the browser's different egress.
    if let Some(remux) = preferred_remux {
        proxied.playable_url = remux.clone();
        proxied.fallback_urls.clear();
        push_unique_url(&mut proxied.fallback_urls, &hls_relay);
        for fallback in &source.fallback_urls {
            if fallback != &remux
                && !is_real_debrid_transcode_hls_url(fallback)
                && !is_remux_playback_url(fallback)
            {
                push_unique_url(&mut proxied.fallback_urls, fallback);
            }
        }
    } else {
        proxied.playable_url = hls_relay;
        proxied
            .fallback_urls
            .retain(|url| !is_real_debrid_transcode_hls_url(url));
    }
    proxied
}

fn is_remux_playback_url(value: &str) -> bool {
    let raw = value.trim();
    let Ok(url) =
        url::Url::parse(raw).or_else(|_| url::Url::parse(&format!("http://localhost{raw}")))
    else {
        return false;
    };
    url.path() == "/api/remux" && parse_playback_proxy_url(raw).is_some()
}

fn is_real_debrid_download_url(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_lowercase()))
        .map(|host| {
            host == "download.real-debrid.com" || host.ends_with(".download.real-debrid.com")
        })
        .unwrap_or(false)
}

fn push_unique_url(target: &mut Vec<String>, value: &str) {
    if value.trim().is_empty() || target.iter().any(|existing| existing == value) {
        return;
    }
    target.push(value.to_owned());
}

trait IfEmptyThen {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String;
}

impl IfEmptyThen for String {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests;
