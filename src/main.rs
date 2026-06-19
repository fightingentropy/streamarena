mod auth;
mod config;
mod email;
mod error;
mod football;
mod health;
mod home_bootstrap;
mod library;
mod live;
mod local_torrent;
mod media;
mod persistence;
mod playback_optimize;
mod process;
mod provider_registry;
mod rate_limit;
mod resolver;
mod routes;
mod static_files;
mod streaming;
mod tmdb;
mod twitch;
mod upload;
mod utils;

use std::env;
use std::net::SocketAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::DefaultBodyLimit;
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::config::Config;
use crate::error::AppResult;
use crate::football::{SportsProviderHealth, SportsScheduleCache, SportsStreamResolveCache};
use crate::local_torrent::LocalTorrentService;
use crate::media::MediaService;
use crate::persistence::Db;
use crate::process::RuntimeServices;
use crate::resolver::ResolverService;
use crate::routes::{AppState, build_router};
use crate::streaming::StreamingService;
use crate::tmdb::TmdbService;
use crate::upload::UploadService;

const SHARED_HTTP_CLIENT_TIMEOUT_SECONDS: u64 = 30;

fn format_startup_url(addr: SocketAddr) -> String {
    if addr.ip().is_loopback() {
        format!("localhost:{}", addr.port())
    } else {
        addr.to_string()
    }
}

/// Raise the open-file-descriptor soft limit. The macOS launchd default is only
/// 256, which a media proxy (client connections + upstream HLS fetches + ffmpeg
/// pipes + cache/DB files) exhausts under peak load — surfacing as
/// `Too many open files (os error 24)`, after which the server can no longer
/// accept connections (the watchdog then sees http=000 and restarts it). The hard
/// limit is effectively unbounded (capped by kern.maxfilesperproc), so lift the
/// soft limit toward a comfortable ceiling. Best-effort: log and continue on error.
#[cfg(unix)]
fn raise_open_file_limit() {
    const DESIRED_SOFT: libc::rlim_t = 16_384;
    // SAFETY: getrlimit/setrlimit take a valid resource id and a pointer to a
    // locally-owned rlimit; no aliasing or lifetime concerns.
    unsafe {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
            warn!(
                "could not read RLIMIT_NOFILE: {}",
                std::io::Error::last_os_error()
            );
            return;
        }
        let target = if limit.rlim_max == libc::RLIM_INFINITY {
            DESIRED_SOFT
        } else {
            DESIRED_SOFT.min(limit.rlim_max)
        };
        if limit.rlim_cur >= target {
            return;
        }
        let previous = limit.rlim_cur;
        limit.rlim_cur = target;
        if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
            warn!(
                "could not raise RLIMIT_NOFILE {} -> {}: {}",
                previous,
                target,
                std::io::Error::last_os_error()
            );
            return;
        }
        info!("raised open-file soft limit {} -> {}", previous, target);
    }
}

#[cfg(not(unix))]
fn raise_open_file_limit() {}

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "streamarena_backend=info,tower_http=info".into()),
        )
        .init();

    raise_open_file_limit();

    let config = Config::load();
    let db = Db::initialize(&config).await?;
    // Append a restart-log row so the admin Health panel can count restarts and
    // spot crash-looping. Best-effort — never block startup on it.
    let _ = db.record_service_start("startup".to_owned()).await;
    // Hydrate the provider-override registry from the DB so admin URL swaps survive
    // restarts. Best-effort: a read failure just leaves the compiled defaults.
    match db.get_provider_overrides().await {
        Ok(rows) => {
            let count = rows.len();
            provider_registry::load(rows.into_iter().collect());
            if count > 0 {
                info!("loaded {count} provider override(s)");
            }
        }
        Err(error) => warn!("failed to load provider overrides: {error:?}"),
    }
    let mut http_client_builder = reqwest::Client::builder()
        .user_agent("streamarena-backend")
        .timeout(Duration::from_secs(SHARED_HTTP_CLIENT_TIMEOUT_SECONDS));
    if let Some(proxy_url) = env::var("OUTBOUND_HTTP_PROXY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|error| {
            crate::error::ApiError::internal(format!("Invalid OUTBOUND_HTTP_PROXY: {error}"))
        })?;
        http_client_builder = http_client_builder.proxy(proxy);
    }
    let http_client = http_client_builder
        .build()
        .map_err(|error| crate::error::ApiError::internal(error.to_string()))?;
    let tmdb = TmdbService::new(config.clone(), db.clone(), http_client.clone());
    let media = MediaService::new(config.clone(), db.clone(), http_client.clone());
    let local_torrent = LocalTorrentService::new(config.clone(), db.clone(), http_client.clone());
    let runtime = RuntimeServices::new(config.clone());
    let resolver = ResolverService::new(
        config.clone(),
        db.clone(),
        http_client.clone(),
        tmdb.clone(),
        media.clone(),
        local_torrent.clone(),
    );
    let sweep_resolver = resolver.clone();
    let streaming = StreamingService::new(config.clone(), runtime.clone(), media.clone());
    let upload = UploadService::new(
        config.clone(),
        runtime.clone(),
        media.clone(),
        http_client.clone(),
    );
    let auth_rate_limiter =
        std::sync::Arc::new(crate::rate_limit::RateLimiter::new(12, 15 * 60 * 1000));
    // Generous global anti-abuse backstop for signups (per-IP limiting via
    // `auth_rate_limiter` is the primary control; see `auth_signup_handler`).
    // Set high enough never to throttle an organic signup surge — a botnet that
    // trips this is already pathological.
    let signup_global_rate_limiter =
        std::sync::Arc::new(crate::rate_limit::RateLimiter::new(2_000, 15 * 60 * 1000));
    let sports_stream_rate_limiter =
        std::sync::Arc::new(crate::rate_limit::RateLimiter::new(30, 60 * 1000));
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let http_metrics = std::sync::Arc::new(crate::health::HttpMetrics::default());
    let host_probe = std::sync::Arc::new(crate::health::HostProbe::new());

    let sweep_db = db.clone();
    let sweep_uploads = upload.clone();
    let sweep_streaming = streaming.clone();
    let sweep_local_torrent = local_torrent.clone();
    let sweep_auth_rate_limiter = auth_rate_limiter.clone();
    let sweep_signup_global_rate_limiter = signup_global_rate_limiter.clone();
    let sweep_sports_stream_rate_limiter = sports_stream_rate_limiter.clone();
    let sweep_sports_stream_resolve_cache = SportsStreamResolveCache::new(
        config.sports_resolver_max_concurrent,
        config.sports_resolver_queue_timeout_ms,
    );
    let sports_stream_resolve_cache = sweep_sports_stream_resolve_cache.clone();
    let live_audio_transcode_cache = crate::live::LiveAudioTranscodeCache::new();
    let sweep_live_audio_transcode_cache = live_audio_transcode_cache.clone();
    let live_hls_playlist_cache = crate::live::LiveHlsPlaylistCache::new();
    let sweep_live_hls_playlist_cache = live_hls_playlist_cache.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            sweep_db.sweep().await;
            sweep_uploads.sweep_sessions().await;
            sweep_streaming.prune().await;
            sweep_local_torrent.prune_idle_locks();
            sweep_auth_rate_limiter.prune();
            sweep_signup_global_rate_limiter.prune();
            sweep_sports_stream_rate_limiter.prune();
            sweep_sports_stream_resolve_cache.prune();
            sweep_live_audio_transcode_cache.prune();
            sweep_live_hls_playlist_cache.prune();
            sweep_resolver.prune_resolve_cache();
        }
    });

    let state = AppState {
        config: config.clone(),
        db,
        tmdb,
        media,
        http_client,
        local_torrent,
        resolver,
        streaming,
        upload,
        runtime,
        sports_schedule_cache: SportsScheduleCache::new(),
        sports_stream_resolve_cache,
        sports_provider_health: SportsProviderHealth::new(),
        home_bootstrap_cache: crate::home_bootstrap::HomeBootstrapCache::new(),
        live_audio_transcode_cache,
        live_hls_playlist_cache,
        auth_rate_limiter,
        signup_global_rate_limiter,
        sports_stream_rate_limiter,
        started_at_ms,
        http_metrics,
        host_probe,
    };

    state.home_bootstrap_cache.spawn_refresh(state.clone());
    state.tmdb.spawn_recent_tv_metadata_warmup();

    // Service-health sampler: every 60s snapshot host + request + provider
    // signals into the durable history that backs the admin Health tab.
    {
        let sampler_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                crate::routes::record_health_sample(&sampler_state).await;
            }
        });
    }

    let app = build_router(state)
        .layer(DefaultBodyLimit::max(config.max_upload_bytes))
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse::<SocketAddr>()
        .map_err(|error: std::net::AddrParseError| {
            crate::error::ApiError::internal(error.to_string())
        })?;
    // launchd's KeepAlive (and the watchdog's `launchctl kickstart -k`) can relaunch the
    // backend a moment before the previous instance has released the port, which surfaces
    // as `AddrInUse`. Exiting here just makes the supervisor relaunch us again, turning a
    // sub-second overlap into the bind crash-loop seen in backend.err.log. Wait the old
    // instance out instead of dying.
    const MAX_BIND_ATTEMPTS: u32 = 20;
    const BIND_RETRY_DELAY: Duration = Duration::from_secs(1);
    let listener = {
        let mut attempt = 1u32;
        loop {
            match TcpListener::bind(addr).await {
                Ok(listener) => break listener,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AddrInUse
                        && attempt < MAX_BIND_ATTEMPTS =>
                {
                    warn!(
                        "{} is in use (attempt {}/{}); a previous instance may still be \
                         shutting down — retrying in {}s",
                        addr,
                        attempt,
                        MAX_BIND_ATTEMPTS,
                        BIND_RETRY_DELAY.as_secs(),
                    );
                    tokio::time::sleep(BIND_RETRY_DELAY).await;
                    attempt += 1;
                }
                Err(error) => {
                    return Err(crate::error::ApiError::internal(error.to_string()));
                }
            }
        }
    };
    let display_addr = format_startup_url(listener.local_addr().unwrap_or(addr));
    info!("Rust server running at http://{}", display_addr);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|error: std::io::Error| crate::error::ApiError::internal(error.to_string()))?;
    Ok(())
}
