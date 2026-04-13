use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::Request;
use dashmap::DashMap;
use futures_util::StreamExt;
use multer::Multipart;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;

use crate::config::Config;
use crate::utils::{hash_stable_string, now_ms};
use crate::error::{ApiError, AppResult};
use crate::library::{
    Library, MovieEntry, SeriesEntry, SeriesEpisodeEntry, mutate_local_library, normalize_tmdb_id,
    normalize_upload_content_type, normalize_upload_episode_ordinal, normalize_whitespace,
    normalize_year, slugify, strip_file_extension,
};
use crate::media::{MediaProbe, MediaService};
use crate::process::{RuntimeServices, run_process_capture_text};

const UPLOAD_SESSION_STALE_MS: i64 = 6 * 60 * 60 * 1000;
const UPLOAD_TRANSCODE_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;
pub const UPLOAD_SESSION_CHUNK_MAX_BYTES: usize = 32 * 1024 * 1024;
const GALLERY_ALLOWED_DOWNLOAD_HOSTS: &[&str] = &["download.real-debrid.com", "real-debrid.com"];
const GALLERY_ALLOWED_VIDEO_EXTENSIONS: &[&str] =
    &[".mp4", ".mkv", ".m4v", ".webm", ".mov", ".avi", ".ts"];

const CHROME_SUPPORTED_VIDEO_CODECS: &[&str] = &[
    "h264", "avc1", "hevc", "h265", "hev1", "hvc1", "vp8", "vp9", "av1", "mpeg4", "theora",
];
const CHROME_SUPPORTED_AUDIO_CODECS: &[&str] = &[
    "aac",
    "mp3",
    "opus",
    "vorbis",
    "flac",
    "pcm_s16le",
    "pcm_s24le",
];

#[derive(Clone)]
pub struct UploadService {
    config: Config,
    runtime: RuntimeServices,
    media: MediaService,
    http_client: reqwest::Client,
    sessions: Arc<DashMap<String, UploadSession>>,
    gallery_jobs: Arc<DashMap<String, ()>>,
}

#[derive(Clone)]
struct UploadSession {
    temp_path: PathBuf,
    file_name: String,
    metadata: Map<String, Value>,
    received_bytes: u64,
    created_at: i64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
struct ChromeCompatibility {
    checked: bool,
    isLikelyCompatible: bool,
    container: String,
    videoCodec: String,
    audioCodecs: Vec<String>,
    reasons: Vec<String>,
    warning: String,
}

#[derive(Debug, Clone)]
struct UploadMetadata {
    content_type: String,
    title: String,
    year: String,
    description: String,
    thumb: String,
    tmdb_id: String,
    season_number: i64,
    episode_number: i64,
    episode_title: String,
    series_title: String,
    series_id: String,
    transcode_audio_to_aac: bool,
}

#[derive(Debug, Clone)]
struct GallerySaveRequest {
    playable_url: String,
    tmdb_id: String,
    media_type: String,
    title: String,
    year: String,
    thumb: String,
    description: String,
    season_number: i64,
    episode_number: i64,
    episode_title: String,
    filename_hint: String,
}

impl UploadService {
    pub fn new(
        config: Config,
        runtime: RuntimeServices,
        media: MediaService,
        http_client: reqwest::Client,
    ) -> Self {
        Self {
            config,
            runtime,
            media,
            http_client,
            sessions: Arc::new(DashMap::new()),
            gallery_jobs: Arc::new(DashMap::new()),
        }
    }

    pub async fn sweep_sessions(&self) {
        let now = now_ms();
        let stale_ids = self
            .sessions
            .iter()
            .filter(|entry| entry.created_at + UPLOAD_SESSION_STALE_MS <= now)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for session_id in stale_ids {
            if let Some((_, session)) = self.sessions.remove(&session_id) {
                let _ = remove_file_if_present(&session.temp_path).await;
            }
        }
    }

    pub async fn handle_direct_upload(&self, request: Request<Body>) -> AppResult<Value> {
        self.require_ffmpeg().await?;
        let (metadata_map, temp_path, original_name, file_size) =
            self.parse_multipart_upload(request).await?;
        if file_size == 0 {
            let _ = remove_file_if_present(&temp_path).await;
            return Err(ApiError::bad_request("Uploaded file is empty."));
        }
        let metadata = build_upload_metadata_from_map(&metadata_map);
        match self
            .process_uploaded_media_into_library(temp_path.clone(), &original_name, metadata)
            .await
        {
            Ok(payload) => Ok(payload),
            Err(error) => {
                let _ = remove_file_if_present(&temp_path).await;
                Err(error)
            }
        }
    }

    pub async fn start_session(&self, payload: Value) -> AppResult<Value> {
        self.sweep_sessions().await;
        self.require_ffmpeg().await?;
        let object = payload
            .as_object()
            .cloned()
            .ok_or_else(|| ApiError::bad_request("Invalid JSON body."))?;
        let file_name = normalize_whitespace(
            object
                .get("fileName")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if file_name.is_empty() {
            return Err(ApiError::bad_request("Missing fileName."));
        }
        validate_upload_extension(&file_name)?;
        self.ensure_upload_directories().await?;
        let session_id = generate_upload_session_id();
        let temp_path = self
            .config
            .upload_temp_dir
            .join(build_upload_temp_filename(&file_name));
        self.sessions.insert(
            session_id.clone(),
            UploadSession {
                temp_path,
                file_name,
                metadata: object,
                received_bytes: 0,
                created_at: now_ms(),
            },
        );
        Ok(json!({
            "ok": true,
            "sessionId": session_id
        }))
    }

    pub async fn append_chunk(&self, session_id: &str, body: Body) -> AppResult<Value> {
        self.sweep_sessions().await;
        if session_id.trim().is_empty() {
            return Err(ApiError::bad_request("Missing sessionId."));
        }
        let temp_path = self
            .sessions
            .get(session_id)
            .map(|entry| entry.temp_path.clone())
            .ok_or_else(|| ApiError::not_found("Upload session not found."))?;
        self.ensure_upload_directories().await?;
        let written_bytes =
            append_request_chunk_to_file(&temp_path, body, UPLOAD_SESSION_CHUNK_MAX_BYTES).await?;
        if written_bytes == 0 {
            return Err(ApiError::bad_request("Empty chunk payload."));
        }

        let received_bytes = {
            let mut session = self
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| ApiError::not_found("Upload session not found."))?;
            session.received_bytes = session.received_bytes.saturating_add(written_bytes);
            session.received_bytes
        };
        Ok(json!({
            "ok": true,
            "receivedBytes": received_bytes
        }))
    }

    pub async fn finish_session(&self, payload: Value) -> AppResult<Value> {
        self.sweep_sessions().await;
        let object = payload
            .as_object()
            .cloned()
            .ok_or_else(|| ApiError::bad_request("Invalid JSON body."))?;
        let session_id = object
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if session_id.is_empty() {
            return Err(ApiError::bad_request("Missing sessionId."));
        }
        let Some((_, session)) = self.sessions.remove(&session_id) else {
            return Err(ApiError::not_found("Upload session not found."));
        };

        let mut metadata_map = session.metadata.clone();
        for (key, value) in object {
            metadata_map.insert(key, value);
        }
        let metadata = build_upload_metadata_from_map(&metadata_map);
        match self
            .process_uploaded_media_into_library(
                session.temp_path.clone(),
                &session.file_name,
                metadata,
            )
            .await
        {
            Ok(payload) => Ok(payload),
            Err(error) => {
                let _ = remove_file_if_present(&session.temp_path).await;
                Err(error)
            }
        }
    }

    pub fn queue_gallery_save(&self, payload: Value) -> AppResult<Value> {
        let object = payload
            .as_object()
            .ok_or_else(|| ApiError::bad_request("Invalid JSON body."))?;
        let playable_url = normalize_gallery_download_url(
            object
                .get("playableUrl")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if playable_url.is_empty() {
            return Err(ApiError::bad_request("Missing or invalid playableUrl."));
        }
        if !is_allowed_gallery_download_url(&playable_url) {
            return Err(ApiError::bad_request(
                "Only Real-Debrid HTTPS download URLs are supported for gallery saves.",
            ));
        }

        let tmdb_id = object
            .get("tmdbId")
            .map(json_string)
            .map(normalize_tmdb_id)
            .unwrap_or_default();
        let media_type = normalize_gallery_media_type(
            object
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or("movie"),
        );
        let title = normalize_whitespace(object.get("title").and_then(Value::as_str).unwrap_or(
            if media_type == "tv" {
                "Saved Series"
            } else {
                "Saved Movie"
            },
        ));
        let year = normalize_year(
            object
                .get("year")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let thumb = normalize_whitespace(
            object
                .get("thumb")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let description = normalize_whitespace(
            object
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let season_number = normalize_upload_episode_ordinal(
            object.get("seasonNumber").and_then(json_i64).unwrap_or(1),
            1,
        );
        let episode_number = normalize_upload_episode_ordinal(
            object.get("episodeNumber").and_then(json_i64).unwrap_or(1),
            1,
        );
        let episode_title = normalize_whitespace(
            object
                .get("episodeTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let filename_hint = normalize_whitespace(
            object
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );

        let job_key =
            build_gallery_download_job_key(&tmdb_id, &media_type, &title, &year, &playable_url);
        if self.gallery_jobs.contains_key(&job_key) {
            return Ok(json!({
                "ok": true,
                "queued": false,
                "alreadyQueued": true,
                "jobKey": job_key,
            }));
        }

        self.gallery_jobs.insert(job_key.clone(), ());
        let service = self.clone();
        let job_key_for_task = job_key.clone();
        let request = GallerySaveRequest {
            playable_url,
            tmdb_id,
            media_type,
            title,
            year,
            thumb,
            description,
            season_number,
            episode_number,
            episode_title,
            filename_hint,
        };
        tokio::spawn(async move {
            let result = service.save_playable_stream_to_gallery(request).await;
            if let Err(error) = result {
                eprintln!("[gallery] Failed saving \"{job_key_for_task}\": {error:?}");
            }
            service.gallery_jobs.remove(&job_key_for_task);
        });

        Ok(json!({
            "ok": true,
            "queued": true,
            "alreadyQueued": false,
            "jobKey": job_key,
        }))
    }

    async fn parse_multipart_upload(
        &self,
        request: Request<Body>,
    ) -> AppResult<(Map<String, Value>, PathBuf, String, u64)> {
        let content_type = request
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| ApiError::bad_request("Invalid multipart form payload."))?
            .to_owned();
        let boundary = multer::parse_boundary(&content_type)
            .map_err(|_| ApiError::bad_request("Invalid multipart form payload."))?;

        self.ensure_upload_directories().await?;
        let stream = request
            .into_body()
            .into_data_stream()
            .map(|result| result.map_err(|error| std::io::Error::other(error.to_string())));
        let mut multipart = Multipart::new(stream, boundary);
        let mut metadata = Map::new();
        let mut temp_path = None;
        let mut original_name = String::new();
        let mut file_size = 0_u64;

        while let Some(field) = multipart
            .next_field()
            .await
            .map_err(|_| ApiError::bad_request("Invalid multipart form payload."))?
        {
            let name = field.name().unwrap_or_default().to_owned();
            if name != "file" {
                let text = field
                    .text()
                    .await
                    .map_err(|_| ApiError::bad_request("Invalid multipart form payload."))?;
                metadata.insert(name, Value::String(text));
                continue;
            }

            if temp_path.is_some() {
                continue;
            }

            original_name = field.file_name().unwrap_or("upload").trim().to_owned();
            if original_name.is_empty() {
                original_name = "upload".to_owned();
            }
            validate_upload_extension(&original_name)?;
            let next_temp_path = self
                .config
                .upload_temp_dir
                .join(build_upload_temp_filename(&original_name));
            let mut temp_file = fs::File::create(&next_temp_path)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            let mut field = field;
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|_| ApiError::bad_request("Invalid multipart form payload."))?
            {
                file_size += chunk.len() as u64;
                temp_file
                    .write_all(&chunk)
                    .await
                    .map_err(|error| ApiError::internal(error.to_string()))?;
            }
            temp_file
                .flush()
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            temp_path = Some(next_temp_path);
        }

        let temp_path = temp_path.ok_or_else(|| ApiError::bad_request("Missing file upload."))?;
        Ok((metadata, temp_path, original_name, file_size))
    }

    async fn save_playable_stream_to_gallery(
        &self,
        request: GallerySaveRequest,
    ) -> AppResult<Value> {
        let safe_playable_url = normalize_gallery_download_url(&request.playable_url);
        if safe_playable_url.is_empty() {
            return Err(ApiError::bad_request("Missing or invalid playableUrl."));
        }
        if !is_allowed_gallery_download_url(&safe_playable_url) {
            return Err(ApiError::bad_request(
                "Only Real-Debrid HTTPS download URLs are supported for gallery saves.",
            ));
        }

        let normalized_media_type = normalize_gallery_media_type(&request.media_type);
        let safe_tmdb_id = normalize_tmdb_id(request.tmdb_id);
        let safe_title = normalize_whitespace(if request.title.is_empty() {
            if normalized_media_type == "tv" {
                "Saved Series"
            } else {
                "Saved Movie"
            }
        } else {
            &request.title
        });
        let safe_year = normalize_year(request.year);
        let safe_thumb = normalize_whitespace(request.thumb)
            .if_empty_then(|| "assets/images/thumbnail.jpg".to_owned());
        let safe_description = normalize_whitespace(request.description);
        let safe_season_number = normalize_upload_episode_ordinal(request.season_number, 1);
        let safe_episode_number = normalize_upload_episode_ordinal(request.episode_number, 1);
        let safe_episode_title = normalize_whitespace(if request.episode_title.is_empty() {
            format!("Episode {safe_episode_number}")
        } else {
            request.episode_title
        });
        let extension = infer_gallery_video_extension(&safe_playable_url, &request.filename_hint);
        let output_file_name = build_unique_video_filename(
            &format!(
                "{}{}",
                safe_title,
                if safe_year.is_empty() {
                    String::new()
                } else {
                    format!("-{safe_year}")
                }
            ),
            &extension,
        );
        let output_path = self
            .config
            .assets_dir
            .join("videos")
            .join(&output_file_name);
        let temp_path = self
            .config
            .upload_temp_dir
            .join(format!("{output_file_name}.part"));

        self.ensure_upload_directories().await?;
        let response = self
            .http_client
            .get(&safe_playable_url)
            .send()
            .await
            .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
        if !response.status().is_success() {
            let _ = remove_file_if_present(&temp_path).await;
            let _ = remove_file_if_present(&output_path).await;
            return Err(ApiError::bad_gateway(format!(
                "Download request failed ({}).",
                response.status().as_u16()
            )));
        }

        let mut temp_file = fs::File::create(&temp_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| ApiError::bad_gateway(error.to_string()))?;
            temp_file
                .write_all(&chunk)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        temp_file
            .flush()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        fs::rename(&temp_path, &output_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;

        let source_path = build_asset_video_source(&output_file_name);
        let movie_id_seed = if !safe_tmdb_id.is_empty() {
            format!("{safe_title}-{safe_tmdb_id}")
        } else {
            format!("{safe_title}-{safe_year}")
        };
        if normalized_media_type == "tv" {
            let series_id_seed = if !safe_tmdb_id.is_empty() {
                format!("{safe_title}-{safe_tmdb_id}")
            } else {
                format!("{safe_title}-{safe_year}")
            };
            let next_episode = SeriesEpisodeEntry {
                title: safe_episode_title.clone(),
                description: safe_description.clone(),
                thumb: safe_thumb.clone(),
                src: source_path.clone(),
                contentKind: "series".to_owned(),
                seasonNumber: safe_season_number,
                episodeNumber: safe_episode_number,
                uploadedAt: now_ms(),
            };
            let persisted_series =
                mutate_local_library(&self.config.local_library_path, |library| {
                    let normalized_series_id =
                        normalize_upload_target_series_id("", &series_id_seed, false);
                    let existing_index = library
                        .series
                        .iter()
                        .position(|entry| entry.id.eq_ignore_ascii_case(&normalized_series_id));
                    let mut target_series = existing_index
                        .and_then(|index| library.series.get(index).cloned())
                        .unwrap_or(SeriesEntry {
                            id: normalized_series_id.clone(),
                            title: safe_title.clone(),
                            contentKind: "series".to_owned(),
                            tmdbId: safe_tmdb_id.clone(),
                            year: safe_year.clone(),
                            preferredContainer: "mp4".to_owned(),
                            requiresLocalEpisodeSources: true,
                            episodes: Vec::new(),
                        });
                    target_series.id = normalized_series_id;
                    target_series.title = normalize_whitespace(&target_series.title)
                        .if_empty_then(|| safe_title.clone());
                    if target_series.tmdbId.trim().is_empty() {
                        target_series.tmdbId = safe_tmdb_id.clone();
                    }
                    target_series.year =
                        normalize_year(&target_series.year).if_empty_then(|| safe_year.clone());
                    target_series.contentKind = "series".to_owned();
                    target_series.preferredContainer = "mp4".to_owned();
                    target_series.requiresLocalEpisodeSources = true;

                    let mut episodes = target_series
                        .episodes
                        .into_iter()
                        .filter(|entry| {
                            !(normalize_upload_episode_ordinal(entry.seasonNumber, 1)
                                == safe_season_number
                                && normalize_upload_episode_ordinal(entry.episodeNumber, 1)
                                    == safe_episode_number)
                        })
                        .collect::<Vec<_>>();
                    episodes.push(next_episode.clone());
                    episodes.sort_by_key(|entry| {
                        (
                            normalize_upload_episode_ordinal(entry.seasonNumber, 1),
                            normalize_upload_episode_ordinal(entry.episodeNumber, 1),
                        )
                    });
                    target_series.episodes = episodes;

                    if let Some(index) = existing_index {
                        library.series[index] = target_series.clone();
                    } else {
                        library.series.insert(0, target_series.clone());
                    }
                    Ok(target_series)
                })
                .await?;
            return Ok(json!({
                "series": persisted_series,
                "episode": next_episode,
                "src": source_path,
                "mediaType": normalized_media_type,
                "tmdbId": safe_tmdb_id,
            }));
        }

        let next_movie = MovieEntry {
            id: build_upload_movie_id(&movie_id_seed),
            title: safe_title,
            tmdbId: safe_tmdb_id.clone(),
            year: safe_year.clone(),
            src: source_path.clone(),
            thumb: safe_thumb,
            description: safe_description,
            uploadedAt: now_ms(),
        };
        mutate_local_library(&self.config.local_library_path, |library| {
            library.movies = upsert_movie_entry_in_library(library, next_movie.clone());
            Ok::<(), ApiError>(())
        })
        .await?;

        Ok(json!({
            "movie": next_movie,
            "src": source_path,
            "mediaType": normalized_media_type,
            "tmdbId": safe_tmdb_id,
        }))
    }

    async fn process_uploaded_media_into_library(
        &self,
        input_path: PathBuf,
        original_name: &str,
        metadata: UploadMetadata,
    ) -> AppResult<Value> {
        let source_path_input = input_path.to_string_lossy().trim().to_owned();
        if source_path_input.is_empty() {
            return Err(ApiError::internal(
                "Missing input path for upload processing.",
            ));
        }
        validate_upload_extension(original_name)?;
        let content_type = normalize_upload_content_type(&metadata.content_type);
        if !matches!(content_type.as_str(), "movie" | "episode" | "course") {
            return Err(ApiError::bad_request(
                "Invalid contentType. Use movie, episode, or course.",
            ));
        }

        let is_movie_content = content_type == "movie";
        let is_course_content = content_type == "course";
        let movie_title = if metadata.title.is_empty() {
            normalize_whitespace(strip_known_video_extensions(original_name))
        } else {
            metadata.title.clone()
        };
        let year = metadata.year.clone();
        let description = metadata.description.clone();
        let thumb = if metadata.thumb.is_empty() {
            "assets/images/thumbnail.jpg".to_owned()
        } else {
            metadata.thumb.clone()
        };
        let tmdb_id = if is_course_content {
            String::new()
        } else {
            normalize_tmdb_id(metadata.tmdb_id.clone())
        };
        let season_number = metadata.season_number;
        let episode_number = metadata.episode_number;
        let episode_title = if metadata.episode_title.is_empty() {
            format!(
                "{} {}",
                if is_course_content {
                    "Lesson"
                } else {
                    "Episode"
                },
                episode_number
            )
        } else {
            metadata.episode_title.clone()
        };
        let series_title = metadata.series_title.clone();
        let raw_series_id = metadata.series_id.clone();
        let series_id_seed = if raw_series_id.is_empty() {
            if series_title.is_empty() {
                movie_title.clone()
            } else {
                series_title.clone()
            }
        } else {
            raw_series_id.clone()
        };

        self.ensure_upload_directories().await?;
        let upload_base_name = if is_movie_content {
            movie_title.clone()
        } else {
            episode_title.clone()
        };
        let mut output_file_name = build_unique_mp4_filename(if upload_base_name.is_empty() {
            original_name
        } else {
            &upload_base_name
        });
        let mut output_path = self
            .config
            .assets_dir
            .join("videos")
            .join(&output_file_name);
        let mut converted_from_mkv = false;
        let mut audio_transcoded_to_aac = false;
        let mut english_audio_enforced = false;

        match detect_upload_extension(original_name).as_deref() {
            Some(".mp4") => {
                fs::rename(&input_path, &output_path)
                    .await
                    .map_err(|error| ApiError::internal(error.to_string()))?;
            }
            Some(".mkv") => {
                converted_from_mkv = true;
                if let Err(error) = convert_mkv_to_mp4_lossless(&input_path, &output_path).await {
                    let _ = remove_file_if_present(&input_path).await;
                    let _ = remove_file_if_present(&output_path).await;
                    return Err(error);
                }
                let _ = remove_file_if_present(&input_path).await;
            }
            _ => {
                return Err(ApiError::bad_request(
                    "Only .mp4 and .mkv files are supported.",
                ));
            }
        }

        let mut source_path = build_asset_video_source(&output_file_name);
        let mut chrome_compatibility = self
            .detect_chrome_compatibility_for_source(&source_path)
            .await;
        if metadata.transcode_audio_to_aac
            && should_attempt_audio_only_upload_transcode(&chrome_compatibility)
        {
            let aac_file_name = build_unique_mp4_filename(&format!(
                "{}-aac",
                if upload_base_name.is_empty() {
                    original_name.to_owned()
                } else {
                    upload_base_name.clone()
                }
            ));
            let aac_path = self.config.assets_dir.join("videos").join(&aac_file_name);
            if convert_media_audio_to_aac_keeping_video(&output_path, &aac_path)
                .await
                .is_ok()
            {
                let _ = remove_file_if_present(&output_path).await;
                output_file_name = aac_file_name;
                output_path = aac_path;
                source_path = build_asset_video_source(&output_file_name);
                chrome_compatibility = self
                    .detect_chrome_compatibility_for_source(&source_path)
                    .await;
                audio_transcoded_to_aac = true;
            } else {
                let _ = remove_file_if_present(&aac_path).await;
            }
        }

        if let Ok(post_process_probe) = self.media.probe_media_tracks(&source_path).await
            && let Some(english_track) = post_process_probe
                .audioTracks
                .iter()
                .find(|track| track.language == "en")
            && let Some(first_track) = post_process_probe.audioTracks.first()
            && english_track.streamIndex >= 0
            && first_track.streamIndex != english_track.streamIndex
        {
            let en_file_name = build_unique_mp4_filename(&format!(
                "{}-en",
                if upload_base_name.is_empty() {
                    original_name.to_owned()
                } else {
                    upload_base_name.clone()
                }
            ));
            let en_path = self.config.assets_dir.join("videos").join(&en_file_name);
            if keep_preferred_audio_track_with_video_copy(
                &output_path,
                &en_path,
                english_track.streamIndex,
            )
            .await
            .is_ok()
            {
                let _ = remove_file_if_present(&output_path).await;
                output_file_name = en_file_name;
                source_path = build_asset_video_source(&output_file_name);
                chrome_compatibility = self
                    .detect_chrome_compatibility_for_source(&source_path)
                    .await;
                english_audio_enforced = true;
            } else {
                let _ = remove_file_if_present(&en_path).await;
            }
        }

        if is_movie_content {
            let entry = MovieEntry {
                id: build_upload_movie_id(&movie_title),
                title: if movie_title.is_empty() {
                    "Untitled Movie".to_owned()
                } else {
                    movie_title
                },
                tmdbId: tmdb_id,
                year,
                src: source_path,
                thumb,
                description,
                uploadedAt: now_ms(),
            };
            mutate_local_library(&self.config.local_library_path, |library| {
                library.movies = upsert_movie_entry_in_library(library, entry.clone());
                Ok::<(), ApiError>(())
            })
            .await?;
            return Ok(json!({
                "ok": true,
                "contentType": "movie",
                "movie": entry,
                "convertedFromMkv": converted_from_mkv,
                "audioTranscodedToAac": audio_transcoded_to_aac,
                "englishAudioEnforced": english_audio_enforced,
                "chromeCompatibility": chrome_compatibility,
            }));
        }

        let series_content_kind = if is_course_content {
            "course"
        } else {
            "series"
        }
        .to_owned();
        let safe_series_title = if !series_title.is_empty() {
            series_title
        } else if is_course_content {
            if movie_title.is_empty() {
                "Untitled Course".to_owned()
            } else {
                movie_title.clone()
            }
        } else {
            "Untitled Series".to_owned()
        };
        let normalized_series_id =
            normalize_upload_target_series_id(&raw_series_id, &series_id_seed, is_course_content);
        let episode_entry = SeriesEpisodeEntry {
            title: episode_title,
            description,
            thumb,
            src: source_path,
            contentKind: series_content_kind.clone(),
            seasonNumber: season_number,
            episodeNumber: episode_number,
            uploadedAt: now_ms(),
        };
        let target_series = mutate_local_library(&self.config.local_library_path, |library| {
            let existing_index = library
                .series
                .iter()
                .position(|entry| entry.id.eq_ignore_ascii_case(&normalized_series_id));
            let mut target_series = existing_index
                .and_then(|index| library.series.get(index).cloned())
                .unwrap_or(SeriesEntry {
                    id: normalized_series_id.clone(),
                    title: safe_series_title.clone(),
                    contentKind: series_content_kind.clone(),
                    tmdbId: tmdb_id.clone(),
                    year: year.clone(),
                    preferredContainer: "mp4".to_owned(),
                    requiresLocalEpisodeSources: true,
                    episodes: Vec::new(),
                });
            target_series.id = normalized_series_id.clone();
            target_series.title = normalize_whitespace(&target_series.title);
            if target_series.title.is_empty() {
                target_series.title = safe_series_title.clone();
            }
            if target_series.tmdbId.trim().is_empty() {
                target_series.tmdbId = tmdb_id.clone();
            }
            target_series.year = normalize_year(&target_series.year).if_empty_then(|| year.clone());
            target_series.contentKind = if target_series
                .contentKind
                .trim()
                .eq_ignore_ascii_case("course")
            {
                "course".to_owned()
            } else {
                "series".to_owned()
            };
            target_series.preferredContainer = "mp4".to_owned();
            target_series.requiresLocalEpisodeSources = true;

            let mut filtered_episodes = target_series
                .episodes
                .into_iter()
                .filter(|entry| {
                    !(normalize_upload_episode_ordinal(entry.seasonNumber, 1) == season_number
                        && normalize_upload_episode_ordinal(entry.episodeNumber, 1)
                            == episode_number)
                })
                .collect::<Vec<_>>();
            filtered_episodes.push(episode_entry.clone());
            filtered_episodes.sort_by_key(|entry| {
                (
                    normalize_upload_episode_ordinal(entry.seasonNumber, 1),
                    normalize_upload_episode_ordinal(entry.episodeNumber, 1),
                )
            });
            target_series.episodes = filtered_episodes;

            if let Some(index) = existing_index {
                library.series[index] = target_series.clone();
            } else {
                library.series.insert(0, target_series.clone());
            }
            Ok(target_series)
        })
        .await?;

        Ok(json!({
            "ok": true,
            "contentType": if is_course_content { "course" } else { "episode" },
            "series": target_series,
            "episode": episode_entry,
            "convertedFromMkv": converted_from_mkv,
            "audioTranscodedToAac": audio_transcoded_to_aac,
            "englishAudioEnforced": english_audio_enforced,
            "chromeCompatibility": chrome_compatibility,
        }))
    }

    async fn ensure_upload_directories(&self) -> AppResult<()> {
        fs::create_dir_all(self.config.assets_dir.join("videos"))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        fs::create_dir_all(&self.config.upload_temp_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    async fn require_ffmpeg(&self) -> AppResult<()> {
        let ffmpeg = self.runtime.get_ffmpeg_capabilities(false).await;
        if ffmpeg.ffmpegAvailable {
            Ok(())
        } else {
            Err(ApiError::internal(
                "ffmpeg is required for uploads and container conversion but is unavailable on this machine.",
            ))
        }
    }

    async fn detect_chrome_compatibility_for_source(&self, source: &str) -> ChromeCompatibility {
        match self.media.probe_media_tracks(source).await {
            Ok(probe) => detect_chrome_compatibility_from_probe(&probe),
            Err(_) => ChromeCompatibility {
                checked: false,
                isLikelyCompatible: true,
                container: String::new(),
                videoCodec: String::new(),
                audioCodecs: Vec::new(),
                reasons: Vec::new(),
                warning: "Compatibility check failed.".to_owned(),
            },
        }
    }
}

fn build_upload_metadata_from_map(payload: &Map<String, Value>) -> UploadMetadata {
    let transcode_value = payload.get("transcodeAudioToAac");
    let transcode_audio_to_aac = matches!(transcode_value, Some(Value::Bool(true)))
        || transcode_value.and_then(Value::as_i64).unwrap_or_default() == 1
        || matches!(
            payload
                .get("transcodeAudioToAac")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_lowercase()
                .as_str(),
            "true" | "1" | "yes" | "on"
        );
    let raw_series_id = normalize_whitespace(
        payload
            .get("seriesId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let raw_content_type = normalize_upload_content_type(
        payload
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or("movie"),
    );
    let content_type = if raw_content_type == "movie" && !raw_series_id.is_empty() {
        if raw_series_id.to_lowercase().starts_with("local-course-") {
            "course".to_owned()
        } else {
            "episode".to_owned()
        }
    } else {
        raw_content_type
    };
    UploadMetadata {
        content_type,
        title: normalize_whitespace(
            payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        year: normalize_year(
            payload
                .get("year")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        description: normalize_whitespace(
            payload
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        thumb: normalize_whitespace(
            payload
                .get("thumb")
                .and_then(Value::as_str)
                .unwrap_or("assets/images/thumbnail.jpg"),
        ),
        tmdb_id: normalize_tmdb_id(
            payload
                .get("tmdbId")
                .map(json_string)
                .unwrap_or_default()
                .chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect(),
        ),
        season_number: normalize_upload_episode_ordinal(
            payload.get("seasonNumber").and_then(json_i64).unwrap_or(1),
            1,
        ),
        episode_number: normalize_upload_episode_ordinal(
            payload.get("episodeNumber").and_then(json_i64).unwrap_or(1),
            1,
        ),
        episode_title: normalize_whitespace(
            payload
                .get("episodeTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        series_title: normalize_whitespace(
            payload
                .get("seriesTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        series_id: raw_series_id,
        transcode_audio_to_aac,
    }
}

fn validate_upload_extension(file_name: &str) -> AppResult<()> {
    match detect_upload_extension(file_name).as_deref() {
        Some(".mp4") | Some(".mkv") => Ok(()),
        _ => Err(ApiError::bad_request(
            "Only .mp4 and .mkv files are supported.",
        )),
    }
}

fn detect_upload_extension(file_name: &str) -> Option<String> {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
}

fn strip_known_video_extensions(value: &str) -> String {
    match detect_upload_extension(value).as_deref() {
        Some(".mp4") | Some(".mkv") => strip_file_extension(value),
        _ => value.trim().to_owned(),
    }
}

fn build_asset_video_source(file_name: &str) -> String {
    format!("assets/videos/{}", file_name.trim())
}

fn build_upload_movie_id(title: &str) -> String {
    format!("local-movie-{}", slugify(title, "movie"))
}

fn build_upload_series_id(value: &str) -> String {
    format!("local-series-{}", slugify(value, "series"))
}

fn build_upload_course_id(value: &str) -> String {
    format!("local-course-{}", slugify(value, "course"))
}

fn normalize_upload_target_series_id(
    raw_series_id: &str,
    fallback_label: &str,
    is_course_content: bool,
) -> String {
    let explicit_id = normalize_whitespace(raw_series_id).to_lowercase();
    if !explicit_id.is_empty() {
        if explicit_id.starts_with("local-course-") || explicit_id.starts_with("local-series-") {
            return explicit_id;
        }
        return if is_course_content {
            build_upload_course_id(&explicit_id)
        } else {
            build_upload_series_id(&explicit_id)
        };
    }
    if is_course_content {
        build_upload_course_id(fallback_label)
    } else {
        build_upload_series_id(fallback_label)
    }
}

fn build_unique_mp4_filename(base_label: &str) -> String {
    let safe_base = slugify(&strip_known_video_extensions(base_label), "upload");
    format!("{safe_base}-{}-{}.mp4", now_ms(), random_suffix())
}

fn build_unique_video_filename(base_label: &str, extension: &str) -> String {
    let safe_base = slugify(&strip_known_video_extensions(base_label), "gallery");
    let safe_extension =
        normalize_gallery_video_extension(extension).if_empty_then(|| ".mp4".to_owned());
    format!(
        "{safe_base}-{}-{}{}",
        now_ms(),
        random_suffix(),
        safe_extension
    )
}

fn build_upload_temp_filename(original_name: &str) -> String {
    let base = slugify(&strip_known_video_extensions(original_name), "upload");
    let safe_ext = match detect_upload_extension(original_name).as_deref() {
        Some(".mp4") => ".mp4",
        Some(".mkv") => ".mkv",
        _ => ".bin",
    };
    format!("{base}-{}-{}{}", now_ms(), random_suffix(), safe_ext)
}

fn random_suffix() -> String {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).unwrap_or_else(|_| {
        // Fallback: use time + pid if OS CSPRNG is unavailable (should never happen).
        let fallback = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
            ^ std::process::id() as u128;
        buf = (fallback as u64).to_le_bytes();
    });
    let value = u64::from_le_bytes(buf);
    format!("{value:012x}")[..12].to_owned()
}

async fn append_request_chunk_to_file(
    path: &Path,
    body: Body,
    max_chunk_bytes: usize,
) -> AppResult<u64> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let initial_len = file
        .metadata()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .len();
    let mut stream = body.into_data_stream();
    let mut written_bytes = 0usize;

    while let Some(next) = stream.next().await {
        let chunk = match next {
            Ok(chunk) => chunk,
            Err(error) => {
                rollback_partial_chunk(&file, initial_len).await;
                return Err(map_chunk_stream_error(&error.to_string(), max_chunk_bytes));
            }
        };
        if chunk.is_empty() {
            continue;
        }
        let next_written_bytes = match written_bytes.checked_add(chunk.len()) {
            Some(value) => value,
            None => {
                rollback_partial_chunk(&file, initial_len).await;
                return Err(ApiError::bad_request("Invalid chunk payload."));
            }
        };
        if next_written_bytes > max_chunk_bytes {
            rollback_partial_chunk(&file, initial_len).await;
            return Err(chunk_limit_error(max_chunk_bytes));
        }
        if let Err(error) = file.write_all(&chunk).await {
            rollback_partial_chunk(&file, initial_len).await;
            return Err(ApiError::internal(error.to_string()));
        }
        written_bytes = next_written_bytes;
    }

    if let Err(error) = file.flush().await {
        rollback_partial_chunk(&file, initial_len).await;
        return Err(ApiError::internal(error.to_string()));
    }

    Ok(written_bytes as u64)
}

async fn rollback_partial_chunk(file: &fs::File, initial_len: u64) {
    let _ = file.set_len(initial_len).await;
}

fn map_chunk_stream_error(message: &str, max_chunk_bytes: usize) -> ApiError {
    if message.to_lowercase().contains("length limit exceeded") {
        chunk_limit_error(max_chunk_bytes)
    } else {
        ApiError::bad_request("Invalid chunk payload.")
    }
}

fn chunk_limit_error(max_chunk_bytes: usize) -> ApiError {
    ApiError::payload_too_large(format!(
        "Chunk payload exceeded the {} MiB upload limit.",
        max_chunk_bytes / (1024 * 1024)
    ))
}

async fn remove_file_if_present(path: &Path) -> AppResult<()> {
    match fs::remove_file(path).await {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApiError::internal(error.to_string())),
    }
}

async fn convert_mkv_to_mp4_lossless(input_path: &Path, output_path: &Path) -> AppResult<()> {
    let command = vec![
        "ffmpeg".to_owned(),
        "-hide_banner".to_owned(),
        "-y".to_owned(),
        "-i".to_owned(),
        input_path.to_string_lossy().to_string(),
        "-map".to_owned(),
        "0:v".to_owned(),
        "-map".to_owned(),
        "0:a?".to_owned(),
        "-c:v".to_owned(),
        "copy".to_owned(),
        "-c:a".to_owned(),
        "copy".to_owned(),
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        output_path.to_string_lossy().to_string(),
    ];
    run_process_capture_text(&command, UPLOAD_TRANSCODE_TIMEOUT_MS)
        .await
        .map(|_| ())
        .map_err(ApiError::bad_gateway)
}

async fn convert_media_audio_to_aac_keeping_video(
    input_path: &Path,
    output_path: &Path,
) -> AppResult<()> {
    let command = vec![
        "ffmpeg".to_owned(),
        "-hide_banner".to_owned(),
        "-y".to_owned(),
        "-i".to_owned(),
        input_path.to_string_lossy().to_string(),
        "-map".to_owned(),
        "0:v".to_owned(),
        "-map".to_owned(),
        "0:a?".to_owned(),
        "-c:v".to_owned(),
        "copy".to_owned(),
        "-c:a".to_owned(),
        "aac".to_owned(),
        "-b:a".to_owned(),
        "256k".to_owned(),
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        output_path.to_string_lossy().to_string(),
    ];
    run_process_capture_text(&command, UPLOAD_TRANSCODE_TIMEOUT_MS)
        .await
        .map(|_| ())
        .map_err(ApiError::bad_gateway)
}

async fn keep_preferred_audio_track_with_video_copy(
    input_path: &Path,
    output_path: &Path,
    preferred_audio_stream_index: i64,
) -> AppResult<()> {
    let command = vec![
        "ffmpeg".to_owned(),
        "-hide_banner".to_owned(),
        "-y".to_owned(),
        "-i".to_owned(),
        input_path.to_string_lossy().to_string(),
        "-map".to_owned(),
        "0:v".to_owned(),
        "-map".to_owned(),
        format!("0:{}?", preferred_audio_stream_index.max(0)),
        "-sn".to_owned(),
        "-c:v".to_owned(),
        "copy".to_owned(),
        "-c:a".to_owned(),
        "copy".to_owned(),
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        output_path.to_string_lossy().to_string(),
    ];
    run_process_capture_text(&command, UPLOAD_TRANSCODE_TIMEOUT_MS)
        .await
        .map(|_| ())
        .map_err(ApiError::bad_gateway)
}

fn detect_chrome_compatibility_from_probe(probe: &MediaProbe) -> ChromeCompatibility {
    let format_name = probe.formatName.trim().to_lowercase();
    let video_codec = normalize_probe_codec_name(&probe.videoCodec);
    let audio_codecs = probe
        .audioTracks
        .iter()
        .map(|track| normalize_probe_codec_name(&track.codec))
        .filter(|codec| !codec.is_empty())
        .fold(Vec::<String>::new(), |mut acc, codec| {
            if !acc.contains(&codec) {
                acc.push(codec);
            }
            acc
        });

    let mut compatibility = ChromeCompatibility {
        checked: true,
        isLikelyCompatible: true,
        container: format_name.clone(),
        videoCodec: video_codec.clone(),
        audioCodecs: audio_codecs.clone(),
        reasons: Vec::new(),
        warning: String::new(),
    };
    if !format_name.contains("mp4") {
        compatibility.isLikelyCompatible = false;
        compatibility.reasons.push(format!(
            "Container '{}' may not be broadly supported in Chrome for this app.",
            if format_name.is_empty() {
                "unknown"
            } else {
                &format_name
            }
        ));
    }
    if !video_codec.is_empty() && !CHROME_SUPPORTED_VIDEO_CODECS.contains(&video_codec.as_str()) {
        compatibility.isLikelyCompatible = false;
        compatibility.reasons.push(format!(
            "Video codec '{}' is likely not Chrome-compatible.",
            video_codec
        ));
    }
    if video_codec.is_empty() {
        compatibility.isLikelyCompatible = false;
        compatibility
            .reasons
            .push("Could not determine video codec.".to_owned());
    }
    let unsupported_audio_codecs = audio_codecs
        .iter()
        .filter(|codec| !CHROME_SUPPORTED_AUDIO_CODECS.contains(&codec.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported_audio_codecs.is_empty() {
        compatibility.isLikelyCompatible = false;
        compatibility.reasons.push(format!(
            "Audio codec(s) {} are likely not Chrome-compatible.",
            unsupported_audio_codecs
                .iter()
                .map(|codec| format!("'{}'", codec))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !compatibility.reasons.is_empty() {
        compatibility.warning = compatibility.reasons.join(" ");
    }
    compatibility
}

fn should_attempt_audio_only_upload_transcode(compatibility: &ChromeCompatibility) -> bool {
    if !compatibility.checked {
        return false;
    }
    if !compatibility.container.contains("mp4") {
        return false;
    }
    if compatibility.videoCodec.is_empty()
        || !CHROME_SUPPORTED_VIDEO_CODECS.contains(&compatibility.videoCodec.as_str())
    {
        return false;
    }
    compatibility
        .audioCodecs
        .iter()
        .any(|codec| !codec.is_empty() && !CHROME_SUPPORTED_AUDIO_CODECS.contains(&codec.as_str()))
}

fn normalize_probe_codec_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn upsert_movie_entry_in_library(library: &Library, entry: MovieEntry) -> Vec<MovieEntry> {
    let normalized_title = entry.title.trim().to_lowercase();
    let normalized_year = entry.year.trim().to_owned();
    let mut movies = library
        .movies
        .iter()
        .filter(|candidate| {
            if candidate.src.trim() == entry.src.trim() {
                return false;
            }
            let candidate_tmdb_id = candidate.tmdbId.trim();
            if !entry.tmdbId.trim().is_empty()
                && !candidate_tmdb_id.is_empty()
                && candidate_tmdb_id == entry.tmdbId.trim()
            {
                return false;
            }
            let candidate_title = candidate.title.trim().to_lowercase();
            let candidate_year = candidate.year.trim();
            !(candidate_title == normalized_title && candidate_year == normalized_year)
        })
        .cloned()
        .collect::<Vec<_>>();
    movies.insert(0, entry);
    movies
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

fn json_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        _ => String::new(),
    }
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

fn generate_upload_session_id() -> String {
    format!("{}-{}", now_ms(), random_suffix())
}

fn normalize_gallery_media_type(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("tv") {
        "tv".to_owned()
    } else {
        "movie".to_owned()
    }
}

fn normalize_gallery_download_url(value: &str) -> String {
    let raw = value.replace("\\/", "/").trim().to_owned();
    if raw.is_empty() {
        return String::new();
    }
    url::Url::parse(&raw)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.to_string())
        .unwrap_or_default()
}

fn is_allowed_gallery_download_url(download_url: &str) -> bool {
    url::Url::parse(download_url)
        .ok()
        .filter(|url| url.scheme() == "https")
        .and_then(|url| {
            let hostname = url.host_str()?.to_lowercase();
            Some(GALLERY_ALLOWED_DOWNLOAD_HOSTS.iter().any(|allowed_host| {
                hostname == *allowed_host || hostname.ends_with(&format!(".{allowed_host}"))
            }))
        })
        .unwrap_or(false)
}

fn normalize_gallery_video_extension(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if GALLERY_ALLOWED_VIDEO_EXTENSIONS.contains(&normalized.as_str()) {
        normalized
    } else {
        String::new()
    }
}

fn infer_gallery_video_extension(download_url: &str, filename_hint: &str) -> String {
    let mut extension = url::Url::parse(download_url)
        .ok()
        .and_then(|url| {
            Path::new(url.path())
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{}", value.to_lowercase()))
        })
        .map(|value| normalize_gallery_video_extension(&value))
        .unwrap_or_default();
    if extension.is_empty() {
        extension = detect_upload_extension(filename_hint)
            .map(|value| normalize_gallery_video_extension(&value))
            .unwrap_or_default();
    }
    extension.if_empty_then(|| ".mp4".to_owned())
}

fn build_gallery_download_job_key(
    tmdb_id: &str,
    media_type: &str,
    title: &str,
    year: &str,
    playable_url: &str,
) -> String {
    let normalized_tmdb_id = tmdb_id.trim();
    let normalized_media_type = normalize_gallery_media_type(media_type);
    if !normalized_tmdb_id.is_empty() {
        return format!("gallery:{normalized_media_type}:{normalized_tmdb_id}");
    }
    let title_key = slugify(
        &format!("{}-{}", normalize_whitespace(title), normalize_year(year)),
        "title",
    );
    format!(
        "gallery:url:{title_key}:{}",
        hash_stable_string(playable_url)
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::body::{Body, Bytes};
    use futures_util::stream;
    use serde_json::{Map, Value};

    use super::{
        UPLOAD_SESSION_CHUNK_MAX_BYTES, UploadService, UploadSession,
        build_gallery_download_job_key, infer_gallery_video_extension,
        is_allowed_gallery_download_url, normalize_gallery_download_url, now_ms,
    };
    use crate::{config::Config, media::MediaService, persistence::Db, process::RuntimeServices};

    #[test]
    fn accepts_only_allowed_gallery_hosts() {
        assert!(is_allowed_gallery_download_url(
            "https://download.real-debrid.com/path/video.mp4"
        ));
        assert!(is_allowed_gallery_download_url(
            "https://sub.real-debrid.com/path/video.mp4"
        ));
        assert!(!is_allowed_gallery_download_url(
            "http://download.real-debrid.com/path/video.mp4"
        ));
        assert!(!is_allowed_gallery_download_url(
            "https://example.com/video.mp4"
        ));
    }

    #[test]
    fn normalizes_gallery_url() {
        assert_eq!(
            normalize_gallery_download_url("https:\\/\\/download.real-debrid.com\\/video.mp4"),
            "https://download.real-debrid.com/video.mp4"
        );
    }

    #[test]
    fn infers_gallery_extension() {
        assert_eq!(
            infer_gallery_video_extension("https://download.real-debrid.com/path/video.mkv", ""),
            ".mkv"
        );
        assert_eq!(
            infer_gallery_video_extension(
                "https://download.real-debrid.com/path/video",
                "clip.mov"
            ),
            ".mov"
        );
    }

    #[test]
    fn builds_gallery_job_key_from_tmdb_or_url() {
        assert_eq!(
            build_gallery_download_job_key(
                "123",
                "tv",
                "Ignored",
                "2024",
                "https://download.real-debrid.com/x.mp4"
            ),
            "gallery:tv:123"
        );
        assert!(
            build_gallery_download_job_key(
                "",
                "movie",
                "My Title",
                "2024",
                "https://download.real-debrid.com/x.mp4"
            )
            .starts_with("gallery:url:")
        );
    }

    #[tokio::test]
    async fn streams_chunk_uploads_to_disk() {
        let (service, root_dir) = setup_test_upload_service("stream-chunk").await;
        let temp_path = service.config.upload_temp_dir.join("stream-chunk.part");
        service.sessions.insert(
            "session-1".to_owned(),
            UploadSession {
                temp_path: temp_path.clone(),
                file_name: "video.mp4".to_owned(),
                metadata: Map::new(),
                received_bytes: 0,
                created_at: now_ms(),
            },
        );

        let payload = service
            .append_chunk("session-1", Body::from("hello"))
            .await
            .expect("append streamed chunk");

        assert_eq!(
            payload.get("receivedBytes").and_then(Value::as_u64),
            Some(5)
        );
        assert_eq!(
            tokio::fs::read(&temp_path).await.expect("read chunk file"),
            b"hello"
        );
        assert_eq!(
            service
                .sessions
                .get("session-1")
                .expect("session exists")
                .received_bytes,
            5
        );

        let _ = tokio::fs::remove_dir_all(root_dir).await;
    }

    #[tokio::test]
    async fn rejects_oversized_chunks_without_leaving_partial_bytes() {
        let (service, root_dir) = setup_test_upload_service("reject-large-chunk").await;
        let temp_path = service
            .config
            .upload_temp_dir
            .join("reject-large-chunk.part");
        tokio::fs::create_dir_all(&service.config.upload_temp_dir)
            .await
            .expect("create upload temp dir");
        tokio::fs::write(&temp_path, b"seed")
            .await
            .expect("seed upload temp file");
        service.sessions.insert(
            "session-2".to_owned(),
            UploadSession {
                temp_path: temp_path.clone(),
                file_name: "video.mp4".to_owned(),
                metadata: Map::new(),
                received_bytes: 4,
                created_at: now_ms(),
            },
        );

        let oversized_stream = stream::iter(vec![
            Ok::<Bytes, std::io::Error>(Bytes::from(vec![
                b'a';
                UPLOAD_SESSION_CHUNK_MAX_BYTES / 2
            ])),
            Ok::<Bytes, std::io::Error>(Bytes::from(vec![
                b'b';
                (UPLOAD_SESSION_CHUNK_MAX_BYTES / 2) + 1
            ])),
        ]);
        let error = service
            .append_chunk("session-2", Body::from_stream(oversized_stream))
            .await
            .expect_err("oversized chunk should fail");

        assert!(
            format!("{error:?}").contains("Chunk payload exceeded"),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            tokio::fs::read(&temp_path)
                .await
                .expect("read rolled back file"),
            b"seed"
        );
        assert_eq!(
            service
                .sessions
                .get("session-2")
                .expect("session exists")
                .received_bytes,
            4
        );

        let _ = tokio::fs::remove_dir_all(root_dir).await;
    }

    async fn setup_test_upload_service(name: &str) -> (UploadService, PathBuf) {
        let root_dir = std::env::temp_dir().join(format!("netflix-upload-{name}-{}", now_ms()));
        let assets_dir = root_dir.join("assets");
        let cache_dir = root_dir.join("cache");
        let config = Config {
            root_dir: root_dir.clone(),
            frontend_dir: root_dir.clone(),
            assets_dir: assets_dir.clone(),
            cache_dir: cache_dir.clone(),
            hls_cache_dir: cache_dir.join("hls"),
            upload_temp_dir: cache_dir.join("uploads"),
            local_library_path: assets_dir.join("library.json"),
            persistent_cache_db_path: cache_dir.join("resolver-cache.sqlite"),
            host: "127.0.0.1".to_owned(),
            port: 0,
            max_upload_bytes: UPLOAD_SESSION_CHUNK_MAX_BYTES * 4,
            tmdb_api_key: String::new(),
            real_debrid_token: String::new(),
            torrentio_base_url: String::new(),
            codex_auth_file: String::new(),
            codex_url: String::new(),
            codex_model: String::new(),
            openai_api_key: String::new(),
            openai_responses_model: String::new(),

            remux_video_mode: "auto".to_owned(),
            hls_hwaccel_mode: "none".to_owned(),
            remux_hwaccel_mode: "none".to_owned(),
            auto_audio_sync_enabled: false,
            playback_sessions_enabled: false,
            opensubtitles_api_key: String::new(),
            opensubtitles_user_agent: String::new(),

        };
        tokio::fs::create_dir_all(&assets_dir)
            .await
            .expect("create assets dir");
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .expect("create cache dir");
        let db = Db::initialize(&config).await.expect("init db");
        let http_client = reqwest::Client::new();
        let media = MediaService::new(config.clone(), db, http_client.clone());
        let runtime = RuntimeServices::new(config.clone());
        (
            UploadService::new(config, runtime, media, http_client),
            root_dir,
        )
    }
}
