use std::env;
use std::path::PathBuf;

#[allow(dead_code)]
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
    pub codex_auth_file: String,
    pub codex_url: String,
    pub codex_model: String,
    pub openai_api_key: String,
    pub openai_responses_model: String,
    pub native_playback_mode: String,
    pub remux_video_mode: String,
    pub hls_hwaccel_mode: String,
    pub remux_hwaccel_mode: String,
    pub auto_audio_sync_enabled: bool,
    pub playback_sessions_enabled: bool,
    pub mpv_binary: String,
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
            codex_auth_file: env::var("CODEX_AUTH_FILE")
                .unwrap_or_else(|_| "~/.codex/auth.json".to_owned())
                .trim()
                .to_owned(),
            codex_url: env::var("CODEX_URL")
                .unwrap_or_else(|_| "https://chatgpt.com/backend-api/codex/responses".to_owned())
                .trim()
                .to_owned(),
            codex_model: env::var("CODEX_MODEL")
                .unwrap_or_else(|_| "gpt-5.2-codex".to_owned())
                .trim()
                .to_owned(),
            openai_api_key: env::var("OPENAI_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            openai_responses_model: env::var("OPENAI_RESPONSES_MODEL")
                .unwrap_or_else(|_| "gpt-5-mini".to_owned())
                .trim()
                .to_owned(),
            native_playback_mode: normalize_native_playback_mode(
                env::var("NATIVE_PLAYBACK")
                    .or_else(|_| env::var("NATIVE_PLAYER_MODE"))
                    .unwrap_or_else(|_| "auto".to_owned()),
            ),
            remux_video_mode: normalize_remux_video_mode(
                env::var("REMUX_VIDEO_MODE").unwrap_or_else(|_| "auto".to_owned()),
            ),
            hls_hwaccel_mode: normalize_hwaccel_mode(
                env::var("HLS_HWACCEL").unwrap_or_else(|_| "none".to_owned()),
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
                env::var("PLAYBACK_SESSIONS").unwrap_or_else(|_| "0".to_owned()),
            ),
            mpv_binary: env::var("MPV_BINARY")
                .unwrap_or_else(|_| "mpv".to_owned())
                .trim()
                .to_owned(),
        }
    }
}

fn normalize_bool_flag(value: String) -> bool {
    !matches!(
        value.trim().to_lowercase().as_str(),
        "" | "0" | "false" | "off"
    )
}

fn normalize_native_playback_mode(value: String) -> String {
    match value.trim().to_lowercase().as_str() {
        "off" => "off".to_owned(),
        _ => "auto".to_owned(),
    }
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
