use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, Response};
use dashmap::DashMap;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use url::Url;

use crate::error::{ApiError, AppResult, json_response};
use crate::routes::AppState;
use crate::utils::now_ms;

const STREAMED_FOOTBALL_CACHE_KEY: &str = "streamed:football";
const STREAMED_BASKETBALL_CACHE_KEY: &str = "streamed:basketball";
const STREAMED_TENNIS_CACHE_KEY: &str = "streamed:tennis";
const STREAMED_HOCKEY_CACHE_KEY: &str = "streamed:hockey";
const STREAMED_BASEBALL_CACHE_KEY: &str = "streamed:baseball";
const STREAMED_AMERICAN_FOOTBALL_CACHE_KEY: &str = "streamed:american-football";
const STREAMED_CRICKET_CACHE_KEY: &str = "streamed:cricket";
const STREAMED_MATCHES_BASE_URL: &str = "https://streamed.pk/api/matches";
const STREAMED_FOOTBALL_MATCHES_URL: &str = "https://streamed.pk/api/matches/football";
const STREAMED_BASKETBALL_MATCHES_URL: &str = "https://streamed.pk/api/matches/basketball";
const STREAMED_REFERER: &str = "https://streamed.pk/";
const STREAMED_DEFAULT_DURATION_MINUTES: i64 = 180;
const STREAMED_USER_AGENT: &str = "Mozilla/5.0";
const STREAMED_EMBED_HLS_RESOLVER_SCRIPT: &str = "scripts/resolve-streamed-hls.mjs";
const STREAMED_EMBED_HLS_RESOLVE_TIMEOUT_SECONDS: u64 = 24;
const STREAMED_EMBED_REFERER: &str = "https://embedsports.top/";
const MAX_LIVE_STREAM_CANDIDATES: usize = 6;
const SPORTS_SCHEDULE_CACHE_TTL_MS: i64 = 6 * 60 * 60 * 1000;
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
pub struct ResolveFootballStreamQuery {
    url: String,
    #[serde(default, rename = "fallbackUrls")]
    fallback_urls: Option<String>,
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
    streamed_sport_matches_response(&state, STREAMED_FOOTBALL_CACHE_KEY, "football", "Football")
        .await
}

pub async fn basketball_matches_handler(
    State(state): State<AppState>,
) -> AppResult<Response<Body>> {
    streamed_sport_matches_response(
        &state,
        STREAMED_BASKETBALL_CACHE_KEY,
        "basketball",
        "Basketball",
    )
    .await
}

pub async fn tennis_matches_handler(State(state): State<AppState>) -> AppResult<Response<Body>> {
    streamed_sport_matches_response(&state, STREAMED_TENNIS_CACHE_KEY, "tennis", "Tennis").await
}

pub async fn hockey_matches_handler(State(state): State<AppState>) -> AppResult<Response<Body>> {
    streamed_sport_matches_response(&state, STREAMED_HOCKEY_CACHE_KEY, "hockey", "Hockey").await
}

pub async fn baseball_matches_handler(State(state): State<AppState>) -> AppResult<Response<Body>> {
    streamed_sport_matches_response(&state, STREAMED_BASEBALL_CACHE_KEY, "baseball", "Baseball")
        .await
}

pub async fn american_football_matches_handler(
    State(state): State<AppState>,
) -> AppResult<Response<Body>> {
    streamed_sport_matches_response(
        &state,
        STREAMED_AMERICAN_FOOTBALL_CACHE_KEY,
        "american-football",
        "American Football",
    )
    .await
}

pub async fn cricket_matches_handler(State(state): State<AppState>) -> AppResult<Response<Body>> {
    streamed_sport_matches_response(&state, STREAMED_CRICKET_CACHE_KEY, "cricket", "Cricket").await
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

    match fetch_streamed_sport_matches_payload(state, streamed_category, sport_name).await {
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

async fn fetch_streamed_sport_matches_payload(
    state: &AppState,
    streamed_category: &'static str,
    sport_name: &'static str,
) -> AppResult<(Value, i64)> {
    let source_url = streamed_matches_url(streamed_category);
    let response = state
        .http_client
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

    let source_matches = response
        .json::<Vec<StreamedMatch>>()
        .await
        .map_err(|error| {
            ApiError::bad_gateway(format!(
                "Failed to parse Streamed {sport_name} schedule: {error}"
            ))
        })?;
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
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    streamed_stream_resolve_response(&state, query).await
}

pub async fn basketball_stream_resolve_handler(
    State(state): State<AppState>,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    streamed_stream_resolve_response(&state, query).await
}

pub async fn streamed_sports_stream_resolve_handler(
    State(state): State<AppState>,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    streamed_stream_resolve_response(&state, query).await
}

async fn streamed_stream_resolve_response(
    state: &AppState,
    query: ResolveFootballStreamQuery,
) -> AppResult<Response<Body>> {
    let candidates = live_stream_source_candidates(&query.url, query.fallback_urls.as_deref())?;
    let mut errors = Vec::new();

    for (candidate_index, source_url) in candidates.iter().enumerate() {
        match resolve_verified_streamed_live_stream(state, source_url, candidate_index).await {
            Ok(resolved) => {
                let playback_url_text = resolved.playback_url.to_string();
                return Ok(json_response(json!({
                    "source": resolved.source_url.as_str(),
                    "playerPage": resolved.player_page_url.as_str(),
                    "playbackType": resolved.playback_type,
                    "playbackUrl": playback_url_text,
                    "streamUrl": "",
                    "embedUrl": playback_url_text.as_str(),
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
        "No working Streamed live stream found after checking {checked} source(s).{latest_error}"
    )))
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

async fn resolve_streamed_embed_hls_url(embed_url: &Url) -> Option<Url> {
    let script_path = std::env::var("STREAMED_HLS_RESOLVER_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| STREAMED_EMBED_HLS_RESOLVER_SCRIPT.to_owned());
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
        MAX_LIVE_STREAM_CANDIDATES, SPORTS_SCHEDULE_CACHE_TTL_MS,
        SPORTS_SCHEDULE_STALE_IF_ERROR_MS, STREAMED_FOOTBALL_MATCHES_URL, SportsScheduleCache,
        StreamedMatch, StreamedSource, StreamedTeam, StreamedTeams,
        build_streamed_football_matches_payload, is_supported_streamed_hls_url,
        live_stream_source_candidates, parse_fallback_stream_urls,
    };
    use crate::utils::now_ms;
    use serde_json::json;

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

        assert_eq!(candidates.len(), MAX_LIVE_STREAM_CANDIDATES);
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
}
