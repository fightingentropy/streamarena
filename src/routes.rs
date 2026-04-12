use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::RequestExt;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{Method, Response, Uri};
use axum::routing::any;
use serde_json::{Value, json};
use url::Url;

use crate::config::Config;
use crate::error::{ApiError, AppResult, json_response};
use crate::library::{
    normalize_upload_content_type, normalize_upload_episode_ordinal, normalize_whitespace,
    normalize_year, read_local_library, strip_file_extension, title_from_filename_token,
    write_local_library,
};
use crate::media::{
    MediaProbe, MediaService, choose_audio_track_from_probe, choose_subtitle_track_from_probe,
    merge_preferred_subtitle_tracks,
};
use crate::persistence::{Db, TitlePreference, build_cache_debug_payload};
use crate::process::{
    RuntimeServices, resolve_effective_remux_hwaccel_mode,
    to_absolute_playback_url,
};
use crate::resolver::ResolverService;
use crate::static_files::serve_static;
use crate::streaming::StreamingService;
use crate::tmdb::TmdbService;
use crate::upload::UPLOAD_SESSION_CHUNK_MAX_BYTES;
use crate::upload::UploadService;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub tmdb: TmdbService,
    pub media: MediaService,
    pub resolver: ResolverService,
    pub streaming: StreamingService,
    pub upload: UploadService,
    pub runtime: RuntimeServices,
    pub started_at_ms: i64,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/debug/cache", any(debug_cache))
        .route("/api/config", any(config_handler))
        .route("/api/health", any(health_handler))
        .route("/api/library", any(library_handler))
        .route("/api/title/preferences", any(title_preferences_handler))
        .route("/api/session/progress", any(session_progress_handler))
        .route("/api/tmdb/popular-movies", any(tmdb_popular_movies_handler))
        .route("/api/tmdb/search", any(tmdb_search_handler))
        .route("/api/tmdb/details", any(tmdb_details_handler))
        .route("/api/tmdb/tv/season", any(tmdb_tv_season_handler))
        .route("/api/upload/infer", any(upload_infer_handler))
        .route("/api/upload", any(upload_handler))
        .route(
            "/api/upload/session/start",
            any(upload_session_start_handler),
        )
        .route(
            "/api/upload/session/chunk",
            any(upload_session_chunk_handler)
                .layer(DefaultBodyLimit::max(UPLOAD_SESSION_CHUNK_MAX_BYTES)),
        )
        .route(
            "/api/upload/session/finish",
            any(upload_session_finish_handler),
        )
        .route("/api/gallery/save-stream", any(gallery_save_stream_handler))
        .route("/api/resolve/sources", any(resolve_sources_handler))
        .route("/api/resolve/movie", any(resolve_movie_handler))
        .route("/api/resolve/tv", any(resolve_tv_handler))
        .route("/api/remux", any(remux_handler))
        .route("/api/hls/master.m3u8", any(hls_master_handler))
        .route("/api/hls/segment.ts", any(hls_segment_handler))
        .route("/api/media/tracks", any(media_tracks_handler))
        .route("/api/subtitles.vtt", any(subtitles_vtt_handler))
        .route(
            "/api/subtitles.opensubtitles.vtt",
            any(subtitles_opensubtitles_vtt_handler),
        )
        .route(
            "/api/subtitles.external.vtt",
            any(subtitles_external_vtt_handler),
        )
        .fallback(any(serve_static))
        .with_state(state)
}

pub async fn debug_cache(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET && method != Method::POST {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    if method == Method::POST && uri.query().unwrap_or_default().contains("clear=1") {
        state.db.clear_persistent_caches().await?;
        let _ = tokio::fs::remove_dir_all(&state.config.hls_cache_dir).await;
    }
    state.db.sweep().await;
    let persistent_counts = state.db.persistent_counts().await?;
    let (hits, misses, expired) = state.tmdb.stats();
    let mut payload = build_cache_debug_payload(
        state.started_at_ms,
        state.tmdb.in_memory_size(),
        persistent_counts,
        hits,
        misses,
        expired,
    );
    if let Some(path) = payload.pointer_mut("/caches/persistentDb/path") {
        *path = Value::String(
            state
                .config
                .persistent_cache_db_path
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(json_response(payload))
}

pub async fn config_handler(
    State(state): State<AppState>,
    method: Method,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let ffmpeg = state.runtime.get_ffmpeg_capabilities(false).await;
    Ok(json_response(json!({
        "realDebridConfigured": !state.config.real_debrid_token.is_empty(),
        "tmdbConfigured": !state.config.tmdb_api_key.is_empty(),
        "playbackSessionsEnabled": state.config.playback_sessions_enabled,
        "autoAudioSyncEnabled": state.config.auto_audio_sync_enabled,
        "remuxVideoMode": state.config.remux_video_mode,
        "maxUploadBytes": state.config.max_upload_bytes,
        "hlsHwaccel": {
            "requested": state.config.hls_hwaccel_mode,
            "effective": ffmpeg.effectiveHlsHwaccel
        },
        "remuxHwaccel": {
            "requested": state.config.remux_hwaccel_mode,
            "effective": resolve_effective_remux_hwaccel_mode(&ffmpeg, &state.config.remux_hwaccel_mode)
        }
    })))
}

pub async fn health_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let refresh = uri.query().unwrap_or_default().contains("refresh=1");
    let ffmpeg = state.runtime.get_ffmpeg_capabilities(refresh).await;
    Ok(json_response(json!({
        "ok": true,
        "uptimeSeconds": ((now_ms() - state.started_at_ms) / 1000).max(0),
        "ffmpeg": ffmpeg
    })))
}

pub async fn library_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    match method {
        Method::GET => {
            let library = read_local_library(&state.config.local_library_path).await?;
            Ok(json_response(
                serde_json::to_value(library)
                    .unwrap_or_else(|_| json!({"movies": [], "series": []})),
            ))
        }
        Method::PUT => {
            let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
                .await
                .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
            let payload = serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
            let updated = write_local_library(&state.config.local_library_path, payload).await?;
            Ok(json_response(json!({
                "ok": true,
                "library": updated
            })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET or PUT.",
        )),
    }
}

pub async fn title_preferences_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    match method {
        Method::GET => {
            let params = query_pairs(uri.query().unwrap_or_default());
            let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
            if !is_numeric_id(&tmdb_id) {
                return Err(ApiError::bad_request(
                    "Missing or invalid tmdbId query parameter.",
                ));
            }
            let preference = state
                .db
                .get_title_preference(tmdb_id.clone())
                .await?
                .unwrap_or(TitlePreference {
                    audioLang: "auto".to_owned(),
                    subtitleLang: String::new(),
                });
            Ok(json_response(json!({
                "tmdbId": tmdb_id,
                "preference": preference
            })))
        }
        Method::POST => {
            let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
                .await
                .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
            let payload = serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
            let tmdb_id = payload
                .get("tmdbId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !is_numeric_id(&tmdb_id) {
                return Err(ApiError::bad_request("Missing or invalid tmdbId."));
            }
            state
                .db
                .persist_title_preference(
                    tmdb_id.clone(),
                    payload
                        .get("audioLang")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    payload
                        .get("subtitleLang")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
                .await?;
            state
                .db
                .invalidate_all_movie_resolve_caches_for_tmdb(tmdb_id.clone())
                .await?;
            let preference = state
                .db
                .get_title_preference(tmdb_id.clone())
                .await?
                .unwrap_or(TitlePreference {
                    audioLang: "auto".to_owned(),
                    subtitleLang: String::new(),
                });
            Ok(json_response(json!({
                "ok": true,
                "tmdbId": tmdb_id,
                "preference": preference
            })))
        }
        Method::DELETE => {
            let params = query_pairs(uri.query().unwrap_or_default());
            let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
            if !is_numeric_id(&tmdb_id) {
                return Err(ApiError::bad_request(
                    "Missing or invalid tmdbId query parameter.",
                ));
            }
            state.db.delete_title_preference(tmdb_id.clone()).await?;
            state
                .db
                .delete_playback_sessions_for_tmdb(tmdb_id.clone())
                .await?;
            state
                .db
                .invalidate_all_movie_resolve_caches_for_tmdb(tmdb_id.clone())
                .await?;
            Ok(json_response(json!({
                "ok": true,
                "tmdbId": tmdb_id,
                "cleared": {
                    "titlePreferences": true,
                    "playbackSessions": true,
                    "movieResolveCaches": true
                }
            })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET, POST, or DELETE.",
        )),
    }
}

pub async fn session_progress_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    if !state.config.playback_sessions_enabled {
        return Ok(json_response(json!({
            "ok": true,
            "disabled": true,
            "session": null
        })));
    }
    let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
        .await
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let payload = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let tmdb_id = payload
        .get("tmdbId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request("Missing or invalid tmdbId."));
    }

    let preferred_audio_lang = normalize_preferred_audio_lang(
        payload
            .get("audioLang")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let preferred_quality = normalize_preferred_stream_quality(
        payload
            .get("quality")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );

    let mut session_key =
        build_playback_session_key(&tmdb_id, &preferred_audio_lang, &preferred_quality);
    let mut existing = state.db.get_playback_session(session_key.clone()).await?;
    if existing.is_none() && preferred_audio_lang == "auto" {
        let effective_audio_lang =
            resolve_effective_preferred_audio_lang(&state, &tmdb_id, &preferred_audio_lang).await?;
        session_key =
            build_playback_session_key(&tmdb_id, &effective_audio_lang, &preferred_quality);
        existing = state.db.get_playback_session(session_key.clone()).await?;
    }
    if existing.is_none() {
        existing = state
            .db
            .get_latest_playback_session_for_tmdb(tmdb_id.clone())
            .await?;
        if let Some(ref latest) = existing {
            session_key = latest.session_key.clone();
        }
    }
    let Some(existing) = existing else {
        return Err(ApiError::not_found(
            "Playback session not found for this title/language.",
        ));
    };

    let position_seconds = payload
        .get("positionSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(existing.last_position_seconds)
        .max(0.0);
    let health_state = normalize_session_health_state(
        payload
            .get("healthState")
            .and_then(Value::as_str)
            .unwrap_or(&existing.health_state),
    );
    let last_error = payload
        .get("lastError")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let updated = state
        .db
        .update_playback_session_progress(
            session_key.clone(),
            position_seconds,
            health_state.clone(),
            last_error,
        )
        .await?;
    if !updated {
        return Err(ApiError::internal(
            "Unable to persist playback session progress.",
        ));
    }

    let source_hash = payload
        .get("sourceHash")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let event_type = payload
        .get("eventType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    if health_state == "invalid" {
        state
            .db
            .invalidate_all_movie_resolve_caches_for_tmdb(tmdb_id.clone())
            .await?;
        if !source_hash.is_empty() {
            let inferred_event = if payload
                .get("lastError")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase()
                .contains("decode")
            {
                "decode_failure".to_owned()
            } else {
                "playback_error".to_owned()
            };
            state
                .db
                .record_source_health_event(
                    source_hash.clone(),
                    inferred_event,
                    payload
                        .get("lastError")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
                .await?;
        }
    } else if !source_hash.is_empty()
        && matches!(
            event_type.as_str(),
            "success" | "decode_failure" | "ended_early" | "playback_error"
        )
    {
        state
            .db
            .record_source_health_event(
                source_hash,
                event_type,
                payload
                    .get("lastError")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )
            .await?;
    }

    let next_session = state.db.get_playback_session(session_key).await?;
    Ok(json_response(json!({
        "ok": true,
        "session": next_session.map(build_playback_session_payload)
    })))
}

pub async fn tmdb_popular_movies_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let page = params
        .get("page")
        .cloned()
        .unwrap_or_else(|| "1".to_owned());
    let mut popular_params = BTreeMap::new();
    popular_params.insert("page".to_owned(), page);

    let (movie_popular, movie_genres) = tokio::join!(
        state.tmdb.fetch("/movie/popular", popular_params, 20_000),
        state
            .tmdb
            .fetch("/genre/movie/list", BTreeMap::new(), 20_000)
    );
    let movie_popular = movie_popular?;
    let movie_genres = movie_genres?;
    Ok(json_response(json!({
        "results": movie_popular.get("results").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "genres": movie_genres.get("genres").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "imageBase": "https://image.tmdb.org/t/p"
    })))
}

pub async fn tmdb_search_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let query = normalize_whitespace(
        params
            .get("query")
            .cloned()
            .or_else(|| params.get("q").cloned())
            .unwrap_or_default(),
    );
    let requested_limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(40);
    let limit = requested_limit.clamp(1, 60) as usize;

    if query.len() < 2 {
        return Ok(json_response(json!({
            "query": query,
            "results": [],
            "imageBase": "https://image.tmdb.org/t/p"
        })));
    }

    let mut search_params = BTreeMap::new();
    search_params.insert("query".to_owned(), query.clone());
    search_params.insert("include_adult".to_owned(), "false".to_owned());
    search_params.insert("page".to_owned(), "1".to_owned());
    let payload = state
        .tmdb
        .fetch("/search/multi", search_params, 20_000)
        .await?;
    let results = payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| {
            entry.get("id").is_some()
                && matches!(
                    entry.get("media_type").and_then(Value::as_str),
                    Some("movie") | Some("tv")
                )
        })
        .take(limit)
        .map(|entry| {
            json!({
                "id": stringify_json(entry.get("id")),
                "mediaType": if entry.get("media_type").and_then(Value::as_str) == Some("tv") { "tv" } else { "movie" },
                "title": normalize_whitespace(stringify_json(entry.get("title")).if_empty_then(|| stringify_json(entry.get("name")))),
                "name": normalize_whitespace(stringify_json(entry.get("name")).if_empty_then(|| stringify_json(entry.get("title")))),
                "releaseDate": stringify_json(entry.get("release_date")),
                "firstAirDate": stringify_json(entry.get("first_air_date")),
                "posterPath": stringify_json(entry.get("poster_path")),
                "backdropPath": stringify_json(entry.get("backdrop_path")),
                "overview": stringify_json(entry.get("overview")),
                "adult": entry.get("adult").and_then(Value::as_bool).unwrap_or(false),
                "popularity": entry.get("popularity").and_then(Value::as_f64).unwrap_or(0.0),
                "voteAverage": entry.get("vote_average").and_then(Value::as_f64).unwrap_or(0.0)
            })
        })
        .collect::<Vec<_>>();

    Ok(json_response(json!({
        "query": query,
        "results": results,
        "imageBase": "https://image.tmdb.org/t/p"
    })))
}

pub async fn tmdb_details_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    let media_type = params
        .get("mediaType")
        .cloned()
        .unwrap_or_else(|| "movie".to_owned())
        .to_lowercase();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    if media_type != "movie" && media_type != "tv" {
        return Err(ApiError::bad_request(
            "Unsupported mediaType. Use movie or tv.",
        ));
    }
    let mut detail_params = BTreeMap::new();
    detail_params.insert("append_to_response".to_owned(), "credits".to_owned());
    let details = state
        .tmdb
        .fetch(&format!("/{media_type}/{tmdb_id}"), detail_params, 20_000)
        .await?;
    Ok(json_response(details))
}

pub async fn tmdb_tv_season_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    let season_number = normalize_upload_episode_ordinal(
        params
            .get("seasonNumber")
            .or_else(|| params.get("season"))
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(1),
        1,
    );
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }

    let season = state
        .tmdb
        .fetch(
            &format!("/tv/{tmdb_id}/season/{season_number}"),
            BTreeMap::new(),
            20_000,
        )
        .await?;
    let episodes = season
        .get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| {
            let still_path = stringify_json(entry.get("still_path"));
            json!({
                "episodeNumber": entry.get("episode_number").and_then(Value::as_i64).unwrap_or(0),
                "seasonNumber": entry.get("season_number").and_then(Value::as_i64).unwrap_or(season_number),
                "stillPath": still_path,
                "stillUrl": if still_path.is_empty() {
                    String::new()
                } else {
                    format!("https://image.tmdb.org/t/p/w780{still_path}")
                },
                "name": stringify_json(entry.get("name"))
            })
        })
        .collect::<Vec<_>>();
    Ok(json_response(json!({
        "tmdbId": tmdb_id,
        "seasonNumber": season_number,
        "episodes": episodes,
        "imageBase": "https://image.tmdb.org/t/p"
    })))
}

pub async fn upload_infer_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
        .await
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let payload = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let file_name = normalize_whitespace(
        payload
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if file_name.is_empty() {
        return Err(ApiError::bad_request("Missing fileName."));
    }
    let inferred = infer_upload_metadata(&state, &file_name).await?;
    Ok(json_response(json!({
        "ok": true,
        "inferred": inferred
    })))
}

pub async fn upload_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let payload = state.upload.handle_direct_upload(request).await?;
    Ok(json_response(payload))
}

pub async fn upload_session_start_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
        .await
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let payload = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    Ok(json_response(state.upload.start_session(payload).await?))
}

pub async fn upload_session_chunk_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let session_id = params.get("sessionId").cloned().unwrap_or_default();
    Ok(json_response(
        state
            .upload
            .append_chunk(&session_id, request.into_limited_body())
            .await?,
    ))
}

pub async fn upload_session_finish_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
        .await
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let payload = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    Ok(json_response(state.upload.finish_session(payload).await?))
}

pub async fn gallery_save_stream_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let bytes = to_bytes(request.into_body(), state.config.max_upload_bytes)
        .await
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    let payload = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))?;
    Ok(json_response(state.upload.queue_gallery_save(payload)?))
}

pub async fn resolve_sources_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }

    let media_type = params
        .get("mediaType")
        .cloned()
        .unwrap_or_else(|| "movie".to_owned())
        .trim()
        .to_lowercase();
    if media_type != "movie" && media_type != "tv" {
        return Err(ApiError::bad_request(
            "Unsupported mediaType. Use movie or tv.",
        ));
    }

    let payload = state
        .resolver
        .list_sources(
            &tmdb_id,
            &media_type,
            params.get("title").map(String::as_str).unwrap_or_default(),
            params.get("year").map(String::as_str).unwrap_or_default(),
            params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("preferredContainer")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("minSeeders")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("allowedFormats")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceAudioProfile")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("limit").map(String::as_str).unwrap_or_default(),
            params
                .get("seasonNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("season").map(String::as_str).unwrap_or_default(),
            params
                .get("episodeNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("episodeOrdinal")
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .await?;
    Ok(json_response(payload))
}

pub async fn resolve_movie_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    let payload = state
        .resolver
        .resolve_movie(
            &tmdb_id,
            params.get("title").map(String::as_str).unwrap_or_default(),
            params.get("year").map(String::as_str).unwrap_or_default(),
            params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("subtitleLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("minSeeders")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("allowedFormats")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceAudioProfile")
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .await?;
    Ok(json_response(payload))
}

pub async fn resolve_tv_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    let payload = state
        .resolver
        .resolve_tv(
            &tmdb_id,
            params.get("title").map(String::as_str).unwrap_or_default(),
            params.get("year").map(String::as_str).unwrap_or_default(),
            params
                .get("seasonNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("season").map(String::as_str).unwrap_or_default(),
            params
                .get("episodeNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("episodeOrdinal")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("subtitleLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("preferredContainer")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("minSeeders")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("allowedFormats")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceAudioProfile")
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .await?;
    Ok(json_response(payload))
}

pub async fn remux_handler(
    State(state): State<AppState>,
    method: Method,
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
    state
        .streaming
        .create_remux_response(
            &input,
            start_seconds,
            audio_stream_index,
            subtitle_stream_index,
            manual_audio_sync_ms,
            &preferred_video_mode,
        )
        .await
}

pub async fn hls_master_handler(
    State(state): State<AppState>,
    method: Method,
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
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state
        .streaming
        .create_hls_playlist_response(&input, audio_stream_index)
        .await
}

pub async fn hls_segment_handler(
    State(state): State<AppState>,
    method: Method,
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
    let segment_index = params
        .get("index")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state
        .streaming
        .create_hls_segment_response(&input, segment_index, audio_stream_index)
        .await
}

pub async fn media_tracks_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let request_url = absolute_request_url(&state, &uri)?;
    let source_input = to_absolute_playback_url(
        params.get("input").map(String::as_str).unwrap_or_default(),
        &request_url,
    );
    if source_input.is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
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
    let subtitle_filename_hint = infer_filename_hint_from_source_input(&source_input);

    let mut tracks = MediaProbe::default();
    let mut selected_audio_stream_index = -1_i64;
    let mut selected_subtitle_stream_index = -1_i64;

    if let Ok(probe) = state.media.probe_media_tracks(&source_input).await {
        let mut merged_tracks = probe;
        let local_sidecar_subtitle_tracks =
            state.media.find_local_sidecar_subtitle_tracks(&source_input);
        let external_subtitle_tracks = state
            .media
            .search_opensubtitles_tracks(
                &subtitle_imdb_id_hint,
                &subtitle_title_hint,
                &subtitle_year_hint,
                &preferred_subtitle_lang,
                &subtitle_filename_hint,
            )
            .await;
        if !local_sidecar_subtitle_tracks.is_empty() {
            merged_tracks.subtitleTracks = merge_preferred_subtitle_tracks(
                local_sidecar_subtitle_tracks,
                merged_tracks.subtitleTracks,
            );
        }
        if !external_subtitle_tracks.is_empty() {
            merged_tracks.subtitleTracks = merge_preferred_subtitle_tracks(
                external_subtitle_tracks,
                merged_tracks.subtitleTracks,
            );
        }
        if let Some(audio_track) =
            choose_audio_track_from_probe(&merged_tracks, &preferred_audio_lang)
        {
            selected_audio_stream_index = audio_track.streamIndex;
        }
        if let Some(subtitle_track) =
            choose_subtitle_track_from_probe(&merged_tracks, &preferred_subtitle_lang)
        {
            selected_subtitle_stream_index = subtitle_track.streamIndex;
        }
        tracks = merged_tracks;
    }

    Ok(json_response(json!({
        "tracks": tracks,
        "selectedAudioStreamIndex": selected_audio_stream_index,
        "selectedSubtitleStreamIndex": selected_subtitle_stream_index,
        "preferences": {
            "audioLang": preferred_audio_lang,
            "subtitleLang": preferred_subtitle_lang
        },
        "sourceInput": source_input
    })))
}

fn infer_filename_hint_from_source_input(source_input: &str) -> String {
    let candidate = if let Ok(url) = Url::parse(source_input) {
        url.path_segments()
            .and_then(|mut segments| segments.next_back())
            .unwrap_or_default()
            .to_owned()
    } else {
        Path::new(source_input)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_owned()
    };
    percent_decode_path_component(&candidate)
}

fn infer_title_hint_from_source_input(source_input: &str) -> String {
    let filename_hint = infer_filename_hint_from_source_input(source_input);
    if filename_hint.trim().is_empty() {
        return String::new();
    }
    title_from_filename_token(&strip_file_extension(&filename_hint))
}

fn percent_decode_path_component(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%'
            && index + 2 < raw.len()
            && let Ok(hex) = std::str::from_utf8(&raw[index + 1..index + 3])
            && let Ok(decoded) = u8::from_str_radix(hex, 16)
        {
            bytes.push(decoded);
            index += 3;
            continue;
        }
        if raw[index] == b'+' {
            bytes.push(b' ');
        } else {
            bytes.push(raw[index]);
        }
        index += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_owned())
}

pub async fn subtitles_vtt_handler(
    State(state): State<AppState>,
    method: Method,
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
    let subtitle_stream_index = params
        .get("subtitleStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state
        .media
        .create_subtitle_vtt_response(&input, subtitle_stream_index)
        .await
}

pub async fn subtitles_external_vtt_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let download_url = params.get("download").cloned().unwrap_or_default();
    if download_url.trim().is_empty() {
        return Err(ApiError::bad_request("Missing download query parameter."));
    }
    state
        .media
        .create_external_subtitle_vtt_response(&download_url)
        .await
}

pub async fn subtitles_opensubtitles_vtt_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let file_id = params
        .get("fileId")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state.media.create_opensubtitles_vtt_response(file_id).await
}

fn absolute_request_url(state: &AppState, uri: &Uri) -> AppResult<Url> {
    absolute_request_url_with_authority(uri, None, &state.config.host, state.config.port)
}

fn absolute_request_url_with_authority(
    uri: &Uri,
    authority: Option<String>,
    default_host: &str,
    default_port: u16,
) -> AppResult<Url> {
    let authority = authority.unwrap_or_else(|| format!("{default_host}:{default_port}"));
    Url::parse(&format!("http://{authority}{uri}"))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn query_pairs(query: &str) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn is_numeric_id(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn build_playback_session_key(tmdb_id: &str, audio_lang: &str, quality: &str) -> String {
    format!(
        "{}:{}:{}",
        tmdb_id.trim(),
        normalize_preferred_audio_lang(audio_lang),
        normalize_preferred_stream_quality(quality)
    )
}

fn build_playback_session_payload(session: crate::persistence::PlaybackSession) -> Value {
    json!({
        "key": session.session_key,
        "sourceHash": session.source_hash,
        "selectedFile": session.selected_file,
        "quality": normalize_preferred_stream_quality(&session.preferred_quality),
        "lastPositionSeconds": session.last_position_seconds,
        "health": {
            "state": session.health_state,
            "failCount": session.health_fail_count,
            "lastError": session.last_error
        }
    })
}

async fn resolve_effective_preferred_audio_lang(
    state: &AppState,
    tmdb_id: &str,
    preferred_audio_lang: &str,
) -> AppResult<String> {
    let normalized = normalize_preferred_audio_lang(preferred_audio_lang);
    if normalized != "auto" {
        return Ok(normalized);
    }
    let preference = state.db.get_title_preference(tmdb_id.to_owned()).await?;
    let preferred = preference
        .map(|value| normalize_preferred_audio_lang(&value.audioLang))
        .unwrap_or_else(|| "auto".to_owned());
    if preferred == "auto" {
        Ok("auto".to_owned())
    } else {
        Ok(preferred)
    }
}

pub fn normalize_preferred_audio_lang(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "auto" => "auto".to_owned(),
        "en" | "fr" | "es" | "de" | "it" | "pt" => value.trim().to_lowercase(),
        _ => "auto".to_owned(),
    }
}

pub fn normalize_preferred_stream_quality(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "auto" => "auto".to_owned(),
        "4k" | "uhd" | "2160" | "2160p" => "2160p".to_owned(),
        "1080" | "1080p" => "1080p".to_owned(),
        "720" | "720p" => "720p".to_owned(),
        _ => "auto".to_owned(),
    }
}

pub fn normalize_subtitle_preference(value: &str) -> String {
    let raw = value.trim().to_lowercase();
    if raw.is_empty() || raw == "auto" {
        return String::new();
    }
    if matches!(raw.as_str(), "off" | "none" | "disabled") {
        return "off".to_owned();
    }
    normalize_iso_language(&raw)
}

pub fn normalize_session_health_state(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "healthy" => "healthy".to_owned(),
        "degraded" => "degraded".to_owned(),
        "invalid" => "invalid".to_owned(),
        _ => "unknown".to_owned(),
    }
}

fn normalize_iso_language(value: &str) -> String {
    let normalized = value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>();
    let alias = match normalized.as_str() {
        "eng" => "en",
        "fre" | "fra" => "fr",
        "spa" => "es",
        "ger" | "deu" => "de",
        "ita" => "it",
        "por" => "pt",
        "jpn" => "ja",
        "kor" => "ko",
        "zho" | "chi" => "zh",
        "dut" | "nld" => "nl",
        "rum" | "ron" => "ro",
        _ => normalized.as_str(),
    };
    if alias.len() == 2 {
        alias.to_owned()
    } else {
        alias.chars().take(2).collect()
    }
}

async fn infer_upload_metadata(state: &AppState, file_name: &str) -> AppResult<Value> {
    let inferred = infer_upload_metadata_from_filename_heuristic(file_name);
    enrich_inference_with_tmdb(state, inferred, file_name).await
}

fn infer_upload_metadata_from_filename_heuristic(file_name: &str) -> Value {
    let raw_base = strip_file_extension(file_name.trim());
    let cleaned = normalize_whitespace(&raw_base);
    let episode_match = find_episode_pattern(&raw_base);
    let has_course_keyword = raw_base.to_lowercase().contains("course")
        || raw_base.to_lowercase().contains("lesson")
        || raw_base.to_lowercase().contains("module")
        || raw_base.to_lowercase().contains("class")
        || raw_base.to_lowercase().contains("lecture")
        || raw_base.to_lowercase().contains("webinar");
    let module_number = capture_keyword_number(&raw_base, "module").unwrap_or(1);
    let lesson_number = ["lesson", "class", "lecture", "webinar"]
        .iter()
        .find_map(|keyword| capture_keyword_number(&raw_base, keyword))
        .unwrap_or_else(|| module_number.max(1));
    let year = extract_year(&raw_base);

    if let Some((series_title, season_number, episode_number)) = episode_match {
        return normalize_inferred_upload_metadata(json!({
            "contentType": "episode",
            "title": series_title,
            "seriesTitle": series_title,
            "seasonNumber": season_number,
            "episodeNumber": episode_number,
            "year": year,
            "confidence": 0.6,
            "reason": "Heuristic SxxExx filename match."
        }));
    }

    if has_course_keyword {
        let raw_title = title_from_filename_token(&raw_base);
        let stripped_for_course_title = raw_base
            .replace("module", " ")
            .replace("lesson", " ")
            .replace("class", " ")
            .replace("lecture", " ")
            .replace("webinar", " ");
        let course_title = title_from_filename_token(&stripped_for_course_title)
            .if_empty_then(|| raw_title.clone())
            .if_empty_then(|| cleaned.clone())
            .if_empty_then(|| "Untitled Course".to_owned());
        let lesson_title =
            if !raw_title.is_empty() && raw_title.to_lowercase() != course_title.to_lowercase() {
                raw_title
            } else {
                format!("Lesson {lesson_number}")
            };
        return normalize_inferred_upload_metadata(json!({
            "contentType": "course",
            "title": course_title,
            "seriesTitle": course_title,
            "seasonNumber": module_number,
            "episodeNumber": lesson_number,
            "episodeTitle": lesson_title,
            "year": year,
            "confidence": 0.55,
            "reason": "Heuristic course filename match."
        }));
    }

    normalize_inferred_upload_metadata(json!({
        "contentType": "movie",
        "title": title_from_filename_token(&raw_base).if_empty_then(|| cleaned),
        "year": year,
        "confidence": 0.4,
        "reason": "Heuristic filename inference."
    }))
}

async fn enrich_inference_with_tmdb(
    state: &AppState,
    base_inference: Value,
    file_name: &str,
) -> AppResult<Value> {
    let mut inferred = normalize_inferred_upload_metadata(base_inference);
    if let Some((series_title, season_number, episode_number)) = find_episode_pattern(file_name) {
        if inferred.get("contentType").and_then(Value::as_str) != Some("course") {
            inferred["contentType"] = Value::String("episode".to_owned());
        }
        let next_series = normalize_whitespace(
            inferred
                .get("seriesTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .if_empty_then(|| {
            normalize_whitespace(
                inferred
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        })
        .if_empty_then(|| series_title.clone());
        inferred["seriesTitle"] = Value::String(next_series.clone());
        inferred["seasonNumber"] = Value::from(season_number);
        inferred["episodeNumber"] = Value::from(episode_number);
        if normalize_whitespace(
            inferred
                .get("episodeTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .is_empty()
        {
            inferred["episodeTitle"] = Value::String(
                if inferred.get("contentType").and_then(Value::as_str) == Some("course") {
                    format!("Lesson {episode_number}")
                } else {
                    format!("Episode {episode_number}")
                },
            );
        }
    }

    if inferred.get("contentType").and_then(Value::as_str) == Some("course") {
        inferred["tmdbId"] = Value::String(String::new());
        return Ok(inferred);
    }

    if state.config.tmdb_api_key.trim().is_empty() {
        let reason = format!(
            "TMDB_API_KEY missing. {}",
            inferred
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )
        .trim()
        .to_owned();
        inferred["reason"] = Value::String(reason);
        return Ok(inferred);
    }

    if inferred.get("contentType").and_then(Value::as_str) == Some("episode") {
        let series_query = normalize_whitespace(
            inferred
                .get("seriesTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .if_empty_then(|| {
            normalize_whitespace(
                inferred
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        })
        .if_empty_then(|| normalize_whitespace(strip_file_extension(file_name)));
        if series_query.is_empty() {
            return Ok(inferred);
        }
        let mut params = BTreeMap::new();
        params.insert("query".to_owned(), series_query.clone());
        params.insert("include_adult".to_owned(), "false".to_owned());
        let tv_search = state.tmdb.fetch("/search/tv", params, 20_000).await?;
        let best_match = choose_best_tmdb_result(
            tv_search.get("results").and_then(Value::as_array),
            &series_query,
            inferred
                .get("year")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if let Some(best_match) = best_match {
            let tmdb_id = stringify_json(best_match.get("id"));
            let series_details = state
                .tmdb
                .fetch(&format!("/tv/{tmdb_id}"), BTreeMap::new(), 20_000)
                .await
                .ok();
            let season_number = inferred
                .get("seasonNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let episode_number = inferred
                .get("episodeNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let episode_details = state
                .tmdb
                .fetch(
                    &format!("/tv/{tmdb_id}/season/{season_number}/episode/{episode_number}"),
                    BTreeMap::new(),
                    20_000,
                )
                .await
                .ok();
            let resolved_series_title = normalize_whitespace(
                series_details
                    .as_ref()
                    .and_then(|value| value.get("name").and_then(Value::as_str))
                    .unwrap_or(&series_query),
            );
            inferred["tmdbId"] = Value::String(tmdb_id.clone());
            inferred["seriesTitle"] = Value::String(resolved_series_title.clone());
            inferred["title"] = Value::String(resolved_series_title);
            inferred["year"] = Value::String(normalize_year(
                series_details
                    .as_ref()
                    .and_then(|value| value.get("first_air_date").and_then(Value::as_str))
                    .or_else(|| best_match.get("first_air_date").and_then(Value::as_str))
                    .unwrap_or_default()
                    .chars()
                    .take(4)
                    .collect::<String>(),
            ));
            if let Some(episode_title) = episode_details
                .as_ref()
                .and_then(|value| value.get("name").and_then(Value::as_str))
            {
                inferred["episodeTitle"] = Value::String(normalize_whitespace(episode_title));
            }
            inferred["confidence"] = Value::from(
                inferred
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    .max(0.9),
            );
            inferred["reason"] = Value::String(
                format!(
                    "TMDB TV match ({}). {}",
                    tmdb_id,
                    inferred
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                )
                .trim()
                .to_owned(),
            );
        }
        return Ok(inferred);
    }

    let movie_query = normalize_whitespace(
        inferred
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .if_empty_then(|| normalize_whitespace(strip_file_extension(file_name)));
    if movie_query.is_empty() {
        return Ok(inferred);
    }
    let mut params = BTreeMap::new();
    params.insert("query".to_owned(), movie_query.clone());
    params.insert("include_adult".to_owned(), "false".to_owned());
    let movie_search = state.tmdb.fetch("/search/movie", params, 20_000).await?;
    if let Some(best_match) = choose_best_tmdb_result(
        movie_search.get("results").and_then(Value::as_array),
        &movie_query,
        inferred
            .get("year")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) {
        let tmdb_id = stringify_json(best_match.get("id"));
        let movie_details = state
            .tmdb
            .fetch(&format!("/movie/{tmdb_id}"), BTreeMap::new(), 20_000)
            .await
            .ok();
        inferred["tmdbId"] = Value::String(tmdb_id.clone());
        inferred["title"] = Value::String(normalize_whitespace(
            movie_details
                .as_ref()
                .and_then(|value| value.get("title").and_then(Value::as_str))
                .or_else(|| best_match.get("title").and_then(Value::as_str))
                .unwrap_or(&movie_query),
        ));
        inferred["year"] = Value::String(normalize_year(
            movie_details
                .as_ref()
                .and_then(|value| value.get("release_date").and_then(Value::as_str))
                .or_else(|| best_match.get("release_date").and_then(Value::as_str))
                .unwrap_or_default()
                .chars()
                .take(4)
                .collect::<String>(),
        ));
        inferred["confidence"] = Value::from(
            inferred
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.9),
        );
        inferred["reason"] = Value::String(
            format!(
                "TMDB Movie match ({}). {}",
                tmdb_id,
                inferred
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
            .trim()
            .to_owned(),
        );
    }
    Ok(inferred)
}

fn normalize_inferred_upload_metadata(value: Value) -> Value {
    let content_type = normalize_upload_content_type(stringify_json(value.get("contentType")));
    let is_series_like = matches!(content_type.as_str(), "episode" | "course");
    let fallback_episode_label = if content_type == "course" {
        "Lesson"
    } else {
        "Episode"
    };
    let tmdb_id = {
        let candidate = stringify_json(value.get("tmdbId"));
        if is_numeric_id(&candidate) {
            candidate
        } else {
            String::new()
        }
    };
    let mut inferred = json!({
        "contentType": content_type,
        "confidence": value.get("confidence").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 1.0),
        "title": normalize_whitespace(stringify_json(value.get("title"))),
        "year": normalize_year(stringify_json(value.get("year"))),
        "seriesTitle": "",
        "seasonNumber": 1,
        "episodeNumber": 1,
        "episodeTitle": "",
        "tmdbId": tmdb_id,
        "reason": normalize_whitespace(stringify_json(value.get("reason")))
    });
    if is_series_like {
        let episode_number = normalize_upload_episode_ordinal(
            value
                .get("episodeNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1),
            1,
        );
        inferred["seriesTitle"] = Value::String(normalize_whitespace(stringify_json(
            value.get("seriesTitle"),
        )));
        inferred["seasonNumber"] = Value::from(normalize_upload_episode_ordinal(
            value
                .get("seasonNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1),
            1,
        ));
        inferred["episodeNumber"] = Value::from(episode_number);
        inferred["episodeTitle"] = Value::String(
            normalize_whitespace(stringify_json(value.get("episodeTitle")))
                .if_empty_then(|| format!("{fallback_episode_label} {episode_number}")),
        );
    }
    inferred
}

fn choose_best_tmdb_result<'a>(
    results: Option<&'a Vec<Value>>,
    query_title: &str,
    query_year: &str,
) -> Option<&'a Value> {
    let mut best: Option<&Value> = None;
    let mut best_score = -1.0_f64;
    for entry in results.into_iter().flatten() {
        let title = normalize_whitespace(entry.get("name").and_then(Value::as_str).unwrap_or_else(
            || {
                entry
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            },
        ));
        if title.is_empty() {
            continue;
        }
        let mut score = score_tmdb_title_candidate(&title, query_title);
        let candidate_year = normalize_year(
            entry
                .get("first_air_date")
                .and_then(Value::as_str)
                .or_else(|| entry.get("release_date").and_then(Value::as_str))
                .unwrap_or_default()
                .chars()
                .take(4)
                .collect::<String>(),
        );
        if !query_year.is_empty() && !candidate_year.is_empty() && candidate_year == query_year {
            score += 0.3;
        }
        if title.eq_ignore_ascii_case(query_title) {
            score += 0.2;
        }
        if score > best_score {
            best_score = score;
            best = Some(entry);
        }
    }
    best
}

fn score_tmdb_title_candidate(candidate_title: &str, query_title: &str) -> f64 {
    let candidate_tokens = tokenize_tmdb_title(candidate_title);
    let query_tokens = tokenize_tmdb_title(query_title);
    if candidate_tokens.is_empty() || query_tokens.is_empty() {
        return 0.0;
    }
    let candidate_set = candidate_tokens
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let overlap = query_tokens
        .iter()
        .filter(|token| candidate_set.contains(*token))
        .count();
    overlap as f64 / query_tokens.len() as f64
}

fn tokenize_tmdb_title(value: &str) -> Vec<String> {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect()
}

fn find_episode_pattern(file_name: &str) -> Option<(String, i64, i64)> {
    let raw_base = strip_file_extension(file_name.trim());
    let tokens = raw_base
        .split(|ch: char| ['.', '_', '-', ' '].contains(&ch))
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let normalized = token.to_lowercase();
        if normalized.starts_with('s') && normalized.contains('e') {
            let parts = normalized
                .trim_start_matches('s')
                .split('e')
                .collect::<Vec<_>>();
            if parts.len() == 2
                && let (Ok(season), Ok(episode)) =
                    (parts[0].parse::<i64>(), parts[1].parse::<i64>())
            {
                let left = tokens[..index].join(" ");
                let series_title = title_from_filename_token(&left)
                    .if_empty_then(|| title_from_filename_token(&raw_base));
                return Some((
                    series_title,
                    normalize_upload_episode_ordinal(season, 1),
                    normalize_upload_episode_ordinal(episode, 1),
                ));
            }
        }
        if let Some((left, right)) = normalized.split_once('x')
            && let (Ok(season), Ok(episode)) = (left.parse::<i64>(), right.parse::<i64>())
        {
            let left_side = tokens[..index].join(" ");
            let series_title = title_from_filename_token(&left_side)
                .if_empty_then(|| title_from_filename_token(&raw_base));
            return Some((
                series_title,
                normalize_upload_episode_ordinal(season, 1),
                normalize_upload_episode_ordinal(episode, 1),
            ));
        }
    }
    None
}

fn capture_keyword_number(raw_base: &str, keyword: &str) -> Option<i64> {
    let lowered = raw_base.to_lowercase();
    let needle = keyword.to_lowercase();
    let index = lowered.find(&needle)?;
    let tail = lowered[index + needle.len()..]
        .chars()
        .skip_while(|ch| [' ', '.', '_', '-'].contains(ch))
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    tail.parse::<i64>()
        .ok()
        .map(|value| normalize_upload_episode_ordinal(value, 1))
}

fn extract_year(raw_base: &str) -> String {
    for piece in raw_base.split(|ch: char| !ch.is_ascii_digit()) {
        if piece.len() == 4 {
            let normalized = normalize_year(piece);
            if !normalized.is_empty() {
                return normalized;
            }
        }
    }
    String::new()
}

fn stringify_json(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(boolean)) => boolean.to_string(),
        _ => String::new(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

trait StringExt {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl StringExt for String {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        absolute_request_url_with_authority, build_playback_session_key, find_episode_pattern,
        normalize_preferred_audio_lang, normalize_subtitle_preference,
    };
    use axum::http::header::HOST;
    use axum::http::{HeaderMap, HeaderValue, Uri};

    #[test]
    fn normalizes_audio_preferences() {
        assert_eq!(normalize_preferred_audio_lang("ENG"), "auto");
        assert_eq!(normalize_preferred_audio_lang("en"), "en");
    }

    #[test]
    fn normalizes_subtitle_preferences() {
        assert_eq!(normalize_subtitle_preference("off"), "off");
        assert_eq!(normalize_subtitle_preference("eng"), "en");
    }

    #[test]
    fn extracts_episode_patterns() {
        let pattern = find_episode_pattern("The.Office.S02E03.mkv").unwrap();
        assert_eq!(pattern.1, 2);
        assert_eq!(pattern.2, 3);
    }

    #[test]
    fn builds_session_key() {
        assert_eq!(build_playback_session_key("1", "en", "1080"), "1:en:1080p");
    }

    #[test]
    fn request_url_prefers_host_header_when_available() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:5173"));
        let uri: Uri = "/api/config".parse().expect("uri");
        let authority = headers
            .get(HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap()
            .to_owned();
        let url = absolute_request_url_with_authority(&uri, Some(authority), "0.0.0.0", 5173)
            .expect("request url");
        assert_eq!(url.as_str(), "http://127.0.0.1:5173/api/config");
    }
}
