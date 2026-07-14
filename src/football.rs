use std::collections::BTreeSet;
use std::env;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode};
use dashmap::DashMap;
use futures_util::stream::{self, StreamExt};
use regex::Regex;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;
use url::Url;
use url::form_urlencoded::byte_serialize;

use crate::error::{ApiError, AppResult, json_response};
use crate::provider_registry;
use crate::routes::AppState;
use crate::utils::now_ms;

const STREAMED_SOURCE_ID: &str = "streamed";
const MATCHSTREAM_SOURCE_ID: &str = "matchstream";
const NTVS_SOURCE_ID: &str = "ntvs";
const CDNLIVETV_SOURCE_ID: &str = "cdnlivetv";
const ESPN_SOURCE_ID: &str = "espn";
const AUTO_SOURCE_ID: &str = "auto";
const STREAMED_FOOTBALL_CACHE_KEY: &str = "streamed:football";
const STREAMED_BASKETBALL_CACHE_KEY: &str = "streamed:basketball";
const STREAMED_TENNIS_CACHE_KEY: &str = "streamed:tennis";
const STREAMED_HOCKEY_CACHE_KEY: &str = "streamed:hockey";
const STREAMED_BASEBALL_CACHE_KEY: &str = "streamed:baseball";
const STREAMED_AMERICAN_FOOTBALL_CACHE_KEY: &str = "streamed:american-football";
const STREAMED_CRICKET_CACHE_KEY: &str = "streamed:cricket";
const MATCHSTREAM_FOOTBALL_CACHE_KEY: &str = "matchstream:football";
const MATCHSTREAM_BASKETBALL_CACHE_KEY: &str = "matchstream:basketball";
const MATCHSTREAM_TENNIS_CACHE_KEY: &str = "matchstream:tennis";
const MATCHSTREAM_HOCKEY_CACHE_KEY: &str = "matchstream:hockey";
const MATCHSTREAM_BASEBALL_CACHE_KEY: &str = "matchstream:baseball";
const MATCHSTREAM_AMERICAN_FOOTBALL_CACHE_KEY: &str = "matchstream:american-football";
const MATCHSTREAM_CRICKET_CACHE_KEY: &str = "matchstream:cricket";
const NTVS_FOOTBALL_CACHE_KEY: &str = "ntvs:football";
const ESPN_FOOTBALL_CACHE_KEY: &str = "espn:football";
pub(crate) const STREAMED_MATCHES_BASE_URL: &str = "https://streamed.pk/api/matches";
pub(crate) const STREAMED_FOOTBALL_MATCHES_URL: &str = "https://streamed.pk/api/matches/football";
pub(crate) const STREAMED_BASKETBALL_MATCHES_URL: &str =
    "https://streamed.pk/api/matches/basketball";
const STREAMED_REFERER: &str = "https://streamed.pk/";
const STREAMED_DEFAULT_DURATION_MINUTES: i64 = 180;
const STREAMED_USER_AGENT: &str = "Mozilla/5.0";
const STREAMED_EMBED_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-streamed-hls.mjs";
const STREAMED_EMBED_HLS_RESOLVER_RUNTIME_SCRIPT: &str = "bin/resolve-streamed-hls.mjs";
const STREAMED_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 24;
const STREAMED_EMBED_REFERER: &str = "https://embedsports.top/";
const MATCHSTREAM_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-matchstream-hls.mjs";
const MATCHSTREAM_HLS_RESOLVER_RUNTIME_SCRIPT: &str = "bin/resolve-matchstream-hls.mjs";
const MATCHSTREAM_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 24;
pub(crate) const MATCHSTREAM_WEBMASTER_URL: &str = "https://matchstream.do/webmaster";
pub(crate) const MATCHSTREAM_VIEWER_URL: &str = "https://matchstream.do/viewer";
const MATCHSTREAM_DEFAULT_DURATION_MINUTES: i64 = 180;
pub(crate) const NTVS_SEARCH_URL: &str = "https://ntvs.cx/api/search";
pub(crate) const ESPN_FOOTBALL_SCOREBOARD_URL: &str =
    "https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?limit=500";
const NTVS_REFERER: &str = "https://ntvs.cx/";
const NTVS_DEFAULT_SERVER: &str = "kobra";
const NTVS_FOOTBALL_SEARCH_QUERY: &str = "football";
const NTVS_DEFAULT_DURATION_MINUTES: i64 = 180;
const ESPN_DEFAULT_DURATION_MINUTES: i64 = 180;
const ESPN_MATCH_MERGE_TOLERANCE_MS: i64 = 2 * 60 * 60 * 1000;
const FOOTBALL_SCHEDULE_PROVIDER_TIMEOUT_MS: u64 = 3_500;
const NTVS_SCHEDULE_PROVIDER_TIMEOUT_MS: u64 = 5_000;
const NTVS_EMBED_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-ntvs-hls.mjs";
const NTVS_EMBED_HLS_RESOLVER_RUNTIME_SCRIPT: &str = "bin/resolve-ntvs-hls.mjs";
const NTVS_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 24;
// Fast path: a minimal-browser resolver (stub page + the site's lock.js WASM
// recipe) that skips bundle-jw.js/clappr/ads. Tried first; the full-page
// resolver above is the fallback. Shorter budget so a miss falls back quickly.
const NTVS_EMBED_MIN_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-embed-min.mjs";
const NTVS_EMBED_MIN_HLS_RESOLVER_RUNTIME_SCRIPT: &str = "bin/resolve-embed-min.mjs";
const NTVS_EMBED_MIN_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 12;
// The NTV watch page expands each coarse search source (admin/delta/golf) into
// individually labelled broadcaster feeds. Hydrate only live fixtures and keep
// this best-effort expansion comfortably inside the NTV schedule's 5 s budget.
const NTVS_LIVE_SOURCE_EXPANSION_TIMEOUT_MS: u64 = 2_500;
const NTVS_LIVE_SOURCE_EXPANSION_MAX_CONCURRENT: usize = 4;
const NTVS_LIVE_SOURCE_EXPANSION_MAX_MATCHES: usize = 4;
const NTVS_LIVE_SOURCE_EXPANSION_MAX_STREAMS: usize = 32;
// cdnlivetv.tv is the channel/IPTV upstream behind streamsports99.su: one schedule
// (`/events/sports/`) maps each game to a set of broadcast channels, each playable
// via a per-channel player page that mints a short-lived tokenized HLS URL. It's an
// independent source from streamed/ntvs (different CDN), so it merges into the
// per-match source picker as additional selectable broadcast feeds.
const CDNLIVETV_FOOTBALL_CACHE_KEY: &str = "cdnlivetv:football";
const CDNLIVETV_EVENTS_URL: &str =
    "https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free";
const CDNLIVETV_CHANNEL_PLAYER_BASE: &str = "https://cdnlivetv.tv/api/v1/channels/player/";
const CDNLIVETV_REFERER: &str = "https://cdnlivetv.tv/";
const CDNLIVETV_DEFAULT_DURATION_MINUTES: i64 = 180;
// Cap how many of a game's broadcast feeds we surface (events list up to ~40
// channels/game). Curated by quality + reputable broadcaster so the picker stays
// short and the highest-quality feeds win.
const CDNLIVETV_MAX_CHANNELS_PER_MATCH: usize = 8;
const CDNLIVETV_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-cdnlivetv-hls.mjs";
const CDNLIVETV_HLS_RESOLVER_RUNTIME_SCRIPT: &str = "bin/resolve-cdnlivetv-hls.mjs";
const CDNLIVETV_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 24;
const SPORTS_HTTP_PROXY_ENV: &str = "SPORTS_HTTP_PROXY";
const SPORTS_HTTP_CLIENT_TIMEOUT_SECONDS: u64 = 30;
const MAX_LIVE_STREAM_CANDIDATES: usize = 12;
const STREAMED_SOURCE_PREFLIGHT_MAX_CONCURRENT: usize = 8;
const STREAMED_SOURCE_PREFLIGHT_TIMEOUT_MS: u64 = 2_000;
const STREAMED_SOURCE_PREFLIGHT_BUDGET_MS: u64 = 2_500;
// Kobra can expose provider groups that its backing Streamed schedule omits.
// Keep page-specific additions scoped by event id; the normal preflight below
// validates them and drops them automatically once their stream rows disappear.
const NTVS_LINKED_SOURCE_OVERRIDES: &[(&str, i64, &str, &str)] = &[
    (
        "france-vs-spain-2528031",
        1_784_055_600_000,
        "admin",
        "ppv-france-vs-spain",
    ),
    (
        "france-vs-spain-2528031",
        1_784_055_600_000,
        "delta",
        "live_world-cup-knockout-stage_france-spain-live-streaming-538120800",
    ),
    (
        "france-vs-spain-2528031",
        1_784_055_600_000,
        "golf",
        "23742",
    ),
];
// Max candidate sources resolved at once during a first-watch preflight. Bounds
// concurrent (potentially browser-backed) resolves so it can't overload the box.
const SPORTS_PREFLIGHT_MAX_CONCURRENT: usize = 4;
const SPORTS_STREAM_RESOLVE_CACHE_TTL_MS: i64 = 60 * 1000;
/// How long a failed resolve is remembered. Without this, a dead source re-runs
/// its full resolver script (up to ~24s) on every player failover cycle and for
/// every viewer of the same match, tying up the small resolver permit pool.
/// Kept shorter than the success TTL so a source that comes alive mid-match
/// recovers quickly.
const SPORTS_STREAM_RESOLVE_FAILURE_TTL_MS: i64 = 45 * 1000;
const SPORTS_STREAM_RESOLVE_CACHE_MAX_ENTRIES: usize = 512;
const SPORTS_SCHEDULE_LIVE_CACHE_TTL_MS: i64 = 60 * 1000;
const SPORTS_SCHEDULE_NEAR_LIVE_CACHE_TTL_MS: i64 = 3 * 60 * 1000;
const SPORTS_SCHEDULE_EMPTY_CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const SPORTS_SCHEDULE_FUTURE_CACHE_TTL_MS: i64 = 30 * 60 * 1000;
const SPORTS_SCHEDULE_STALE_IF_ERROR_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Deserialize)]
struct StreamedTeams {
    #[serde(default)]
    home: Option<StreamedTeam>,
    #[serde(default)]
    away: Option<StreamedTeam>,
}

#[derive(Debug, Deserialize)]
struct StreamedTeam {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    name: String,
}

#[derive(Debug, Deserialize)]
struct StreamedSource {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    source: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    id: String,
    #[serde(default, skip_deserializing)]
    expanded_streams: Vec<StreamedEmbedStream>,
}

#[derive(Debug, Deserialize)]
struct StreamedMatch {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    id: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    title: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    category: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    date: i64,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    popular: bool,
    #[serde(default)]
    teams: StreamedTeams,
    #[serde(default, deserialize_with = "deserialize_streamed_sources")]
    sources: Vec<StreamedSource>,
}

#[derive(Clone, Debug, Deserialize)]
struct StreamedEmbedStream {
    #[serde(
        default,
        rename = "streamNo",
        deserialize_with = "deserialize_default_on_null"
    )]
    stream_no: i64,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    hd: bool,
    #[serde(
        default,
        rename = "embedUrl",
        deserialize_with = "deserialize_default_on_null"
    )]
    embed_url: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    language: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    source: String,
}

#[derive(Debug, Deserialize)]
struct StreamedHlsResolverOutput {
    #[serde(rename = "playbackUrl")]
    playback_url: String,
}

#[derive(Debug, Deserialize)]
struct MatchstreamHlsResolverOutput {
    #[serde(rename = "playbackUrl")]
    playback_url: String,
    #[serde(default, rename = "playerPage")]
    player_page: String,
    #[serde(default)]
    referer: String,
}

#[derive(Debug, Deserialize)]
struct NtvsSearchPayload {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    success: bool,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    message: String,
    #[serde(default)]
    data: Vec<NtvsMatch>,
}

#[derive(Debug, Deserialize)]
struct NtvsMatch {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    id: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    title: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    category: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    date: i64,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    popular: bool,
    #[serde(default)]
    teams: StreamedTeams,
    #[serde(default, deserialize_with = "deserialize_streamed_sources")]
    sources: Vec<StreamedSource>,
    #[serde(default, skip_deserializing)]
    expanded_streams: Vec<StreamedEmbedStream>,
}

#[derive(Debug, Deserialize)]
struct NtvsHlsResolverOutput {
    #[serde(rename = "playbackUrl")]
    playback_url: String,
    #[serde(default, rename = "playerPage")]
    player_page: String,
    #[serde(default)]
    referer: String,
}

#[derive(Debug, Deserialize)]
pub struct SportsScheduleQuery {
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveFootballStreamQuery {
    url: String,
    #[serde(default, rename = "fallbackUrls")]
    fallback_urls: Option<String>,
    // When truthy, resolve the candidate sources concurrently (first working one
    // wins) instead of sequentially — used for the initial "first watch" pick so
    // a dead primary source doesn't gate the working one behind it.
    #[serde(default)]
    preflight: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SportsScheduleSource {
    Auto,
    Espn,
    Streamed,
    Matchstream,
    Ntvs,
    Cdnlivetv,
}

#[derive(Clone)]
struct ResolvedLiveStream {
    source_url: Url,
    player_page_url: Url,
    playback_url: Url,
    playback_type: &'static str,
    candidate_index: usize,
    attempted_streams: usize,
}

#[derive(Debug, Deserialize)]
struct MatchstreamMatch {
    #[serde(
        default,
        rename = "matchText",
        deserialize_with = "deserialize_default_on_null"
    )]
    match_text: String,
    #[serde(
        default,
        rename = "matchstr",
        deserialize_with = "deserialize_default_on_null"
    )]
    match_str: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    league: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    sport: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    team1: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    team2: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    channel: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    important: bool,
    #[serde(
        default,
        rename = "matchDate",
        deserialize_with = "deserialize_default_on_null"
    )]
    match_date: String,
    #[serde(default, deserialize_with = "deserialize_matchstream_channels")]
    channels: Vec<MatchstreamChannel>,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    slug: String,
    #[serde(
        default,
        rename = "startTimestamp",
        deserialize_with = "deserialize_default_on_null"
    )]
    start_timestamp: i64,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    duration: i64,
}

#[derive(Debug, Deserialize)]
struct MatchstreamChannel {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    name: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    number: i64,
    #[serde(default)]
    language: Option<String>,
    #[serde(default, deserialize_with = "deserialize_matchstream_links")]
    links: Vec<String>,
}

#[derive(Clone, Default)]
pub struct SportsScheduleCache {
    entries: Arc<DashMap<&'static str, CachedSportsSchedule>>,
    locks: Arc<DashMap<&'static str, Arc<Mutex<()>>>>,
}

#[derive(Clone)]
struct CachedSportsSchedule {
    payload: Value,
    fetched_at_ms: i64,
    fresh_until_ms: i64,
    stale_until_ms: i64,
}

impl SportsScheduleCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn fresh(&self, key: &'static str, now: i64) -> Option<Value> {
        self.entries.get(key).and_then(|entry| {
            let cached = entry.value();
            (now <= cached.fresh_until_ms).then(|| cached.payload.clone())
        })
    }

    fn stale(&self, key: &'static str, now: i64) -> Option<Value> {
        self.entries.get(key).and_then(|entry| {
            let cached = entry.value();
            (now <= cached.stale_until_ms).then(|| cached.payload.clone())
        })
    }

    fn insert(&self, key: &'static str, payload: Value, fetched_at_ms: i64) {
        let fresh_until_ms =
            fetched_at_ms.saturating_add(sports_schedule_fresh_ttl_ms(&payload, fetched_at_ms));
        self.entries.insert(
            key,
            CachedSportsSchedule {
                payload,
                fetched_at_ms,
                fresh_until_ms,
                stale_until_ms: fetched_at_ms.saturating_add(SPORTS_SCHEDULE_STALE_IF_ERROR_MS),
            },
        );
    }

    fn lock_for(&self, key: &'static str) -> Arc<Mutex<()>> {
        self.locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn debug_payload(&self) -> Value {
        let now = now_ms();
        let mut entries = self
            .entries
            .iter()
            .map(|entry| {
                let cached = entry.value();
                json!({
                    "key": *entry.key(),
                    "fetchedAt": cached.fetched_at_ms,
                    "freshForMs": cached.fresh_until_ms.saturating_sub(now),
                    "staleForMs": cached.stale_until_ms.saturating_sub(now),
                    "matchCount": cached.payload.get("matches").and_then(Value::as_array).map(Vec::len).unwrap_or_default(),
                    "sourceProvider": cached.payload.get("sourceProvider").and_then(Value::as_str).unwrap_or_default()
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            left["key"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["key"].as_str().unwrap_or_default())
        });
        json!({
            "entries": entries,
            "staleIfErrorMs": SPORTS_SCHEDULE_STALE_IF_ERROR_MS
        })
    }
}

#[derive(Clone)]
pub struct SportsStreamResolveCache {
    entries: Arc<DashMap<String, CachedResolvedLiveStream>>,
    failures: Arc<DashMap<String, CachedResolveFailure>>,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    permits: Arc<Semaphore>,
    max_concurrent: usize,
    queue_timeout_ms: u64,
}

#[derive(Clone)]
struct CachedResolvedLiveStream {
    resolved: ResolvedLiveStream,
    cached_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Clone)]
struct CachedResolveFailure {
    message: String,
    cached_at_ms: i64,
    expires_at_ms: i64,
}

impl SportsStreamResolveCache {
    pub fn new(max_concurrent: usize, queue_timeout_ms: u64) -> Self {
        let max_concurrent = max_concurrent.max(1);
        Self {
            entries: Arc::new(DashMap::new()),
            failures: Arc::new(DashMap::new()),
            locks: Arc::new(DashMap::new()),
            permits: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
            queue_timeout_ms: queue_timeout_ms.max(100),
        }
    }

    fn fresh(&self, key: &str, now: i64) -> Option<ResolvedLiveStream> {
        self.entries.get(key).and_then(|entry| {
            let cached = entry.value();
            (now <= cached.expires_at_ms).then(|| cached.resolved.clone())
        })
    }

    fn insert(&self, key: String, resolved: ResolvedLiveStream, cached_at_ms: i64) {
        self.entries.insert(
            key,
            CachedResolvedLiveStream {
                resolved,
                cached_at_ms,
                expires_at_ms: cached_at_ms.saturating_add(SPORTS_STREAM_RESOLVE_CACHE_TTL_MS),
            },
        );
        self.trim();
    }

    fn fresh_failure(&self, key: &str, now: i64) -> Option<String> {
        self.failures.get(key).and_then(|entry| {
            let cached = entry.value();
            (now <= cached.expires_at_ms).then(|| cached.message.clone())
        })
    }

    fn insert_failure(&self, key: String, message: String, cached_at_ms: i64) {
        self.failures.insert(
            key,
            CachedResolveFailure {
                message,
                cached_at_ms,
                expires_at_ms: cached_at_ms.saturating_add(SPORTS_STREAM_RESOLVE_FAILURE_TTL_MS),
            },
        );
        self.trim_failures();
    }

    fn lock_for(&self, key: &str) -> Arc<Mutex<()>> {
        self.locks
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn acquire_permit(&self) -> AppResult<OwnedSemaphorePermit> {
        match timeout(
            Duration::from_millis(self.queue_timeout_ms),
            self.permits.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => Ok(permit),
            Ok(Err(_)) => Err(ApiError::internal("Sports resolver limiter is closed.")),
            Err(_) => Err(ApiError::too_many_requests(
                "Sports stream resolver is busy. Try again shortly.",
            )),
        }
    }

    fn trim(&self) {
        if self.entries.len() <= SPORTS_STREAM_RESOLVE_CACHE_MAX_ENTRIES {
            return;
        }
        let mut entries = self
            .entries
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().cached_at_ms))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(_, cached_at_ms)| *cached_at_ms);
        let overflow = entries
            .len()
            .saturating_sub(SPORTS_STREAM_RESOLVE_CACHE_MAX_ENTRIES);
        for (key, _) in entries.into_iter().take(overflow) {
            self.entries.remove(&key);
        }
    }

    fn trim_failures(&self) {
        if self.failures.len() <= SPORTS_STREAM_RESOLVE_CACHE_MAX_ENTRIES {
            return;
        }
        let mut failures = self
            .failures
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().cached_at_ms))
            .collect::<Vec<_>>();
        failures.sort_by_key(|(_, cached_at_ms)| *cached_at_ms);
        let overflow = failures
            .len()
            .saturating_sub(SPORTS_STREAM_RESOLVE_CACHE_MAX_ENTRIES);
        for (key, _) in failures.into_iter().take(overflow) {
            self.failures.remove(&key);
        }
    }

    pub fn prune(&self) {
        let now = now_ms();
        self.entries.retain(|_, cached| now <= cached.expires_at_ms);
        self.failures
            .retain(|_, cached| now <= cached.expires_at_ms);
        self.locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }

    pub fn stats(&self) -> Value {
        let now = now_ms();
        json!({
            "entries": self.entries.len(),
            "ttlMs": SPORTS_STREAM_RESOLVE_CACHE_TTL_MS,
            "maxEntries": SPORTS_STREAM_RESOLVE_CACHE_MAX_ENTRIES,
            "maxConcurrent": self.max_concurrent,
            "availablePermits": self.permits.available_permits(),
            "queueTimeoutMs": self.queue_timeout_ms,
            "freshEntries": self.entries.iter().filter(|entry| now <= entry.value().expires_at_ms).count(),
            "failureEntries": self.failures.len(),
            "failureTtlMs": SPORTS_STREAM_RESOLVE_FAILURE_TTL_MS,
            "freshFailureEntries": self.failures.iter().filter(|entry| now <= entry.value().expires_at_ms).count()
        })
    }
}

impl Default for SportsStreamResolveCache {
    fn default() -> Self {
        Self::new(2, 3_000)
    }
}

#[derive(Clone, Default)]
pub struct SportsProviderHealth {
    entries: Arc<DashMap<String, ProviderHealthEntry>>,
}

#[derive(Clone, Default)]
struct ProviderHealthEntry {
    successes: u64,
    failures: u64,
    consecutive_failures: u64,
    last_success_at_ms: i64,
    last_failure_at_ms: i64,
    last_latency_ms: i64,
    last_error: String,
}

impl SportsProviderHealth {
    pub fn new() -> Self {
        Self::default()
    }

    fn record_success(&self, provider: &'static str, operation: &'static str, started_at_ms: i64) {
        let latency_ms = now_ms().saturating_sub(started_at_ms);
        let key = sports_provider_health_key(provider, operation);
        let mut entry = self.entries.entry(key).or_default();
        entry.successes = entry.successes.saturating_add(1);
        entry.consecutive_failures = 0;
        entry.last_success_at_ms = now_ms();
        entry.last_latency_ms = latency_ms;
        entry.last_error.clear();
    }

    fn record_failure(
        &self,
        provider: &'static str,
        operation: &'static str,
        started_at_ms: i64,
        error: &str,
    ) {
        let latency_ms = now_ms().saturating_sub(started_at_ms);
        let key = sports_provider_health_key(provider, operation);
        let mut entry = self.entries.entry(key).or_default();
        entry.failures = entry.failures.saturating_add(1);
        entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
        entry.last_failure_at_ms = now_ms();
        entry.last_latency_ms = latency_ms;
        entry.last_error = error.chars().take(240).collect();
    }

    pub fn summary(&self, include_errors: bool) -> Value {
        let mut entries = self
            .entries
            .iter()
            .map(|entry| {
                let value = entry.value();
                let mut payload = json!({
                    "key": entry.key().as_str(),
                    "successes": value.successes,
                    "failures": value.failures,
                    "consecutiveFailures": value.consecutive_failures,
                    "lastSuccessAt": value.last_success_at_ms,
                    "lastFailureAt": value.last_failure_at_ms,
                    "lastLatencyMs": value.last_latency_ms
                });
                if include_errors {
                    payload["lastError"] = json!(value.last_error);
                }
                payload
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            left["key"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["key"].as_str().unwrap_or_default())
        });
        json!({ "providers": entries })
    }
}

fn sports_provider_health_key(provider: &'static str, operation: &'static str) -> String {
    format!("{provider}:{operation}")
}

fn sports_schedule_fresh_ttl_ms(payload: &Value, now: i64) -> i64 {
    let Some(matches) = payload.get("matches").and_then(Value::as_array) else {
        return SPORTS_SCHEDULE_EMPTY_CACHE_TTL_MS;
    };
    if matches.is_empty() {
        return SPORTS_SCHEDULE_EMPTY_CACHE_TTL_MS;
    }

    let mut starts_soon = false;
    for match_item in matches {
        let start = match_item
            .get("startTimestamp")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let end = match_item
            .get("endsAtTimestamp")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        if start <= now && now < end {
            return SPORTS_SCHEDULE_LIVE_CACHE_TTL_MS;
        }
        if start > now && start.saturating_sub(now) <= 2 * 60 * 60 * 1000 {
            starts_soon = true;
        }
    }

    if starts_soon {
        SPORTS_SCHEDULE_NEAR_LIVE_CACHE_TTL_MS
    } else {
        SPORTS_SCHEDULE_FUTURE_CACHE_TTL_MS
    }
}

fn deserialize_default_on_null<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn deserialize_streamed_sources<'de, D>(deserializer: D) -> Result<Vec<StreamedSource>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<Vec<Option<StreamedSource>>>::deserialize(deserializer)?
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .collect(),
    )
}

fn deserialize_matchstream_channels<'de, D>(
    deserializer: D,
) -> Result<Vec<MatchstreamChannel>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<Vec<Option<MatchstreamChannel>>>::deserialize(deserializer)?
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .collect(),
    )
}

fn deserialize_matchstream_links<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Vec<Option<String>>>::deserialize(deserializer)?
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .map(|link| link.trim().to_owned())
        .filter(|link| !link.is_empty())
        .collect())
}

impl SportsScheduleSource {
    fn from_query(value: Option<&str>) -> AppResult<Self> {
        match value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(AUTO_SOURCE_ID)
            .to_ascii_lowercase()
            .as_str()
        {
            AUTO_SOURCE_ID => Ok(Self::Auto),
            ESPN_SOURCE_ID => Ok(Self::Espn),
            STREAMED_SOURCE_ID => Ok(Self::Streamed),
            MATCHSTREAM_SOURCE_ID => Ok(Self::Matchstream),
            NTVS_SOURCE_ID => Ok(Self::Ntvs),
            CDNLIVETV_SOURCE_ID => Ok(Self::Cdnlivetv),
            _ => Err(ApiError::bad_request("Unsupported sports schedule source.")),
        }
    }
}

#[derive(Clone, Copy)]
struct SportsScheduleConfig {
    espn_cache_key: Option<&'static str>,
    streamed_cache_key: &'static str,
    matchstream_cache_key: &'static str,
    ntvs_cache_key: Option<&'static str>,
    cdnlivetv_cache_key: Option<&'static str>,
    streamed_category: &'static str,
    sport_name: &'static str,
}

const FOOTBALL_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: Some(ESPN_FOOTBALL_CACHE_KEY),
    streamed_cache_key: STREAMED_FOOTBALL_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_FOOTBALL_CACHE_KEY,
    ntvs_cache_key: Some(NTVS_FOOTBALL_CACHE_KEY),
    cdnlivetv_cache_key: Some(CDNLIVETV_FOOTBALL_CACHE_KEY),
    streamed_category: "football",
    sport_name: "Football",
};

const BASKETBALL_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: None,
    streamed_cache_key: STREAMED_BASKETBALL_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_BASKETBALL_CACHE_KEY,
    ntvs_cache_key: None,
    cdnlivetv_cache_key: None,
    streamed_category: "basketball",
    sport_name: "Basketball",
};

const TENNIS_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: None,
    streamed_cache_key: STREAMED_TENNIS_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_TENNIS_CACHE_KEY,
    ntvs_cache_key: None,
    cdnlivetv_cache_key: None,
    streamed_category: "tennis",
    sport_name: "Tennis",
};

const HOCKEY_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: None,
    streamed_cache_key: STREAMED_HOCKEY_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_HOCKEY_CACHE_KEY,
    ntvs_cache_key: None,
    cdnlivetv_cache_key: None,
    streamed_category: "hockey",
    sport_name: "Hockey",
};

const BASEBALL_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: None,
    streamed_cache_key: STREAMED_BASEBALL_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_BASEBALL_CACHE_KEY,
    ntvs_cache_key: None,
    cdnlivetv_cache_key: None,
    streamed_category: "baseball",
    sport_name: "Baseball",
};

const AMERICAN_FOOTBALL_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: None,
    streamed_cache_key: STREAMED_AMERICAN_FOOTBALL_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_AMERICAN_FOOTBALL_CACHE_KEY,
    ntvs_cache_key: None,
    cdnlivetv_cache_key: None,
    streamed_category: "american-football",
    sport_name: "American Football",
};

const CRICKET_SCHEDULE_CONFIG: SportsScheduleConfig = SportsScheduleConfig {
    espn_cache_key: None,
    streamed_cache_key: STREAMED_CRICKET_CACHE_KEY,
    matchstream_cache_key: MATCHSTREAM_CRICKET_CACHE_KEY,
    ntvs_cache_key: None,
    cdnlivetv_cache_key: None,
    streamed_category: "cricket",
    sport_name: "Cricket",
};

pub async fn football_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, FOOTBALL_SCHEDULE_CONFIG).await
}

pub async fn basketball_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, BASKETBALL_SCHEDULE_CONFIG).await
}

pub async fn tennis_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, TENNIS_SCHEDULE_CONFIG).await
}

pub async fn hockey_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, HOCKEY_SCHEDULE_CONFIG).await
}

pub async fn baseball_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, BASEBALL_SCHEDULE_CONFIG).await
}

pub async fn american_football_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, AMERICAN_FOOTBALL_SCHEDULE_CONFIG).await
}

pub async fn cricket_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(&state, query, CRICKET_SCHEDULE_CONFIG).await
}

async fn sport_matches_response(
    state: &AppState,
    query: SportsScheduleQuery,
    config: SportsScheduleConfig,
) -> AppResult<Response<Body>> {
    let source = SportsScheduleSource::from_query(query.source.as_deref())?;
    if source == SportsScheduleSource::Auto && config.espn_cache_key.is_some() {
        return auto_football_matches_response(state, config).await;
    }
    let SportsScheduleConfig {
        espn_cache_key,
        streamed_cache_key,
        matchstream_cache_key,
        ntvs_cache_key,
        cdnlivetv_cache_key,
        streamed_category,
        sport_name,
    } = config;
    match source {
        SportsScheduleSource::Auto => {
            auto_sport_matches_response(
                state,
                streamed_cache_key,
                matchstream_cache_key,
                ntvs_cache_key,
                streamed_category,
                sport_name,
            )
            .await
        }
        SportsScheduleSource::Espn => {
            let Some(espn_cache_key) = espn_cache_key else {
                return Err(ApiError::bad_request(
                    "ESPN schedule is only available for football.",
                ));
            };
            espn_football_matches_response(state, espn_cache_key).await
        }
        SportsScheduleSource::Streamed => {
            streamed_sport_matches_response(
                state,
                streamed_cache_key,
                streamed_category,
                sport_name,
            )
            .await
        }
        SportsScheduleSource::Matchstream => {
            matchstream_sport_matches_response(state, matchstream_cache_key, sport_name).await
        }
        SportsScheduleSource::Ntvs => {
            let Some(ntvs_cache_key) = ntvs_cache_key else {
                return Err(ApiError::bad_request(
                    "NTVS schedule is only available for football.",
                ));
            };
            ntvs_sport_matches_response(state, ntvs_cache_key, sport_name).await
        }
        SportsScheduleSource::Cdnlivetv => {
            let Some(cdnlivetv_cache_key) = cdnlivetv_cache_key else {
                return Err(ApiError::bad_request(
                    "cdnlivetv schedule is only available for football.",
                ));
            };
            cdnlivetv_sport_matches_response(state, cdnlivetv_cache_key, sport_name).await
        }
    }
}

async fn auto_sport_matches_response(
    state: &AppState,
    streamed_cache_key: &'static str,
    matchstream_cache_key: &'static str,
    ntvs_cache_key: Option<&'static str>,
    streamed_category: &'static str,
    sport_name: &'static str,
) -> AppResult<Response<Body>> {
    let streamed_error = match streamed_sport_matches_response(
        state,
        streamed_cache_key,
        streamed_category,
        sport_name,
    )
    .await
    {
        Ok(response) => return Ok(response),
        Err(error) => error,
    };

    let matchstream_error =
        match matchstream_sport_matches_response(state, matchstream_cache_key, sport_name).await {
            Ok(response) => return Ok(response),
            Err(error) => error,
        };

    if let Some(ntvs_cache_key) = ntvs_cache_key {
        match ntvs_sport_matches_response(state, ntvs_cache_key, sport_name).await {
            Ok(response) => return Ok(response),
            Err(ntvs_error) => {
                return Err(ApiError::bad_gateway(format!(
                    "Sports schedule providers failed. Streamed: {} MatchStream: {} NTVS: {}",
                    api_error_message(&streamed_error),
                    api_error_message(&matchstream_error),
                    api_error_message(&ntvs_error)
                )));
            }
        }
    }

    Err(ApiError::bad_gateway(format!(
        "Sports schedule providers failed. Streamed: {} MatchStream: {}",
        api_error_message(&streamed_error),
        api_error_message(&matchstream_error)
    )))
}

async fn auto_football_matches_response(
    state: &AppState,
    config: SportsScheduleConfig,
) -> AppResult<Response<Body>> {
    let SportsScheduleConfig {
        espn_cache_key,
        streamed_cache_key,
        matchstream_cache_key,
        ntvs_cache_key,
        cdnlivetv_cache_key,
        streamed_category,
        sport_name,
    } = config;
    let espn_cache_key = espn_cache_key
        .ok_or_else(|| ApiError::internal("Football ESPN schedule cache was not configured."))?;
    let ntvs_response = async {
        let cache_key = ntvs_cache_key.ok_or_else(|| {
            ApiError::internal("Football NTVS schedule cache was not configured.")
        })?;
        ntvs_sport_matches_response(state, cache_key, sport_name).await
    };
    let cdnlivetv_response = async {
        let cache_key = cdnlivetv_cache_key.ok_or_else(|| {
            ApiError::internal("Football cdnlivetv schedule cache was not configured.")
        })?;
        cdnlivetv_sport_matches_response(state, cache_key, sport_name).await
    };

    // Fixture discovery and playback discovery are deliberately independent.
    // ESPN supplies the broad scoreboard; the four existing providers only add
    // playable sources to matching fixtures (and remain as fallbacks if ESPN is
    // temporarily unavailable).
    let (espn, streamed, matchstream, ntvs, cdnlivetv) = tokio::join!(
        sports_schedule_provider_with_timeout(
            ESPN_SOURCE_ID,
            espn_football_matches_response(state, espn_cache_key),
        ),
        sports_schedule_provider_with_timeout(
            STREAMED_SOURCE_ID,
            streamed_sport_matches_response(
                state,
                streamed_cache_key,
                streamed_category,
                sport_name,
            ),
        ),
        sports_schedule_provider_with_timeout(
            MATCHSTREAM_SOURCE_ID,
            matchstream_sport_matches_response(state, matchstream_cache_key, sport_name),
        ),
        sports_schedule_provider_with_timeout(NTVS_SOURCE_ID, ntvs_response),
        sports_schedule_provider_with_timeout(CDNLIVETV_SOURCE_ID, cdnlivetv_response),
    );

    let mut payloads = Vec::new();
    let mut errors = Vec::new();
    for (provider, result) in [
        (ESPN_SOURCE_ID, espn),
        (STREAMED_SOURCE_ID, streamed),
        (MATCHSTREAM_SOURCE_ID, matchstream),
        (NTVS_SOURCE_ID, ntvs),
        (CDNLIVETV_SOURCE_ID, cdnlivetv),
    ] {
        match result {
            Ok(response) => match sports_schedule_payload_from_response(response).await {
                Ok(payload) => payloads.push(payload),
                Err(error) => errors.push(format!("{provider}: {}", api_error_message(&error))),
            },
            Err(error) => errors.push(format!("{provider}: {}", api_error_message(&error))),
        }
    }

    if payloads.is_empty() {
        return Err(ApiError::bad_gateway(format!(
            "Football schedule providers failed. {}",
            errors.join("; ")
        )));
    }

    let payload = merge_sports_schedule_payloads(payloads, sport_name);
    Ok(schedule_response(
        filter_marquee_football_schedule(payload),
        "aggregate",
    ))
}

async fn sports_schedule_provider_with_timeout<F>(
    provider: &'static str,
    future: F,
) -> AppResult<Response<Body>>
where
    F: Future<Output = AppResult<Response<Body>>>,
{
    let timeout_ms = if provider == NTVS_SOURCE_ID {
        // NTVS additionally fetches the live event's labelled source selector.
        // Keep other providers on the tighter budget while leaving enough room
        // for that one bounded page request to complete on the WARP route.
        NTVS_SCHEDULE_PROVIDER_TIMEOUT_MS
    } else {
        FOOTBALL_SCHEDULE_PROVIDER_TIMEOUT_MS
    };
    timeout(Duration::from_millis(timeout_ms), future)
        .await
        .map_err(|_| ApiError::gateway_timeout(format!("{provider} schedule timed out.")))?
}

async fn sports_schedule_payload_from_response(response: Response<Body>) -> AppResult<Value> {
    let body = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|error| {
            ApiError::internal(format!("Failed to read sports schedule response: {error}"))
        })?;
    serde_json::from_slice(&body).map_err(|error| {
        ApiError::internal(format!(
            "Failed to decode sports schedule response: {error}"
        ))
    })
}

fn merge_sports_schedule_payloads(payloads: Vec<Value>, sport_name: &'static str) -> Value {
    let fetched_at_ms = payloads
        .iter()
        .filter_map(|payload| payload.get("fetchedAt").and_then(Value::as_i64))
        .max()
        .unwrap_or_else(now_ms);
    let mut matches: Vec<Value> = Vec::new();

    for payload in payloads {
        let Some(source_matches) = payload.get("matches").and_then(Value::as_array) else {
            continue;
        };
        for incoming in source_matches {
            if let Some(existing) = matches
                .iter_mut()
                .find(|existing| sports_schedule_matches_refer_to_same_fixture(existing, incoming))
            {
                merge_sports_schedule_match(existing, incoming);
            } else {
                matches.push(incoming.clone());
            }
        }
    }

    matches.sort_by_key(|match_item| {
        match_item
            .get("startTimestamp")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
    });

    json!({
        "source": ESPN_FOOTBALL_SCOREBOARD_URL,
        "sourceProvider": AUTO_SOURCE_ID,
        "sport": sport_name,
        "fetchedAt": fetched_at_ms,
        "matches": matches
    })
}

fn filter_marquee_football_schedule(mut payload: Value) -> Value {
    if let Some(matches) = payload.get_mut("matches").and_then(Value::as_array_mut) {
        matches.retain(|match_item| {
            match_item
                .get("league")
                .and_then(Value::as_str)
                .is_some_and(is_marquee_football_competition)
        });
    }
    payload
}

fn sports_schedule_matches_refer_to_same_fixture(left: &Value, right: &Value) -> bool {
    let left_start = left
        .get("startTimestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let right_start = right
        .get("startTimestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    if left_start <= 0
        || right_start <= 0
        || left_start.abs_diff(right_start) > ESPN_MATCH_MERGE_TOLERANCE_MS as u64
    {
        return false;
    }

    let left_teams = sports_schedule_team_pair(left);
    let right_teams = sports_schedule_team_pair(right);
    if let (Some((left_home, left_away)), Some((right_home, right_away))) =
        (left_teams, right_teams)
    {
        return (left_home == right_home && left_away == right_away)
            || (left_home == right_away && left_away == right_home);
    }

    normalize_sports_schedule_name(
        left.get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) == normalize_sports_schedule_name(
        right
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

fn sports_schedule_team_pair(match_item: &Value) -> Option<(String, String)> {
    let home = normalize_sports_schedule_name(
        match_item
            .get("team1")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let away = normalize_sports_schedule_name(
        match_item
            .get("team2")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    (!home.is_empty() && !away.is_empty()).then_some((home, away))
}

fn normalize_sports_schedule_name(value: &str) -> String {
    value
        .replace('.', "")
        .split(|ch: char| !ch.is_alphanumeric())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .filter(|part| {
            !matches!(
                part.as_str(),
                "fc" | "afc"
                    | "cf"
                    | "sc"
                    | "ac"
                    | "aif"
                    | "bk"
                    | "if"
                    | "is"
                    | "fk"
                    | "sk"
                    | "club"
            )
        })
        .map(|part| {
            if part == "utd" {
                "united".to_owned()
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn merge_sports_schedule_match(existing: &mut Value, incoming: &Value) {
    let mut providers = BTreeSet::new();
    collect_sports_schedule_providers(existing, &mut providers);
    collect_sports_schedule_providers(incoming, &mut providers);
    let incoming_streams = incoming
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_channels = incoming
        .get("channels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_languages = incoming
        .get("languages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_end = incoming
        .get("endsAtTimestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let incoming_important = incoming
        .get("important")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let Some(existing_object) = existing.as_object_mut() else {
        return;
    };

    merge_sports_schedule_array(existing_object, "streams", incoming_streams, "source");
    merge_sports_schedule_array(existing_object, "channels", incoming_channels, "name");
    merge_sports_schedule_array(existing_object, "languages", incoming_languages, "");

    let link_count = existing_object
        .get("streams")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let channel_count = existing_object
        .get("channels")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    existing_object.insert("linkCount".to_owned(), json!(link_count));
    existing_object.insert("channelCount".to_owned(), json!(channel_count));
    existing_object.insert(
        "endsAtTimestamp".to_owned(),
        json!(
            existing_object
                .get("endsAtTimestamp")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .max(incoming_end)
        ),
    );
    existing_object.insert(
        "important".to_owned(),
        json!(
            existing_object
                .get("important")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || incoming_important
        ),
    );
    let providers = providers.into_iter().collect::<Vec<_>>();
    existing_object.insert("providers".to_owned(), json!(providers));
    existing_object.insert(
        "provider".to_owned(),
        json!(if providers.len() == 1 {
            providers[0].as_str()
        } else {
            AUTO_SOURCE_ID
        }),
    );
}

fn collect_sports_schedule_providers(match_item: &Value, providers: &mut BTreeSet<String>) {
    if let Some(provider) = match_item.get("provider").and_then(Value::as_str) {
        let provider = provider.trim();
        if !provider.is_empty() && provider != AUTO_SOURCE_ID {
            providers.insert(provider.to_owned());
        }
    }
    if let Some(items) = match_item.get("providers").and_then(Value::as_array) {
        for provider in items.iter().filter_map(Value::as_str) {
            let provider = provider.trim();
            if !provider.is_empty() && provider != AUTO_SOURCE_ID {
                providers.insert(provider.to_owned());
            }
        }
    }
}

fn merge_sports_schedule_array(
    object: &mut serde_json::Map<String, Value>,
    field: &str,
    incoming: Vec<Value>,
    unique_field: &str,
) {
    let target = object.entry(field.to_owned()).or_insert_with(|| json!([]));
    let Some(target) = target.as_array_mut() else {
        return;
    };
    let mut seen = target
        .iter()
        .map(|item| sports_schedule_array_identity(item, unique_field))
        .collect::<BTreeSet<_>>();
    for item in incoming {
        let identity = sports_schedule_array_identity(&item, unique_field);
        if !identity.is_empty() && seen.insert(identity) {
            target.push(item);
        }
    }
}

fn sports_schedule_array_identity(value: &Value, field: &str) -> String {
    if field.is_empty() {
        return value.as_str().unwrap_or_default().trim().to_lowercase();
    }
    let raw_value = value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if field != "source" {
        return raw_value.to_lowercase();
    }
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let stream_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if provider.eq_ignore_ascii_case(NTVS_SOURCE_ID)
        && stream_id.to_ascii_lowercase().starts_with("ntvs-")
    {
        // The Kobra page's opaque wrappers and Streamed's canonical embed rows
        // describe the same numbered feed. Payloads are merged in canonical-row
        // order, so semantic ids suppress the later wrapper duplicate.
        return format!("ntvs-id:{}", stream_id.to_ascii_lowercase());
    }
    let Ok(mut url) = Url::parse(raw_value) else {
        return raw_value.to_owned();
    };
    if let Some(host) = url.host_str().map(|host| host.to_ascii_lowercase()) {
        let _ = url.set_host(Some(&host));
    }
    // URL paths and query values may be opaque, case-sensitive source tokens.
    // Normalize only the host so distinct NTV wrapper tokens cannot collapse.
    url.to_string()
}

fn api_error_message(error: &ApiError) -> &str {
    error.message().unwrap_or("unknown error")
}

fn sports_http_client(state: &AppState) -> AppResult<reqwest::Client> {
    let Some(proxy_url) = env::var(SPORTS_HTTP_PROXY_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return Ok(state.http_client.clone());
    };

    let proxy = reqwest::Proxy::all(&proxy_url)
        .map_err(|error| ApiError::internal(format!("Invalid {SPORTS_HTTP_PROXY_ENV}: {error}")))?;
    reqwest::Client::builder()
        .user_agent("streamarena-backend")
        .timeout(Duration::from_secs(SPORTS_HTTP_CLIENT_TIMEOUT_SECONDS))
        .proxy(proxy)
        .build()
        .map_err(|error| ApiError::internal(error.to_string()))
}

async fn espn_football_matches_response(
    state: &AppState,
    cache_key: &'static str,
) -> AppResult<Response<Body>> {
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let schedule_lock = state.sports_schedule_cache.lock_for(cache_key);
    let _guard = schedule_lock.lock().await;
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let started_at_ms = now_ms();
    match fetch_espn_football_matches_payload(state).await {
        Ok((payload, fetched_at_ms)) => {
            state
                .sports_provider_health
                .record_success(ESPN_SOURCE_ID, "schedule", started_at_ms);
            state
                .sports_schedule_cache
                .insert(cache_key, payload.clone(), fetched_at_ms);
            Ok(schedule_response(payload, "miss"))
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                ESPN_SOURCE_ID,
                "schedule",
                started_at_ms,
                api_error_message(&error),
            );
            if let Some(payload) = state.sports_schedule_cache.stale(cache_key, now_ms()) {
                return Ok(schedule_response(payload, "stale"));
            }
            Err(error)
        }
    }
}

async fn fetch_espn_football_matches_payload(state: &AppState) -> AppResult<(Value, i64)> {
    let source_url = provider_registry::resolve(
        provider_registry::keys::SPORTS_ESPN_FOOTBALL,
        ESPN_FOOTBALL_SCOREBOARD_URL,
    );
    // ESPN's scoreboard is fixture metadata, not a playback provider, so it does
    // not need the WARP proxy used by the stream-discovery sites.
    let response = state
        .http_client
        .get(&source_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out fetching ESPN football schedule.")
            } else {
                ApiError::bad_gateway(format!("Failed to fetch ESPN football schedule: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "ESPN football schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let source_payload = response.json::<Value>().await.map_err(|error| {
        ApiError::bad_gateway(format!("Failed to parse ESPN football schedule: {error}"))
    })?;
    Ok(build_espn_football_matches_payload(
        source_payload,
        &source_url,
    ))
}

fn build_espn_football_matches_payload(source_payload: Value, source_url: &str) -> (Value, i64) {
    let now = now_ms();
    let matches = source_payload
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|event| normalize_espn_football_match(event, now))
        .collect::<Vec<_>>();
    let fetched_at_ms = now_ms();
    (
        json!({
            "source": source_url,
            "sourceProvider": ESPN_SOURCE_ID,
            "sport": "Football",
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

fn normalize_espn_football_match(event: &Value, now: i64) -> Option<Value> {
    let event_id = event.get("id").and_then(Value::as_str)?.trim();
    let source_date = event.get("date").and_then(Value::as_str)?.trim();
    let start_timestamp = parse_espn_start_ms(source_date)?;
    let ends_at_timestamp = start_timestamp.saturating_add(ESPN_DEFAULT_DURATION_MINUTES * 60_000);
    if ends_at_timestamp <= now {
        return None;
    }

    let home = espn_event_team(event, "home")?;
    let away = espn_event_team(event, "away")?;
    if home.is_empty() || away.is_empty() {
        return None;
    }
    let title = format!("{home} vs {away}");
    let league = event
        .pointer("/competitions/0/altGameNote")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Football");
    let important = is_marquee_football_competition(league);

    Some(json!({
        "id": format!("espn-{event_id}"),
        "title": title,
        "matchText": title,
        "sourceDisplayTime": "",
        "league": league,
        "sport": "Football",
        "team1": home,
        "team2": away,
        "primaryChannel": "",
        "important": important,
        "sourceMatchDate": source_date.get(0..10).unwrap_or_default(),
        "startTimestamp": start_timestamp,
        "endsAtTimestamp": ends_at_timestamp,
        "durationMinutes": ESPN_DEFAULT_DURATION_MINUTES,
        "linkCount": 0,
        "channelCount": 0,
        "channels": [],
        "streams": [],
        "languages": [],
        "provider": ESPN_SOURCE_ID,
        "providers": [ESPN_SOURCE_ID]
    }))
}

fn is_marquee_football_competition(league: &str) -> bool {
    let competition = league
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    matches!(
        competition.as_str(),
        // Europe's five biggest domestic leagues.
        "english premier league"
            | "laliga"
            | "bundesliga"
            | "serie a"
            | "ligue 1"
            // Major UEFA and FIFA competitions.
            | "uefa champions league"
            | "uefa women's champions league"
            | "uefa europa league"
            | "uefa conference league"
            | "uefa european championship"
            | "uefa women's european championship"
            | "uefa nations league"
            | "fifa world cup"
            | "fifa women's world cup"
            | "fifa club world cup"
            | "copa américa"
            | "copa america"
            | "africa cup of nations"
            // The main cups belonging to the five domestic leagues above.
            | "english fa cup"
            | "english carabao cup"
            | "english league cup"
            | "copa del rey"
            | "coppa italia"
            | "german cup"
            | "coupe de france"
    )
}

fn espn_event_team(event: &Value, home_away: &str) -> Option<String> {
    event
        .pointer("/competitions/0/competitors")
        .and_then(Value::as_array)?
        .iter()
        .find(|competitor| {
            competitor
                .get("homeAway")
                .and_then(Value::as_str)
                .is_some_and(|value| value.eq_ignore_ascii_case(home_away))
        })
        .and_then(|competitor| competitor.pointer("/team/displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_espn_start_ms(value: &str) -> Option<i64> {
    // ESPN emits UTC RFC3339 values such as `2026-07-11T21:00Z`.
    let prefix = value.trim().get(0..16)?;
    parse_cdnlivetv_start_ms(&prefix.replace('T', " "))
}

async fn streamed_sport_matches_response(
    state: &AppState,
    cache_key: &'static str,
    streamed_category: &'static str,
    sport_name: &'static str,
) -> AppResult<Response<Body>> {
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let schedule_lock = state.sports_schedule_cache.lock_for(cache_key);
    let _guard = schedule_lock.lock().await;
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let started_at_ms = now_ms();
    match fetch_streamed_sport_matches_payload(state, streamed_category, sport_name).await {
        Ok((payload, fetched_at_ms)) => {
            state.sports_provider_health.record_success(
                STREAMED_SOURCE_ID,
                "schedule",
                started_at_ms,
            );
            state
                .sports_schedule_cache
                .insert(cache_key, payload.clone(), fetched_at_ms);
            Ok(schedule_response(payload, "miss"))
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                STREAMED_SOURCE_ID,
                "schedule",
                started_at_ms,
                api_error_message(&error),
            );
            if let Some(payload) = state.sports_schedule_cache.stale(cache_key, now_ms()) {
                return Ok(schedule_response(payload, "stale"));
            }
            Err(error)
        }
    }
}

async fn fetch_streamed_sport_matches_payload(
    state: &AppState,
    streamed_category: &'static str,
    sport_name: &'static str,
) -> AppResult<(Value, i64)> {
    let source_url = streamed_matches_url(streamed_category);
    let response = sports_http_client(state)?
        .get(&source_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_REFERER)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout(format!(
                    "Timed out fetching Streamed {sport_name} schedule."
                ))
            } else {
                ApiError::bad_gateway(format!(
                    "Failed to fetch Streamed {sport_name} schedule: {error}"
                ))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Streamed {sport_name} schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let mut source_matches = response
        .json::<Vec<StreamedMatch>>()
        .await
        .map_err(|error| {
            ApiError::bad_gateway(format!(
                "Failed to parse Streamed {sport_name} schedule: {error}"
            ))
        })?;
    add_ntvs_linked_source_overrides(&mut source_matches);
    filter_empty_live_streamed_sources(state, &mut source_matches, now_ms()).await?;
    Ok(build_streamed_sport_matches_payload(
        source_matches,
        &source_url,
        sport_name,
    ))
}

fn add_ntvs_linked_source_overrides(source_matches: &mut [StreamedMatch]) {
    for (match_id, start_timestamp, source_name, source_id) in NTVS_LINKED_SOURCE_OVERRIDES {
        let Some(match_item) = source_matches.iter_mut().find(|match_item| {
            match_item.id.trim() == *match_id && match_item.date == *start_timestamp
        }) else {
            continue;
        };
        let already_present = match_item.sources.iter().any(|source| {
            source.source.trim().eq_ignore_ascii_case(source_name) && source.id.trim() == *source_id
        });
        if !already_present {
            match_item.sources.push(StreamedSource {
                source: (*source_name).to_owned(),
                id: (*source_id).to_owned(),
                expanded_streams: Vec::new(),
            });
        }
    }
}

fn streamed_matches_url(streamed_category: &str) -> String {
    match streamed_category {
        "football" => provider_registry::resolve(
            provider_registry::keys::SPORTS_STREAMED_FOOTBALL,
            STREAMED_FOOTBALL_MATCHES_URL,
        ),
        "basketball" => provider_registry::resolve(
            provider_registry::keys::SPORTS_STREAMED_BASKETBALL,
            STREAMED_BASKETBALL_MATCHES_URL,
        ),
        _ => format!(
            "{}/{}",
            provider_registry::resolve(
                provider_registry::keys::SPORTS_STREAMED_MATCHES,
                STREAMED_MATCHES_BASE_URL,
            ),
            streamed_category
        ),
    }
}

#[cfg(test)]
fn build_streamed_football_matches_payload(source_matches: Vec<StreamedMatch>) -> (Value, i64) {
    build_streamed_sport_matches_payload(source_matches, STREAMED_FOOTBALL_MATCHES_URL, "Football")
}

fn build_streamed_sport_matches_payload(
    source_matches: Vec<StreamedMatch>,
    source_url: &str,
    default_sport_name: &'static str,
) -> (Value, i64) {
    let now = now_ms();
    let matches = source_matches
        .into_iter()
        .filter(|match_item| {
            match_item.date > 0
                && !match_item.title.trim().is_empty()
                && !match_item.sources.is_empty()
                && match_item
                    .date
                    .saturating_add(STREAMED_DEFAULT_DURATION_MINUTES.saturating_mul(60_000))
                    > now
        })
        .map(|match_item| normalize_streamed_sport_match(match_item, default_sport_name))
        .collect::<Vec<_>>();
    let fetched_at_ms = now_ms();

    (
        json!({
            "source": source_url,
            "sourceProvider": STREAMED_SOURCE_ID,
            "sport": default_sport_name,
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

async fn filter_empty_live_streamed_sources(
    state: &AppState,
    source_matches: &mut [StreamedMatch],
    now: i64,
) -> AppResult<()> {
    let probes = source_matches
        .iter()
        .enumerate()
        .filter(|(_, match_item)| streamed_match_is_live(match_item, now))
        .flat_map(|(match_index, match_item)| {
            match_item
                .sources
                .iter()
                .enumerate()
                .filter_map(move |(source_index, source)| {
                    streamed_source_stream_api_url(source)
                        .map(|source_url| (match_index, source_index, source_url))
                })
        })
        .collect::<Vec<_>>();
    if probes.is_empty() {
        return Ok(());
    }

    let client = sports_http_client(state)?;
    let pending = stream::iter(probes)
        .map(|(match_index, source_index, source_url)| {
            let client = client.clone();
            async move {
                timeout(
                    Duration::from_millis(STREAMED_SOURCE_PREFLIGHT_TIMEOUT_MS),
                    fetch_streamed_source_embeds(&client, &source_url),
                )
                .await
                .ok()
                .flatten()
                .map(|streams| (match_index, source_index, streams))
            }
        })
        .buffer_unordered(STREAMED_SOURCE_PREFLIGHT_MAX_CONCURRENT);
    tokio::pin!(pending);
    let mut source_results = Vec::new();
    let collect_results = async {
        while let Some(result) = pending.next().await {
            if let Some(result) = result {
                source_results.push(result);
            }
        }
    };
    // Retain every completed probe when one source stalls. The remaining
    // coarse URLs stay selectable because incomplete probes are not removed.
    let _ = timeout(
        Duration::from_millis(STREAMED_SOURCE_PREFLIGHT_BUDGET_MS),
        collect_results,
    )
    .await;
    source_results.sort_by_key(|(match_index, source_index, _)| (*match_index, *source_index));

    let mut empty_sources = Vec::new();
    for (match_index, source_index, streams) in source_results {
        if streams.is_empty() {
            empty_sources.push((match_index, source_index));
            continue;
        }
        let Some(source) = source_matches
            .get_mut(match_index)
            .and_then(|match_item| match_item.sources.get_mut(source_index))
        else {
            continue;
        };
        source.expanded_streams = streams;
    }

    remove_streamed_sources_by_index(source_matches, &empty_sources);
    Ok(())
}

async fn fetch_streamed_source_embeds(
    client: &reqwest::Client,
    source_url: &str,
) -> Option<Vec<StreamedEmbedStream>> {
    let response = client
        .get(source_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_REFERER)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    response.json::<Vec<StreamedEmbedStream>>().await.ok()
}

fn remove_streamed_sources_by_index(
    source_matches: &mut [StreamedMatch],
    empty_sources: &[(usize, usize)],
) {
    let mut empty_by_match = vec![BTreeSet::new(); source_matches.len()];
    for &(match_index, source_index) in empty_sources {
        if let Some(indexes) = empty_by_match.get_mut(match_index) {
            indexes.insert(source_index);
        }
    }

    for (match_index, indexes) in empty_by_match.into_iter().enumerate() {
        if indexes.is_empty() {
            continue;
        }
        let mut source_index = 0usize;
        source_matches[match_index].sources.retain(|_| {
            let keep = !indexes.contains(&source_index);
            source_index += 1;
            keep
        });
    }
}

fn streamed_match_is_live(match_item: &StreamedMatch, now: i64) -> bool {
    match_item.date <= now
        && match_item
            .date
            .saturating_add(STREAMED_DEFAULT_DURATION_MINUTES.saturating_mul(60_000))
            > now
}

async fn matchstream_sport_matches_response(
    state: &AppState,
    cache_key: &'static str,
    sport_name: &'static str,
) -> AppResult<Response<Body>> {
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let schedule_lock = state.sports_schedule_cache.lock_for(cache_key);
    let _guard = schedule_lock.lock().await;
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let started_at_ms = now_ms();
    match fetch_matchstream_sport_matches_payload(state, sport_name).await {
        Ok((payload, fetched_at_ms)) => {
            state.sports_provider_health.record_success(
                MATCHSTREAM_SOURCE_ID,
                "schedule",
                started_at_ms,
            );
            state
                .sports_schedule_cache
                .insert(cache_key, payload.clone(), fetched_at_ms);
            Ok(schedule_response(payload, "miss"))
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                MATCHSTREAM_SOURCE_ID,
                "schedule",
                started_at_ms,
                api_error_message(&error),
            );
            if let Some(payload) = state.sports_schedule_cache.stale(cache_key, now_ms()) {
                return Ok(schedule_response(payload, "stale"));
            }
            Err(error)
        }
    }
}

async fn fetch_matchstream_sport_matches_payload(
    state: &AppState,
    sport_name: &'static str,
) -> AppResult<(Value, i64)> {
    let source_url = matchstream_viewer_url(sport_name);
    let response = sports_http_client(state)?
        .get(&source_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(
            reqwest::header::REFERER,
            provider_registry::resolve(
                provider_registry::keys::SPORTS_MATCHSTREAM_WEBMASTER,
                MATCHSTREAM_WEBMASTER_URL,
            ),
        )
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout(format!(
                    "Timed out fetching MatchStream {sport_name} schedule."
                ))
            } else {
                ApiError::bad_gateway(format!(
                    "Failed to fetch MatchStream {sport_name} schedule: {error}"
                ))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "MatchStream {sport_name} schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let html = response.text().await.map_err(|error| {
        ApiError::bad_gateway(format!(
            "Failed to read MatchStream {sport_name} schedule: {error}"
        ))
    })?;
    let source_matches = extract_matchstream_matches(&html).map_err(|error| {
        ApiError::bad_gateway(format!(
            "Failed to parse MatchStream {sport_name} schedule: {}",
            error.message().unwrap_or("invalid match list")
        ))
    })?;
    Ok(build_matchstream_sport_matches_payload(
        source_matches,
        &source_url,
        sport_name,
    ))
}

fn matchstream_viewer_url(sport_name: &str) -> String {
    let base = provider_registry::resolve(
        provider_registry::keys::SPORTS_MATCHSTREAM_VIEWER,
        MATCHSTREAM_VIEWER_URL,
    );
    // Fall back to the compiled default if an admin saved a malformed override.
    let mut url = Url::parse(&base)
        .or_else(|_| Url::parse(MATCHSTREAM_VIEWER_URL))
        .expect("valid MatchStream viewer URL");
    url.query_pairs_mut().append_pair("sport", sport_name);
    url.to_string()
}

fn extract_matchstream_matches(html: &str) -> AppResult<Vec<MatchstreamMatch>> {
    let marker = "window.matches = JSON.parse(`";
    let start = html
        .find(marker)
        .ok_or_else(|| ApiError::bad_gateway("MatchStream schedule did not include matches."))?
        + marker.len();
    let rest = &html[start..];
    let end = find_unescaped_backtick(rest)
        .ok_or_else(|| ApiError::bad_gateway("MatchStream schedule JSON was incomplete."))?;
    serde_json::from_str::<Vec<MatchstreamMatch>>(&rest[..end])
        .map_err(|error| ApiError::bad_gateway(format!("Invalid MatchStream matches: {error}")))
}

fn find_unescaped_backtick(value: &str) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '`' {
            return Some(index);
        }
    }
    None
}

#[cfg(test)]
fn build_matchstream_football_matches_payload(
    source_matches: Vec<MatchstreamMatch>,
) -> (Value, i64) {
    build_matchstream_sport_matches_payload(
        source_matches,
        &matchstream_viewer_url("Football"),
        "Football",
    )
}

fn build_matchstream_sport_matches_payload(
    source_matches: Vec<MatchstreamMatch>,
    source_url: &str,
    default_sport_name: &'static str,
) -> (Value, i64) {
    let now = now_ms();
    let matches = source_matches
        .into_iter()
        .filter(|match_item| {
            let duration_minutes = normalize_matchstream_duration_minutes(match_item.duration);
            match_item.start_timestamp > 0
                && !matchstream_match_title(match_item, default_sport_name).is_empty()
                && matchstream_match_link_count(match_item) > 0
                && match_item
                    .start_timestamp
                    .saturating_add(duration_minutes.saturating_mul(60_000))
                    > now
        })
        .map(|match_item| normalize_matchstream_sport_match(match_item, default_sport_name))
        .collect::<Vec<_>>();
    let fetched_at_ms = now_ms();

    (
        json!({
            "source": provider_registry::resolve(
                provider_registry::keys::SPORTS_MATCHSTREAM_WEBMASTER,
                MATCHSTREAM_WEBMASTER_URL,
            ),
            "sourceFetchUrl": source_url,
            "sourceProvider": MATCHSTREAM_SOURCE_ID,
            "sport": default_sport_name,
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

async fn ntvs_sport_matches_response(
    state: &AppState,
    cache_key: &'static str,
    sport_name: &'static str,
) -> AppResult<Response<Body>> {
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let schedule_lock = state.sports_schedule_cache.lock_for(cache_key);
    let _guard = schedule_lock.lock().await;
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let started_at_ms = now_ms();
    match fetch_ntvs_sport_matches_payload(state, sport_name).await {
        Ok((payload, fetched_at_ms)) => {
            state
                .sports_provider_health
                .record_success(NTVS_SOURCE_ID, "schedule", started_at_ms);
            state
                .sports_schedule_cache
                .insert(cache_key, payload.clone(), fetched_at_ms);
            Ok(schedule_response(payload, "miss"))
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                NTVS_SOURCE_ID,
                "schedule",
                started_at_ms,
                api_error_message(&error),
            );
            if let Some(payload) = state.sports_schedule_cache.stale(cache_key, now_ms()) {
                return Ok(schedule_response(payload, "stale"));
            }
            Err(error)
        }
    }
}

async fn fetch_ntvs_sport_matches_payload(
    state: &AppState,
    sport_name: &'static str,
) -> AppResult<(Value, i64)> {
    let source_url = ntvs_search_url(NTVS_FOOTBALL_SEARCH_QUERY, NTVS_DEFAULT_SERVER);
    let response = sports_http_client(state)?
        .get(&source_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, NTVS_REFERER)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout(format!("Timed out fetching NTVS {sport_name} schedule."))
            } else {
                ApiError::bad_gateway(format!(
                    "Failed to fetch NTVS {sport_name} schedule: {error}"
                ))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "NTVS {sport_name} schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let mut payload = response
        .json::<NtvsSearchPayload>()
        .await
        .map_err(|error| {
            ApiError::bad_gateway(format!(
                "Failed to parse NTVS {sport_name} schedule: {error}"
            ))
        })?;
    if !payload.success {
        let message = payload.message.trim();
        return Err(ApiError::bad_gateway(if message.is_empty() {
            format!("NTVS {sport_name} schedule failed.")
        } else {
            format!("NTVS {sport_name} schedule failed: {message}")
        }));
    }

    expand_ntvs_live_sources(state, &mut payload.data, sport_name, now_ms()).await;

    Ok(build_ntvs_sport_matches_payload(
        payload.data,
        &source_url,
        sport_name,
    ))
}

async fn expand_ntvs_live_sources(
    state: &AppState,
    source_matches: &mut [NtvsMatch],
    sport_name: &'static str,
    now: i64,
) {
    let mut probes = source_matches
        .iter()
        .enumerate()
        .filter(|(_, match_item)| ntvs_match_is_live(match_item, sport_name, now))
        .filter_map(|(match_index, match_item)| {
            let source_url = ntvs_watch_page_url(match_item.id.trim())?;
            Url::parse(&source_url)
                .ok()
                .map(|url| (match_index, match_item.popular, url))
        })
        .collect::<Vec<_>>();
    probes.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    probes.truncate(NTVS_LIVE_SOURCE_EXPANSION_MAX_MATCHES);
    if probes.is_empty() {
        return;
    }

    let expanded_matches = stream::iter(probes)
        .map(|(match_index, _, source_url)| async move {
            let html = timeout(
                Duration::from_millis(NTVS_LIVE_SOURCE_EXPANSION_TIMEOUT_MS),
                fetch_ntvs_html(state, &source_url, NTVS_REFERER),
            )
            .await
            .ok()?
            .ok()?;
            let streams = extract_ntvs_watch_page_sources(&html, &source_url);
            (!streams.is_empty()).then_some((match_index, streams))
        })
        .buffer_unordered(NTVS_LIVE_SOURCE_EXPANSION_MAX_CONCURRENT)
        .collect::<Vec<_>>()
        .await;

    for (match_index, streams) in expanded_matches.into_iter().flatten() {
        let Some(match_item) = source_matches.get_mut(match_index) else {
            continue;
        };
        match_item.expanded_streams = streams;
    }
}

fn ntvs_search_url(query: &str, server: &str) -> String {
    let base =
        provider_registry::resolve(provider_registry::keys::SPORTS_NTVS_SEARCH, NTVS_SEARCH_URL);
    // Fall back to the compiled default if an admin saved a malformed override.
    let mut url = Url::parse(&base)
        .or_else(|_| Url::parse(NTVS_SEARCH_URL))
        .expect("valid NTVS search URL");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("server", server);
    url.to_string()
}

#[cfg(test)]
fn build_ntvs_football_matches_payload(source_matches: Vec<NtvsMatch>) -> (Value, i64) {
    build_ntvs_sport_matches_payload(
        source_matches,
        &ntvs_search_url(NTVS_FOOTBALL_SEARCH_QUERY, NTVS_DEFAULT_SERVER),
        "Football",
    )
}

fn build_ntvs_sport_matches_payload(
    source_matches: Vec<NtvsMatch>,
    source_url: &str,
    default_sport_name: &'static str,
) -> (Value, i64) {
    let now = now_ms();
    let matches = source_matches
        .into_iter()
        .filter(|match_item| {
            match_item.date > 0
                && !match_item.title.trim().is_empty()
                && ntvs_match_link_count(match_item) > 0
                && ntvs_category_matches(match_item.category.trim(), default_sport_name)
                && match_item
                    .date
                    .saturating_add(NTVS_DEFAULT_DURATION_MINUTES.saturating_mul(60_000))
                    > now
        })
        .map(|match_item| normalize_ntvs_sport_match(match_item, default_sport_name))
        .collect::<Vec<_>>();
    let fetched_at_ms = now_ms();

    (
        json!({
            "source": NTVS_REFERER,
            "sourceFetchUrl": source_url,
            "sourceProvider": NTVS_SOURCE_ID,
            "sport": default_sport_name,
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

fn schedule_response(payload: Value, cache_status: &'static str) -> Response<Body> {
    let mut response = json_response(payload);
    response.headers_mut().insert(
        "x-sports-schedule-cache",
        HeaderValue::from_static(cache_status),
    );
    response
}

// ── cdnlivetv schedule ──────────────────────────────────────────────────────
// cdnlivetv's `/events/sports/` returns one document keyed by sport
// (`{"cdn-live-tv": {"Soccer": [...], ...}}`); each game lists the broadcast
// channels carrying it. We surface a curated subset as per-channel player URLs
// (selectable HLS sources); the sports schedule UI merges them into the match's
// source picker alongside streamed/ntvs by title + date. Parsed loosely via
// serde_json::Value because cdnlivetv mixes numeric and string gameIDs and
// occasionally omits fields.
async fn cdnlivetv_sport_matches_response(
    state: &AppState,
    cache_key: &'static str,
    sport_name: &'static str,
) -> AppResult<Response<Body>> {
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let schedule_lock = state.sports_schedule_cache.lock_for(cache_key);
    let _guard = schedule_lock.lock().await;
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let started_at_ms = now_ms();
    match fetch_cdnlivetv_sport_matches_payload(state, sport_name).await {
        Ok((payload, fetched_at_ms)) => {
            state.sports_provider_health.record_success(
                CDNLIVETV_SOURCE_ID,
                "schedule",
                started_at_ms,
            );
            state
                .sports_schedule_cache
                .insert(cache_key, payload.clone(), fetched_at_ms);
            Ok(schedule_response(payload, "miss"))
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                CDNLIVETV_SOURCE_ID,
                "schedule",
                started_at_ms,
                api_error_message(&error),
            );
            if let Some(payload) = state.sports_schedule_cache.stale(cache_key, now_ms()) {
                return Ok(schedule_response(payload, "stale"));
            }
            Err(error)
        }
    }
}

async fn fetch_cdnlivetv_sport_matches_payload(
    state: &AppState,
    sport_name: &'static str,
) -> AppResult<(Value, i64)> {
    let response = sports_http_client(state)?
        .get(CDNLIVETV_EVENTS_URL)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, CDNLIVETV_REFERER)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout(format!(
                    "Timed out fetching cdnlivetv {sport_name} schedule."
                ))
            } else {
                ApiError::bad_gateway(format!(
                    "Failed to fetch cdnlivetv {sport_name} schedule: {error}"
                ))
            }
        })?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "cdnlivetv {sport_name} schedule returned HTTP {}.",
            response.status(),
        )));
    }
    let payload = response.json::<Value>().await.map_err(|error| {
        ApiError::bad_gateway(format!(
            "Failed to parse cdnlivetv {sport_name} schedule: {error}"
        ))
    })?;
    Ok(build_cdnlivetv_sport_matches_payload(
        &payload,
        CDNLIVETV_EVENTS_URL,
        sport_name,
    ))
}

// Map our sport name to cdnlivetv's event-bucket key. Only football is wired for
// now (the high-value case); other sports keep their existing providers.
fn cdnlivetv_sport_key(sport_name: &str) -> Option<&'static str> {
    match sport_name.to_ascii_lowercase().as_str() {
        "football" => Some("Soccer"),
        _ => None,
    }
}

fn build_cdnlivetv_sport_matches_payload(
    payload: &Value,
    source_url: &str,
    default_sport_name: &'static str,
) -> (Value, i64) {
    let now = now_ms();
    let events = cdnlivetv_sport_key(default_sport_name)
        .and_then(|key| {
            payload
                .get("cdn-live-tv")
                .and_then(|root| root.get(key))
                .and_then(Value::as_array)
        })
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let matches = events
        .iter()
        .filter_map(|event| normalize_cdnlivetv_event(event, default_sport_name, now))
        .collect::<Vec<_>>();
    let fetched_at_ms = now_ms();
    (
        json!({
            "source": source_url,
            "sourceProvider": CDNLIVETV_SOURCE_ID,
            "sport": default_sport_name,
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

fn cdnlivetv_event_game_id(event: &Value) -> String {
    match event.get("gameID") {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

// Read a trimmed string field from a cdnlivetv JSON object, "" when missing.
// A free fn (not a closure) so the returned borrow is tied to `value`, not the
// key argument.
fn cdnlivetv_str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

fn normalize_cdnlivetv_event(
    event: &Value,
    default_sport_name: &'static str,
    now: i64,
) -> Option<Value> {
    let home = cdnlivetv_str_field(event, "homeTeam");
    let away = cdnlivetv_str_field(event, "awayTeam");
    let title = if !home.is_empty() && !away.is_empty() {
        format!("{home} vs {away}")
    } else {
        cdnlivetv_str_field(event, "event").to_owned()
    };
    if title.is_empty() {
        return None;
    }

    let start_timestamp = parse_cdnlivetv_start_ms(cdnlivetv_str_field(event, "start"))?;
    let ends_at = start_timestamp.saturating_add(CDNLIVETV_DEFAULT_DURATION_MINUTES * 60_000);
    if ends_at <= now {
        return None;
    }

    let channels = event.get("channels").and_then(Value::as_array);
    let curated = curate_cdnlivetv_channels(channels.map(Vec::as_slice).unwrap_or(&[]));
    if curated.is_empty() {
        return None;
    }

    let streams = curated
        .iter()
        .map(|channel| {
            json!({
                "id": format!("cdnlivetv-{}", channel.id),
                "label": channel.channel_name,
                "source": channel.player_url,
                "provider": CDNLIVETV_SOURCE_ID,
                "playbackType": "hls",
                "quality": cdnlivetv_channel_quality_label(&channel.channel_name)
            })
        })
        .collect::<Vec<_>>();
    let channels_payload = curated
        .iter()
        .map(|channel| {
            json!({
                "name": channel.channel_name,
                "language": cdnlivetv_channel_quality_label(&channel.channel_name),
                "linkCount": 1
            })
        })
        .collect::<Vec<_>>();

    let game_id = cdnlivetv_event_game_id(event);
    let id_suffix = if game_id.is_empty() {
        cdnlivetv_id_slug(&title)
    } else {
        game_id
    };
    let tournament = cdnlivetv_str_field(event, "tournament");

    Some(json!({
        "id": format!("cdnlivetv-{id_suffix}"),
        "title": title,
        "matchText": title,
        "sourceDisplayTime": "",
        "league": if tournament.is_empty() { "cdnlivetv" } else { tournament },
        "sport": default_sport_name,
        "team1": home,
        "team2": away,
        "primaryChannel": "cdnlivetv",
        "important": false,
        "sourceMatchDate": "",
        "startTimestamp": start_timestamp,
        "endsAtTimestamp": ends_at,
        "durationMinutes": CDNLIVETV_DEFAULT_DURATION_MINUTES,
        "linkCount": streams.len(),
        "channelCount": channels_payload.len(),
        "channels": channels_payload,
        "streams": streams,
        "languages": ["HD"],
        "provider": CDNLIVETV_SOURCE_ID
    }))
}

struct CdnlivetvChannelInfo {
    id: String,
    channel_name: String,
    player_url: String,
}

// Curate a game's broadcast feeds: prefer higher resolution + reputable sports
// broadcasters, cap the count so the picker stays short. Stable sort keeps the
// upstream order for equal scores.
fn curate_cdnlivetv_channels(channels: &[Value]) -> Vec<CdnlivetvChannelInfo> {
    let mut scored = channels
        .iter()
        .filter_map(|channel| {
            let id = cdnlivetv_str_field(channel, "id");
            let name = cdnlivetv_str_field(channel, "channel_name");
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let player_url = cdnlivetv_channel_player_url(
                name,
                cdnlivetv_str_field(channel, "channel_code"),
                cdnlivetv_str_field(channel, "url"),
            );
            Some((
                cdnlivetv_channel_score(name),
                CdnlivetvChannelInfo {
                    id: id.to_owned(),
                    channel_name: name.to_owned(),
                    player_url,
                },
            ))
        })
        .collect::<Vec<_>>();
    scored.sort_by_key(|item| std::cmp::Reverse(item.0));
    scored
        .into_iter()
        .take(CDNLIVETV_MAX_CHANNELS_PER_MATCH)
        .map(|(_, info)| info)
        .collect()
}

fn cdnlivetv_channel_score(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    let mut score = 0;
    if lower.contains("fhd") || lower.contains("1080") {
        score += 6;
    } else if lower.contains("4k") || lower.contains("uhd") {
        score += 5;
    } else if lower.contains("hd") {
        score += 4;
    }
    const REPUTABLE: &[&str] = &[
        "bein",
        "itv",
        "tnt",
        "sky",
        "dazn",
        "tsn",
        "espn",
        "sport tv",
        "canal",
        "rmc",
        "eurosport",
        "arena",
        "match",
        "m6",
        "tf1",
        "tv4",
        "rai",
        "movistar",
        "viaplay",
        "ziggo",
        "supersport",
        "premier",
    ];
    if REPUTABLE.iter().any(|needle| lower.contains(needle)) {
        score += 3;
    }
    score
}

fn cdnlivetv_channel_quality_label(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("fhd") || lower.contains("1080") {
        "FHD"
    } else if lower.contains("4k") || lower.contains("uhd") {
        "4K"
    } else if lower.contains("hd") {
        "HD"
    } else {
        "SD"
    }
}

// Each event channel ships a ready-made `url` (the player page the site itself
// opens); prefer it when it's a valid cdnlivetv player URL so non-ASCII names
// stay correctly encoded, and reconstruct it from name+code otherwise.
fn cdnlivetv_channel_player_url(name: &str, code: &str, provided: &str) -> String {
    let provided = provided.trim();
    if !provided.is_empty()
        && let Ok(url) = Url::parse(provided)
        && is_supported_cdnlivetv_stream_url(&url)
    {
        return url.to_string();
    }
    let mut url = Url::parse(CDNLIVETV_CHANNEL_PLAYER_BASE).expect("valid cdnlivetv player base");
    url.query_pairs_mut()
        .append_pair("name", name)
        .append_pair("code", code)
        .append_pair("user", "cdnlivetv")
        .append_pair("plan", "free");
    url.to_string()
}

fn cdnlivetv_id_slug(value: &str) -> String {
    let slug: String = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    slug.trim_matches('-').to_owned()
}

// Parse cdnlivetv's "YYYY-MM-DD HH:MM" start string into a UTC epoch-ms.
fn parse_cdnlivetv_start_ms(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (date_part, time_part) = value.split_once(' ').unwrap_or((value, "00:00"));
    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.trim().parse().ok()?;
    let month: i64 = date_iter.next()?.trim().parse().ok()?;
    let day: i64 = date_iter.next()?.trim().parse().ok()?;
    let mut time_iter = time_part.split(':');
    let hour: i64 = time_iter.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let minute: i64 = time_iter.next().unwrap_or("0").trim().parse().unwrap_or(0);
    if !(1..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = unix_days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60) * 1000)
}

// Howard Hinnant's days_from_civil: days since 1970-01-01 for a proleptic
// Gregorian date. Mirrors civil_from_unix_days in home_bootstrap.rs (inverse).
fn unix_days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ── cdnlivetv stream resolve ────────────────────────────────────────────────
fn is_cdnlivetv_host(host: &str) -> bool {
    host == "cdnlivetv.tv"
        || host.ends_with(".cdnlivetv.tv")
        || host == "cdn-live.tv"
        || host.ends_with(".cdn-live.tv")
}

fn is_supported_cdnlivetv_stream_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    is_cdnlivetv_host(&host) && url.path().starts_with("/api/v1/channels/player")
}

fn is_supported_cdnlivetv_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    is_cdnlivetv_host(&host) && path.contains("/secure/") && path.ends_with(".m3u8")
}

async fn resolve_cached_cdnlivetv_live_stream(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    let cache_key = sports_stream_resolve_cache_key(CDNLIVETV_SOURCE_ID, source_url);
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }
    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let lock = state.sports_stream_resolve_cache.lock_for(&cache_key);
    let _guard = lock.lock().await;
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }
    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let started_at_ms = now_ms();
    let _permit = state.sports_stream_resolve_cache.acquire_permit().await?;
    match resolve_verified_cdnlivetv_live_stream_uncached(source_url, candidate_index).await {
        Ok(resolved) => {
            state.sports_provider_health.record_success(
                CDNLIVETV_SOURCE_ID,
                "stream",
                started_at_ms,
            );
            state
                .sports_stream_resolve_cache
                .insert(cache_key, resolved.clone(), now_ms());
            Ok(resolved)
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                CDNLIVETV_SOURCE_ID,
                "stream",
                started_at_ms,
                api_error_message(&error),
            );
            if error.status() != StatusCode::TOO_MANY_REQUESTS {
                state.sports_stream_resolve_cache.insert_failure(
                    cache_key,
                    api_error_message(&error).to_owned(),
                    now_ms(),
                );
            }
            Err(error)
        }
    }
}

async fn resolve_verified_cdnlivetv_live_stream_uncached(
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    if !is_supported_cdnlivetv_stream_url(source_url) {
        return Err(ApiError::bad_request(
            "Unsupported cdnlivetv live stream URL.",
        ));
    }
    let Some((playback_url, player_page_url)) = resolve_cdnlivetv_hls_url(source_url).await else {
        return Err(ApiError::bad_gateway(
            "cdnlivetv player could not produce an HLS playlist.",
        ));
    };
    Ok(ResolvedLiveStream {
        source_url: source_url.clone(),
        player_page_url,
        playback_url,
        playback_type: "hls",
        candidate_index,
        attempted_streams: candidate_index + 1,
    })
}

async fn resolve_cdnlivetv_hls_url(source_url: &Url) -> Option<(Url, Url)> {
    let script_path = cdnlivetv_hls_resolver_script_path();
    if is_disabled_resolver_script(&script_path) {
        return None;
    }

    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(source_url.as_str())
        .env(
            "CDNLIVETV_HLS_RESOLVE_TIMEOUT_MS",
            (CDNLIVETV_HLS_RESOLVE_TIMEOUT_SECONDS * 1000).to_string(),
        )
        .kill_on_drop(true);

    let output = timeout(
        Duration::from_secs(CDNLIVETV_HLS_RESOLVE_TIMEOUT_SECONDS + 4),
        command.output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }

    let resolver_output =
        serde_json::from_slice::<StreamedHlsResolverOutput>(&output.stdout).ok()?;
    let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
    if !is_supported_cdnlivetv_hls_url(&playback_url) {
        return None;
    }
    // Segments/playlists are plain-fetchable with a cdnlivetv Referer (no browser
    // binding), so the live proxy uses its normal curl path from here.
    let referer = Url::parse(CDNLIVETV_REFERER).ok()?;
    Some((playback_url, referer))
}

fn cdnlivetv_hls_resolver_script_path() -> String {
    if let Some(value) = std::env::var("CDNLIVETV_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(CDNLIVETV_HLS_RESOLVER_SCRIPT).is_file() {
        return CDNLIVETV_HLS_RESOLVER_SCRIPT.to_owned();
    }

    CDNLIVETV_HLS_RESOLVER_RUNTIME_SCRIPT.to_owned()
}

pub async fn football_stream_resolve_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    check_sports_stream_rate_limit(&state, &headers, &query)?;
    streamed_stream_resolve_response(&state, query).await
}

pub async fn basketball_stream_resolve_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    check_sports_stream_rate_limit(&state, &headers, &query)?;
    streamed_stream_resolve_response(&state, query).await
}

pub async fn streamed_sports_stream_resolve_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    check_sports_stream_rate_limit(&state, &headers, &query)?;
    sports_stream_resolve_response(&state, query).await
}

fn check_sports_stream_rate_limit(
    state: &AppState,
    headers: &HeaderMap,
    query: &ResolveFootballStreamQuery,
) -> AppResult<()> {
    let session_key = crate::auth::extract_session_token(headers)
        .map(|token| token.chars().take(16).collect::<String>())
        .unwrap_or_else(|| "anonymous".to_owned());
    let provider_key = Url::parse(query.url.trim())
        .ok()
        .and_then(|url| sports_stream_provider_id(&url))
        .unwrap_or("unknown");
    let key = format!("{session_key}:{provider_key}");
    if state.sports_stream_rate_limiter.check_and_record(&key) {
        Ok(())
    } else {
        Err(ApiError::too_many_requests(
            "Too many sports stream attempts. Try again shortly.",
        ))
    }
}

async fn sports_stream_resolve_response(
    state: &AppState,
    query: ResolveFootballStreamQuery,
) -> AppResult<Response<Body>> {
    let candidates =
        sports_live_stream_source_candidates(&query.url, query.fallback_urls.as_deref())?;
    let preflight = query
        .preflight
        .as_deref()
        .is_some_and(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"));
    let concurrency = if preflight {
        SPORTS_PREFLIGHT_MAX_CONCURRENT
    } else {
        1
    };

    // Resolve candidates with bounded concurrency. concurrency == 1 reproduces
    // the old sequential behaviour (primary, then each fallback); a higher cap
    // (first-watch preflight) races them so a dead primary doesn't gate a working
    // source behind it. Returning on the first HLS result drops the stream and
    // cancels the in-flight resolves.
    let mut resolved_stream = stream::iter(candidates.iter().cloned().enumerate().map(
        |(candidate_index, source_url)| async move {
            let provider = sports_stream_provider_id(&source_url).unwrap_or("unknown");
            let result = if is_supported_streamed_stream_url(&source_url) {
                resolve_cached_streamed_live_stream(state, &source_url, candidate_index).await
            } else if is_supported_matchstream_stream_url(&source_url) {
                resolve_cached_matchstream_live_stream(state, &source_url, candidate_index).await
            } else if is_supported_ntvs_stream_url(&source_url) {
                resolve_cached_ntvs_live_stream(state, &source_url, candidate_index).await
            } else if is_supported_cdnlivetv_stream_url(&source_url) {
                resolve_cached_cdnlivetv_live_stream(state, &source_url, candidate_index).await
            } else {
                Err(ApiError::bad_request("Unsupported sports live stream URL."))
            };
            (source_url, provider, result)
        },
    ))
    .buffer_unordered(concurrency);

    let mut errors = Vec::new();
    while let Some((source_url, provider, result)) = resolved_stream.next().await {
        match result {
            Ok(resolved) if resolved.playback_type == "hls" => {
                return Ok(resolved_live_stream_response(
                    state, resolved, provider, false,
                ));
            }
            Ok(resolved) => {
                errors.push(format!(
                    "{}: unsupported playback type {}",
                    source_url, resolved.playback_type
                ));
            }
            Err(error) => {
                let detail = error.message().unwrap_or("unknown error");
                errors.push(format!("{}: {detail}", source_url.as_str()));
            }
        }
    }

    let checked = candidates.len();
    let latest_error = errors
        .last()
        .map(|error| format!(" Last error: {error}"))
        .unwrap_or_default();
    Err(ApiError::bad_gateway(format!(
        "No working sports live stream found after checking {checked} source(s).{latest_error}"
    )))
}

async fn streamed_stream_resolve_response(
    state: &AppState,
    query: ResolveFootballStreamQuery,
) -> AppResult<Response<Body>> {
    let candidates = live_stream_source_candidates(&query.url, query.fallback_urls.as_deref())?;
    let mut errors = Vec::new();

    for (candidate_index, source_url) in candidates.iter().enumerate() {
        match resolve_cached_streamed_live_stream(state, source_url, candidate_index).await {
            Ok(resolved) if resolved.playback_type == "hls" => {
                return Ok(resolved_live_stream_response(
                    state,
                    resolved,
                    STREAMED_SOURCE_ID,
                    false,
                ));
            }
            Ok(resolved) => {
                errors.push(format!(
                    "{}: unsupported playback type {}",
                    source_url, resolved.playback_type
                ));
            }
            Err(error) => {
                let detail = error.message().unwrap_or("unknown error");
                errors.push(format!("{}: {detail}", source_url.as_str()));
            }
        }
    }

    let checked = candidates.len();
    let latest_error = errors
        .last()
        .map(|error| format!(" Last error: {error}"))
        .unwrap_or_default();
    Err(ApiError::bad_gateway(format!(
        "No working Streamed live stream found after checking {checked} source(s).{latest_error}"
    )))
}

fn resolved_live_stream_response(
    state: &AppState,
    resolved: ResolvedLiveStream,
    provider: &'static str,
    _cache_hit: bool,
) -> Response<Body> {
    let playback_url_text = if resolved.playback_type == "hls" {
        // Serve the signed playlist from the Cloudflare Worker (when
        // configured) so live playlist polling never crosses the zone's L7
        // DDoS managed ruleset, which 503s it under bursty load.
        crate::live::route_live_playback_source_via_worker(
            &state.config.live_hls_resource_worker_base,
            crate::live::build_sports_live_hls_playback_source(
                resolved.playback_url.as_str(),
                Some(resolved.player_page_url.as_str()),
                state.config.live_hls_proxy_secret.as_str(),
            ),
        )
    } else {
        resolved.playback_url.to_string()
    };
    json_response(json!({
        "source": resolved.source_url.as_str(),
        "provider": provider,
        "playerPage": resolved.player_page_url.as_str(),
        "playbackType": resolved.playback_type,
        "playbackUrl": playback_url_text,
        "streamUrl": "",
        "embedUrl": playback_url_text.as_str(),
        "resolvedFromFallback": resolved.candidate_index > 0,
        "attemptedStreams": resolved.attempted_streams
    }))
}

async fn resolve_cached_streamed_live_stream(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    let cache_key = sports_stream_resolve_cache_key(STREAMED_SOURCE_ID, source_url);
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }

    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let lock = state.sports_stream_resolve_cache.lock_for(&cache_key);
    let _guard = lock.lock().await;
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }

    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let started_at_ms = now_ms();
    let _permit = state.sports_stream_resolve_cache.acquire_permit().await?;
    match resolve_verified_streamed_live_stream_uncached(state, source_url, candidate_index).await {
        Ok(resolved) => {
            state.sports_provider_health.record_success(
                STREAMED_SOURCE_ID,
                "stream",
                started_at_ms,
            );
            state
                .sports_stream_resolve_cache
                .insert(cache_key, resolved.clone(), now_ms());
            Ok(resolved)
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                STREAMED_SOURCE_ID,
                "stream",
                started_at_ms,
                api_error_message(&error),
            );
            if error.status() != StatusCode::TOO_MANY_REQUESTS {
                state.sports_stream_resolve_cache.insert_failure(
                    cache_key,
                    api_error_message(&error).to_owned(),
                    now_ms(),
                );
            }
            Err(error)
        }
    }
}

async fn resolve_cached_matchstream_live_stream(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    let cache_key = sports_stream_resolve_cache_key(MATCHSTREAM_SOURCE_ID, source_url);
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }

    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let lock = state.sports_stream_resolve_cache.lock_for(&cache_key);
    let _guard = lock.lock().await;
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }

    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let started_at_ms = now_ms();
    let _permit = state.sports_stream_resolve_cache.acquire_permit().await?;
    match resolve_verified_matchstream_live_stream_uncached(state, source_url, candidate_index)
        .await
    {
        Ok(resolved) => {
            state.sports_provider_health.record_success(
                MATCHSTREAM_SOURCE_ID,
                "stream",
                started_at_ms,
            );
            state
                .sports_stream_resolve_cache
                .insert(cache_key, resolved.clone(), now_ms());
            Ok(resolved)
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                MATCHSTREAM_SOURCE_ID,
                "stream",
                started_at_ms,
                api_error_message(&error),
            );
            if error.status() != StatusCode::TOO_MANY_REQUESTS {
                state.sports_stream_resolve_cache.insert_failure(
                    cache_key,
                    api_error_message(&error).to_owned(),
                    now_ms(),
                );
            }
            Err(error)
        }
    }
}

async fn resolve_cached_ntvs_live_stream(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    let cache_key = sports_stream_resolve_cache_key(NTVS_SOURCE_ID, source_url);
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }

    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let lock = state.sports_stream_resolve_cache.lock_for(&cache_key);
    let _guard = lock.lock().await;
    if let Some(mut resolved) = state
        .sports_stream_resolve_cache
        .fresh(&cache_key, now_ms())
    {
        resolved.candidate_index = candidate_index;
        resolved.attempted_streams = candidate_index + 1;
        return Ok(resolved);
    }

    if let Some(message) = state
        .sports_stream_resolve_cache
        .fresh_failure(&cache_key, now_ms())
    {
        return Err(ApiError::bad_gateway(format!(
            "Recently failed to resolve this source (cached): {message}"
        )));
    }

    let started_at_ms = now_ms();
    let _permit = state.sports_stream_resolve_cache.acquire_permit().await?;
    match resolve_verified_ntvs_live_stream_uncached(state, source_url, candidate_index).await {
        Ok(resolved) => {
            state
                .sports_provider_health
                .record_success(NTVS_SOURCE_ID, "stream", started_at_ms);
            state
                .sports_stream_resolve_cache
                .insert(cache_key, resolved.clone(), now_ms());
            Ok(resolved)
        }
        Err(error) => {
            state.sports_provider_health.record_failure(
                NTVS_SOURCE_ID,
                "stream",
                started_at_ms,
                api_error_message(&error),
            );
            if error.status() != StatusCode::TOO_MANY_REQUESTS {
                state.sports_stream_resolve_cache.insert_failure(
                    cache_key,
                    api_error_message(&error).to_owned(),
                    now_ms(),
                );
            }
            Err(error)
        }
    }
}

fn sports_stream_resolve_cache_key(provider: &'static str, source_url: &Url) -> String {
    format!("{provider}:{}", normalize_url_cache_key(source_url))
}

fn normalize_url_cache_key(url: &Url) -> String {
    let mut normalized = url.clone();
    if let Some(host) = normalized.host_str().map(|host| host.to_ascii_lowercase()) {
        let _ = normalized.set_host(Some(&host));
    }
    normalized.to_string()
}

async fn resolve_verified_streamed_live_stream_uncached(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    let mut streams = fetch_streamed_embed_streams(state, source_url).await?;
    streams.sort_by_key(|stream| (!stream.hd, stream.stream_no));

    let mut errors = Vec::new();
    for stream in streams {
        let embed_url = match Url::parse(stream.embed_url.trim()) {
            Ok(url)
                if is_supported_streamed_embed_url(&url) || is_supported_ntvs_embed_url(&url) =>
            {
                url
            }
            _ => {
                errors.push("Streamed returned an unsupported embed URL.".to_owned());
                continue;
            }
        };
        if let Some((playback_url, player_page_url)) =
            resolve_streamed_embed_playback_url(&embed_url).await
        {
            return Ok(ResolvedLiveStream {
                source_url: source_url.clone(),
                player_page_url,
                playback_url,
                playback_type: "hls",
                candidate_index,
                attempted_streams: candidate_index + 1,
            });
        }

        errors.push("Streamed embed could not produce an HLS playlist.".to_owned());
    }

    let latest_error = errors
        .last()
        .map(|error| format!(" Last error: {error}"))
        .unwrap_or_default();
    Err(ApiError::bad_gateway(format!(
        "No playable Streamed embed found.{latest_error}"
    )))
}

async fn resolve_streamed_embed_playback_url(embed_url: &Url) -> Option<(Url, Url)> {
    if is_supported_streamed_embed_url(embed_url) {
        let playback_url = resolve_streamed_embed_hls_url(embed_url).await?;
        let player_page_url =
            Url::parse(STREAMED_EMBED_REFERER).unwrap_or_else(|_| embed_url.clone());
        return Some((playback_url, player_page_url));
    }

    if is_supported_ntvs_embed_url(embed_url) {
        return resolve_ntvs_embed_st_hls_url(embed_url).await;
    }

    None
}

async fn resolve_verified_matchstream_live_stream_uncached(
    _state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    if !is_supported_matchstream_stream_url(source_url) {
        return Err(ApiError::bad_request(
            "Unsupported MatchStream live stream URL.",
        ));
    }
    let Some((playback_url, player_page_url)) = resolve_matchstream_hls_url(source_url).await
    else {
        return Err(ApiError::bad_gateway(
            "MatchStream player could not produce an HLS playlist.",
        ));
    };

    Ok(ResolvedLiveStream {
        source_url: source_url.clone(),
        player_page_url,
        playback_url,
        playback_type: "hls",
        candidate_index,
        attempted_streams: candidate_index + 1,
    })
}

async fn resolve_verified_ntvs_live_stream_uncached(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    if !is_supported_ntvs_stream_url(source_url) {
        return Err(ApiError::bad_request("Unsupported NTVS live stream URL."));
    }

    let player_page_urls = ntvs_player_page_candidates(state, source_url).await?;
    let mut errors = Vec::new();
    for player_page_url in player_page_urls {
        if let Some((playback_url, resolved_player_page_url)) =
            resolve_ntvs_player_hls_url(state, &player_page_url).await
        {
            return Ok(ResolvedLiveStream {
                source_url: source_url.clone(),
                player_page_url: resolved_player_page_url,
                playback_url,
                playback_type: "hls",
                candidate_index,
                attempted_streams: candidate_index + 1,
            });
        }
        errors.push(format!(
            "{} could not produce an HLS playlist.",
            player_page_url.as_str()
        ));
    }

    let latest_error = errors
        .last()
        .map(|error| format!(" Last error: {error}"))
        .unwrap_or_default();
    Err(ApiError::bad_gateway(format!(
        "No playable NTVS embed found.{latest_error}"
    )))
}

async fn resolve_streamed_embed_hls_url(embed_url: &Url) -> Option<Url> {
    // Fast path: the shared minimal-browser resolver (stub page + lock.js recipe;
    // it handles embedsports.top -> strmd.top just like embed.st -> strmd.st).
    let min_script = ntvs_embed_min_hls_resolver_script_path();
    if !is_disabled_resolver_script(&min_script)
        && let Some(playback_url) = run_streamed_embed_min_resolver(&min_script, embed_url).await
    {
        return Some(playback_url);
    }

    // Fallback: full-page Streamed resolver.
    let script_path = streamed_embed_hls_resolver_script_path();
    if matches!(
        script_path.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "disabled"
    ) {
        return None;
    }

    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(embed_url.as_str())
        .env(
            "STREAMED_HLS_RESOLVE_TIMEOUT_MS",
            (STREAMED_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS * 1000).to_string(),
        )
        .kill_on_drop(true);

    let output = timeout(
        Duration::from_secs(STREAMED_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS + 4),
        command.output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }

    let resolver_output =
        serde_json::from_slice::<StreamedHlsResolverOutput>(&output.stdout).ok()?;
    let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
    is_supported_streamed_hls_url(&playback_url).then_some(playback_url)
}

async fn run_streamed_embed_min_resolver(script_path: &str, embed_url: &Url) -> Option<Url> {
    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(embed_url.as_str())
        .env(
            "EMBED_MIN_RESOLVE_TIMEOUT_MS",
            (NTVS_EMBED_MIN_HLS_RESOLVE_TIMEOUT_SECONDS * 1000).to_string(),
        )
        .kill_on_drop(true);

    let output = timeout(
        Duration::from_secs(NTVS_EMBED_MIN_HLS_RESOLVE_TIMEOUT_SECONDS + 4),
        command.output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }

    // resolve-embed-min.mjs emits {playbackUrl, playerPage, referer}; we only
    // need the playback URL here (the Streamed caller supplies the referer).
    let resolver_output =
        serde_json::from_slice::<StreamedHlsResolverOutput>(&output.stdout).ok()?;
    let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
    is_supported_streamed_hls_url(&playback_url).then_some(playback_url)
}

async fn resolve_matchstream_hls_url(source_url: &Url) -> Option<(Url, Url)> {
    let script_path = matchstream_hls_resolver_script_path();
    if matches!(
        script_path.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "disabled"
    ) {
        return None;
    }

    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(source_url.as_str())
        .env(
            "MATCHSTREAM_HLS_RESOLVE_TIMEOUT_MS",
            (MATCHSTREAM_HLS_RESOLVE_TIMEOUT_SECONDS * 1000).to_string(),
        )
        .kill_on_drop(true);

    let output = timeout(
        Duration::from_secs(MATCHSTREAM_HLS_RESOLVE_TIMEOUT_SECONDS + 4),
        command.output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }

    let resolver_output =
        serde_json::from_slice::<MatchstreamHlsResolverOutput>(&output.stdout).ok()?;
    let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
    if !is_supported_matchstream_hls_url(&playback_url) {
        return None;
    }
    let player_page_text = if resolver_output.player_page.trim().is_empty() {
        resolver_output.referer.trim()
    } else {
        resolver_output.player_page.trim()
    };
    let player_page_url = Url::parse(player_page_text)
        .ok()
        .filter(is_supported_matchstream_player_url)
        .unwrap_or_else(|| source_url.clone());
    Some((playback_url, player_page_url))
}

async fn resolve_ntvs_player_hls_url(state: &AppState, player_url: &Url) -> Option<(Url, Url)> {
    if is_supported_ntvs_embed_url(player_url) {
        return resolve_ntvs_embed_st_hls_url(player_url).await;
    }
    if is_supported_ntvs_hesgoaler_player_url(player_url) {
        return resolve_ntvs_hesgoaler_hls_url(state, player_url).await;
    }
    if is_supported_cdnlivetv_stream_url(player_url) {
        return resolve_cdnlivetv_hls_url(player_url).await;
    }
    None
}

async fn resolve_ntvs_embed_st_hls_url(embed_url: &Url) -> Option<(Url, Url)> {
    // Fast path: minimal-browser resolver (stub page + the site's lock.js WASM
    // recipe — no bundle-jw.js/clappr/ads). Short budget; falls back on miss.
    let min_script = ntvs_embed_min_hls_resolver_script_path();
    if !is_disabled_resolver_script(&min_script)
        && let Some(resolved) = run_ntvs_embed_resolver_script(
            &min_script,
            embed_url,
            NTVS_EMBED_MIN_HLS_RESOLVE_TIMEOUT_SECONDS,
        )
        .await
    {
        return Some(resolved);
    }

    // Fallback: full-page Playwright resolver.
    let script_path = ntvs_embed_hls_resolver_script_path();
    if is_disabled_resolver_script(&script_path) {
        return None;
    }
    run_ntvs_embed_resolver_script(
        &script_path,
        embed_url,
        NTVS_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS,
    )
    .await
}

fn is_disabled_resolver_script(script_path: &str) -> bool {
    matches!(
        script_path.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "disabled"
    )
}

async fn run_ntvs_embed_resolver_script(
    script_path: &str,
    embed_url: &Url,
    inner_timeout_seconds: u64,
) -> Option<(Url, Url)> {
    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(embed_url.as_str())
        .env(
            "NTVS_HLS_RESOLVE_TIMEOUT_MS",
            (inner_timeout_seconds * 1000).to_string(),
        )
        .env(
            "EMBED_MIN_RESOLVE_TIMEOUT_MS",
            (inner_timeout_seconds * 1000).to_string(),
        )
        .kill_on_drop(true);

    let output = timeout(
        Duration::from_secs(inner_timeout_seconds + 4),
        command.output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }

    let resolver_output = serde_json::from_slice::<NtvsHlsResolverOutput>(&output.stdout).ok()?;
    let playback_url = Url::parse(resolver_output.playback_url.trim()).ok()?;
    if !is_supported_ntvs_hls_url(&playback_url) {
        return None;
    }
    let player_page_text = if resolver_output.player_page.trim().is_empty() {
        resolver_output.referer.trim()
    } else {
        resolver_output.player_page.trim()
    };
    let player_page_url = Url::parse(player_page_text)
        .ok()
        .filter(is_supported_ntvs_embed_url)
        .unwrap_or_else(|| embed_url.clone());
    Some((playback_url, player_page_url))
}

async fn resolve_ntvs_hesgoaler_hls_url(state: &AppState, player_url: &Url) -> Option<(Url, Url)> {
    let html = fetch_ntvs_html(state, player_url, player_url.as_str())
        .await
        .ok()?;
    let (channel, playlist_url) = parse_ntvs_hesgoaler_player_source(&html)?;
    let token = fetch_ntvs_hesgoaler_token(state, player_url, &channel).await?;
    let mut playback_url = Url::parse(&playlist_url)
        .or_else(|_| player_url.join(&playlist_url))
        .ok()?;
    {
        let mut query_pairs = playback_url.query_pairs_mut();
        query_pairs.clear();
        query_pairs.append_pair("token", token.as_str());
    }
    if !is_supported_ntvs_hls_url(&playback_url) {
        return None;
    }
    Some((playback_url, player_url.clone()))
}

async fn fetch_ntvs_hesgoaler_token(
    state: &AppState,
    player_url: &Url,
    channel: &str,
) -> Option<String> {
    let client = sports_http_client(state).ok()?;
    let response = client
        .post(player_url.clone())
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, player_url.as_str())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&json!({
            "channel": channel,
            "current_token": "",
        }))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.json::<Value>().await.ok()?;
    body.get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
}

fn parse_ntvs_hesgoaler_player_source(html: &str) -> Option<(String, String)> {
    let channel_re = Regex::new(r#"(?i)ch\s*:\s*"([^"]+)"|ch\s*:\s*'([^']+)'"#).ok()?;
    let src_re = Regex::new(r#"(?i)src\s*:\s*"([^"]+)"|src\s*:\s*'([^']+)'"#).ok()?;

    let channel = channel_re
        .captures(html)
        .and_then(|captures| captures.get(1).or_else(|| captures.get(2)))
        .map(|value| value.as_str().trim().to_owned())?;
    let playlist_url = src_re
        .captures(html)
        .and_then(|captures| captures.get(1).or_else(|| captures.get(2)))
        .map(|value| value.as_str().trim().to_owned())?;

    Some((channel, playlist_url))
}

fn streamed_embed_hls_resolver_script_path() -> String {
    if let Some(value) = std::env::var("STREAMED_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(STREAMED_EMBED_HLS_RESOLVER_SCRIPT).is_file() {
        return STREAMED_EMBED_HLS_RESOLVER_SCRIPT.to_owned();
    }

    STREAMED_EMBED_HLS_RESOLVER_RUNTIME_SCRIPT.to_owned()
}

fn matchstream_hls_resolver_script_path() -> String {
    if let Some(value) = std::env::var("MATCHSTREAM_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(MATCHSTREAM_HLS_RESOLVER_SCRIPT).is_file() {
        return MATCHSTREAM_HLS_RESOLVER_SCRIPT.to_owned();
    }

    MATCHSTREAM_HLS_RESOLVER_RUNTIME_SCRIPT.to_owned()
}

fn ntvs_embed_hls_resolver_script_path() -> String {
    if let Some(value) = std::env::var("NTVS_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(NTVS_EMBED_HLS_RESOLVER_SCRIPT).is_file() {
        return NTVS_EMBED_HLS_RESOLVER_SCRIPT.to_owned();
    }

    NTVS_EMBED_HLS_RESOLVER_RUNTIME_SCRIPT.to_owned()
}

fn ntvs_embed_min_hls_resolver_script_path() -> String {
    if let Some(value) = std::env::var("NTVS_EMBED_MIN_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(NTVS_EMBED_MIN_HLS_RESOLVER_SCRIPT).is_file() {
        return NTVS_EMBED_MIN_HLS_RESOLVER_SCRIPT.to_owned();
    }

    NTVS_EMBED_MIN_HLS_RESOLVER_RUNTIME_SCRIPT.to_owned()
}

fn sports_live_stream_source_candidates(
    primary_url: &str,
    fallback_urls: Option<&str>,
) -> AppResult<Vec<Url>> {
    let mut primary = Url::parse(primary_url.trim())
        .map_err(|_| ApiError::bad_request("Invalid live stream URL."))?;
    normalize_matchstream_channel_url_path(&mut primary);
    if !is_supported_sports_stream_url(&primary) {
        return Err(ApiError::bad_request("Unsupported sports live stream URL."));
    }

    let mut candidates = Vec::with_capacity(MAX_LIVE_STREAM_CANDIDATES);
    let mut seen = BTreeSet::new();
    push_unique_stream_candidate(&mut candidates, &mut seen, primary);

    for fallback_url in parse_fallback_stream_urls(fallback_urls)? {
        if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
            break;
        }
        let Ok(mut parsed) = Url::parse(fallback_url.trim()) else {
            continue;
        };
        normalize_matchstream_channel_url_path(&mut parsed);
        if !is_supported_sports_stream_url(&parsed) {
            continue;
        }
        push_unique_stream_candidate(&mut candidates, &mut seen, parsed);
    }

    Ok(candidates)
}

fn live_stream_source_candidates(
    primary_url: &str,
    fallback_urls: Option<&str>,
) -> AppResult<Vec<Url>> {
    let primary = Url::parse(primary_url.trim())
        .map_err(|_| ApiError::bad_request("Invalid live stream URL."))?;
    if !is_supported_streamed_stream_url(&primary) {
        return Err(ApiError::bad_request(
            "Unsupported Streamed live stream URL.",
        ));
    }
    let mut candidates = Vec::with_capacity(MAX_LIVE_STREAM_CANDIDATES);
    let mut seen = BTreeSet::new();

    push_unique_stream_candidate(&mut candidates, &mut seen, primary);
    for fallback_url in parse_fallback_stream_urls(fallback_urls)? {
        if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
            break;
        }
        let Ok(parsed) = Url::parse(fallback_url.trim()) else {
            continue;
        };
        if !is_supported_streamed_stream_url(&parsed) {
            continue;
        }
        push_unique_stream_candidate(&mut candidates, &mut seen, parsed);
    }

    Ok(candidates)
}

#[cfg(test)]
fn matchstream_live_stream_source_candidates(
    primary_url: &str,
    fallback_urls: Option<&str>,
) -> AppResult<Vec<Url>> {
    let mut primary = Url::parse(primary_url.trim())
        .map_err(|_| ApiError::bad_request("Invalid live stream URL."))?;
    normalize_matchstream_channel_url_path(&mut primary);
    if !is_supported_matchstream_stream_url(&primary) {
        return Err(ApiError::bad_request(
            "Unsupported MatchStream live stream URL.",
        ));
    }
    let mut candidates = Vec::with_capacity(MAX_LIVE_STREAM_CANDIDATES);
    let mut seen = BTreeSet::new();

    push_unique_stream_candidate(&mut candidates, &mut seen, primary);
    for fallback_url in parse_fallback_stream_urls(fallback_urls)? {
        if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
            break;
        }
        let Ok(mut parsed) = Url::parse(fallback_url.trim()) else {
            continue;
        };
        normalize_matchstream_channel_url_path(&mut parsed);
        if !is_supported_matchstream_stream_url(&parsed) {
            continue;
        }
        push_unique_stream_candidate(&mut candidates, &mut seen, parsed);
    }

    Ok(candidates)
}

fn normalize_matchstream_channel_url_path(url: &mut Url) {
    if url.path().trim_start_matches('/') == "ch" {
        url.set_path("/ch");
    }
}

fn parse_fallback_stream_urls(value: Option<&str>) -> AppResult<Vec<String>> {
    let Some(raw_value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };

    if raw_value.starts_with('[') {
        return serde_json::from_str::<Vec<String>>(raw_value)
            .map_err(|_| ApiError::bad_request("Invalid fallback live stream list."));
    }

    Ok(raw_value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect())
}

fn push_unique_stream_candidate(candidates: &mut Vec<Url>, seen: &mut BTreeSet<String>, url: Url) {
    let key = url.as_str().trim_end_matches('/').to_owned();
    if seen.insert(key) {
        candidates.push(url);
    }
}

async fn fetch_streamed_embed_streams(
    state: &AppState,
    source_url: &Url,
) -> AppResult<Vec<StreamedEmbedStream>> {
    if is_streamed_watch_url(source_url) {
        return fetch_streamed_watch_embed_streams(state, source_url).await;
    }

    let response = sports_http_client(state)?
        .get(source_url.clone())
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_REFERER)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out fetching Streamed embeds.")
            } else {
                ApiError::bad_gateway(format!("Failed to fetch Streamed embeds: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Streamed embed resolver returned HTTP {}.",
            response.status()
        )));
    }

    let streams = response
        .json::<Vec<StreamedEmbedStream>>()
        .await
        .map_err(|error| ApiError::bad_gateway(format!("Invalid Streamed embeds: {error}")))?;
    if streams.is_empty() {
        return Err(ApiError::bad_gateway("Streamed returned no embeds."));
    }
    Ok(streams)
}

async fn fetch_streamed_watch_embed_streams(
    state: &AppState,
    source_url: &Url,
) -> AppResult<Vec<StreamedEmbedStream>> {
    let response = sports_http_client(state)?
        .get(source_url.clone())
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_REFERER)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out fetching Streamed watch page.")
            } else {
                ApiError::bad_gateway(format!("Failed to fetch Streamed watch page: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Streamed watch page returned HTTP {}.",
            response.status()
        )));
    }

    let html = response.text().await.map_err(|error| {
        ApiError::bad_gateway(format!("Failed to read Streamed watch page: {error}"))
    })?;
    let streams = extract_streamed_watch_embed_streams(&html, source_url);
    if streams.is_empty() {
        return Err(ApiError::bad_gateway(
            "Streamed watch page did not include a supported embed.",
        ));
    }
    Ok(streams)
}

fn extract_streamed_watch_embed_streams(html: &str, base_url: &Url) -> Vec<StreamedEmbedStream> {
    let mut seen = BTreeSet::new();
    extract_html_attribute_values(html, "src")
        .into_iter()
        .filter_map(|value| resolve_html_url(base_url, &value))
        .filter(|url| is_supported_streamed_embed_url(url) || is_supported_ntvs_embed_url(url))
        .filter(|url| seen.insert(url.as_str().trim_end_matches('/').to_owned()))
        .map(|url| StreamedEmbedStream {
            stream_no: parse_embed_stream_number(&url).unwrap_or(1),
            hd: true,
            embed_url: url.to_string(),
            language: String::new(),
            source: String::new(),
        })
        .collect()
}

fn parse_embed_stream_number(url: &Url) -> Option<i64> {
    url.path_segments()?
        .next_back()?
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
}

async fn ntvs_player_page_candidates(state: &AppState, source_url: &Url) -> AppResult<Vec<Url>> {
    if is_supported_ntvs_embed_url(source_url) {
        return Ok(vec![source_url.clone()]);
    }

    if is_supported_ntvs_hesgoaler_player_url(source_url) {
        return Ok(vec![source_url.clone()]);
    }

    if is_supported_ntvs_wrapper_embed_url(source_url) {
        return fetch_ntvs_direct_embed_candidates(state, source_url).await;
    }

    if !is_supported_ntvs_watch_url(source_url) && !is_supported_ntvs_channel_url(source_url) {
        return Err(ApiError::bad_request("Unsupported NTVS live stream URL."));
    }

    let referer = ntvs_referer_for_url(source_url);
    let html = fetch_ntvs_html(state, source_url, &referer).await?;
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();

    for url in extract_ntvs_candidate_urls(&html, source_url) {
        if is_supported_ntvs_embed_url(&url) {
            push_unique_stream_candidate(&mut candidates, &mut seen, url);
            continue;
        }
        if is_supported_ntvs_hesgoaler_player_url(&url) {
            push_unique_stream_candidate(&mut candidates, &mut seen, url);
            continue;
        }
        if is_supported_cdnlivetv_stream_url(&url) {
            push_unique_stream_candidate(&mut candidates, &mut seen, url);
            continue;
        }
        if !is_supported_ntvs_wrapper_embed_url(&url) {
            continue;
        }
        if let Ok(embed_urls) = fetch_ntvs_direct_embed_candidates(state, &url).await {
            for embed_url in embed_urls {
                push_unique_stream_candidate(&mut candidates, &mut seen, embed_url);
                if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
                    break;
                }
            }
        }
        if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
            break;
        }
    }

    if candidates.is_empty() {
        return Err(ApiError::bad_gateway(
            "NTVS watch page did not include a supported embed.",
        ));
    }
    Ok(candidates)
}

async fn fetch_ntvs_direct_embed_candidates(
    state: &AppState,
    wrapper_url: &Url,
) -> AppResult<Vec<Url>> {
    let html = fetch_ntvs_html(state, wrapper_url, wrapper_url.as_str()).await?;
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    for url in extract_ntvs_candidate_urls(&html, wrapper_url) {
        if is_supported_ntvs_embed_url(&url) {
            push_unique_stream_candidate(&mut candidates, &mut seen, url);
            if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
                break;
            }
            continue;
        }
        if is_supported_ntvs_hesgoaler_player_url(&url) {
            push_unique_stream_candidate(&mut candidates, &mut seen, url);
            if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
                break;
            }
            continue;
        }
        if is_supported_cdnlivetv_stream_url(&url) {
            push_unique_stream_candidate(&mut candidates, &mut seen, url);
            if candidates.len() >= MAX_LIVE_STREAM_CANDIDATES {
                break;
            }
        }
    }
    if candidates.is_empty() {
        return Err(ApiError::bad_gateway(
            "NTVS wrapper did not include a supported embed.",
        ));
    }
    Ok(candidates)
}

async fn fetch_ntvs_html(state: &AppState, url: &Url, referer: &str) -> AppResult<String> {
    let fetch_url = normalize_ntvs_fetch_url(url);
    let response = sports_http_client(state)?
        .get(fetch_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, referer)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out fetching NTVS stream page.")
            } else {
                ApiError::bad_gateway(format!("Failed to fetch NTVS stream page: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "NTVS stream page returned HTTP {}.",
            response.status()
        )));
    }

    response
        .text()
        .await
        .map_err(|error| ApiError::bad_gateway(format!("Failed to read NTVS stream page: {error}")))
}

fn extract_ntvs_watch_page_sources(html: &str, base_url: &Url) -> Vec<StreamedEmbedStream> {
    let Ok(select_pattern) = Regex::new(r#"(?is)<select\b([^>]*)>(.*?)</select>"#) else {
        return Vec::new();
    };
    let Ok(option_pattern) = Regex::new(r#"(?is)<option\b([^>]*)>(.*?)</option>"#) else {
        return Vec::new();
    };
    let mut sources = Vec::new();
    let mut seen = BTreeSet::new();

    for select in select_pattern.captures_iter(html) {
        let attributes = select
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let is_source_selector = extract_html_attribute_values(attributes, "id")
            .into_iter()
            .any(|value| value.eq_ignore_ascii_case("sourceSelect"));
        if !is_source_selector {
            continue;
        }
        let options_html = select
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or_default();
        for option in option_pattern.captures_iter(options_html) {
            if sources.len() >= NTVS_LIVE_SOURCE_EXPANSION_MAX_STREAMS {
                break;
            }
            let attributes = option
                .get(1)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let Some(raw_value) = extract_html_attribute_values(attributes, "value")
                .into_iter()
                .next()
            else {
                continue;
            };
            let Some(source_url) = resolve_ntvs_candidate_url(base_url, &raw_value) else {
                continue;
            };
            if !is_supported_ntvs_wrapper_embed_url(&source_url) {
                continue;
            }
            let canonical_url = source_url.to_string();
            if !seen.insert(canonical_url.clone()) {
                continue;
            }
            let raw_label = option
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let label = normalize_ntvs_option_text(raw_label);
            let Some((source, language, stream_no, hd)) = parse_ntvs_option_label(&label) else {
                continue;
            };
            sources.push(StreamedEmbedStream {
                stream_no,
                hd,
                embed_url: canonical_url,
                language,
                source,
            });
        }
        // There is only one playback selector. Ignoring unrelated selects also
        // avoids treating embed-code textarea values as phantom sources.
        break;
    }

    sources
}

fn normalize_ntvs_option_text(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => text.push(character),
            _ => {}
        }
    }
    decode_basic_html_entities(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_ntvs_option_label(label: &str) -> Option<(String, String, i64, bool)> {
    let parts = label
        .split(" - ")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 4 || !parts.first()?.to_ascii_lowercase().starts_with("server ") {
        return None;
    }
    let source = parts.get(1)?.trim();
    let stream_label = parts.last()?.trim();
    let stream_no = stream_label
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())?
        .parse::<i64>()
        .ok()?;
    let language = parts[2..parts.len() - 1].join(" - ");
    if source.is_empty() || language.is_empty() || stream_no <= 0 {
        return None;
    }
    Some((
        source.to_ascii_lowercase(),
        language,
        stream_no,
        label.to_ascii_lowercase().contains("[hd]"),
    ))
}

fn extract_ntvs_candidate_urls(html: &str, base_url: &Url) -> Vec<Url> {
    let mut seen = BTreeSet::new();
    let mut candidates = Vec::new();
    for url in ["src", "value", "data-src", "href"]
        .into_iter()
        .flat_map(|attribute| extract_html_attribute_values(html, attribute))
        .filter_map(|value| resolve_ntvs_candidate_url(base_url, &value))
        .filter(|url| {
            is_supported_ntvs_wrapper_embed_url(url)
                || is_supported_ntvs_embed_url(url)
                || is_supported_ntvs_hesgoaler_player_url(url)
                || is_supported_cdnlivetv_stream_url(url)
        })
    {
        let key = url.as_str().trim_end_matches('/').to_owned();
        if seen.insert(key) {
            candidates.push(url);
        }
    }
    for url in extract_ntvs_script_candidate_urls(html, base_url) {
        let key = url.as_str().trim_end_matches('/').to_owned();
        if seen.insert(key) {
            candidates.push(url);
        }
    }
    candidates
}

fn extract_ntvs_script_candidate_urls(html: &str, base_url: &Url) -> Vec<Url> {
    let mut candidates = Vec::new();
    let mut values = Vec::new();

    let script_candidate_patterns = [
        r#"(?i)/embed\?t=[^"'`\s>]+"#,
        r#"(?i)/stream\.php\?ch=[^"'`\s>]+"#,
        r#"(?i)https?://[^"'`\s>]+/embed\.st/embed/[^"'`\s>]+"#,
        r#"(?i)https?://[^"'`\s>]+/stream\.php\?ch=[^"'`\s>]+"#,
        r#"(?i)https?://(?:[^/]+\.)?(?:cdnlivetv\.tv|cdn-live\.tv)/api/v1/channels/player/[^"'`\s>]+"#,
    ];

    for pattern in script_candidate_patterns {
        if let Ok(regex) = Regex::new(pattern) {
            for value in regex.find_iter(html).map(|value| value.as_str()) {
                values.extend(extract_ntvs_candidate_values_from_text(
                    &normalize_ntvs_inline_value(value),
                ));
            }
        }
    }

    for value in values {
        if let Some(url) = resolve_ntvs_candidate_url(base_url, &value)
            && (is_supported_ntvs_wrapper_embed_url(&url)
                || is_supported_ntvs_embed_url(&url)
                || is_supported_ntvs_hesgoaler_player_url(&url)
                || is_supported_cdnlivetv_stream_url(&url))
        {
            candidates.push(url);
        }
    }
    candidates
}

fn extract_ntvs_candidate_values_from_text(value: &str) -> Vec<String> {
    let mut values = Vec::new();
    let value = value.trim_matches(|character: char| character.is_whitespace());
    let value = value
        .trim_matches(|character: char| matches!(character, '"' | '\'' | '`' | '\\' | '>' | '<'));
    values.push(value.to_owned());
    values
}

fn normalize_ntvs_inline_value(value: &str) -> String {
    value
        .replace("\\/", "/")
        .replace("\\'", "'")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\t", "\t")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn extract_html_attribute_values(html: &str, attribute: &str) -> Vec<String> {
    let escaped_attribute = regex::escape(attribute);
    let pattern = Regex::new(&format!(
        r#"(?i)(?:^|[^\w-]){}\s*=\s*"([^"]*?)"|(?i)(?:^|[^\w-]){}\s*=\s*'([^']*?)'"#,
        escaped_attribute, escaped_attribute
    ))
    .ok();
    if let Some(pattern) = pattern {
        return pattern
            .captures_iter(html)
            .filter_map(|captures| captures.get(1).or_else(|| captures.get(2)))
            .map(|value| decode_basic_html_entities(value.as_str().trim()))
            .collect();
    }

    let lower_html = html.to_ascii_lowercase();
    let mut values = Vec::new();
    let lower_attribute = attribute.to_ascii_lowercase();
    for quote in ['"', '\''] {
        let pattern = format!("{lower_attribute}={quote}");
        let mut offset = 0usize;
        while let Some(relative_start) = lower_html[offset..].find(&pattern) {
            let value_start = offset + relative_start + pattern.len();
            let Some(relative_end) = html[value_start..].find(quote) else {
                break;
            };
            values.push(decode_basic_html_entities(
                &html[value_start..value_start + relative_end],
            ));
            offset = value_start + relative_end + 1;
        }
    }
    values
}

fn decode_basic_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn resolve_html_url(base_url: &Url, value: &str) -> Option<Url> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.to_ascii_lowercase().starts_with("javascript:") {
        return None;
    }
    base_url.join(trimmed).ok()
}

fn resolve_ntvs_candidate_url(base_url: &Url, value: &str) -> Option<Url> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.to_ascii_lowercase().starts_with("javascript:") {
        return None;
    }

    if let Some(hesgoaler_url) = resolve_ntvs_hesgoaler_player_url(trimmed) {
        return Some(hesgoaler_url);
    }

    if let Ok(url) = Url::parse(trimmed) {
        if let Some(host) = url.host_str().map(|host| host.to_ascii_lowercase())
            && is_ntvs_host(&host)
            && let Some(hesgoaler_url) = resolve_ntvs_hesgoaler_player_url(&format!(
                "{}{}",
                url.path(),
                url.query()
                    .map(|query| format!("?{query}"))
                    .unwrap_or_default()
            ))
        {
            return Some(hesgoaler_url);
        }
        if is_supported_ntvs_wrapper_embed_url(&url)
            || is_supported_ntvs_embed_url(&url)
            || is_supported_ntvs_hesgoaler_player_url(&url)
        {
            return Some(url);
        }
    }

    resolve_html_url(base_url, trimmed)
}

fn resolve_ntvs_hesgoaler_player_url(value: &str) -> Option<Url> {
    let trimmed = value.trim();
    let (path, query) = trimmed.split_once('?').unwrap_or((trimmed, ""));
    if !path.eq_ignore_ascii_case("/stream.php") {
        return None;
    }
    let channel = query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key.eq_ignore_ascii_case("ch") && !value.trim().is_empty()).then_some(value.trim())
    })?;
    let mut url = Url::parse("https://hesgoaler.com/stream.php").ok()?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.clear();
        query_pairs.append_pair("ch", channel);
    }
    Some(url)
}

fn normalize_ntvs_fetch_url(url: &Url) -> Url {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let normalized_host = match host.as_str() {
        "ntv.cx" => Some("ntvs.cx"),
        "www.ntv.cx" => Some("www.ntvs.cx"),
        _ => None,
    };
    let Some(normalized_host) = normalized_host else {
        return url.clone();
    };

    let mut normalized = url.clone();
    if normalized.set_host(Some(normalized_host)).is_err() {
        return url.clone();
    }
    normalized
}

fn ntvs_referer_for_url(_url: &Url) -> String {
    NTVS_REFERER.to_owned()
}

fn is_streamed_stream_api_url(url: &Url) -> bool {
    matches!(
        url.host_str().unwrap_or_default(),
        "streamed.pk" | "www.streamed.pk"
    ) && url.path().starts_with("/api/stream/")
}

fn is_streamed_watch_url(url: &Url) -> bool {
    matches!(
        url.host_str().unwrap_or_default(),
        "streamed.pk" | "www.streamed.pk"
    ) && url.path().starts_with("/watch/")
}

fn is_supported_streamed_stream_url(url: &Url) -> bool {
    is_streamed_stream_api_url(url) || is_streamed_watch_url(url)
}

fn is_supported_streamed_embed_url(url: &Url) -> bool {
    (url.scheme() == "https" || url.scheme() == "http")
        && matches!(
            url.host_str().unwrap_or_default(),
            "embedsports.top" | "www.embedsports.top"
        )
        && url.path().starts_with("/embed/")
}

fn is_supported_streamed_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    (host == "strmd.top" || host.ends_with(".strmd.top"))
        && url.path().to_ascii_lowercase().ends_with(".m3u8")
}

fn is_supported_sports_stream_url(url: &Url) -> bool {
    is_supported_streamed_stream_url(url)
        || is_supported_matchstream_stream_url(url)
        || is_supported_ntvs_stream_url(url)
        || is_supported_cdnlivetv_stream_url(url)
}

fn sports_stream_provider_id(url: &Url) -> Option<&'static str> {
    if is_supported_streamed_stream_url(url) {
        return Some(STREAMED_SOURCE_ID);
    }
    if is_supported_matchstream_stream_url(url) {
        return Some(MATCHSTREAM_SOURCE_ID);
    }
    if is_supported_ntvs_stream_url(url) {
        return Some(NTVS_SOURCE_ID);
    }
    if is_supported_cdnlivetv_stream_url(url) {
        return Some(CDNLIVETV_SOURCE_ID);
    }
    None
}

fn is_supported_ntvs_stream_url(url: &Url) -> bool {
    is_supported_ntvs_watch_url(url)
        || is_supported_ntvs_channel_url(url)
        || is_supported_ntvs_wrapper_embed_url(url)
        || is_supported_ntvs_embed_url(url)
        || is_supported_ntvs_hesgoaler_player_url(url)
}

fn is_supported_ntvs_watch_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    is_ntvs_host(&host) && url.path().starts_with("/watch/")
}

fn is_supported_ntvs_channel_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path();
    is_ntvs_host(&host)
        && (path
            .strip_prefix("/channel-hesgoales/")
            .is_some_and(|slug| !slug.is_empty())
            || path
                .strip_prefix("/channel-cdnlive/")
                .is_some_and(|slug| !slug.is_empty()))
}

fn is_supported_ntvs_wrapper_embed_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    is_ntvs_host(&host)
        && url.path() == "/embed"
        && url
            .query_pairs()
            .any(|(key, value)| key == "t" && !value.trim().is_empty())
}

fn is_ntvs_host(host: &str) -> bool {
    matches!(host, "ntv.cx" | "www.ntv.cx" | "ntvs.cx" | "www.ntvs.cx")
}

fn is_supported_ntvs_embed_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    matches!(host.as_str(), "embed.st" | "www.embed.st") && url.path().starts_with("/embed/")
}

fn live_iframe_playback_source(url: &Url) -> String {
    format!(
        "live-iframe:{}",
        byte_serialize(url.as_str().as_bytes()).collect::<String>()
    )
}

fn is_supported_ntvs_hesgoaler_player_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    (host == "hesgoaler.com" || host.ends_with(".hesgoaler.com"))
        && url.path().starts_with("/stream.php")
}

fn is_supported_ntvs_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    (host == "strmd.st" || host.ends_with(".strmd.st") || host.ends_with(".lovetier.bz"))
        && url.path().to_ascii_lowercase().ends_with(".m3u8")
}

fn is_supported_matchstream_stream_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !is_matchstream_channel_host(&host) || url.path().trim_start_matches('/') != "ch" {
        return false;
    }
    url.query_pairs()
        .any(|(key, value)| key == "id" && !value.trim().is_empty())
}

fn is_matchstream_channel_host(host: &str) -> bool {
    if matches!(
        host,
        "glisco.link" | "evfancy.link" | "strongst.link" | "l2l2.link"
    ) {
        return true;
    }

    let parts = host.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return false;
    }

    let channel_shard = parts[0];
    let provider = parts[1];
    let tld = parts[2];
    channel_shard.len() > 1
        && channel_shard.starts_with('s')
        && channel_shard[1..].chars().all(|ch| ch.is_ascii_digit())
        && !provider.is_empty()
        && provider
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        && (2..=24).contains(&tld.len())
        && tld.chars().all(|ch| ch.is_ascii_lowercase())
}

fn is_supported_matchstream_player_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    if is_supported_matchstream_stream_url(url) {
        return true;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    match host.as_str() {
        "brightcoremind.com" | "www.brightcoremind.com" => {
            matches!(url.path(), "/embedb.php" | "/embedw.php")
        }
        host if is_matchstream_embed_player_host(host) => url.path().starts_with("/e/"),
        _ => false,
    }
}

fn is_matchstream_embed_player_host(host: &str) -> bool {
    matches!(
        host,
        "adexchangerapid.com"
            | "www.adexchangerapid.com"
            | "dohaunting.com"
            | "www.dohaunting.com"
            | "helpless.click"
            | "www.helpless.click"
            | "jnbhi.com"
            | "www.jnbhi.com"
            | "lineagest.click"
            | "www.lineagest.click"
            | "mxbrbviqikqaw.com"
            | "www.mxbrbviqikqaw.com"
    )
}

fn is_supported_matchstream_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let supported_host = host == "zohanayaan.com"
        || host.ends_with(".zohanayaan.com")
        || host == "28585519.net"
        || host.ends_with(".28585519.net");
    supported_host && url.path().to_ascii_lowercase().ends_with(".m3u8")
}

fn normalize_matchstream_link(link: &str) -> Option<String> {
    let mut url = Url::parse(link.trim()).ok()?;
    normalize_matchstream_channel_url_path(&mut url);
    is_supported_matchstream_stream_url(&url).then(|| url.to_string())
}

fn normalize_matchstream_duration_minutes(duration: i64) -> i64 {
    if duration > 0 {
        duration
    } else {
        MATCHSTREAM_DEFAULT_DURATION_MINUTES
    }
}

fn matchstream_match_title(match_item: &MatchstreamMatch, default_sport_name: &str) -> String {
    let match_str = match_item.match_str.trim();
    if !match_str.is_empty() {
        return match_str.to_owned();
    }

    let team1 = match_item.team1.trim();
    let team2 = match_item.team2.trim();
    if !team1.is_empty() && !team2.is_empty() {
        return format!("{team1} vs {team2}");
    }
    if !team1.is_empty() {
        return team1.to_owned();
    }

    let match_text = match_item.match_text.trim();
    if !match_text.is_empty() {
        return match_text.to_owned();
    }

    format!("{default_sport_name} match")
}

fn matchstream_match_link_count(match_item: &MatchstreamMatch) -> usize {
    match_item
        .channels
        .iter()
        .map(|channel| {
            channel
                .links
                .iter()
                .filter(|link| normalize_matchstream_link(link).is_some())
                .count()
        })
        .sum()
}

fn normalize_streamed_sport_match(
    match_item: StreamedMatch,
    default_sport_name: &'static str,
) -> serde_json::Value {
    let title = match_item.title.trim().to_owned();
    let team1 = match_item
        .teams
        .home
        .as_ref()
        .map(|team| team.name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
        .to_owned();
    let team2 = match_item
        .teams
        .away
        .as_ref()
        .map(|team| team.name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
        .to_owned();
    let sport = if match_item.category.trim().is_empty() {
        default_sport_name.to_owned()
    } else {
        title_case_ascii(match_item.category.trim())
    };
    let mut indexed_sources = match_item
        .sources
        .iter()
        .enumerate()
        .filter_map(|(index, source)| {
            let source_name = source.source.trim();
            let source_url = streamed_source_stream_api_url(source)?;
            Some((
                sports_embed_source_priority(source_name),
                index,
                source,
                source_url,
            ))
        })
        .collect::<Vec<_>>();
    indexed_sources.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let mut streams = Vec::new();
    let mut channels = Vec::new();
    let mut languages = BTreeSet::new();
    for (_, index, source, source_url) in indexed_sources {
        let source_name = source.source.trim();
        let mut direct_rows = source
            .expanded_streams
            .iter()
            .filter_map(|stream| {
                let url = Url::parse(stream.embed_url.trim()).ok()?;
                is_supported_ntvs_embed_url(&url).then_some((stream, url))
            })
            .collect::<Vec<_>>();
        direct_rows.sort_by_key(|(stream, _)| stream.stream_no);

        for (stream, url) in &direct_rows {
            let row_source = stream.source.trim();
            let row_source = if row_source.is_empty() {
                source_name
            } else {
                row_source
            };
            let language_parts = stream
                .language
                .split(" - ")
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            let language = language_parts.first().copied().unwrap_or("Unknown");
            let mut label_parts = vec!["NTV Kobra".to_owned(), row_source.to_ascii_uppercase()];
            label_parts.extend(language_parts.iter().map(|part| (*part).to_owned()));
            label_parts.push(format!("Stream {}", stream.stream_no));
            let label = label_parts.join(" · ");
            let quality = if stream.hd { "HD" } else { "SD" };
            let playback_source = live_iframe_playback_source(url);
            languages.insert(language.to_owned());
            streams.push(json!({
                "id": format!("ntvs-{}-{}", row_source.to_ascii_lowercase(), stream.stream_no),
                "label": label,
                "source": playback_source,
                "provider": NTVS_SOURCE_ID,
                "playbackType": "iframe",
                "quality": quality
            }));
            channels.push(json!({
                "name": label,
                "language": language,
                "linkCount": 1
            }));
        }

        // A failed probe leaves no rows; a mixed response may contain embed
        // hosts that are only safe behind Streamed's group resolver. Preserve
        // that coarse endpoint whenever exact direct rows are unavailable or
        // could not represent the complete response.
        if direct_rows.is_empty() || direct_rows.len() != source.expanded_streams.len() {
            let display_source = title_case_ascii(source_name);
            let label = format!("Streamed {display_source}");
            streams.push(json!({
                "id": format!("streamed-{source_name}-{index}"),
                "label": label,
                "source": source_url,
                "provider": STREAMED_SOURCE_ID,
                "playbackType": "hls",
                "quality": "HD"
            }));
            channels.push(json!({
                "name": label,
                "language": "HD",
                "linkCount": 1
            }));
            languages.insert("HD".to_owned());
        }
    }
    let ends_at_timestamp = match_item
        .date
        .saturating_add(STREAMED_DEFAULT_DURATION_MINUTES.saturating_mul(60_000));

    json!({
        "id": format!("streamed-{}", match_item.id),
        "title": title,
        "matchText": title,
        "sourceDisplayTime": "",
        "league": "Streamed",
        "sport": sport,
        "team1": team1,
        "team2": team2,
        "primaryChannel": "Streamed",
        "important": match_item.popular,
        "sourceMatchDate": "",
        "startTimestamp": match_item.date,
        "endsAtTimestamp": ends_at_timestamp,
        "durationMinutes": STREAMED_DEFAULT_DURATION_MINUTES,
        "linkCount": streams.len(),
        "channelCount": channels.len(),
        "channels": channels,
        "streams": streams,
        "languages": languages.into_iter().collect::<Vec<_>>(),
        "provider": "streamed"
    })
}

fn streamed_source_stream_api_url(source: &StreamedSource) -> Option<String> {
    let source_name = source.source.trim();
    let source_id = source.id.trim();
    if source_name.is_empty() || source_id.is_empty() {
        return None;
    }
    Some(format!(
        "https://streamed.pk/api/stream/{source_name}/{source_id}"
    ))
}

fn normalize_matchstream_sport_match(
    match_item: MatchstreamMatch,
    default_sport_name: &'static str,
) -> serde_json::Value {
    let title = matchstream_match_title(&match_item, default_sport_name);
    let sport = if match_item.sport.trim().is_empty() {
        default_sport_name.to_owned()
    } else {
        match_item.sport.trim().to_owned()
    };
    let league = if match_item.league.trim().is_empty() {
        "MatchStream".to_owned()
    } else {
        match_item.league.trim().to_owned()
    };
    let duration_minutes = normalize_matchstream_duration_minutes(match_item.duration);
    let ends_at_timestamp = match_item
        .start_timestamp
        .saturating_add(duration_minutes.saturating_mul(60_000));
    let mut streams = Vec::new();
    let mut channels = Vec::new();
    let mut languages = BTreeSet::new();

    for (channel_index, channel) in match_item.channels.iter().enumerate() {
        let links = channel
            .links
            .iter()
            .filter_map(|link| normalize_matchstream_link(link))
            .collect::<Vec<_>>();
        if links.is_empty() {
            continue;
        }

        let channel_name = if channel.name.trim().is_empty() {
            format!("Channel {}", channel.number.max((channel_index + 1) as i64))
        } else {
            channel.name.trim().to_owned()
        };
        let language = channel
            .language
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Live")
            .to_owned();
        languages.insert(language.clone());
        channels.push(json!({
            "name": format!("MatchStream {channel_name}"),
            "language": language,
            "linkCount": links.len()
        }));

        for (link_index, source_url) in links.into_iter().enumerate() {
            let link_label = if channel.links.len() > 1 {
                format!("MatchStream {channel_name} #{}", link_index + 1)
            } else {
                format!("MatchStream {channel_name}")
            };
            streams.push(json!({
                "id": format!("matchstream-{channel_index}-{link_index}"),
                "label": link_label,
                "source": source_url,
                "provider": MATCHSTREAM_SOURCE_ID,
                "playbackType": "hls",
                "quality": language
            }));
        }
    }

    let primary_channel = if match_item.channel.trim().is_empty() {
        "MatchStream".to_owned()
    } else {
        match_item.channel.trim().to_owned()
    };
    let id = if match_item.slug.trim().is_empty() {
        format!(
            "matchstream-{}",
            title_case_ascii(&title).replace(' ', "-").to_lowercase()
        )
    } else {
        format!("matchstream-{}", match_item.slug.trim())
    };

    json!({
        "id": id,
        "title": title,
        "matchText": match_item.match_text.trim(),
        "sourceDisplayTime": "",
        "league": league,
        "sport": sport,
        "team1": match_item.team1.trim(),
        "team2": match_item.team2.trim(),
        "primaryChannel": primary_channel,
        "important": match_item.important,
        "sourceMatchDate": match_item.match_date.trim(),
        "startTimestamp": match_item.start_timestamp,
        "endsAtTimestamp": ends_at_timestamp,
        "durationMinutes": duration_minutes,
        "linkCount": streams.len(),
        "channelCount": channels.len(),
        "channels": channels,
        "streams": streams,
        "languages": languages.into_iter().collect::<Vec<_>>(),
        "provider": MATCHSTREAM_SOURCE_ID
    })
}

fn ntvs_category_matches(category: &str, default_sport_name: &str) -> bool {
    category.trim().is_empty() || category.trim().eq_ignore_ascii_case(default_sport_name)
}

fn ntvs_match_is_live(match_item: &NtvsMatch, default_sport_name: &str, now: i64) -> bool {
    match_item.date > 0
        && match_item.date <= now
        && ntvs_category_matches(match_item.category.trim(), default_sport_name)
        && ntvs_match_link_count(match_item) > 0
        && match_item
            .date
            .saturating_add(NTVS_DEFAULT_DURATION_MINUTES.saturating_mul(60_000))
            > now
}

fn ntvs_match_link_count(match_item: &NtvsMatch) -> usize {
    if !match_item.expanded_streams.is_empty() {
        return match_item.expanded_streams.len();
    }
    match_item
        .sources
        .iter()
        .filter(|source| streamed_source_stream_api_url(source).is_some())
        .count()
}

fn ntvs_watch_page_url(match_id: &str) -> Option<String> {
    let match_id = match_id.trim();
    if match_id.is_empty() {
        return None;
    }
    Some(format!(
        "https://ntv.cx/watch/{NTVS_DEFAULT_SERVER}/{match_id}"
    ))
}

fn sports_embed_source_priority(source_name: &str) -> u8 {
    match source_name.trim().to_ascii_lowercase().as_str() {
        "admin" => 0,
        "echo" => 1,
        "delta" => 2,
        _ => 3,
    }
}

fn normalize_ntvs_sport_match(
    match_item: NtvsMatch,
    default_sport_name: &'static str,
) -> serde_json::Value {
    let title = match_item.title.trim().to_owned();
    let team1 = match_item
        .teams
        .home
        .as_ref()
        .map(|team| team.name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
        .to_owned();
    let team2 = match_item
        .teams
        .away
        .as_ref()
        .map(|team| team.name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
        .to_owned();
    let sport = if match_item.category.trim().is_empty() {
        default_sport_name.to_owned()
    } else {
        title_case_ascii(match_item.category.trim())
    };
    let mut streams = Vec::new();
    let mut channels = Vec::new();
    let mut languages = BTreeSet::new();

    if !match_item.expanded_streams.is_empty() {
        // These are the exact numbered feeds shown by ntv.cx's Kobra selector.
        // Play them in the browser-native iframe mode used by the source site:
        // embed.st's HLS token is bound to the browser session that minted it,
        // so resolving it in a separate backend browser produces a 403 later.
        for stream in &match_item.expanded_streams {
            let Ok(embed_url) = Url::parse(stream.embed_url.trim()) else {
                continue;
            };
            if !is_supported_ntvs_wrapper_embed_url(&embed_url)
                && !is_supported_ntvs_embed_url(&embed_url)
            {
                continue;
            }
            let source_name = stream.source.trim();
            let source_id = source_name.to_ascii_lowercase();
            let display_source = source_name.to_ascii_uppercase();
            let language_parts = stream
                .language
                .split(" - ")
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            let language = language_parts.first().copied().unwrap_or("Unknown");
            let mut label_parts = vec!["NTV Kobra".to_owned()];
            if !display_source.is_empty() {
                label_parts.push(display_source);
            }
            label_parts.extend(language_parts.iter().map(|part| (*part).to_owned()));
            label_parts.push(format!("Stream {}", stream.stream_no));
            let label = label_parts.join(" · ");
            let quality = if stream.hd { "HD" } else { "SD" };
            let playback_source = live_iframe_playback_source(&embed_url);
            languages.insert(language.to_owned());
            streams.push(json!({
                "id": format!("ntvs-{source_id}-{}", stream.stream_no),
                "label": label,
                "source": playback_source,
                "provider": NTVS_SOURCE_ID,
                "playbackType": "iframe",
                "quality": quality
            }));
            channels.push(json!({
                "name": label,
                "language": language,
                "linkCount": 1
            }));
        }
    } else {
        // Best-effort expansion can time out without removing the fixture. In
        // that case retain the coarse source-group URLs so playback still has
        // the same resilient fallback path it had before this enrichment.
        let mut indexed_sources = match_item
            .sources
            .iter()
            .enumerate()
            .filter_map(|(index, source)| {
                let source_url = streamed_source_stream_api_url(source)?;
                let source_name = source.source.trim();
                Some((
                    sports_embed_source_priority(source_name),
                    index,
                    source,
                    source_url,
                ))
            })
            .collect::<Vec<_>>();
        indexed_sources
            .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

        for (index, source, source_url) in indexed_sources
            .into_iter()
            .map(|(_, index, source, source_url)| (index, source, source_url))
        {
            let source_name = source.source.trim();
            let display_source = title_case_ascii(source_name);
            let label = format!("NTVS {display_source}");
            streams.push(json!({
                "id": format!("ntvs-{source_name}-{index}"),
                "label": label,
                "source": source_url,
                "provider": NTVS_SOURCE_ID,
                "playbackType": "hls",
                "quality": "HD"
            }));
            channels.push(json!({
                "name": label,
                "language": "HD",
                "linkCount": 1
            }));
        }
        languages.insert("HD".to_owned());
    }

    // Keep ntv.cx's own "Kobra" watch page as a last-resort fallback *after* the
    // numbered embed sources. It resolves via ntv.cx directly (so it still works
    // when streamed.pk is unreachable) and refreshes the live option set, but must
    // never be the default: the mobile picker plays streams[0] and the web picker
    // sorts /watch/ pages last.
    let primary_channel = channels
        .first()
        .and_then(|channel| channel.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| "NTVS Kobra".to_owned());
    if let Some(watch_page_url) = ntvs_watch_page_url(match_item.id.trim()) {
        streams.push(json!({
            "id": "ntvs-watch-page",
            "label": "NTVS Kobra",
            "source": watch_page_url,
            "provider": NTVS_SOURCE_ID,
            "playbackType": "hls",
            "quality": "HD"
        }));
        channels.push(json!({
            "name": "NTVS Kobra",
            "language": "Auto",
            "linkCount": 1
        }));
    }

    let ends_at_timestamp = match_item
        .date
        .saturating_add(NTVS_DEFAULT_DURATION_MINUTES.saturating_mul(60_000));

    json!({
        "id": format!("ntvs-{}", match_item.id.trim()),
        "title": title,
        "matchText": title,
        "sourceDisplayTime": "",
        "league": "NTVS",
        "sport": sport,
        "team1": team1,
        "team2": team2,
        "primaryChannel": primary_channel,
        "important": match_item.popular,
        "sourceMatchDate": "",
        "startTimestamp": match_item.date,
        "endsAtTimestamp": ends_at_timestamp,
        "durationMinutes": NTVS_DEFAULT_DURATION_MINUTES,
        "linkCount": streams.len(),
        "channelCount": channels.len(),
        "channels": channels,
        "streams": streams,
        "languages": languages.into_iter().collect::<Vec<_>>(),
        "provider": NTVS_SOURCE_ID
    })
}

fn title_case_ascii(value: &str) -> String {
    value
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            let mut word = first.to_ascii_uppercase().to_string();
            word.extend(chars.map(|ch| ch.to_ascii_lowercase()));
            word
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{
        CDNLIVETV_MAX_CHANNELS_PER_MATCH, CDNLIVETV_SOURCE_ID,
        build_cdnlivetv_sport_matches_payload, cdnlivetv_channel_quality_label,
        cdnlivetv_channel_score, curate_cdnlivetv_channels, is_supported_cdnlivetv_hls_url,
        is_supported_cdnlivetv_stream_url, parse_cdnlivetv_start_ms, unix_days_from_civil,
    };
    use super::{
        MATCHSTREAM_WEBMASTER_URL, MatchstreamChannel, MatchstreamMatch, NTVS_SOURCE_ID, NtvsMatch,
        SPORTS_SCHEDULE_FUTURE_CACHE_TTL_MS, SPORTS_SCHEDULE_STALE_IF_ERROR_MS,
        SPORTS_STREAM_RESOLVE_CACHE_TTL_MS, SPORTS_STREAM_RESOLVE_FAILURE_TTL_MS,
        STREAMED_FOOTBALL_MATCHES_URL, STREAMED_SOURCE_ID, SportsScheduleCache,
        SportsScheduleSource, SportsStreamResolveCache, StreamedEmbedStream, StreamedMatch,
        StreamedSource, StreamedTeam, StreamedTeams, add_ntvs_linked_source_overrides,
        build_matchstream_football_matches_payload, build_ntvs_football_matches_payload,
        build_streamed_football_matches_payload, extract_matchstream_matches,
        extract_ntvs_candidate_urls, extract_ntvs_watch_page_sources,
        extract_streamed_watch_embed_streams, filter_marquee_football_schedule,
        is_marquee_football_competition, is_streamed_watch_url, is_supported_matchstream_hls_url,
        is_supported_matchstream_player_url, is_supported_matchstream_stream_url,
        is_supported_ntvs_channel_url, is_supported_ntvs_embed_url,
        is_supported_ntvs_hesgoaler_player_url, is_supported_ntvs_hls_url,
        is_supported_ntvs_stream_url, is_supported_ntvs_watch_url,
        is_supported_ntvs_wrapper_embed_url, is_supported_streamed_hls_url,
        is_supported_streamed_stream_url, live_stream_source_candidates,
        matchstream_live_stream_source_candidates, merge_sports_schedule_payloads,
        normalize_espn_football_match, normalize_matchstream_link, normalize_ntvs_fetch_url,
        normalize_sports_schedule_name, parse_espn_start_ms, parse_fallback_stream_urls,
        parse_ntvs_hesgoaler_player_source, remove_streamed_sources_by_index,
        resolve_ntvs_candidate_url, sports_live_stream_source_candidates,
        sports_schedule_array_identity, sports_schedule_fresh_ttl_ms, sports_stream_provider_id,
        sports_stream_resolve_cache_key, streamed_match_is_live, streamed_source_stream_api_url,
    };
    use crate::utils::now_ms;
    use serde_json::json;
    use url::Url;

    fn sample_streamed_match(sources: Vec<StreamedSource>) -> StreamedMatch {
        StreamedMatch {
            id: "morocco-vs-madagascar-football-1545264".to_owned(),
            title: "Morocco vs Madagascar".to_owned(),
            category: "football".to_owned(),
            date: now_ms().saturating_sub(60_000),
            popular: false,
            teams: StreamedTeams {
                home: Some(StreamedTeam {
                    name: "Morocco".to_owned(),
                }),
                away: Some(StreamedTeam {
                    name: "Madagascar".to_owned(),
                }),
            },
            sources,
        }
    }

    #[test]
    fn sports_schedule_source_defaults_to_auto() {
        assert_eq!(
            SportsScheduleSource::from_query(None).unwrap(),
            SportsScheduleSource::Auto
        );
        assert_eq!(
            SportsScheduleSource::from_query(Some("")).unwrap(),
            SportsScheduleSource::Auto
        );
        assert_eq!(
            SportsScheduleSource::from_query(Some("auto")).unwrap(),
            SportsScheduleSource::Auto
        );
        assert_eq!(
            SportsScheduleSource::from_query(Some("matchstream")).unwrap(),
            SportsScheduleSource::Matchstream
        );
        assert_eq!(
            SportsScheduleSource::from_query(Some("ntvs")).unwrap(),
            SportsScheduleSource::Ntvs
        );
        assert_eq!(
            SportsScheduleSource::from_query(Some("espn")).unwrap(),
            SportsScheduleSource::Espn
        );
    }

    #[test]
    fn normalizes_espn_scoreboard_fixture_without_playback_sources() {
        let start = parse_espn_start_ms("2026-07-11T21:00Z").unwrap();
        let event = json!({
            "id": "760512",
            "date": "2026-07-11T21:00Z",
            "competitions": [{
                "altGameNote": "FIFA World Cup, Quarterfinals",
                "competitors": [
                    {"homeAway": "home", "team": {"displayName": "Norway"}},
                    {"homeAway": "away", "team": {"displayName": "England"}}
                ]
            }]
        });

        let normalized = normalize_espn_football_match(&event, start - 1).unwrap();
        assert_eq!(normalized["id"], "espn-760512");
        assert_eq!(normalized["title"], "Norway vs England");
        assert_eq!(normalized["league"], "FIFA World Cup, Quarterfinals");
        assert_eq!(normalized["startTimestamp"], start);
        assert_eq!(normalized["provider"], "espn");
        assert_eq!(normalized["important"], true);
        assert_eq!(normalized["linkCount"], 0);
        assert!(normalized["streams"].as_array().unwrap().is_empty());
    }

    #[test]
    fn marquee_football_competitions_exclude_similarly_named_smaller_leagues() {
        for league in [
            "English Premier League",
            "LALIGA",
            "Bundesliga",
            "Serie A",
            "Ligue 1",
            "UEFA Champions League, Quarterfinals",
            "FIFA World Cup, Quarterfinals",
            "English FA Cup, Final",
        ] {
            assert!(
                is_marquee_football_competition(league),
                "expected {league:?} to be included"
            );
        }

        for league in [
            "LALIGA 2",
            "2. Bundesliga",
            "Brazil Serie A",
            "Northern Premier League",
            "AFC Champions League Elite",
            "FIFA U-17 World Cup, Final",
            "Scottish League Cup, Group A",
            "Club Friendly",
        ] {
            assert!(
                !is_marquee_football_competition(league),
                "expected {league:?} to be excluded"
            );
        }
    }

    #[test]
    fn football_schedule_keeps_only_matches_in_marquee_competitions() {
        let payload = json!({
            "sport": "Football",
            "matches": [
                {
                    "id": "premier-league",
                    "league": "English Premier League",
                    "important": false
                },
                {
                    "id": "league-two",
                    "league": "England League Two",
                    "important": true
                },
                {
                    "id": "friendly",
                    "league": "Club Friendly",
                    "important": true
                }
            ]
        });

        let filtered = filter_marquee_football_schedule(payload);
        let matches = filtered["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["id"], "premier-league");
    }

    #[test]
    fn combined_schedule_keeps_espn_fixture_and_attaches_stream_provider() {
        let start = 1_800_000_000_000i64;
        let espn = json!({
            "sourceProvider": "espn",
            "fetchedAt": 100,
            "matches": [{
                "id": "espn-1",
                "title": "Manchester United vs Liverpool",
                "league": "English Premier League",
                "sport": "Football",
                "team1": "Manchester United",
                "team2": "Liverpool FC",
                "startTimestamp": start,
                "endsAtTimestamp": start + 10_800_000,
                "important": true,
                "linkCount": 0,
                "channelCount": 0,
                "channels": [],
                "streams": [],
                "languages": [],
                "provider": "espn",
                "providers": ["espn"]
            }]
        });
        let streamed = json!({
            "sourceProvider": "streamed",
            "fetchedAt": 200,
            "matches": [{
                "id": "streamed-1",
                "title": "Liverpool vs Man Utd",
                "league": "Streamed",
                "sport": "Football",
                "team1": "Liverpool",
                "team2": "Manchester Utd",
                "startTimestamp": start + 30 * 60_000,
                "endsAtTimestamp": start + 11_000_000,
                "important": false,
                "linkCount": 1,
                "channelCount": 1,
                "channels": [{"name": "Streamed HD"}],
                "streams": [{
                    "id": "streamed-admin-1",
                    "label": "Streamed Admin",
                    "source": "https://streamed.pk/api/stream/admin/1",
                    "provider": "streamed",
                    "playbackType": "hls",
                    "quality": "HD"
                }],
                "languages": ["HD"],
                "provider": "streamed"
            }]
        });

        let combined = merge_sports_schedule_payloads(vec![espn, streamed], "Football");
        let matches = combined["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["id"], "espn-1");
        assert_eq!(matches[0]["league"], "English Premier League");
        assert_eq!(matches[0]["provider"], "auto");
        assert_eq!(matches[0]["linkCount"], 1);
        assert_eq!(matches[0]["streams"][0]["provider"], "streamed");
        assert_eq!(combined["sourceProvider"], "auto");
        assert_eq!(combined["fetchedAt"], 200);
    }

    #[test]
    fn combined_schedule_deduplicates_ntv_wrapper_and_canonical_rows() {
        let start = 1_784_055_600_000i64;
        let canonical = json!({
            "sourceProvider": "streamed",
            "fetchedAt": 100,
            "matches": [{
                "id": "streamed-france-spain",
                "title": "France vs Spain",
                "sport": "Football",
                "team1": "France",
                "team2": "Spain",
                "startTimestamp": start,
                "endsAtTimestamp": start + 10_800_000,
                "linkCount": 1,
                "channelCount": 1,
                "channels": [],
                "streams": [{
                    "id": "ntvs-admin-1",
                    "label": "NTV Kobra · ADMIN · English · TSN · Stream 1",
                    "source": "live-iframe:https%3A%2F%2Fembed.st%2Fembed%2Fadmin%2Fppv-france-vs-spain%2F1",
                    "provider": "ntvs",
                    "playbackType": "iframe",
                    "quality": "HD"
                }],
                "languages": ["English"],
                "provider": "streamed"
            }]
        });
        let wrapper = json!({
            "sourceProvider": "ntvs",
            "fetchedAt": 200,
            "matches": [{
                "id": "ntvs-france-spain",
                "title": "France vs Spain",
                "sport": "Football",
                "team1": "France",
                "team2": "Spain",
                "startTimestamp": start,
                "endsAtTimestamp": start + 10_800_000,
                "linkCount": 1,
                "channelCount": 1,
                "channels": [],
                "streams": [{
                    "id": "ntvs-admin-1",
                    "label": "NTV Kobra · ADMIN · English · TSN · Stream 1",
                    "source": "live-iframe:https%3A%2F%2Fntv.cx%2Fembed%3Ft%3DOpaqueWrapperToken",
                    "provider": "ntvs",
                    "playbackType": "iframe",
                    "quality": "HD"
                }],
                "languages": ["English"],
                "provider": "ntvs"
            }]
        });

        let combined = merge_sports_schedule_payloads(vec![canonical, wrapper], "Football");
        let streams = combined["matches"][0]["streams"].as_array().unwrap();

        assert_eq!(streams.len(), 1);
        assert_eq!(
            streams[0]["source"],
            "live-iframe:https%3A%2F%2Fembed.st%2Fembed%2Fadmin%2Fppv-france-vs-spain%2F1"
        );
    }

    #[test]
    fn schedule_team_names_ignore_common_club_prefixes_and_suffixes() {
        assert_eq!(
            normalize_sports_schedule_name("Mjällby AIF"),
            normalize_sports_schedule_name("Mjällby")
        );
        assert_eq!(
            normalize_sports_schedule_name("Örgryte IS"),
            normalize_sports_schedule_name("Örgryte")
        );
        assert_eq!(
            normalize_sports_schedule_name("BK Häcken"),
            normalize_sports_schedule_name("Häcken")
        );
        assert_eq!(
            normalize_sports_schedule_name("Manta F.C."),
            normalize_sports_schedule_name("Manta")
        );
    }

    #[test]
    fn parses_live_stream_fallback_urls_from_json() {
        let urls = parse_fallback_stream_urls(Some(
            r#"["https://streamed.pk/api/stream/admin/a","https://streamed.pk/api/stream/echo/a"]"#,
        ))
        .unwrap();

        assert_eq!(
            urls,
            vec![
                "https://streamed.pk/api/stream/admin/a".to_owned(),
                "https://streamed.pk/api/stream/echo/a".to_owned(),
            ]
        );
    }

    #[test]
    fn builds_unique_limited_live_stream_candidates() {
        let fallback_urls = [
            "https://streamed.pk/api/stream/admin/a",
            "https://streamed.pk/api/stream/echo/a",
            "bad-url",
            "https://glisco.link/ch?id=2",
            "https://streamed.pk/api/stream/alpha/a",
            "https://streamed.pk/api/stream/beta/a",
            "https://streamed.pk/api/stream/gamma/a",
            "https://streamed.pk/api/stream/delta/a",
        ]
        .join(",");

        let candidates = live_stream_source_candidates(
            "https://streamed.pk/api/stream/admin/a",
            Some(&fallback_urls),
        )
        .unwrap();

        assert_eq!(candidates.len(), 6);
        assert_eq!(
            candidates[0].as_str(),
            "https://streamed.pk/api/stream/admin/a"
        );
        assert_eq!(
            candidates[1].as_str(),
            "https://streamed.pk/api/stream/echo/a"
        );
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.host_str() == Some("streamed.pk"))
        );
    }

    #[test]
    fn rejects_non_streamed_primary_live_stream_candidates() {
        let error = live_stream_source_candidates("https://glisco.link/ch?id=1", None).unwrap_err();

        assert_eq!(
            error.message(),
            Some("Unsupported Streamed live stream URL.")
        );
    }

    #[test]
    fn accepts_streamed_hls_hosts_only() {
        let streamed_hls =
            url::Url::parse("https://lb12.strmd.top/secure/token/rtmp/stream/id/1/playlist.m3u8")
                .unwrap();
        let streamed_segment =
            url::Url::parse("https://lb12.strmd.top/secure/token/rtmp/stream/id/1/high/segment.ts")
                .unwrap();
        let other_hls = url::Url::parse("https://example.test/live/playlist.m3u8").unwrap();

        assert!(is_supported_streamed_hls_url(&streamed_hls));
        assert!(!is_supported_streamed_hls_url(&streamed_segment));
        assert!(!is_supported_streamed_hls_url(&other_hls));
    }

    #[test]
    fn removes_empty_streamed_sources_before_building_schedule_payload() {
        let mut source_matches = vec![sample_streamed_match(vec![
            StreamedSource {
                source: "echo".to_owned(),
                id: "morocco-vs-madagascar-football-1545264".to_owned(),
                expanded_streams: Vec::new(),
            },
            StreamedSource {
                source: "admin".to_owned(),
                id: "ppv-morocco-vs-madagascar".to_owned(),
                expanded_streams: Vec::new(),
            },
        ])];

        remove_streamed_sources_by_index(&mut source_matches, &[(0, 0)]);
        let (payload, _) = build_streamed_football_matches_payload(source_matches);

        assert_eq!(payload["matches"][0]["linkCount"], 1);
        assert_eq!(
            payload["matches"][0]["streams"][0]["source"],
            "https://streamed.pk/api/stream/admin/ppv-morocco-vs-madagascar"
        );
        assert_eq!(
            payload["matches"][0]["channels"][0]["name"],
            "Streamed Admin"
        );
    }

    #[test]
    fn omits_streamed_match_when_all_live_sources_are_empty() {
        let mut source_matches = vec![sample_streamed_match(vec![StreamedSource {
            source: "echo".to_owned(),
            id: "morocco-vs-madagascar-football-1545264".to_owned(),
            expanded_streams: Vec::new(),
        }])];

        remove_streamed_sources_by_index(&mut source_matches, &[(0, 0)]);
        let (payload, _) = build_streamed_football_matches_payload(source_matches);

        assert_eq!(payload["matches"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn recognizes_streamed_live_window_and_source_urls() {
        let now = now_ms();
        let live_match = sample_streamed_match(vec![StreamedSource {
            source: "echo".to_owned(),
            id: "morocco-vs-madagascar-football-1545264".to_owned(),
            expanded_streams: Vec::new(),
        }]);
        let future_match = StreamedMatch {
            date: now.saturating_add(60_000),
            ..sample_streamed_match(Vec::new())
        };

        assert!(streamed_match_is_live(&live_match, now));
        assert!(!streamed_match_is_live(&future_match, now));
        assert_eq!(
            streamed_source_stream_api_url(&live_match.sources[0]).as_deref(),
            Some("https://streamed.pk/api/stream/echo/morocco-vs-madagascar-football-1545264")
        );

        let watch =
            url::Url::parse("https://streamed.pk/watch/kosovo-vs-andorra-2472554/admin/1").unwrap();
        assert!(is_streamed_watch_url(&watch));
        assert!(is_supported_streamed_stream_url(&watch));
        assert_eq!(sports_stream_provider_id(&watch), Some(STREAMED_SOURCE_ID));
    }

    #[test]
    fn extracts_streamed_watch_embed_candidates_from_html() {
        let base =
            url::Url::parse("https://streamed.pk/watch/kosovo-vs-andorra-2472554/admin/1").unwrap();
        let html = r#"
            <iframe src="https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1"></iframe>
            <iframe src="https://embedsports.top/embed/admin/legacy-source/2"></iframe>
            <iframe src="https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1"></iframe>
            <iframe src="https://example.test/embed/admin/ppv-kosovo-vs-andorra/1"></iframe>
        "#;

        let streams = extract_streamed_watch_embed_streams(html, &base)
            .into_iter()
            .map(|stream| (stream.stream_no, stream.hd, stream.embed_url))
            .collect::<Vec<_>>();

        assert_eq!(
            streams,
            vec![
                (
                    1,
                    true,
                    "https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1".to_owned()
                ),
                (
                    2,
                    true,
                    "https://embedsports.top/embed/admin/legacy-source/2".to_owned()
                )
            ]
        );
    }

    #[test]
    fn builds_ntvs_payload_with_embed_sources() {
        let (payload, _) = build_ntvs_football_matches_payload(vec![NtvsMatch {
            id: "kosovo-vs-andorra-2472554".to_owned(),
            title: "Kosovo vs Andorra".to_owned(),
            category: "football".to_owned(),
            date: now_ms() + 60_000,
            popular: true,
            teams: StreamedTeams {
                home: Some(StreamedTeam {
                    name: "Kosovo".to_owned(),
                }),
                away: Some(StreamedTeam {
                    name: "Andorra".to_owned(),
                }),
            },
            sources: vec![
                StreamedSource {
                    source: "admin".to_owned(),
                    id: "ppv-kosovo-vs-andorra".to_owned(),
                    expanded_streams: Vec::new(),
                },
                StreamedSource {
                    source: "echo".to_owned(),
                    id: "kosovo-vs-andorra-football-1545036".to_owned(),
                    expanded_streams: Vec::new(),
                },
            ],
            expanded_streams: Vec::new(),
        }]);
        let matches = payload["matches"].as_array().unwrap();

        assert_eq!(payload["sourceProvider"], NTVS_SOURCE_ID);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["provider"], NTVS_SOURCE_ID);
        assert_eq!(matches[0]["league"], "NTVS");
        assert_eq!(matches[0]["linkCount"], 3);
        // HD embed sources come first (admin outranks echo via source priority),
        // resolved through the streamed /api/stream endpoint so the resolver can
        // pick the HD variant. primaryChannel tracks that top source.
        assert_eq!(matches[0]["primaryChannel"], "NTVS Admin");
        assert_eq!(
            matches[0]["streams"][0]["source"],
            "https://streamed.pk/api/stream/admin/ppv-kosovo-vs-andorra"
        );
        assert_eq!(
            matches[0]["streams"][1]["source"],
            "https://streamed.pk/api/stream/echo/kosovo-vs-andorra-football-1545036"
        );
        // ntv.cx's own Kobra watch page is demoted to a last-resort fallback.
        assert_eq!(
            matches[0]["streams"][2]["source"],
            "https://ntv.cx/watch/kobra/kosovo-vs-andorra-2472554"
        );
        assert_eq!(matches[0]["streams"][2]["label"], "NTVS Kobra");
    }

    #[test]
    fn builds_ntvs_payload_with_every_numbered_kobra_source() {
        let admin_rows = [
            (1, "English - TSN", true),
            (2, "English - TSN", false),
            (3, "English - FOX", true),
            (4, "English - FOX", false),
            (5, "English - ITV1", true),
            (6, "English - ITV1", false),
            (7, "Spanish - DAZN Spain", true),
            (8, "Spanish - DAZN Spain", false),
            (9, "Spanish - Telemundo", true),
            (10, "Spanish - Telemundo", false),
        ];
        let mut expanded_streams = admin_rows
            .into_iter()
            .map(|(stream_no, language, hd)| StreamedEmbedStream {
                stream_no,
                hd,
                embed_url: format!("https://embed.st/embed/admin/ppv-france-vs-spain/{stream_no}"),
                language: language.to_owned(),
                source: "admin".to_owned(),
            })
            .collect::<Vec<_>>();
        expanded_streams.extend((1..=6).map(|stream_no| StreamedEmbedStream {
            stream_no,
            hd: true,
            embed_url: format!(
                "https://embed.st/embed/delta/live-world-cup-france-spain/{stream_no}"
            ),
            language: "English".to_owned(),
            source: "delta".to_owned(),
        }));
        expanded_streams.extend((1..=2).map(|stream_no| StreamedEmbedStream {
            stream_no,
            hd: true,
            embed_url: format!("https://embed.st/embed/golf/23742/{stream_no}"),
            language: "English".to_owned(),
            source: "golf".to_owned(),
        }));

        let (payload, _) = build_ntvs_football_matches_payload(vec![NtvsMatch {
            id: "france-vs-spain-2528031".to_owned(),
            title: "France vs Spain".to_owned(),
            category: "football".to_owned(),
            date: now_ms() + 60_000,
            popular: true,
            teams: StreamedTeams {
                home: Some(StreamedTeam {
                    name: "France".to_owned(),
                }),
                away: Some(StreamedTeam {
                    name: "Spain".to_owned(),
                }),
            },
            sources: vec![StreamedSource {
                source: "admin".to_owned(),
                id: "ppv-france-vs-spain".to_owned(),
                expanded_streams: Vec::new(),
            }],
            expanded_streams,
        }]);
        let game = &payload["matches"][0];
        let streams = game["streams"].as_array().unwrap();

        assert_eq!(game["linkCount"], 19);
        assert_eq!(streams.len(), 19);
        assert_eq!(streams[0]["id"], "ntvs-admin-1");
        assert_eq!(
            streams[0]["label"],
            "NTV Kobra · ADMIN · English · TSN · Stream 1"
        );
        assert_eq!(streams[0]["quality"], "HD");
        assert_eq!(streams[0]["playbackType"], "iframe");
        assert_eq!(
            streams[0]["source"],
            "live-iframe:https%3A%2F%2Fembed.st%2Fembed%2Fadmin%2Fppv-france-vs-spain%2F1"
        );
        assert_eq!(streams[1]["quality"], "SD");
        assert_eq!(
            streams[6]["label"],
            "NTV Kobra · ADMIN · Spanish · DAZN Spain · Stream 7"
        );
        assert_eq!(streams[10]["id"], "ntvs-delta-1");
        assert_eq!(streams[16]["id"], "ntvs-golf-1");
        assert_eq!(streams[17]["id"], "ntvs-golf-2");
        assert_eq!(streams[18]["label"], "NTVS Kobra");
        assert_eq!(
            streams[18]["source"],
            "https://ntv.cx/watch/kobra/france-vs-spain-2528031"
        );
        assert_eq!(game["languages"], json!(["English", "Spanish"]));
    }

    #[test]
    fn extracts_every_source_from_the_ntvs_selector_only() {
        let mut options = String::new();
        let admin = [
            (1, "English - TSN", true),
            (2, "English - TSN", false),
            (3, "English - FOX", true),
            (4, "English - FOX", false),
            (5, "English - ITV1", true),
            (6, "English - ITV1", false),
            (7, "Spanish - DAZN Spain", true),
            (8, "Spanish - DAZN Spain", false),
            (9, "Spanish - Telemundo", true),
            (10, "Spanish - Telemundo", false),
        ];
        for (stream_no, language, hd) in admin {
            let quality = if hd { " [HD]" } else { "" };
            options.push_str(&format!(
                "<option value='/embed?t=Admin{stream_no}'>Server Kobra - ADMIN - {language} - Stream {stream_no}{quality}</option>"
            ));
        }
        for stream_no in 1..=6 {
            options.push_str(&format!(
                "<option value='/embed?t=Delta{stream_no}'>Server Kobra - DELTA - English - Stream {stream_no} [HD]</option>"
            ));
        }
        for stream_no in 1..=2 {
            options.push_str(&format!(
                "<option value='/embed?t=Golf{stream_no}'>Server Kobra - GOLF - English - Stream {stream_no} [HD]</option>"
            ));
        }
        options.push_str(
            "<option value='/embed?t=Admin1'>Duplicate</option>\
             <option value='https://example.test/embed?t=evil'>Off domain</option>",
        );
        let html = format!(
            "<select id='other'><option value='/embed?t=phantom'>Ignore</option></select>\
             <select class='server-picker' id='sourceSelect'>{options}</select>\
             <textarea><option value='/embed?t=textarea'>Ignore</option></textarea>"
        );
        let base = Url::parse("https://ntv.cx/watch/kobra/france-vs-spain-2528031").unwrap();
        let sources = extract_ntvs_watch_page_sources(&html, &base);

        assert_eq!(sources.len(), 18);
        assert_eq!(sources.iter().filter(|stream| stream.hd).count(), 13);
        assert_eq!(sources[0].source, "admin");
        assert_eq!(sources[0].language, "English - TSN");
        assert_eq!(sources[0].stream_no, 1);
        assert_eq!(sources[0].embed_url, "https://ntv.cx/embed?t=Admin1");
        assert_eq!(sources[9].language, "Spanish - Telemundo");
        assert_eq!(sources[10].source, "delta");
        assert_eq!(sources[16].source, "golf");
        assert_eq!(sources[17].stream_no, 2);
    }

    #[test]
    fn sports_source_identity_preserves_case_sensitive_tokens() {
        let upper_token = json!({"source": "https://NTV.cx/embed?t=AbC123"});
        let lower_token = json!({"source": "https://ntv.cx/embed?t=aBc123"});

        assert_eq!(
            sports_schedule_array_identity(&upper_token, "source"),
            "https://ntv.cx/embed?t=AbC123"
        );
        assert_ne!(
            sports_schedule_array_identity(&upper_token, "source"),
            sports_schedule_array_identity(&lower_token, "source")
        );
    }

    #[test]
    fn parses_numbered_ntvs_stream_metadata() {
        let stream: StreamedEmbedStream = serde_json::from_value(json!({
            "streamNo": 1,
            "language": "English - TSN",
            "hd": true,
            "embedUrl": "https://embed.st/embed/admin/ppv-france-vs-spain/1",
            "source": "admin"
        }))
        .unwrap();

        assert_eq!(stream.stream_no, 1);
        assert_eq!(stream.language, "English - TSN");
        assert!(stream.hd);
        assert_eq!(
            stream.embed_url,
            "https://embed.st/embed/admin/ppv-france-vs-spain/1"
        );
        assert_eq!(stream.source, "admin");
    }

    #[test]
    fn accepts_ntvs_stream_and_hls_urls_only() {
        let watch =
            url::Url::parse("https://ntvs.cx/watch/kobra/kosovo-vs-andorra-2472554").unwrap();
        let ntv_watch =
            url::Url::parse("https://ntv.cx/watch/kobra/kosovo-vs-andorra-2472554").unwrap();
        let channel = url::Url::parse("https://ntvs.cx/channel-hesgoales/NOVASPORTS-1").unwrap();
        let ntv_channel = url::Url::parse("https://ntv.cx/channel-hesgoales/NOVASPORTS-1").unwrap();
        let cdnlive_channel =
            url::Url::parse("https://ntvs.cx/channel-cdnlive/BBC?code=us").unwrap();
        let ntv_cdnlive_channel =
            url::Url::parse("https://ntv.cx/channel-cdnlive/BBC?code=us").unwrap();
        let empty_cdnlive_channel =
            url::Url::parse("https://ntvs.cx/channel-cdnlive/?code=us").unwrap();
        let lookalike_cdnlive_channel =
            url::Url::parse("https://ntvs.cx/channel-cdnlive.evil/BBC?code=us").unwrap();
        let wrapper = url::Url::parse("https://ntvs.cx/embed?t=abc123").unwrap();
        let ntv_wrapper = url::Url::parse("https://ntv.cx/embed?t=abc123").unwrap();
        let hesgoaler = url::Url::parse("https://hesgoaler.com/stream.php?ch=NOVASPORTS1").unwrap();
        let embed =
            url::Url::parse("https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1").unwrap();
        let hls =
            url::Url::parse("https://lb10.strmd.st/secure/token/rtmp/stream/id/1/playlist.m3u8")
                .unwrap();
        let hls2 =
            url::Url::parse("https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8?token=abc").unwrap();
        let segment =
            url::Url::parse("https://lb10.strmd.st/secure/token/rtmp/stream/id/1/segment.ts")
                .unwrap();
        let other = url::Url::parse("https://example.test/embed/admin/id/1").unwrap();

        assert!(is_supported_ntvs_watch_url(&watch));
        assert!(is_supported_ntvs_watch_url(&ntv_watch));
        assert!(is_supported_ntvs_channel_url(&channel));
        assert!(is_supported_ntvs_channel_url(&ntv_channel));
        assert!(is_supported_ntvs_channel_url(&cdnlive_channel));
        assert!(is_supported_ntvs_channel_url(&ntv_cdnlive_channel));
        assert!(!is_supported_ntvs_channel_url(&empty_cdnlive_channel));
        assert!(!is_supported_ntvs_channel_url(&lookalike_cdnlive_channel));
        assert!(is_supported_ntvs_wrapper_embed_url(&wrapper));
        assert!(is_supported_ntvs_wrapper_embed_url(&ntv_wrapper));
        assert!(is_supported_ntvs_embed_url(&embed));
        assert!(is_supported_ntvs_hesgoaler_player_url(&hesgoaler));
        assert!(is_supported_ntvs_stream_url(&watch));
        assert!(is_supported_ntvs_stream_url(&ntv_watch));
        assert!(is_supported_ntvs_stream_url(&channel));
        assert!(is_supported_ntvs_stream_url(&ntv_channel));
        assert!(is_supported_ntvs_stream_url(&cdnlive_channel));
        assert!(is_supported_ntvs_stream_url(&ntv_cdnlive_channel));
        assert_eq!(
            sports_stream_provider_id(&cdnlive_channel),
            Some(NTVS_SOURCE_ID)
        );
        assert!(is_supported_ntvs_stream_url(&embed));
        assert!(is_supported_ntvs_stream_url(&hesgoaler));
        assert_eq!(sports_stream_provider_id(&embed), Some(NTVS_SOURCE_ID));
        assert!(is_supported_ntvs_hls_url(&hls));
        assert!(is_supported_ntvs_hls_url(&hls2));
        assert!(!is_supported_ntvs_hls_url(&segment));
        assert!(!is_supported_ntvs_stream_url(&other));
    }

    #[test]
    fn extracts_ntvs_wrapper_and_embed_candidates_from_html() {
        let base = url::Url::parse("https://ntv.cx/watch/kobra/kosovo-vs-andorra-2472554").unwrap();
        let html = r#"
            <option value="/embed?t=abc&amp;server=kobra">Server Kobra</option>
            <iframe src="https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1"></iframe>
            <iframe src="https://hesgoaler.com/stream.php?ch=NOVASPORTS1"></iframe>
            <iframe src="https://example.test/embed/admin/ppv-kosovo-vs-andorra/1"></iframe>
        "#;

        let candidates = extract_ntvs_candidate_urls(html, &base)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            candidates,
            vec![
                "https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1".to_owned(),
                "https://hesgoaler.com/stream.php?ch=NOVASPORTS1".to_owned(),
                "https://ntv.cx/embed?t=abc&server=kobra".to_owned(),
            ]
        );
    }

    #[test]
    fn extracts_ntvs_candidates_from_single_quote_and_href() {
        let base = url::Url::parse("https://ntv.cx/watch/kobra/kosovo-vs-andorra-2472554").unwrap();
        let html = r#"
            <div class="watch">
                <a href="/embed?t=single">Open embed</a>
                <iframe data-src='/embed?t=single2' id='streamPlayer'></iframe>
                <a href='https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1'></a>
                <iframe
                    src = 'https://hesgoaler.com/stream.php?ch=NOVASPORTS1'
                ></iframe>
            </div>
        "#;

        let candidates = extract_ntvs_candidate_urls(html, &base)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();

        let mut candidates = candidates;
        candidates.sort();
        let mut expected = vec![
            "https://ntv.cx/embed?t=single".to_owned(),
            "https://ntv.cx/embed?t=single2".to_owned(),
            "https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1".to_owned(),
            "https://hesgoaler.com/stream.php?ch=NOVASPORTS1".to_owned(),
        ];
        expected.sort();
        assert_eq!(candidates, expected);
    }

    #[test]
    fn extracts_cdnlivetv_player_from_ntvs_channel_wrapper() {
        let base = url::Url::parse("https://ntv.cx/embed?t=opaque-token").unwrap();
        let html = r#"
            <iframe
                src="https://cdnlivetv.tv/api/v1/channels/player/?name=FOX%20News&amp;code=us&amp;user=ntvstream&amp;plan=free"
            ></iframe>
            <iframe src="https://example.test/api/v1/channels/player/?name=FOX%20News"></iframe>
        "#;

        let candidates = extract_ntvs_candidate_urls(html, &base)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            candidates,
            vec![
                "https://cdnlivetv.tv/api/v1/channels/player/?name=FOX%20News&code=us&user=ntvstream&plan=free"
                    .to_owned(),
            ]
        );
    }

    #[test]
    fn parses_ntvs_hesgoaler_player_source_from_html() {
        let html = r#"
            <script>
                const settings = {
                    api: window.location.pathname + window.location.search,
                    ch: "NOVASPORTS1",
                    src: "https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8",
                    currentToken: ""
                };
            </script>
        "#;
        assert_eq!(
            parse_ntvs_hesgoaler_player_source(html),
            Some((
                "NOVASPORTS1".to_owned(),
                "https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8".to_owned()
            ))
        );
    }

    #[test]
    fn parses_ntvs_hesgoaler_player_source_single_quotes() {
        let html = r#"
            <script>
                const settings = {
                    api: window.location.pathname + window.location.search,
                    ch: 'NOVASPORTS1',
                    src: 'https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8',
                    currentToken: ""
                };
            </script>
        "#;
        assert_eq!(
            parse_ntvs_hesgoaler_player_source(html),
            Some((
                "NOVASPORTS1".to_owned(),
                "https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8".to_owned()
            ))
        );
    }

    #[test]
    fn extracts_ntvs_candidates_from_script_embed_code() {
        let base = url::Url::parse("https://ntv.cx/channel-hesgoales/NOVASPORTS-1").unwrap();
        let html = r#"
            <script>
                const streamData = {
                  embedUrl: "\/embed?t=OFd0cFZIcCtUQ3NleURxSUs1SW9VTHRKb2tpMjlQWXN2Y29SM2E0UDdvOFo5K2I4MWdPWHgvSVZxZDB3YnNjSw~~",
                  embedCode: "<iframe src=\"/embed?t=single\" width=\"800\" height=\"450\"></iframe>",
                  streamData: "/stream.php?ch=NOVASPORTS1"
                };
            </script>
        "#;

        let mut candidates = extract_ntvs_candidate_urls(html, &base)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();

        candidates.sort();
        let mut expected = vec![
            "https://hesgoaler.com/stream.php?ch=NOVASPORTS1".to_owned(),
            "https://ntv.cx/embed?t=OFd0cFZIcCtUQ3NleURxSUs1SW9VTHRKb2tpMjlQWXN2Y29SM2E0UDdvOFo5K2I4MWdPWHgvSVZxZDB3YnNjSw~~".to_owned(),
            "https://ntv.cx/embed?t=single".to_owned(),
        ];
        expected.sort();
        assert_eq!(candidates, expected);
    }

    #[test]
    fn resolves_relative_ntvs_stream_php_paths_to_hesgoaler() {
        let base = url::Url::parse("https://ntvs.cx/channel-hesgoales/NOVASPORTS-1").unwrap();
        let resolved = resolve_ntvs_candidate_url(&base, "/stream.php?ch=NOVASPORTS1")
            .expect("hesgoaler candidate");
        assert_eq!(
            resolved.as_str(),
            "https://hesgoaler.com/stream.php?ch=NOVASPORTS1"
        );
    }

    #[test]
    fn normalizes_ntv_cx_fetch_urls_to_ntvs_cx() {
        let ntv_channel = url::Url::parse("https://ntv.cx/channel-hesgoales/NOVASPORTS-1").unwrap();
        let ntv_embed = url::Url::parse(
            "https://ntv.cx/embed?t=OFd0cFZIcCtUQ3NleURxSUs1SW9VTHRKb2tpMjlQWXN2Y29SM2E0UDdvOFo5K2I4MWdPWHgvSVZxZDB3YnNjSw~~",
        )
        .unwrap();
        let ntv_cdnlive = url::Url::parse("https://ntv.cx/channel-cdnlive/BBC?code=us").unwrap();

        assert_eq!(
            normalize_ntvs_fetch_url(&ntv_channel).as_str(),
            "https://ntvs.cx/channel-hesgoales/NOVASPORTS-1"
        );
        assert_eq!(
            normalize_ntvs_fetch_url(&ntv_embed).as_str(),
            "https://ntvs.cx/embed?t=OFd0cFZIcCtUQ3NleURxSUs1SW9VTHRKb2tpMjlQWXN2Y29SM2E0UDdvOFo5K2I4MWdPWHgvSVZxZDB3YnNjSw~~"
        );
        assert_eq!(
            normalize_ntvs_fetch_url(&ntv_cdnlive).as_str(),
            "https://ntvs.cx/channel-cdnlive/BBC?code=us"
        );
    }

    #[test]
    fn extracts_ntvs_candidates_from_channel_iframe_src() {
        let base = url::Url::parse("https://ntv.cx/channel-hesgoales/NOVASPORTS-1").unwrap();
        let html = r#"
            <iframe
                src="/embed?t=OFd0cFZIcCtUQ3NleURxSUs1SW9VTHRKb2tpMjlQWXN2Y29SM2E0UDdvOFo5K2I4MWdPWHgvSVZxZDB3YnNjSw~~"
            ></iframe>
        "#;

        let mut candidates = extract_ntvs_candidate_urls(html, &base)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        candidates.sort();

        assert_eq!(
            candidates,
            vec![
                "https://ntv.cx/embed?t=OFd0cFZIcCtUQ3NleURxSUs1SW9VTHRKb2tpMjlQWXN2Y29SM2E0UDdvOFo5K2I4MWdPWHgvSVZxZDB3YnNjSw~~"
                    .to_owned(),
            ]
        );
    }

    #[test]
    fn accepts_matchstream_channel_hosts_only() {
        let glisco = url::Url::parse("https://glisco.link/ch?id=4").unwrap();
        let evfancy = url::Url::parse("https://evfancy.link//ch?id=4").unwrap();
        let l2l2 = url::Url::parse("https://l2l2.link/ch?id=4").unwrap();
        let vertex = url::Url::parse("https://s3.vertex.st/ch?id=17").unwrap();
        let kora = url::Url::parse("https://s3.kora.st/ch?id=17").unwrap();
        let nexa = url::Url::parse("https://s1.nexa.st/ch?id=17").unwrap();
        let future_rotation = url::Url::parse("https://s42.any-provider.to/ch?id=91").unwrap();
        let missing_id = url::Url::parse("https://strongst.link/ch").unwrap();
        let wrong_path = url::Url::parse("https://s3.vertex.st/embed?id=17").unwrap();
        let wrong_shard = url::Url::parse("https://player.vertex.st/ch?id=17").unwrap();
        let nested_st = url::Url::parse("https://s3.extra.vertex.st/ch?id=17").unwrap();
        let numeric_tld = url::Url::parse("https://s3.vertex.x123/ch?id=17").unwrap();
        let other = url::Url::parse("https://example.test/ch?id=4").unwrap();

        assert!(is_supported_matchstream_stream_url(&glisco));
        assert!(is_supported_matchstream_stream_url(&evfancy));
        assert!(is_supported_matchstream_stream_url(&l2l2));
        assert!(is_supported_matchstream_stream_url(&vertex));
        assert!(is_supported_matchstream_stream_url(&kora));
        assert!(is_supported_matchstream_stream_url(&nexa));
        assert!(is_supported_matchstream_stream_url(&future_rotation));
        assert!(!is_supported_matchstream_stream_url(&missing_id));
        assert!(!is_supported_matchstream_stream_url(&wrong_path));
        assert!(!is_supported_matchstream_stream_url(&wrong_shard));
        assert!(!is_supported_matchstream_stream_url(&nested_st));
        assert!(!is_supported_matchstream_stream_url(&numeric_tld));
        assert!(!is_supported_matchstream_stream_url(&other));
        assert_eq!(
            normalize_matchstream_link("https://evfancy.link//ch?id=4").unwrap(),
            "https://evfancy.link/ch?id=4"
        );
        assert_eq!(
            normalize_matchstream_link("https://s3.vertex.st//ch?id=17").unwrap(),
            "https://s3.vertex.st/ch?id=17"
        );
    }

    #[test]
    fn accepts_matchstream_hls_and_player_hosts_only() {
        let brightcore =
            url::Url::parse("https://brightcoremind.com/embedb.php?player=desktop&live=do6")
                .unwrap();
        let helpless = url::Url::parse("https://helpless.click/e/sugutdh5wpwe").unwrap();
        let lineagest =
            url::Url::parse("https://lineagest.click/e/mbsb8pkj0dg6l?color=FF661A").unwrap();
        let zohanayaan =
            url::Url::parse("https://cdn6.zohanayaan.com:1686/hls/do6.m3u8?token=1").unwrap();
        let xst = url::Url::parse("https://media.example.28585519.net/hls/live.m3u8").unwrap();
        let segment = url::Url::parse("https://cdn6.zohanayaan.com:1686/hls/do6.ts").unwrap();
        let other = url::Url::parse("https://example.test/live.m3u8").unwrap();

        assert!(is_supported_matchstream_player_url(&brightcore));
        assert!(is_supported_matchstream_player_url(&helpless));
        assert!(is_supported_matchstream_player_url(&lineagest));
        assert!(is_supported_matchstream_hls_url(&zohanayaan));
        assert!(is_supported_matchstream_hls_url(&xst));
        assert!(!is_supported_matchstream_hls_url(&segment));
        assert!(!is_supported_matchstream_hls_url(&other));
    }

    #[test]
    fn builds_unique_matchstream_live_stream_candidates() {
        let candidates = matchstream_live_stream_source_candidates(
            "https://s3.vertex.st/ch?id=17",
            Some(
                "https://s3.kora.st//ch?id=17,https://streamed.pk/api/stream/admin/a,https://strongst.link/ch?id=4,https://s1.nexa.st/ch?id=17",
            ),
        )
        .unwrap();

        assert_eq!(
            candidates
                .iter()
                .map(|url| url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://s3.vertex.st/ch?id=17",
                "https://s3.kora.st/ch?id=17",
                "https://strongst.link/ch?id=4",
                "https://s1.nexa.st/ch?id=17",
            ]
        );
    }

    #[test]
    fn builds_mixed_sports_live_stream_candidates() {
        let candidates = sports_live_stream_source_candidates(
            "https://streamed.pk/api/stream/admin/a",
            Some(
                r#"["https://evfancy.link//ch?id=4","https://streamed.pk/api/stream/echo/a","https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1","https://streamed.pk/watch/kosovo-vs-andorra-2472554/admin/1","https://example.test/live"]"#,
            ),
        )
        .unwrap();

        assert_eq!(
            candidates
                .iter()
                .map(|url| url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://streamed.pk/api/stream/admin/a",
                "https://evfancy.link/ch?id=4",
                "https://streamed.pk/api/stream/echo/a",
                "https://embed.st/embed/admin/ppv-kosovo-vs-andorra/1",
                "https://streamed.pk/watch/kosovo-vs-andorra-2472554/admin/1",
            ]
        );
    }

    #[test]
    fn builds_streamed_payload_with_source_routes() {
        let (payload, _) = build_streamed_football_matches_payload(vec![StreamedMatch {
            id: "crystal-palace-vs-arsenal-2267445".to_owned(),
            title: "Crystal Palace vs Arsenal".to_owned(),
            category: "football".to_owned(),
            date: now_ms() + 60_000,
            popular: true,
            teams: StreamedTeams {
                home: Some(StreamedTeam {
                    name: "Crystal Palace".to_owned(),
                }),
                away: Some(StreamedTeam {
                    name: "Arsenal".to_owned(),
                }),
            },
            sources: vec![StreamedSource {
                source: "admin".to_owned(),
                id: "ppv-crystal-palace-vs-arsenal".to_owned(),
                expanded_streams: Vec::new(),
            }],
        }]);
        let matches = payload["matches"].as_array().unwrap();

        assert_eq!(payload["source"], STREAMED_FOOTBALL_MATCHES_URL);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["team1"], "Crystal Palace");
        assert_eq!(
            matches[0]["streams"][0]["source"],
            "https://streamed.pk/api/stream/admin/ppv-crystal-palace-vs-arsenal"
        );
    }

    #[test]
    fn linked_ntvs_override_is_scoped_and_deduplicated() {
        let mut intended = sample_streamed_match(vec![StreamedSource {
            source: "delta".to_owned(),
            id: "live_world-cup-knockout-stage_france-spain-live-streaming-538120800".to_owned(),
            expanded_streams: Vec::new(),
        }]);
        intended.id = "france-vs-spain-2528031".to_owned();
        intended.date = 1_784_055_600_000;
        let mut wrong_date = sample_streamed_match(Vec::new());
        wrong_date.id = "france-vs-spain-2528031".to_owned();
        wrong_date.date = 1_784_055_600_001;
        let mut matches = vec![intended, wrong_date];

        add_ntvs_linked_source_overrides(&mut matches);
        add_ntvs_linked_source_overrides(&mut matches);

        let mut source_groups = matches[0]
            .sources
            .iter()
            .map(|source| (source.source.as_str(), source.id.as_str()))
            .collect::<Vec<_>>();
        source_groups.sort_unstable();
        assert_eq!(
            source_groups,
            vec![
                ("admin", "ppv-france-vs-spain"),
                (
                    "delta",
                    "live_world-cup-knockout-stage_france-spain-live-streaming-538120800"
                ),
                ("golf", "23742"),
            ]
        );
        assert!(matches[1].sources.is_empty());
    }

    #[test]
    fn streamed_payload_exposes_all_linked_kobra_rows() {
        let admin_languages = [
            "English - TSN",
            "English - TSN",
            "English - FOX",
            "English - FOX",
            "English - ITV1",
            "English - ITV1",
            "Spanish - DAZN Spain",
            "Spanish - DAZN Spain",
            "Spanish - Telemundo",
            "Spanish - Telemundo",
        ];
        let admin_rows = admin_languages
            .into_iter()
            .enumerate()
            .map(|(index, language)| StreamedEmbedStream {
                stream_no: (index + 1) as i64,
                hd: index % 2 == 0,
                embed_url: format!(
                    "https://embed.st/embed/admin/ppv-france-vs-spain/{}",
                    index + 1
                ),
                language: language.to_owned(),
                source: "admin".to_owned(),
            })
            .collect::<Vec<_>>();
        let delta_rows = (1..=6)
            .map(|stream_no| StreamedEmbedStream {
                stream_no,
                hd: true,
                embed_url: format!(
                    "https://embed.st/embed/delta/live_world-cup-knockout-stage_france-spain-live-streaming-538120800/{stream_no}"
                ),
                language: "English".to_owned(),
                source: "delta".to_owned(),
            })
            .collect::<Vec<_>>();
        let golf_rows = (1..=2)
            .map(|stream_no| StreamedEmbedStream {
                stream_no,
                hd: true,
                embed_url: format!("https://embed.st/embed/golf/23742/{stream_no}"),
                language: "English".to_owned(),
                source: "golf".to_owned(),
            })
            .collect::<Vec<_>>();
        let (payload, _) = build_streamed_football_matches_payload(vec![StreamedMatch {
            id: "france-vs-spain-2528031".to_owned(),
            title: "France vs Spain".to_owned(),
            category: "football".to_owned(),
            date: now_ms().saturating_sub(60_000),
            popular: true,
            teams: StreamedTeams {
                home: Some(StreamedTeam {
                    name: "France".to_owned(),
                }),
                away: Some(StreamedTeam {
                    name: "Spain".to_owned(),
                }),
            },
            sources: vec![
                StreamedSource {
                    source: "admin".to_owned(),
                    id: "ppv-france-vs-spain".to_owned(),
                    expanded_streams: admin_rows,
                },
                StreamedSource {
                    source: "delta".to_owned(),
                    id: "live_world-cup-knockout-stage_france-spain-live-streaming-538120800"
                        .to_owned(),
                    expanded_streams: delta_rows,
                },
                StreamedSource {
                    source: "golf".to_owned(),
                    id: "23742".to_owned(),
                    expanded_streams: golf_rows,
                },
            ],
        }]);
        let game = &payload["matches"][0];
        let streams = game["streams"].as_array().unwrap();

        assert_eq!(streams.len(), 18);
        assert_eq!(game["linkCount"], 18);
        assert_eq!(streams[0]["id"], "ntvs-admin-1");
        assert_eq!(
            streams[0]["label"],
            "NTV Kobra · ADMIN · English · TSN · Stream 1"
        );
        assert_eq!(streams[0]["quality"], "HD");
        assert_eq!(streams[0]["playbackType"], "iframe");
        assert_eq!(
            streams[0]["source"],
            "live-iframe:https%3A%2F%2Fembed.st%2Fembed%2Fadmin%2Fppv-france-vs-spain%2F1"
        );
        assert_eq!(streams[1]["quality"], "SD");
        assert_eq!(
            streams[6]["label"],
            "NTV Kobra · ADMIN · Spanish · DAZN Spain · Stream 7"
        );
        assert_eq!(streams[10]["id"], "ntvs-delta-1");
        assert_eq!(streams[16]["id"], "ntvs-golf-1");
        assert_eq!(streams[17]["id"], "ntvs-golf-2");
        assert!(
            streams
                .iter()
                .all(|stream| stream["provider"] == NTVS_SOURCE_ID)
        );
        assert_eq!(game["languages"], json!(["English", "Spanish"]));
    }

    #[test]
    fn streamed_payload_keeps_coarse_fallback_for_non_direct_rows() {
        let (payload, _) =
            build_streamed_football_matches_payload(vec![sample_streamed_match(vec![
                StreamedSource {
                    source: "admin".to_owned(),
                    id: "ppv-morocco-vs-madagascar".to_owned(),
                    expanded_streams: vec![StreamedEmbedStream {
                        stream_no: 1,
                        hd: true,
                        embed_url: "https://embedsports.top/embed/admin/legacy/1".to_owned(),
                        language: "English".to_owned(),
                        source: "admin".to_owned(),
                    }],
                },
            ])]);

        assert_eq!(payload["matches"][0]["linkCount"], 1);
        assert_eq!(
            payload["matches"][0]["streams"][0]["source"],
            "https://streamed.pk/api/stream/admin/ppv-morocco-vs-madagascar"
        );
        assert_eq!(
            payload["matches"][0]["streams"][0]["provider"],
            STREAMED_SOURCE_ID
        );
    }

    #[test]
    fn extracts_matchstream_matches_from_viewer_html() {
        let html = r#"<script>window.matches = JSON.parse(`[{"matchText":"17:00 [England League Two] Notts County vs Salford City [Sky Sports Football GB]","matchstr":"Notts County vs Salford City","league":"England League Two","sport":"Football","team1":"Notts County","team2":"Salford City","channel":"Sky Sports Football GB","important":false,"matchDate":"2026-05-25","channels":[{"name":"Sky Sports Football","number":4,"language":"GB","links":["https:\/\/glisco.link\/ch?id=4"]}],"slug":"england-league-two-football-notts-county-salford-city-2026-05-25-17-00","startTimestamp":1779717600000,"duration":120}]`);</script>"#;

        let matches = extract_matchstream_matches(html).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].team1, "Notts County");
        assert_eq!(
            matches[0].channels[0].links[0],
            "https://glisco.link/ch?id=4"
        );
    }

    #[test]
    fn builds_matchstream_payload_with_hls_sources() {
        let (payload, _) = build_matchstream_football_matches_payload(vec![MatchstreamMatch {
            match_text:
                "17:00 [England League Two] Notts County vs Salford City [Sky Sports Football GB]"
                    .to_owned(),
            match_str: "Notts County vs Salford City".to_owned(),
            league: "England League Two".to_owned(),
            sport: "Football".to_owned(),
            team1: "Notts County".to_owned(),
            team2: "Salford City".to_owned(),
            channel: "Sky Sports Football GB".to_owned(),
            important: false,
            match_date: "2026-05-25".to_owned(),
            channels: vec![MatchstreamChannel {
                name: "Sky Sports Football".to_owned(),
                number: 4,
                language: Some("GB".to_owned()),
                links: vec![
                    "https://glisco.link/ch?id=4".to_owned(),
                    "https://evfancy.link//ch?id=4".to_owned(),
                ],
            }],
            slug: "england-league-two-football-notts-county-salford-city-2026-05-25-17-00"
                .to_owned(),
            start_timestamp: now_ms() + 60_000,
            duration: 120,
        }]);
        let matches = payload["matches"].as_array().unwrap();

        assert_eq!(payload["source"], MATCHSTREAM_WEBMASTER_URL);
        assert_eq!(payload["sourceProvider"], "matchstream");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["provider"], "matchstream");
        assert_eq!(
            matches[0]["streams"][1]["source"],
            "https://evfancy.link/ch?id=4"
        );
    }

    #[test]
    fn sports_schedule_cache_reuses_fresh_entries_and_expires_later() {
        let cache = SportsScheduleCache::new();
        cache.insert(
            "football",
            json!({
                "sport": "Football",
                "matches": [{
                    "startTimestamp": 8_000_000,
                    "endsAtTimestamp": 8_700_000
                }]
            }),
            1_000,
        );

        assert_eq!(
            cache
                .fresh("football", 1_000 + SPORTS_SCHEDULE_FUTURE_CACHE_TTL_MS)
                .unwrap()["sport"],
            "Football"
        );
        assert!(
            cache
                .fresh("football", 1_000 + SPORTS_SCHEDULE_FUTURE_CACHE_TTL_MS + 1)
                .is_none()
        );
        assert_eq!(
            cache
                .stale("football", 1_000 + SPORTS_SCHEDULE_STALE_IF_ERROR_MS)
                .unwrap()["sport"],
            "Football"
        );
        assert!(
            cache
                .stale("football", 1_000 + SPORTS_SCHEDULE_STALE_IF_ERROR_MS + 1)
                .is_none()
        );
    }

    #[test]
    fn sports_schedule_ttl_is_shorter_for_live_and_empty_payloads() {
        let now = now_ms();
        assert_eq!(
            sports_schedule_fresh_ttl_ms(
                &json!({ "matches": [{ "startTimestamp": now - 1_000, "endsAtTimestamp": now + 1_000 }] }),
                now,
            ),
            super::SPORTS_SCHEDULE_LIVE_CACHE_TTL_MS
        );
        assert_eq!(
            sports_schedule_fresh_ttl_ms(&json!({ "matches": [] }), now),
            super::SPORTS_SCHEDULE_EMPTY_CACHE_TTL_MS
        );
    }

    #[test]
    fn sports_stream_resolve_cache_keys_include_provider_and_expire() {
        let cache = SportsStreamResolveCache::new(1, 100);
        let source_url = url::Url::parse("https://evfancy.link/ch?id=4").unwrap();
        let streamed_key = sports_stream_resolve_cache_key("streamed", &source_url);
        let matchstream_key = sports_stream_resolve_cache_key("matchstream", &source_url);
        let resolved = super::ResolvedLiveStream {
            source_url: source_url.clone(),
            player_page_url: source_url.clone(),
            playback_url: url::Url::parse("https://cdn6.zohanayaan.com/hls/do4.m3u8").unwrap(),
            playback_type: "hls",
            candidate_index: 0,
            attempted_streams: 1,
        };

        assert_ne!(streamed_key, matchstream_key);
        cache.insert(matchstream_key.clone(), resolved, 1_000);
        assert!(
            cache
                .fresh(&matchstream_key, 1_000 + SPORTS_STREAM_RESOLVE_CACHE_TTL_MS)
                .is_some()
        );
        assert!(
            cache
                .fresh(
                    &matchstream_key,
                    1_000 + SPORTS_STREAM_RESOLVE_CACHE_TTL_MS + 1
                )
                .is_none()
        );
        assert!(cache.fresh(&streamed_key, 1_000).is_none());
    }

    #[test]
    fn sports_stream_resolve_cache_remembers_failures_briefly() {
        let cache = SportsStreamResolveCache::new(1, 100);
        let source_url = url::Url::parse("https://ntv.cx/watch/kobra/dead-source-1").unwrap();
        let key = sports_stream_resolve_cache_key(NTVS_SOURCE_ID, &source_url);

        assert!(cache.fresh_failure(&key, 1_000).is_none());
        cache.insert_failure(key.clone(), "resolver timed out".to_owned(), 1_000);
        assert_eq!(
            cache
                .fresh_failure(&key, 1_000 + SPORTS_STREAM_RESOLVE_FAILURE_TTL_MS)
                .as_deref(),
            Some("resolver timed out")
        );
        assert!(
            cache
                .fresh_failure(&key, 1_000 + SPORTS_STREAM_RESOLVE_FAILURE_TTL_MS + 1)
                .is_none()
        );
        // A cached failure must not leak into the success cache.
        assert!(cache.fresh(&key, 1_000).is_none());
    }

    #[test]
    fn cdnlivetv_schedule_source_round_trips() {
        assert_eq!(
            SportsScheduleSource::from_query(Some("cdnlivetv")).unwrap(),
            SportsScheduleSource::Cdnlivetv
        );
    }

    #[test]
    fn cdnlivetv_url_checks_distinguish_player_and_hls() {
        let player = Url::parse(
            "https://cdnlivetv.tv/api/v1/channels/player/?name=ITV%201%20FHD%20UK&code=gb&user=cdnlivetv&plan=free",
        )
        .unwrap();
        let hls = Url::parse("https://cdnlivetv.tv/secure/api/v1/6a288d2a/playlist.m3u8?token=abc")
            .unwrap();
        let sibling =
            Url::parse("https://cdn-live.tv/api/v1/channels/player/?name=Sky&code=gb").unwrap();
        let other = Url::parse("https://example.com/api/v1/channels/player/?name=x").unwrap();

        assert!(is_supported_cdnlivetv_stream_url(&player));
        assert!(is_supported_cdnlivetv_stream_url(&sibling));
        assert!(!is_supported_cdnlivetv_stream_url(&hls));
        assert!(!is_supported_cdnlivetv_stream_url(&other));

        assert!(is_supported_cdnlivetv_hls_url(&hls));
        assert!(!is_supported_cdnlivetv_hls_url(&player));

        assert_eq!(
            sports_stream_provider_id(&player),
            Some(CDNLIVETV_SOURCE_ID)
        );
    }

    #[test]
    fn cdnlivetv_start_parses_as_utc() {
        // France vs Sweden kickoff — must equal streamed's epoch (verified live).
        assert_eq!(
            parse_cdnlivetv_start_ms("2026-06-30 21:00"),
            Some(1_782_853_200_000)
        );
        assert_eq!(parse_cdnlivetv_start_ms("1970-01-01 00:00"), Some(0));
        assert_eq!(parse_cdnlivetv_start_ms(""), None);
        assert_eq!(parse_cdnlivetv_start_ms("not-a-date"), None);

        assert_eq!(unix_days_from_civil(1970, 1, 1), 0);
        assert_eq!(unix_days_from_civil(2026, 6, 30), 20_634);
    }

    #[test]
    fn cdnlivetv_channel_scoring_prefers_fhd_and_broadcasters() {
        assert!(
            cdnlivetv_channel_score("ITV 1 FHD UK")
                > cdnlivetv_channel_score("beIN SPORTS 1 FR HD")
        );
        assert!(
            cdnlivetv_channel_score("beIN SPORTS 1 FR HD")
                > cdnlivetv_channel_score("FOX 5 New York")
        );
        assert_eq!(cdnlivetv_channel_quality_label("ITV 1 FHD UK"), "FHD");
        assert_eq!(cdnlivetv_channel_quality_label("M6 HD FR"), "HD");
        assert_eq!(cdnlivetv_channel_quality_label("FOX 5 New York"), "SD");
    }

    #[test]
    fn cdnlivetv_curation_ranks_and_caps_channels() {
        let mut channels = vec![
            json!({"id": "fox", "channel_name": "FOX 5 New York", "channel_code": ""}),
            json!({"id": "itv", "channel_name": "ITV 1 FHD UK", "channel_code": "gb"}),
            json!({"id": "bad", "channel_name": "", "channel_code": "gb"}),
        ];
        for index in 0..CDNLIVETV_MAX_CHANNELS_PER_MATCH {
            channels.push(json!({"id": format!("ca-{index}"), "channel_name": format!("CA CTV {index}"), "channel_code": ""}));
        }
        let curated = curate_cdnlivetv_channels(&channels);
        // Empty-named channel is dropped; the rest are capped.
        assert_eq!(curated.len(), CDNLIVETV_MAX_CHANNELS_PER_MATCH);
        // Highest-scoring feed leads the picker.
        assert_eq!(curated[0].channel_name, "ITV 1 FHD UK");
    }

    #[test]
    fn cdnlivetv_payload_builds_streams_and_filters_dead_events() {
        let payload = json!({
            "cdn-live-tv": {
                "Soccer": [
                    {
                        "gameID": 2502847,
                        "homeTeam": "France",
                        "awayTeam": "Sweden",
                        "start": "2099-01-01 21:00",
                        "status": "NS",
                        "tournament": "Friendly",
                        "channels": [
                            {
                                "id": "itv",
                                "channel_name": "ITV 1 FHD UK",
                                "channel_code": "gb",
                                "url": "https://cdnlivetv.tv/api/v1/channels/player/?name=ITV%201%20FHD%20UK&code=gb&user=cdnlivetv&plan=free"
                            },
                            {"id": "bein", "channel_name": "beIN SPORTS 1 FR HD", "channel_code": "fr"},
                            {"id": "fox", "channel_name": "FOX 5 New York", "channel_code": ""}
                        ]
                    },
                    {
                        "gameID": "daddy:2000-01-01:old-game",
                        "homeTeam": "Old",
                        "awayTeam": "Game",
                        "start": "2000-01-01 00:00",
                        "status": "LIVE",
                        "channels": [{"id": "x", "channel_name": "X HD", "channel_code": ""}]
                    },
                    {
                        "gameID": 7,
                        "homeTeam": "No",
                        "awayTeam": "Channels",
                        "start": "2099-01-01 21:00",
                        "status": "NS",
                        "channels": []
                    }
                ]
            }
        });

        let (built, _fetched_at) =
            build_cdnlivetv_sport_matches_payload(&payload, "https://example/events", "football");
        let matches = built["matches"].as_array().unwrap();
        // Past event + channel-less event are filtered; only France vs Sweden survives.
        assert_eq!(matches.len(), 1);
        let game = &matches[0];
        assert_eq!(game["title"], "France vs Sweden");
        assert_eq!(game["provider"], CDNLIVETV_SOURCE_ID);
        assert_eq!(
            game["startTimestamp"],
            parse_cdnlivetv_start_ms("2099-01-01 21:00").unwrap()
        );

        let streams = game["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 3);
        // Best feed first; ITV's provided url is kept verbatim.
        assert_eq!(streams[0]["label"], "ITV 1 FHD UK");
        assert_eq!(streams[0]["quality"], "FHD");
        assert_eq!(
            streams[0]["source"],
            "https://cdnlivetv.tv/api/v1/channels/player/?name=ITV%201%20FHD%20UK&code=gb&user=cdnlivetv&plan=free"
        );
        // beIN had no url, so it's reconstructed into a valid player URL.
        let bein = streams
            .iter()
            .find(|s| s["label"] == "beIN SPORTS 1 FR HD")
            .unwrap();
        let bein_source = bein["source"].as_str().unwrap();
        assert!(is_supported_cdnlivetv_stream_url(
            &Url::parse(bein_source).unwrap()
        ));
        assert_eq!(bein["quality"], "HD");
    }

    #[test]
    fn cdnlivetv_payload_empty_for_unmapped_sport() {
        let payload = json!({ "cdn-live-tv": { "Soccer": [] } });
        let (built, _fetched_at) =
            build_cdnlivetv_sport_matches_payload(&payload, "https://example/events", "basketball");
        assert_eq!(built["matches"].as_array().unwrap().len(), 0);
    }
}
