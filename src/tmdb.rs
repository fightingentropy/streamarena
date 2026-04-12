use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde_json::Value;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::persistence::Db;

const TMDB_BASE_URL: &str = "https://api.themoviedb.org/3";
const TMDB_RESPONSE_CACHE_TTL_DEFAULT_MS: i64 = 6 * 60 * 60 * 1000;
const TMDB_RESPONSE_CACHE_TTL_POPULAR_MS: i64 = 30 * 60 * 1000;
const TMDB_RESPONSE_CACHE_TTL_GENRE_MS: i64 = 24 * 60 * 60 * 1000;
const TMDB_RESPONSE_CACHE_MAX_ENTRIES: usize = 1200;

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
        if self.config.tmdb_api_key.trim().is_empty() {
            return Err(ApiError::internal(
                "TMDB_API_KEY is not configured on the server.",
            ));
        }

        let cache_key = build_tmdb_response_cache_key(path, &params);
        if let Some(cached) = self.get_cached_response(&cache_key).await? {
            return Ok(cached);
        }

        let mut query = params.clone();
        query.insert("language".to_owned(), "en-US".to_owned());
        query.insert("api_key".to_owned(), self.config.tmdb_api_key.clone());

        let response = self
            .client
            .get(format!("{TMDB_BASE_URL}{path}"))
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
            return Err(ApiError::internal(message));
        }

        let ttl_ms = get_tmdb_cache_ttl_ms(path);
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
}

impl TmdbService {
    async fn get_cached_response(&self, cache_key: &str) -> AppResult<Option<Value>> {
        if let Some(entry) = self.cache.get(cache_key) {
            if entry.expires_at > now_ms() {
                self.hits.fetch_add(1, Ordering::Relaxed);
                let value = entry.value.clone();
                drop(entry);
                // Update last_accessed_at for LRU
                self.cache.entry(cache_key.to_owned()).and_modify(|e| e.last_accessed_at = now_ms());
                return Ok(Some(value));
            }
            self.cache.remove(cache_key);
            self.expired.fetch_add(1, Ordering::Relaxed);
        }

        if let Some((payload, expires_at)) = self.db.get_tmdb_cache(cache_key.to_owned()).await? {
            self.cache.insert(
                cache_key.to_owned(),
                CachedValue {
                    expires_at,
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

fn trim_cache(cache: &DashMap<String, CachedValue>) {
    while cache.len() > TMDB_RESPONSE_CACHE_MAX_ENTRIES {
        let Some(entry) = cache.iter().min_by_key(|entry| entry.value().last_accessed_at) else {
            break;
        };
        let key = entry.key().clone();
        drop(entry);
        cache.remove(&key);
    }
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
    } else {
        TMDB_RESPONSE_CACHE_TTL_DEFAULT_MS
    }
}

fn map_reqwest_error(error: reqwest::Error, timeout_message: &str) -> ApiError {
    if error.is_timeout() {
        ApiError::internal(timeout_message)
    } else {
        ApiError::internal(error.to_string())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::build_tmdb_response_cache_key;

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
}
