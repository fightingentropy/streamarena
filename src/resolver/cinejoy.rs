use std::path::Path;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;
use url::Url;

use super::{ExternalEmbedHlsPlaybackSource, ExternalEmbedHlsResolverOutput, ExternalEmbedSource};

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

pub(super) async fn resolve(
    client: &reqwest::Client,
    source: ExternalEmbedSource,
    embed_url: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let server = source.server.map(|server| server.id).unwrap_or("LISBON");
    let script = if Path::new("scripts/resolve-cinejoy-hls.mjs").is_file() {
        "scripts/resolve-cinejoy-hls.mjs"
    } else {
        "bin/resolve-cinejoy-hls.mjs"
    };
    // The outer deadline bounds launch, discovery, and validation together.
    // Existing resolver locks/cache and per-provider budgets also apply to this
    // path. Alternate servers are manual-only, preventing parallel browser fans.
    timeout(
        Duration::from_millis(timeout_ms.saturating_add(1000)),
        async {
            let output = Command::new("node")
                .arg(script)
                .arg(embed_url)
                .env("EXTERNAL_EMBED_SERVER", server)
                .env(
                    "EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS",
                    timeout_ms.to_string(),
                )
                .kill_on_drop(true)
                .output()
                .await
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let output: ExternalEmbedHlsResolverOutput =
                serde_json::from_slice(&output.stdout).ok()?;
            let url = Url::parse(&output.playback_url).ok()?;
            if !valid_playlist(&url, server) {
                return None;
            }
            // Never trust the helper's referer, or an extensionless Solara URL without
            // proving it is a fetchable #EXTM3U manifest using the backend's egress.
            let resolved = super::validate_external_embed_hls_playlist(
                client,
                url.as_str(),
                Some("https://cinejoy.to/"),
                timeout_ms.min(8000),
            )
            .await?;
            valid_playlist(&resolved.playback_url, server).then_some(resolved)
        },
    )
    .await
    .ok()?
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
