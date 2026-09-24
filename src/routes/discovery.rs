use std::collections::{BTreeMap, HashSet};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Method, Response, Uri};
use serde_json::{Value, json};

use super::{AppState, is_numeric_id, query_pairs, stringify_json};
use crate::auth;
use crate::error::{ApiError, AppResult, json_response};
use crate::library::normalize_whitespace;

const IMAGE_BASE: &str = "https://image.tmdb.org/t/p";
const PAGE_SIZE: usize = 40;
// TMDB uses different genre IDs for films and TV. Keep that translation on the
// server so both clients offer the same filters without treating soaps as romance.
const GENRES: &[(&str, &str, &str, &str)] = &[
    ("action", "Action & Adventure", "28|12", "10759"),
    ("animation", "Animation", "16", "16"),
    ("comedy", "Comedy", "35", "35"),
    ("crime", "Crime", "80", "80"),
    ("documentary", "Documentary", "99", "99"),
    ("drama", "Drama", "18", "18"),
    ("family", "Family", "10751", "10751"),
    ("fantasy", "Fantasy", "14", "10765"),
    ("horror", "Horror", "27", ""),
    ("mystery", "Mystery", "9648", "9648"),
    ("romance", "Romance", "10749", ""),
    ("science-fiction", "Science Fiction", "878", "10765"),
    ("thriller", "Thriller", "53", ""),
];

#[derive(Debug)]
struct SearchOptions {
    query: String,
    media_type: String,
    genre: String,
    year: String,
    person_id: String,
    page: usize,
}

fn genre_key(value: &str) -> Option<&'static str> {
    let value = value.trim().to_lowercase();
    if matches!(value.as_str(), "sci-fi" | "scifi" | "science fiction") {
        return Some("science-fiction");
    }
    GENRES
        .iter()
        .find_map(|(id, name, _, _)| (*id == value || name.to_lowercase() == value).then_some(*id))
}

impl SearchOptions {
    fn parse(params: &BTreeMap<String, String>) -> AppResult<Self> {
        let query = normalize_whitespace(
            params
                .get("query")
                .or_else(|| params.get("q"))
                .cloned()
                .unwrap_or_default(),
        );
        if query.chars().count() > 200 {
            return Err(ApiError::bad_request(
                "Search is limited to 200 characters.",
            ));
        }
        let media_type = params
            .get("mediaType")
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "all".into());
        if !matches!(media_type.as_str(), "all" | "movie" | "tv") {
            return Err(ApiError::bad_request("Unsupported mediaType."));
        }
        let genre = match params.get("genre").filter(|v| !v.is_empty()) {
            Some(value) => genre_key(value)
                .ok_or_else(|| ApiError::bad_request("Unknown genre."))?
                .to_owned(),
            None => genre_key(&query).unwrap_or_default().to_owned(),
        };
        let year = params.get("year").cloned().unwrap_or_default();
        if !year.is_empty()
            && (year.len() != 4
                || !year
                    .parse::<u16>()
                    .is_ok_and(|v| (1874..=2100).contains(&v)))
        {
            return Err(ApiError::bad_request("Enter a four-digit release year."));
        }
        let person_id = params.get("personId").cloned().unwrap_or_default();
        if !person_id.is_empty() && (!is_numeric_id(&person_id) || person_id.len() > 10) {
            return Err(ApiError::bad_request("Invalid personId."));
        }
        let page = params
            .get("page")
            .map(|v| v.parse::<usize>().unwrap_or(0))
            .unwrap_or(1);
        if !(1..=500).contains(&page) {
            return Err(ApiError::bad_request("Page must be between 1 and 500."));
        }
        Ok(Self {
            query,
            media_type,
            genre,
            year,
            person_id,
            page,
        })
    }

    fn genre_ids(&self, media_type: &str) -> Option<&'static str> {
        GENRES
            .iter()
            .find(|(id, _, _, _)| *id == self.genre)
            .map(
                |(_, _, movie, tv)| {
                    if media_type == "tv" { *tv } else { *movie }
                },
            )
    }

    fn accepts(&self, entry: &Value) -> bool {
        let media_type = entry["media_type"].as_str().unwrap_or_default();
        if !matches!(media_type, "movie" | "tv")
            || entry["adult"].as_bool() == Some(true)
            || entry["id"].as_u64().is_none()
            || (self.media_type != "all" && self.media_type != media_type)
        {
            return false;
        }
        let date = if media_type == "tv" {
            &entry["first_air_date"]
        } else {
            &entry["release_date"]
        };
        if !self.year.is_empty() && !date.as_str().is_some_and(|v| v.starts_with(&self.year)) {
            return false;
        }
        if let Some(ids) = self.genre_ids(media_type) {
            return entry["genre_ids"].as_array().is_some_and(|genres| {
                ids.split('|')
                    .filter_map(|id| id.parse::<u64>().ok())
                    .any(|id| genres.iter().any(|g| g.as_u64() == Some(id)))
            });
        }
        true
    }
}

fn entries(payload: &Value, field: &str) -> Vec<Value> {
    payload[field].as_array().cloned().unwrap_or_default()
}

fn normalize_title(entry: &Value) -> Value {
    json!({
        "id": stringify_json(entry.get("id")), "mediaType": entry["media_type"],
        "title": entry.get("title").or_else(|| entry.get("name")).and_then(Value::as_str).unwrap_or_default(),
        "name": entry.get("name").or_else(|| entry.get("title")).and_then(Value::as_str).unwrap_or_default(),
        "releaseDate": entry["release_date"].as_str().unwrap_or_default(),
        "firstAirDate": entry["first_air_date"].as_str().unwrap_or_default(),
        "posterPath": entry["poster_path"], "backdropPath": entry["backdrop_path"],
        "overview": entry["overview"].as_str().unwrap_or_default(),
        "genreIds": entry["genre_ids"], "voteAverage": entry["vote_average"].as_f64().unwrap_or(0.0)
    })
}

fn normalized_people(payload: &Value) -> Vec<Value> {
    entries(payload, "results").into_iter().filter(|p| p["id"].as_u64().is_some() && p["adult"].as_bool() != Some(true)).take(6).map(|p| json!({
        "id": p["id"], "name": p["name"], "department": p["known_for_department"], "profilePath": p["profile_path"]
    })).collect()
}

fn filter_titles(titles: Vec<Value>, options: &SearchOptions) -> Vec<Value> {
    let mut seen = HashSet::new();
    titles
        .into_iter()
        .filter(|entry| options.accepts(entry))
        .filter(|entry| seen.insert(format!("{}:{}", entry["media_type"], entry["id"])))
        .collect()
}

fn sort_popular(titles: &mut [Value]) {
    titles.sort_by(|a, b| {
        b["popularity"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["popularity"].as_f64().unwrap_or(0.0))
    });
}

fn filmography(credits: &Value, department: &str) -> Vec<Value> {
    let crew = entries(credits, "crew");
    let selected: Vec<Value> = match department {
        "Directing" => crew
            .iter()
            .filter(|e| e["job"] == "Director")
            .cloned()
            .collect(),
        "Writing" => crew
            .iter()
            .filter(|e| {
                matches!(
                    e["job"].as_str(),
                    Some("Writer" | "Screenplay" | "Story" | "Creator")
                )
            })
            .cloned()
            .collect(),
        "Acting" => entries(credits, "cast"),
        _ => crew
            .iter()
            .filter(|e| e["department"] == department)
            .cloned()
            .collect(),
    };
    if selected.is_empty() {
        entries(credits, "cast").into_iter().chain(crew).collect()
    } else {
        selected
    }
}

async fn discover(state: &AppState, options: &SearchOptions, media_type: &str) -> AppResult<Value> {
    if (options.media_type != "all" && options.media_type != media_type)
        || options.genre_ids(media_type) == Some("")
    {
        return Ok(json!({ "results": [], "total_pages": 0 }));
    }
    let mut params = BTreeMap::from([
        ("page".into(), options.page.to_string()),
        ("include_adult".into(), "false".into()),
        ("sort_by".into(), "popularity.desc".into()),
    ]);
    if let Some(ids) = options.genre_ids(media_type) {
        params.insert("with_genres".into(), ids.into());
    }
    if !options.year.is_empty() {
        params.insert(
            if media_type == "tv" {
                "first_air_date_year"
            } else {
                "primary_release_year"
            }
            .into(),
            options.year.clone(),
        );
    }
    let mut payload = state
        .tmdb
        .fetch(&format!("/discover/{media_type}"), params, 20_000)
        .await?;
    if let Some(results) = payload["results"].as_array_mut() {
        for entry in results {
            entry["media_type"] = json!(media_type);
        }
    }
    Ok(payload)
}

pub(super) async fn tmdb_search_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let options = SearchOptions::parse(&query_pairs(uri.query().unwrap_or_default()))?;
    let mut people = Vec::new();
    let mut person = Value::Null;
    let mut has_more = false;
    let titles;
    if !options.person_id.is_empty() {
        let details = state
            .tmdb
            .fetch(
                &format!("/person/{}", options.person_id),
                BTreeMap::from([("append_to_response".into(), "combined_credits".into())]),
                20_000,
            )
            .await?;
        person = json!({ "id": details["id"], "name": details["name"], "department": details["known_for_department"] });
        titles = filmography(
            &details["combined_credits"],
            details["known_for_department"].as_str().unwrap_or_default(),
        );
    } else if options.query.is_empty() || genre_key(&options.query).is_some() {
        let (movies, series) = tokio::try_join!(
            discover(&state, &options, "movie"),
            discover(&state, &options, "tv")
        )?;
        has_more = [
            movies["total_pages"].as_u64(),
            series["total_pages"].as_u64(),
        ]
        .into_iter()
        .flatten()
        .any(|total| total.min(500) > options.page as u64);
        titles = entries(&movies, "results")
            .into_iter()
            .chain(entries(&series, "results"))
            .collect();
    } else if options.query.chars().count() < 2 {
        titles = Vec::new();
    } else {
        let params = BTreeMap::from([
            ("query".into(), options.query.clone()),
            ("include_adult".into(), "false".into()),
            ("page".into(), options.page.to_string()),
        ]);
        let person_params = BTreeMap::from([
            ("query".into(), options.query.clone()),
            ("include_adult".into(), "false".into()),
        ]);
        let (matches, names) = tokio::try_join!(
            state.tmdb.fetch("/search/multi", params, 20_000),
            state.tmdb.fetch("/search/person", person_params, 20_000)
        )?;
        people = normalized_people(&names);
        if let Some(exact) = people.iter().find(|p| {
            p["name"]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(&options.query))
        }) {
            person = exact.clone();
            let credits = state
                .tmdb
                .fetch(
                    &format!("/person/{}/combined_credits", person["id"]),
                    BTreeMap::new(),
                    20_000,
                )
                .await?;
            titles = filmography(&credits, person["department"].as_str().unwrap_or_default());
        } else {
            has_more = matches["total_pages"].as_u64().unwrap_or(0).min(500) > options.page as u64;
            titles = entries(&matches, "results");
        }
    }
    let mut titles = filter_titles(titles, &options);
    if options.query.is_empty() || genre_key(&options.query).is_some() || !person.is_null() {
        sort_popular(&mut titles);
    }
    if !person.is_null() {
        let start = (options.page - 1) * PAGE_SIZE;
        has_more = titles.len() > start + PAGE_SIZE;
        titles = titles.into_iter().skip(start).take(PAGE_SIZE).collect();
    }
    let results: Vec<_> = titles.iter().map(normalize_title).collect();
    Ok(json_response(json!({
        "query": options.query, "results": results, "people": people, "person": person,
        "page": options.page, "hasMore": has_more, "imageBase": IMAGE_BASE,
        "genres": GENRES.iter().map(|(id, name, _, _)| json!({ "id": id, "name": name })).collect::<Vec<_>>()
    })))
}

fn watched_title_keys(progress: &[(String, f64, i64)]) -> HashSet<String> {
    progress
        .iter()
        .filter(|(_, seconds, _)| *seconds >= 60.0)
        .filter_map(|(identity, _, _)| {
            let parts: Vec<_> = identity.split(':').collect();
            (parts.len() >= 3
                && parts[0] == "tmdb"
                && matches!(parts[1], "movie" | "tv")
                && is_numeric_id(parts[2]))
            .then(|| format!("{}:{}", parts[1], parts[2]))
        })
        .collect()
}

fn rank_recommendations(
    titles: Vec<Value>,
    media_type: &str,
    tmdb_id: &str,
    watched: &HashSet<String>,
) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut titles: Vec<_> = titles
        .into_iter()
        .filter_map(|mut entry| {
            let id = entry["id"].as_u64()?.to_string();
            let kind = entry["media_type"]
                .as_str()
                .unwrap_or(media_type)
                .to_owned();
            if !matches!(kind.as_str(), "movie" | "tv")
                || entry["adult"] == true
                || (id == tmdb_id && kind == media_type)
                || !seen.insert(format!("{kind}:{id}"))
            {
                return None;
            }
            entry["media_type"] = json!(kind);
            Some(entry)
        })
        .collect();
    // Stable partition: prioritize titles the viewer has not started, preserving
    // TMDB relevance within each group. A partial watch is not a completion signal.
    titles.sort_by_key(|e| {
        watched.contains(&format!(
            "{}:{}",
            e["media_type"].as_str().unwrap_or_default(),
            e["id"]
        ))
    });
    titles.iter().take(12).map(normalize_title).collect()
}

pub(super) async fn tmdb_recommendations_handler(
    State(state): State<AppState>,
    request_auth: auth::RequestAuth,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    let user = request_auth.require_auth(&state.db, &headers).await?;
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    let media_type = params
        .get("mediaType")
        .map(String::as_str)
        .unwrap_or("movie");
    if !is_numeric_id(&tmdb_id) || tmdb_id.len() > 10 || !matches!(media_type, "movie" | "tv") {
        return Err(ApiError::bad_request("Invalid title."));
    }
    let recommendations_path = format!("/{media_type}/{tmdb_id}/recommendations");
    let (recommendations, progress) = tokio::try_join!(
        state
            .tmdb
            .fetch(&recommendations_path, BTreeMap::new(), 20_000),
        state.db.get_user_watch_progress(user.id)
    )?;
    let results = rank_recommendations(
        entries(&recommendations, "results"),
        media_type,
        &tmdb_id,
        &watched_title_keys(&progress),
    );
    let mut response = json_response(json!({ "results": results, "imageBase": IMAGE_BASE }));
    response.headers_mut().insert(
        "cache-control",
        "private, no-store".parse().expect("static header"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(values: &[(&str, &str)]) -> SearchOptions {
        SearchOptions::parse(
            &values
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
        )
        .unwrap()
    }

    #[test]
    fn discovery_filters_use_the_correct_movie_and_tv_genres() {
        let opts = options(&[("genre", "Science Fiction"), ("year", "2010")]);
        assert_eq!(opts.genre_ids("movie"), Some("878"));
        assert_eq!(opts.genre_ids("tv"), Some("10765"));
        assert!(opts.accepts(
            &json!({"id": 1, "media_type":"movie", "release_date":"2010-07-01", "genre_ids":[878]})
        ));
        assert!(!opts.accepts(
            &json!({"id": 1, "media_type":"movie", "release_date":"2011-07-01", "genre_ids":[878]})
        ));
        assert!(
            !options(&[("genre", "romance")])
                .accepts(&json!({"id": 2, "media_type":"tv", "genre_ids":[10766]}))
        );
    }

    #[test]
    fn search_rejects_invalid_filter_and_path_inputs() {
        for (key, value) in [
            ("personId", "../movie"),
            ("year", "20"),
            ("mediaType", "person"),
            ("genre", "fake"),
            ("page", "501"),
            ("page", "0"),
        ] {
            assert!(SearchOptions::parse(&BTreeMap::from([(key.into(), value.into())])).is_err());
        }
    }

    #[test]
    fn directors_get_directed_films_and_actors_get_cast_credits() {
        let credits = json!({"cast":[{"id":1}], "crew":[{"id":2,"job":"Director"},{"id":3,"job":"Producer"}]});
        assert_eq!(
            filmography(&credits, "Directing"),
            vec![json!({"id":2,"job":"Director"})]
        );
        assert_eq!(filmography(&credits, "Acting"), vec![json!({"id":1})]);
    }

    #[test]
    fn titles_are_deduplicated_by_type_and_adult_results_are_excluded() {
        let entries = vec![
            json!({"id":1,"media_type":"movie"}),
            json!({"id":1,"media_type":"movie"}),
            json!({"id":1,"media_type":"tv"}),
            json!({"id":2,"media_type":"movie","adult":true}),
        ];
        assert_eq!(filter_titles(entries, &options(&[])).len(), 2);
    }

    #[test]
    fn recommendations_preserve_relevance_while_prioritizing_unwatched_titles() {
        let watched = watched_title_keys(&[
            ("tmdb:tv:2:s3:e4".into(), 120.0, 0),
            ("tmdb:movie:3".into(), 5.0, 0),
        ]);
        let entries = vec![
            json!({"id":1}),
            json!({"id":2}),
            json!({"id":3}),
            json!({"id":3}),
            json!({"id":4,"adult":true}),
        ];
        let ranked = rank_recommendations(entries, "tv", "1", &watched);
        assert_eq!(
            ranked
                .iter()
                .map(|e| e["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["3", "2"]
        );
        assert!(!watched.contains("movie:3"));
    }
}
