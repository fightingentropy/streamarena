use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, Response, header};
use axum::middleware::Next;
use url::Url;

use crate::error::ApiError;
use crate::routes::AppState;

fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn normalized_authority(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let port = url.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

fn host_header_authorities(headers: &HeaderMap) -> Vec<String> {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| matches!(*value, "http" | "https"));
    let mut schemes = Vec::new();
    if let Some(scheme) = forwarded_proto {
        schemes.push(scheme);
    }
    schemes.extend(["https", "http"]);
    schemes
        .into_iter()
        .filter_map(|scheme| normalized_authority(&format!("{scheme}://{host}")))
        .collect()
}

/// Validate browser provenance for state-changing requests.
///
/// Native apps and CLI clients may omit browser provenance headers, so absence
/// is allowed. Browsers do send `Origin` and/or Fetch Metadata on cross-site
/// form/fetch mutations: those requests fail closed unless their authority
/// matches either the effective Host or the configured public app origin.
pub(crate) fn browser_mutation_is_trusted(
    method: &Method,
    headers: &HeaderMap,
    app_origin: &str,
) -> bool {
    if is_safe_method(method) {
        return true;
    }
    if headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("cross-site"))
    {
        return false;
    }
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    else {
        return true;
    };
    let Some(authority) = normalized_authority(origin) else {
        return false;
    };
    normalized_authority(app_origin).as_deref() == Some(authority.as_str())
        || host_header_authorities(headers)
            .iter()
            .any(|expected| expected == &authority)
}

pub async fn csrf_guard_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response<Body>, ApiError> {
    if !browser_mutation_is_trusted(
        request.method(),
        request.headers(),
        &state.config.app_origin,
    ) {
        return Err(ApiError::forbidden("Cross-site mutation rejected."));
    }
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::browser_mutation_is_trusted;
    use axum::http::{HeaderMap, HeaderValue, Method, header};

    fn headers(values: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in values {
            headers.insert(*name, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn safe_methods_and_native_clients_remain_allowed() {
        assert!(browser_mutation_is_trusted(
            &Method::GET,
            &headers(&[("sec-fetch-site", "cross-site")]),
            "https://streamarena.xyz",
        ));
        assert!(browser_mutation_is_trusted(
            &Method::POST,
            &HeaderMap::new(),
            "https://streamarena.xyz",
        ));
    }

    #[test]
    fn rejects_cross_site_fetch_metadata_and_null_origins() {
        assert!(!browser_mutation_is_trusted(
            &Method::POST,
            &headers(&[("sec-fetch-site", "cross-site")]),
            "https://streamarena.xyz",
        ));
        assert!(!browser_mutation_is_trusted(
            &Method::DELETE,
            &headers(&[(header::ORIGIN.as_str(), "null")]),
            "https://streamarena.xyz",
        ));
    }

    #[test]
    fn origin_must_match_public_origin_or_effective_host() {
        assert!(browser_mutation_is_trusted(
            &Method::PUT,
            &headers(&[(header::ORIGIN.as_str(), "https://streamarena.xyz")]),
            "https://streamarena.xyz",
        ));
        assert!(browser_mutation_is_trusted(
            &Method::POST,
            &headers(&[
                (header::ORIGIN.as_str(), "http://localhost:4173"),
                (header::HOST.as_str(), "localhost:4173"),
                ("x-forwarded-proto", "http"),
            ]),
            "https://streamarena.xyz",
        ));
        assert!(!browser_mutation_is_trusted(
            &Method::POST,
            &headers(&[
                (header::ORIGIN.as_str(), "https://evil.example"),
                (header::HOST.as_str(), "streamarena.xyz"),
            ]),
            "https://streamarena.xyz",
        ));
    }
}
