use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Response};
use axum::response::IntoResponse;
use serde_json::{Value, json};

use crate::auth::AuthUser;
use crate::error::{ApiError, AppResult, json_response};

const PROVIDER_BENCHMARK_HEADER: &str = "x-streamarena-provider-benchmark";
const PROVIDER_HEALTH_RECORDING_HEADER: &str = "x-streamarena-provider-health-recording";
const PROVIDER_HEALTH_RECORDING_SUPPRESSED: &str = "suppressed";

/// Provider benchmarks exercise the real resolver but must not train the live
/// provider-health model. The opt-out is deliberately an authenticated admin
/// capability: ordinary clients cannot suppress production health signals.
pub(crate) fn record_external_health_events_for_request(
    headers: &HeaderMap,
    user: &AuthUser,
) -> AppResult<bool> {
    let mut values = headers.get_all(PROVIDER_BENCHMARK_HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(true);
    };
    if !user.is_admin {
        return Err(ApiError::forbidden(
            "Provider benchmark mode requires admin access.",
        ));
    }
    if value.as_bytes() != b"1" || values.next().is_some() {
        return Err(ApiError::bad_request(
            "Provider benchmark header must be exactly 1.",
        ));
    }
    Ok(false)
}

pub(crate) fn provider_benchmark_capability_method_supported(method: &Method) -> bool {
    method == Method::GET
}

/// Proves that the authenticated admin benchmark header reached this backend
/// before a benchmark makes any resolver request. This response does not
/// inspect providers or touch their health state.
pub(crate) fn provider_benchmark_capability_response(
    headers: &HeaderMap,
    user: &AuthUser,
) -> AppResult<Response<Body>> {
    if !user.is_admin {
        return Err(ApiError::forbidden(
            "Provider benchmark capability requires admin access.",
        ));
    }
    if record_external_health_events_for_request(headers, user)? {
        return Err(ApiError::bad_request(
            "Provider benchmark header must be exactly 1.",
        ));
    }
    Ok(provider_resolve_response(
        json!({ "available": true }),
        false,
    ))
}

pub(crate) fn provider_resolve_response(
    payload: Value,
    record_external_health_events: bool,
) -> Response<Body> {
    let mut response = json_response(payload);
    acknowledge_provider_health_suppression(&mut response, record_external_health_events);
    response
}

fn acknowledge_provider_health_suppression(
    response: &mut Response<Body>,
    record_external_health_events: bool,
) {
    if !record_external_health_events {
        response.headers_mut().insert(
            PROVIDER_HEALTH_RECORDING_HEADER,
            HeaderValue::from_static(PROVIDER_HEALTH_RECORDING_SUPPRESSED),
        );
    }
}

pub(crate) fn provider_resolve_result(
    result: AppResult<Value>,
    record_external_health_events: bool,
) -> AppResult<Response<Body>> {
    match result {
        Ok(payload) => Ok(provider_resolve_response(
            payload,
            record_external_health_events,
        )),
        Err(error) if record_external_health_events => Err(error),
        Err(error) => {
            let mut response = error.into_response();
            acknowledge_provider_health_suppression(&mut response, false);
            Ok(response)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::http::header::CONTENT_TYPE;

    fn viewer() -> AuthUser {
        AuthUser {
            id: 1,
            email: String::new(),
            display_name: String::new(),
            is_admin: false,
        }
    }

    fn admin() -> AuthUser {
        AuthUser {
            is_admin: true,
            ..viewer()
        }
    }

    #[test]
    fn provider_benchmark_health_suppression_is_admin_only_and_explicit() {
        let viewer = viewer();
        let admin = admin();
        let mut headers = HeaderMap::new();

        assert!(record_external_health_events_for_request(&headers, &viewer).unwrap());
        assert!(record_external_health_events_for_request(&headers, &admin).unwrap());

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let forbidden = record_external_health_events_for_request(&headers, &viewer)
            .expect_err("non-admin benchmark header must be forbidden");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        assert!(!record_external_health_events_for_request(&headers, &admin).unwrap());

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("true"));
        let malformed = record_external_health_events_for_request(&headers, &admin)
            .expect_err("benchmark header must use its fixed value");
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        headers.append(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let duplicate = record_external_health_events_for_request(&headers, &admin)
            .expect_err("duplicate benchmark headers must be rejected");
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn provider_benchmark_capability_requires_get() {
        assert!(provider_benchmark_capability_method_supported(&Method::GET));
        assert!(!provider_benchmark_capability_method_supported(
            &Method::HEAD
        ));
        assert!(!provider_benchmark_capability_method_supported(
            &Method::POST
        ));
    }

    #[tokio::test]
    async fn provider_benchmark_capability_is_admin_only_and_requires_exact_header() {
        let viewer = viewer();
        let admin = admin();
        let mut headers = HeaderMap::new();

        let forbidden = provider_benchmark_capability_response(&headers, &viewer)
            .expect_err("non-admin capability preflight must be forbidden");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let forbidden = provider_benchmark_capability_response(&headers, &viewer)
            .expect_err("the benchmark header cannot grant admin capability");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        headers.remove(PROVIDER_BENCHMARK_HEADER);

        let absent = provider_benchmark_capability_response(&headers, &admin)
            .expect_err("capability preflight requires the benchmark header");
        assert_eq!(absent.status(), StatusCode::BAD_REQUEST);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("true"));
        let malformed = provider_benchmark_capability_response(&headers, &admin)
            .expect_err("capability preflight requires the fixed header value");
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        headers.append(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let duplicate = provider_benchmark_capability_response(&headers, &admin)
            .expect_err("capability preflight rejects duplicate headers");
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);

        let mut exact_headers = HeaderMap::new();
        exact_headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let response = provider_benchmark_capability_response(&exact_headers, &admin)
            .expect("admin capability preflight must succeed");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(PROVIDER_HEALTH_RECORDING_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(PROVIDER_HEALTH_RECORDING_SUPPRESSED)
        );
        assert_eq!(
            response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        let body = axum::body::to_bytes(response.into_body(), 1_024)
            .await
            .expect("capability response body");
        assert_eq!(
            serde_json::from_slice::<Value>(&body).expect("JSON capability response"),
            json!({ "available": true })
        );
    }

    #[test]
    fn provider_resolve_response_acknowledges_only_suppressed_health_recording() {
        let normal = provider_resolve_response(json!({ "ok": true }), true);
        assert!(
            !normal
                .headers()
                .contains_key(PROVIDER_HEALTH_RECORDING_HEADER)
        );

        let benchmark = provider_resolve_response(json!({ "ok": true }), false);
        assert_eq!(
            benchmark
                .headers()
                .get(PROVIDER_HEALTH_RECORDING_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(PROVIDER_HEALTH_RECORDING_SUPPRESSED)
        );

        let suppressed_error =
            provider_resolve_result(Err(ApiError::bad_gateway("provider unavailable")), false)
                .expect("suppressed resolve errors become acknowledged responses");
        assert_eq!(suppressed_error.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            suppressed_error
                .headers()
                .get(PROVIDER_HEALTH_RECORDING_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(PROVIDER_HEALTH_RECORDING_SUPPRESSED)
        );

        let normal_error =
            provider_resolve_result(Err(ApiError::bad_gateway("provider unavailable")), true);
        assert!(normal_error.is_err());
    }
}
