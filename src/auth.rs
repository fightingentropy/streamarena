use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::http::HeaderMap;

use crate::error::{ApiError, AppResult};
use crate::persistence::Db;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
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

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();

    if expires_at <= now_ms {
        return Err(ApiError::unauthorized("Session expired."));
    }

    let (id, username, _password_hash, display_name) = db
        .get_user_by_id(user_id)
        .await?
        .ok_or_else(|| ApiError::unauthorized("User not found."))?;

    Ok(AuthUser {
        id,
        username,
        display_name,
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
