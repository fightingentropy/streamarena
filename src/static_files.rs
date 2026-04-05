use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderValue, RANGE,
};
use axum::http::{Method, Response, StatusCode};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

use crate::error::{ApiError, AppResult};
use crate::routes::AppState;

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
        if should_disable_cache(&content_type) {
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
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
    if should_disable_cache(&content_type) {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&file_size.to_string()).unwrap(),
    );
    Ok(response)
}

fn resolve_local_path(frontend_dir: &Path, repo_root: &Path, pathname: &str) -> Option<PathBuf> {
    let decoded = percent_decode(pathname)?;
    if decoded.starts_with("/assets/") {
        let normalized = normalize_path(decoded.trim_start_matches('/'));
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
    let normalized = normalize_path(requested.trim_start_matches('/'));
    let file_path = frontend_dir.join(normalized);
    if file_path.starts_with(frontend_dir) {
        Some(file_path)
    } else {
        None
    }
}

fn normalize_path(path: &str) -> PathBuf {
    let mut output = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) => output.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            _ => {}
        }
    }
    output
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

fn should_disable_cache(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.contains("javascript")
        || content_type.contains("json")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{parse_range, resolve_local_path};

    #[test]
    fn maps_clean_route_to_html() {
        let path = resolve_local_path(Path::new("/tmp/app"), Path::new("/tmp/app"), "/settings")
            .unwrap();
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
    fn parses_open_ended_range() {
        assert_eq!(parse_range("bytes=10-", 100), Some((10, 99)));
    }

    #[test]
    fn parses_large_suffix_range() {
        assert_eq!(parse_range("bytes=-999", 100), Some((0, 99)));
    }
}
