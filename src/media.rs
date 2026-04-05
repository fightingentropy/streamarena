use std::collections::HashSet;
use std::env;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};

use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use dashmap::DashMap;
use encoding_rs::{UTF_8, WINDOWS_1252};
use flate2::read::GzDecoder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use url::Url;
use url::form_urlencoded::Serializer;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::persistence::Db;
use crate::process::run_process_capture_text;

const HLS_SEGMENT_STALE_MS: u64 = 6 * 60 * 60 * 1000;
const SUBTITLE_EXTRACT_TIMEOUT_MS: u64 = 3 * 60 * 1000;
const EXTERNAL_SUBTITLE_CACHE_TTL_MS: u64 = 12 * 60 * 60 * 1000;
const OPENSUBTITLES_DEFAULT_USER_AGENT: &str = "netflix-rust-backend v1.0.0";
const OPENSUBTITLES_API_BASE: &str = "https://api.opensubtitles.com/api/v1";
const OPENSUBTITLES_TRACK_LIMIT: usize = 5;
const LOCAL_SIDECAR_SUBTITLE_STREAM_INDEX_BASE: i64 = 1_000_000;
const EXTERNAL_SUBTITLE_STREAM_INDEX_BASE: i64 = 2_000_000;

static ASS_OVERRIDE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\\[^}]*\}").expect("valid ASS override regex"));
static OPEN_CUE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<c(\.[^>]*)?>").expect("valid cue regex"));
static CLOSE_CUE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</c>").expect("valid cue regex"));
static OPEN_VOICE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<v(?:\s+[^>]*)?>").expect("valid voice regex"));
static CLOSE_VOICE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</v>").expect("valid voice regex"));
static SIMPLE_HTML_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</?(ruby|rt|font|span)[^>]*>").expect("valid subtitle HTML regex")
});
static SRT_TIMESTAMP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d{2}:\d{2}(?::\d{2})?),(\d{3})").expect("valid subtitle timestamp regex")
});

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MediaProbe {
    pub durationSeconds: i64,
    pub formatName: String,
    pub formatLongName: String,
    pub videoStartTimeSeconds: f64,
    pub videoBFrameLeadSeconds: f64,
    pub videoFrameRateFps: f64,
    pub videoBFrames: i64,
    pub videoCodec: String,
    pub audioTracks: Vec<AudioTrack>,
    pub subtitleTracks: Vec<SubtitleTrack>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioTrack {
    pub streamIndex: i64,
    pub language: String,
    pub title: String,
    pub codec: String,
    pub channels: i64,
    pub isDefault: bool,
    pub startTimeSeconds: f64,
    pub label: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub streamIndex: i64,
    pub language: String,
    pub title: String,
    pub codec: String,
    pub isDefault: bool,
    pub isTextBased: bool,
    pub isExternal: bool,
    pub label: String,
    pub vttUrl: String,
}

#[derive(Clone)]
pub struct MediaService {
    config: Config,
    db: Db,
    http_client: reqwest::Client,
    opensubtitles_api_key: String,
    subtitle_user_agent: String,
    probe_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    subtitle_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    external_subtitle_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
}

impl MediaService {
    pub fn new(config: Config, db: Db, http_client: reqwest::Client) -> Self {
        Self {
            config,
            db,
            http_client,
            opensubtitles_api_key: env::var("OPENSUBTITLES_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            subtitle_user_agent: env::var("OPENSUBTITLES_USER_AGENT")
                .unwrap_or_else(|_| OPENSUBTITLES_DEFAULT_USER_AGENT.to_owned())
                .trim()
                .to_owned(),
            probe_locks: Arc::new(DashMap::new()),
            subtitle_locks: Arc::new(DashMap::new()),
            external_subtitle_locks: Arc::new(DashMap::new()),
        }
    }

    pub async fn probe_media_tracks(&self, source: &str) -> AppResult<MediaProbe> {
        let source_input = self.resolve_transcode_input(source)?;
        let probe_key = build_media_probe_cache_key(&source_input);
        if let Some(cached) = self.cached_probe(&probe_key).await? {
            return Ok(cached);
        }

        let lock = key_lock(&self.probe_locks, &probe_key);
        let _guard = lock.lock().await;
        if let Some(cached) = self.cached_probe(&probe_key).await? {
            return Ok(cached);
        }

        let command = vec![
            "ffprobe".to_owned(),
            "-v".to_owned(),
            "error".to_owned(),
            "-print_format".to_owned(),
            "json".to_owned(),
            "-show_streams".to_owned(),
            "-show_format".to_owned(),
            source_input.clone(),
        ];
        let raw = run_process_capture_text(&command, 15_000)
            .await
            .map_err(ApiError::bad_gateway)?;
        let payload = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        let probe = parse_probe_tracks_from_ffprobe_payload(&payload, &source_input);
        self.db
            .set_media_probe_cache(
                probe_key,
                serde_json::to_value(&probe).unwrap_or_else(|_| json!({})),
            )
            .await?;
        Ok(probe)
    }

    pub async fn create_subtitle_vtt_response(
        &self,
        input: &str,
        subtitle_stream_index: i64,
    ) -> AppResult<Response<Body>> {
        let source_input = self.resolve_transcode_input(input)?;
        if subtitle_stream_index < 0 {
            return Err(ApiError::bad_request(
                "Missing or invalid subtitle stream index.",
            ));
        }

        let cache_path = build_subtitle_cache_path(
            &self.config.hls_cache_dir,
            &source_input,
            subtitle_stream_index,
        );
        if file_is_fresh_against_source(
            &cache_path,
            Duration::from_millis(HLS_SEGMENT_STALE_MS),
            &source_input,
        )
        .await
        {
            return serve_text_file(&cache_path, "text/vtt; charset=utf-8", "no-store").await;
        }

        let cache_key = format!("{source_input}|s:{subtitle_stream_index}");
        let lock = key_lock(&self.subtitle_locks, &cache_key);
        let _guard = lock.lock().await;
        if file_is_fresh_against_source(
            &cache_path,
            Duration::from_millis(HLS_SEGMENT_STALE_MS),
            &source_input,
        )
        .await
        {
            return serve_text_file(&cache_path, "text/vtt; charset=utf-8", "no-store").await;
        }

        let subtitle_text = self
            .extract_subtitle_vtt_text(&source_input, subtitle_stream_index)
            .await
            .unwrap_or_default();
        if !subtitle_text.trim().is_empty() {
            let _ = tokio::fs::create_dir_all(&self.config.hls_cache_dir).await;
            let _ = tokio::fs::write(&cache_path, subtitle_text.as_bytes()).await;
            return text_response(subtitle_text, "text/vtt; charset=utf-8", "no-store");
        }

        text_response("WEBVTT\n\n".to_owned(), "text/vtt; charset=utf-8", "no-store")
    }

    pub async fn create_external_subtitle_vtt_response(
        &self,
        download_url: &str,
    ) -> AppResult<Response<Body>> {
        let safe_url = normalize_external_subtitle_download_url(download_url);
        if safe_url.is_empty() || !is_allowed_external_subtitle_download_url(&safe_url) {
            return Err(ApiError::bad_request(
                "Missing or invalid external subtitle URL.",
            ));
        }

        let cache_path = build_external_subtitle_cache_path(&self.config.hls_cache_dir, &safe_url);
        if file_is_fresh(
            &cache_path,
            Duration::from_millis(EXTERNAL_SUBTITLE_CACHE_TTL_MS),
        )
        .await
        {
            return serve_text_file(&cache_path, "text/vtt; charset=utf-8", "no-store").await;
        }

        let lock = key_lock(&self.external_subtitle_locks, &safe_url);
        let _guard = lock.lock().await;
        if file_is_fresh(
            &cache_path,
            Duration::from_millis(EXTERNAL_SUBTITLE_CACHE_TTL_MS),
        )
        .await
        {
            return serve_text_file(&cache_path, "text/vtt; charset=utf-8", "no-store").await;
        }

        let subtitle_text = self
            .fetch_external_subtitle_payload(&safe_url)
            .await
            .unwrap_or_else(|_| "WEBVTT\n\n".to_owned());
        if subtitle_text.trim() != "WEBVTT" && !subtitle_text.trim().is_empty() {
            let _ = tokio::fs::create_dir_all(&self.config.hls_cache_dir).await;
            let _ = tokio::fs::write(&cache_path, subtitle_text.as_bytes()).await;
        }

        text_response(subtitle_text, "text/vtt; charset=utf-8", "no-store")
    }

    pub async fn create_opensubtitles_vtt_response(
        &self,
        file_id: i64,
    ) -> AppResult<Response<Body>> {
        if file_id <= 0 {
            return Err(ApiError::bad_request("Missing or invalid file id."));
        }
        let download_url = self
            .fetch_opensubtitles_download_url(file_id)
            .await
            .unwrap_or_default();
        if download_url.trim().is_empty() {
            return text_response("WEBVTT\n\n".to_owned(), "text/vtt; charset=utf-8", "no-store");
        }
        self.create_external_subtitle_vtt_response(&download_url)
            .await
    }

    pub async fn search_opensubtitles_tracks(
        &self,
        imdb_id: &str,
        title: &str,
        year: &str,
        preferred_language: &str,
        filename_hint: &str,
    ) -> Vec<SubtitleTrack> {
        let api_key = self.opensubtitles_api_key.trim();
        if api_key.is_empty() {
            return Vec::new();
        }

        let normalized_language = normalize_subtitle_preference(preferred_language);
        let search_language = if normalized_language.is_empty() || normalized_language == "off" {
            "en".to_owned()
        } else {
            normalized_language
        };
        let imdb_digits = imdb_id
            .trim()
            .strip_prefix("tt")
            .unwrap_or(imdb_id.trim())
            .trim();
        if imdb_digits.is_empty() && title.trim().is_empty() {
            return Vec::new();
        }

        let mut request = self
            .http_client
            .get(format!("{OPENSUBTITLES_API_BASE}/subtitles"));
        request = request
            .header("Api-Key", api_key)
            .header(
                reqwest::header::USER_AGENT,
                self.subtitle_user_agent.clone(),
            )
            .query(&[("languages", search_language.as_str())]);
        if !imdb_digits.is_empty() {
            request = request.query(&[("imdb_id", imdb_digits)]);
        } else {
            request = request.query(&[("query", title.trim())]);
            if !year.trim().is_empty() {
                request = request.query(&[("year", year.trim())]);
            }
        }

        let Ok(response) = request.send().await else {
            return Vec::new();
        };
        if !response.status().is_success() {
            return Vec::new();
        }
        let Ok(payload) = response.json::<Value>().await else {
            return Vec::new();
        };
        let normalized_filename_hint = normalize_subtitle_match_text(filename_hint);
        let normalized_title_hint = normalize_subtitle_match_text(title);
        let mut ranked = payload
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                let attributes = item.get("attributes")?;
                let file_id = attributes
                    .get("files")
                    .and_then(Value::as_array)
                    .and_then(|files| files.first())
                    .and_then(|file| file.get("file_id"))
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                if file_id <= 0 {
                    return None;
                }
                let language = normalize_subtitle_preference(
                    attributes
                        .get("language")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                if language.is_empty() {
                    return None;
                }
                let release = attributes
                    .get("release")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                let hearing_impaired = attributes
                    .get("hearing_impaired")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let foreign_parts_only = attributes
                    .get("foreign_parts_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let download_count = attributes
                    .get("download_count")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                let normalized_release = normalize_subtitle_match_text(&release);
                let mut score = download_count.clamp(0, 100_000) / 100;
                if !normalized_filename_hint.is_empty()
                    && !normalized_release.is_empty()
                    && (normalized_filename_hint.contains(&normalized_release)
                        || normalized_release.contains(&normalized_filename_hint))
                {
                    score += 1000;
                }
                if !normalized_title_hint.is_empty()
                    && !normalized_release.is_empty()
                    && normalized_release.contains(&normalized_title_hint)
                {
                    score += 400;
                }
                if hearing_impaired {
                    score -= 25;
                }
                if foreign_parts_only {
                    score -= 100;
                }
                let language_label = get_subtitle_language_display_name(&language);
                let label = if foreign_parts_only {
                    format!("{language_label} Forced (OpenSubtitles)")
                } else if hearing_impaired {
                    format!("{language_label} SDH (OpenSubtitles)")
                } else {
                    format!("{language_label} (OpenSubtitles)")
                };
                Some((
                    score,
                    SubtitleTrack {
                        streamIndex: EXTERNAL_SUBTITLE_STREAM_INDEX_BASE + file_id,
                        language,
                        title: release.clone(),
                        codec: "webvtt".to_owned(),
                        isDefault: false,
                        isTextBased: true,
                        isExternal: true,
                        label,
                        vttUrl: format!("/api/subtitles.opensubtitles.vtt?fileId={file_id}"),
                    },
                ))
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| right.0.cmp(&left.0));
        ranked
            .into_iter()
            .map(|(_, track)| track)
            .take(OPENSUBTITLES_TRACK_LIMIT)
            .collect::<Vec<_>>()
    }

    pub fn find_local_sidecar_subtitle_tracks(&self, source_input: &str) -> Vec<SubtitleTrack> {
        let Ok(resolved_input) = self.resolve_transcode_input(source_input) else {
            return Vec::new();
        };

        let source_path = Path::new(&resolved_input);
        if !source_path.is_file() {
            return Vec::new();
        }

        let Some(parent_dir) = source_path.parent() else {
            return Vec::new();
        };
        let Some(source_stem) = source_path.file_stem().and_then(|value| value.to_str()) else {
            return Vec::new();
        };

        let Ok(entries) = std::fs::read_dir(parent_dir) else {
            return Vec::new();
        };

        let mut candidates = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && path != source_path)
            .collect::<Vec<_>>();
        candidates.sort();

        let mut tracks = Vec::new();
        let mut next_stream_index = LOCAL_SIDECAR_SUBTITLE_STREAM_INDEX_BASE;

        for candidate_path in candidates {
            let Some(extension) = candidate_path.extension().and_then(|value| value.to_str()) else {
                continue;
            };
            let normalized_extension = extension.trim().to_lowercase();
            if !is_supported_sidecar_subtitle_extension(&normalized_extension) {
                continue;
            }

            let Some(candidate_stem) = candidate_path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(sidecar_suffix) =
                extract_sidecar_subtitle_suffix(source_stem, candidate_stem)
            else {
                continue;
            };

            let language = infer_sidecar_subtitle_language(sidecar_suffix);
            let title = infer_sidecar_subtitle_title(sidecar_suffix);
            let label = if language.is_empty() {
                if title.is_empty() {
                    "Subtitle".to_owned()
                } else {
                    title.clone()
                }
            } else {
                get_subtitle_language_display_name(&language)
            };
            let query = Serializer::new(String::new())
                .append_pair("input", &candidate_path.to_string_lossy())
                .append_pair("subtitleStream", "0")
                .finish();

            tracks.push(SubtitleTrack {
                streamIndex: next_stream_index,
                language,
                title,
                codec: subtitle_codec_from_extension(&normalized_extension),
                isDefault: false,
                isTextBased: true,
                isExternal: true,
                label,
                vttUrl: format!("/api/subtitles.vtt?{query}"),
            });
            next_stream_index += 1;
        }

        tracks
    }

    pub fn resolve_transcode_input(&self, raw_input: &str) -> AppResult<String> {
        let input = raw_input.trim();
        if input.is_empty() {
            return Err(ApiError::bad_request("Missing playback input."));
        }

        if let Some(playback_input) = parse_playback_proxy_input(input) {
            return self.resolve_transcode_input(&playback_input);
        }

        if let Ok(url) = Url::parse(input)
            && matches!(url.scheme(), "http" | "https")
        {
            if is_local_app_playback_url(&self.config, &url) {
                let local_path = to_local_path(&self.config.root_dir, url.path())
                    .ok_or_else(|| ApiError::bad_request("Invalid local playback path."))?;
                return Ok(local_path.to_string_lossy().to_string());
            }
            if is_allowed_remote_transcode_url(&url) {
                return Ok(url.to_string());
            }
            return Err(ApiError::bad_request("Unsupported remote playback URL."));
        }

        if input.starts_with('/') && is_path_inside_root_dir(&self.config.root_dir, input) {
            return Ok(input.to_owned());
        }

        let normalized_path = if input.starts_with('/') {
            input.to_owned()
        } else {
            format!("/{input}")
        };
        let file_path = to_local_path(&self.config.root_dir, &normalized_path)
            .ok_or_else(|| ApiError::bad_request("Invalid local playback path."))?;
        Ok(file_path.to_string_lossy().to_string())
    }

    async fn cached_probe(&self, probe_key: &str) -> AppResult<Option<MediaProbe>> {
        let Some(cached) = self.db.get_media_probe_cache(probe_key.to_owned()).await? else {
            return Ok(None);
        };
        Ok(serde_json::from_value::<MediaProbe>(cached).ok())
    }

    async fn extract_subtitle_vtt_text(
        &self,
        source_input: &str,
        subtitle_stream_index: i64,
    ) -> AppResult<String> {
        let try_extract = |map_specifier: String, source: String| async move {
            let command = vec![
                "ffmpeg".to_owned(),
                "-v".to_owned(),
                "error".to_owned(),
                "-i".to_owned(),
                source,
                "-map".to_owned(),
                map_specifier,
                "-c:s".to_owned(),
                "webvtt".to_owned(),
                "-f".to_owned(),
                "webvtt".to_owned(),
                "pipe:1".to_owned(),
            ];
            run_process_capture_text(&command, SUBTITLE_EXTRACT_TIMEOUT_MS)
                .await
                .map_err(ApiError::bad_gateway)
        };

        if let Ok(raw) = try_extract(
            format!("0:{subtitle_stream_index}"),
            source_input.to_owned(),
        )
        .await
        {
            let normalized = normalize_subtitle_text_to_vtt(&raw);
            if !normalized.trim().is_empty() {
                return Ok(normalized);
            }
        }

        let probe = self.probe_media_tracks(source_input).await?;
        if let Some(ordinal) = probe
            .subtitleTracks
            .iter()
            .position(|track| track.streamIndex == subtitle_stream_index)
            && let Ok(raw) = try_extract(format!("0:s:{ordinal}"), source_input.to_owned()).await
        {
            let normalized = normalize_subtitle_text_to_vtt(&raw);
            if !normalized.trim().is_empty() {
                return Ok(normalized);
            }
        }

        Ok(String::new())
    }

    async fn fetch_external_subtitle_payload(&self, download_url: &str) -> AppResult<String> {
        let response = self
            .http_client
            .get(download_url)
            .header(
                reqwest::header::USER_AGENT,
                self.subtitle_user_agent.clone(),
            )
            .send()
            .await
            .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
        if !response.status().is_success() {
            return Err(ApiError::bad_gateway(format!(
                "External subtitle request failed ({}).",
                response.status().as_u16()
            )));
        }

        let headers = response.headers().clone();
        let raw_bytes = response
            .bytes()
            .await
            .map_err(|error| ApiError::bad_gateway(error.to_string()))?
            .to_vec();
        if raw_bytes.is_empty() {
            return Ok(String::new());
        }

        let text_bytes = if is_likely_gzip_payload(download_url, &raw_bytes, &headers) {
            gunzip_bytes(&raw_bytes).unwrap_or(raw_bytes)
        } else {
            raw_bytes
        };
        Ok(normalize_subtitle_text_to_vtt(&decode_subtitle_bytes(
            &text_bytes,
        )))
    }

    async fn fetch_opensubtitles_download_url(&self, file_id: i64) -> AppResult<String> {
        let api_key = self.opensubtitles_api_key.trim();
        if api_key.is_empty() {
            return Err(ApiError::bad_request("Missing OpenSubtitles API key."));
        }
        let response = self
            .http_client
            .post(format!("{OPENSUBTITLES_API_BASE}/download"))
            .header("Api-Key", api_key)
            .header(
                reqwest::header::USER_AGENT,
                self.subtitle_user_agent.clone(),
            )
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&json!({ "file_id": file_id }))
            .send()
            .await
            .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
        if !response.status().is_success() {
            return Err(ApiError::bad_gateway(format!(
                "OpenSubtitles download request failed ({}).",
                response.status().as_u16()
            )));
        }
        let payload = response
            .json::<Value>()
            .await
            .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
        Ok(payload
            .get("link")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned())
    }
}

pub fn choose_audio_track_from_probe(
    probe: &MediaProbe,
    preferred_lang: &str,
) -> Option<AudioTrack> {
    let audio_tracks = &probe.audioTracks;
    if audio_tracks.is_empty() {
        return None;
    }

    let normalized_preferred = normalize_preferred_audio_lang(preferred_lang);
    if normalized_preferred == "auto"
        && let Some(original) = audio_tracks
            .iter()
            .find(|track| is_likely_original_audio_track(track))
    {
        return Some(original.clone());
    }

    if normalized_preferred != "auto" {
        if let Some(exact) = audio_tracks
            .iter()
            .find(|track| track.language == normalized_preferred)
        {
            return Some(exact.clone());
        }

        let preferred_tokens = language_hint_tokens(&normalized_preferred);
        if let Some(hinted) = audio_tracks.iter().find(|track| {
            let title = if track.title.trim().is_empty() {
                track.label.trim().to_lowercase()
            } else {
                track.title.trim().to_lowercase()
            };
            if title.is_empty() {
                return false;
            }
            let tokens = title
                .split(|ch: char| !ch.is_ascii_alphanumeric())
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>();
            preferred_tokens.iter().any(|token| tokens.contains(token))
        }) {
            return Some(hinted.clone());
        }
    }

    audio_tracks
        .iter()
        .find(|track| track.isDefault && !is_likely_dubbed_audio_track(track))
        .cloned()
        .or_else(|| {
            audio_tracks
                .iter()
                .find(|track| !is_likely_dubbed_audio_track(track))
                .cloned()
        })
        .or_else(|| {
            audio_tracks
                .iter()
                .find(|track| is_likely_original_audio_track(track))
                .cloned()
        })
        .or_else(|| audio_tracks.iter().find(|track| track.isDefault).cloned())
        .or_else(|| audio_tracks.first().cloned())
}

fn audio_track_descriptor_tokens(track: &AudioTrack) -> Vec<String> {
    format!("{} {}", track.title, track.label)
        .to_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn is_likely_original_audio_track(track: &AudioTrack) -> bool {
    let tokens = audio_track_descriptor_tokens(track);
    tokens
        .iter()
        .any(|token| matches!(token.as_str(), "original" | "orig"))
}

fn is_likely_dubbed_audio_track(track: &AudioTrack) -> bool {
    let tokens = audio_track_descriptor_tokens(track);
    tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "dub" | "dubbed" | "dublado" | "dublaj" | "voiceover" | "voice"
        )
    })
}

pub fn choose_subtitle_track_from_probe(
    probe: &MediaProbe,
    preferred_subtitle_lang: &str,
) -> Option<SubtitleTrack> {
    let subtitles = probe
        .subtitleTracks
        .iter()
        .filter(|track| is_playable_subtitle_track(track))
        .cloned()
        .collect::<Vec<_>>();
    if subtitles.is_empty() {
        return None;
    }

    let normalized = normalize_subtitle_preference(preferred_subtitle_lang);
    if normalized.is_empty() || normalized == "off" {
        return None;
    }

    let language_matches = subtitles
        .iter()
        .filter(|track| track.language == normalized)
        .cloned()
        .collect::<Vec<_>>();
    if !language_matches.is_empty() {
        return sort_subtitle_tracks_by_playback_preference(language_matches)
            .into_iter()
            .next();
    }

    let default_matches = subtitles
        .iter()
        .filter(|track| track.isDefault)
        .cloned()
        .collect::<Vec<_>>();
    if !default_matches.is_empty() {
        return sort_subtitle_tracks_by_playback_preference(default_matches)
            .into_iter()
            .next();
    }

    sort_subtitle_tracks_by_playback_preference(subtitles)
        .into_iter()
        .next()
}

pub fn merge_preferred_subtitle_tracks(
    preferred_tracks: Vec<SubtitleTrack>,
    fallback_tracks: Vec<SubtitleTrack>,
) -> Vec<SubtitleTrack> {
    let mut seen_stream_indexes = HashSet::new();
    preferred_tracks
        .into_iter()
        .chain(fallback_tracks)
        .filter(|track| seen_stream_indexes.insert(track.streamIndex))
        .collect()
}

fn parse_probe_tracks_from_ffprobe_payload(payload: &Value, source_input: &str) -> MediaProbe {
    let streams = payload
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let format_duration = payload
        .get("format")
        .and_then(|value| value.get("duration"))
        .and_then(json_number);
    let duration_seconds = format_duration
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.round() as i64)
        .unwrap_or(0);
    let format_name = payload
        .get("format")
        .and_then(|value| value.get("format_name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let format_long_name = payload
        .get("format")
        .and_then(|value| value.get("format_long_name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();

    let mut audio_tracks = Vec::new();
    let mut subtitle_tracks = Vec::new();
    let mut video_start_time_seconds = 0.0;
    let mut has_video_start_time = false;
    let mut video_b_frame_lead_seconds = 0.0;
    let mut video_frame_rate_fps = 0.0;
    let mut video_b_frames = 0_i64;
    let mut video_codec = String::new();

    for stream in streams {
        let Some(stream_index) = stream.get("index").and_then(Value::as_i64) else {
            continue;
        };
        if stream_index < 0 {
            continue;
        }

        let codec_type = stream
            .get("codec_type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        let codec = stream
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        let tags = stream
            .get("tags")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let language = normalize_iso_language(
            tags.get("language")
                .and_then(Value::as_str)
                .or_else(|| tags.get("LANGUAGE").and_then(Value::as_str))
                .unwrap_or_default(),
        );
        let stream_title = tags
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| tags.get("handler_name").and_then(Value::as_str))
            .unwrap_or_default()
            .trim()
            .to_owned();
        let disposition = stream
            .get("disposition")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let is_default = disposition
            .get("default")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            == 1;
        let channels = stream
            .get("channels")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            .max(0);
        let start_time_seconds = stream
            .get("start_time")
            .and_then(json_number)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(0.0);

        if codec_type == "video" && !has_video_start_time {
            video_start_time_seconds = start_time_seconds;
            has_video_start_time = true;
            video_codec = codec.clone();
            let fps = parse_frame_rate_to_fps(
                stream
                    .get("avg_frame_rate")
                    .and_then(Value::as_str)
                    .or_else(|| stream.get("r_frame_rate").and_then(Value::as_str))
                    .unwrap_or_default(),
            );
            if fps > 0.0 {
                video_frame_rate_fps = fps;
            }

            let b_frames = stream
                .get("has_b_frames")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            if b_frames > 0 {
                video_b_frames = b_frames;
            }
            if video_b_frames > 0 && video_frame_rate_fps > 0.0 {
                let lead_seconds = video_b_frames as f64 / video_frame_rate_fps;
                if lead_seconds > 0.0 && lead_seconds < 1.0 {
                    video_b_frame_lead_seconds = lead_seconds;
                }
            }
        }

        if codec_type == "audio" {
            let label = if stream_title.trim().is_empty() {
                let mut label = language.to_uppercase();
                if label.is_empty() {
                    label = "UND".to_owned();
                }
                if channels > 0 {
                    label = format!("{label} {channels}ch");
                }
                label
            } else {
                stream_title.clone()
            };
            audio_tracks.push(AudioTrack {
                streamIndex: stream_index,
                language,
                title: stream_title,
                codec,
                channels,
                isDefault: is_default,
                startTimeSeconds: start_time_seconds,
                label,
            });
            continue;
        }

        if codec_type == "subtitle" {
            let subtitle_title = tags
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let subtitle_handler_name = tags
                .get("handler_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let normalized_subtitle_title = if !subtitle_title.is_empty() {
                subtitle_title
            } else if is_generic_subtitle_handler(&subtitle_handler_name) {
                String::new()
            } else {
                subtitle_handler_name
            };
            let is_text_based = matches!(
                codec.as_str(),
                "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
            );
            let vtt_url = if is_text_based {
                let query = Serializer::new(String::new())
                    .append_pair("input", source_input)
                    .append_pair("subtitleStream", &stream_index.to_string())
                    .finish();
                format!("/api/subtitles.vtt?{query}")
            } else {
                String::new()
            };
            let label = if normalized_subtitle_title.trim().is_empty() {
                get_subtitle_language_display_name(if language.is_empty() {
                    "en"
                } else {
                    &language
                })
            } else {
                normalized_subtitle_title.clone()
            };
            subtitle_tracks.push(SubtitleTrack {
                streamIndex: stream_index,
                language,
                title: normalized_subtitle_title,
                codec,
                isDefault: is_default,
                isTextBased: is_text_based,
                isExternal: false,
                label,
                vttUrl: vtt_url,
            });
        }
    }

    MediaProbe {
        durationSeconds: duration_seconds,
        formatName: format_name,
        formatLongName: format_long_name,
        videoStartTimeSeconds: video_start_time_seconds,
        videoBFrameLeadSeconds: video_b_frame_lead_seconds,
        videoFrameRateFps: video_frame_rate_fps,
        videoBFrames: video_b_frames,
        videoCodec: video_codec,
        audioTracks: audio_tracks,
        subtitleTracks: subtitle_tracks,
    }
}

fn key_lock(map: &DashMap<String, Arc<Mutex<()>>>, key: &str) -> Arc<Mutex<()>> {
    map.entry(key.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn is_local_app_playback_url(config: &Config, url: &Url) -> bool {
    let hostname = url.host_str().unwrap_or_default().trim().to_lowercase();
    if hostname.is_empty() {
        return false;
    }
    let matches_host = hostname == config.host.to_lowercase()
        || matches!(
            hostname.as_str(),
            "127.0.0.1" | "localhost" | "::1" | "[::1]"
        );
    let matches_port = url.port_or_known_default().unwrap_or_default() == config.port;
    matches_host && matches_port
}

fn is_allowed_remote_transcode_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let hostname = url.host_str().unwrap_or_default().trim().to_lowercase();
    !hostname.is_empty()
        && (hostname == "download.real-debrid.com" || hostname.ends_with(".real-debrid.com"))
}

fn is_path_inside_root_dir(root_dir: &Path, value: &str) -> bool {
    let candidate = PathBuf::from(value);
    candidate == root_dir || candidate.starts_with(root_dir)
}

fn to_local_path(root_dir: &Path, pathname: &str) -> Option<PathBuf> {
    let mut requested = if pathname == "/" {
        "/index.html".to_owned()
    } else {
        pathname.to_owned()
    };
    if requested.len() > 1 && requested.ends_with('/') {
        requested.pop();
    }
    let file_name = Path::new(&requested)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !file_name.contains('.') {
        requested.push_str(".html");
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(&requested).components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir | Component::RootDir => {}
            _ => {}
        }
    }

    Some(root_dir.join(normalized))
}

fn parse_playback_proxy_input(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let url = Url::parse(raw)
        .or_else(|_| Url::parse(&format!("http://localhost{raw}")))
        .ok()?;
    if !matches!(url.path(), "/api/remux" | "/api/hls/master.m3u8") {
        return None;
    }
    let input = url
        .query_pairs()
        .find_map(|(key, value)| (key == "input").then(|| value.into_owned()))
        .unwrap_or_default();
    (!input.trim().is_empty()).then_some(input)
}

fn extract_playable_source_input(source: &str) -> String {
    parse_playback_proxy_input(source).unwrap_or_else(|| source.trim().to_owned())
}

fn build_media_probe_cache_key(source: &str) -> String {
    format!("source:{}", extract_playable_source_input(source))
}

fn build_subtitle_cache_path(
    cache_dir: &Path,
    source_input: &str,
    subtitle_stream_index: i64,
) -> PathBuf {
    cache_dir.join(format!(
        "{}.vtt",
        hash_stable_string(&format!("{source_input}|s:{subtitle_stream_index}"))
    ))
}

fn build_external_subtitle_cache_path(cache_dir: &Path, download_url: &str) -> PathBuf {
    cache_dir.join(format!(
        "{}.vtt",
        hash_stable_string(&format!("external-subtitle:{download_url}"))
    ))
}

async fn file_is_fresh(path: &Path, ttl: Duration) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    let Ok(modified_at) = metadata.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified_at)
        .map(|age| age <= ttl)
        .unwrap_or(false)
}

async fn file_is_fresh_against_source(path: &Path, ttl: Duration, source_input: &str) -> bool {
    if !file_is_fresh(path, ttl).await {
        return false;
    }

    let Ok(cache_metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    let Ok(cache_modified_at) = cache_metadata.modified() else {
        return false;
    };

    let source_path = Path::new(source_input);
    let Ok(source_metadata) = tokio::fs::metadata(source_path).await else {
        return true;
    };
    let Ok(source_modified_at) = source_metadata.modified() else {
        return true;
    };

    source_modified_at <= cache_modified_at
}

async fn serve_text_file(
    path: &Path,
    content_type: &str,
    cache_control: &str,
) -> AppResult<Response<Body>> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    response_with_headers(StatusCode::OK, bytes, content_type, cache_control)
}

fn text_response(
    body: String,
    content_type: &str,
    cache_control: &str,
) -> AppResult<Response<Body>> {
    response_with_headers(
        StatusCode::OK,
        body.into_bytes(),
        content_type,
        cache_control,
    )
}

fn response_with_headers(
    status: StatusCode,
    body: Vec<u8>,
    content_type: &str,
    cache_control: &str,
) -> AppResult<Response<Body>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(body))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn normalize_external_subtitle_download_url(value: &str) -> String {
    let raw = value.replace("\\/", "/").trim().to_owned();
    if raw.is_empty() {
        return String::new();
    }
    Url::parse(&raw)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.to_string())
        .unwrap_or_default()
}

fn is_allowed_external_subtitle_download_url(download_url: &str) -> bool {
    Url::parse(download_url)
        .ok()
        .filter(|url| url.scheme() == "https")
        .and_then(|url| {
            let hostname = url.host_str()?.to_lowercase();
            Some(
                hostname == "dl.opensubtitles.org"
                    || hostname == "www.opensubtitles.com"
                    || hostname.ends_with(".opensubtitles.org"),
            )
        })
        .unwrap_or(false)
}

fn normalize_subtitle_match_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace(|ch: char| !ch.is_ascii_alphanumeric(), " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_likely_gzip_payload(
    download_url: &str,
    bytes: &[u8],
    headers: &reqwest::header::HeaderMap,
) -> bool {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return true;
    }
    let content_encoding = headers
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_lowercase();
    if content_encoding.contains("gzip") {
        return true;
    }
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_lowercase();
    if content_type.contains("gzip") {
        return true;
    }
    download_url.to_lowercase().ends_with(".gz")
}

fn gunzip_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = GzDecoder::new(bytes);
    let mut output = Vec::new();
    decoder.read_to_end(&mut output).ok()?;
    Some(output)
}

fn decode_subtitle_bytes(raw_bytes: &[u8]) -> String {
    if raw_bytes.is_empty() {
        return String::new();
    }

    let (utf8, _, utf8_had_errors) = UTF_8.decode(raw_bytes);
    if !utf8_had_errors && !utf8.is_empty() {
        return utf8.into_owned();
    }

    let (cp1252, _, _) = WINDOWS_1252.decode(raw_bytes);
    if !cp1252.is_empty() {
        return cp1252.into_owned();
    }

    raw_bytes.iter().map(|byte| char::from(*byte)).collect()
}

pub fn normalize_subtitle_text_to_vtt(raw_text: &str) -> String {
    const CUE_LINE_PERCENT: i64 = 80;
    const CUE_POSITION_PERCENT: i64 = 50;
    const CUE_SIZE_PERCENT: i64 = 88;

    fn build_transparent_cue_style_block() -> String {
        [
            "STYLE",
            "::cue {",
            "  background-color: transparent;",
            "}",
            "::cue-region {",
            "  background-color: transparent;",
            "}",
            "",
        ]
        .join("\n")
    }

    fn strip_cue_markup(line: &str) -> String {
        let without_ass = ASS_OVERRIDE_RE.replace_all(line, "");
        let without_cue = OPEN_CUE_RE.replace_all(&without_ass, "");
        let without_close_cue = CLOSE_CUE_RE.replace_all(&without_cue, "");
        let without_voice = OPEN_VOICE_RE.replace_all(&without_close_cue, "");
        let without_close_voice = CLOSE_VOICE_RE.replace_all(&without_voice, "");
        SIMPLE_HTML_TAG_RE
            .replace_all(&without_close_voice, "")
            .to_string()
    }

    fn apply_cue_display_settings_to_timing_line(line: &str) -> String {
        let stripped = line
            .split_whitespace()
            .filter(|token| {
                !(token.starts_with("line:")
                    || token.starts_with("position:")
                    || token.starts_with("size:")
                    || token.starts_with("align:"))
            })
            .collect::<Vec<_>>()
            .join(" ");
        if !stripped.contains("-->") {
            return stripped.trim().to_owned();
        }
        format!(
            "{} line:{}% position:{}% size:{}% align:center",
            stripped.trim(),
            CUE_LINE_PERCENT,
            CUE_POSITION_PERCENT,
            CUE_SIZE_PERCENT
        )
    }

    fn sanitize_vtt_body(input: &str) -> String {
        let mut output = Vec::new();
        let mut in_style_block = false;

        for line in input.lines() {
            let trimmed = line.trim();
            if in_style_block {
                if trimmed.is_empty() {
                    in_style_block = false;
                }
                continue;
            }
            if trimmed.eq_ignore_ascii_case("STYLE") {
                in_style_block = true;
                continue;
            }
            if trimmed.is_empty() {
                output.push(String::new());
                continue;
            }
            if trimmed.starts_with("WEBVTT")
                || trimmed.starts_with("NOTE")
                || trimmed.starts_with("REGION")
                || trimmed.starts_with("X-TIMESTAMP-MAP=")
            {
                output.push(line.to_owned());
                continue;
            }
            if trimmed.contains("-->") {
                output.push(apply_cue_display_settings_to_timing_line(line));
                continue;
            }
            output.push(strip_cue_markup(line));
        }

        output.join("\n")
    }

    let normalized = raw_text
        .trim_start_matches('\u{FEFF}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_owned();
    if normalized.is_empty() {
        return format!("WEBVTT\n\n{}", build_transparent_cue_style_block());
    }

    if normalized.starts_with("WEBVTT") {
        let sanitized = sanitize_vtt_body(&normalized);
        let without_header = sanitized
            .strip_prefix("WEBVTT")
            .unwrap_or(&sanitized)
            .trim_start_matches(['\n', ' ', '\t'])
            .trim()
            .to_owned();
        return format!(
            "WEBVTT\n\n{}{}\n",
            build_transparent_cue_style_block(),
            without_header
        );
    }

    let normalized_srt = SRT_TIMESTAMP_RE.replace_all(&normalized, "$1.$2");
    let vtt_body = sanitize_vtt_body(&normalized_srt).trim().to_owned();
    format!(
        "WEBVTT\n\n{}{}\n",
        build_transparent_cue_style_block(),
        vtt_body
    )
}

fn normalize_preferred_audio_lang(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "auto" => "auto".to_owned(),
        "en" | "fr" | "es" | "de" | "it" | "pt" => value.trim().to_lowercase(),
        _ => "auto".to_owned(),
    }
}

fn normalize_subtitle_preference(value: &str) -> String {
    let raw = value.trim().to_lowercase();
    if raw.is_empty() || raw == "auto" {
        return String::new();
    }
    if matches!(raw.as_str(), "off" | "none" | "disabled") {
        return "off".to_owned();
    }
    normalize_iso_language(&raw)
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

fn get_subtitle_language_display_name(value: &str) -> String {
    match normalize_iso_language(value).as_str() {
        "en" => "English",
        "fr" => "French",
        "es" => "Spanish",
        "de" => "German",
        "it" => "Italian",
        "pt" => "Portuguese",
        "ja" => "Japanese",
        "ko" => "Korean",
        "zh" => "Chinese",
        "nl" => "Dutch",
        "ro" => "Romanian",
        "pl" => "Polish",
        "tr" => "Turkish",
        "ru" => "Russian",
        "ar" => "Arabic",
        _ => "English",
    }
    .to_owned()
}

fn is_supported_sidecar_subtitle_extension(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "srt" | "vtt" | "ass" | "ssa")
}

fn subtitle_codec_from_extension(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "srt" => "subrip".to_owned(),
        "vtt" => "webvtt".to_owned(),
        "ass" => "ass".to_owned(),
        "ssa" => "ssa".to_owned(),
        other => other.to_owned(),
    }
}

fn extract_sidecar_subtitle_suffix<'a>(
    source_stem: &str,
    candidate_stem: &'a str,
) -> Option<&'a str> {
    if candidate_stem.eq_ignore_ascii_case(source_stem) {
        return Some("");
    }

    for delimiter in ['.', '_', '-', ' '] {
        let prefix = format!("{source_stem}{delimiter}");
        if candidate_stem
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
        {
            return candidate_stem.get(prefix.len()..);
        }
    }

    None
}

fn infer_sidecar_subtitle_language(sidecar_suffix: &str) -> String {
    let trimmed = sidecar_suffix.trim_matches(|ch: char| {
        ch == '.' || ch == '_' || ch == '-' || ch == ' ' || ch == '(' || ch == ')' || ch == '[' || ch == ']'
    });
    if trimmed.is_empty() {
        return "en".to_owned();
    }

    let tokens = trimmed
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.trim().is_empty())
        .map(|token| token.trim().to_lowercase())
        .collect::<Vec<_>>();

    for preferred_language in [
        "en", "fr", "es", "de", "it", "pt", "ja", "ko", "zh", "nl", "ro", "pl", "tr", "ru",
        "ar",
    ] {
        let hint_tokens = language_hint_tokens(preferred_language);
        if tokens.iter().any(|token| hint_tokens.iter().any(|hint| token == hint)) {
            return preferred_language.to_owned();
        }
    }

    for token in &tokens {
        let normalized = normalize_iso_language(token);
        if normalized.len() == 2 {
            return normalized;
        }
    }

    String::new()
}

fn infer_sidecar_subtitle_title(sidecar_suffix: &str) -> String {
    let trimmed = sidecar_suffix.trim_matches(|ch: char| {
        ch == '.' || ch == '_' || ch == '-' || ch == ' ' || ch == '(' || ch == ')' || ch == '[' || ch == ']'
    });
    if trimmed.is_empty() {
        return String::new();
    }

    let lower = trimmed.to_lowercase();
    if lower.contains("forced") {
        return "Forced".to_owned();
    }
    if lower.contains("sdh") || lower.contains("hearing") || lower.contains("cc") {
        return "SDH".to_owned();
    }

    String::new()
}

fn language_hint_tokens(language: &str) -> Vec<&'static str> {
    match language {
        "en" => vec!["en", "eng", "english"],
        "fr" => vec!["fr", "fra", "fre", "french"],
        "es" => vec!["es", "spa", "spanish", "espanol", "castellano"],
        "de" => vec!["de", "ger", "deu", "german", "deutsch"],
        "it" => vec!["it", "ita", "italian", "italiano"],
        "pt" => vec!["pt", "por", "portuguese", "portugues", "brazilian", "ptbr"],
        "ja" => vec!["ja", "jpn", "japanese"],
        "ko" => vec!["ko", "kor", "korean"],
        "zh" => vec!["zh", "zho", "chi", "chinese"],
        "nl" => vec!["nl", "dut", "nld", "dutch"],
        "ro" => vec!["ro", "rum", "ron", "romanian"],
        "pl" => vec!["pl", "pol", "polish"],
        "tr" => vec!["tr", "tur", "turkish"],
        "ru" => vec!["ru", "rus", "russian"],
        "ar" => vec!["ar", "ara", "arabic"],
        _ => vec!["auto"],
    }
}

fn is_generic_subtitle_handler(value: &str) -> bool {
    let normalized = value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "subtitlehandler" | "subtitle" | "subtitles" | "text" | "movtext"
    )
}

fn is_playable_subtitle_track(track: &SubtitleTrack) -> bool {
    track.isTextBased && !track.vttUrl.trim().is_empty()
}

fn is_likely_forced_subtitle_track(track: &SubtitleTrack) -> bool {
    let label_text = track.label.to_lowercase();
    let title_text = track.title.to_lowercase();
    let combined = format!("{label_text} {title_text}");
    combined.contains("forced") || combined.contains("foreign") || combined.contains("sign")
}

fn sort_subtitle_tracks_by_playback_preference(tracks: Vec<SubtitleTrack>) -> Vec<SubtitleTrack> {
    let mut indexed_tracks = tracks.into_iter().enumerate().collect::<Vec<_>>();
    indexed_tracks.sort_by(|(left_index, left), (right_index, right)| {
        let left_forced = is_likely_forced_subtitle_track(left) as i32;
        let right_forced = is_likely_forced_subtitle_track(right) as i32;
        let left_external_priority = (!left.isExternal) as i32;
        let right_external_priority = (!right.isExternal) as i32;
        left_forced
            .cmp(&right_forced)
            .then_with(|| left_external_priority.cmp(&right_external_priority))
            .then_with(|| (!left.isDefault as i32).cmp(&(!right.isDefault as i32)))
            .then_with(|| left_index.cmp(right_index))
    });
    indexed_tracks.into_iter().map(|(_, track)| track).collect()
}

fn parse_frame_rate_to_fps(value: &str) -> f64 {
    let raw = value.trim();
    if raw.is_empty() {
        return 0.0;
    }
    if let Some((num_raw, den_raw)) = raw.split_once('/') {
        let num = num_raw.parse::<f64>().unwrap_or(0.0);
        let den = den_raw.parse::<f64>().unwrap_or(0.0);
        if num.is_finite() && den.is_finite() && den > 0.0 {
            return num / den;
        }
        return 0.0;
    }
    raw.parse::<f64>().unwrap_or(0.0)
}

fn hash_stable_string(value: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for ch in value.bytes() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("{hash:08x}")
}

fn json_number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::{
        AudioTrack, MediaProbe, SubtitleTrack, choose_audio_track_from_probe,
        choose_subtitle_track_from_probe, extract_sidecar_subtitle_suffix,
        infer_sidecar_subtitle_language, is_allowed_external_subtitle_download_url,
        is_allowed_remote_transcode_url, is_local_app_playback_url, merge_preferred_subtitle_tracks,
        normalize_external_subtitle_download_url, normalize_subtitle_text_to_vtt,
    };

    #[test]
    fn keeps_only_allowed_external_subtitle_hosts() {
        assert!(is_allowed_external_subtitle_download_url(
            "https://dl.opensubtitles.org/en/download/file.gz"
        ));
        assert!(!is_allowed_external_subtitle_download_url(
            "http://dl.opensubtitles.org/en/download/file.gz"
        ));
        assert!(!is_allowed_external_subtitle_download_url(
            "https://example.com/subtitle.srt"
        ));
    }

    #[test]
    fn normalizes_external_subtitle_urls() {
        assert_eq!(
            normalize_external_subtitle_download_url("https:\\/\\/dl.opensubtitles.org\\/foo.gz"),
            "https://dl.opensubtitles.org/foo.gz"
        );
    }

    #[test]
    fn normalizes_srt_to_vtt() {
        let normalized = normalize_subtitle_text_to_vtt(
            "1\r\n00:00:01,250 --> 00:00:03,000\r\nHello <font color=\"red\">world</font>\r\n",
        );
        assert!(normalized.starts_with("WEBVTT"));
        assert!(normalized.contains("00:00:01.250 --> 00:00:03.000"));
        assert!(normalized.contains("Hello world"));
        assert!(normalized.contains("background-color: transparent"));
    }

    #[test]
    fn extracts_sidecar_suffix_from_matching_video_stem() {
        assert_eq!(
            extract_sidecar_subtitle_suffix(
                "the-worst-person-in-the-world-2021-1080p-hevc",
                "the-worst-person-in-the-world-2021-1080p-hevc.en"
            ),
            Some("en")
        );
        assert_eq!(
            extract_sidecar_subtitle_suffix(
                "the-worst-person-in-the-world-2021-1080p-hevc",
                "the-worst-person-in-the-world-2021-1080p-hevc"
            ),
            Some("")
        );
    }

    #[test]
    fn infers_sidecar_subtitle_language_from_common_tokens() {
        assert_eq!(infer_sidecar_subtitle_language("en"), "en");
        assert_eq!(infer_sidecar_subtitle_language("english.sdh"), "en");
        assert_eq!(infer_sidecar_subtitle_language("pt-br"), "pt");
    }

    #[test]
    fn prefers_matching_audio_language() {
        let probe = MediaProbe {
            audioTracks: vec![
                AudioTrack {
                    streamIndex: 1,
                    language: "fr".to_owned(),
                    title: "French".to_owned(),
                    codec: "aac".to_owned(),
                    channels: 2,
                    isDefault: true,
                    startTimeSeconds: 0.0,
                    label: "French".to_owned(),
                },
                AudioTrack {
                    streamIndex: 2,
                    language: "en".to_owned(),
                    title: "English".to_owned(),
                    codec: "aac".to_owned(),
                    channels: 2,
                    isDefault: false,
                    startTimeSeconds: 0.0,
                    label: "English".to_owned(),
                },
            ],
            ..MediaProbe::default()
        };
        let selected = choose_audio_track_from_probe(&probe, "en").expect("audio track");
        assert_eq!(selected.streamIndex, 2);
    }

    #[test]
    fn auto_prefers_original_audio_track_over_default_dub() {
        let probe = MediaProbe {
            audioTracks: vec![
                AudioTrack {
                    streamIndex: 1,
                    language: "ru".to_owned(),
                    title: "DUB - Studio".to_owned(),
                    codec: "ac3".to_owned(),
                    channels: 6,
                    isDefault: true,
                    startTimeSeconds: 0.0,
                    label: "DUB - Studio".to_owned(),
                },
                AudioTrack {
                    streamIndex: 2,
                    language: "en".to_owned(),
                    title: "Original".to_owned(),
                    codec: "ac3".to_owned(),
                    channels: 6,
                    isDefault: false,
                    startTimeSeconds: 0.0,
                    label: "Original".to_owned(),
                },
            ],
            ..MediaProbe::default()
        };
        let selected = choose_audio_track_from_probe(&probe, "auto").expect("audio track");
        assert_eq!(selected.streamIndex, 2);
    }

    #[test]
    fn prefers_matching_subtitle_language() {
        let probe = MediaProbe {
            subtitleTracks: vec![
                SubtitleTrack {
                    streamIndex: 3,
                    language: "fr".to_owned(),
                    title: String::new(),
                    codec: "subrip".to_owned(),
                    isDefault: true,
                    isTextBased: true,
                    isExternal: false,
                    label: "French".to_owned(),
                    vttUrl: "/api/subtitles.vtt?x=1".to_owned(),
                },
                SubtitleTrack {
                    streamIndex: 4,
                    language: "en".to_owned(),
                    title: String::new(),
                    codec: "subrip".to_owned(),
                    isDefault: false,
                    isTextBased: true,
                    isExternal: false,
                    label: "English".to_owned(),
                    vttUrl: "/api/subtitles.vtt?x=2".to_owned(),
                },
            ],
            ..MediaProbe::default()
        };
        let selected = choose_subtitle_track_from_probe(&probe, "en").expect("subtitle track");
        assert_eq!(selected.streamIndex, 4);
    }

    #[test]
    fn prefers_external_subtitle_track_when_language_matches() {
        let probe = MediaProbe {
            subtitleTracks: merge_preferred_subtitle_tracks(
                vec![SubtitleTrack {
                    streamIndex: 2_000_123,
                    language: "en".to_owned(),
                    title: "The.Housemaid.2025.1080p.AMZN.WEB-DL".to_owned(),
                    codec: "webvtt".to_owned(),
                    isDefault: false,
                    isTextBased: true,
                    isExternal: true,
                    label: "English (OpenSubtitles)".to_owned(),
                    vttUrl: "/api/subtitles.opensubtitles.vtt?fileId=123".to_owned(),
                }],
                vec![SubtitleTrack {
                    streamIndex: 4,
                    language: "en".to_owned(),
                    title: String::new(),
                    codec: "subrip".to_owned(),
                    isDefault: true,
                    isTextBased: true,
                    isExternal: false,
                    label: "English".to_owned(),
                    vttUrl: "/api/subtitles.vtt?x=2".to_owned(),
                }],
            ),
            ..MediaProbe::default()
        };
        let selected = choose_subtitle_track_from_probe(&probe, "en").expect("subtitle track");
        assert_eq!(selected.streamIndex, 2_000_123);
    }

    #[test]
    fn accepts_only_known_remote_transcode_hosts() {
        assert!(is_allowed_remote_transcode_url(
            &Url::parse("https://download.real-debrid.com/video.mkv").expect("rd url")
        ));
        assert!(!is_allowed_remote_transcode_url(
            &Url::parse("https://example.com/video.mkv").expect("example url")
        ));
    }

    #[test]
    fn detects_local_app_playback_urls() {
        let config = crate::config::Config {
            root_dir: std::env::temp_dir(),
            frontend_dir: std::env::temp_dir(),
            assets_dir: std::env::temp_dir(),
            cache_dir: std::env::temp_dir(),
            hls_cache_dir: std::env::temp_dir(),
            upload_temp_dir: std::env::temp_dir(),
            local_library_path: std::env::temp_dir().join("library.json"),
            persistent_cache_db_path: std::env::temp_dir().join("cache.sqlite"),
            host: "127.0.0.1".to_owned(),
            port: 5173,
            max_upload_bytes: 1,
            tmdb_api_key: String::new(),
            real_debrid_token: String::new(),
            torrentio_base_url: String::new(),
            codex_auth_file: String::new(),
            codex_url: String::new(),
            codex_model: String::new(),
            openai_api_key: String::new(),
            openai_responses_model: String::new(),
            native_playback_mode: "off".to_owned(),
            remux_video_mode: "auto".to_owned(),
            hls_hwaccel_mode: "none".to_owned(),
            remux_hwaccel_mode: "none".to_owned(),
            auto_audio_sync_enabled: false,
            playback_sessions_enabled: false,
            mpv_binary: "mpv".to_owned(),
        };
        assert!(is_local_app_playback_url(
            &config,
            &Url::parse("http://127.0.0.1:5173/assets/videos/test.mp4").expect("local url")
        ));
        assert!(!is_local_app_playback_url(
            &config,
            &Url::parse("https://download.real-debrid.com/video.mp4").expect("rd url")
        ));
    }
}
