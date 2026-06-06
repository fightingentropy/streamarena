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

const MOVIE_POPULAR_QUALITY: TmdbRailQuality = TmdbRailQuality {
    min_vote_average: 7.0,
    min_vote_count: 3_000,
    release_date_key: "release_date",
};
const MOVIE_CROWD_QUALITY: TmdbRailQuality = TmdbRailQuality {
    min_vote_average: 7.2,
    min_vote_count: 5_000,
    release_date_key: "release_date",
};
const MOVIE_ACCLAIMED_QUALITY: TmdbRailQuality = TmdbRailQuality {
    min_vote_average: 7.7,
    min_vote_count: 5_000,
    release_date_key: "release_date",
};
const TV_BINGE_QUALITY: TmdbRailQuality = TmdbRailQuality {
    min_vote_average: 7.8,
    min_vote_count: 2_000,
    release_date_key: "first_air_date",
};
const TV_POPULAR_QUALITY: TmdbRailQuality = TmdbRailQuality {
    min_vote_average: 7.2,
    min_vote_count: 1_000,
    release_date_key: "first_air_date",
};
const TV_ACCLAIMED_QUALITY: TmdbRailQuality = TmdbRailQuality {
    min_vote_average: 8.0,
    min_vote_count: 2_000,
    release_date_key: "first_air_date",
};

#[derive(Clone, Copy)]
struct TmdbRailQuality {
    min_vote_average: f64,
    min_vote_count: i64,
    release_date_key: &'static str,
}

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
    let today = today_utc_date();
    let movie_popular_params = movie_discover_params(
        "popularity.desc",
        MOVIE_POPULAR_QUALITY,
        BOOTSTRAP_PAGE,
        &today,
    );
    let movie_crowd_params = movie_discover_params(
        "vote_count.desc",
        MOVIE_CROWD_QUALITY,
        BOOTSTRAP_PAGE,
        &today,
    );
    let movie_acclaimed_params = movie_discover_params(
        "vote_average.desc",
        MOVIE_ACCLAIMED_QUALITY,
        BOOTSTRAP_PAGE,
        &today,
    );
    let tv_binge_params =
        tv_discover_params("vote_count.desc", TV_BINGE_QUALITY, BOOTSTRAP_PAGE, &today);
    let tv_popular_params = tv_discover_params(
        "popularity.desc",
        TV_POPULAR_QUALITY,
        BOOTSTRAP_PAGE,
        &today,
    );
    let tv_acclaimed_params = tv_discover_params(
        "vote_average.desc",
        TV_ACCLAIMED_QUALITY,
        BOOTSTRAP_PAGE,
        &today,
    );

    let (
        movie_popular,
        movie_crowd,
        movie_acclaimed,
        tv_binge,
        tv_popular,
        tv_acclaimed,
        movie_genres,
        tv_genres,
    ) = tokio::join!(
        state.tmdb.fetch(
            "/discover/movie",
            movie_popular_params,
            TMDB_FETCH_TIMEOUT_MS
        ),
        state
            .tmdb
            .fetch("/discover/movie", movie_crowd_params, TMDB_FETCH_TIMEOUT_MS),
        state.tmdb.fetch(
            "/discover/movie",
            movie_acclaimed_params,
            TMDB_FETCH_TIMEOUT_MS
        ),
        state
            .tmdb
            .fetch("/discover/tv", tv_binge_params, TMDB_FETCH_TIMEOUT_MS),
        state
            .tmdb
            .fetch("/discover/tv", tv_popular_params, TMDB_FETCH_TIMEOUT_MS),
        state
            .tmdb
            .fetch("/discover/tv", tv_acclaimed_params, TMDB_FETCH_TIMEOUT_MS),
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
    let movie_acclaimed = movie_acclaimed.unwrap_or_else(|_| empty_results());
    let movie_popular_payload =
        tmdb_list_payload_with_quality(movie_popular, "movie", MOVIE_POPULAR_QUALITY);
    let movie_crowd_payload = tmdb_list_payload_with_quality(
        movie_crowd.unwrap_or_else(|_| empty_results()),
        "movie",
        MOVIE_CROWD_QUALITY,
    );
    let movie_acclaimed_payload =
        tmdb_list_payload_with_quality(movie_acclaimed, "movie", MOVIE_ACCLAIMED_QUALITY);
    let tv_binge_payload = tmdb_list_payload_with_quality(
        tv_binge.unwrap_or_else(|_| empty_results()),
        "tv",
        TV_BINGE_QUALITY,
    );
    let tv_popular_payload = tmdb_list_payload_with_quality(
        tv_popular.unwrap_or_else(|_| empty_results()),
        "tv",
        TV_POPULAR_QUALITY,
    );
    let tv_acclaimed_payload = tmdb_list_payload_with_quality(
        tv_acclaimed.unwrap_or_else(|_| empty_results()),
        "tv",
        TV_ACCLAIMED_QUALITY,
    );

    Ok(json!({
        "imageBase": "https://image.tmdb.org/t/p",
        "genres": merge_genres(&movie_genres, &tv_genres),
        "popular": movie_popular_payload.clone(),
        "bingeworthy": tv_binge_payload,
        "crowdPleasers": movie_crowd_payload,
        "topSeries": tv_popular_payload,
        "criticallyAcclaimed": movie_acclaimed_payload.clone(),
        "trending": movie_popular_payload,
        "nowPlaying": tv_acclaimed_payload,
        "topRated": movie_acclaimed_payload,
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

fn movie_discover_params(
    sort_by: &str,
    quality: TmdbRailQuality,
    page: &str,
    today: &str,
) -> BTreeMap<String, String> {
    let mut params = page_params(page);
    params.insert("include_adult".to_owned(), "false".to_owned());
    params.insert("include_video".to_owned(), "false".to_owned());
    params.insert("sort_by".to_owned(), sort_by.to_owned());
    params.insert(
        "vote_average.gte".to_owned(),
        quality.min_vote_average.to_string(),
    );
    params.insert(
        "vote_count.gte".to_owned(),
        quality.min_vote_count.to_string(),
    );
    params.insert("primary_release_date.lte".to_owned(), today.to_owned());
    params
}

fn tv_discover_params(
    sort_by: &str,
    quality: TmdbRailQuality,
    page: &str,
    today: &str,
) -> BTreeMap<String, String> {
    let mut params = page_params(page);
    params.insert("include_adult".to_owned(), "false".to_owned());
    params.insert(
        "include_null_first_air_dates".to_owned(),
        "false".to_owned(),
    );
    params.insert("sort_by".to_owned(), sort_by.to_owned());
    params.insert(
        "vote_average.gte".to_owned(),
        quality.min_vote_average.to_string(),
    );
    params.insert(
        "vote_count.gte".to_owned(),
        quality.min_vote_count.to_string(),
    );
    params.insert("first_air_date.lte".to_owned(), today.to_owned());
    params
}

fn tmdb_list_payload_with_quality(
    payload: Value,
    media_type: &str,
    quality: TmdbRailQuality,
) -> Value {
    let today = today_utc_date();
    tmdb_list_payload_from_results(payload, media_type, |item| {
        tmdb_item_passes_quality(item, quality, &today)
    })
}

fn tmdb_list_payload_from_results<F>(payload: Value, media_type: &str, include_item: F) -> Value
where
    F: Fn(&Value) -> bool,
{
    let results = payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(include_item)
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

fn tmdb_item_passes_quality(item: &Value, quality: TmdbRailQuality, today: &str) -> bool {
    let vote_average = item
        .get("vote_average")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let vote_count = item.get("vote_count").and_then(Value::as_i64).unwrap_or(0);
    if vote_average < quality.min_vote_average || vote_count < quality.min_vote_count {
        return false;
    }

    if item.get("adult").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }

    let has_art = ["backdrop_path", "poster_path"].iter().any(|key| {
        item.get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    });
    if !has_art {
        return false;
    }

    let release_date = item
        .get(quality.release_date_key)
        .and_then(Value::as_str)
        .unwrap_or_default();
    is_released_tmdb_date(release_date, today)
}

fn is_released_tmdb_date(date: &str, today: &str) -> bool {
    let date = date.trim();
    date.len() == 10
        && date.chars().enumerate().all(|(index, ch)| {
            if index == 4 || index == 7 {
                ch == '-'
            } else {
                ch.is_ascii_digit()
            }
        })
        && date <= today
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
        "vote_count",
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

pub fn bootstrap_data_tag(payload: &Value) -> AppResult<String> {
    let json = serde_json::to_string(payload).map_err(|error| {
        crate::error::ApiError::internal(format!("Failed to serialize home bootstrap: {error}"))
    })?;
    let safe_json = json.replace('<', "\\u003c");
    Ok(format!(
        "<script id=\"home-bootstrap\" type=\"application/json\">{safe_json}</script>"
    ))
}

pub fn inject_bootstrap_into_html(html: &str, payload: &Value) -> AppResult<String> {
    let script = bootstrap_data_tag(payload)?;
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

fn today_utc_date() -> String {
    utc_date_from_unix_days(now_ms().div_euclid(86_400_000))
}

fn utc_date_from_unix_days(days_since_unix_epoch: i64) -> String {
    let (year, month, day) = civil_from_unix_days(days_since_unix_epoch);
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil_from_unix_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let days = days_since_unix_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 }.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524
        - day_of_era / 146_096)
        .div_euclid(365);
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2).div_euclid(153);
    let day = day_of_year - (153 * month_prime + 2).div_euclid(5) + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::{
        MOVIE_POPULAR_QUALITY, bootstrap_data_tag, inject_bootstrap_into_html,
        tmdb_list_payload_with_quality, utc_date_from_unix_days,
    };
    use serde_json::json;

    #[test]
    fn escapes_json_data_script_breakout_sequences() {
        let script = bootstrap_data_tag(&json!({ "note": "</script>" })).unwrap();
        let json_part = script
            .strip_prefix("<script id=\"home-bootstrap\" type=\"application/json\">")
            .and_then(|value| value.strip_suffix("</script>"))
            .expect("bootstrap data wrapper");
        assert!(!json_part.contains("</script>"));
        assert!(json_part.contains("\\u003c"));
    }

    #[test]
    fn injects_before_head_close() {
        let html = "<html><head><title>Home</title></head><body></body></html>";
        let injected =
            inject_bootstrap_into_html(html, &json!({ "popular": { "results": [] } })).unwrap();
        assert!(injected.contains("id=\"home-bootstrap\" type=\"application/json\""));
        assert!(
            injected.find("id=\"home-bootstrap\"").unwrap() < injected.find("</head>").unwrap()
        );
    }

    #[test]
    fn filters_low_signal_unreleased_and_artless_tmdb_items() {
        let payload = json!({
            "results": [
                {
                    "id": 1,
                    "title": "Crowd Favorite",
                    "release_date": "2024-03-01",
                    "backdrop_path": "/good.jpg",
                    "vote_average": 7.0,
                    "vote_count": 5000
                },
                {
                    "id": 2,
                    "title": "Too Early",
                    "release_date": "2099-01-01",
                    "backdrop_path": "/future.jpg",
                    "vote_average": 8.0,
                    "vote_count": 5000
                },
                {
                    "id": 3,
                    "title": "Too Thin",
                    "release_date": "2024-03-01",
                    "backdrop_path": "/thin.jpg",
                    "vote_average": 9.2,
                    "vote_count": 12
                },
                {
                    "id": 4,
                    "title": "No Art",
                    "release_date": "2024-03-01",
                    "vote_average": 8.0,
                    "vote_count": 5000
                }
            ]
        });

        let curated = tmdb_list_payload_with_quality(payload, "movie", MOVIE_POPULAR_QUALITY);
        let titles = curated
            .get("results")
            .and_then(|value| value.as_array())
            .unwrap();

        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0]["title"], "Crowd Favorite");
        assert_eq!(titles[0]["media_type"], "movie");
    }

    #[test]
    fn formats_unix_days_as_utc_dates() {
        assert_eq!(utc_date_from_unix_days(0), "1970-01-01");
        assert_eq!(utc_date_from_unix_days(10_957), "2000-01-01");
        assert_eq!(utc_date_from_unix_days(20_600), "2026-05-27");
    }
}
