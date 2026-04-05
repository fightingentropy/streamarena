use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::task;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::routes::{
    normalize_preferred_audio_lang, normalize_preferred_stream_quality,
    normalize_session_health_state, normalize_subtitle_preference,
};

const TITLE_PREFERENCES_STALE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const PLAYBACK_SESSION_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const PLAYBACK_SESSION_VALIDATE_INTERVAL_MS: i64 = 90 * 1000;
const SOURCE_HEALTH_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MEDIA_PROBE_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const TMDB_RESPONSE_PERSIST_MAX_ENTRIES: i64 = 6000;
const PLAYBACK_SESSION_PERSIST_MAX_ENTRIES: i64 = 2500;
const RESOLVED_STREAM_PERSIST_MAX_ENTRIES: i64 = 6000;
const MOVIE_QUICK_START_PERSIST_MAX_ENTRIES: i64 = 1200;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;

#[derive(Clone)]
pub struct Db {
    path: Arc<PathBuf>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize)]
pub struct CacheCounts {
    pub tmdb_response_size: i64,
    pub playback_session_size: i64,
    pub resolved_stream_size: i64,
    pub movie_quick_start_size: i64,
    pub source_health_size: i64,
    pub media_probe_size: i64,
    pub title_preference_size: i64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitlePreference {
    pub audioLang: String,
    pub subtitleLang: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct PlaybackSession {
    pub session_key: String,
    pub tmdb_id: String,
    pub audio_lang: String,
    pub preferred_quality: String,
    pub source_hash: String,
    pub selected_file: String,
    pub filename: String,
    pub playable_url: String,
    pub fallback_urls: Vec<String>,
    pub metadata: Value,
    pub last_position_seconds: f64,
    pub health_state: String,
    pub health_fail_count: i64,
    pub last_error: String,
    pub last_verified_at: i64,
    pub next_validation_at: i64,
}

#[derive(Debug, Clone)]
pub struct PersistPlaybackSessionInput {
    pub session_key: String,
    pub tmdb_id: String,
    pub audio_lang: String,
    pub preferred_quality: String,
    pub source_hash: String,
    pub selected_file: String,
    pub filename: String,
    pub playable_url: String,
    pub fallback_urls: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Default)]
pub struct SourceHealthStats {
    pub success_count: i64,
    pub failure_count: i64,
    pub decode_failure_count: i64,
    pub ended_early_count: i64,
    pub playback_error_count: i64,
}

impl Db {
    pub async fn initialize(config: &Config) -> AppResult<Self> {
        let path = config.persistent_cache_db_path.clone();
        let cache_dir = config.cache_dir.clone();
        tokio::fs::create_dir_all(cache_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let path_for_task = path.clone();
        task::spawn_blocking(move || init_schema(path_for_task))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))?;

        Ok(Self {
            path: Arc::new(path),
        })
    }

    pub async fn sweep(&self) {
        let path = self.path.clone();
        let _ = task::spawn_blocking(move || sweep_db(path)).await;
    }

    pub async fn clear_persistent_caches(&self) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute_batch(
                "
                DELETE FROM resolved_stream_cache;
                DELETE FROM movie_quick_start_cache;
                DELETE FROM tmdb_response_cache;
                DELETE FROM playback_sessions;
                DELETE FROM source_health_stats;
                DELETE FROM media_probe_cache;
                DELETE FROM title_track_preferences;
                ",
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn persistent_counts(&self) -> AppResult<CacheCounts> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            Ok::<CacheCounts, rusqlite::Error>(CacheCounts {
                tmdb_response_size: table_count(&connection, "tmdb_response_cache")?,
                playback_session_size: table_count(&connection, "playback_sessions")?,
                resolved_stream_size: table_count(&connection, "resolved_stream_cache")?,
                movie_quick_start_size: table_count(&connection, "movie_quick_start_cache")?,
                source_health_size: table_count(&connection, "source_health_stats")?,
                media_probe_size: table_count(&connection, "media_probe_cache")?,
                title_preference_size: table_count(&connection, "title_track_preferences")?,
            })
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_title_preference(
        &self,
        tmdb_id: String,
    ) -> AppResult<Option<TitlePreference>> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let row = connection
                .query_row(
                    "
                    SELECT preferred_audio_lang, preferred_subtitle_lang, updated_at
                    FROM title_track_preferences
                    WHERE tmdb_id = ?
                    ",
                    [tmdb_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()?;

            let Some((audio_lang, subtitle_lang, updated_at)) = row else {
                return Ok(None);
            };
            if updated_at == 0 || updated_at + TITLE_PREFERENCES_STALE_MS <= now_ms() {
                connection.execute(
                    "DELETE FROM title_track_preferences WHERE tmdb_id = ?",
                    [tmdb_id.as_str()],
                )?;
                return Ok(None);
            }

            Ok(Some(TitlePreference {
                audioLang: normalize_preferred_audio_lang(&audio_lang),
                subtitleLang: normalize_subtitle_preference(&subtitle_lang),
            }))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn persist_title_preference(
        &self,
        tmdb_id: String,
        audio_lang: String,
        subtitle_lang: String,
    ) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let normalized_audio = normalize_preferred_audio_lang(&audio_lang);
            let normalized_subtitle = normalize_subtitle_preference(&subtitle_lang);
            connection.execute(
                "
                INSERT INTO title_track_preferences (
                  tmdb_id,
                  preferred_audio_lang,
                  preferred_subtitle_lang,
                  updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(tmdb_id) DO UPDATE SET
                  preferred_audio_lang = CASE
                    WHEN excluded.preferred_audio_lang != '' THEN excluded.preferred_audio_lang
                    ELSE title_track_preferences.preferred_audio_lang
                  END,
                  preferred_subtitle_lang = CASE
                    WHEN excluded.preferred_subtitle_lang != '' THEN excluded.preferred_subtitle_lang
                    ELSE title_track_preferences.preferred_subtitle_lang
                  END,
                  updated_at = excluded.updated_at
                ",
                params![
                    tmdb_id,
                    if normalized_audio == "auto" {
                        String::new()
                    } else {
                        normalized_audio
                    },
                    normalized_subtitle,
                    now_ms(),
                ],
            )?;
            if normalize_preferred_audio_lang(&audio_lang) != "auto" {
                for quality in ["auto", "2160p", "1080p", "720p"] {
                    let session_key = format!("{tmdb_id}:auto:{quality}");
                    let _ = connection.execute(
                        "DELETE FROM playback_sessions WHERE session_key = ?",
                        [session_key],
                    );
                }
            }
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_title_preference(&self, tmdb_id: String) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "DELETE FROM title_track_preferences WHERE tmdb_id = ?",
                [tmdb_id.as_str()],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_playback_sessions_for_tmdb(&self, tmdb_id: String) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "DELETE FROM playback_sessions WHERE tmdb_id = ?",
                [tmdb_id.as_str()],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn invalidate_all_movie_resolve_caches_for_tmdb(
        &self,
        tmdb_id: String,
    ) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "DELETE FROM movie_quick_start_cache WHERE cache_key LIKE ?",
                [format!("{tmdb_id}:%")],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_playback_session(
        &self,
        session_key: String,
    ) -> AppResult<Option<PlaybackSession>> {
        let path = self.path.clone();
        task::spawn_blocking(move || get_playback_session_inner(path, session_key))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_latest_playback_session_for_tmdb(
        &self,
        tmdb_id: String,
    ) -> AppResult<Option<PlaybackSession>> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let key = connection
                .query_row(
                    "
                    SELECT session_key
                    FROM playback_sessions
                    WHERE tmdb_id = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                    ",
                    [tmdb_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            match key {
                Some(session_key) => get_playback_session_inner(path.clone(), session_key),
                None => Ok(None),
            }
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn update_playback_session_progress(
        &self,
        session_key: String,
        position_seconds: f64,
        health_state: String,
        last_error: String,
    ) -> AppResult<bool> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let Some(existing) = get_playback_session_inner(path.clone(), session_key.clone())?
            else {
                return Ok(false);
            };
            let connection = open_connection(&path)?;
            let next_health = normalize_session_health_state(&health_state);
            let next_fail_count = if next_health == "invalid" {
                existing.health_fail_count + 1
            } else if next_health == "healthy" {
                0
            } else {
                existing.health_fail_count
            };
            let next_error = if next_health == "healthy" {
                String::new()
            } else {
                let candidate = if last_error.trim().is_empty() {
                    existing.last_error
                } else {
                    last_error
                };
                candidate.chars().take(500).collect()
            };
            connection.execute(
                "
                UPDATE playback_sessions
                SET
                  last_position_seconds = ?,
                  health_state = ?,
                  health_fail_count = ?,
                  last_error = ?,
                  updated_at = ?,
                  last_accessed_at = ?
                WHERE session_key = ?
                ",
                params![
                    position_seconds.max(0.0),
                    next_health,
                    next_fail_count,
                    next_error,
                    now_ms(),
                    now_ms(),
                    session_key,
                ],
            )?;
            Ok(true)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn refresh_playback_session_validation_window(
        &self,
        session_key: String,
    ) -> AppResult<bool> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let now = now_ms();
            let updated = connection.execute(
                "
                UPDATE playback_sessions
                SET
                  last_verified_at = ?,
                  next_validation_at = ?,
                  updated_at = ?,
                  last_accessed_at = ?
                WHERE session_key = ?
                ",
                params![
                    now,
                    now + PLAYBACK_SESSION_VALIDATE_INTERVAL_MS,
                    now,
                    now,
                    session_key,
                ],
            )?;
            Ok(updated > 0)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn persist_playback_session(
        &self,
        input: PersistPlaybackSessionInput,
    ) -> AppResult<()> {
        if input.session_key.trim().is_empty()
            || input.tmdb_id.trim().is_empty()
            || input.playable_url.trim().is_empty()
        {
            return Ok(());
        }

        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let normalized_audio_lang = normalize_preferred_audio_lang(&input.audio_lang);
            let normalized_quality = normalize_preferred_stream_quality(&input.preferred_quality);
            let session_key = build_playback_session_key(
                &input.tmdb_id,
                &normalized_audio_lang,
                &normalized_quality,
            );
            let existing = get_playback_session_inner(path.clone(), session_key.clone())?;
            let auto_session_key = if normalized_audio_lang != "auto" {
                build_playback_session_key(&input.tmdb_id, "auto", &normalized_quality)
            } else {
                String::new()
            };
            let auto_session = if !auto_session_key.is_empty() && auto_session_key != session_key {
                get_playback_session_inner(path.clone(), auto_session_key.clone())?
            } else {
                None
            };
            let persisted_position = existing
                .as_ref()
                .map(|session| session.last_position_seconds)
                .unwrap_or_else(|| {
                    auto_session
                        .as_ref()
                        .map(|session| session.last_position_seconds)
                        .unwrap_or(0.0)
                })
                .max(0.0);
            let now = now_ms();
            connection.execute(
                "
                INSERT INTO playback_sessions (
                  session_key,
                  tmdb_id,
                  audio_lang,
                  source_hash,
                  selected_file,
                  filename,
                  playable_url,
                  fallback_urls_json,
                  metadata_json,
                  last_position_seconds,
                  health_state,
                  health_fail_count,
                  last_error,
                  last_verified_at,
                  next_validation_at,
                  updated_at,
                  last_accessed_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_key) DO UPDATE SET
                  tmdb_id = excluded.tmdb_id,
                  audio_lang = excluded.audio_lang,
                  source_hash = excluded.source_hash,
                  selected_file = excluded.selected_file,
                  filename = excluded.filename,
                  playable_url = excluded.playable_url,
                  fallback_urls_json = excluded.fallback_urls_json,
                  metadata_json = excluded.metadata_json,
                  health_state = excluded.health_state,
                  health_fail_count = excluded.health_fail_count,
                  last_error = excluded.last_error,
                  last_verified_at = excluded.last_verified_at,
                  next_validation_at = excluded.next_validation_at,
                  updated_at = excluded.updated_at,
                  last_accessed_at = excluded.last_accessed_at
                ",
                params![
                    session_key,
                    input.tmdb_id.trim(),
                    normalized_audio_lang,
                    input.source_hash.trim().to_lowercase(),
                    input.selected_file.trim(),
                    input.filename.trim(),
                    input.playable_url.trim(),
                    serde_json::to_string(&normalize_playback_session_fallback_urls(
                        input.fallback_urls,
                    ))
                    .unwrap_or_else(|_| "[]".to_owned()),
                    serde_json::to_string(&input.metadata).unwrap_or_else(|_| "{}".to_owned()),
                    persisted_position,
                    "healthy",
                    0,
                    "",
                    now,
                    now + PLAYBACK_SESSION_VALIDATE_INTERVAL_MS,
                    now,
                    now,
                ],
            )?;
            if !auto_session_key.is_empty() && auto_session_key != session_key {
                let _ = connection.execute(
                    "DELETE FROM playback_sessions WHERE session_key = ?",
                    [auto_session_key.as_str()],
                );
            }
            trim_table(
                &connection,
                "playback_sessions",
                "updated_at",
                PLAYBACK_SESSION_PERSIST_MAX_ENTRIES,
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn record_source_health_event(
        &self,
        source_key: String,
        event_type: String,
        last_error: String,
    ) -> AppResult<()> {
        if source_key.trim().is_empty() {
            return Ok(());
        }
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let (success, failure, decode_failure, ended_early, playback_error) =
                match event_type.as_str() {
                    "success" => (1, 0, 0, 0, 0),
                    "decode_failure" => (0, 1, 1, 0, 0),
                    "ended_early" => (0, 1, 0, 1, 0),
                    "playback_error" => (0, 1, 0, 0, 1),
                    _ => (0, 0, 0, 0, 0),
                };

            connection.execute(
                "
                INSERT INTO source_health_stats (
                  source_key,
                  total_success_count,
                  total_failure_count,
                  decode_failure_count,
                  ended_early_count,
                  playback_error_count,
                  last_error,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_key) DO UPDATE SET
                  total_success_count = source_health_stats.total_success_count + excluded.total_success_count,
                  total_failure_count = source_health_stats.total_failure_count + excluded.total_failure_count,
                  decode_failure_count = source_health_stats.decode_failure_count + excluded.decode_failure_count,
                  ended_early_count = source_health_stats.ended_early_count + excluded.ended_early_count,
                  playback_error_count = source_health_stats.playback_error_count + excluded.playback_error_count,
                  last_error = excluded.last_error,
                  updated_at = excluded.updated_at
                ",
                params![
                    source_key,
                    success,
                    failure,
                    decode_failure,
                    ended_early,
                    playback_error,
                    last_error.chars().take(500).collect::<String>(),
                    now_ms(),
                ],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_source_health_stats(
        &self,
        source_key: String,
    ) -> AppResult<Option<SourceHealthStats>> {
        if source_key.trim().is_empty() {
            return Ok(None);
        }
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let row = connection
                .query_row(
                    "
                    SELECT
                      total_success_count,
                      total_failure_count,
                      decode_failure_count,
                      ended_early_count,
                      playback_error_count,
                      updated_at
                    FROM source_health_stats
                    WHERE source_key = ?
                    ",
                    [source_key.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                success_count,
                failure_count,
                decode_failure_count,
                ended_early_count,
                playback_error_count,
                updated_at,
            )) = row
            else {
                return Ok(None);
            };
            if updated_at == 0 || updated_at + SOURCE_HEALTH_STALE_MS <= now_ms() {
                connection.execute(
                    "DELETE FROM source_health_stats WHERE source_key = ?",
                    [source_key.as_str()],
                )?;
                return Ok(None);
            }
            Ok(Some(SourceHealthStats {
                success_count: success_count.max(0),
                failure_count: failure_count.max(0),
                decode_failure_count: decode_failure_count.max(0),
                ended_early_count: ended_early_count.max(0),
                playback_error_count: playback_error_count.max(0),
            }))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn get_tmdb_cache(&self, cache_key: String) -> AppResult<Option<(Value, i64)>> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let row = connection
                .query_row(
                    "
                    SELECT payload_json, expires_at
                    FROM tmdb_response_cache
                    WHERE cache_key = ?
                    ",
                    [cache_key.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let Some((payload_json, expires_at)) = row else {
                return Ok(None);
            };
            if expires_at <= now_ms() {
                connection.execute(
                    "DELETE FROM tmdb_response_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() {
                connection.execute(
                    "DELETE FROM tmdb_response_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return Ok(None);
            }
            Ok(Some((parsed, expires_at)))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn set_tmdb_cache(
        &self,
        cache_key: String,
        payload: Value,
        expires_at: i64,
    ) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "
                INSERT INTO tmdb_response_cache (
                  cache_key,
                  payload_json,
                  expires_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  expires_at = excluded.expires_at,
                  updated_at = excluded.updated_at
                ",
                params![
                    cache_key,
                    serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_owned()),
                    expires_at,
                    now_ms(),
                ],
            )?;
            trim_table(
                &connection,
                "tmdb_response_cache",
                "updated_at",
                TMDB_RESPONSE_PERSIST_MAX_ENTRIES,
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_resolved_stream_cache(
        &self,
        cache_key: String,
    ) -> AppResult<Option<(Value, i64, i64)>> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let row = connection
                .query_row(
                    "
                    SELECT payload_json, expires_at, next_validation_at
                    FROM resolved_stream_cache
                    WHERE cache_key = ?
                    ",
                    [cache_key.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((payload_json, expires_at, next_validation_at)) = row else {
                return Ok(None);
            };
            if expires_at <= now_ms() {
                connection.execute(
                    "DELETE FROM resolved_stream_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() || !parsed.is_object() {
                connection.execute(
                    "DELETE FROM resolved_stream_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return Ok(None);
            }
            Ok(Some((parsed, expires_at.max(0), next_validation_at.max(0))))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn set_resolved_stream_cache(
        &self,
        cache_key: String,
        payload: Value,
        expires_at: i64,
        next_validation_at: i64,
    ) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "
                INSERT INTO resolved_stream_cache (
                  cache_key,
                  payload_json,
                  expires_at,
                  is_ephemeral,
                  next_validation_at,
                  updated_at
                )
                VALUES (?, ?, ?, 0, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  expires_at = excluded.expires_at,
                  is_ephemeral = excluded.is_ephemeral,
                  next_validation_at = excluded.next_validation_at,
                  updated_at = excluded.updated_at
                ",
                params![
                    cache_key,
                    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_owned()),
                    expires_at.max(next_validation_at).max(now_ms() + 1_000),
                    next_validation_at.max(0),
                    now_ms(),
                ],
            )?;
            trim_table(
                &connection,
                "resolved_stream_cache",
                "updated_at",
                RESOLVED_STREAM_PERSIST_MAX_ENTRIES,
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_movie_quick_start_cache(
        &self,
        cache_key: String,
    ) -> AppResult<Option<(Value, i64)>> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let row = connection
                .query_row(
                    "
                    SELECT payload_json, expires_at
                    FROM movie_quick_start_cache
                    WHERE cache_key = ?
                    ",
                    [cache_key.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let Some((payload_json, expires_at)) = row else {
                return Ok(None);
            };
            if expires_at <= now_ms() {
                connection.execute(
                    "DELETE FROM movie_quick_start_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() || !parsed.is_object() {
                connection.execute(
                    "DELETE FROM movie_quick_start_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return Ok(None);
            }
            Ok(Some((parsed, expires_at.max(0))))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn set_movie_quick_start_cache(
        &self,
        cache_key: String,
        payload: Value,
        expires_at: i64,
    ) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "
                INSERT INTO movie_quick_start_cache (
                  cache_key,
                  payload_json,
                  expires_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  expires_at = excluded.expires_at,
                  updated_at = excluded.updated_at
                ",
                params![
                    cache_key,
                    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_owned()),
                    expires_at.max(now_ms() + 1_000),
                    now_ms(),
                ],
            )?;
            trim_table(
                &connection,
                "movie_quick_start_cache",
                "updated_at",
                MOVIE_QUICK_START_PERSIST_MAX_ENTRIES,
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_movie_quick_start_cache(&self, cache_key: String) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "DELETE FROM movie_quick_start_cache WHERE cache_key = ?",
                [cache_key.as_str()],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_media_probe_cache(&self, probe_key: String) -> AppResult<Option<Value>> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            let row = connection
                .query_row(
                    "
                    SELECT payload_json, updated_at
                    FROM media_probe_cache
                    WHERE probe_key = ?
                    ",
                    [probe_key.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let Some((payload_json, updated_at)) = row else {
                return Ok(None);
            };
            if updated_at == 0 || updated_at + MEDIA_PROBE_STALE_MS <= now_ms() {
                connection.execute(
                    "DELETE FROM media_probe_cache WHERE probe_key = ?",
                    [probe_key.as_str()],
                )?;
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() || !parsed.is_object() {
                connection.execute(
                    "DELETE FROM media_probe_cache WHERE probe_key = ?",
                    [probe_key.as_str()],
                )?;
                return Ok(None);
            }
            Ok(Some(parsed))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn set_media_probe_cache(&self, probe_key: String, payload: Value) -> AppResult<()> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let connection = open_connection(&path)?;
            connection.execute(
                "
                INSERT INTO media_probe_cache (
                  probe_key,
                  payload_json,
                  updated_at
                )
                VALUES (?, ?, ?)
                ON CONFLICT(probe_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                ",
                params![
                    probe_key,
                    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_owned()),
                    now_ms(),
                ],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }
}

fn get_playback_session_inner(
    path: Arc<PathBuf>,
    session_key: String,
) -> Result<Option<PlaybackSession>, rusqlite::Error> {
    let connection = open_connection(&path)?;
    let row = connection
        .query_row(
            "
            SELECT
              session_key,
              tmdb_id,
              audio_lang,
              source_hash,
              selected_file,
              filename,
              playable_url,
              fallback_urls_json,
              metadata_json,
              last_position_seconds,
              health_state,
              health_fail_count,
              last_error,
              last_verified_at,
              next_validation_at
            FROM playback_sessions
            WHERE session_key = ?
            ",
            [session_key.as_str()],
            |row| {
                let fallback_urls = row.get::<_, String>(7)?;
                let metadata = row.get::<_, String>(8)?;
                Ok(PlaybackSession {
                    session_key: row.get(0)?,
                    tmdb_id: row.get(1)?,
                    audio_lang: normalize_preferred_audio_lang(&row.get::<_, String>(2)?),
                    preferred_quality: parse_movie_resolve_key_quality(&row.get::<_, String>(0)?),
                    source_hash: row.get::<_, String>(3)?.trim().to_lowercase(),
                    selected_file: row.get(4)?,
                    filename: row.get(5)?,
                    playable_url: row.get(6)?,
                    fallback_urls: serde_json::from_str::<Vec<String>>(&fallback_urls)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|value| value.trim().to_owned())
                        .filter(|value| !value.is_empty())
                        .collect(),
                    metadata: serde_json::from_str::<Value>(&metadata).unwrap_or(Value::Null),
                    last_position_seconds: row.get::<_, f64>(9)?.max(0.0),
                    health_state: normalize_session_health_state(&row.get::<_, String>(10)?),
                    health_fail_count: row.get::<_, i64>(11)?.max(0),
                    last_error: row.get(12)?,
                    last_verified_at: row.get::<_, i64>(13)?.max(0),
                    next_validation_at: row.get::<_, i64>(14)?.max(0),
                })
            },
        )
        .optional()?;
    Ok(row)
}

fn init_schema(path: PathBuf) -> Result<(), rusqlite::Error> {
    let connection = open_connection(&path)?;
    connection.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS resolved_stream_cache (
          cache_key TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          is_ephemeral INTEGER NOT NULL DEFAULT 0,
          next_validation_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resolved_stream_cache_expires ON resolved_stream_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_resolved_stream_cache_updated ON resolved_stream_cache(updated_at);
        CREATE TABLE IF NOT EXISTS movie_quick_start_cache (
          cache_key TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_movie_quick_start_cache_expires ON movie_quick_start_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_movie_quick_start_cache_updated ON movie_quick_start_cache(updated_at);
        CREATE TABLE IF NOT EXISTS tmdb_response_cache (
          cache_key TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tmdb_response_cache_expires ON tmdb_response_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_tmdb_response_cache_updated ON tmdb_response_cache(updated_at);
        CREATE TABLE IF NOT EXISTS playback_sessions (
          session_key TEXT PRIMARY KEY,
          tmdb_id TEXT NOT NULL,
          audio_lang TEXT NOT NULL,
          source_hash TEXT NOT NULL DEFAULT '',
          selected_file TEXT NOT NULL DEFAULT '',
          filename TEXT NOT NULL DEFAULT '',
          playable_url TEXT NOT NULL,
          fallback_urls_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          last_position_seconds REAL NOT NULL DEFAULT 0,
          health_state TEXT NOT NULL DEFAULT 'unknown',
          health_fail_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          last_verified_at INTEGER NOT NULL DEFAULT 0,
          next_validation_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playback_sessions_tmdb_lang ON playback_sessions(tmdb_id, audio_lang);
        CREATE INDEX IF NOT EXISTS idx_playback_sessions_updated ON playback_sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_playback_sessions_last_accessed ON playback_sessions(last_accessed_at);
        CREATE TABLE IF NOT EXISTS source_health_stats (
          source_key TEXT PRIMARY KEY,
          total_success_count INTEGER NOT NULL DEFAULT 0,
          total_failure_count INTEGER NOT NULL DEFAULT 0,
          decode_failure_count INTEGER NOT NULL DEFAULT 0,
          ended_early_count INTEGER NOT NULL DEFAULT 0,
          playback_error_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_source_health_updated ON source_health_stats(updated_at);
        CREATE TABLE IF NOT EXISTS media_probe_cache (
          probe_key TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_media_probe_updated ON media_probe_cache(updated_at);
        CREATE TABLE IF NOT EXISTS title_track_preferences (
          tmdb_id TEXT PRIMARY KEY,
          preferred_audio_lang TEXT NOT NULL DEFAULT '',
          preferred_subtitle_lang TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_title_track_preferences_updated ON title_track_preferences(updated_at);
        ",
    )?;
    Ok(())
}

fn sweep_db(path: Arc<PathBuf>) -> Result<(), rusqlite::Error> {
    let connection = open_connection(&path)?;
    let now = now_ms();
    let stale_threshold = now - PLAYBACK_SESSION_STALE_MS;
    connection.execute(
        "DELETE FROM resolved_stream_cache WHERE expires_at <= ?",
        [now],
    )?;
    connection.execute(
        "DELETE FROM movie_quick_start_cache WHERE expires_at <= ?",
        [now],
    )?;
    connection.execute(
        "DELETE FROM tmdb_response_cache WHERE expires_at <= ?",
        [now],
    )?;
    connection.execute(
        "DELETE FROM playback_sessions WHERE last_accessed_at <= ?",
        [stale_threshold],
    )?;
    connection.execute(
        "DELETE FROM source_health_stats WHERE updated_at <= ?",
        [now - SOURCE_HEALTH_STALE_MS],
    )?;
    connection.execute(
        "DELETE FROM media_probe_cache WHERE updated_at <= ?",
        [now - MEDIA_PROBE_STALE_MS],
    )?;
    connection.execute(
        "DELETE FROM title_track_preferences WHERE updated_at <= ?",
        [now - TITLE_PREFERENCES_STALE_MS],
    )?;
    trim_table(
        &connection,
        "resolved_stream_cache",
        "updated_at",
        RESOLVED_STREAM_PERSIST_MAX_ENTRIES,
    )?;
    trim_table(
        &connection,
        "movie_quick_start_cache",
        "updated_at",
        MOVIE_QUICK_START_PERSIST_MAX_ENTRIES,
    )?;
    trim_table(
        &connection,
        "tmdb_response_cache",
        "updated_at",
        TMDB_RESPONSE_PERSIST_MAX_ENTRIES,
    )?;
    trim_table(
        &connection,
        "playback_sessions",
        "updated_at",
        PLAYBACK_SESSION_PERSIST_MAX_ENTRIES,
    )?;
    Ok(())
}

fn open_connection(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    Ok(connection)
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, rusqlite::Error> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    connection.query_row(sql.as_str(), [], |row| row.get::<_, i64>(0))
}

fn trim_table(
    connection: &Connection,
    table: &str,
    order_column: &str,
    max_entries: i64,
) -> Result<(), rusqlite::Error> {
    let current = table_count(connection, table)?;
    if current <= max_entries {
        return Ok(());
    }
    let overflow = current - max_entries;
    let sql = format!(
        "DELETE FROM {table} WHERE rowid IN (
           SELECT rowid FROM {table}
           ORDER BY {order_column} ASC
           LIMIT ?
         )"
    );
    connection.execute(sql.as_str(), [overflow])?;
    Ok(())
}

fn parse_movie_resolve_key_quality(cache_key: &str) -> String {
    cache_key
        .split(':')
        .nth(2)
        .map(normalize_preferred_stream_quality)
        .unwrap_or_else(|| "auto".to_owned())
}

fn build_playback_session_key(tmdb_id: &str, audio_lang: &str, quality: &str) -> String {
    format!(
        "{}:{}:{}",
        tmdb_id.trim(),
        normalize_preferred_audio_lang(audio_lang),
        normalize_preferred_stream_quality(quality)
    )
}

fn normalize_playback_session_fallback_urls(values: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || unique.iter().any(|existing| existing == trimmed) {
            continue;
        }
        unique.push(trimmed.to_owned());
    }
    unique
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn build_cache_debug_payload(
    started_at_ms: i64,
    in_memory_tmdb_size: usize,
    persistent_counts: CacheCounts,
    tmdb_hits: u64,
    tmdb_misses: u64,
    tmdb_expired: u64,
) -> Value {
    let tmdb_requests = tmdb_hits + tmdb_misses;
    json!({
      "uptimeSeconds": ((now_ms() - started_at_ms) / 1000).max(0),
      "caches": {
        "tmdbResponse": {
          "size": in_memory_tmdb_size,
          "ttlDefaultMs": 21600000,
          "ttlPopularMs": 1800000,
          "ttlGenreMs": 86400000,
          "maxEntries": 1200
        },
        "movieQuickStart": {
          "size": 0,
          "ttlMs": 3600000,
          "maxEntries": 160
        },
        "resolvedStream": {
          "size": 0,
          "ttlMs": 1200000,
          "ephemeralTtlMs": 43200000,
          "ephemeralRevalidateMs": 90000,
          "maxEntries": 800
        },
        "rdTorrentLookup": {
          "size": 0,
          "ttlMs": 120000,
          "maxEntries": 1500
        },
        "externalSubtitleLookup": {
          "size": 0,
          "ttlMs": 1800000,
          "maxEntries": 500
        },
        "playbackSession": {
          "validateIntervalMs": 90000,
          "staleMs": 2592000000_i64
        },
        "persistentDb": {
          "enabled": true,
          "path": "",
          "tmdbResponseSize": persistent_counts.tmdb_response_size,
          "playbackSessionSize": persistent_counts.playback_session_size,
          "resolvedStreamSize": persistent_counts.resolved_stream_size,
          "movieQuickStartSize": persistent_counts.movie_quick_start_size,
          "sourceHealthSize": persistent_counts.source_health_size,
          "mediaProbeSize": persistent_counts.media_probe_size,
          "titlePreferenceSize": persistent_counts.title_preference_size,
          "tmdbResponseMaxEntries": TMDB_RESPONSE_PERSIST_MAX_ENTRIES,
          "playbackSessionMaxEntries": PLAYBACK_SESSION_PERSIST_MAX_ENTRIES,
          "resolvedStreamMaxEntries": RESOLVED_STREAM_PERSIST_MAX_ENTRIES,
          "movieQuickStartMaxEntries": MOVIE_QUICK_START_PERSIST_MAX_ENTRIES
        },
        "inFlightMovieResolves": 0,
        "hlsTranscodeJobs": 0
      },
      "stats": {
        "tmdbResponse": {
          "hits": tmdb_hits,
          "misses": tmdb_misses,
          "expired": tmdb_expired,
          "hitRate": if tmdb_requests > 0 {
            (((tmdb_hits as f64) / (tmdb_requests as f64)) * 1000.0).round() / 1000.0
          } else {
            0.0
          }
        },
        "playbackSession": {
          "hits": 0,
          "misses": 0,
          "invalidated": 0,
          "hitRate": 0.0
        },
        "movieQuickStart": {
          "hits": 0,
          "misses": 0,
          "expired": 0,
          "hitRate": 0.0
        },
        "resolvedStream": {
          "hits": 0,
          "misses": 0,
          "expired": 0,
          "invalidated": 0,
          "hitRate": 0.0
        },
        "rdLookup": {
          "hits": 0,
          "misses": 0,
          "expired": 0,
          "apiPagesScanned": 0,
          "hitRate": 0.0
        },
        "movieResolveDedup": {
          "hits": 0,
          "misses": 0,
          "hitRate": 0.0
        }
      }
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rusqlite::params;
    use serde_json::json;

    use super::{
        Db, PLAYBACK_SESSION_VALIDATE_INTERVAL_MS, PersistPlaybackSessionInput,
        SQLITE_BUSY_TIMEOUT_MS, open_connection, parse_movie_resolve_key_quality,
    };

    #[test]
    fn parses_quality_from_session_key() {
        assert_eq!(parse_movie_resolve_key_quality("123:auto:1080p"), "1080p");
    }

    #[tokio::test]
    async fn persists_playback_sessions_and_moves_auto_progress() {
        let path = unique_temp_db_path("playback-session");
        let db = setup_test_playback_session_db(&path).await;
        db.persist_playback_session(PersistPlaybackSessionInput {
            session_key: "123:auto:1080p".to_owned(),
            tmdb_id: "123".to_owned(),
            audio_lang: "auto".to_owned(),
            preferred_quality: "1080p".to_owned(),
            source_hash: "abc".to_owned(),
            selected_file: "1".to_owned(),
            filename: "Movie.mp4".to_owned(),
            playable_url: "https://download.real-debrid.com/movie.mp4".to_owned(),
            fallback_urls: vec!["https://download.real-debrid.com/movie-alt.mp4".to_owned()],
            metadata: json!({"tmdbId":"123","displayTitle":"Movie"}),
        })
        .await
        .expect("persist auto session");
        db.update_playback_session_progress(
            "123:auto:1080p".to_owned(),
            187.0,
            "healthy".to_owned(),
            String::new(),
        )
        .await
        .expect("update auto progress");

        db.persist_playback_session(PersistPlaybackSessionInput {
            session_key: "123:en:1080p".to_owned(),
            tmdb_id: "123".to_owned(),
            audio_lang: "en".to_owned(),
            preferred_quality: "1080p".to_owned(),
            source_hash: "def".to_owned(),
            selected_file: "2".to_owned(),
            filename: "Movie.en.mkv".to_owned(),
            playable_url: "https://download.real-debrid.com/movie.en.mkv".to_owned(),
            fallback_urls: vec![
                "https://download.real-debrid.com/movie.en.mkv".to_owned(),
                "https://download.real-debrid.com/movie.en.mkv".to_owned(),
                "https://download.real-debrid.com/movie.en.alt.mkv".to_owned(),
            ],
            metadata: json!({"tmdbId":"123","displayTitle":"Movie"}),
        })
        .await
        .expect("persist language session");

        let persisted = db
            .get_playback_session("123:en:1080p".to_owned())
            .await
            .expect("load persisted session")
            .expect("session exists");
        assert_eq!(persisted.last_position_seconds, 187.0);
        assert_eq!(
            persisted.fallback_urls,
            vec![
                "https://download.real-debrid.com/movie.en.mkv".to_owned(),
                "https://download.real-debrid.com/movie.en.alt.mkv".to_owned()
            ]
        );
        assert!(
            db.get_playback_session("123:auto:1080p".to_owned())
                .await
                .expect("load auto session")
                .is_none()
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn refreshes_playback_session_validation_window_without_mutating_other_fields() {
        let path = unique_temp_db_path("playback-session-refresh");
        let db = setup_test_playback_session_db(&path).await;
        db.persist_playback_session(PersistPlaybackSessionInput {
            session_key: "123:en:1080p".to_owned(),
            tmdb_id: "123".to_owned(),
            audio_lang: "en".to_owned(),
            preferred_quality: "1080p".to_owned(),
            source_hash: "abc".to_owned(),
            selected_file: "2".to_owned(),
            filename: "Movie.en.mkv".to_owned(),
            playable_url: "https://download.real-debrid.com/movie.en.mkv".to_owned(),
            fallback_urls: vec!["https://download.real-debrid.com/movie.en.alt.mkv".to_owned()],
            metadata: json!({"tmdbId":"123","displayTitle":"Movie"}),
        })
        .await
        .expect("persist session");
        db.update_playback_session_progress(
            "123:en:1080p".to_owned(),
            187.0,
            "healthy".to_owned(),
            String::new(),
        )
        .await
        .expect("update session progress");

        let stale_verified_at = super::now_ms() - 120_000;
        let stale_next_validation_at = super::now_ms() - 60_000;
        let setup_path = db.path.clone();
        super::task::spawn_blocking(move || {
            let connection = open_connection(&setup_path)?;
            connection.execute(
                "
                UPDATE playback_sessions
                SET
                  last_verified_at = ?,
                  next_validation_at = ?
                WHERE session_key = ?
                ",
                params![
                    stale_verified_at,
                    stale_next_validation_at,
                    "123:en:1080p".to_owned(),
                ],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .expect("join setup")
        .expect("set stale validation times");

        let before_refresh = super::now_ms();
        assert!(
            db.refresh_playback_session_validation_window("123:en:1080p".to_owned())
                .await
                .expect("refresh validation window")
        );
        let after_refresh = super::now_ms();

        let refreshed = db
            .get_playback_session("123:en:1080p".to_owned())
            .await
            .expect("load refreshed session")
            .expect("session exists");
        assert_eq!(
            refreshed.playable_url,
            "https://download.real-debrid.com/movie.en.mkv"
        );
        assert_eq!(refreshed.source_hash, "abc");
        assert_eq!(refreshed.last_position_seconds, 187.0);
        assert_eq!(
            refreshed.fallback_urls,
            vec!["https://download.real-debrid.com/movie.en.alt.mkv".to_owned()]
        );
        assert!(refreshed.last_verified_at >= before_refresh);
        assert!(refreshed.last_verified_at <= after_refresh);
        assert!(
            refreshed.next_validation_at >= before_refresh + PLAYBACK_SESSION_VALIDATE_INTERVAL_MS
        );
        assert!(
            refreshed.next_validation_at <= after_refresh + PLAYBACK_SESSION_VALIDATE_INTERVAL_MS
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn persists_movie_quick_start_cache_entries() {
        let path = unique_temp_db_path("movie-quick-start");
        let db = setup_test_playback_session_db(&path).await;
        db.set_movie_quick_start_cache(
            "rd-torrent:abc".to_owned(),
            json!({"torrentId":"123"}),
            super::now_ms() + 60_000,
        )
        .await
        .expect("persist quick start cache");

        let cached = db
            .get_movie_quick_start_cache("rd-torrent:abc".to_owned())
            .await
            .expect("load quick start cache")
            .expect("cache exists");
        assert_eq!(cached.0["torrentId"], "123");

        db.delete_movie_quick_start_cache("rd-torrent:abc".to_owned())
            .await
            .expect("delete quick start cache");
        assert!(
            db.get_movie_quick_start_cache("rd-torrent:abc".to_owned())
                .await
                .expect("load deleted quick start cache")
                .is_none()
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn applies_busy_timeout_to_sqlite_connections() {
        let path = unique_temp_db_path("busy-timeout");
        let db = setup_test_playback_session_db(&path).await;
        let setup_path = db.path.clone();
        let busy_timeout = super::task::spawn_blocking(move || {
            let connection = open_connection(&setup_path)?;
            connection.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
        })
        .await
        .expect("join busy timeout query")
        .expect("read busy_timeout pragma");

        assert_eq!(busy_timeout, SQLITE_BUSY_TIMEOUT_MS as i64);

        let _ = tokio::fs::remove_file(&path).await;
    }

    fn unique_temp_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("netflix-{name}-{}.sqlite", super::now_ms()))
    }

    async fn setup_test_playback_session_db(path: &Path) -> Db {
        let config = crate::config::Config {
            root_dir: std::env::temp_dir(),
            frontend_dir: std::env::temp_dir(),
            assets_dir: std::env::temp_dir(),
            cache_dir: std::env::temp_dir(),
            hls_cache_dir: std::env::temp_dir(),
            upload_temp_dir: std::env::temp_dir(),
            local_library_path: std::env::temp_dir().join("library.json"),
            persistent_cache_db_path: path.to_path_buf(),
            host: "127.0.0.1".to_owned(),
            port: 0,
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
            playback_sessions_enabled: true,
            mpv_binary: "mpv".to_owned(),
        };
        Db::initialize(&config).await.expect("init db")
    }
}
