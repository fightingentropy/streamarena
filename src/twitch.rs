use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use crate::error::{ApiError, AppResult, json_response};
use crate::routes::AppState;
use crate::utils::now_ms;

const TWITCH_GQL_URL: &str = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TOP_NEWS_TWITCH_CHANNEL: &str = "topmedia_topnews";
const TWITCH_PLAYBACK_ACCESS_TOKEN_QUERY: &str = r#"query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
    value
    signature
    __typename
  }
  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
    value
    signature
    __typename
  }
}"#;

#[derive(Debug, Deserialize)]
pub struct ResolveTwitchStreamQuery {
    url: String,
}

#[derive(Debug, Deserialize)]
struct TwitchGraphQlResponse {
    data: Option<TwitchGraphQlData>,
    #[serde(default)]
    errors: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct TwitchGraphQlData {
    #[serde(rename = "streamPlaybackAccessToken")]
    stream_playback_access_token: Option<TwitchPlaybackAccessToken>,
}

#[derive(Debug, Deserialize)]
struct TwitchPlaybackAccessToken {
    value: String,
    signature: String,
}

pub async fn twitch_stream_resolve_handler(
    State(state): State<AppState>,
    Query(query): Query<ResolveTwitchStreamQuery>,
) -> AppResult<Response<Body>> {
    let source = query.url.trim();
    let channel = resolve_twitch_channel_name(source)?;
    let token = fetch_twitch_playback_access_token(&state, &channel).await?;
    let playback_url = build_twitch_hls_url(&channel, &token)?;
    let player_page = twitch_player_page_url(&channel);

    Ok(json_response(json!({
        "source": source,
        "playerPage": player_page,
        "playbackType": "hls",
        "playbackUrl": playback_url,
        "streamUrl": playback_url
    })))
}

async fn fetch_twitch_playback_access_token(
    state: &AppState,
    channel: &str,
) -> AppResult<TwitchPlaybackAccessToken> {
    let payload = json!({
        "operationName": "PlaybackAccessToken",
        "variables": {
            "isLive": true,
            "login": channel,
            "isVod": false,
            "vodID": "",
            "playerType": "site"
        },
        "query": TWITCH_PLAYBACK_ACCESS_TOKEN_QUERY
    });
    let response = state
        .http_client
        .post(TWITCH_GQL_URL)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .header("Client-ID", TWITCH_CLIENT_ID)
        .json(&payload)
        .send()
        .await
        .map_err(|_| ApiError::bad_gateway("Failed to resolve Twitch stream."))?;

    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Twitch stream resolver returned HTTP {}.",
            response.status()
        )));
    }

    let payload = response
        .json::<TwitchGraphQlResponse>()
        .await
        .map_err(|_| ApiError::bad_gateway("Invalid Twitch resolver response."))?;
    if payload.errors.is_some() {
        return Err(ApiError::bad_gateway(
            "Twitch stream resolver returned an error.",
        ));
    }
    payload
        .data
        .and_then(|data| data.stream_playback_access_token)
        .filter(|token| !token.value.trim().is_empty() && !token.signature.trim().is_empty())
        .ok_or_else(|| ApiError::bad_gateway("Twitch stream is not currently available."))
}

fn resolve_twitch_channel_name(input: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("Missing Twitch stream URL."));
    }

    if let Ok(url) = Url::parse(trimmed) {
        return resolve_twitch_channel_from_url(&url);
    }

    normalize_twitch_channel_name(trimmed)
        .ok_or_else(|| ApiError::bad_request("Invalid Twitch channel."))
}

fn resolve_twitch_channel_from_url(url: &Url) -> AppResult<String> {
    let host = url.host_str().unwrap_or_default().to_lowercase();
    match host.as_str() {
        "player.twitch.tv" => {
            let channel = url
                .query_pairs()
                .find_map(|(key, value)| (key == "channel").then(|| value.into_owned()))
                .and_then(|value| normalize_twitch_channel_name(&value));
            channel.ok_or_else(|| ApiError::bad_request("Missing Twitch channel."))
        }
        "twitch.tv" | "www.twitch.tv" | "m.twitch.tv" => {
            let channel = url
                .path_segments()
                .and_then(|mut segments| segments.find(|segment| !segment.trim().is_empty()))
                .and_then(normalize_twitch_channel_name);
            channel.ok_or_else(|| ApiError::bad_request("Missing Twitch channel."))
        }
        "top-channel.tv" | "www.top-channel.tv" => {
            if url.path().trim_end_matches('/') == "/topnewslive" {
                Ok(TOP_NEWS_TWITCH_CHANNEL.to_owned())
            } else {
                Err(ApiError::bad_request("Unsupported Top Channel live page."))
            }
        }
        _ => Err(ApiError::bad_request("Unsupported Twitch stream host.")),
    }
}

fn normalize_twitch_channel_name(value: &str) -> Option<String> {
    let channel = value.trim().trim_start_matches('@').to_lowercase();
    if !(3..=32).contains(&channel.len()) {
        return None;
    }
    channel
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        .then_some(channel)
}

fn twitch_player_page_url(channel: &str) -> String {
    format!("https://player.twitch.tv/?channel={channel}&parent=top-channel.tv")
}

fn build_twitch_hls_url(channel: &str, token: &TwitchPlaybackAccessToken) -> AppResult<String> {
    let mut url = Url::parse(&format!(
        "https://usher.ttvnw.net/api/channel/hls/{channel}.m3u8"
    ))
    .map_err(|error| ApiError::internal(error.to_string()))?;
    let timestamp = now_ms().max(0).to_string();
    url.query_pairs_mut()
        .append_pair("allow_source", "true")
        .append_pair("allow_audio_only", "true")
        .append_pair("allow_spectre", "false")
        .append_pair("fast_bread", "true")
        .append_pair("p", &timestamp)
        .append_pair("play_session_id", &format!("netflix-{timestamp}"))
        .append_pair("player_backend", "mediaplayer")
        .append_pair("playlist_include_framerate", "true")
        .append_pair("reassignments_supported", "true")
        .append_pair("sig", token.signature.trim())
        .append_pair("token", token.value.trim());
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::{TOP_NEWS_TWITCH_CHANNEL, resolve_twitch_channel_name, twitch_player_page_url};

    #[test]
    fn resolves_twitch_embed_channel() {
        let channel = resolve_twitch_channel_name(
            "https://player.twitch.tv/?channel=topmedia_topnews&parent=top-channel.tv",
        )
        .expect("channel");

        assert_eq!(channel, TOP_NEWS_TWITCH_CHANNEL);
    }

    #[test]
    fn maps_top_channel_live_page_to_top_news_channel() {
        let channel =
            resolve_twitch_channel_name("https://top-channel.tv/topnewslive/").expect("channel");

        assert_eq!(channel, TOP_NEWS_TWITCH_CHANNEL);
    }

    #[test]
    fn rejects_unsupported_hosts() {
        assert!(resolve_twitch_channel_name("https://example.com/topmedia_topnews").is_err());
    }

    #[test]
    fn builds_twitch_player_page_url() {
        assert_eq!(
            twitch_player_page_url(TOP_NEWS_TWITCH_CHANNEL),
            "https://player.twitch.tv/?channel=topmedia_topnews&parent=top-channel.tv"
        );
    }
}
