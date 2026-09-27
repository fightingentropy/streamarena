/// Require a real HD rendition, not a provider's name or advertised badge.
/// Cinemascope films can be 1920x800; anamorphic releases can be 1440x1080.
/// A lower adaptive rendition is fine when this master also offers full HD.
pub(super) fn offers_full_hd(playlist: &str) -> bool {
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
                    (Ok(w), Ok(h)) if w > 0 && h > 0 && (w >= 1920 || h >= 1080))
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

#[cfg(test)]
mod tests {
    use super::offers_full_hd;

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
