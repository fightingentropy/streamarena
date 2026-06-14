use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::task;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::utils::now_ms;
use crate::utils::{
    normalize_preferred_audio_lang, normalize_preferred_stream_quality,
    normalize_session_health_state, normalize_subtitle_preference,
};

const TITLE_PREFERENCES_STALE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const PLAYBACK_SESSION_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const PLAYBACK_SESSION_VALIDATE_INTERVAL_MS: i64 = 90 * 1000;
const SOURCE_HEALTH_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MEDIA_PROBE_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
// Service-health history. Samples drive the 24h dashboard sparklines (we keep a
// little extra so a "last 24h" view always has a full window); the restart log
// is kept long enough to reason about flapping over a month.
const HEALTH_SAMPLE_STALE_MS: i64 = 48 * 60 * 60 * 1000;
const SERVICE_START_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const TMDB_RESPONSE_PERSIST_MAX_ENTRIES: i64 = 6000;
const PLAYBACK_SESSION_PERSIST_MAX_ENTRIES: i64 = 2500;
const RESOLVED_STREAM_PERSIST_MAX_ENTRIES: i64 = 6000;
const MOVIE_QUICK_START_PERSIST_MAX_ENTRIES: i64 = 1200;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;

type Pool = std::sync::Mutex<Vec<Connection>>;

/// Two physically separate SQLite files behind one handle:
///
/// * `cache_*` — `resolver-cache.sqlite`: regenerable cache/resolver state. A
///   corrupt file here self-heals (quarantine + rebuild empty schema).
/// * `users_*` — `users.sqlite`: durable accounts and user data. Kept apart so a
///   cache-corruption quarantine can never delete accounts (the 2026-06-09
///   incident). Never auto-quarantined.
///
/// Each accessor reaches into whichever store owns its tables. The only place the
/// two meet is continue-watching reconciliation, which reads `playback_sessions`
/// (cache) via a dedicated cache connection — never a cross-database `ATTACH`.
#[derive(Clone)]
pub struct Db {
    cache_path: Arc<PathBuf>,
    cache_pool: Arc<Pool>,
    users_path: Arc<PathBuf>,
    users_pool: Arc<Pool>,
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
pub struct TmdbTvWarmupCandidate {
    pub tmdb_id: String,
    pub season_number: i64,
    pub episode_number: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default)]
struct ContinueWatchingRow {
    source_identity: String,
    title: String,
    episode: String,
    src: String,
    tmdb_id: String,
    media_type: String,
    series_id: String,
    episode_index: i64,
    year: String,
    thumb: String,
    source_hash: String,
    session_key: String,
    resolver_provider: String,
    source_input: String,
    filename: String,
    resume_seconds: f64,
    updated_at: i64,
}

#[derive(Debug, Clone, Default)]
struct ContinueWatchingSourceMetadata {
    source_hash: String,
    session_key: String,
    resolver_provider: String,
    source_input: String,
    filename: String,
    updated_at: i64,
    last_accessed_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct SourceHealthStats {
    pub success_count: i64,
    pub failure_count: i64,
    pub decode_failure_count: i64,
    pub ended_early_count: i64,
    pub playback_error_count: i64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize)]
pub struct AdminOverview {
    pub totalUsers: i64,
    pub newUsers24h: i64,
    pub newUsers7d: i64,
    pub newUsers30d: i64,
    pub verifiedUsers: i64,
    pub adminUsers: i64,
    pub disabledUsers: i64,
    pub activeSessions: i64,
    pub activeUsers: i64,
    pub continueWatchingItems: i64,
    pub myListItems: i64,
    pub watchProgressItems: i64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct AdminDailyCount {
    pub date: String,
    pub signups: i64,
}

/// One 60-second service-health snapshot. Counter columns (`req*`,
/// `playback*Total`) are cumulative-since-boot so rates can be derived as deltas
/// between rows; the `*Rate` columns are the already-windowed values for cheap
/// sparkline plotting. `status` is [`crate::health::Status`] as 0/1/2.
#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize)]
pub struct HealthSampleRow {
    pub ts: i64,
    pub uptimeSeconds: i64,
    pub status: i64,
    pub fdCount: i64,
    pub fdLimit: i64,
    pub memUsed: i64,
    pub memTotal: i64,
    pub load1: f64,
    pub numCpus: i64,
    pub diskFree: i64,
    pub diskTotal: i64,
    pub reqTotal: i64,
    pub req4xx: i64,
    pub req5xx: i64,
    pub liveProxy5xx: i64,
    pub req5xxRate: f64,
    pub playbackSuccessTotal: i64,
    pub playbackFailureTotal: i64,
    pub playbackFailureRate: f64,
    pub worstProviderConsecutiveFailures: i64,
}

/// One process-start record. Appended each boot so the dashboard can count
/// restarts (and spot crash-looping) without parsing logs.
#[allow(non_snake_case)]
#[derive(Debug, Clone, Default, Serialize)]
pub struct ServiceStartRow {
    pub startedAt: i64,
    pub note: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct AdminUserRow {
    pub id: i64,
    pub email: String,
    pub displayName: String,
    pub createdAt: i64,
    pub emailVerifiedAt: Option<i64>,
    pub isAdmin: bool,
    pub isDisabled: bool,
    pub sessionCount: i64,
    pub continueWatchingCount: i64,
    pub myListCount: i64,
    pub lastActiveAt: Option<i64>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct AdminActivityEvent {
    pub kind: String,
    pub ts: i64,
    pub email: String,
    pub displayName: String,
    pub title: String,
    pub detail: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct FeedbackRow {
    pub id: i64,
    pub email: String,
    pub displayName: String,
    pub message: String,
    pub hasImage: bool,
    pub createdAt: i64,
}

/// One row of the admin "top live streams" panel: a live title aggregated over
/// the lookback window.
#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct AdminLiveStreamRow {
    pub title: String,
    pub category: String,
    pub plays: i64,
    pub viewers: i64,
    pub lastAt: i64,
}

impl Db {
    pub async fn initialize(config: &Config) -> AppResult<Self> {
        let cache_path = config.persistent_cache_db_path.clone();
        let users_path = config.persistent_users_db_path.clone();
        let cache_dir = config.cache_dir.clone();
        tokio::fs::create_dir_all(cache_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let cache_for_task = cache_path.clone();
        let users_for_task = users_path.clone();
        task::spawn_blocking(move || initialize_databases(&cache_for_task, &users_for_task))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))?;

        Ok(Self {
            cache_path: Arc::new(cache_path),
            cache_pool: Arc::new(std::sync::Mutex::new(Vec::new())),
            users_path: Arc::new(users_path),
            users_pool: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }

    pub async fn sweep(&self) {
        let cache_path = self.cache_path.clone();
        let cache_pool = self.cache_pool.clone();
        let users_path = self.users_path.clone();
        let users_pool = self.users_pool.clone();
        let _ = task::spawn_blocking(move || {
            // Each store sweeps independently; a failure in one must not skip the
            // other, so the results are intentionally ignored here.
            let _ = sweep_cache_db(&cache_pool, &cache_path);
            let _ = sweep_users_db(&users_pool, &users_path);
        })
        .await;
    }

    pub async fn clear_persistent_caches(&self) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute_batch(
                "
                DELETE FROM resolved_stream_cache;
                DELETE FROM movie_quick_start_cache;
                DELETE FROM tmdb_response_cache;
                DELETE FROM home_bootstrap_cache;
                DELETE FROM playback_sessions;
                DELETE FROM source_health_stats;
                DELETE FROM media_probe_cache;
                DELETE FROM title_track_preferences;
                ",
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn persistent_counts(&self) -> AppResult<CacheCounts> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let counts = CacheCounts {
                tmdb_response_size: table_count(&connection, "tmdb_response_cache")?,
                playback_session_size: table_count(&connection, "playback_sessions")?,
                resolved_stream_size: table_count(&connection, "resolved_stream_cache")?,
                movie_quick_start_size: table_count(&connection, "movie_quick_start_cache")?,
                source_health_size: table_count(&connection, "source_health_stats")?,
                media_probe_size: table_count(&connection, "media_probe_cache")?,
                title_preference_size: table_count(&connection, "title_track_preferences")?,
            };
            return_connection(&pool, connection);
            Ok::<CacheCounts, rusqlite::Error>(counts)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_title_preference(
        &self,
        user_id: i64,
        media_type: String,
        tmdb_id: String,
    ) -> AppResult<Option<TitlePreference>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let media_type = normalize_title_preference_media_type(&media_type);
            let row = connection
                .query_row(
                    "
                    SELECT preferred_audio_lang, preferred_subtitle_lang, updated_at
                    FROM title_track_preferences
                    WHERE user_id = ? AND media_type = ? AND tmdb_id = ?
                    ",
                    params![user_id, media_type, tmdb_id],
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
                return_connection(&pool, connection);
                return Ok(None);
            };
            if updated_at == 0 || updated_at + TITLE_PREFERENCES_STALE_MS <= now_ms() {
                connection.execute(
                    "DELETE FROM title_track_preferences
                     WHERE user_id = ? AND media_type = ? AND tmdb_id = ?",
                    params![
                        user_id,
                        normalize_title_preference_media_type(&media_type),
                        tmdb_id
                    ],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }

            let result = TitlePreference {
                audioLang: normalize_preferred_audio_lang(&audio_lang),
                subtitleLang: normalize_subtitle_preference(&subtitle_lang),
            };
            return_connection(&pool, connection);
            Ok(Some(result))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn persist_title_preference(
        &self,
        user_id: i64,
        media_type: String,
        tmdb_id: String,
        audio_lang: String,
        subtitle_lang: String,
    ) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let media_type = normalize_title_preference_media_type(&media_type);
            let normalized_audio = normalize_preferred_audio_lang(&audio_lang);
            let normalized_subtitle = normalize_subtitle_preference(&subtitle_lang);
            let tx = connection.unchecked_transaction()?;
            tx.execute(
                "
                INSERT INTO title_track_preferences (
                  user_id,
                  media_type,
                  tmdb_id,
                  preferred_audio_lang,
                  preferred_subtitle_lang,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, media_type, tmdb_id) DO UPDATE SET
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
                    user_id,
                    media_type,
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
                let _ = tx.execute(
                    "DELETE FROM playback_sessions WHERE tmdb_id = ? AND audio_lang = 'auto'",
                    [tmdb_id.as_str()],
                );
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_title_preference(
        &self,
        user_id: i64,
        media_type: String,
        tmdb_id: String,
    ) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let media_type = normalize_title_preference_media_type(&media_type);
            connection.execute(
                "DELETE FROM title_track_preferences
                 WHERE user_id = ? AND media_type = ? AND tmdb_id = ?",
                params![user_id, media_type, tmdb_id],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_playback_sessions_for_tmdb(&self, tmdb_id: String) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM playback_sessions WHERE tmdb_id = ?",
                [tmdb_id.as_str()],
            )?;
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM movie_quick_start_cache WHERE cache_key LIKE ?",
                [format!("{tmdb_id}:%")],
            )?;
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || get_playback_session_inner(&pool, &path, session_key))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_latest_playback_session_for_tmdb(
        &self,
        tmdb_id: String,
    ) -> AppResult<Option<PlaybackSession>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
            match key {
                Some(session_key) => get_playback_session_inner(&pool, &path, session_key),
                None => Ok(None),
            }
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_latest_healthy_playback_sessions_for_tmdb(
        &self,
        tmdb_id: String,
        limit: i64,
    ) -> AppResult<Vec<PlaybackSession>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let normalized_limit = limit.clamp(1, 100);
            let connection = take_connection(&pool, &path)?;
            let mut statement = connection.prepare(
                "
                    SELECT session_key
                    FROM playback_sessions
                    WHERE tmdb_id = ?
                      AND health_state != 'invalid'
                      AND playable_url != ''
                    ORDER BY updated_at DESC
                    LIMIT ?
                    ",
            )?;
            let keys = statement
                .query_map(params![tmdb_id.as_str(), normalized_limit], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            return_connection(&pool, connection);
            let mut sessions = Vec::new();
            for session_key in keys {
                if let Some(session) = get_playback_session_inner(&pool, &path, session_key)? {
                    sessions.push(session);
                }
            }
            Ok::<Vec<PlaybackSession>, rusqlite::Error>(sessions)
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let Some(existing) = get_playback_session_inner(&pool, &path, session_key.clone())?
            else {
                return Ok(false);
            };
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
            Ok(true)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn invalidate_playback_sessions_by_source_hash(
        &self,
        source_hash: String,
        reason: String,
    ) -> AppResult<usize> {
        let normalized_source_hash = source_hash.trim().to_lowercase();
        if normalized_source_hash.is_empty() {
            return Ok(0);
        }
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let updated = connection.execute(
                "
                UPDATE playback_sessions
                SET
                  health_state = 'invalid',
                  health_fail_count = health_fail_count + 1,
                  last_error = ?,
                  updated_at = ?,
                  last_accessed_at = ?
                WHERE source_hash = ?
                  AND health_state != 'invalid'
                ",
                params![
                    reason.chars().take(500).collect::<String>(),
                    now,
                    now,
                    normalized_source_hash,
                ],
            )?;
            return_connection(&pool, connection);
            Ok::<usize, rusqlite::Error>(updated)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn refresh_playback_session_validation_window(
        &self,
        session_key: String,
    ) -> AppResult<bool> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
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

        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let normalized_audio_lang = normalize_preferred_audio_lang(&input.audio_lang);
            let normalized_quality = normalize_preferred_stream_quality(&input.preferred_quality);
            let session_key = input.session_key.trim().to_owned();
            let existing = get_playback_session_inner(&pool, &path, session_key.clone())?;
            let auto_session_key = if normalized_audio_lang != "auto" {
                build_related_playback_session_key_with_audio(
                    &session_key,
                    &input.tmdb_id,
                    "auto",
                    &normalized_quality,
                )
            } else {
                String::new()
            };
            let auto_session = if !auto_session_key.is_empty() && auto_session_key != session_key {
                get_playback_session_inner(&pool, &path, auto_session_key.clone())?
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
            let tx = connection.unchecked_transaction()?;
            tx.execute(
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
                let _ = tx.execute(
                    "DELETE FROM playback_sessions WHERE session_key = ?",
                    [auto_session_key.as_str()],
                );
            }
            tx.commit()?;
            trim_table(
                &connection,
                "playback_sessions",
                "updated_at",
                PLAYBACK_SESSION_PERSIST_MAX_ENTRIES,
            )?;
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
                return_connection(&pool, connection);
                return Ok(None);
            };
            if updated_at == 0 || updated_at + SOURCE_HEALTH_STALE_MS <= now_ms() {
                connection.execute(
                    "DELETE FROM source_health_stats WHERE source_key = ?",
                    [source_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            let result = SourceHealthStats {
                success_count: success_count.max(0),
                failure_count: failure_count.max(0),
                decode_failure_count: decode_failure_count.max(0),
                ended_early_count: ended_early_count.max(0),
                playback_error_count: playback_error_count.max(0),
            };
            return_connection(&pool, connection);
            Ok(Some(result))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    /// Lifetime success / failure totals summed across every tracked source.
    /// Used as the cumulative playback signal the health sampler deltas over a
    /// window. Note these reset to zero when `clear_persistent_caches` runs.
    pub async fn source_health_totals(&self) -> AppResult<(i64, i64)> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let totals = connection.query_row(
                "SELECT
                   COALESCE(SUM(total_success_count), 0),
                   COALESCE(SUM(total_failure_count), 0)
                 FROM source_health_stats",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            return_connection(&pool, connection);
            Ok::<(i64, i64), rusqlite::Error>(totals)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Append one row to the restart log. Called once at process startup.
    pub async fn record_service_start(&self, note: String) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "INSERT INTO service_starts (started_at, note) VALUES (?1, ?2)",
                params![now_ms(), note.chars().take(200).collect::<String>()],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Restart records at or after `since_ms`, newest first.
    pub async fn service_starts_since(&self, since_ms: i64) -> AppResult<Vec<ServiceStartRow>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let mut stmt = connection.prepare(
                "SELECT started_at, note FROM service_starts
                 WHERE started_at >= ?1 ORDER BY started_at DESC",
            )?;
            let rows = stmt
                .query_map([since_ms], |row| {
                    Ok(ServiceStartRow {
                        startedAt: row.get::<_, i64>(0)?,
                        note: row.get::<_, String>(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            return_connection(&pool, connection);
            Ok::<Vec<ServiceStartRow>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Store a user-submitted feedback message. `email`/`display_name` are
    /// snapshotted so the row stays attributable if the account is later deleted.
    pub async fn insert_feedback(
        &self,
        user_id: i64,
        email: String,
        display_name: String,
        message: String,
        image_data: Option<Vec<u8>>,
        image_mime: String,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "INSERT INTO feedback (user_id, email, display_name, message, image_data, image_mime, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![user_id, email, display_name, message, image_data, image_mime, now_ms()],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Feedback messages, newest first, for the admin dashboard. The attached
    /// image (if any) is not included here — only a `hasImage` flag — so the
    /// list stays light; the bytes are fetched lazily via `feedback_image`.
    pub async fn admin_feedback(&self, limit: i64) -> AppResult<Vec<FeedbackRow>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let limit = limit.clamp(1, 500);
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let mut stmt = connection.prepare(
                "SELECT id, email, display_name, message, image_data IS NOT NULL, created_at
                 FROM feedback ORDER BY created_at DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map([limit], |row| {
                    Ok(FeedbackRow {
                        id: row.get::<_, i64>(0)?,
                        email: row.get::<_, String>(1)?,
                        displayName: row.get::<_, String>(2)?,
                        message: row.get::<_, String>(3)?,
                        hasImage: row.get::<_, bool>(4)?,
                        createdAt: row.get::<_, i64>(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            return_connection(&pool, connection);
            Ok::<Vec<FeedbackRow>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// The image attached to a feedback row, as `(bytes, mime)`. Returns `None`
    /// when the row doesn't exist or has no attachment.
    pub async fn feedback_image(&self, id: i64) -> AppResult<Option<(Vec<u8>, String)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let result = connection
                .query_row(
                    "SELECT image_data, image_mime FROM feedback WHERE id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, Option<Vec<u8>>>(0)?,
                            row.get::<_, String>(1)?,
                        ))
                    },
                )
                .optional()?;
            return_connection(&pool, connection);
            Ok::<Option<(Vec<u8>, String)>, rusqlite::Error>(
                result.and_then(|(data, mime)| data.map(|bytes| (bytes, mime))),
            )
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn insert_health_sample(&self, sample: HealthSampleRow) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "INSERT OR REPLACE INTO health_samples (
                   ts, uptime_seconds, status, fd_count, fd_limit, mem_used, mem_total,
                   load1, num_cpus, disk_free, disk_total, req_total, req_4xx, req_5xx,
                   live_proxy_5xx, req_5xx_rate, playback_success_total,
                   playback_failure_total, playback_failure_rate,
                   worst_provider_consecutive_failures
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18, ?19, ?20
                 )",
                params![
                    sample.ts,
                    sample.uptimeSeconds,
                    sample.status,
                    sample.fdCount,
                    sample.fdLimit,
                    sample.memUsed,
                    sample.memTotal,
                    sample.load1,
                    sample.numCpus,
                    sample.diskFree,
                    sample.diskTotal,
                    sample.reqTotal,
                    sample.req4xx,
                    sample.req5xx,
                    sample.liveProxy5xx,
                    sample.req5xxRate,
                    sample.playbackSuccessTotal,
                    sample.playbackFailureTotal,
                    sample.playbackFailureRate,
                    sample.worstProviderConsecutiveFailures,
                ],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Health samples at or after `since_ms`, oldest first (chart-ready order).
    pub async fn recent_health_samples(&self, since_ms: i64) -> AppResult<Vec<HealthSampleRow>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let mut stmt = connection.prepare(
                "SELECT ts, uptime_seconds, status, fd_count, fd_limit, mem_used, mem_total,
                        load1, num_cpus, disk_free, disk_total, req_total, req_4xx, req_5xx,
                        live_proxy_5xx, req_5xx_rate, playback_success_total,
                        playback_failure_total, playback_failure_rate,
                        worst_provider_consecutive_failures
                 FROM health_samples WHERE ts >= ?1 ORDER BY ts ASC",
            )?;
            let rows = stmt
                .query_map([since_ms], |row| {
                    Ok(HealthSampleRow {
                        ts: row.get(0)?,
                        uptimeSeconds: row.get(1)?,
                        status: row.get(2)?,
                        fdCount: row.get(3)?,
                        fdLimit: row.get(4)?,
                        memUsed: row.get(5)?,
                        memTotal: row.get(6)?,
                        load1: row.get(7)?,
                        numCpus: row.get(8)?,
                        diskFree: row.get(9)?,
                        diskTotal: row.get(10)?,
                        reqTotal: row.get(11)?,
                        req4xx: row.get(12)?,
                        req5xx: row.get(13)?,
                        liveProxy5xx: row.get(14)?,
                        req5xxRate: row.get(15)?,
                        playbackSuccessTotal: row.get(16)?,
                        playbackFailureTotal: row.get(17)?,
                        playbackFailureRate: row.get(18)?,
                        worstProviderConsecutiveFailures: row.get(19)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            return_connection(&pool, connection);
            Ok::<Vec<HealthSampleRow>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_tmdb_cache(&self, cache_key: String) -> AppResult<Option<(Value, i64)>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
                return_connection(&pool, connection);
                return Ok(None);
            };
            if expires_at <= now_ms() {
                connection.execute(
                    "DELETE FROM tmdb_response_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() {
                connection.execute(
                    "DELETE FROM tmdb_response_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn extend_tmdb_cache_expiration(
        &self,
        cache_key: String,
        expires_at: i64,
    ) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "
                UPDATE tmdb_response_cache
                SET expires_at = ?, updated_at = ?
                WHERE cache_key = ?
                  AND expires_at < ?
                ",
                params![expires_at, now_ms(), cache_key, expires_at],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_home_bootstrap_cache(&self) -> AppResult<Option<(Value, i64)>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT payload_json, refreshed_at FROM home_bootstrap_cache WHERE id = 1",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            return_connection(&pool, connection);
            let Some((payload_json, refreshed_at)) = row else {
                return Ok(None);
            };
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() {
                return Ok(None);
            }
            Ok(Some((parsed, refreshed_at)))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn set_home_bootstrap_cache(
        &self,
        payload: Value,
        refreshed_at: i64,
    ) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "
                INSERT INTO home_bootstrap_cache (id, payload_json, refreshed_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  refreshed_at = excluded.refreshed_at
                ",
                params![
                    serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_owned()),
                    refreshed_at,
                ],
            )?;
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
                return_connection(&pool, connection);
                return Ok(None);
            };
            if expires_at <= now_ms() {
                connection.execute(
                    "DELETE FROM resolved_stream_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() || !parsed.is_object() {
                connection.execute(
                    "DELETE FROM resolved_stream_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
                return_connection(&pool, connection);
                return Ok(None);
            };
            if expires_at <= now_ms() {
                connection.execute(
                    "DELETE FROM movie_quick_start_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() || !parsed.is_object() {
                connection.execute(
                    "DELETE FROM movie_quick_start_cache WHERE cache_key = ?",
                    [cache_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            return_connection(&pool, connection);
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
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_movie_quick_start_cache(&self, cache_key: String) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM movie_quick_start_cache WHERE cache_key = ?",
                [cache_key.as_str()],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_media_probe_cache(&self, probe_key: String) -> AppResult<Option<Value>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
                return_connection(&pool, connection);
                return Ok(None);
            };
            if updated_at == 0 || updated_at + MEDIA_PROBE_STALE_MS <= now_ms() {
                connection.execute(
                    "DELETE FROM media_probe_cache WHERE probe_key = ?",
                    [probe_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            let parsed = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            if parsed.is_null() || !parsed.is_object() {
                connection.execute(
                    "DELETE FROM media_probe_cache WHERE probe_key = ?",
                    [probe_key.as_str()],
                )?;
                return_connection(&pool, connection);
                return Ok(None);
            }
            return_connection(&pool, connection);
            Ok(Some(parsed))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error: rusqlite::Error| ApiError::internal(error.to_string()))
    }

    pub async fn set_media_probe_cache(&self, probe_key: String, payload: Value) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
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
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    // ── User / Auth methods ──────────────────────────────────────────

    pub async fn create_user(
        &self,
        email: String,
        password_hash: String,
        display_name: String,
    ) -> AppResult<i64> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            connection.execute(
                "INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)",
                params![email, password_hash, display_name, now, now],
            )?;
            let id = connection.last_insert_rowid();
            return_connection(&pool, connection);
            Ok::<i64, rusqlite::Error>(id)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn create_first_user(
        &self,
        email: String,
        password_hash: String,
        display_name: String,
    ) -> AppResult<Option<i64>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let inserted = connection.execute(
                "INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM users LIMIT 1)",
                params![email, password_hash, display_name, now, now],
            )?;
            let id = if inserted > 0 {
                Some(connection.last_insert_rowid())
            } else {
                None
            };
            return_connection(&pool, connection);
            Ok::<Option<i64>, rusqlite::Error>(id)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn user_count(&self) -> AppResult<i64> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let count = connection
                .query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_, i64>(0))?;
            return_connection(&pool, connection);
            Ok::<i64, rusqlite::Error>(count)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_user_by_email(
        &self,
        email: String,
    ) -> AppResult<Option<(i64, String, String, String)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT id, username, password_hash, display_name FROM users WHERE username = ?",
                    [email.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?;
            return_connection(&pool, connection);
            Ok::<Option<(i64, String, String, String)>, rusqlite::Error>(row)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn create_session(
        &self,
        token: String,
        user_id: i64,
        expires_at: i64,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            connection.execute(
                "INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
                 VALUES (?, ?, ?, ?)",
                params![token, user_id, now, expires_at],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_session(&self, token: String) -> AppResult<Option<(i64, i64)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT user_id, expires_at FROM auth_sessions WHERE token = ?",
                    [token.as_str()],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            return_connection(&pool, connection);
            Ok::<Option<(i64, i64)>, rusqlite::Error>(row)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn delete_session(&self, token: String) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM auth_sessions WHERE token = ?",
                [token.as_str()],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    // ── Admin dashboard ──────────────────────────────────────────────

    /// Identity + authorization flags for a user. Used by `require_auth`
    /// (which also enforces `is_disabled`) and `require_admin`.
    pub async fn get_auth_user(
        &self,
        user_id: i64,
    ) -> AppResult<Option<(i64, String, String, bool, bool)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT id, username, display_name, is_admin, is_disabled
                     FROM users WHERE id = ?",
                    [user_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)? != 0,
                            row.get::<_, i64>(4)? != 0,
                        ))
                    },
                )
                .optional()?;
            return_connection(&pool, connection);
            Ok::<Option<(i64, String, String, bool, bool)>, rusqlite::Error>(row)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn admin_overview(&self) -> AppResult<AdminOverview> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let day = 24 * 60 * 60 * 1000i64;
            let scalar = |sql: &str| connection.query_row(sql, [], |row| row.get::<_, i64>(0));
            let scalar1 =
                |sql: &str, arg: i64| connection.query_row(sql, [arg], |row| row.get::<_, i64>(0));
            let overview = AdminOverview {
                totalUsers: scalar("SELECT COUNT(*) FROM users")?,
                newUsers24h: scalar1("SELECT COUNT(*) FROM users WHERE created_at >= ?", now - day)?,
                newUsers7d: scalar1(
                    "SELECT COUNT(*) FROM users WHERE created_at >= ?",
                    now - 7 * day,
                )?,
                newUsers30d: scalar1(
                    "SELECT COUNT(*) FROM users WHERE created_at >= ?",
                    now - 30 * day,
                )?,
                verifiedUsers: scalar("SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL")?,
                adminUsers: scalar("SELECT COUNT(*) FROM users WHERE is_admin = 1")?,
                disabledUsers: scalar("SELECT COUNT(*) FROM users WHERE is_disabled = 1")?,
                activeSessions: scalar1("SELECT COUNT(*) FROM auth_sessions WHERE expires_at > ?", now)?,
                activeUsers: scalar1(
                    "SELECT COUNT(DISTINCT user_id) FROM auth_sessions WHERE expires_at > ?",
                    now,
                )?,
                continueWatchingItems: scalar("SELECT COUNT(*) FROM user_continue_watching")?,
                myListItems: scalar("SELECT COUNT(*) FROM user_my_list")?,
                watchProgressItems: scalar("SELECT COUNT(*) FROM user_watch_progress")?,
            };
            return_connection(&pool, connection);
            Ok::<AdminOverview, rusqlite::Error>(overview)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// New sign-ups per UTC day for the last `days` days, zero-filled so the
    /// chart always has a continuous axis.
    pub async fn admin_growth(&self, days: i64) -> AppResult<Vec<AdminDailyCount>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let days = days.clamp(1, 90);
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let start_modifier = format!("-{} days", days - 1);
            let mut stmt = connection.prepare(
                "WITH RECURSIVE dates(d) AS (
                   SELECT date('now', ?1)
                   UNION ALL
                   SELECT date(d, '+1 day') FROM dates WHERE d < date('now')
                 )
                 SELECT d,
                        (SELECT COUNT(*) FROM users
                          WHERE date(created_at / 1000, 'unixepoch') = d) AS signups
                 FROM dates
                 ORDER BY d",
            )?;
            let rows = stmt
                .query_map([start_modifier.as_str()], |row| {
                    Ok(AdminDailyCount {
                        date: row.get::<_, String>(0)?,
                        signups: row.get::<_, i64>(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            return_connection(&pool, connection);
            Ok::<Vec<AdminDailyCount>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn admin_users(
        &self,
        search: String,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<AdminUserRow>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let limit = limit.clamp(1, 500);
        let offset = offset.max(0);
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let like = format!("%{}%", search);
            let mut stmt = connection.prepare(
                "SELECT
                   u.id,
                   u.username,
                   u.display_name,
                   u.created_at,
                   u.email_verified_at,
                   u.is_admin,
                   u.is_disabled,
                   (SELECT COUNT(*) FROM auth_sessions s
                      WHERE s.user_id = u.id AND s.expires_at > ?1) AS active_sessions,
                   (SELECT COUNT(*) FROM user_continue_watching c WHERE c.user_id = u.id) AS cw,
                   (SELECT COUNT(*) FROM user_my_list m WHERE m.user_id = u.id) AS ml,
                   (SELECT MAX(t) FROM (
                      SELECT MAX(updated_at) AS t FROM user_continue_watching WHERE user_id = u.id
                      UNION ALL
                      SELECT MAX(updated_at) FROM user_watch_progress WHERE user_id = u.id
                      UNION ALL
                      SELECT MAX(created_at) FROM auth_sessions WHERE user_id = u.id
                    )) AS last_active
                 FROM users u
                 WHERE ?2 = '' OR u.username LIKE ?3 OR u.display_name LIKE ?3
                 ORDER BY u.created_at DESC
                 LIMIT ?4 OFFSET ?5",
            )?;
            let rows = stmt
                .query_map(params![now, search, like, limit, offset], |row| {
                    Ok(AdminUserRow {
                        id: row.get::<_, i64>(0)?,
                        email: row.get::<_, String>(1)?,
                        displayName: row.get::<_, String>(2)?,
                        createdAt: row.get::<_, i64>(3)?,
                        emailVerifiedAt: row.get::<_, Option<i64>>(4)?,
                        isAdmin: row.get::<_, i64>(5)? != 0,
                        isDisabled: row.get::<_, i64>(6)? != 0,
                        sessionCount: row.get::<_, i64>(7)?,
                        continueWatchingCount: row.get::<_, i64>(8)?,
                        myListCount: row.get::<_, i64>(9)?,
                        lastActiveAt: row.get::<_, Option<i64>>(10)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            return_connection(&pool, connection);
            Ok::<Vec<AdminUserRow>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// A merged, time-sorted feed of recent sign-ins, watches, and sign-ups.
    pub async fn admin_activity(&self, limit: i64) -> AppResult<Vec<AdminActivityEvent>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let limit = limit.clamp(1, 200);
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let mut events: Vec<AdminActivityEvent> = Vec::new();

            {
                let mut stmt = connection.prepare(
                    "SELECT s.created_at, u.username, u.display_name
                     FROM auth_sessions s JOIN users u ON u.id = s.user_id
                     ORDER BY s.created_at DESC LIMIT ?1",
                )?;
                let rows = stmt
                    .query_map([limit], |row| {
                        Ok(AdminActivityEvent {
                            kind: "login".to_owned(),
                            ts: row.get::<_, i64>(0)?,
                            email: row.get::<_, String>(1)?,
                            displayName: row.get::<_, String>(2)?,
                            title: String::new(),
                            detail: "Signed in".to_owned(),
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                events.extend(rows);
            }
            {
                let mut stmt = connection.prepare(
                    "SELECT c.updated_at, u.username, u.display_name, c.title, c.episode
                     FROM user_continue_watching c JOIN users u ON u.id = c.user_id
                     ORDER BY c.updated_at DESC LIMIT ?1",
                )?;
                let rows = stmt
                    .query_map([limit], |row| {
                        let title = row.get::<_, String>(3)?;
                        let episode = row.get::<_, String>(4)?;
                        let detail = if episode.trim().is_empty() {
                            "Watched".to_owned()
                        } else {
                            format!("Watched · {}", episode)
                        };
                        Ok(AdminActivityEvent {
                            kind: "watch".to_owned(),
                            ts: row.get::<_, i64>(0)?,
                            email: row.get::<_, String>(1)?,
                            displayName: row.get::<_, String>(2)?,
                            title,
                            detail,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                events.extend(rows);
            }
            {
                let mut stmt = connection.prepare(
                    "SELECT created_at, username, display_name FROM users
                     ORDER BY created_at DESC LIMIT ?1",
                )?;
                let rows = stmt
                    .query_map([limit], |row| {
                        Ok(AdminActivityEvent {
                            kind: "signup".to_owned(),
                            ts: row.get::<_, i64>(0)?,
                            email: row.get::<_, String>(1)?,
                            displayName: row.get::<_, String>(2)?,
                            title: String::new(),
                            detail: "Created account".to_owned(),
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                events.extend(rows);
            }
            {
                let mut stmt = connection.prepare(
                    "SELECT l.created_at, u.username, u.display_name, l.title
                     FROM live_watch_events l JOIN users u ON u.id = l.user_id
                     ORDER BY l.created_at DESC LIMIT ?1",
                )?;
                let rows = stmt
                    .query_map([limit], |row| {
                        Ok(AdminActivityEvent {
                            kind: "live".to_owned(),
                            ts: row.get::<_, i64>(0)?,
                            email: row.get::<_, String>(1)?,
                            displayName: row.get::<_, String>(2)?,
                            title: row.get::<_, String>(3)?,
                            detail: "Watched live".to_owned(),
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                events.extend(rows);
            }

            return_connection(&pool, connection);
            events.sort_by(|a, b| b.ts.cmp(&a.ts));
            events.truncate(limit as usize);
            Ok::<Vec<AdminActivityEvent>, rusqlite::Error>(events)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Append one live-watch event (sports / live channel). Best-effort retention:
    /// prune rows older than 60 days on each insert so the table stays small.
    pub async fn record_live_watch(
        &self,
        user_id: i64,
        title: String,
        category: String,
        source_identity: String,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            connection.execute(
                "INSERT INTO live_watch_events (user_id, title, category, source_identity, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![user_id, title, category, source_identity, now],
            )?;
            let _ = connection.execute(
                "DELETE FROM live_watch_events WHERE created_at < ?1",
                params![now - 60 * 24 * 60 * 60 * 1000i64],
            );
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Most-watched live titles over the last `days`, ranked by play count.
    pub async fn admin_top_live_streams(
        &self,
        days: i64,
        limit: i64,
    ) -> AppResult<Vec<AdminLiveStreamRow>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let days = days.clamp(1, 90);
        let limit = limit.clamp(1, 50);
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let since = now_ms() - days * 24 * 60 * 60 * 1000;
            let mut stmt = connection.prepare(
                "SELECT title,
                        MAX(category) AS category,
                        COUNT(*) AS plays,
                        COUNT(DISTINCT user_id) AS viewers,
                        MAX(created_at) AS last_at
                 FROM live_watch_events
                 WHERE created_at >= ?1 AND title <> ''
                 GROUP BY title
                 ORDER BY plays DESC, last_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![since, limit], |row| {
                    Ok(AdminLiveStreamRow {
                        title: row.get::<_, String>(0)?,
                        category: row.get::<_, String>(1)?,
                        plays: row.get::<_, i64>(2)?,
                        viewers: row.get::<_, i64>(3)?,
                        lastAt: row.get::<_, i64>(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            return_connection(&pool, connection);
            Ok::<Vec<AdminLiveStreamRow>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Set a new password hash and force re-login by clearing the user's
    /// sessions. Returns the number of user rows changed (0 = no such user).
    pub async fn admin_set_password(
        &self,
        user_id: i64,
        password_hash: String,
    ) -> AppResult<usize> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let tx = connection.unchecked_transaction()?;
            let changed = tx.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                params![password_hash, now_ms(), user_id],
            )?;
            if changed > 0 {
                tx.execute("DELETE FROM auth_sessions WHERE user_id = ?", [user_id])?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<usize, rusqlite::Error>(changed)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn admin_set_disabled(&self, user_id: i64, disabled: bool) -> AppResult<usize> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let tx = connection.unchecked_transaction()?;
            let changed = tx.execute(
                "UPDATE users SET is_disabled = ?, updated_at = ? WHERE id = ?",
                params![i64::from(disabled), now_ms(), user_id],
            )?;
            if disabled && changed > 0 {
                tx.execute("DELETE FROM auth_sessions WHERE user_id = ?", [user_id])?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<usize, rusqlite::Error>(changed)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn admin_set_admin(&self, user_id: i64, is_admin: bool) -> AppResult<usize> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let changed = connection.execute(
                "UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?",
                params![i64::from(is_admin), now_ms(), user_id],
            )?;
            return_connection(&pool, connection);
            Ok::<usize, rusqlite::Error>(changed)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Hard-delete a user. ON DELETE CASCADE removes their sessions,
    /// preferences, watch progress, continue-watching, and list rows.
    pub async fn admin_delete_user(&self, user_id: i64) -> AppResult<usize> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let changed = connection.execute("DELETE FROM users WHERE id = ?", [user_id])?;
            return_connection(&pool, connection);
            Ok::<usize, rusqlite::Error>(changed)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    // ── Email verification ───────────────────────────────────────────

    /// Store a verification token (hashed) for an email, replacing any prior
    /// token for that email so only the most recent link stays valid.
    pub async fn create_email_verification_token(
        &self,
        email: String,
        token_hash: String,
        expires_at: i64,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            connection.execute(
                "DELETE FROM email_verification_tokens WHERE email = ?",
                [email.as_str()],
            )?;
            connection.execute(
                "INSERT INTO email_verification_tokens (token_hash, email, expires_at, created_at)
                 VALUES (?, ?, ?, ?)",
                params![token_hash, email, expires_at, now],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Look up a verification token by its hash and delete it (single-use),
    /// returning the associated email and expiry if it existed. The token is
    /// consumed regardless of expiry so used/stale tokens cannot be replayed.
    pub async fn consume_email_verification_token(
        &self,
        token_hash: String,
    ) -> AppResult<Option<(String, i64)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT email, expires_at FROM email_verification_tokens WHERE token_hash = ?",
                    [token_hash.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            connection.execute(
                "DELETE FROM email_verification_tokens WHERE token_hash = ?",
                [token_hash.as_str()],
            )?;
            return_connection(&pool, connection);
            Ok::<Option<(String, i64)>, rusqlite::Error>(row)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Mark a user's email as verified. Idempotent: only sets the timestamp the
    /// first time (the `email_verified_at IS NULL` guard).
    pub async fn mark_email_verified(&self, email: String, verified_at: i64) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "UPDATE users SET email_verified_at = ?, updated_at = ?
                 WHERE username = ? AND email_verified_at IS NULL",
                params![verified_at, now_ms(), email],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    // ── Password reset ───────────────────────────────────────────────

    /// Store a reset token (hashed) for an email, replacing any prior token so
    /// only the most recent link stays valid.
    pub async fn create_password_reset_token(
        &self,
        email: String,
        token_hash: String,
        expires_at: i64,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            connection.execute(
                "DELETE FROM password_reset_tokens WHERE email = ?",
                [email.as_str()],
            )?;
            connection.execute(
                "INSERT INTO password_reset_tokens (token_hash, email, expires_at, created_at)
                 VALUES (?, ?, ?, ?)",
                params![token_hash, email, expires_at, now],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Look up a reset token by its hash and delete it (single-use), returning
    /// the associated email and expiry if it existed. Consumed regardless of
    /// expiry so used/stale tokens cannot be replayed.
    pub async fn consume_password_reset_token(
        &self,
        token_hash: String,
    ) -> AppResult<Option<(String, i64)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT email, expires_at FROM password_reset_tokens WHERE token_hash = ?",
                    [token_hash.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            connection.execute(
                "DELETE FROM password_reset_tokens WHERE token_hash = ?",
                [token_hash.as_str()],
            )?;
            return_connection(&pool, connection);
            Ok::<Option<(String, i64)>, rusqlite::Error>(row)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Set a user's password by email and clear their sessions (force re-login
    /// everywhere). Returns rows changed (0 = no such user).
    pub async fn set_password_by_email(
        &self,
        email: String,
        password_hash: String,
    ) -> AppResult<usize> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let tx = connection.unchecked_transaction()?;
            let changed = tx.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?",
                params![password_hash, now_ms(), email],
            )?;
            if changed > 0 {
                tx.execute(
                    "DELETE FROM auth_sessions
                     WHERE user_id IN (SELECT id FROM users WHERE username = ?)",
                    [email.as_str()],
                )?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<usize, rusqlite::Error>(changed)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Returns the verification timestamp for a user, or None if unverified or
    /// the user does not exist.
    pub async fn email_verified_at(&self, user_id: i64) -> AppResult<Option<i64>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let row = connection
                .query_row(
                    "SELECT email_verified_at FROM users WHERE id = ?",
                    [user_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?;
            return_connection(&pool, connection);
            Ok::<Option<i64>, rusqlite::Error>(row.flatten())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_user_preferences(&self, user_id: i64) -> AppResult<Vec<(String, String)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection.prepare(
                    "SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?",
                )?;
                stmt.query_map([user_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            return_connection(&pool, connection);
            Ok::<Vec<(String, String)>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_user_preference(
        &self,
        user_id: i64,
        pref_key: String,
    ) -> AppResult<Option<String>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let value = {
                let mut stmt = connection.prepare(
                    "SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = ?",
                )?;
                stmt.query_row(params![user_id, pref_key], |row| row.get::<_, String>(0))
                    .optional()?
            };
            return_connection(&pool, connection);
            Ok::<Option<String>, rusqlite::Error>(value)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn upsert_user_preferences(
        &self,
        user_id: i64,
        entries: Vec<(String, String)>,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let tx = connection.unchecked_transaction()?;
            for (key, value) in &entries {
                tx.execute(
                    "INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id, pref_key) DO UPDATE SET
                       pref_value = excluded.pref_value,
                       updated_at = excluded.updated_at",
                    params![user_id, key, value, now],
                )?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_user_preference(&self, user_id: i64, pref_key: String) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM user_preferences WHERE user_id = ? AND pref_key = ?",
                params![user_id, pref_key],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_user_watch_progress(
        &self,
        user_id: i64,
    ) -> AppResult<Vec<(String, f64, i64)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection.prepare(
                    "SELECT source_identity, resume_seconds, updated_at
                     FROM user_watch_progress WHERE user_id = ?",
                )?;
                stmt.query_map([user_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            return_connection(&pool, connection);
            Ok::<Vec<(String, f64, i64)>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn upsert_user_watch_progress(
        &self,
        user_id: i64,
        source_identity: String,
        resume_seconds: f64,
        updated_at: i64,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "INSERT INTO user_watch_progress (user_id, source_identity, resume_seconds, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, source_identity) DO UPDATE SET
                   resume_seconds = excluded.resume_seconds,
                   updated_at = excluded.updated_at",
                params![user_id, source_identity, resume_seconds, updated_at],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_user_watch_progress(
        &self,
        user_id: i64,
        source_identity: String,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM user_watch_progress WHERE user_id = ? AND source_identity = ?",
                params![user_id, source_identity],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_user_watch_progress_for_series(
        &self,
        user_id: i64,
        series_id: String,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let normalized_series_id = series_id.trim().to_ascii_lowercase();
            let source_prefix = format!("series:{normalized_series_id}:episode:%");
            if let Some(tmdb_id) = tmdb_tv_id_from_series_id(&normalized_series_id) {
                let tmdb_source = format!("tmdb:tv:{tmdb_id}");
                let tmdb_source_prefix = format!("{tmdb_source}:%");
                connection.execute(
                    "DELETE FROM user_watch_progress
                     WHERE user_id = ?
                       AND (
                         source_identity LIKE ?
                         OR source_identity = ?
                         OR source_identity LIKE ?
                       )",
                    params![user_id, source_prefix, tmdb_source, tmdb_source_prefix],
                )?;
            } else {
                connection.execute(
                    "DELETE FROM user_watch_progress
                     WHERE user_id = ? AND source_identity LIKE ?",
                    params![user_id, source_prefix],
                )?;
            }
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_user_continue_watching(&self, user_id: i64) -> AppResult<Vec<Value>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        // Reconciliation reads `playback_sessions`, which lives in the cache DB.
        let cache_path = self.cache_path.clone();
        let cache_pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection.prepare(
                    "SELECT source_identity, title, episode, src, tmdb_id, media_type,
                            series_id, episode_index, year, thumb,
                            source_hash, session_key, resolver_provider, source_input, filename,
                            resume_seconds, updated_at
                     FROM user_continue_watching WHERE user_id = ?
                     ORDER BY updated_at DESC",
                )?;
                stmt.query_map([user_id], |row| {
                    Ok(ContinueWatchingRow {
                        source_identity: row.get(0)?,
                        title: row.get(1)?,
                        episode: row.get(2)?,
                        src: row.get(3)?,
                        tmdb_id: row.get(4)?,
                        media_type: row.get(5)?,
                        series_id: row.get(6)?,
                        episode_index: row.get(7)?,
                        year: row.get(8)?,
                        thumb: row.get(9)?,
                        source_hash: row.get::<_, String>(10)?.trim().to_lowercase(),
                        session_key: row.get::<_, String>(11)?.trim().to_owned(),
                        resolver_provider: row.get::<_, String>(12)?.trim().to_owned(),
                        source_input: row.get::<_, String>(13)?.trim().to_owned(),
                        filename: row.get::<_, String>(14)?.trim().to_owned(),
                        resume_seconds: row.get(15)?,
                        updated_at: row.get(16)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            // Done with the users DB; reconcile reads only the cache DB below.
            return_connection(&pool, connection);
            let cache_connection = take_connection(&cache_pool, &cache_path)?;
            let mut entries = Vec::with_capacity(rows.len());
            for mut row in rows {
                let (season_number, episode_number) =
                    continue_watching_target_episode(&row.source_identity, row.episode_index, None);
                if let Some(reconciled) = reconcile_continue_watching_source_metadata(
                    &cache_connection,
                    ContinueWatchingReconcileInput {
                        tmdb_id: &row.tmdb_id,
                        media_type: &row.media_type,
                        season_number,
                        episode_number,
                        source_hash: &row.source_hash,
                        session_key: &row.session_key,
                        resolver_provider: &row.resolver_provider,
                        source_input: &row.source_input,
                    },
                )? {
                    row.source_hash = reconciled.source_hash;
                    row.session_key = reconciled.session_key;
                    row.resolver_provider = reconciled.resolver_provider;
                    row.source_input = reconciled.source_input;
                    row.filename = reconciled.filename;
                }
                entries.push(json!({
                    "sourceIdentity": row.source_identity,
                    "title": row.title,
                    "episode": row.episode,
                    "src": row.src,
                    "tmdbId": row.tmdb_id,
                    "mediaType": row.media_type,
                    "seriesId": row.series_id,
                    "episodeIndex": row.episode_index,
                    "year": row.year,
                    "thumb": row.thumb,
                    "sourceHash": row.source_hash,
                    "sessionKey": row.session_key,
                    "resolverProvider": row.resolver_provider,
                    "sourceInput": row.source_input,
                    "filename": row.filename,
                    "resumeSeconds": row.resume_seconds,
                    "updatedAt": row.updated_at,
                }));
            }
            return_connection(&cache_pool, cache_connection);
            Ok::<Vec<Value>, rusqlite::Error>(entries)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_recent_tmdb_tv_warmup_candidates(
        &self,
        limit: usize,
    ) -> AppResult<Vec<TmdbTvWarmupCandidate>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let normalized_limit = limit.clamp(1, 50) as i64;
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let mut candidates = BTreeMap::<String, TmdbTvWarmupCandidate>::new();

            {
                let mut stmt = connection.prepare(
                    "
                    SELECT tmdb_id, source_identity, episode_index, updated_at
                    FROM user_continue_watching
                    WHERE lower(media_type) = 'tv'
                      AND trim(tmdb_id) <> ''
                    ORDER BY updated_at DESC
                    LIMIT ?
                    ",
                )?;
                let rows = stmt
                    .query_map([normalized_limit], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                for (tmdb_id, source_identity, episode_index, updated_at) in rows {
                    let normalized_tmdb_id = tmdb_id.trim().to_owned();
                    if !is_numeric_tmdb_id(&normalized_tmdb_id) {
                        continue;
                    }
                    let (season_number, episode_number) =
                        continue_watching_target_episode(&source_identity, episode_index, None);
                    upsert_warmup_candidate(
                        &mut candidates,
                        TmdbTvWarmupCandidate {
                            tmdb_id: normalized_tmdb_id,
                            season_number,
                            episode_number,
                            updated_at,
                        },
                    );
                }
            }

            {
                let mut stmt = connection.prepare(
                    "
                    SELECT details_json, added_at
                    FROM user_my_list
                    ORDER BY added_at DESC
                    LIMIT ?
                    ",
                )?;
                let rows = stmt
                    .query_map([normalized_limit], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                for (details_json, added_at) in rows {
                    let details =
                        serde_json::from_str::<Value>(&details_json).unwrap_or_else(|_| json!({}));
                    let media_type = details
                        .get("mediaType")
                        .or_else(|| details.get("media_type"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase();
                    if media_type != "tv" {
                        continue;
                    }
                    let tmdb_id = details
                        .get("tmdbId")
                        .or_else(|| details.get("id"))
                        .and_then(|value| {
                            value
                                .as_str()
                                .map(ToOwned::to_owned)
                                .or_else(|| value.as_i64().map(|number| number.to_string()))
                        })
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    if !is_numeric_tmdb_id(&tmdb_id) {
                        continue;
                    }
                    upsert_warmup_candidate(
                        &mut candidates,
                        TmdbTvWarmupCandidate {
                            tmdb_id,
                            season_number: 1,
                            episode_number: 1,
                            updated_at: added_at,
                        },
                    );
                }
            }

            let mut candidates = candidates.into_values().collect::<Vec<_>>();
            candidates.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            candidates.truncate(normalized_limit as usize);
            return_connection(&pool, connection);
            Ok::<Vec<TmdbTvWarmupCandidate>, rusqlite::Error>(candidates)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn upsert_user_continue_watching(&self, user_id: i64, entry: Value) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        // Reconciliation reads `playback_sessions`, which lives in the cache DB.
        let cache_path = self.cache_path.clone();
        let cache_pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let now = now_ms();
            let source_identity = entry
                .get("sourceIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let title = entry
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let episode = entry
                .get("episode")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let src = entry
                .get("src")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let tmdb_id = entry
                .get("tmdbId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let media_type = entry
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let series_id = entry
                .get("seriesId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let episode_index = entry
                .get("episodeIndex")
                .and_then(Value::as_i64)
                .unwrap_or(-1);
            let year = entry
                .get("year")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let thumb = entry
                .get("thumb")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let resume_seconds = entry
                .get("resumeSeconds")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let mut source_hash = entry
                .get("sourceHash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            let mut session_key = entry
                .get("sessionKey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let mut resolver_provider = entry
                .get("resolverProvider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let mut source_input = entry
                .get("sourceInput")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let mut filename = entry
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let normalized_series_id = series_id.trim().to_ascii_lowercase();
            let normalized_media_type = media_type.trim().to_ascii_lowercase();
            let normalized_tmdb_id = tmdb_id.trim().to_owned();
            let (season_number, episode_number) =
                continue_watching_target_episode(&source_identity, episode_index, Some(&entry));
            // Reconcile against `playback_sessions` (cache DB) on its own
            // connection, then switch to the users DB for the actual write.
            let cache_connection = take_connection(&cache_pool, &cache_path)?;
            let reconciled = reconcile_continue_watching_source_metadata(
                &cache_connection,
                ContinueWatchingReconcileInput {
                    tmdb_id: &normalized_tmdb_id,
                    media_type: &normalized_media_type,
                    season_number,
                    episode_number,
                    source_hash: &source_hash,
                    session_key: &session_key,
                    resolver_provider: &resolver_provider,
                    source_input: &source_input,
                },
            )?;
            return_connection(&cache_pool, cache_connection);
            let connection = take_connection(&pool, &path)?;
            if let Some(reconciled) = reconciled {
                source_hash = reconciled.source_hash;
                session_key = reconciled.session_key;
                resolver_provider = reconciled.resolver_provider;
                source_input = reconciled.source_input;
                filename = reconciled.filename;
            }
            if !normalized_series_id.is_empty() {
                let source_prefix = format!("series:{normalized_series_id}:episode:%");
                if let Some(tmdb_id_from_series) = tmdb_tv_id_from_series_id(&normalized_series_id)
                {
                    let tmdb_source = format!("tmdb:tv:{tmdb_id_from_series}");
                    let tmdb_source_prefix = format!("{tmdb_source}:%");
                    connection.execute(
                        "DELETE FROM user_continue_watching
                         WHERE user_id = ?
                           AND source_identity <> ?
                           AND (
                             lower(series_id) = ?
                             OR source_identity LIKE ?
                             OR source_identity = ?
                             OR source_identity LIKE ?
                             OR (tmdb_id = ? AND lower(media_type) = 'tv')
                           )",
                        params![
                            user_id,
                            source_identity,
                            normalized_series_id,
                            source_prefix,
                            tmdb_source,
                            tmdb_source_prefix,
                            tmdb_id_from_series
                        ],
                    )?;
                } else {
                    connection.execute(
                        "DELETE FROM user_continue_watching
                         WHERE user_id = ?
                           AND source_identity <> ?
                           AND (lower(series_id) = ? OR source_identity LIKE ?)",
                        params![
                            user_id,
                            source_identity,
                            normalized_series_id,
                            source_prefix
                        ],
                    )?;
                }
            }
            if normalized_media_type == "tv" && !normalized_tmdb_id.is_empty() {
                let tmdb_source = format!("tmdb:tv:{normalized_tmdb_id}");
                let tmdb_source_prefix = format!("{tmdb_source}:%");
                connection.execute(
                    "DELETE FROM user_continue_watching
                     WHERE user_id = ?
                       AND source_identity <> ?
                       AND (
                         (tmdb_id = ? AND lower(media_type) = 'tv')
                         OR source_identity = ?
                         OR source_identity LIKE ?
                       )",
                    params![
                        user_id,
                        source_identity,
                        normalized_tmdb_id,
                        tmdb_source,
                        tmdb_source_prefix
                    ],
                )?;
            }
            connection.execute(
                "INSERT INTO user_continue_watching
                   (user_id, source_identity, title, episode, src, tmdb_id, media_type,
                    series_id, episode_index, year, thumb, source_hash, session_key,
                    resolver_provider, source_input, filename, resume_seconds, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, source_identity) DO UPDATE SET
                   title = excluded.title,
                   episode = excluded.episode,
                   src = excluded.src,
                   tmdb_id = excluded.tmdb_id,
                   media_type = excluded.media_type,
                   series_id = excluded.series_id,
                   episode_index = excluded.episode_index,
                   year = excluded.year,
                   thumb = excluded.thumb,
                   source_hash = excluded.source_hash,
                   session_key = excluded.session_key,
                   resolver_provider = excluded.resolver_provider,
                   source_input = excluded.source_input,
                   filename = excluded.filename,
                   resume_seconds = excluded.resume_seconds,
                   updated_at = excluded.updated_at",
                params![
                    user_id,
                    source_identity,
                    title,
                    episode,
                    src,
                    tmdb_id,
                    media_type,
                    series_id,
                    episode_index,
                    year,
                    thumb,
                    source_hash,
                    session_key,
                    resolver_provider,
                    source_input,
                    filename,
                    resume_seconds,
                    now
                ],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_user_continue_watching(
        &self,
        user_id: i64,
        source_identity: String,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM user_continue_watching WHERE user_id = ? AND source_identity = ?",
                params![user_id, source_identity],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_user_continue_watching_for_series(
        &self,
        user_id: i64,
        series_id: String,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let normalized_series_id = series_id.trim().to_ascii_lowercase();
            let source_prefix = format!("series:{normalized_series_id}:episode:%");
            if let Some(tmdb_id) = tmdb_tv_id_from_series_id(&normalized_series_id) {
                let tmdb_source = format!("tmdb:tv:{tmdb_id}");
                let tmdb_source_prefix = format!("{tmdb_source}:%");
                connection.execute(
                    "DELETE FROM user_continue_watching
                     WHERE user_id = ?
                       AND (
                         lower(series_id) = ?
                         OR source_identity LIKE ?
                         OR source_identity = ?
                         OR source_identity LIKE ?
                         OR (tmdb_id = ? AND lower(media_type) = 'tv')
                       )",
                    params![
                        user_id,
                        normalized_series_id,
                        source_prefix,
                        tmdb_source,
                        tmdb_source_prefix,
                        tmdb_id
                    ],
                )?;
            } else {
                connection.execute(
                    "DELETE FROM user_continue_watching
                     WHERE user_id = ?
                       AND (lower(series_id) = ? OR source_identity LIKE ?)",
                    params![user_id, normalized_series_id, source_prefix],
                )?;
            }
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn get_user_my_list(&self, user_id: i64) -> AppResult<Vec<Value>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection.prepare(
                    "SELECT item_identity, details_json, added_at
                     FROM user_my_list WHERE user_id = ?
                     ORDER BY added_at DESC",
                )?;
                stmt.query_map([user_id], |row| {
                    let item_identity: String = row.get(0)?;
                    let details_json: String = row.get(1)?;
                    let added_at: i64 = row.get(2)?;
                    let mut details: Value =
                        serde_json::from_str(&details_json).unwrap_or_else(|_| json!({}));
                    if let Some(obj) = details.as_object_mut() {
                        obj.insert("itemIdentity".to_owned(), Value::String(item_identity));
                        obj.insert("addedAt".to_owned(), Value::Number(added_at.into()));
                    }
                    Ok(details)
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            return_connection(&pool, connection);
            Ok::<Vec<Value>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn replace_user_my_list(&self, user_id: i64, entries: Vec<Value>) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let tx = connection.unchecked_transaction()?;
            tx.execute("DELETE FROM user_my_list WHERE user_id = ?", [user_id])?;
            for entry in &entries {
                let item_identity = entry
                    .get("itemIdentity")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if item_identity.is_empty() {
                    continue;
                }
                let added_at = entry.get("addedAt").and_then(Value::as_i64).unwrap_or(now);
                let details_json = serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_owned());
                tx.execute(
                    "INSERT INTO user_my_list (user_id, item_identity, details_json, added_at)
                     VALUES (?, ?, ?, ?)",
                    params![user_id, item_identity, details_json, added_at],
                )?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }
}

fn get_playback_session_inner(
    pool: &Pool,
    path: &Path,
    session_key: String,
) -> Result<Option<PlaybackSession>, rusqlite::Error> {
    let connection = take_connection(pool, path)?;
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
    return_connection(pool, connection);
    Ok(row)
}

/// Durable, account-bearing tables. These live in `users.sqlite` and are copied
/// out of the legacy combined cache DB on first boot. Ordered parents-first so the
/// `ON DELETE CASCADE` foreign keys are satisfied as rows are migrated.
const DURABLE_TABLES: &[&str] = &[
    "users",
    "auth_sessions",
    "user_preferences",
    "user_watch_progress",
    "user_continue_watching",
    "user_my_list",
    "password_reset_tokens",
    "email_verification_tokens",
    "health_samples",
    "service_starts",
    "feedback",
    "live_watch_events",
];

/// Bring both database files up to schema. The users DB is initialized first and,
/// on its very first boot, seeded from the legacy combined cache DB; the cache DB
/// is initialized last because it may self-heal (quarantine + rebuild), which must
/// not run until any migration has already read whatever it could.
fn initialize_databases(cache_path: &Path, users_path: &Path) -> Result<(), rusqlite::Error> {
    let users_db_existed = users_path.exists();
    init_users_schema(users_path)?;
    if !users_db_existed {
        // First boot for the split: lift durable rows out of the old single-file
        // DB. Best-effort — a corrupt or absent legacy file is not fatal.
        migrate_durable_tables_from_legacy(users_path, cache_path)?;
    }
    init_cache_schema(cache_path)?;
    Ok(())
}

/// Initialize the regenerable cache DB, self-healing from corruption by
/// quarantining the bad file and rebuilding an empty schema. Safe because every
/// table here is regenerable.
fn init_cache_schema(path: &Path) -> Result<(), rusqlite::Error> {
    match build_cache_schema(path) {
        Ok(()) => Ok(()),
        Err(error) if is_corruption_error(&error) => {
            tracing::warn!(
                database = %path.display(),
                error = %error,
                "resolver cache database is corrupt; quarantining it and rebuilding from scratch"
            );
            if let Err(io_error) = quarantine_corrupt_db(path) {
                tracing::error!(
                    database = %path.display(),
                    error = %io_error,
                    "failed to quarantine corrupt resolver cache database; cannot recover"
                );
                return Err(error);
            }
            build_cache_schema(path)
        }
        Err(error) => Err(error),
    }
}

/// Initialize the durable users DB. Unlike the cache DB, a corrupt users file is
/// NEVER quarantined/rebuilt: that would silently delete every account (the
/// 2026-06-09 incident this split exists to prevent). The error is surfaced so a
/// human can recover the file from backup instead.
fn init_users_schema(path: &Path) -> Result<(), rusqlite::Error> {
    build_users_schema(path)
}

/// One-time seed of `users.sqlite` from the legacy combined cache DB. Runs only on
/// the first boot after the split (when `users.sqlite` did not yet exist) and
/// copies every durable table via `ATTACH`. Non-destructive: the legacy rows are
/// left in place as a safety net. Best-effort: if the legacy DB is missing or
/// itself corrupt, nothing is migrated and boot continues (the cache DB is rebuilt
/// separately).
fn migrate_durable_tables_from_legacy(
    users_path: &Path,
    legacy_path: &Path,
) -> Result<(), rusqlite::Error> {
    if !legacy_path.exists() {
        return Ok(());
    }
    let connection = open_connection(users_path)?;
    // A corrupt legacy file may fail to attach outright; treat that as "nothing to
    // migrate" rather than blocking boot.
    let legacy = legacy_path.to_string_lossy().into_owned();
    if connection
        .execute("ATTACH DATABASE ?1 AS legacy", [legacy.as_str()])
        .is_err()
    {
        return Ok(());
    }
    let result = copy_durable_tables(&connection);
    let _ = connection.execute("DETACH DATABASE legacy", []);
    match result {
        Ok(()) => Ok(()),
        Err(error) if is_corruption_error(&error) => {
            tracing::warn!(
                legacy = %legacy_path.display(),
                error = %error,
                "legacy cache database is unreadable; skipping account migration (it will be rebuilt)"
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// Copy every durable table from the attached `legacy` schema into `main`, inside
/// a single transaction. Columns are matched by name (not position) so a legacy DB
/// whose columns were appended via `ALTER` still migrates correctly, and rows are
/// inserted with `OR IGNORE` so a re-run after a crash is harmless.
fn copy_durable_tables(connection: &Connection) -> Result<(), rusqlite::Error> {
    let tx = connection.unchecked_transaction()?;
    let mut migrated_users = 0i64;
    for table in DURABLE_TABLES {
        let legacy_has_table = tx
            .query_row(
                "SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
                [table],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !legacy_has_table {
            continue;
        }
        let dest_columns = schema_table_columns(&tx, "main", table)?;
        let src_columns = schema_table_columns(&tx, "legacy", table)?;
        let shared: Vec<String> = dest_columns
            .into_iter()
            .filter(|column| {
                src_columns
                    .iter()
                    .any(|existing| existing.eq_ignore_ascii_case(column))
            })
            .collect();
        if shared.is_empty() {
            continue;
        }
        let column_list = shared
            .iter()
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ");
        // Child tables carry a `user_id` FK to `users`. A legacy DB can hold orphan
        // rows whose user was deleted without the cascade firing (e.g. inserted
        // while foreign_keys was off); copying those would trip the FK constraint,
        // so drop them by keeping only rows with a surviving parent.
        let parent_filter = if shared.iter().any(|column| column.eq_ignore_ascii_case("user_id")) {
            " WHERE \"user_id\" IN (SELECT id FROM main.\"users\")"
        } else {
            ""
        };
        let copied = tx.execute(
            &format!(
                "INSERT OR IGNORE INTO main.\"{table}\" ({column_list}) \
                 SELECT {column_list} FROM legacy.\"{table}\"{parent_filter}"
            ),
            [],
        )?;
        if *table == "users" {
            migrated_users = copied as i64;
        }
    }
    tx.commit()?;
    if migrated_users > 0 {
        tracing::info!(
            users = migrated_users,
            "migrated durable account data from the legacy cache database into users.sqlite"
        );
    }
    Ok(())
}

/// Column names of `schema.table` (e.g. schema = "main" or "legacy"). PRAGMA does
/// not accept bound parameters, so the identifiers are interpolated; both are
/// internal constants, never user input.
fn schema_table_columns(
    connection: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = connection.prepare(&format!("PRAGMA {schema}.table_info(\"{table}\")"))?;
    stmt.query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()
}

/// True for SQLite errors that mean the database file itself is unusable
/// (malformed pages, or not a database) rather than a transient or logic error.
/// These are the only cases a from-scratch rebuild can recover from — the
/// resolver cache is regenerable, so it is always safe to discard and rebuild.
fn is_corruption_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
}

/// Move a corrupt database file aside (kept for forensics) and remove its stale
/// `-wal`/`-shm` siblings so the next open creates a clean database in its place.
fn quarantine_corrupt_db(path: &Path) -> std::io::Result<()> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let mut backup = corrupt_backup_path(path, &format!("corrupt-{stamp}"));
    let mut attempt = 1u32;
    while backup.exists() {
        backup = corrupt_backup_path(path, &format!("corrupt-{stamp}-{attempt}"));
        attempt += 1;
    }
    std::fs::rename(path, &backup)?;
    tracing::warn!(backup = %backup.display(), "moved corrupt database aside");
    // The write-ahead log and shared-memory files belong to the quarantined
    // database; drop them so SQLite builds a fresh database from scratch.
    let _ = std::fs::remove_file(append_suffix(path, "-wal"));
    let _ = std::fs::remove_file(append_suffix(path, "-shm"));
    Ok(())
}

/// Append a suffix to a path's full filename (not its extension), preserving the
/// original bytes so non-UTF-8 paths survive untouched.
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Build the quarantine path for a corrupt database, inserting the marker before
/// the extension: `resolver-cache.sqlite` -> `resolver-cache.corrupt-<stamp>.sqlite`.
/// Falls back to appending the marker when the path has no stem/extension to split
/// on, so an unusual path still gets moved aside rather than left in place.
fn corrupt_backup_path(path: &Path, marker: &str) -> PathBuf {
    match (path.file_stem(), path.extension()) {
        (Some(stem), Some(extension)) => {
            let mut name = stem.to_os_string();
            name.push(".");
            name.push(marker);
            name.push(".");
            name.push(extension);
            path.with_file_name(name)
        }
        _ => append_suffix(path, &format!(".{marker}")),
    }
}

/// Create the regenerable cache tables in `resolver-cache.sqlite`. This file is
/// safe to discard and rebuild, so it owns nothing durable.
fn build_cache_schema(path: &Path) -> Result<(), rusqlite::Error> {
    let connection = open_connection(path)?;
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
        CREATE TABLE IF NOT EXISTS home_bootstrap_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload_json TEXT NOT NULL,
          refreshed_at INTEGER NOT NULL
        );
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
          user_id INTEGER NOT NULL,
          media_type TEXT NOT NULL DEFAULT 'movie',
          tmdb_id TEXT NOT NULL,
          preferred_audio_lang TEXT NOT NULL DEFAULT '',
          preferred_subtitle_lang TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, media_type, tmdb_id)
        );
        CREATE INDEX IF NOT EXISTS idx_title_track_preferences_updated ON title_track_preferences(updated_at);
        ",
    )?;
    migrate_title_preferences_schema(&connection)?;
    Ok(())
}

/// Create the durable user/account tables in `users.sqlite`. This file is never
/// auto-quarantined; see [`init_users_schema`].
fn build_users_schema(path: &Path) -> Result<(), rusqlite::Error> {
    let connection = open_connection(path)?;
    connection.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          email_verified_at INTEGER,
          is_admin INTEGER NOT NULL DEFAULT 0,
          is_disabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_email_verification_email ON email_verification_tokens(email);
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset_tokens(email);
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          pref_key TEXT NOT NULL,
          pref_value TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, pref_key)
        );
        CREATE TABLE IF NOT EXISTS user_watch_progress (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_identity TEXT NOT NULL,
          resume_seconds REAL NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, source_identity)
        );
        CREATE TABLE IF NOT EXISTS user_continue_watching (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_identity TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          episode TEXT NOT NULL DEFAULT '',
          src TEXT NOT NULL DEFAULT '',
          tmdb_id TEXT NOT NULL DEFAULT '',
          media_type TEXT NOT NULL DEFAULT '',
          series_id TEXT NOT NULL DEFAULT '',
          episode_index INTEGER NOT NULL DEFAULT -1,
          year TEXT NOT NULL DEFAULT '',
          thumb TEXT NOT NULL DEFAULT '',
          source_hash TEXT NOT NULL DEFAULT '',
          session_key TEXT NOT NULL DEFAULT '',
          resolver_provider TEXT NOT NULL DEFAULT '',
          source_input TEXT NOT NULL DEFAULT '',
          filename TEXT NOT NULL DEFAULT '',
          resume_seconds REAL NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, source_identity)
        );
        CREATE TABLE IF NOT EXISTS user_my_list (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          item_identity TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}',
          added_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, item_identity)
        );
        -- Service-health history (durable: deliberately NOT cleared by
        -- clear_persistent_caches, and now in users.sqlite so it also survives a
        -- cache-corruption quarantine — the restart count is most useful then).
        CREATE TABLE IF NOT EXISTS health_samples (
          ts INTEGER PRIMARY KEY,
          uptime_seconds INTEGER NOT NULL DEFAULT 0,
          status INTEGER NOT NULL DEFAULT 0,
          fd_count INTEGER NOT NULL DEFAULT 0,
          fd_limit INTEGER NOT NULL DEFAULT 0,
          mem_used INTEGER NOT NULL DEFAULT 0,
          mem_total INTEGER NOT NULL DEFAULT 0,
          load1 REAL NOT NULL DEFAULT 0,
          num_cpus INTEGER NOT NULL DEFAULT 0,
          disk_free INTEGER NOT NULL DEFAULT 0,
          disk_total INTEGER NOT NULL DEFAULT 0,
          req_total INTEGER NOT NULL DEFAULT 0,
          req_4xx INTEGER NOT NULL DEFAULT 0,
          req_5xx INTEGER NOT NULL DEFAULT 0,
          live_proxy_5xx INTEGER NOT NULL DEFAULT 0,
          req_5xx_rate REAL NOT NULL DEFAULT 0,
          playback_success_total INTEGER NOT NULL DEFAULT 0,
          playback_failure_total INTEGER NOT NULL DEFAULT 0,
          playback_failure_rate REAL NOT NULL DEFAULT 0,
          worst_provider_consecutive_failures INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_health_samples_ts ON health_samples(ts);
        CREATE TABLE IF NOT EXISTS service_starts (
          id INTEGER PRIMARY KEY,
          started_at INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_service_starts_started ON service_starts(started_at);
        -- User-submitted feedback (durable: visible in the admin dashboard). The
        -- email/display_name are snapshotted at submit time so a row stays
        -- attributable even if the account is later deleted (user_id -> NULL).
        CREATE TABLE IF NOT EXISTS feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          email TEXT NOT NULL DEFAULT '',
          display_name TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL,
          image_data BLOB,
          image_mime TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
        -- Live-watch events (durable: powers the admin activity feed + top-live
        -- panel). VOD resume lives in user_continue_watching; live playback has no
        -- resume position, so the player logs a lightweight event here instead.
        CREATE TABLE IF NOT EXISTS live_watch_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          source_identity TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_live_watch_created ON live_watch_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_live_watch_user ON live_watch_events(user_id);
        ",
    )?;
    // Feedback image attachments were added after the table first shipped, so
    // back-fill the columns on databases that already have a `feedback` table.
    ensure_text_column(&connection, "feedback", "image_data", "image_data BLOB")?;
    ensure_text_column(
        &connection,
        "feedback",
        "image_mime",
        "image_mime TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_text_column(
        &connection,
        "user_continue_watching",
        "source_hash",
        "source_hash TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_text_column(
        &connection,
        "user_continue_watching",
        "session_key",
        "session_key TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_text_column(
        &connection,
        "user_continue_watching",
        "resolver_provider",
        "resolver_provider TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_text_column(
        &connection,
        "user_continue_watching",
        "source_input",
        "source_input TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_text_column(
        &connection,
        "user_continue_watching",
        "filename",
        "filename TEXT NOT NULL DEFAULT ''",
    )?;
    // Soft email verification: nullable timestamp (ms) set when the user confirms
    // their email. NULL = unverified. Added via ALTER for pre-existing databases.
    ensure_text_column(
        &connection,
        "users",
        "email_verified_at",
        "email_verified_at INTEGER",
    )?;
    // Admin dashboard: per-account authorization + moderation flags. Added via
    // ALTER for pre-existing databases. 0 = normal user / enabled.
    ensure_text_column(
        &connection,
        "users",
        "is_admin",
        "is_admin INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_text_column(
        &connection,
        "users",
        "is_disabled",
        "is_disabled INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

fn migrate_title_preferences_schema(connection: &Connection) -> Result<(), rusqlite::Error> {
    let columns = table_column_names(connection, "title_track_preferences")?;
    let has_user_id = columns
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case("user_id"));
    let has_media_type = columns
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case("media_type"));
    if has_user_id && has_media_type {
        return Ok(());
    }

    connection.execute_batch(
        "
        DROP TABLE IF EXISTS title_track_preferences_legacy;
        ALTER TABLE title_track_preferences RENAME TO title_track_preferences_legacy;
        CREATE TABLE title_track_preferences (
          user_id INTEGER NOT NULL,
          media_type TEXT NOT NULL DEFAULT 'movie',
          tmdb_id TEXT NOT NULL,
          preferred_audio_lang TEXT NOT NULL DEFAULT '',
          preferred_subtitle_lang TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, media_type, tmdb_id)
        );
        INSERT OR IGNORE INTO title_track_preferences (
          user_id,
          media_type,
          tmdb_id,
          preferred_audio_lang,
          preferred_subtitle_lang,
          updated_at
        )
        SELECT
          0,
          'movie',
          tmdb_id,
          preferred_audio_lang,
          preferred_subtitle_lang,
          updated_at
        FROM title_track_preferences_legacy
        WHERE trim(tmdb_id) <> '';
        DROP TABLE title_track_preferences_legacy;
        CREATE INDEX IF NOT EXISTS idx_title_track_preferences_updated ON title_track_preferences(updated_at);
        ",
    )
}

fn ensure_text_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> Result<(), rusqlite::Error> {
    let existing_columns = table_column_names(connection, table_name)?;
    if existing_columns
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(column_name))
    {
        return Ok(());
    }
    connection.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_definition}"),
        [],
    )?;
    Ok(())
}

fn table_column_names(
    connection: &Connection,
    table_name: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    stmt.query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()
}

/// Evict expired/stale rows and trim oversized cache tables in the cache DB.
fn sweep_cache_db(pool: &Pool, path: &Path) -> Result<(), rusqlite::Error> {
    let connection = take_connection(pool, path)?;
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
    return_connection(pool, connection);
    Ok(())
}

/// Evict expired sessions and aged-out health history from the durable users DB.
fn sweep_users_db(pool: &Pool, path: &Path) -> Result<(), rusqlite::Error> {
    let connection = take_connection(pool, path)?;
    let now = now_ms();
    connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", [now])?;
    connection.execute(
        "DELETE FROM health_samples WHERE ts <= ?",
        [now - HEALTH_SAMPLE_STALE_MS],
    )?;
    connection.execute(
        "DELETE FROM service_starts WHERE started_at <= ?",
        [now - SERVICE_START_STALE_MS],
    )?;
    return_connection(pool, connection);
    Ok(())
}

/// RAII guard that returns its connection to the pool when dropped.
///
/// This guarantees the connection is returned even when a query, transaction,
/// or commit fails early via `?`, preventing the pool from leaking slots under
/// error load. `Deref` keeps existing call sites (`connection.prepare(...)`,
/// `trim_table(&connection, ...)`) working unchanged.
struct PooledConnection<'a> {
    pool: &'a Pool,
    conn: Option<Connection>,
}

impl std::ops::Deref for PooledConnection<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn
            .as_ref()
            .expect("pooled connection used after release")
    }
}

impl Drop for PooledConnection<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            push_connection(self.pool, conn);
        }
    }
}

fn take_connection<'a>(
    pool: &'a Pool,
    path: &Path,
) -> Result<PooledConnection<'a>, rusqlite::Error> {
    let conn = {
        let mut connections = pool.lock().unwrap_or_else(|e| e.into_inner());
        connections.pop()
    };
    let conn = match conn {
        Some(conn) => conn,
        None => open_connection(path)?,
    };
    Ok(PooledConnection {
        pool,
        conn: Some(conn),
    })
}

/// Explicitly release a pooled connection. Dropping the guard does the same
/// thing; this is kept so existing call sites compile and to make the
/// "return as early as possible" intent clear at the end of a unit of work.
fn return_connection(_pool: &Pool, _conn: PooledConnection<'_>) {
    // Dropping `_conn` runs `PooledConnection::drop`, returning it to the pool.
}

fn push_connection(pool: &Pool, conn: Connection) {
    let mut connections = pool.lock().unwrap_or_else(|e| e.into_inner());
    // Retain more idle connections so a concurrent burst (e.g. a signup surge,
    // where each request runs several queries) reuses warm connections instead
    // of opening/closing one per call — each open is an fd + pragma round-trip.
    if connections.len() < 16 {
        connections.push(conn);
    }
    // else drop it — pool is full
}

fn tmdb_tv_id_from_series_id(series_id: &str) -> Option<String> {
    let normalized = series_id.trim().to_ascii_lowercase();
    let tmdb_id = normalized.strip_prefix("tmdb-tv-")?;
    if tmdb_id.chars().all(|ch| ch.is_ascii_digit()) && !tmdb_id.is_empty() {
        Some(tmdb_id.to_owned())
    } else {
        None
    }
}

fn open_connection(path: &Path) -> Result<Connection, rusqlite::Error> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    // SQLite disables foreign keys by default, and the setting is per-connection,
    // so enable it on every pooled connection to honor ON DELETE CASCADE.
    connection.pragma_update(None, "foreign_keys", true)?;
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
        .next_back()
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

fn build_related_playback_session_key_with_audio(
    session_key: &str,
    tmdb_id: &str,
    audio_lang: &str,
    quality: &str,
) -> String {
    let parts = session_key.split(':').collect::<Vec<_>>();
    if parts.len() == 6
        && parts.first() == Some(&"tv")
        && parts.get(1).copied() == Some(tmdb_id.trim())
    {
        return format!(
            "tv:{}:{}:{}:{}:{}",
            parts[1],
            parts[2],
            parts[3],
            normalize_preferred_audio_lang(audio_lang),
            normalize_preferred_stream_quality(quality)
        );
    }
    build_playback_session_key(tmdb_id, audio_lang, quality)
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

fn is_numeric_tmdb_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit())
}

fn upsert_warmup_candidate(
    candidates: &mut BTreeMap<String, TmdbTvWarmupCandidate>,
    candidate: TmdbTvWarmupCandidate,
) {
    match candidates.get(&candidate.tmdb_id) {
        Some(existing) if existing.updated_at >= candidate.updated_at => {}
        _ => {
            candidates.insert(candidate.tmdb_id.clone(), candidate);
        }
    }
}

fn continue_watching_target_episode(
    source_identity: &str,
    episode_index: i64,
    entry: Option<&Value>,
) -> (i64, i64) {
    let mut season_number = entry
        .and_then(|value| value.get("seasonNumber"))
        .and_then(|value| json_number_to_i64(Some(value)))
        .unwrap_or(0);
    let mut episode_number = entry
        .and_then(|value| value.get("episodeNumber"))
        .and_then(|value| json_number_to_i64(Some(value)))
        .unwrap_or(0);

    if let Some((_, parsed_season, parsed_episode)) = parse_tmdb_tv_source_identity(source_identity)
    {
        if season_number <= 0 {
            season_number = parsed_season;
        }
        if episode_number <= 0 {
            episode_number = parsed_episode;
        }
    }
    if season_number <= 0 {
        season_number = 1;
    }
    if episode_number <= 0 && episode_index >= 0 {
        episode_number = episode_index + 1;
    }
    (season_number, episode_number)
}

struct ContinueWatchingReconcileInput<'a> {
    tmdb_id: &'a str,
    media_type: &'a str,
    season_number: i64,
    episode_number: i64,
    source_hash: &'a str,
    session_key: &'a str,
    resolver_provider: &'a str,
    source_input: &'a str,
}

fn reconcile_continue_watching_source_metadata(
    connection: &Connection,
    input: ContinueWatchingReconcileInput<'_>,
) -> Result<Option<ContinueWatchingSourceMetadata>, rusqlite::Error> {
    let normalized_tmdb_id = input.tmdb_id.trim();
    if normalized_tmdb_id.is_empty() {
        return Ok(None);
    }

    let Some(candidate) = latest_continue_watching_playback_session_metadata(
        connection,
        normalized_tmdb_id,
        input.media_type,
        input.season_number,
        input.episode_number,
    )?
    else {
        return Ok(None);
    };

    let incoming_source_hash = input.source_hash.trim().to_lowercase();
    let incoming_session_key = input.session_key.trim();
    let incoming_provider = input.resolver_provider.trim().to_lowercase();
    if incoming_provider == "external-embed" && candidate.resolver_provider != "external-embed" {
        return Ok(None);
    }

    if incoming_source_hash.is_empty()
        && incoming_session_key.is_empty()
        && incoming_provider.is_empty()
    {
        return Ok(Some(candidate));
    }

    if !incoming_session_key.is_empty() && candidate.session_key == incoming_session_key {
        return Ok(Some(candidate));
    }
    if !incoming_source_hash.is_empty() && candidate.source_hash == incoming_source_hash {
        return Ok(Some(candidate));
    }

    let current = continue_watching_playback_session_metadata_for_input(
        connection,
        incoming_session_key,
        &incoming_source_hash,
    )?;
    if let Some(current) = current {
        if continue_watching_session_timestamp(&candidate)
            > continue_watching_session_timestamp(&current)
        {
            return Ok(Some(candidate));
        }
        return Ok(None);
    }

    let incoming_looks_local = incoming_provider == "local-torrent"
        || incoming_session_key.starts_with("local-torrent:")
        || input.source_input.contains("/api/local-cache/")
        || input.source_input.contains("/api/local-torrent/");
    if incoming_looks_local && candidate.resolver_provider == "real-debrid" {
        return Ok(Some(candidate));
    }

    Ok(None)
}

fn latest_continue_watching_playback_session_metadata(
    connection: &Connection,
    tmdb_id: &str,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> Result<Option<ContinueWatchingSourceMetadata>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "
        SELECT session_key, source_hash, filename, playable_url, metadata_json,
               updated_at, last_accessed_at
        FROM playback_sessions
        WHERE tmdb_id = ?
          AND health_state != 'invalid'
          AND playable_url != ''
        ORDER BY last_accessed_at DESC, updated_at DESC
        LIMIT 80
        ",
    )?;
    let rows = statement.query_map([tmdb_id.trim()], |row| {
        let session_key: String = row.get(0)?;
        let source_hash: String = row.get(1)?;
        let filename: String = row.get(2)?;
        let playable_url: String = row.get(3)?;
        let metadata_raw: String = row.get(4)?;
        let metadata = serde_json::from_str::<Value>(&metadata_raw).unwrap_or_else(|_| json!({}));
        Ok((
            session_key,
            source_hash,
            filename,
            playable_url,
            metadata,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;

    let normalized_media_type = media_type.trim().to_lowercase();
    for row in rows {
        let (
            session_key,
            source_hash,
            filename,
            playable_url,
            metadata,
            updated_at,
            last_accessed_at,
        ) = row?;
        if !playback_session_matches_continue_target(
            &session_key,
            &metadata,
            &normalized_media_type,
            season_number,
            episode_number,
        ) {
            continue;
        }
        return Ok(Some(ContinueWatchingSourceMetadata {
            source_hash: source_hash.trim().to_lowercase(),
            session_key,
            resolver_provider: continue_watching_resolver_provider(&metadata, &playable_url),
            source_input: extract_continue_watching_source_input(&playable_url),
            filename,
            updated_at,
            last_accessed_at,
        }));
    }

    Ok(None)
}

fn continue_watching_playback_session_metadata_for_input(
    connection: &Connection,
    session_key: &str,
    source_hash: &str,
) -> Result<Option<ContinueWatchingSourceMetadata>, rusqlite::Error> {
    let lookup_by_session_key = !session_key.trim().is_empty();
    if !lookup_by_session_key && source_hash.trim().is_empty() {
        return Ok(None);
    }

    let sql = if lookup_by_session_key {
        "
        SELECT session_key, source_hash, filename, playable_url, metadata_json,
               updated_at, last_accessed_at
        FROM playback_sessions
        WHERE session_key = ?
        LIMIT 1
        "
    } else {
        "
        SELECT session_key, source_hash, filename, playable_url, metadata_json,
               updated_at, last_accessed_at
        FROM playback_sessions
        WHERE source_hash = ?
        ORDER BY last_accessed_at DESC, updated_at DESC
        LIMIT 1
        "
    };
    let mut statement = connection.prepare(sql)?;
    let param = if lookup_by_session_key {
        session_key.trim()
    } else {
        source_hash.trim()
    };
    let row = statement
        .query_row([param], |row| {
            let metadata_raw: String = row.get(4)?;
            let metadata =
                serde_json::from_str::<Value>(&metadata_raw).unwrap_or_else(|_| json!({}));
            let playable_url: String = row.get(3)?;
            Ok(ContinueWatchingSourceMetadata {
                session_key: row.get(0)?,
                source_hash: row.get::<_, String>(1)?.trim().to_lowercase(),
                filename: row.get(2)?,
                resolver_provider: continue_watching_resolver_provider(&metadata, &playable_url),
                source_input: extract_continue_watching_source_input(&playable_url),
                updated_at: row.get(5)?,
                last_accessed_at: row.get(6)?,
            })
        })
        .optional()?;

    if row.is_none() && lookup_by_session_key && !source_hash.trim().is_empty() {
        return continue_watching_playback_session_metadata_for_input(connection, "", source_hash);
    }

    Ok(row)
}

fn continue_watching_session_timestamp(metadata: &ContinueWatchingSourceMetadata) -> i64 {
    metadata.updated_at.max(metadata.last_accessed_at)
}

fn playback_session_matches_continue_target(
    session_key: &str,
    metadata: &Value,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> bool {
    if media_type == "tv" {
        let (parsed_season, parsed_episode) =
            parse_tv_episode_from_session_key(session_key).unwrap_or((0, 0));
        let candidate_season =
            json_number_to_i64(metadata.get("seasonNumber")).unwrap_or(parsed_season);
        let candidate_episode =
            json_number_to_i64(metadata.get("episodeNumber")).unwrap_or(parsed_episode);
        return season_number > 0
            && episode_number > 0
            && candidate_season == season_number
            && candidate_episode == episode_number;
    }

    let session_media_type = metadata
        .get("mediaType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    session_media_type != "tv"
}

fn continue_watching_resolver_provider(metadata: &Value, playable_url: &str) -> String {
    let explicit = metadata
        .get("resolverProvider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if matches!(
        explicit.as_str(),
        "real-debrid" | "local-torrent" | "external-embed"
    ) {
        return explicit;
    }

    let url = playable_url.trim().to_lowercase();
    if url.contains("download.real-debrid.com") {
        return "real-debrid".to_owned();
    }
    if url.contains("/api/local-cache/") || url.contains("/api/local-torrent/") {
        return "local-torrent".to_owned();
    }
    if url.contains("/api/live/iframe") || url.contains("/api/embed/") {
        return "external-embed".to_owned();
    }
    String::new()
}

fn extract_continue_watching_source_input(playable_url: &str) -> String {
    let trimmed = playable_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some((path, query)) = trimmed.split_once('?')
        && (path.ends_with("/api/remux") || path == "/api/remux")
    {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if key == "input" {
                return value.into_owned();
            }
        }
    }
    trimmed.to_owned()
}

fn json_number_to_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    if let Some(number) = value.as_f64()
        && number.is_finite()
    {
        return Some(number.floor() as i64);
    }
    value.as_str()?.trim().parse::<i64>().ok()
}

fn parse_tmdb_tv_source_identity(value: &str) -> Option<(String, i64, i64)> {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    if parts.len() < 5 || parts.first()? != &"tmdb" || parts.get(1)? != &"tv" {
        return None;
    }
    let tmdb_id = parts.get(2)?.trim();
    let season = parts
        .get(3)?
        .trim()
        .strip_prefix('s')?
        .parse::<i64>()
        .ok()?;
    let episode = parts
        .get(4)?
        .trim()
        .strip_prefix('e')?
        .parse::<i64>()
        .ok()?;
    if tmdb_id.is_empty() || season <= 0 || episode <= 0 {
        return None;
    }
    Some((tmdb_id.to_owned(), season, episode))
}

fn parse_tv_episode_from_session_key(value: &str) -> Option<(i64, i64)> {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    if parts.len() < 4 || parts.first()? != &"tv" {
        return None;
    }
    let season = parts
        .get(2)?
        .trim()
        .strip_prefix('s')?
        .parse::<i64>()
        .ok()?;
    let episode = parts
        .get(3)?
        .trim()
        .strip_prefix('e')?
        .parse::<i64>()
        .ok()?;
    if season <= 0 || episode <= 0 {
        return None;
    }
    Some((season, episode))
}

fn normalize_title_preference_media_type(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("tv") {
        "tv".to_owned()
    } else {
        "movie".to_owned()
    }
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
            "ttlTvMetadataMs": 2592000000_i64,
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
        assert_eq!(
            parse_movie_resolve_key_quality("tv:123:s1:e2:en:720p"),
            "720p"
        );
    }

    #[tokio::test]
    async fn title_preferences_are_scoped_by_user_and_media_type() {
        let path = unique_temp_db_path("title-preference-scope");
        let db = setup_test_playback_session_db(&path).await;

        db.persist_title_preference(
            1,
            "movie".to_owned(),
            "123".to_owned(),
            "en".to_owned(),
            "off".to_owned(),
        )
        .await
        .expect("persist user one movie preference");
        db.persist_title_preference(
            2,
            "movie".to_owned(),
            "123".to_owned(),
            "fr".to_owned(),
            String::new(),
        )
        .await
        .expect("persist user two movie preference");
        db.persist_title_preference(
            1,
            "tv".to_owned(),
            "123".to_owned(),
            "de".to_owned(),
            "es".to_owned(),
        )
        .await
        .expect("persist user one tv preference");

        let user_one_movie = db
            .get_title_preference(1, "movie".to_owned(), "123".to_owned())
            .await
            .expect("load user one movie preference")
            .expect("user one movie preference exists");
        assert_eq!(user_one_movie.audioLang, "en");
        assert_eq!(user_one_movie.subtitleLang, "off");

        let user_two_movie = db
            .get_title_preference(2, "movie".to_owned(), "123".to_owned())
            .await
            .expect("load user two movie preference")
            .expect("user two movie preference exists");
        assert_eq!(user_two_movie.audioLang, "fr");
        assert_eq!(user_two_movie.subtitleLang, "");

        let user_one_tv = db
            .get_title_preference(1, "tv".to_owned(), "123".to_owned())
            .await
            .expect("load user one tv preference")
            .expect("user one tv preference exists");
        assert_eq!(user_one_tv.audioLang, "de");
        assert_eq!(user_one_tv.subtitleLang, "es");

        assert!(
            db.get_title_preference(2, "tv".to_owned(), "123".to_owned())
                .await
                .expect("load missing user two tv preference")
                .is_none()
        );

        db.delete_title_preference(1, "movie".to_owned(), "123".to_owned())
            .await
            .expect("delete user one movie preference");
        assert!(
            db.get_title_preference(1, "movie".to_owned(), "123".to_owned())
                .await
                .expect("load deleted user one movie preference")
                .is_none()
        );
        assert!(
            db.get_title_preference(2, "movie".to_owned(), "123".to_owned())
                .await
                .expect("load user two movie preference after delete")
                .is_some()
        );
        assert!(
            db.get_title_preference(1, "tv".to_owned(), "123".to_owned())
                .await
                .expect("load user one tv preference after delete")
                .is_some()
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn migrates_legacy_title_preferences_without_assigning_them_to_users() {
        let path = unique_temp_db_path("title-preference-migration");
        let setup_path = path.clone();
        super::task::spawn_blocking(move || {
            let connection = open_connection(&setup_path)?;
            connection.execute_batch(
                "
                CREATE TABLE title_track_preferences (
                  tmdb_id TEXT PRIMARY KEY,
                  preferred_audio_lang TEXT NOT NULL DEFAULT '',
                  preferred_subtitle_lang TEXT NOT NULL DEFAULT '',
                  updated_at INTEGER NOT NULL
                );
                CREATE INDEX idx_title_track_preferences_updated
                  ON title_track_preferences(updated_at);
                ",
            )?;
            connection.execute(
                "
                INSERT INTO title_track_preferences (
                  tmdb_id,
                  preferred_audio_lang,
                  preferred_subtitle_lang,
                  updated_at
                )
                VALUES (?, ?, ?, ?)
                ",
                params!["456", "en", "off", super::now_ms()],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .expect("join legacy schema setup")
        .expect("create legacy title preference table");

        let db = setup_test_playback_session_db(&path).await;
        let migrated = db
            .get_title_preference(0, "movie".to_owned(), "456".to_owned())
            .await
            .expect("load migrated legacy preference")
            .expect("legacy preference migrated to neutral scope");
        assert_eq!(migrated.audioLang, "en");
        assert_eq!(migrated.subtitleLang, "off");

        let user_id = db
            .create_user(
                "title-pref-migration".to_owned(),
                "hash".to_owned(),
                "Title Pref Migration".to_owned(),
            )
            .await
            .expect("create user");
        assert!(
            db.get_title_preference(user_id, "movie".to_owned(), "456".to_owned())
                .await
                .expect("load user scoped preference")
                .is_none()
        );

        db.persist_title_preference(
            user_id,
            "movie".to_owned(),
            "456".to_owned(),
            "fr".to_owned(),
            String::new(),
        )
        .await
        .expect("persist user scoped preference");
        let user_preference = db
            .get_title_preference(user_id, "movie".to_owned(), "456".to_owned())
            .await
            .expect("load persisted user preference")
            .expect("user preference exists");
        assert_eq!(user_preference.audioLang, "fr");

        let _ = tokio::fs::remove_file(&path).await;
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
    async fn persists_episode_scoped_playback_sessions_without_overwriting() {
        let path = unique_temp_db_path("episode-scoped-playback-session");
        let db = setup_test_playback_session_db(&path).await;

        for (session_key, episode_number, filename) in [
            ("tv:123:s1:e1:auto:1080p", 1, "Show.S01E01.mkv"),
            ("tv:123:s1:e2:auto:1080p", 2, "Show.S01E02.mkv"),
        ] {
            db.persist_playback_session(PersistPlaybackSessionInput {
                session_key: session_key.to_owned(),
                tmdb_id: "123".to_owned(),
                audio_lang: "auto".to_owned(),
                preferred_quality: "1080p".to_owned(),
                source_hash: format!("{episode_number:040}"),
                selected_file: episode_number.to_string(),
                filename: filename.to_owned(),
                playable_url: format!("https://download.real-debrid.com/{filename}"),
                fallback_urls: Vec::new(),
                metadata: json!({
                    "tmdbId": "123",
                    "displayTitle": "Show",
                    "mediaType": "tv",
                    "seasonNumber": 1,
                    "episodeNumber": episode_number
                }),
            })
            .await
            .expect("persist episode session");
        }

        assert!(
            db.get_playback_session("tv:123:s1:e1:auto:1080p".to_owned())
                .await
                .expect("load episode 1")
                .is_some()
        );
        assert!(
            db.get_playback_session("tv:123:s1:e2:auto:1080p".to_owned())
                .await
                .expect("load episode 2")
                .is_some()
        );

        let sessions = db
            .get_latest_healthy_playback_sessions_for_tmdb("123".to_owned(), 10)
            .await
            .expect("load latest healthy sessions");
        assert_eq!(sessions.len(), 2);

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn invalidates_playback_sessions_by_source_hash() {
        let path = unique_temp_db_path("playback-session-source-invalidate");
        let db = setup_test_playback_session_db(&path).await;
        for (session_key, tmdb_id, source_hash) in [
            ("123:en:1080p", "123", "abc"),
            ("456:en:1080p", "456", "abc"),
            ("789:en:1080p", "789", "def"),
        ] {
            db.persist_playback_session(PersistPlaybackSessionInput {
                session_key: session_key.to_owned(),
                tmdb_id: tmdb_id.to_owned(),
                audio_lang: "en".to_owned(),
                preferred_quality: "1080p".to_owned(),
                source_hash: source_hash.to_owned(),
                selected_file: "1".to_owned(),
                filename: "Movie.mp4".to_owned(),
                playable_url: "https://download.real-debrid.com/movie.mp4".to_owned(),
                fallback_urls: Vec::new(),
                metadata: json!({"tmdbId": tmdb_id, "displayTitle": "Movie"}),
            })
            .await
            .expect("persist session");
        }

        let updated = db
            .invalidate_playback_sessions_by_source_hash(
                "abc".to_owned(),
                "Playback failed.".to_owned(),
            )
            .await
            .expect("invalidate source sessions");
        assert_eq!(updated, 2);

        for session_key in ["123:en:1080p", "456:en:1080p"] {
            let session = db
                .get_playback_session(session_key.to_owned())
                .await
                .expect("load invalidated session")
                .expect("session exists");
            assert_eq!(session.health_state, "invalid");
            assert_eq!(session.health_fail_count, 1);
            assert_eq!(session.last_error, "Playback failed.");
        }

        let untouched = db
            .get_playback_session("789:en:1080p".to_owned())
            .await
            .expect("load untouched session")
            .expect("session exists");
        assert_eq!(untouched.health_state, "healthy");
        assert_eq!(untouched.health_fail_count, 0);

        let updated_again = db
            .invalidate_playback_sessions_by_source_hash(
                "abc".to_owned(),
                "Playback failed again.".to_owned(),
            )
            .await
            .expect("invalidate source sessions again");
        assert_eq!(updated_again, 0);

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn latest_healthy_playback_session_skips_invalid_sessions() {
        let path = unique_temp_db_path("latest-healthy-playback-session");
        let db = setup_test_playback_session_db(&path).await;
        for (session_key, audio_lang, quality, source_hash, filename) in [
            (
                "123:en:1080p",
                "en",
                "1080p",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "Healthy.mp4",
            ),
            (
                "123:auto:720p",
                "auto",
                "720p",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "Invalid.mp4",
            ),
        ] {
            db.persist_playback_session(PersistPlaybackSessionInput {
                session_key: session_key.to_owned(),
                tmdb_id: "123".to_owned(),
                audio_lang: audio_lang.to_owned(),
                preferred_quality: quality.to_owned(),
                source_hash: source_hash.to_owned(),
                selected_file: "1".to_owned(),
                filename: filename.to_owned(),
                playable_url: format!("https://download.real-debrid.com/{filename}"),
                fallback_urls: Vec::new(),
                metadata: json!({"tmdbId":"123","displayTitle":"Movie"}),
            })
            .await
            .expect("persist session");
        }

        db.invalidate_playback_sessions_by_source_hash(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
            "Playback failed.".to_owned(),
        )
        .await
        .expect("invalidate latest session");

        let latest = db
            .get_latest_healthy_playback_sessions_for_tmdb("123".to_owned(), 1)
            .await
            .expect("load latest healthy session")
            .into_iter()
            .next()
            .expect("healthy session exists");

        assert_eq!(latest.session_key, "123:en:1080p");
        assert_eq!(latest.filename, "Healthy.mp4");

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
        let setup_path = db.cache_path.clone();
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
    async fn continue_watching_keeps_one_entry_per_tmdb_series() {
        let path = unique_temp_db_path("continue-watching-tmdb-series");
        let db = setup_test_playback_session_db(&path).await;
        let user_id = db
            .create_user(
                "series-test".to_owned(),
                "hash".to_owned(),
                "Series Test".to_owned(),
            )
            .await
            .expect("create user");
        db.upsert_user_continue_watching(
            user_id,
            json!({
                "sourceIdentity": "tmdb:tv:85552:s1:e1",
                "title": "Euphoria",
                "episode": "Pilot",
                "tmdbId": "85552",
                "mediaType": "tv",
                "resumeSeconds": 180.0
            }),
        )
        .await
        .expect("persist first episode");
        db.upsert_user_continue_watching(
            user_id,
            json!({
                "sourceIdentity": "tmdb:tv:85552:s1:e2",
                "title": "Euphoria",
                "episode": "Stuntin' Like My Daddy",
                "tmdbId": "85552",
                "mediaType": "tv",
                "seriesId": "tmdb-tv-85552",
                "episodeIndex": 1,
                "sourceHash": "abcdef123",
                "sessionKey": "local-torrent:tv:85552:s1:e2:en:1080p",
                "resolverProvider": "local-torrent",
                "sourceInput": "http://127.0.0.1:5173/api/local-torrent/stream?sourceHash=abcdef123",
                "filename": "Euphoria.S01E02.mkv",
                "resumeSeconds": 240.0
            }),
        )
        .await
        .expect("persist second episode");

        let entries = db
            .get_user_continue_watching(user_id)
            .await
            .expect("load continue watching");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["sourceIdentity"], "tmdb:tv:85552:s1:e2");
        assert_eq!(entries[0]["seriesId"], "tmdb-tv-85552");
        assert_eq!(entries[0]["sourceHash"], "abcdef123");
        assert_eq!(
            entries[0]["sessionKey"],
            "local-torrent:tv:85552:s1:e2:en:1080p"
        );
        assert_eq!(entries[0]["resolverProvider"], "local-torrent");
        assert_eq!(entries[0]["filename"], "Euphoria.S01E02.mkv");

        db.delete_user_continue_watching_for_series(user_id, "tmdb-tv-85552".to_owned())
            .await
            .expect("delete series continue watching");
        assert!(
            db.get_user_continue_watching(user_id)
                .await
                .expect("load deleted continue watching")
                .is_empty()
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn continue_watching_prefers_newer_healthy_episode_session_metadata() {
        let path = unique_temp_db_path("continue-watching-session-reconcile");
        let db = setup_test_playback_session_db(&path).await;
        let user_id = db
            .create_user(
                "session-reconcile".to_owned(),
                "hash".to_owned(),
                "Session Reconcile".to_owned(),
            )
            .await
            .expect("create user");

        db.persist_playback_session(PersistPlaybackSessionInput {
            session_key: "local-torrent:tv:273240:s1:e2:en:auto".to_owned(),
            tmdb_id: "273240".to_owned(),
            audio_lang: "en".to_owned(),
            preferred_quality: "auto".to_owned(),
            source_hash: "37a51a81760e397d9fc4fe56791e93752700c89c".to_owned(),
            selected_file: "1".to_owned(),
            filename: "Off.Campus.S01E02.The.Practice.720p.HEVC.x265-MeGusta.mkv".to_owned(),
            playable_url: "/api/remux?input=%2Fapi%2Flocal-cache%2Fstream%3FsourceHash%3D37a51a81760e397d9fc4fe56791e93752700c89c%26fileId%3D1".to_owned(),
            fallback_urls: Vec::new(),
            metadata: json!({
                "tmdbId": "273240",
                "displayTitle": "Off Campus",
                "mediaType": "tv",
                "seasonNumber": 1,
                "episodeNumber": 2,
                "resolverProvider": "local-torrent"
            }),
        })
        .await
        .expect("persist local session");

        let setup_path = db.cache_path.clone();
        super::task::spawn_blocking(move || {
            let connection = open_connection(&setup_path)?;
            connection.execute(
                "
                UPDATE playback_sessions
                SET updated_at = 1,
                    last_accessed_at = 1
                WHERE session_key = ?
                ",
                ["local-torrent:tv:273240:s1:e2:en:auto"],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .expect("join local timestamp update")
        .expect("local timestamp update");

        db.persist_playback_session(PersistPlaybackSessionInput {
            session_key: "tv:273240:s1:e2:en:auto".to_owned(),
            tmdb_id: "273240".to_owned(),
            audio_lang: "en".to_owned(),
            preferred_quality: "auto".to_owned(),
            source_hash: "37a51a81760e397d9fc4fe56791e93752700c89c".to_owned(),
            selected_file: "1".to_owned(),
            filename: "Off.Campus.S01E02.The.Practice.720p.HEVC.x265-MeGusta.mkv".to_owned(),
            playable_url: "/api/remux?input=https%3A%2F%2F101-4.download.real-debrid.com%2Fd%2FYJQ4MSOINGNWI%2FOff.Campus.S01E02.The.Practice.720p.HEVC.x265-MeGusta.mkv".to_owned(),
            fallback_urls: Vec::new(),
            metadata: json!({
                "tmdbId": "273240",
                "displayTitle": "Off Campus",
                "mediaType": "tv",
                "seasonNumber": 1,
                "episodeNumber": 2,
                "resolverProvider": "real-debrid"
            }),
        })
        .await
        .expect("persist real-debrid session");

        db.upsert_user_continue_watching(
            user_id,
            json!({
                "sourceIdentity": "tmdb:tv:273240:s1:e2",
                "title": "Off Campus",
                "episode": "E2 The Practice",
                "tmdbId": "273240",
                "mediaType": "tv",
                "seriesId": "tmdb-tv-273240",
                "episodeIndex": 1,
                "seasonNumber": 1,
                "episodeNumber": 2,
                "sourceHash": "37a51a81760e397d9fc4fe56791e93752700c89c",
                "sessionKey": "local-torrent:tv:273240:s1:e2:en:auto",
                "resolverProvider": "local-torrent",
                "sourceInput": "/api/local-cache/stream?sourceHash=37a51a81760e397d9fc4fe56791e93752700c89c&fileId=1",
                "filename": "Off.Campus.S01E02.The.Practice.720p.HEVC.x265-MeGusta.mkv",
                "resumeSeconds": 691.46
            }),
        )
        .await
        .expect("persist continue watching");

        let entries = db
            .get_user_continue_watching(user_id)
            .await
            .expect("load continue watching");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["resolverProvider"], "real-debrid");
        assert_eq!(entries[0]["sessionKey"], "tv:273240:s1:e2:en:auto");
        assert_eq!(
            entries[0]["sourceInput"],
            "https://101-4.download.real-debrid.com/d/YJQ4MSOINGNWI/Off.Campus.S01E02.The.Practice.720p.HEVC.x265-MeGusta.mkv"
        );

        let setup_path = db.users_path.clone();
        super::task::spawn_blocking(move || {
            let connection = open_connection(&setup_path)?;
            connection.execute(
                "
                UPDATE user_continue_watching
                SET session_key = ?,
                    resolver_provider = ?,
                    source_input = ?
                WHERE user_id = ? AND source_identity = ?
                ",
                params![
                    "local-torrent:tv:273240:s1:e2:en:auto",
                    "local-torrent",
                    "/api/local-cache/stream?sourceHash=37a51a81760e397d9fc4fe56791e93752700c89c&fileId=1",
                    user_id,
                    "tmdb:tv:273240:s1:e2",
                ],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .expect("join stale update")
        .expect("stale update");

        let entries = db
            .get_user_continue_watching(user_id)
            .await
            .expect("load reconciled continue watching");
        assert_eq!(entries[0]["resolverProvider"], "real-debrid");
        assert_eq!(entries[0]["sessionKey"], "tv:273240:s1:e2:en:auto");

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn applies_busy_timeout_to_sqlite_connections() {
        let path = unique_temp_db_path("busy-timeout");
        let db = setup_test_playback_session_db(&path).await;
        let setup_path = db.cache_path.clone();
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

    /// Per-test users DB path sitting beside the cache path, so each test gets its
    /// own isolated `users.sqlite` (tests run in parallel).
    fn users_db_path_for(cache_path: &Path) -> PathBuf {
        let file = cache_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cache.sqlite".to_owned());
        cache_path.with_file_name(format!("users-{file}"))
    }

    async fn setup_test_playback_session_db(path: &Path) -> Db {
        Db::initialize(&test_config(path)).await.expect("init db")
    }

    fn test_config(path: &Path) -> crate::config::Config {
        crate::config::Config {
            root_dir: std::env::temp_dir(),
            frontend_dir: std::env::temp_dir(),
            assets_dir: std::env::temp_dir(),
            cache_dir: std::env::temp_dir(),
            hls_cache_dir: std::env::temp_dir(),
            local_torrent_cache_dir: std::env::temp_dir().join("local-torrents"),
            upload_temp_dir: std::env::temp_dir(),
            local_library_path: std::env::temp_dir().join("library.json"),
            persistent_cache_db_path: path.to_path_buf(),
            persistent_users_db_path: users_db_path_for(path),
            host: "127.0.0.1".to_owned(),
            port: 0,
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
            playback_sessions_enabled: true,
            opensubtitles_api_key: String::new(),
            opensubtitles_user_agent: String::new(),
            session_cookie_secure: true,
            open_signup_enabled: false,
            signup_invite_code: String::new(),
            live_hls_proxy_secret: "test-live-hls-proxy-secret-with-enough-length".to_owned(),
            live_hls_resource_worker_base: String::new(),
            app_origin: "https://streamthatshit.com".to_owned(),
            email_from: "noreply@streamthatshit.com".to_owned(),
            cf_account_id: String::new(),
            cf_email_api_token: String::new(),
        }
    }

    #[tokio::test]
    async fn health_history_is_durable_across_cache_clear() {
        let path = unique_temp_db_path("health-durable");
        let db = setup_test_playback_session_db(&path).await;

        db.record_service_start("test".to_owned())
            .await
            .expect("record start");
        db.insert_health_sample(super::HealthSampleRow {
            ts: super::now_ms(),
            status: 1,
            fdCount: 42,
            fdLimit: 16_384,
            ..Default::default()
        })
        .await
        .expect("insert sample");
        // A cache-table row, to prove the clear below actually clears something.
        db.record_source_health_event("src-1".to_owned(), "success".to_owned(), String::new())
            .await
            .expect("record source health");

        assert_eq!(db.recent_health_samples(0).await.expect("samples").len(), 1);
        assert_eq!(db.service_starts_since(0).await.expect("starts").len(), 1);
        assert_eq!(db.source_health_totals().await.expect("totals").0, 1);

        db.clear_persistent_caches().await.expect("clear caches");

        // Durable health history survives the wipe...
        assert_eq!(
            db.recent_health_samples(0).await.expect("samples after").len(),
            1,
            "health_samples must survive clear_persistent_caches"
        );
        assert_eq!(
            db.service_starts_since(0).await.expect("starts after").len(),
            1,
            "service_starts must survive clear_persistent_caches"
        );
        // ...while the cache table it sits beside was cleared.
        assert_eq!(db.source_health_totals().await.expect("totals after").0, 0);

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn create_first_user_only_inserts_when_users_table_is_empty() {
        let path = unique_temp_db_path("first-user");
        let db = setup_test_playback_session_db(&path).await;

        let first = db
            .create_first_user(
                "first@example.com".to_owned(),
                "hash-one".to_owned(),
                "First".to_owned(),
            )
            .await
            .expect("create first user");
        assert!(first.is_some());
        assert_eq!(db.user_count().await.expect("count users"), 1);

        let second = db
            .create_first_user(
                "second@example.com".to_owned(),
                "hash-two".to_owned(),
                "Second".to_owned(),
            )
            .await
            .expect("attempt second first user");
        assert!(second.is_none());
        assert_eq!(db.user_count().await.expect("count users"), 1);

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn email_verification_token_is_single_use_and_marks_user_verified() {
        let path = unique_temp_db_path("email-verify");
        let db = setup_test_playback_session_db(&path).await;

        let email = "viewer@example.com".to_owned();
        let user_id = db
            .create_user(email.clone(), "hash".to_owned(), "Viewer".to_owned())
            .await
            .expect("create user");
        assert_eq!(
            db.email_verified_at(user_id).await.expect("verified at"),
            None,
            "new users start unverified"
        );

        db.create_email_verification_token(email.clone(), "hash-a".to_owned(), 10_000)
            .await
            .expect("create token a");
        // A second token for the same email invalidates the first.
        db.create_email_verification_token(email.clone(), "hash-b".to_owned(), 20_000)
            .await
            .expect("create token b");
        assert!(
            db.consume_email_verification_token("hash-a".to_owned())
                .await
                .expect("consume a")
                .is_none(),
            "superseded token is no longer valid"
        );

        let consumed = db
            .consume_email_verification_token("hash-b".to_owned())
            .await
            .expect("consume b");
        assert_eq!(consumed, Some((email.clone(), 20_000)));
        assert!(
            db.consume_email_verification_token("hash-b".to_owned())
                .await
                .expect("consume b twice")
                .is_none(),
            "tokens are single-use"
        );

        db.mark_email_verified(email.clone(), 123_456)
            .await
            .expect("mark verified");
        assert_eq!(
            db.email_verified_at(user_id).await.expect("verified at"),
            Some(123_456)
        );
        // Idempotent: a later mark does not overwrite the first timestamp.
        db.mark_email_verified(email, 999_999)
            .await
            .expect("mark verified again");
        assert_eq!(
            db.email_verified_at(user_id).await.expect("verified at"),
            Some(123_456)
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn initialize_recovers_from_a_corrupt_database_file() {
        let path = unique_temp_db_path("corrupt-recovery");
        // A file that SQLite cannot read as a database — exactly what takes the
        // server down on boot if init bubbles the error up instead of recovering.
        let mut corrupt = b"SQLite format 3\0".to_vec();
        corrupt.extend_from_slice(&[0xFFu8; 512]);
        tokio::fs::write(&path, &corrupt)
            .await
            .expect("write corrupt db file");

        // initialize() must succeed by quarantining the bad file and rebuilding.
        let db = setup_test_playback_session_db(&path).await;
        let counts = db
            .persistent_counts()
            .await
            .expect("query counts after recovery");
        assert_eq!(counts.title_preference_size, 0);

        // The rebuilt database is healthy and carries the full schema.
        let check_path = path.clone();
        let (integrity, table_count) = super::task::spawn_blocking(move || {
            let connection = open_connection(&check_path)?;
            let integrity =
                connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?;
            let table_count = connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<(String, i64), rusqlite::Error>((integrity, table_count))
        })
        .await
        .expect("join integrity check")
        .expect("run integrity check");
        assert_eq!(integrity, "ok");
        // The 8 regenerable cache tables. The durable user tables (and the
        // `sqlite_sequence` that `users`' AUTOINCREMENT would create) now live in
        // users.sqlite, so they are deliberately absent here.
        assert_eq!(
            table_count, 8,
            "rebuilt cache database should expose exactly the cache schema"
        );

        // The corrupt original was preserved alongside, not deleted, with the
        // marker inserted before the extension (foo.sqlite -> foo.corrupt-<ts>.sqlite).
        let stem = path.file_stem().expect("db file stem").to_owned();
        let parent = path.parent().expect("db parent dir").to_path_buf();
        let prefix = format!("{}.corrupt-", stem.to_string_lossy());
        let mut backups = Vec::new();
        let mut entries = tokio::fs::read_dir(&parent).await.expect("read temp dir");
        while let Some(entry) = entries.next_entry().await.expect("read dir entry") {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(prefix.as_str())
            {
                backups.push(entry.path());
            }
        }
        assert!(
            !backups.is_empty(),
            "expected the corrupt database to be quarantined alongside the rebuilt one"
        );

        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(users_db_path_for(&path)).await;
        for backup in backups {
            let _ = tokio::fs::remove_file(backup).await;
        }
    }

    /// The core invariant this split exists to guarantee: a cache-DB corruption
    /// self-heals (quarantine + rebuild) without touching accounts, which now live
    /// in a separate users.sqlite that is never quarantined.
    #[tokio::test]
    async fn cache_corruption_preserves_user_accounts() {
        let path = unique_temp_db_path("cache-corruption-accounts");
        let config = test_config(&path);

        // Create an account and some durable user state, then close the DB so WAL
        // is checkpointed back into the main cache file.
        let user_id = {
            let db = Db::initialize(&config).await.expect("init db");
            let user_id = db
                .create_user(
                    "survivor@example.com".to_owned(),
                    "hash".to_owned(),
                    "Survivor".to_owned(),
                )
                .await
                .expect("create user");
            db.replace_user_my_list(
                user_id,
                vec![json!({"itemIdentity": "tmdb:movie:1", "title": "Keep"})],
            )
            .await
            .expect("seed my list");
            user_id
        };

        // Corrupt the cache DB on disk, exactly as the 2026-06-09 boot incident
        // did, and drop its WAL/SHM siblings so the malformed main file is opened.
        let mut corrupt = b"SQLite format 3\0".to_vec();
        corrupt.extend_from_slice(&[0xFFu8; 512]);
        tokio::fs::write(&path, &corrupt)
            .await
            .expect("corrupt cache db");
        let _ = tokio::fs::remove_file(PathBuf::from(format!("{}-wal", path.to_string_lossy()))).await;
        let _ = tokio::fs::remove_file(PathBuf::from(format!("{}-shm", path.to_string_lossy()))).await;

        // Re-initialize: the cache DB self-heals; users.sqlite is untouched.
        let db = Db::initialize(&config)
            .await
            .expect("re-init after cache corruption");
        assert_eq!(
            db.user_count().await.expect("count users"),
            1,
            "accounts must survive a cache-DB corruption"
        );
        let found = db
            .get_user_by_email("survivor@example.com".to_owned())
            .await
            .expect("lookup user")
            .expect("user still exists");
        assert_eq!(found.0, user_id);
        assert_eq!(
            db.get_user_my_list(user_id).await.expect("load list").len(),
            1,
            "durable user data must survive a cache-DB corruption"
        );

        // The corrupt cache file was quarantined (not silently deleted).
        let stem = path.file_stem().expect("db file stem").to_string_lossy().into_owned();
        let parent = path.parent().expect("db parent dir").to_path_buf();
        let prefix = format!("{stem}.corrupt-");
        let mut backups = Vec::new();
        let mut entries = tokio::fs::read_dir(&parent).await.expect("read temp dir");
        while let Some(entry) = entries.next_entry().await.expect("read dir entry") {
            if entry.file_name().to_string_lossy().starts_with(prefix.as_str()) {
                backups.push(entry.path());
            }
        }
        assert!(!backups.is_empty(), "corrupt cache file should be quarantined");

        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(users_db_path_for(&path)).await;
        for backup in backups {
            let _ = tokio::fs::remove_file(backup).await;
        }
    }

    /// First boot after the split: a pre-existing single-file DB (cache + user
    /// tables together) must have its durable rows copied into a fresh
    /// users.sqlite, with foreign-key-linked rows surviving intact.
    #[tokio::test]
    async fn first_boot_migrates_durable_rows_out_of_the_legacy_combined_db() {
        let legacy_path = unique_temp_db_path("legacy-combined");
        let users_path = users_db_path_for(&legacy_path);

        // Build a pre-split combined DB (cache + user tables in one file) and seed
        // an account with FK-linked session, continue-watching, and my-list rows.
        let setup = legacy_path.clone();
        let user_id = super::task::spawn_blocking(move || {
            super::build_cache_schema(&setup)?;
            super::build_users_schema(&setup)?;
            let connection = open_connection(&setup)?;
            // Seed deliberately-messy legacy data, including an orphan session whose
            // user was deleted without the cascade firing — so foreign_keys is off
            // here to allow inserting it, just as the real legacy DB accumulated one.
            connection.pragma_update(None, "foreign_keys", false)?;
            let now = super::now_ms();
            connection.execute(
                "INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)",
                params!["legacy@example.com", "legacy-hash", "Legacy User", now, now],
            )?;
            let user_id = connection.last_insert_rowid();
            connection.execute(
                "INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
                 VALUES (?, ?, ?, ?)",
                params!["legacy-token", user_id, now, now + 1_000_000],
            )?;
            // Orphan session: references a user id that does not exist.
            connection.execute(
                "INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
                 VALUES (?, ?, ?, ?)",
                params!["orphan-token", user_id + 9_999, now, now + 1_000_000],
            )?;
            connection.execute(
                "INSERT INTO user_my_list (user_id, item_identity, details_json, added_at)
                 VALUES (?, ?, ?, ?)",
                params![user_id, "tmdb:movie:9", "{\"title\":\"Kept\"}", now],
            )?;
            // A cache row, to prove the legacy file keeps serving as the cache DB.
            connection.execute(
                "INSERT INTO tmdb_response_cache (cache_key, payload_json, expires_at, updated_at)
                 VALUES (?, ?, ?, ?)",
                params!["legacy-key", "{}", now + 1_000_000, now],
            )?;
            Ok::<i64, rusqlite::Error>(user_id)
        })
        .await
        .expect("join legacy seed")
        .expect("seed legacy combined db");

        // First boot: users.sqlite is absent, so the durable rows migrate over.
        let config = test_config(&legacy_path);
        let db = Db::initialize(&config).await.expect("init with migration");

        assert_eq!(
            db.user_count().await.expect("count users"),
            1,
            "the legacy account should migrate into users.sqlite"
        );
        let found = db
            .get_user_by_email("legacy@example.com".to_owned())
            .await
            .expect("lookup migrated user")
            .expect("migrated user exists");
        assert_eq!(found.0, user_id);
        assert!(
            db.get_session("legacy-token".to_owned())
                .await
                .expect("lookup migrated session")
                .is_some(),
            "FK-linked auth session should migrate alongside its user"
        );
        assert!(
            db.get_session("orphan-token".to_owned())
                .await
                .expect("lookup orphan session")
                .is_none(),
            "orphan session (no surviving user) must be dropped, not block migration"
        );
        assert_eq!(
            db.get_user_my_list(user_id).await.expect("load my list").len(),
            1,
            "my-list rows should migrate"
        );

        // The legacy file continues to back the cache DB.
        let cached = db
            .get_tmdb_cache("legacy-key".to_owned())
            .await
            .expect("load cache row after migration");
        assert!(cached.is_some(), "cache rows in the legacy file remain usable");

        // The migration is non-destructive: the user rows are still in the legacy
        // file as a safety net.
        let check = legacy_path.clone();
        let legacy_users = super::task::spawn_blocking(move || {
            let connection = open_connection(&check)?;
            connection.query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_, i64>(0))
        })
        .await
        .expect("join legacy count")
        .expect("count legacy users");
        assert_eq!(legacy_users, 1, "legacy rows are left in place as a backup");

        let _ = tokio::fs::remove_file(&legacy_path).await;
        let _ = tokio::fs::remove_file(&users_path).await;
    }
}
