use std::sync::LazyLock;

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::http::HeaderMap;
use tokio::sync::Semaphore;

use crate::error::{ApiError, AppResult};
use crate::persistence::Db;

/// Bound on concurrent Argon2 operations. Argon2id with the default params is
/// memory-hard (~19 MiB) and CPU-bound, so each hash/verify is run on the
/// blocking pool (never an async worker) AND capped here: an unbounded
/// signup/login burst would otherwise spawn hundreds of parallel hashes,
/// saturating CPU and risking OOM. Sized to the core count so hashing keeps the
/// CPU busy without oversubscribing it; excess callers wait briefly for a permit.
static HASH_CONCURRENCY: LazyLock<Semaphore> = LazyLock::new(|| {
    let permits = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(2);
    Semaphore::new(permits)
});

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub is_admin: bool,
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let mut salt_bytes = [0u8; 16];
    getrandom::fill(&mut salt_bytes).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| error.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Async wrapper around [`hash_password`]: runs the CPU-heavy, memory-hard
/// Argon2 work on the blocking pool under the [`HASH_CONCURRENCY`] cap so it
/// never blocks an async worker thread. Blocking a worker on hashing is what
/// stalls unrelated requests — including the `/api/health/live` probe the
/// watchdog uses — under a signup surge.
pub async fn hash_password_async(password: String) -> Result<String, String> {
    let _permit = HASH_CONCURRENCY
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|error| error.to_string())?
}

/// Async wrapper around [`verify_password`] with the same offloading and
/// concurrency cap as [`hash_password_async`]. Any internal failure (semaphore
/// closed or join error) returns `false`: a broken verification must fail
/// closed, never bypass the password check.
pub async fn verify_password_async(password: String, hash: String) -> bool {
    let Ok(_permit) = HASH_CONCURRENCY.acquire().await else {
        return false;
    };
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false)
}

/// Generate a cryptographically random session token.
///
/// Uses the OS CSPRNG via `getrandom`. If `getrandom::fill` fails, the
/// process is in an unrecoverable state (the OS random source is broken),
/// so panicking is the correct response -- serving requests with weak
/// tokens would be worse than crashing.
pub fn generate_session_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS CSPRNG unavailable — cannot generate secure tokens");
    hex_encode(&buf)
}

pub fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get("cookie")?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some(value) = trimmed.strip_prefix("session=") {
            let token = value.trim();
            if !token.is_empty() {
                return Some(token.to_owned());
            }
        }
    }
    None
}

pub async fn require_auth(db: &Db, headers: &HeaderMap) -> AppResult<AuthUser> {
    let token = extract_session_token(headers)
        .ok_or_else(|| ApiError::unauthorized("Not authenticated."))?;

    let (user_id, expires_at) = db
        .get_session(token)
        .await?
        .ok_or_else(|| ApiError::unauthorized("Session not found."))?;

    // Fail closed on a broken clock: defaulting to epoch (0) would make every
    // session look unexpired and bypass the check below.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .map_err(|_| ApiError::internal("System clock error."))?;

    if expires_at <= now_ms {
        return Err(ApiError::unauthorized("Session expired."));
    }

    let (id, email, display_name, is_admin, is_disabled) = db
        .get_auth_user(user_id)
        .await?
        .ok_or_else(|| ApiError::unauthorized("User not found."))?;

    // A disabled account is treated as not-authenticated everywhere: the
    // session may still be valid, but every protected route and gated page
    // funnels through here, so this one check locks them out app-wide.
    if is_disabled {
        return Err(ApiError::unauthorized("Account disabled."));
    }

    Ok(AuthUser {
        id,
        email,
        display_name,
        is_admin,
    })
}

/// Like `require_auth`, but additionally requires the `is_admin` flag.
/// Returns 403 for a valid, non-admin session.
pub async fn require_admin(db: &Db, headers: &HeaderMap) -> AppResult<AuthUser> {
    let user = require_auth(db, headers).await?;
    if !user.is_admin {
        return Err(ApiError::forbidden("Admin access required."));
    }
    Ok(user)
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{
        AuthUser, extract_session_token, generate_session_token, hash_password,
        hash_password_async, require_admin, require_auth, verify_password, verify_password_async,
    };
    use crate::config::Config;
    use crate::error::AppResult;
    use crate::persistence::Db;
    use crate::utils::now_ms;
    use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
    use axum::response::IntoResponse;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    // ── Password hashing / verification ───────────────────────────────

    #[test]
    fn hash_then_verify_accepts_correct_and_rejects_wrong_password() {
        let hash = hash_password("correct horse battery staple").expect("hash");
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
    }

    #[test]
    fn verify_password_fails_closed_on_malformed_hash() {
        // A non-PHC string must never panic or be treated as a match.
        assert!(!verify_password("anything", "not-a-valid-argon2-phc-hash"));
        assert!(!verify_password("anything", ""));
    }

    #[test]
    fn hash_password_uses_a_fresh_salt_each_time() {
        let a = hash_password("same-password").expect("hash a");
        let b = hash_password("same-password").expect("hash b");
        assert_ne!(
            a, b,
            "identical passwords must not produce identical hashes"
        );
        assert!(verify_password("same-password", &a));
        assert!(verify_password("same-password", &b));
    }

    #[tokio::test]
    async fn async_hash_and_verify_roundtrip() {
        let hash = hash_password_async("p@ssw0rd".to_owned())
            .await
            .expect("hash");
        assert!(verify_password_async("p@ssw0rd".to_owned(), hash.clone()).await);
        assert!(!verify_password_async("nope".to_owned(), hash).await);
    }

    // ── Session token generation ──────────────────────────────────────

    #[test]
    fn session_token_is_64_lowercase_hex_chars_and_unique() {
        let a = generate_session_token();
        let b = generate_session_token();
        assert_eq!(a.len(), 64, "32 random bytes hex-encoded is 64 chars");
        assert!(
            a.chars()
                .all(|c| c.is_ascii_hexdigit()
                    && (!c.is_ascii_alphabetic() || c.is_ascii_lowercase())),
            "token must be lowercase hex"
        );
        assert_ne!(a, b, "tokens must not repeat");
    }

    // ── Cookie parsing ────────────────────────────────────────────────

    fn headers_with_cookie(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn extract_session_token_reads_the_session_cookie() {
        let headers = headers_with_cookie("session=abc123");
        assert_eq!(extract_session_token(&headers).as_deref(), Some("abc123"));
    }

    #[test]
    fn extract_session_token_finds_session_among_other_cookies() {
        let headers = headers_with_cookie("theme=dark; session=tok; lang=en");
        assert_eq!(extract_session_token(&headers).as_deref(), Some("tok"));
    }

    #[test]
    fn extract_session_token_is_none_when_absent_or_blank() {
        assert_eq!(extract_session_token(&HeaderMap::new()), None);
        assert_eq!(extract_session_token(&headers_with_cookie("other=1")), None);
        assert_eq!(
            extract_session_token(&headers_with_cookie("session=")),
            None
        );
        assert_eq!(
            extract_session_token(&headers_with_cookie("session=   ")),
            None
        );
    }

    // ── require_auth / require_admin against a real (temp) database ────

    static TEST_DB_SEQ: AtomicU64 = AtomicU64::new(0);

    fn unique_cache_db_path() -> PathBuf {
        // now_ms() alone can collide for tests that start in the same
        // millisecond; the atomic sequence guarantees each parallel test gets a
        // distinct file (and thus an isolated users.sqlite via test_config).
        let seq = TEST_DB_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("streamarena-auth-test-{}-{seq}.sqlite", now_ms()))
    }

    /// Minimal `Config` whose only load-bearing fields are the two database
    /// paths; everything else is an inert default so `Db::initialize` can build
    /// the schema. Mirrors the per-test config pattern in `persistence.rs`.
    fn test_config(cache_db_path: PathBuf) -> Config {
        let users_db_path = cache_db_path.with_file_name(format!(
            "users-{}",
            cache_db_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("cache.sqlite")
        ));
        let tmp = std::env::temp_dir();
        Config {
            root_dir: tmp.clone(),
            frontend_dir: tmp.clone(),
            assets_dir: tmp.clone(),
            cache_dir: tmp.clone(),
            hls_cache_dir: tmp.clone(),
            local_torrent_cache_dir: tmp.join("local-torrents"),
            upload_temp_dir: tmp.clone(),
            local_library_path: tmp.join("library.json"),
            persistent_cache_db_path: cache_db_path,
            persistent_users_db_path: users_db_path,
            host: "127.0.0.1".to_owned(),
            port: 0,
            max_upload_bytes: 1,
            tmdb_api_key: String::new(),
            torrentio_base_url: String::new(),
            torznab_api_url: String::new(),
            torznab_api_key: String::new(),
            torznab_movie_categories: vec!["2000".to_owned()],
            torznab_tv_categories: vec!["5000".to_owned()],
            torznab_limit: 50,
            torznab_timeout_ms: 15_000,
            remux_video_mode: "auto".to_owned(),
            remux_max_concurrent: 2,
            remux_queue_timeout_ms: 2_000,
            remux_process_timeout_seconds: 4 * 60 * 60,
            export_max_concurrent: 2,
            export_queue_timeout_ms: 5_000,
            export_process_timeout_seconds: 6 * 60 * 60,
            resolver_max_concurrent: 2,
            resolver_queue_timeout_ms: 3_000,
            sports_resolver_max_concurrent: 2,
            sports_resolver_queue_timeout_ms: 3_000,
            local_torrent_max_bytes: 1024 * 1024 * 1024,
            local_torrent_metadata_timeout_ms: 45_000,
            local_torrent_ready_timeout_ms: 90_000,
            hls_max_transcode_jobs: 1,
            hls_max_segment_renders: 2,
            hls_segment_queue_timeout_ms: 2_000,
            hls_hwaccel_mode: "none".to_owned(),
            remux_hwaccel_mode: "none".to_owned(),
            auto_audio_sync_enabled: false,
            playback_sessions_enabled: true,
            opensubtitles_api_key: String::new(),
            opensubtitles_user_agent: String::new(),
            session_cookie_secure: true,
            open_signup_enabled: false,
            signup_invite_code: String::new(),
            live_hls_proxy_secret: "test-live-hls-proxy-secret-with-enough-length".to_owned(),
            live_hls_resource_worker_base: String::new(),
            app_origin: "https://example.com".to_owned(),
            email_from: "noreply@example.com".to_owned(),
            cf_account_id: String::new(),
            cf_email_api_token: String::new(),
        }
    }

    async fn fresh_db() -> Db {
        Db::initialize(&test_config(unique_cache_db_path()))
            .await
            .expect("initialize test database")
    }

    fn error_status(result: AppResult<AuthUser>) -> StatusCode {
        let Err(error) = result else {
            panic!("expected an error result");
        };
        error.into_response().status()
    }

    async fn seed_user(db: &Db, email: &str) -> i64 {
        let hash = hash_password("hunter2-correct").expect("hash");
        db.create_user(email.to_owned(), hash, "Test User".to_owned())
            .await
            .expect("create user")
    }

    async fn open_session(db: &Db, user_id: i64) -> String {
        let token = generate_session_token();
        db.create_session(token.clone(), user_id, now_ms() + 60_000)
            .await
            .expect("create session");
        token
    }

    #[tokio::test]
    async fn require_auth_accepts_a_valid_session() {
        let db = fresh_db().await;
        let id = seed_user(&db, "valid@example.com").await;
        let token = open_session(&db, id).await;
        let user = require_auth(&db, &headers_with_cookie(&format!("session={token}")))
            .await
            .expect("authenticated");
        assert_eq!(user.id, id);
        assert_eq!(user.email, "valid@example.com");
        assert_eq!(user.display_name, "Test User");
        assert!(!user.is_admin);
    }

    #[tokio::test]
    async fn require_auth_rejects_missing_cookie() {
        let db = fresh_db().await;
        assert_eq!(
            error_status(require_auth(&db, &HeaderMap::new()).await),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn require_auth_rejects_unknown_token() {
        let db = fresh_db().await;
        let result = require_auth(&db, &headers_with_cookie("session=not-a-real-token")).await;
        assert_eq!(error_status(result), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn require_auth_rejects_expired_session() {
        let db = fresh_db().await;
        let id = seed_user(&db, "expired@example.com").await;
        let token = generate_session_token();
        db.create_session(token.clone(), id, now_ms() - 1)
            .await
            .expect("create session");
        let result = require_auth(&db, &headers_with_cookie(&format!("session={token}"))).await;
        assert_eq!(error_status(result), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn require_auth_rejects_disabled_account() {
        let db = fresh_db().await;
        let id = seed_user(&db, "disabled@example.com").await;
        // Disable BEFORE opening the session: admin_set_disabled(true) clears
        // existing sessions, so create the session afterwards to exercise the
        // is_disabled branch rather than the "session missing" branch.
        db.admin_set_disabled(id, true).await.expect("disable");
        let token = open_session(&db, id).await;
        let err = require_auth(&db, &headers_with_cookie(&format!("session={token}")))
            .await
            .expect_err("disabled account must be rejected");
        assert_eq!(err.message(), Some("Account disabled."));
        assert_eq!(err.into_response().status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn require_auth_rejects_after_logout() {
        let db = fresh_db().await;
        let id = seed_user(&db, "logout@example.com").await;
        let token = open_session(&db, id).await;
        db.delete_session(token.clone()).await.expect("logout");
        let result = require_auth(&db, &headers_with_cookie(&format!("session={token}"))).await;
        assert_eq!(error_status(result), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn require_admin_forbids_non_admins() {
        let db = fresh_db().await;
        let id = seed_user(&db, "peasant@example.com").await;
        let token = open_session(&db, id).await;
        let err = require_admin(&db, &headers_with_cookie(&format!("session={token}")))
            .await
            .expect_err("non-admin must be forbidden");
        assert_eq!(err.into_response().status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn require_admin_allows_admins() {
        let db = fresh_db().await;
        let id = seed_user(&db, "boss@example.com").await;
        db.admin_set_admin(id, true).await.expect("promote");
        let token = open_session(&db, id).await;
        let user = require_admin(&db, &headers_with_cookie(&format!("session={token}")))
            .await
            .expect("admin authorized");
        assert!(user.is_admin);
        assert_eq!(user.id, id);
    }
}
