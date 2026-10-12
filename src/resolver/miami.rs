//! Miami's public Movy resolver, also used by FrameX's browser player.
//! Resolve directly instead of depending on FrameX's slower server-side mirror.

use base64::Engine;
use serde::Deserialize;
use std::time::Duration;
use url::Url;

use super::{ExternalEmbedHlsPlaybackSource, ResolveMetadata};

const API: &str = "https://api.wecollege.net/";
const REFERER: &str = "https://www.movy.bz/";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn source_url(metadata: &ResolveMetadata) -> Option<String> {
    let id = title_id(metadata)?;
    let path = match metadata.media_type.as_str() {
        "movie" => format!("movie/{id}"),
        "tv" if metadata.season_number > 0 && metadata.episode_number > 0 => format!(
            "tv/{id}/{}/{}",
            metadata.season_number, metadata.episode_number
        ),
        _ => return None,
    };
    Some(format!("https://framextv.xyz/embed/{path}?provider=miner"))
}

fn title_id(metadata: &ResolveMetadata) -> Option<u32> {
    let id = metadata.tmdb_id.trim();
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    id.parse::<u32>().ok().filter(|id| *id > 0)
}

#[derive(Deserialize)]
struct Seed {
    seed: String,
}

#[derive(Deserialize)]
struct Sources {
    #[serde(default)]
    playlist: String,
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    // Bound the whole lookup, not five independent per-request timeouts.
    tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        resolve_inner(client, metadata),
    )
    .await
    .ok()
    .flatten()
}

async fn resolve_inner(
    client: &reqwest::Client,
    metadata: &ResolveMetadata,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    source_url(metadata)?;
    let id = title_id(metadata)?;
    let api = Url::parse(API).ok()?;
    let mut seed_url = api.join("seed").ok()?;
    seed_url
        .query_pairs_mut()
        .append_pair("mediaId", &id.to_string());
    let (_, seed_bytes) = fetch_bytes(client, seed_url, 16 * 1024).await?;
    let seed: Seed = serde_json::from_slice(&seed_bytes).ok()?;
    if seed.seed.is_empty() || seed.seed.len() > 4096 {
        return None;
    }
    let mut endpoint = api.join("miami/sources").ok()?;
    endpoint.query_pairs_mut().extend_pairs([
        ("mediaType", metadata.media_type.as_str()),
        ("tmdbId", &id.to_string()),
        ("enc", "2"),
        ("seed", seed.seed.as_str()),
    ]);
    if metadata.media_type == "tv" {
        endpoint.query_pairs_mut().extend_pairs([
            ("seasonId", metadata.season_number.to_string()),
            ("episodeId", metadata.episode_number.to_string()),
        ]);
    }
    let (_, encoded) = fetch_bytes(client, endpoint, MAX_RESPONSE_BYTES).await?;
    let sources = decode_sources(std::str::from_utf8(&encoded).ok()?, &seed.seed, id)?;
    let (master_url, master) = fetch_bytes(
        client,
        Url::parse(&sources.playlist).ok()?,
        MAX_RESPONSE_BYTES,
    )
    .await?;
    let (rendition, advertised_pixels) =
        highest_hd_rendition(&master_url, std::str::from_utf8(&master).ok()?)?;
    let (media_url, media) = fetch_bytes(client, rendition, MAX_RESPONSE_BYTES).await?;
    let init_url = init_segment_url(&media_url, std::str::from_utf8(&media).ok()?)?;
    let (_, init) = fetch_bytes(client, init_url, 512 * 1024).await?;
    if !verified_hd_init(&init, advertised_pixels) {
        return None;
    }
    // Keep the master: the player can start quickly with ABR and still expose
    // the verified 4K rendition. Returning a 1080p child would hide that option.
    Some(ExternalEmbedHlsPlaybackSource {
        playback_url: master_url,
        referer: Some(REFERER.to_owned()),
        full_hd: true,
    })
}

fn verified_hd_init(init: &[u8], advertised_pixels: u64) -> bool {
    super::hls_quality::avc_dimensions(init, 0).is_some_and(|(width, height)| {
        (width >= 1920 || height >= 1080)
            // Permit small coded/display aspect differences, but not false 4K.
            && u64::from(width) * u64::from(height) >= advertised_pixels.saturating_mul(9) / 10
    })
}

fn highest_hd_rendition(base: &Url, playlist: &str) -> Option<(Url, u64)> {
    if !playlist.trim_start().starts_with("#EXTM3U") {
        return None;
    }
    let mut pending = None;
    let mut best: Option<(u64, Url)> = None;
    for line in playlist.lines().map(str::trim) {
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = attributes.split(',').find_map(|attribute| {
                let (width, height) = attribute
                    .trim()
                    .strip_prefix("RESOLUTION=")?
                    .split_once('x')?;
                let (width, height) = (width.parse::<u32>().ok()?, height.parse::<u32>().ok()?);
                (width > 0 && height > 0 && (width >= 1920 || height >= 1080))
                    .then_some(u64::from(width) * u64::from(height))
            });
        } else if !line.is_empty()
            && !line.starts_with('#')
            && let Some(pixels) = pending.take()
            && let Ok(url) = base.join(line)
            && valid_destination(&url)
            && best.as_ref().is_none_or(|(previous, _)| pixels > *previous)
        {
            best = Some((pixels, url));
        }
    }
    best.map(|(pixels, url)| (url, pixels))
}

fn init_segment_url(base: &Url, playlist: &str) -> Option<Url> {
    if !playlist.trim_start().starts_with("#EXTM3U")
        || !playlist.lines().any(|line| line.starts_with("#EXTINF:"))
    {
        return None;
    }
    let map = playlist
        .lines()
        .find_map(|line| line.strip_prefix("#EXT-X-MAP:"))?;
    // A separate, small fMP4 initialization file proves encoded dimensions
    // without downloading a film or spawning ffprobe during startup.
    if map.contains("BYTERANGE=") {
        return None;
    }
    let (_, uri) = map.split_once("URI=\"")?;
    let (uri, _) = uri.split_once('"')?;
    let url = base.join(uri).ok()?;
    valid_destination(&url).then_some(url)
}

fn mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(2_246_822_507);
    value ^= value >> 13;
    value = value.wrapping_mul(3_266_489_909);
    value ^ (value >> 16)
}

fn decode_sources(encoded: &str, seed: &str, id: u32) -> Option<Sources> {
    if encoded.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let mut bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.trim().trim_end_matches('='))
        .ok()?;
    if bytes.len() <= 4 {
        return None;
    }
    // The public response format binds its short-lived seed to the TMDB id.
    // Wrapping u32 arithmetic matches the browser's bitwise implementation.
    let hash = seed.encode_utf16().fold(2_166_136_261_u32, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(16_777_619)
    });
    let mut acc = mix(mix(hash) ^ mix(id ^ 2_654_435_769));
    let mut state = [None; 61];
    for index in 0..8 {
        let slot = (acc % 61) as usize;
        acc = acc.wrapping_add(2_654_435_769).rotate_left(7 + index);
        state[slot] = Some(acc ^ mix(acc));
        acc = mix(acc.wrapping_add(slot as u32));
    }
    acc = mix(2_779_096_485 ^ acc);
    for (index, chunk) in bytes.chunks_mut(4).enumerate() {
        let slot = (acc % 61) as usize;
        let mask = if state[slot].is_some() { u32::MAX } else { 0 };
        let word = state[slot].unwrap_or_default() ^ (index as u32 + 1).wrapping_mul(2_654_435_769);
        acc = mix((((acc ^ word) | (acc & word & mask))
            .wrapping_add(acc)
            .rotate_left(slot as u32)
            ^ acc.rotate_left(slot as u32 * 7))
        .wrapping_add(2_654_435_769));
        state[slot] = Some(acc);
        for (byte, key) in chunk.iter_mut().zip(acc.to_le_bytes()) {
            *byte ^= key;
        }
    }
    (bytes.starts_with(b"mvm1"))
        .then(|| serde_json::from_slice(&bytes[4..]).ok())
        .flatten()
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
) -> Option<(Url, Vec<u8>)> {
    // The shared transport pins public DNS and disables automatic redirects.
    // Validate every hop, bound decompressed bodies, and never forward secrets.
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
            .header(reqwest::header::REFERER, REFERER)
            .header(reqwest::header::ORIGIN, "https://www.movy.bz")
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
    fn public_wire_fixture_is_bound_to_seed_and_title() {
        let encoded = "GI8ByItADYiM2BWec337lnygkJd2psyNOLsx3AveCfhSGIs7nwsy18GQvJZIK3dgWvM";
        assert_eq!(
            decode_sources(encoded, "miami-test-seed", 1399)
                .unwrap()
                .playlist,
            "https://cdn.example/master.m3u8"
        );
        assert!(decode_sources(encoded, "wrong-seed", 1399).is_none());
        assert!(decode_sources(encoded, "miami-test-seed", 155).is_none());
        for malformed in ["", "AA", "<html>Unavailable</html>"] {
            assert!(decode_sources(malformed, "miami-test-seed", 1399).is_none());
        }
        assert!(decode_sources(&"a".repeat(MAX_RESPONSE_BYTES + 1), "seed", 1399).is_none());
    }

    #[test]
    fn identity_rejects_invalid_titles_and_keeps_episode_scope() {
        let mut title = metadata("tv", "1399");
        assert_eq!(
            source_url(&title).as_deref(),
            Some("https://framextv.xyz/embed/tv/1399/1/1?provider=miner")
        );
        title.episode_number = 2;
        assert!(source_url(&title).unwrap().contains("/1/2?"));
        title.episode_number = 0;
        assert!(source_url(&title).is_none());
        for id in ["0", "../seed", "4294967296", "+155"] {
            assert!(source_url(&metadata("movie", id)).is_none());
        }
        assert!(source_url(&metadata("anime", "155")).is_none());
    }

    #[test]
    fn selects_real_video_variants_and_rejects_unsafe_or_low_resolution_urls() {
        let base = Url::parse("https://cdn.example/title/master.m3u8").unwrap();
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nhd.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\nlow.m3u8\n";
        let (url, pixels) = highest_hd_rendition(&base, master).unwrap();
        assert_eq!(url.as_str(), "https://cdn.example/title/4k.m3u8");
        assert_eq!(pixels, 3840 * 2160);
        for invalid in [
            "#EXTM3U\n#EXT-X-STREAM-INF:NAME=\"4K\",RESOLUTION=1280x720\nlow.m3u8",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160",
            "#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:RESOLUTION=3840x2160,URI=\"thumbs.m3u8\"",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nhttps://127.0.0.1/private",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nfile:///etc/passwd",
        ] {
            assert!(highest_hd_rendition(&base, invalid).is_none(), "{invalid}");
        }
        for unsafe_url in [
            "http://cdn.example/a",
            "https://user:pass@cdn.example/a",
            "https://localhost/a",
            "https://[::1]/a",
            "https://cdn.example:8443/a",
        ] {
            assert!(!valid_destination(&Url::parse(unsafe_url).unwrap()));
        }
        assert!(
            init_segment_url(
                &base,
                "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\na.m4s"
            )
            .is_some()
        );
        assert!(
            init_segment_url(
                &base,
                "#EXTM3U\n#EXT-X-MAP:URI=\"movie.mp4\",BYTERANGE=\"100@0\"\n#EXTINF:6,\na.m4s"
            )
            .is_none()
        );
    }

    #[test]
    fn encoded_dimensions_reject_false_hd_and_false_4k_badges() {
        let init = |width: u16, height: u16| {
            let mut data = vec![0_u8; 36];
            data[..4].copy_from_slice(&36_u32.to_be_bytes());
            data[4..8].copy_from_slice(b"avc1");
            data[32..34].copy_from_slice(&width.to_be_bytes());
            data[34..36].copy_from_slice(&height.to_be_bytes());
            data
        };
        assert!(!verified_hd_init(&init(1280, 720), 1920 * 1080));
        assert!(!verified_hd_init(&init(1920, 1080), 3840 * 2160));
        assert!(verified_hd_init(&init(1920, 800), 1920 * 800));
        assert!(verified_hd_init(&init(3832, 1600), 3840 * 1600));
        assert!(verified_hd_init(&init(3840, 2160), 3840 * 2160));
        assert!(!verified_hd_init(
            b"not an initialization segment",
            1920 * 1080
        ));
    }

    #[tokio::test]
    #[ignore = "Opt-in public Miami check; requires the current upstream service"]
    async fn live_miami_keeps_master_after_verifying_encoded_dimensions() {
        let client =
            crate::egress_policy::hardened_provider_client_builder(reqwest::Client::builder())
                .build()
                .unwrap();
        for title in [
            metadata("movie", "157336"),
            metadata("movie", "155"),
            metadata("tv", "1399"),
        ] {
            let start = std::time::Instant::now();
            let source = resolve(&client, &title, 12_000)
                .await
                .expect("verified full-HD Miami source");
            assert!(source.full_hd);
            assert_eq!(source.referer.as_deref(), Some(REFERER));
            eprintln!(
                "Miami {}: verified master in {:?}",
                title.tmdb_id,
                start.elapsed()
            );
        }
    }
}
