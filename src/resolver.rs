use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use aes::Aes256;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use dashmap::DashMap;
use quick_xml::Reader;
use quick_xml::events::Event;
use regex::Regex;
use reqwest::header;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::{sleep, timeout};
use url::Url;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::local_torrent::{
    LocalTorrentResolveRequest, LocalTorrentResolvedSource, LocalTorrentService,
};
use crate::media::{
    MediaProbe, MediaService, choose_audio_track_from_probe, choose_subtitle_track_from_probe,
    merge_preferred_subtitle_tracks,
};
use crate::persistence::{Db, PersistPlaybackSessionInput, PlaybackSession, SourceHealthStats};
use crate::tmdb::TmdbService;
use crate::utils::now_ms;
use crate::utils::{
    normalize_preferred_audio_lang, normalize_preferred_stream_quality,
    normalize_subtitle_preference,
};

const REAL_DEBRID_API_BASE: &str = "https://api.real-debrid.com/rest/1.0";
const SOURCE_LANGUAGE_FILTER_DEFAULT: &str = "en";
const SOURCE_AUDIO_PROFILE_DEFAULT: &str = "single";
const RESOLVE_MAX_MS: i64 = 90_000;
const LOCAL_TORRENT_RESOLVE_MAX_MS: i64 = 40_000;
const FASTEST_RESOLVE_MAX_MS: i64 = 45_000;
#[cfg(test)]
const FASTEST_PARALLEL_CANDIDATES: usize = 4;
const FASTEST_CANDIDATE_POOL_LIMIT: usize = 40;
const PLAYABLE_URL_VALIDATE_TIMEOUT_MS: u64 = 8_000;
const TORRENTIO_REQUEST_TIMEOUT_MS: u64 = 65_000;
const TORRENTIO_REQUEST_MAX_ATTEMPTS: usize = 2;
const TORRENTIO_REQUEST_RETRY_DELAY_MS: u64 = 1_200;
const TORRENTIO_RETRY_MAX_ELAPSED_MS: i64 = 25_000;
const TORRENTIO_CACHE_MAX_AGE_DEFAULT_SECONDS: i64 = 60 * 60;
const TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS: i64 = 4 * 60 * 60;
const TORZNAB_CACHE_MAX_AGE_SECONDS: i64 = 30 * 60;
const TORZNAB_CACHE_STALE_WINDOW_SECONDS: i64 = 2 * 60 * 60;
const RD_TORRENT_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
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
static SEED_COUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*([0-9.,]+)").expect("valid seed regex"));
static STREAM_SIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"💾\s*([^\n⚙👤]+)").expect("valid stream size regex"));
static STREAM_RELEASE_GROUP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"⚙\s*([^\n👤]+)").expect("valid release group regex"));
static HXH_SEASON_EPISODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bs(?:eason\s*)?0*(\d{1,2})\s*[-_. ]?e(?:pisode\s*)?0*(\d{1,3})\b")
        .expect("valid episode regex")
});
static X_SEASON_EPISODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b0*(\d{1,2})x0*(\d{1,3})\b").expect("valid x episode regex"));
static EPISODE_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:e|ep|episode)\s*[-_. ]?0*(\d{1,3})\b").expect("valid episode-only regex")
});
static HMS_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b").expect("valid hms runtime regex")
});
static HOURS_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)\s*h(?:ours?)?\b").expect("valid hours runtime regex")
});
static MINUTES_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\b").expect("valid minutes runtime regex")
});
static COMPACT_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2})h(?:\s*|)(\d{1,2})m\b").expect("valid compact runtime regex")
});
static LOW_QUALITY_THEATRICAL_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:hdts|telesync|ts|telecine|tc|hdcam|camrip|cam)\b")
        .expect("valid low quality theatrical release regex")
});
static LOW_QUALITY_SCREENER_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:dvdscr|dvdscreener|screener|workprint)\b")
        .expect("valid low quality screener release regex")
});
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

#[derive(Clone)]
pub struct ResolverService {
    config: Config,
    db: Db,
    client: reqwest::Client,
    tmdb: TmdbService,
    media: MediaService,
    local_torrent: LocalTorrentService,
    resolve_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    resolve_metrics: Arc<ResolverMetrics>,
    external_resolver_permits: Arc<Semaphore>,
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
    external_queue_timeout_ms: u64,
    external_active: i64,
    external_started: i64,
    external_completed: i64,
    external_failed: i64,
    external_rejected: i64,
}

#[derive(Debug, Clone)]
struct ResolveMetadata {
    tmdb_id: String,
    imdb_id: String,
    display_title: String,
    display_year: String,
    runtime_seconds: i64,
    season_number: i64,
    episode_number: i64,
    episode_title: String,
    media_type: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Deserialize)]
struct DiscoveryStream {
    #[serde(default)]
    infoHash: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    behaviorHints: DiscoveryBehaviorHints,
    #[serde(default)]
    sources: Vec<String>,
    #[serde(default)]
    magnetUrl: String,
    #[serde(default)]
    discoveryProvider: String,
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
struct DiscoveryBehaviorHints {
    #[serde(default)]
    filename: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
struct SourceSummary {
    sourceHash: String,
    infoHash: String,
    provider: String,
    primary: String,
    filename: String,
    qualityLabel: String,
    container: String,
    seeders: i64,
    size: String,
    releaseGroup: String,
    score: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExternalEmbedProvider {
    id: &'static str,
    label: &'static str,
    priority: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExternalEmbedServer {
    id: &'static str,
    label: &'static str,
    quality_label: &'static str,
    detail_label: &'static str,
    priority: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExternalEmbedSource {
    provider: ExternalEmbedProvider,
    server: Option<ExternalEmbedServer>,
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
const ICEFY_HLS_RETRY_ATTEMPTS: usize = 3;
const ICEFY_HLS_RETRY_DELAY_MS: u64 = 900;

const EXTERNAL_EMBED_PROVIDERS: &[ExternalEmbedProvider] = &[
    ExternalEmbedProvider {
        id: "videasy",
        label: "VidEasy",
        priority: 5,
    },
    ExternalEmbedProvider {
        id: "vidlink",
        label: "VidLink",
        priority: 0,
    },
    ExternalEmbedProvider {
        id: "vidrock",
        label: "VidRock",
        priority: 1,
    },
    ExternalEmbedProvider {
        id: "notorrent",
        label: "NoTorrent",
        priority: 2,
    },
    ExternalEmbedProvider {
        id: "vixsrc",
        label: "VixSrc",
        priority: 3,
    },
    ExternalEmbedProvider {
        id: "lordflix",
        label: "LordFlix",
        priority: 4,
    },
    ExternalEmbedProvider {
        id: "icefy",
        label: "Icefy",
        priority: 6,
    },
];

const VIDEASY_EXTERNAL_EMBED_SERVERS: &[ExternalEmbedServer] = &[
    ExternalEmbedServer {
        id: "YORU",
        label: "Yoru",
        quality_label: "4K",
        detail_label: "Movies only, may have 4K",
        priority: 0,
    },
    ExternalEmbedServer {
        id: "NEON",
        label: "Neon",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 10,
    },
    ExternalEmbedServer {
        id: "CYPHER",
        label: "Cypher",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 11,
    },
    ExternalEmbedServer {
        id: "SAGE",
        label: "Sage",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 12,
    },
    ExternalEmbedServer {
        id: "BREACH",
        label: "Breach",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 13,
    },
    ExternalEmbedServer {
        id: "VYSE",
        label: "Vyse",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 14,
    },
    ExternalEmbedServer {
        id: "RAZE",
        label: "Raze",
        quality_label: "HLS",
        detail_label: "Portuguese audio",
        priority: 15,
    },
];

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
    live_hls_proxy_secret: &'a str,
}

#[derive(Clone)]
struct RealDebridRequestContext {
    api_key: String,
    cache_scope: String,
}

impl RealDebridRequestContext {
    fn for_user(user_id: i64, api_key: &str) -> Option<Self> {
        let normalized_api_key = api_key.trim();
        if normalized_api_key.is_empty() {
            return None;
        }
        Some(Self {
            api_key: normalized_api_key.to_owned(),
            cache_scope: format!("user:{}", user_id.max(0)),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolverProvider {
    RealDebrid,
    LocalTorrent,
    Fastest,
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
        tmdb: TmdbService,
        media: MediaService,
        local_torrent: LocalTorrentService,
    ) -> Self {
        let external_resolver_permits = Arc::new(Semaphore::new(config.resolver_max_concurrent));
        Self {
            config,
            db,
            client,
            tmdb,
            media,
            local_torrent,
            resolve_locks: Arc::new(DashMap::new()),
            resolve_metrics: Arc::new(ResolverMetrics::default()),
            external_resolver_permits,
        }
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

    async fn try_build_external_embed_payload(
        &self,
        metadata: &ResolveMetadata,
        source: ExternalEmbedSource,
        preferences: &ResolvePreferences,
        allow_native_fallback: bool,
        health_scores: &HashMap<String, i64>,
    ) -> Option<Value> {
        let mut external_guard = self.acquire_external_resolve_permit().await.ok()?;
        let payload =
            build_external_embed_resolved_playback_payload(ExternalEmbedPlaybackRequest {
                client: &self.client,
                db: &self.db,
                metadata,
                source,
                preferences,
                allow_native_fallback,
                health_scores,
                live_hls_proxy_secret: &self.config.live_hls_proxy_secret,
            })
            .await?;
        external_guard.mark_completed();
        Some(payload)
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
            let pinned_external_source =
                external_embed_source_for_source_hash(&metadata, &normalized_source_hash).is_some();
            if real_debrid.is_none() {
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
            let torrentio_result = self
                .fetch_torrentio_episode_streams(
                    &metadata.imdb_id,
                    metadata.season_number,
                    metadata.episode_number,
                )
                .await;
            let sources = match torrentio_result {
                Ok(streams) => {
                    let sources = self
                        .summarize_episode_sources_from_streams(
                            &streams,
                            &metadata,
                            &normalized_audio_lang,
                            &normalized_quality,
                            &normalized_container,
                            &normalized_source_hash,
                            normalized_limit as usize,
                            &source_filters,
                        )
                        .await?;
                    let pinned_missing = !pinned_external_source
                        && !normalized_source_hash.is_empty()
                        && !stream_list_contains_hash(&streams, &normalized_source_hash);
                    if should_try_torznab_discovery(
                        false,
                        sources.is_empty(),
                        pinned_missing,
                        false,
                    ) {
                        let torznab_streams =
                            match self.fetch_torznab_episode_streams(&metadata).await {
                                Ok(streams) => streams,
                                Err(torznab_error) => {
                                    if has_external_sources {
                                        Vec::new()
                                    } else {
                                        return Err(torznab_error);
                                    }
                                }
                            };
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
                            )
                            .await?;
                        if !torznab_sources.is_empty()
                            && (!pinned_missing
                                || stream_list_contains_hash(
                                    &torznab_streams,
                                    &normalized_source_hash,
                                ))
                        {
                            torznab_sources
                        } else {
                            sources
                        }
                    } else {
                        sources
                    }
                }
                Err(error) => {
                    let torznab_streams = match self.fetch_torznab_episode_streams(&metadata).await
                    {
                        Ok(streams) => streams,
                        Err(torznab_error) => {
                            if has_external_sources {
                                Vec::new()
                            } else {
                                return Err(torznab_error);
                            }
                        }
                    };
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
        let pinned_external_source =
            external_embed_source_for_source_hash(&metadata, &normalized_source_hash).is_some();
        if real_debrid.is_none() {
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
        let torrentio_result = self.fetch_torrentio_movie_streams(&metadata.imdb_id).await;
        let sources = match torrentio_result {
            Ok(streams) => {
                let sources = self
                    .summarize_movie_sources_from_streams(
                        &streams,
                        &metadata,
                        &normalized_audio_lang,
                        &normalized_quality,
                        &normalized_source_hash,
                        normalized_limit as usize,
                        &source_filters,
                    )
                    .await?;
                let pinned_missing = !pinned_external_source
                    && !normalized_source_hash.is_empty()
                    && !stream_list_contains_hash(&streams, &normalized_source_hash);
                if should_try_torznab_discovery(false, sources.is_empty(), pinned_missing, false) {
                    let torznab_streams = match self.fetch_torznab_movie_streams(&metadata).await {
                        Ok(streams) => streams,
                        Err(torznab_error) => {
                            if has_external_sources {
                                Vec::new()
                            } else {
                                return Err(torznab_error);
                            }
                        }
                    };
                    let torznab_sources = self
                        .summarize_movie_sources_from_streams(
                            &torznab_streams,
                            &metadata,
                            &normalized_audio_lang,
                            &normalized_quality,
                            &normalized_source_hash,
                            normalized_limit as usize,
                            &source_filters,
                        )
                        .await?;
                    if !torznab_sources.is_empty()
                        && (!pinned_missing
                            || stream_list_contains_hash(&torznab_streams, &normalized_source_hash))
                    {
                        torznab_sources
                    } else {
                        sources
                    }
                } else {
                    sources
                }
            }
            Err(error) => {
                let torznab_streams = match self.fetch_torznab_movie_streams(&metadata).await {
                    Ok(streams) => streams,
                    Err(torznab_error) => {
                        if has_external_sources {
                            Vec::new()
                        } else {
                            return Err(torznab_error);
                        }
                    }
                };
                let torznab_sources = self
                    .summarize_movie_sources_from_streams(
                        &torznab_streams,
                        &metadata,
                        &normalized_audio_lang,
                        &normalized_quality,
                        &normalized_source_hash,
                        normalized_limit as usize,
                        &source_filters,
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
    ) -> AppResult<Value> {
        self.resolve_metrics
            .movie_requests
            .fetch_add(1, Ordering::Relaxed);
        let resolver_provider = normalize_resolver_provider(resolver_provider);
        let real_debrid = RealDebridRequestContext::for_user(user_id, real_debrid_api_key);
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
        let lock = resolver_key_lock(&self.resolve_locks, &lock_key);
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
        self.resolve_movie_inner(
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
        )
        .await
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
        let pinned_external_source =
            external_embed_source_for_source_hash(&metadata, &filters.source_hash);
        let external_embed_only = real_debrid.is_none();
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
        let default_external_resolver_provider = if external_embed_only {
            ResolverProvider::Fastest
        } else {
            resolver_provider
        };
        if !effective_skip_external_embed
            && let Some(provider) = pinned_external_source
            && is_external_embed_hls_capable_source(provider)
        {
            let mut external_guard = self.acquire_external_resolve_permit().await?;
            if let Some(payload) =
                build_external_embed_resolved_playback_payload(ExternalEmbedPlaybackRequest {
                    client: &self.client,
                    db: &self.db,
                    metadata: &metadata,
                    source: provider,
                    preferences: &preferences,
                    allow_native_fallback: false,
                    health_scores: &external_health_scores,
                    live_hls_proxy_secret: &self.config.live_hls_proxy_secret,
                })
                .await
            {
                external_guard.mark_completed();
                return Ok(payload);
            }

            if !filters.source_hash.is_empty() && !external_embed_only {
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
                )
                .await
        {
            return Ok(payload);
        }
        if real_debrid.is_none() {
            return Err(external_embed_hls_unavailable_error());
        }
        if resolver_provider == ResolverProvider::LocalTorrent && !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
        let cache_reuse_provider = resolver_provider.cache_reuse_provider();
        if let Some(reused) = self
            .try_reuse_playback_session(
                user_id,
                &metadata,
                &preferences,
                &filters,
                cache_reuse_provider,
                session_key,
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
            Ok(streams) => {
                let health_scores = self.compute_source_health_scores(&streams).await?;
                let candidate_limit = if resolver_provider.is_fastest() {
                    FASTEST_CANDIDATE_POOL_LIMIT
                } else {
                    10
                };
                let candidates = select_top_movie_candidates(
                    &streams,
                    &metadata,
                    &preferences.audio_lang,
                    &preferences.quality,
                    &filters.source_hash,
                    candidate_limit,
                    &filters.source_filters,
                    &health_scores,
                );
                let pinned_missing = !filters.source_hash.is_empty()
                    && !stream_list_contains_hash(&streams, &filters.source_hash);
                if pinned_missing {
                    let torznab_streams = self.fetch_torznab_movie_streams(&metadata).await?;
                    if stream_list_contains_hash(&torznab_streams, &filters.source_hash) {
                        let health_scores =
                            self.compute_source_health_scores(&torznab_streams).await?;
                        let torznab_candidates = select_top_movie_candidates(
                            &torznab_streams,
                            &metadata,
                            &preferences.audio_lang,
                            &preferences.quality,
                            &filters.source_hash,
                            candidate_limit,
                            &filters.source_filters,
                            &health_scores,
                        );
                        if let Ok(result) = self
                            .resolve_movie_candidates(torznab_candidates, candidate_context)
                            .await
                        {
                            external_guard.mark_completed();
                            return Ok(result);
                        }
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

        let torznab_streams = self.fetch_torznab_movie_streams(&metadata).await?;
        if !torznab_streams.is_empty() {
            let health_scores = self.compute_source_health_scores(&torznab_streams).await?;
            let candidate_limit = if resolver_provider.is_fastest() {
                FASTEST_CANDIDATE_POOL_LIMIT
            } else {
                10
            };
            let torznab_candidates = select_top_movie_candidates(
                &torznab_streams,
                &metadata,
                &preferences.audio_lang,
                &preferences.quality,
                &filters.source_hash,
                candidate_limit,
                &filters.source_filters,
                &health_scores,
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
    ) -> AppResult<Value> {
        self.resolve_metrics
            .tv_requests
            .fetch_add(1, Ordering::Relaxed);
        let resolver_provider = normalize_resolver_provider(resolver_provider);
        let real_debrid = RealDebridRequestContext::for_user(user_id, real_debrid_api_key);
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
        let lock = resolver_key_lock(&self.resolve_locks, &lock_key);
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
        self.resolve_tv_inner(
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
        )
        .await
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
        let pinned_external_source =
            external_embed_source_for_source_hash(&metadata, &filters.source_hash);
        let external_embed_only = real_debrid.is_none();
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
        let default_external_resolver_provider = if external_embed_only {
            ResolverProvider::Fastest
        } else {
            resolver_provider
        };
        if !effective_skip_external_embed
            && let Some(provider) = pinned_external_source
            && is_external_embed_hls_capable_source(provider)
        {
            let mut external_guard = self.acquire_external_resolve_permit().await?;
            if let Some(payload) =
                build_external_embed_resolved_playback_payload(ExternalEmbedPlaybackRequest {
                    client: &self.client,
                    db: &self.db,
                    metadata: &metadata,
                    source: provider,
                    preferences: &preferences,
                    allow_native_fallback: false,
                    health_scores: &external_health_scores,
                    live_hls_proxy_secret: &self.config.live_hls_proxy_secret,
                })
                .await
            {
                external_guard.mark_completed();
                return Ok(payload);
            }

            if !filters.source_hash.is_empty() && !external_embed_only {
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
                )
                .await
        {
            return Ok(payload);
        }
        if real_debrid.is_none() {
            return Err(external_embed_hls_unavailable_error());
        }
        if resolver_provider == ResolverProvider::LocalTorrent && !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
        let cache_reuse_provider = resolver_provider.cache_reuse_provider();
        if let Some(reused) = self
            .try_reuse_playback_session(
                user_id,
                &metadata,
                &preferences,
                &filters,
                cache_reuse_provider,
                session_key,
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
            Ok(streams) => {
                let health_scores = self.compute_source_health_scores(&streams).await?;
                let candidate_limit = if resolver_provider.is_fastest() {
                    FASTEST_CANDIDATE_POOL_LIMIT
                } else {
                    10
                };
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
                );
                let pinned_missing = !filters.source_hash.is_empty()
                    && !stream_list_contains_hash(&streams, &filters.source_hash);
                if pinned_missing {
                    let torznab_streams = self.fetch_torznab_episode_streams(&metadata).await?;
                    if stream_list_contains_hash(&torznab_streams, &filters.source_hash) {
                        let health_scores =
                            self.compute_source_health_scores(&torznab_streams).await?;
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
                        );
                        if let Ok(result) = self
                            .resolve_episode_candidates(torznab_candidates, candidate_context)
                            .await
                        {
                            external_guard.mark_completed();
                            return Ok(result);
                        }
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

        let torznab_streams = self.fetch_torznab_episode_streams(&metadata).await?;
        if !torznab_streams.is_empty() {
            let health_scores = self.compute_source_health_scores(&torznab_streams).await?;
            let candidate_limit = if resolver_provider.is_fastest() {
                FASTEST_CANDIDATE_POOL_LIMIT
            } else {
                10
            };
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
                Ok(result) => result.and_then(|resolved| {
                    validate_resolved_movie_source(resolved, context.metadata)
                }),
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
        let Some(real_debrid) = real_debrid else {
            return Err(real_debrid_api_key_required_error());
        };
        let real_debrid_result = self
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
            .await;
        if !local_torrent_enabled {
            return real_debrid_result;
        }
        match real_debrid_result {
            Ok(result) => Ok(result),
            Err(real_debrid_error) => match self
                .resolve_movie_candidates_with_provider(
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
            {
                Ok(result) => Ok(result),
                Err(local_torrent_error) => Err(
                    if is_persistent_source_resolve_error(&local_torrent_error) {
                        local_torrent_error
                    } else {
                        real_debrid_error
                    },
                ),
            },
        }
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
                Ok(result) => result.and_then(|resolved| {
                    validate_resolved_episode_source(resolved, context.metadata)
                }),
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

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
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
        let Some(real_debrid) = real_debrid else {
            return Err(real_debrid_api_key_required_error());
        };
        let real_debrid_result = self
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
            .await;
        if !local_torrent_enabled {
            return real_debrid_result;
        }
        match real_debrid_result {
            Ok(result) => Ok(result),
            Err(real_debrid_error) => match self
                .resolve_episode_candidates_with_provider(
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
            {
                Ok(result) => Ok(result),
                Err(local_torrent_error) => Err(
                    if is_persistent_source_resolve_error(&local_torrent_error) {
                        local_torrent_error
                    } else {
                        real_debrid_error
                    },
                ),
            },
        }
    }

    async fn build_resolved_response(
        &self,
        resolved: ResolvedSource,
        metadata: ResolveMetadata,
        preferences: ResolvePreferences,
        resolver_provider: ResolverProvider,
        user_id: i64,
        include_session: bool,
    ) -> AppResult<Value> {
        let source_input = extract_playable_source_input(&resolved.playable_url);
        let tracks = match self.media.probe_media_tracks(&source_input).await {
            Ok(probe) => probe,
            Err(_) => MediaProbe {
                durationSeconds: metadata.runtime_seconds,
                ..MediaProbe::default()
            },
        };
        let mut tracks = tracks;
        let external_subtitle_tracks = self
            .media
            .search_opensubtitles_tracks(
                &metadata.imdb_id,
                &metadata.display_title,
                &metadata.display_year,
                &preferences.subtitle_lang,
                &resolved.filename,
            )
            .await;
        if !external_subtitle_tracks.is_empty() {
            tracks.subtitleTracks =
                merge_preferred_subtitle_tracks(external_subtitle_tracks, tracks.subtitleTracks);
        }
        let force_audio_stream_mapping = preferences.audio_lang != "auto";
        let preferred_audio_track = choose_audio_track_from_probe(&tracks, &preferences.audio_lang);
        let mut selected_audio_stream_index = if force_audio_stream_mapping {
            preferred_audio_track
                .as_ref()
                .map(|track| track.streamIndex)
                .unwrap_or(-1)
        } else {
            -1
        };
        let preferred_subtitle_track =
            choose_subtitle_track_from_probe(&tracks, &preferences.subtitle_lang);
        let selected_subtitle_stream_index = preferred_subtitle_track
            .as_ref()
            .map(|track| track.streamIndex)
            .unwrap_or(-1);
        if should_force_remux_for_audio_compatibility(&tracks, selected_audio_stream_index)
            && selected_audio_stream_index < 0
        {
            selected_audio_stream_index = preferred_audio_track
                .as_ref()
                .map(|track| track.streamIndex)
                .unwrap_or_else(|| get_fallback_audio_stream_index(&tracks));
        }
        let normalized = normalize_resolved_source_for_software_decode(
            &resolved,
            selected_audio_stream_index,
            selected_subtitle_stream_index,
        );

        let response_filename = if normalized.filename.is_empty() {
            resolved.filename.clone()
        } else {
            normalized.filename.clone()
        };
        let mut response_metadata =
            build_resolved_metadata_payload(&metadata, &resolved, &response_filename);
        response_metadata["resolverProvider"] = json!(resolver_provider.as_str());
        let response_source_hash = resolved.source_hash.clone();
        let response_selected_file = resolved.selected_file.clone();
        let response_selected_file_path = resolved.selected_file_path.clone();
        let response_audio_lang = preferences.audio_lang.clone();
        let response_subtitle_lang = preferences.subtitle_lang.clone();
        let response_quality = preferences.quality.clone();
        let mut payload = json!({
            "playableUrl": normalized.playable_url.clone(),
            "fallbackUrls": normalized.fallback_urls.clone(),
            "filename": response_filename.clone(),
            "sourceHash": response_source_hash.clone(),
            "selectedFile": response_selected_file.clone(),
            "selectedFilePath": response_selected_file_path.clone(),
            "resolverProvider": resolver_provider.as_str(),
            "sourceInput": source_input,
            "tracks": tracks,
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
                    self.db
                        .persist_playback_session(PersistPlaybackSessionInput {
                            session_key: session_key.clone(),
                            tmdb_id: metadata.tmdb_id.clone(),
                            audio_lang: response_audio_lang.clone(),
                            preferred_quality: response_quality.clone(),
                            source_hash: response_source_hash.clone(),
                            selected_file: response_selected_file.clone(),
                            filename: response_filename.clone(),
                            playable_url: normalized.playable_url.clone(),
                            fallback_urls: normalized.fallback_urls.clone(),
                            metadata: response_metadata.clone(),
                        })
                        .await?;
                    self.db
                        .get_playback_session(session_key.clone())
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
        real_debrid: Option<&RealDebridRequestContext>,
        local_torrent_enabled: bool,
    ) -> AppResult<ResolvedSource> {
        if resolver_provider.is_real_debrid() {
            let real_debrid = real_debrid.ok_or_else(real_debrid_api_key_required_error)?;
            return self
                .resolve_real_debrid_candidate_stream(stream, fallback_name, real_debrid)
                .await;
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
        let Some(session) = self.db.get_playback_session(session_key).await? else {
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
        json!({
            "ready": true,
            "playableUrl": resolved.playable_url,
            "sourceInput": extract_playable_source_input(&resolved.playable_url),
            "filename": resolved.filename,
            "sourceHash": resolved.source_hash,
            "selectedFile": resolved.selected_file,
            "resolverProvider": ResolverProvider::LocalTorrent.as_str(),
        })
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
                preferred_filename: stream.behaviorHints.filename.clone(),
                fallback_name: fallback_name.to_owned(),
            })
            .await?;
        Ok(local_torrent_resolved_source_to_resolved_source(resolved))
    }

    async fn resolve_real_debrid_candidate_stream(
        &self,
        stream: &DiscoveryStream,
        fallback_name: &str,
        real_debrid: &RealDebridRequestContext,
    ) -> AppResult<ResolvedSource> {
        let magnet = build_magnet_uri(stream, fallback_name)?;
        let info_hash = get_stream_info_hash(stream);
        if let Ok(Some(reusable_torrent_id)) = self
            .find_reusable_rd_torrent_by_hash(real_debrid, &info_hash)
            .await
        {
            match self
                .resolve_from_torrent_id(
                    real_debrid,
                    &reusable_torrent_id,
                    &info_hash,
                    stream,
                    fallback_name,
                )
                .await
            {
                Ok(resolved) => {
                    let _ = self
                        .set_cached_rd_torrent_id(real_debrid, &info_hash, &reusable_torrent_id)
                        .await;
                    return Ok(resolved);
                }
                Err(error) => {
                    if is_rd_selected_file_mismatch_error(&error) {
                        let _ = self
                            .safe_delete_torrent(real_debrid, &reusable_torrent_id)
                            .await;
                    }
                    let _ = self
                        .delete_cached_rd_torrent_id(real_debrid, &info_hash)
                        .await;
                }
            }
        }

        let mut last_error = None;
        for attempt in 0..2 {
            let add_magnet = self
                .rd_fetch_form(
                    real_debrid,
                    "/torrents/addMagnet",
                    reqwest::Method::POST,
                    &[("magnet", magnet.as_str())],
                    12_000,
                )
                .await?;
            let torrent_id = stringify_json(add_magnet.get("id"));
            if torrent_id.is_empty() {
                return Err(ApiError::internal(
                    "Real-Debrid did not return a torrent id.",
                ));
            }

            let result = self
                .resolve_from_torrent_id(
                    real_debrid,
                    &torrent_id,
                    &info_hash,
                    stream,
                    fallback_name,
                )
                .await;
            match result {
                Ok(resolved) => {
                    let _ = self
                        .set_cached_rd_torrent_id(real_debrid, &info_hash, &torrent_id)
                        .await;
                    return Ok(resolved);
                }
                Err(error) => {
                    let retry_after_stale_selected_file =
                        attempt == 0 && is_rd_selected_file_mismatch_error(&error);
                    let _ = self.safe_delete_torrent(real_debrid, &torrent_id).await;
                    let _ = self
                        .delete_cached_rd_torrent_id(real_debrid, &info_hash)
                        .await;
                    if retry_after_stale_selected_file {
                        last_error = Some(error);
                        continue;
                    }
                    return Err(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("Unable to resolve this source.")))
    }

    async fn resolve_from_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        torrent_id: &str,
        info_hash: &str,
        stream: &DiscoveryStream,
        fallback_name: &str,
    ) -> AppResult<ResolvedSource> {
        let info = self
            .rd_fetch_json(
                real_debrid,
                &format!("/torrents/info/{torrent_id}"),
                reqwest::Method::GET,
                12_000,
            )
            .await?;
        let files = info
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let file_ids = pick_video_file_ids(&files, &stream.behaviorHints.filename, fallback_name);
        if file_ids.is_empty() {
            return Err(ApiError::internal(
                "No supported video file was found in this torrent.",
            ));
        }
        let selected_file = file_ids[0].to_string();
        let selected_file_path = files
            .iter()
            .find(|file| file.get("id").and_then(Value::as_i64) == Some(file_ids[0]))
            .map(|file| stringify_json(file.get("path")))
            .unwrap_or_default();
        self.rd_fetch_form(
            real_debrid,
            &format!("/torrents/selectFiles/{torrent_id}"),
            reqwest::Method::POST,
            &[(
                "files",
                &file_ids
                    .iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            )],
            12_000,
        )
        .await?;

        let ready_info = self
            .wait_for_torrent_to_be_ready(real_debrid, torrent_id)
            .await?;
        if !ready_info_has_selected_file_id(&ready_info, file_ids[0]) {
            return Err(ApiError::internal(RD_SELECTED_FILE_MISMATCH_ERROR));
        }
        let download_links = ready_info
            .get("links")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        if download_links.is_empty() {
            return Err(ApiError::internal(
                "No Real-Debrid download link was generated.",
            ));
        }

        let mut filename = String::new();
        let mut verified_candidates = Vec::new();
        let mut uncertain_candidates = Vec::new();
        let mut last_error = None;
        for download_link in download_links {
            match self
                .resolve_playable_url_from_rd_link(real_debrid, &download_link)
                .await
            {
                Ok((playable_urls, resolved_filename)) => {
                    if filename.is_empty() {
                        filename = resolved_filename.clone();
                    }
                    let filename_hint = if !filename.is_empty() {
                        filename.clone()
                    } else if !selected_file_path.is_empty() {
                        selected_file_path.clone()
                    } else {
                        resolved_filename
                    };
                    let mut ranked_urls = playable_urls
                        .into_iter()
                        .filter(|url| !url.trim().is_empty())
                        .collect::<Vec<_>>();
                    ranked_urls.sort_by(|left, right| {
                        let left_stable = left.contains("download.real-debrid.com");
                        let right_stable = right.contains("download.real-debrid.com");
                        right_stable.cmp(&left_stable)
                    });
                    if ranked_urls.is_empty()
                        && is_supported_resolved_container_path(&filename_hint)
                    {
                        last_error = Some(ApiError::internal(
                            "No playable Real-Debrid stream URL was available.",
                        ));
                    }
                    for playable_url in ranked_urls {
                        if verified_candidates.contains(&playable_url)
                            || uncertain_candidates.contains(&playable_url)
                        {
                            continue;
                        }
                        match self
                            .verify_playable_url(&playable_url, PLAYABLE_URL_VALIDATE_TIMEOUT_MS)
                            .await
                        {
                            Ok(PlayableUrlVerification::Verified) => {
                                verified_candidates.push(playable_url)
                            }
                            Ok(PlayableUrlVerification::Uncertain) => {
                                uncertain_candidates.push(playable_url)
                            }
                            Err(error) => last_error = Some(error),
                        }
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }

        let ranked_candidates = verified_candidates
            .into_iter()
            .chain(uncertain_candidates)
            .collect::<Vec<_>>();
        if ranked_candidates.is_empty() {
            return Err(last_error.unwrap_or_else(|| {
                ApiError::internal("No playable Real-Debrid stream URL was available.")
            }));
        }

        let playable_url = ranked_candidates[0].clone();
        let resolved = ResolvedSource {
            playable_url,
            fallback_urls: ranked_candidates.into_iter().skip(1).collect(),
            filename: if filename.is_empty() {
                selected_file_path.clone()
            } else {
                filename
            },
            source_hash: info_hash.to_owned(),
            selected_file,
            selected_file_path,
        };
        Ok(resolved)
    }

    async fn find_reusable_rd_torrent_by_hash(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
    ) -> AppResult<Option<String>> {
        let normalized_hash = normalize_source_hash(info_hash);
        if normalized_hash.is_empty() {
            return Ok(None);
        }

        if let Some(cached_torrent_id) = self
            .get_cached_rd_torrent_id(real_debrid, &normalized_hash)
            .await?
        {
            return Ok(Some(cached_torrent_id));
        }

        for page in 1..=4 {
            let payload = self
                .rd_fetch_json(
                    real_debrid,
                    &format!("/torrents?page={page}"),
                    reqwest::Method::GET,
                    10_000,
                )
                .await?;
            let Some(items) = payload.as_array() else {
                break;
            };
            if items.is_empty() {
                break;
            }
            if let Some(torrent_id) = items.iter().find_map(|item| {
                let hash = stringify_json(item.get("hash"));
                let torrent_id = stringify_json(item.get("id"));
                (hash == normalized_hash && !torrent_id.is_empty()).then_some(torrent_id)
            }) {
                let _ = self
                    .set_cached_rd_torrent_id(real_debrid, &normalized_hash, &torrent_id)
                    .await;
                return Ok(Some(torrent_id));
            }
        }
        Ok(None)
    }

    async fn get_cached_rd_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
    ) -> AppResult<Option<String>> {
        let cache_key = build_scoped_rd_torrent_cache_key(&real_debrid.cache_scope, info_hash);
        let Some((payload, _)) = self.db.get_movie_quick_start_cache(cache_key).await? else {
            return Ok(None);
        };
        let torrent_id = stringify_json(payload.get("torrentId"));
        if torrent_id.is_empty() {
            return Ok(None);
        }
        Ok(Some(torrent_id))
    }

    async fn set_cached_rd_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
        torrent_id: &str,
    ) -> AppResult<()> {
        let normalized_hash = normalize_source_hash(info_hash);
        let normalized_torrent_id = torrent_id.trim();
        if normalized_hash.is_empty() || normalized_torrent_id.is_empty() {
            return Ok(());
        }
        self.db
            .set_movie_quick_start_cache(
                build_scoped_rd_torrent_cache_key(&real_debrid.cache_scope, &normalized_hash),
                json!({
                    "infoHash": normalized_hash,
                    "torrentId": normalized_torrent_id
                }),
                now_ms() + RD_TORRENT_CACHE_TTL_MS,
            )
            .await
    }

    async fn delete_cached_rd_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
    ) -> AppResult<()> {
        let normalized_hash = normalize_source_hash(info_hash);
        if normalized_hash.is_empty() {
            return Ok(());
        }
        self.db
            .delete_movie_quick_start_cache(build_scoped_rd_torrent_cache_key(
                &real_debrid.cache_scope,
                &normalized_hash,
            ))
            .await
    }

    async fn record_source_resolve_failure(&self, stream: &DiscoveryStream, error: &ApiError) {
        if !is_persistent_source_resolve_error(error) {
            return;
        }
        let source_hash = get_stream_info_hash(stream);
        if source_hash.is_empty() {
            return;
        }
        let message = error
            .message()
            .unwrap_or("Source failed during resolve.")
            .to_owned();
        let _ = self
            .db
            .record_source_health_event(source_hash, "playback_error".to_owned(), message)
            .await;
    }

    async fn wait_for_torrent_to_be_ready(
        &self,
        real_debrid: &RealDebridRequestContext,
        torrent_id: &str,
    ) -> AppResult<Value> {
        let started_at = now_ms();
        let mut last_status = "pending".to_owned();
        while now_ms() - started_at < 18_000 {
            let info = self
                .rd_fetch_json(
                    real_debrid,
                    &format!("/torrents/info/{torrent_id}"),
                    reqwest::Method::GET,
                    12_000,
                )
                .await?;
            let status = stringify_json(info.get("status")).to_lowercase();
            if !status.is_empty() {
                last_status = status.clone();
            }
            let has_links = info
                .get("links")
                .and_then(Value::as_array)
                .map(|values| !values.is_empty())
                .unwrap_or(false);
            if status == "downloaded" && has_links {
                return Ok(info);
            }
            if TORRENT_FATAL_STATUSES.contains(&status.as_str()) {
                return Err(ApiError::internal(format!(
                    "Real-Debrid torrent failed ({status})."
                )));
            }
            sleep(Duration::from_millis(1_200)).await;
        }
        Err(ApiError::internal(format!(
            "Timed out waiting for cached source ({last_status})."
        )))
    }

    async fn resolve_playable_url_from_rd_link(
        &self,
        real_debrid: &RealDebridRequestContext,
        rd_link: &str,
    ) -> AppResult<(Vec<String>, String)> {
        let unrestricted = self
            .rd_fetch_form(
                real_debrid,
                "/unrestrict/link",
                reqwest::Method::POST,
                &[("link", rd_link)],
                12_000,
            )
            .await?;
        let download = stringify_json(unrestricted.get("download"));
        if download.is_empty() {
            return Err(ApiError::internal(
                "Real-Debrid returned no downloadable link.",
            ));
        }
        Ok((vec![download], stringify_json(unrestricted.get("filename"))))
    }

    async fn verify_playable_url(
        &self,
        playable_url: &str,
        timeout_ms: u64,
    ) -> AppResult<PlayableUrlVerification> {
        if playable_url.trim().is_empty() {
            return Err(ApiError::internal("Resolved stream URL is empty."));
        }
        let response = self
            .client
            .head(playable_url)
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => Ok(PlayableUrlVerification::Verified),
            Ok(response)
                if matches!(response.status().as_u16(), 401 | 403 | 404)
                    || response.status().is_server_error() =>
            {
                Err(ApiError::internal(format!(
                    "Resolved stream is unavailable ({}).",
                    response.status().as_u16()
                )))
            }
            Ok(_) => Ok(PlayableUrlVerification::Uncertain),
            Err(error) if error.is_timeout() => Ok(PlayableUrlVerification::Uncertain),
            Err(_) => Ok(PlayableUrlVerification::Uncertain),
        }
    }

    async fn rd_fetch_json(
        &self,
        real_debrid: &RealDebridRequestContext,
        path: &str,
        method: reqwest::Method,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        self.rd_fetch(real_debrid, path, method, None, timeout_ms)
            .await
    }

    async fn rd_fetch_form(
        &self,
        real_debrid: &RealDebridRequestContext,
        path: &str,
        method: reqwest::Method,
        form: &[(&str, &str)],
        timeout_ms: u64,
    ) -> AppResult<Value> {
        self.rd_fetch(real_debrid, path, method, Some(form), timeout_ms)
            .await
    }

    async fn rd_fetch(
        &self,
        real_debrid: &RealDebridRequestContext,
        path: &str,
        method: reqwest::Method,
        form: Option<&[(&str, &str)]>,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        if real_debrid.api_key.trim().is_empty() {
            return Err(ApiError::internal("Real-Debrid API key is not configured."));
        }
        let mut builder = self
            .client
            .request(method, format!("{REAL_DEBRID_API_BASE}{path}"))
            .bearer_auth(real_debrid.api_key.clone())
            .timeout(Duration::from_millis(timeout_ms));
        if let Some(form) = form {
            builder = builder.form(form);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| map_reqwest_error(error, "Real-Debrid request timed out."))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|_| ApiError::bad_gateway("Real-Debrid response could not be read."))?;
        let payload = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| {
            json!({
                "message": body
            })
        });
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .unwrap_or("Real-Debrid request failed.");
            let user_message = user_facing_real_debrid_error(message);
            if is_real_debrid_blocked_source_message(&user_message) {
                return Err(ApiError::failed_dependency(user_message));
            }
            return Err(ApiError::bad_gateway(user_message));
        }
        Ok(payload)
    }

    async fn safe_delete_torrent(
        &self,
        real_debrid: &RealDebridRequestContext,
        torrent_id: &str,
    ) -> AppResult<()> {
        if torrent_id.trim().is_empty() {
            return Ok(());
        }
        let _ = self
            .rd_fetch_json(
                real_debrid,
                &format!("/torrents/delete/{torrent_id}"),
                reqwest::Method::DELETE,
                5_000,
            )
            .await;
        Ok(())
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

    async fn try_reuse_playback_session(
        &self,
        user_id: i64,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        filters: &ResolveFilters,
        resolver_provider: ResolverProvider,
        requested_session_key: &str,
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
            if let Some(candidate) = self.db.get_playback_session(session_key).await? {
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

        let verifiable_url = extract_playable_source_input(&session.playable_url);
        let needs_revalidation = session.next_validation_at > 0
            && session.next_validation_at <= now_ms()
            && looks_like_http_url(&verifiable_url);
        if needs_revalidation {
            if self
                .verify_playable_url(&verifiable_url, 3_000)
                .await
                .is_err()
            {
                self.invalidate_playback_session(
                    &session,
                    "Playback session validation failed for the stored stream URL.",
                )
                .await;
                return Ok(None);
            }
            let _ = self
                .db
                .refresh_playback_session_validation_window(session.session_key.clone())
                .await;
        }

        self.build_resolved_response(
            ResolvedSource {
                playable_url: session.playable_url.clone(),
                fallback_urls: session.fallback_urls.clone(),
                filename: session.filename.clone(),
                source_hash: session.source_hash.clone(),
                selected_file: session.selected_file.clone(),
                selected_file_path: playback_session_selected_file_path(&session),
            },
            metadata.clone(),
            preferences.clone(),
            resolver_provider,
            user_id,
            true,
        )
        .await
        .map(Some)
    }

    async fn try_reuse_latest_healthy_playback_session(
        &self,
        user_id: i64,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        filters: &ResolveFilters,
        resolver_provider: ResolverProvider,
    ) -> AppResult<Option<Value>> {
        if !self.config.playback_sessions_enabled || metadata.tmdb_id.trim().is_empty() {
            return Ok(None);
        }

        let sessions = self
            .db
            .get_latest_healthy_playback_sessions_for_tmdb(metadata.tmdb_id.clone(), 20)
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

            let verifiable_url = extract_playable_source_input(&session.playable_url);
            let needs_revalidation = session.next_validation_at > 0
                && session.next_validation_at <= now_ms()
                && looks_like_http_url(&verifiable_url);
            if needs_revalidation {
                if self
                    .verify_playable_url(&verifiable_url, 3_000)
                    .await
                    .is_err()
                {
                    self.invalidate_playback_session(
                        &session,
                        "Playback session validation failed for the stored stream URL.",
                    )
                    .await;
                    continue;
                }
                let _ = self
                    .db
                    .refresh_playback_session_validation_window(session.session_key.clone())
                    .await;
            }

            return self
                .build_resolved_response(
                    ResolvedSource {
                        playable_url: session.playable_url.clone(),
                        fallback_urls: session.fallback_urls.clone(),
                        filename: session.filename.clone(),
                        source_hash: session.source_hash.clone(),
                        selected_file: session.selected_file.clone(),
                        selected_file_path: playback_session_selected_file_path(&session),
                    },
                    metadata.clone(),
                    preferences.clone(),
                    resolver_provider,
                    user_id,
                    true,
                )
                .await
                .map(Some);
        }

        Ok(None)
    }

    async fn invalidate_playback_session(&self, session: &PlaybackSession, reason: &str) {
        let _ = self
            .db
            .update_playback_session_progress(
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
        let url = format!("{}{}", self.config.torrentio_base_url, path);
        let cache_key = build_torrentio_stream_cache_key(&self.config.torrentio_base_url, path);
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
        match self.fetch_torznab_streams(&primary_params).await {
            Ok(streams) if !streams.is_empty() => Ok(streams),
            Ok(_) => self.fetch_torznab_streams(&search_params).await,
            Err(primary_error) => match self.fetch_torznab_streams(&search_params).await {
                Ok(streams) if !streams.is_empty() => Ok(streams),
                _ => Err(primary_error),
            },
        }
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
        match self.fetch_torznab_streams(&primary_params).await {
            Ok(streams) if !streams.is_empty() => Ok(streams),
            Ok(_) => self.fetch_torznab_streams(&search_params).await,
            Err(primary_error) => match self.fetch_torznab_streams(&search_params).await {
                Ok(streams) if !streams.is_empty() => Ok(streams),
                _ => Err(primary_error),
            },
        }
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
            return parse_torznab_streams_payload(payload);
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
                        return parse_torznab_streams_payload(&payload);
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
                parse_torznab_streams_payload(&payload)
            }
            Err(error) => {
                if let Some((payload, expires_at, _)) = cached
                    && expires_at > now_ms()
                {
                    return parse_torznab_streams_payload(&payload);
                }
                Err(map_reqwest_error(error, "Torznab request timed out."))
            }
        }
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
                score += compute_external_embed_rank_health_score(&stats);
            }
            scores.insert(source_hash, score);
        }
        Ok(scores)
    }
}

#[derive(Debug, Clone)]
struct SourceFilters {
    min_seeders: i64,
    allowed_formats: Vec<String>,
    source_language: String,
    source_audio_profile: String,
}

fn resolver_key_lock(map: &DashMap<String, Arc<Mutex<()>>>, key: &str) -> Arc<Mutex<()>> {
    map.entry(key.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
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
    }
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

#[allow(clippy::too_many_arguments)]
fn select_top_movie_candidates<'a>(
    streams: &'a [DiscoveryStream],
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_hash: &str,
    limit: usize,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let ranked_pool = streams
        .iter()
        .filter(|stream| !get_stream_info_hash(stream).is_empty())
        .collect::<Vec<_>>();
    let filtered_pool = apply_source_stream_filters(ranked_pool, source_filters);
    if filtered_pool.is_empty() {
        return Vec::new();
    }
    let title_filtered = prefer_movie_title_matched_candidates(filtered_pool, metadata);
    let quality_filtered = filter_streams_by_quality_preference(title_filtered, preferred_quality);
    let sorted = sort_movie_candidates(
        quality_filtered,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    let capped = sorted
        .iter()
        .copied()
        .take(limit.max(1))
        .collect::<Vec<_>>();
    let selected = prioritize_candidates_by_source_hash(capped, sorted.clone(), source_hash, limit);
    apply_mp4_default_candidate_rule(
        selected,
        sorted,
        source_hash,
        limit,
        &source_filters.source_language,
        health_scores,
    )
}

#[allow(clippy::too_many_arguments)]
fn select_top_episode_candidates<'a>(
    streams: &'a [DiscoveryStream],
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    preferred_container: &str,
    source_hash: &str,
    limit: usize,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let ranked_pool = streams
        .iter()
        .filter(|stream| !get_stream_info_hash(stream).is_empty())
        .collect::<Vec<_>>();
    let filtered_pool = apply_source_stream_filters(ranked_pool, source_filters);
    if filtered_pool.is_empty() {
        return Vec::new();
    }
    let episode_filtered = prefer_episode_title_matched_candidates(filtered_pool, metadata);
    let quality_filtered =
        filter_streams_by_quality_preference(episode_filtered, preferred_quality);
    let sorted = sort_episode_candidates(
        quality_filtered,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    let selected = prioritize_candidates_by_source_hash(
        sorted
            .iter()
            .copied()
            .take(limit.max(1))
            .collect::<Vec<_>>(),
        sorted.clone(),
        source_hash,
        limit,
    );
    if should_prefer_mp4_episode_candidate(preferred_container, source_hash) {
        apply_mp4_default_candidate_rule(
            selected,
            sorted,
            source_hash,
            limit,
            &source_filters.source_language,
            health_scores,
        )
    } else {
        selected
    }
}

#[cfg(test)]
fn select_fastest_race_candidates(candidates: Vec<&DiscoveryStream>) -> Vec<&DiscoveryStream> {
    let safe_limit = FASTEST_PARALLEL_CANDIDATES.max(1);
    let mut selected = Vec::new();
    let mut seen_hashes = HashSet::new();
    for candidate in candidates.iter().copied().take(2) {
        push_unique_candidate(&mut selected, &mut seen_hashes, candidate);
        if selected.len() >= safe_limit {
            return selected;
        }
    }

    let mut local_friendly = candidates.clone();
    local_friendly.sort_by(|left, right| {
        let right_score = score_fastest_local_candidate(right);
        let left_score = score_fastest_local_candidate(left);
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    for candidate in local_friendly {
        push_unique_candidate(&mut selected, &mut seen_hashes, candidate);
        if selected.len() >= safe_limit {
            return selected;
        }
    }

    for candidate in candidates {
        push_unique_candidate(&mut selected, &mut seen_hashes, candidate);
        if selected.len() >= safe_limit {
            break;
        }
    }
    selected
}

#[cfg(test)]
fn score_fastest_local_candidate(stream: &DiscoveryStream) -> i64 {
    let seed_count = parse_seed_count(if stream.title.is_empty() {
        stream.name.as_str()
    } else {
        stream.title.as_str()
    });
    let size_bytes = parse_stream_size_bytes(stream);
    let mut score = if seed_count > 0 {
        (((seed_count + 1) as f64).log10() * 900.0).round() as i64
    } else {
        0
    };

    if size_bytes > 0 {
        let size_gb = size_bytes as f64 / 1_073_741_824.0;
        score += if size_gb <= 1.5 {
            600
        } else if size_gb <= 3.5 {
            1_100
        } else if size_gb <= 6.0 {
            800
        } else if size_gb <= 10.0 {
            250
        } else {
            -((size_gb - 10.0) * 85.0).round() as i64
        };
    }
    if is_stream_likely_container(stream, "mp4") {
        score += 550;
    }
    score + score_stream_release_quality(stream)
}

fn should_prefer_mp4_episode_candidate(preferred_container: &str, source_hash: &str) -> bool {
    match normalize_preferred_container(preferred_container).as_str() {
        "mp4" => true,
        "mkv" => false,
        _ => normalize_source_hash(source_hash).is_empty(),
    }
}

fn summarize_stream_candidate_for_client(
    stream: &DiscoveryStream,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Option<SourceSummary> {
    let info_hash = get_stream_info_hash(stream);
    if info_hash.is_empty() {
        return None;
    }
    let title_lines = extract_stream_title_lines(stream);
    let filename = stream.behaviorHints.filename.trim().to_owned();
    let primary = if !filename.is_empty() {
        filename.clone()
    } else if let Some(line) = title_lines.first() {
        line.clone()
    } else if !stream.name.trim().is_empty() {
        stream.name.trim().to_owned()
    } else {
        "Source".to_owned()
    };
    let provider = normalize_whitespace(&stream.name);
    let seeders = parse_seed_count(stream.title.as_str()).max(0);
    let resolution = parse_stream_vertical_resolution(stream);
    let container = infer_stream_container_label(stream);
    let mut score = score_stream_quality(
        stream,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    if metadata.episode_number > 0 {
        score +=
            score_stream_episode_match(stream, metadata.season_number, metadata.episode_number);
    }
    Some(SourceSummary {
        sourceHash: info_hash.clone(),
        infoHash: info_hash,
        provider,
        primary,
        filename,
        qualityLabel: if resolution > 0 {
            format!("{resolution}p")
        } else {
            String::new()
        },
        container,
        seeders,
        size: extract_stream_size_label(stream),
        releaseGroup: extract_stream_release_group(stream),
        score,
    })
}

fn apply_source_stream_filters<'a>(
    streams: Vec<&'a DiscoveryStream>,
    source_filters: &SourceFilters,
) -> Vec<&'a DiscoveryStream> {
    let effective_allowed_formats = if source_filters.allowed_formats.is_empty() {
        DEFAULT_ALLOWED_SOURCE_FORMATS
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    } else {
        source_filters.allowed_formats.clone()
    };
    let allowed_format_set = effective_allowed_formats
        .into_iter()
        .collect::<HashSet<_>>();
    streams
        .into_iter()
        .filter(|stream| {
            if source_filters.min_seeders > 0
                && parse_seed_count(if stream.title.is_empty() {
                    stream.name.as_str()
                } else {
                    stream.title.as_str()
                }) < source_filters.min_seeders
            {
                return false;
            }
            let container = infer_stream_container_label(stream);
            if container.is_empty() || !allowed_format_set.contains(&container) {
                return false;
            }
            if source_filters.source_language != "any"
                && !matches_source_language_filter(stream, &source_filters.source_language)
            {
                return false;
            }
            true
        })
        .collect()
}

fn filter_streams_by_quality_preference<'a>(
    streams: Vec<&'a DiscoveryStream>,
    preferred_quality: &str,
) -> Vec<&'a DiscoveryStream> {
    let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
    if normalized_quality == "auto" {
        return streams;
    }
    let target_height = stream_quality_target(&normalized_quality);
    if target_height == 0 {
        return streams;
    }

    let exact_matches = streams
        .iter()
        .copied()
        .filter(|stream| parse_stream_vertical_resolution(stream) == target_height)
        .collect::<Vec<_>>();
    if !exact_matches.is_empty() {
        return exact_matches;
    }

    let lower_or_equal = streams
        .iter()
        .copied()
        .filter(|stream| {
            let height = parse_stream_vertical_resolution(stream);
            height > 0 && height <= target_height
        })
        .collect::<Vec<_>>();
    if !lower_or_equal.is_empty() {
        return lower_or_equal;
    }

    let higher = streams
        .iter()
        .copied()
        .filter(|stream| parse_stream_vertical_resolution(stream) > target_height)
        .collect::<Vec<_>>();
    if !higher.is_empty() {
        return higher;
    }

    streams
}

fn sort_movie_candidates<'a>(
    streams: Vec<&'a DiscoveryStream>,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let mut sorted = streams;
    sorted.sort_by(|left, right| {
        let right_score = score_stream_quality(
            right,
            metadata,
            preferred_audio_lang,
            preferred_quality,
            source_filters,
            health_scores,
        );
        let left_score = score_stream_quality(
            left,
            metadata,
            preferred_audio_lang,
            preferred_quality,
            source_filters,
            health_scores,
        );
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    sorted
}

fn sort_episode_candidates<'a>(
    streams: Vec<&'a DiscoveryStream>,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let mut sorted = streams;
    sorted.sort_by(|left, right| {
        let right_score =
            score_stream_quality(
                right,
                metadata,
                preferred_audio_lang,
                preferred_quality,
                source_filters,
                health_scores,
            ) + score_stream_episode_match(right, metadata.season_number, metadata.episode_number);
        let left_score =
            score_stream_quality(
                left,
                metadata,
                preferred_audio_lang,
                preferred_quality,
                source_filters,
                health_scores,
            ) + score_stream_episode_match(left, metadata.season_number, metadata.episode_number);
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    sorted
}

fn score_stream_quality(
    stream: &DiscoveryStream,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> i64 {
    score_stream_language_preference(stream, preferred_audio_lang)
        + score_stream_source_audio_profile(
            stream,
            &source_filters.source_language,
            &source_filters.source_audio_profile,
        )
        + score_stream_quality_preference(stream, preferred_quality)
        + score_stream_title_year_match(stream, metadata)
        + score_stream_runtime_match(stream, metadata)
        + score_stream_release_quality(stream)
        + score_stream_seeders(stream)
        + health_scores
            .get(&get_stream_info_hash(stream))
            .copied()
            .unwrap_or_default()
}

fn prioritize_candidates_by_source_hash<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    ranked_pool: Vec<&'a DiscoveryStream>,
    source_hash: &str,
    limit: usize,
) -> Vec<&'a DiscoveryStream> {
    let normalized_hash = normalize_source_hash(source_hash);
    let safe_limit = limit.max(1);
    if normalized_hash.is_empty() {
        return candidates.into_iter().take(safe_limit).collect();
    }

    let dedup_by_hash = |list: Vec<&'a DiscoveryStream>| {
        let mut seen = HashSet::new();
        let mut output = Vec::new();
        for item in list {
            let hash = get_stream_info_hash(item);
            if hash.is_empty() || !seen.insert(hash) {
                continue;
            }
            output.push(item);
        }
        output
    };

    let base_list = dedup_by_hash(candidates);
    if let Some(selected) = base_list
        .iter()
        .copied()
        .find(|item| get_stream_info_hash(item) == normalized_hash)
    {
        let mut next = vec![selected];
        next.extend(
            base_list
                .into_iter()
                .filter(|item| !std::ptr::eq(*item, selected)),
        );
        return next.into_iter().take(safe_limit).collect();
    }

    let selected_from_pool = dedup_by_hash(ranked_pool)
        .into_iter()
        .find(|item| get_stream_info_hash(item) == normalized_hash);
    let Some(selected_from_pool) = selected_from_pool else {
        return base_list.into_iter().take(safe_limit).collect();
    };
    let mut next = vec![selected_from_pool];
    next.extend(base_list);
    next.into_iter().take(safe_limit).collect()
}

fn apply_mp4_default_candidate_rule<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    ranked_pool: Vec<&'a DiscoveryStream>,
    source_hash: &str,
    limit: usize,
    source_language: &str,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let with_mp4 = ensure_at_least_one_container_candidate(
        candidates,
        ranked_pool.clone(),
        "mp4",
        limit,
        source_language,
        health_scores,
    );
    if with_mp4.is_empty() {
        return with_mp4;
    }
    if !normalize_source_hash(source_hash).is_empty() {
        return with_mp4;
    }

    let mut mp4_candidates = ranked_pool
        .iter()
        .copied()
        .filter(|candidate| {
            is_stream_likely_container(candidate, "mp4")
                && is_candidate_healthy_enough_for_default(candidate, health_scores)
        })
        .collect::<Vec<_>>();
    if mp4_candidates.is_empty() {
        return move_container_candidates_to_front(with_mp4, "mp4");
    }

    mp4_candidates
        .sort_by(|left, right| compare_container_default_candidates(left, right, source_language));

    let safe_limit = limit.max(1);
    let mut seen_hashes = HashSet::new();
    let mut next = Vec::new();
    for candidate in mp4_candidates {
        push_unique_candidate(&mut next, &mut seen_hashes, candidate);
        if next.len() >= safe_limit {
            return next;
        }
    }
    for candidate in with_mp4 {
        push_unique_candidate(&mut next, &mut seen_hashes, candidate);
        if next.len() >= safe_limit {
            break;
        }
    }
    next
}

fn push_unique_candidate<'a>(
    output: &mut Vec<&'a DiscoveryStream>,
    seen_hashes: &mut HashSet<String>,
    candidate: &'a DiscoveryStream,
) {
    let hash = get_stream_info_hash(candidate);
    if hash.is_empty() || seen_hashes.insert(hash) {
        output.push(candidate);
    }
}

fn ensure_at_least_one_container_candidate<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    ranked_pool: Vec<&'a DiscoveryStream>,
    container: &str,
    limit: usize,
    source_language: &str,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let safe_limit = limit.max(1);
    let mut current = candidates.into_iter().take(safe_limit).collect::<Vec<_>>();
    if current.is_empty() {
        return current;
    }
    if current.iter().any(|candidate| {
        is_stream_likely_container(candidate, container)
            && is_candidate_healthy_enough_for_default(candidate, health_scores)
    }) {
        return current;
    }
    let current_hashes = current
        .iter()
        .map(|candidate| get_stream_info_hash(candidate))
        .filter(|hash| !hash.is_empty())
        .collect::<HashSet<_>>();
    let Some(fallback) =
        pick_best_container_candidate(&ranked_pool, container, source_language, health_scores)
    else {
        return current;
    };
    let fallback_hash = get_stream_info_hash(fallback);
    if !fallback_hash.is_empty() && current_hashes.contains(&fallback_hash) {
        return current;
    }
    if let Some(last) = current.last_mut() {
        *last = fallback;
    }
    current
}

fn pick_best_container_candidate<'a>(
    candidates: &[&'a DiscoveryStream],
    container: &str,
    source_language: &str,
    health_scores: &HashMap<String, i64>,
) -> Option<&'a DiscoveryStream> {
    let mut container_candidates = candidates
        .iter()
        .copied()
        .filter(|candidate| {
            is_stream_likely_container(candidate, container)
                && is_candidate_healthy_enough_for_default(candidate, health_scores)
        })
        .collect::<Vec<_>>();
    container_candidates
        .sort_by(|left, right| compare_container_default_candidates(left, right, source_language));
    container_candidates.first().copied()
}

fn is_candidate_healthy_enough_for_default(
    candidate: &DiscoveryStream,
    health_scores: &HashMap<String, i64>,
) -> bool {
    let source_hash = get_stream_info_hash(candidate);
    health_scores.get(&source_hash).copied().unwrap_or_default() > SOURCE_HEALTH_AVOID_SCORE
}

fn compare_container_default_candidates(
    left: &DiscoveryStream,
    right: &DiscoveryStream,
    source_language: &str,
) -> std::cmp::Ordering {
    let left_language_score = score_container_default_language(left, source_language);
    let right_language_score = score_container_default_language(right, source_language);
    if left_language_score != right_language_score {
        return right_language_score.cmp(&left_language_score);
    }
    let left_resolution = parse_stream_vertical_resolution(left);
    let right_resolution = parse_stream_vertical_resolution(right);
    if left_resolution != right_resolution {
        return right_resolution.cmp(&left_resolution);
    }
    parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
}

fn move_container_candidates_to_front<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    container: &str,
) -> Vec<&'a DiscoveryStream> {
    let mut preferred = Vec::new();
    let mut rest = Vec::new();
    for candidate in candidates {
        if is_stream_likely_container(candidate, container) {
            preferred.push(candidate);
        } else {
            rest.push(candidate);
        }
    }
    preferred.extend(rest);
    preferred
}

fn score_container_default_language(stream: &DiscoveryStream, source_language: &str) -> i64 {
    let normalized_source_language = normalize_source_language_filter(source_language);
    if normalized_source_language == "any" {
        return 0;
    }
    let detected = get_detected_stream_languages(stream);
    if detected.contains(&normalized_source_language) {
        return if detected.len() == 1 { 4 } else { 2 };
    }
    if detected.is_empty() && normalized_source_language == SOURCE_LANGUAGE_FILTER_DEFAULT {
        return 1;
    }
    -5
}

fn score_stream_source_audio_profile(
    stream: &DiscoveryStream,
    source_language: &str,
    source_audio_profile: &str,
) -> i64 {
    let normalized_profile = normalize_source_audio_profile_filter(source_audio_profile);
    if normalized_profile != SOURCE_AUDIO_PROFILE_DEFAULT {
        return 0;
    }

    let detected_languages = get_detected_stream_languages(stream);
    let has_multi_audio_marker = has_explicit_multi_audio_marker(stream);
    if has_multi_audio_marker || detected_languages.len() > 1 {
        let normalized_source_language = normalize_source_language_filter(source_language);
        if normalized_source_language != "any"
            && detected_languages.contains(&normalized_source_language)
        {
            return -2_200;
        }
        return -1_800;
    }

    let normalized_source_language = normalize_source_language_filter(source_language);
    if normalized_source_language == "any" {
        return if detected_languages.len() == 1 {
            450
        } else {
            0
        };
    }

    if detected_languages.len() == 1 && detected_languages.contains(&normalized_source_language) {
        return 1_600;
    }

    0
}

fn score_stream_seeders(stream: &DiscoveryStream) -> i64 {
    let seed_count = parse_seed_count(if stream.title.is_empty() {
        stream.name.as_str()
    } else {
        stream.title.as_str()
    });
    if seed_count <= 0 {
        return 0;
    }
    ((((seed_count + 1) as f64).log10() * 320.0).round() as i64).min(900)
}

fn score_stream_language_preference(stream: &DiscoveryStream, preferred_audio_lang: &str) -> i64 {
    let preferred = normalize_preferred_audio_lang(preferred_audio_lang);
    if preferred == "auto" {
        return 0;
    }
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    let mut score = 0;
    if audio_language_tokens(&preferred)
        .iter()
        .any(|token| stream_text.contains(token))
    {
        score += 2500;
    }
    for lang in ["en", "fr", "es", "de", "it", "pt"] {
        if lang == preferred {
            continue;
        }
        if audio_language_tokens(lang)
            .iter()
            .any(|token| stream_text.contains(token))
        {
            score -= 1400;
        }
    }
    score
}

fn score_stream_quality_preference(stream: &DiscoveryStream, preferred_quality: &str) -> i64 {
    let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
    if normalized_quality == "auto" {
        return 0;
    }
    let target_height = stream_quality_target(&normalized_quality);
    let candidate_height = parse_stream_vertical_resolution(stream);
    if target_height == 0 || candidate_height == 0 {
        return 0;
    }
    if candidate_height == target_height {
        return 1400;
    }
    if candidate_height > target_height {
        return -700 - (candidate_height - target_height).min(900);
    }
    -300 - (target_height - candidate_height).min(700)
}

fn score_stream_title_year_match(stream: &DiscoveryStream, metadata: &ResolveMetadata) -> i64 {
    let stream_text = normalize_text_for_match(&build_stream_text_raw(stream));
    if stream_text.is_empty() {
        return 0;
    }
    let title_tokens = tokenize_title_for_match(&metadata.display_title);
    if title_tokens.is_empty() {
        return 0;
    }
    let matched_token_count = count_matching_title_tokens(&stream_text, &title_tokens);
    let has_year =
        !metadata.display_year.is_empty() && stream_text.contains(&metadata.display_year);
    let required_matches = title_tokens.len().min(2);
    if matched_token_count >= required_matches && has_year {
        return 1800;
    }
    if matched_token_count >= required_matches {
        return 1100;
    }
    if matched_token_count >= 1 && has_year {
        return 420;
    }
    if matched_token_count == 0 && has_year {
        return -900;
    }
    -600
}

fn score_stream_runtime_match(stream: &DiscoveryStream, metadata: &ResolveMetadata) -> i64 {
    let target_runtime_seconds = metadata.runtime_seconds.max(0);
    if target_runtime_seconds < 1800 {
        return 0;
    }
    let candidate_runtime_seconds =
        parse_runtime_from_label_seconds(&build_stream_text_raw(stream));
    if candidate_runtime_seconds <= 0 {
        return 0;
    }
    let delta_ratio = ((candidate_runtime_seconds - target_runtime_seconds).abs() as f64)
        / target_runtime_seconds as f64;
    if delta_ratio <= 0.06 {
        return 420;
    }
    if delta_ratio <= 0.12 {
        return 220;
    }
    if delta_ratio <= 0.2 {
        return 60;
    }
    -360
}

fn score_stream_release_quality(stream: &DiscoveryStream) -> i64 {
    let stream_text = build_stream_release_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    if LOW_QUALITY_THEATRICAL_RELEASE_RE.is_match(&stream_text) {
        return -4200;
    }
    if LOW_QUALITY_SCREENER_RELEASE_RE.is_match(&stream_text) {
        return -2600;
    }
    0
}

fn score_stream_episode_match(
    stream: &DiscoveryStream,
    season_number: i64,
    episode_number: i64,
) -> i64 {
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    let target_signature = build_episode_signature(season_number, episode_number);
    let signatures = collect_episode_signatures(&stream_text, Some(season_number));
    if signatures.is_empty() {
        return 0;
    }
    if signatures.contains(&target_signature) {
        return 2800;
    }
    -3400
}

fn build_episode_signature(season_number: i64, episode_number: i64) -> String {
    format!(
        "{}x{}",
        normalize_episode_ordinal(&season_number.to_string(), 1),
        normalize_episode_ordinal(&episode_number.to_string(), 1)
    )
}

fn collect_episode_signatures(text: &str, season_hint: Option<i64>) -> Vec<String> {
    let normalized = text.to_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut signatures = Vec::new();
    let mut push = |season: i64, episode: i64| {
        if !(1..=99).contains(&season) || !(1..=999).contains(&episode) {
            return;
        }
        signatures.push(format!("{season}x{episode}"));
    };
    for captures in HXH_SEASON_EPISODE_RE.captures_iter(&normalized) {
        push(
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
        );
    }
    for captures in X_SEASON_EPISODE_RE.captures_iter(&normalized) {
        push(
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
        );
    }
    if let Some(season_hint) = season_hint.filter(|value| *value > 0) {
        for captures in EPISODE_ONLY_RE.captures_iter(&normalized) {
            push(
                season_hint,
                captures
                    .get(1)
                    .and_then(|value| value.as_str().parse::<i64>().ok())
                    .unwrap_or_default(),
            );
        }
    }
    signatures.sort();
    signatures.dedup();
    signatures
}

fn parse_runtime_from_label_seconds(value: &str) -> i64 {
    let text = value.to_lowercase();
    if text.is_empty() {
        return 0;
    }
    if let Some(captures) = HMS_RUNTIME_RE.captures(&text) {
        let first = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let second = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let third = captures
            .get(3)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        if captures.get(3).is_some() {
            return first * 3600 + second * 60 + third;
        }
        return first * 60 + second;
    }
    let hours = HOURS_RUNTIME_RE
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or_default();
    let minutes = MINUTES_RUNTIME_RE
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or_default();
    if hours > 0.0 || minutes > 0.0 {
        return (hours * 3600.0 + minutes * 60.0).round() as i64;
    }
    if let Some(captures) = COMPACT_RUNTIME_RE.captures(&text) {
        let hours = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let minutes = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        return hours * 3600 + minutes * 60;
    }
    0
}

fn parse_stream_vertical_resolution(stream: &DiscoveryStream) -> i64 {
    parse_vertical_resolution_from_text(&build_stream_text(stream))
}

fn parse_vertical_resolution_from_text(value: &str) -> i64 {
    let stream_text = value.to_lowercase();
    if stream_text.is_empty() {
        return 0;
    }
    if Regex::new(r"\b(2160p|4k|uhd)\b")
        .expect("valid 2160 regex")
        .is_match(&stream_text)
    {
        return 2160;
    }
    if Regex::new(r"\b(1080p|full\s*hd)\b")
        .expect("valid 1080 regex")
        .is_match(&stream_text)
    {
        return 1080;
    }
    if Regex::new(r"\b720p\b")
        .expect("valid 720 regex")
        .is_match(&stream_text)
    {
        return 720;
    }
    if Regex::new(r"\b(480p|sd)\b")
        .expect("valid 480 regex")
        .is_match(&stream_text)
    {
        return 480;
    }
    0
}

fn infer_stream_container_label(stream: &DiscoveryStream) -> String {
    let stream_text = [
        stream.behaviorHints.filename.as_str(),
        stream.title.as_str(),
        stream.name.as_str(),
        stream.description.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    if stream_text.is_empty() {
        return String::new();
    }
    if stream_text.contains(".mp4") {
        return "mp4".to_owned();
    }
    if stream_text.contains(".mkv") {
        return "mkv".to_owned();
    }
    if stream_text.contains(".avi") {
        return "avi".to_owned();
    }
    if stream_text.contains(".wmv") {
        return "wmv".to_owned();
    }
    if stream_text.contains(".m3u8") {
        return "m3u8".to_owned();
    }
    if stream_text.contains(".ts") {
        return "ts".to_owned();
    }
    if stream.discoveryProvider == "torznab" {
        return "mkv".to_owned();
    }
    String::new()
}

fn is_stream_likely_container(stream: &DiscoveryStream, container: &str) -> bool {
    let inferred = infer_stream_container_label(stream);
    if !inferred.is_empty() {
        return inferred == container;
    }
    false
}

fn matches_source_language_filter(stream: &DiscoveryStream, source_language: &str) -> bool {
    let safe_source_language = normalize_source_language_filter(source_language);
    if safe_source_language == "any" {
        return true;
    }
    let matched = get_detected_stream_languages(stream);
    if matched.contains(&safe_source_language) {
        return matched.len() == 1;
    }
    safe_source_language == SOURCE_LANGUAGE_FILTER_DEFAULT && matched.is_empty()
}

fn get_detected_stream_languages(stream: &DiscoveryStream) -> HashSet<String> {
    let stream_text_raw = build_stream_text_raw(stream);
    let normalized_stream_text = normalize_text_for_match(&stream_text_raw);
    let stream_text = format!(" {} ", normalized_stream_text.trim());
    let mut matched = HashSet::new();
    if stream_text.trim().is_empty() {
        return matched;
    }
    for lang in ["en", "fr", "es", "de", "it", "pt"] {
        let has_match = audio_language_tokens(lang).iter().any(|token| {
            let normalized = normalize_text_for_match(token);
            !normalized.is_empty() && stream_text.contains(&format!(" {normalized} "))
        });
        if has_match {
            matched.insert(lang.to_owned());
        }
    }
    matched
}

fn extract_stream_title_lines(stream: &DiscoveryStream) -> Vec<String> {
    stream
        .title
        .lines()
        .map(normalize_whitespace)
        .filter(|line| !line.is_empty())
        .collect()
}

fn extract_stream_size_label(stream: &DiscoveryStream) -> String {
    STREAM_SIZE_RE
        .captures(&stream.title)
        .and_then(|captures| captures.get(1))
        .map(|value| normalize_whitespace(value.as_str()))
        .unwrap_or_default()
}

#[cfg(test)]
fn parse_stream_size_bytes(stream: &DiscoveryStream) -> i64 {
    parse_size_label_bytes(&extract_stream_size_label(stream))
}

#[cfg(test)]
fn parse_size_label_bytes(label: &str) -> i64 {
    let mut parts = label.split_whitespace();
    let Some(number_part) = parts.next() else {
        return 0;
    };
    let value = number_part.replace(',', "").parse::<f64>().unwrap_or(0.0);
    if value <= 0.0 {
        return 0;
    }
    let unit = parts.next().unwrap_or("b").to_lowercase();
    let multiplier = if unit.starts_with("kb") || unit.starts_with("kib") {
        1024.0
    } else if unit.starts_with("mb") || unit.starts_with("mib") {
        1024.0_f64.powi(2)
    } else if unit.starts_with("gb") || unit.starts_with("gib") {
        1024.0_f64.powi(3)
    } else if unit.starts_with("tb") || unit.starts_with("tib") {
        1024.0_f64.powi(4)
    } else {
        1.0
    };
    (value * multiplier).round() as i64
}

fn extract_stream_release_group(stream: &DiscoveryStream) -> String {
    STREAM_RELEASE_GROUP_RE
        .captures(&stream.title)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            normalize_whitespace(value.as_str())
                .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
                .to_owned()
        })
        .unwrap_or_default()
}

fn parse_seed_count(stream_title: &str) -> i64 {
    SEED_COUNT_RE
        .captures(stream_title)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            value
                .as_str()
                .chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<i64>()
                .unwrap_or_default()
        })
        .unwrap_or_default()
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

fn combine_external_embed_source_summaries(
    external_sources: Vec<SourceSummary>,
    torrent_sources: Vec<SourceSummary>,
) -> Vec<SourceSummary> {
    if external_sources.is_empty() {
        return torrent_sources;
    }
    let mut sources = external_sources;
    sources.extend(torrent_sources);
    sources
}

fn build_external_embed_source_summaries(
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> Vec<SourceSummary> {
    let mut sources = external_embed_sources()
        .into_iter()
        .filter(|source| is_external_embed_hls_capable_source(*source))
        .filter_map(|source| {
            let source_hash = external_embed_source_hash(source, metadata);
            if source_hash.is_empty() || external_embed_url(source, metadata).is_none() {
                return None;
            }
            let display_name = external_embed_source_display_name(source);
            let filename = external_embed_source_filename(source);
            Some(SourceSummary {
                sourceHash: source_hash.clone(),
                infoHash: source_hash,
                provider: external_embed_source_provider_label(source).to_owned(),
                primary: display_name,
                filename,
                qualityLabel: external_embed_source_quality_label(source).to_owned(),
                container: "hls".to_owned(),
                seeders: 0,
                size: String::new(),
                releaseGroup: external_embed_source_detail_label(source).to_owned(),
                score: 1_000_000
                    + external_embed_source_rank_score(source, metadata, health_scores),
            })
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.primary.cmp(&right.primary))
    });
    sources
}

fn external_embed_source_for_source_hash(
    metadata: &ResolveMetadata,
    source_hash: &str,
) -> Option<ExternalEmbedSource> {
    let normalized_hash = normalize_source_hash(source_hash);
    if normalized_hash.is_empty() {
        return None;
    }
    external_embed_sources()
        .into_iter()
        .find(|source| external_embed_source_hash(*source, metadata) == normalized_hash)
}

fn default_external_embed_source(
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> Option<ExternalEmbedSource> {
    let mut sources = external_embed_sources()
        .into_iter()
        .filter(|source| is_external_embed_hls_capable_source(*source))
        .filter(|source| external_embed_url(*source, metadata).is_some())
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        external_embed_source_rank_score(*right, metadata, health_scores)
            .cmp(&external_embed_source_rank_score(
                *left,
                metadata,
                health_scores,
            ))
            .then_with(|| {
                external_embed_source_display_name(*left)
                    .cmp(&external_embed_source_display_name(*right))
            })
    });
    sources.into_iter().next()
}

fn preferred_external_embed_hls_sources(
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> Vec<ExternalEmbedSource> {
    let mut sources = external_embed_sources()
        .into_iter()
        .filter(|source| is_default_external_embed_hls_fallback_source(*source))
        .filter(|source| is_external_embed_hls_capable_source(*source))
        .filter(|source| external_embed_url(*source, metadata).is_some())
        .filter(|source| {
            is_external_embed_source_healthy_enough_for_fallback(*source, metadata, health_scores)
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        external_embed_source_rank_score(*right, metadata, health_scores)
            .cmp(&external_embed_source_rank_score(
                *left,
                metadata,
                health_scores,
            ))
            .then_with(|| {
                external_embed_source_display_name(*left)
                    .cmp(&external_embed_source_display_name(*right))
            })
    });
    sources
}

fn external_embed_source_rank_score(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> i64 {
    let source_hash = external_embed_source_hash(source, metadata);
    external_embed_source_availability_score(source)
        + external_embed_source_quality_score(source)
        + health_scores.get(&source_hash).copied().unwrap_or_default()
        - external_embed_source_priority(source, metadata)
}

fn is_default_external_embed_hls_fallback_source(source: ExternalEmbedSource) -> bool {
    match source.provider.id {
        "videasy" => source
            .server
            .map(|server| server.id == "YORU")
            .unwrap_or(true),
        "vidlink" => source.server.is_none(),
        "vidrock" | "notorrent" | "vixsrc" | "lordflix" => source.server.is_none(),
        _ => false,
    }
}

fn is_external_embed_source_healthy_enough_for_fallback(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> bool {
    let source_hash = external_embed_source_hash(source, metadata);
    health_scores
        .get(&source_hash)
        .copied()
        .unwrap_or_default()
        > SOURCE_HEALTH_AVOID_SCORE
}

fn is_external_embed_hls_capable_source(source: ExternalEmbedSource) -> bool {
    matches!(
        source.provider.id,
        "videasy" | "vidlink" | "icefy" | "vidrock" | "vixsrc" | "lordflix" | "notorrent"
    )
}

fn external_embed_source_availability_score(source: ExternalEmbedSource) -> i64 {
    match source.provider.id {
        "vidlink" => 1_350,
        "vidrock" => 1_200,
        "notorrent" => 1_150,
        "vixsrc" => 1_100,
        "lordflix" => 1_050,
        "videasy" if source.server.is_none() => 1_000,
        "icefy" => 700,
        "videasy" => 150,
        _ => 0,
    }
}

fn external_embed_source_quality_score(source: ExternalEmbedSource) -> i64 {
    match source.provider.id {
        "videasy" if source.server.map(|server| server.id) == Some("YORU") => 600,
        "vidlink" | "vidrock" | "notorrent" | "vixsrc" | "lordflix" => 400,
        "videasy" if source.server.is_none() => 400,
        "icefy" => 350,
        "videasy" => 300,
        _ => 0,
    }
}

fn should_prefer_default_external_embed(
    filters: &ResolveFilters,
    resolver_provider: ResolverProvider,
) -> bool {
    filters.source_hash.is_empty()
        && !matches!(
            resolver_provider,
            ResolverProvider::RealDebrid | ResolverProvider::LocalTorrent
        )
}

async fn build_external_embed_resolved_playback_payload(
    request: ExternalEmbedPlaybackRequest<'_>,
) -> Option<Value> {
    let _ = external_embed_playback_url(request.source, request.metadata, request.preferences)?;
    let candidates = external_embed_hls_candidate_sources(
        request.source,
        request.metadata,
        request.allow_native_fallback,
        request.health_scores,
    );
    let hls_deadline_ms = now_ms() + external_embed_hls_total_timeout_ms() as i64;

    for candidate in candidates {
        let remaining_ms = hls_deadline_ms - now_ms();
        if remaining_ms < 1_000 {
            break;
        }
        let Some(embed_url) =
            external_embed_playback_url(candidate, request.metadata, request.preferences)
        else {
            continue;
        };
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
        let Some(hls_source) = hls_result else {
            record_external_embed_health_event(
                request.db,
                candidate,
                request.metadata,
                "playback_error",
                "Native HLS resolver failed.",
            )
            .await;
            continue;
        };
        record_external_embed_health_event(request.db, candidate, request.metadata, "success", "")
            .await;
        let playable_url = crate::live::build_trusted_external_embed_hls_playback_source(
            hls_source.playback_url.as_str(),
            hls_source.referer.as_deref(),
            request.live_hls_proxy_secret,
        );
        return Some(build_external_embed_resolved_payload_with_playable_url(
            request.metadata,
            candidate,
            request.preferences,
            playable_url,
            embed_url,
        ));
    }

    None
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
        "videasy" | "vidlink" => external_embed_hls_resolve_timeout_ms(),
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

fn build_external_embed_resolved_payload_with_playable_url(
    metadata: &ResolveMetadata,
    source: ExternalEmbedSource,
    preferences: &ResolvePreferences,
    playable_url: String,
    source_input: String,
) -> Value {
    let source_hash = external_embed_source_hash(source, metadata);
    let filename = external_embed_source_filename(source);
    let fallback_urls = Vec::new();
    let resolved = ResolvedSource {
        playable_url: playable_url.clone(),
        fallback_urls: fallback_urls.clone(),
        filename: filename.clone(),
        source_hash: source_hash.clone(),
        selected_file: String::new(),
        selected_file_path: String::new(),
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

fn external_embed_url(source: ExternalEmbedSource, metadata: &ResolveMetadata) -> Option<String> {
    let tmdb_id = metadata.tmdb_id.trim();
    if tmdb_id.is_empty() {
        return None;
    }
    match (source.provider.id, metadata.media_type.as_str()) {
        ("videasy", "movie") => Some(format!(
            "https://player.videasy.to/movie/{tmdb_id}?color=ffd700"
        )),
        ("videasy", "tv") => Some(format!(
            "https://player.videasy.to/tv/{}/{}/{}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=false&overlay=true&color=ffd700",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("vidlink", "movie") => Some(format!("https://vidlink.pro/movie/{tmdb_id}")),
        ("vidlink", "tv") => Some(format!(
            "https://vidlink.pro/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("icefy", "movie") => Some(format!("https://streams.icefy.top/movie/{tmdb_id}")),
        ("icefy", "tv") => Some(format!(
            "https://streams.icefy.top/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("vixsrc", "movie") => Some(format!("https://vixsrc.to/api/movie/{tmdb_id}")),
        ("vixsrc", "tv") => Some(format!(
            "https://vixsrc.to/api/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("vidrock", "movie") => Some(format!("https://vidrock.net/movie/{tmdb_id}")),
        ("vidrock", "tv") => Some(format!(
            "https://vidrock.net/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("lordflix", _) => lordflix_source_url(metadata),
        ("notorrent", "movie") => {
            let imdb_id = metadata.imdb_id.trim();
            if imdb_id.is_empty() {
                None
            } else {
                Some(format!("{NOTORRENT_API_BASE}/stream/movie/{imdb_id}.json"))
            }
        }
        ("notorrent", "tv") => {
            let imdb_id = metadata.imdb_id.trim();
            if imdb_id.is_empty() {
                None
            } else {
                Some(format!(
                    "{NOTORRENT_API_BASE}/stream/series/{imdb_id}:{}:{}.json",
                    metadata.season_number, metadata.episode_number
                ))
            }
        }
        _ => None,
    }
}

fn external_embed_playback_url(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    _preferences: &ResolvePreferences,
) -> Option<String> {
    external_embed_url(source, metadata)
}

fn external_embed_source_hash(source: ExternalEmbedSource, metadata: &ResolveMetadata) -> String {
    if external_embed_url(source, metadata).is_none() {
        return String::new();
    }
    let identity = format!(
        "external-embed|{}|{}|{}|{}|{}|{}",
        source.provider.id,
        source.server.map(|server| server.id).unwrap_or("default"),
        metadata.media_type,
        metadata.tmdb_id.trim(),
        metadata.season_number,
        metadata.episode_number
    );
    deterministic_40_hex(&identity)
}

fn external_embed_sources() -> Vec<ExternalEmbedSource> {
    let mut sources = Vec::new();
    for provider in EXTERNAL_EMBED_PROVIDERS.iter().copied() {
        for server in external_embed_servers_for_provider(provider) {
            sources.push(ExternalEmbedSource {
                provider,
                server: Some(*server),
            });
        }
        sources.push(ExternalEmbedSource {
            provider,
            server: None,
        });
    }
    sources
}

fn external_embed_servers_for_provider(
    provider: ExternalEmbedProvider,
) -> &'static [ExternalEmbedServer] {
    match provider.id {
        "videasy" => VIDEASY_EXTERNAL_EMBED_SERVERS,
        _ => &[],
    }
}

fn external_embed_source_priority(source: ExternalEmbedSource, _metadata: &ResolveMetadata) -> i64 {
    if source.provider.id == "vidlink" {
        return 0;
    }
    if matches!(
        source.provider.id,
        "vidrock" | "notorrent" | "vixsrc" | "lordflix" | "icefy"
    ) && source.server.is_none()
    {
        return source.provider.priority;
    }
    if source.provider.id == "videasy" && source.server.is_none() {
        return source.provider.priority;
    }
    if source.provider.id == "videasy" {
        return source
            .server
            .map(|server| 100 + server.priority)
            .unwrap_or(150);
    }
    if let Some(server) = source.server {
        return source.provider.priority * 100 + server.priority;
    }
    source.provider.priority * 100 + 50
}

fn external_embed_source_display_name(source: ExternalEmbedSource) -> String {
    source
        .server
        .map(|server| server.label.to_owned())
        .unwrap_or_else(|| source.provider.label.to_owned())
}

fn external_embed_source_provider_label(source: ExternalEmbedSource) -> &'static str {
    if source.server.is_some() {
        source.provider.label
    } else {
        "LivNet"
    }
}

fn external_embed_source_quality_label(source: ExternalEmbedSource) -> &'static str {
    if matches!(
        source.provider.id,
        "icefy" | "vidrock" | "vixsrc" | "lordflix" | "notorrent"
    ) {
        return "1080p";
    }
    source
        .server
        .map(|server| server.quality_label)
        .unwrap_or("HLS")
}

fn external_embed_source_detail_label(source: ExternalEmbedSource) -> &'static str {
    match source.provider.id {
        "icefy" => return "Fast native HLS",
        "vidrock" => return "Native HLS",
        "vixsrc" => return "Native HLS, alternate audio",
        "lordflix" => return "Multi-server native HLS",
        "notorrent" => return "Stremio addon HLS",
        _ => {}
    }
    source
        .server
        .map(|server| server.detail_label)
        .unwrap_or("")
}

fn external_embed_source_filename(source: ExternalEmbedSource) -> String {
    if let Some(server) = source.server {
        format!("{} {} embed", source.provider.label, server.label)
    } else {
        format!("{} embed", source.provider.label)
    }
}

fn deterministic_40_hex(value: &str) -> String {
    let a = fnv1a64(value.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let b = fnv1a64(value.as_bytes(), 0x9e37_79b9_7f4a_7c15);
    let c = fnv1a64(value.as_bytes(), 0x94d0_49bb_1331_11eb);
    format!("{a:016x}{b:016x}{:08x}", (c >> 32) as u32)
}

fn fnv1a64(bytes: &[u8], seed: u64) -> u64 {
    bytes.iter().fold(seed, |mut hash, byte| {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        hash
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
            return resolve_notorrent_hls_playback_source(client, metadata, timeout_ms).await;
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
        .kill_on_drop(true);
    if let Some(server) = source.server {
        command.env(EXTERNAL_EMBED_SERVER_ENV, server.id);
    }

    let output = timeout(
        Duration::from_millis(resolve_timeout_ms.saturating_add(1_000)),
        command.output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }

    let resolver_output =
        serde_json::from_slice::<ExternalEmbedHlsResolverOutput>(&output.stdout).ok()?;
    let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
    if !is_supported_external_embed_hls_url(&playback_url) {
        return None;
    }
    let referer = normalize_external_embed_hls_referer(&resolver_output.referer)
        .or_else(|| normalize_external_embed_hls_referer(embed_url.as_str()));
    Some(ExternalEmbedHlsPlaybackSource {
        playback_url,
        referer,
    })
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
        if let Some(source) =
            validate_external_embed_hls_playlist(client, &response.stream, Some(referer), timeout_ms)
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
    if dec_result.error.as_deref().unwrap_or("").trim().len() > 0 {
        return None;
    }

    for stream in dec_result.stream {
        if stream.r#type.trim().eq_ignore_ascii_case("hls") {
            let playlist = stream.playlist.trim();
            if !playlist.is_empty() {
                if let Some(source) = validate_external_embed_hls_playlist(
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
    }
    None
}

async fn resolve_notorrent_hls_playback_source(
    client: &reqwest::Client,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let imdb_id = metadata.imdb_id.trim();
    if imdb_id.is_empty() {
        return None;
    }
    let api_url = if metadata.media_type == "tv" {
        format!(
            "{NOTORRENT_API_BASE}/stream/series/{imdb_id}:{}:{}.json",
            metadata.season_number, metadata.episode_number
        )
    } else {
        format!("{NOTORRENT_API_BASE}/stream/movie/{imdb_id}.json")
    };
    let response = fetch_external_json::<NoTorrentStreamResponse>(
        client,
        &api_url,
        None,
        timeout_ms,
    )
    .await?;

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
        let referer = notorrent_stream_referer(&stream);
        if let Some(source) =
            validate_external_embed_hls_playlist(client, stream_url, referer.as_deref(), timeout_ms)
                .await
        {
            return Some(source);
        }
    }
    None
}

fn notorrent_stream_referer(stream: &NoTorrentStreamEntry) -> Option<String> {
    let mut headers = stream.behavior_hints.headers.clone();
    headers.extend(stream.behavior_hints.proxy_headers.request.clone());
    headers
        .get("Referer")
        .or_else(|| headers.get("referer"))
        .cloned()
        .or_else(|| headers.get("Origin").or_else(|| headers.get("origin")).cloned())
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
    let mut request = client
        .get(playback_url)
        .header(header::USER_AGENT, EXTERNAL_EMBED_USER_AGENT)
        .header(
            header::ACCEPT,
            "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        )
        .header(header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    let referer = referer.and_then(normalize_external_embed_hls_referer);
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

fn should_try_torznab_discovery(
    torrentio_failed: bool,
    torrentio_candidates_empty: bool,
    pinned_source_missing: bool,
    torrentio_candidates_failed: bool,
) -> bool {
    torrentio_failed
        || torrentio_candidates_empty
        || pinned_source_missing
        || torrentio_candidates_failed
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

fn sanitize_torznab_base_url_for_cache(base_url: &str) -> String {
    let trimmed = base_url.trim();
    let Ok(mut url) = url::Url::parse(trimmed) else {
        return trimmed.to_owned();
    };
    let retained_pairs = url
        .query_pairs()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("apikey"))
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

fn build_rd_torrent_cache_key(info_hash: &str) -> String {
    format!("rd-torrent:{}", normalize_source_hash(info_hash))
}

fn build_scoped_rd_torrent_cache_key(cache_scope: &str, info_hash: &str) -> String {
    let normalized_hash = normalize_source_hash(info_hash);
    let normalized_scope = cache_scope.trim();
    if normalized_scope.is_empty() {
        build_rd_torrent_cache_key(&normalized_hash)
    } else {
        format!("rd-torrent:{normalized_scope}:{normalized_hash}")
    }
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
    let info_hash = [
        item.info_hash.as_str(),
        candidate_magnet.as_str(),
        item.link.as_str(),
        item.enclosure_url.as_str(),
    ]
    .into_iter()
    .find_map(extract_info_hash_from_source)
    .unwrap_or_default();
    if info_hash.is_empty() && candidate_magnet.is_empty() {
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
        name: provider,
        title: title_lines.join("\n"),
        description: String::new(),
        behaviorHints: DiscoveryBehaviorHints { filename: title },
        sources: Vec::new(),
        magnetUrl: candidate_magnet,
        discoveryProvider: "torznab".to_owned(),
    })
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

fn user_facing_real_debrid_error(message: &str) -> String {
    match message.trim() {
        "infringing_file" => "Real-Debrid blocked this source.".to_owned(),
        "too_many_requests" => {
            "Real-Debrid is rate limiting requests. Try again shortly.".to_owned()
        }
        "" => "Real-Debrid request failed.".to_owned(),
        other => other.to_owned(),
    }
}

fn real_debrid_api_key_required_error() -> ApiError {
    ApiError::failed_dependency("Add a Real-Debrid API key in Settings to use torrent sources.")
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
    ApiError::failed_dependency(
        "Enable Local torrent cache in Settings to use local torrent sources.",
    )
}

fn is_real_debrid_blocked_source_message(message: &str) -> bool {
    message.trim() == "Real-Debrid blocked this source."
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

fn build_magnet_uri(stream: &DiscoveryStream, fallback_name: &str) -> AppResult<String> {
    if let Some(magnet_url) = normalize_magnet_url(&stream.magnetUrl) {
        return Ok(magnet_url);
    }
    let info_hash = get_stream_info_hash(stream);
    if info_hash.is_empty() {
        return Err(ApiError::internal("Missing torrent info hash."));
    }
    let source_trackers = stream
        .sources
        .iter()
        .filter_map(|source| source.strip_prefix("tracker:"))
        .filter(|tracker| !tracker.trim().is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut trackers = source_trackers;
    for tracker in DEFAULT_TRACKERS {
        if !trackers.iter().any(|existing| existing == tracker) {
            trackers.push((*tracker).to_owned());
        }
    }

    let mut parts = vec![format!("xt=urn:btih:{info_hash}")];
    if !fallback_name.trim().is_empty() {
        parts.push(format!(
            "dn={}",
            url::form_urlencoded::byte_serialize(fallback_name.trim().as_bytes())
                .collect::<String>()
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

pub(crate) fn pick_video_file_ids(
    files: &[Value],
    preferred_filename: &str,
    fallback_name: &str,
) -> Vec<i64> {
    let list = files
        .iter()
        .filter_map(|file| {
            let id = file.get("id").and_then(Value::as_i64)?;
            let path = stringify_json(file.get("path"));
            let bytes = file
                .get("bytes")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            Some((id, path, bytes))
        })
        .collect::<Vec<_>>();
    if list.is_empty() {
        return Vec::new();
    }
    let video_files = list
        .iter()
        .filter(|(_, path, _)| is_supported_resolved_container_path(path))
        .cloned()
        .collect::<Vec<_>>();
    if video_files.is_empty() {
        return Vec::new();
    }
    let preferred_needle = preferred_filename.trim().to_lowercase();
    if !preferred_needle.is_empty()
        && let Some((id, _, _)) = video_files
            .iter()
            .find(|(_, path, _)| path.to_lowercase().contains(&preferred_needle))
    {
        return vec![*id];
    }

    let fallback_episode_signatures = collect_episode_signatures(fallback_name, None);
    let fallback_season_hint = fallback_episode_signatures
        .first()
        .and_then(|signature| signature.split('x').next())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    if !fallback_episode_signatures.is_empty()
        && let Some((id, _, _)) = video_files.iter().find(|(_, path, _)| {
            let file_signatures = collect_episode_signatures(
                path,
                (fallback_season_hint > 0).then_some(fallback_season_hint),
            );
            !file_signatures.is_empty()
                && fallback_episode_signatures
                    .iter()
                    .any(|signature| file_signatures.contains(signature))
        })
    {
        return vec![*id];
    }

    video_files
        .iter()
        .max_by_key(|(_, path, bytes)| (container_preference_rank(path), *bytes))
        .map(|(id, _, _)| vec![*id])
        .unwrap_or_default()
}

fn ready_info_has_selected_file_id(info: &Value, selected_file_id: i64) -> bool {
    if selected_file_id <= 0 {
        return true;
    }
    let Some(files) = info.get("files").and_then(Value::as_array) else {
        return true;
    };
    if files.is_empty() {
        return true;
    }
    files.iter().any(|file| {
        file.get("id").and_then(Value::as_i64) == Some(selected_file_id)
            && file
                .get("selected")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                != 0
    })
}

fn is_rd_selected_file_mismatch_error(error: &ApiError) -> bool {
    error.message() == Some(RD_SELECTED_FILE_MISMATCH_ERROR)
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
        "mp4" => Regex::new(r"\.mp4(?:$|[?#&/])")
            .expect("valid mp4 regex")
            .is_match(&normalized),
        "mkv" => Regex::new(r"\.mkv(?:$|[?#&/])")
            .expect("valid mkv regex")
            .is_match(&normalized),
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
    !filters.preferred_container.is_empty()
        || filters.source_filters.min_seeders > 0
        || !filters.source_filters.allowed_formats.is_empty()
        || filters.source_filters.source_language != SOURCE_LANGUAGE_FILTER_DEFAULT
        || filters.source_filters.source_audio_profile != SOURCE_AUDIO_PROFILE_DEFAULT
}

fn should_allow_latest_playback_session_fallback(filters: &ResolveFilters) -> bool {
    filters.source_hash.is_empty()
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
    let year_matches_in_filename = Regex::new(r"\b(?:19|20)\d{2}\b")
        .expect("valid year regex")
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
    let year_matches_in_filename = Regex::new(r"\b(?:19|20)\d{2}\b")
        .expect("valid year regex")
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
        if is_real_debrid_download_url(&current_playable) && !remux_fallback.is_empty() {
            push_unique_url(&mut normalized.fallback_urls, &remux_fallback);
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
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use serde_json::json;
    use tokio::sync::Semaphore;

    use crate::error::ApiError;

    use super::{
        DiscoveryBehaviorHints, DiscoveryStream, PlaybackSession, RD_SELECTED_FILE_MISMATCH_ERROR,
        ResolveFilters, ResolveMetadata, ResolvePreferences, ResolvedSource, ResolverExternalGuard,
        ResolverMetrics, ResolverProvider, SOURCE_HEALTH_AVOID_SCORE, SourceFilters,
        SourceHealthStats, build_external_embed_source_summaries, build_movie_resolve_lock_key,
        build_playback_session_key_for_metadata, build_rd_torrent_cache_key,
        build_scoped_rd_torrent_cache_key, build_torrentio_stream_cache_key,
        build_torznab_request_url, build_torznab_stream_cache_key, build_tv_resolve_lock_key,
        build_user_scoped_playback_session_key_for_metadata, collect_episode_signatures,
        compute_external_embed_rank_health_score, compute_source_health_score,
        compute_torrentio_cache_deadlines, default_external_embed_source,
        does_filename_likely_match_movie, external_embed_hls_candidate_sources,
        external_embed_source_for_source_hash, external_embed_source_hash, external_embed_sources,
        external_embed_url, extract_info_hash_from_magnet, is_external_embed_hls_capable_source,
        is_persistent_source_resolve_error, is_public_external_embed_hls_hostname,
        is_supported_external_embed_hls_embed_url, is_supported_external_embed_hls_url,
        normalize_allowed_formats, normalize_resolved_source_for_software_decode,
        normalize_resolver_provider, normalize_source_audio_profile_filter, normalize_source_hash,
        now_ms, parse_runtime_from_label_seconds, parse_seed_count, parse_size_label_bytes,
        parse_torznab_xml, playback_session_key_allowed_for_user,
        playback_session_matches_preferred_container, playback_session_matches_preferred_quality,
        playback_session_matches_source_hash, ready_info_has_selected_file_id,
        select_fastest_race_candidates, select_top_episode_candidates, select_top_movie_candidates,
        should_allow_latest_playback_session_fallback, should_prefer_default_external_embed,
        should_prefer_software_decode_source, should_skip_playback_session_reuse,
        should_try_torznab_discovery, sort_movie_candidates, stream_list_contains_hash,
        user_facing_real_debrid_error,
    };

    #[test]
    fn normalizes_source_hashes() {
        assert_eq!(
            normalize_source_hash("0123456789abcdef0123456789abcdef01234567"),
            "0123456789abcdef0123456789abcdef01234567"
        );
        assert!(normalize_source_hash("bad-hash").is_empty());
    }

    #[test]
    fn external_embed_sources_use_stable_hashes_and_hls_urls() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::new();
        let sources = build_external_embed_source_summaries(&metadata, &health_scores);

        // VidLink is the neutral default native HLS source, with fast native
        // API providers and VidEasy variants still available behind it.
        assert_eq!(sources.len(), 14);
        assert_eq!(sources[0].primary, "VidLink");
        assert_eq!(sources[0].provider, "LivNet");
        assert_eq!(sources[0].filename, "VidLink embed");
        assert_eq!(sources[0].qualityLabel, "HLS");
        assert_eq!(sources[0].container, "hls");
        assert_eq!(sources[0].releaseGroup, "");
        assert_eq!(
            normalize_source_hash(&sources[0].sourceHash),
            sources[0].sourceHash
        );

        let source = external_embed_source_for_source_hash(&metadata, &sources[0].sourceHash)
            .expect("matching external provider");
        assert_eq!(source.provider.id, "vidlink");
        assert_eq!(source.server.map(|server| server.id), None);
        assert_eq!(
            external_embed_url(source, &metadata).unwrap(),
            "https://vidlink.pro/movie/1368166"
        );
        assert_eq!(
            external_embed_source_hash(source, &metadata),
            sources[0].sourceHash
        );
        assert_eq!(sources[1].primary, "VidRock");
        assert_eq!(sources[2].primary, "NoTorrent");
        assert_eq!(sources[3].primary, "VixSrc");
        assert_eq!(sources[4].primary, "LordFlix");
        assert_eq!(sources[5].primary, "VidEasy");
        assert_eq!(sources[5].provider, "LivNet");
        assert_eq!(sources[5].filename, "VidEasy embed");
        assert_eq!(sources[6].primary, "Icefy");
        assert_eq!(sources[6].provider, "LivNet");
        assert_eq!(sources[6].filename, "Icefy embed");
        assert_eq!(sources[6].qualityLabel, "1080p");
        assert_eq!(sources[6].releaseGroup, "Fast native HLS");

        let yoru_summary = sources
            .iter()
            .find(|source| source.primary == "Yoru")
            .expect("yoru source");
        assert_eq!(yoru_summary.provider, "VidEasy");
        assert_eq!(yoru_summary.qualityLabel, "4K");

        let notorrent_summary = sources
            .iter()
            .find(|source| source.primary == "NoTorrent")
            .expect("notorrent source");
        assert_eq!(notorrent_summary.provider, "LivNet");
        assert_eq!(notorrent_summary.releaseGroup, "Stremio addon HLS");

        let lordflix_summary = sources
            .iter()
            .find(|source| source.primary == "LordFlix")
            .expect("lordflix source");
        assert_eq!(lordflix_summary.provider, "LivNet");
        assert_eq!(lordflix_summary.releaseGroup, "Multi-server native HLS");

        let neon_source = sources
            .iter()
            .find(|source| source.primary == "Neon")
            .expect("neon source summary");
        let neon_source = external_embed_source_for_source_hash(&metadata, &neon_source.sourceHash)
            .expect("matching neon external provider");
        assert_eq!(neon_source.provider.id, "videasy");
        assert_eq!(neon_source.server.map(|server| server.id), Some("NEON"));

        let vidlink_source = external_embed_sources()
            .into_iter()
            .find(|source| source.provider.id == "vidlink" && source.server.is_none())
            .expect("vidlink fallback source");
        assert_eq!(
            external_embed_url(vidlink_source, &metadata).unwrap(),
            "https://vidlink.pro/movie/1368166"
        );

        let tv_metadata = sample_tv_metadata();
        let videasy_source = external_embed_sources()
            .into_iter()
            .find(|source| source.provider.id == "videasy" && source.server.is_none())
            .expect("videasy fallback source");
        assert_eq!(
            external_embed_url(videasy_source, &tv_metadata).unwrap(),
            "https://player.videasy.to/tv/76331/1/1?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=false&overlay=true&color=ffd700"
        );
        assert_eq!(
            external_embed_url(vidlink_source, &tv_metadata).unwrap(),
            "https://vidlink.pro/tv/76331/1/1"
        );

        let tv_sources = build_external_embed_source_summaries(&tv_metadata, &health_scores);
        assert_eq!(tv_sources.len(), 14);
        assert_eq!(tv_sources[0].primary, "VidLink");
        assert_eq!(tv_sources[0].provider, "LivNet");
        assert_eq!(tv_sources[1].primary, "VidRock");
        assert_eq!(tv_sources[2].primary, "NoTorrent");
    }

    #[test]
    fn default_external_embed_prefers_hls_sources() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::new();
        let source =
            default_external_embed_source(&metadata, &health_scores).expect("default embed source");
        assert_eq!(source.provider.id, "vidlink");
        assert_eq!(source.server.map(|server| server.id), None);

        let tv_metadata = sample_tv_metadata();
        let tv_source = default_external_embed_source(&tv_metadata, &health_scores)
            .expect("default tv embed source");
        assert_eq!(tv_source.provider.id, "vidlink");
        assert_eq!(tv_source.server.map(|server| server.id), None);

        let filters = ResolveFilters {
            source_hash: String::new(),
            preferred_container: String::new(),
            source_filters: sample_source_filters(),
        };
        assert!(should_prefer_default_external_embed(
            &filters,
            ResolverProvider::Fastest
        ));
        assert!(!should_prefer_default_external_embed(
            &filters,
            ResolverProvider::LocalTorrent
        ));
    }

    #[test]
    fn default_external_embed_native_fallback_can_try_hls_sources() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::new();
        let source =
            default_external_embed_source(&metadata, &health_scores).expect("default embed source");
        assert_eq!(source.provider.id, "vidlink");
        assert_eq!(source.server.map(|server| server.id), None);

        let candidates =
            external_embed_hls_candidate_sources(source, &metadata, true, &health_scores);
        let source_ids = candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.provider.id,
                    candidate
                        .server
                        .map(|server| server.id)
                        .unwrap_or("default"),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(source_ids.first(), Some(&("vidlink", "default")));
        assert_eq!(source_ids.get(1), Some(&("vidrock", "default")));
        assert_eq!(source_ids.get(2), Some(&("notorrent", "default")));
        assert_eq!(source_ids.get(3), Some(&("vixsrc", "default")));
        assert_eq!(source_ids.get(4), Some(&("lordflix", "default")));
        assert_eq!(source_ids.get(5), Some(&("videasy", "default")));
        assert_eq!(source_ids.get(6), Some(&("videasy", "YORU")));
        assert_eq!(source_ids.len(), 7);

        let tv_metadata = sample_tv_metadata();
        let tv_source = default_external_embed_source(&tv_metadata, &health_scores)
            .expect("default tv embed source");
        let tv_candidates =
            external_embed_hls_candidate_sources(tv_source, &tv_metadata, true, &health_scores);
        let tv_source_ids = tv_candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.provider.id,
                    candidate
                        .server
                        .map(|server| server.id)
                        .unwrap_or("default"),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(tv_source_ids.first(), Some(&("vidlink", "default")));
        assert_eq!(tv_source_ids.get(1), Some(&("vidrock", "default")));
        assert_eq!(tv_source_ids.get(2), Some(&("notorrent", "default")));
        assert_eq!(tv_source_ids.get(3), Some(&("vixsrc", "default")));
        assert_eq!(tv_source_ids.get(4), Some(&("lordflix", "default")));
        assert_eq!(tv_source_ids.get(5), Some(&("videasy", "default")));
        assert_eq!(tv_source_ids.get(6), Some(&("videasy", "YORU")));
        assert_eq!(tv_source_ids.len(), 7);

        let neon_source = external_embed_sources()
            .into_iter()
            .find(|source| {
                source.provider.id == "videasy"
                    && source
                        .server
                        .map(|server| server.id == "NEON")
                        .unwrap_or(false)
            })
            .expect("neon source");
        let pinned_candidates =
            external_embed_hls_candidate_sources(neon_source, &metadata, false, &health_scores);
        assert_eq!(pinned_candidates, vec![neon_source]);
    }

    #[test]
    fn external_embed_unhealthy_sources_skip_auto_fallback() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::from([(
            external_embed_source_hash(
                external_embed_sources()
                    .into_iter()
                    .find(|source| source.provider.id == "vidrock")
                    .expect("vidrock source"),
                &metadata,
            ),
            SOURCE_HEALTH_AVOID_SCORE - 500,
        )]);
        let source =
            default_external_embed_source(&metadata, &health_scores).expect("default embed source");
        let candidates =
            external_embed_hls_candidate_sources(source, &metadata, true, &health_scores);
        let provider_ids = candidates
            .iter()
            .map(|candidate| candidate.provider.id)
            .collect::<Vec<_>>();
        assert!(!provider_ids.contains(&"vidrock"));

        let icefy_source = external_embed_sources()
            .into_iter()
            .find(|source| source.provider.id == "icefy")
            .expect("icefy source");
        let pinned_candidates =
            external_embed_hls_candidate_sources(icefy_source, &metadata, false, &health_scores);
        assert_eq!(pinned_candidates, vec![icefy_source]);
    }

    #[test]
    fn external_embed_positive_health_does_not_override_vidlink_baseline() {
        let metadata = sample_movie_metadata();
        let mut health_scores = HashMap::new();
        for source in external_embed_sources() {
            if source.provider.id == "vidlink" {
                continue;
            }
            health_scores.insert(external_embed_source_hash(source, &metadata), 150);
        }

        let source =
            default_external_embed_source(&metadata, &health_scores).expect("default embed source");
        assert_eq!(source.provider.id, "vidlink");
        assert_eq!(source.server.map(|server| server.id), None);

        let capped = compute_external_embed_rank_health_score(&SourceHealthStats {
            success_count: 12,
            ..SourceHealthStats::default()
        });
        assert_eq!(capped, 75);

        let failed = compute_external_embed_rank_health_score(&SourceHealthStats {
            failure_count: 1,
            ..SourceHealthStats::default()
        });
        assert!(failed < SOURCE_HEALTH_AVOID_SCORE);
    }

    #[test]
    fn selected_external_embed_sources_are_native_hls_only() {
        let metadata = sample_movie_metadata();
        let neon_source = external_embed_sources()
            .into_iter()
            .find(|source| {
                source.provider.id == "videasy"
                    && source
                        .server
                        .map(|server| server.id == "NEON")
                        .unwrap_or(false)
            })
            .expect("neon source");

        let health_scores = HashMap::new();
        let pinned_candidates =
            external_embed_hls_candidate_sources(neon_source, &metadata, false, &health_scores);
        assert_eq!(pinned_candidates, vec![neon_source]);
        assert!(
            pinned_candidates
                .iter()
                .all(|source| is_external_embed_hls_capable_source(*source))
        );
    }

    #[test]
    fn external_embed_hls_resolver_accepts_public_playlist_hosts() {
        let videasy_embed: url::Url = "https://player.videasy.to/movie/1368166?color=ffd700"
            .parse()
            .expect("videasy embed");
        let legacy_videasy_embed: url::Url =
            "https://player.videasy.net/movie/1368166?color=ffd700"
                .parse()
                .expect("legacy videasy embed");
        let vidlink_embed: url::Url = "https://vidlink.pro/movie/1368166"
            .parse()
            .expect("vidlink embed");
        let unsupported_embed: url::Url = "https://example.com/embed/movie/1368166"
            .parse()
            .expect("unsupported embed");
        let hls: url::Url = "https://easy.speedsterwave.app/example/index.m3u8"
            .parse()
            .expect("hls url");
        let yoru_hls: url::Url = "https://yoru.midwesteagle.com/video.m3u8"
            .parse()
            .expect("yoru hls url");
        let mousedoor_hls: url::Url = "https://hello.mousedoor.com/example/index.m3u8"
            .parse()
            .expect("mousedoor hls url");
        let vidlink_hls: url::Url = "https://storm.vodvidl.site/example/index.m3u8"
            .parse()
            .expect("vidlink hls url");
        let rotated_hls: url::Url = "https://new-videasy-cdn.example.com/example/index.m3u8"
            .parse()
            .expect("rotated hls url");
        let unsupported_local_hls: url::Url = "https://localhost/example/index.m3u8"
            .parse()
            .expect("unsupported local hls url");
        let unsupported_ip_hls: url::Url = "https://127.0.0.1/example/index.m3u8"
            .parse()
            .expect("unsupported ip hls url");
        let unsupported_non_hls: url::Url = "https://cdn.example.com/example/video.mp4"
            .parse()
            .expect("unsupported non-hls url");

        assert!(is_supported_external_embed_hls_embed_url(&videasy_embed));
        assert!(is_supported_external_embed_hls_embed_url(
            &legacy_videasy_embed
        ));
        assert!(is_supported_external_embed_hls_embed_url(&vidlink_embed));
        assert!(!is_supported_external_embed_hls_embed_url(
            &unsupported_embed
        ));
        assert!(is_supported_external_embed_hls_url(&hls));
        assert!(is_supported_external_embed_hls_url(&yoru_hls));
        assert!(is_supported_external_embed_hls_url(&mousedoor_hls));
        assert!(is_supported_external_embed_hls_url(&vidlink_hls));
        assert!(is_supported_external_embed_hls_url(&rotated_hls));
        assert!(!is_supported_external_embed_hls_url(&unsupported_local_hls));
        assert!(!is_supported_external_embed_hls_url(&unsupported_ip_hls));
        assert!(!is_supported_external_embed_hls_url(&unsupported_non_hls));
    }

    #[test]
    fn external_embed_public_hls_hostname_rejects_local_or_malformed_hosts() {
        assert!(is_public_external_embed_hls_hostname("media.example.com"));
        assert!(is_public_external_embed_hls_hostname("cdn-1.example.net"));
        assert!(!is_public_external_embed_hls_hostname("localhost"));
        assert!(!is_public_external_embed_hls_hostname("media.local"));
        assert!(!is_public_external_embed_hls_hostname(
            "internal.service.internal"
        ));
        assert!(!is_public_external_embed_hls_hostname("127.0.0.1"));
        assert!(!is_public_external_embed_hls_hostname("example..com"));
        assert!(!is_public_external_embed_hls_hostname(
            "bad_host.example.com"
        ));
    }

    #[test]
    fn parses_seed_counts() {
        assert_eq!(parse_seed_count("Torrent 👤 1,234"), 1234);
    }

    #[test]
    fn parses_stream_size_labels() {
        assert_eq!(parse_size_label_bytes("2.5 GB"), 2_684_354_560);
        assert_eq!(parse_size_label_bytes("900 MB"), 943_718_400);
        assert_eq!(parse_size_label_bytes(""), 0);
    }

    #[test]
    fn normalizes_allowed_formats_to_supported_video_containers() {
        assert_eq!(
            normalize_allowed_formats("mkv, mp4 avi"),
            vec!["mkv", "mp4"]
        );
    }

    #[test]
    fn maps_real_debrid_provider_codes_to_readable_errors() {
        assert_eq!(
            user_facing_real_debrid_error("infringing_file"),
            "Real-Debrid blocked this source."
        );
        assert_eq!(
            user_facing_real_debrid_error("too_many_requests"),
            "Real-Debrid is rate limiting requests. Try again shortly."
        );
    }

    #[test]
    fn normalizes_resolver_provider_preference() {
        assert_eq!(normalize_resolver_provider(""), ResolverProvider::Fastest);
        assert_eq!(
            normalize_resolver_provider("fastest"),
            ResolverProvider::Fastest
        );
        assert_eq!(
            normalize_resolver_provider("local-torrent"),
            ResolverProvider::LocalTorrent
        );
        assert_eq!(
            normalize_resolver_provider("real-debrid"),
            ResolverProvider::RealDebrid
        );
        assert_eq!(
            normalize_resolver_provider("unexpected"),
            ResolverProvider::Fastest
        );
        assert!(ResolverProvider::RealDebrid.is_real_debrid());
        assert!(!ResolverProvider::LocalTorrent.is_real_debrid());
        assert!(ResolverProvider::Fastest.is_fastest());
    }

    #[test]
    fn real_debrid_and_fastest_reuse_real_debrid_sessions() {
        assert_eq!(
            ResolverProvider::Fastest.cache_reuse_provider(),
            ResolverProvider::RealDebrid
        );
        assert_eq!(
            ResolverProvider::RealDebrid.cache_reuse_provider(),
            ResolverProvider::RealDebrid
        );
        assert_eq!(
            ResolverProvider::LocalTorrent.cache_reuse_provider(),
            ResolverProvider::LocalTorrent
        );
    }

    #[test]
    fn classifies_persistent_source_resolve_failures() {
        assert!(is_persistent_source_resolve_error(
            &ApiError::failed_dependency("Real-Debrid blocked this source.")
        ));
        assert!(is_persistent_source_resolve_error(&ApiError::bad_gateway(
            "Real-Debrid blocked this source."
        )));
        assert!(is_persistent_source_resolve_error(&ApiError::internal(
            RD_SELECTED_FILE_MISMATCH_ERROR
        )));
        assert!(!is_persistent_source_resolve_error(&ApiError::bad_gateway(
            "Real-Debrid is rate limiting requests. Try again shortly."
        )));
    }

    #[test]
    fn normalizes_resolve_lock_keys() {
        assert_eq!(
            build_movie_resolve_lock_key(
                " 123 ",
                "EN",
                "1080",
                "Off",
                "bad",
                " local-torrent:123:en:1080p ",
                "5",
                "mkv mp4",
                "EN",
                "single",
                ResolverProvider::RealDebrid,
                false,
            ),
            "movie|provider:real-debrid|skipEmbed:0|tmdb:123|audio:en|sub:off|quality:1080p|session:local-torrent:123:en:1080p|hash:|min:5|formats:mkv,mp4|lang:en|profile:single"
        );
        assert_eq!(
            build_tv_resolve_lock_key(
                "123",
                "",
                "2",
                "",
                "7",
                "auto",
                "4k",
                "en",
                "mp4",
                "",
                "",
                "",
                "mp4",
                "auto",
                "multi",
                ResolverProvider::LocalTorrent,
                false,
            ),
            "tv|provider:local-torrent|skipEmbed:0|tmdb:123|s:2|e:7|audio:auto|sub:en|quality:2160p|container:mp4|session:|hash:|min:0|formats:mp4|lang:any|profile:any"
        );
    }

    #[test]
    fn builds_episode_scoped_tv_playback_session_keys() {
        assert_eq!(
            build_playback_session_key_for_metadata(
                &sample_tv_metadata(),
                "EN",
                "1080",
                ResolverProvider::RealDebrid
            ),
            "tv:76331:s1:e1:en:1080p"
        );
        assert_eq!(
            build_playback_session_key_for_metadata(
                &sample_movie_metadata(),
                "EN",
                "1080",
                ResolverProvider::LocalTorrent
            ),
            "local-torrent:1368166:en:1080p"
        );
        assert_eq!(
            build_playback_session_key_for_metadata(
                &sample_movie_metadata(),
                "EN",
                "1080",
                ResolverProvider::RealDebrid
            ),
            "1368166:en:1080p"
        );
        assert_eq!(
            build_user_scoped_playback_session_key_for_metadata(
                &sample_movie_metadata(),
                "EN",
                "1080",
                ResolverProvider::RealDebrid,
                42
            ),
            "real-debrid:user:42:1368166:en:1080p"
        );
        assert!(playback_session_key_allowed_for_user(
            "real-debrid:user:42:1368166:en:1080p",
            ResolverProvider::RealDebrid,
            42
        ));
        assert!(!playback_session_key_allowed_for_user(
            "1368166:en:1080p",
            ResolverProvider::RealDebrid,
            42
        ));
    }

    #[test]
    fn latest_playback_session_fallback_allows_unpinned_requests() {
        let mut filters = ResolveFilters {
            source_hash: String::new(),
            preferred_container: String::new(),
            source_filters: sample_source_filters(),
        };
        assert!(should_allow_latest_playback_session_fallback(&filters));

        filters.source_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
        assert!(!should_allow_latest_playback_session_fallback(&filters));
    }

    #[test]
    fn pinned_source_hash_can_reuse_matching_playback_session() {
        let filters = ResolveFilters {
            source_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            preferred_container: String::new(),
            source_filters: sample_source_filters(),
        };
        let matching_session = PlaybackSession {
            source_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            ..PlaybackSession::default()
        };
        let different_session = PlaybackSession {
            source_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
            ..PlaybackSession::default()
        };

        assert!(!should_skip_playback_session_reuse(&filters));
        assert!(playback_session_matches_source_hash(
            &matching_session,
            &filters
        ));
        assert!(!playback_session_matches_source_hash(
            &different_session,
            &filters
        ));
    }

    #[test]
    fn tracks_external_resolver_guard_lifecycle() {
        let metrics = Arc::new(ResolverMetrics::default());
        let semaphore = Arc::new(Semaphore::new(1));
        {
            let permit = semaphore
                .clone()
                .try_acquire_owned()
                .expect("acquire first resolver permit");
            let mut guard = ResolverExternalGuard::new(metrics.clone(), permit);
            assert_eq!(metrics.external_active.load(Ordering::Relaxed), 1);
            assert_eq!(metrics.external_started.load(Ordering::Relaxed), 1);
            guard.mark_completed();
        }

        assert_eq!(metrics.external_active.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.external_completed.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.external_failed.load(Ordering::Relaxed), 0);

        {
            let permit = semaphore
                .try_acquire_owned()
                .expect("acquire second resolver permit");
            let _guard = ResolverExternalGuard::new(metrics.clone(), permit);
        }

        assert_eq!(metrics.external_active.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.external_started.load(Ordering::Relaxed), 2);
        assert_eq!(metrics.external_completed.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.external_failed.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn parses_runtime_labels() {
        assert_eq!(parse_runtime_from_label_seconds("2h 10m"), 7800);
        assert_eq!(parse_runtime_from_label_seconds("01:45:00"), 6300);
    }

    #[test]
    fn collects_episode_signatures_from_common_labels() {
        assert_eq!(
            collect_episode_signatures("Show.S02E07.1080p", Some(2)),
            vec!["2x7"]
        );
    }

    #[test]
    fn extracts_stream_filename() {
        let stream = DiscoveryStream {
            infoHash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            name: "Torrentio".to_owned(),
            title: String::new(),
            description: String::new(),
            behaviorHints: DiscoveryBehaviorHints {
                filename: "Movie.2024.mp4".to_owned(),
            },
            sources: Vec::new(),
            ..DiscoveryStream::default()
        };
        assert_eq!(stream.behaviorHints.filename, "Movie.2024.mp4");
    }

    #[test]
    fn normalizes_torrentio_stream_cache_keys() {
        assert_eq!(
            build_torrentio_stream_cache_key(
                "https://torrentio.strem.fun/",
                "/stream/movie/tt1.json"
            ),
            "torrentio:https://torrentio.strem.fun/stream/movie/tt1.json"
        );
    }

    #[test]
    fn builds_torznab_urls_without_leaking_api_keys_to_cache_keys() {
        let params = vec![
            ("t", "movie".to_owned()),
            ("imdbid", "tt1234567".to_owned()),
            ("cat", "2000,2040".to_owned()),
            ("limit", "50".to_owned()),
            ("extended", "1".to_owned()),
        ];
        let request_url = build_torznab_request_url(
            "http://127.0.0.1:9696/1/api?apikey=old-key&profile=default",
            "new-key",
            &params,
        )
        .expect("build torznab url");
        assert!(request_url.contains("profile=default"));
        assert!(request_url.contains("apikey=new-key"));
        assert!(!request_url.contains("old-key"));
        assert!(request_url.contains("t=movie"));
        assert!(request_url.contains("imdbid=tt1234567"));

        let cache_key = build_torznab_stream_cache_key(
            "http://127.0.0.1:9696/1/api?apikey=old-key&profile=default",
            &params,
        );
        assert!(cache_key.starts_with("torznab:http://127.0.0.1:9696/1/api?"));
        assert!(cache_key.contains("profile=default"));
        assert!(cache_key.contains("imdbid=tt1234567"));
        assert!(!cache_key.contains("apikey"));
        assert!(!cache_key.contains("old-key"));
    }

    #[test]
    fn extracts_info_hash_from_magnet_urls() {
        assert_eq!(
            extract_info_hash_from_magnet(
                "magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Movie"
            ),
            "abcdef0123456789abcdef0123456789abcdef01"
        );
        assert!(extract_info_hash_from_magnet("https://example.com/file.torrent").is_empty());
    }

    #[test]
    fn parses_torznab_xml_into_discovery_streams() {
        let xml = r#"
            <rss>
              <channel>
                <item>
                  <title>The Housemaid 2025 1080p WEB-DL x264-GROUP</title>
                  <link>magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&amp;dn=The.Housemaid</link>
                  <jackettindexer>ExampleIndexer</jackettindexer>
                  <torznab:attr name="seeders" value="321" />
                  <torznab:attr name="size" value="1610612736" />
                  <torznab:attr name="team" value="GROUP" />
                </item>
                <item>
                  <title>No usable hash</title>
                  <link>https://example.com/file.torrent</link>
                </item>
              </channel>
            </rss>
        "#;
        let streams = parse_torznab_xml(xml).expect("parse torznab");
        assert_eq!(streams.len(), 1);
        let stream = &streams[0];
        assert_eq!(stream.infoHash, "abcdef0123456789abcdef0123456789abcdef01");
        assert_eq!(stream.name, "Torznab - ExampleIndexer");
        assert_eq!(stream.discoveryProvider, "torznab");
        assert!(stream.magnetUrl.starts_with("magnet:?"));
        assert_eq!(parse_seed_count(&stream.title), 321);
        assert!(stream.title.contains("💾 1.5 GB"));
        assert!(stream.title.contains("⚙ GROUP"));
    }

    #[test]
    fn torznab_fallback_decision_matches_failure_only_policy() {
        assert!(!should_try_torznab_discovery(false, false, false, false));
        assert!(should_try_torznab_discovery(true, false, false, false));
        assert!(should_try_torznab_discovery(false, true, false, false));
        assert!(should_try_torznab_discovery(false, false, true, false));
        assert!(should_try_torznab_discovery(false, false, false, true));
    }

    #[test]
    fn normalizes_rd_torrent_cache_keys() {
        assert_eq!(
            build_rd_torrent_cache_key("ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
            "rd-torrent:abcdef0123456789abcdef0123456789abcdef01"
        );
        assert_eq!(
            build_scoped_rd_torrent_cache_key(
                "user:42",
                "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
            ),
            "rd-torrent:user:42:abcdef0123456789abcdef0123456789abcdef01"
        );
    }

    #[test]
    fn detects_real_debrid_selected_file_mismatch() {
        let ready_info = json!({
            "status": "downloaded",
            "files": [
                {"id": 2, "path": "/Succession.S01E01.mp4", "selected": 1},
                {"id": 3, "path": "/Succession.S01E02.mp4", "selected": 0}
            ],
            "links": ["https://real-debrid.example/file"]
        });

        assert!(!ready_info_has_selected_file_id(&ready_info, 3));
        assert!(ready_info_has_selected_file_id(&ready_info, 2));
    }

    #[test]
    fn prefers_direct_for_browser_safe_real_debrid_mp4_sources() {
        assert!(!should_prefer_software_decode_source(
            "https://126-4.download.real-debrid.com/path/The.Matrix.1999.1080p.mp4",
            "The.Matrix.1999.1080p.mp4"
        ));

        let normalized = normalize_resolved_source_for_software_decode(
            &ResolvedSource {
                playable_url:
                    "https://126-4.download.real-debrid.com/path/The.Matrix.1999.1080p.mp4"
                        .to_owned(),
                filename: "The.Matrix.1999.1080p.mp4".to_owned(),
                ..ResolvedSource::default()
            },
            -1,
            -1,
        );

        assert_eq!(
            normalized.playable_url,
            "https://126-4.download.real-debrid.com/path/The.Matrix.1999.1080p.mp4"
        );
        assert_eq!(
            normalized.fallback_urls,
            vec![
                "/api/remux?input=https%3A%2F%2F126-4.download.real-debrid.com%2Fpath%2FThe.Matrix.1999.1080p.mp4"
            ]
        );
    }

    #[test]
    fn omits_raw_mkv_fallback_when_remux_is_required() {
        let raw = "https://126-4.download.real-debrid.com/path/Succession.S01E01.mkv";

        let normalized = normalize_resolved_source_for_software_decode(
            &ResolvedSource {
                playable_url: raw.to_owned(),
                filename: "Succession.S01E01.mkv".to_owned(),
                fallback_urls: vec![raw.to_owned()],
                ..ResolvedSource::default()
            },
            1,
            -1,
        );

        assert!(normalized.playable_url.starts_with("/api/remux?"));
        assert!(normalized.fallback_urls.is_empty());
    }

    #[test]
    fn computes_torrentio_cache_deadlines_from_payload() {
        let before = now_ms();
        let payload = json!({
            "cacheMaxAge": 60,
            "staleRevalidate": 120,
            "staleError": 300
        });
        let (expires_at, next_validation_at) = compute_torrentio_cache_deadlines(&payload);
        assert!(next_validation_at >= before + 60_000);
        assert!(expires_at >= next_validation_at + 300_000);
    }

    fn sample_movie_metadata() -> ResolveMetadata {
        ResolveMetadata {
            tmdb_id: "1368166".to_owned(),
            imdb_id: "tt0000001".to_owned(),
            display_title: "The Housemaid".to_owned(),
            display_year: "2025".to_owned(),
            runtime_seconds: 6_720,
            season_number: 0,
            episode_number: 0,
            episode_title: String::new(),
            media_type: "movie".to_owned(),
        }
    }

    fn sample_tv_metadata() -> ResolveMetadata {
        ResolveMetadata {
            tmdb_id: "76331".to_owned(),
            imdb_id: "tt7660850".to_owned(),
            display_title: "Succession".to_owned(),
            display_year: "2018".to_owned(),
            runtime_seconds: 3_840,
            season_number: 1,
            episode_number: 1,
            episode_title: "Celebration".to_owned(),
            media_type: "tv".to_owned(),
        }
    }

    fn sample_stream(title: &str, info_hash: &str) -> DiscoveryStream {
        DiscoveryStream {
            infoHash: info_hash.to_owned(),
            name: "Torrentio".to_owned(),
            title: title.to_owned(),
            description: "English audio • 1h 52m • 👤 950".to_owned(),
            behaviorHints: DiscoveryBehaviorHints::default(),
            sources: Vec::new(),
            ..DiscoveryStream::default()
        }
    }

    fn sample_source_filters() -> SourceFilters {
        SourceFilters {
            min_seeders: 0,
            allowed_formats: Vec::new(),
            source_language: "en".to_owned(),
            source_audio_profile: "single".to_owned(),
        }
    }

    #[test]
    fn fastest_race_candidates_include_local_friendly_sources() {
        let ranked_huge = sample_stream(
            "The Matrix 1999 2160p Remux.mkv\n💾 76 GB\n👤 300",
            "1111111111111111111111111111111111111111",
        );
        let ranked_large = sample_stream(
            "The Matrix 1999 2160p WEB-DL.mkv\n💾 24 GB\n👤 180",
            "2222222222222222222222222222222222222222",
        );
        let small_mp4 = sample_stream(
            "The Matrix 1999 1080p BluRay.x265.mp4\n💾 2.2 GB\n👤 2,400",
            "3333333333333333333333333333333333333333",
        );
        let medium_mkv = sample_stream(
            "The Matrix 1999 1080p BluRay.mkv\n💾 8 GB\n👤 650",
            "4444444444444444444444444444444444444444",
        );
        let candidates = vec![&ranked_huge, &ranked_large, &medium_mkv, &small_mp4];

        let selected = select_fastest_race_candidates(candidates);

        assert_eq!(selected.len(), 4);
        assert_eq!(selected[0].infoHash, ranked_huge.infoHash);
        assert_eq!(selected[1].infoHash, ranked_large.infoHash);
        assert!(
            selected
                .iter()
                .any(|item| item.infoHash == small_mp4.infoHash)
        );
    }

    #[test]
    fn deprioritizes_ts_releases_against_comparable_web_sources() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::from([
            ("1111111111111111111111111111111111111111".to_owned(), 1200),
            ("2222222222222222222222222222222222222222".to_owned(), 0),
        ]);
        let ts = sample_stream(
            "The Housemaid 2025 1080p TS EN-RGB\n⚙ TS-GROUP",
            "1111111111111111111111111111111111111111",
        );
        let web = sample_stream(
            "The Housemaid 2025 1080p AMZN WEB-DL DDP5.1 H.264-BYNDR\n⚙ BYNDR",
            "2222222222222222222222222222222222222222",
        );

        let ranked = sort_movie_candidates(
            vec![&ts, &web],
            &metadata,
            "en",
            "auto",
            &sample_source_filters(),
            &health_scores,
        );

        assert_eq!(ranked[0].infoHash, web.infoHash);
        assert_eq!(ranked[1].infoHash, ts.infoHash);
    }

    #[test]
    fn prefers_single_audio_release_over_explicit_multi_audio_pack() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::new();
        let single_audio = sample_stream(
            "The Housemaid 2025 1080p AMZN WEB-DL English\n⚙ BYNDR",
            "3333333333333333333333333333333333333333",
        );
        let multi_audio = sample_stream(
            "The Housemaid 2025 1080p AMZN WEB-DL Multi Audio English\n⚙ PACK",
            "4444444444444444444444444444444444444444",
        );

        let ranked = sort_movie_candidates(
            vec![&multi_audio, &single_audio],
            &metadata,
            "auto",
            "auto",
            &sample_source_filters(),
            &health_scores,
        );

        assert_eq!(ranked[0].infoHash, single_audio.infoHash);
        assert_eq!(ranked[1].infoHash, multi_audio.infoHash);
    }

    #[test]
    fn filename_match_does_not_treat_webrip_suffix_as_title_match() {
        assert!(does_filename_likely_match_movie(
            "The.Rip.2026.1080p.WEBRip.x265.10bit.AAC5.1-[YTS.BZ].mp4",
            "The Rip",
            "2026"
        ));
        assert!(!does_filename_likely_match_movie(
            r#"2024-10-10 - "Multiple Alien Groups May Be Visiting Earth!" (Lue Elizondo Documentary).mp4"#,
            "The Rip",
            "2026"
        ));
    }

    #[test]
    fn filters_unrelated_sources_for_short_movie_titles() {
        let mut metadata = sample_movie_metadata();
        metadata.display_title = "The Rip".to_owned();
        metadata.display_year = "2026".to_owned();

        let good = sample_stream(
            "The.Rip.2026.1080p.WEBRip.x265.10bit.AAC5.1-[YTS.BZ].mp4\n👤 604",
            "5555555555555555555555555555555555555555",
        );
        let unrelated = sample_stream(
            r#"2024-10-10 - "Multiple Alien Groups May Be Visiting Earth!" (Lue Elizondo Documentary).mp4
👤 999"#,
            "6666666666666666666666666666666666666666",
        );

        let streams = vec![good.clone(), unrelated.clone()];
        let selected = select_top_movie_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "",
            5,
            &sample_source_filters(),
            &HashMap::new(),
        );

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].infoHash, good.infoHash);
    }

    #[test]
    fn avoids_failed_mp4_default_candidate_when_health_is_bad() {
        let metadata = sample_movie_metadata();
        let bad_mp4 = sample_stream(
            "The Housemaid 2025 1080p BluRay x265-GROUP.mp4\n👤 1000",
            "9999999999999999999999999999999999999999",
        );
        let good_mkv = sample_stream(
            "The Housemaid 2025 1080p BluRay x265-GROUP.mkv\n👤 5",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let streams = vec![bad_mp4.clone(), good_mkv.clone()];
        let health_scores = HashMap::from([(
            "9999999999999999999999999999999999999999".to_owned(),
            SOURCE_HEALTH_AVOID_SCORE - 1_000,
        )]);

        let selected = select_top_movie_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "",
            1,
            &sample_source_filters(),
            &health_scores,
        );

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].infoHash, good_mkv.infoHash);
    }

    #[test]
    fn prefers_mp4_for_tv_episode_auto_container_when_unpinned() {
        let metadata = sample_tv_metadata();
        let high_seed_mkv = sample_stream(
            "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );
        let direct_mp4 = sample_stream(
            "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 5",
            "cccccccccccccccccccccccccccccccccccccccc",
        );
        let streams = vec![high_seed_mkv.clone(), direct_mp4.clone()];

        let selected = select_top_episode_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "auto",
            "",
            2,
            &sample_source_filters(),
            &HashMap::new(),
        );

        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].infoHash, direct_mp4.infoHash);
        assert_eq!(selected[1].infoHash, high_seed_mkv.infoHash);
    }

    #[test]
    fn keeps_mp4_alternates_ahead_of_mkv_for_tv_default() {
        let metadata = sample_tv_metadata();
        let high_seed_mkv = sample_stream(
            "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );
        let first_mp4 = sample_stream(
            "Succession S01E01 1080p.mp4\n👤 42",
            "cccccccccccccccccccccccccccccccccccccccc",
        );
        let second_mp4 = sample_stream(
            "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 9",
            "dddddddddddddddddddddddddddddddddddddddd",
        );
        let streams = vec![high_seed_mkv.clone(), first_mp4.clone(), second_mp4.clone()];

        let selected = select_top_episode_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "auto",
            "",
            3,
            &sample_source_filters(),
            &HashMap::new(),
        );

        assert_eq!(selected.len(), 3);
        assert_eq!(selected[0].infoHash, first_mp4.infoHash);
        assert_eq!(selected[1].infoHash, second_mp4.infoHash);
        assert_eq!(selected[2].infoHash, high_seed_mkv.infoHash);
    }

    #[test]
    fn keeps_pinned_tv_episode_source_ahead_of_default_mp4() {
        let metadata = sample_tv_metadata();
        let pinned_mkv = sample_stream(
            "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
            "dddddddddddddddddddddddddddddddddddddddd",
        );
        let direct_mp4 = sample_stream(
            "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 5",
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        );
        let streams = vec![direct_mp4.clone(), pinned_mkv.clone()];

        let selected = select_top_episode_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "auto",
            &pinned_mkv.infoHash,
            2,
            &sample_source_filters(),
            &HashMap::new(),
        );

        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].infoHash, pinned_mkv.infoHash);
    }

    #[test]
    fn skips_non_mp4_playback_session_for_mp4_container_preference() {
        let filters = ResolveFilters {
            source_hash: String::new(),
            preferred_container: "mp4".to_owned(),
            source_filters: sample_source_filters(),
        };
        let mkv_session = PlaybackSession {
            filename: "Succession.S01E01.1080p.WEB-DL.mkv".to_owned(),
            playable_url:
                "/api/remux?input=https%3A%2F%2Fdownload.real-debrid.com%2FSuccession.S01E01.mkv"
                    .to_owned(),
            metadata: json!({
                "subtitleTargetFilePath": "/Succession.S01E01.1080p.WEB-DL.mkv"
            }),
            ..PlaybackSession::default()
        };
        let mp4_session = PlaybackSession {
            filename: "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4".to_owned(),
            playable_url:
                "https://download.real-debrid.com/Succession.S01E01.1080p.BluRay.x265-RARBG.mp4"
                    .to_owned(),
            ..PlaybackSession::default()
        };

        assert!(!playback_session_matches_preferred_container(
            &mkv_session,
            &filters
        ));
        assert!(playback_session_matches_preferred_container(
            &mp4_session,
            &filters
        ));
    }

    #[test]
    fn skips_heavy_unpinned_session_for_mobile_quality_preference() {
        let filters = ResolveFilters {
            source_hash: String::new(),
            preferred_container: String::new(),
            source_filters: sample_source_filters(),
        };
        let preferences = ResolvePreferences {
            audio_lang: "auto".to_owned(),
            subtitle_lang: "off".to_owned(),
            quality: "720p".to_owned(),
        };
        let session = PlaybackSession {
            preferred_quality: "auto".to_owned(),
            filename: "Off.Campus.S01E02.1080p.HEVC.x265-MeGusta.mkv".to_owned(),
            playable_url:
                "/api/remux?input=https%3A%2F%2Fdownload.real-debrid.com%2FOff.Campus.S01E02.1080p.HEVC.x265-MeGusta.mkv"
                    .to_owned(),
            ..PlaybackSession::default()
        };

        assert!(!playback_session_matches_preferred_quality(
            &session,
            &preferences,
            &filters
        ));

        let pinned_filters = ResolveFilters {
            source_hash: "1111111111111111111111111111111111111111".to_owned(),
            ..filters
        };
        assert!(playback_session_matches_preferred_quality(
            &session,
            &preferences,
            &pinned_filters
        ));
    }

    #[test]
    fn strongly_penalizes_persistent_source_resolve_failures() {
        let score = compute_source_health_score(&SourceHealthStats {
            success_count: 0,
            failure_count: 1,
            playback_error_count: 1,
            ..SourceHealthStats::default()
        });

        assert!(score < SOURCE_HEALTH_AVOID_SCORE);
    }

    #[test]
    fn torznab_candidates_use_existing_filters_and_hash_pinning() {
        let metadata = sample_movie_metadata();
        let torznab = DiscoveryStream {
            infoHash: "7777777777777777777777777777777777777777".to_owned(),
            name: "Torznab - ExampleIndexer".to_owned(),
            title: "The Housemaid 2025 1080p WEB-DL x264-GROUP\n💾 1.5 GB\n⚙ GROUP\n👤 80"
                .to_owned(),
            behaviorHints: DiscoveryBehaviorHints {
                filename: "The Housemaid 2025 1080p WEB-DL x264-GROUP".to_owned(),
            },
            discoveryProvider: "torznab".to_owned(),
            ..DiscoveryStream::default()
        };
        let low_seed = DiscoveryStream {
            infoHash: "8888888888888888888888888888888888888888".to_owned(),
            name: "Torznab - ExampleIndexer".to_owned(),
            title: "The Housemaid 2025 1080p WEB-DL x264-LOW\n👤 3".to_owned(),
            behaviorHints: DiscoveryBehaviorHints {
                filename: "The Housemaid 2025 1080p WEB-DL x264-LOW".to_owned(),
            },
            discoveryProvider: "torznab".to_owned(),
            ..DiscoveryStream::default()
        };
        let streams = vec![low_seed, torznab];
        let filters = SourceFilters {
            min_seeders: 50,
            allowed_formats: vec!["mkv".to_owned()],
            source_language: "en".to_owned(),
            source_audio_profile: "single".to_owned(),
        };
        let selected = select_top_movie_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "7777777777777777777777777777777777777777",
            5,
            &filters,
            &HashMap::new(),
        );

        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected[0].infoHash,
            "7777777777777777777777777777777777777777"
        );
        assert!(stream_list_contains_hash(
            &streams,
            "7777777777777777777777777777777777777777"
        ));
        assert!(!stream_list_contains_hash(
            &streams,
            "9999999999999999999999999999999999999999"
        ));
    }

    #[test]
    fn normalizes_source_audio_profile_to_single_by_default() {
        assert_eq!(normalize_source_audio_profile_filter(""), "single");
        assert_eq!(
            normalize_source_audio_profile_filter("single-audio"),
            "single"
        );
        assert_eq!(normalize_source_audio_profile_filter("multi-audio"), "any");
    }
}
