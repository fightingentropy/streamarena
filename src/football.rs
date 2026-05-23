use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};

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
const SUPER_LEAGUE_STREAM_USER_AGENT: &str = "Mozilla/5.0";
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

#[derive(Debug, Deserialize)]
pub struct ResolveFootballStreamQuery {
    url: String,
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
    let source_url = Url::parse(query.url.trim())
        .map_err(|_| ApiError::bad_request("Invalid live stream URL."))?;
    let player_page_url = resolve_embed_player_page_url(state, &source_url).await?;
    let stream_url = resolve_player_hls_url(state, &player_page_url, source_url.as_str()).await?;
    let stream_url_text = stream_url.to_string();

    Ok(json_response(json!({
        "source": source_url.as_str(),
        "playerPage": player_page_url.as_str(),
        "playbackType": "hls",
        "playbackUrl": stream_url_text,
        "streamUrl": stream_url_text
    })))
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
    while normalized.len() % 4 != 0 {
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
        MATCHSTREAM_SCHEDULE_URL, SPORTS_SCHEDULE_CACHE_TTL_MS, SPORTS_SCHEDULE_STALE_IF_ERROR_MS,
        SourceChannel, SourceMatch, SportsScheduleCache, build_sports_matches_payload,
        extract_source_matches, is_basketball_match, is_high_priority_football_match,
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
