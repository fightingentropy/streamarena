use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use tokio::sync::RwLock;

use crate::error::AppResult;
use crate::library::read_local_library;
use crate::routes::AppState;
use crate::utils::now_ms;

const TMDB_FETCH_TIMEOUT_MS: u64 = 8_000;
const BOOTSTRAP_PAGE: &str = "1";
const HOME_BOOTSTRAP_REFRESH_AFTER_MS: i64 = 15 * 60 * 1000;
const HOME_BOOTSTRAP_RAIL_LIMIT: usize = 14;

#[derive(Clone, Default)]
pub struct HomeBootstrapCache {
    inner: Arc<HomeBootstrapCacheInner>,
}

#[derive(Default)]
struct HomeBootstrapCacheInner {
    cached: RwLock<Option<CachedHomeBootstrap>>,
    refresh_in_flight: AtomicBool,
}

#[derive(Clone)]
struct CachedHomeBootstrap {
    payload: Value,
    refreshed_at_ms: i64,
}

impl HomeBootstrapCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn payload_or_refresh(&self, state: AppState) -> Value {
        if let Some(cached) = self.cached_payload().await {
            if self.should_refresh_cached(&cached).await {
                self.spawn_refresh(state);
            }
            return cached;
        }

        self.spawn_refresh(state);
        default_home_bootstrap()
    }

    pub fn spawn_refresh(&self, state: AppState) {
        if self.inner.refresh_in_flight.swap(true, Ordering::AcqRel) {
            return;
        }

        let cache = self.clone();
        tokio::spawn(async move {
            let result = build_home_bootstrap(&state, true).await;
            if let Ok(payload) = result {
                cache.store_payload(payload).await;
            }
            cache
                .inner
                .refresh_in_flight
                .store(false, Ordering::Release);
        });
    }

    async fn cached_payload(&self) -> Option<Value> {
        self.inner
            .cached
            .read()
            .await
            .as_ref()
            .map(|cached| cached.payload.clone())
    }

    async fn cached_is_stale(&self) -> bool {
        match self.inner.cached.read().await.as_ref() {
            Some(cached) => is_stale(cached.refreshed_at_ms),
            None => true,
        }
    }

    async fn should_refresh_cached(&self, payload: &Value) -> bool {
        if is_warming_payload(payload) {
            return true;
        }
        self.cached_is_stale().await
    }

    async fn store_payload(&self, payload: Value) {
        *self.inner.cached.write().await = Some(CachedHomeBootstrap {
            payload,
            refreshed_at_ms: now_ms(),
        });
    }
}

fn is_stale(refreshed_at_ms: i64) -> bool {
    now_ms().saturating_sub(refreshed_at_ms) >= HOME_BOOTSTRAP_REFRESH_AFTER_MS
}

pub async fn build_home_bootstrap(state: &AppState, include_library: bool) -> AppResult<Value> {
    let popular_params = page_params(BOOTSTRAP_PAGE);
    let trending_movie_params = page_params("2");
    let now_playing_params = page_params(BOOTSTRAP_PAGE);
    let top_rated_movie_params = page_params(BOOTSTRAP_PAGE);
    let tv_popular_params = page_params(BOOTSTRAP_PAGE);
    let tv_trending_params = page_params(BOOTSTRAP_PAGE);
    let tv_top_rated_params = page_params(BOOTSTRAP_PAGE);

    let (
        movie_popular,
        movie_trending,
        movie_now_playing,
        movie_top_rated,
        tv_popular,
        tv_trending,
        tv_top_rated,
        movie_genres,
        tv_genres,
    ) = tokio::join!(
        state
            .tmdb
            .fetch("/movie/popular", popular_params, TMDB_FETCH_TIMEOUT_MS),
        state.tmdb.fetch(
            "/trending/movie/week",
            trending_movie_params,
            TMDB_FETCH_TIMEOUT_MS
        ),
        state.tmdb.fetch(
            "/movie/now_playing",
            now_playing_params,
            TMDB_FETCH_TIMEOUT_MS
        ),
        state.tmdb.fetch(
            "/movie/top_rated",
            top_rated_movie_params,
            TMDB_FETCH_TIMEOUT_MS
        ),
        state
            .tmdb
            .fetch("/tv/popular", tv_popular_params, TMDB_FETCH_TIMEOUT_MS),
        state.tmdb.fetch(
            "/trending/tv/week",
            tv_trending_params,
            TMDB_FETCH_TIMEOUT_MS
        ),
        state
            .tmdb
            .fetch("/tv/top_rated", tv_top_rated_params, TMDB_FETCH_TIMEOUT_MS),
        state
            .tmdb
            .fetch("/genre/movie/list", BTreeMap::new(), TMDB_FETCH_TIMEOUT_MS),
        state
            .tmdb
            .fetch("/genre/tv/list", BTreeMap::new(), TMDB_FETCH_TIMEOUT_MS)
    );

    let library = if include_library {
        Some(read_local_library(&state.config.local_library_path).await?)
    } else {
        None
    };
    let movie_genres = movie_genres.unwrap_or_else(|_| json!({ "genres": [] }));
    let tv_genres = tv_genres.unwrap_or_else(|_| json!({ "genres": [] }));
    let empty_results = || json!({ "results": [] });
    let movie_popular = movie_popular.unwrap_or_else(|_| empty_results());

    Ok(json!({
        "imageBase": "https://image.tmdb.org/t/p",
        "genres": merge_genres(&movie_genres, &tv_genres),
        "popular": tmdb_list_payload(movie_popular.clone(), "movie"),
        "bingeworthy": tmdb_list_payload(tv_popular.unwrap_or_else(|_| empty_results()), "tv"),
        "crowdPleasers": tmdb_list_payload(movie_trending.unwrap_or_else(|_| empty_results()), "movie"),
        "topSeries": tmdb_list_payload(tv_trending.unwrap_or_else(|_| empty_results()), "tv"),
        "criticallyAcclaimed": tmdb_list_payload(movie_top_rated.unwrap_or_else(|_| empty_results()), "movie"),
        "trending": tmdb_list_payload(movie_now_playing.unwrap_or_else(|_| empty_results()), "movie"),
        "nowPlaying": tmdb_list_payload(tv_top_rated.unwrap_or_else(|_| empty_results()), "tv"),
        "topRated": tmdb_list_payload(movie_popular, "movie"),
        "library": library
            .map(|value| serde_json::to_value(value).unwrap_or_else(|_| library_empty_value()))
            .unwrap_or_else(library_empty_value),
    }))
}

pub fn default_home_bootstrap() -> Value {
    json!({
        "_meta": {
            "status": "warming",
        },
        "imageBase": "https://image.tmdb.org/t/p",
        "genres": [],
        "popular": { "results": [] },
        "bingeworthy": { "results": [] },
        "crowdPleasers": { "results": [] },
        "topSeries": { "results": [] },
        "criticallyAcclaimed": { "results": [] },
        "trending": { "results": [] },
        "nowPlaying": { "results": [] },
        "topRated": { "results": [] },
        "library": library_empty_value(),
    })
}

pub fn is_warming_payload(payload: &Value) -> bool {
    payload
        .pointer("/_meta/status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "warming")
}

fn page_params(page: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("page".to_owned(), page.to_owned())])
}

fn tmdb_list_payload(payload: Value, media_type: &str) -> Value {
    let results = payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(HOME_BOOTSTRAP_RAIL_LIMIT)
        .map(|mut item| {
            if let Value::Object(object) = &mut item {
                object
                    .entry("media_type")
                    .or_insert_with(|| Value::String(media_type.to_owned()));
            }
            slim_tmdb_item(item)
        })
        .collect::<Vec<_>>();

    json!({
        "results": results,
    })
}

fn slim_tmdb_item(item: Value) -> Value {
    let object = match item {
        Value::Object(object) => object,
        other => return other,
    };
    let mut slim = serde_json::Map::new();
    for key in [
        "id",
        "media_type",
        "title",
        "name",
        "release_date",
        "first_air_date",
        "poster_path",
        "backdrop_path",
        "genre_ids",
        "overview",
        "adult",
        "vote_average",
        "original_language",
    ] {
        if let Some(value) = object.get(key) {
            slim.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(slim)
}

fn library_empty_value() -> Value {
    json!({ "movies": [], "series": [] })
}

fn merge_genres(movie_genres: &Value, tv_genres: &Value) -> Value {
    let mut seen = std::collections::BTreeSet::new();
    let genres = [movie_genres, tv_genres]
        .into_iter()
        .flat_map(|payload| {
            payload
                .get("genres")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter(|genre| {
            genre
                .get("id")
                .and_then(Value::as_i64)
                .is_some_and(|id| seen.insert(id))
        })
        .collect::<Vec<_>>();
    Value::Array(genres)
}

pub fn bootstrap_script_tag(payload: &Value) -> AppResult<String> {
    let json = serde_json::to_string(payload).map_err(|error| {
        crate::error::ApiError::internal(format!("Failed to serialize home bootstrap: {error}"))
    })?;
    let safe_json = json.replace('<', "\\u003c");
    Ok(format!(
        "<script id=\"home-bootstrap\">window.__HOME_BOOTSTRAP__={safe_json};</script>"
    ))
}

pub fn inject_bootstrap_into_html(html: &str, payload: &Value) -> AppResult<String> {
    let script = bootstrap_script_tag(payload)?;
    if let Some(index) = html.find("</head>") {
        let mut output = String::with_capacity(html.len() + script.len() + 16);
        output.push_str(&html[..index]);
        output.push_str(&script);
        output.push('\n');
        output.push_str(&html[index..]);
        return Ok(output);
    }

    Ok(format!("{script}\n{html}"))
}

#[cfg(test)]
mod tests {
    use super::{bootstrap_script_tag, inject_bootstrap_into_html};
    use serde_json::json;

    #[test]
    fn escapes_script_breakout_sequences() {
        let script = bootstrap_script_tag(&json!({ "note": "</script>" })).unwrap();
        let json_part = script
            .strip_prefix("<script id=\"home-bootstrap\">window.__HOME_BOOTSTRAP__=")
            .and_then(|value| value.strip_suffix(";</script>"))
            .expect("bootstrap script wrapper");
        assert!(!json_part.contains("</script>"));
        assert!(json_part.contains("\\u003c"));
    }

    #[test]
    fn injects_before_head_close() {
        let html = "<html><head><title>Home</title></head><body></body></html>";
        let injected =
            inject_bootstrap_into_html(html, &json!({ "popular": { "results": [] } })).unwrap();
        assert!(injected.contains("window.__HOME_BOOTSTRAP__="));
        assert!(
            injected.find("window.__HOME_BOOTSTRAP__=").unwrap()
                < injected.find("</head>").unwrap()
        );
    }
}
