use std::collections::BTreeSet;
use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::Response;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use regex::Regex;
use serde::{Deserialize, Deserializer};
use serde_json::json;
use url::Url;

use crate::error::{ApiError, AppResult, json_response};
use crate::routes::AppState;
use crate::utils::now_ms;

const SUPER_LEAGUE_FOOTBALL_URL: &str = "https://super.league.st/index.php?sport=Football";
const FOOTBALL_STREAM_USER_AGENT: &str = "Mozilla/5.0";

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
    let response = state
        .http_client
        .get(SUPER_LEAGUE_FOOTBALL_URL)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::gateway_timeout("Timed out fetching football schedule.")
            } else {
                ApiError::bad_gateway(format!("Failed to fetch football schedule: {error}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Football schedule returned HTTP {}.",
            response.status()
        )));
    }

    let html = response.text().await.map_err(|error| {
        ApiError::bad_gateway(format!("Failed to read football schedule: {error}"))
    })?;
    let source_matches = extract_source_matches(&html)?;
    let now = now_ms();
    let matches: Vec<_> = source_matches
        .into_iter()
        .filter(|match_item| {
            match_item.start_timestamp > 0
                && match_item.duration > 0
                && !match_item.slug.trim().is_empty()
                && match_item
                    .start_timestamp
                    .saturating_add(match_item.duration.saturating_mul(60_000))
                    > now
        })
        .map(normalize_match)
        .collect();

    Ok(json_response(json!({
        "source": SUPER_LEAGUE_FOOTBALL_URL,
        "fetchedAt": now_ms(),
        "matches": matches
    })))
}

pub async fn football_stream_resolve_handler(
    State(state): State<AppState>,
    Query(query): Query<ResolveFootballStreamQuery>,
) -> AppResult<Response<Body>> {
    let source_url = Url::parse(query.url.trim())
        .map_err(|_| ApiError::bad_request("Invalid football stream URL."))?;
    let player_page_url = resolve_embed_player_page_url(&state, &source_url).await?;
    let stream_url = resolve_player_hls_url(&state, &player_page_url, source_url.as_str()).await?;
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
                Err(ApiError::bad_request("Unsupported football stream page."))
            }
        }
        _ => Err(ApiError::bad_request("Unsupported football stream host.")),
    }
}

async fn resolve_channel_player_page_url(state: &AppState, source_url: &Url) -> AppResult<Url> {
    if source_url.path() != "/ch" {
        return Err(ApiError::bad_request("Unsupported football stream page."));
    }
    let Some(id) = source_url
        .query_pairs()
        .find_map(|(key, value)| (key == "id").then(|| value.into_owned()))
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(ApiError::bad_request("Missing football stream id."));
    };

    let api_origin = match source_url.host_str().unwrap_or_default() {
        "glisco.link" | "www.glisco.link" => "https://glisco.link",
        "sansat.link" | "www.sansat.link" => "https://sansat.link",
        _ => return Err(ApiError::bad_request("Unsupported football stream host.")),
    };
    let api_url = Url::parse_with_params(&format!("{api_origin}/api/player.php"), [("id", id)])
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let response = state
        .http_client
        .get(api_url)
        .header(reqwest::header::USER_AGENT, FOOTBALL_STREAM_USER_AGENT)
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
        return Err(ApiError::bad_request("Unsupported football stream player."));
    }

    let response = state
        .http_client
        .get(player_page_url.clone())
        .header(reqwest::header::USER_AGENT, FOOTBALL_STREAM_USER_AGENT)
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

fn extract_source_matches(html: &str) -> AppResult<Vec<SourceMatch>> {
    static MATCHES_RE: OnceLock<Regex> = OnceLock::new();
    let regex = MATCHES_RE.get_or_init(|| {
        Regex::new(r#"window\.matches\s*=\s*JSON\.parse\(`([\s\S]*?)`\)"#)
            .expect("valid football matches regex")
    });
    let raw_matches = regex
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
        .ok_or_else(|| ApiError::bad_gateway("Football schedule did not include match data."))?;

    serde_json::from_str::<Vec<SourceMatch>>(raw_matches).map_err(|error| {
        ApiError::bad_gateway(format!("Failed to parse football schedule: {error}"))
    })
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
    use super::extract_source_matches;

    #[test]
    fn extracts_embedded_matches_json() {
        let html = r#"
            <script>
              window.matches = JSON.parse(`[{"matchstr":"A vs B","slug":"a-b","startTimestamp":1000,"duration":120,"channels":[{"name":"One","language":"GB","links":["https://example.test/1"]}]}]`);
            </script>
        "#;
        let matches = extract_source_matches(html).unwrap();
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
        let matches = extract_source_matches(html).unwrap();

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
}
