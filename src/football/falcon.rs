use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use url::Url;

use super::is_supported_ntvs_hls_url;

pub(super) fn is_safe_ntvs_channel_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn ntvs_falcon_channel_code(url: &Url) -> Option<String> {
    url.query_pairs()
        .find_map(|(key, value)| (key == "id").then_some(value.into_owned()))
        .filter(|value| is_safe_ntvs_channel_code(value))
}

pub(super) fn is_supported_ntvs_falcon_player_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.scheme() == "https"
        && matches!(host.as_str(), "hesgoal.team" | "www.hesgoal.team")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path() == "/ntvtvplayer.html"
        && ntvs_falcon_channel_code(url).is_some()
}

pub(super) fn is_supported_ntvs_wideiptv_player_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let channel = url.path().strip_prefix("/player/").unwrap_or_default();
    url.scheme() == "https"
        && matches!(host.as_str(), "wideiptv.top" | "www.wideiptv.top")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && is_safe_ntvs_channel_code(channel)
}

pub(super) fn parse_ntvs_falcon_wideiptv_player_url(html: &str, player_url: &Url) -> Option<Url> {
    if !is_supported_ntvs_falcon_player_url(player_url) {
        return None;
    }

    // The Falcon bridge intentionally keeps the channel code in its own URL and
    // sets the iframe source in JavaScript (`wideiptv.top/player/` + code). Do
    // not execute that page or follow arbitrary iframe hosts: require the exact
    // provider-owned base in the fetched HTML, then construct the one allowlisted
    // player URL from the already-validated channel code.
    let normalized_html = normalize_ntvs_inline_value(html);
    if !normalized_html.contains("https://wideiptv.top/player/")
        && !normalized_html.contains("https://www.wideiptv.top/player/")
    {
        return None;
    }

    let channel = ntvs_falcon_channel_code(player_url)?;
    let mut url = Url::parse("https://wideiptv.top/player/").ok()?;
    url.set_path(&format!("/player/{channel}"));
    is_supported_ntvs_wideiptv_player_url(&url).then_some(url)
}

pub(super) fn parse_ntvs_fawanews_stream_url(html: &str) -> Option<Url> {
    let stream_url_re =
        Regex::new(r#"(?is)\bstreamUrl\s*:\s*"([^"]+)"|\bstreamUrl\s*:\s*'([^']+)'"#).ok()?;
    let value = stream_url_re
        .captures(html)
        .and_then(|captures| captures.get(1).or_else(|| captures.get(2)))?;
    let decoded = normalize_ntvs_inline_value(value.as_str().trim());
    let playback_url = Url::parse(&decoded).ok()?;
    is_supported_ntvs_hls_url(&playback_url).then_some(playback_url)
}

pub(super) fn normalize_ntvs_inline_value(value: &str) -> String {
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

pub(super) fn ntvs_wideiptv_hls_request_channel(source_url: &Url, referer: &str) -> Option<String> {
    let referer_url = Url::parse(referer).ok()?;
    if !is_supported_ntvs_wideiptv_player_url(&referer_url)
        || source_url.scheme() != "https"
        || !is_supported_ntvs_hls_url(source_url)
    {
        return None;
    }
    let host = source_url.host_str()?.to_ascii_lowercase();
    if host != "bluetier.top" && !host.ends_with(".bluetier.top") {
        return None;
    }
    let referer_channel = referer_url.path().strip_prefix("/player/")?;
    let source_channel = source_url.path_segments()?.next()?;
    if source_channel != referer_channel
        || !source_url
            .query_pairs()
            .any(|(key, value)| key == "token" && !value.is_empty())
    {
        return None;
    }
    Some(referer_channel.to_owned())
}

pub(crate) fn ntvs_wideiptv_hls_token_expires_within(
    source_url: &Url,
    referer: &str,
    now_seconds: i64,
    refresh_window_seconds: i64,
) -> bool {
    if ntvs_wideiptv_hls_request_channel(source_url, referer).is_none() {
        return false;
    }
    let token = source_url
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then_some(value.into_owned()));
    let Some(encoded_payload) = token.as_deref().and_then(|token| token.split('.').next()) else {
        return false;
    };
    let Some(expires_at) = STANDARD
        .decode(encoded_payload)
        .ok()
        .and_then(|payload| String::from_utf8(payload).ok())
        .and_then(|payload| payload.rsplit('|').next()?.parse::<i64>().ok())
    else {
        return false;
    };
    expires_at <= now_seconds.saturating_add(refresh_window_seconds.max(0))
}

pub(crate) fn refresh_ntvs_wideiptv_hls_request_url(
    source_url: &Url,
    refreshed_master_url: &Url,
    referer: &str,
) -> Option<Url> {
    ntvs_wideiptv_hls_request_channel(source_url, referer)?;
    ntvs_wideiptv_hls_request_channel(refreshed_master_url, referer)?;
    let refreshed_token = refreshed_master_url
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then_some(value.into_owned()))?;

    // Preserve whether this request targets the master or a rolling rendition.
    // Only rotate to the current provider shard and token, so a media-playlist
    // refresh never turns back into the master playlist.
    let original_query = source_url
        .query_pairs()
        .filter(|(key, _)| key != "token")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let mut refreshed_url = refreshed_master_url.clone();
    refreshed_url.set_path(source_url.path());
    refreshed_url.set_fragment(None);
    {
        let mut query = refreshed_url.query_pairs_mut();
        query.clear();
        for (key, value) in original_query {
            query.append_pair(&key, &value);
        }
        query.append_pair("token", &refreshed_token);
    }
    ntvs_wideiptv_hls_request_channel(&refreshed_url, referer)?;
    Some(refreshed_url)
}

#[cfg(test)]
mod tests {
    use super::{
        is_supported_ntvs_falcon_player_url, is_supported_ntvs_wideiptv_player_url,
        ntvs_wideiptv_hls_token_expires_within, parse_ntvs_falcon_wideiptv_player_url,
        parse_ntvs_fawanews_stream_url, refresh_ntvs_wideiptv_hls_request_url,
    };
    use crate::football::extract_ntvs_candidate_urls;
    use url::Url;

    #[test]
    fn follows_current_falcon_player_chain_only() {
        let wrapper = Url::parse("https://ntvs.cx/embed?t=opaque-token").unwrap();
        let wrapper_html = r#"
            <iframe src="https://hesgoal.team/ntvtvplayer.html?id=NOVASPORTS1"></iframe>
            <iframe src="https://hesgoal.team.evil.test/ntvtvplayer.html?id=NOVASPORTS1"></iframe>
            <iframe src="https://hesgoal.team/ntvtvplayer.html?id=../../private"></iframe>
        "#;
        let candidates = extract_ntvs_candidate_urls(wrapper_html, &wrapper)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            candidates,
            vec!["https://hesgoal.team/ntvtvplayer.html?id=NOVASPORTS1".to_owned()]
        );

        let falcon_player = Url::parse(candidates[0].as_str()).unwrap();
        let player_html = r#"
            <script>
                const channel = new URLSearchParams(window.location.search).get('id');
                iframe.src = 'https://wideiptv.top/player/' + encodeURIComponent(channel);
            </script>
        "#;
        let wideiptv = parse_ntvs_falcon_wideiptv_player_url(player_html, &falcon_player)
            .expect("wideiptv player");
        assert_eq!(wideiptv.as_str(), "https://wideiptv.top/player/NOVASPORTS1");
        assert!(is_supported_ntvs_wideiptv_player_url(&wideiptv));
    }

    #[test]
    fn rejects_falcon_player_lookalikes_and_unapproved_hops() {
        for value in [
            "http://hesgoal.team/ntvtvplayer.html?id=NOVASPORTS1",
            "https://hesgoal.team.evil.test/ntvtvplayer.html?id=NOVASPORTS1",
            "https://hesgoal.team:444/ntvtvplayer.html?id=NOVASPORTS1",
            "https://hesgoal.team/ntvtvplayer.html?id=../../private",
            "https://hesgoal.team/another-player.html?id=NOVASPORTS1",
        ] {
            assert!(!is_supported_ntvs_falcon_player_url(
                &Url::parse(value).unwrap()
            ));
        }
        for value in [
            "http://wideiptv.top/player/NOVASPORTS1",
            "https://wideiptv.top.evil.test/player/NOVASPORTS1",
            "https://wideiptv.top:444/player/NOVASPORTS1",
            "https://wideiptv.top/player/../../private",
            "https://wideiptv.top/player/NOVASPORTS1?next=https://example.test",
        ] {
            assert!(!is_supported_ntvs_wideiptv_player_url(
                &Url::parse(value).unwrap()
            ));
        }

        let falcon_player =
            Url::parse("https://hesgoal.team/ntvtvplayer.html?id=NOVASPORTS1").unwrap();
        assert!(
            parse_ntvs_falcon_wideiptv_player_url(
                "iframe.src = 'https://wideiptv.example/player/' + channel;",
                &falcon_player,
            )
            .is_none()
        );
    }

    #[test]
    fn parses_current_fawanews_hls_and_rejects_rotated_lookalikes() {
        let html = r#"
            <script>
                const config = {
                    streamUrl: "https:\/\/ds164.bluetier.top\/NOVASPORTS1\/index.m3u8?token=abc",
                    channelName: "NOVASPORTS1"
                };
            </script>
        "#;
        assert_eq!(
            parse_ntvs_fawanews_stream_url(html)
                .as_ref()
                .map(Url::as_str),
            Some("https://ds164.bluetier.top/NOVASPORTS1/index.m3u8?token=abc")
        );
        assert!(
            parse_ntvs_fawanews_stream_url(
                r#"const config = { streamUrl: 'https://cdn.bluetier.top/SkySportsF1/index.m3u8?token=abc' };"#
            )
            .is_some()
        );
        assert!(
            parse_ntvs_fawanews_stream_url(
                r#"const config = { streamUrl: "https://cdn.bluetier.top.evil.test/NOVASPORTS1/index.m3u8" };"#
            )
            .is_none()
        );
        assert!(
            parse_ntvs_fawanews_stream_url(
                r#"const config = { streamUrl: "https://cdn.bluetier.top/NOVASPORTS1/index.ts" };"#
            )
            .is_none()
        );
    }

    #[test]
    fn refreshes_only_matching_wideiptv_bluetier_tokens_near_expiry() {
        let source = Url::parse(
            "https://ds164.bluetier.top/NOVASPORTS1/tracks-v1a1/mono.m3u8?token=Tk9WQVNQT1JUUzF8bm9fY2hlY2tfaXB8MTAwMA%3D%3D.signature",
        )
        .unwrap();
        let referer = "https://wideiptv.top/player/NOVASPORTS1";

        assert!(!ntvs_wideiptv_hls_token_expires_within(
            &source, referer, 940, 30
        ));
        assert!(ntvs_wideiptv_hls_token_expires_within(
            &source, referer, 970, 30
        ));
        assert!(ntvs_wideiptv_hls_token_expires_within(
            &source, referer, 1_001, 30
        ));

        let fresh_master = Url::parse(
            "https://ds200.bluetier.top/NOVASPORTS1/index.m3u8?token=Tk9WQVNQT1JUUzF8bm9fY2hlY2tfaXB8MjAwMA%3D%3D.new-signature",
        )
        .unwrap();
        let refreshed_media =
            refresh_ntvs_wideiptv_hls_request_url(&source, &fresh_master, referer)
                .expect("refreshed media playlist");
        assert_eq!(refreshed_media.host_str(), Some("ds200.bluetier.top"));
        assert_eq!(refreshed_media.path(), "/NOVASPORTS1/tracks-v1a1/mono.m3u8");
        assert_eq!(
            refreshed_media
                .query_pairs()
                .find_map(|(key, value)| (key == "token").then_some(value.into_owned()))
                .as_deref(),
            Some("Tk9WQVNQT1JUUzF8bm9fY2hlY2tfaXB8MjAwMA==.new-signature")
        );

        assert!(!ntvs_wideiptv_hls_token_expires_within(
            &source,
            "https://wideiptv.top/player/ANOTHERCHANNEL",
            1_001,
            30,
        ));
        assert!(!ntvs_wideiptv_hls_token_expires_within(
            &source,
            "https://wideiptv.top.evil.test/player/NOVASPORTS1",
            1_001,
            30,
        ));
        assert!(!ntvs_wideiptv_hls_token_expires_within(
            &Url::parse(
                "https://bluetier.top.evil.test/NOVASPORTS1/index.m3u8?token=Tk9WQVNQT1JUUzF8bm9fY2hlY2tfaXB8MTAwMA%3D%3D.signature",
            )
            .unwrap(),
            referer,
            1_001,
            30,
        ));
    }
}
