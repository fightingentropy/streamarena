use axum::body::Body;
use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{HeaderMap, Method, Response, StatusCode, Uri};
use serde_json::{Value, json};

use crate::auth;
use crate::error::{ApiError, AppResult, json_response};
use crate::health::HealthInputs;
use crate::utils::now_ms;

use super::{AppState, parse_json_body};

fn admin_query_param(uri: &Uri, key: &str) -> Option<String> {
    let query = uri.query()?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn admin_query_i64(uri: &Uri, key: &str, fallback: i64) -> i64 {
    admin_query_param(uri, key)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(fallback)
}

pub(super) async fn admin_overview_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let overview = state.db.admin_overview().await?;
    let value =
        serde_json::to_value(overview).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(value))
}

pub(super) async fn admin_growth_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let days = admin_query_i64(&uri, "days", 30);
    let rows = state.db.admin_growth(days).await?;
    let value =
        serde_json::to_value(rows).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "days": value })))
}

pub(super) async fn admin_users_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let search = admin_query_param(&uri, "search").unwrap_or_default();
    let limit = admin_query_i64(&uri, "limit", 200);
    let offset = admin_query_i64(&uri, "offset", 0);
    let rows = state.db.admin_users(search, limit, offset).await?;
    let value =
        serde_json::to_value(rows).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "users": value })))
}

pub(super) async fn admin_user_detail_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let user_id = admin_query_i64(&uri, "id", 0);
    if user_id <= 0 {
        return Err(ApiError::bad_request(
            "A numeric id query parameter is required.",
        ));
    }
    let detail = state
        .db
        .admin_user_detail(user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("User not found."))?;
    let value =
        serde_json::to_value(detail).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(value))
}

pub(super) async fn admin_activity_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let limit = admin_query_i64(&uri, "limit", 50);
    let rows = state.db.admin_activity(limit).await?;
    let value =
        serde_json::to_value(rows).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "events": value })))
}

pub(super) async fn admin_live_top_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let days = admin_query_i64(&uri, "days", 7);
    let rows = state.db.admin_top_live_streams(days, 12).await?;
    let value =
        serde_json::to_value(rows).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "streams": value })))
}

pub(super) async fn admin_feedback_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let limit = admin_query_i64(&uri, "limit", 100);
    let rows = state.db.admin_feedback(limit).await?;
    let value =
        serde_json::to_value(rows).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "feedback": value })))
}

/// Serve the image attached to a feedback row (admin-only). Streams the stored
/// bytes with their original content type.
pub(super) async fn admin_feedback_image_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let (bytes, mime) = state
        .db
        .feedback_image(id)
        .await?
        .ok_or_else(|| ApiError::not_found("No image attached to that feedback."))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime)
        .header(axum::http::header::CACHE_CONTROL, "private, max-age=300")
        .body(Body::from(bytes))
        .map_err(|_| ApiError::internal("Failed to build image response."))
}

/// Delete a feedback message (admin-only). A missing id is a 404 so the UI can
/// tell "already removed" apart from a successful delete.
pub(super) async fn admin_delete_feedback_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> AppResult<Response<Body>> {
    if method != Method::DELETE {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use DELETE.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let changed = state.db.admin_delete_feedback(id).await?;
    if changed == 0 {
        return Err(ApiError::not_found("Feedback not found."));
    }
    Ok(json_response(json!({ "ok": true })))
}

pub(super) async fn admin_reset_password_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let user_id = payload
        .get("userId")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::bad_request("userId is required."))?;
    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if password.chars().count() < 6 {
        return Err(ApiError::bad_request(
            "Password must be at least 6 characters.",
        ));
    }
    let hash = auth::hash_password_async(password.to_string())
        .await
        .map_err(ApiError::internal)?;
    let changed = state.db.admin_set_password(user_id, hash).await?;
    if changed == 0 {
        return Err(ApiError::not_found("User not found."));
    }
    Ok(json_response(json!({ "ok": true })))
}

pub(super) async fn admin_set_disabled_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let admin = auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let user_id = payload
        .get("userId")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::bad_request("userId is required."))?;
    let disabled = payload
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if disabled && user_id == admin.id {
        return Err(ApiError::bad_request(
            "You cannot disable your own account.",
        ));
    }
    let changed = state.db.admin_set_disabled(user_id, disabled).await?;
    if changed == 0 {
        return Err(ApiError::not_found("User not found."));
    }
    Ok(json_response(json!({ "ok": true, "disabled": disabled })))
}

pub(super) async fn admin_set_admin_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let admin = auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let user_id = payload
        .get("userId")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::bad_request("userId is required."))?;
    let make_admin = payload
        .get("isAdmin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !make_admin && user_id == admin.id {
        return Err(ApiError::bad_request(
            "You cannot remove your own admin access.",
        ));
    }
    let changed = state.db.admin_set_admin(user_id, make_admin).await?;
    if changed == 0 {
        return Err(ApiError::not_found("User not found."));
    }
    Ok(json_response(json!({ "ok": true, "isAdmin": make_admin })))
}

pub(super) async fn admin_delete_user_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let admin = auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let user_id = payload
        .get("userId")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::bad_request("userId is required."))?;
    if user_id == admin.id {
        return Err(ApiError::bad_request("You cannot delete your own account."));
    }
    let changed = state.db.admin_delete_user(user_id).await?;
    if changed == 0 {
        return Err(ApiError::not_found("User not found."));
    }
    Ok(json_response(json!({ "ok": true })))
}

/// Everything one health snapshot needs, shared by the live `/api/admin/health`
/// endpoint and the background sampler that persists it.
struct HealthGather {
    uptime_seconds: i64,
    host: crate::health::HostMetrics,
    http: crate::health::HttpCounters,
    req_5xx_rate: f64,
    playback_failure_rate: f64,
    playback_window_total: i64,
    source_success_total: i64,
    source_failure_total: i64,
    restarts_last_1h: i64,
    minutes_since_last_restart: Option<i64>,
    worst_provider_consecutive_failures: i64,
    provider_summary: Value,
    streaming_stats: Value,
    resolver_stats: Value,
    status: crate::health::Status,
    checks: Vec<crate::health::Check>,
}

/// Assemble a health snapshot: live host/request/provider signals plus rates
/// derived as deltas against the recent sample history, rolled into a status.
async fn gather_health(state: &AppState) -> AppResult<HealthGather> {
    let now = now_ms();
    let uptime_seconds = ((now - state.started_at_ms) / 1000).max(0);

    let host = state
        .host_probe
        .snapshot(&state.config.persistent_cache_db_path);
    let http = state.http_metrics.snapshot();

    // Rates are computed over the last ~10 minutes of samples. The in-memory
    // counters reset to zero on restart, so a current value below the baseline
    // means we restarted within the window — count from zero in that case.
    let recent = state.db.recent_health_samples(now - 10 * 60 * 1000).await?;
    let baseline = recent.first();
    let delta = |current: i64, base: i64| -> i64 {
        if current >= base {
            current - base
        } else {
            current
        }
    };
    let (http_window_total, http_window_5xx, live_proxy_window_5xx) = match baseline {
        Some(b) => (
            delta(http.reqTotal as i64, b.reqTotal),
            delta(http.req5xx as i64, b.req5xx),
            delta(http.liveProxy5xx as i64, b.liveProxy5xx),
        ),
        None => (
            http.reqTotal as i64,
            http.req5xx as i64,
            http.liveProxy5xx as i64,
        ),
    };

    let (source_success_total, source_failure_total) = state.db.source_health_totals().await?;
    let (pb_success_window, pb_failure_window) = match baseline {
        Some(b) => (
            delta(source_success_total, b.playbackSuccessTotal),
            delta(source_failure_total, b.playbackFailureTotal),
        ),
        None => (source_success_total, source_failure_total),
    };
    let playback_window_total = pb_success_window + pb_failure_window;

    let starts = state.db.service_starts_since(now - 60 * 60 * 1000).await?;
    let restarts_last_1h = starts.len() as i64;
    let minutes_since_last_restart = starts
        .first()
        .map(|s| ((now - s.startedAt) / 60_000).max(0));

    let provider_summary = state.sports_provider_health.summary(true);
    let worst_provider_consecutive_failures = provider_summary
        .get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers
                .iter()
                .filter_map(|p| p.get("consecutiveFailures").and_then(Value::as_i64))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);

    let streaming_stats =
        serde_json::to_value(state.streaming.stats()).unwrap_or_else(|_| json!({}));
    let resolver_stats = serde_json::to_value(state.resolver.stats()).unwrap_or_else(|_| json!({}));

    let req_5xx_rate = if http_window_total > 0 {
        http_window_5xx as f64 / http_window_total as f64 * 100.0
    } else {
        0.0
    };
    let playback_failure_rate = if playback_window_total > 0 {
        pb_failure_window as f64 / playback_window_total as f64 * 100.0
    } else {
        0.0
    };

    let inputs = HealthInputs {
        restarts_last_1h,
        minutes_since_last_restart,
        fd_count: host.fdCount,
        fd_limit: host.fdLimit,
        mem_used: host.memUsed,
        mem_total: host.memTotal,
        disk_free: host.diskFree,
        disk_total: host.diskTotal,
        load1: host.load1,
        num_cpus: host.numCpus,
        http_window_total,
        http_window_5xx,
        live_proxy_window_5xx,
        worst_provider_consecutive_failures,
        playback_window_total,
        playback_window_failures: pb_failure_window,
    };
    let (status, checks) = crate::health::compute_status(&inputs);

    Ok(HealthGather {
        uptime_seconds,
        host,
        http,
        req_5xx_rate,
        playback_failure_rate,
        playback_window_total,
        source_success_total,
        source_failure_total,
        restarts_last_1h,
        minutes_since_last_restart,
        worst_provider_consecutive_failures,
        provider_summary,
        streaming_stats,
        resolver_stats,
        status,
        checks,
    })
}

/// Take one health snapshot and persist it. Best-effort: the background sampler
/// calls this on a timer, and a failed sample should never take the loop down.
pub async fn record_health_sample(state: &AppState) {
    let report = match gather_health(state).await {
        Ok(report) => report,
        Err(error) => {
            tracing::warn!("health sampler: gather failed: {error:?}");
            return;
        }
    };
    let sample = crate::persistence::HealthSampleRow {
        ts: now_ms(),
        uptimeSeconds: report.uptime_seconds,
        status: report.status.as_i64(),
        fdCount: report.host.fdCount,
        fdLimit: report.host.fdLimit,
        memUsed: report.host.memUsed,
        memTotal: report.host.memTotal,
        load1: report.host.load1,
        numCpus: report.host.numCpus,
        diskFree: report.host.diskFree,
        diskTotal: report.host.diskTotal,
        reqTotal: report.http.reqTotal as i64,
        req4xx: report.http.req4xx as i64,
        req5xx: report.http.req5xx as i64,
        liveProxy5xx: report.http.liveProxy5xx as i64,
        req5xxRate: report.req_5xx_rate,
        playbackSuccessTotal: report.source_success_total,
        playbackFailureTotal: report.source_failure_total,
        playbackFailureRate: report.playback_failure_rate,
        worstProviderConsecutiveFailures: report.worst_provider_consecutive_failures,
    };
    if let Err(error) = state.db.insert_health_sample(sample).await {
        tracing::warn!("health sampler: insert failed: {error:?}");
    }
}

pub(super) async fn admin_health_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let report = gather_health(&state).await?;
    Ok(json_response(json!({
        "status": report.status,
        "checks": report.checks,
        "uptimeSeconds": report.uptime_seconds,
        "host": report.host,
        "http": {
            "counters": report.http,
            "req5xxRate": report.req_5xx_rate,
        },
        "playback": {
            "successTotal": report.source_success_total,
            "failureTotal": report.source_failure_total,
            "failureRate": report.playback_failure_rate,
            "windowTotal": report.playback_window_total,
        },
        "restarts": {
            "lastHour": report.restarts_last_1h,
            "minutesSinceLast": report.minutes_since_last_restart,
        },
        "providers": report.provider_summary,
        "streaming": report.streaming_stats,
        "resolver": report.resolver_stats,
        "sampledAt": now_ms(),
    })))
}

pub(super) async fn admin_health_history_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let hours = admin_query_i64(&uri, "hours", 24).clamp(1, 48);
    let since = now_ms() - hours * 60 * 60 * 1000;
    let samples = state.db.recent_health_samples(since).await?;
    let value =
        serde_json::to_value(samples).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "hours": hours, "samples": value })))
}

/// Provider catalog for the admin Providers dashboard: every backend-resolved
/// source (sports APIs, embed providers, infra origins) with its compiled default
/// and current effective value, plus the live-channel override map the frontend
/// merges over its compiled channel list.
pub(super) async fn admin_providers_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let providers = crate::provider_registry::catalog(&state.config);
    let providers_value =
        serde_json::to_value(providers).map_err(|error| ApiError::internal(error.to_string()))?;
    let live_overrides: std::collections::BTreeMap<String, String> =
        crate::provider_registry::live_overrides()
            .into_iter()
            .collect();
    let live_value = serde_json::to_value(live_overrides)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({
        "providers": providers_value,
        "liveOverrides": live_value,
    })))
}

/// Set or clear a single provider override. URL providers take an http(s) URL (an
/// empty value resets to the default); embed providers take a "0"/"1" enable flag.
pub(super) async fn admin_provider_set_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if key.is_empty() {
        return Err(ApiError::bad_request("key is required."));
    }
    let kind = crate::provider_registry::classify_writable(&key)
        .ok_or_else(|| ApiError::bad_request("That provider can't be edited."))?;
    let raw_value = payload
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    // Normalise to the stored value. Empty string means "clear the override".
    let value = match kind {
        crate::provider_registry::WriteKind::Url => {
            if raw_value.is_empty() {
                String::new()
            } else {
                let parsed = url::Url::parse(&raw_value)
                    .map_err(|_| ApiError::bad_request("Enter a valid URL."))?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err(ApiError::bad_request(
                        "URL must start with http:// or https://.",
                    ));
                }
                raw_value
            }
        }
        // Enabled is the default, so re-enabling just clears the override row.
        crate::provider_registry::WriteKind::Toggle => match raw_value.as_str() {
            "0" => "0".to_owned(),
            "1" | "" => String::new(),
            _ => return Err(ApiError::bad_request("Toggle value must be 0 or 1.")),
        },
        // A ranking weight: a whole number in a sane range. Empty clears it back to
        // the compiled default tier.
        crate::provider_registry::WriteKind::Rank => {
            if raw_value.is_empty() {
                String::new()
            } else {
                let weight: i64 = raw_value
                    .parse()
                    .map_err(|_| ApiError::bad_request("Rank weight must be a whole number."))?;
                if !(0..=10_000).contains(&weight) {
                    return Err(ApiError::bad_request(
                        "Rank weight must be between 0 and 10000.",
                    ));
                }
                weight.to_string()
            }
        }
    };
    if value.is_empty() {
        state.db.delete_provider_override(key.clone()).await?;
    } else {
        state
            .db
            .set_provider_override(key.clone(), value.clone())
            .await?;
    }
    crate::provider_registry::set(&key, &value);
    Ok(json_response(
        json!({ "ok": true, "key": key, "value": value }),
    ))
}

/// Reachability probe for a provider URL. Admin-only. Uses a browser-ish UA and a
/// short timeout — many stream hosts 403 a bare client or geo-gate, so a non-2xx
/// here is a hint, not proof the stream is dead in-app.
pub(super) async fn admin_provider_test_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let valid = url::Url::parse(&url)
        .ok()
        .is_some_and(|parsed| matches!(parsed.scheme(), "http" | "https"));
    if !valid {
        return Err(ApiError::bad_request("Enter a valid http(s) URL to test."));
    }
    let started = std::time::Instant::now();
    let outcome = state
        .http_client
        .get(&url)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis() as i64;
    let body = match outcome {
        Ok(response) => {
            let status = response.status();
            json!({
                "ok": status.is_success() || status.is_redirection(),
                "status": status.as_u16(),
                "latencyMs": latency_ms,
                "error": Value::Null,
            })
        }
        Err(error) => {
            let reason = if error.is_timeout() {
                "Timed out".to_owned()
            } else if error.is_connect() {
                "Connection failed".to_owned()
            } else {
                error.to_string()
            };
            json!({ "ok": false, "status": 0, "latencyMs": latency_ms, "error": reason })
        }
    };
    Ok(json_response(body))
}

/// Normalize a pasted addon URL to its base: drop a trailing `/manifest.json` or
/// `/configure` and any trailing slash, and require an https origin (the resolve +
/// playback paths are https-only). Returns None for anything that isn't a usable
/// https base.
pub(super) fn normalize_custom_addon_base(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let base = trimmed
        .strip_suffix("/manifest.json")
        .or_else(|| trimmed.strip_suffix("/configure"))
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    let parsed = url::Url::parse(base).ok()?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return None;
    }
    Some(base.to_owned())
}

/// Lowercase kebab-case slug from arbitrary text (for deriving a stable provider id).
pub(super) fn provider_slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true; // trims leading dashes
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

/// Whether a Stremio manifest is a stream addon for movies/series — the only kind
/// we can resolve generically. Handles `resources` as plain strings or objects.
pub(super) fn manifest_is_stream_addon(manifest: &Value) -> bool {
    let resources = manifest.get("resources").and_then(Value::as_array);
    let has_stream = resources.is_some_and(|items| {
        items.iter().any(|item| {
            item.as_str() == Some("stream")
                || item.get("name").and_then(Value::as_str) == Some("stream")
        })
    });
    let types = manifest.get("types").and_then(Value::as_array);
    let has_vod_type = types.is_some_and(|items| {
        items
            .iter()
            .any(|item| matches!(item.as_str(), Some("movie") | Some("series")))
    });
    has_stream && has_vod_type
}

/// Add a custom Stremio stream-addon provider from a pasted manifest/install URL.
/// Validates the manifest is a movie/series stream addon, derives a stable unique
/// id, and registers it so it resolves like NoTorrent/Nebula and shows up in the
/// Providers dashboard. Admin-only.
pub(super) async fn admin_provider_add_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let raw_url = payload
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if raw_url.is_empty() {
        return Err(ApiError::bad_request(
            "A manifest or addon URL is required.",
        ));
    }
    let base = normalize_custom_addon_base(&raw_url)
        .ok_or_else(|| ApiError::bad_request("Enter a valid https addon URL."))?;

    // Fetch + validate the manifest so we only register addons we can actually use.
    let manifest_url = format!("{base}/manifest.json");
    let response = state
        .http_client
        .get(&manifest_url)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| ApiError::bad_request("Couldn't reach that addon's manifest."))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_request(format!(
            "Addon manifest returned HTTP {}.",
            response.status().as_u16()
        )));
    }
    let manifest: Value = response
        .json()
        .await
        .map_err(|_| ApiError::bad_request("That URL didn't return a valid Stremio manifest."))?;
    if !manifest_is_stream_addon(&manifest) {
        return Err(ApiError::bad_request(
            "Not a supported addon: needs a `stream` resource for `movie`/`series`. Catalog-only or sports addons aren't supported.",
        ));
    }

    // Label: admin-provided, else the manifest name, else the host.
    let manifest_name = manifest.get("name").and_then(Value::as_str).unwrap_or("");
    let label = payload
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let label = if !label.is_empty() {
        label.to_owned()
    } else if !manifest_name.trim().is_empty() {
        manifest_name.trim().to_owned()
    } else {
        url::Url::parse(&base)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| "Custom provider".to_owned())
    };

    // Stable id: custom-<slug-of-name>, deduped against compiled + existing custom.
    let slug_seed = if !manifest_name.trim().is_empty() {
        provider_slugify(manifest_name)
    } else {
        provider_slugify(&label)
    };
    let slug_seed = if slug_seed.is_empty() {
        "addon".to_owned()
    } else {
        slug_seed
    };
    let taken = |candidate: &str| -> bool {
        crate::provider_registry::EMBED_IDS.contains(&candidate)
            || crate::provider_registry::is_custom(candidate)
    };
    let mut id = format!("custom-{slug_seed}");
    let mut suffix = 2;
    while taken(&id) {
        id = format!("custom-{slug_seed}-{suffix}");
        suffix += 1;
    }

    state
        .db
        .add_custom_provider(id.clone(), label.clone(), base.clone())
        .await?;
    crate::provider_registry::add_custom(crate::provider_registry::CustomProvider {
        id: id.clone(),
        label: label.clone(),
        base_url: base.clone(),
    });

    Ok(json_response(
        json!({ "ok": true, "id": id, "label": label, "base": base }),
    ))
}

/// Remove an admin-added custom provider and clear its enable/rank overrides.
/// Admin-only; refuses to touch compiled providers.
pub(super) async fn admin_provider_remove_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if id.is_empty() {
        return Err(ApiError::bad_request("id is required."));
    }
    if !crate::provider_registry::is_custom(&id) {
        return Err(ApiError::bad_request(
            "Only custom (dashboard-added) providers can be removed.",
        ));
    }
    state.db.delete_custom_provider(id.clone()).await?;
    crate::provider_registry::remove_custom(&id);
    // Drop the provider's enable/rank override rows so a re-add starts clean.
    for suffix in ["enabled", "rank"] {
        let key = format!("embed:{id}:{suffix}");
        state.db.delete_provider_override(key.clone()).await?;
        crate::provider_registry::set(&key, "");
    }
    Ok(json_response(json!({ "ok": true, "id": id })))
}
