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
