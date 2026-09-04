use super::*;

pub(super) async fn remux_handler(
    State(state): State<AppState>,
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
    let benchmark_instance = real_debrid_benchmark_instance_for_request(&state, &headers).await?;
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
    let benchmark_instance = real_debrid_benchmark_instance_for_request(&state, &headers).await?;
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
