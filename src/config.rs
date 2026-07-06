use std::env;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(Clone, Debug)]
pub struct Config {
    pub root_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub hls_cache_dir: PathBuf,
    pub local_torrent_cache_dir: PathBuf,
    pub upload_temp_dir: PathBuf,
    pub local_library_path: PathBuf,
    /// Regenerable cache + resolver state (resolver-cache.sqlite). Self-heals from
    /// corruption by quarantining the file and rebuilding an empty schema.
    pub persistent_cache_db_path: PathBuf,
    /// Durable user/account data (users.sqlite). Deliberately kept in a separate
    /// file so a cache-corruption quarantine can never wipe accounts.
    pub persistent_users_db_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub max_upload_bytes: usize,
    pub tmdb_api_key: String,
    pub torrentio_base_url: String,
    pub torznab_api_url: String,
    pub torznab_api_key: String,
    pub torznab_movie_categories: Vec<String>,
    pub torznab_tv_categories: Vec<String>,
    pub torznab_limit: usize,
    pub torznab_timeout_ms: u64,
    pub remux_video_mode: String,
    pub remux_max_concurrent: usize,
    pub remux_queue_timeout_ms: u64,
    pub remux_process_timeout_seconds: u64,
    pub export_max_concurrent: usize,
    pub export_queue_timeout_ms: u64,
    pub export_process_timeout_seconds: u64,
    pub resolver_max_concurrent: usize,
    pub resolver_queue_timeout_ms: u64,
    pub sports_resolver_max_concurrent: usize,
    pub sports_resolver_queue_timeout_ms: u64,
    pub local_torrent_max_bytes: u64,
    pub local_torrent_metadata_timeout_ms: u64,
    pub local_torrent_ready_timeout_ms: u64,
    pub hls_max_transcode_jobs: usize,
    pub hls_max_segment_renders: usize,
    pub hls_segment_queue_timeout_ms: u64,
    pub hls_hwaccel_mode: String,
    pub remux_hwaccel_mode: String,
    pub auto_audio_sync_enabled: bool,
    pub playback_sessions_enabled: bool,
    pub opensubtitles_api_key: String,
    pub opensubtitles_user_agent: String,
    pub session_cookie_secure: bool,
    pub open_signup_enabled: bool,
    pub signup_invite_code: String,
    pub live_hls_proxy_secret: String,
    /// When set (env `LIVE_HLS_RESOURCE_WORKER_BASE`), browser-safe live HLS
    /// segment URLs are rewritten to this Cloudflare Worker base so segment
    /// bandwidth is served from Cloudflare instead of the mini's home uplink.
    /// Empty = disabled (mini serves segments, as before).
    pub live_hls_resource_worker_base: String,
    /// Public origin used to build email verification links (e.g. https://streamarena.xyz).
    pub app_origin: String,
    /// From address for transactional email (e.g. noreply@streamarena.xyz).
    pub email_from: String,
    /// Cloudflare account id that owns the Email Sending domain.
    pub cf_account_id: String,
    /// Cloudflare API token with the "Email Sending: Edit" permission.
    pub cf_email_api_token: String,
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
        // Offline export (`/api/download/export.mp4`) gets its own, longer budget and a
        // separate concurrency pool so a slow full-file faststart copy never holds a
        // remux permit hostage from live playback.
        let export_max_concurrent = parse_usize_env("EXPORT_MAX_CONCURRENT", 2, 1, 8);
        let export_queue_timeout_ms =
            parse_u64_env("EXPORT_QUEUE_TIMEOUT_MS", 5_000, 100, 120_000);
        let export_process_timeout_seconds = parse_u64_env(
            "EXPORT_PROCESS_TIMEOUT_SECONDS",
            6 * 60 * 60,
            60,
            24 * 60 * 60,
        );
        let resolver_max_concurrent = parse_usize_env("RESOLVER_MAX_CONCURRENT", 2, 1, 16);
        let resolver_queue_timeout_ms =
            parse_u64_env("RESOLVER_QUEUE_TIMEOUT_MS", 3_000, 100, 120_000);
        let sports_resolver_max_concurrent =
            parse_usize_env("SPORTS_RESOLVER_MAX_CONCURRENT", 2, 1, 8);
        let sports_resolver_queue_timeout_ms =
            parse_u64_env("SPORTS_RESOLVER_QUEUE_TIMEOUT_MS", 3_000, 100, 60_000);
        let local_torrent_max_bytes = parse_u64_env(
            "LOCAL_TORRENT_MAX_BYTES",
            80 * 1024 * 1024 * 1024,
            1024 * 1024 * 1024,
            2 * 1024 * 1024 * 1024 * 1024,
        );
        let local_torrent_metadata_timeout_ms =
            parse_u64_env("LOCAL_TORRENT_METADATA_TIMEOUT_MS", 20_000, 5_000, 180_000);
        let local_torrent_ready_timeout_ms =
            parse_u64_env("LOCAL_TORRENT_READY_TIMEOUT_MS", 15_000, 5_000, 300_000);
        let torznab_limit = parse_usize_env("TORZNAB_LIMIT", 50, 1, 100);
        let torznab_timeout_ms = parse_u64_env("TORZNAB_TIMEOUT_MS", 15_000, 3_000, 65_000);
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
            local_torrent_cache_dir: cache_dir.join("local-torrents"),
            upload_temp_dir: cache_dir.join("uploads"),
            local_library_path: assets_dir.join("library.json"),
            persistent_cache_db_path: cache_dir.join("resolver-cache.sqlite"),
            persistent_users_db_path: cache_dir.join("users.sqlite"),
            host,
            port,
            max_upload_bytes,
            tmdb_api_key: env::var("TMDB_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            torrentio_base_url: env::var("TORRENTIO_BASE_URL")
                .unwrap_or_else(|_| "https://torrentio.strem.fun".to_owned())
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            torznab_api_url: env::var("TORZNAB_API_URL")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            torznab_api_key: env::var("TORZNAB_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            torznab_movie_categories: parse_csv_env(
                "TORZNAB_MOVIE_CATEGORIES",
                &["2000", "2040", "2045"],
            ),
            torznab_tv_categories: parse_csv_env(
                "TORZNAB_TV_CATEGORIES",
                &["5000", "5040", "5045"],
            ),
            torznab_limit,
            torznab_timeout_ms,
            remux_video_mode: normalize_remux_video_mode(
                env::var("REMUX_VIDEO_MODE").unwrap_or_else(|_| "auto".to_owned()),
            ),
            remux_max_concurrent,
            remux_queue_timeout_ms,
            remux_process_timeout_seconds,
            export_max_concurrent,
            export_queue_timeout_ms,
            export_process_timeout_seconds,
            resolver_max_concurrent,
            resolver_queue_timeout_ms,
            sports_resolver_max_concurrent,
            sports_resolver_queue_timeout_ms,
            local_torrent_max_bytes,
            local_torrent_metadata_timeout_ms,
            local_torrent_ready_timeout_ms,
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
                .unwrap_or_else(|_| "streamarena-backend v1.0.0".to_owned())
                .trim()
                .to_owned(),
            session_cookie_secure: normalize_bool_flag(
                env::var("SESSION_COOKIE_SECURE").unwrap_or_else(|_| "1".to_owned()),
            ),
            // Public sign-up is open by default. Set OPEN_SIGNUP=0 to re-close it
            // (only the first account can be created once closed).
            open_signup_enabled: normalize_bool_flag(
                env::var("OPEN_SIGNUP").unwrap_or_else(|_| "1".to_owned()),
            ),
            signup_invite_code: env::var("SIGNUP_INVITE_CODE")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            live_hls_proxy_secret: env::var("LIVE_HLS_PROXY_SECRET")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| value.len() >= 32)
                .unwrap_or_else(generate_live_hls_proxy_secret),
            live_hls_resource_worker_base: env::var("LIVE_HLS_RESOURCE_WORKER_BASE")
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            app_origin: env::var("APP_ORIGIN")
                .unwrap_or_else(|_| "https://streamarena.xyz".to_owned())
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            email_from: env::var("EMAIL_FROM")
                .unwrap_or_else(|_| "noreply@streamarena.xyz".to_owned())
                .trim()
                .to_owned(),
            cf_account_id: env::var("CF_ACCOUNT_ID")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            cf_email_api_token: env::var("CF_EMAIL_API_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_owned(),
        }
    }
}

/// Hosts that skip the outbound WARP proxy by default: metadata/API traffic
/// that gains nothing from WARP's shielding but pays its latency and shares its
/// rate-limited egress IP. Deliberately NOT here: real-debrid.com — its API
/// pins download links to the requesting IP, so it must ride the same
/// consistent WARP egress the media fetches use.
const DEFAULT_OUTBOUND_PROXY_BYPASS_HOSTS: &[&str] = &[
    "api.themoviedb.org",
    "image.tmdb.org",
    "torrentio.strem.fun",
    "nebula.work.gd",
    "api.cloudflare.com",
    "opensubtitles.com",
];

/// Host suffixes whose outbound requests skip `OUTBOUND_HTTP_PROXY` and go
/// direct (env `OUTBOUND_HTTP_PROXY_BYPASS`, comma-separated suffixes). A free
/// function rather than a `Config` field: several modules build `Config` with
/// exhaustive struct literals in their test fixtures, and this value is only
/// ever consumed once, at HTTP-client construction in main.rs.
pub fn outbound_proxy_bypass_hosts() -> Vec<String> {
    parse_proxy_bypass_env("OUTBOUND_HTTP_PROXY_BYPASS")
}

/// Unset env -> the default bypass list; set-but-empty (or only whitespace/
/// commas) -> empty, i.e. the operator explicitly re-routes everything through
/// the proxy. Entries are trimmed and lowercased for suffix matching.
fn parse_proxy_bypass_env(name: &str) -> Vec<String> {
    match env::var(name) {
        Ok(value) => value
            .split(',')
            .map(|entry| entry.trim().to_ascii_lowercase())
            .filter(|entry| !entry.is_empty())
            .collect(),
        Err(_) => DEFAULT_OUTBOUND_PROXY_BYPASS_HOSTS
            .iter()
            .map(|entry| (*entry).to_owned())
            .collect(),
    }
}

fn generate_live_hls_proxy_secret() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("OS CSPRNG unavailable - cannot sign live HLS URLs");
    URL_SAFE_NO_PAD.encode(bytes)
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

fn parse_csv_env(name: &str, fallback: &[&str]) -> Vec<String> {
    let values = env::var(name).unwrap_or_else(|_| fallback.join(","));
    let mut seen = std::collections::HashSet::new();
    let mut normalized = values
        .split(',')
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
                return None;
            }
            let normalized = trimmed.to_owned();
            if seen.insert(normalized.clone()) {
                Some(normalized)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        normalized = fallback.iter().map(|value| (*value).to_owned()).collect();
    }
    normalized
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

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_OUTBOUND_PROXY_BYPASS_HOSTS, parse_csv_env, parse_proxy_bypass_env, parse_u64_env,
        parse_usize_env,
    };

    #[test]
    fn proxy_bypass_env_defaults_trims_and_distinguishes_empty() {
        // Unset: the compiled default list (metadata APIs, never real-debrid).
        let defaults = parse_proxy_bypass_env("OUTBOUND_PROXY_BYPASS_UNSET_TEST");
        assert_eq!(defaults, DEFAULT_OUTBOUND_PROXY_BYPASS_HOSTS);
        assert!(!defaults.iter().any(|host| host.contains("real-debrid")));

        unsafe {
            std::env::set_var(
                "OUTBOUND_PROXY_BYPASS_SET_TEST",
                " API.Example.com , ,cdn.other.net,",
            );
            std::env::set_var("OUTBOUND_PROXY_BYPASS_EMPTY_TEST", "  ");
        }
        assert_eq!(
            parse_proxy_bypass_env("OUTBOUND_PROXY_BYPASS_SET_TEST"),
            vec!["api.example.com", "cdn.other.net"]
        );
        // Set-but-empty: proxy everything (the pre-bypass behavior).
        assert!(parse_proxy_bypass_env("OUTBOUND_PROXY_BYPASS_EMPTY_TEST").is_empty());
        unsafe {
            std::env::remove_var("OUTBOUND_PROXY_BYPASS_SET_TEST");
            std::env::remove_var("OUTBOUND_PROXY_BYPASS_EMPTY_TEST");
        }
    }

    #[test]
    fn clamps_torznab_numeric_config() {
        unsafe {
            std::env::set_var("TORZNAB_LIMIT_TEST", "500");
            std::env::set_var("TORZNAB_TIMEOUT_TEST", "1000");
        }
        assert_eq!(parse_usize_env("TORZNAB_LIMIT_TEST", 50, 1, 100), 100);
        assert_eq!(
            parse_u64_env("TORZNAB_TIMEOUT_TEST", 15_000, 3_000, 65_000),
            3_000
        );
        unsafe {
            std::env::remove_var("TORZNAB_LIMIT_TEST");
            std::env::remove_var("TORZNAB_TIMEOUT_TEST");
        }
    }

    #[test]
    fn normalizes_torznab_category_lists() {
        unsafe {
            std::env::set_var("TORZNAB_CATEGORY_TEST", " 2000,2040,bad,2000,,5045 ");
        }
        assert_eq!(
            parse_csv_env("TORZNAB_CATEGORY_TEST", &["2000"]),
            vec!["2000", "2040", "5045"]
        );
        unsafe {
            std::env::remove_var("TORZNAB_CATEGORY_TEST");
        }
    }
}
