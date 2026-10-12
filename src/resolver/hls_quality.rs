/// Require a real video rendition, not a provider's name or advertised badge.
/// Cinemascope films can be 1920x800; anamorphic releases can be 1440x1080.
/// A lower adaptive rendition is fine when this master also offers full HD.
pub(super) fn offers_full_hd(playlist: &str) -> bool {
    offers_resolution(playlist, 1920, 1080)
}

pub(super) fn offers_hd(playlist: &str) -> bool {
    offers_resolution(playlist, 1280, 720)
}

fn offers_resolution(playlist: &str, min_width: u32, min_height: u32) -> bool {
    if !playlist.trim_start().starts_with("#EXTM3U") {
        return false;
    }
    let mut pending_hd = false;
    for line in playlist.lines().map(str::trim) {
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_hd = attributes.split(',').any(|attribute| {
                let Some(resolution) = attribute.trim().strip_prefix("RESOLUTION=") else {
                    return false;
                };
                let Some((width, height)) = resolution.split_once('x') else {
                    return false;
                };
                matches!((width.parse::<u32>(), height.parse::<u32>()),
                    (Ok(w), Ok(h)) if w > 0 && h > 0 && (w >= min_width || h >= min_height))
            });
        } else if !line.is_empty() && !line.starts_with('#') {
            if pending_hd {
                return true;
            }
            pending_hd = false;
        }
    }
    false
}

/// Inspect ISO BMFF sample entries, not track display dimensions or API labels.
/// The depth/length checks keep malformed upstream files bounded and panic-free.
pub(super) fn avc_dimensions(mut data: &[u8], depth: u8) -> Option<(u16, u16)> {
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

#[cfg(test)]
mod tests {
    use super::{offers_full_hd, offers_hd};

    #[test]
    fn accepts_real_720p_as_hd_without_calling_it_full_hd() {
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n720.m3u8";
        assert!(offers_hd(playlist));
        assert!(!offers_full_hd(playlist));
        for invalid in [
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=854x480,NAME=\"720p\"\nsd.m3u8",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720",
            "#EXTM3U\n#EXTINF:6,\nsegment.ts",
            "<html>720p</html>",
        ] {
            assert!(!offers_hd(invalid));
        }
    }

    #[test]
    fn requires_hd_video_rendition_with_uri_and_preserves_cropped_films() {
        for dimensions in ["1920x1080", "1920x800", "1440x1080", "3840x2160"] {
            assert!(offers_full_hd(&format!(
                "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:CODECS=\"avc1,mp4a\",RESOLUTION={dimensions}\nhd.m3u8\n"
            )));
        }
        for playlist in [
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,NAME=\"1080p\"\nlow.m3u8",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080",
            "#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:RESOLUTION=1920x1080,URI=\"thumbs.m3u8\"",
            "#EXTM3U\n#EXTINF:6,\nvideo.ts",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x0\nbad.m3u8",
            "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\n#EXT-X-STREAM-INF:RESOLUTION=640x360\nlow.m3u8",
            "<html>1080p</html>",
        ] {
            assert!(!offers_full_hd(playlist), "{playlist}");
        }
    }
}
