mod auth;
mod config;
mod error;
mod library;
mod media;
mod persistence;
mod process;
mod resolver;
mod routes;
mod static_files;
mod streaming;
mod tmdb;
mod upload;

use std::net::SocketAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::DefaultBodyLimit;
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::config::Config;
use crate::error::AppResult;
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

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "netflix_rust_backend=info,tower_http=info".into()),
        )
        .init();

    let config = Config::load();
    let db = Db::initialize(&config).await?;
    let http_client = reqwest::Client::builder()
        .user_agent("netflix-rust-backend")
        .timeout(Duration::from_secs(SHARED_HTTP_CLIENT_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| crate::error::ApiError::internal(error.to_string()))?;
    let tmdb = TmdbService::new(config.clone(), db.clone(), http_client.clone());
    let media = MediaService::new(config.clone(), db.clone(), http_client.clone());
    let runtime = RuntimeServices::new(config.clone());
    let resolver = ResolverService::new(
        config.clone(),
        db.clone(),
        http_client.clone(),
        tmdb.clone(),
        media.clone(),
    );
    let streaming = StreamingService::new(config.clone(), runtime.clone(), media.clone());
    let upload = UploadService::new(
        config.clone(),
        runtime.clone(),
        media.clone(),
        http_client.clone(),
    );
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();

    let sweep_db = db.clone();
    let sweep_uploads = upload.clone();
    let sweep_streaming = streaming.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            sweep_db.sweep().await;
            sweep_uploads.sweep_sessions().await;
            sweep_streaming.prune().await;
        }
    });

    let state = AppState {
        config: config.clone(),
        db,
        tmdb,
        media,
        resolver,
        streaming,
        upload,
        runtime,
        started_at_ms,
    };

    let app = build_router(state)
        .layer(DefaultBodyLimit::max(config.max_upload_bytes))
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse::<SocketAddr>()
        .map_err(|error: std::net::AddrParseError| {
            crate::error::ApiError::internal(error.to_string())
        })?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|error: std::io::Error| crate::error::ApiError::internal(error.to_string()))?;
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
