use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use dashmap::DashMap;
use regex::Regex;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use url::Url;

use crate::error::{ApiError, AppResult, json_response};
use crate::routes::AppState;
use crate::utils::now_ms;

const MATCHSTREAM_SCHEDULE_URL: &str = "https://matchstream.do/matchstream/proxy.php";
const MATCHSTREAM_FOOTBALL_CACHE_KEY: &str = "matchstream:football";
const MATCHSTREAM_BASKETBALL_CACHE_KEY: &str = "matchstream:basketball";
const SUPER_LEAGUE_FOOTBALL_URL: &str = "https://super.league.st/index.php?sport=Football";
const SUPER_LEAGUE_BASKETBALL_URL: &str = "https://super.league.st/index.php?sport=Basketball";
const STREAMED_FOOTBALL_MATCHES_URL: &str = "https://streamed.pk/api/matches/football";
const STREAMED_FOOTBALL_REFERER: &str = "https://livsport.dpdns.org/sport?id=football";
const STREAMED_FOOTBALL_DEFAULT_DURATION_MINUTES: i64 = 180;
const SUPER_LEAGUE_STREAM_USER_AGENT: &str = "Mozilla/5.0";
const MAX_LIVE_STREAM_CANDIDATES: usize = 6;
const LIVE_STREAM_PREFLIGHT_TIMEOUT_MS: u64 = 4_000;
const SPORTS_SCHEDULE_CACHE_TTL_MS: i64 = 6 * 60 * 60 * 1000;
const SPORTS_SCHEDULE_STALE_IF_ERROR_MS: i64 = 24 * 60 * 60 * 1000;
const HIGH_PRIORITY_FOOTBALL_LEAGUES: &[&str] = &[
    "england premier league",
    "england fa cup",
    "england efl cup",
    "england league cup",
    "england community shield",
    "france coupe de france",
    "france ligue 1",
    "france trophee des champions",
    "germany bundesliga",
    "germany dfb pokal",
    "germany super cup",
    "italy coppa italia",
    "italy serie a",
    "italy super cup",
    "spain copa del rey",
    "spain la liga",
    "spain super cup",
    "world club world cup",
    "world cup",
    "world fifa club world cup",
    "world fifa world cup",
];
const HIGH_PRIORITY_FOOTBALL_LEAGUE_KEYWORDS: &[&str] = &[
    "euro qualification",
    "euro qualifiers",
    "fifa club world cup",
    "fifa world cup",
    "uefa champions league",
    "uefa conference league",
    "uefa euro",
    "uefa europa conference league",
    "uefa europa league",
    "uefa nations league",
    "uefa super cup",
    "uefa women s champions league",
    "world cup qualification",
    "world cup qualifiers",
];

#[derive(Debug, Deserialize)]
struct SourceChannel {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    name: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    language: String,
    #[serde(default, deserialize_with = "deserialize_links")]
    links: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SourceMatch {
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
    title: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    time: String,
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
    #[serde(default, deserialize_with = "deserialize_channels")]
    channels: Vec<SourceChannel>,
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
struct MatchStreamSchedulePayload {
    matches: Vec<SourceMatch>,
}

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
pub struct ResolveFootballStreamQuery {
    url: String,
    #[serde(default, rename = "fallbackUrls")]
    fallback_urls: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChannelPlayerResponse {
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct EmbeddedPlayerConfig {
    #[serde(default)]
    stream_url: String,
    #[serde(default)]
    stream_url_nop2p: String,
}

struct ResolvedLiveStream {
    source_url: Url,
    player_page_url: Url,
    playback_url: Url,
    playback_type: &'static str,
    candidate_index: usize,
    attempted_streams: usize,
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
}

impl SportsScheduleCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn fresh(&self, key: &'static str, now: i64) -> Option<Value> {
        self.entries.get(key).and_then(|entry| {
            let cached = entry.value();
            (cache_age_ms(cached.fetched_at_ms, now) <= SPORTS_SCHEDULE_CACHE_TTL_MS)
                .then(|| cached.payload.clone())
        })
    }

    fn stale(&self, key: &'static str, now: i64) -> Option<Value> {
        self.entries.get(key).and_then(|entry| {
            let cached = entry.value();
            (cache_age_ms(cached.fetched_at_ms, now) <= SPORTS_SCHEDULE_STALE_IF_ERROR_MS)
                .then(|| cached.payload.clone())
        })
    }

    fn insert(&self, key: &'static str, payload: Value, fetched_at_ms: i64) {
        self.entries.insert(
            key,
            CachedSportsSchedule {
                payload,
                fetched_at_ms,
            },
        );
    }

    fn lock_for(&self, key: &'static str) -> Arc<Mutex<()>> {
        self.locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

fn cache_age_ms(fetched_at_ms: i64, now: i64) -> i64 {
    if now <= fetched_at_ms {
        0
    } else {
        now - fetched_at_ms
    }
}

fn deserialize_default_on_null<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn deserialize_links<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Vec<Option<String>>>::deserialize(deserializer)?
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect())
}

fn deserialize_channels<'de, D>(deserializer: D) -> Result<Vec<SourceChannel>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<Vec<Option<SourceChannel>>>::deserialize(deserializer)?
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .collect(),
    )
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

pub async fn football_matches_handler(State(state): State<AppState>) -> AppResult<Response<Body>> {
    sports_matches_response(
        &state,
        MATCHSTREAM_FOOTBALL_CACHE_KEY,
        "Football",
        is_high_priority_football_match,
        SUPER_LEAGUE_FOOTBALL_URL,
    )
    .await
}

pub async fn basketball_matches_handler(
    State(state): State<AppState>,
) -> AppResult<Response<Body>> {
    sports_matches_response(
        &state,
        MATCHSTREAM_BASKETBALL_CACHE_KEY,
        "Basketball",
        is_basketball_match,
        SUPER_LEAGUE_BASKETBALL_URL,
    )
    .await
}

async fn sports_matches_response(
    state: &AppState,
    cache_key: &'static str,
    sport_name: &'static str,
    include_match: fn(&SourceMatch) -> bool,
    fallback_source_url: &'static str,
) -> AppResult<Response<Body>> {
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    let schedule_lock = state.sports_schedule_cache.lock_for(cache_key);
    let _guard = schedule_lock.lock().await;
    if let Some(payload) = state.sports_schedule_cache.fresh(cache_key, now_ms()) {
        return Ok(schedule_response(payload, "hit"));
    }

    match fetch_sports_matches_payload(state, sport_name, include_match, fallback_source_url).await
    {
        Ok((payload, fetched_at_ms)) => {
            state
                .sports_schedule_cache
                .insert(cache_key, payload.clone(), fetched_at_ms);
            Ok(schedule_response(payload, "miss"))
        }
        Err(error) => {
            if let Some(payload) = state.sports_schedule_cache.stale(cache_key, now_ms()) {
                return Ok(schedule_response(payload, "stale"));
            }
            Err(error)
        }
    }
}

async fn fetch_sports_matches_payload(
    state: &AppState,
    sport_name: &'static str,
    include_match: fn(&SourceMatch) -> bool,
    fallback_source_url: &'static str,
) -> AppResult<(Value, i64)> {
    if sport_name == "Football" {
        return fetch_combined_football_matches_payload(state, include_match, fallback_source_url)
            .await;
    }

    fetch_legacy_sports_matches_payload(state, sport_name, include_match, fallback_source_url).await
}

async fn fetch_combined_football_matches_payload(
    state: &AppState,
    include_match: fn(&SourceMatch) -> bool,
    fallback_source_url: &'static str,
) -> AppResult<(Value, i64)> {
    let legacy_future =
        fetch_legacy_sports_matches_payload(state, "Football", include_match, fallback_source_url);
    let streamed_future = fetch_streamed_football_matches_payload(state);
    let (legacy_result, streamed_result) = tokio::join!(legacy_future, streamed_future);

    match (legacy_result, streamed_result) {
        (
            Ok((legacy_payload, legacy_fetched_at_ms)),
            Ok((streamed_payload, streamed_fetched_at_ms)),
        ) => {
            let fetched_at_ms = legacy_fetched_at_ms.max(streamed_fetched_at_ms);
            Ok((
                merge_football_match_payloads(legacy_payload, streamed_payload, fetched_at_ms),
                fetched_at_ms,
            ))
        }
        (Ok(payload), Err(_streamed_error)) => Ok(payload),
        (Err(_legacy_error), Ok(payload)) => Ok(payload),
        (Err(legacy_error), Err(streamed_error)) => Err(ApiError::bad_gateway(format!(
            "Failed to fetch Football schedule from legacy providers ({}) and Streamed ({}).",
            legacy_error.message().unwrap_or("unknown error"),
            streamed_error.message().unwrap_or("unknown error")
        ))),
    }
}

async fn fetch_legacy_sports_matches_payload(
    state: &AppState,
    sport_name: &'static str,
    include_match: fn(&SourceMatch) -> bool,
    fallback_source_url: &'static str,
) -> AppResult<(Value, i64)> {
    match fetch_matchstream_matches_payload(state, sport_name, include_match).await {
        Ok(payload) => Ok(payload),
        Err(matchstream_error) => {
            match fetch_super_league_matches_payload(
                state,
                fallback_source_url,
                sport_name,
                include_match,
            )
            .await
            {
                Ok(payload) => Ok(payload),
                Err(super_league_error) => Err(ApiError::bad_gateway(format!(
                    "Failed to fetch {sport_name} schedule from MatchStream ({}) and Super League ({}).",
                    matchstream_error.message().unwrap_or("unknown error"),
                    super_league_error.message().unwrap_or("unknown error")
                ))),
            }
        }
    }
}

async fn fetch_matchstream_matches_payload(
    state: &AppState,
    sport_name: &'static str,
    include_match: fn(&SourceMatch) -> bool,
) -> AppResult<(Value, i64)> {
    let response = state
        .http_client
        .get(MATCHSTREAM_SCHEDULE_URL)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout(format!("Timed out fetching {sport_name} schedule."))
            } else {
                ApiError::bad_gateway(format!("Failed to fetch {sport_name} schedule: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "{sport_name} schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let payload = response.text().await.map_err(|error| {
        ApiError::bad_gateway(format!("Failed to read {sport_name} schedule: {error}"))
    })?;
    let source_matches = parse_matchstream_matches_payload(&payload, sport_name)?;
    Ok(build_sports_matches_payload(
        MATCHSTREAM_SCHEDULE_URL,
        sport_name,
        include_match,
        source_matches,
    ))
}

async fn fetch_super_league_matches_payload(
    state: &AppState,
    source_url: &'static str,
    sport_name: &'static str,
    include_match: fn(&SourceMatch) -> bool,
) -> AppResult<(Value, i64)> {
    let response = state
        .http_client
        .get(source_url)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout(format!("Timed out fetching {sport_name} schedule."))
            } else {
                ApiError::bad_gateway(format!("Failed to fetch {sport_name} schedule: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "{sport_name} schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let html = response.text().await.map_err(|error| {
        ApiError::bad_gateway(format!("Failed to read {sport_name} schedule: {error}"))
    })?;
    let source_matches = extract_source_matches(&html, sport_name)?;
    Ok(build_sports_matches_payload(
        source_url,
        sport_name,
        include_match,
        source_matches,
    ))
}

async fn fetch_streamed_football_matches_payload(state: &AppState) -> AppResult<(Value, i64)> {
    let response = state
        .http_client
        .get(STREAMED_FOOTBALL_MATCHES_URL)
        .header(reqwest::header::USER_AGENT, SUPER_LEAGUE_STREAM_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_FOOTBALL_REFERER)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out fetching Streamed football schedule.")
            } else {
                ApiError::bad_gateway(format!(
                    "Failed to fetch Streamed football schedule: {error}"
                ))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Streamed football schedule returned HTTP {}.",
            response.status(),
        )));
    }

    let source_matches = response
        .json::<Vec<StreamedMatch>>()
        .await
        .map_err(|error| {
            ApiError::bad_gateway(format!(
                "Failed to parse Streamed football schedule: {error}"
            ))
        })?;
    Ok(build_streamed_football_matches_payload(source_matches))
}

fn build_sports_matches_payload(
    source_url: &'static str,
    sport_name: &'static str,
    include_match: fn(&SourceMatch) -> bool,
    source_matches: Vec<SourceMatch>,
) -> (Value, i64) {
    let now = now_ms();
    let matches: Vec<_> = source_matches
        .into_iter()
        .filter(|match_item| {
            match_item.start_timestamp > 0
                && match_item.duration > 0
                && !match_item.slug.trim().is_empty()
                && include_match(match_item)
                && match_item
                    .start_timestamp
                    .saturating_add(match_item.duration.saturating_mul(60_000))
                    > now
        })
        .map(normalize_match)
        .collect();
    let fetched_at_ms = now_ms();

    (
        json!({
            "source": source_url,
            "sport": sport_name,
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

fn build_streamed_football_matches_payload(source_matches: Vec<StreamedMatch>) -> (Value, i64) {
    let now = now_ms();
    let matches = source_matches
        .into_iter()
        .filter(|match_item| {
            match_item.date > 0
                && !match_item.title.trim().is_empty()
                && !match_item.sources.is_empty()
                && match_item.date.saturating_add(
                    STREAMED_FOOTBALL_DEFAULT_DURATION_MINUTES.saturating_mul(60_000),
                ) > now
        })
        .map(normalize_streamed_football_match)
        .collect::<Vec<_>>();
    let fetched_at_ms = now_ms();

    (
        json!({
            "source": STREAMED_FOOTBALL_MATCHES_URL,
            "sport": "Football",
            "fetchedAt": fetched_at_ms,
            "matches": matches
        }),
        fetched_at_ms,
    )
}

fn merge_football_match_payloads(
    legacy_payload: Value,
    streamed_payload: Value,
    fetched_at_ms: i64,
) -> Value {
    let mut matches = Vec::<Value>::new();
    let mut match_indexes = std::collections::BTreeMap::<String, usize>::new();

    append_football_payload_matches(&mut matches, &mut match_indexes, &legacy_payload);
    append_football_payload_matches(&mut matches, &mut match_indexes, &streamed_payload);
    matches.sort_by_key(|match_item| {
        match_item
            .get("startTimestamp")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });

    json!({
        "source": "combined",
        "sources": [
            STREAMED_FOOTBALL_MATCHES_URL,
            legacy_payload.get("source").and_then(Value::as_str).unwrap_or_default()
        ],
        "sport": "Football",
        "fetchedAt": fetched_at_ms,
        "matches": matches
    })
}

fn append_football_payload_matches(
    matches: &mut Vec<Value>,
    match_indexes: &mut std::collections::BTreeMap<String, usize>,
    payload: &Value,
) {
    let Some(payload_matches) = payload.get("matches").and_then(Value::as_array) else {
        return;
    };

    for match_item in payload_matches {
        let Some(merge_key) = football_match_merge_key(match_item) else {
            matches.push(match_item.clone());
            continue;
        };
        if let Some(existing_index) = match_indexes.get(&merge_key).copied() {
            merge_football_match_streams(&mut matches[existing_index], match_item);
        } else {
            match_indexes.insert(merge_key, matches.len());
            matches.push(match_item.clone());
        }
    }
}

fn football_match_merge_key(match_item: &Value) -> Option<String> {
    let title = normalize_football_league_name(match_item.get("title")?.as_str()?);
    if title.is_empty() {
        return None;
    }
    let start_timestamp = match_item.get("startTimestamp")?.as_i64()?;
    Some(format!("{start_timestamp}:{title}"))
}

fn merge_football_match_streams(existing: &mut Value, incoming: &Value) {
    let Some(existing_object) = existing.as_object_mut() else {
        return;
    };
    let prefer_incoming = is_streamed_match_payload(incoming);

    let existing_streams = existing_object
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_streams = incoming.get("streams").and_then(Value::as_array);
    let mut streams = Vec::new();
    let mut seen_stream_sources = BTreeSet::new();
    if prefer_incoming {
        if let Some(incoming_streams) = incoming_streams {
            for stream in incoming_streams {
                push_unique_football_stream(&mut streams, &mut seen_stream_sources, stream);
            }
        }
        for stream in &existing_streams {
            push_unique_football_stream(&mut streams, &mut seen_stream_sources, stream);
        }
    } else {
        for stream in &existing_streams {
            push_unique_football_stream(&mut streams, &mut seen_stream_sources, stream);
        }
        if let Some(incoming_streams) = incoming_streams {
            for stream in incoming_streams {
                push_unique_football_stream(&mut streams, &mut seen_stream_sources, stream);
            }
        }
    }
    existing_object.insert("linkCount".to_owned(), json!(streams.len()));
    existing_object.insert("streams".to_owned(), Value::Array(streams));

    let existing_channels = existing_object
        .get("channels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_channels = incoming.get("channels").and_then(Value::as_array);
    let mut channels = Vec::new();
    let mut seen_channels = BTreeSet::new();
    if prefer_incoming {
        if let Some(incoming_channels) = incoming_channels {
            for channel in incoming_channels {
                push_unique_football_channel(&mut channels, &mut seen_channels, channel);
            }
        }
        for channel in &existing_channels {
            push_unique_football_channel(&mut channels, &mut seen_channels, channel);
        }
    } else {
        for channel in &existing_channels {
            push_unique_football_channel(&mut channels, &mut seen_channels, channel);
        }
        if let Some(incoming_channels) = incoming_channels {
            for channel in incoming_channels {
                push_unique_football_channel(&mut channels, &mut seen_channels, channel);
            }
        }
    }
    existing_object.insert("channelCount".to_owned(), json!(channels.len()));
    existing_object.insert("channels".to_owned(), Value::Array(channels));

    let mut languages = existing_object
        .get("languages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    if let Some(incoming_languages) = incoming.get("languages").and_then(Value::as_array) {
        languages.extend(
            incoming_languages
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
    }
    existing_object.insert(
        "languages".to_owned(),
        Value::Array(languages.into_iter().map(Value::String).collect()),
    );
}

fn is_streamed_match_payload(match_item: &Value) -> bool {
    if match_item
        .get("provider")
        .and_then(Value::as_str)
        .map(|provider| provider.eq_ignore_ascii_case("streamed"))
        .unwrap_or(false)
    {
        return true;
    }

    match_item
        .get("streams")
        .and_then(Value::as_array)
        .map(|streams| {
            streams.iter().any(|stream| {
                stream
                    .get("source")
                    .and_then(Value::as_str)
                    .map(is_streamed_stream_source)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn is_streamed_stream_source(source: &str) -> bool {
    Url::parse(source.trim())
        .map(|url| is_streamed_stream_api_url(&url))
        .unwrap_or(false)
}

fn push_unique_football_stream(
    streams: &mut Vec<Value>,
    seen_sources: &mut BTreeSet<String>,
    stream: &Value,
) {
    let Some(source) = stream.get("source").and_then(Value::as_str) else {
        return;
    };
    if seen_sources.insert(source.to_owned()) {
        streams.push(stream.clone());
    }
}

fn push_unique_football_channel(
    channels: &mut Vec<Value>,
    seen_channels: &mut BTreeSet<String>,
    channel: &Value,
) {
    let key = format!(
        "{}:{}",
        channel
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        channel
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or_default()
    );
    if seen_channels.insert(key) {
        channels.push(channel.clone());
    }
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
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    super_league_stream_resolve_response(&state, query).await
}

pub async fn basketball_stream_resolve_handler(
    State(state): State<AppState>,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    super_league_stream_resolve_response(&state, query).await
}

async fn super_league_stream_resolve_response(
    state: &AppState,
    query: ResolveFootballStreamQuery,
) -> AppResult<Response<Body>> {
    let candidates = live_stream_source_candidates(&query.url, query.fallback_urls.as_deref())?;
    let mut errors = Vec::new();

    for (candidate_index, source_url) in candidates.iter().enumerate() {
        match resolve_verified_live_stream(state, source_url, candidate_index).await {
            Ok(resolved) => {
                let playback_url_text = resolved.playback_url.to_string();
                return Ok(json_response(json!({
                    "source": resolved.source_url.as_str(),
                    "playerPage": resolved.player_page_url.as_str(),
                    "playbackType": resolved.playback_type,
                    "playbackUrl": playback_url_text,
                    "streamUrl": if resolved.playback_type == "hls" { playback_url_text.as_str() } else { "" },
                    "embedUrl": if resolved.playback_type == "iframe" { playback_url_text.as_str() } else { "" },
                    "resolvedFromFallback": resolved.candidate_index > 0,
                    "attemptedStreams": resolved.attempted_streams
                })));
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
        "No working live stream found after checking {checked} source(s).{latest_error}"
    )))
}

async fn resolve_verified_live_stream(
    state: &AppState,
    source_url: &Url,
    candidate_index: usize,
) -> AppResult<ResolvedLiveStream> {
    if is_streamed_stream_api_url(source_url) {
        return resolve_verified_streamed_live_stream(state, source_url, candidate_index).await;
    }

    let player_page_url = resolve_embed_player_page_url(state, source_url).await?;
    let stream_url = resolve_player_hls_url(state, &player_page_url, source_url.as_str()).await?;
    preflight_hls_stream_url(state, &stream_url, player_page_url.as_str()).await?;
    Ok(ResolvedLiveStream {
        source_url: source_url.clone(),
        player_page_url,
        playback_url: stream_url,
        playback_type: "hls",
        candidate_index,
        attempted_streams: candidate_index + 1,
    })
}

async fn resolve_verified_streamed_live_stream(
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
        return Ok(ResolvedLiveStream {
            source_url: source_url.clone(),
            player_page_url: embed_url.clone(),
            playback_url: embed_url,
            playback_type: "iframe",
            candidate_index,
            attempted_streams: candidate_index + 1,
        });
    }

    let latest_error = errors
        .last()
        .map(|error| format!(" Last error: {error}"))
        .unwrap_or_default();
    Err(ApiError::bad_gateway(format!(
        "No playable Streamed embed found.{latest_error}"
    )))
}

fn live_stream_source_candidates(
    primary_url: &str,
    fallback_urls: Option<&str>,
) -> AppResult<Vec<Url>> {
    let primary = Url::parse(primary_url.trim())
        .map_err(|_| ApiError::bad_request("Invalid live stream URL."))?;
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
        push_unique_stream_candidate(&mut candidates, &mut seen, parsed);
    }

    Ok(candidates)
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
    let response = state
        .http_client
        .get(source_url.clone())
        .header(reqwest::header::USER_AGENT, SUPER_LEAGUE_STREAM_USER_AGENT)
        .header(reqwest::header::REFERER, STREAMED_FOOTBALL_REFERER)
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

async fn preflight_hls_stream_url(
    state: &AppState,
    stream_url: &Url,
    referer: &str,
) -> AppResult<()> {
    let response = state
        .http_client
        .get(stream_url.clone())
        .header(reqwest::header::USER_AGENT, SUPER_LEAGUE_STREAM_USER_AGENT)
        .header(reqwest::header::REFERER, referer)
        .timeout(Duration::from_millis(LIVE_STREAM_PREFLIGHT_TIMEOUT_MS))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out checking live HLS playlist.")
            } else {
                ApiError::bad_gateway(format!("Failed to check live HLS playlist: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS playlist returned HTTP {}.",
            response.status()
        )));
    }

    let final_url = response.url().clone();
    if !is_supported_hls_stream_url(&final_url) {
        return Err(ApiError::bad_gateway(
            "Live HLS playlist redirected to an unsupported URL.",
        ));
    }

    let playlist = response.text().await.map_err(|error| {
        ApiError::bad_gateway(format!("Failed to read live HLS playlist: {error}"))
    })?;
    if !playlist.trim_start().starts_with("#EXTM3U") {
        return Err(ApiError::bad_gateway(
            "Live HLS playlist response was not valid HLS.",
        ));
    }
    Ok(())
}

async fn resolve_embed_player_page_url(state: &AppState, source_url: &Url) -> AppResult<Url> {
    match source_url.host_str().unwrap_or_default() {
        "glisco.link" | "www.glisco.link" | "sansat.link" | "www.sansat.link" => {
            resolve_channel_player_page_url(state, source_url).await
        }
        "helpless.click" | "www.helpless.click" | "wilderness.click" | "www.wilderness.click" => {
            if source_url.path().starts_with("/e/") {
                Ok(source_url.clone())
            } else {
                Err(ApiError::bad_request("Unsupported live stream page."))
            }
        }
        _ => Err(ApiError::bad_request("Unsupported live stream host.")),
    }
}

async fn resolve_channel_player_page_url(state: &AppState, source_url: &Url) -> AppResult<Url> {
    if source_url.path() != "/ch" {
        return Err(ApiError::bad_request("Unsupported live stream page."));
    }
    let Some(id) = source_url
        .query_pairs()
        .find_map(|(key, value)| (key == "id").then(|| value.into_owned()))
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(ApiError::bad_request("Missing live stream id."));
    };

    let api_origin = match source_url.host_str().unwrap_or_default() {
        "glisco.link" | "www.glisco.link" => "https://glisco.link",
        "sansat.link" | "www.sansat.link" => "https://sansat.link",
        _ => return Err(ApiError::bad_request("Unsupported live stream host.")),
    };
    let api_url = Url::parse_with_params(&format!("{api_origin}/api/player.php"), [("id", id)])
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let response = state
        .http_client
        .get(api_url)
        .header(reqwest::header::USER_AGENT, SUPER_LEAGUE_STREAM_USER_AGENT)
        .header(reqwest::header::REFERER, source_url.as_str())
        .send()
        .await
        .map_err(|error| {
            ApiError::bad_gateway(format!("Failed to resolve stream page: {error}"))
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Stream page resolver returned HTTP {}.",
            response.status()
        )));
    }

    let payload = response
        .json::<ChannelPlayerResponse>()
        .await
        .map_err(|error| ApiError::bad_gateway(format!("Invalid stream page response: {error}")))?;
    let player_page_url = Url::parse(payload.url.trim())
        .map_err(|_| ApiError::bad_gateway("Stream page response did not include a valid URL."))?;
    if !is_supported_embedded_player_url(&player_page_url) {
        return Err(ApiError::bad_gateway(
            "Stream page resolver returned an unsupported player host.",
        ));
    }
    Ok(player_page_url)
}

async fn resolve_player_hls_url(
    state: &AppState,
    player_page_url: &Url,
    referer: &str,
) -> AppResult<Url> {
    if !is_supported_embedded_player_url(player_page_url) {
        return Err(ApiError::bad_request("Unsupported live stream player."));
    }

    let response = state
        .http_client
        .get(player_page_url.clone())
        .header(reqwest::header::USER_AGENT, SUPER_LEAGUE_STREAM_USER_AGENT)
        .header(reqwest::header::REFERER, referer)
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway(format!("Failed to load stream player: {error}")))?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Stream player returned HTTP {}.",
            response.status()
        )));
    }

    let html = response
        .text()
        .await
        .map_err(|error| ApiError::bad_gateway(format!("Failed to read stream player: {error}")))?;
    let config = extract_embedded_player_config(&html)?;
    let stream_url = if config.stream_url.trim().is_empty() {
        config.stream_url_nop2p.trim()
    } else {
        config.stream_url.trim()
    };
    let parsed_stream_url = Url::parse(stream_url)
        .map_err(|_| ApiError::bad_gateway("Stream player did not include a valid HLS URL."))?;
    if !is_supported_hls_stream_url(&parsed_stream_url) {
        return Err(ApiError::bad_gateway(
            "Stream player returned an unsupported HLS URL.",
        ));
    }
    Ok(parsed_stream_url)
}

fn is_supported_embedded_player_url(url: &Url) -> bool {
    matches!(
        url.host_str().unwrap_or_default(),
        "helpless.click" | "www.helpless.click" | "wilderness.click" | "www.wilderness.click"
    ) && url.path().starts_with("/e/")
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

fn extract_embedded_player_config(html: &str) -> AppResult<EmbeddedPlayerConfig> {
    static CONFIG_RE: OnceLock<Regex> = OnceLock::new();
    let regex = CONFIG_RE.get_or_init(|| {
        Regex::new(r#"window\._econfig='([^']+)'"#).expect("valid player config regex")
    });
    let encoded = regex
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
        .ok_or_else(|| ApiError::bad_gateway("Stream player did not include playback config."))?;
    decode_embedded_player_config(encoded)
}

fn decode_embedded_player_config(encoded: &str) -> AppResult<EmbeddedPlayerConfig> {
    let decoded = decode_base64_utf8(encoded)?;
    let chunk_size = decoded.len().div_ceil(4);
    let order = [2_usize, 0, 3, 1];
    let mut chunks = Vec::with_capacity(4);
    let mut offset = 0_usize;
    for _ in 0..4 {
        let end = offset.saturating_add(chunk_size).min(decoded.len());
        chunks.push(decoded[offset..end].to_owned());
        offset = end;
    }

    let mut reordered = vec![String::new(); 4];
    for (index, target_index) in order.iter().copied().enumerate() {
        let chunk = chunks.get(index).map(String::as_str).unwrap_or_default();
        let cleaned = remove_config_noise_char(chunk);
        reordered[target_index] = decode_base64_utf8(&cleaned)?;
    }

    let config_json = decode_base64_utf8(&reordered.join(""))?;
    serde_json::from_str::<EmbeddedPlayerConfig>(&config_json)
        .map_err(|error| ApiError::bad_gateway(format!("Invalid stream player config: {error}")))
}

fn remove_config_noise_char(value: &str) -> String {
    value
        .chars()
        .enumerate()
        .filter_map(|(index, ch)| (index != 3).then_some(ch))
        .collect()
}

fn decode_base64_utf8(value: &str) -> AppResult<String> {
    let mut normalized = value.trim().to_owned();
    while !normalized.len().is_multiple_of(4) {
        normalized.push('=');
    }
    let bytes = BASE64_STANDARD
        .decode(normalized.as_bytes())
        .map_err(|error| {
            ApiError::bad_gateway(format!("Invalid stream config encoding: {error}"))
        })?;
    String::from_utf8(bytes)
        .map_err(|error| ApiError::bad_gateway(format!("Invalid stream config text: {error}")))
}

fn is_supported_hls_stream_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    url.path().to_lowercase().ends_with(".m3u8")
}

fn parse_matchstream_matches_payload(
    payload: &str,
    sport_name: &str,
) -> AppResult<Vec<SourceMatch>> {
    serde_json::from_str::<MatchStreamSchedulePayload>(payload)
        .map(|schedule| schedule.matches)
        .map_err(|error| {
            ApiError::bad_gateway(format!("Failed to parse {sport_name} schedule: {error}"))
        })
}

fn extract_source_matches(html: &str, sport_name: &str) -> AppResult<Vec<SourceMatch>> {
    static MATCHES_RE: OnceLock<Regex> = OnceLock::new();
    let regex = MATCHES_RE.get_or_init(|| {
        Regex::new(r#"window\.matches\s*=\s*JSON\.parse\(`([\s\S]*?)`\)"#)
            .expect("valid source matches regex")
    });
    let raw_matches = regex
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
        .ok_or_else(|| {
            ApiError::bad_gateway(format!("{sport_name} schedule did not include match data."))
        })?;

    serde_json::from_str::<Vec<SourceMatch>>(raw_matches).map_err(|error| {
        ApiError::bad_gateway(format!("Failed to parse {sport_name} schedule: {error}"))
    })
}

fn is_high_priority_football_match(match_item: &SourceMatch) -> bool {
    let sport = match_item.sport.trim();
    if !sport.is_empty() && !sport.eq_ignore_ascii_case("Football") {
        return false;
    }

    is_high_priority_football_league(&match_item.league)
}

fn is_basketball_match(match_item: &SourceMatch) -> bool {
    let sport = match_item.sport.trim();
    sport.is_empty() || sport.eq_ignore_ascii_case("Basketball")
}

fn is_high_priority_football_league(league: &str) -> bool {
    let normalized_league = normalize_football_league_name(league);
    if HIGH_PRIORITY_FOOTBALL_LEAGUES
        .iter()
        .any(|important_league| normalized_league == *important_league)
    {
        return true;
    }

    HIGH_PRIORITY_FOOTBALL_LEAGUE_KEYWORDS
        .iter()
        .any(|important_league| normalized_league.contains(important_league))
}

fn normalize_football_league_name(league: &str) -> String {
    league
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_streamed_football_match(match_item: StreamedMatch) -> serde_json::Value {
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
        "Football".to_owned()
    } else {
        title_case_ascii(match_item.category.trim())
    };
    let streams = match_item
        .sources
        .iter()
        .enumerate()
        .filter_map(|(index, source)| {
            let source_name = source.source.trim();
            let source_id = source.id.trim();
            if source_name.is_empty() || source_id.is_empty() {
                return None;
            }
            let source_url = format!("https://streamed.pk/api/stream/{source_name}/{source_id}");
            let display_source = title_case_ascii(source_name);
            Some(json!({
                "id": format!("streamed-{source_name}-{index}"),
                "label": format!("Streamed {display_source}"),
                "source": source_url,
                "quality": "HD"
            }))
        })
        .collect::<Vec<_>>();
    let channels = match_item
        .sources
        .iter()
        .filter_map(|source| {
            let source_name = source.source.trim();
            if source_name.is_empty() {
                return None;
            }
            Some(json!({
                "name": format!("Streamed {}", title_case_ascii(source_name)),
                "language": "HD",
                "linkCount": 1
            }))
        })
        .collect::<Vec<_>>();
    let ends_at_timestamp = match_item
        .date
        .saturating_add(STREAMED_FOOTBALL_DEFAULT_DURATION_MINUTES.saturating_mul(60_000));

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
        "durationMinutes": STREAMED_FOOTBALL_DEFAULT_DURATION_MINUTES,
        "linkCount": streams.len(),
        "channelCount": channels.len(),
        "channels": channels,
        "streams": streams,
        "languages": ["HD"],
        "provider": "streamed"
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

fn normalize_match(match_item: SourceMatch) -> serde_json::Value {
    let link_count = match_item
        .channels
        .iter()
        .map(|channel| channel.links.len())
        .sum::<usize>();
    let channels = match_item
        .channels
        .iter()
        .map(|channel| {
            json!({
                "name": channel.name.as_str(),
                "language": channel.language.as_str(),
                "linkCount": channel.links.len()
            })
        })
        .collect::<Vec<_>>();
    let streams = match_item
        .channels
        .iter()
        .enumerate()
        .flat_map(|(channel_index, channel)| {
            channel
                .links
                .iter()
                .enumerate()
                .filter_map(move |(link_index, source)| {
                    let source = source.trim();
                    if source.is_empty() {
                        return None;
                    }
                    let channel_name = channel.name.trim();
                    let label = if channel_name.is_empty() {
                        format!("Stream {}", link_index + 1)
                    } else {
                        format!("{channel_name} #{}", link_index + 1)
                    };
                    let quality = channel.language.trim();
                    Some(json!({
                        "id": format!("channel-{channel_index}-stream-{link_index}"),
                        "label": label,
                        "source": source,
                        "quality": quality
                    }))
                })
        })
        .collect::<Vec<_>>();
    let languages = match_item
        .channels
        .iter()
        .filter_map(|channel| {
            let language = channel.language.trim();
            if language.is_empty() {
                None
            } else {
                Some(language.to_owned())
            }
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let ends_at_timestamp = match_item
        .start_timestamp
        .saturating_add(match_item.duration.saturating_mul(60_000));

    json!({
        "id": match_item.slug,
        "title": match_item.title,
        "matchText": match_item.match_text,
        "sourceDisplayTime": match_item.time,
        "league": match_item.league,
        "sport": match_item.sport,
        "team1": match_item.team1,
        "team2": match_item.team2,
        "primaryChannel": match_item.channel,
        "important": match_item.important,
        "sourceMatchDate": match_item.match_date,
        "startTimestamp": match_item.start_timestamp,
        "endsAtTimestamp": ends_at_timestamp,
        "durationMinutes": match_item.duration,
        "linkCount": link_count,
        "channelCount": match_item.channels.len(),
        "channels": channels,
        "streams": streams,
        "languages": languages
    })
}

#[cfg(test)]
mod tests {
    use super::{
        MATCHSTREAM_SCHEDULE_URL, MAX_LIVE_STREAM_CANDIDATES, SPORTS_SCHEDULE_CACHE_TTL_MS,
        SPORTS_SCHEDULE_STALE_IF_ERROR_MS, STREAMED_FOOTBALL_MATCHES_URL, SourceChannel,
        SourceMatch, SportsScheduleCache, StreamedMatch, StreamedSource, StreamedTeam,
        StreamedTeams, build_sports_matches_payload, build_streamed_football_matches_payload,
        extract_source_matches, is_basketball_match, is_high_priority_football_match,
        live_stream_source_candidates, merge_football_match_payloads, parse_fallback_stream_urls,
        parse_matchstream_matches_payload,
    };
    use crate::utils::now_ms;
    use serde_json::json;

    #[test]
    fn extracts_embedded_matches_json() {
        let html = r#"
            <script>
              window.matches = JSON.parse(`[{"matchstr":"A vs B","slug":"a-b","startTimestamp":1000,"duration":120,"channels":[{"name":"One","language":"GB","links":["https://example.test/1"]}]}]`);
            </script>
        "#;
        let matches = extract_source_matches(html, "Football").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].title, "A vs B");
        assert_eq!(matches[0].channels[0].links.len(), 1);
    }

    #[test]
    fn treats_provider_nulls_as_missing_values() {
        let html = r#"
            <script>
              window.matches = JSON.parse(`[{"matchstr":"A vs B","team1":"A","team2":null,"channel":null,"important":null,"matchDate":null,"slug":"a-b","startTimestamp":1000,"duration":120,"channels":[null,{"name":null,"language":null,"links":["https://example.test/1",null]}]}]`);
            </script>
        "#;
        let matches = extract_source_matches(html, "Football").unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].team2, "");
        assert_eq!(matches[0].channel, "");
        assert!(!matches[0].important);
        assert_eq!(matches[0].match_date, "");
        assert_eq!(matches[0].channels.len(), 1);
        assert_eq!(matches[0].channels[0].name, "");
        assert_eq!(matches[0].channels[0].language, "");
        assert_eq!(
            matches[0].channels[0].links,
            vec!["https://example.test/1".to_owned()]
        );
    }

    #[test]
    fn parses_matchstream_proxy_payload() {
        let payload = r#"{
            "matches": [{
                "matchText": "03:00 [NBA] Basketball: A vs B [ABC US]",
                "matchstr": "A vs B",
                "time": "03:00",
                "league": "NBA",
                "sport": "Basketball",
                "team1": "A",
                "team2": "B",
                "channel": "ABC US",
                "important": false,
                "matchDate": "2026-05-24",
                "channels": [{
                    "name": "ABC",
                    "oldLinks": ["https://nrdrse.link/ch.php?id=1"],
                    "number": 1,
                    "language": "US",
                    "links": ["https://glisco.link/ch?id=1", "https://sansat.link/ch?id=1"]
                }],
                "slug": "nba-basketball-a-b-2026-05-24-03-00",
                "startTimestamp": 1779580800000,
                "duration": 180
            }]
        }"#;

        let matches = parse_matchstream_matches_payload(payload, "Basketball").unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].title, "A vs B");
        assert_eq!(matches[0].channels[0].name, "ABC");
        assert_eq!(
            matches[0].channels[0].links,
            vec![
                "https://glisco.link/ch?id=1".to_owned(),
                "https://sansat.link/ch?id=1".to_owned(),
            ]
        );
    }

    #[test]
    fn parses_live_stream_fallback_urls_from_json() {
        let urls = parse_fallback_stream_urls(Some(
            r#"["https://glisco.link/ch?id=2","https://sansat.link/ch?id=2"]"#,
        ))
        .unwrap();

        assert_eq!(
            urls,
            vec![
                "https://glisco.link/ch?id=2".to_owned(),
                "https://sansat.link/ch?id=2".to_owned(),
            ]
        );
    }

    #[test]
    fn builds_unique_limited_live_stream_candidates() {
        let fallback_urls = [
            "https://glisco.link/ch?id=1",
            "https://sansat.link/ch?id=1",
            "bad-url",
            "https://glisco.link/ch?id=2",
            "https://sansat.link/ch?id=2",
            "https://glisco.link/ch?id=3",
            "https://sansat.link/ch?id=3",
        ]
        .join(",");

        let candidates =
            live_stream_source_candidates("https://glisco.link/ch?id=1", Some(&fallback_urls))
                .unwrap();

        assert_eq!(candidates.len(), MAX_LIVE_STREAM_CANDIDATES);
        assert_eq!(candidates[0].as_str(), "https://glisco.link/ch?id=1");
        assert_eq!(candidates[1].as_str(), "https://sansat.link/ch?id=1");
    }

    #[test]
    fn builds_matchstream_payload_with_normalized_streams() {
        let mut match_item = source_match_with_league("NBA");
        match_item.sport = "Basketball".to_owned();
        match_item.slug = "nba-basketball-a-b".to_owned();
        match_item.start_timestamp = now_ms() + 60_000;
        match_item.duration = 180;
        match_item.channels = vec![SourceChannel {
            name: "ABC".to_owned(),
            language: "US".to_owned(),
            links: vec![
                "https://glisco.link/ch?id=1".to_owned(),
                "https://sansat.link/ch?id=1".to_owned(),
            ],
        }];

        let (payload, _) = build_sports_matches_payload(
            MATCHSTREAM_SCHEDULE_URL,
            "Basketball",
            is_basketball_match,
            vec![match_item],
        );
        let matches = payload["matches"].as_array().unwrap();

        assert_eq!(payload["source"], MATCHSTREAM_SCHEDULE_URL);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["linkCount"], 2);
        assert_eq!(
            matches[0]["streams"][0]["source"],
            "https://glisco.link/ch?id=1"
        );
        assert_eq!(
            matches[0]["streams"][1]["source"],
            "https://sansat.link/ch?id=1"
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
    fn merges_streamed_streams_first_into_matching_legacy_match() {
        let legacy_payload = json!({
            "source": "legacy",
            "sport": "Football",
            "matches": [{
                "id": "legacy-a-b",
                "title": "A vs B",
                "startTimestamp": 1000,
                "linkCount": 1,
                "channelCount": 1,
                "streams": [{
                    "id": "legacy-1",
                    "label": "Legacy",
                    "source": "https://glisco.link/ch?id=1",
                    "quality": "GB"
                }],
                "channels": [{
                    "name": "Legacy",
                    "language": "GB",
                    "linkCount": 1
                }],
                "languages": ["GB"]
            }]
        });
        let streamed_payload = json!({
            "source": STREAMED_FOOTBALL_MATCHES_URL,
            "sport": "Football",
            "matches": [{
                "id": "streamed-a-b",
                "title": "A vs B",
                "startTimestamp": 1000,
                "linkCount": 1,
                "channelCount": 1,
                "streams": [{
                    "id": "streamed-1",
                    "label": "Streamed Admin",
                    "source": "https://streamed.pk/api/stream/admin/a-b",
                    "quality": "HD"
                }],
                "channels": [{
                    "name": "Streamed Admin",
                    "language": "HD",
                    "linkCount": 1
                }],
                "languages": ["HD"]
            }]
        });

        let merged = merge_football_match_payloads(legacy_payload, streamed_payload, 2_000);
        let matches = merged["matches"].as_array().unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["linkCount"], 2);
        assert_eq!(matches[0]["streams"].as_array().unwrap().len(), 2);
        assert_eq!(
            matches[0]["streams"][0]["source"],
            "https://streamed.pk/api/stream/admin/a-b"
        );
        assert_eq!(
            matches[0]["streams"][1]["source"],
            "https://glisco.link/ch?id=1"
        );
        assert_eq!(matches[0]["channels"][0]["name"], "Streamed Admin");
        assert_eq!(matches[0]["languages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn sports_schedule_cache_reuses_fresh_entries_and_expires_later() {
        let cache = SportsScheduleCache::new();
        cache.insert("football", json!({ "sport": "Football" }), 1_000);

        assert_eq!(
            cache
                .fresh("football", 1_000 + SPORTS_SCHEDULE_CACHE_TTL_MS)
                .unwrap()["sport"],
            "Football"
        );
        assert!(
            cache
                .fresh("football", 1_000 + SPORTS_SCHEDULE_CACHE_TTL_MS + 1)
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
    fn keeps_high_priority_football_competitions() {
        for league in [
            "England Premier League",
            "Spain La Liga",
            "Italy Serie A",
            "Germany Bundesliga",
            "France Ligue 1",
            "Germany DFB Pokal",
            "Europe UEFA Women's Champions League",
            "World FIFA World Cup",
        ] {
            assert!(
                is_high_priority_football_match(&source_match_with_league(league)),
                "{league} should be visible"
            );
        }
    }

    #[test]
    fn drops_lower_priority_football_competitions() {
        for league in [
            "South America Copa Libertadores",
            "South America Copa Sudamericana",
            "Belgium Pro League",
            "Netherlands Eredivisie",
            "Switzerland Super League",
            "Germany Bundesliga 2",
            "England Championship",
            "USA/Canada Major League Soccer",
        ] {
            assert!(
                !is_high_priority_football_match(&source_match_with_league(league)),
                "{league} should be hidden"
            );
        }
    }

    #[test]
    fn ignores_non_football_sports() {
        let mut match_item = source_match_with_league("England Premier League");
        match_item.sport = "Basketball".to_owned();

        assert!(!is_high_priority_football_match(&match_item));
    }

    #[test]
    fn keeps_basketball_sport_matches() {
        let mut match_item = source_match_with_league("NBA");
        match_item.sport = "Basketball".to_owned();

        assert!(is_basketball_match(&match_item));
    }

    #[test]
    fn basketball_filter_ignores_other_sports() {
        let match_item = source_match_with_league("England Premier League");

        assert!(!is_basketball_match(&match_item));
    }

    fn source_match_with_league(league: &str) -> SourceMatch {
        SourceMatch {
            match_text: String::new(),
            title: "A vs B".to_owned(),
            time: String::new(),
            league: league.to_owned(),
            sport: "Football".to_owned(),
            team1: "A".to_owned(),
            team2: "B".to_owned(),
            channel: String::new(),
            important: false,
            match_date: String::new(),
            channels: Vec::new(),
            slug: "a-b".to_owned(),
            start_timestamp: 1000,
            duration: 120,
        }
    }
}
