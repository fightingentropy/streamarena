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
    "28585519.net",
    "antennaplus.gr",
    "broadpeak-aas.com",
    "cdn.skycdp.com",
    "msvdn.net",
    "siliconweb.com",
    "strmd.top",
    "easy.speedsterwave.app",
    "storm.vodvidl.site",
    "ttvnw.net",
];

struct LiveHlsRequest {
    source_url: Url,
    referer: Option<String>,
}

pub async fn live_hls_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let live_request = live_hls_request_input(&state, &uri)?;

    let mut request = state
        .http_client
        .get(live_request.source_url.clone())
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0");
    if let Some(referer) = live_request.referer.as_deref() {
        request = request.header(reqwest::header::REFERER, referer);
    }
    let response = request
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
    let rewritten =
        rewrite_live_hls_playlist(&final_url, &playlist, live_request.referer.as_deref());

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

pub async fn live_hls_resource_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let live_request = live_hls_request_input(&state, &uri)?;
    let mut request = state
        .http_client
        .get(live_request.source_url.clone())
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0");
    if let Some(referer) = live_request.referer.as_deref() {
        request = request.header(reqwest::header::REFERER, referer);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS resource request failed with status {}.",
            response.status()
        )));
    }
    let final_url = response.url().clone();
    if !is_allowed_live_hls_url(&final_url) {
        return Err(ApiError::bad_gateway(
            "Live HLS resource redirected to an unsupported host.",
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ApiError::bad_gateway(error.to_string()))?;

    Response::builder()
        .status(200)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Body::from(bytes))
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

fn live_hls_request_input(state: &AppState, uri: &Uri) -> AppResult<LiveHlsRequest> {
    let params = query_pairs(uri.query().unwrap_or_default());
    let request_url = absolute_request_url(state, uri)?;
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
    let referer = params
        .get("referer")
        .and_then(|value| normalize_hls_referer(value));
    Ok(LiveHlsRequest {
        source_url,
        referer,
    })
}

fn normalize_hls_referer(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return None;
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_ascii_control() || ch == '\u{7f}')
    {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    url.host_str()?;
    Some(url.to_string())
}

fn encode_query_value(value: &str) -> String {
    byte_serialize(value.as_bytes()).collect::<String>()
}

pub fn build_live_hls_playback_source(input: &str, referer: Option<&str>) -> String {
    live_hls_proxy_playlist_url(input, referer)
}

fn live_hls_proxy_playlist_url(input: &str, referer: Option<&str>) -> String {
    live_hls_proxy_url("/api/live/hls.m3u8", input, referer)
}

fn live_hls_proxy_resource_url(input: &str, referer: Option<&str>) -> String {
    live_hls_proxy_url("/api/live/hls-resource", input, referer)
}

fn live_hls_proxy_url(path: &str, input: &str, referer: Option<&str>) -> String {
    let mut url = format!("{path}?input={}", encode_query_value(input));
    if let Some(referer) = referer.and_then(normalize_hls_referer) {
        url.push_str("&referer=");
        url.push_str(&encode_query_value(&referer));
    }
    url
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
        .any(|allowed| host_matches_allowed_live_hls_host(&host, allowed))
}

fn host_matches_allowed_live_hls_host(host: &str, allowed: &str) -> bool {
    host == allowed
        || host
            .strip_suffix(allowed)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn rewrite_live_hls_playlist(base_url: &Url, playlist: &str, referer: Option<&str>) -> String {
    let lines: Vec<&str> = playlist.lines().collect();
    let is_master_playlist = lines
        .iter()
        .any(|line| line.trim_start().starts_with("#EXT-X-STREAM-INF"));
    let is_media_playlist = lines
        .iter()
        .any(|line| line.trim_start().starts_with("#EXTINF"));

    if is_master_playlist {
        return rewrite_live_hls_master_playlist(base_url, &lines, referer);
    }
    if is_media_playlist {
        return rewrite_live_hls_media_playlist(base_url, &lines, referer);
    }
    playlist.to_owned()
}

fn rewrite_live_hls_master_playlist(
    base_url: &Url,
    lines: &[&str],
    referer: Option<&str>,
) -> String {
    let mut rewritten = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            rewritten.push(line.to_owned());
            continue;
        }

        if line.starts_with('#') {
            let proxy_url_builder = if line.starts_with("#EXT-X-MEDIA:")
                || line.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
            {
                live_hls_proxy_playlist_url
            } else {
                live_hls_proxy_resource_url
            };
            rewritten.push(rewrite_hls_uri_attribute(
                base_url,
                line,
                referer,
                proxy_url_builder,
            ));
            continue;
        }

        if let Some(absolute_uri) = resolve_hls_uri(base_url, line) {
            rewritten.push(live_hls_proxy_playlist_url(&absolute_uri, referer));
        } else {
            rewritten.push(line.to_owned());
        }
    }
    rewritten.join("\n")
}

fn rewrite_live_hls_media_playlist(
    base_url: &Url,
    lines: &[&str],
    referer: Option<&str>,
) -> String {
    let is_vod_playlist = lines.iter().any(|line| {
        let line = line.trim();
        line.eq_ignore_ascii_case("#EXT-X-ENDLIST")
            || line.eq_ignore_ascii_case("#EXT-X-PLAYLIST-TYPE:VOD")
    });
    if is_vod_playlist {
        return rewrite_vod_hls_media_playlist(base_url, lines, referer);
    }

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
                header.push(rewrite_hls_uri_attribute(
                    base_url,
                    line,
                    referer,
                    live_hls_proxy_resource_url,
                ));
            } else {
                pending_block.push(rewrite_hls_uri_attribute(
                    base_url,
                    line,
                    referer,
                    live_hls_proxy_resource_url,
                ));
            }
            continue;
        }

        saw_segment = true;
        let segment_uri = resolve_hls_uri(base_url, line)
            .map(|absolute_uri| live_hls_proxy_resource_url(&absolute_uri, referer))
            .unwrap_or_else(|| line.to_owned());
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

fn rewrite_vod_hls_media_playlist(base_url: &Url, lines: &[&str], referer: Option<&str>) -> String {
    let mut rewritten = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            rewritten.push(line.to_owned());
            continue;
        }

        if line.starts_with('#') {
            rewritten.push(rewrite_hls_uri_attribute(
                base_url,
                line,
                referer,
                live_hls_proxy_resource_url,
            ));
            continue;
        }

        let segment_uri = resolve_hls_uri(base_url, line)
            .map(|absolute_uri| live_hls_proxy_resource_url(&absolute_uri, referer))
            .unwrap_or_else(|| line.to_owned());
        rewritten.push(segment_uri);
    }
    rewritten.join("\n")
}

fn rewrite_hls_uri_attribute(
    base_url: &Url,
    line: &str,
    referer: Option<&str>,
    proxy_url_builder: fn(&str, Option<&str>) -> String,
) -> String {
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
    let proxied_uri = proxy_url_builder(&absolute_uri, referer);
    format!(
        "{}{}{}",
        &line[..value_start],
        proxied_uri,
        &line[value_end..]
    )
}

#[cfg(test)]
mod tests {
    use super::{
        host_matches_allowed_live_hls_host, is_allowed_live_hls_url, rewrite_live_hls_playlist,
    };

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
        let sky_news: url::Url = "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8"
            .parse()
            .expect("sky news url");
        let ert1: url::Url = "https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERT1/default/index.m3u8"
            .parse()
            .expect("ert1 url");
        let mega_news: url::Url = "https://streamcdnb2-c98db5952cb54b358365984178fb898a.msvdn.net/live/S99841657/NU0xOarAMJ5X/playlist.m3u8"
            .parse()
            .expect("mega news url");
        let ant1: url::Url = "https://pcdn.antennaplus.gr/live/media0/antenna-gr/HLS/index.m3u8"
            .parse()
            .expect("ant1 url");
        let alpha_tv: url::Url =
            "https://alphatvlive2-ak.siliconweb.com/alphatvlive/live_abr/playlist.m3u8"
                .parse()
                .expect("alpha tv url");
        let twitch_master: url::Url =
            "https://usher.ttvnw.net/api/channel/hls/topmedia_topnews.m3u8"
                .parse()
                .expect("twitch master url");
        let twitch_variant: url::Url = "https://euw12.playlist.ttvnw.net/v1/playlist/live.m3u8"
            .parse()
            .expect("twitch variant url");
        let twitch_segment: url::Url =
            "https://91334ab1a2f2.j.cloudfront.hls.ttvnw.net/v1/segment/live.ts"
                .parse()
                .expect("twitch segment url");
        let streamed_sports: url::Url =
            "https://lb12.strmd.top/secure/token/rtmp/stream/id/1/playlist.m3u8"
                .parse()
                .expect("streamed sports url");
        let videasy_hls: url::Url = "https://easy.speedsterwave.app/example/index.m3u8"
            .parse()
            .expect("videasy hls url");
        let vidlink_hls: url::Url = "https://storm.vodvidl.site/example/index.m3u8"
            .parse()
            .expect("vidlink hls url");
        let disallowed: url::Url = "https://example.com/live.m3u8"
            .parse()
            .expect("disallowed url");
        let local: url::Url = "http://127.0.0.1/private.m3u8".parse().expect("local url");

        assert!(is_allowed_live_hls_url(&allowed));
        assert!(is_allowed_live_hls_url(&bloomberg_variant));
        assert!(is_allowed_live_hls_url(&bloomberg_akamai_variant));
        assert!(is_allowed_live_hls_url(&sky_news));
        assert!(is_allowed_live_hls_url(&ert1));
        assert!(is_allowed_live_hls_url(&mega_news));
        assert!(is_allowed_live_hls_url(&ant1));
        assert!(is_allowed_live_hls_url(&alpha_tv));
        assert!(is_allowed_live_hls_url(&twitch_master));
        assert!(is_allowed_live_hls_url(&twitch_variant));
        assert!(is_allowed_live_hls_url(&twitch_segment));
        assert!(is_allowed_live_hls_url(&streamed_sports));
        assert!(is_allowed_live_hls_url(&videasy_hls));
        assert!(is_allowed_live_hls_url(&vidlink_hls));
        assert!(!is_allowed_live_hls_url(&disallowed));
        assert!(!is_allowed_live_hls_url(&local));
    }

    #[test]
    fn live_hls_host_matching_requires_domain_boundary() {
        assert!(host_matches_allowed_live_hls_host(
            "media.example.com",
            "example.com"
        ));
        assert!(host_matches_allowed_live_hls_host(
            "example.com",
            "example.com"
        ));
        assert!(!host_matches_allowed_live_hls_host(
            "badexample.com",
            "example.com"
        ));
        assert!(!host_matches_allowed_live_hls_host(
            "example.com.evil.test",
            "example.com"
        ));
    }

    #[test]
    fn rewrites_master_playlist_entries_through_live_proxy() {
        let base: url::Url = "https://www.bloomberg.com/media-manifest/master.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild/main.m3u8\n";
        let rewritten = rewrite_live_hls_playlist(&base, playlist, None);

        assert!(rewritten.contains("/api/live/hls.m3u8?input="));
        assert!(rewritten.contains("child%2Fmain.m3u8"));
    }

    #[test]
    fn rewrites_master_playlist_uri_attributes_through_live_proxy() {
        let base: url::Url = "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio1\",URI=\"08_1080-30.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n07_1080-30.m3u8\n";
        let rewritten = rewrite_live_hls_playlist(&base, playlist, None);

        assert!(rewritten.contains("/api/live/hls.m3u8?input="));
        assert!(rewritten.contains("08_1080-30.m3u8"));
        assert!(rewritten.contains("07_1080-30.m3u8"));
        assert!(!rewritten.contains("URI=\"08_1080-30.m3u8\""));
    }

    #[test]
    fn rewrites_media_playlist_segments_and_referer_through_live_proxy() {
        let base: url::Url = "https://media.example.28585519.net/hls/live.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n#EXTINF:4.0,\nseg-1.ts\n";
        let rewritten =
            rewrite_live_hls_playlist(&base, playlist, Some("https://helpless.click/e/player"));

        assert!(rewritten.contains("/api/live/hls-resource?input="));
        assert!(rewritten.contains("seg-1.ts"));
        assert!(rewritten.contains("referer=https%3A%2F%2Fhelpless.click%2Fe%2Fplayer"));
    }

    #[test]
    fn preserves_vod_media_playlist_segments_through_live_proxy() {
        let base: url::Url = "https://easy.speedsterwave.app/title/index.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4.0,\nseg-1.ts\n#EXTINF:4.0,\nseg-2.ts\n#EXTINF:4.0,\nseg-3.ts\n#EXTINF:4.0,\nseg-4.ts\n#EXTINF:4.0,\nseg-5.ts\n#EXTINF:4.0,\nseg-6.ts\n#EXTINF:4.0,\nseg-7.ts\n#EXTINF:4.0,\nseg-8.ts\n#EXTINF:4.0,\nseg-9.ts\n#EXT-X-ENDLIST\n";
        let rewritten =
            rewrite_live_hls_playlist(&base, playlist, Some("https://player.videasy.net/movie/1"));

        assert!(rewritten.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(rewritten.contains("#EXT-X-MEDIA-SEQUENCE:1"));
        assert!(rewritten.contains("#EXT-X-ENDLIST"));
        assert!(rewritten.contains("seg-1.ts"));
        assert!(rewritten.contains("seg-9.ts"));
        assert!(!rewritten.contains("#EXT-X-START:TIME-OFFSET=-18"));
    }
}
