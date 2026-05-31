use dashmap::DashMap;
use reqwest::StatusCode;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tracing::{info, warn};

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::persistence::{Db, TmdbTvWarmupCandidate};
use crate::utils::now_ms;

const TMDB_BASE_URL: &str = "https://api.themoviedb.org/3";
const TMDB_RESPONSE_CACHE_TTL_DEFAULT_MS: i64 = 6 * 60 * 60 * 1000;
const TMDB_RESPONSE_CACHE_TTL_POPULAR_MS: i64 = 30 * 60 * 1000;
const TMDB_RESPONSE_CACHE_TTL_GENRE_MS: i64 = 24 * 60 * 60 * 1000;
const TMDB_RESPONSE_CACHE_TTL_TV_METADATA_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const TMDB_RESPONSE_CACHE_EXTEND_MIN_DELTA_MS: i64 = 24 * 60 * 60 * 1000;
const TMDB_RESPONSE_CACHE_MAX_ENTRIES: usize = 1200;
const TMDB_TV_METADATA_WARMUP_DELAY_SECONDS: u64 = 5;
const TMDB_TV_METADATA_WARMUP_CANDIDATES: usize = 8;
const TMDB_TV_METADATA_WARMUP_MAX_SEASONS: usize = 12;

#[derive(Clone)]
pub struct TmdbService {
    config: Config,
    db: Db,
    client: reqwest::Client,
    cache: Arc<DashMap<String, CachedValue>>,
    hits: Arc<AtomicU64>,
    misses: Arc<AtomicU64>,
    expired: Arc<AtomicU64>,
}

#[derive(Clone)]
struct CachedValue {
    expires_at: i64,
    last_accessed_at: i64,
    value: Value,
}

impl TmdbService {
    pub fn new(config: Config, db: Db, client: reqwest::Client) -> Self {
        Self {
            config,
            db,
            client,
            cache: Arc::new(DashMap::new()),
            hits: Arc::new(AtomicU64::new(0)),
            misses: Arc::new(AtomicU64::new(0)),
            expired: Arc::new(AtomicU64::new(0)),
        }
    }

    pub async fn fetch(
        &self,
        path: &str,
        params: BTreeMap<String, String>,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        let credential = tmdb_credential_from_config(&self.config.tmdb_api_key)
            .ok_or_else(|| ApiError::internal("TMDB_API_KEY is not configured on the server."))?;
        if credential.secret().is_empty() {
            return Err(ApiError::internal(
                "TMDB_API_KEY is not configured on the server.",
            ));
        };

        let cache_key = build_tmdb_response_cache_key(path, &params);
        let ttl_ms = get_tmdb_cache_ttl_ms(path);
        let extend_cached_expires_at = is_tv_metadata_cache_path(&path.trim().to_lowercase())
            .then(|| now_ms() + ttl_ms.max(1_000));
        if let Some(cached) = self
            .get_cached_response(&cache_key, extend_cached_expires_at)
            .await?
        {
            return Ok(cached);
        }

        let mut query = params.clone();
        query.insert("language".to_owned(), "en-US".to_owned());

        let response = self
            .client
            .get(format!("{TMDB_BASE_URL}{path}"))
            .apply_tmdb_credential(&credential)
            .query(&query)
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .send()
            .await
            .map_err(|error| map_reqwest_error(error, "Request timed out."))?;

        let status = response.status();
        let raw_text = response
            .text()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }

        let payload = serde_json::from_str::<Value>(&raw_text).unwrap_or_else(|_| {
            Value::Object(
                [("message".to_owned(), Value::String(raw_text.clone()))]
                    .into_iter()
                    .collect(),
            )
        });
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("Request failed ({status})"));
            return Err(map_tmdb_status_error(status, message));
        }

        let expires_at = now_ms() + ttl_ms.max(1_000);
        self.cache.insert(
            cache_key.clone(),
            CachedValue {
                expires_at,
                last_accessed_at: now_ms(),
                value: payload.clone(),
            },
        );
        trim_cache(&self.cache);
        self.db
            .set_tmdb_cache(cache_key, payload.clone(), expires_at)
            .await?;
        Ok(payload)
    }

    pub fn in_memory_size(&self) -> usize {
        self.cache.len()
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        (
            self.hits.load(Ordering::Relaxed),
            self.misses.load(Ordering::Relaxed),
            self.expired.load(Ordering::Relaxed),
        )
    }

    pub fn spawn_recent_tv_metadata_warmup(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(TMDB_TV_METADATA_WARMUP_DELAY_SECONDS)).await;
            match service.warm_recent_tv_metadata().await {
                Ok(warmed) if warmed > 0 => {
                    info!("warmed TMDB TV metadata cache for {warmed} series");
                }
                Ok(_) => {}
                Err(error) => {
                    warn!(
                        "TMDB TV metadata warmup failed: {}",
                        error.message().unwrap_or("request failed")
                    );
                }
            }
        });
    }

    pub async fn warm_recent_tv_metadata(&self) -> AppResult<usize> {
        let candidates = self
            .db
            .get_recent_tmdb_tv_warmup_candidates(TMDB_TV_METADATA_WARMUP_CANDIDATES)
            .await?;
        let mut warmed = 0;
        for candidate in candidates {
            match self.warm_tv_metadata_candidate(&candidate).await {
                Ok(()) => warmed += 1,
                Err(error) => {
                    warn!(
                        "failed to warm TMDB TV metadata for {}: {}",
                        candidate.tmdb_id,
                        error.message().unwrap_or("request failed")
                    );
                }
            }
        }
        Ok(warmed)
    }

    async fn warm_tv_metadata_candidate(&self, candidate: &TmdbTvWarmupCandidate) -> AppResult<()> {
        let tmdb_id = candidate.tmdb_id.trim();
        if !is_numeric_id(tmdb_id) {
            return Ok(());
        }

        let series_path = format!("/tv/{tmdb_id}");
        let external_ids_path = format!("/tv/{tmdb_id}/external_ids");
        let mut detail_params = BTreeMap::new();
        detail_params.insert("append_to_response".to_owned(), "credits,videos".to_owned());
        let details = self.fetch(&series_path, detail_params, 20_000).await?;

        let current_season = candidate.season_number.max(1);
        let current_episode = candidate.episode_number.max(1);
        let current_episode_path =
            format!("/tv/{tmdb_id}/season/{current_season}/episode/{current_episode}");
        let next_episode_path = format!(
            "/tv/{tmdb_id}/season/{current_season}/episode/{}",
            current_episode + 1
        );

        let (series_result, external_result, current_episode_result, next_episode_result) = tokio::join!(
            self.fetch(&series_path, BTreeMap::new(), 20_000),
            self.fetch(&external_ids_path, BTreeMap::new(), 20_000),
            self.fetch(&current_episode_path, BTreeMap::new(), 20_000),
            self.fetch(&next_episode_path, BTreeMap::new(), 20_000)
        );
        log_warmup_fetch_error(tmdb_id, &series_path, &series_result);
        log_warmup_fetch_error(tmdb_id, &external_ids_path, &external_result);
        log_warmup_fetch_error(tmdb_id, &current_episode_path, &current_episode_result);
        log_warmup_fetch_error(tmdb_id, &next_episode_path, &next_episode_result);

        for season_number in tv_metadata_warmup_seasons(&details, current_season) {
            let season_path = format!("/tv/{tmdb_id}/season/{season_number}");
            let result = self.fetch(&season_path, BTreeMap::new(), 20_000).await;
            log_warmup_fetch_error(tmdb_id, &season_path, &result);
        }

        Ok(())
    }
}

impl TmdbService {
    async fn get_cached_response(
        &self,
        cache_key: &str,
        extend_expires_at: Option<i64>,
    ) -> AppResult<Option<Value>> {
        if let Some(entry) = self.cache.get(cache_key) {
            if entry.expires_at > now_ms() {
                self.hits.fetch_add(1, Ordering::Relaxed);
                let existing_expires_at = entry.expires_at;
                let value = entry.value.clone();
                drop(entry);
                let extended_expires_at =
                    cache_extension_expires_at(extend_expires_at, existing_expires_at);
                self.cache.entry(cache_key.to_owned()).and_modify(|e| {
                    e.last_accessed_at = now_ms();
                    if let Some(expires_at) = extended_expires_at {
                        e.expires_at = expires_at;
                    }
                });
                if let Some(expires_at) = extended_expires_at {
                    self.db
                        .extend_tmdb_cache_expiration(cache_key.to_owned(), expires_at)
                        .await?;
                }
                return Ok(Some(value));
            }
            self.cache.remove(cache_key);
            self.expired.fetch_add(1, Ordering::Relaxed);
        }

        if let Some((payload, expires_at)) = self.db.get_tmdb_cache(cache_key.to_owned()).await? {
            let final_expires_at =
                cache_extension_expires_at(extend_expires_at, expires_at).unwrap_or(expires_at);
            if final_expires_at > expires_at {
                self.db
                    .extend_tmdb_cache_expiration(cache_key.to_owned(), final_expires_at)
                    .await?;
            }
            self.cache.insert(
                cache_key.to_owned(),
                CachedValue {
                    expires_at: final_expires_at,
                    last_accessed_at: now_ms(),
                    value: payload.clone(),
                },
            );
            trim_cache(&self.cache);
            self.hits.fetch_add(1, Ordering::Relaxed);
            return Ok(Some(payload));
        }

        self.misses.fetch_add(1, Ordering::Relaxed);
        Ok(None)
    }
}

const TMDB_CACHE_EVICTION_AGE_MS: i64 = 24 * 60 * 60 * 1000;

fn trim_cache(cache: &DashMap<String, CachedValue>) {
    if cache.len() <= TMDB_RESPONSE_CACHE_MAX_ENTRIES {
        return;
    }
    let cutoff = now_ms() - TMDB_CACHE_EVICTION_AGE_MS;
    cache.retain(|_, entry| entry.last_accessed_at > cutoff);
}

pub fn build_tmdb_response_cache_key(path: &str, params: &BTreeMap<String, String>) -> String {
    let mut normalized = BTreeMap::from([("language".to_owned(), "en-US".to_owned())]);
    for (key, value) in params {
        if !value.trim().is_empty() {
            normalized.insert(key.clone(), value.clone());
        }
    }
    let query = normalized
        .into_iter()
        .fold(
            url::form_urlencoded::Serializer::new(String::new()),
            |mut serializer, (key, value)| {
                serializer.append_pair(&key, &value);
                serializer
            },
        )
        .finish();
    format!("{}?{}", path.trim(), query)
}

pub fn get_tmdb_cache_ttl_ms(path: &str) -> i64 {
    let normalized = path.trim().to_lowercase();
    if normalized.starts_with("/movie/popular") {
        TMDB_RESPONSE_CACHE_TTL_POPULAR_MS
    } else if normalized.starts_with("/genre/") {
        TMDB_RESPONSE_CACHE_TTL_GENRE_MS
    } else if is_tv_metadata_cache_path(&normalized) {
        TMDB_RESPONSE_CACHE_TTL_TV_METADATA_MS
    } else {
        TMDB_RESPONSE_CACHE_TTL_DEFAULT_MS
    }
}

fn is_numeric_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit())
}

fn is_tv_metadata_cache_path(normalized_path: &str) -> bool {
    let without_query = normalized_path.split('?').next().unwrap_or_default();
    let parts = without_query
        .trim_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if parts.len() < 2 || parts.first() != Some(&"tv") {
        return false;
    }
    is_numeric_id(parts[1])
        && (parts.len() == 2
            || (parts.len() == 3 && parts[2] == "external_ids")
            || (parts.len() == 4 && parts[2] == "season" && is_numeric_id(parts[3]))
            || (parts.len() == 6
                && parts[2] == "season"
                && is_numeric_id(parts[3])
                && parts[4] == "episode"
                && is_numeric_id(parts[5])))
}

fn tv_metadata_warmup_seasons(details: &Value, current_season: i64) -> Vec<i64> {
    let mut seasons = Vec::new();
    push_unique_season(&mut seasons, current_season.max(1));
    if let Some(entries) = details.get("seasons").and_then(Value::as_array) {
        for entry in entries {
            let season_number = entry
                .get("season_number")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if season_number > 0 {
                push_unique_season(&mut seasons, season_number);
            }
            if seasons.len() >= TMDB_TV_METADATA_WARMUP_MAX_SEASONS {
                break;
            }
        }
    }
    seasons.truncate(TMDB_TV_METADATA_WARMUP_MAX_SEASONS);
    seasons
}

fn push_unique_season(seasons: &mut Vec<i64>, season_number: i64) {
    if !seasons.iter().any(|existing| *existing == season_number) {
        seasons.push(season_number);
    }
}

fn cache_extension_expires_at(candidate: Option<i64>, existing_expires_at: i64) -> Option<i64> {
    candidate.filter(|expires_at| {
        expires_at.saturating_sub(existing_expires_at) >= TMDB_RESPONSE_CACHE_EXTEND_MIN_DELTA_MS
    })
}

fn log_warmup_fetch_error<T>(tmdb_id: &str, path: &str, result: &AppResult<T>) {
    if let Err(error) = result {
        warn!(
            "TMDB warmup skipped {path} for series {tmdb_id}: {}",
            error.message().unwrap_or("request failed")
        );
    }
}

fn map_reqwest_error(error: reqwest::Error, timeout_message: &str) -> ApiError {
    if error.is_timeout() {
        ApiError::gateway_timeout(timeout_message)
    } else {
        ApiError::bad_gateway(error.to_string())
    }
}

enum TmdbCredential {
    ApiKey(String),
    Bearer(String),
}

impl TmdbCredential {
    fn secret(&self) -> &str {
        match self {
            Self::ApiKey(value) | Self::Bearer(value) => value.as_str(),
        }
    }
}

trait TmdbRequestAuth {
    fn apply_tmdb_credential(self, credential: &TmdbCredential) -> Self;
}

impl TmdbRequestAuth for reqwest::RequestBuilder {
    fn apply_tmdb_credential(self, credential: &TmdbCredential) -> Self {
        match credential {
            TmdbCredential::ApiKey(api_key) => self.query(&[("api_key", api_key.as_str())]),
            TmdbCredential::Bearer(token) => {
                self.header("Authorization", format!("Bearer {token}"))
            }
        }
    }
}

fn tmdb_credential_from_config(value: &str) -> Option<TmdbCredential> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
    {
        let token = trimmed[7..].trim();
        return (!token.is_empty()).then(|| TmdbCredential::Bearer(token.to_owned()));
    }
    if looks_like_tmdb_read_access_token(trimmed) {
        Some(TmdbCredential::Bearer(trimmed.to_owned()))
    } else {
        Some(TmdbCredential::ApiKey(trimmed.to_owned()))
    }
}

fn looks_like_tmdb_read_access_token(value: &str) -> bool {
    value.starts_with("eyJ") && value.matches('.').count() >= 2
}

fn map_tmdb_status_error(status: StatusCode, message: String) -> ApiError {
    let message = message.trim();
    let detail = if message.is_empty() {
        status.to_string()
    } else {
        message.to_owned()
    };
    match status {
        StatusCode::NOT_FOUND => ApiError::not_found(format!("TMDB item not found: {detail}")),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            ApiError::bad_gateway(format!("TMDB authentication failed: {detail}"))
        }
        StatusCode::TOO_MANY_REQUESTS => {
            ApiError::bad_gateway(format!("TMDB rate limit exceeded: {detail}"))
        }
        _ if status.is_server_error() => {
            ApiError::bad_gateway(format!("TMDB service failed: {detail}"))
        }
        _ => ApiError::bad_gateway(format!("TMDB request failed: {detail}")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        TMDB_RESPONSE_CACHE_TTL_DEFAULT_MS, TMDB_RESPONSE_CACHE_TTL_TV_METADATA_MS, TmdbCredential,
        build_tmdb_response_cache_key, cache_extension_expires_at, get_tmdb_cache_ttl_ms,
        tmdb_credential_from_config, tv_metadata_warmup_seasons,
    };

    #[test]
    fn sorts_tmdb_cache_key_parameters() {
        let mut params = BTreeMap::new();
        params.insert("page".to_owned(), "1".to_owned());
        params.insert("query".to_owned(), "test".to_owned());
        let key = build_tmdb_response_cache_key("/search/movie", &params);
        assert!(key.contains("language=en-US"));
        assert!(key.contains("page=1"));
        assert!(key.contains("query=test"));
    }

    #[test]
    fn treats_plain_tmdb_config_value_as_v3_api_key() {
        let credential = tmdb_credential_from_config("abc123").expect("credential");
        assert!(matches!(credential, TmdbCredential::ApiKey(value) if value == "abc123"));
    }

    #[test]
    fn treats_bearer_tmdb_config_value_as_read_access_token() {
        let credential = tmdb_credential_from_config("Bearer eyJabc.def.ghi").expect("credential");
        assert!(matches!(credential, TmdbCredential::Bearer(value) if value == "eyJabc.def.ghi"));
    }

    #[test]
    fn keeps_tv_metadata_cache_entries_longer() {
        assert_eq!(
            get_tmdb_cache_ttl_ms("/tv/1396"),
            TMDB_RESPONSE_CACHE_TTL_TV_METADATA_MS
        );
        assert_eq!(
            get_tmdb_cache_ttl_ms("/tv/1396/season/1"),
            TMDB_RESPONSE_CACHE_TTL_TV_METADATA_MS
        );
        assert_eq!(
            get_tmdb_cache_ttl_ms("/tv/1396/season/1/episode/1"),
            TMDB_RESPONSE_CACHE_TTL_TV_METADATA_MS
        );
        assert_eq!(
            get_tmdb_cache_ttl_ms("/search/tv"),
            TMDB_RESPONSE_CACHE_TTL_DEFAULT_MS
        );
    }

    #[test]
    fn tv_warmup_seasons_include_current_first() {
        let details = serde_json::json!({
            "seasons": [
                { "season_number": 1 },
                { "season_number": 2 },
                { "season_number": 3 }
            ]
        });
        assert_eq!(tv_metadata_warmup_seasons(&details, 2), vec![2, 1, 3]);
    }

    #[test]
    fn cache_expiration_extension_requires_meaningful_delta() {
        assert_eq!(cache_extension_expires_at(Some(2_000), 1_000), None);
        assert_eq!(
            cache_extension_expires_at(Some(90_000_000), 1_000),
            Some(90_000_000)
        );
    }
}
