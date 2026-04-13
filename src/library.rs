use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::{ApiError, AppResult};
use crate::utils::now_ms;

static LOCAL_LIBRARY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Library {
    #[serde(default)]
    pub movies: Vec<MovieEntry>,
    #[serde(default)]
    pub series: Vec<SeriesEntry>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovieEntry {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub tmdbId: String,
    #[serde(default)]
    pub year: String,
    pub src: String,
    pub thumb: String,
    #[serde(default)]
    pub description: String,
    pub uploadedAt: i64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesEntry {
    pub id: String,
    pub title: String,
    pub contentKind: String,
    #[serde(default)]
    pub tmdbId: String,
    #[serde(default)]
    pub year: String,
    pub preferredContainer: String,
    pub requiresLocalEpisodeSources: bool,
    pub episodes: Vec<SeriesEpisodeEntry>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesEpisodeEntry {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub thumb: String,
    pub src: String,
    pub contentKind: String,
    pub seasonNumber: i64,
    pub episodeNumber: i64,
    pub uploadedAt: i64,
}

pub async fn read_local_library(path: &Path) -> AppResult<Library> {
    let _guard = LOCAL_LIBRARY_LOCK.lock().await;
    read_local_library_unlocked(path).await
}

pub async fn write_local_library(path: &Path, payload: Value) -> AppResult<Library> {
    let _guard = LOCAL_LIBRARY_LOCK.lock().await;
    write_local_library_unlocked(path, payload).await
}

pub async fn mutate_local_library<T, F>(path: &Path, mutate: F) -> AppResult<T>
where
    F: FnOnce(&mut Library) -> AppResult<T>,
{
    let _guard = LOCAL_LIBRARY_LOCK.lock().await;
    let mut library = read_local_library_unlocked(path).await?;
    let output = mutate(&mut library)?;
    write_local_library_unlocked(
        path,
        serde_json::to_value(&library).map_err(|error| ApiError::internal(error.to_string()))?,
    )
    .await?;
    Ok(output)
}

async fn read_local_library_unlocked(path: &Path) -> AppResult<Library> {
    match fs::read_to_string(path).await {
        Ok(raw) => {
            let parsed = serde_json::from_str::<Value>(&raw).map_err(|error| {
                ApiError::internal(format!("Failed to parse local library JSON: {error}"))
            })?;
            Ok(normalize_local_library(parsed))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Library::default()),
        Err(error) => Err(ApiError::internal(error.to_string())),
    }
}

async fn write_local_library_unlocked(path: &Path, payload: Value) -> AppResult<Library> {
    let normalized = normalize_local_library(payload);
    let pretty = serde_json::to_string_pretty(&normalized)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    write_local_library_file_atomically(path, &format!("{pretty}\n")).await?;
    Ok(normalized)
}

async fn write_local_library_file_atomically(path: &Path, contents: &str) -> AppResult<()> {
    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let temp_path = build_local_library_temp_path(path);
    let mut temp_file = match fs::File::create(&temp_path).await {
        Ok(file) => file,
        Err(error) => return Err(ApiError::internal(error.to_string())),
    };

    if let Err(error) = temp_file.write_all(contents.as_bytes()).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(ApiError::internal(error.to_string()));
    }
    if let Err(error) = temp_file.sync_all().await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(ApiError::internal(error.to_string()));
    }
    drop(temp_file);

    if let Err(error) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(ApiError::internal(error.to_string()));
    }
    Ok(())
}

fn build_local_library_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("library.json");
    path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        now_ms()
    ))
}

pub fn normalize_local_library(raw_value: Value) -> Library {
    let source = raw_value.as_object().cloned().unwrap_or_default();

    let movies = source
        .get("movies")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_local_movie_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let series = source
        .get("series")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_local_series_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Library { movies, series }
}

fn normalize_local_movie_entry(entry: &Value) -> Option<MovieEntry> {
    let entry = entry.as_object()?;
    let title = normalize_whitespace(value_string(entry.get("title")));
    let src = normalize_whitespace(value_string(entry.get("src")));
    if title.is_empty() || src.is_empty() {
        return None;
    }

    Some(MovieEntry {
        id: normalize_whitespace(value_string(entry.get("id")))
            .trim()
            .to_owned()
            .chars()
            .collect::<String>()
            .if_empty_then(|| slugify(&title, "title")),
        title,
        tmdbId: normalize_tmdb_id(value_string(entry.get("tmdbId"))),
        year: normalize_year(value_string(entry.get("year"))),
        src,
        thumb: normalize_whitespace(value_string(entry.get("thumb")))
            .if_empty_then(|| "assets/images/thumbnail.jpg".to_owned()),
        description: normalize_whitespace(value_string(entry.get("description"))),
        uploadedAt: value_i64(entry.get("uploadedAt")).unwrap_or_else(now_ms),
    })
}

fn normalize_local_series_entry(entry: &Value) -> Option<SeriesEntry> {
    let entry = entry.as_object()?;
    let title = normalize_whitespace(value_string(entry.get("title")));
    let id = slugify(
        &normalize_whitespace(value_string(entry.get("id")).if_empty_then(|| title.clone())),
        "series",
    );
    if id.is_empty() || title.is_empty() {
        return None;
    }

    let inferred_course = format!("{id} {title}").to_lowercase().contains("course");
    let content_kind = match normalize_whitespace(value_string(entry.get("contentKind")))
        .to_lowercase()
        .as_str()
    {
        "course" => "course".to_owned(),
        _ if inferred_course => "course".to_owned(),
        _ => "series".to_owned(),
    };

    let mut episodes = entry
        .get("episodes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    normalize_local_series_episode_entry(item, index, &content_kind)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if episodes.is_empty() {
        return None;
    }
    episodes.sort_by_key(|item| (item.seasonNumber, item.episodeNumber));

    Some(SeriesEntry {
        id,
        title,
        contentKind: content_kind,
        tmdbId: normalize_tmdb_id(value_string(entry.get("tmdbId"))),
        year: normalize_year(value_string(entry.get("year"))),
        preferredContainer: "mp4".to_owned(),
        requiresLocalEpisodeSources: true,
        episodes,
    })
}

fn normalize_local_series_episode_entry(
    entry: &Value,
    fallback_index: usize,
    fallback_content_kind: &str,
) -> Option<SeriesEpisodeEntry> {
    let entry = entry.as_object()?;
    let src = normalize_whitespace(value_string(entry.get("src")));
    if src.is_empty() {
        return None;
    }
    let content_kind = match normalize_whitespace(value_string(entry.get("contentKind")))
        .to_lowercase()
        .as_str()
    {
        "course" => "course".to_owned(),
        _ => fallback_content_kind.to_owned(),
    };
    let episode_number = normalize_upload_episode_ordinal(
        value_i64(entry.get("episodeNumber")).unwrap_or((fallback_index + 1) as i64),
        (fallback_index + 1) as i64,
    );
    let fallback_prefix = if content_kind == "course" {
        "Lesson"
    } else {
        "Episode"
    };

    Some(SeriesEpisodeEntry {
        title: normalize_whitespace(value_string(entry.get("title")))
            .if_empty_then(|| format!("{fallback_prefix} {episode_number}")),
        description: normalize_whitespace(value_string(entry.get("description"))),
        thumb: normalize_whitespace(value_string(entry.get("thumb")))
            .if_empty_then(|| "assets/images/thumbnail.jpg".to_owned()),
        src,
        contentKind: content_kind,
        seasonNumber: normalize_upload_episode_ordinal(
            value_i64(entry.get("seasonNumber")).unwrap_or(1),
            1,
        ),
        episodeNumber: episode_number,
        uploadedAt: value_i64(entry.get("uploadedAt")).unwrap_or_else(now_ms),
    })
}

pub fn normalize_whitespace(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned()
}

pub fn slugify(value: &str, fallback: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in normalize_whitespace(value).to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    let trimmed = output.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed
    }
}

pub fn normalize_year(value: impl AsRef<str>) -> String {
    let text = value.as_ref().trim();
    if text.len() != 4 || !text.chars().all(|ch| ch.is_ascii_digit()) {
        return String::new();
    }
    let numeric = text.parse::<i32>().unwrap_or_default();
    if (1888..=2100).contains(&numeric) {
        text.to_owned()
    } else {
        String::new()
    }
}

pub fn strip_file_extension(value: &str) -> String {
    let mut chars = value.chars().collect::<Vec<_>>();
    while let Some(ch) = chars.pop() {
        if ch == '.' {
            return chars.into_iter().collect();
        }
        if ch == '/' || ch == '\\' {
            chars.push(ch);
            break;
        }
    }
    value.to_owned()
}

pub fn title_from_filename_token(token: &str) -> String {
    let normalized = token.replace(['.', '_'], " ");
    let tokens = normalized
        .split_whitespace()
        .filter(|item| !is_filename_noise_token(item))
        .collect::<Vec<_>>();
    normalize_whitespace(tokens.join(" "))
}

pub fn normalize_upload_content_type(value: impl AsRef<str>) -> String {
    match value.as_ref().trim().to_lowercase().as_str() {
        "episode" => "episode".to_owned(),
        "course" => "course".to_owned(),
        _ => "movie".to_owned(),
    }
}

pub fn normalize_upload_episode_ordinal(value: i64, fallback: i64) -> i64 {
    if value <= 0 {
        return fallback;
    }
    value.clamp(1, 999)
}

pub fn normalize_tmdb_id(value: String) -> String {
    let trimmed = value.trim();
    if !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        trimmed.to_owned()
    } else {
        String::new()
    }
}

fn value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string().trim_matches('"').to_owned(),
        None => String::new(),
    }
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64(),
        Some(Value::String(text)) => text.parse::<i64>().ok(),
        _ => None,
    }
}

fn is_filename_noise_token(token: &str) -> bool {
    let normalized = token.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    if matches!(
        normalized.as_str(),
        "2160p"
            | "1080p"
            | "720p"
            | "480p"
            | "x264"
            | "x265"
            | "h264"
            | "h265"
            | "hevc"
            | "webdl"
            | "web-dl"
            | "webrip"
            | "bluray"
            | "brrip"
            | "dvdrip"
            | "aac"
            | "ac3"
            | "ddp"
            | "proper"
            | "repack"
    ) {
        return true;
    }
    if let Some(stripped) = normalized.strip_prefix('s') {
        let parts = stripped.split('e').collect::<Vec<_>>();
        if parts.len() == 2
            && !parts[0].is_empty()
            && !parts[1].is_empty()
            && parts[0].chars().all(|ch| ch.is_ascii_digit())
            && parts[1].chars().all(|ch| ch.is_ascii_digit())
        {
            return true;
        }
    }
    if let Some((left, right)) = normalized.split_once('x')
        && !left.is_empty()
        && !right.is_empty()
        && left.chars().all(|ch| ch.is_ascii_digit())
        && right.chars().all(|ch| ch.is_ascii_digit())
    {
        return true;
    }
    false
}

trait StringExt {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl StringExt for String {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::{
        MovieEntry, mutate_local_library, normalize_local_library, read_local_library, slugify,
        write_local_library,
    };
    use crate::error::ApiError;

    fn unique_temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("netflix-library-{name}-{}.json", super::now_ms()))
    }

    #[test]
    fn normalizes_movie_entries() {
        let library = normalize_local_library(json!({
            "movies": [
                {
                    "title": "  Test  Movie ",
                    "src": " assets/videos/test.mp4 ",
                    "year": "2024"
                }
            ]
        }));
        assert_eq!(library.movies.len(), 1);
        assert_eq!(library.movies[0].title, "Test Movie");
        assert_eq!(library.movies[0].id, "test-movie");
    }

    #[test]
    fn slugify_falls_back() {
        assert_eq!(slugify("!!!", "movie"), "movie");
    }

    #[test]
    fn strips_episode_tokens_from_filename_titles() {
        assert_eq!(
            super::title_from_filename_token("The.Office.S02E03.1080p"),
            "The Office"
        );
    }

    #[tokio::test]
    async fn mutates_local_library_without_losing_concurrent_entries() {
        let path = unique_temp_path("concurrent");
        tokio::fs::write(&path, "{\n  \"movies\": [],\n  \"series\": []\n}\n")
            .await
            .expect("write seed library");

        let first_path = path.clone();
        let second_path = path.clone();
        let first = tokio::spawn(async move {
            mutate_local_library(&first_path, |library| {
                library.movies.push(MovieEntry {
                    id: "movie-a".to_owned(),
                    title: "Movie A".to_owned(),
                    tmdbId: "1".to_owned(),
                    year: "2024".to_owned(),
                    src: "assets/videos/movie-a.mp4".to_owned(),
                    thumb: "assets/images/thumbnail.jpg".to_owned(),
                    description: String::new(),
                    uploadedAt: 1,
                });
                Ok::<(), ApiError>(())
            })
            .await
        });
        let second = tokio::spawn(async move {
            mutate_local_library(&second_path, |library| {
                library.movies.push(MovieEntry {
                    id: "movie-b".to_owned(),
                    title: "Movie B".to_owned(),
                    tmdbId: "2".to_owned(),
                    year: "2025".to_owned(),
                    src: "assets/videos/movie-b.mp4".to_owned(),
                    thumb: "assets/images/thumbnail.jpg".to_owned(),
                    description: String::new(),
                    uploadedAt: 2,
                });
                Ok::<(), ApiError>(())
            })
            .await
        });

        first.await.expect("first task").expect("first mutation");
        second.await.expect("second task").expect("second mutation");

        let library = read_local_library(&path).await.expect("read library");
        assert_eq!(library.movies.len(), 2);

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn reports_invalid_local_library_json_instead_of_resetting() {
        let path = unique_temp_path("invalid-json");
        tokio::fs::write(&path, "{ invalid json")
            .await
            .expect("write invalid library");

        let result = read_local_library(&path).await;
        assert!(result.is_err());

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn writes_local_library_via_temp_file_without_leftovers() {
        let path = unique_temp_path("atomic-write");
        let parent = path.parent().expect("parent").to_path_buf();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("file name")
            .to_owned();

        write_local_library(
            &path,
            json!({
                "movies": [{ "title": "Movie A", "src": "assets/videos/movie-a.mp4" }],
                "series": []
            }),
        )
        .await
        .expect("write library");

        let library = read_local_library(&path).await.expect("read library");
        assert_eq!(library.movies.len(), 1);

        let mut entries = tokio::fs::read_dir(&parent).await.expect("read dir");
        while let Some(entry) = entries.next_entry().await.expect("next entry") {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            assert!(
                name == file_name || !name.starts_with(&format!(".{file_name}.tmp-")),
                "unexpected temp file left behind: {name}"
            );
        }

        let _ = tokio::fs::remove_file(&path).await;
    }
}
