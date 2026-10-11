use serde::Deserialize;
use url::Url;

use super::{ExternalEmbedHlsPlaybackSource, ResolveMetadata};

const ORIGIN: &str = "https://embed.vidrift.net/";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn provider_name(provider: &str) -> Option<&'static str> {
    match provider {
        "vidrift-evion" => Some("evion"),
        "vidrift-vela" => Some("vela"),
        _ => None,
    }
}

pub(super) fn source_url(provider: &str, metadata: &ResolveMetadata) -> Option<String> {
    let provider = provider_name(provider)?;
    let id = metadata.tmdb_id.trim();
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let path = match metadata.media_type.as_str() {
        "movie" => format!("movie/{id}"),
        "tv" if metadata.season_number > 0 && metadata.episode_number > 0 => format!(
            "tv/{id}/{}/{}",
            metadata.season_number, metadata.episode_number
        ),
        _ => return None,
    };
    Some(format!("{ORIGIN}embed2/{path}?provider={provider}"))
}

#[derive(Deserialize)]
struct Boot {
    meta: BootMeta,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootMeta {
    playback_token: String,
    evion_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sources {
    success: bool,
    provider: String,
    #[serde(default)]
    fell_back: bool,
    streams: Vec<Stream>,
}

#[derive(Deserialize)]
struct Stream {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "proxyUrl")]
    proxy_url: String,
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    provider: &str,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let embed = Url::parse(&source_url(provider, metadata)?).ok()?;
    let path = embed.path().strip_prefix("/embed2/")?;
    let origin = Url::parse(ORIGIN).ok()?;
    let (_, bytes) = fetch_bytes(
        client,
        origin.join(&format!("api/boot/{path}")).ok()?,
        MAX_RESPONSE_BYTES,
        timeout_ms,
    )
    .await?;
    // Use the public embed's short-lived grant. No stored site credentials or
    // fabricated parent identity; a denied/missing title is unavailable here too.
    let boot: Boot = serde_json::from_slice(&bytes).ok()?;
    let playback_url = match provider_name(provider)? {
        "evion" => origin.join(boot.meta.evion_url.as_deref()?).ok()?,
        "vela" => {
            if boot.meta.playback_token.is_empty() {
                return None;
            }
            let mut endpoint = origin.join(&format!("api/source/{path}")).ok()?;
            endpoint.query_pairs_mut().extend_pairs([
                ("token", boot.meta.playback_token.as_str()),
                ("provider", "vela"),
                ("nofallback", "1"),
            ]);
            let (_, bytes) = fetch_bytes(client, endpoint, MAX_RESPONSE_BYTES, timeout_ms).await?;
            let sources: Sources = serde_json::from_slice(&bytes).ok()?;
            origin.join(pinned_vela_url(&sources)?).ok()?
        }
        _ => return None,
    };
    let (playback_url, bytes) =
        fetch_bytes(client, playback_url, MAX_RESPONSE_BYTES, timeout_ms).await?;
    let playlist = std::str::from_utf8(&bytes).ok()?;
    if !playlist.trim_start().starts_with("#EXTM3U") {
        return None;
    }
    let full_hd = if super::hls_quality::offers_full_hd(playlist) {
        true
    } else if provider == "vidrift-vela" {
        // Vela returns a single fMP4 media playlist, without a resolution ladder.
        // Read the tiny initialization segment's AVC sample entry instead of
        // trusting its API's HD/maxRes badge or spawning ffprobe on every play.
        let init_url = init_segment_url(&playback_url, playlist)?;
        let (_, init) = fetch_bytes(client, init_url, 512 * 1024, timeout_ms).await?;
        let (width, height) = avc_dimensions(&init, 0)?;
        width >= 1920 || height >= 1080
    } else {
        false
    };
    full_hd.then_some(ExternalEmbedHlsPlaybackSource {
        playback_url,
        referer: Some(ORIGIN.to_owned()),
        full_hd,
    })
}

fn pinned_vela_url(sources: &Sources) -> Option<&str> {
    if !sources.success || sources.provider != "vela" || sources.fell_back {
        return None;
    }
    // The first rendition is Vela's original/highest-quality source. Never
    // attribute a raced provider or an alternate language to this source pin.
    let stream = sources.streams.first()?;
    if stream.kind != "hls" {
        return None;
    }
    let url = if stream.url.is_empty() {
        &stream.proxy_url
    } else {
        &stream.url
    };
    (!url.is_empty()).then_some(url.as_str())
}

fn init_segment_url(base: &Url, playlist: &str) -> Option<Url> {
    if !playlist.lines().any(|line| line.starts_with("#EXTINF:")) {
        return None;
    }
    let map = playlist
        .lines()
        .find_map(|line| line.strip_prefix("#EXT-X-MAP:"))?;
    // Only standalone, bounded initialization files are supported. Do not
    // download a whole movie when a provider changes to a byte-range map.
    if map.contains("BYTERANGE=") {
        return None;
    }
    let (_, uri) = map.split_once("URI=\"")?;
    let (uri, _) = uri.split_once('"')?;
    let url = base.join(uri).ok()?;
    valid_destination(&url).then_some(url)
}

/// Inspect ISO BMFF sample entries, not track display dimensions or API labels.
/// The depth/length checks keep malformed upstream files bounded and panic-free.
fn avc_dimensions(mut data: &[u8], depth: u8) -> Option<(u16, u16)> {
    if depth > 8 {
        return None;
    }
    while data.len() >= 8 {
        let size = u32::from_be_bytes(data[..4].try_into().ok()?);
        let (size, header) = match size {
            0 => (data.len(), 8),
            1 => (
                usize::try_from(u64::from_be_bytes(data.get(8..16)?.try_into().ok()?)).ok()?,
                16,
            ),
            size => (size as usize, 8),
        };
        if size < header || size > data.len() {
            return None;
        }
        let payload = &data[header..size];
        let dimensions = match &data[4..8] {
            b"avc1" | b"avc3" => {
                let width = u16::from_be_bytes(payload.get(24..26)?.try_into().ok()?);
                let height = u16::from_be_bytes(payload.get(26..28)?.try_into().ok()?);
                (width > 0 && height > 0).then_some((width, height))
            }
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" => avc_dimensions(payload, depth + 1),
            b"stsd" => avc_dimensions(payload.get(8..)?, depth + 1),
            _ => None,
        };
        if dimensions.is_some() {
            return dimensions;
        }
        data = &data[size..];
    }
    None
}

fn valid_destination(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(super::is_public_external_embed_hls_hostname)
}

async fn fetch_bytes(
    client: &reqwest::Client,
    mut url: Url,
    limit: usize,
    timeout_ms: u64,
) -> Option<(Url, Vec<u8>)> {
    // The shared client pins public DNS answers and disables automatic
    // redirects. Check every hop before handing it to that transport.
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
            .header(reqwest::header::REFERER, ORIGIN)
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
                .is_some_and(|len| len > limit as u64)
        {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > limit {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        return Some((url, bytes));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(kind: &str, id: &str) -> ResolveMetadata {
        ResolveMetadata {
            tmdb_id: id.into(),
            media_type: kind.into(),
            season_number: 1,
            episode_number: 1,
            imdb_id: String::new(),
            display_title: String::new(),
            display_year: String::new(),
            runtime_seconds: 0,
            episode_title: String::new(),
        }
    }

    #[test]
    fn pins_are_bound_to_a_known_provider_and_valid_title() {
        let mut title = metadata("tv", "1399");
        assert_eq!(
            source_url("vidrift-evion", &title).as_deref(),
            Some("https://embed.vidrift.net/embed2/tv/1399/1/1?provider=evion")
        );
        title.media_type = "movie".into();
        assert_eq!(
            source_url("vidrift-vela", &title).as_deref(),
            Some("https://embed.vidrift.net/embed2/movie/1399?provider=vela")
        );
        assert!(source_url("vidrift-orion", &title).is_none());
        title.tmdb_id = "../admin".into();
        assert!(source_url("vidrift-vela", &title).is_none());
        title.tmdb_id = "1399".into();
        title.media_type = "tv".into();
        title.episode_number = 0;
        assert!(source_url("vidrift-vela", &title).is_none());
    }

    #[tokio::test]
    #[ignore = "Opt-in public provider smoke check; requires the current upstream service"]
    async fn live_hd_resolve_uses_the_hardened_transport() {
        let client =
            crate::egress_policy::hardened_provider_client_builder(reqwest::Client::builder())
                .build()
                .unwrap();
        for (provider, title) in [
            ("vidrift-evion", metadata("tv", "1399")),
            ("vidrift-evion", metadata("tv", "66732")),
            ("vidrift-vela", metadata("movie", "157336")),
            ("vidrift-vela", metadata("movie", "238")),
        ] {
            let start = std::time::Instant::now();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                resolve(&client, provider, &title, 15_000),
            )
            .await
            .unwrap();
            assert!(
                result.is_some_and(|source| source.full_hd),
                "{provider} {}",
                title.tmdb_id
            );
            println!(
                "{provider} {}: full HD in {:?}",
                title.tmdb_id,
                start.elapsed()
            );
        }
    }

    fn mp4_box(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(data);
        bytes
    }

    #[test]
    fn reads_avc_sample_dimensions_and_rejects_truncated_or_other_codecs() {
        let mut sample = vec![0; 78];
        sample[24..26].copy_from_slice(&1920_u16.to_be_bytes());
        sample[26..28].copy_from_slice(&1080_u16.to_be_bytes());
        let avc = mp4_box(b"avc1", &sample);
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend_from_slice(&avc);
        let init = mp4_box(b"moov", &mp4_box(b"stsd", &stsd));
        assert_eq!(avc_dimensions(&init, 0), Some((1920, 1080)));
        for end in 0..init.len() {
            assert_eq!(avc_dimensions(&init[..end], 0), None);
        }
        assert_eq!(avc_dimensions(&mp4_box(b"hvc1", &sample), 0), None);
        assert_eq!(
            avc_dimensions(&[0, 0, 0, 1, b'm', b'o', b'o', b'v'], 0),
            None
        );
        assert_eq!(avc_dimensions(&avc, 9), None);
        sample[24..28].fill(0);
        assert_eq!(avc_dimensions(&mp4_box(b"avc1", &sample), 0), None);
    }

    #[test]
    fn refuses_fallback_attribution_and_non_hls_responses() {
        let mut sources: Sources = serde_json::from_value(serde_json::json!({
            "success": true, "provider": "vela", "fellBack": false,
            "streams": [{"type": "hls", "proxyUrl": "https://relay.vidrift.net/proxy?u=test"}]
        }))
        .unwrap();
        assert!(pinned_vela_url(&sources).is_some());
        sources.fell_back = true;
        assert!(pinned_vela_url(&sources).is_none());
        sources.fell_back = false;
        sources.provider = "lyra".into();
        assert!(pinned_vela_url(&sources).is_none());
        sources.provider = "vela".into();
        sources.streams[0].kind = "mp4".into();
        assert!(pinned_vela_url(&sources).is_none());
    }

    #[test]
    fn init_map_is_bounded_and_cannot_target_private_urls() {
        let base = Url::parse("https://relay.vidrift.net/a/media.m3u8").unwrap();
        assert_eq!(
            init_segment_url(
                &base,
                "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\n1.m4s"
            )
            .unwrap()
            .as_str(),
            "https://relay.vidrift.net/a/init.mp4"
        );
        for map in [
            "URI=\"https://localhost/init\"",
            "URI=\"http://cdn.example/init\"",
            "URI=\"https://secret@cdn.example/init\"",
            "URI=\"https://cdn.example:8443/init\"",
            "URI=\"init.mp4\",BYTERANGE=\"100@0\"",
            "URI=\"https://127.0.0.1/init\"",
        ] {
            assert!(
                init_segment_url(
                    &base,
                    &format!("#EXTM3U\n#EXT-X-MAP:{map}\n#EXTINF:6,\n1.m4s")
                )
                .is_none()
            );
        }
    }
}
