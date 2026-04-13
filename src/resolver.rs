use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::time::sleep;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::utils::now_ms;
use crate::media::{
    MediaProbe, MediaService, choose_audio_track_from_probe, choose_subtitle_track_from_probe,
    merge_preferred_subtitle_tracks,
};
use crate::persistence::{Db, PersistPlaybackSessionInput, PlaybackSession, SourceHealthStats};
use crate::routes::{
    normalize_preferred_audio_lang, normalize_preferred_stream_quality,
    normalize_subtitle_preference,
};
use crate::tmdb::TmdbService;

const REAL_DEBRID_API_BASE: &str = "https://api.real-debrid.com/rest/1.0";
const SOURCE_LANGUAGE_FILTER_DEFAULT: &str = "en";
const SOURCE_AUDIO_PROFILE_DEFAULT: &str = "single";
const RESOLVE_MAX_MS: i64 = 90_000;
const PLAYABLE_URL_VALIDATE_TIMEOUT_MS: u64 = 8_000;
const TORRENTIO_REQUEST_TIMEOUT_MS: u64 = 65_000;
const TORRENTIO_REQUEST_MAX_ATTEMPTS: usize = 2;
const TORRENTIO_REQUEST_RETRY_DELAY_MS: u64 = 1_200;
const TORRENTIO_RETRY_MAX_ELAPSED_MS: i64 = 25_000;
const TORRENTIO_CACHE_MAX_AGE_DEFAULT_SECONDS: i64 = 60 * 60;
const TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS: i64 = 4 * 60 * 60;
const RD_TORRENT_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const EXTERNAL_SUBTITLE_STREAM_INDEX_BASE: i64 = 2_000_000;
const DEFAULT_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://explodie.org:6969/announce",
];
const TORRENT_FATAL_STATUSES: &[&str] =
    &["error", "magnet_error", "virus", "dead", "invalid_magnet"];
const BROWSER_SAFE_AUDIO_CODECS: &[&str] = &["aac", "mp3", "mp2", "opus", "vorbis", "flac", "alac"];
const BROWSER_UNSAFE_AUDIO_CODEC_PREFIXES: &[&str] =
    &["ac3", "eac3", "dts", "dca", "truehd", "mlp", "pcm_", "wma"];
const DEFAULT_ALLOWED_SOURCE_FORMATS: &[&str] = &["mp4"];

static SEED_COUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*([0-9.,]+)").expect("valid seed regex"));
static STREAM_SIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"💾\s*([^\n⚙👤]+)").expect("valid stream size regex"));
static STREAM_RELEASE_GROUP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"⚙\s*([^\n👤]+)").expect("valid release group regex"));
static HXH_SEASON_EPISODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bs(?:eason\s*)?0*(\d{1,2})\s*[-_. ]?e(?:pisode\s*)?0*(\d{1,3})\b")
        .expect("valid episode regex")
});
static X_SEASON_EPISODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b0*(\d{1,2})x0*(\d{1,3})\b").expect("valid x episode regex"));
static EPISODE_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:e|ep|episode)\s*[-_. ]?0*(\d{1,3})\b").expect("valid episode-only regex")
});
static HMS_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b").expect("valid hms runtime regex")
});
static HOURS_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)\s*h(?:ours?)?\b").expect("valid hours runtime regex")
});
static MINUTES_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\b").expect("valid minutes runtime regex")
});
static COMPACT_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2})h(?:\s*|)(\d{1,2})m\b").expect("valid compact runtime regex")
});
static LOW_QUALITY_THEATRICAL_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:hdts|telesync|ts|telecine|tc|hdcam|camrip|cam)\b")
        .expect("valid low quality theatrical release regex")
});
static LOW_QUALITY_SCREENER_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:dvdscr|dvdscreener|screener|workprint)\b")
        .expect("valid low quality screener release regex")
});
static MULTI_AUDIO_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:multiaudio|dualaudio|multidub(?:bed)?|dualdub(?:bed)?|multilang(?:uage)?s?|duallang(?:uage)?s?|multiple\s+(?:audio|dub(?:bed)?|lang(?:uage)?s?)|multi\s+(?:audio|dub(?:bed)?|lang(?:uage)?s?)|dual\s+(?:audio|dub(?:bed)?|lang(?:uage)?s?)|(?:2|3|4)\s*(?:audio|dub(?:bed)?|lang(?:uage)?s?))\b",
    )
    .expect("valid multi audio release regex")
});

#[derive(Clone)]
pub struct ResolverService {
    config: Config,
    db: Db,
    client: reqwest::Client,
    tmdb: TmdbService,
    media: MediaService,
}

#[derive(Debug, Clone)]
struct ResolveMetadata {
    tmdb_id: String,
    imdb_id: String,
    display_title: String,
    display_year: String,
    runtime_seconds: i64,
    season_number: i64,
    episode_number: i64,
    episode_title: String,
    media_type: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Deserialize)]
struct TorrentioStream {
    #[serde(default)]
    infoHash: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    behaviorHints: TorrentioBehaviorHints,
    #[serde(default)]
    sources: Vec<String>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Deserialize)]
struct TorrentioBehaviorHints {
    #[serde(default)]
    filename: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
struct SourceSummary {
    sourceHash: String,
    infoHash: String,
    provider: String,
    primary: String,
    filename: String,
    qualityLabel: String,
    container: String,
    seeders: i64,
    size: String,
    releaseGroup: String,
    score: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ResolvedSource {
    #[serde(rename = "playableUrl")]
    playable_url: String,
    #[serde(rename = "fallbackUrls")]
    fallback_urls: Vec<String>,
    filename: String,
    #[serde(rename = "sourceHash")]
    source_hash: String,
    #[serde(rename = "selectedFile")]
    selected_file: String,
    #[serde(rename = "selectedFilePath")]
    selected_file_path: String,
}

#[derive(Debug, Clone)]
struct ResolvePreferences {
    audio_lang: String,
    subtitle_lang: String,
    quality: String,
}

#[derive(Debug, Clone)]
struct ResolveFilters {
    source_hash: String,
    source_filters: SourceFilters,
}

impl ResolverService {
    pub fn new(
        config: Config,
        db: Db,
        client: reqwest::Client,
        tmdb: TmdbService,
        media: MediaService,
    ) -> Self {
        Self {
            config,
            db,
            client,
            tmdb,
            media,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn list_sources(
        &self,
        tmdb_id: &str,
        media_type: &str,
        title_fallback: &str,
        year_fallback: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_container: &str,
        source_hash: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
        limit: &str,
        season_number: &str,
        season_alias: &str,
        episode_number: &str,
        episode_alias: &str,
    ) -> AppResult<Value> {
        let normalized_audio_lang = normalize_preferred_audio_lang(preferred_audio_lang);
        let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
        let normalized_container = normalize_preferred_container(preferred_container);
        let normalized_source_hash = normalize_source_hash(source_hash);
        let normalized_limit = limit.trim().parse::<i64>().ok().unwrap_or(10).clamp(1, 20);
        let source_filters = SourceFilters {
            min_seeders: normalize_minimum_seeders(min_seeders),
            allowed_formats: normalize_allowed_formats(allowed_formats),
            source_language: normalize_source_language_filter(source_language),
            source_audio_profile: normalize_source_audio_profile_filter(source_audio_profile),
        };

        if media_type == "tv" {
            let season_number = normalize_episode_ordinal(
                if season_number.trim().is_empty() {
                    season_alias
                } else {
                    season_number
                },
                1,
            );
            let episode_number = normalize_episode_ordinal(
                if episode_number.trim().is_empty() {
                    episode_alias
                } else {
                    episode_number
                },
                1,
            );
            let metadata = self
                .fetch_tv_episode_metadata(
                    tmdb_id,
                    title_fallback,
                    year_fallback,
                    season_number,
                    episode_number,
                )
                .await?;
            let streams = self
                .fetch_torrentio_episode_streams(
                    &metadata.imdb_id,
                    metadata.season_number,
                    metadata.episode_number,
                )
                .await?;
            let health_scores = self.compute_source_health_scores(&streams).await?;
            let candidates = select_top_episode_candidates(
                &streams,
                &metadata,
                &normalized_audio_lang,
                &normalized_quality,
                &normalized_container,
                &normalized_source_hash,
                normalized_limit as usize,
                &source_filters,
                &health_scores,
            );
            let sources = candidates
                .iter()
                .filter_map(|candidate| {
                    summarize_stream_candidate_for_client(
                        candidate,
                        &metadata,
                        &normalized_audio_lang,
                        &normalized_quality,
                        &source_filters,
                        &health_scores,
                    )
                })
                .collect::<Vec<_>>();
            return Ok(json!({
                "mediaType": "tv",
                "tmdbId": tmdb_id.trim(),
                "seasonNumber": metadata.season_number,
                "episodeNumber": metadata.episode_number,
                "sources": sources
            }));
        }

        let metadata = self
            .fetch_movie_metadata(tmdb_id, title_fallback, year_fallback)
            .await?;
        let streams = self
            .fetch_torrentio_movie_streams(&metadata.imdb_id)
            .await?;
        let health_scores = self.compute_source_health_scores(&streams).await?;
        let candidates = select_top_movie_candidates(
            &streams,
            &metadata,
            &normalized_audio_lang,
            &normalized_quality,
            &normalized_source_hash,
            normalized_limit as usize,
            &source_filters,
            &health_scores,
        );
        let sources = candidates
            .iter()
            .filter_map(|candidate| {
                summarize_stream_candidate_for_client(
                    candidate,
                    &metadata,
                    &normalized_audio_lang,
                    &normalized_quality,
                    &source_filters,
                    &health_scores,
                )
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "mediaType": "movie",
            "tmdbId": tmdb_id.trim(),
            "sources": sources
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn resolve_movie(
        &self,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_subtitle_lang: &str,
        source_hash: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
    ) -> AppResult<Value> {
        let stored_preference = self
            .db
            .get_title_preference(tmdb_id.trim().to_owned())
            .await?;
        let effective_audio_lang = self
            .resolve_effective_preferred_audio_lang(
                tmdb_id,
                stored_preference
                    .as_ref()
                    .map(|value| value.audioLang.as_str())
                    .unwrap_or_default(),
                preferred_audio_lang,
            )
            .await?;
        let preferences = ResolvePreferences {
            audio_lang: effective_audio_lang.clone(),
            subtitle_lang: resolve_effective_preferred_subtitle_lang(
                stored_preference
                    .as_ref()
                    .map(|value| value.subtitleLang.as_str())
                    .unwrap_or_default(),
                preferred_subtitle_lang,
            ),
            quality: normalize_preferred_stream_quality(preferred_quality),
        };
        let filters = ResolveFilters {
            source_hash: normalize_source_hash(source_hash),
            source_filters: SourceFilters {
                min_seeders: normalize_minimum_seeders(min_seeders),
                allowed_formats: normalize_allowed_formats(allowed_formats),
                source_language: normalize_source_language_filter(source_language),
                source_audio_profile: normalize_source_audio_profile_filter(source_audio_profile),
            },
        };
        let metadata = self
            .fetch_movie_metadata(tmdb_id, title_fallback, year_fallback)
            .await?;
        if let Some(reused) = self
            .try_reuse_playback_session(&metadata, &preferences, &filters)
            .await?
        {
            return Ok(reused);
        }
        let streams = self
            .fetch_torrentio_movie_streams(&metadata.imdb_id)
            .await?;
        let health_scores = self.compute_source_health_scores(&streams).await?;
        let candidates = select_top_movie_candidates(
            &streams,
            &metadata,
            &preferences.audio_lang,
            &preferences.quality,
            &filters.source_hash,
            10,
            &filters.source_filters,
            &health_scores,
        );
        if candidates.is_empty() {
            return Err(ApiError::internal(
                "No stream candidates were returned for this movie.",
            ));
        }

        let resolution_started_at = now_ms();
        let mut last_error = None;
        for candidate in candidates {
            if now_ms() - resolution_started_at > RESOLVE_MAX_MS {
                break;
            }
            let fallback_name = normalize_whitespace(
                format!("{} {}", metadata.display_title, metadata.display_year).trim(),
            );
            match self
                .resolve_candidate_stream(candidate, &fallback_name)
                .await
                .and_then(|resolved| {
                    if !does_filename_likely_match_movie(
                        &resolved.filename,
                        &metadata.display_title,
                        &metadata.display_year,
                    ) {
                        return Err(ApiError::internal(
                            "Resolved stream filename did not match requested title.",
                        ));
                    }
                    Ok(resolved)
                }) {
                Ok(resolved) => {
                    return self
                        .build_resolved_response(resolved, metadata, preferences, true)
                        .await;
                }
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn resolve_tv(
        &self,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        season_number: &str,
        season_alias: &str,
        episode_number: &str,
        episode_alias: &str,
        preferred_audio_lang: &str,
        preferred_quality: &str,
        preferred_subtitle_lang: &str,
        preferred_container: &str,
        source_hash: &str,
        min_seeders: &str,
        allowed_formats: &str,
        source_language: &str,
        source_audio_profile: &str,
    ) -> AppResult<Value> {
        let stored_preference = self
            .db
            .get_title_preference(tmdb_id.trim().to_owned())
            .await?;
        let preferences = ResolvePreferences {
            audio_lang: self
                .resolve_effective_preferred_audio_lang(
                    tmdb_id,
                    stored_preference
                        .as_ref()
                        .map(|value| value.audioLang.as_str())
                        .unwrap_or_default(),
                    preferred_audio_lang,
                )
                .await?,
            subtitle_lang: resolve_effective_preferred_subtitle_lang(
                stored_preference
                    .as_ref()
                    .map(|value| value.subtitleLang.as_str())
                    .unwrap_or_default(),
                preferred_subtitle_lang,
            ),
            quality: normalize_preferred_stream_quality(preferred_quality),
        };
        let filters = ResolveFilters {
            source_hash: normalize_source_hash(source_hash),
            source_filters: SourceFilters {
                min_seeders: normalize_minimum_seeders(min_seeders),
                allowed_formats: normalize_allowed_formats(allowed_formats),
                source_language: normalize_source_language_filter(source_language),
                source_audio_profile: normalize_source_audio_profile_filter(source_audio_profile),
            },
        };
        let season_number = normalize_episode_ordinal(
            if season_number.trim().is_empty() {
                season_alias
            } else {
                season_number
            },
            1,
        );
        let episode_number = normalize_episode_ordinal(
            if episode_number.trim().is_empty() {
                episode_alias
            } else {
                episode_number
            },
            1,
        );
        let metadata = self
            .fetch_tv_episode_metadata(
                tmdb_id,
                title_fallback,
                year_fallback,
                season_number,
                episode_number,
            )
            .await?;
        if let Some(reused) = self
            .try_reuse_playback_session(&metadata, &preferences, &filters)
            .await?
        {
            return Ok(reused);
        }
        let streams = self
            .fetch_torrentio_episode_streams(
                &metadata.imdb_id,
                metadata.season_number,
                metadata.episode_number,
            )
            .await?;
        let health_scores = self.compute_source_health_scores(&streams).await?;
        let candidates = select_top_episode_candidates(
            &streams,
            &metadata,
            &preferences.audio_lang,
            &preferences.quality,
            preferred_container,
            &filters.source_hash,
            10,
            &filters.source_filters,
            &health_scores,
        );
        if candidates.is_empty() {
            return Err(ApiError::internal(
                "No stream candidates were returned for this episode.",
            ));
        }

        let resolution_started_at = now_ms();
        let mut last_error = None;
        for candidate in candidates {
            if now_ms() - resolution_started_at > RESOLVE_MAX_MS {
                break;
            }
            let fallback_name = if metadata.episode_title.is_empty() {
                format!(
                    "{} S{:02}E{:02}",
                    metadata.display_title, metadata.season_number, metadata.episode_number
                )
            } else {
                format!(
                    "{} S{:02}E{:02} {}",
                    metadata.display_title,
                    metadata.season_number,
                    metadata.episode_number,
                    metadata.episode_title
                )
            };
            match self
                .resolve_candidate_stream(candidate, &fallback_name)
                .await
                .and_then(|resolved| {
                    let episode_match_name = if !resolved.selected_file_path.trim().is_empty() {
                        resolved.selected_file_path.clone()
                    } else {
                        resolved.filename.clone()
                    };
                    if !does_filename_likely_match_tv_episode(
                        &episode_match_name,
                        &metadata.display_title,
                        &metadata.display_year,
                        metadata.season_number,
                        metadata.episode_number,
                    ) {
                        return Err(ApiError::internal(
                            "Resolved stream filename did not match requested episode.",
                        ));
                    }
                    Ok(resolved)
                }) {
                Ok(resolved) => {
                    return self
                        .build_resolved_response(resolved, metadata, preferences, true)
                        .await;
                }
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("All stream candidates failed.")))
    }

    async fn build_resolved_response(
        &self,
        resolved: ResolvedSource,
        metadata: ResolveMetadata,
        preferences: ResolvePreferences,
        include_session: bool,
    ) -> AppResult<Value> {
        let source_input = extract_playable_source_input(&resolved.playable_url);
        let tracks = match self.media.probe_media_tracks(&source_input).await {
            Ok(probe) => probe,
            Err(_) => MediaProbe {
                durationSeconds: metadata.runtime_seconds,
                ..MediaProbe::default()
            },
        };
        let mut tracks = tracks;
        let external_subtitle_tracks = self
            .media
            .search_opensubtitles_tracks(
                &metadata.imdb_id,
                &metadata.display_title,
                &metadata.display_year,
                &preferences.subtitle_lang,
                &resolved.filename,
            )
            .await;
        if !external_subtitle_tracks.is_empty() {
            tracks.subtitleTracks =
                merge_preferred_subtitle_tracks(external_subtitle_tracks, tracks.subtitleTracks);
        }
        let force_audio_stream_mapping = preferences.audio_lang != "auto";
        let preferred_audio_track = choose_audio_track_from_probe(&tracks, &preferences.audio_lang);
        let mut selected_audio_stream_index = if force_audio_stream_mapping {
            preferred_audio_track
                .as_ref()
                .map(|track| track.streamIndex)
                .unwrap_or(-1)
        } else {
            -1
        };
        let preferred_subtitle_track =
            choose_subtitle_track_from_probe(&tracks, &preferences.subtitle_lang);
        let selected_subtitle_stream_index = preferred_subtitle_track
            .as_ref()
            .map(|track| track.streamIndex)
            .unwrap_or(-1);
        if should_force_remux_for_audio_compatibility(&tracks, selected_audio_stream_index)
            && selected_audio_stream_index < 0
        {
            selected_audio_stream_index = preferred_audio_track
                .as_ref()
                .map(|track| track.streamIndex)
                .unwrap_or_else(|| get_fallback_audio_stream_index(&tracks));
        }
        let normalized = normalize_resolved_source_for_software_decode(
            &resolved,
            selected_audio_stream_index,
            selected_subtitle_stream_index,
        );

        let response_filename = if normalized.filename.is_empty() {
            resolved.filename.clone()
        } else {
            normalized.filename.clone()
        };
        let response_metadata =
            build_resolved_metadata_payload(&metadata, &resolved, &response_filename);
        let response_source_hash = resolved.source_hash.clone();
        let response_selected_file = resolved.selected_file.clone();
        let response_selected_file_path = resolved.selected_file_path.clone();
        let response_audio_lang = preferences.audio_lang.clone();
        let response_subtitle_lang = preferences.subtitle_lang.clone();
        let response_quality = preferences.quality.clone();
        let mut payload = json!({
            "playableUrl": normalized.playable_url.clone(),
            "fallbackUrls": normalized.fallback_urls.clone(),
            "filename": response_filename.clone(),
            "sourceHash": response_source_hash.clone(),
            "selectedFile": response_selected_file.clone(),
            "selectedFilePath": response_selected_file_path.clone(),
            "sourceInput": source_input,
            "tracks": tracks,
            "selectedAudioStreamIndex": selected_audio_stream_index,
            "selectedSubtitleStreamIndex": selected_subtitle_stream_index,
            "preferences": {
                "audioLang": response_audio_lang.clone(),
                "subtitleLang": response_subtitle_lang.clone(),
                "quality": response_quality.clone()
            },
            "metadata": response_metadata.clone()
        });
        if include_session {
            payload["session"] =
                if self.config.playback_sessions_enabled && !metadata.tmdb_id.is_empty() {
                    let session_key = build_playback_session_key(
                        &metadata.tmdb_id,
                        &response_audio_lang,
                        &response_quality,
                    );
                    self.db
                        .persist_playback_session(PersistPlaybackSessionInput {
                            session_key: session_key.clone(),
                            tmdb_id: metadata.tmdb_id.clone(),
                            audio_lang: response_audio_lang.clone(),
                            preferred_quality: response_quality.clone(),
                            source_hash: response_source_hash.clone(),
                            selected_file: response_selected_file.clone(),
                            filename: response_filename.clone(),
                            playable_url: normalized.playable_url.clone(),
                            fallback_urls: normalized.fallback_urls.clone(),
                            metadata: response_metadata.clone(),
                        })
                        .await?;
                    self.db
                        .get_playback_session(session_key.clone())
                        .await?
                        .map(|session| build_playback_session_payload(&session))
                        .unwrap_or_else(|| {
                            build_pending_playback_session_payload(
                                &session_key,
                                &response_source_hash,
                                &response_selected_file,
                                &response_quality,
                            )
                        })
                } else {
                    Value::Null
                };
        }
        Ok(payload)
    }

    async fn resolve_candidate_stream(
        &self,
        stream: &TorrentioStream,
        fallback_name: &str,
    ) -> AppResult<ResolvedSource> {
        let magnet = build_magnet_uri(stream, fallback_name)?;
        let info_hash = get_stream_info_hash(stream);
        if let Ok(Some(reusable_torrent_id)) =
            self.find_reusable_rd_torrent_by_hash(&info_hash).await
        {
            match self
                .resolve_from_torrent_id(&reusable_torrent_id, &info_hash, stream, fallback_name)
                .await
            {
                Ok(resolved) => {
                    let _ = self
                        .set_cached_rd_torrent_id(&info_hash, &reusable_torrent_id)
                        .await;
                    return Ok(resolved);
                }
                Err(_) => {
                    let _ = self.delete_cached_rd_torrent_id(&info_hash).await;
                }
            }
        }
        let add_magnet = self
            .rd_fetch_form(
                "/torrents/addMagnet",
                reqwest::Method::POST,
                &[("magnet", magnet.as_str())],
                12_000,
            )
            .await?;
        let torrent_id = stringify_json(add_magnet.get("id"));
        if torrent_id.is_empty() {
            return Err(ApiError::internal(
                "Real-Debrid did not return a torrent id.",
            ));
        }

        let result = self
            .resolve_from_torrent_id(&torrent_id, &info_hash, stream, fallback_name)
            .await;
        match result {
            Ok(resolved) => {
                let _ = self.set_cached_rd_torrent_id(&info_hash, &torrent_id).await;
                Ok(resolved)
            }
            Err(error) => {
                let _ = self.safe_delete_torrent(&torrent_id).await;
                let _ = self.delete_cached_rd_torrent_id(&info_hash).await;
                Err(error)
            }
        }
    }

    async fn resolve_from_torrent_id(
        &self,
        torrent_id: &str,
        info_hash: &str,
        stream: &TorrentioStream,
        fallback_name: &str,
    ) -> AppResult<ResolvedSource> {
        let info = self
            .rd_fetch_json(
                &format!("/torrents/info/{torrent_id}"),
                reqwest::Method::GET,
                12_000,
            )
            .await?;
        let files = info
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let file_ids = pick_video_file_ids(&files, &stream.behaviorHints.filename, fallback_name);
        if file_ids.is_empty() {
            return Err(ApiError::internal(
                "No supported video file was found in this torrent.",
            ));
        }
        let selected_file = file_ids[0].to_string();
        let selected_file_path = files
            .iter()
            .find(|file| file.get("id").and_then(Value::as_i64) == Some(file_ids[0]))
            .map(|file| stringify_json(file.get("path")))
            .unwrap_or_default();
        self.rd_fetch_form(
            &format!("/torrents/selectFiles/{torrent_id}"),
            reqwest::Method::POST,
            &[(
                "files",
                &file_ids
                    .iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            )],
            12_000,
        )
        .await?;

        let ready_info = self.wait_for_torrent_to_be_ready(torrent_id).await?;
        let download_links = ready_info
            .get("links")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        if download_links.is_empty() {
            return Err(ApiError::internal(
                "No Real-Debrid download link was generated.",
            ));
        }

        let mut filename = String::new();
        let mut verified_candidates = Vec::new();
        let mut uncertain_candidates = Vec::new();
        let mut last_error = None;
        for download_link in download_links {
            match self.resolve_playable_url_from_rd_link(&download_link).await {
                Ok((playable_urls, resolved_filename)) => {
                    if filename.is_empty() {
                        filename = resolved_filename.clone();
                    }
                    let filename_hint = if !filename.is_empty() {
                        filename.clone()
                    } else if !selected_file_path.is_empty() {
                        selected_file_path.clone()
                    } else {
                        resolved_filename
                    };
                    let mut ranked_urls = playable_urls
                        .into_iter()
                        .filter(|url| !url.trim().is_empty())
                        .collect::<Vec<_>>();
                    ranked_urls.sort_by(|left, right| {
                        let left_stable = left.contains("download.real-debrid.com");
                        let right_stable = right.contains("download.real-debrid.com");
                        right_stable.cmp(&left_stable)
                    });
                    if ranked_urls.is_empty()
                        && is_supported_resolved_container_path(&filename_hint)
                    {
                        last_error = Some(ApiError::internal(
                            "No playable Real-Debrid stream URL was available.",
                        ));
                    }
                    for playable_url in ranked_urls {
                        if verified_candidates.contains(&playable_url)
                            || uncertain_candidates.contains(&playable_url)
                        {
                            continue;
                        }
                        match self
                            .verify_playable_url(&playable_url, PLAYABLE_URL_VALIDATE_TIMEOUT_MS)
                            .await
                        {
                            Ok(PlayableUrlVerification::Verified) => {
                                verified_candidates.push(playable_url)
                            }
                            Ok(PlayableUrlVerification::Uncertain) => {
                                uncertain_candidates.push(playable_url)
                            }
                            Err(error) => last_error = Some(error),
                        }
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }

        let ranked_candidates = verified_candidates
            .into_iter()
            .chain(uncertain_candidates.into_iter())
            .collect::<Vec<_>>();
        if ranked_candidates.is_empty() {
            return Err(last_error.unwrap_or_else(|| {
                ApiError::internal("No playable Real-Debrid stream URL was available.")
            }));
        }

        let playable_url = ranked_candidates[0].clone();
        let resolved = ResolvedSource {
            playable_url,
            fallback_urls: ranked_candidates.into_iter().skip(1).collect(),
            filename: if filename.is_empty() {
                selected_file_path.clone()
            } else {
                filename
            },
            source_hash: info_hash.to_owned(),
            selected_file,
            selected_file_path,
        };
        Ok(resolved)
    }

    async fn find_reusable_rd_torrent_by_hash(&self, info_hash: &str) -> AppResult<Option<String>> {
        let normalized_hash = normalize_source_hash(info_hash);
        if normalized_hash.is_empty() {
            return Ok(None);
        }

        if let Some(cached_torrent_id) = self.get_cached_rd_torrent_id(&normalized_hash).await? {
            return Ok(Some(cached_torrent_id));
        }

        for page in 1..=4 {
            let payload = self
                .rd_fetch_json(
                    &format!("/torrents?page={page}"),
                    reqwest::Method::GET,
                    10_000,
                )
                .await?;
            let Some(items) = payload.as_array() else {
                break;
            };
            if items.is_empty() {
                break;
            }
            if let Some(torrent_id) = items.iter().find_map(|item| {
                let hash = stringify_json(item.get("hash"));
                let torrent_id = stringify_json(item.get("id"));
                (hash == normalized_hash && !torrent_id.is_empty()).then_some(torrent_id)
            }) {
                let _ = self
                    .set_cached_rd_torrent_id(&normalized_hash, &torrent_id)
                    .await;
                return Ok(Some(torrent_id));
            }
        }
        Ok(None)
    }

    async fn get_cached_rd_torrent_id(&self, info_hash: &str) -> AppResult<Option<String>> {
        let cache_key = build_rd_torrent_cache_key(info_hash);
        let Some((payload, _)) = self.db.get_movie_quick_start_cache(cache_key).await? else {
            return Ok(None);
        };
        let torrent_id = stringify_json(payload.get("torrentId"));
        if torrent_id.is_empty() {
            return Ok(None);
        }
        Ok(Some(torrent_id))
    }

    async fn set_cached_rd_torrent_id(&self, info_hash: &str, torrent_id: &str) -> AppResult<()> {
        let normalized_hash = normalize_source_hash(info_hash);
        let normalized_torrent_id = torrent_id.trim();
        if normalized_hash.is_empty() || normalized_torrent_id.is_empty() {
            return Ok(());
        }
        self.db
            .set_movie_quick_start_cache(
                build_rd_torrent_cache_key(&normalized_hash),
                json!({
                    "infoHash": normalized_hash,
                    "torrentId": normalized_torrent_id
                }),
                now_ms() + RD_TORRENT_CACHE_TTL_MS,
            )
            .await
    }

    async fn delete_cached_rd_torrent_id(&self, info_hash: &str) -> AppResult<()> {
        let normalized_hash = normalize_source_hash(info_hash);
        if normalized_hash.is_empty() {
            return Ok(());
        }
        self.db
            .delete_movie_quick_start_cache(build_rd_torrent_cache_key(&normalized_hash))
            .await
    }

    async fn wait_for_torrent_to_be_ready(&self, torrent_id: &str) -> AppResult<Value> {
        let started_at = now_ms();
        let mut last_status = "pending".to_owned();
        while now_ms() - started_at < 18_000 {
            let info = self
                .rd_fetch_json(
                    &format!("/torrents/info/{torrent_id}"),
                    reqwest::Method::GET,
                    12_000,
                )
                .await?;
            let status = stringify_json(info.get("status")).to_lowercase();
            if !status.is_empty() {
                last_status = status.clone();
            }
            let has_links = info
                .get("links")
                .and_then(Value::as_array)
                .map(|values| !values.is_empty())
                .unwrap_or(false);
            if status == "downloaded" && has_links {
                return Ok(info);
            }
            if TORRENT_FATAL_STATUSES.contains(&status.as_str()) {
                return Err(ApiError::internal(format!(
                    "Real-Debrid torrent failed ({status})."
                )));
            }
            sleep(Duration::from_millis(1_200)).await;
        }
        Err(ApiError::internal(format!(
            "Timed out waiting for cached source ({last_status})."
        )))
    }

    async fn resolve_playable_url_from_rd_link(
        &self,
        rd_link: &str,
    ) -> AppResult<(Vec<String>, String)> {
        let unrestricted = self
            .rd_fetch_form(
                "/unrestrict/link",
                reqwest::Method::POST,
                &[("link", rd_link)],
                12_000,
            )
            .await?;
        let download = stringify_json(unrestricted.get("download"));
        if download.is_empty() {
            return Err(ApiError::internal(
                "Real-Debrid returned no downloadable link.",
            ));
        }
        Ok((vec![download], stringify_json(unrestricted.get("filename"))))
    }

    async fn verify_playable_url(
        &self,
        playable_url: &str,
        timeout_ms: u64,
    ) -> AppResult<PlayableUrlVerification> {
        if playable_url.trim().is_empty() {
            return Err(ApiError::internal("Resolved stream URL is empty."));
        }
        let response = self
            .client
            .head(playable_url)
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => Ok(PlayableUrlVerification::Verified),
            Ok(response)
                if matches!(response.status().as_u16(), 401 | 403 | 404)
                    || response.status().is_server_error() =>
            {
                Err(ApiError::internal(format!(
                    "Resolved stream is unavailable ({}).",
                    response.status().as_u16()
                )))
            }
            Ok(_) => Ok(PlayableUrlVerification::Uncertain),
            Err(error) if error.is_timeout() => Ok(PlayableUrlVerification::Uncertain),
            Err(_) => Ok(PlayableUrlVerification::Uncertain),
        }
    }

    async fn rd_fetch_json(
        &self,
        path: &str,
        method: reqwest::Method,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        self.rd_fetch(path, method, None, timeout_ms).await
    }

    async fn rd_fetch_form(
        &self,
        path: &str,
        method: reqwest::Method,
        form: &[(&str, &str)],
        timeout_ms: u64,
    ) -> AppResult<Value> {
        self.rd_fetch(path, method, Some(form), timeout_ms).await
    }

    async fn rd_fetch(
        &self,
        path: &str,
        method: reqwest::Method,
        form: Option<&[(&str, &str)]>,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        if self.config.real_debrid_token.trim().is_empty() {
            return Err(ApiError::internal(
                "REAL_DEBRID_TOKEN is not configured on the server.",
            ));
        }
        let mut builder = self
            .client
            .request(method, format!("{REAL_DEBRID_API_BASE}{path}"))
            .bearer_auth(self.config.real_debrid_token.clone())
            .timeout(Duration::from_millis(timeout_ms));
        if let Some(form) = form {
            builder = builder.form(form);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| map_reqwest_error(error, "Real-Debrid request timed out."))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let payload = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| {
            json!({
                "message": body
            })
        });
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .unwrap_or("Real-Debrid request failed.");
            return Err(ApiError::internal(message.to_owned()));
        }
        Ok(payload)
    }

    async fn safe_delete_torrent(&self, torrent_id: &str) -> AppResult<()> {
        if torrent_id.trim().is_empty() {
            return Ok(());
        }
        let _ = self
            .rd_fetch_json(
                &format!("/torrents/delete/{torrent_id}"),
                reqwest::Method::DELETE,
                5_000,
            )
            .await;
        Ok(())
    }

    async fn resolve_effective_preferred_audio_lang(
        &self,
        tmdb_id: &str,
        stored_preferred_audio_lang: &str,
        preferred_audio_lang: &str,
    ) -> AppResult<String> {
        let normalized = normalize_preferred_audio_lang(preferred_audio_lang);
        if normalized != "auto" {
            return Ok(normalized);
        }
        let stored = normalize_preferred_audio_lang(stored_preferred_audio_lang);
        if stored != "auto" {
            return Ok(stored);
        }
        let preference = self
            .db
            .get_title_preference(tmdb_id.trim().to_owned())
            .await?;
        Ok(preference
            .map(|value| normalize_preferred_audio_lang(&value.audioLang))
            .filter(|value| value != "auto")
            .unwrap_or_else(|| "auto".to_owned()))
    }

    async fn try_reuse_playback_session(
        &self,
        metadata: &ResolveMetadata,
        preferences: &ResolvePreferences,
        filters: &ResolveFilters,
    ) -> AppResult<Option<Value>> {
        if !self.config.playback_sessions_enabled
            || metadata.tmdb_id.trim().is_empty()
            || should_skip_playback_session_reuse(filters)
        {
            return Ok(None);
        }

        let session_key = build_playback_session_key(
            &metadata.tmdb_id,
            &preferences.audio_lang,
            &preferences.quality,
        );
        let Some(session) = self.db.get_playback_session(session_key).await? else {
            return Ok(None);
        };
        if session.tmdb_id != metadata.tmdb_id
            || session.playable_url.trim().is_empty()
            || session.health_state == "invalid"
        {
            return Ok(None);
        }

        let match_name = playback_session_match_name(&session);
        let is_valid_match = if metadata.media_type == "tv" {
            does_filename_likely_match_tv_episode(
                &match_name,
                &metadata.display_title,
                &metadata.display_year,
                metadata.season_number,
                metadata.episode_number,
            )
        } else {
            does_filename_likely_match_movie(
                &match_name,
                &metadata.display_title,
                &metadata.display_year,
            )
        };
        if !is_valid_match {
            self.invalidate_playback_session(
                &session,
                "Playback session filename mismatched the requested title.",
            )
            .await;
            return Ok(None);
        }

        let verifiable_url = extract_playable_source_input(&session.playable_url);
        let needs_revalidation = session.next_validation_at > 0
            && session.next_validation_at <= now_ms()
            && looks_like_http_url(&verifiable_url);
        if needs_revalidation {
            if self
                .verify_playable_url(&verifiable_url, 3_000)
                .await
                .is_err()
            {
                self.invalidate_playback_session(
                    &session,
                    "Playback session validation failed for the stored stream URL.",
                )
                .await;
                return Ok(None);
            }
            let _ = self
                .db
                .refresh_playback_session_validation_window(session.session_key.clone())
                .await;
        }

        self.build_resolved_response(
            ResolvedSource {
                playable_url: session.playable_url.clone(),
                fallback_urls: session.fallback_urls.clone(),
                filename: session.filename.clone(),
                source_hash: session.source_hash.clone(),
                selected_file: session.selected_file.clone(),
                selected_file_path: playback_session_selected_file_path(&session),
            },
            metadata.clone(),
            preferences.clone(),
            true,
        )
        .await
        .map(Some)
    }

    async fn invalidate_playback_session(&self, session: &PlaybackSession, reason: &str) {
        let _ = self
            .db
            .update_playback_session_progress(
                session.session_key.clone(),
                session.last_position_seconds,
                "invalid".to_owned(),
                reason.to_owned(),
            )
            .await;
    }

    async fn fetch_movie_metadata(
        &self,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
    ) -> AppResult<ResolveMetadata> {
        let details = self
            .tmdb
            .fetch(
                &format!("/movie/{}", tmdb_id.trim()),
                BTreeMap::new(),
                20_000,
            )
            .await?;
        let imdb_id = stringify_json(details.get("imdb_id"));
        if imdb_id.is_empty() {
            return Err(ApiError::internal(
                "This TMDB movie does not expose an IMDb id.",
            ));
        }
        let runtime_minutes = details
            .get("runtime")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        Ok(ResolveMetadata {
            tmdb_id: tmdb_id.trim().to_owned(),
            imdb_id,
            display_title: normalize_whitespace(
                &stringify_json(details.get("title")).if_empty_then(|| title_fallback.to_owned()),
            )
            .if_empty_then(|| "Movie".to_owned()),
            display_year: normalize_whitespace(
                &stringify_json(details.get("release_date"))
                    .chars()
                    .take(4)
                    .collect::<String>()
                    .if_empty_then(|| year_fallback.to_owned()),
            ),
            runtime_seconds: if runtime_minutes > 0 {
                runtime_minutes * 60
            } else {
                0
            },
            season_number: 0,
            episode_number: 0,
            episode_title: String::new(),
            media_type: "movie".to_owned(),
        })
    }

    async fn fetch_tv_episode_metadata(
        &self,
        tmdb_id: &str,
        title_fallback: &str,
        year_fallback: &str,
        season_number: i64,
        episode_number: i64,
    ) -> AppResult<ResolveMetadata> {
        let series_path = format!("/tv/{}", tmdb_id.trim());
        let episode_path = format!(
            "/tv/{}/season/{}/episode/{}",
            tmdb_id.trim(),
            season_number,
            episode_number
        );
        let external_ids_path = format!("/tv/{}/external_ids", tmdb_id.trim());
        let series_details_fut = self.tmdb.fetch(&series_path, BTreeMap::new(), 20_000);
        let episode_details_fut = self.tmdb.fetch(&episode_path, BTreeMap::new(), 20_000);
        let series_external_ids_fut = self.tmdb.fetch(&external_ids_path, BTreeMap::new(), 20_000);
        let (series_details, episode_details, series_external_ids) = tokio::try_join!(
            series_details_fut,
            episode_details_fut,
            series_external_ids_fut
        )?;
        let imdb_id = stringify_json(series_external_ids.get("imdb_id"));
        if imdb_id.is_empty() {
            return Err(ApiError::internal(
                "This TMDB series does not expose an IMDb id.",
            ));
        }
        let runtime_minutes = episode_details
            .get("runtime")
            .and_then(Value::as_i64)
            .or_else(|| {
                series_details
                    .get("episode_run_time")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(Value::as_i64)
            })
            .unwrap_or_default();
        Ok(ResolveMetadata {
            tmdb_id: tmdb_id.trim().to_owned(),
            imdb_id,
            display_title: normalize_whitespace(
                &stringify_json(series_details.get("name"))
                    .if_empty_then(|| title_fallback.to_owned()),
            )
            .if_empty_then(|| "Series".to_owned()),
            display_year: stringify_json(series_details.get("first_air_date"))
                .chars()
                .take(4)
                .collect::<String>()
                .if_empty_then(|| year_fallback.to_owned()),
            runtime_seconds: if runtime_minutes > 0 {
                runtime_minutes * 60
            } else {
                0
            },
            season_number,
            episode_number,
            episode_title: normalize_whitespace(&stringify_json(episode_details.get("name")))
                .if_empty_then(|| format!("Episode {episode_number}")),
            media_type: "tv".to_owned(),
        })
    }

    async fn fetch_torrentio_movie_streams(
        &self,
        imdb_id: &str,
    ) -> AppResult<Vec<TorrentioStream>> {
        self.fetch_torrentio_streams(&format!("/stream/movie/{}.json", imdb_id.trim()))
            .await
    }

    async fn fetch_torrentio_episode_streams(
        &self,
        imdb_id: &str,
        season_number: i64,
        episode_number: i64,
    ) -> AppResult<Vec<TorrentioStream>> {
        self.fetch_torrentio_streams(&format!(
            "/stream/series/{}:{}:{}.json",
            url::form_urlencoded::byte_serialize(imdb_id.trim().as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(season_number.to_string().as_bytes())
                .collect::<String>(),
            url::form_urlencoded::byte_serialize(episode_number.to_string().as_bytes())
                .collect::<String>(),
        ))
        .await
    }

    async fn fetch_torrentio_streams(&self, path: &str) -> AppResult<Vec<TorrentioStream>> {
        let url = format!("{}{}", self.config.torrentio_base_url, path);
        let cache_key = build_torrentio_stream_cache_key(&self.config.torrentio_base_url, path);
        let cached = self.db.get_resolved_stream_cache(cache_key.clone()).await?;
        let now = now_ms();
        if let Some((payload, _, next_validation_at)) = cached.as_ref()
            && *next_validation_at > now
        {
            return parse_torrentio_streams_payload(payload);
        }

        let mut last_error = None;

        for attempt in 0..TORRENTIO_REQUEST_MAX_ATTEMPTS {
            let is_last_attempt = attempt + 1 == TORRENTIO_REQUEST_MAX_ATTEMPTS;
            let attempt_started_at = now_ms();
            let response = self
                .client
                .get(&url)
                .timeout(Duration::from_millis(TORRENTIO_REQUEST_TIMEOUT_MS))
                .send()
                .await;

            match response {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let attempt_elapsed_ms = now_ms() - attempt_started_at;
                        if !is_last_attempt
                            && is_retryable_torrentio_status(status)
                            && attempt_elapsed_ms <= TORRENTIO_RETRY_MAX_ELAPSED_MS
                        {
                            sleep(Duration::from_millis(TORRENTIO_REQUEST_RETRY_DELAY_MS)).await;
                            continue;
                        }
                        last_error = Some(ApiError::bad_gateway(format!(
                            "Torrentio request failed ({status})."
                        )));
                        break;
                    }

                    let payload = response
                        .json::<Value>()
                        .await
                        .map_err(|error| ApiError::internal(error.to_string()))?;
                    let (expires_at, next_validation_at) =
                        compute_torrentio_cache_deadlines(&payload);
                    self.db
                        .set_resolved_stream_cache(
                            cache_key.clone(),
                            payload.clone(),
                            expires_at,
                            next_validation_at,
                        )
                        .await?;
                    return parse_torrentio_streams_payload(&payload);
                }
                Err(error) => {
                    let attempt_elapsed_ms = now_ms() - attempt_started_at;
                    if !is_last_attempt
                        && is_retryable_torrentio_transport_error(&error)
                        && attempt_elapsed_ms <= TORRENTIO_RETRY_MAX_ELAPSED_MS
                    {
                        sleep(Duration::from_millis(TORRENTIO_REQUEST_RETRY_DELAY_MS)).await;
                        continue;
                    }
                    last_error = Some(map_reqwest_error(error, "Torrentio request timed out."));
                    break;
                }
            }
        }

        if let Some((payload, expires_at, _)) = cached
            && expires_at > now_ms()
        {
            return parse_torrentio_streams_payload(&payload);
        }

        Err(last_error
            .unwrap_or_else(|| ApiError::bad_gateway("Torrentio request failed after retrying.")))
    }

    async fn compute_source_health_scores(
        &self,
        streams: &[TorrentioStream],
    ) -> AppResult<HashMap<String, i64>> {
        let mut scores = HashMap::new();
        let mut seen = HashSet::new();
        for stream in streams {
            let info_hash = get_stream_info_hash(stream);
            if info_hash.is_empty() || !seen.insert(info_hash.clone()) {
                continue;
            }
            let Some(stats) = self.db.get_source_health_stats(info_hash.clone()).await? else {
                scores.insert(info_hash, 0);
                continue;
            };
            scores.insert(info_hash, compute_source_health_score(&stats));
        }
        Ok(scores)
    }
}

#[derive(Debug, Clone)]
struct SourceFilters {
    min_seeders: i64,
    allowed_formats: Vec<String>,
    source_language: String,
    source_audio_profile: String,
}

#[allow(clippy::too_many_arguments)]
fn select_top_movie_candidates<'a>(
    streams: &'a [TorrentioStream],
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_hash: &str,
    limit: usize,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a TorrentioStream> {
    let ranked_pool = streams
        .iter()
        .filter(|stream| !get_stream_info_hash(stream).is_empty())
        .collect::<Vec<_>>();
    let filtered_pool = apply_source_stream_filters(ranked_pool, source_filters);
    if filtered_pool.is_empty() {
        return Vec::new();
    }
    let title_filtered = prefer_movie_title_matched_candidates(filtered_pool, metadata);
    let quality_filtered = filter_streams_by_quality_preference(title_filtered, preferred_quality);
    let sorted = sort_movie_candidates(
        quality_filtered,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    let capped = sorted
        .iter()
        .copied()
        .take(limit.max(1))
        .collect::<Vec<_>>();
    let selected = prioritize_candidates_by_source_hash(capped, sorted.clone(), source_hash, limit);
    apply_mp4_default_candidate_rule(
        selected,
        sorted,
        source_hash,
        limit,
        &source_filters.source_language,
    )
}

#[allow(clippy::too_many_arguments)]
fn select_top_episode_candidates<'a>(
    streams: &'a [TorrentioStream],
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    preferred_container: &str,
    source_hash: &str,
    limit: usize,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a TorrentioStream> {
    let ranked_pool = streams
        .iter()
        .filter(|stream| !get_stream_info_hash(stream).is_empty())
        .collect::<Vec<_>>();
    let filtered_pool = apply_source_stream_filters(ranked_pool, source_filters);
    if filtered_pool.is_empty() {
        return Vec::new();
    }
    let episode_filtered = prefer_episode_title_matched_candidates(filtered_pool, metadata);
    let quality_filtered =
        filter_streams_by_quality_preference(episode_filtered, preferred_quality);
    let sorted = sort_episode_candidates(
        quality_filtered,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    let selected = prioritize_candidates_by_source_hash(
        sorted
            .iter()
            .copied()
            .take(limit.max(1))
            .collect::<Vec<_>>(),
        sorted.clone(),
        source_hash,
        limit,
    );
    if preferred_container == "mp4" {
        apply_mp4_default_candidate_rule(
            selected,
            sorted,
            source_hash,
            limit,
            &source_filters.source_language,
        )
    } else {
        selected
    }
}

fn summarize_stream_candidate_for_client(
    stream: &TorrentioStream,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Option<SourceSummary> {
    let info_hash = get_stream_info_hash(stream);
    if info_hash.is_empty() {
        return None;
    }
    let title_lines = extract_stream_title_lines(stream);
    let filename = stream.behaviorHints.filename.trim().to_owned();
    let primary = if !filename.is_empty() {
        filename.clone()
    } else if let Some(line) = title_lines.first() {
        line.clone()
    } else if !stream.name.trim().is_empty() {
        stream.name.trim().to_owned()
    } else {
        "Source".to_owned()
    };
    let provider = normalize_whitespace(&stream.name);
    let seeders = parse_seed_count(stream.title.as_str()).max(0);
    let resolution = parse_stream_vertical_resolution(stream);
    let container = infer_stream_container_label(stream);
    let mut score = score_stream_quality(
        stream,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    if metadata.episode_number > 0 {
        score +=
            score_stream_episode_match(stream, metadata.season_number, metadata.episode_number);
    }
    Some(SourceSummary {
        sourceHash: info_hash.clone(),
        infoHash: info_hash,
        provider,
        primary,
        filename,
        qualityLabel: if resolution > 0 {
            format!("{resolution}p")
        } else {
            String::new()
        },
        container,
        seeders,
        size: extract_stream_size_label(stream),
        releaseGroup: extract_stream_release_group(stream),
        score,
    })
}

fn apply_source_stream_filters<'a>(
    streams: Vec<&'a TorrentioStream>,
    source_filters: &SourceFilters,
) -> Vec<&'a TorrentioStream> {
    let effective_allowed_formats = if source_filters.allowed_formats.is_empty() {
        DEFAULT_ALLOWED_SOURCE_FORMATS
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    } else {
        source_filters.allowed_formats.clone()
    };
    let allowed_format_set = effective_allowed_formats
        .into_iter()
        .collect::<HashSet<_>>();
    streams
        .into_iter()
        .filter(|stream| {
            if source_filters.min_seeders > 0
                && parse_seed_count(if stream.title.is_empty() {
                    stream.name.as_str()
                } else {
                    stream.title.as_str()
                }) < source_filters.min_seeders
            {
                return false;
            }
            let container = infer_stream_container_label(stream);
            if container.is_empty() || !allowed_format_set.contains(&container) {
                return false;
            }
            if source_filters.source_language != "any"
                && !matches_source_language_filter(stream, &source_filters.source_language)
            {
                return false;
            }
            true
        })
        .collect()
}

fn filter_streams_by_quality_preference<'a>(
    streams: Vec<&'a TorrentioStream>,
    preferred_quality: &str,
) -> Vec<&'a TorrentioStream> {
    let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
    if normalized_quality == "auto" {
        return streams;
    }
    let target_height = stream_quality_target(&normalized_quality);
    if target_height == 0 {
        return streams;
    }

    let exact_matches = streams
        .iter()
        .copied()
        .filter(|stream| parse_stream_vertical_resolution(stream) == target_height)
        .collect::<Vec<_>>();
    if !exact_matches.is_empty() {
        return exact_matches;
    }

    let lower_or_equal = streams
        .iter()
        .copied()
        .filter(|stream| {
            let height = parse_stream_vertical_resolution(stream);
            height > 0 && height <= target_height
        })
        .collect::<Vec<_>>();
    if !lower_or_equal.is_empty() {
        return lower_or_equal;
    }

    let higher = streams
        .iter()
        .copied()
        .filter(|stream| parse_stream_vertical_resolution(stream) > target_height)
        .collect::<Vec<_>>();
    if !higher.is_empty() {
        return higher;
    }

    streams
}

fn sort_movie_candidates<'a>(
    streams: Vec<&'a TorrentioStream>,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a TorrentioStream> {
    let mut sorted = streams;
    sorted.sort_by(|left, right| {
        let right_score = score_stream_quality(
            right,
            metadata,
            preferred_audio_lang,
            preferred_quality,
            source_filters,
            health_scores,
        );
        let left_score = score_stream_quality(
            left,
            metadata,
            preferred_audio_lang,
            preferred_quality,
            source_filters,
            health_scores,
        );
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    sorted
}

fn sort_episode_candidates<'a>(
    streams: Vec<&'a TorrentioStream>,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a TorrentioStream> {
    let mut sorted = streams;
    sorted.sort_by(|left, right| {
        let right_score =
            score_stream_quality(
                right,
                metadata,
                preferred_audio_lang,
                preferred_quality,
                source_filters,
                health_scores,
            ) + score_stream_episode_match(right, metadata.season_number, metadata.episode_number);
        let left_score =
            score_stream_quality(
                left,
                metadata,
                preferred_audio_lang,
                preferred_quality,
                source_filters,
                health_scores,
            ) + score_stream_episode_match(left, metadata.season_number, metadata.episode_number);
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    sorted
}

fn score_stream_quality(
    stream: &TorrentioStream,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> i64 {
    score_stream_language_preference(stream, preferred_audio_lang)
        + score_stream_source_audio_profile(
            stream,
            &source_filters.source_language,
            &source_filters.source_audio_profile,
        )
        + score_stream_quality_preference(stream, preferred_quality)
        + score_stream_title_year_match(stream, metadata)
        + score_stream_runtime_match(stream, metadata)
        + score_stream_release_quality(stream)
        + score_stream_seeders(stream)
        + health_scores
            .get(&get_stream_info_hash(stream))
            .copied()
            .unwrap_or_default()
}

fn prioritize_candidates_by_source_hash<'a>(
    candidates: Vec<&'a TorrentioStream>,
    ranked_pool: Vec<&'a TorrentioStream>,
    source_hash: &str,
    limit: usize,
) -> Vec<&'a TorrentioStream> {
    let normalized_hash = normalize_source_hash(source_hash);
    let safe_limit = limit.max(1);
    if normalized_hash.is_empty() {
        return candidates.into_iter().take(safe_limit).collect();
    }

    let dedup_by_hash = |list: Vec<&'a TorrentioStream>| {
        let mut seen = HashSet::new();
        let mut output = Vec::new();
        for item in list {
            let hash = get_stream_info_hash(item);
            if hash.is_empty() || !seen.insert(hash) {
                continue;
            }
            output.push(item);
        }
        output
    };

    let base_list = dedup_by_hash(candidates);
    if let Some(selected) = base_list
        .iter()
        .copied()
        .find(|item| get_stream_info_hash(item) == normalized_hash)
    {
        let mut next = vec![selected];
        next.extend(
            base_list
                .into_iter()
                .filter(|item| !std::ptr::eq(*item, selected)),
        );
        return next.into_iter().take(safe_limit).collect();
    }

    let selected_from_pool = dedup_by_hash(ranked_pool)
        .into_iter()
        .find(|item| get_stream_info_hash(item) == normalized_hash);
    let Some(selected_from_pool) = selected_from_pool else {
        return base_list.into_iter().take(safe_limit).collect();
    };
    let mut next = vec![selected_from_pool];
    next.extend(base_list);
    next.into_iter().take(safe_limit).collect()
}

fn apply_mp4_default_candidate_rule<'a>(
    candidates: Vec<&'a TorrentioStream>,
    ranked_pool: Vec<&'a TorrentioStream>,
    source_hash: &str,
    limit: usize,
    source_language: &str,
) -> Vec<&'a TorrentioStream> {
    let with_mp4 = ensure_at_least_one_container_candidate(
        candidates,
        ranked_pool.clone(),
        "mp4",
        limit,
        source_language,
    );
    if with_mp4.is_empty() {
        return with_mp4;
    }
    if !normalize_source_hash(source_hash).is_empty() {
        return with_mp4;
    }

    let Some(best_mp4) = pick_best_container_candidate(&with_mp4, "mp4", source_language) else {
        return move_container_candidates_to_front(with_mp4, "mp4");
    };
    let mut next = vec![best_mp4];
    next.extend(
        with_mp4
            .into_iter()
            .filter(|candidate| !std::ptr::eq(*candidate, best_mp4)),
    );
    next
}

fn ensure_at_least_one_container_candidate<'a>(
    candidates: Vec<&'a TorrentioStream>,
    ranked_pool: Vec<&'a TorrentioStream>,
    container: &str,
    limit: usize,
    source_language: &str,
) -> Vec<&'a TorrentioStream> {
    let safe_limit = limit.max(1);
    let mut current = candidates.into_iter().take(safe_limit).collect::<Vec<_>>();
    if current.is_empty() {
        return current;
    }
    if current
        .iter()
        .any(|candidate| is_stream_likely_container(candidate, container))
    {
        return current;
    }
    let current_hashes = current
        .iter()
        .map(|candidate| get_stream_info_hash(candidate))
        .filter(|hash| !hash.is_empty())
        .collect::<HashSet<_>>();
    let Some(fallback) = pick_best_container_candidate(&ranked_pool, container, source_language)
    else {
        return current;
    };
    let fallback_hash = get_stream_info_hash(fallback);
    if !fallback_hash.is_empty() && current_hashes.contains(&fallback_hash) {
        return current;
    }
    if let Some(last) = current.last_mut() {
        *last = fallback;
    }
    current
}

fn pick_best_container_candidate<'a>(
    candidates: &[&'a TorrentioStream],
    container: &str,
    source_language: &str,
) -> Option<&'a TorrentioStream> {
    let mut container_candidates = candidates
        .iter()
        .copied()
        .filter(|candidate| is_stream_likely_container(candidate, container))
        .collect::<Vec<_>>();
    container_candidates
        .sort_by(|left, right| compare_container_default_candidates(left, right, source_language));
    container_candidates.first().copied()
}

fn compare_container_default_candidates(
    left: &TorrentioStream,
    right: &TorrentioStream,
    source_language: &str,
) -> std::cmp::Ordering {
    let left_language_score = score_container_default_language(left, source_language);
    let right_language_score = score_container_default_language(right, source_language);
    if left_language_score != right_language_score {
        return right_language_score.cmp(&left_language_score);
    }
    let left_resolution = parse_stream_vertical_resolution(left);
    let right_resolution = parse_stream_vertical_resolution(right);
    if left_resolution != right_resolution {
        return right_resolution.cmp(&left_resolution);
    }
    parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
}

fn move_container_candidates_to_front<'a>(
    candidates: Vec<&'a TorrentioStream>,
    container: &str,
) -> Vec<&'a TorrentioStream> {
    let mut preferred = Vec::new();
    let mut rest = Vec::new();
    for candidate in candidates {
        if is_stream_likely_container(candidate, container) {
            preferred.push(candidate);
        } else {
            rest.push(candidate);
        }
    }
    preferred.extend(rest);
    preferred
}

fn score_container_default_language(stream: &TorrentioStream, source_language: &str) -> i64 {
    let normalized_source_language = normalize_source_language_filter(source_language);
    if normalized_source_language == "any" {
        return 0;
    }
    let detected = get_detected_stream_languages(stream);
    if detected.contains(&normalized_source_language) {
        return if detected.len() == 1 { 4 } else { 2 };
    }
    if detected.is_empty() && normalized_source_language == SOURCE_LANGUAGE_FILTER_DEFAULT {
        return 1;
    }
    -5
}

fn score_stream_source_audio_profile(
    stream: &TorrentioStream,
    source_language: &str,
    source_audio_profile: &str,
) -> i64 {
    let normalized_profile = normalize_source_audio_profile_filter(source_audio_profile);
    if normalized_profile != SOURCE_AUDIO_PROFILE_DEFAULT {
        return 0;
    }

    let detected_languages = get_detected_stream_languages(stream);
    let has_multi_audio_marker = has_explicit_multi_audio_marker(stream);
    if has_multi_audio_marker || detected_languages.len() > 1 {
        let normalized_source_language = normalize_source_language_filter(source_language);
        if normalized_source_language != "any"
            && detected_languages.contains(&normalized_source_language)
        {
            return -2_200;
        }
        return -1_800;
    }

    let normalized_source_language = normalize_source_language_filter(source_language);
    if normalized_source_language == "any" {
        return if detected_languages.len() == 1 {
            450
        } else {
            0
        };
    }

    if detected_languages.len() == 1 && detected_languages.contains(&normalized_source_language) {
        return 1_600;
    }

    0
}

fn score_stream_seeders(stream: &TorrentioStream) -> i64 {
    let seed_count = parse_seed_count(if stream.title.is_empty() {
        stream.name.as_str()
    } else {
        stream.title.as_str()
    });
    if seed_count <= 0 {
        return 0;
    }
    ((((seed_count + 1) as f64).log10() * 320.0).round() as i64).min(900)
}

fn score_stream_language_preference(stream: &TorrentioStream, preferred_audio_lang: &str) -> i64 {
    let preferred = normalize_preferred_audio_lang(preferred_audio_lang);
    if preferred == "auto" {
        return 0;
    }
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    let mut score = 0;
    if audio_language_tokens(&preferred)
        .iter()
        .any(|token| stream_text.contains(token))
    {
        score += 2500;
    }
    for lang in ["en", "fr", "es", "de", "it", "pt"] {
        if lang == preferred {
            continue;
        }
        if audio_language_tokens(lang)
            .iter()
            .any(|token| stream_text.contains(token))
        {
            score -= 1400;
        }
    }
    score
}

fn score_stream_quality_preference(stream: &TorrentioStream, preferred_quality: &str) -> i64 {
    let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
    if normalized_quality == "auto" {
        return 0;
    }
    let target_height = stream_quality_target(&normalized_quality);
    let candidate_height = parse_stream_vertical_resolution(stream);
    if target_height == 0 || candidate_height == 0 {
        return 0;
    }
    if candidate_height == target_height {
        return 1400;
    }
    if candidate_height > target_height {
        return -700 - (candidate_height - target_height).min(900);
    }
    -300 - (target_height - candidate_height).min(700)
}

fn score_stream_title_year_match(stream: &TorrentioStream, metadata: &ResolveMetadata) -> i64 {
    let stream_text = normalize_text_for_match(&build_stream_text_raw(stream));
    if stream_text.is_empty() {
        return 0;
    }
    let title_tokens = tokenize_title_for_match(&metadata.display_title);
    if title_tokens.is_empty() {
        return 0;
    }
    let matched_token_count = count_matching_title_tokens(&stream_text, &title_tokens);
    let has_year =
        !metadata.display_year.is_empty() && stream_text.contains(&metadata.display_year);
    let required_matches = title_tokens.len().min(2);
    if matched_token_count >= required_matches && has_year {
        return 1800;
    }
    if matched_token_count >= required_matches {
        return 1100;
    }
    if matched_token_count >= 1 && has_year {
        return 420;
    }
    if matched_token_count == 0 && has_year {
        return -900;
    }
    -600
}

fn score_stream_runtime_match(stream: &TorrentioStream, metadata: &ResolveMetadata) -> i64 {
    let target_runtime_seconds = metadata.runtime_seconds.max(0);
    if target_runtime_seconds < 1800 {
        return 0;
    }
    let candidate_runtime_seconds =
        parse_runtime_from_label_seconds(&build_stream_text_raw(stream));
    if candidate_runtime_seconds <= 0 {
        return 0;
    }
    let delta_ratio = ((candidate_runtime_seconds - target_runtime_seconds).abs() as f64)
        / target_runtime_seconds as f64;
    if delta_ratio <= 0.06 {
        return 420;
    }
    if delta_ratio <= 0.12 {
        return 220;
    }
    if delta_ratio <= 0.2 {
        return 60;
    }
    -360
}

fn score_stream_release_quality(stream: &TorrentioStream) -> i64 {
    let stream_text = build_stream_release_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    if LOW_QUALITY_THEATRICAL_RELEASE_RE.is_match(&stream_text) {
        return -4200;
    }
    if LOW_QUALITY_SCREENER_RELEASE_RE.is_match(&stream_text) {
        return -2600;
    }
    0
}

fn score_stream_episode_match(
    stream: &TorrentioStream,
    season_number: i64,
    episode_number: i64,
) -> i64 {
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    let target_signature = build_episode_signature(season_number, episode_number);
    let signatures = collect_episode_signatures(&stream_text, Some(season_number));
    if signatures.is_empty() {
        return 0;
    }
    if signatures.contains(&target_signature) {
        return 2800;
    }
    -3400
}

fn build_episode_signature(season_number: i64, episode_number: i64) -> String {
    format!(
        "{}x{}",
        normalize_episode_ordinal(&season_number.to_string(), 1),
        normalize_episode_ordinal(&episode_number.to_string(), 1)
    )
}

fn collect_episode_signatures(text: &str, season_hint: Option<i64>) -> Vec<String> {
    let normalized = text.to_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut signatures = Vec::new();
    let mut push = |season: i64, episode: i64| {
        if !(1..=99).contains(&season) || !(1..=999).contains(&episode) {
            return;
        }
        signatures.push(format!("{season}x{episode}"));
    };
    for captures in HXH_SEASON_EPISODE_RE.captures_iter(&normalized) {
        push(
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
        );
    }
    for captures in X_SEASON_EPISODE_RE.captures_iter(&normalized) {
        push(
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
        );
    }
    if let Some(season_hint) = season_hint.filter(|value| *value > 0) {
        for captures in EPISODE_ONLY_RE.captures_iter(&normalized) {
            push(
                season_hint,
                captures
                    .get(1)
                    .and_then(|value| value.as_str().parse::<i64>().ok())
                    .unwrap_or_default(),
            );
        }
    }
    signatures.sort();
    signatures.dedup();
    signatures
}

fn parse_runtime_from_label_seconds(value: &str) -> i64 {
    let text = value.to_lowercase();
    if text.is_empty() {
        return 0;
    }
    if let Some(captures) = HMS_RUNTIME_RE.captures(&text) {
        let first = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let second = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let third = captures
            .get(3)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        if captures.get(3).is_some() {
            return first * 3600 + second * 60 + third;
        }
        return first * 60 + second;
    }
    let hours = HOURS_RUNTIME_RE
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or_default();
    let minutes = MINUTES_RUNTIME_RE
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or_default();
    if hours > 0.0 || minutes > 0.0 {
        return (hours * 3600.0 + minutes * 60.0).round() as i64;
    }
    if let Some(captures) = COMPACT_RUNTIME_RE.captures(&text) {
        let hours = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let minutes = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        return hours * 3600 + minutes * 60;
    }
    0
}

fn parse_stream_vertical_resolution(stream: &TorrentioStream) -> i64 {
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    if Regex::new(r"\b(2160p|4k|uhd)\b")
        .expect("valid 2160 regex")
        .is_match(&stream_text)
    {
        return 2160;
    }
    if Regex::new(r"\b(1080p|full\s*hd)\b")
        .expect("valid 1080 regex")
        .is_match(&stream_text)
    {
        return 1080;
    }
    if Regex::new(r"\b720p\b")
        .expect("valid 720 regex")
        .is_match(&stream_text)
    {
        return 720;
    }
    if Regex::new(r"\b(480p|sd)\b")
        .expect("valid 480 regex")
        .is_match(&stream_text)
    {
        return 480;
    }
    0
}

fn infer_stream_container_label(stream: &TorrentioStream) -> String {
    let stream_text = [
        stream.behaviorHints.filename.as_str(),
        stream.title.as_str(),
        stream.name.as_str(),
        stream.description.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    if stream_text.is_empty() {
        return String::new();
    }
    if stream_text.contains(".mp4") {
        return "mp4".to_owned();
    }
    if stream_text.contains(".mkv") {
        return "mkv".to_owned();
    }
    if stream_text.contains(".avi") {
        return "avi".to_owned();
    }
    if stream_text.contains(".wmv") {
        return "wmv".to_owned();
    }
    if stream_text.contains(".m3u8") {
        return "m3u8".to_owned();
    }
    if stream_text.contains(".ts") {
        return "ts".to_owned();
    }
    String::new()
}

fn is_stream_likely_container(stream: &TorrentioStream, container: &str) -> bool {
    let inferred = infer_stream_container_label(stream);
    if !inferred.is_empty() {
        return inferred == container;
    }
    false
}

fn matches_source_language_filter(stream: &TorrentioStream, source_language: &str) -> bool {
    let safe_source_language = normalize_source_language_filter(source_language);
    if safe_source_language == "any" {
        return true;
    }
    let matched = get_detected_stream_languages(stream);
    if matched.contains(&safe_source_language) {
        return matched.len() == 1;
    }
    safe_source_language == SOURCE_LANGUAGE_FILTER_DEFAULT && matched.is_empty()
}

fn get_detected_stream_languages(stream: &TorrentioStream) -> HashSet<String> {
    let stream_text_raw = build_stream_text_raw(stream);
    let normalized_stream_text = normalize_text_for_match(&stream_text_raw);
    let stream_text = format!(" {} ", normalized_stream_text.trim());
    let mut matched = HashSet::new();
    if stream_text.trim().is_empty() {
        return matched;
    }
    for lang in ["en", "fr", "es", "de", "it", "pt"] {
        let has_match = audio_language_tokens(lang).iter().any(|token| {
            let normalized = normalize_text_for_match(token);
            !normalized.is_empty() && stream_text.contains(&format!(" {normalized} "))
        });
        if has_match {
            matched.insert(lang.to_owned());
        }
    }
    matched
}

fn extract_stream_title_lines(stream: &TorrentioStream) -> Vec<String> {
    stream
        .title
        .lines()
        .map(normalize_whitespace)
        .filter(|line| !line.is_empty())
        .collect()
}

fn extract_stream_size_label(stream: &TorrentioStream) -> String {
    STREAM_SIZE_RE
        .captures(&stream.title)
        .and_then(|captures| captures.get(1))
        .map(|value| normalize_whitespace(value.as_str()))
        .unwrap_or_default()
}

fn extract_stream_release_group(stream: &TorrentioStream) -> String {
    STREAM_RELEASE_GROUP_RE
        .captures(&stream.title)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            normalize_whitespace(value.as_str())
                .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
                .to_owned()
        })
        .unwrap_or_default()
}

fn parse_seed_count(stream_title: &str) -> i64 {
    SEED_COUNT_RE
        .captures(stream_title)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            value
                .as_str()
                .chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<i64>()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

fn normalize_source_hash(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.len() == 40 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        normalized
    } else {
        String::new()
    }
}

fn get_stream_info_hash(stream: &TorrentioStream) -> String {
    normalize_source_hash(&stream.infoHash)
}

fn normalize_preferred_container(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "mp4" => "mp4".to_owned(),
        "mkv" => "mkv".to_owned(),
        _ => "auto".to_owned(),
    }
}

fn normalize_minimum_seeders(value: &str) -> i64 {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .unwrap_or_default()
        .clamp(0, 50_000)
}

fn normalize_allowed_formats(value: &str) -> Vec<String> {
    let normalized = value
        .split([',', ' '])
        .filter_map(|item| {
            let normalized = item.trim().to_lowercase();
            if matches!(normalized.as_str(), "mp4") {
                Some(normalized)
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();
    let mut next = normalized.into_iter().collect::<Vec<_>>();
    next.sort();
    next
}

fn normalize_source_language_filter(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "en" | "eng" | "english" => SOURCE_LANGUAGE_FILTER_DEFAULT.to_owned(),
        "any" | "all" | "auto" | "*" => "any".to_owned(),
        "fr" | "es" | "de" | "it" | "pt" => value.trim().to_lowercase(),
        _ => SOURCE_LANGUAGE_FILTER_DEFAULT.to_owned(),
    }
}

fn normalize_source_audio_profile_filter(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "single" | "single-audio" | "single_audio" | "singleaudio" | "preferred" => {
            SOURCE_AUDIO_PROFILE_DEFAULT.to_owned()
        }
        "any" | "all" | "multi" | "multi-audio" | "multi_audio" | "multiaudio" => "any".to_owned(),
        _ => SOURCE_AUDIO_PROFILE_DEFAULT.to_owned(),
    }
}

fn compute_source_health_score(stats: &SourceHealthStats) -> i64 {
    let attempts = stats.success_count + stats.failure_count;
    if attempts <= 0 {
        return 0;
    }
    let success_rate = stats.success_count as f64 / attempts as f64;
    let confidence_factor = (attempts as f64 / 6.0).min(1.0);
    let mut score = ((success_rate - 0.55) * 2800.0 * confidence_factor).round() as i64;
    score -= (stats.decode_failure_count * 800).min(2400);
    score -= (stats.ended_early_count * 550).min(2000);
    score -= (stats.playback_error_count * 260).min(1200);
    score
}

fn stream_quality_target(value: &str) -> i64 {
    match value {
        "2160p" => 2160,
        "1080p" => 1080,
        "720p" => 720,
        _ => 0,
    }
}

fn tokenize_title_for_match(title: &str) -> Vec<String> {
    let normalized = normalize_text_for_match(title);
    if normalized.is_empty() {
        return Vec::new();
    }
    normalized
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !title_match_stopwords().contains(*token))
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_text_for_match(value: &str) -> String {
    Regex::new(r"[^a-z0-9]+")
        .expect("valid text normalize regex")
        .replace_all(&value.to_lowercase(), " ")
        .trim()
        .to_owned()
}

fn normalize_episode_ordinal(value: &str, fallback: i64) -> i64 {
    value.trim().parse::<i64>().ok().unwrap_or(fallback).max(1)
}

fn count_matching_title_tokens(normalized_value: &str, title_tokens: &[String]) -> usize {
    if normalized_value.is_empty() || title_tokens.is_empty() {
        return 0;
    }
    let normalized_token_set = normalized_value
        .split_whitespace()
        .collect::<HashSet<_>>();
    title_tokens
        .iter()
        .filter(|token| normalized_token_set.contains(token.as_str()))
        .count()
}

fn build_stream_text(stream: &TorrentioStream) -> String {
    build_stream_text_raw(stream).to_lowercase()
}

fn build_stream_release_text(stream: &TorrentioStream) -> String {
    normalize_text_for_match(
        &[
            stream.name.as_str(),
            stream.title.as_str(),
            stream.description.as_str(),
        ]
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" "),
    )
}

fn build_stream_text_raw(stream: &TorrentioStream) -> String {
    [
        stream.name.as_str(),
        stream.title.as_str(),
        stream.description.as_str(),
        stream.behaviorHints.filename.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_explicit_multi_audio_marker(stream: &TorrentioStream) -> bool {
    let release_text = build_stream_release_text(stream);
    !release_text.is_empty() && MULTI_AUDIO_RELEASE_RE.is_match(&release_text)
}

fn build_torrentio_stream_cache_key(base_url: &str, path: &str) -> String {
    format!(
        "torrentio:{}{}",
        base_url.trim().trim_end_matches('/'),
        path.trim()
    )
}

fn build_rd_torrent_cache_key(info_hash: &str) -> String {
    format!("rd-torrent:{}", normalize_source_hash(info_hash))
}

fn parse_torrentio_streams_payload(payload: &Value) -> AppResult<Vec<TorrentioStream>> {
    let streams = payload
        .get("streams")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    serde_json::from_value::<Vec<TorrentioStream>>(streams)
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn compute_torrentio_cache_deadlines(payload: &Value) -> (i64, i64) {
    let now = now_ms();
    let fresh_seconds = torrentio_cache_seconds(
        payload,
        "cacheMaxAge",
        TORRENTIO_CACHE_MAX_AGE_DEFAULT_SECONDS,
    );
    let stale_seconds = torrentio_cache_seconds(
        payload,
        "staleError",
        torrentio_cache_seconds(
            payload,
            "staleRevalidate",
            TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS,
        ),
    )
    .max(torrentio_cache_seconds(
        payload,
        "staleRevalidate",
        TORRENTIO_CACHE_STALE_WINDOW_DEFAULT_SECONDS,
    ));
    let next_validation_at = now + fresh_seconds.max(1) * 1_000;
    let expires_at = next_validation_at + stale_seconds.max(0) * 1_000;
    (expires_at.max(next_validation_at), next_validation_at)
}

fn torrentio_cache_seconds(payload: &Value, key: &str, default_seconds: i64) -> i64 {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(default_seconds)
        .max(0)
}

fn map_reqwest_error(error: reqwest::Error, timeout_message: &str) -> ApiError {
    if error.is_timeout() {
        ApiError::internal(timeout_message)
    } else {
        ApiError::internal(error.to_string())
    }
}

fn is_retryable_torrentio_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429) || status.is_server_error()
}

fn is_retryable_torrentio_transport_error(error: &reqwest::Error) -> bool {
    error.is_connect()
}

fn stringify_json(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => {
            if *value {
                "true".to_owned()
            } else {
                "false".to_owned()
            }
        }
        _ => String::new(),
    }
}

fn title_match_stopwords() -> &'static HashSet<&'static str> {
    static STOPWORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        [
            "the", "a", "an", "and", "of", "in", "on", "to", "for", "vs", "v", "movie", "film",
        ]
        .into_iter()
        .collect()
    });
    &STOPWORDS
}

fn audio_language_tokens(lang: &str) -> &'static [&'static str] {
    match lang {
        "en" => &[
            "english",
            " eng ",
            "eng-",
            "eng]",
            "eng)",
            "en audio",
            "dubbed english",
        ],
        "fr" => &["french", " fran", "fra ", " fr ", "vf", "vff"],
        "es" => &["spanish", "espanol", "castellano", " spa ", "esp "],
        "de" => &["german", " deutsch", " ger ", "deu "],
        "it" => &["italian", " italiano", " ita "],
        "pt" => &["portuguese", " portugues", " por ", "pt-br", "brazilian"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlayableUrlVerification {
    Verified,
    Uncertain,
}

fn build_magnet_uri(stream: &TorrentioStream, fallback_name: &str) -> AppResult<String> {
    let info_hash = get_stream_info_hash(stream);
    if info_hash.is_empty() {
        return Err(ApiError::internal("Missing torrent info hash."));
    }
    let source_trackers = stream
        .sources
        .iter()
        .filter_map(|source| source.strip_prefix("tracker:"))
        .filter(|tracker| !tracker.trim().is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut trackers = source_trackers;
    for tracker in DEFAULT_TRACKERS {
        if !trackers.iter().any(|existing| existing == tracker) {
            trackers.push((*tracker).to_owned());
        }
    }

    let mut parts = vec![format!("xt=urn:btih:{info_hash}")];
    if !fallback_name.trim().is_empty() {
        parts.push(format!(
            "dn={}",
            url::form_urlencoded::byte_serialize(fallback_name.trim().as_bytes())
                .collect::<String>()
        ));
    }
    for tracker in trackers {
        parts.push(format!(
            "tr={}",
            url::form_urlencoded::byte_serialize(tracker.as_bytes()).collect::<String>()
        ));
    }
    Ok(format!("magnet:?{}", parts.join("&")))
}

fn pick_video_file_ids(files: &[Value], preferred_filename: &str, fallback_name: &str) -> Vec<i64> {
    let list = files
        .iter()
        .filter_map(|file| {
            let id = file.get("id").and_then(Value::as_i64)?;
            let path = stringify_json(file.get("path"));
            let bytes = file
                .get("bytes")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            Some((id, path, bytes))
        })
        .collect::<Vec<_>>();
    if list.is_empty() {
        return Vec::new();
    }
    let video_files = list
        .iter()
        .filter(|(_, path, _)| is_supported_resolved_container_path(path))
        .cloned()
        .collect::<Vec<_>>();
    if video_files.is_empty() {
        return Vec::new();
    }
    let preferred_needle = preferred_filename.trim().to_lowercase();
    if !preferred_needle.is_empty()
        && let Some((id, _, _)) = video_files
            .iter()
            .find(|(_, path, _)| path.to_lowercase().contains(&preferred_needle))
    {
        return vec![*id];
    }

    let fallback_episode_signatures = collect_episode_signatures(fallback_name, None);
    let fallback_season_hint = fallback_episode_signatures
        .first()
        .and_then(|signature| signature.split('x').next())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    if !fallback_episode_signatures.is_empty()
        && let Some((id, _, _)) = video_files.iter().find(|(_, path, _)| {
            let file_signatures = collect_episode_signatures(
                path,
                (fallback_season_hint > 0).then_some(fallback_season_hint),
            );
            !file_signatures.is_empty()
                && fallback_episode_signatures
                    .iter()
                    .any(|signature| file_signatures.contains(signature))
        })
    {
        return vec![*id];
    }

    video_files
        .iter()
        .max_by_key(|(_, path, bytes)| (container_preference_rank(path), *bytes))
        .map(|(id, _, _)| vec![*id])
        .unwrap_or_default()
}

fn has_url_like_container_extension(value: &str, container: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    match container {
        "mp4" => Regex::new(r"\.mp4(?:$|[?#&/])")
            .expect("valid mp4 regex")
            .is_match(&normalized),
        "mkv" => Regex::new(r"\.mkv(?:$|[?#&/])")
            .expect("valid mkv regex")
            .is_match(&normalized),
        _ => false,
    }
}

fn is_supported_resolved_container_path(value: &str) -> bool {
    DEFAULT_ALLOWED_SOURCE_FORMATS
        .iter()
        .any(|container| has_url_like_container_extension(value, container))
}

fn container_preference_rank(path: &str) -> i64 {
    if has_url_like_container_extension(path, "mp4") {
        1
    } else {
        0
    }
}

fn resolve_effective_preferred_subtitle_lang(
    stored_preferred_subtitle_lang: &str,
    preferred_subtitle_lang: &str,
) -> String {
    let normalized = normalize_subtitle_preference(preferred_subtitle_lang);
    if !normalized.is_empty() {
        return normalized;
    }
    normalize_subtitle_preference(stored_preferred_subtitle_lang)
}

fn should_skip_playback_session_reuse(filters: &ResolveFilters) -> bool {
    !filters.source_hash.is_empty()
        || filters.source_filters.min_seeders > 0
        || !filters.source_filters.allowed_formats.is_empty()
        || filters.source_filters.source_language != SOURCE_LANGUAGE_FILTER_DEFAULT
        || filters.source_filters.source_audio_profile != SOURCE_AUDIO_PROFILE_DEFAULT
}

fn looks_like_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn build_playback_session_key(tmdb_id: &str, audio_lang: &str, quality: &str) -> String {
    format!(
        "{}:{}:{}",
        tmdb_id.trim(),
        normalize_preferred_audio_lang(audio_lang),
        normalize_preferred_stream_quality(quality)
    )
}

fn build_playback_session_payload(session: &PlaybackSession) -> Value {
    json!({
        "key": session.session_key.clone(),
        "sourceHash": session.source_hash.clone(),
        "selectedFile": session.selected_file.clone(),
        "quality": normalize_preferred_stream_quality(&session.preferred_quality),
        "lastPositionSeconds": session.last_position_seconds,
        "health": {
            "state": session.health_state.clone(),
            "failCount": session.health_fail_count,
            "lastError": session.last_error.clone()
        }
    })
}

fn build_pending_playback_session_payload(
    session_key: &str,
    source_hash: &str,
    selected_file: &str,
    preferred_quality: &str,
) -> Value {
    json!({
        "key": session_key,
        "sourceHash": source_hash,
        "selectedFile": selected_file,
        "quality": normalize_preferred_stream_quality(preferred_quality),
        "lastPositionSeconds": 0,
        "health": {
            "state": "unknown",
            "failCount": 0,
            "lastError": ""
        }
    })
}

fn build_resolved_metadata_payload(
    metadata: &ResolveMetadata,
    resolved: &ResolvedSource,
    filename: &str,
) -> Value {
    let subtitle_target_file_path = resolved.selected_file_path.trim().to_owned();
    let subtitle_target_filename = normalize_whitespace(filename);
    let subtitle_target_name = if !subtitle_target_file_path.is_empty() {
        subtitle_target_file_path.clone()
    } else {
        subtitle_target_filename.clone()
    };
    json!({
        "tmdbId": metadata.tmdb_id.clone(),
        "imdbId": metadata.imdb_id.clone(),
        "displayTitle": metadata.display_title.clone(),
        "displayYear": metadata.display_year.clone(),
        "runtimeSeconds": metadata.runtime_seconds,
        "seasonNumber": metadata.season_number,
        "episodeNumber": metadata.episode_number,
        "episodeTitle": metadata.episode_title.clone(),
        "mediaType": metadata.media_type.clone(),
        "subtitleTargetName": subtitle_target_name,
        "subtitleTargetFilename": subtitle_target_filename,
        "subtitleTargetFilePath": subtitle_target_file_path
    })
}

fn playback_session_selected_file_path(session: &PlaybackSession) -> String {
    stringify_json(session.metadata.get("subtitleTargetFilePath"))
}

fn playback_session_match_name(session: &PlaybackSession) -> String {
    let selected_file_path = playback_session_selected_file_path(session);
    if !selected_file_path.is_empty() {
        selected_file_path
    } else {
        session.filename.clone()
    }
}

fn does_filename_likely_match_movie(filename: &str, movie_title: &str, movie_year: &str) -> bool {
    let normalized_filename = normalize_text_for_match(filename);
    if normalized_filename.is_empty() {
        return true;
    }
    let title_tokens = tokenize_title_for_match(movie_title);
    if title_tokens.is_empty() {
        return true;
    }
    let expected_year = movie_year.trim();
    let year_matches_in_filename = Regex::new(r"\b(?:19|20)\d{2}\b")
        .expect("valid year regex")
        .find_iter(&normalized_filename)
        .map(|value| value.as_str().to_owned())
        .collect::<Vec<_>>();
    let has_expected_year = !expected_year.is_empty()
        && year_matches_in_filename
            .iter()
            .any(|value| value == expected_year);
    let has_conflicting_year =
        !expected_year.is_empty() && !year_matches_in_filename.is_empty() && !has_expected_year;
    let matched_token_count = count_matching_title_tokens(&normalized_filename, &title_tokens);
    let required_matches = if title_tokens.len() == 1 {
        1
    } else {
        title_tokens.len().min(2)
    };
    if matched_token_count >= required_matches {
        if expected_year.is_empty() {
            return true;
        }
        if has_expected_year {
            return true;
        }
        return !has_conflicting_year;
    }
    matched_token_count >= 1 && has_expected_year
}

fn does_filename_likely_match_tv_episode(
    filename: &str,
    show_title: &str,
    show_year: &str,
    season_number: i64,
    episode_number: i64,
) -> bool {
    let normalized_filename = normalize_text_for_match(filename);
    if normalized_filename.is_empty() {
        return true;
    }
    let target_signature = build_episode_signature(season_number, episode_number);
    let episode_signatures = collect_episode_signatures(&normalized_filename, Some(season_number));
    if !episode_signatures.is_empty() {
        return episode_signatures.contains(&target_signature);
    }
    let title_tokens = tokenize_title_for_match(show_title);
    if title_tokens.is_empty() {
        return true;
    }
    let expected_year = show_year.trim();
    let year_matches_in_filename = Regex::new(r"\b(?:19|20)\d{2}\b")
        .expect("valid year regex")
        .find_iter(&normalized_filename)
        .map(|value| value.as_str().to_owned())
        .collect::<Vec<_>>();
    let has_expected_year = !expected_year.is_empty()
        && year_matches_in_filename
            .iter()
            .any(|value| value == expected_year);
    let has_conflicting_year =
        !expected_year.is_empty() && !year_matches_in_filename.is_empty() && !has_expected_year;
    let matched_token_count = count_matching_title_tokens(&normalized_filename, &title_tokens);
    let required_matches = if title_tokens.len() == 1 {
        1
    } else {
        title_tokens.len().min(2)
    };
    if matched_token_count >= required_matches {
        if expected_year.is_empty() {
            return true;
        }
        if has_expected_year {
            return true;
        }
        return !has_conflicting_year;
    }
    matched_token_count >= 1 && has_expected_year
}

fn stream_candidate_match_name(stream: &TorrentioStream) -> String {
    let filename = normalize_whitespace(&stream.behaviorHints.filename);
    if !filename.is_empty() {
        return filename;
    }
    if let Some(line) = extract_stream_title_lines(stream).first() {
        return line.clone();
    }
    let title = normalize_whitespace(&stream.title);
    if !title.is_empty() {
        return title;
    }
    let name = normalize_whitespace(&stream.name);
    if !name.is_empty() {
        return name;
    }
    normalize_whitespace(&stream.description)
}

fn prefer_movie_title_matched_candidates<'a>(
    streams: Vec<&'a TorrentioStream>,
    metadata: &ResolveMetadata,
) -> Vec<&'a TorrentioStream> {
    let matched = streams
        .iter()
        .copied()
        .filter(|stream| {
            does_filename_likely_match_movie(
                &stream_candidate_match_name(stream),
                &metadata.display_title,
                &metadata.display_year,
            )
        })
        .collect::<Vec<_>>();
    if matched.is_empty() { streams } else { matched }
}

fn prefer_episode_title_matched_candidates<'a>(
    streams: Vec<&'a TorrentioStream>,
    metadata: &ResolveMetadata,
) -> Vec<&'a TorrentioStream> {
    let matched = streams
        .iter()
        .copied()
        .filter(|stream| {
            does_filename_likely_match_tv_episode(
                &stream_candidate_match_name(stream),
                &metadata.display_title,
                &metadata.display_year,
                metadata.season_number,
                metadata.episode_number,
            )
        })
        .collect::<Vec<_>>();
    if matched.is_empty() { streams } else { matched }
}

fn should_force_remux_for_audio_compatibility(
    probe: &MediaProbe,
    preferred_audio_stream_index: i64,
) -> bool {
    if probe.audioTracks.is_empty() {
        return false;
    }
    if preferred_audio_stream_index >= 0 {
        return probe
            .audioTracks
            .iter()
            .find(|track| track.streamIndex == preferred_audio_stream_index)
            .map(|track| !is_browser_safe_audio_codec(&track.codec))
            .unwrap_or(true);
    }
    probe
        .audioTracks
        .iter()
        .find(|track| track.isDefault)
        .or_else(|| probe.audioTracks.first())
        .map(|track| !is_browser_safe_audio_codec(&track.codec))
        .unwrap_or(false)
}

fn get_fallback_audio_stream_index(probe: &MediaProbe) -> i64 {
    probe
        .audioTracks
        .iter()
        .find(|track| track.isDefault)
        .or_else(|| probe.audioTracks.first())
        .map(|track| track.streamIndex)
        .unwrap_or(-1)
}

fn is_browser_safe_audio_codec(codec: &str) -> bool {
    let normalized = codec.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if BROWSER_SAFE_AUDIO_CODECS.contains(&normalized.as_str()) {
        return true;
    }
    !BROWSER_UNSAFE_AUDIO_CODEC_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
}

fn is_likely_html5_playable_url(playable_url: &str, filename: &str) -> bool {
    let value = playable_url.to_lowercase();
    let normalized_filename = filename.to_lowercase();
    if value.is_empty() {
        return false;
    }
    if normalized_filename.ends_with(".mkv")
        || normalized_filename.ends_with(".avi")
        || normalized_filename.ends_with(".wmv")
        || normalized_filename.ends_with(".ts")
        || normalized_filename.ends_with(".m3u8")
    {
        return false;
    }
    ![".m3u8", ".mkv", ".avi", ".wmv", ".ts"]
        .iter()
        .any(|needle| value.contains(needle))
}

fn should_prefer_software_decode(source: &str) -> bool {
    let value = source.to_lowercase();
    [".mkv", ".avi", ".wmv", ".ts", ".m3u8"]
        .iter()
        .any(|needle| value.contains(needle))
}

fn should_prefer_software_decode_source(source: &str, filename: &str) -> bool {
    let normalized_source = source.to_lowercase();
    if normalized_source.contains("download.real-debrid.com") {
        return !is_likely_html5_playable_url(source, filename);
    }
    if should_prefer_software_decode(source) {
        return true;
    }
    let normalized_filename = filename.to_lowercase();
    if is_likely_html5_playable_url(source, &normalized_filename) {
        return false;
    }
    [".mkv", ".avi", ".wmv", ".ts", ".m3u8"]
        .iter()
        .any(|needle| normalized_filename.ends_with(needle))
}

fn is_playback_proxy_url(value: &str) -> bool {
    let raw = value.trim().to_lowercase();
    raw.starts_with("/api/remux?") || raw.starts_with("/api/hls/master.m3u8?")
}

#[derive(Debug, Clone)]
struct PlaybackProxyMeta {
    input: String,
    audio_stream_index: i64,
    subtitle_stream_index: i64,
}

fn parse_playback_proxy_url(value: &str) -> Option<PlaybackProxyMeta> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let url = url::Url::parse(raw)
        .or_else(|_| url::Url::parse(&format!("http://localhost{raw}")))
        .ok()?;
    if !matches!(url.path(), "/api/remux" | "/api/hls/master.m3u8") {
        return None;
    }
    let input = url
        .query_pairs()
        .find_map(|(key, value)| (key == "input").then(|| value.into_owned()))
        .unwrap_or_default();
    if input.trim().is_empty() {
        return None;
    }
    let audio_stream_index = url
        .query_pairs()
        .find_map(|(key, value)| (key == "audioStream").then(|| value.into_owned()))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let subtitle_stream_index = url
        .query_pairs()
        .find_map(|(key, value)| (key == "subtitleStream").then(|| value.into_owned()))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    Some(PlaybackProxyMeta {
        input,
        audio_stream_index,
        subtitle_stream_index,
    })
}

fn normalize_internal_subtitle_stream_index(value: i64) -> i64 {
    if value < 0 {
        return -1;
    }
    let safe = value;
    if safe >= EXTERNAL_SUBTITLE_STREAM_INDEX_BASE {
        -1
    } else {
        safe
    }
}

fn build_remux_proxy_url(
    input: &str,
    audio_stream_index: i64,
    subtitle_stream_index: i64,
) -> String {
    let normalized_input = input.trim();
    if normalized_input.is_empty() {
        return String::new();
    }
    let existing_meta = parse_playback_proxy_url(normalized_input);
    let resolved_audio_stream_index = if audio_stream_index >= 0 {
        audio_stream_index
    } else {
        existing_meta
            .as_ref()
            .map(|meta| meta.audio_stream_index)
            .unwrap_or(-1)
    };
    let requested_subtitle_stream_index =
        normalize_internal_subtitle_stream_index(subtitle_stream_index);
    let fallback_subtitle_stream_index = existing_meta
        .as_ref()
        .map(|meta| normalize_internal_subtitle_stream_index(meta.subtitle_stream_index))
        .unwrap_or(-1);
    let resolved_subtitle_stream_index = if requested_subtitle_stream_index >= 0 {
        requested_subtitle_stream_index
    } else {
        fallback_subtitle_stream_index
    };
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair(
        "input",
        existing_meta
            .as_ref()
            .map(|meta| meta.input.as_str())
            .unwrap_or(normalized_input),
    );
    if resolved_audio_stream_index >= 0 {
        serializer.append_pair("audioStream", &resolved_audio_stream_index.to_string());
    }
    if resolved_subtitle_stream_index >= 0 {
        serializer.append_pair(
            "subtitleStream",
            &resolved_subtitle_stream_index.to_string(),
        );
    }
    format!("/api/remux?{}", serializer.finish())
}

fn extract_playable_source_input(source_url: &str) -> String {
    parse_playback_proxy_url(source_url)
        .map(|meta| meta.input)
        .unwrap_or_else(|| source_url.trim().to_owned())
}

fn normalize_resolved_source_for_software_decode(
    source: &ResolvedSource,
    audio_stream_index: i64,
    subtitle_stream_index: i64,
) -> ResolvedSource {
    let mut normalized = source.clone();
    let current_playable = normalized.playable_url.trim().to_owned();
    if current_playable.is_empty() {
        return normalized;
    }
    let has_explicit_audio_selection = audio_stream_index >= 0;
    let normalized_subtitle_stream_index =
        normalize_internal_subtitle_stream_index(subtitle_stream_index);
    let has_explicit_subtitle_selection = normalized_subtitle_stream_index >= 0;
    if !has_explicit_audio_selection
        && !has_explicit_subtitle_selection
        && !should_prefer_software_decode_source(&current_playable, &normalized.filename)
    {
        return normalized;
    }
    let proxy_meta = if is_playback_proxy_url(&current_playable) {
        parse_playback_proxy_url(&current_playable)
    } else {
        None
    };
    let source_input = proxy_meta
        .as_ref()
        .map(|meta| meta.input.as_str())
        .unwrap_or(&current_playable);
    let preferred_remux = build_remux_proxy_url(
        source_input,
        audio_stream_index,
        normalized_subtitle_stream_index,
    );
    if preferred_remux.is_empty() {
        return normalized;
    }
    let mut next_fallbacks = Vec::new();
    push_unique_url(&mut next_fallbacks, &current_playable);
    if source_input != current_playable {
        push_unique_url(&mut next_fallbacks, source_input);
    }
    for url in &normalized.fallback_urls {
        if url != &preferred_remux {
            push_unique_url(&mut next_fallbacks, url);
        }
    }
    normalized.playable_url = preferred_remux;
    normalized.fallback_urls = next_fallbacks;
    normalized
}

fn push_unique_url(target: &mut Vec<String>, value: &str) {
    if value.trim().is_empty() || target.iter().any(|existing| existing == value) {
        return;
    }
    target.push(value.to_owned());
}


trait IfEmptyThen {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String;
}

impl IfEmptyThen for String {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::{
        ResolveMetadata, SourceFilters, TorrentioBehaviorHints, TorrentioStream,
        build_rd_torrent_cache_key, build_torrentio_stream_cache_key, collect_episode_signatures,
        compute_torrentio_cache_deadlines, normalize_allowed_formats,
        does_filename_likely_match_movie, normalize_source_audio_profile_filter,
        normalize_source_hash, now_ms, parse_runtime_from_label_seconds, parse_seed_count,
        select_top_movie_candidates, sort_movie_candidates,
    };

    #[test]
    fn normalizes_source_hashes() {
        assert_eq!(
            normalize_source_hash("0123456789abcdef0123456789abcdef01234567"),
            "0123456789abcdef0123456789abcdef01234567"
        );
        assert!(normalize_source_hash("bad-hash").is_empty());
    }

    #[test]
    fn parses_seed_counts() {
        assert_eq!(parse_seed_count("Torrent 👤 1,234"), 1234);
    }

    #[test]
    fn normalizes_allowed_formats_to_supported_video_containers() {
        assert_eq!(normalize_allowed_formats("mkv, mp4 avi"), vec!["mp4"]);
    }

    #[test]
    fn parses_runtime_labels() {
        assert_eq!(parse_runtime_from_label_seconds("2h 10m"), 7800);
        assert_eq!(parse_runtime_from_label_seconds("01:45:00"), 6300);
    }

    #[test]
    fn collects_episode_signatures_from_common_labels() {
        assert_eq!(
            collect_episode_signatures("Show.S02E07.1080p", Some(2)),
            vec!["2x7"]
        );
    }

    #[test]
    fn extracts_stream_filename() {
        let stream = TorrentioStream {
            infoHash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            name: "Torrentio".to_owned(),
            title: String::new(),
            description: String::new(),
            behaviorHints: TorrentioBehaviorHints {
                filename: "Movie.2024.mp4".to_owned(),
            },
            sources: Vec::new(),
        };
        assert_eq!(stream.behaviorHints.filename, "Movie.2024.mp4");
    }

    #[test]
    fn normalizes_torrentio_stream_cache_keys() {
        assert_eq!(
            build_torrentio_stream_cache_key(
                "https://torrentio.strem.fun/",
                "/stream/movie/tt1.json"
            ),
            "torrentio:https://torrentio.strem.fun/stream/movie/tt1.json"
        );
    }

    #[test]
    fn normalizes_rd_torrent_cache_keys() {
        assert_eq!(
            build_rd_torrent_cache_key("ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
            "rd-torrent:abcdef0123456789abcdef0123456789abcdef01"
        );
    }

    #[test]
    fn computes_torrentio_cache_deadlines_from_payload() {
        let before = now_ms();
        let payload = json!({
            "cacheMaxAge": 60,
            "staleRevalidate": 120,
            "staleError": 300
        });
        let (expires_at, next_validation_at) = compute_torrentio_cache_deadlines(&payload);
        assert!(next_validation_at >= before + 60_000);
        assert!(expires_at >= next_validation_at + 300_000);
    }

    fn sample_movie_metadata() -> ResolveMetadata {
        ResolveMetadata {
            tmdb_id: "1368166".to_owned(),
            imdb_id: "tt0000001".to_owned(),
            display_title: "The Housemaid".to_owned(),
            display_year: "2025".to_owned(),
            runtime_seconds: 6_720,
            season_number: 0,
            episode_number: 0,
            episode_title: String::new(),
            media_type: "movie".to_owned(),
        }
    }

    fn sample_stream(title: &str, info_hash: &str) -> TorrentioStream {
        TorrentioStream {
            infoHash: info_hash.to_owned(),
            name: "Torrentio".to_owned(),
            title: title.to_owned(),
            description: "English audio • 1h 52m • 👤 950".to_owned(),
            behaviorHints: TorrentioBehaviorHints::default(),
            sources: Vec::new(),
        }
    }

    fn sample_source_filters() -> SourceFilters {
        SourceFilters {
            min_seeders: 0,
            allowed_formats: Vec::new(),
            source_language: "en".to_owned(),
            source_audio_profile: "single".to_owned(),
        }
    }

    #[test]
    fn deprioritizes_ts_releases_against_comparable_web_sources() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::from([
            ("1111111111111111111111111111111111111111".to_owned(), 1200),
            ("2222222222222222222222222222222222222222".to_owned(), 0),
        ]);
        let ts = sample_stream(
            "The Housemaid 2025 1080p TS EN-RGB\n⚙ TS-GROUP",
            "1111111111111111111111111111111111111111",
        );
        let web = sample_stream(
            "The Housemaid 2025 1080p AMZN WEB-DL DDP5.1 H.264-BYNDR\n⚙ BYNDR",
            "2222222222222222222222222222222222222222",
        );

        let ranked = sort_movie_candidates(
            vec![&ts, &web],
            &metadata,
            "en",
            "auto",
            &sample_source_filters(),
            &health_scores,
        );

        assert_eq!(ranked[0].infoHash, web.infoHash);
        assert_eq!(ranked[1].infoHash, ts.infoHash);
    }

    #[test]
    fn prefers_single_audio_release_over_explicit_multi_audio_pack() {
        let metadata = sample_movie_metadata();
        let health_scores = HashMap::new();
        let single_audio = sample_stream(
            "The Housemaid 2025 1080p AMZN WEB-DL English\n⚙ BYNDR",
            "3333333333333333333333333333333333333333",
        );
        let multi_audio = sample_stream(
            "The Housemaid 2025 1080p AMZN WEB-DL Multi Audio English\n⚙ PACK",
            "4444444444444444444444444444444444444444",
        );

        let ranked = sort_movie_candidates(
            vec![&multi_audio, &single_audio],
            &metadata,
            "auto",
            "auto",
            &sample_source_filters(),
            &health_scores,
        );

        assert_eq!(ranked[0].infoHash, single_audio.infoHash);
        assert_eq!(ranked[1].infoHash, multi_audio.infoHash);
    }

    #[test]
    fn filename_match_does_not_treat_webrip_suffix_as_title_match() {
        assert!(does_filename_likely_match_movie(
            "The.Rip.2026.1080p.WEBRip.x265.10bit.AAC5.1-[YTS.BZ].mp4",
            "The Rip",
            "2026"
        ));
        assert!(!does_filename_likely_match_movie(
            r#"2024-10-10 - "Multiple Alien Groups May Be Visiting Earth!" (Lue Elizondo Documentary).mp4"#,
            "The Rip",
            "2026"
        ));
    }

    #[test]
    fn filters_unrelated_sources_for_short_movie_titles() {
        let mut metadata = sample_movie_metadata();
        metadata.display_title = "The Rip".to_owned();
        metadata.display_year = "2026".to_owned();

        let good = sample_stream(
            "The.Rip.2026.1080p.WEBRip.x265.10bit.AAC5.1-[YTS.BZ].mp4\n👤 604",
            "5555555555555555555555555555555555555555",
        );
        let unrelated = sample_stream(
            r#"2024-10-10 - "Multiple Alien Groups May Be Visiting Earth!" (Lue Elizondo Documentary).mp4
👤 999"#,
            "6666666666666666666666666666666666666666",
        );

        let streams = vec![good.clone(), unrelated.clone()];
        let selected = select_top_movie_candidates(
            &streams,
            &metadata,
            "en",
            "1080p",
            "",
            5,
            &sample_source_filters(),
            &HashMap::new(),
        );

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].infoHash, good.infoHash);
    }

    #[test]
    fn normalizes_source_audio_profile_to_single_by_default() {
        assert_eq!(normalize_source_audio_profile_filter(""), "single");
        assert_eq!(
            normalize_source_audio_profile_filter("single-audio"),
            "single"
        );
        assert_eq!(normalize_source_audio_profile_filter("multi-audio"), "any");
    }
}
