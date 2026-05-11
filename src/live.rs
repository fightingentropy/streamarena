use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Response, Uri};
use url::Url;
use url::form_urlencoded::byte_serialize;

use crate::error::{ApiError, AppResult};
use crate::process::to_absolute_playback_url;
use crate::routes::AppState;

const LIVE_HLS_EDGE_SEGMENT_COUNT: usize = 8;
const LIVE_HLS_ALLOWED_HOSTS: &[&str] = &[
    "liveproduseast.akamaized.net",
    "liveproduseast.global.ssl.fastly.net",
    "vs-hls-push-ww-live.akamaized.net",
    "jmp2.uk",
    "www.bloomberg.com",
];

pub async fn live_hls_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let request_url = absolute_request_url(&state, &uri)?;
    let input = to_absolute_playback_url(
        params.get("input").map(String::as_str).unwrap_or_default(),
        &request_url,
    );
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let source_url =
        Url::parse(&input).map_err(|_| ApiError::bad_request("Invalid live HLS URL."))?;
    if !is_allowed_live_hls_url(&source_url) {
        return Err(ApiError::bad_request("Unsupported live HLS URL."));
    }

    let response = state
        .http_client
        .get(source_url.clone())
        .header(reqwest::header::USER_AGENT, "netflix-rust-backend")
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS playlist request failed with status {}.",
            response.status()
        )));
    }
    let final_url = response.url().clone();
    if !is_allowed_live_hls_url(&final_url) {
        return Err(ApiError::bad_gateway(
            "Live HLS playlist redirected to an unsupported host.",
        ));
    }
    let playlist = response
        .text()
        .await
        .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
    let rewritten = rewrite_live_hls_playlist(&final_url, &playlist);

    Response::builder()
        .status(200)
        .header(
            "content-type",
            "application/vnd.apple.mpegurl; charset=utf-8",
        )
        .header("cache-control", "no-store")
        .body(Body::from(rewritten))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn query_pairs(query: &str) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn absolute_request_url(state: &AppState, uri: &Uri) -> AppResult<Url> {
    Url::parse(&format!(
        "http://{}:{}{}",
        state.config.host, state.config.port, uri
    ))
    .map_err(|error| ApiError::internal(error.to_string()))
}

fn encode_query_value(value: &str) -> String {
    byte_serialize(value.as_bytes()).collect::<String>()
}

fn live_hls_proxy_playlist_url(input: &str) -> String {
    format!("/api/live/hls.m3u8?input={}", encode_query_value(input))
}

fn resolve_hls_uri(base_url: &Url, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    base_url.join(trimmed).ok().map(|url| url.to_string())
}

fn is_allowed_live_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }

    let Some(host) = url.host_str().map(|value| value.to_lowercase()) else {
        return false;
    };

    LIVE_HLS_ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn rewrite_live_hls_playlist(base_url: &Url, playlist: &str) -> String {
    let lines: Vec<&str> = playlist.lines().collect();
    let is_master_playlist = lines
        .iter()
        .any(|line| line.trim_start().starts_with("#EXT-X-STREAM-INF"));
    let is_media_playlist = lines
        .iter()
        .any(|line| line.trim_start().starts_with("#EXTINF"));

    if is_master_playlist {
        return rewrite_live_hls_master_playlist(base_url, &lines);
    }
    if is_media_playlist {
        return rewrite_live_hls_media_playlist(base_url, &lines);
    }
    playlist.to_owned()
}

fn rewrite_live_hls_master_playlist(base_url: &Url, lines: &[&str]) -> String {
    let mut rewritten = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() || line.starts_with('#') {
            rewritten.push(line.to_owned());
            continue;
        }

        if let Some(absolute_uri) = resolve_hls_uri(base_url, line) {
            rewritten.push(live_hls_proxy_playlist_url(&absolute_uri));
        } else {
            rewritten.push(line.to_owned());
        }
    }
    rewritten.join("\n")
}

fn rewrite_live_hls_media_playlist(base_url: &Url, lines: &[&str]) -> String {
    let mut header = Vec::new();
    let mut pending_block = Vec::new();
    let mut segment_blocks: Vec<Vec<String>> = Vec::new();
    let mut original_media_sequence = 0_i64;
    let mut saw_segment = false;

    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            original_media_sequence = value.trim().parse::<i64>().unwrap_or_default();
            continue;
        }

        if line.starts_with("#EXT-X-ENDLIST") {
            continue;
        }

        if line.starts_with('#') {
            if !saw_segment
                && !line.starts_with("#EXTINF")
                && !line.starts_with("#EXT-X-KEY")
                && !line.starts_with("#EXT-X-MAP")
                && !line.starts_with("#EXT-X-PROGRAM-DATE-TIME")
                && !line.starts_with("#EXT-X-DISCONTINUITY")
            {
                header.push(line.to_owned());
            } else {
                pending_block.push(rewrite_hls_uri_attribute(base_url, line));
            }
            continue;
        }

        saw_segment = true;
        let segment_uri = resolve_hls_uri(base_url, line).unwrap_or_else(|| line.to_owned());
        pending_block.push(segment_uri);
        segment_blocks.push(std::mem::take(&mut pending_block));
    }

    if segment_blocks.is_empty() {
        return lines.join("\n");
    }

    if !header.iter().any(|line| line == "#EXTM3U") {
        header.insert(0, "#EXTM3U".to_owned());
    }
    header.push("#EXT-X-START:TIME-OFFSET=-18,PRECISE=NO".to_owned());

    let dropped_segments = segment_blocks
        .len()
        .saturating_sub(LIVE_HLS_EDGE_SEGMENT_COUNT);
    let next_media_sequence = original_media_sequence + dropped_segments as i64;
    let kept_blocks = segment_blocks.into_iter().skip(dropped_segments);

    let mut rewritten = header;
    rewritten.push(format!("#EXT-X-MEDIA-SEQUENCE:{next_media_sequence}"));
    for block in kept_blocks {
        rewritten.extend(block);
    }
    rewritten.join("\n")
}

fn rewrite_hls_uri_attribute(base_url: &Url, line: &str) -> String {
    let Some(uri_start) = line.find("URI=\"") else {
        return line.to_owned();
    };
    let value_start = uri_start + 5;
    let Some(relative_end) = line[value_start..].find('"') else {
        return line.to_owned();
    };
    let value_end = value_start + relative_end;
    let uri_value = &line[value_start..value_end];
    let Some(absolute_uri) = resolve_hls_uri(base_url, uri_value) else {
        return line.to_owned();
    };
    format!(
        "{}{}{}",
        &line[..value_start],
        absolute_uri,
        &line[value_end..]
    )
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_live_hls_url, rewrite_live_hls_playlist};

    #[test]
    fn live_hls_proxy_rejects_unapproved_hosts() {
        let allowed: url::Url = "https://www.bloomberg.com/media-manifest/streams/us.m3u8"
            .parse()
            .expect("allowed url");
        let bloomberg_variant: url::Url = "https://liveproduseast.global.ssl.fastly.net/us/Channel-USTV-AWS-virginia-2/Source-USTV-10000-1-slxdlg-BP-HD-7-oQALjcQ9CJcP_live.m3u8"
            .parse()
            .expect("bloomberg variant url");
        let bloomberg_akamai_variant: url::Url = "https://liveproduseast.akamaized.net/us/Channel-USTV-AWS-virginia-2/Source-USTV-10000-1-slxdlg-BP-HD-7-oQALjcQ9CJcP_live.m3u8"
            .parse()
            .expect("bloomberg akamai variant url");
        let disallowed: url::Url = "https://example.com/live.m3u8"
            .parse()
            .expect("disallowed url");
        let local: url::Url = "http://127.0.0.1/private.m3u8".parse().expect("local url");

        assert!(is_allowed_live_hls_url(&allowed));
        assert!(is_allowed_live_hls_url(&bloomberg_variant));
        assert!(is_allowed_live_hls_url(&bloomberg_akamai_variant));
        assert!(!is_allowed_live_hls_url(&disallowed));
        assert!(!is_allowed_live_hls_url(&local));
    }

    #[test]
    fn rewrites_master_playlist_entries_through_live_proxy() {
        let base: url::Url = "https://www.bloomberg.com/media-manifest/master.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild/main.m3u8\n";
        let rewritten = rewrite_live_hls_playlist(&base, playlist);

        assert!(rewritten.contains("/api/live/hls.m3u8?input="));
        assert!(rewritten.contains("child%2Fmain.m3u8"));
    }
}
