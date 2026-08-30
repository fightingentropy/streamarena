use std::env;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

const DEFAULT_LOCAL_TORRENT_UPLOAD_BPS: u32 = 512 * 1024;
const MIN_LOCAL_TORRENT_UPLOAD_BPS: u64 = 64 * 1024;
const MAX_LOCAL_TORRENT_UPLOAD_BPS: u64 = 32 * 1024 * 1024;

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
    pub resolver_provider_max_concurrent: usize,
    pub resolver_queue_timeout_ms: u64,
    pub sports_resolver_max_concurrent: usize,
    pub sports_resolver_queue_timeout_ms: u64,
    pub local_torrent_max_bytes: u64,
    pub local_torrent_metadata_timeout_ms: u64,
    pub local_torrent_ready_timeout_ms: u64,
    /// TCP listen range for inbound BitTorrent peer connections. `None` disables
    /// inbound peers (outbound-only, slowest swarm joins). Enabled by default;
    /// set `LOCAL_TORRENT_LISTEN_PORT_START=0` to disable.
    pub local_torrent_listen_port_range: Option<std::ops::Range<u16>>,
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
        // Static files must always resolve beneath the build output. Falling
        // back to the repository root when `dist/` is absent can expose source,
        // configuration, or database files through the catch-all static route.
        // A missing frontend build should fail closed with 404 responses.
        let frontend_dir = root_dir.join("dist");
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
        let export_queue_timeout_ms = parse_u64_env("EXPORT_QUEUE_TIMEOUT_MS", 5_000, 100, 120_000);
        let export_process_timeout_seconds = parse_u64_env(
            "EXPORT_PROCESS_TIMEOUT_SECONDS",
            6 * 60 * 60,
            60,
            24 * 60 * 60,
        );
        let resolver_max_concurrent = parse_usize_env("RESOLVER_MAX_CONCURRENT", 2, 1, 16);
        let resolver_provider_max_concurrent =
            parse_usize_env("RESOLVER_PROVIDER_MAX_CONCURRENT", 1, 1, 8);
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
            parse_u64_env("LOCAL_TORRENT_METADATA_TIMEOUT_MS", 45_000, 5_000, 300_000);
        let local_torrent_ready_timeout_ms =
            parse_u64_env("LOCAL_TORRENT_READY_TIMEOUT_MS", 45_000, 5_000, 300_000);
        let local_torrent_listen_port_start =
            parse_u64_env("LOCAL_TORRENT_LISTEN_PORT_START", 42_501, 0, 65_534);
        let local_torrent_listen_port_end =
            parse_u64_env("LOCAL_TORRENT_LISTEN_PORT_END", 42_502, 1, 65_535);
        let local_torrent_listen_port_range = if local_torrent_listen_port_start == 0 {
            None
        } else {
            let start = local_torrent_listen_port_start as u16;
            let end = (local_torrent_listen_port_end as u16).max(start.saturating_add(1));
            Some(start..end)
        };
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
            resolver_provider_max_concurrent,
            resolver_queue_timeout_ms,
            sports_resolver_max_concurrent,
            sports_resolver_queue_timeout_ms,
            local_torrent_max_bytes,
            local_torrent_metadata_timeout_ms,
            local_torrent_ready_timeout_ms,
            local_torrent_listen_port_range,
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
            // Fail closed when OPEN_SIGNUP is absent. Operators can explicitly
            // enable public registration, use an invite code, or nominate one
            // bootstrap administrator through BOOTSTRAP_ADMIN_EMAIL together
            // with SIGNUP_INVITE_CODE.
            open_signup_enabled: parse_bool_env("OPEN_SIGNUP", false),
            signup_invite_code: env::var("SIGNUP_INVITE_CODE")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            live_hls_proxy_secret: resolve_live_hls_proxy_secret(
                env::var("LIVE_HLS_PROXY_SECRET").ok(),
                env::var("LIVE_HLS_RESOURCE_WORKER_BASE")
                    .unwrap_or_default()
                    .trim(),
                parse_bool_env("REQUIRE_LIVE_HLS_PROXY_SECRET", false),
            )
            .unwrap_or_else(|message| panic!("{message}")),
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

/// The only email eligible to bootstrap an administrator. The signup route also
/// requires the configured invite code, so knowing this address is insufficient
/// to claim the account. Kept out of [`Config`] so it is never accidentally
/// serialized with the public runtime configuration payload.
pub fn bootstrap_admin_email() -> Option<String> {
    configured_email_from_env("BOOTSTRAP_ADMIN_EMAIL")
}

fn configured_email_from_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
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

/// Use Real-Debrid's paid Remote Traffic pool for unrestricted links. This is
/// required when StreamArena runs on a VPS/cloud host instead of the account
/// holder's own network. Keep it disabled for ordinary local deployments.
pub fn real_debrid_remote_traffic_enabled() -> bool {
    parse_bool_env("REAL_DEBRID_REMOTE_TRAFFIC", false)
}

/// Global BitTorrent upload budget. A small bounded contribution improves
/// swarm reciprocity without allowing peer uploads to monopolize the same home
/// uplink used to relay playback. Operators can set the value to 0 to opt out.
pub fn local_torrent_upload_bps() -> Option<u32> {
    normalize_local_torrent_upload_bps(env::var("LOCAL_TORRENT_UPLOAD_BPS").ok().as_deref())
}

fn normalize_local_torrent_upload_bps(value: Option<&str>) -> Option<u32> {
    let parsed = value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(u64::from(DEFAULT_LOCAL_TORRENT_UPLOAD_BPS));
    if parsed == 0 {
        return None;
    }
    Some(parsed.clamp(MIN_LOCAL_TORRENT_UPLOAD_BPS, MAX_LOCAL_TORRENT_UPLOAD_BPS) as u32)
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

/// Pin the live-HLS HMAC secret when a Worker origin is configured or the
/// operator asked for pinned secrets. Local `cargo run` without those still
/// generates an ephemeral secret so unsigned URLs work for a single process.
fn resolve_live_hls_proxy_secret(
    configured: Option<String>,
    worker_base: &str,
    require_pinned: bool,
) -> Result<String, String> {
    if let Some(secret) = configured
        .map(|value| value.trim().to_owned())
        .filter(|value| value.len() >= 32)
    {
        return Ok(secret);
    }
    if require_pinned || !worker_base.trim().is_empty() {
        return Err(
            "LIVE_HLS_PROXY_SECRET must be set to at least 32 characters when REQUIRE_LIVE_HLS_PROXY_SECRET=1 or LIVE_HLS_RESOURCE_WORKER_BASE is set."
                .to_owned(),
        );
    }
    Ok(generate_live_hls_proxy_secret())
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

fn parse_bool_env(name: &str, fallback: bool) -> bool {
    env::var(name).map(normalize_bool_flag).unwrap_or(fallback)
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
        DEFAULT_OUTBOUND_PROXY_BYPASS_HOSTS, configured_email_from_env, normalize_bool_flag,
        normalize_local_torrent_upload_bps, parse_bool_env, parse_csv_env, parse_proxy_bypass_env,
        parse_u64_env, parse_usize_env, resolve_live_hls_proxy_secret,
    };

    #[test]
    fn signup_flags_fail_closed_and_bootstrap_email_is_normalized() {
        assert!(!normalize_bool_flag("0".to_owned()));
        assert!(!normalize_bool_flag("false".to_owned()));

        unsafe {
            std::env::remove_var("BOOTSTRAP_ADMIN_EMAIL_TEST");
            std::env::remove_var("OPEN_SIGNUP_DEFAULT_TEST");
        }
        assert!(!parse_bool_env("OPEN_SIGNUP_DEFAULT_TEST", false));
        assert_eq!(
            configured_email_from_env("BOOTSTRAP_ADMIN_EMAIL_TEST"),
            None
        );
        unsafe {
            std::env::set_var("BOOTSTRAP_ADMIN_EMAIL_TEST", " Owner@Example.COM ");
        }
        assert_eq!(
            configured_email_from_env("BOOTSTRAP_ADMIN_EMAIL_TEST").as_deref(),
            Some("owner@example.com")
        );
        unsafe {
            std::env::remove_var("BOOTSTRAP_ADMIN_EMAIL_TEST");
        }
    }

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

    #[test]
    fn bounds_local_torrent_upload_and_allows_opt_out() {
        assert_eq!(normalize_local_torrent_upload_bps(None), Some(512 * 1024));
        assert_eq!(
            normalize_local_torrent_upload_bps(Some("bad")),
            Some(512 * 1024)
        );
        assert_eq!(normalize_local_torrent_upload_bps(Some("0")), None);
        assert_eq!(
            normalize_local_torrent_upload_bps(Some("1")),
            Some(64 * 1024)
        );
        assert_eq!(
            normalize_local_torrent_upload_bps(Some("999999999")),
            Some(32 * 1024 * 1024)
        );
    }

    #[test]
    fn live_hls_proxy_secret_generates_locally_and_fails_closed_when_pinned() {
        let generated = resolve_live_hls_proxy_secret(None, "", false).expect("local generate");
        assert!(generated.len() >= 32);

        let pinned = resolve_live_hls_proxy_secret(
            Some("  pinned-live-hls-proxy-secret-value  ".to_owned()),
            "https://live.example.workers.dev",
            true,
        )
        .expect("configured secret");
        assert_eq!(pinned, "pinned-live-hls-proxy-secret-value");

        let missing_with_worker =
            resolve_live_hls_proxy_secret(None, "https://live.example.workers.dev", false);
        assert!(missing_with_worker.is_err());

        let missing_when_required =
            resolve_live_hls_proxy_secret(Some("short".to_owned()), "", true);
        assert!(missing_when_required.is_err());
    }
}
