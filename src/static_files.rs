use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderValue, RANGE,
};
use axum::http::{Method, Response, StatusCode};
use tokio::fs;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

use crate::auth;
use crate::error::{ApiError, AppResult};
use crate::home_bootstrap;
use crate::routes::AppState;

const CACHE_NO_STORE: &str = "no-store";
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
const CACHE_STATIC_ASSET: &str = "public, max-age=86400";
const CACHE_VIDEO_ASSET: &str = "private, max-age=3600";

pub async fn serve_static(
    State(state): State<AppState>,
    method: Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET && method != Method::HEAD {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let Some(file_path) = resolve_local_path(
        &state.config.frontend_dir,
        &state.config.root_dir,
        uri.path(),
    ) else {
        return Err(ApiError::not_found("Not found"));
    };
    let injects_home_bootstrap = could_inject_home_bootstrap(uri.path());
    let requires_auth = should_require_auth_for_static_path(uri.path())
        || should_require_auth_for_static_file(&state.config.root_dir, &file_path);
    let authenticated = if injects_home_bootstrap || requires_auth {
        auth::require_auth(&state.db, &headers).await.is_ok()
    } else {
        false
    };
    if requires_auth && !authenticated {
        return Err(ApiError::unauthorized("Not authenticated."));
    }
    let file = File::open(&file_path)
        .await
        .map_err(|_| ApiError::not_found("Not found"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| ApiError::not_found("Not found"))?;
    if !metadata.is_file() {
        return Err(ApiError::not_found("Not found"));
    }

    let file_size = metadata.len();
    let content_type = mime_guess::from_path(&file_path)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_owned();
    let cache_control = cache_control_for_path(uri.path(), &content_type);

    if should_inject_home_bootstrap(uri.path(), &content_type) {
        let html = fs::read_to_string(&file_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let bootstrap = if authenticated {
            state
                .home_bootstrap_cache
                .payload_or_refresh(state.clone())
                .await
        } else {
            home_bootstrap::default_home_bootstrap()
        };
        let html = home_bootstrap::inject_bootstrap_into_html(&html, &bootstrap)?;
        let body_bytes = html.into_bytes();
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(body_bytes.clone())
            })
            .expect("bootstrap html response");
        let headers = response.headers_mut();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        headers.insert(CACHE_CONTROL, HeaderValue::from_static(CACHE_NO_STORE));
        headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&body_bytes.len().to_string()).unwrap(),
        );
        return Ok(response);
    }

    if let Some(range_header) = headers.get(RANGE).and_then(|value| value.to_str().ok()) {
        let Some((start, end)) = parse_range(range_header, file_size) else {
            let mut response = Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .body(Body::from("Requested range not satisfiable"))
                .expect("range response");
            response.headers_mut().insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{file_size}")).unwrap(),
            );
            return Ok(response);
        };
        let mut file = file;
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let len = end - start + 1;
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(ReaderStream::new(file.take(len)))
        };
        let mut response = Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .body(body)
            .expect("partial response");
        let headers = response.headers_mut();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_str(&content_type)
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
        headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&len.to_string()).unwrap(),
        );
        headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{file_size}")).unwrap(),
        );
        return Ok(response);
    }

    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file))
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(body)
        .expect("static response");
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&file_size.to_string()).unwrap(),
    );
    Ok(response)
}

fn resolve_local_path(frontend_dir: &Path, repo_root: &Path, pathname: &str) -> Option<PathBuf> {
    let decoded = percent_decode(pathname)?;
    if decoded.starts_with("/watch/") || decoded == "/watch" {
        return Some(frontend_dir.join("player.html"));
    }
    if decoded.starts_with("/reset-password/") || decoded == "/reset-password" {
        return Some(frontend_dir.join("reset-password.html"));
    }
    if decoded.starts_with("/assets/") {
        let normalized = normalize_path(decoded.trim_start_matches('/'))?;
        let file_path = repo_root.join(normalized);
        return if file_path.starts_with(repo_root) {
            Some(file_path)
        } else {
            None
        };
    }

    let mut requested = if decoded == "/" {
        "/index.html".to_owned()
    } else {
        decoded
    };
    if requested.len() > 1 && requested.ends_with('/') {
        requested.pop();
    }
    if !requested
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .contains('.')
    {
        requested.push_str(".html");
    }
    let normalized = normalize_path(requested.trim_start_matches('/'))?;
    let file_path = frontend_dir.join(normalized);
    if file_path.starts_with(frontend_dir) {
        Some(file_path)
    } else {
        None
    }
}

fn normalize_path(path: &str) -> Option<PathBuf> {
    let mut output = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) => output.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(output)
}

fn percent_decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            let value = u8::from_str_radix(hex, 16).ok()?;
            output.push(value);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).ok()
}

fn parse_range(header: &str, file_size: u64) -> Option<(u64, u64)> {
    let value = header.trim().strip_prefix("bytes=")?;
    let (raw_start, raw_end) = value.split_once('-')?;
    let start = if raw_start.trim().is_empty() {
        let suffix = raw_end.trim().parse::<u64>().ok()?;
        file_size.saturating_sub(suffix)
    } else {
        raw_start.trim().parse::<u64>().ok()?
    };
    let end = if raw_start.trim().is_empty() || raw_end.trim().is_empty() {
        file_size.checked_sub(1)?
    } else {
        raw_end.trim().parse::<u64>().ok()?
    };
    if start > end || end >= file_size {
        return None;
    }
    Some((start, end))
}

fn should_inject_home_bootstrap(pathname: &str, content_type: &str) -> bool {
    pathname == "/"
        || pathname == "/index.html"
        || (content_type.starts_with("text/html") && could_inject_home_bootstrap(pathname))
}

fn could_inject_home_bootstrap(pathname: &str) -> bool {
    pathname == "/" || pathname == "/index.html" || pathname.ends_with("/index.html")
}

fn should_require_auth_for_static_path(pathname: &str) -> bool {
    pathname == "/assets/library.json" || pathname.starts_with("/assets/videos/")
}

fn should_require_auth_for_static_file(repo_root: &Path, file_path: &Path) -> bool {
    let asset_root = repo_root.join("assets");
    let library_path = asset_root.join("library.json");
    let videos_dir = asset_root.join("videos");
    file_path == library_path || file_path.starts_with(videos_dir)
}

fn cache_control_for_path(pathname: &str, content_type: &str) -> &'static str {
    if pathname == "/"
        || pathname.ends_with(".html")
        || pathname == "/assets/library.json"
        || content_type.starts_with("text/html")
        || content_type.contains("json")
    {
        return CACHE_NO_STORE;
    }
    if pathname.starts_with("/ui-assets/") {
        return CACHE_IMMUTABLE;
    }
    if pathname.starts_with("/assets/videos/") {
        return CACHE_VIDEO_ASSET;
    }
    if pathname.starts_with("/assets/images/") || pathname.starts_with("/assets/icons/") {
        return CACHE_STATIC_ASSET;
    }
    if content_type.starts_with("text/") || content_type.contains("javascript") {
        return CACHE_NO_STORE;
    }
    CACHE_STATIC_ASSET
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        CACHE_IMMUTABLE, CACHE_NO_STORE, CACHE_STATIC_ASSET, cache_control_for_path,
        should_require_auth_for_static_file, should_require_auth_for_static_path,
    };
    use super::{CACHE_VIDEO_ASSET, parse_range, resolve_local_path};

    #[test]
    fn maps_clean_route_to_html() {
        let path =
            resolve_local_path(Path::new("/tmp/app"), Path::new("/tmp/app"), "/settings").unwrap();
        assert!(path.ends_with("settings.html"));
    }

    #[test]
    fn preserves_assets_under_repo_root() {
        let path = resolve_local_path(
            Path::new("/tmp/app/dist"),
            Path::new("/tmp/app"),
            "/assets/library.json",
        )
        .unwrap();
        assert!(path.ends_with("assets/library.json"));
        assert!(!path.ends_with("dist/assets/library.json"));
    }

    #[test]
    fn rejects_asset_path_traversal() {
        assert!(
            resolve_local_path(
                Path::new("/tmp/app/dist"),
                Path::new("/tmp/app"),
                "/assets/../.env",
            )
            .is_none()
        );
        assert!(
            resolve_local_path(
                Path::new("/tmp/app/dist"),
                Path::new("/tmp/app"),
                "/assets/%2e%2e/.env",
            )
            .is_none()
        );
    }

    #[test]
    fn maps_watch_route_to_player_html() {
        let path = resolve_local_path(
            Path::new("/tmp/app/dist"),
            Path::new("/tmp/app"),
            "/watch/electrical-course-2025/0",
        )
        .unwrap();
        assert!(path.ends_with("player.html"));
    }

    #[test]
    fn marks_private_static_media_and_library_as_auth_required() {
        assert!(should_require_auth_for_static_path("/assets/library.json"));
        assert!(should_require_auth_for_static_path(
            "/assets/videos/movie.mp4"
        ));
        assert!(!should_require_auth_for_static_path(
            "/assets/icons/netflix-n.svg"
        ));
        assert!(!should_require_auth_for_static_path(
            "/assets/images/poster.jpg"
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/videos/movie.mp4")
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/library.json")
        ));
    }

    #[test]
    fn parses_open_ended_range() {
        assert_eq!(parse_range("bytes=10-", 100), Some((10, 99)));
    }

    #[test]
    fn parses_large_suffix_range() {
        assert_eq!(parse_range("bytes=-999", 100), Some((0, 99)));
    }

    #[test]
    fn keeps_html_and_library_uncached() {
        assert_eq!(cache_control_for_path("/", "text/html"), CACHE_NO_STORE);
        assert_eq!(
            cache_control_for_path("/assets/library.json", "application/json"),
            CACHE_NO_STORE
        );
    }

    #[test]
    fn caches_hashed_vite_assets_immutably() {
        assert_eq!(
            cache_control_for_path("/ui-assets/home-DROte660.js", "text/javascript"),
            CACHE_IMMUTABLE
        );
        assert_eq!(
            cache_control_for_path("/ui-assets/style-D8pVIT3e.css", "text/css"),
            CACHE_IMMUTABLE
        );
    }

    #[test]
    fn caches_media_assets_without_marking_them_immutable() {
        assert_eq!(
            cache_control_for_path("/assets/images/poster.jpg", "image/jpeg"),
            CACHE_STATIC_ASSET
        );
        assert_eq!(
            cache_control_for_path("/assets/videos/movie.mp4", "video/mp4"),
            CACHE_VIDEO_ASSET
        );
    }
}
