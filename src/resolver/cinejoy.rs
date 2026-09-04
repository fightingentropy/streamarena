use url::Url;

use super::ExternalEmbedHlsPlaybackSource;

fn valid_playlist(url: &Url, server: &str) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let parts: Vec<_> = url
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    match (server, url.host_str()) {
        ("LISBON", Some("info.movieboxnoob.cc")) => {
            parts.len() == 2 && parts[0] == "playlist" && parts[1].ends_with(".m3u8")
        }
        ("NEBULA", Some("nebula.bright67.online")) => {
            parts.len() == 3 && parts[0] == "hls" && parts[2] == "master.m3u8"
        }
        ("SOLARA", Some("lol.movieboxnoob.cc")) => {
            url.path() == "/content"
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "v" && !value.is_empty())
        }
        _ => false,
    }
}

pub(super) async fn validate(
    client: &reqwest::Client,
    url: &Url,
    server: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    if !valid_playlist(url, server) {
        return None;
    }
    // Never trust the helper's referer or assume an extensionless Solara URL is
    // media. Validate #EXTM3U using the backend's egress and the fixed referer.
    let resolved = super::validate_external_embed_hls_playlist(
        client,
        url.as_str(),
        Some("https://cinejoy.to/"),
        timeout_ms.min(8000),
    )
    .await?;
    valid_playlist(&resolved.playback_url, server).then_some(resolved)
}

#[cfg(test)]
mod tests {
    use super::valid_playlist;
    use url::Url;

    #[test]
    fn cinejoy_playlists_are_server_bound_and_reject_untrusted_urls() {
        let cases = [
            ("LISBON", "https://info.movieboxnoob.cc/playlist/test.m3u8"),
            (
                "NEBULA",
                "https://nebula.bright67.online/hls/test/master.m3u8",
            ),
            ("SOLARA", "https://lol.movieboxnoob.cc/content?v=test"),
        ];
        for (server, value) in cases {
            let url = Url::parse(value).unwrap();
            assert!(valid_playlist(&url, server));
            assert!(!valid_playlist(&url, "UNKNOWN"));
            let mut malicious = url.clone();
            malicious.set_host(Some("127.0.0.1")).unwrap();
            assert!(!valid_playlist(&malicious, server));
            malicious = url.clone();
            malicious.set_username("secret").unwrap();
            assert!(!valid_playlist(&malicious, server));
        }
        assert!(!valid_playlist(
            &Url::parse("https://lol.movieboxnoob.cc/content").unwrap(),
            "SOLARA"
        ));
    }
}
