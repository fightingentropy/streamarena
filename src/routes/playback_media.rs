use super::*;

pub(super) async fn remux_handler(
    State(state): State<AppState>,
    request_auth: auth::RequestAuth,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let input = params.get("input").cloned().unwrap_or_default();
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let benchmark_instance =
        real_debrid_benchmark_instance_for_request(&state, &request_auth, &headers).await?;
    if benchmark_instance.is_some()
        && (!benchmark_query_matches_cardinality(
            uri.query().unwrap_or_default(),
            &["input"],
            &[
                "start",
                "audioStream",
                "subtitleStream",
                "audioSyncMs",
                "sourceHash",
                "videoMode",
                "videoCodecs",
            ],
        ) || exact_single_query_value(uri.query().unwrap_or_default(), "subtitleStream")
            .is_some_and(|value| !value.is_empty() && value != "-1"))
    {
        return Err(ApiError::bad_request(
            "Benchmark remux parameters are not exact.",
        ));
    }
    let start_seconds = params
        .get("start")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let subtitle_stream_index = params
        .get("subtitleStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let manual_audio_sync_ms = params
        .get("audioSyncMs")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let preferred_video_mode = params
        .get("videoMode")
        .cloned()
        .unwrap_or_else(|| state.config.remux_video_mode.clone());
    let browser_video_codecs = params
        .get("videoCodecs")
        .map(String::as_str)
        .unwrap_or_default();
    let mut response = state
        .streaming
        .create_remux_response(
            &input,
            start_seconds,
            audio_stream_index,
            subtitle_stream_index,
            manual_audio_sync_ms,
            &preferred_video_mode,
            browser_video_codecs,
        )
        .await?;
    attach_benchmark_server_instance(&mut response, benchmark_instance.as_deref())?;
    Ok(response)
}

pub(super) async fn media_tracks_handler(
    State(state): State<AppState>,
    request_auth: auth::RequestAuth,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let request_url = absolute_request_url(&state, &uri)?;
    let raw_input = params.get("input").map(String::as_str).unwrap_or_default();
    let source_input = if raw_input.trim().starts_with("/api/local-torrent/stream")
        || raw_input.trim().starts_with("/api/local-cache/stream")
    {
        raw_input.trim().to_owned()
    } else {
        to_absolute_playback_url(raw_input, &request_url)
    };
    if source_input.is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let benchmark_instance =
        real_debrid_benchmark_instance_for_request(&state, &request_auth, &headers).await?;
    if benchmark_instance.is_some()
        && (!benchmark_query_matches_cardinality(
            uri.query().unwrap_or_default(),
            &["input", "audioLang", "subtitleLang"],
            &[
                "title",
                "year",
                "imdbId",
                "filename",
                "seasonNumber",
                "episodeNumber",
            ],
        ) || exact_single_query_value(uri.query().unwrap_or_default(), "subtitleLang")
            .as_deref()
            != Some("off"))
    {
        return Err(ApiError::bad_request(
            "Benchmark media parameters are not exact.",
        ));
    }

    let preferred_audio_lang = normalize_preferred_audio_lang(
        params
            .get("audioLang")
            .map(String::as_str)
            .unwrap_or_default(),
    );
    let preferred_subtitle_lang = normalize_subtitle_preference(
        params
            .get("subtitleLang")
            .map(String::as_str)
            .unwrap_or_default(),
    );
    let subtitle_title_hint = params
        .get("title")
        .cloned()
        .unwrap_or_else(|| infer_title_hint_from_source_input(&source_input));
    let subtitle_year_hint = normalize_year(params.get("year").cloned().unwrap_or_default());
    let subtitle_imdb_id_hint = params.get("imdbId").cloned().unwrap_or_default();
    let subtitle_filename_hint = params
        .get("filename")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| infer_filename_hint_from_source_input(&source_input));

    let mut selected_audio_stream_index = -1_i64;
    let mut selected_subtitle_stream_index = -1_i64;
    let season_number_hint = params
        .get("seasonNumber")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or_default();
    let episode_number_hint = params
        .get("episodeNumber")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or_default();
    let probe_future = state.media.probe_media_tracks(&source_input);
    let external_subtitle_future = async {
        if preferred_subtitle_lang == "off" {
            return Vec::new();
        }
        let mut external = state
            .media
            .search_opensubtitles_tracks(
                &subtitle_imdb_id_hint,
                &subtitle_title_hint,
                &subtitle_year_hint,
                &preferred_subtitle_lang,
                &subtitle_filename_hint,
            )
            .await;
        if external.is_empty() {
            external = state
                .media
                .search_stremio_addon_subtitle_tracks(
                    &subtitle_imdb_id_hint,
                    season_number_hint,
                    episode_number_hint,
                    &preferred_subtitle_lang,
                )
                .await;
        }
        external
    };
    let (probe_result, external_subtitle_tracks) =
        tokio::join!(probe_future, external_subtitle_future);
    let mut merged_tracks = probe_result.unwrap_or_default();
    let local_sidecar_subtitle_tracks = state
        .media
        .find_local_sidecar_subtitle_tracks(&source_input);
    if !local_sidecar_subtitle_tracks.is_empty() {
        merged_tracks.subtitleTracks = merge_preferred_subtitle_tracks(
            local_sidecar_subtitle_tracks,
            merged_tracks.subtitleTracks,
        );
    }
    if !external_subtitle_tracks.is_empty() {
        merged_tracks.subtitleTracks =
            merge_preferred_subtitle_tracks(external_subtitle_tracks, merged_tracks.subtitleTracks);
    }
    if let Some(audio_track) = choose_audio_track_from_probe(&merged_tracks, &preferred_audio_lang)
    {
        selected_audio_stream_index = audio_track.streamIndex;
    }
    if let Some(subtitle_track) =
        choose_subtitle_track_from_probe(&merged_tracks, &preferred_subtitle_lang)
    {
        selected_subtitle_stream_index = subtitle_track.streamIndex;
    }
    let tracks = merged_tracks;

    let mut response = json_response(json!({
        "tracks": tracks,
        "selectedAudioStreamIndex": selected_audio_stream_index,
        "selectedSubtitleStreamIndex": selected_subtitle_stream_index,
        "preferences": {
            "audioLang": preferred_audio_lang,
            "subtitleLang": preferred_subtitle_lang
        },
        "sourceInput": source_input
    }));
    attach_benchmark_server_instance(&mut response, benchmark_instance.as_deref())?;
    Ok(response)
}

/// Subtitle-only enrichment deliberately has no media input and never probes or
/// resolves video. It is called after playback starts by clients that opt in.
pub(super) async fn resolve_subtitles_handler(
    State(state): State<AppState>,
    request_auth: auth::RequestAuth,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    request_auth.require_auth(&state.db, &headers).await?;
    let params = query_pairs(uri.query().unwrap_or_default());
    let mut payload = subtitle_enrichment_payload(&params)?;
    let started = Instant::now();
    state
        .resolver
        .attach_external_subtitle_tracks_to_payload(&mut payload)
        .await;
    let mut response = json_response(json!({
        "tracks": payload["tracks"],
        "selectedSubtitleStreamIndex": payload["selectedSubtitleStreamIndex"],
        "preferences": payload["preferences"],
    }));
    apply_private_no_store(response.headers_mut());
    if let Ok(timing) = HeaderValue::from_str(&format!(
        "subtitles;dur={:.3}",
        started.elapsed().as_secs_f64() * 1_000.0
    )) {
        response.headers_mut().insert("server-timing", timing);
    }
    Ok(response)
}

fn subtitle_enrichment_payload(params: &BTreeMap<String, String>) -> AppResult<Value> {
    let imdb_id = params
        .get("imdbId")
        .map(|value| value.trim())
        .unwrap_or_default();
    let digits = imdb_id.strip_prefix("tt").unwrap_or(imdb_id);
    if !imdb_id.is_empty()
        && (digits.is_empty()
            || digits.len() > 16
            || !digits.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(ApiError::bad_request("Invalid IMDb id."));
    }
    let text = |key: &str| {
        params
            .get(key)
            .map(|value| value.trim().chars().take(512).collect::<String>())
            .unwrap_or_default()
    };
    let title = text("title");
    if imdb_id.is_empty() && title.is_empty() {
        return Err(ApiError::bad_request("Missing subtitle search identity."));
    }
    let normalized_imdb_id = if imdb_id.is_empty() {
        String::new()
    } else {
        format!("tt{digits}")
    };
    let ordinal = |key: &str| {
        params
            .get(key)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or_default()
            .clamp(0, 10_000)
    };
    Ok(json!({
        "resolverProvider": "external-embed",
        "metadata": {
            "imdbId": normalized_imdb_id,
            "displayTitle": title,
            "displayYear": normalize_year(text("year")),
            "seasonNumber": ordinal("seasonNumber"),
            "episodeNumber": ordinal("episodeNumber"),
        },
        "filename": text("filename"),
        "tracks": crate::media::MediaProbe::default(),
        "selectedSubtitleStreamIndex": -1,
        "preferences": { "subtitleLang": normalize_subtitle_preference(&text("subtitleLang")) },
    }))
}

#[cfg(test)]
mod subtitle_enrichment_tests {
    use super::*;

    #[test]
    fn subtitle_lookup_uses_bounded_identity_hints_and_never_media_input() {
        let payload = subtitle_enrichment_payload(&query_pairs(
            "imdbId=tt0944947&title=Game%20of%20Thrones&year=2011&seasonNumber=1&episodeNumber=2&subtitleLang=en&input=https%3A%2F%2Fprivate.invalid%2Fvideo",
        )).unwrap();
        assert_eq!(payload["metadata"]["imdbId"], "tt0944947");
        assert_eq!(payload["metadata"]["seasonNumber"], 1);
        assert_eq!(payload["metadata"]["episodeNumber"], 2);
        assert!(payload.get("input").is_none());
        assert!(payload.get("sourceInput").is_none());
        let mut params = query_pairs("imdbId=123&seasonNumber=-20&episodeNumber=999999");
        params.insert("title".into(), "x".repeat(2_000));
        let bounded = subtitle_enrichment_payload(&params).unwrap();
        assert_eq!(
            bounded["metadata"]["displayTitle"].as_str().unwrap().len(),
            512
        );
        assert_eq!(bounded["metadata"]["seasonNumber"], 0);
        assert_eq!(bounded["metadata"]["episodeNumber"], 10_000);
    }

    #[test]
    fn subtitle_lookup_rejects_invalid_imdb_identity() {
        for value in [
            "",
            "tt",
            "tt../admin",
            "12345678901234567",
            "https://example.org",
        ] {
            let mut params = BTreeMap::new();
            params.insert("imdbId".into(), value.into());
            assert!(subtitle_enrichment_payload(&params).is_err());
        }
    }

    #[test]
    fn subtitle_lookup_preserves_title_fallback_without_imdb() {
        for query in [
            "title=Example&year=2026",
            "imdbId=%20&title=Example&year=2026",
        ] {
            let payload = subtitle_enrichment_payload(&query_pairs(query)).unwrap();
            assert_eq!(payload["metadata"]["imdbId"], "");
            assert_eq!(payload["metadata"]["displayTitle"], "Example");
            assert_eq!(payload["metadata"]["displayYear"], "2026");
        }
        assert!(subtitle_enrichment_payload(&query_pairs("title=%20")).is_err());
        assert!(
            subtitle_enrichment_payload(&query_pairs("title=Example&imdbId=ttinvalid")).is_err()
        );
    }
}
