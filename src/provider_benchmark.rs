use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Response};
use axum::response::IntoResponse;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::path::Path;

use crate::auth::AuthUser;
use crate::error::{ApiError, AppResult, json_response};
use crate::persistence::DatabaseFileIdentity;
#[cfg(test)]
use crate::persistence::database_file_identity;

const PROVIDER_BENCHMARK_HEADER: &str = "x-streamarena-provider-benchmark";
const REAL_DEBRID_BENCHMARK_HEADER: &str = "x-streamarena-real-debrid-benchmark";
const REAL_DEBRID_EXACT_REUSE_ACK_HEADER: &str = "x-streamarena-real-debrid-exact-reuse";
const REAL_DEBRID_EXACT_REUSE_ACKNOWLEDGED: &str = "enforced";
const PROVIDER_HEALTH_RECORDING_HEADER: &str = "x-streamarena-provider-health-recording";
const PROVIDER_HEALTH_RECORDING_SUPPRESSED: &str = "suppressed";
const DATABASE_PATH_IDENTITY_DOMAIN: &[u8] = b"streamarena-provider-benchmark-db-file-v2\0";
const REAL_DEBRID_SCOPE_IDENTITY_DOMAIN: &[u8] = b"streamarena-provider-benchmark-rd-scope-v1\0";
const SERVER_INSTANCE_IDENTITY_DOMAIN: &[u8] = b"streamarena-provider-benchmark-instance-v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderBenchmarkAttestations {
    pub real_debrid_playback_session_scope_identity: Option<String>,
    pub resolver_cache_identity: String,
    pub users_db_identity: String,
    pub server_instance_identity: String,
    pub real_debrid_exact_session_reuse: bool,
}

pub(crate) fn provider_benchmark_real_debrid_scope_identity(scope: &str) -> Option<String> {
    let scope = scope.trim();
    if scope.is_empty() {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(REAL_DEBRID_SCOPE_IDENTITY_DOMAIN);
    digest.update(scope.as_bytes());
    Some(URL_SAFE_NO_PAD.encode(digest.finalize()))
}

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

/// A second, admin-only capability bit used by the Real-Debrid benchmark.
/// Unlike the general provider benchmark header, this asks the resolver to
/// serve only the exact already-fresh playback session and to fail closed
/// before revalidation or provider fallback.
pub(crate) fn real_debrid_benchmark_exact_reuse_for_request(
    headers: &HeaderMap,
    user: &AuthUser,
) -> AppResult<bool> {
    let mut values = headers.get_all(REAL_DEBRID_BENCHMARK_HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(false);
    };
    if !user.is_admin {
        return Err(ApiError::forbidden(
            "Real-Debrid benchmark mode requires admin access.",
        ));
    }
    if value.as_bytes() != b"1" || values.next().is_some() {
        return Err(ApiError::bad_request(
            "Real-Debrid benchmark header must be exactly 1.",
        ));
    }
    if record_external_health_events_for_request(headers, user)? {
        return Err(ApiError::bad_request(
            "Real-Debrid benchmark mode requires provider benchmark mode.",
        ));
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) fn provider_benchmark_database_path_identity(
    path: &Path,
    role: &str,
) -> AppResult<String> {
    let identity = database_file_identity(path)?;
    provider_benchmark_database_file_identity(&identity, role)
}

pub(crate) fn provider_benchmark_database_file_identity(
    identity: &DatabaseFileIdentity,
    role: &str,
) -> AppResult<String> {
    let canonical = identity
        .canonical_path()
        .to_str()
        .ok_or_else(|| ApiError::internal("Benchmark database identity unavailable."))?;
    let mut digest = Sha256::new();
    digest.update(DATABASE_PATH_IDENTITY_DOMAIN);
    digest.update(role.as_bytes());
    digest.update(b"\0");
    digest.update(canonical.as_bytes());
    digest.update(b"\0");
    digest.update(identity.device().to_string().as_bytes());
    digest.update(b"\0");
    digest.update(identity.inode().to_string().as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(digest.finalize()))
}

pub(crate) fn provider_benchmark_server_instance_identity(
    started_at_ms: i64,
    resolver_cache_identity: &str,
    users_db_identity: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(SERVER_INSTANCE_IDENTITY_DOMAIN);
    digest.update(started_at_ms.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(std::process::id().to_string().as_bytes());
    digest.update(b"\0");
    digest.update(resolver_cache_identity.as_bytes());
    digest.update(b"\0");
    digest.update(users_db_identity.as_bytes());
    URL_SAFE_NO_PAD.encode(digest.finalize())
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
    attestations: Option<&ProviderBenchmarkAttestations>,
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
    let mut payload = json!({ "available": true });
    if let Some(attestations) = attestations {
        payload["realDebridPlaybackSessionScopeIdentity"] = attestations
            .real_debrid_playback_session_scope_identity
            .as_deref()
            .map(Value::from)
            .unwrap_or(Value::Null);
        payload["databaseIdentities"] = json!({
            "resolverCache": attestations.resolver_cache_identity,
            "users": attestations.users_db_identity,
        });
        payload["serverInstanceIdentity"] =
            Value::String(attestations.server_instance_identity.clone());
        payload["realDebridExactSessionReuse"] =
            Value::Bool(attestations.real_debrid_exact_session_reuse);
    }
    Ok(provider_resolve_response(payload, false))
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
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store, max-age=0"),
        );
        response.headers_mut().insert(
            axum::http::header::PRAGMA,
            HeaderValue::from_static("no-cache"),
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

pub(crate) fn acknowledge_real_debrid_exact_reuse(
    response: &mut Response<Body>,
    exact_reuse: bool,
) {
    if exact_reuse {
        response.headers_mut().insert(
            REAL_DEBRID_EXACT_REUSE_ACK_HEADER,
            HeaderValue::from_static(REAL_DEBRID_EXACT_REUSE_ACKNOWLEDGED),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::http::header::CONTENT_TYPE;
    use std::fs::File;

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

        let forbidden = provider_benchmark_capability_response(&headers, &viewer, None)
            .expect_err("non-admin capability preflight must be forbidden");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let forbidden = provider_benchmark_capability_response(&headers, &viewer, None)
            .expect_err("the benchmark header cannot grant admin capability");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        headers.remove(PROVIDER_BENCHMARK_HEADER);

        let absent = provider_benchmark_capability_response(&headers, &admin, None)
            .expect_err("capability preflight requires the benchmark header");
        assert_eq!(absent.status(), StatusCode::BAD_REQUEST);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("true"));
        let malformed = provider_benchmark_capability_response(&headers, &admin, None)
            .expect_err("capability preflight requires the fixed header value");
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        headers.append(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let duplicate = provider_benchmark_capability_response(&headers, &admin, None)
            .expect_err("capability preflight rejects duplicate headers");
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);

        let mut exact_headers = HeaderMap::new();
        exact_headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let response = provider_benchmark_capability_response(&exact_headers, &admin, None)
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
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("private, no-store, max-age=0")
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
    fn real_debrid_benchmark_exact_reuse_requires_both_exact_admin_headers() {
        let viewer = viewer();
        let admin = admin();
        let mut headers = HeaderMap::new();
        headers.insert(REAL_DEBRID_BENCHMARK_HEADER, HeaderValue::from_static("1"));

        let missing_provider = real_debrid_benchmark_exact_reuse_for_request(&headers, &admin)
            .expect_err("the RD contract must require provider benchmark mode");
        assert_eq!(missing_provider.status(), StatusCode::BAD_REQUEST);

        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let forbidden = real_debrid_benchmark_exact_reuse_for_request(&headers, &viewer)
            .expect_err("the RD contract must remain admin-only");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        assert!(real_debrid_benchmark_exact_reuse_for_request(&headers, &admin).unwrap());

        headers.insert(
            REAL_DEBRID_BENCHMARK_HEADER,
            HeaderValue::from_static("true"),
        );
        let malformed = real_debrid_benchmark_exact_reuse_for_request(&headers, &admin)
            .expect_err("the RD header must use its fixed value");
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn capability_attests_scope_database_paths_and_exact_reuse_opaquely() {
        let root = std::env::temp_dir().join(format!(
            "streamarena-provider-benchmark-{}-{}",
            std::process::id(),
            crate::utils::now_ms()
        ));
        std::fs::create_dir_all(&root).expect("temporary benchmark directory");
        let resolver_path = root.join("resolver-cache.sqlite");
        let users_path = root.join("users.sqlite");
        File::create(&resolver_path).expect("resolver database placeholder");
        File::create(&users_path).expect("users database placeholder");

        let resolver_identity =
            provider_benchmark_database_path_identity(&resolver_path, "resolver-cache")
                .expect("resolver database identity");
        let users_identity = provider_benchmark_database_path_identity(&users_path, "users")
            .expect("users database identity");
        assert_ne!(resolver_identity, users_identity);
        assert_eq!(resolver_identity.len(), 43);
        assert!(!resolver_identity.contains(resolver_path.to_string_lossy().as_ref()));

        let mut headers = HeaderMap::new();
        headers.insert(PROVIDER_BENCHMARK_HEADER, HeaderValue::from_static("1"));
        let scope_identity =
            provider_benchmark_real_debrid_scope_identity("current-scope").expect("scope identity");
        let attestations = ProviderBenchmarkAttestations {
            real_debrid_playback_session_scope_identity: Some(scope_identity.clone()),
            resolver_cache_identity: resolver_identity.clone(),
            users_db_identity: users_identity.clone(),
            server_instance_identity: provider_benchmark_server_instance_identity(
                123,
                &resolver_identity,
                &users_identity,
            ),
            real_debrid_exact_session_reuse: true,
        };
        let response =
            provider_benchmark_capability_response(&headers, &admin(), Some(&attestations))
                .expect("attested capability response");
        let body = axum::body::to_bytes(response.into_body(), 4_096)
            .await
            .expect("attested capability body");
        let payload = serde_json::from_slice::<Value>(&body).expect("capability JSON");
        assert_eq!(
            payload
                .pointer("/realDebridPlaybackSessionScopeIdentity")
                .and_then(Value::as_str),
            Some(scope_identity.as_str())
        );
        assert_eq!(
            payload.pointer("/databaseIdentities/resolverCache"),
            Some(&Value::String(resolver_identity.clone()))
        );
        assert_eq!(
            payload.pointer("/databaseIdentities/users"),
            Some(&Value::String(users_identity))
        );
        assert_eq!(
            payload.get("realDebridExactSessionReuse"),
            Some(&Value::Bool(true))
        );
        assert!(
            payload
                .get("serverInstanceIdentity")
                .and_then(Value::as_str)
                .is_some_and(|value| value.len() == 43)
        );

        let encoded = String::from_utf8(body.to_vec()).expect("UTF-8 capability body");
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));
        assert!(!encoded.contains("current-scope"));

        let replacement_path = root.join("resolver-cache-replacement.sqlite");
        File::create(&replacement_path).expect("replacement database placeholder");
        std::fs::rename(&replacement_path, &resolver_path).expect("replace resolver database");
        let replacement_identity =
            provider_benchmark_database_path_identity(&resolver_path, "resolver-cache")
                .expect("replacement resolver identity");
        assert_ne!(
            resolver_identity, replacement_identity,
            "an atomic replacement at the same path must change the identity"
        );
        std::fs::remove_dir_all(root).expect("remove temporary benchmark directory");
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

    #[test]
    fn exact_reuse_acknowledgement_is_explicit_and_opt_in() {
        let mut ordinary = provider_resolve_response(json!({ "ok": true }), false);
        acknowledge_real_debrid_exact_reuse(&mut ordinary, false);
        assert!(
            !ordinary
                .headers()
                .contains_key(REAL_DEBRID_EXACT_REUSE_ACK_HEADER)
        );

        acknowledge_real_debrid_exact_reuse(&mut ordinary, true);
        assert_eq!(
            ordinary
                .headers()
                .get(REAL_DEBRID_EXACT_REUSE_ACK_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(REAL_DEBRID_EXACT_REUSE_ACKNOWLEDGED)
        );
    }
}
