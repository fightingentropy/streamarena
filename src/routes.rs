use std::collections::BTreeMap;
use std::path::Path;

use axum::RequestExt;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, Response, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::routing::{any, get};
use serde_json::{Value, json};
use url::Url;

use axum::http::HeaderMap;

use crate::auth;
use crate::config::{self, Config};
use crate::error::{ApiError, AppResult, json_response};
use crate::football::{
    SportsProviderHealth, SportsScheduleCache, SportsStreamResolveCache,
    american_football_matches_handler, baseball_matches_handler, basketball_matches_handler,
    basketball_stream_resolve_handler, cricket_matches_handler, football_matches_handler,
    football_stream_resolve_handler, hockey_matches_handler,
    streamed_sports_stream_resolve_handler, tennis_matches_handler,
};
use crate::health::HealthInputs;
use crate::home_bootstrap;
use crate::library::{
    normalize_upload_content_type, normalize_upload_episode_ordinal, normalize_whitespace,
    normalize_year, read_local_library, strip_file_extension, title_from_filename_token,
    write_local_library,
};
use crate::live::{live_hls_handler, live_hls_resource_handler};
use crate::local_torrent::LocalTorrentService;
use crate::media::{
    MediaProbe, MediaService, choose_audio_track_from_probe, choose_subtitle_track_from_probe,
    merge_preferred_subtitle_tracks,
};
use crate::persistence::{Db, TitlePreference, build_cache_debug_payload};
use crate::process::{
    RuntimeServices, resolve_effective_remux_hwaccel_mode, to_absolute_playback_url,
};
use crate::resolver::{LocalCacheUpgradeRequest, ResolverService};
use crate::secret_store::{REAL_DEBRID_TOKEN_PREF_KEY, RealDebridTokenCipher};
use crate::static_files::serve_static;
use crate::streaming::StreamingService;
use crate::tmdb::TmdbService;
use crate::twitch::twitch_stream_resolve_handler;
use crate::upload::UPLOAD_SESSION_CHUNK_MAX_BYTES;
use crate::upload::UploadService;
use crate::utils::now_ms;
use crate::utils::{
    normalize_preferred_audio_lang, normalize_preferred_stream_quality,
    normalize_session_health_state, normalize_subtitle_preference,
};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub real_debrid_token_cipher: RealDebridTokenCipher,
    pub tmdb: TmdbService,
    pub media: MediaService,
    pub http_client: reqwest::Client,
    pub local_torrent: LocalTorrentService,
    pub resolver: ResolverService,
    pub streaming: StreamingService,
    pub upload: UploadService,
    pub runtime: RuntimeServices,
    pub sports_schedule_cache: SportsScheduleCache,
    pub sports_stream_resolve_cache: SportsStreamResolveCache,
    pub sports_provider_health: SportsProviderHealth,
    pub home_bootstrap_cache: home_bootstrap::HomeBootstrapCache,
    pub live_audio_transcode_cache: crate::live::LiveAudioTranscodeCache,
    pub live_hls_playlist_cache: crate::live::LiveHlsPlaylistCache,
    pub auth_rate_limiter: std::sync::Arc<crate::rate_limit::RateLimiter>,
    /// Generous global anti-abuse backstop for signups. Per-IP limiting (via
    /// `auth_rate_limiter`) protects against single-source floods; this caps the
    /// aggregate so a distributed botnet can't create unlimited accounts. Set
    /// high enough never to throttle an organic signup surge.
    pub signup_global_rate_limiter: std::sync::Arc<crate::rate_limit::RateLimiter>,
    pub sports_stream_rate_limiter: std::sync::Arc<crate::rate_limit::RateLimiter>,
    pub started_at_ms: i64,
    pub http_metrics: std::sync::Arc<crate::health::HttpMetrics>,
    pub host_probe: std::sync::Arc<crate::health::HostProbe>,
}

const JSON_BODY_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const LOCAL_TORRENT_ENABLED_PREF_KEY: &str = "streamarena-local-torrent-enabled";
const USER_PREF_MAX_ENTRIES: usize = 200;
const USER_PREF_KEY_MAX_BYTES: usize = 128;
const USER_PREF_VALUE_MAX_BYTES: usize = 2_000_000;
const USER_SYNC_MAX_ENTRIES: usize = 500;
const USER_IDENTITY_MAX_BYTES: usize = 512;
const USER_URL_MAX_BYTES: usize = 4_096;
const USER_SMALL_TEXT_MAX_BYTES: usize = 256;
const MAX_RESUME_SECONDS: f64 = 31_536_000.0;
const SECURITY_CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' blob:; ",
    "script-src-attr 'none'; ",
    "style-src 'self'; ",
    "style-src-attr 'none'; ",
    "img-src 'self' data: blob: https: http:; ",
    "font-src 'self' data:; ",
    "media-src 'self' data: blob: https: http:; ",
    "connect-src 'self' https: http: blob:; ",
    "frame-src 'self' https: http:; ",
    "worker-src 'self' blob:; ",
    "manifest-src 'self'; ",
    "base-uri 'self'; ",
    "form-action 'self'; ",
    "object-src 'none'; ",
    "frame-ancestors 'self'"
);
const SECURITY_STRICT_TRANSPORT_SECURITY: &str = "max-age=31536000; includeSubDomains";
const SECURITY_PERMISSIONS_POLICY: &str = concat!(
    "accelerometer=(), ",
    "ambient-light-sensor=(), ",
    "autoplay=(self), ",
    "camera=(), ",
    "display-capture=(), ",
    "encrypted-media=(self), ",
    "fullscreen=(self), ",
    "geolocation=(), ",
    "gyroscope=(), ",
    "magnetometer=(), ",
    "microphone=(), ",
    "payment=(), ",
    "usb=(), ",
    "xr-spatial-tracking=()"
);

fn insert_security_header_if_missing(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &'static str,
) {
    let header_name = HeaderName::from_static(name);
    if !headers.contains_key(&header_name) {
        headers.insert(header_name, HeaderValue::from_static(value));
    }
}

fn apply_security_headers(headers: &mut HeaderMap, include_hsts: bool) {
    insert_security_header_if_missing(
        headers,
        "content-security-policy",
        SECURITY_CONTENT_SECURITY_POLICY,
    );
    insert_security_header_if_missing(headers, "x-frame-options", "SAMEORIGIN");
    insert_security_header_if_missing(headers, "x-content-type-options", "nosniff");
    insert_security_header_if_missing(
        headers,
        "referrer-policy",
        "strict-origin-when-cross-origin",
    );
    insert_security_header_if_missing(headers, "permissions-policy", SECURITY_PERMISSIONS_POLICY);
    if include_hsts {
        insert_security_header_if_missing(
            headers,
            "strict-transport-security",
            SECURITY_STRICT_TRANSPORT_SECURITY,
        );
    }
}

async fn security_headers_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let mut response = next.run(request).await;
    apply_security_headers(response.headers_mut(), state.config.session_cookie_secure);
    response
}

/// Tally every response by status class for the admin Health panel. `/api/live/*`
/// 5xx (the HLS proxy's upstream failures — the `fragLoadError` source) get an
/// extra dedicated count. Adds one atomic increment per request; no allocation.
async fn http_metrics_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let is_live_proxy = request.uri().path().starts_with("/api/live");
    let response = next.run(request).await;
    state
        .http_metrics
        .record(response.status().as_u16(), is_live_proxy);
    response
}

async fn parse_json_body(request: Request<Body>) -> AppResult<Value> {
    let bytes = to_bytes(request.into_body(), JSON_BODY_LIMIT_BYTES)
        .await
        .map_err(|error| {
            let message = error.to_string().to_lowercase();
            if message.contains("length limit") || message.contains("body larger") {
                ApiError::payload_too_large(format!(
                    "JSON body exceeded the {} MiB limit.",
                    JSON_BODY_LIMIT_BYTES / (1024 * 1024)
                ))
            } else {
                ApiError::bad_request("Invalid JSON body.")
            }
        })?;
    serde_json::from_slice::<Value>(&bytes).map_err(|_| ApiError::bad_request("Invalid JSON body."))
}

async fn api_auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Result<Response<Body>, ApiError> {
    // The Cloudflare live-HLS Worker relays signed playlist/segment requests
    // to this origin without a browser session (cookies don't cross the
    // worker hop); the HMAC in the URL is the authorization — only this
    // backend can mint it. Everything else requires a session.
    if crate::live::is_signed_live_hls_request(&state.config.live_hls_proxy_secret, request.uri()) {
        return Ok(next.run(request).await);
    }
    if crate::local_torrent::is_internal_stream_request(
        &state.config.live_hls_proxy_secret,
        request.uri(),
    ) {
        return Ok(next.run(request).await);
    }
    auth::require_auth(&state.db, &headers).await?;
    Ok(next.run(request).await)
}

/// Best-effort client IP for rate-limiting. The backend always sits behind our
/// own Caddy on loopback, which sets `X-Forwarded-For`, so the left-most entry
/// is the real client. Falls back to the peer address (direct connections, e.g.
/// local dev) and finally a constant, so a missing IP degrades to a single
/// shared bucket rather than failing.
/// Parse the left-most (original-client) entry from an `X-Forwarded-For` value.
/// Returns `None` for an empty/blank header so the caller falls back to the peer.
fn parse_forwarded_for(header: &str) -> Option<String> {
    header
        .split(',')
        .next()
        .map(str::trim)
        .filter(|ip| !ip.is_empty())
        .map(str::to_owned)
}

fn extract_client_ip(request: &Request<Body>) -> String {
    // When fronted by Cloudflare, `CF-Connecting-IP` is the authoritative client
    // IP — Cloudflare sets it at the edge and it can't be forged by traffic that
    // actually transits Cloudflare. Prefer it, then fall back to `X-Forwarded-For`
    // (set by our own Caddy when there's no CDN), then the direct peer address.
    // NOTE: these headers are only trustworthy because the origin sees nothing but
    // our Caddy on loopback; once Cloudflare is in front, lock the origin's :443 to
    // Cloudflare's IP ranges so the public can't hit Caddy directly and spoof them.
    if let Some(ip) = request
        .headers()
        .get("cf-connecting-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|ip| !ip.is_empty())
    {
        return ip.to_owned();
    }
    if let Some(ip) = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_forwarded_for)
    {
        return ip;
    }
    request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Max concurrent in-flight requests across the throttled auth routes. With
/// Argon2 offloaded these resolve in well under a second, so reaching this many
/// at once signals a genuine overload worth shedding rather than queueing.
const AUTH_ROUTE_MAX_INFLIGHT: usize = 256;
/// Upper bound on a single auth request. Comfortably above a normal
/// hash/login/email round-trip; its job is to bound the pathological tail.
const AUTH_ROUTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
static AUTH_ROUTE_CONCURRENCY: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(AUTH_ROUTE_MAX_INFLIGHT);

/// Concurrency limit + timeout for the cheap mutating auth routes. Sheds with a
/// fast, retryable 503 when at capacity or when a request overruns the budget,
/// so a signup/login burst can never pile up and starve the shared runtime.
async fn auth_throttle_middleware(
    request: Request<Body>,
    next: Next,
) -> Result<Response<Body>, ApiError> {
    let busy =
        || ApiError::service_unavailable("The server is busy right now. Please try again shortly.");
    let _permit = AUTH_ROUTE_CONCURRENCY.try_acquire().map_err(|_| busy())?;
    match tokio::time::timeout(AUTH_ROUTE_TIMEOUT, next.run(request)).await {
        Ok(response) => Ok(response),
        Err(_elapsed) => Err(busy()),
    }
}

pub fn build_router(state: AppState) -> Router {
    let public_api = Router::new()
        .route("/api/health/live", any(health_live_handler))
        .route("/api/health", any(health_handler))
        .route("/api/config", any(config_handler))
        .route("/api/auth/logout", any(auth_logout_handler))
        .route("/api/auth/verify/{token}", get(auth_verify_handler))
        .route("/api/home/bootstrap", get(home_bootstrap_handler));

    // The cheap mutating auth routes do the surge-heavy work (Argon2 hashing +
    // outbound verification/reset email). A concurrency cap + per-request
    // timeout turns an overload into fast 503s instead of a pile-up that starves
    // the runtime. Health and the long-lived streaming/upload routes are
    // intentionally NOT wrapped — a short timeout would break video playback,
    // and the watchdog's health probe must always get an immediate answer.
    let auth_throttled = Router::new()
        .route("/api/auth/signup", any(auth_signup_handler))
        .route("/api/auth/login", any(auth_login_handler))
        .route(
            "/api/auth/resend-verification",
            any(auth_resend_verification_handler),
        )
        .route("/api/auth/forgot", any(auth_forgot_handler))
        .route("/api/auth/reset", any(auth_reset_handler))
        .route_layer(middleware::from_fn(auth_throttle_middleware));

    let protected_api = Router::new()
        .route(
            "/api/library",
            get(library_get_handler).put(library_put_handler),
        )
        .route("/api/hls/master.m3u8", any(hls_master_handler))
        .route("/api/hls/segment.ts", any(hls_segment_handler))
        .route("/api/debug/cache", any(debug_cache))
        .route("/api/debug/sports", any(debug_sports))
        .route("/api/football/matches", get(football_matches_handler))
        .route("/api/basketball/matches", get(basketball_matches_handler))
        .route("/api/tennis/matches", get(tennis_matches_handler))
        .route("/api/hockey/matches", get(hockey_matches_handler))
        .route("/api/baseball/matches", get(baseball_matches_handler))
        .route(
            "/api/american-football/matches",
            get(american_football_matches_handler),
        )
        .route("/api/cricket/matches", get(cricket_matches_handler))
        .route("/api/twitch/stream", get(twitch_stream_resolve_handler))
        .route("/api/live/hls.m3u8", any(live_hls_handler))
        .route("/api/live/hls-resource", any(live_hls_resource_handler))
        .route(
            "/api/live/channel-overrides",
            get(live_channel_overrides_handler),
        )
        .route("/api/football/stream", get(football_stream_resolve_handler))
        .route(
            "/api/basketball/stream",
            get(basketball_stream_resolve_handler),
        )
        .route(
            "/api/sports/stream",
            get(streamed_sports_stream_resolve_handler),
        )
        .route("/api/title/preferences", any(title_preferences_handler))
        .route("/api/session/progress", any(session_progress_handler))
        .route("/api/tmdb/popular-movies", any(tmdb_popular_movies_handler))
        .route("/api/tmdb/search", any(tmdb_search_handler))
        .route("/api/tmdb/details", any(tmdb_details_handler))
        .route("/api/tmdb/tv/season", any(tmdb_tv_season_handler))
        .route("/api/upload/infer", any(upload_infer_handler))
        .route("/api/upload", any(upload_handler))
        .route(
            "/api/upload/session/start",
            any(upload_session_start_handler),
        )
        .route(
            "/api/upload/session/chunk",
            any(upload_session_chunk_handler)
                .layer(DefaultBodyLimit::max(UPLOAD_SESSION_CHUNK_MAX_BYTES)),
        )
        .route(
            "/api/upload/session/finish",
            any(upload_session_finish_handler),
        )
        .route("/api/gallery/save-stream", any(gallery_save_stream_handler))
        .route("/api/resolve/sources", any(resolve_sources_handler))
        .route("/api/resolve/movie", any(resolve_movie_handler))
        .route("/api/resolve/tv", any(resolve_tv_handler))
        .route(
            "/api/resolve/local-upgrade",
            any(resolve_local_upgrade_handler),
        )
        .route(
            "/api/local-torrent/stream",
            any(local_torrent_stream_handler),
        )
        .route("/api/local-cache/stream", any(local_cache_stream_handler))
        .route("/api/remux", any(remux_handler))
        .route("/api/download/export.mp4", any(download_export_handler))
        .route("/api/media/tracks", any(media_tracks_handler))
        .route("/api/subtitles.vtt", any(subtitles_vtt_handler))
        .route(
            "/api/subtitles.opensubtitles.vtt",
            any(subtitles_opensubtitles_vtt_handler),
        )
        .route(
            "/api/subtitles.external.vtt",
            any(subtitles_external_vtt_handler),
        )
        .route("/api/auth/me", any(auth_me_handler))
        .route("/api/user/preferences", any(user_preferences_handler))
        .route("/api/user/real-debrid", any(user_real_debrid_handler))
        .route("/api/user/torrent-settings", any(user_real_debrid_handler))
        .route("/api/user/watch-progress", any(user_watch_progress_handler))
        .route(
            "/api/user/continue-watching",
            any(user_continue_watching_handler),
        )
        .route("/api/user/my-list", any(user_my_list_handler))
        .route("/api/user/live-watch", any(user_live_watch_handler))
        .route("/api/user/sync", any(user_sync_handler))
        .route("/api/feedback", any(feedback_submit_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            api_auth_middleware,
        ));

    // Admin dashboard API. Each handler calls `auth::require_admin`, so these
    // are gated independently (authentication + admin check in one step).
    let admin_api = Router::new()
        .route("/api/admin/overview", get(admin_overview_handler))
        .route("/api/admin/growth", get(admin_growth_handler))
        .route("/api/admin/users", get(admin_users_handler))
        .route("/api/admin/users/detail", get(admin_user_detail_handler))
        .route("/api/admin/activity", get(admin_activity_handler))
        .route("/api/admin/live-top", get(admin_live_top_handler))
        .route("/api/admin/feedback", get(admin_feedback_handler))
        .route(
            "/api/admin/feedback/{id}",
            any(admin_delete_feedback_handler),
        )
        .route(
            "/api/admin/feedback/{id}/image",
            get(admin_feedback_image_handler),
        )
        .route(
            "/api/admin/users/reset-password",
            any(admin_reset_password_handler),
        )
        .route(
            "/api/admin/users/set-disabled",
            any(admin_set_disabled_handler),
        )
        .route("/api/admin/users/set-admin", any(admin_set_admin_handler))
        .route("/api/admin/users/delete", any(admin_delete_user_handler))
        .route("/api/admin/health", get(admin_health_handler))
        .route(
            "/api/admin/health/history",
            get(admin_health_history_handler),
        )
        .route("/api/admin/providers", get(admin_providers_handler))
        .route("/api/admin/providers/set", any(admin_provider_set_handler))
        .route(
            "/api/admin/providers/test",
            any(admin_provider_test_handler),
        )
        .route("/api/admin/providers/add", any(admin_provider_add_handler))
        .route(
            "/api/admin/providers/remove",
            any(admin_provider_remove_handler),
        );

    Router::new()
        .merge(public_api)
        .merge(auth_throttled)
        .merge(protected_api)
        .merge(admin_api)
        .fallback(any(serve_static))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            http_metrics_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state,
            security_headers_middleware,
        ))
}

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

async fn admin_overview_handler(
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

async fn admin_growth_handler(
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

async fn admin_users_handler(
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

async fn admin_user_detail_handler(
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

async fn admin_activity_handler(
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

async fn admin_live_top_handler(
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

async fn admin_feedback_handler(
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
async fn admin_feedback_image_handler(
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
async fn admin_delete_feedback_handler(
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

async fn admin_reset_password_handler(
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

async fn admin_set_disabled_handler(
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

async fn admin_set_admin_handler(
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

async fn admin_delete_user_handler(
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

async fn admin_health_handler(
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

async fn admin_health_history_handler(
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
async fn admin_providers_handler(
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
async fn admin_provider_set_handler(
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
async fn admin_provider_test_handler(
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
fn normalize_custom_addon_base(raw: &str) -> Option<String> {
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
fn provider_slugify(value: &str) -> String {
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
fn manifest_is_stream_addon(manifest: &Value) -> bool {
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
async fn admin_provider_add_handler(
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
async fn admin_provider_remove_handler(
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

/// Live-channel URL overrides for the signed-in frontend. The live page / player
/// merge these over the compiled channel list so an admin swap takes effect
/// without a redeploy. Login-gated (not admin) since any viewer plays these.
async fn live_channel_overrides_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    auth::require_auth(&state.db, &headers).await?;
    let overrides: std::collections::BTreeMap<String, String> =
        crate::provider_registry::live_overrides()
            .into_iter()
            .collect();
    let value =
        serde_json::to_value(overrides).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(json_response(json!({ "overrides": value })))
}

pub async fn debug_cache(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET && method != Method::POST {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    auth::require_admin(&state.db, &headers).await?;
    let clear_requested = query_flag_enabled(uri.query().unwrap_or_default(), "clear");
    if clear_requested && method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST to clear caches.",
        ));
    }
    if clear_requested {
        state.db.clear_persistent_caches().await?;
        let _ = tokio::fs::remove_dir_all(&state.config.hls_cache_dir).await;
    }
    state.db.sweep().await;
    let persistent_counts = state.db.persistent_counts().await?;
    let (hits, misses, expired) = state.tmdb.stats();
    let mut payload = build_cache_debug_payload(
        state.started_at_ms,
        state.tmdb.in_memory_size(),
        persistent_counts,
        hits,
        misses,
        expired,
    );
    if let Some(path) = payload.pointer_mut("/caches/persistentDb/path") {
        *path = Value::String(
            state
                .config
                .persistent_cache_db_path
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(json_response(payload))
}

pub async fn debug_sports(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    auth::require_admin(&state.db, &headers).await?;
    Ok(json_response(json!({
        "scheduleCache": state.sports_schedule_cache.debug_payload(),
        "streamResolveCache": state.sports_stream_resolve_cache.stats(),
        "providerHealth": state.sports_provider_health.summary(true),
        "proxyConfigured": std::env::var("SPORTS_HTTP_PROXY").ok().is_some_and(|value| !value.trim().is_empty()),
        "streamedResolverConfigured": std::env::var("STREAMED_HLS_RESOLVER_SCRIPT").ok().map(|value| !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "disabled")).unwrap_or(true),
        "matchstreamResolverConfigured": std::env::var("MATCHSTREAM_HLS_RESOLVER_SCRIPT").ok().map(|value| !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "disabled")).unwrap_or(true),
        "ntvsResolverConfigured": std::env::var("NTVS_HLS_RESOLVER_SCRIPT").ok().map(|value| !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "disabled")).unwrap_or(true)
    })))
}

pub async fn config_handler(
    State(state): State<AppState>,
    method: Method,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let ffmpeg = state.runtime.get_ffmpeg_capabilities(false).await;
    Ok(json_response(json!({
        "realDebridConfigured": false,
        "realDebridRequiresUserApiKey": true,
        "localTorrentAvailable": state.local_torrent.is_available(),
        "defaultResolverProvider": "fastest",
        "resolverProviders": ["fastest", "local-torrent", "real-debrid"],
        "torznabConfigured": !state.config.torznab_api_url.is_empty(),
        "tmdbConfigured": !state.config.tmdb_api_key.is_empty(),
        "signup": {
            "open": state.config.open_signup_enabled,
            "inviteEnabled": !state.config.signup_invite_code.is_empty(),
            "bootstrapEnabled": config::bootstrap_admin_email().is_some()
                && !state.config.signup_invite_code.is_empty()
        },
        "playbackSessionsEnabled": state.config.playback_sessions_enabled,
        "autoAudioSyncEnabled": state.config.auto_audio_sync_enabled,
        "remuxVideoMode": state.config.remux_video_mode,
        "remuxLimits": {
            "maxConcurrent": state.config.remux_max_concurrent,
            "queueTimeoutMs": state.config.remux_queue_timeout_ms,
            "processTimeoutSeconds": state.config.remux_process_timeout_seconds
        },
        "hlsLimits": {
            "maxTranscodeJobs": state.config.hls_max_transcode_jobs,
            "maxSegmentRenders": state.config.hls_max_segment_renders,
            "segmentQueueTimeoutMs": state.config.hls_segment_queue_timeout_ms
        },
        "maxUploadBytes": state.config.max_upload_bytes,
        "hlsHwaccel": {
            "requested": state.config.hls_hwaccel_mode,
            "effective": ffmpeg.effectiveHlsHwaccel
        },
        "remuxHwaccel": {
            "requested": state.config.remux_hwaccel_mode,
            "effective": resolve_effective_remux_hwaccel_mode(&ffmpeg, &state.config.remux_hwaccel_mode)
        }
    })))
}

pub async fn health_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let refresh = query_flag_enabled(uri.query().unwrap_or_default(), "refresh");
    if refresh {
        auth::require_admin(&state.db, &headers).await?;
    }
    let ffmpeg = state.runtime.get_ffmpeg_capabilities(refresh).await;
    Ok(json_response(json!({
        "ok": true,
        "uptimeSeconds": ((now_ms() - state.started_at_ms) / 1000).max(0),
        "streaming": state.streaming.stats(),
        "resolver": state.resolver.stats(),
        "sports": {
            "streamResolveCache": state.sports_stream_resolve_cache.stats(),
            "providerHealth": state.sports_provider_health.summary(false)
        },
        "ffmpeg": ffmpeg
    })))
}

pub async fn health_live_handler(
    State(state): State<AppState>,
    method: Method,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    Ok(json_response(json!({
        "ok": true,
        "uptimeSeconds": ((now_ms() - state.started_at_ms) / 1000).max(0)
    })))
}

pub async fn library_get_handler(State(state): State<AppState>) -> AppResult<Response<Body>> {
    let library = read_local_library(&state.config.local_library_path).await?;
    Ok(json_response(
        serde_json::to_value(library).unwrap_or_else(|_| json!({"movies": [], "series": []})),
    ))
}

pub async fn library_put_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    auth::require_admin(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let updated = write_local_library(&state.config.local_library_path, payload).await?;
    Ok(json_response(json!({
        "ok": true,
        "library": updated
    })))
}

pub async fn title_preferences_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let params = query_pairs(uri.query().unwrap_or_default());
            let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
            let media_type = normalize_media_type_param(
                params
                    .get("mediaType")
                    .map(String::as_str)
                    .unwrap_or("movie"),
            );
            if !is_numeric_id(&tmdb_id) {
                return Err(ApiError::bad_request(
                    "Missing or invalid tmdbId query parameter.",
                ));
            }
            let preference = state
                .db
                .get_title_preference(user.id, media_type.clone(), tmdb_id.clone())
                .await?
                .unwrap_or(TitlePreference {
                    audioLang: "auto".to_owned(),
                    subtitleLang: String::new(),
                });
            Ok(json_response(json!({
                "tmdbId": tmdb_id,
                "mediaType": media_type,
                "preference": preference
            })))
        }
        Method::POST => {
            let payload = parse_json_body(request).await?;
            let tmdb_id = payload
                .get("tmdbId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let media_type = normalize_media_type_param(
                payload
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .unwrap_or("movie"),
            );
            if !is_numeric_id(&tmdb_id) {
                return Err(ApiError::bad_request("Missing or invalid tmdbId."));
            }
            state
                .db
                .persist_title_preference(
                    user.id,
                    media_type.clone(),
                    tmdb_id.clone(),
                    payload
                        .get("audioLang")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    payload
                        .get("subtitleLang")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
                .await?;
            state
                .db
                .invalidate_all_movie_resolve_caches_for_tmdb(tmdb_id.clone())
                .await?;
            let preference = state
                .db
                .get_title_preference(user.id, media_type.clone(), tmdb_id.clone())
                .await?
                .unwrap_or(TitlePreference {
                    audioLang: "auto".to_owned(),
                    subtitleLang: String::new(),
                });
            Ok(json_response(json!({
                "ok": true,
                "tmdbId": tmdb_id,
                "mediaType": media_type,
                "preference": preference
            })))
        }
        Method::DELETE => {
            let params = query_pairs(uri.query().unwrap_or_default());
            let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
            let media_type = normalize_media_type_param(
                params
                    .get("mediaType")
                    .map(String::as_str)
                    .unwrap_or("movie"),
            );
            if !is_numeric_id(&tmdb_id) {
                return Err(ApiError::bad_request(
                    "Missing or invalid tmdbId query parameter.",
                ));
            }
            state
                .db
                .delete_title_preference(user.id, media_type.clone(), tmdb_id.clone())
                .await?;
            state
                .db
                .delete_playback_sessions_for_tmdb(user.id, tmdb_id.clone())
                .await?;
            state
                .db
                .invalidate_all_movie_resolve_caches_for_tmdb(tmdb_id.clone())
                .await?;
            Ok(json_response(json!({
                "ok": true,
                "tmdbId": tmdb_id,
                "mediaType": media_type,
                "cleared": {
                    "titlePreferences": true,
                    "playbackSessions": true,
                    "movieResolveCaches": true
                }
            })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET, POST, or DELETE.",
        )),
    }
}

pub async fn session_progress_handler(
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
    if !state.config.playback_sessions_enabled {
        return Ok(json_response(json!({
            "ok": true,
            "disabled": true,
            "session": null
        })));
    }
    let user = auth::require_auth(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let tmdb_id = payload
        .get("tmdbId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request("Missing or invalid tmdbId."));
    }
    let media_type = normalize_media_type_param(
        payload
            .get("mediaType")
            .and_then(Value::as_str)
            .unwrap_or("movie"),
    );

    let preferred_audio_lang = normalize_preferred_audio_lang(
        payload
            .get("audioLang")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let preferred_quality = normalize_preferred_stream_quality(
        payload
            .get("quality")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );

    let requested_session_key = payload
        .get("sessionKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let mut session_key = if requested_session_key.is_empty() {
        build_playback_session_key(&tmdb_id, &preferred_audio_lang, &preferred_quality)
    } else {
        requested_session_key.clone()
    };
    let mut existing = state
        .db
        .get_playback_session(user.id, session_key.clone())
        .await?;
    if let Some(ref session) = existing
        && session.tmdb_id != tmdb_id
    {
        existing = None;
    }
    if existing.is_none() && requested_session_key.is_empty() {
        if preferred_audio_lang == "auto" {
            let effective_audio_lang = resolve_effective_preferred_audio_lang(
                &state,
                user.id,
                &media_type,
                &tmdb_id,
                &preferred_audio_lang,
            )
            .await?;
            session_key =
                build_playback_session_key(&tmdb_id, &effective_audio_lang, &preferred_quality);
            existing = state
                .db
                .get_playback_session(user.id, session_key.clone())
                .await?;
        }
        if existing.is_none() {
            existing = state
                .db
                .get_latest_playback_session_for_tmdb(user.id, tmdb_id.clone())
                .await?;
            if let Some(ref latest) = existing {
                session_key = latest.session_key.clone();
            }
        }
    }
    let Some(existing) = existing else {
        return Err(ApiError::not_found(
            "Playback session not found for this title/language.",
        ));
    };

    let position_seconds = payload
        .get("positionSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(existing.last_position_seconds)
        .max(0.0);
    let health_state = normalize_session_health_state(
        payload
            .get("healthState")
            .and_then(Value::as_str)
            .unwrap_or(&existing.health_state),
    );
    let last_error = payload
        .get("lastError")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let updated = state
        .db
        .update_playback_session_progress(
            user.id,
            session_key.clone(),
            position_seconds,
            health_state.clone(),
            last_error,
        )
        .await?;
    if !updated {
        return Err(ApiError::internal(
            "Unable to persist playback session progress.",
        ));
    }

    // Never trust the caller to identify which source should be penalized. The
    // source identity comes from the authenticated user's stored session.
    let source_hash = existing.source_hash.trim().to_lowercase();
    let last_error_text = payload
        .get("lastError")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    if health_state == "invalid" && !source_hash.is_empty() {
        state
            .db
            .invalidate_playback_sessions_by_source_hash(
                user.id,
                source_hash.clone(),
                last_error_text.if_empty_then(|| "Playback source failed.".to_owned()),
            )
            .await?;
    }

    let next_session = state.db.get_playback_session(user.id, session_key).await?;
    Ok(json_response(json!({
        "ok": true,
        "session": next_session.map(build_playback_session_payload)
    })))
}

pub async fn tmdb_popular_movies_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let page = params
        .get("page")
        .cloned()
        .unwrap_or_else(|| "1".to_owned());
    let mut popular_params = BTreeMap::new();
    popular_params.insert("page".to_owned(), page);

    let (movie_popular, movie_genres) = tokio::join!(
        state.tmdb.fetch("/movie/popular", popular_params, 20_000),
        state
            .tmdb
            .fetch("/genre/movie/list", BTreeMap::new(), 20_000)
    );
    let movie_popular = movie_popular?;
    let movie_genres = movie_genres?;
    Ok(json_response(json!({
        "results": movie_popular.get("results").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "genres": movie_genres.get("genres").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "imageBase": "https://image.tmdb.org/t/p"
    })))
}

pub async fn home_bootstrap_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    auth::require_auth(&state.db, &headers).await?;
    let payload = state
        .home_bootstrap_cache
        .payload_or_refresh(state.clone())
        .await;
    Ok(json_response(payload))
}

pub async fn tmdb_search_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let query = normalize_whitespace(
        params
            .get("query")
            .cloned()
            .or_else(|| params.get("q").cloned())
            .unwrap_or_default(),
    );
    let requested_limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(40);
    let limit = requested_limit.clamp(1, 60) as usize;

    if query.len() < 2 {
        return Ok(json_response(json!({
            "query": query,
            "results": [],
            "imageBase": "https://image.tmdb.org/t/p"
        })));
    }

    let mut search_params = BTreeMap::new();
    search_params.insert("query".to_owned(), query.clone());
    search_params.insert("include_adult".to_owned(), "false".to_owned());
    search_params.insert("page".to_owned(), "1".to_owned());
    let payload = state
        .tmdb
        .fetch("/search/multi", search_params, 20_000)
        .await?;
    let results = payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| {
            entry.get("id").is_some()
                && matches!(
                    entry.get("media_type").and_then(Value::as_str),
                    Some("movie") | Some("tv")
                )
        })
        .take(limit)
        .map(|entry| {
            json!({
                "id": stringify_json(entry.get("id")),
                "mediaType": if entry.get("media_type").and_then(Value::as_str) == Some("tv") { "tv" } else { "movie" },
                "title": normalize_whitespace(stringify_json(entry.get("title")).if_empty_then(|| stringify_json(entry.get("name")))),
                "name": normalize_whitespace(stringify_json(entry.get("name")).if_empty_then(|| stringify_json(entry.get("title")))),
                "releaseDate": stringify_json(entry.get("release_date")),
                "firstAirDate": stringify_json(entry.get("first_air_date")),
                "posterPath": stringify_json(entry.get("poster_path")),
                "backdropPath": stringify_json(entry.get("backdrop_path")),
                "overview": stringify_json(entry.get("overview")),
                "adult": entry.get("adult").and_then(Value::as_bool).unwrap_or(false),
                "popularity": entry.get("popularity").and_then(Value::as_f64).unwrap_or(0.0),
                "voteAverage": entry.get("vote_average").and_then(Value::as_f64).unwrap_or(0.0)
            })
        })
        .collect::<Vec<_>>();

    Ok(json_response(json!({
        "query": query,
        "results": results,
        "imageBase": "https://image.tmdb.org/t/p"
    })))
}

pub async fn tmdb_details_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    let media_type = params
        .get("mediaType")
        .cloned()
        .unwrap_or_else(|| "movie".to_owned())
        .to_lowercase();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    if media_type != "movie" && media_type != "tv" {
        return Err(ApiError::bad_request(
            "Unsupported mediaType. Use movie or tv.",
        ));
    }
    let mut detail_params = BTreeMap::new();
    detail_params.insert(
        "append_to_response".to_owned(),
        crate::tmdb::details_append_to_response(&media_type).to_owned(),
    );
    // Widen the appended image set so language-neutral ("null") title-logos come back too;
    // `select_best_logo_path` then picks the best English/most-voted wordmark.
    detail_params.insert("include_image_language".to_owned(), "en,null".to_owned());
    let mut details = state
        .tmdb
        .fetch(&format!("/{media_type}/{tmdb_id}"), detail_params, 20_000)
        .await?;
    // Hoist the chosen title-logo to a top-level `logo_path` (mirroring the home rails) and drop
    // the bulky `images` blob the client doesn't need, so Continue Watching cards can render the
    // show's wordmark just like every other rail.
    let logo_path = details
        .get("images")
        .and_then(crate::home_bootstrap::select_best_logo_path);
    let certification = crate::tmdb::select_details_certification(&details, &media_type);
    if let Value::Object(map) = &mut details {
        map.remove("images");
        map.remove("release_dates");
        map.remove("content_ratings");
        if let Some(logo_path) = logo_path {
            map.insert("logo_path".to_owned(), Value::String(logo_path));
        }
        map.insert(
            "certification".to_owned(),
            certification.map(Value::String).unwrap_or(Value::Null),
        );
    }
    Ok(json_response(details))
}

pub async fn tmdb_tv_season_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    let season_number = normalize_upload_episode_ordinal(
        params
            .get("seasonNumber")
            .or_else(|| params.get("season"))
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(1),
        1,
    );
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }

    let season = state
        .tmdb
        .fetch(
            &format!("/tv/{tmdb_id}/season/{season_number}"),
            BTreeMap::new(),
            20_000,
        )
        .await?;
    let episodes = season
        .get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| {
            let still_path = stringify_json(entry.get("still_path"));
            json!({
                "episodeNumber": entry.get("episode_number").and_then(Value::as_i64).unwrap_or(0),
                "seasonNumber": entry.get("season_number").and_then(Value::as_i64).unwrap_or(season_number),
                "stillPath": still_path,
                "stillUrl": if still_path.is_empty() {
                    String::new()
                } else {
                    format!("https://image.tmdb.org/t/p/w780{still_path}")
                },
                "name": stringify_json(entry.get("name")),
                "overview": stringify_json(entry.get("overview")),
                "airDate": stringify_json(entry.get("air_date")),
                "runtime": entry.get("runtime").and_then(Value::as_i64).unwrap_or(0)
            })
        })
        .collect::<Vec<_>>();
    Ok(json_response(json!({
        "tmdbId": tmdb_id,
        "seasonNumber": season_number,
        "episodes": episodes,
        "imageBase": "https://image.tmdb.org/t/p"
    })))
}

pub async fn upload_infer_handler(
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
    let file_name = normalize_whitespace(
        payload
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if file_name.is_empty() {
        return Err(ApiError::bad_request("Missing fileName."));
    }
    let inferred = infer_upload_metadata(&state, &file_name).await?;
    Ok(json_response(json!({
        "ok": true,
        "inferred": inferred
    })))
}

pub async fn upload_handler(
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
    let payload = state.upload.handle_direct_upload(request).await?;
    Ok(json_response(payload))
}

pub async fn upload_session_start_handler(
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
    Ok(json_response(state.upload.start_session(payload).await?))
}

pub async fn upload_session_chunk_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    auth::require_admin(&state.db, &headers).await?;
    let params = query_pairs(uri.query().unwrap_or_default());
    let session_id = params.get("sessionId").cloned().unwrap_or_default();
    Ok(json_response(
        state
            .upload
            .append_chunk(&session_id, request.into_limited_body())
            .await?,
    ))
}

pub async fn upload_session_finish_handler(
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
    Ok(json_response(state.upload.finish_session(payload).await?))
}

pub async fn gallery_save_stream_handler(
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
    Ok(json_response(state.upload.queue_gallery_save(payload)?))
}

pub async fn resolve_sources_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }

    let media_type = params
        .get("mediaType")
        .cloned()
        .unwrap_or_else(|| "movie".to_owned())
        .trim()
        .to_lowercase();
    if media_type != "movie" && media_type != "tv" {
        return Err(ApiError::bad_request(
            "Unsupported mediaType. Use movie or tv.",
        ));
    }
    let user = auth::require_auth(&state.db, &headers).await?;
    let real_debrid_api_key = real_debrid_api_key_for_user(&state, user.id).await?;
    let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;

    let payload = state
        .resolver
        .list_sources(
            user.id,
            &real_debrid_api_key,
            local_torrent_enabled,
            &tmdb_id,
            &media_type,
            params.get("title").map(String::as_str).unwrap_or_default(),
            params.get("year").map(String::as_str).unwrap_or_default(),
            params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("preferredContainer")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("minSeeders")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("allowedFormats")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceAudioProfile")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("limit").map(String::as_str).unwrap_or_default(),
            params
                .get("resolverProvider")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("seasonNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("season").map(String::as_str).unwrap_or_default(),
            params
                .get("episodeNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("episodeOrdinal")
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .await?;
    Ok(json_response(payload))
}

pub async fn resolve_movie_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    let skip_external_embed = params.get("skipExternalEmbed").is_some_and(|value| {
        let normalized = value.trim();
        normalized == "1" || normalized.eq_ignore_ascii_case("true")
    });
    // Set by the player when re-resolving after a playback failure: bypass + evict
    // any cached resolved source so a stale/dead upstream URL can't be re-served.
    let refresh_resolve = params.get("refreshResolve").is_some_and(|value| {
        let normalized = value.trim();
        normalized == "1" || normalized.eq_ignore_ascii_case("true")
    });
    let user = auth::require_auth(&state.db, &headers).await?;
    let real_debrid_api_key = real_debrid_api_key_for_user(&state, user.id).await?;
    let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
    let payload = state
        .resolver
        .resolve_movie(
            user.id,
            &real_debrid_api_key,
            local_torrent_enabled,
            &tmdb_id,
            params.get("title").map(String::as_str).unwrap_or_default(),
            params.get("year").map(String::as_str).unwrap_or_default(),
            params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("subtitleLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sessionKey")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("minSeeders")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("allowedFormats")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceAudioProfile")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("resolverProvider")
                .map(String::as_str)
                .unwrap_or_default(),
            skip_external_embed,
            refresh_resolve,
        )
        .await?;
    Ok(json_response(payload))
}

pub async fn resolve_local_upgrade_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    let user = auth::require_auth(&state.db, &headers).await?;
    let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
    if !local_torrent_enabled {
        return Ok(json_response(json!({ "ready": false })));
    }
    let payload = state
        .resolver
        .check_local_cache_upgrade(LocalCacheUpgradeRequest {
            user_id: user.id,
            tmdb_id: &tmdb_id,
            preferred_audio_lang: params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            preferred_quality: params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            source_hash: params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            selected_file: params
                .get("selectedFile")
                .map(String::as_str)
                .unwrap_or_default(),
            media_type: params
                .get("mediaType")
                .map(String::as_str)
                .unwrap_or("movie"),
            season_number: params
                .get("seasonNumber")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(1),
            episode_number: params
                .get("episodeNumber")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(1),
        })
        .await?;
    Ok(json_response(payload))
}

pub async fn resolve_tv_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let tmdb_id = params.get("tmdbId").cloned().unwrap_or_default();
    if !is_numeric_id(&tmdb_id) {
        return Err(ApiError::bad_request(
            "Missing or invalid tmdbId query parameter.",
        ));
    }
    let skip_external_embed = params.get("skipExternalEmbed").is_some_and(|value| {
        let normalized = value.trim();
        normalized == "1" || normalized.eq_ignore_ascii_case("true")
    });
    // Set by the player when re-resolving after a playback failure: bypass + evict
    // any cached resolved source so a stale/dead upstream URL can't be re-served.
    let refresh_resolve = params.get("refreshResolve").is_some_and(|value| {
        let normalized = value.trim();
        normalized == "1" || normalized.eq_ignore_ascii_case("true")
    });
    let user = auth::require_auth(&state.db, &headers).await?;
    let real_debrid_api_key = real_debrid_api_key_for_user(&state, user.id).await?;
    let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
    let payload = state
        .resolver
        .resolve_tv(
            user.id,
            &real_debrid_api_key,
            local_torrent_enabled,
            &tmdb_id,
            params.get("title").map(String::as_str).unwrap_or_default(),
            params.get("year").map(String::as_str).unwrap_or_default(),
            params
                .get("seasonNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("season").map(String::as_str).unwrap_or_default(),
            params
                .get("episodeNumber")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("episodeOrdinal")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("audioLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("quality")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("subtitleLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("preferredContainer")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sessionKey")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("minSeeders")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("allowedFormats")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceLang")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("sourceAudioProfile")
                .map(String::as_str)
                .unwrap_or_default(),
            params
                .get("resolverProvider")
                .map(String::as_str)
                .unwrap_or_default(),
            skip_external_embed,
            refresh_resolve,
        )
        .await?;
    Ok(json_response(payload))
}

pub async fn local_torrent_stream_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if !crate::local_torrent::is_internal_stream_request(&state.config.live_hls_proxy_secret, &uri)
    {
        let user = auth::require_auth(&state.db, &headers).await?;
        let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
        if !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    state
        .local_torrent
        .create_stream_response(
            method,
            headers,
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("fileId").map(String::as_str).unwrap_or_default(),
        )
        .await
}

pub async fn local_cache_stream_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if !crate::local_torrent::is_internal_stream_request(&state.config.live_hls_proxy_secret, &uri)
    {
        let user = auth::require_auth(&state.db, &headers).await?;
        let real_debrid_api_key = real_debrid_api_key_for_user(&state, user.id).await?;
        if real_debrid_api_key.is_empty() {
            return Err(real_debrid_api_key_required_error());
        }
        let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
        if !local_torrent_enabled {
            return Err(local_torrent_required_error());
        }
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    state
        .local_torrent
        .create_direct_file_stream_response(
            method,
            headers,
            params
                .get("sourceHash")
                .map(String::as_str)
                .unwrap_or_default(),
            params.get("fileId").map(String::as_str).unwrap_or_default(),
        )
        .await
}

pub async fn remux_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let input = params.get("input").cloned().unwrap_or_default();
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let start_seconds = params
        .get("start")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let subtitle_stream_index = params
        .get("subtitleStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let manual_audio_sync_ms = params
        .get("audioSyncMs")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let preferred_video_mode = params
        .get("videoMode")
        .cloned()
        .unwrap_or_else(|| state.config.remux_video_mode.clone());
    state
        .streaming
        .create_remux_response(
            &input,
            start_seconds,
            audio_stream_index,
            subtitle_stream_index,
            manual_audio_sync_ms,
            &preferred_video_mode,
        )
        .await
}

// Offline export: a fragmented MP4 of the chosen source + audio language, streamed live
// for offline download. Cookie-authenticated via `api_auth_middleware` like every other
// `protected_api` route.
pub async fn download_export_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET && method != Method::HEAD {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let input = params.get("input").cloned().unwrap_or_default();
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    // Optional duration cap (clip exports / fast verification); omitted means the whole title.
    let duration_seconds = params
        .get("duration")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    state
        .streaming
        .create_export_response(
            &input,
            audio_stream_index,
            duration_seconds,
            method == Method::HEAD,
        )
        .await
}

pub async fn hls_master_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let input = params.get("input").cloned().unwrap_or_default();
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state
        .streaming
        .create_hls_playlist_response(&input, audio_stream_index)
        .await
}

pub async fn hls_segment_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let input = params.get("input").cloned().unwrap_or_default();
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let segment_index = params
        .get("index")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let audio_stream_index = params
        .get("audioStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state
        .streaming
        .create_hls_segment_response(&input, segment_index, audio_stream_index)
        .await
}

pub async fn media_tracks_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let request_url = absolute_request_url(&state, &uri)?;
    let raw_input = params.get("input").map(String::as_str).unwrap_or_default();
    let source_input = if raw_input.trim().starts_with("/api/local-torrent/stream")
        || raw_input.trim().starts_with("/api/local-cache/stream")
    {
        raw_input.trim().to_owned()
    } else {
        to_absolute_playback_url(raw_input, &request_url)
    };
    if source_input.is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }

    let preferred_audio_lang = normalize_preferred_audio_lang(
        params
            .get("audioLang")
            .map(String::as_str)
            .unwrap_or_default(),
    );
    let preferred_subtitle_lang = normalize_subtitle_preference(
        params
            .get("subtitleLang")
            .map(String::as_str)
            .unwrap_or_default(),
    );
    let subtitle_title_hint = params
        .get("title")
        .cloned()
        .unwrap_or_else(|| infer_title_hint_from_source_input(&source_input));
    let subtitle_year_hint = normalize_year(params.get("year").cloned().unwrap_or_default());
    let subtitle_imdb_id_hint = params.get("imdbId").cloned().unwrap_or_default();
    let subtitle_filename_hint = infer_filename_hint_from_source_input(&source_input);

    let mut tracks = MediaProbe::default();
    let mut selected_audio_stream_index = -1_i64;
    let mut selected_subtitle_stream_index = -1_i64;

    if let Ok(probe) = state.media.probe_media_tracks(&source_input).await {
        let mut merged_tracks = probe;
        let local_sidecar_subtitle_tracks = state
            .media
            .find_local_sidecar_subtitle_tracks(&source_input);
        let mut external_subtitle_tracks = state
            .media
            .search_opensubtitles_tracks(
                &subtitle_imdb_id_hint,
                &subtitle_title_hint,
                &subtitle_year_hint,
                &preferred_subtitle_lang,
                &subtitle_filename_hint,
            )
            .await;
        if external_subtitle_tracks.is_empty() {
            let season_number_hint = params
                .get("seasonNumber")
                .and_then(|value| value.trim().parse::<i64>().ok())
                .unwrap_or_default();
            let episode_number_hint = params
                .get("episodeNumber")
                .and_then(|value| value.trim().parse::<i64>().ok())
                .unwrap_or_default();
            external_subtitle_tracks = state
                .media
                .search_stremio_addon_subtitle_tracks(
                    &subtitle_imdb_id_hint,
                    season_number_hint,
                    episode_number_hint,
                    &preferred_subtitle_lang,
                )
                .await;
        }
        if !local_sidecar_subtitle_tracks.is_empty() {
            merged_tracks.subtitleTracks = merge_preferred_subtitle_tracks(
                local_sidecar_subtitle_tracks,
                merged_tracks.subtitleTracks,
            );
        }
        if !external_subtitle_tracks.is_empty() {
            merged_tracks.subtitleTracks = merge_preferred_subtitle_tracks(
                external_subtitle_tracks,
                merged_tracks.subtitleTracks,
            );
        }
        if let Some(audio_track) =
            choose_audio_track_from_probe(&merged_tracks, &preferred_audio_lang)
        {
            selected_audio_stream_index = audio_track.streamIndex;
        }
        if let Some(subtitle_track) =
            choose_subtitle_track_from_probe(&merged_tracks, &preferred_subtitle_lang)
        {
            selected_subtitle_stream_index = subtitle_track.streamIndex;
        }
        tracks = merged_tracks;
    }

    Ok(json_response(json!({
        "tracks": tracks,
        "selectedAudioStreamIndex": selected_audio_stream_index,
        "selectedSubtitleStreamIndex": selected_subtitle_stream_index,
        "preferences": {
            "audioLang": preferred_audio_lang,
            "subtitleLang": preferred_subtitle_lang
        },
        "sourceInput": source_input
    })))
}

fn infer_filename_hint_from_source_input(source_input: &str) -> String {
    let candidate = if let Ok(url) = Url::parse(source_input) {
        url.path_segments()
            .and_then(|mut segments| segments.next_back())
            .unwrap_or_default()
            .to_owned()
    } else {
        Path::new(source_input)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_owned()
    };
    percent_decode_path_component(&candidate)
}

fn infer_title_hint_from_source_input(source_input: &str) -> String {
    let filename_hint = infer_filename_hint_from_source_input(source_input);
    if filename_hint.trim().is_empty() {
        return String::new();
    }
    title_from_filename_token(&strip_file_extension(&filename_hint))
}

fn percent_decode_path_component(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%'
            && index + 2 < raw.len()
            && let Ok(hex) = std::str::from_utf8(&raw[index + 1..index + 3])
            && let Ok(decoded) = u8::from_str_radix(hex, 16)
        {
            bytes.push(decoded);
            index += 3;
            continue;
        }
        if raw[index] == b'+' {
            bytes.push(b' ');
        } else {
            bytes.push(raw[index]);
        }
        index += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_owned())
}

pub async fn subtitles_vtt_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let input = params.get("input").cloned().unwrap_or_default();
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let subtitle_stream_index = params
        .get("subtitleStream")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state
        .media
        .create_subtitle_vtt_response(&input, subtitle_stream_index)
        .await
}

pub async fn subtitles_external_vtt_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let download_url = params.get("download").cloned().unwrap_or_default();
    if download_url.trim().is_empty() {
        return Err(ApiError::bad_request("Missing download query parameter."));
    }
    state
        .media
        .create_external_subtitle_vtt_response(&download_url)
        .await
}

pub async fn subtitles_opensubtitles_vtt_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    let file_id = params
        .get("fileId")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    state.media.create_opensubtitles_vtt_response(file_id).await
}

fn absolute_request_url(state: &AppState, uri: &Uri) -> AppResult<Url> {
    absolute_request_url_with_authority(uri, None, &state.config.host, state.config.port)
}

fn absolute_request_url_with_authority(
    uri: &Uri,
    authority: Option<String>,
    default_host: &str,
    default_port: u16,
) -> AppResult<Url> {
    let authority = authority.unwrap_or_else(|| format!("{default_host}:{default_port}"));
    Url::parse(&format!("http://{authority}{uri}"))
        .map_err(|error| ApiError::internal(error.to_string()))
}

// ── Auth / User route handlers ────────────────────────────────────────

const SESSION_MAX_AGE_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days
const SIGNUP_CLOSED_MESSAGE: &str = "Sign-up is closed. Ask the app owner for access.";

/// Returns whether an allowed registration should become the configured
/// bootstrap administrator. A bootstrap address must also present the invite
/// code, even when public signup is open, so the address cannot be preempted by
/// someone who merely knows it. `None` means registration is closed for this
/// request. This deliberately has no "first user" exception.
fn signup_admin_status(
    open_signup: bool,
    configured_invite: &str,
    supplied_invite: &str,
    bootstrap_email: Option<&str>,
    email: &str,
) -> Option<bool> {
    let valid_invite = !configured_invite.is_empty() && supplied_invite == configured_invite;
    if bootstrap_email.is_some_and(|configured| configured == email) {
        return valid_invite.then_some(true);
    }
    (open_signup || valid_invite).then_some(false)
}

fn set_session_cookie(token: &str, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "session={token}; HttpOnly{secure_attr}; SameSite=Lax; Path=/; Max-Age={SESSION_MAX_AGE_SECONDS}"
    )
}

fn clear_session_cookie(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("session=; HttpOnly{secure_attr}; SameSite=Lax; Path=/; Max-Age=0")
}

async fn auth_signup_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    // Captured before the body is consumed below; used for per-IP rate limiting.
    let client_ip = extract_client_ip(&request);
    let payload = parse_json_body(request).await?;
    let email = payload
        .get("email")
        .or_else(|| payload.get("username"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .to_owned();
    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let display_name = payload
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let invite_code = payload
        .get("inviteCode")
        .or_else(|| payload.get("signupInviteCode"))
        .or_else(|| payload.get("invite_code"))
        .or_else(|| payload.get("invite"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();

    if !is_valid_email(&email) {
        return Err(ApiError::bad_request("Enter a valid email address."));
    }
    if password.len() < 6 || password.len() > 256 {
        return Err(ApiError::bad_request("Password must be 6-256 characters."));
    }
    if display_name.is_empty() || display_name.len() > 64 {
        return Err(ApiError::bad_request(
            "Display name must be 1-64 characters.",
        ));
    }

    // Rate-limit per client IP, not globally: the old single "signup:global" key
    // capped the entire site to 12 signups per 15 minutes, which a real signup
    // surge hits immediately. Per-IP stops a single source flooding accounts
    // while letting many distinct users through; the generous global backstop
    // only trips on egregious distributed abuse.
    if !state
        .auth_rate_limiter
        .check_and_record(&format!("signup:{client_ip}"))
        || !state
            .signup_global_rate_limiter
            .check_and_record("signup:global")
    {
        return Err(ApiError::too_many_requests(
            "Too many sign-up attempts right now. Please wait and try again.",
        ));
    }

    let bootstrap_admin_email = config::bootstrap_admin_email();
    let is_bootstrap_admin = signup_admin_status(
        state.config.open_signup_enabled,
        &state.config.signup_invite_code,
        &invite_code,
        bootstrap_admin_email.as_deref(),
        &email,
    )
    .ok_or_else(|| ApiError::forbidden(SIGNUP_CLOSED_MESSAGE))?;

    if state.db.get_user_by_email(email.clone()).await?.is_some() {
        return Err(ApiError::bad_request("Email already in use."));
    }

    let password_hash = auth::hash_password_async(password)
        .await
        .map_err(ApiError::internal)?;

    let user_id = if is_bootstrap_admin {
        state
            .db
            .create_bootstrap_admin(
                email.clone(),
                password_hash,
                display_name.clone(),
                bootstrap_admin_email.unwrap_or_default(),
            )
            .await?
            .ok_or_else(|| ApiError::forbidden(SIGNUP_CLOSED_MESSAGE))?
    } else {
        state
            .db
            .create_user(email.clone(), password_hash, display_name.clone())
            .await?
    };

    let token = auth::generate_session_token();
    let expires_at = now_ms() + SESSION_MAX_AGE_SECONDS * 1000;
    state
        .db
        .create_session(token.clone(), user_id, expires_at)
        .await?;

    // Soft email verification: issue a single-use token and email a confirmation
    // link. Best-effort — a delivery problem must never fail sign-up. The user is
    // logged in immediately and nudged to verify by a banner in the app.
    let raw_token = auth::generate_session_token();
    let verify_expires_at = now_ms() + crate::email::VERIFY_TOKEN_TTL_MS;
    match state
        .db
        .create_email_verification_token(
            user_id,
            crate::email::sha256_hex(&raw_token),
            verify_expires_at,
        )
        .await
    {
        Ok(()) => {
            let send_state = state.clone();
            let send_email = email.clone();
            tokio::spawn(async move {
                crate::email::send_verification_email(&send_state, &send_email, &raw_token).await;
            });
        }
        Err(error) => {
            tracing::error!("failed to store email verification token: {error:?}");
        }
    }

    let mut response = json_response(json!({
        "ok": true,
        "user": {
            "id": user_id,
            "email": email,
            "displayName": display_name,
            "emailVerified": false,
            "isAdmin": is_bootstrap_admin
        }
    }));
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        set_session_cookie(&token, state.config.session_cookie_secure)
            .parse()
            .map_err(|_| ApiError::internal("Failed to build session cookie."))?,
    );
    Ok(response)
}

async fn auth_login_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let payload = parse_json_body(request).await?;
    let email = payload
        .get("email")
        .or_else(|| payload.get("username"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .to_owned();
    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    if email.is_empty() || password.is_empty() {
        return Err(ApiError::bad_request("Email and password are required."));
    }

    if !state
        .auth_rate_limiter
        .check_and_record(&format!("login:{}", email))
    {
        return Err(ApiError::too_many_requests(
            "Too many login attempts. Please wait and try again.",
        ));
    }

    let (user_id, db_email, password_hash, display_name) = state
        .db
        .get_user_by_email(email.clone())
        .await?
        .ok_or_else(|| ApiError::unauthorized("Invalid email or password."))?;

    if !auth::verify_password_async(password, password_hash).await {
        return Err(ApiError::unauthorized("Invalid email or password."));
    }

    if let Some((_, _, _, _, is_disabled)) = state.db.get_auth_user(user_id).await?
        && is_disabled
    {
        return Err(ApiError::forbidden("This account has been disabled."));
    }

    let token = auth::generate_session_token();
    let expires_at = now_ms() + SESSION_MAX_AGE_SECONDS * 1000;
    state
        .db
        .create_session(token.clone(), user_id, expires_at)
        .await?;

    let mut response = json_response(json!({
        "ok": true,
        "user": {
            "id": user_id,
            "email": db_email,
            "displayName": display_name
        }
    }));
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        set_session_cookie(&token, state.config.session_cookie_secure)
            .parse()
            .map_err(|_| ApiError::internal("Failed to build session cookie."))?,
    );
    Ok(response)
}

async fn auth_logout_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    if let Some(token) = auth::extract_session_token(&headers) {
        state.db.delete_session(token).await?;
    }
    let mut response = json_response(json!({ "ok": true }));
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        clear_session_cookie(state.config.session_cookie_secure)
            .parse()
            .map_err(|_| ApiError::internal("Failed to build session cookie."))?,
    );
    Ok(response)
}

async fn auth_me_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    let user = auth::require_auth(&state.db, &headers).await?;
    let email_verified = state.db.email_verified_at(user.id).await?.is_some();
    Ok(json_response(json!({
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "emailVerified": email_verified,
        "isAdmin": user.is_admin
    })))
}

fn redirect_response(location: &str) -> AppResult<Response<Body>> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(axum::http::header::LOCATION, location)
        .body(Body::empty())
        .map_err(|_| ApiError::internal("Failed to build redirect response."))
}

/// Confirms an email-verification link clicked from the inbox. The token is
/// single-use; the outcome is communicated to the SPA via `?verified=` so it can
/// show a notice. Always redirects (never returns a bare error page).
async fn auth_verify_handler(
    State(state): State<AppState>,
    AxumPath(raw_token): AxumPath<String>,
) -> AppResult<Response<Body>> {
    let outcome = match state
        .db
        .consume_email_verification_token(crate::email::sha256_hex(raw_token.trim()))
        .await?
    {
        None => "invalid",
        Some((user_id, expires_at)) => {
            if expires_at <= now_ms() {
                "expired"
            } else {
                state.db.mark_email_verified(user_id, now_ms()).await?;
                "success"
            }
        }
    };
    let app_origin = crate::provider_registry::resolve(
        crate::provider_registry::keys::INFRA_APP_ORIGIN,
        &state.config.app_origin,
    );
    redirect_response(&format!("{}/?verified={}", app_origin, outcome))
}

/// Re-sends the verification email for the signed-in user. Rate-limited and
/// intentionally generic (always `{ ok: true }`) so it reveals nothing about
/// account state.
async fn auth_resend_verification_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let user = auth::require_auth(&state.db, &headers).await?;

    if !state
        .auth_rate_limiter
        .check_and_record(&format!("verify-resend:{}", user.id))
    {
        return Err(ApiError::too_many_requests(
            "Too many verification emails requested. Please wait and try again.",
        ));
    }

    // Only (re)send while the account is still unverified.
    if state.db.email_verified_at(user.id).await?.is_none() {
        let raw_token = auth::generate_session_token();
        let verify_expires_at = now_ms() + crate::email::VERIFY_TOKEN_TTL_MS;
        match state
            .db
            .create_email_verification_token(
                user.id,
                crate::email::sha256_hex(&raw_token),
                verify_expires_at,
            )
            .await
        {
            Ok(()) => {
                crate::email::send_verification_email(&state, &user.email, &raw_token).await;
            }
            Err(error) => {
                tracing::error!("failed to store resend verification token: {error:?}");
            }
        }
    }

    Ok(json_response(json!({ "ok": true })))
}

/// Begin a password reset. If the email maps to an account, issue a single-use
/// token and email a reset link. Always returns `{ ok: true }` (even for
/// unknown addresses) so it never reveals whether an email is registered.
async fn auth_forgot_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let payload = parse_json_body(request).await?;
    let email = payload
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if email.is_empty() {
        return Err(ApiError::bad_request("Email is required."));
    }

    if !state
        .auth_rate_limiter
        .check_and_record(&format!("forgot:{email}"))
    {
        return Err(ApiError::too_many_requests(
            "Too many reset requests. Please wait and try again.",
        ));
    }

    // Act only for real accounts, but always respond identically.
    if let Some((user_id, _, _, _)) = state.db.get_user_by_email(email.clone()).await? {
        let raw_token = auth::generate_session_token();
        let reset_expires_at = now_ms() + crate::email::RESET_TOKEN_TTL_MS;
        match state
            .db
            .create_password_reset_token(
                user_id,
                crate::email::sha256_hex(&raw_token),
                reset_expires_at,
            )
            .await
        {
            Ok(()) => {
                let send_state = state.clone();
                let send_email = email.clone();
                tokio::spawn(async move {
                    crate::email::send_password_reset_email(&send_state, &send_email, &raw_token)
                        .await;
                });
            }
            Err(error) => {
                tracing::error!("failed to store password reset token: {error:?}");
            }
        }
    }

    Ok(json_response(json!({ "ok": true })))
}

/// Complete a password reset: validate the single-use token, set the new
/// password, and invalidate the user's existing sessions.
async fn auth_reset_handler(
    State(state): State<AppState>,
    method: Method,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    if method != Method::POST {
        return Err(ApiError::method_not_allowed(
            "Method not allowed. Use POST.",
        ));
    }
    let payload = parse_json_body(request).await?;
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token.is_empty() {
        return Err(ApiError::bad_request("Missing reset token."));
    }
    if password.chars().count() < 6 {
        return Err(ApiError::bad_request(
            "Password must be at least 6 characters.",
        ));
    }

    let (user_id, expires_at) = state
        .db
        .consume_password_reset_token(crate::email::sha256_hex(&token))
        .await?
        .ok_or_else(|| {
            ApiError::bad_request("This reset link is invalid or has already been used.")
        })?;
    if expires_at <= now_ms() {
        return Err(ApiError::bad_request("This reset link has expired."));
    }

    let hash = auth::hash_password_async(password.to_string())
        .await
        .map_err(ApiError::internal)?;
    let changed = state.db.set_password_by_user_id(user_id, hash).await?;
    if changed == 0 {
        return Err(ApiError::bad_request("This reset link is no longer valid."));
    }

    Ok(json_response(json!({ "ok": true })))
}

fn is_valid_email(value: &str) -> bool {
    if value.is_empty() || value.len() > 254 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || domain.len() > 253
        || domain.starts_with('.')
        || domain.ends_with('.')
        || !domain.contains('.')
    {
        return false;
    }
    domain.split('.').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })
}

fn is_secret_user_preference_key(key: &str) -> bool {
    key.trim().eq_ignore_ascii_case(REAL_DEBRID_TOKEN_PREF_KEY)
}

fn bounded_trimmed_string(value: &str, max_bytes: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes {
        return None;
    }
    Some(trimmed.to_owned())
}

fn bounded_string_field(payload: &Value, field: &str, max_bytes: usize) -> Option<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .and_then(|value| bounded_trimmed_string(value, max_bytes))
}

fn require_bounded_string_field(
    payload: &Value,
    field: &str,
    max_bytes: usize,
) -> AppResult<String> {
    bounded_string_field(payload, field, max_bytes).ok_or_else(|| {
        ApiError::bad_request(format!(
            "Missing or invalid {field}; limit is {max_bytes} bytes."
        ))
    })
}

fn normalize_resume_seconds_value(value: Option<&Value>) -> f64 {
    let seconds = value.and_then(Value::as_f64).unwrap_or(0.0);
    if seconds.is_finite() {
        seconds.clamp(0.0, MAX_RESUME_SECONDS)
    } else {
        0.0
    }
}

fn normalize_user_updated_at(value: Option<&Value>) -> i64 {
    let now = now_ms();
    let candidate = value.and_then(Value::as_i64).unwrap_or(now);
    if candidate <= 0 {
        return now;
    }
    // Cap future timestamps so a device with a wrong clock can't report a
    // year-3000 time and permanently win last-write-wins progress merges. Past
    // values are left untouched — they simply lose to newer entries.
    const MAX_FUTURE_SKEW_MS: i64 = 24 * 60 * 60 * 1000;
    candidate.min(now + MAX_FUTURE_SKEW_MS)
}

fn insert_bounded_string(
    object: &mut serde_json::Map<String, Value>,
    source: &Value,
    field: &str,
    max_bytes: usize,
) {
    if let Some(value) = bounded_string_field(source, field, max_bytes) {
        object.insert(field.to_owned(), Value::String(value));
    }
}

fn insert_bounded_i64(
    object: &mut serde_json::Map<String, Value>,
    source: &Value,
    field: &str,
    min: i64,
    max: i64,
) {
    if let Some(value) = source
        .get(field)
        .and_then(Value::as_i64)
        .map(|value| value.clamp(min, max))
    {
        object.insert(field.to_owned(), Value::Number(value.into()));
    }
}

fn user_preference_entries_from_object(
    prefs: &serde_json::Map<String, Value>,
) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for (key, value) in prefs {
        if entries.len() >= USER_PREF_MAX_ENTRIES || is_secret_user_preference_key(key) {
            continue;
        }
        let Some(key) = bounded_trimmed_string(key, USER_PREF_KEY_MAX_BYTES) else {
            continue;
        };
        let val = match value {
            Value::String(text) => text.trim().to_owned(),
            other => other.to_string(),
        };
        if val.len() > USER_PREF_VALUE_MAX_BYTES {
            continue;
        }
        entries.push((key, val));
    }
    entries
}

fn sanitize_watch_progress_entry(
    entry: &Value,
    fallback_source_identity: Option<&str>,
) -> Option<Value> {
    let source_identity = bounded_string_field(entry, "sourceIdentity", USER_IDENTITY_MAX_BYTES)
        .or_else(|| {
            fallback_source_identity
                .and_then(|value| bounded_trimmed_string(value, USER_IDENTITY_MAX_BYTES))
        })?;
    Some(json!({
        "sourceIdentity": source_identity,
        "resumeSeconds": normalize_resume_seconds_value(entry.get("resumeSeconds").or(Some(entry))),
        "updatedAt": normalize_user_updated_at(entry.get("updatedAt"))
    }))
}

fn sanitize_continue_watching_entry(
    entry: &Value,
    fallback_source_identity: Option<&str>,
) -> Option<Value> {
    let source_identity = bounded_string_field(entry, "sourceIdentity", USER_IDENTITY_MAX_BYTES)
        .or_else(|| {
            fallback_source_identity
                .and_then(|value| bounded_trimmed_string(value, USER_IDENTITY_MAX_BYTES))
        })?;
    let mut object = serde_json::Map::new();
    object.insert("sourceIdentity".to_owned(), Value::String(source_identity));
    for field in [
        "title",
        "episode",
        "tmdbId",
        "mediaType",
        "seriesId",
        "year",
        "sourceHash",
        "sessionKey",
        "resolverProvider",
        "filename",
    ] {
        insert_bounded_string(&mut object, entry, field, USER_SMALL_TEXT_MAX_BYTES);
    }
    for field in ["src", "thumb", "sourceInput"] {
        insert_bounded_string(&mut object, entry, field, USER_URL_MAX_BYTES);
    }
    insert_bounded_i64(&mut object, entry, "episodeIndex", -1, 1_000_000);
    object.insert(
        "resumeSeconds".to_owned(),
        json!(normalize_resume_seconds_value(
            entry.get("resumeSeconds").or(Some(entry))
        )),
    );
    Some(Value::Object(object))
}

fn sanitize_my_list_entry(entry: &Value) -> Option<Value> {
    let item_identity = bounded_string_field(entry, "itemIdentity", USER_IDENTITY_MAX_BYTES)?;
    let mut object = serde_json::Map::new();
    object.insert("itemIdentity".to_owned(), Value::String(item_identity));
    for field in [
        "title",
        "episode",
        "tmdbId",
        "mediaType",
        "seriesId",
        "year",
        "libraryType",
        "libraryId",
    ] {
        insert_bounded_string(&mut object, entry, field, USER_SMALL_TEXT_MAX_BYTES);
    }
    for field in ["src", "thumb", "librarySrc"] {
        insert_bounded_string(&mut object, entry, field, USER_URL_MAX_BYTES);
    }
    insert_bounded_i64(&mut object, entry, "episodeIndex", -1, 1_000_000);
    object.insert(
        "addedAt".to_owned(),
        Value::Number(normalize_user_updated_at(entry.get("addedAt")).into()),
    );
    Some(Value::Object(object))
}

fn sanitize_my_list_entries(entries: &[Value]) -> Vec<Value> {
    entries
        .iter()
        .take(USER_SYNC_MAX_ENTRIES)
        .filter_map(sanitize_my_list_entry)
        .collect()
}

fn normalize_bool_preference(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on" | "enabled"
    )
}

fn normalize_real_debrid_api_key(value: &str) -> String {
    value.trim().to_owned()
}

fn is_valid_real_debrid_api_key(value: &str) -> bool {
    let normalized = normalize_real_debrid_api_key(value);
    if normalized.len() < 16 || normalized.len() > 512 {
        return false;
    }
    if normalized.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = normalized.to_lowercase();
    !matches!(
        lower.as_str(),
        "your_real_debrid_api_token_here" | "real_debrid_token" | "test" | "demo"
    )
}

fn mask_real_debrid_api_key(value: &str) -> String {
    let normalized = normalize_real_debrid_api_key(value);
    if normalized.is_empty() {
        return String::new();
    }
    if normalized.len() <= 10 {
        return "****".to_owned();
    }
    format!(
        "{}****{}",
        &normalized[..4],
        &normalized[normalized.len().saturating_sub(4)..]
    )
}

async fn real_debrid_api_key_for_user(state: &AppState, user_id: i64) -> AppResult<String> {
    let Some(stored_value) = state
        .db
        .get_user_preference(user_id, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
        .await?
    else {
        return Ok(String::new());
    };
    let value = state
        .real_debrid_token_cipher
        .decrypt_for_user(user_id, &stored_value)?;
    let normalized = normalize_real_debrid_api_key(&value);
    Ok(if is_valid_real_debrid_api_key(&normalized) {
        normalized
    } else {
        String::new()
    })
}

async fn local_torrent_enabled_for_user(db: &Db, user_id: i64) -> AppResult<bool> {
    Ok(db
        .get_user_preference(user_id, LOCAL_TORRENT_ENABLED_PREF_KEY.to_owned())
        .await?
        .map(|value| normalize_bool_preference(&value))
        .unwrap_or(false))
}

fn real_debrid_api_key_required_error() -> ApiError {
    ApiError::failed_dependency("Add a Real-Debrid API key in Settings to use this cached source.")
}

fn local_torrent_required_error() -> ApiError {
    ApiError::failed_dependency("Enable Torrent streaming in Settings to use magnet sources.")
}

async fn user_preferences_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let prefs = state.db.get_user_preferences(user.id).await?;
            let mut obj = serde_json::Map::new();
            for (key, value) in prefs {
                if is_secret_user_preference_key(&key) {
                    continue;
                }
                obj.insert(key, Value::String(value));
            }
            Ok(json_response(Value::Object(obj)))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let entries: Vec<(String, String)> = match payload.as_object() {
                Some(obj) => user_preference_entries_from_object(obj),
                None => {
                    return Err(ApiError::bad_request("Body must be a JSON object."));
                }
            };
            state.db.upsert_user_preferences(user.id, entries).await?;
            Ok(json_response(json!({ "ok": true })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET or PUT.",
        )),
    }
}

async fn user_real_debrid_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let api_key = real_debrid_api_key_for_user(&state, user.id).await?;
            let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
            Ok(json_response(json!({
                "configured": !api_key.is_empty(),
                "maskedApiKey": mask_real_debrid_api_key(&api_key),
                "localTorrentEnabled": local_torrent_enabled
            })))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let api_key_value = payload
                .get("apiKey")
                .or_else(|| payload.get("token"))
                .or_else(|| payload.get("realDebridApiKey"));
            let has_api_key_field = api_key_value.is_some();
            let api_key = api_key_value
                .and_then(Value::as_str)
                .map(normalize_real_debrid_api_key)
                .unwrap_or_default();

            if has_api_key_field {
                if api_key.is_empty() {
                    state
                        .db
                        .delete_user_preference(user.id, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
                        .await?;
                } else {
                    if !is_valid_real_debrid_api_key(&api_key) {
                        return Err(ApiError::bad_request(
                            "Enter a valid Real-Debrid API token from Settings > API token.",
                        ));
                    }

                    let encrypted_api_key = state
                        .real_debrid_token_cipher
                        .encrypt_for_user(user.id, &api_key)?;
                    state
                        .db
                        .upsert_user_preferences(
                            user.id,
                            vec![(REAL_DEBRID_TOKEN_PREF_KEY.to_owned(), encrypted_api_key)],
                        )
                        .await?;
                }
            }

            if let Some(value) = payload.get("localTorrentEnabled") {
                let enabled = match value {
                    Value::Bool(value) => *value,
                    Value::String(value) => normalize_bool_preference(value),
                    Value::Number(value) => value.as_i64().unwrap_or_default() != 0,
                    _ => false,
                };
                state
                    .db
                    .upsert_user_preferences(
                        user.id,
                        vec![(
                            LOCAL_TORRENT_ENABLED_PREF_KEY.to_owned(),
                            if enabled { "1" } else { "0" }.to_owned(),
                        )],
                    )
                    .await?;
            }

            let saved_api_key = real_debrid_api_key_for_user(&state, user.id).await?;
            let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
            Ok(json_response(json!({
                "ok": true,
                "configured": !saved_api_key.is_empty(),
                "maskedApiKey": mask_real_debrid_api_key(&saved_api_key),
                "localTorrentEnabled": local_torrent_enabled
            })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET or PUT.",
        )),
    }
}

async fn user_watch_progress_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let progress = state.db.get_user_watch_progress(user.id).await?;
            let entries: Vec<Value> = progress
                .into_iter()
                .map(|(source_identity, resume_seconds, updated_at)| {
                    json!({
                        "sourceIdentity": source_identity,
                        "resumeSeconds": resume_seconds,
                        "updatedAt": updated_at
                    })
                })
                .collect();
            Ok(json_response(json!({ "entries": entries })))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let source_identity =
                require_bounded_string_field(&payload, "sourceIdentity", USER_IDENTITY_MAX_BYTES)?;
            let resume_seconds = normalize_resume_seconds_value(payload.get("resumeSeconds"));
            state
                .db
                .upsert_user_watch_progress(user.id, source_identity, resume_seconds, now_ms())
                .await?;
            Ok(json_response(json!({ "ok": true })))
        }
        Method::DELETE => {
            let payload = parse_json_body(request).await?;
            let source_identity =
                require_bounded_string_field(&payload, "sourceIdentity", USER_IDENTITY_MAX_BYTES)?;
            let series_id = payload
                .get("seriesId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_else(|| extract_series_id_from_source_identity(&source_identity));
            if !series_id.is_empty() {
                state
                    .db
                    .delete_user_watch_progress_for_series(user.id, series_id)
                    .await?;
                return Ok(json_response(json!({ "ok": true })));
            }
            state
                .db
                .delete_user_watch_progress(user.id, source_identity)
                .await?;
            Ok(json_response(json!({ "ok": true })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET, PUT, or DELETE.",
        )),
    }
}

async fn user_continue_watching_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let entries = state.db.get_user_continue_watching(user.id).await?;
            Ok(json_response(json!({ "entries": entries })))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let payload = sanitize_continue_watching_entry(&payload, None).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "Missing or invalid sourceIdentity; limit is {USER_IDENTITY_MAX_BYTES} bytes."
                ))
            })?;
            state
                .db
                .upsert_user_continue_watching(user.id, payload)
                .await?;
            Ok(json_response(json!({ "ok": true })))
        }
        Method::DELETE => {
            let payload = parse_json_body(request).await?;
            let source_identity =
                require_bounded_string_field(&payload, "sourceIdentity", USER_IDENTITY_MAX_BYTES)?;
            let series_id = payload
                .get("seriesId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_else(|| extract_series_id_from_source_identity(&source_identity));
            if !series_id.is_empty() {
                state
                    .db
                    .delete_user_continue_watching_for_series(user.id, series_id.clone())
                    .await?;
                state
                    .db
                    .delete_user_watch_progress_for_series(user.id, series_id)
                    .await?;
                return Ok(json_response(json!({ "ok": true })));
            }
            state
                .db
                .delete_user_continue_watching(user.id, source_identity.clone())
                .await?;
            state
                .db
                .delete_user_watch_progress(user.id, source_identity)
                .await?;
            Ok(json_response(json!({ "ok": true })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET, PUT, or DELETE.",
        )),
    }
}

/// Log a live-watch event (sports / live channel). Live playback has no resume
/// position so it never lands in continue-watching; this records it for the admin
/// activity feed + top-live panel. The player dedupes per session.
async fn user_live_watch_handler(
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
    let user = auth::require_auth(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let title: String = payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect();
    if title.is_empty() {
        return Err(ApiError::bad_request("title is required."));
    }
    let category: String = payload
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(40)
        .collect();
    let source_identity: String = payload
        .get("sourceIdentity")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();
    state
        .db
        .record_live_watch(user.id, title, category, source_identity)
        .await?;
    Ok(json_response(json!({ "ok": true })))
}

async fn user_my_list_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let entries = state.db.get_user_my_list(user.id).await?;
            Ok(json_response(json!({ "entries": entries })))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let entries = payload
                .get("entries")
                .and_then(Value::as_array)
                .ok_or_else(|| ApiError::bad_request("Body must include an entries array."))?;
            if entries.len() > USER_SYNC_MAX_ENTRIES {
                return Err(ApiError::bad_request(format!(
                    "My List can contain at most {USER_SYNC_MAX_ENTRIES} entries."
                )));
            }
            let entries = sanitize_my_list_entries(entries);
            state.db.replace_user_my_list(user.id, entries).await?;
            Ok(json_response(json!({ "ok": true })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET or PUT.",
        )),
    }
}

fn normalize_sync_watch_progress_entries(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .take(USER_SYNC_MAX_ENTRIES)
            .filter_map(|entry| sanitize_watch_progress_entry(entry, None))
            .collect(),
        Some(Value::Object(entries)) => entries
            .iter()
            .take(USER_SYNC_MAX_ENTRIES)
            .filter_map(|(source_identity, entry)| {
                sanitize_watch_progress_entry(entry, Some(source_identity))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_sync_continue_watching_entries(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .take(USER_SYNC_MAX_ENTRIES)
            .filter_map(|entry| sanitize_continue_watching_entry(entry, None))
            .collect(),
        Some(Value::Object(entries)) => entries
            .iter()
            .take(USER_SYNC_MAX_ENTRIES)
            .filter_map(|(source_identity, entry)| {
                sanitize_continue_watching_entry(entry, Some(source_identity))
            })
            .collect(),
        _ => Vec::new(),
    }
}

async fn user_sync_handler(
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
    let user = auth::require_auth(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;

    // Preferences
    if let Some(prefs) = payload.get("preferences").and_then(Value::as_object) {
        let entries = user_preference_entries_from_object(prefs);
        if !entries.is_empty() {
            state.db.upsert_user_preferences(user.id, entries).await?;
        }
    }

    // Watch progress
    let progress_entries = normalize_sync_watch_progress_entries(payload.get("watchProgress"));
    if !progress_entries.is_empty() {
        for entry in &progress_entries {
            let source_identity = entry
                .get("sourceIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if source_identity.is_empty() {
                continue;
            }
            let resume_seconds = entry
                .get("resumeSeconds")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let updated_at = entry
                .get("updatedAt")
                .and_then(Value::as_i64)
                .unwrap_or_else(now_ms);
            state
                .db
                .upsert_user_watch_progress(user.id, source_identity, resume_seconds, updated_at)
                .await?;
        }
    }

    // Continue watching
    let continue_watching_entries =
        normalize_sync_continue_watching_entries(payload.get("continueWatching"));
    if !continue_watching_entries.is_empty() {
        for entry in &continue_watching_entries {
            let source_identity = entry
                .get("sourceIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if source_identity.is_empty() {
                continue;
            }
            state
                .db
                .upsert_user_continue_watching(user.id, entry.clone())
                .await?;
        }
    }

    // My list
    if let Some(my_list_arr) = payload.get("myList").and_then(Value::as_array) {
        let mut merged_entries = state.db.get_user_my_list(user.id).await?;
        if merged_entries.len() > USER_SYNC_MAX_ENTRIES {
            merged_entries.truncate(USER_SYNC_MAX_ENTRIES);
        }
        let mut known_identities = BTreeMap::new();
        for entry in &merged_entries {
            let item_identity = entry
                .get("itemIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !item_identity.is_empty() {
                known_identities.insert(item_identity, true);
            }
        }
        for entry in my_list_arr
            .iter()
            .take(USER_SYNC_MAX_ENTRIES)
            .filter_map(sanitize_my_list_entry)
        {
            let item_identity = entry
                .get("itemIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if item_identity.is_empty()
                || known_identities.contains_key(&item_identity)
                || merged_entries.len() >= USER_SYNC_MAX_ENTRIES
            {
                continue;
            }
            known_identities.insert(item_identity, true);
            merged_entries.push(entry);
        }
        state
            .db
            .replace_user_my_list(user.id, merged_entries)
            .await?;
    }

    Ok(json_response(json!({ "ok": true })))
}

/// Store a feedback message from the signed-in user. Surfaced in the admin
/// dashboard via `GET /api/admin/feedback`.
async fn feedback_submit_handler(
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
    let user = auth::require_auth(&state.db, &headers).await?;
    let payload = parse_json_body(request).await?;
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if message.is_empty() {
        return Err(ApiError::bad_request("Feedback message is required."));
    }
    // Cap length so a single submission can't bloat the DB.
    let message = message.chars().take(4000).collect::<String>();
    // Optional screenshot, sent as a `data:image/...;base64,…` URL. The client
    // downscales before upload; we still validate + size-cap server-side.
    let (image_data, image_mime) = match payload.get("image").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => {
            let (bytes, mime) = decode_data_url_image(raw.trim())?;
            (Some(bytes), mime)
        }
        _ => (None, String::new()),
    };
    state
        .db
        .insert_feedback(
            user.id,
            user.email.clone(),
            user.display_name.clone(),
            message,
            image_data,
            image_mime,
        )
        .await?;
    Ok(json_response(json!({ "ok": true })))
}

/// Decoded feedback attachments are capped well under the 4 MiB JSON body limit
/// (which already bounds the base64-inflated payload); this is a safety net.
const FEEDBACK_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Parse a `data:<mime>;base64,<data>` image URL into `(bytes, mime)`. The mime
/// is restricted to a raster-image allowlist — notably this rejects SVG, which
/// can carry script and would otherwise be served back inline to the admin.
fn decode_data_url_image(raw: &str) -> AppResult<(Vec<u8>, String)> {
    use base64::Engine as _;
    const ALLOWED: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    let rest = raw
        .strip_prefix("data:")
        .ok_or_else(|| ApiError::bad_request("Attachment must be a data URL."))?;
    let (mime, b64) = rest
        .split_once(";base64,")
        .ok_or_else(|| ApiError::bad_request("Attachment must be base64-encoded."))?;
    let mime = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !ALLOWED.contains(&mime.as_str()) {
        return Err(ApiError::bad_request("Unsupported image type."));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| ApiError::bad_request("Attachment is not valid base64."))?;
    if bytes.is_empty() {
        return Err(ApiError::bad_request("Attachment is empty."));
    }
    if bytes.len() > FEEDBACK_IMAGE_MAX_BYTES {
        return Err(ApiError::payload_too_large("Attachment is too large."));
    }
    Ok((bytes, mime))
}

fn query_pairs(query: &str) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn query_flag_enabled(query: &str, name: &str) -> bool {
    query_pairs(query).get(name).is_some_and(|value| {
        let normalized = value.trim();
        normalized == "1" || normalized.eq_ignore_ascii_case("true")
    })
}

fn is_numeric_id(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn normalize_media_type_param(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("tv") {
        "tv".to_owned()
    } else {
        "movie".to_owned()
    }
}

fn build_playback_session_key(tmdb_id: &str, audio_lang: &str, quality: &str) -> String {
    format!(
        "{}:{}:{}",
        tmdb_id.trim(),
        normalize_preferred_audio_lang(audio_lang),
        normalize_preferred_stream_quality(quality)
    )
}

fn build_playback_session_payload(session: crate::persistence::PlaybackSession) -> Value {
    json!({
        "key": session.session_key,
        "sourceHash": session.source_hash,
        "selectedFile": session.selected_file,
        "quality": normalize_preferred_stream_quality(&session.preferred_quality),
        "lastPositionSeconds": session.last_position_seconds,
        "health": {
            "state": session.health_state,
            "failCount": session.health_fail_count,
            "lastError": session.last_error
        }
    })
}

async fn resolve_effective_preferred_audio_lang(
    state: &AppState,
    user_id: i64,
    media_type: &str,
    tmdb_id: &str,
    preferred_audio_lang: &str,
) -> AppResult<String> {
    let normalized = normalize_preferred_audio_lang(preferred_audio_lang);
    if normalized != "auto" {
        return Ok(normalized);
    }
    let preference = state
        .db
        .get_title_preference(
            user_id,
            normalize_media_type_param(media_type),
            tmdb_id.to_owned(),
        )
        .await?;
    let preferred = preference
        .map(|value| normalize_preferred_audio_lang(&value.audioLang))
        .unwrap_or_else(|| "auto".to_owned());
    if preferred == "auto" {
        Ok("auto".to_owned())
    } else {
        Ok(preferred)
    }
}

fn extract_series_id_from_source_identity(source_identity: &str) -> String {
    let Some(rest) = source_identity.trim().strip_prefix("series:") else {
        return String::new();
    };
    let Some((series_id, _episode_suffix)) = rest.split_once(":episode:") else {
        return String::new();
    };
    series_id.trim().to_ascii_lowercase()
}

async fn infer_upload_metadata(state: &AppState, file_name: &str) -> AppResult<Value> {
    let inferred = infer_upload_metadata_from_filename_heuristic(file_name);
    enrich_inference_with_tmdb(state, inferred, file_name).await
}

fn infer_upload_metadata_from_filename_heuristic(file_name: &str) -> Value {
    let raw_base = strip_file_extension(file_name.trim());
    let cleaned = normalize_whitespace(&raw_base);
    let episode_match = find_episode_pattern(&raw_base);
    let has_course_keyword = raw_base.to_lowercase().contains("course")
        || raw_base.to_lowercase().contains("lesson")
        || raw_base.to_lowercase().contains("module")
        || raw_base.to_lowercase().contains("class")
        || raw_base.to_lowercase().contains("lecture")
        || raw_base.to_lowercase().contains("webinar");
    let module_number = capture_keyword_number(&raw_base, "module").unwrap_or(1);
    let lesson_number = ["lesson", "class", "lecture", "webinar"]
        .iter()
        .find_map(|keyword| capture_keyword_number(&raw_base, keyword))
        .unwrap_or_else(|| module_number.max(1));
    let year = extract_year(&raw_base);

    if let Some((series_title, season_number, episode_number)) = episode_match {
        return normalize_inferred_upload_metadata(json!({
            "contentType": "episode",
            "title": series_title,
            "seriesTitle": series_title,
            "seasonNumber": season_number,
            "episodeNumber": episode_number,
            "year": year,
            "confidence": 0.6,
            "reason": "Heuristic SxxExx filename match."
        }));
    }

    if has_course_keyword {
        let raw_title = title_from_filename_token(&raw_base);
        let stripped_for_course_title = raw_base
            .replace("module", " ")
            .replace("lesson", " ")
            .replace("class", " ")
            .replace("lecture", " ")
            .replace("webinar", " ");
        let course_title = title_from_filename_token(&stripped_for_course_title)
            .if_empty_then(|| raw_title.clone())
            .if_empty_then(|| cleaned.clone())
            .if_empty_then(|| "Untitled Course".to_owned());
        let lesson_title =
            if !raw_title.is_empty() && raw_title.to_lowercase() != course_title.to_lowercase() {
                raw_title
            } else {
                format!("Lesson {lesson_number}")
            };
        return normalize_inferred_upload_metadata(json!({
            "contentType": "course",
            "title": course_title,
            "seriesTitle": course_title,
            "seasonNumber": module_number,
            "episodeNumber": lesson_number,
            "episodeTitle": lesson_title,
            "year": year,
            "confidence": 0.55,
            "reason": "Heuristic course filename match."
        }));
    }

    normalize_inferred_upload_metadata(json!({
        "contentType": "movie",
        "title": title_from_filename_token(&raw_base).if_empty_then(|| cleaned),
        "year": year,
        "confidence": 0.4,
        "reason": "Heuristic filename inference."
    }))
}

async fn enrich_inference_with_tmdb(
    state: &AppState,
    base_inference: Value,
    file_name: &str,
) -> AppResult<Value> {
    let mut inferred = normalize_inferred_upload_metadata(base_inference);
    if let Some((series_title, season_number, episode_number)) = find_episode_pattern(file_name) {
        if inferred.get("contentType").and_then(Value::as_str) != Some("course") {
            inferred["contentType"] = Value::String("episode".to_owned());
        }
        let next_series = normalize_whitespace(
            inferred
                .get("seriesTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .if_empty_then(|| {
            normalize_whitespace(
                inferred
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        })
        .if_empty_then(|| series_title.clone());
        inferred["seriesTitle"] = Value::String(next_series.clone());
        inferred["seasonNumber"] = Value::from(season_number);
        inferred["episodeNumber"] = Value::from(episode_number);
        if normalize_whitespace(
            inferred
                .get("episodeTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .is_empty()
        {
            inferred["episodeTitle"] = Value::String(
                if inferred.get("contentType").and_then(Value::as_str) == Some("course") {
                    format!("Lesson {episode_number}")
                } else {
                    format!("Episode {episode_number}")
                },
            );
        }
    }

    if inferred.get("contentType").and_then(Value::as_str) == Some("course") {
        inferred["tmdbId"] = Value::String(String::new());
        return Ok(inferred);
    }

    if state.config.tmdb_api_key.trim().is_empty() {
        let reason = format!(
            "TMDB_API_KEY missing. {}",
            inferred
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )
        .trim()
        .to_owned();
        inferred["reason"] = Value::String(reason);
        return Ok(inferred);
    }

    if inferred.get("contentType").and_then(Value::as_str) == Some("episode") {
        let series_query = normalize_whitespace(
            inferred
                .get("seriesTitle")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .if_empty_then(|| {
            normalize_whitespace(
                inferred
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        })
        .if_empty_then(|| normalize_whitespace(strip_file_extension(file_name)));
        if series_query.is_empty() {
            return Ok(inferred);
        }
        let mut params = BTreeMap::new();
        params.insert("query".to_owned(), series_query.clone());
        params.insert("include_adult".to_owned(), "false".to_owned());
        let tv_search = state.tmdb.fetch("/search/tv", params, 20_000).await?;
        let best_match = choose_best_tmdb_result(
            tv_search.get("results").and_then(Value::as_array),
            &series_query,
            inferred
                .get("year")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if let Some(best_match) = best_match {
            let tmdb_id = stringify_json(best_match.get("id"));
            let series_details = state
                .tmdb
                .fetch(&format!("/tv/{tmdb_id}"), BTreeMap::new(), 20_000)
                .await
                .ok();
            let season_number = inferred
                .get("seasonNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let episode_number = inferred
                .get("episodeNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let episode_details = state
                .tmdb
                .fetch(
                    &format!("/tv/{tmdb_id}/season/{season_number}/episode/{episode_number}"),
                    BTreeMap::new(),
                    20_000,
                )
                .await
                .ok();
            let resolved_series_title = normalize_whitespace(
                series_details
                    .as_ref()
                    .and_then(|value| value.get("name").and_then(Value::as_str))
                    .unwrap_or(&series_query),
            );
            inferred["tmdbId"] = Value::String(tmdb_id.clone());
            inferred["seriesTitle"] = Value::String(resolved_series_title.clone());
            inferred["title"] = Value::String(resolved_series_title);
            inferred["year"] = Value::String(normalize_year(
                series_details
                    .as_ref()
                    .and_then(|value| value.get("first_air_date").and_then(Value::as_str))
                    .or_else(|| best_match.get("first_air_date").and_then(Value::as_str))
                    .unwrap_or_default()
                    .chars()
                    .take(4)
                    .collect::<String>(),
            ));
            if let Some(episode_title) = episode_details
                .as_ref()
                .and_then(|value| value.get("name").and_then(Value::as_str))
            {
                inferred["episodeTitle"] = Value::String(normalize_whitespace(episode_title));
            }
            inferred["confidence"] = Value::from(
                inferred
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    .max(0.9),
            );
            inferred["reason"] = Value::String(
                format!(
                    "TMDB TV match ({}). {}",
                    tmdb_id,
                    inferred
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                )
                .trim()
                .to_owned(),
            );
        }
        return Ok(inferred);
    }

    let movie_query = normalize_whitespace(
        inferred
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .if_empty_then(|| normalize_whitespace(strip_file_extension(file_name)));
    if movie_query.is_empty() {
        return Ok(inferred);
    }
    let mut params = BTreeMap::new();
    params.insert("query".to_owned(), movie_query.clone());
    params.insert("include_adult".to_owned(), "false".to_owned());
    let movie_search = state.tmdb.fetch("/search/movie", params, 20_000).await?;
    if let Some(best_match) = choose_best_tmdb_result(
        movie_search.get("results").and_then(Value::as_array),
        &movie_query,
        inferred
            .get("year")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) {
        let tmdb_id = stringify_json(best_match.get("id"));
        let movie_details = state
            .tmdb
            .fetch(&format!("/movie/{tmdb_id}"), BTreeMap::new(), 20_000)
            .await
            .ok();
        inferred["tmdbId"] = Value::String(tmdb_id.clone());
        inferred["title"] = Value::String(normalize_whitespace(
            movie_details
                .as_ref()
                .and_then(|value| value.get("title").and_then(Value::as_str))
                .or_else(|| best_match.get("title").and_then(Value::as_str))
                .unwrap_or(&movie_query),
        ));
        inferred["year"] = Value::String(normalize_year(
            movie_details
                .as_ref()
                .and_then(|value| value.get("release_date").and_then(Value::as_str))
                .or_else(|| best_match.get("release_date").and_then(Value::as_str))
                .unwrap_or_default()
                .chars()
                .take(4)
                .collect::<String>(),
        ));
        inferred["confidence"] = Value::from(
            inferred
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.9),
        );
        inferred["reason"] = Value::String(
            format!(
                "TMDB Movie match ({}). {}",
                tmdb_id,
                inferred
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
            .trim()
            .to_owned(),
        );
    }
    Ok(inferred)
}

fn normalize_inferred_upload_metadata(value: Value) -> Value {
    let content_type = normalize_upload_content_type(stringify_json(value.get("contentType")));
    let is_series_like = matches!(content_type.as_str(), "episode" | "course");
    let fallback_episode_label = if content_type == "course" {
        "Lesson"
    } else {
        "Episode"
    };
    let tmdb_id = {
        let candidate = stringify_json(value.get("tmdbId"));
        if is_numeric_id(&candidate) {
            candidate
        } else {
            String::new()
        }
    };
    let mut inferred = json!({
        "contentType": content_type,
        "confidence": value.get("confidence").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 1.0),
        "title": normalize_whitespace(stringify_json(value.get("title"))),
        "year": normalize_year(stringify_json(value.get("year"))),
        "seriesTitle": "",
        "seasonNumber": 1,
        "episodeNumber": 1,
        "episodeTitle": "",
        "tmdbId": tmdb_id,
        "reason": normalize_whitespace(stringify_json(value.get("reason")))
    });
    if is_series_like {
        let episode_number = normalize_upload_episode_ordinal(
            value
                .get("episodeNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1),
            1,
        );
        inferred["seriesTitle"] = Value::String(normalize_whitespace(stringify_json(
            value.get("seriesTitle"),
        )));
        inferred["seasonNumber"] = Value::from(normalize_upload_episode_ordinal(
            value
                .get("seasonNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1),
            1,
        ));
        inferred["episodeNumber"] = Value::from(episode_number);
        inferred["episodeTitle"] = Value::String(
            normalize_whitespace(stringify_json(value.get("episodeTitle")))
                .if_empty_then(|| format!("{fallback_episode_label} {episode_number}")),
        );
    }
    inferred
}

fn choose_best_tmdb_result<'a>(
    results: Option<&'a Vec<Value>>,
    query_title: &str,
    query_year: &str,
) -> Option<&'a Value> {
    let mut best: Option<&Value> = None;
    let mut best_score = -1.0_f64;
    for entry in results.into_iter().flatten() {
        let title = normalize_whitespace(entry.get("name").and_then(Value::as_str).unwrap_or_else(
            || {
                entry
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            },
        ));
        if title.is_empty() {
            continue;
        }
        let mut score = score_tmdb_title_candidate(&title, query_title);
        let candidate_year = normalize_year(
            entry
                .get("first_air_date")
                .and_then(Value::as_str)
                .or_else(|| entry.get("release_date").and_then(Value::as_str))
                .unwrap_or_default()
                .chars()
                .take(4)
                .collect::<String>(),
        );
        if !query_year.is_empty() && !candidate_year.is_empty() && candidate_year == query_year {
            score += 0.3;
        }
        if title.eq_ignore_ascii_case(query_title) {
            score += 0.2;
        }
        if score > best_score {
            best_score = score;
            best = Some(entry);
        }
    }
    best
}

fn score_tmdb_title_candidate(candidate_title: &str, query_title: &str) -> f64 {
    let candidate_tokens = tokenize_tmdb_title(candidate_title);
    let query_tokens = tokenize_tmdb_title(query_title);
    if candidate_tokens.is_empty() || query_tokens.is_empty() {
        return 0.0;
    }
    let candidate_set = candidate_tokens
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let overlap = query_tokens
        .iter()
        .filter(|token| candidate_set.contains(*token))
        .count();
    overlap as f64 / query_tokens.len() as f64
}

fn tokenize_tmdb_title(value: &str) -> Vec<String> {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect()
}

fn find_episode_pattern(file_name: &str) -> Option<(String, i64, i64)> {
    let raw_base = strip_file_extension(file_name.trim());
    let tokens = raw_base
        .split(|ch: char| ['.', '_', '-', ' '].contains(&ch))
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let normalized = token.to_lowercase();
        if normalized.starts_with('s') && normalized.contains('e') {
            let parts = normalized
                .trim_start_matches('s')
                .split('e')
                .collect::<Vec<_>>();
            if parts.len() == 2
                && let (Ok(season), Ok(episode)) =
                    (parts[0].parse::<i64>(), parts[1].parse::<i64>())
            {
                let left = tokens[..index].join(" ");
                let series_title = title_from_filename_token(&left)
                    .if_empty_then(|| title_from_filename_token(&raw_base));
                return Some((
                    series_title,
                    normalize_upload_episode_ordinal(season, 1),
                    normalize_upload_episode_ordinal(episode, 1),
                ));
            }
        }
        if let Some((left, right)) = normalized.split_once('x')
            && let (Ok(season), Ok(episode)) = (left.parse::<i64>(), right.parse::<i64>())
        {
            let left_side = tokens[..index].join(" ");
            let series_title = title_from_filename_token(&left_side)
                .if_empty_then(|| title_from_filename_token(&raw_base));
            return Some((
                series_title,
                normalize_upload_episode_ordinal(season, 1),
                normalize_upload_episode_ordinal(episode, 1),
            ));
        }
    }
    None
}

fn capture_keyword_number(raw_base: &str, keyword: &str) -> Option<i64> {
    let lowered = raw_base.to_lowercase();
    let needle = keyword.to_lowercase();
    let index = lowered.find(&needle)?;
    let tail = lowered[index + needle.len()..]
        .chars()
        .skip_while(|ch| [' ', '.', '_', '-'].contains(ch))
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    tail.parse::<i64>()
        .ok()
        .map(|value| normalize_upload_episode_ordinal(value, 1))
}

fn extract_year(raw_base: &str) -> String {
    for piece in raw_base.split(|ch: char| !ch.is_ascii_digit()) {
        if piece.len() == 4 {
            let normalized = normalize_year(piece);
            if !normalized.is_empty() {
                return normalized;
            }
        }
    }
    String::new()
}

fn stringify_json(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(boolean)) => boolean.to_string(),
        _ => String::new(),
    }
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
    use super::{
        USER_IDENTITY_MAX_BYTES, USER_SYNC_MAX_ENTRIES, absolute_request_url_with_authority,
        apply_security_headers, build_playback_session_key, find_episode_pattern, is_valid_email,
        manifest_is_stream_addon, normalize_custom_addon_base, normalize_preferred_audio_lang,
        normalize_subtitle_preference, normalize_sync_continue_watching_entries,
        normalize_sync_watch_progress_entries, normalize_user_updated_at, now_ms, provider_slugify,
        query_flag_enabled, sanitize_my_list_entries, signup_admin_status,
    };
    use axum::http::header::{CONTENT_TYPE, HOST};
    use axum::http::{HeaderMap, HeaderValue, Uri};

    #[test]
    fn forwarded_for_takes_left_most_client_ip() {
        // Single IP passes through.
        assert_eq!(
            super::parse_forwarded_for("1.2.3.4").as_deref(),
            Some("1.2.3.4")
        );
        // Proxy chain: the original client is the left-most entry.
        assert_eq!(
            super::parse_forwarded_for("1.2.3.4, 5.6.7.8, 9.10.11.12").as_deref(),
            Some("1.2.3.4")
        );
        // Surrounding whitespace is trimmed.
        assert_eq!(
            super::parse_forwarded_for("  1.2.3.4  ").as_deref(),
            Some("1.2.3.4")
        );
        // Blank/empty header yields None so the caller falls back to the peer IP.
        assert_eq!(super::parse_forwarded_for(""), None);
        assert_eq!(super::parse_forwarded_for("   "), None);
    }

    #[test]
    fn normalizes_audio_preferences() {
        assert_eq!(normalize_preferred_audio_lang("ENG"), "auto");
        assert_eq!(normalize_preferred_audio_lang("en"), "en");
    }

    #[test]
    fn normalizes_subtitle_preferences() {
        assert_eq!(normalize_subtitle_preference("off"), "off");
        assert_eq!(normalize_subtitle_preference("eng"), "en");
    }

    #[test]
    fn extracts_episode_patterns() {
        let pattern = find_episode_pattern("The.Office.S02E03.mkv").unwrap();
        assert_eq!(pattern.1, 2);
        assert_eq!(pattern.2, 3);
    }

    #[test]
    fn builds_session_key() {
        assert_eq!(build_playback_session_key("1", "en", "1080"), "1:en:1080p");
    }

    #[test]
    fn query_flags_require_exact_parameter_names() {
        assert!(query_flag_enabled("clear=1", "clear"));
        assert!(query_flag_enabled("clear=true", "clear"));
        assert!(!query_flag_enabled("notclear=1", "clear"));
        assert!(!query_flag_enabled("clearance=1", "clear"));
        assert!(!query_flag_enabled("clear=0", "clear"));
    }

    #[test]
    fn security_headers_include_baseline_browser_hardening() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        apply_security_headers(&mut headers, false);

        let csp = headers
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok())
            .expect("content security policy");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("script-src 'self' blob:"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
        assert!(!csp.contains("'unsafe-eval'"));
        assert!(csp.contains("script-src-attr 'none'"));
        assert!(csp.contains("style-src 'self'"));
        assert!(csp.contains("style-src-attr 'none'"));
        assert!(!csp.contains("'unsafe-inline'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("frame-ancestors 'self'"));
        assert!(csp.contains("media-src 'self' data: blob: https: http:"));

        assert_eq!(
            headers
                .get("x-frame-options")
                .and_then(|value| value.to_str().ok()),
            Some("SAMEORIGIN")
        );
        assert_eq!(
            headers
                .get("x-content-type-options")
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            headers
                .get("referrer-policy")
                .and_then(|value| value.to_str().ok()),
            Some("strict-origin-when-cross-origin")
        );
        assert!(
            headers
                .get("permissions-policy")
                .and_then(|value| value.to_str().ok())
                .expect("permissions policy")
                .contains("camera=()")
        );
        assert_eq!(
            headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        assert!(!headers.contains_key("strict-transport-security"));

        apply_security_headers(&mut headers, true);
        assert_eq!(
            headers
                .get("strict-transport-security")
                .and_then(|value| value.to_str().ok()),
            Some("max-age=31536000; includeSubDomains")
        );
    }

    #[test]
    fn validates_account_email_addresses() {
        assert!(is_valid_email("viewer@example.com"));
        assert!(is_valid_email("viewer.name+tag@example.co.uk"));
        assert!(!is_valid_email(""));
        assert!(!is_valid_email("viewer"));
        assert!(!is_valid_email("viewer@example"));
        assert!(!is_valid_email("viewer @example.com"));
    }

    #[test]
    fn closed_signup_has_no_public_first_claimant_exception() {
        assert_eq!(
            signup_admin_status(false, "", "", None, "claimant@example.com"),
            None
        );
        assert_eq!(
            signup_admin_status(
                false,
                "invite-secret",
                "invite-secret",
                None,
                "viewer@example.com",
            ),
            Some(false)
        );
        assert_eq!(
            signup_admin_status(
                false,
                "invite-secret",
                "invite-secret",
                Some("owner@example.com"),
                "owner@example.com",
            ),
            Some(true)
        );
        assert_eq!(
            signup_admin_status(
                true,
                "invite-secret",
                "wrong-invite",
                Some("owner@example.com"),
                "owner@example.com",
            ),
            None,
            "the reserved bootstrap address cannot be preempted during open signup"
        );
        assert_eq!(
            signup_admin_status(
                true,
                "",
                "",
                Some("owner@example.com"),
                "viewer@example.com",
            ),
            Some(false)
        );
    }

    #[test]
    fn normalizes_legacy_user_sync_maps() {
        let payload = serde_json::json!({
            "watchProgress": {
                "movie:1": 42.5,
                "movie:2": { "resumeSeconds": 15.0, "updatedAt": 123 }
            },
            "continueWatching": {
                "movie:1": { "title": "Movie One", "resumeSeconds": 42.5 },
                "movie:2": 15.0
            }
        });

        let progress = normalize_sync_watch_progress_entries(payload.get("watchProgress"));
        assert_eq!(progress.len(), 2);
        assert!(progress.iter().any(|entry| {
            entry["sourceIdentity"] == "movie:1" && entry["resumeSeconds"] == 42.5
        }));
        assert!(
            progress
                .iter()
                .any(|entry| { entry["sourceIdentity"] == "movie:2" && entry["updatedAt"] == 123 })
        );

        let continue_watching =
            normalize_sync_continue_watching_entries(payload.get("continueWatching"));
        assert_eq!(continue_watching.len(), 2);
        assert!(continue_watching.iter().any(|entry| {
            entry["sourceIdentity"] == "movie:1" && entry["title"] == "Movie One"
        }));
        assert!(continue_watching.iter().any(|entry| {
            entry["sourceIdentity"] == "movie:2" && entry["resumeSeconds"] == 15.0
        }));
    }

    #[test]
    fn normalize_user_updated_at_caps_future_but_keeps_past() {
        let now = now_ms();
        // Legacy/small timestamps pass through untouched.
        assert_eq!(
            normalize_user_updated_at(Some(&serde_json::json!(123))),
            123
        );
        // Non-positive falls back to now.
        assert!(normalize_user_updated_at(Some(&serde_json::json!(0))) >= now);
        // A year-3000 timestamp is capped to roughly now (within the skew window).
        let far_future = now + 1_000 * 60 * 60 * 24 * 365 * 100;
        let capped = normalize_user_updated_at(Some(&serde_json::json!(far_future)));
        assert!(capped <= now + 24 * 60 * 60 * 1000 + 1_000);
        assert!(capped < far_future);
    }

    #[test]
    fn user_sync_normalization_drops_oversized_identities() {
        let oversized_identity = "x".repeat(USER_IDENTITY_MAX_BYTES + 1);
        let mut watch_progress = serde_json::Map::new();
        watch_progress.insert(oversized_identity.clone(), serde_json::json!(10.0));
        watch_progress.insert("movie:ok".to_owned(), serde_json::json!(20.0));
        let payload = serde_json::json!({
            "watchProgress": serde_json::Value::Object(watch_progress),
            "continueWatching": {
                "movie:ok": { "title": "Movie", "extra": "ignored" }
            },
            "myList": [
                { "itemIdentity": "movie:ok", "title": "Movie", "extra": "ignored" },
                { "itemIdentity": "x".repeat(USER_IDENTITY_MAX_BYTES + 1), "title": "Bad" }
            ]
        });

        let progress = normalize_sync_watch_progress_entries(payload.get("watchProgress"));
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0]["sourceIdentity"], "movie:ok");

        let continue_watching =
            normalize_sync_continue_watching_entries(payload.get("continueWatching"));
        assert_eq!(continue_watching.len(), 1);
        assert!(continue_watching[0].get("extra").is_none());

        let my_list = sanitize_my_list_entries(
            payload
                .get("myList")
                .and_then(serde_json::Value::as_array)
                .expect("my list array"),
        );
        assert_eq!(my_list.len(), 1);
        assert!(my_list[0].get("extra").is_none());
    }

    #[test]
    fn user_sync_normalization_caps_collection_sizes() {
        let progress_payload = serde_json::Value::Array(
            (0..(USER_SYNC_MAX_ENTRIES + 20))
                .map(|index| {
                    serde_json::json!({
                        "sourceIdentity": format!("movie:{index}"),
                        "resumeSeconds": index as f64
                    })
                })
                .collect(),
        );
        let my_list_payload = serde_json::Value::Array(
            (0..(USER_SYNC_MAX_ENTRIES + 20))
                .map(|index| {
                    serde_json::json!({
                        "itemIdentity": format!("movie:{index}"),
                        "title": format!("Movie {index}")
                    })
                })
                .collect(),
        );

        assert_eq!(
            normalize_sync_watch_progress_entries(Some(&progress_payload)).len(),
            USER_SYNC_MAX_ENTRIES
        );
        assert_eq!(
            sanitize_my_list_entries(my_list_payload.as_array().expect("array")).len(),
            USER_SYNC_MAX_ENTRIES
        );
    }

    #[test]
    fn request_url_prefers_host_header_when_available() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:5173"));
        let uri: Uri = "/api/config".parse().expect("uri");
        let authority = headers
            .get(HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap()
            .to_owned();
        let url = absolute_request_url_with_authority(&uri, Some(authority), "0.0.0.0", 5173)
            .expect("request url");
        assert_eq!(url.as_str(), "http://127.0.0.1:5173/api/config");
    }

    #[test]
    fn normalize_custom_addon_base_strips_suffixes_and_requires_https() {
        let want = "https://nebula.work.gd/private/abc".to_owned();
        for input in [
            "https://nebula.work.gd/private/abc",
            "https://nebula.work.gd/private/abc/",
            "https://nebula.work.gd/private/abc/manifest.json",
            "  https://nebula.work.gd/private/abc/configure  ",
        ] {
            assert_eq!(
                normalize_custom_addon_base(input),
                Some(want.clone()),
                "{input}"
            );
        }
        // Non-https / junk rejected.
        assert_eq!(normalize_custom_addon_base("http://nebula.work.gd/x"), None);
        assert_eq!(normalize_custom_addon_base("not a url"), None);
        assert_eq!(normalize_custom_addon_base(""), None);
    }

    #[test]
    fn provider_slugify_makes_kebab_ids() {
        assert_eq!(provider_slugify("NebulaStreams(CFG)"), "nebulastreams-cfg");
        assert_eq!(provider_slugify("  My Addon!! 2 "), "my-addon-2");
        assert_eq!(provider_slugify("already-kebab"), "already-kebab");
        assert_eq!(provider_slugify("!!!"), "");
    }

    #[test]
    fn manifest_is_stream_addon_accepts_vod_stream_addons_only() {
        // String resources + movie/series types → accepted.
        assert!(manifest_is_stream_addon(&serde_json::json!({
            "resources": ["stream"], "types": ["movie", "series"]
        })));
        // Object-form resources → accepted.
        assert!(manifest_is_stream_addon(&serde_json::json!({
            "resources": [{"name": "stream", "types": ["movie"]}], "types": ["movie"]
        })));
        // Sports stream addon (no movie/series type) → rejected.
        assert!(!manifest_is_stream_addon(&serde_json::json!({
            "resources": ["catalog", "stream", "meta"], "types": ["sports"]
        })));
        // Catalog-only (no stream resource) → rejected.
        assert!(!manifest_is_stream_addon(&serde_json::json!({
            "resources": ["catalog"], "types": ["movie"]
        })));
        // Garbage → rejected.
        assert!(!manifest_is_stream_addon(&serde_json::json!({})));
    }
}
