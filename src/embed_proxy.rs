use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Response, Uri};
use url::Url;
use url::form_urlencoded::byte_serialize;

use crate::error::{ApiError, AppResult};
use crate::routes::AppState;

const EMBED_PROXY_ALLOWED_HOSTS: &[&str] = &[
    "vidlink.pro",
    "vidfast.me",
    "vidfast.pro",
    "player.videasy.net",
];

pub async fn embed_frame_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }

    let target_url = parse_embed_frame_target(uri.query().unwrap_or_default())?;
    let mut request = state
        .http_client
        .get(target_url.clone())
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        )
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
    if let Some(origin) = embed_origin(&target_url) {
        request = request.header(reqwest::header::REFERER, origin);
    }

    let response = request
        .send()
        .await
        .map_err(|_| ApiError::bad_gateway("Embed proxy fetch failed."))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Embed provider returned HTTP {}.",
            response.status()
        )));
    }

    let final_url = response.url().clone();
    if !is_allowed_embed_proxy_url(&final_url) {
        return Err(ApiError::bad_gateway(
            "Embed provider redirected to an unsupported host.",
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|_| ApiError::bad_gateway("Embed proxy read failed."))?;
    let prepared = prepare_embed_html(&html, &final_url);

    Response::builder()
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Body::from(prepared))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn query_pairs(query: &str) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn parse_embed_frame_target(query: &str) -> AppResult<Url> {
    let params = query_pairs(query);
    let raw_url = params
        .get("url")
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    if raw_url.is_empty() {
        return Err(ApiError::bad_request("Missing embed url query parameter."));
    }

    let target_url =
        Url::parse(raw_url).map_err(|_| ApiError::bad_request("Invalid embed URL."))?;
    if target_url.scheme() != "https" && target_url.scheme() != "http" {
        return Err(ApiError::bad_request("Invalid embed URL scheme."));
    }
    if !is_allowed_embed_proxy_url(&target_url) {
        return Err(ApiError::bad_request("Unsupported embed provider host."));
    }
    Ok(target_url)
}

pub fn is_allowed_embed_proxy_url(url: &Url) -> bool {
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    EMBED_PROXY_ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn embed_origin(url: &Url) -> Option<String> {
    let mut origin = url.clone();
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    origin.to_string().into()
}

fn prepare_embed_html(html: &str, base_url: &Url) -> String {
    let base_href = base_url.as_str();
    let lower = html.to_ascii_lowercase();
    if lower.contains("<base") {
        return html.to_owned();
    }
    if let Some(index) = lower.find("<head>") {
        let insert_at = index + "<head>".len();
        let mut prepared = html.to_owned();
        prepared.insert_str(insert_at, &format!("<base href=\"{base_href}\">"));
        return prepared;
    }
    format!("<base href=\"{base_href}\">{html}")
}

pub fn encode_query_value(value: &str) -> String {
    byte_serialize(value.as_bytes()).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_known_embed_hosts() {
        let vidlink = Url::parse("https://vidlink.pro/movie/278").expect("url");
        assert!(is_allowed_embed_proxy_url(&vidlink));

        let vidfast = Url::parse("https://vidfast.pro/movie/278").expect("url");
        assert!(is_allowed_embed_proxy_url(&vidfast));
    }

    #[test]
    fn rejects_unknown_embed_hosts() {
        let url = Url::parse("https://example.com/embed/movie/278").expect("url");
        assert!(!is_allowed_embed_proxy_url(&url));
    }

    #[test]
    fn injects_base_tag_when_missing() {
        let base = Url::parse("https://vidlink.pro/movie/278").expect("url");
        let prepared = prepare_embed_html("<html><head></head><body></body></html>", &base);
        assert!(prepared.contains("<base href=\"https://vidlink.pro/movie/278\">"));
    }
}
