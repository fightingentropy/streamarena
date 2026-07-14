use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};

use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use dashmap::DashMap;
use encoding_rs::{UTF_8, WINDOWS_1252};
use flate2::read::GzDecoder;
use futures_util::{StreamExt, stream};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use url::Url;
use url::form_urlencoded::{Serializer, byte_serialize};

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::persistence::Db;
use crate::process::run_process_capture_text;
use crate::utils::hash_stable_string;

const HLS_SEGMENT_STALE_MS: u64 = 6 * 60 * 60 * 1000;
const SUBTITLE_EXTRACT_TIMEOUT_MS: u64 = 3 * 60 * 1000;
const EXTERNAL_SUBTITLE_CACHE_TTL_MS: u64 = 12 * 60 * 60 * 1000;
const OPENSUBTITLES_API_BASE: &str = "https://api.opensubtitles.com/api/v1";
const OPENSUBTITLES_TRACK_LIMIT: usize = 5;
const STREMIO_OPENSUBTITLES_ADDON_BASE: &str = "https://opensubtitles-v3.strem.io";
const STREMIO_SUBTITLE_SEARCH_TIMEOUT_SECONDS: u64 = 5;
const STREMIO_SUBTITLE_CONTENT_RANK_TIMEOUT_SECONDS: u64 = 5;
const STREMIO_SUBTITLE_CONTENT_RANK_MAX_CANDIDATES: usize = 12;
const STREMIO_SUBTITLE_CONTENT_RANK_MAX_CONCURRENT: usize = 6;
const STREMIO_SUBTITLE_CUE_ALIGNMENT_TOLERANCE_MS: u64 = 2_000;
const STREMIO_SUBTITLE_SEARCH_CACHE_TTL_MS: u64 = 6 * 60 * 60 * 1000;
const STREMIO_SUBTITLE_PARTIAL_CACHE_TTL_MS: u64 = 5 * 60 * 1000;
const STREMIO_SUBTITLE_SEARCH_CACHE_MAX_ENTRIES: usize = 512;
const STREMIO_SUBTITLE_STREAM_INDEX_BASE: i64 = 3_000_000_000;
const STREMIO_SUBTITLE_PREFERRED_TRACK_LIMIT: usize = 3;
const STREMIO_SUBTITLE_ENGLISH_FALLBACK_TRACK_LIMIT: usize = 2;
// Languages eligible for the keyless addon menu, in menu order. Every entry
// must have a real name in get_subtitle_language_display_name — unknown codes
// would otherwise be labeled "English".
const STREMIO_SUBTITLE_LANGUAGE_MENU: &[&str] = &[
    "en", "es", "fr", "de", "it", "pt", "el", "sq", "tr", "ru", "ar", "pl", "nl", "ro", "ja", "ko",
    "zh",
];
const LOCAL_SIDECAR_SUBTITLE_STREAM_INDEX_BASE: i64 = 1_000_000;
const EXTERNAL_SUBTITLE_STREAM_INDEX_BASE: i64 = 2_000_000;
const LOCAL_TORRENT_STREAM_PATH: &str = "/api/local-torrent/stream";
const LOCAL_CACHE_STREAM_PATH: &str = "/api/local-cache/stream";

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
static SUBTITLE_CONTENT_MARKUP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<[^>]+>|\[[^\]]*\]|\([^)]*\)|\{[^}]*\}")
        .expect("valid subtitle content markup regex")
});
static SUBTITLE_SPOKEN_LANGUAGE_MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)(?:\[[^\]]*\b(?:speak|speaks|speaking)\b[^\]]*\]|\([^)]*\b(?:speak|speaks|speaking)\b[^)]*\))",
    )
    .expect("valid spoken-language subtitle marker regex")
});
static SUBTITLE_FANTASY_LANGUAGE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:dothraki|valyrian|klingon|elvish|sindarin|quenya|huttese|parseltongue|vulcan|orcish|belter|chakobsa|fremen|foreign language|alien language|fictional language)\b|\bna'?vi\b|\bblack speech\b",
    )
    .expect("valid fantasy-language subtitle marker regex")
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

#[derive(Debug, Clone)]
struct StremioSubtitleCandidate {
    original_order: usize,
    language: String,
    subtitle_id: i64,
    download_url: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct EnglishSubtitleQuality {
    translated_dialogue_cues: usize,
    untranslated_dialogue_cues: usize,
    cue_count: usize,
}

#[derive(Debug, Clone)]
struct EnglishSubtitleCue {
    start_ms: u64,
    end_ms: u64,
    normalized_text: String,
    english_anchor_count: usize,
    has_spoken_language_marker: bool,
    looks_phonetic: bool,
}

#[derive(Debug, Clone, Default)]
struct EnglishSubtitleContent {
    cues: Vec<EnglishSubtitleCue>,
}

#[derive(Debug, Clone)]
struct StremioSubtitleCacheEntry {
    stored_at_ms: u64,
    ttl_ms: u64,
    tracks: Vec<SubtitleTrack>,
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
    // (stored_at_ms, tracks) per "imdb|season|episode|lang" key. Resolves hit
    // this on every playback start (including embed-cache fast hits), so the
    // addon lookup must not cost a network round-trip each time. Empty results
    // are cached too.
    stremio_subtitle_cache: Arc<DashMap<String, StremioSubtitleCacheEntry>>,
}

impl MediaService {
    pub fn new(config: Config, db: Db, http_client: reqwest::Client) -> Self {
        let opensubtitles_api_key = config.opensubtitles_api_key.clone();
        let subtitle_user_agent = config.opensubtitles_user_agent.clone();
        Self {
            config,
            db,
            http_client,
            opensubtitles_api_key,
            subtitle_user_agent,
            probe_locks: Arc::new(DashMap::new()),
            subtitle_locks: Arc::new(DashMap::new()),
            external_subtitle_locks: Arc::new(DashMap::new()),
            stremio_subtitle_cache: Arc::new(DashMap::new()),
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

    /// Duration (seconds) of a live-proxy HLS source, probed with the segment-protocol gates
    /// relaxed — its segment URLs carry a query string that masks the `.ts` extension, which
    /// the default `probe_media_tracks` ffprobe rejects. Takes an already-resolved localhost
    /// source URL; does NOT re-run `resolve_transcode_input` (that only accepts direct files /
    /// real-debrid and would reject the proxy URL).
    pub async fn probe_hls_source_duration(&self, source_input: &str) -> AppResult<i64> {
        let command = vec![
            "ffprobe".to_owned(),
            "-v".to_owned(),
            "error".to_owned(),
            "-protocol_whitelist".to_owned(),
            "file,http,https,tcp,tls,crypto".to_owned(),
            "-extension_picky".to_owned(),
            "0".to_owned(),
            "-allowed_extensions".to_owned(),
            "ALL".to_owned(),
            "-analyzeduration".to_owned(),
            "100M".to_owned(),
            "-probesize".to_owned(),
            "100M".to_owned(),
            "-print_format".to_owned(),
            "json".to_owned(),
            "-show_format".to_owned(),
            source_input.to_owned(),
        ];
        let raw = run_process_capture_text(&command, 20_000)
            .await
            .map_err(ApiError::bad_gateway)?;
        let payload = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        let duration = payload
            .get("format")
            .and_then(|format| format.get("duration"))
            .and_then(|value| value.as_str())
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        Ok(duration.max(1.0) as i64)
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

        text_response(
            "WEBVTT\n\n".to_owned(),
            "text/vtt; charset=utf-8",
            "no-store",
        )
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
            return text_response(
                "WEBVTT\n\n".to_owned(),
                "text/vtt; charset=utf-8",
                "no-store",
            );
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
        ranked.sort_by_key(|item| std::cmp::Reverse(item.0));
        ranked
            .into_iter()
            .map(|(_, track)| track)
            .take(OPENSUBTITLES_TRACK_LIMIT)
            .collect::<Vec<_>>()
    }

    /// Keyless subtitle search via the public Stremio OpenSubtitles addon.
    ///
    /// Used as a fallback when no OpenSubtitles API key is configured (the
    /// keyed search returns nothing in that case). The addon matches by IMDb
    /// id only; pass season/episode > 0 for series lookups.
    pub async fn search_stremio_addon_subtitle_tracks(
        &self,
        imdb_id: &str,
        season_number: i64,
        episode_number: i64,
        preferred_language: &str,
    ) -> Vec<SubtitleTrack> {
        let imdb_digits = imdb_id
            .trim()
            .strip_prefix("tt")
            .unwrap_or(imdb_id.trim())
            .trim();
        if imdb_digits.is_empty() || !imdb_digits.chars().all(|ch| ch.is_ascii_digit()) {
            return Vec::new();
        }

        let normalized_language = normalize_subtitle_preference(preferred_language);
        let cache_key =
            format!("{imdb_digits}|{season_number}|{episode_number}|{normalized_language}");
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
        if let Some(entry) = self.stremio_subtitle_cache.get(&cache_key)
            && now_ms.saturating_sub(entry.stored_at_ms) < entry.ttl_ms
        {
            return entry.tracks.clone();
        }

        let request_url = if season_number > 0 && episode_number > 0 {
            format!(
                "{STREMIO_OPENSUBTITLES_ADDON_BASE}/subtitles/series/tt{imdb_digits}:{season_number}:{episode_number}.json"
            )
        } else {
            format!("{STREMIO_OPENSUBTITLES_ADDON_BASE}/subtitles/movie/tt{imdb_digits}.json")
        };

        let fetch_payload = async {
            let response = self
                .http_client
                .get(request_url)
                .header(
                    reqwest::header::USER_AGENT,
                    self.subtitle_user_agent.clone(),
                )
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            response.json::<Value>().await.ok()
        };
        let Ok(Some(payload)) = tokio::time::timeout(
            Duration::from_secs(STREMIO_SUBTITLE_SEARCH_TIMEOUT_SECONDS),
            fetch_payload,
        )
        .await
        else {
            // Transient failures are not cached so the next resolve retries.
            return Vec::new();
        };
        let (content_qualities, content_analysis_complete) = self
            .analyze_stremio_english_subtitle_candidates(&payload, preferred_language)
            .await;
        let tracks = build_stremio_subtitle_tracks_from_payload(
            &payload,
            preferred_language,
            &content_qualities,
        );
        if self.stremio_subtitle_cache.len() >= STREMIO_SUBTITLE_SEARCH_CACHE_MAX_ENTRIES {
            self.stremio_subtitle_cache
                .retain(|_, entry| now_ms.saturating_sub(entry.stored_at_ms) < entry.ttl_ms);
            if self.stremio_subtitle_cache.len() >= STREMIO_SUBTITLE_SEARCH_CACHE_MAX_ENTRIES {
                self.stremio_subtitle_cache.clear();
            }
        }
        let cache_ttl_ms = if content_analysis_complete {
            STREMIO_SUBTITLE_SEARCH_CACHE_TTL_MS
        } else {
            STREMIO_SUBTITLE_PARTIAL_CACHE_TTL_MS
        };
        self.stremio_subtitle_cache.insert(
            cache_key,
            StremioSubtitleCacheEntry {
                stored_at_ms: now_ms,
                ttl_ms: cache_ttl_ms,
                tracks: tracks.clone(),
            },
        );
        tracks
    }

    async fn analyze_stremio_english_subtitle_candidates(
        &self,
        payload: &Value,
        preferred_language: &str,
    ) -> (HashMap<i64, EnglishSubtitleQuality>, bool) {
        let normalized_preference = normalize_subtitle_preference(preferred_language);
        let preferred = if normalized_preference.is_empty() || normalized_preference == "off" {
            "en"
        } else {
            normalized_preference.as_str()
        };
        if preferred != "en" {
            return (HashMap::new(), true);
        }

        let candidates = parse_stremio_subtitle_candidates(payload)
            .into_iter()
            .filter(|candidate| candidate.language == "en")
            .take(STREMIO_SUBTITLE_CONTENT_RANK_MAX_CANDIDATES)
            .collect::<Vec<_>>();
        let candidate_count = candidates.len();

        let mut pending = stream::iter(candidates)
            .map(|candidate| async move {
                let subtitle_text = self
                    .fetch_external_subtitle_payload(&candidate.download_url)
                    .await
                    .ok()?;
                let content = analyze_english_subtitle_content(&subtitle_text)?;
                Some((candidate.subtitle_id, content))
            })
            .buffer_unordered(STREMIO_SUBTITLE_CONTENT_RANK_MAX_CONCURRENT)
            .boxed();
        let deadline = tokio::time::Instant::now()
            + Duration::from_secs(STREMIO_SUBTITLE_CONTENT_RANK_TIMEOUT_SECONDS);
        let mut contents = HashMap::new();
        while let Ok(Some(result)) = tokio::time::timeout_at(deadline, pending.next()).await {
            if let Some((subtitle_id, content)) = result {
                contents.insert(subtitle_id, content);
            }
        }
        let complete = contents.len() == candidate_count;
        (build_english_subtitle_qualities(&contents), complete)
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
            let Some(extension) = candidate_path.extension().and_then(|value| value.to_str())
            else {
                continue;
            };
            let normalized_extension = extension.trim().to_lowercase();
            if !is_supported_sidecar_subtitle_extension(&normalized_extension) {
                continue;
            }

            let Some(candidate_stem) = candidate_path.file_stem().and_then(|value| value.to_str())
            else {
                continue;
            };
            let Some(sidecar_suffix) = extract_sidecar_subtitle_suffix(source_stem, candidate_stem)
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

        if is_local_cache_stream_input(input)
            && let Some(local_path) = local_cache_stream_file_path(&self.config, input)
        {
            return Ok(local_path.to_string_lossy().to_string());
        }

        if is_local_stream_input(input) {
            return Ok(local_backend_url(&self.config, input));
        }

        if let Ok(url) = Url::parse(input)
            && matches!(url.scheme(), "http" | "https")
        {
            if is_local_app_playback_url(&self.config, &url) {
                if is_local_cache_stream_url(&url)
                    && let Some(local_path) =
                        local_cache_stream_file_path(&self.config, url.as_str())
                {
                    return Ok(local_path.to_string_lossy().to_string());
                }
                if is_local_stream_url(&url) {
                    return Ok(url.to_string());
                }
                let local_path = resolve_local_media_path(&self.config, url.path())
                    .ok_or_else(|| ApiError::bad_request("Invalid local playback path."))?;
                return Ok(local_path.to_string_lossy().to_string());
            }
            if is_allowed_remote_transcode_url(&url) {
                return Ok(url.to_string());
            }
            return Err(ApiError::bad_request("Unsupported remote playback URL."));
        }

        if input.starts_with('/') && is_path_inside_root_dir(&self.config.root_dir, input) {
            let local_path = PathBuf::from(input);
            if is_allowed_local_media_file(&self.config, &local_path) {
                return Ok(local_path.to_string_lossy().to_string());
            }
            return Err(ApiError::bad_request("Invalid local playback path."));
        }

        let normalized_path = if input.starts_with('/') {
            input.to_owned()
        } else {
            format!("/{input}")
        };
        let file_path = resolve_local_media_path(&self.config, &normalized_path)
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

pub async fn probe_local_media_file(path: &Path) -> AppResult<MediaProbe> {
    let source_input = path
        .to_str()
        .ok_or_else(|| ApiError::bad_request("Local media path is invalid."))?
        .to_owned();
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
    Ok(parse_probe_tracks_from_ffprobe_payload(
        &payload,
        &source_input,
    ))
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

fn is_local_torrent_stream_input(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed == LOCAL_TORRENT_STREAM_PATH
        || trimmed.starts_with(&format!("{LOCAL_TORRENT_STREAM_PATH}?"))
}

fn is_local_cache_stream_input(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed == LOCAL_CACHE_STREAM_PATH
        || trimmed.starts_with(&format!("{LOCAL_CACHE_STREAM_PATH}?"))
}

fn is_local_stream_input(value: &str) -> bool {
    is_local_torrent_stream_input(value) || is_local_cache_stream_input(value)
}

fn is_local_torrent_stream_url(url: &Url) -> bool {
    url.path() == LOCAL_TORRENT_STREAM_PATH
}

fn is_local_cache_stream_url(url: &Url) -> bool {
    url.path() == LOCAL_CACHE_STREAM_PATH
}

fn is_local_stream_url(url: &Url) -> bool {
    is_local_torrent_stream_url(url) || is_local_cache_stream_url(url)
}

fn local_cache_stream_file_path(config: &Config, value: &str) -> Option<PathBuf> {
    let (path, query) = if let Ok(url) = Url::parse(value) {
        (
            url.path().to_owned(),
            url.query().unwrap_or_default().to_owned(),
        )
    } else {
        let trimmed = value.trim();
        let (path, query) = trimmed.split_once('?')?;
        (path.to_owned(), query.to_owned())
    };
    if path != LOCAL_CACHE_STREAM_PATH {
        return None;
    }
    let params = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect::<std::collections::HashMap<String, String>>();
    let source_hash = normalize_local_cache_hash(params.get("sourceHash")?);
    let file_id = normalize_local_cache_file_id(params.get("fileId")?);
    if source_hash.is_empty() || file_id.is_empty() {
        return None;
    }
    let folder = config
        .local_torrent_cache_dir
        .join(source_hash)
        .join("direct")
        .join(file_id);
    let entries = std::fs::read_dir(folder).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let filename = path.file_name().and_then(|value| value.to_str())?;
        if filename.starts_with('.') {
            continue;
        }
        if entry
            .metadata()
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn normalize_local_cache_hash(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.len() == 40 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        normalized
    } else {
        String::new()
    }
}

fn normalize_local_cache_file_id(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    normalized.trim_matches('.').trim_matches('_').to_owned()
}

fn local_backend_url(config: &Config, path_and_query: &str) -> String {
    let host = match config.host.trim() {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        host => host,
    };
    let signed_path = crate::local_torrent::with_internal_stream_access(
        path_and_query.trim(),
        &config.live_hls_proxy_secret,
    );
    format!("http://{host}:{}{signed_path}", config.port)
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
    let Ok(root_dir) = root_dir.canonicalize() else {
        return false;
    };
    let Ok(candidate) = PathBuf::from(value).canonicalize() else {
        return false;
    };
    candidate == root_dir || candidate.starts_with(root_dir)
}

fn resolve_local_media_path(config: &Config, pathname: &str) -> Option<PathBuf> {
    let local_path = to_local_path(&config.root_dir, pathname)?;
    is_allowed_local_media_file(config, &local_path).then_some(local_path)
}

fn is_allowed_local_media_file(config: &Config, path: &Path) -> bool {
    let Ok(candidate) = path.canonicalize() else {
        return false;
    };
    let allowed_roots = [
        config.assets_dir.join("videos"),
        config.local_torrent_cache_dir.clone(),
    ];
    allowed_roots.iter().any(|root| {
        root.canonicalize()
            .map(|allowed| candidate == allowed || candidate.starts_with(allowed))
            .unwrap_or(false)
    })
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
                    || hostname.ends_with(".opensubtitles.org")
                    || hostname == "strem.io"
                    || hostname.ends_with(".strem.io"),
            )
        })
        .unwrap_or(false)
}

fn stremio_subtitle_language_menu_rank(language: &str, preferred_language: &str) -> usize {
    if language == preferred_language {
        return 0;
    }
    if language == "en" {
        return 1;
    }
    STREMIO_SUBTITLE_LANGUAGE_MENU
        .iter()
        .position(|candidate| *candidate == language)
        .map(|position| position + 2)
        .unwrap_or(usize::MAX)
}

fn parse_stremio_subtitle_candidates(payload: &Value) -> Vec<StremioSubtitleCandidate> {
    let mut seen_subtitle_ids = HashSet::new();
    payload
        .get("subtitles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(original_order, item)| {
            let download_url = item
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !is_allowed_external_subtitle_download_url(&download_url) {
                return None;
            }
            let language = normalize_iso_language(
                item.get("lang").and_then(Value::as_str).unwrap_or_default(),
            );
            if !STREMIO_SUBTITLE_LANGUAGE_MENU.contains(&language.as_str()) {
                return None;
            }
            let subtitle_id = item
                .get("id")
                .and_then(|value| {
                    value.as_i64().or_else(|| {
                        value
                            .as_str()
                            .and_then(|raw| raw.trim().parse::<i64>().ok())
                    })
                })
                .unwrap_or_default();
            if subtitle_id <= 0 || !seen_subtitle_ids.insert(subtitle_id) {
                return None;
            }
            Some(StremioSubtitleCandidate {
                original_order,
                language,
                subtitle_id,
                download_url,
            })
        })
        .collect()
}

fn is_english_subtitle_anchor(token: &str) -> bool {
    matches!(
        token,
        "a" | "about"
            | "after"
            | "again"
            | "all"
            | "am"
            | "an"
            | "and"
            | "any"
            | "are"
            | "as"
            | "at"
            | "away"
            | "back"
            | "be"
            | "because"
            | "been"
            | "before"
            | "but"
            | "by"
            | "can"
            | "come"
            | "could"
            | "dead"
            | "did"
            | "do"
            | "does"
            | "don"
            | "for"
            | "from"
            | "get"
            | "give"
            | "go"
            | "good"
            | "had"
            | "has"
            | "have"
            | "he"
            | "her"
            | "here"
            | "him"
            | "his"
            | "how"
            | "i"
            | "if"
            | "in"
            | "into"
            | "is"
            | "it"
            | "know"
            | "let"
            | "like"
            | "look"
            | "make"
            | "me"
            | "more"
            | "must"
            | "my"
            | "no"
            | "not"
            | "now"
            | "of"
            | "off"
            | "on"
            | "one"
            | "only"
            | "or"
            | "our"
            | "out"
            | "please"
            | "say"
            | "see"
            | "she"
            | "should"
            | "so"
            | "some"
            | "stop"
            | "take"
            | "tell"
            | "than"
            | "that"
            | "the"
            | "their"
            | "them"
            | "then"
            | "there"
            | "they"
            | "this"
            | "to"
            | "tonight"
            | "too"
            | "up"
            | "upon"
            | "us"
            | "want"
            | "was"
            | "we"
            | "were"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "why"
            | "will"
            | "with"
            | "would"
            | "yes"
            | "you"
            | "your"
    )
}

fn english_subtitle_anchor_count(words: &[String]) -> usize {
    words
        .iter()
        .filter(|word| is_english_subtitle_anchor(word))
        .count()
}

fn parse_subtitle_timestamp_ms(value: &str) -> Option<u64> {
    let value = value.split_whitespace().next()?.replace(',', ".");
    let (clock, fraction) = value.split_once('.').unwrap_or((&value, "0"));
    let parts = clock
        .split(':')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (0, *minutes, *seconds),
        [hours, minutes, seconds] => (*hours, *minutes, *seconds),
        _ => return None,
    };
    let milliseconds = format!("{fraction:0<3}")
        .chars()
        .take(3)
        .collect::<String>()
        .parse::<u64>()
        .ok()?;
    Some(((hours * 60 * 60 + minutes * 60 + seconds) * 1_000) + milliseconds)
}

fn parse_subtitle_cue_timing(block: &str) -> Option<(u64, u64)> {
    let timeline = block.lines().find(|line| line.contains("-->"))?;
    let (start, end) = timeline.split_once("-->")?;
    let start_ms = parse_subtitle_timestamp_ms(start)?;
    let end_ms = parse_subtitle_timestamp_ms(end)?;
    (end_ms >= start_ms).then_some((start_ms, end_ms))
}

fn subtitle_cues_align(left: &EnglishSubtitleCue, right: &EnglishSubtitleCue) -> bool {
    left.start_ms
        <= right
            .end_ms
            .saturating_add(STREMIO_SUBTITLE_CUE_ALIGNMENT_TOLERANCE_MS)
        && right.start_ms
            <= left
                .end_ms
                .saturating_add(STREMIO_SUBTITLE_CUE_ALIGNMENT_TOLERANCE_MS)
}

fn subtitle_contents_have_compatible_timing(
    left: &EnglishSubtitleContent,
    right: &EnglishSubtitleContent,
) -> bool {
    let shorter_cue_count = left.cues.len().min(right.cues.len());
    if shorter_cue_count <= 3 {
        return true;
    }
    let required_matches = (shorter_cue_count / 20).clamp(3, 24);
    let mut used_right_cues = vec![false; right.cues.len()];
    let mut matches = 0;
    for left_cue in &left.cues {
        let Some((right_index, _)) = right.cues.iter().enumerate().find(|(index, right_cue)| {
            !used_right_cues[*index]
                && left_cue.normalized_text.len() >= 4
                && left_cue.normalized_text == right_cue.normalized_text
                && subtitle_cues_align(left_cue, right_cue)
        }) else {
            continue;
        };
        used_right_cues[right_index] = true;
        matches += 1;
        if matches >= required_matches {
            return true;
        }
    }
    false
}

fn analyze_english_subtitle_content(text: &str) -> Option<EnglishSubtitleContent> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut content = EnglishSubtitleContent::default();
    for block in normalized
        .split("\n\n")
        .filter(|block| block.contains("-->"))
    {
        let Some((start_ms, end_ms)) = parse_subtitle_cue_timing(block) else {
            continue;
        };
        let cue_text = block
            .lines()
            .filter(|line| {
                !line.contains("-->") && !line.trim().chars().all(|ch| ch.is_ascii_digit())
            })
            .collect::<Vec<_>>()
            .join(" ");
        if cue_text.trim().is_empty() {
            continue;
        }

        let lower = cue_text.to_lowercase();
        let has_spoken_language_marker = SUBTITLE_SPOKEN_LANGUAGE_MARKER_RE
            .find_iter(&lower)
            .any(|marker| SUBTITLE_FANTASY_LANGUAGE_NAME_RE.is_match(marker.as_str()));
        let cleaned = SUBTITLE_CONTENT_MARKUP_RE.replace_all(&lower, " ");
        let words = cleaned
            .split(|ch: char| !ch.is_alphabetic())
            .filter(|word| word.chars().count() >= 2)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let english_anchor_count = english_subtitle_anchor_count(&words);
        content.cues.push(EnglishSubtitleCue {
            start_ms,
            end_ms,
            normalized_text: words.join(" "),
            english_anchor_count,
            has_spoken_language_marker,
            looks_phonetic: lower.contains("<i>") && words.len() >= 4 && english_anchor_count == 0,
        });
    }

    (!content.cues.is_empty()).then_some(content)
}

fn build_english_subtitle_qualities(
    contents: &HashMap<i64, EnglishSubtitleContent>,
) -> HashMap<i64, EnglishSubtitleQuality> {
    let content_entries = contents.iter().collect::<Vec<_>>();
    let mut compatible_pairs = HashSet::new();
    for (index, (left_id, left_content)) in content_entries.iter().enumerate() {
        for (right_id, right_content) in content_entries.iter().skip(index + 1) {
            if subtitle_contents_have_compatible_timing(left_content, right_content) {
                compatible_pairs.insert((**left_id, **right_id));
                compatible_pairs.insert((**right_id, **left_id));
            }
        }
    }

    contents
        .iter()
        .map(|(subtitle_id, content)| {
            let mut quality = EnglishSubtitleQuality {
                cue_count: content.cues.len(),
                ..EnglishSubtitleQuality::default()
            };
            for cue in &content.cues {
                if cue.has_spoken_language_marker {
                    if cue.english_anchor_count >= 2 {
                        quality.translated_dialogue_cues += 1;
                    } else {
                        quality.untranslated_dialogue_cues += 1;
                    }
                    continue;
                }

                let mut aligned_cues = contents
                    .iter()
                    .filter(|(other_id, _)| compatible_pairs.contains(&(*subtitle_id, **other_id)))
                    .flat_map(|(_, other_content)| other_content.cues.iter())
                    .filter(|other_cue| subtitle_cues_align(cue, other_cue));
                if cue.english_anchor_count >= 2
                    && aligned_cues
                        .clone()
                        .any(|other_cue| other_cue.looks_phonetic)
                {
                    quality.translated_dialogue_cues += 1;
                } else if cue.looks_phonetic
                    && aligned_cues.any(|other_cue| other_cue.english_anchor_count >= 2)
                {
                    quality.untranslated_dialogue_cues += 1;
                }
            }
            (*subtitle_id, quality)
        })
        .collect()
}

fn english_subtitle_quality_rank(
    quality: EnglishSubtitleQuality,
    max_english_cue_count: usize,
) -> (bool, bool, i64) {
    let content_rank = quality.translated_dialogue_cues as i64 * 30
        - quality.untranslated_dialogue_cues as i64 * 12;
    let has_full_caption_coverage =
        max_english_cue_count > 0 && quality.cue_count.saturating_mul(2) >= max_english_cue_count;
    (
        has_confident_english_translation(quality),
        has_full_caption_coverage,
        content_rank,
    )
}

fn has_confident_english_translation(quality: EnglishSubtitleQuality) -> bool {
    quality.translated_dialogue_cues > quality.untranslated_dialogue_cues
}

fn build_stremio_subtitle_tracks_from_payload(
    payload: &Value,
    preferred_language: &str,
    content_qualities: &HashMap<i64, EnglishSubtitleQuality>,
) -> Vec<SubtitleTrack> {
    let normalized_preference = normalize_subtitle_preference(preferred_language);
    let preferred = if normalized_preference.is_empty() || normalized_preference == "off" {
        "en".to_owned()
    } else {
        normalized_preference
    };

    let max_english_cue_count = content_qualities
        .values()
        .map(|quality| quality.cue_count)
        .max()
        .unwrap_or_default();
    let mut candidates = parse_stremio_subtitle_candidates(payload);
    candidates.sort_by(|left, right| {
        stremio_subtitle_language_menu_rank(&left.language, &preferred)
            .cmp(&stremio_subtitle_language_menu_rank(
                &right.language,
                &preferred,
            ))
            .then_with(|| {
                if left.language != "en" || right.language != "en" {
                    return std::cmp::Ordering::Equal;
                }
                let left_quality = content_qualities
                    .get(&left.subtitle_id)
                    .copied()
                    .unwrap_or_default();
                let right_quality = content_qualities
                    .get(&right.subtitle_id)
                    .copied()
                    .unwrap_or_default();
                english_subtitle_quality_rank(right_quality, max_english_cue_count)
                    .cmp(&english_subtitle_quality_rank(
                        left_quality,
                        max_english_cue_count,
                    ))
                    .then_with(|| {
                        content_qualities
                            .contains_key(&right.subtitle_id)
                            .cmp(&content_qualities.contains_key(&left.subtitle_id))
                    })
            })
            .then_with(|| left.original_order.cmp(&right.original_order))
    });

    let mut per_language_counts: HashMap<String, usize> = HashMap::new();
    let mut selected = Vec::new();
    for candidate in candidates {
        let language = &candidate.language;
        let quota = if language.as_str() == preferred {
            STREMIO_SUBTITLE_PREFERRED_TRACK_LIMIT
        } else if language == "en" {
            STREMIO_SUBTITLE_ENGLISH_FALLBACK_TRACK_LIMIT
        } else {
            1
        };
        let language_count = per_language_counts.entry(language.clone()).or_insert(0);
        if *language_count >= quota {
            continue;
        }
        *language_count += 1;
        selected.push(candidate);
    }

    let translated_track_id = selected
        .iter()
        .find(|candidate| candidate.language == "en")
        .and_then(|candidate| {
            let best = content_qualities.get(&candidate.subtitle_id)?;
            has_confident_english_translation(*best).then_some(candidate.subtitle_id)
        });
    let translated_track_is_forced = translated_track_id
        .and_then(|subtitle_id| content_qualities.get(&subtitle_id))
        .is_some_and(|quality| {
            max_english_cue_count > 0 && quality.cue_count.saturating_mul(2) < max_english_cue_count
        });

    let mut label_counts: HashMap<String, usize> = HashMap::new();
    selected
        .into_iter()
        .map(|candidate| {
            let StremioSubtitleCandidate {
                language,
                subtitle_id,
                download_url,
                ..
            } = candidate;
            let language_label = get_subtitle_language_display_name(&language);
            let label_count = label_counts.entry(language.clone()).or_insert(0);
            *label_count += 1;
            let label = if translated_track_id == Some(subtitle_id) && translated_track_is_forced {
                format!("{language_label} Translated Forced (OpenSubtitles)")
            } else if translated_track_id == Some(subtitle_id) {
                format!("{language_label} Translated (OpenSubtitles)")
            } else if *label_count > 1 {
                format!("{language_label} (OpenSubtitles) {label_count}")
            } else {
                format!("{language_label} (OpenSubtitles)")
            };
            SubtitleTrack {
                streamIndex: STREMIO_SUBTITLE_STREAM_INDEX_BASE + subtitle_id,
                language,
                title: String::new(),
                codec: "webvtt".to_owned(),
                isDefault: false,
                isTextBased: true,
                isExternal: true,
                label,
                vttUrl: format!(
                    "/api/subtitles.external.vtt?download={}",
                    byte_serialize(download_url.as_bytes()).collect::<String>()
                ),
            }
        })
        .collect()
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
        "por" | "pob" | "pb" => "pt",
        "jpn" => "ja",
        "kor" => "ko",
        "zho" | "chi" => "zh",
        "dut" | "nld" => "nl",
        "rum" | "ron" => "ro",
        "pol" => "pl",
        "tur" => "tr",
        "rus" => "ru",
        "ara" => "ar",
        "gre" | "ell" => "el",
        "alb" | "sqi" => "sq",
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
        "el" => "Greek",
        "sq" => "Albanian",
        _ => "English",
    }
    .to_owned()
}

fn is_supported_sidecar_subtitle_extension(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "srt" | "vtt" | "ass" | "ssa"
    )
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
        ch == '.'
            || ch == '_'
            || ch == '-'
            || ch == ' '
            || ch == '('
            || ch == ')'
            || ch == '['
            || ch == ']'
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
        "en", "fr", "es", "de", "it", "pt", "ja", "ko", "zh", "nl", "ro", "pl", "tr", "ru", "ar",
    ] {
        let hint_tokens = language_hint_tokens(preferred_language);
        if tokens
            .iter()
            .any(|token| hint_tokens.iter().any(|hint| token == hint))
        {
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
        ch == '.'
            || ch == '_'
            || ch == '-'
            || ch == ' '
            || ch == '('
            || ch == ')'
            || ch == '['
            || ch == ']'
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

fn json_number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use url::Url;

    use super::{
        AudioTrack, MediaProbe, SubtitleTrack, analyze_english_subtitle_content,
        build_english_subtitle_qualities, build_stremio_subtitle_tracks_from_payload,
        choose_audio_track_from_probe, choose_subtitle_track_from_probe,
        extract_sidecar_subtitle_suffix, infer_sidecar_subtitle_language,
        is_allowed_external_subtitle_download_url, is_allowed_remote_transcode_url,
        is_local_app_playback_url, is_local_cache_stream_input, is_local_cache_stream_url,
        is_local_torrent_stream_input, is_local_torrent_stream_url, is_path_inside_root_dir,
        local_cache_stream_file_path, merge_preferred_subtitle_tracks,
        normalize_external_subtitle_download_url, normalize_subtitle_text_to_vtt,
        resolve_local_media_path,
    };

    fn test_config(root_dir: PathBuf) -> crate::config::Config {
        let assets_dir = root_dir.join("assets");
        let cache_dir = root_dir.join("cache");
        crate::config::Config {
            root_dir,
            frontend_dir: std::env::temp_dir(),
            assets_dir: assets_dir.clone(),
            cache_dir: cache_dir.clone(),
            hls_cache_dir: cache_dir.join("hls"),
            local_torrent_cache_dir: cache_dir.join("local-torrents"),
            upload_temp_dir: cache_dir.join("uploads"),
            local_library_path: assets_dir.join("library.json"),
            persistent_cache_db_path: cache_dir.join("cache.sqlite"),
            persistent_users_db_path: cache_dir.join("users.sqlite"),
            host: "127.0.0.1".to_owned(),
            port: 5173,
            max_upload_bytes: 1,
            tmdb_api_key: String::new(),
            torrentio_base_url: String::new(),
            torznab_api_url: String::new(),
            torznab_api_key: String::new(),
            torznab_movie_categories: vec!["2000".to_owned(), "2040".to_owned(), "2045".to_owned()],
            torznab_tv_categories: vec!["5000".to_owned(), "5040".to_owned(), "5045".to_owned()],
            torznab_limit: 50,
            torznab_timeout_ms: 15_000,
            remux_video_mode: "auto".to_owned(),
            remux_max_concurrent: 2,
            remux_queue_timeout_ms: 2_000,
            remux_process_timeout_seconds: 4 * 60 * 60,
            export_max_concurrent: 2,
            export_queue_timeout_ms: 5_000,
            export_process_timeout_seconds: 6 * 60 * 60,
            resolver_max_concurrent: 2,
            resolver_queue_timeout_ms: 3_000,
            sports_resolver_max_concurrent: 2,
            sports_resolver_queue_timeout_ms: 3_000,
            local_torrent_max_bytes: 80 * 1024 * 1024 * 1024,
            local_torrent_metadata_timeout_ms: 45_000,
            local_torrent_ready_timeout_ms: 90_000,
            hls_max_transcode_jobs: 1,
            hls_max_segment_renders: 2,
            hls_segment_queue_timeout_ms: 2_000,
            hls_hwaccel_mode: "none".to_owned(),
            remux_hwaccel_mode: "none".to_owned(),
            auto_audio_sync_enabled: false,
            playback_sessions_enabled: false,
            opensubtitles_api_key: String::new(),
            opensubtitles_user_agent: String::new(),
            session_cookie_secure: true,
            open_signup_enabled: false,
            signup_invite_code: String::new(),
            live_hls_proxy_secret: "test-live-hls-proxy-secret-with-enough-length".to_owned(),
            live_hls_resource_worker_base: String::new(),
            app_origin: "https://streamarena.xyz".to_owned(),
            email_from: "noreply@streamarena.xyz".to_owned(),
            cf_account_id: String::new(),
            cf_email_api_token: String::new(),
        }
    }

    #[test]
    fn keeps_only_allowed_external_subtitle_hosts() {
        assert!(is_allowed_external_subtitle_download_url(
            "https://dl.opensubtitles.org/en/download/file.gz"
        ));
        assert!(is_allowed_external_subtitle_download_url(
            "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/26958"
        ));
        assert!(!is_allowed_external_subtitle_download_url(
            "http://dl.opensubtitles.org/en/download/file.gz"
        ));
        assert!(!is_allowed_external_subtitle_download_url(
            "https://example.com/subtitle.srt"
        ));
        assert!(!is_allowed_external_subtitle_download_url(
            "https://subs5.strem.io.example.com/file/26958"
        ));
    }

    #[test]
    fn builds_stremio_subtitle_tracks_grouped_by_language() {
        let payload = serde_json::json!({
            "subtitles": [
                {"id": "101", "url": "https://subs5.strem.io/file/101", "lang": "spa"},
                {"id": "102", "url": "https://subs5.strem.io/file/102", "lang": "eng"},
                {"id": "103", "url": "https://subs5.strem.io/file/103", "lang": "eng"},
                {"id": "104", "url": "https://subs5.strem.io/file/104", "lang": "eng"},
                {"id": "105", "url": "https://subs5.strem.io/file/105", "lang": "eng"},
                {"id": "106", "url": "https://subs5.strem.io/file/106", "lang": "pob"},
                {"id": "107", "url": "https://subs5.strem.io/file/107", "lang": "abk"},
                {"id": "108", "url": "https://evil.example.com/file/108", "lang": "eng"},
                {"id": "102", "url": "https://subs5.strem.io/file/102", "lang": "eng"},
                {"id": "109", "url": "https://subs5.strem.io/file/109", "lang": "gre"}
            ]
        });

        let tracks = build_stremio_subtitle_tracks_from_payload(&payload, "", &HashMap::new());

        // English is the implicit preference: first three eligible English
        // entries kept, preferred quota applied, off-host and unknown-language
        // entries dropped, duplicate ids deduped.
        let labels = tracks
            .iter()
            .map(|track| track.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                "English (OpenSubtitles)",
                "English (OpenSubtitles) 2",
                "English (OpenSubtitles) 3",
                "Spanish (OpenSubtitles)",
                "Portuguese (OpenSubtitles)",
                "Greek (OpenSubtitles)",
            ]
        );
        assert!(
            tracks
                .iter()
                .all(|track| track.isExternal && track.isTextBased)
        );
        assert_eq!(tracks[0].streamIndex, 3_000_000_000 + 102);
        assert_eq!(
            tracks[0].vttUrl,
            "/api/subtitles.external.vtt?download=https%3A%2F%2Fsubs5.strem.io%2Ffile%2F102"
        );
        assert_eq!(tracks[3].language, "es");

        // Explicit non-English preference reorders that language first and
        // keeps English as a capped fallback.
        let spanish_first =
            build_stremio_subtitle_tracks_from_payload(&payload, "es", &HashMap::new());
        assert_eq!(spanish_first[0].language, "es");
        assert_eq!(
            spanish_first
                .iter()
                .filter(|track| track.language == "en")
                .count(),
            2
        );
    }

    #[test]
    fn ranks_english_translation_above_phonetic_fantasy_dialogue() {
        let payload = serde_json::json!({
            "subtitles": [
                {"id": "201", "url": "https://subs5.strem.io/file/201", "lang": "eng"},
                {"id": "202", "url": "https://subs5.strem.io/file/202", "lang": "eng"},
                {"id": "203", "url": "https://subs5.strem.io/file/203", "lang": "eng"},
                {"id": "204", "url": "https://subs5.strem.io/file/204", "lang": "eng"}
            ]
        });
        let phonetic = analyze_english_subtitle_content(
            "1\n00:40:52,731 --> 00:40:57,401\n<i>Ajjalan anha zalat\nvitiherat yer hatif.</i>\n",
        )
        .expect("phonetic content");
        let translated = analyze_english_subtitle_content(
            "1\n00:40:55,745 --> 00:40:58,705\nTonight I would look upon your face!\n",
        )
        .expect("translated content");

        let contents = HashMap::from([
            (201, phonetic.clone()),
            (202, phonetic.clone()),
            (203, phonetic),
            (204, translated),
        ]);
        let qualities = build_english_subtitle_qualities(&contents);
        assert!(
            qualities[&201].untranslated_dialogue_cues > qualities[&204].untranslated_dialogue_cues
        );
        let tracks = build_stremio_subtitle_tracks_from_payload(&payload, "en", &qualities);

        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].streamIndex, 3_000_000_000 + 204);
        assert_eq!(tracks[0].label, "English Translated (OpenSubtitles)");
        assert!(
            tracks
                .iter()
                .all(|track| track.streamIndex != 3_000_000_000 + 203)
        );
    }

    #[test]
    fn recognizes_explicit_english_gloss_after_fantasy_dialogue() {
        let phonetic = analyze_english_subtitle_content(
            "1\n00:36:05,282 --> 00:36:07,818\nAnnakhas dozgosores.\n",
        )
        .expect("phonetic content");
        let translated = analyze_english_subtitle_content(
            "1\n00:36:05,999 --> 00:36:08,418\n[Jorah speaks Dothraki] {Annakhas dozgosores}\n- Stop the horde\n",
        )
        .expect("translated content");
        let qualities =
            build_english_subtitle_qualities(&HashMap::from([(301, phonetic), (302, translated)]));
        let phonetic = qualities[&301];
        let translated = qualities[&302];

        assert_eq!(translated.translated_dialogue_cues, 1);
        assert_eq!(translated.untranslated_dialogue_cues, 0);
        assert!(translated.translated_dialogue_cues > phonetic.translated_dialogue_cues);
    }

    #[test]
    fn ignores_ordinary_speaking_annotations_as_translation_evidence() {
        let english_annotation = analyze_english_subtitle_content(
            "1\n00:10:00,000 --> 00:10:02,000\n(Speaks English) We should go now.\n",
        )
        .expect("English annotation content");
        let action_annotation = analyze_english_subtitle_content(
            "1\n00:11:00,000 --> 00:11:02,000\n[John speaks softly] We should go.\n",
        )
        .expect("action annotation content");
        let qualities = build_english_subtitle_qualities(&HashMap::from([
            (351, english_annotation),
            (352, action_annotation),
        ]));

        assert_eq!(qualities[&351].translated_dialogue_cues, 0);
        assert_eq!(qualities[&352].translated_dialogue_cues, 0);
    }

    #[test]
    fn prefers_forced_translation_when_full_tracks_are_phonetic() {
        let payload = serde_json::json!({
            "subtitles": [
                {"id": "701", "url": "https://subs5.strem.io/file/701", "lang": "eng"},
                {"id": "702", "url": "https://subs5.strem.io/file/702", "lang": "eng"},
                {"id": "703", "url": "https://subs5.strem.io/file/703", "lang": "eng"},
                {"id": "704", "url": "https://subs5.strem.io/file/704", "lang": "eng"}
            ]
        });
        let full_phonetic = analyze_english_subtitle_content(
            "1\n00:10:00,000 --> 00:10:03,000\n<i>Ajjalan anha zalat vitiherat yer hatif.</i>\n\n2\n00:20:00,000 --> 00:20:02,000\nWe should go now.\n\n3\n00:30:00,000 --> 00:30:02,000\nThis is the place.\n\n4\n00:40:00,000 --> 00:40:02,000\nTell me what happened.\n",
        )
        .expect("full phonetic content");
        let forced_translation = analyze_english_subtitle_content(
            "1\n00:10:00,000 --> 00:10:03,000\nTonight I would look upon your face!\n",
        )
        .expect("forced translation content");
        let qualities = build_english_subtitle_qualities(&HashMap::from([
            (701, full_phonetic.clone()),
            (702, full_phonetic.clone()),
            (703, full_phonetic),
            (704, forced_translation),
        ]));
        let tracks = build_stremio_subtitle_tracks_from_payload(&payload, "en", &qualities);

        assert_eq!(tracks[0].streamIndex, 3_000_000_000 + 704);
        assert_eq!(tracks[0].label, "English Translated Forced (OpenSubtitles)");
    }

    #[test]
    fn translation_label_requires_more_translated_than_phonetic_cues() {
        let payload = serde_json::json!({
            "subtitles": [
                {"id": "801", "url": "https://subs5.strem.io/file/801", "lang": "eng"}
            ]
        });
        let qualities = HashMap::from([(
            801,
            super::EnglishSubtitleQuality {
                translated_dialogue_cues: 1,
                untranslated_dialogue_cues: 2,
                cue_count: 100,
            },
        )]);
        let tracks = build_stremio_subtitle_tracks_from_payload(&payload, "en", &qualities);

        assert!(!tracks[0].label.contains("Translated"));
    }

    #[test]
    fn does_not_treat_omitted_fantasy_dialogue_as_a_translation() {
        let phonetic = analyze_english_subtitle_content(
            "1\n00:40:52,731 --> 00:40:57,401\n<i>Ajjalan anha zalat\nvitiherat yer hatif.</i>\n",
        )
        .expect("phonetic content");
        let omitted = analyze_english_subtitle_content(
            "1\n00:39:00,000 --> 00:39:02,000\nThe camp is quiet.\n\n2\n00:42:00,000 --> 00:42:02,000\nWe should go.\n",
        )
        .expect("omitted-dialogue content");
        let translated = analyze_english_subtitle_content(
            "1\n00:39:00,000 --> 00:39:02,000\nThe camp is quiet.\n\n2\n00:40:55,745 --> 00:40:58,705\nTonight I would look upon your face!\n\n3\n00:42:00,000 --> 00:42:02,000\nWe should go.\n",
        )
        .expect("translated content");
        let qualities = build_english_subtitle_qualities(&HashMap::from([
            (401, phonetic),
            (402, omitted),
            (403, translated),
        ]));

        assert_eq!(qualities[&402].translated_dialogue_cues, 0);
        assert_eq!(qualities[&403].translated_dialogue_cues, 1);

        let omission_only_payload = serde_json::json!({
            "subtitles": [
                {"id": "401", "url": "https://subs5.strem.io/file/401", "lang": "eng"},
                {"id": "402", "url": "https://subs5.strem.io/file/402", "lang": "eng"}
            ]
        });
        let omission_tracks =
            build_stremio_subtitle_tracks_from_payload(&omission_only_payload, "en", &qualities);
        assert!(
            omission_tracks
                .iter()
                .all(|track| !track.label.contains("Translated"))
        );
    }

    #[test]
    fn does_not_treat_ordinary_italic_english_as_fantasy_dialogue() {
        let italic = analyze_english_subtitle_content(
            "1\n00:10:00,000 --> 00:10:02,000\n<i>Winter is coming.</i>\n",
        )
        .expect("italic English content");
        let plain = analyze_english_subtitle_content(
            "1\n00:10:00,000 --> 00:10:02,000\nWinter is coming.\n",
        )
        .expect("plain English content");
        let qualities =
            build_english_subtitle_qualities(&HashMap::from([(501, italic), (502, plain)]));

        assert_eq!(qualities[&501].translated_dialogue_cues, 0);
        assert_eq!(qualities[&501].untranslated_dialogue_cues, 0);
        assert_eq!(qualities[&502].translated_dialogue_cues, 0);
        assert_eq!(qualities[&502].untranslated_dialogue_cues, 0);
    }

    #[test]
    fn does_not_compare_subtitle_releases_with_incompatible_timing() {
        let shifted_english = analyze_english_subtitle_content(
            "1\n00:00:10,000 --> 00:00:12,000\nWe should go now.\n\n2\n00:00:20,000 --> 00:00:22,000\nThis is the place.\n\n3\n00:00:30,000 --> 00:00:32,000\nTell me what happened.\n\n4\n00:00:40,000 --> 00:00:43,000\nTonight I would look upon your face!\n",
        )
        .expect("shifted English content");
        let differently_timed_phonetic = analyze_english_subtitle_content(
            "1\n00:00:40,000 --> 00:00:43,000\n<i>Ajjalan anha zalat vitiherat yer hatif.</i>\n\n2\n00:01:40,000 --> 00:01:42,000\nWe should go now.\n\n3\n00:01:50,000 --> 00:01:52,000\nThis is the place.\n\n4\n00:02:00,000 --> 00:02:02,000\nTell me what happened.\n",
        )
        .expect("differently timed phonetic content");
        let qualities = build_english_subtitle_qualities(&HashMap::from([
            (601, shifted_english),
            (602, differently_timed_phonetic),
        ]));

        assert_eq!(qualities[&601].translated_dialogue_cues, 0);
        assert_eq!(qualities[&602].untranslated_dialogue_cues, 0);
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
    fn canonical_path_check_rejects_traversal_outside_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let temp_dir = std::env::temp_dir();
        let root = temp_dir.join(format!("streamarena-media-root-{unique}"));
        let outside = temp_dir.join(format!("streamarena-media-outside-{unique}"));
        fs::create_dir_all(&root).expect("root dir");
        fs::create_dir_all(&outside).expect("outside dir");
        let inside_file = root.join("video.mp4");
        let outside_file = outside.join("secret.mp4");
        fs::write(&inside_file, b"inside").expect("inside file");
        fs::write(&outside_file, b"outside").expect("outside file");

        assert!(is_path_inside_root_dir(
            &root,
            inside_file.to_str().expect("inside path")
        ));

        let traversal = root
            .join("..")
            .join(outside.file_name().expect("outside name"))
            .join("secret.mp4");
        assert!(!is_path_inside_root_dir(
            &root,
            traversal.to_str().expect("traversal path")
        ));

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn local_media_paths_are_limited_to_media_roots() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("streamarena-media-allowed-{unique}"));
        let videos_dir = root.join("assets").join("videos");
        fs::create_dir_all(&videos_dir).expect("videos dir");
        fs::write(videos_dir.join("movie.mp4"), b"movie").expect("movie file");
        fs::write(root.join("Cargo.toml"), b"secret").expect("non-media file");
        let config = test_config(root.clone());

        assert_eq!(
            resolve_local_media_path(&config, "/assets/videos/movie.mp4"),
            Some(videos_dir.join("movie.mp4"))
        );
        assert!(resolve_local_media_path(&config, "/Cargo.toml").is_none());
        assert!(resolve_local_media_path(&config, "/assets/videos/../Cargo.toml").is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detects_local_app_playback_urls() {
        let config = crate::config::Config {
            root_dir: std::env::temp_dir(),
            frontend_dir: std::env::temp_dir(),
            assets_dir: std::env::temp_dir(),
            cache_dir: std::env::temp_dir(),
            hls_cache_dir: std::env::temp_dir(),
            local_torrent_cache_dir: std::env::temp_dir().join("local-torrents"),
            upload_temp_dir: std::env::temp_dir(),
            local_library_path: std::env::temp_dir().join("library.json"),
            persistent_cache_db_path: std::env::temp_dir().join("cache.sqlite"),
            persistent_users_db_path: std::env::temp_dir().join("users.sqlite"),
            host: "127.0.0.1".to_owned(),
            port: 5173,
            max_upload_bytes: 1,
            tmdb_api_key: String::new(),
            torrentio_base_url: String::new(),
            torznab_api_url: String::new(),
            torznab_api_key: String::new(),
            torznab_movie_categories: vec!["2000".to_owned(), "2040".to_owned(), "2045".to_owned()],
            torznab_tv_categories: vec!["5000".to_owned(), "5040".to_owned(), "5045".to_owned()],
            torznab_limit: 50,
            torznab_timeout_ms: 15_000,
            remux_video_mode: "auto".to_owned(),
            remux_max_concurrent: 2,
            remux_queue_timeout_ms: 2_000,
            remux_process_timeout_seconds: 4 * 60 * 60,
            export_max_concurrent: 2,
            export_queue_timeout_ms: 5_000,
            export_process_timeout_seconds: 6 * 60 * 60,
            resolver_max_concurrent: 2,
            resolver_queue_timeout_ms: 3_000,
            sports_resolver_max_concurrent: 2,
            sports_resolver_queue_timeout_ms: 3_000,
            local_torrent_max_bytes: 80 * 1024 * 1024 * 1024,
            local_torrent_metadata_timeout_ms: 45_000,
            local_torrent_ready_timeout_ms: 90_000,
            hls_max_transcode_jobs: 1,
            hls_max_segment_renders: 2,
            hls_segment_queue_timeout_ms: 2_000,
            hls_hwaccel_mode: "none".to_owned(),
            remux_hwaccel_mode: "none".to_owned(),
            auto_audio_sync_enabled: false,
            playback_sessions_enabled: false,
            opensubtitles_api_key: String::new(),
            opensubtitles_user_agent: String::new(),
            session_cookie_secure: true,
            open_signup_enabled: false,
            signup_invite_code: String::new(),
            live_hls_proxy_secret: "test-live-hls-proxy-secret-with-enough-length".to_owned(),
            live_hls_resource_worker_base: String::new(),
            app_origin: "https://streamarena.xyz".to_owned(),
            email_from: "noreply@streamarena.xyz".to_owned(),
            cf_account_id: String::new(),
            cf_email_api_token: String::new(),
        };
        assert!(is_local_app_playback_url(
            &config,
            &Url::parse("http://127.0.0.1:5173/assets/videos/test.mp4").expect("local url")
        ));
        assert!(!is_local_app_playback_url(
            &config,
            &Url::parse("https://download.real-debrid.com/video.mp4").expect("rd url")
        ));
        assert!(is_local_torrent_stream_input(
            "/api/local-torrent/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=0"
        ));
        assert!(is_local_cache_stream_input(
            "/api/local-cache/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=1"
        ));
        assert!(is_local_torrent_stream_url(
            &Url::parse("http://127.0.0.1:5173/api/local-torrent/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=0")
                .expect("local torrent url")
        ));
        assert!(is_local_cache_stream_url(
            &Url::parse("http://127.0.0.1:5173/api/local-cache/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=1")
                .expect("local cache url")
        ));
        let cached_file = config
            .local_torrent_cache_dir
            .join("0123456789abcdef0123456789abcdef01234567")
            .join("direct")
            .join("1")
            .join("Movie.mkv");
        std::fs::create_dir_all(cached_file.parent().expect("cache parent")).expect("cache dir");
        std::fs::write(&cached_file, b"movie").expect("cache file");
        assert_eq!(
            local_cache_stream_file_path(
                &config,
                "/api/local-cache/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=1"
            ),
            Some(cached_file)
        );
        assert!(!is_local_torrent_stream_url(
            &Url::parse("http://127.0.0.1:5173/api/remux?input=x").expect("remux url")
        ));
    }
}
