use base64::Engine as _;
use serde::Deserialize;
use url::Url;

use super::{ExternalEmbedHlsPlaybackSource, ResolveMetadata};

const ORIGIN: &str = "https://player.vidzee.wtf/";
const API: &str = "https://core.vidzee.wtf/";
// FrameX audit (2026-10-25): its "Root Rider" source. The player decrypts the
// `c` field with RC4 after discarding 2048 keystream bytes; the key is a
// constant in the WASM module shipped in its `streams-*.js` chunk.
const STREAM_KEY: [u8; 32] = [
    0xe4, 0xf9, 0xb2, 0x7d, 0x8c, 0x1a, 0x6e, 0xf5, 0x03, 0x7d, 0xb9, 0x8a, 0xc5, 0x4e, 0x21, 0xf0,
    0xb9, 0xd6, 0xc3, 0xa7, 0x81, 0xfe, 0x42, 0xad, 0x65, 0xc0, 0xe9, 0xb7, 0x3f, 0x14, 0x8a, 0x2d,
];
const KEYSTREAM_DROP: usize = 2048;
// Both servers come from the same lookup API but separate CDN hosts
// (cdn2/cdn1.fastcloud.live), so the second covers a failing first CDN.
const SERVERS: &[&str] = &["dcloud", "ipcloud"];
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
// Enough of the first MPEG-TS segment to reach its leading SPS.
const SEGMENT_PROBE_BYTES: usize = 256 * 1024;
const TS_PACKET_LEN: usize = 188;

pub(super) fn source_url(metadata: &ResolveMetadata) -> Option<String> {
    let path = title_path(metadata)?;
    Some(format!("{ORIGIN}embed/{path}"))
}

fn title_path(metadata: &ResolveMetadata) -> Option<String> {
    let id = metadata.tmdb_id.trim();
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match metadata.media_type.as_str() {
        "movie" => Some(format!("movie/{id}")),
        "tv" if metadata.season_number > 0 && metadata.episode_number > 0 => Some(format!(
            "tv/{id}/{}/{}",
            metadata.season_number, metadata.episode_number
        )),
        _ => None,
    }
}

#[derive(Deserialize)]
struct EncryptedResponse {
    c: String,
}

#[derive(Deserialize)]
struct Stream {
    url: String,
    #[serde(default)]
    headers: serde_json::Map<String, serde_json::Value>,
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    metadata: &ResolveMetadata,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let path = title_path(metadata)?;
    for server in SERVERS {
        if let Some(source) = resolve_server(client, &path, server, timeout_ms).await {
            return Some(source);
        }
    }
    None
}

async fn resolve_server(
    client: &reqwest::Client,
    path: &str,
    server: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsPlaybackSource> {
    let mut endpoint = Url::parse(API)
        .ok()?
        .join(&format!("streams/{path}"))
        .ok()?;
    endpoint
        .query_pairs_mut()
        .extend_pairs([("s", server), ("e", "1")]);
    let (_, bytes) = fetch_bytes(client, endpoint, None, MAX_RESPONSE_BYTES, timeout_ms).await?;
    let response: EncryptedResponse = serde_json::from_slice(&bytes).ok()?;
    let playback_url = stream_playlist_url(decrypt_stream(&response.c)?)?;
    let (playback_url, bytes) =
        fetch_bytes(client, playback_url, None, MAX_RESPONSE_BYTES, timeout_ms).await?;
    let playlist = std::str::from_utf8(&bytes).ok()?;
    if !playlist.trim_start().starts_with("#EXTM3U") {
        return None;
    }
    let full_hd = if super::hls_quality::offers_full_hd(playlist) {
        true
    } else {
        // A single MPEG-TS media playlist, without a resolution ladder. Read
        // the first segment's SPS rather than trusting a quality label.
        let segment_url = first_segment_url(&playback_url, playlist)?;
        let (_, head) = fetch_bytes(
            client,
            segment_url,
            Some(SEGMENT_PROBE_BYTES),
            SEGMENT_PROBE_BYTES,
            timeout_ms,
        )
        .await?;
        let (width, height) = ts_h264_dimensions(&head)?;
        width >= 1920 || height >= 1080
    };
    full_hd.then_some(ExternalEmbedHlsPlaybackSource {
        playback_url,
        referer: Some(ORIGIN.to_owned()),
        full_hd,
    })
}

fn stream_playlist_url(stream: Stream) -> Option<Url> {
    // The relay can only forward a Referer. Refuse streams that need more.
    if !stream.headers.is_empty() {
        return None;
    }
    let url = Url::parse(stream.url.trim()).ok()?;
    (url.path().ends_with(".m3u8") && valid_destination(&url)).then_some(url)
}

fn decrypt_stream(encoded: &str) -> Option<Stream> {
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    rc4_drop_apply(&STREAM_KEY, KEYSTREAM_DROP, &mut bytes);
    serde_json::from_slice(&bytes).ok()
}

fn rc4_drop_apply(key: &[u8], drop: usize, data: &mut [u8]) {
    let mut state: [u8; 256] = std::array::from_fn(|index| index as u8);
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(state[i]).wrapping_add(key[i % key.len()]);
        state.swap(i, j as usize);
    }
    let (mut i, mut j) = (0u8, 0u8);
    let mut next = || {
        i = i.wrapping_add(1);
        j = j.wrapping_add(state[i as usize]);
        state.swap(i as usize, j as usize);
        state[state[i as usize].wrapping_add(state[j as usize]) as usize]
    };
    for _ in 0..drop {
        next();
    }
    for byte in data {
        *byte ^= next();
    }
}

fn first_segment_url(base: &Url, playlist: &str) -> Option<Url> {
    if playlist.contains("#EXT-X-KEY:") && !playlist.contains("METHOD=NONE") {
        return None;
    }
    let mut lines = playlist.lines().map(str::trim);
    lines.find(|line| line.starts_with("#EXTINF:"))?;
    let uri = lines.find(|line| !line.is_empty() && !line.starts_with('#'))?;
    let url = base.join(uri).ok()?;
    valid_destination(&url).then_some(url)
}

/// Encoded dimensions of the first H.264 SPS in an MPEG-TS byte prefix.
fn ts_h264_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let video = ts_h264_elementary_stream(bytes)?;
    let sps = annex_b_nal_units(&video).find(|nal| nal.first().is_some_and(|b| b & 0x1f == 7))?;
    h264_sps_dimensions(sps)
}

fn ts_h264_elementary_stream(bytes: &[u8]) -> Option<Vec<u8>> {
    let start = (0..bytes.len().min(TS_PACKET_LEN)).find(|&offset| {
        bytes.get(offset) == Some(&0x47) && bytes.get(offset + TS_PACKET_LEN) == Some(&0x47)
    })?;
    let mut pmt_pid = None;
    let mut video_pid = None;
    let mut stream = Vec::new();
    // A PES may carry only its header in the first packet; keep collecting.
    let mut pes_started = false;
    for packet in bytes[start..].as_chunks::<TS_PACKET_LEN>().0 {
        if packet[0] != 0x47 {
            return None;
        }
        let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
        let unit_start = packet[1] & 0x40 != 0;
        let control = (packet[3] >> 4) & 0x3;
        if control & 0x1 == 0 {
            continue;
        }
        let mut payload_start = 4;
        if control & 0x2 != 0 {
            payload_start += 1 + usize::from(packet[4]);
        }
        let Some(payload) = packet.get(payload_start..) else {
            continue;
        };
        if pid == 0 && unit_start && pmt_pid.is_none() {
            pmt_pid = psi_section(payload).and_then(pat_pmt_pid);
        } else if Some(pid) == pmt_pid && unit_start && video_pid.is_none() {
            video_pid = psi_section(payload).and_then(pmt_h264_pid);
        } else if Some(pid) == video_pid {
            if unit_start {
                // PES header: start code, stream id, length, flags, header length.
                if payload.len() < 9 || payload[..3] != [0, 0, 1] {
                    return None;
                }
                let header_end = 9 + usize::from(payload[8]);
                stream.extend_from_slice(payload.get(header_end..)?);
                pes_started = true;
            } else if pes_started {
                stream.extend_from_slice(payload);
            }
        }
    }
    (!stream.is_empty()).then_some(stream)
}

fn psi_section(payload: &[u8]) -> Option<&[u8]> {
    let pointer = usize::from(*payload.first()?);
    let section = payload.get(1 + pointer..)?;
    let length = usize::from(u16::from_be_bytes([*section.get(1)?, *section.get(2)?]) & 0x0fff);
    // Header through last_section_number, without the trailing CRC.
    section.get(..3 + length.checked_sub(4)?)
}

fn pat_pmt_pid(section: &[u8]) -> Option<u16> {
    if *section.first()? != 0x00 {
        return None;
    }
    section
        .get(8..)?
        .as_chunks::<4>()
        .0
        .iter()
        .find_map(|entry| {
            let program = u16::from_be_bytes([entry[0], entry[1]]);
            (program != 0).then_some(u16::from_be_bytes([entry[2], entry[3]]) & 0x1fff)
        })
}

fn pmt_h264_pid(section: &[u8]) -> Option<u16> {
    if *section.first()? != 0x02 {
        return None;
    }
    let info_len = usize::from(u16::from_be_bytes([*section.get(10)?, *section.get(11)?]) & 0x0fff);
    let mut entries = section.get(12 + info_len..)?;
    while entries.len() >= 5 {
        let stream_type = entries[0];
        let pid = u16::from_be_bytes([entries[1], entries[2]]) & 0x1fff;
        let es_info_len = usize::from(u16::from_be_bytes([entries[3], entries[4]]) & 0x0fff);
        if stream_type == 0x1b {
            return Some(pid);
        }
        entries = entries.get(5 + es_info_len..)?;
    }
    None
}

fn annex_b_nal_units(stream: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= stream.len() {
        if stream[index..index + 3] == [0, 0, 1] {
            starts.push(index + 3);
            index += 3;
        } else {
            index += 1;
        }
    }
    let ends = starts
        .iter()
        .skip(1)
        .map(|&next| next - 3)
        .chain(std::iter::once(stream.len()))
        .collect::<Vec<_>>();
    starts.into_iter().zip(ends).map(move |(start, end)| {
        let mut nal = &stream[start..end];
        while let [rest @ .., 0] = nal {
            nal = rest;
        }
        nal
    })
}

struct BitReader {
    bytes: Vec<u8>,
    position: usize,
}

impl BitReader {
    fn new(nal: &[u8]) -> Self {
        // Remove emulation-prevention bytes (00 00 03 -> 00 00).
        let mut bytes = Vec::with_capacity(nal.len());
        let mut zeros = 0;
        for &byte in nal {
            if zeros >= 2 && byte == 3 {
                zeros = 0;
                continue;
            }
            zeros = if byte == 0 { zeros + 1 } else { 0 };
            bytes.push(byte);
        }
        Self { bytes, position: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        let byte = *self.bytes.get(self.position / 8)?;
        let bit = (byte >> (7 - self.position % 8)) & 1;
        self.position += 1;
        Some(u32::from(bit))
    }

    fn bits(&mut self, count: u32) -> Option<u32> {
        (0..count).try_fold(0, |value, _| Some((value << 1) | self.bit()?))
    }

    fn ue(&mut self) -> Option<u32> {
        let mut leading = 0;
        while self.bit()? == 0 {
            leading += 1;
            if leading > 31 {
                return None;
            }
        }
        Some((1u32 << leading) - 1 + self.bits(leading)?)
    }

    fn se(&mut self) -> Option<i64> {
        let value = i64::from(self.ue()?);
        Some(if value % 2 == 0 {
            -value / 2
        } else {
            (value + 1) / 2
        })
    }
}

fn h264_sps_dimensions(nal: &[u8]) -> Option<(u32, u32)> {
    let mut reader = BitReader::new(nal);
    if reader.bits(8)? & 0x1f != 7 {
        return None;
    }
    let profile = reader.bits(8)?;
    reader.bits(16)?; // constraint flags, level
    reader.ue()?; // seq_parameter_set_id
    let mut chroma_format = 1;
    let mut separate_planes = false;
    if matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        chroma_format = reader.ue()?;
        if chroma_format == 3 {
            separate_planes = reader.bit()? == 1;
        }
        reader.ue()?; // bit_depth_luma_minus8
        reader.ue()?; // bit_depth_chroma_minus8
        reader.bit()?; // qpprime_y_zero_transform_bypass_flag
        if reader.bit()? == 1 {
            for list in 0..if chroma_format == 3 { 12 } else { 8 } {
                if reader.bit()? == 1 {
                    let size = if list < 6 { 16 } else { 64 };
                    let (mut last, mut next) = (8i64, 8i64);
                    for _ in 0..size {
                        if next != 0 {
                            next = (last + reader.se()? + 256) % 256;
                        }
                        last = if next == 0 { last } else { next };
                    }
                }
            }
        }
    }
    reader.ue()?; // log2_max_frame_num_minus4
    match reader.ue()? {
        0 => {
            reader.ue()?;
        }
        1 => {
            reader.bit()?;
            reader.se()?;
            reader.se()?;
            for _ in 0..reader.ue()? {
                reader.se()?;
            }
        }
        _ => {}
    }
    reader.ue()?; // max_num_ref_frames
    reader.bit()?; // gaps_in_frame_num_value_allowed_flag
    let width_mbs = u64::from(reader.ue()?) + 1;
    let height_map_units = u64::from(reader.ue()?) + 1;
    let frame_mbs_only = u64::from(reader.bit()?);
    if frame_mbs_only == 0 {
        reader.bit()?; // mb_adaptive_frame_field_flag
    }
    reader.bit()?; // direct_8x8_inference_flag
    let (mut crop_x, mut crop_y) = (0, 0);
    if reader.bit()? == 1 {
        let mut offset = || reader.ue().map(u64::from);
        let (left, right, top, bottom) = (offset()?, offset()?, offset()?, offset()?);
        let chroma_array = if separate_planes { 0 } else { chroma_format };
        let (unit_x, unit_y) = match chroma_array {
            1 => (2, 2 * (2 - frame_mbs_only)),
            2 => (2, 2 - frame_mbs_only),
            _ => (1, 2 - frame_mbs_only),
        };
        crop_x = unit_x * (left + right);
        crop_y = unit_y * (top + bottom);
    }
    let width = (width_mbs * 16).checked_sub(crop_x)?;
    let height = ((2 - frame_mbs_only) * height_map_units * 16).checked_sub(crop_y)?;
    (width > 0 && height > 0).then_some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
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
    url: Url,
    range: Option<usize>,
    limit: usize,
    timeout_ms: u64,
) -> Option<(Url, Vec<u8>)> {
    fetch_bytes_to(client, url, range, limit, timeout_ms, valid_destination).await
}

async fn fetch_bytes_to(
    client: &reqwest::Client,
    mut url: Url,
    range: Option<usize>,
    limit: usize,
    timeout_ms: u64,
    allowed: fn(&Url) -> bool,
) -> Option<(Url, Vec<u8>)> {
    // The shared client pins public DNS answers and disables automatic
    // redirects. Check every hop before handing it to that transport.
    for _ in 0..4 {
        if !allowed(&url) {
            return None;
        }
        let mut request = client
            .get(url.clone())
            .header(
                reqwest::header::USER_AGENT,
                super::EXTERNAL_EMBED_USER_AGENT,
            )
            .header(reqwest::header::REFERER, ORIGIN)
            .timeout(std::time::Duration::from_millis(timeout_ms));
        if let Some(bytes) = range {
            request = request.header(reqwest::header::RANGE, format!("bytes=0-{}", bytes - 1));
        }
        let mut response = request.send().await.ok()?;
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
        if !response.status().is_success() {
            return None;
        }
        // A whole response over the limit is refused. A ranged probe keeps
        // its prefix, even from a server that ignores Range.
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            let room = limit - bytes.len();
            if chunk.len() > room {
                range?;
                bytes.extend_from_slice(&chunk[..room]);
                break;
            }
            bytes.extend_from_slice(&chunk);
            if range.is_some() && bytes.len() == limit {
                break;
            }
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
            episode_number: 2,
            imdb_id: String::new(),
            display_title: String::new(),
            display_year: String::new(),
            runtime_seconds: 0,
            episode_title: String::new(),
        }
    }

    fn hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn identity_is_bound_to_title_and_episode() {
        let mut title = metadata("tv", "1399");
        assert_eq!(
            source_url(&title).as_deref(),
            Some("https://player.vidzee.wtf/embed/tv/1399/1/2")
        );
        title.media_type = "movie".into();
        assert_eq!(
            source_url(&title).as_deref(),
            Some("https://player.vidzee.wtf/embed/movie/1399")
        );
        title.tmdb_id = "../admin".into();
        assert!(source_url(&title).is_none());
        title.tmdb_id = "1399".into();
        title.media_type = "tv".into();
        title.episode_number = 0;
        assert!(source_url(&title).is_none());
    }

    #[test]
    fn decrypts_the_public_wire_format() {
        // core.vidzee.wtf/streams/movie/157336?s=dcloud&e=1 on 2026-10-25.
        let stream = decrypt_stream(
            "JHd/O54eLA5vxsCtWd93Lje/bCkNsUmiXpP5HAUxlG1BGMmDoAioYOHugRkUURC3E7cir1z3r2EJFsdQ8teqiNyTOI7doqLBlffPV9P+ca6SUzPlb6iRoFMzAsYzPJdSwgyngdq/5KjHboRxTe/z+LNfuURb4Pob13QEcy7Six4yDKeDv2Dk3Gi6elI=",
        )
        .unwrap();
        assert_eq!(
            stream.url,
            "https://cdn2.fastcloud.live/movie/1KuUwpHqeQUHm5OgQ91HJZj8Us7Lr4RS6AUf_NiNWV4.VNYFU4P8/bigtits.m3u8"
        );
        assert!(stream.headers.is_empty());
        assert!(decrypt_stream("not base64").is_none());
    }

    #[test]
    fn reads_encoded_sps_dimensions_including_cropping() {
        for (sps, expected) in [
            // x264 High 1920x1088 coded, cropped to 1080.
            (
                "67640028acd940780227e5c044000003000400000300083c60c658",
                (1920, 1080),
            ),
            (
                "6764001facd9405005bb011000000300100000030020f1831960",
                (1280, 720),
            ),
            // Vidzee's Interstellar segment.
            (
                "67640029acc8501e0089f9701100000303e90000bb808f183196",
                (1920, 1080),
            ),
        ] {
            assert_eq!(h264_sps_dimensions(&hex(sps)), Some(expected), "{sps}");
        }
        assert!(h264_sps_dimensions(&hex("68ee3cb0")).is_none());
        assert!(h264_sps_dimensions(&hex("67640028")).is_none());
    }

    fn ts_packet(pid: u16, unit_start: bool, payload: &[u8]) -> Vec<u8> {
        let mut packet = vec![
            0x47,
            (u8::from(unit_start) << 6) | (pid >> 8) as u8,
            pid as u8,
            0x10,
        ];
        packet.extend_from_slice(payload);
        packet.resize(TS_PACKET_LEN, 0xff);
        packet
    }

    #[test]
    fn demuxes_the_h264_stream_from_mpeg_ts() {
        let pat = [
            0, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0,
        ];
        let pmt = [
            0, 0x02, 0xb0, 0x17, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x0f, 0xe1, 0x01, 0xf0,
            0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
        ];
        let sps = hex("67640028acd940780227e5c044000003000400000300083c60c658");
        let mut pes = vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 0x05, 0x21, 0, 1, 0, 1];
        pes.extend_from_slice(&[0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1]);
        // Split the SPS across two packets, as a real muxer may.
        let (first, rest) = sps.split_at(10);
        pes.extend_from_slice(first);
        let mut stream = ts_packet(0, true, &pat);
        stream.extend(ts_packet(0x1000, true, &pmt));
        // Pad with an adaptation field so the payload ends exactly at the split.
        let stuffing = TS_PACKET_LEN - 4 - pes.len();
        let mut padded = vec![0x47, 0x41, 0x00, 0x30, (stuffing - 1) as u8];
        if stuffing > 1 {
            padded.push(0);
            padded.extend(std::iter::repeat_n(0xff, stuffing - 2));
        }
        padded.extend_from_slice(&pes);
        stream.extend(padded);
        stream.extend(ts_packet(0x101, true, &[0, 0, 1, 0xc0, 0, 0, 0x80, 0, 0]));
        let mut continuation = rest.to_vec();
        continuation.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xee, 0x3c, 0xb0]);
        stream.extend(ts_packet(0x100, false, &continuation));
        assert_eq!(ts_h264_dimensions(&stream), Some((1920, 1080)));
        // Truncated and non-TS input stay unknown.
        assert!(ts_h264_dimensions(&stream[..TS_PACKET_LEN * 2]).is_none());
        assert!(ts_h264_dimensions(b"#EXTM3U\n").is_none());

        // A PES whose first packet carries only its header still collects
        // the elementary stream from the packets that follow it.
        let header = [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 0x05, 0x21, 0, 1, 0, 1];
        let stuffing = TS_PACKET_LEN - 4 - header.len();
        let mut header_only = vec![0x47, 0x41, 0x00, 0x30, (stuffing - 1) as u8, 0];
        header_only.extend(std::iter::repeat_n(0xff, stuffing - 2));
        header_only.extend_from_slice(&header);
        let mut body = vec![0, 0, 0, 1];
        body.extend_from_slice(&sps);
        body.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xee, 0x3c, 0xb0]);
        let mut stream = ts_packet(0, true, &pat);
        stream.extend(ts_packet(0x1000, true, &pmt));
        stream.extend(header_only);
        stream.extend(ts_packet(0x100, false, &body));
        assert_eq!(ts_h264_dimensions(&stream), Some((1920, 1080)));
    }

    fn encrypt_stream(json: &str) -> String {
        let mut bytes = json.as_bytes().to_vec();
        rc4_drop_apply(&STREAM_KEY, KEYSTREAM_DROP, &mut bytes);
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn malformed_or_unsafe_payloads_never_become_playback_urls() {
        let accepted = |json: &str| {
            decrypt_stream(&encrypt_stream(json))
                .and_then(stream_playlist_url)
                .map(String::from)
        };
        assert_eq!(
            accepted(
                r#"{"language":"Auto","url":"https://cdn2.fastcloud.live/m/x.m3u8","headers":{}}"#
            )
            .as_deref(),
            Some("https://cdn2.fastcloud.live/m/x.m3u8")
        );
        for json in [
            r#"{"url":"https://cdn2.fastcloud.live/m/x.m3u8","headers":{"Cookie":"a=b"}}"#,
            r#"{"url":"http://cdn2.fastcloud.live/m/x.m3u8"}"#,
            r#"{"url":"https://127.0.0.1/m/x.m3u8"}"#,
            r#"{"url":"https://user:pass@cdn2.fastcloud.live/m/x.m3u8"}"#,
            r#"{"url":"https://cdn2.fastcloud.live:8443/m/x.m3u8"}"#,
            r#"{"url":"https://cdn2.fastcloud.live/m/x.mp4"}"#,
            r#"{"url":"file:///etc/passwd.m3u8"}"#,
            r#"{"language":"Auto"}"#,
            "not json",
        ] {
            assert!(accepted(json).is_none(), "{json}");
        }
        assert!(decrypt_stream("").is_none());
        assert!(decrypt_stream("%%%").is_none());
    }

    #[test]
    fn every_hop_must_be_a_public_https_destination() {
        for url in [
            "http://cdn.example/master.m3u8",
            "https://127.0.0.1/private",
            "https://localhost/private",
            "https://[::1]/private",
            "https://169.254.169.254/latest/meta-data",
            "https://foo.internal/x",
            "https://secret@cdn.example/x",
            "https://cdn.example:8443/x",
        ] {
            assert!(!valid_destination(&url.parse().unwrap()), "{url}");
        }
        assert!(valid_destination(
            &"https://nexcloud.live/segment".parse().unwrap()
        ));
    }

    /// One-shot local HTTP server. Each path answers in a fixed way.
    async fn transport_fixture() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 1024];
                    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let head = String::from_utf8_lossy(&request);
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let response = match path.as_str() {
                        "/ok" => b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello".to_vec(),
                        "/to-private" => b"HTTP/1.1 302 Found\r\nLocation: https://169.254.169.254/x\r\nContent-Length: 0\r\n\r\n".to_vec(),
                        "/to-plaintext-host" => b"HTTP/1.1 302 Found\r\nLocation: http://blocked.test/x\r\nContent-Length: 0\r\n\r\n".to_vec(),
                        "/loop" => b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\n\r\n".to_vec(),
                        "/hop" => b"HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\n\r\n".to_vec(),
                        "/large" | "/ignores-range" => {
                            let mut body = b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n".to_vec();
                            body.extend(std::iter::repeat_n(b'x', 4096));
                            body
                        }
                        "/stall-headers" => {
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                            return;
                        }
                        "/stall-body" => {
                            let _ = socket
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
                                .await;
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                            return;
                        }
                        _ => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec(),
                    };
                    let _ = socket.write_all(&response).await;
                });
            }
        });
        (address, task)
    }

    fn loopback_only(url: &Url) -> bool {
        url.host_str() == Some("127.0.0.1")
    }

    #[tokio::test]
    async fn transport_refuses_unsafe_redirects_and_enforces_time_and_size_bounds() {
        let (address, server) = transport_fixture().await;
        // Mirror the hardened client's redirect policy; its DNS pinning is
        // covered in `egress_policy`. Loopback stands in for a public host.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = |path: &str| Url::parse(&format!("http://{address}{path}")).unwrap();
        let fetch = |path: &'static str, range: Option<usize>, limit: usize, timeout_ms: u64| {
            let client = client.clone();
            let target = url(path);
            async move { fetch_bytes_to(&client, target, range, limit, timeout_ms, loopback_only).await }
        };

        let (final_url, body) = fetch("/hop", None, 1024, 2_000).await.unwrap();
        assert_eq!(
            (final_url.path(), body.as_slice()),
            ("/ok", b"hello".as_slice())
        );
        for path in ["/to-private", "/to-plaintext-host", "/loop", "/missing"] {
            assert!(fetch(path, None, 1024, 2_000).await.is_none(), "{path}");
        }
        // Whole responses over the limit are refused; a ranged probe keeps
        // only its prefix from a server that ignores Range.
        assert!(fetch("/large", None, 1024, 2_000).await.is_none());
        let (_, prefix) = fetch("/ignores-range", Some(1024), 1024, 2_000)
            .await
            .unwrap();
        assert_eq!(prefix.len(), 1024);
        // A stalled server is abandoned at the deadline, during headers or body.
        for path in ["/stall-headers", "/stall-body"] {
            let started = std::time::Instant::now();
            assert!(fetch(path, None, 1024, 300).await.is_none(), "{path}");
            assert!(
                started.elapsed() < std::time::Duration::from_secs(5),
                "{path}"
            );
        }
        // Production refuses the loopback fixture before connecting.
        assert!(
            fetch_bytes(&client, url("/ok"), None, 1024, 2_000)
                .await
                .is_none()
        );
        server.abort();
    }

    #[test]
    fn segment_probe_is_bounded_to_public_unencrypted_media() {
        let base = Url::parse("https://cdn2.fastcloud.live/movie/x/bigtits.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:18\n#EXTINF:12.0,\nhttps://nexcloud.live/abc\n#EXT-X-ENDLIST\n";
        assert_eq!(
            first_segment_url(&base, playlist).unwrap().as_str(),
            "https://nexcloud.live/abc"
        );
        for playlist in [
            "#EXTM3U\n#EXTINF:12.0,\nhttps://127.0.0.1/abc\n",
            "#EXTM3U\n#EXTINF:12.0,\nhttp://nexcloud.live/abc\n",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:12.0,\nhttps://nexcloud.live/abc\n",
            "#EXTM3U\n#EXT-X-ENDLIST\n",
        ] {
            assert!(first_segment_url(&base, playlist).is_none(), "{playlist}");
        }
    }

    #[tokio::test]
    #[ignore = "Opt-in public provider smoke check; requires the current upstream service"]
    async fn live_full_hd_resolve_uses_the_hardened_transport() {
        let client =
            crate::egress_policy::hardened_provider_client_builder(reqwest::Client::builder())
                .build()
                .unwrap();
        let mut episode = metadata("tv", "95480");
        episode.episode_number = 1;
        for title in [
            metadata("movie", "157336"),
            metadata("movie", "129"),
            episode,
        ] {
            let start = std::time::Instant::now();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                resolve(&client, &title, 8_000),
            )
            .await
            .unwrap();
            assert!(
                result.is_some_and(|source| source.full_hd),
                "{}",
                title.tmdb_id
            );
            println!("vidzee {}: full HD in {:?}", title.tmdb_id, start.elapsed());
        }
    }
}
