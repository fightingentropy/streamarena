use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub root_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub hls_cache_dir: PathBuf,
    pub upload_temp_dir: PathBuf,
    pub local_library_path: PathBuf,
    pub persistent_cache_db_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub max_upload_bytes: usize,
    pub tmdb_api_key: String,
    pub real_debrid_token: String,
    pub torrentio_base_url: String,
    pub remux_video_mode: String,
    pub remux_max_concurrent: usize,
    pub remux_queue_timeout_ms: u64,
    pub remux_process_timeout_seconds: u64,
    pub hls_max_transcode_jobs: usize,
    pub hls_max_segment_renders: usize,
    pub hls_segment_queue_timeout_ms: u64,
    pub hls_hwaccel_mode: String,
    pub remux_hwaccel_mode: String,
    pub auto_audio_sync_enabled: bool,
    pub playback_sessions_enabled: bool,
    pub opensubtitles_api_key: String,
    pub opensubtitles_user_agent: String,
}

impl Config {
    pub fn load() -> Self {
        let root_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let dist_dir = root_dir.join("dist");
        let frontend_dir = if dist_dir.is_dir() {
            dist_dir
        } else {
            root_dir.clone()
        };
        let assets_dir = root_dir.join("assets");
        let cache_dir = root_dir.join("cache");
        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(5173);
        let max_upload_bytes = env::var("MAX_UPLOAD_BYTES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(10 * 1024 * 1024 * 1024)
            .max(50 * 1024 * 1024);
        let remux_max_concurrent = parse_usize_env("REMUX_MAX_CONCURRENT", 2, 1, 16);
        let remux_queue_timeout_ms = parse_u64_env("REMUX_QUEUE_TIMEOUT_MS", 2_000, 100, 60_000);
        let remux_process_timeout_seconds = parse_u64_env(
            "REMUX_PROCESS_TIMEOUT_SECONDS",
            4 * 60 * 60,
            60,
            24 * 60 * 60,
        );
        let hls_max_transcode_jobs = parse_usize_env("HLS_MAX_TRANSCODE_JOBS", 1, 1, 8);
        let hls_max_segment_renders = parse_usize_env("HLS_MAX_SEGMENT_RENDERS", 2, 1, 16);
        let hls_segment_queue_timeout_ms =
            parse_u64_env("HLS_SEGMENT_QUEUE_TIMEOUT_MS", 2_000, 100, 60_000);

        Self {
            root_dir: root_dir.clone(),
            frontend_dir,
            assets_dir: assets_dir.clone(),
            cache_dir: cache_dir.clone(),
            hls_cache_dir: cache_dir.join("hls"),
            upload_temp_dir: cache_dir.join("uploads"),
            local_library_path: assets_dir.join("library.json"),
            persistent_cache_db_path: cache_dir.join("resolver-cache.sqlite"),
            host,
            port,
            max_upload_bytes,
            tmdb_api_key: env::var("TMDB_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            real_debrid_token: env::var("REAL_DEBRID_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            torrentio_base_url: env::var("TORRENTIO_BASE_URL")
                .unwrap_or_else(|_| "https://torrentio.strem.fun".to_owned())
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            remux_video_mode: normalize_remux_video_mode(
                env::var("REMUX_VIDEO_MODE").unwrap_or_else(|_| "auto".to_owned()),
            ),
            remux_max_concurrent,
            remux_queue_timeout_ms,
            remux_process_timeout_seconds,
            hls_max_transcode_jobs,
            hls_max_segment_renders,
            hls_segment_queue_timeout_ms,
            hls_hwaccel_mode: normalize_hwaccel_mode(
                env::var("HLS_HWACCEL").unwrap_or_else(|_| "auto".to_owned()),
            ),
            remux_hwaccel_mode: normalize_hwaccel_mode(
                env::var("REMUX_HWACCEL")
                    .or_else(|_| env::var("HLS_HWACCEL"))
                    .unwrap_or_else(|_| "auto".to_owned()),
            ),
            auto_audio_sync_enabled: normalize_bool_flag(
                env::var("AUTO_AUDIO_SYNC").unwrap_or_else(|_| "1".to_owned()),
            ),
            playback_sessions_enabled: normalize_bool_flag(
                env::var("PLAYBACK_SESSIONS").unwrap_or_else(|_| "1".to_owned()),
            ),
            opensubtitles_api_key: env::var("OPENSUBTITLES_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            opensubtitles_user_agent: env::var("OPENSUBTITLES_USER_AGENT")
                .unwrap_or_else(|_| "netflix-rust-backend v1.0.0".to_owned())
                .trim()
                .to_owned(),
        }
    }
}

fn parse_usize_env(name: &str, fallback: usize, min: usize, max: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_u64_env(name: &str, fallback: u64, min: u64, max: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn normalize_bool_flag(value: String) -> bool {
    !matches!(
        value.trim().to_lowercase().as_str(),
        "" | "0" | "false" | "off"
    )
}

fn normalize_remux_video_mode(value: String) -> String {
    match value.trim().to_lowercase().as_str() {
        "copy" => "copy".to_owned(),
        "normalize" => "normalize".to_owned(),
        _ => "auto".to_owned(),
    }
}

fn normalize_hwaccel_mode(value: String) -> String {
    match value.trim().to_lowercase().as_str() {
        "auto" => {
            if cfg!(target_os = "macos") {
                "videotoolbox".to_owned()
            } else {
                "none".to_owned()
            }
        }
        "videotoolbox" => "videotoolbox".to_owned(),
        "cuda" => "cuda".to_owned(),
        "qsv" => "qsv".to_owned(),
        _ => "none".to_owned(),
    }
}
