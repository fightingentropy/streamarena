use serde_json::{Value, json};

use super::{EXTERNAL_EMBED_RESOLVER_PROVIDER, ResolverService, stringify_json};
use crate::media::{MediaProbe, choose_subtitle_track_from_probe};

/// Legacy/native clients keep inline subtitle enrichment. The web player opts in
/// and hydrates through the authenticated subtitle-only route after playback starts.
pub(super) fn mark_deferred_subtitles(payload: &mut Value, requested: bool) -> bool {
    if !requested
        || payload.get("resolverProvider").and_then(Value::as_str)
            != Some(EXTERNAL_EMBED_RESOLVER_PROVIDER)
        || payload
            .pointer("/preferences/subtitleLang")
            .and_then(Value::as_str)
            == Some("off")
        || payload
            .pointer("/tracks/subtitleTracks")
            .and_then(Value::as_array)
            .is_some_and(|tracks| !tracks.is_empty())
        || payload.get("metadata").is_none()
    {
        return false;
    }
    payload["tracksPending"] = json!(true);
    payload["subtitlesPending"] = json!(true);
    true
}

impl ResolverService {
    /// Backfill external subtitle tracks on resolved payloads that have none.
    ///
    /// The external-embed pipeline builds its payload without a media probe or
    /// subtitle search (see build_external_embed_resolved_payload_with_playable_url),
    /// so embed playback — the most common VOD path — would otherwise always
    /// surface an empty Subtitles menu. Reads everything it needs back out of
    /// the payload, so it covers fresh resolves, embed-cache hits, and pinned
    /// sources alike.
    pub(crate) async fn attach_external_subtitle_tracks_to_payload(&self, payload: &mut Value) {
        if stringify_json(payload.get("resolverProvider")) != EXTERNAL_EMBED_RESOLVER_PROVIDER {
            return;
        }
        let has_subtitle_tracks = payload
            .get("tracks")
            .and_then(|tracks| tracks.get("subtitleTracks"))
            .and_then(Value::as_array)
            .map(|tracks| !tracks.is_empty())
            .unwrap_or(false);
        if has_subtitle_tracks {
            return;
        }
        let Some(metadata) = payload.get("metadata") else {
            return;
        };
        let imdb_id = stringify_json(metadata.get("imdbId"));
        let display_title = stringify_json(metadata.get("displayTitle"));
        let display_year = stringify_json(metadata.get("displayYear"));
        let season_number = metadata
            .get("seasonNumber")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let episode_number = metadata
            .get("episodeNumber")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let filename = stringify_json(payload.get("filename"));
        let preferred_subtitle_lang = stringify_json(
            payload
                .get("preferences")
                .and_then(|preferences| preferences.get("subtitleLang")),
        );
        if preferred_subtitle_lang == "off" {
            return;
        }

        let mut subtitle_tracks = self
            .media
            .search_opensubtitles_tracks(
                &imdb_id,
                &display_title,
                &display_year,
                &preferred_subtitle_lang,
                &filename,
            )
            .await;
        if subtitle_tracks.is_empty() {
            subtitle_tracks = self
                .media
                .search_stremio_addon_subtitle_tracks(
                    &imdb_id,
                    season_number,
                    episode_number,
                    &preferred_subtitle_lang,
                )
                .await;
        }
        if subtitle_tracks.is_empty() {
            return;
        }

        let probe = MediaProbe {
            subtitleTracks: subtitle_tracks,
            ..MediaProbe::default()
        };
        let selected_subtitle_stream_index =
            choose_subtitle_track_from_probe(&probe, &preferred_subtitle_lang)
                .map(|track| track.streamIndex)
                .unwrap_or(-1);
        payload["tracks"]["subtitleTracks"] = json!(probe.subtitleTracks);
        payload["selectedSubtitleStreamIndex"] = json!(selected_subtitle_stream_index);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embed_payload() -> Value {
        json!({
            "resolverProvider": "external-embed",
            "metadata": { "imdbId": "tt12345" },
            "tracks": { "subtitleTracks": [] },
            "preferences": { "subtitleLang": "en" },
        })
    }

    #[test]
    fn subtitles_defer_only_for_opted_in_external_playback() {
        let mut legacy = embed_payload();
        assert!(!mark_deferred_subtitles(&mut legacy, false));
        assert!(legacy.get("tracksPending").is_none());
        let mut web = embed_payload();
        assert!(mark_deferred_subtitles(&mut web, true));
        assert_eq!(web["tracksPending"], true);
        assert_eq!(web["subtitlesPending"], true);
        for provider in ["real-debrid", "local-torrent", ""] {
            let mut payload = embed_payload();
            payload["resolverProvider"] = json!(provider);
            assert!(!mark_deferred_subtitles(&mut payload, true));
            assert!(payload.get("subtitlesPending").is_none());
        }
    }

    #[test]
    fn disabled_or_existing_subtitles_do_not_schedule_duplicate_lookup() {
        let mut disabled = embed_payload();
        disabled["preferences"]["subtitleLang"] = json!("off");
        assert!(!mark_deferred_subtitles(&mut disabled, true));
        let mut existing = embed_payload();
        existing["tracks"]["subtitleTracks"] = json!([{ "streamIndex": 42 }]);
        assert!(!mark_deferred_subtitles(&mut existing, true));
        assert_eq!(existing["tracks"]["subtitleTracks"][0]["streamIndex"], 42);
    }
}
