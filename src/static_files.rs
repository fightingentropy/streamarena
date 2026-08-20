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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrivateStaticAssetKind {
    Library,
    Image,
    Video,
}

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
    // Every page shell except the sign-in, password-reset, and offline pages is
    // private: a logged-out visitor sees nothing about the app — not even the
    // homepage. Assets (JS/CSS/images/fonts) stay public so the sign-in page can
    // load and so we don't leak any user-specific data through them.
    let is_protected_page = is_protected_html_page(&file_path);
    let authenticated = if injects_home_bootstrap || requires_auth || is_protected_page {
        auth::require_auth(&state.db, &headers).await.is_ok()
    } else {
        false
    };
    if requires_auth && !authenticated {
        return Err(ApiError::unauthorized("Not authenticated."));
    }
    // A logged-out request for a protected page is bounced to the sign-in page
    // rather than rendering any app chrome.
    if is_protected_page && !authenticated {
        return Ok(redirect_to_login());
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
    let normalized_request = normalize_path(decoded.trim_start_matches('/'))?;
    if first_path_component_eq_ignore_ascii_case(&normalized_request, "assets") {
        let normalized = normalized_request;
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

fn first_path_component_eq_ignore_ascii_case(path: &Path, expected: &str) -> bool {
    path.components().next().is_some_and(|component| {
        matches!(component, Component::Normal(value) if value.to_str().is_some_and(|value| value.eq_ignore_ascii_case(expected)))
    })
}

fn classify_private_static_asset(path: &Path) -> Option<PrivateStaticAssetKind> {
    let mut components = path.components();
    let Component::Normal(root) = components.next()? else {
        return None;
    };
    if !root
        .to_str()
        .is_some_and(|value| value.eq_ignore_ascii_case("assets"))
    {
        return None;
    }
    let Component::Normal(category) = components.next()? else {
        return None;
    };
    let category = category.to_str()?;
    if category.eq_ignore_ascii_case("library.json") && components.next().is_none() {
        return Some(PrivateStaticAssetKind::Library);
    }
    if category.eq_ignore_ascii_case("images") {
        return Some(PrivateStaticAssetKind::Image);
    }
    if category.eq_ignore_ascii_case("videos") {
        return Some(PrivateStaticAssetKind::Video);
    }
    None
}

fn classify_private_static_request(pathname: &str) -> Option<PrivateStaticAssetKind> {
    let decoded = percent_decode(pathname)?;
    let normalized = normalize_path(decoded.trim_start_matches('/'))?;
    classify_private_static_asset(&normalized)
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

/// HTML page shells are private by default. Only the sign-in, password-reset,
/// and offline fallback pages render for a logged-out visitor; every other page
/// (home, browse, player, settings, admin, help, legal, …) requires a session.
/// Decided on the resolved file, so clean routes (`/`, `/watch/…`, `/settings`)
/// are covered too. Non-HTML files are never page shells.
fn is_protected_html_page(file_path: &Path) -> bool {
    let is_html = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html"));
    if !is_html {
        return false;
    }
    let name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "login.html" | "reset-password.html" | "offline.html"
    )
}

/// 302 to the sign-in page, uncached so a later authenticated load isn't shadowed
/// by a stale redirect in any cache between us and the browser.
fn redirect_to_login() -> Response<Body> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(axum::http::header::LOCATION, "/login.html")
        .header(CACHE_CONTROL, CACHE_NO_STORE)
        .body(Body::empty())
        .expect("login redirect response")
}

fn should_require_auth_for_static_path(pathname: &str) -> bool {
    classify_private_static_request(pathname).is_some()
}

fn should_require_auth_for_static_file(repo_root: &Path, file_path: &Path) -> bool {
    file_path
        .strip_prefix(repo_root)
        .ok()
        .and_then(classify_private_static_asset)
        .is_some()
}

fn cache_control_for_path(pathname: &str, content_type: &str) -> &'static str {
    match classify_private_static_request(pathname) {
        Some(PrivateStaticAssetKind::Library | PrivateStaticAssetKind::Image) => {
            return CACHE_NO_STORE;
        }
        Some(PrivateStaticAssetKind::Video) => return CACHE_VIDEO_ASSET,
        None => {}
    }
    if pathname == "/"
        || pathname.ends_with(".html")
        || content_type.starts_with("text/html")
        || content_type.contains("json")
    {
        return CACHE_NO_STORE;
    }
    if pathname.starts_with("/ui-assets/") {
        return CACHE_IMMUTABLE;
    }
    if pathname.starts_with("/assets/icons/") {
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
        CACHE_IMMUTABLE, CACHE_NO_STORE, cache_control_for_path, is_protected_html_page,
        should_require_auth_for_static_file, should_require_auth_for_static_path,
    };
    use super::{CACHE_VIDEO_ASSET, parse_range, resolve_local_path};

    #[test]
    fn gates_app_pages_but_not_sign_in_reset_offline_or_assets() {
        // App page shells require a session.
        assert!(is_protected_html_page(Path::new("/app/dist/index.html")));
        assert!(is_protected_html_page(Path::new("/app/dist/settings.html")));
        assert!(is_protected_html_page(Path::new("/app/dist/player.html")));
        assert!(is_protected_html_page(Path::new("/app/dist/admin.html")));
        assert!(is_protected_html_page(Path::new("/app/dist/help.html")));
        assert!(is_protected_html_page(Path::new("/app/dist/privacy.html")));
        // The pages a logged-out visitor must still reach stay public.
        assert!(!is_protected_html_page(Path::new("/app/dist/login.html")));
        assert!(!is_protected_html_page(Path::new(
            "/app/dist/reset-password.html"
        )));
        assert!(!is_protected_html_page(Path::new("/app/dist/offline.html")));
        // Assets are never page shells. Authentication for private catalogue
        // artwork/media is enforced separately from the HTML-shell check.
        assert!(!is_protected_html_page(Path::new(
            "/app/dist/ui-assets/login-abc123.js"
        )));
        assert!(!is_protected_html_page(Path::new(
            "/app/dist/ui-assets/style-abc123.css"
        )));
        assert!(!is_protected_html_page(Path::new(
            "/app/assets/icons/streamarena-mark.svg"
        )));
        assert!(!is_protected_html_page(Path::new(
            "/app/dist/manifest.webmanifest"
        )));
    }

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
    fn resolves_asset_routes_case_insensitively_after_decoding() {
        for route in [
            "/ASSETS/IMAGES/poster.jpg",
            "/assets%2FIMAGES%2Fposter.jpg",
            "/assets//VIDEOS/movie.mp4",
            "/assets/%2e/LIBRARY.JSON",
        ] {
            let path = resolve_local_path(Path::new("/tmp/app/dist"), Path::new("/tmp/app"), route)
                .unwrap();
            assert!(
                path.to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with("/tmp/app/assets"),
                "route {route}: {path:?}"
            );
            assert!(
                !path.starts_with("/tmp/app/dist"),
                "route {route}: {path:?}"
            );
        }
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
        for route in [
            "/watch/electrical-course-2025/0",
            "/watch/movie/496243/parasite",
            "/watch/tv/1399/game-of-thrones/s1e5",
            "/watch/movie/603",
            "/watch/live/bloomberg-tv-us",
        ] {
            let path = resolve_local_path(Path::new("/tmp/app/dist"), Path::new("/tmp/app"), route)
                .unwrap();
            assert!(
                path.ends_with("player.html"),
                "route {route} should serve player.html"
            );
        }
    }

    #[test]
    fn marks_private_static_media_and_library_as_auth_required() {
        for route in [
            "/assets/library.json",
            "/assets/LIBRARY.JSON",
            "/assets/%4cIBRARY.JSON",
            "/assets%2FLIBRARY.JSON",
            "/assets/images/poster.jpg",
            "/ASSETS/IMAGES/poster.jpg",
            "/assets/IMAGES/poster.jpg",
            "/assets/%49MAGES/poster.jpg",
            "/assets%2FIMAGES%2Fposter.jpg",
            "/assets//IMAGES/poster.jpg",
            "/assets/./IMAGES/poster.jpg",
            "/assets/%2e/IMAGES/poster.jpg",
            "/assets/videos/movie.mp4",
            "/assets/VIDEOS/movie.mp4",
            "/assets/%56IDEOS/movie.mp4",
            "/assets%2FVIDEOS%2Fmovie.mp4",
            "/assets//VIDEOS/movie.mp4",
            "/assets/./VIDEOS/movie.mp4",
            "/assets/%2e/VIDEOS/movie.mp4",
        ] {
            assert!(
                should_require_auth_for_static_path(route),
                "route {route} must require authentication"
            );
        }
        assert!(!should_require_auth_for_static_path(
            "/assets/icons/streamarena-mark.svg"
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/videos/movie.mp4")
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/library.json")
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/images/poster.jpg")
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/IMAGES/poster.jpg")
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/VIDEOS/movie.mp4")
        ));
        assert!(should_require_auth_for_static_file(
            Path::new("/tmp/app"),
            Path::new("/tmp/app/assets/LIBRARY.JSON")
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
            CACHE_NO_STORE
        );
        assert_eq!(
            cache_control_for_path("/assets/videos/movie.mp4", "video/mp4"),
            CACHE_VIDEO_ASSET
        );
        assert_eq!(
            cache_control_for_path("/assets/%49MAGES/poster.jpg", "image/jpeg"),
            CACHE_NO_STORE
        );
        assert_eq!(
            cache_control_for_path("/assets%2FVIDEOS%2Fmovie.mp4", "video/mp4"),
            CACHE_VIDEO_ASSET
        );
    }
}
