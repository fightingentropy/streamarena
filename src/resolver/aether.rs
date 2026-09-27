use serde::Deserialize;
use url::Url;

use super::{ExternalEmbedHlsPlaybackSource, ResolveMetadata};

const REFERER: &str = "https://aether.ist/";

pub(super) fn source_url(provider: &str, metadata: &ResolveMetadata) -> Option<String> {
    let host = match provider {
        "aether-lul" => "lul.aether.cx",
        "aether-link" => "link.aether.cx",
        _ => return None,
    };
    let id = metadata.tmdb_id.trim();
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match metadata.media_type.as_str() {
        "movie" => Some(format!("https://{host}/movie/{id}")),
        "tv" if metadata.season_number > 0 && metadata.episode_number > 0 => Some(format!(
            "https://{host}/tv/{id}/{}/{}",
            metadata.season_number, metadata.episode_number
        )),
        _ => None,
    }
}

#[derive(Deserialize)]
struct StreamResponse {
    stream: String,
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    provider: &str,
    endpoint: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let playback_referer = match provider {
        "aether-lul" => REFERER,
        // Observed in Aether's Link player request headers; its lookup API uses
        // the site referer, but CDN segments reject that referer with HTTP 403.
        "aether-link" => "https://nextgencloudfabric.com/",
        _ => return None,
    };
    let response =
        super::fetch_external_json::<StreamResponse>(client, endpoint, Some(REFERER), timeout_ms)
            .await?;
    let mut url = Url::parse(response.stream.trim()).ok()?;
    // The hardened client never follows redirects itself. Authorize every hop
    // and retain its DNS-pinned public-only transport, including the CDN hop.
    for _ in 0..4 {
        if !valid_destination(&url) {
            return None;
        }
        let mut response = client
            .get(url.clone())
            .header(
                reqwest::header::USER_AGENT,
                super::EXTERNAL_EMBED_USER_AGENT,
            )
            .header(reqwest::header::REFERER, playback_referer)
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .send()
            .await
            .ok()?;
        if response.status().is_redirection() {
            url = url
                .join(
                    response
                        .headers()
                        .get(reqwest::header::LOCATION)?
                        .to_str()
                        .ok()?,
                )
                .ok()?;
            continue;
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|len| len > 2 * 1024 * 1024)
        {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        let playlist = std::str::from_utf8(&bytes).ok()?;
        return super::hls_quality::offers_full_hd(playlist).then_some(
            ExternalEmbedHlsPlaybackSource {
                playback_url: url,
                referer: Some(playback_referer.to_owned()),
            },
        );
    }
    None
}

fn valid_destination(url: &Url) -> bool {
    !(url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some())
        && url
            .host_str()
            .is_some_and(super::is_public_external_embed_hls_hostname)
}

#[cfg(test)]
mod tests {
    use super::{source_url, valid_destination};
    use crate::resolver::ResolveMetadata;

    #[test]
    fn source_identity_stays_bound_to_provider_title_and_episode() {
        let mut metadata = ResolveMetadata {
            tmdb_id: "1399".into(),
            media_type: "tv".into(),
            season_number: 1,
            episode_number: 2,
            imdb_id: String::new(),
            display_title: String::new(),
            display_year: String::new(),
            runtime_seconds: 0,
            episode_title: String::new(),
        };
        assert_eq!(
            source_url("aether-lul", &metadata).as_deref(),
            Some("https://lul.aether.cx/tv/1399/1/2")
        );
        metadata.media_type = "movie".into();
        assert_eq!(
            source_url("aether-link", &metadata).as_deref(),
            Some("https://link.aether.cx/movie/1399")
        );
        assert!(source_url("aether-unknown", &metadata).is_none());
        metadata.tmdb_id = "../admin".into();
        assert!(source_url("aether-lul", &metadata).is_none());
    }

    #[test]
    fn redirects_cannot_change_to_private_or_credentialed_destinations() {
        for url in [
            "http://cdn.example/master.m3u8",
            "https://127.0.0.1/private",
            "https://localhost/private",
            "https://[::1]/private",
            "https://foo.internal/x",
            "https://secret@cdn.example/x",
            "https://cdn.example:8443/x",
        ] {
            assert!(!valid_destination(&url.parse().unwrap()), "{url}");
        }
        assert!(valid_destination(
            &"https://cdn.example/master.m3u8".parse().unwrap()
        ));
    }
}
