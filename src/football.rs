use std::collections::BTreeSet;
use std::env;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, Response};
use dashmap::DashMap;
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;
use url::Url;

use crate::error::{ApiError, AppResult, json_response};
use crate::routes::AppState;
use crate::utils::now_ms;

const STREAMED_SOURCE_ID: &str = "streamed";
const MATCHSTREAM_SOURCE_ID: &str = "matchstream";
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
const STREAMED_MATCHES_BASE_URL: &str = "https://streamed.pk/api/matches";
const STREAMED_FOOTBALL_MATCHES_URL: &str = "https://streamed.pk/api/matches/football";
const STREAMED_BASKETBALL_MATCHES_URL: &str = "https://streamed.pk/api/matches/basketball";
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
const MATCHSTREAM_WEBMASTER_URL: &str = "https://matchstream.do/webmaster";
const MATCHSTREAM_VIEWER_URL: &str = "https://matchstream.do/viewer";
const MATCHSTREAM_DEFAULT_DURATION_MINUTES: i64 = 180;
const SPORTS_HTTP_PROXY_ENV: &str = "SPORTS_HTTP_PROXY";
const SPORTS_HTTP_CLIENT_TIMEOUT_SECONDS: u64 = 30;
const MAX_LIVE_STREAM_CANDIDATES: usize = 12;
const STREAMED_SOURCE_PREFLIGHT_MAX_CONCURRENT: usize = 8;
const STREAMED_SOURCE_PREFLIGHT_TIMEOUT_SECONDS: u64 = 6;
const SPORTS_STREAM_RESOLVE_CACHE_TTL_MS: i64 = 60 * 1000;
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

#[derive(Debug, Deserialize)]
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
pub struct SportsScheduleQuery {
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveFootballStreamQuery {
    url: String,
    #[serde(default, rename = "fallbackUrls")]
    fallback_urls: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SportsScheduleSource {
    Auto,
    Streamed,
    Matchstream,
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

impl SportsStreamResolveCache {
    pub fn new(max_concurrent: usize, queue_timeout_ms: u64) -> Self {
        let max_concurrent = max_concurrent.max(1);
        Self {
            entries: Arc::new(DashMap::new()),
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

    pub fn prune(&self) {
        let now = now_ms();
        self.entries.retain(|_, cached| now <= cached.expires_at_ms);
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
            "freshEntries": self.entries.iter().filter(|entry| now <= entry.value().expires_at_ms).count()
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
            STREAMED_SOURCE_ID => Ok(Self::Streamed),
            MATCHSTREAM_SOURCE_ID => Ok(Self::Matchstream),
            _ => Err(ApiError::bad_request("Unsupported sports schedule source.")),
        }
    }
}

pub async fn football_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_FOOTBALL_CACHE_KEY,
        MATCHSTREAM_FOOTBALL_CACHE_KEY,
        "football",
        "Football",
    )
    .await
}

pub async fn basketball_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_BASKETBALL_CACHE_KEY,
        MATCHSTREAM_BASKETBALL_CACHE_KEY,
        "basketball",
        "Basketball",
    )
    .await
}

pub async fn tennis_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_TENNIS_CACHE_KEY,
        MATCHSTREAM_TENNIS_CACHE_KEY,
        "tennis",
        "Tennis",
    )
    .await
}

pub async fn hockey_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_HOCKEY_CACHE_KEY,
        MATCHSTREAM_HOCKEY_CACHE_KEY,
        "hockey",
        "Hockey",
    )
    .await
}

pub async fn baseball_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_BASEBALL_CACHE_KEY,
        MATCHSTREAM_BASEBALL_CACHE_KEY,
        "baseball",
        "Baseball",
    )
    .await
}

pub async fn american_football_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_AMERICAN_FOOTBALL_CACHE_KEY,
        MATCHSTREAM_AMERICAN_FOOTBALL_CACHE_KEY,
        "american-football",
        "American Football",
    )
    .await
}

pub async fn cricket_matches_handler(
    State(state): State<AppState>,
    Query(query): Query<SportsScheduleQuery>,
) -> AppResult<Response<Body>> {
    sport_matches_response(
        &state,
        query,
        STREAMED_CRICKET_CACHE_KEY,
        MATCHSTREAM_CRICKET_CACHE_KEY,
        "cricket",
        "Cricket",
    )
    .await
}

async fn sport_matches_response(
    state: &AppState,
    query: SportsScheduleQuery,
    streamed_cache_key: &'static str,
    matchstream_cache_key: &'static str,
    streamed_category: &'static str,
    sport_name: &'static str,
) -> AppResult<Response<Body>> {
    match SportsScheduleSource::from_query(query.source.as_deref())? {
        SportsScheduleSource::Auto => {
            auto_sport_matches_response(
                state,
                streamed_cache_key,
                matchstream_cache_key,
                streamed_category,
                sport_name,
            )
            .await
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
    }
}

async fn auto_sport_matches_response(
    state: &AppState,
    streamed_cache_key: &'static str,
    matchstream_cache_key: &'static str,
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

    match matchstream_sport_matches_response(state, matchstream_cache_key, sport_name).await {
        Ok(response) => Ok(response),
        Err(matchstream_error) => Err(ApiError::bad_gateway(format!(
            "Sports schedule providers failed. Streamed: {} MatchStream: {}",
            api_error_message(&streamed_error),
            api_error_message(&matchstream_error)
        ))),
    }
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
        .user_agent("netflix-rust-backend")
        .timeout(Duration::from_secs(SPORTS_HTTP_CLIENT_TIMEOUT_SECONDS))
        .proxy(proxy)
        .build()
        .map_err(|error| ApiError::internal(error.to_string()))
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
    filter_empty_live_streamed_sources(state, &mut source_matches, now_ms()).await?;
    Ok(build_streamed_sport_matches_payload(
        source_matches,
        &source_url,
        sport_name,
    ))
}

fn streamed_matches_url(streamed_category: &str) -> String {
    match streamed_category {
        "football" => STREAMED_FOOTBALL_MATCHES_URL.to_owned(),
        "basketball" => STREAMED_BASKETBALL_MATCHES_URL.to_owned(),
        _ => format!("{STREAMED_MATCHES_BASE_URL}/{streamed_category}"),
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
    let empty_sources = stream::iter(probes)
        .map(|(match_index, source_index, source_url)| {
            let client = client.clone();
            async move {
                match fetch_streamed_source_has_embeds(&client, &source_url).await {
                    Some(false) => Some((match_index, source_index)),
                    _ => None,
                }
            }
        })
        .buffer_unordered(STREAMED_SOURCE_PREFLIGHT_MAX_CONCURRENT)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    remove_streamed_sources_by_index(source_matches, &empty_sources);
    Ok(())
}

async fn fetch_streamed_source_has_embeds(
    client: &reqwest::Client,
    source_url: &str,
) -> Option<bool> {
    let response = client
        .get(source_url)
        .header(reqwest::header::USER_AGENT, STREAMED_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_REFERER)
        .send();
    let response_result = timeout(
        Duration::from_secs(STREAMED_SOURCE_PREFLIGHT_TIMEOUT_SECONDS),
        response,
    )
    .await
    .ok()?;
    let response = response_result.ok()?;
    if !response.status().is_success() {
        return None;
    }

    let streams = response.json::<Vec<StreamedEmbedStream>>().await.ok()?;
    Some(!streams.is_empty())
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
        .header(reqwest::header::REFERER, MATCHSTREAM_WEBMASTER_URL)
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
    let mut url = Url::parse(MATCHSTREAM_VIEWER_URL).expect("valid MatchStream viewer URL");
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
            "source": MATCHSTREAM_WEBMASTER_URL,
            "sourceFetchUrl": source_url,
            "sourceProvider": MATCHSTREAM_SOURCE_ID,
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
    let mut errors = Vec::new();

    for (candidate_index, source_url) in candidates.iter().enumerate() {
        let provider = sports_stream_provider_id(source_url).unwrap_or("unknown");
        let resolved_result = if is_streamed_stream_api_url(source_url) {
            resolve_cached_streamed_live_stream(state, source_url, candidate_index).await
        } else if is_supported_matchstream_stream_url(source_url) {
            resolve_cached_matchstream_live_stream(state, source_url, candidate_index).await
        } else {
            Err(ApiError::bad_request("Unsupported sports live stream URL."))
        };

        match resolved_result {
            Ok(resolved) if resolved.playback_type == "hls" => {
                return Ok(resolved_live_stream_response(resolved, provider, false));
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
    resolved: ResolvedLiveStream,
    provider: &'static str,
    _cache_hit: bool,
) -> Response<Body> {
    let playback_url_text = resolved.playback_url.to_string();
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
            Ok(url) if is_supported_streamed_embed_url(&url) => url,
            _ => {
                errors.push("Streamed returned an unsupported embed URL.".to_owned());
                continue;
            }
        };
        if let Some(playback_url) = resolve_streamed_embed_hls_url(&embed_url).await {
            let player_page_url =
                Url::parse(STREAMED_EMBED_REFERER).unwrap_or_else(|_| embed_url.clone());
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

async fn resolve_streamed_embed_hls_url(embed_url: &Url) -> Option<Url> {
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
    if !is_streamed_stream_api_url(&primary) {
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
        if !is_streamed_stream_api_url(&parsed) {
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

fn is_streamed_stream_api_url(url: &Url) -> bool {
    matches!(
        url.host_str().unwrap_or_default(),
        "streamed.pk" | "www.streamed.pk"
    ) && url.path().starts_with("/api/stream/")
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
    is_streamed_stream_api_url(url) || is_supported_matchstream_stream_url(url)
}

fn sports_stream_provider_id(url: &Url) -> Option<&'static str> {
    if is_streamed_stream_api_url(url) {
        return Some(STREAMED_SOURCE_ID);
    }
    if is_supported_matchstream_stream_url(url) {
        return Some(MATCHSTREAM_SOURCE_ID);
    }
    None
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
        "helpless.click" | "www.helpless.click" => url.path().starts_with("/e/"),
        _ => false,
    }
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
    let streams = match_item
        .sources
        .iter()
        .enumerate()
        .filter_map(|(index, source)| {
            let source_name = source.source.trim();
            let source_url = streamed_source_stream_api_url(source)?;
            let display_source = title_case_ascii(source_name);
            Some(json!({
                "id": format!("streamed-{source_name}-{index}"),
                "label": format!("Streamed {display_source}"),
                "source": source_url,
                "provider": STREAMED_SOURCE_ID,
                "playbackType": "hls",
                "quality": "HD"
            }))
        })
        .collect::<Vec<_>>();
    let channels = match_item
        .sources
        .iter()
        .filter_map(|source| {
            let source_name = source.source.trim();
            let _ = streamed_source_stream_api_url(source)?;
            Some(json!({
                "name": format!("Streamed {}", title_case_ascii(source_name)),
                "language": "HD",
                "linkCount": 1
            }))
        })
        .collect::<Vec<_>>();
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
        "languages": ["HD"],
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
        MATCHSTREAM_WEBMASTER_URL, MatchstreamChannel, MatchstreamMatch,
        SPORTS_SCHEDULE_FUTURE_CACHE_TTL_MS, SPORTS_SCHEDULE_STALE_IF_ERROR_MS,
        SPORTS_STREAM_RESOLVE_CACHE_TTL_MS, STREAMED_FOOTBALL_MATCHES_URL, SportsScheduleCache,
        SportsScheduleSource, SportsStreamResolveCache, StreamedMatch, StreamedSource,
        StreamedTeam, StreamedTeams, build_matchstream_football_matches_payload,
        build_streamed_football_matches_payload, extract_matchstream_matches,
        is_supported_matchstream_hls_url, is_supported_matchstream_player_url,
        is_supported_matchstream_stream_url, is_supported_streamed_hls_url,
        live_stream_source_candidates, matchstream_live_stream_source_candidates,
        normalize_matchstream_link, parse_fallback_stream_urls, remove_streamed_sources_by_index,
        sports_live_stream_source_candidates, sports_schedule_fresh_ttl_ms,
        sports_stream_resolve_cache_key, streamed_match_is_live, streamed_source_stream_api_url,
    };
    use crate::utils::now_ms;
    use serde_json::json;

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
            },
            StreamedSource {
                source: "admin".to_owned(),
                id: "ppv-morocco-vs-madagascar".to_owned(),
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
        let zohanayaan =
            url::Url::parse("https://cdn6.zohanayaan.com:1686/hls/do6.m3u8?token=1").unwrap();
        let xst = url::Url::parse("https://media.example.28585519.net/hls/live.m3u8").unwrap();
        let segment = url::Url::parse("https://cdn6.zohanayaan.com:1686/hls/do6.ts").unwrap();
        let other = url::Url::parse("https://example.test/live.m3u8").unwrap();

        assert!(is_supported_matchstream_player_url(&brightcore));
        assert!(is_supported_matchstream_player_url(&helpless));
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
                r#"["https://evfancy.link//ch?id=4","https://streamed.pk/api/stream/echo/a","https://example.test/live"]"#,
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
}
