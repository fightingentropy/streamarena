//! Transactional email via the Cloudflare Email Sending REST API.
//!
//! The app runs as a standalone Rust server (not a Cloudflare Worker), so it
//! cannot use the `send_email` Worker binding. Instead it calls the Email
//! Sending REST API directly with an API token. Sending is always best-effort:
//! if email is unconfigured or the request fails, callers continue normally so
//! that account sign-up never breaks on an email problem.

use std::fmt::Write as _;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::routes::AppState;

/// Cap on concurrent outbound email sends, with a per-send timeout. Each signup
/// spawns one send task; without a bound a slow Cloudflare endpoint would let a
/// burst pile up (one socket + the shared client's 30s timeout each). 16 is
/// ample for transactional email and keeps the worst case small.
static EMAIL_CONCURRENCY: Semaphore = Semaphore::const_new(16);
const EMAIL_SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// Bounded, time-boxed POST to the Cloudflare email send endpoint. Acquires an
/// [`EMAIL_CONCURRENCY`] permit, sends with a [`EMAIL_SEND_TIMEOUT`] cap, logs
/// the outcome, and returns `true` only when Cloudflare accepted the message.
/// `kind` is the email type for log lines (e.g. "verification").
async fn post_cloudflare_email(
    state: &AppState,
    endpoint: &str,
    payload: &serde_json::Value,
    kind: &str,
    to_email: &str,
) -> bool {
    let Ok(_permit) = EMAIL_CONCURRENCY.acquire().await else {
        return false;
    };
    let send = state
        .http_client
        .post(endpoint)
        .bearer_auth(&state.config.cf_email_api_token)
        .json(payload)
        .send();
    match tokio::time::timeout(EMAIL_SEND_TIMEOUT, send).await {
        Ok(Ok(response)) => {
            let status = response.status();
            if status.is_success() {
                tracing::info!("sent {kind} email to {to_email}");
                true
            } else {
                let body = response.text().await.unwrap_or_default();
                tracing::error!("{kind} email to {to_email} rejected ({status}): {body}");
                false
            }
        }
        Ok(Err(error)) => {
            tracing::error!("{kind} email to {to_email} failed: {error}");
            false
        }
        Err(_elapsed) => {
            tracing::error!(
                "{kind} email to {to_email} timed out after {}s",
                EMAIL_SEND_TIMEOUT.as_secs()
            );
            false
        }
    }
}

/// How long a verification link stays valid (24 hours, in milliseconds).
pub const VERIFY_TOKEN_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// How long a password-reset link stays valid (1 hour, in milliseconds). Reset
/// links are shorter-lived than verification links because they grant account
/// access.
pub const RESET_TOKEN_TTL_MS: i64 = 60 * 60 * 1000;

/// SHA-256 hex digest. Verification tokens are stored hashed at rest so a
/// database leak does not hand out working links.
pub fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Send an email-verification link via Cloudflare Email Sending.
///
/// Returns `true` only when Cloudflare accepted the message. Returns `false`
/// (after logging) when email is not configured or the send fails — the caller
/// should treat that as a soft failure, not an error.
pub async fn send_verification_email(state: &AppState, to_email: &str, raw_token: &str) -> bool {
    let config = &state.config;
    if config.cf_email_api_token.is_empty()
        || config.cf_account_id.is_empty()
        || config.email_from.is_empty()
    {
        tracing::warn!(
            "email verification not configured (set CF_EMAIL_API_TOKEN, CF_ACCOUNT_ID, EMAIL_FROM); \
             skipping verification email to {to_email}"
        );
        return false;
    }

    // Path-based token (not a query param): a raw token in a query string can be
    // mangled by quoted-printable email encoding, corrupting the link.
    let app_origin = crate::provider_registry::resolve(
        crate::provider_registry::keys::INFRA_APP_ORIGIN,
        &config.app_origin,
    );
    let link = format!("{}/api/auth/verify/{}", app_origin, raw_token);
    let text = format!(
        "Welcome to StreamArena.\n\nConfirm your email address by opening this link:\n{link}\n\n\
         This link expires in 24 hours. If you did not create this account, you can ignore this email."
    );
    let html = verification_email_html(&link);

    let endpoint = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/email/sending/send",
        config.cf_account_id
    );
    let payload = serde_json::json!({
        "to": to_email,
        "from": config.email_from,
        "subject": "Verify your email",
        "text": text,
        "html": html,
    });

    post_cloudflare_email(state, &endpoint, &payload, "verification", to_email).await
}

/// StreamArena-branded HTML body for the verification email (brand red `#e50914`).
fn verification_email_html(link: &str) -> String {
    format!(
        r#"<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#ffffff;background:#141414">
  <div style="font-size:28px;font-weight:800;color:#e50914;letter-spacing:-0.5px;margin:0 0 24px">StreamArena</div>
  <h1 style="font-size:22px;margin:0 0 12px;color:#ffffff">Confirm your email</h1>
  <p style="margin:0 0 24px;line-height:1.5;color:#b3b3b3">Welcome! Tap the button below to verify your email address and finish setting up your account.</p>
  <p style="margin:0 0 28px"><a href="{link}" style="display:inline-block;background:#e50914;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:600">Verify email</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#808080">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="{link}" style="color:#e50914">{link}</a></p>
  <p style="margin:0;font-size:12px;color:#666666">This link expires in 24 hours. If you did not create this account, you can ignore this email.</p>
</div>"#
    )
}

/// Send a password-reset link via Cloudflare Email Sending. Best-effort like
/// [`send_verification_email`]: returns `false` (after logging) when email is
/// unconfigured or the send fails.
pub async fn send_password_reset_email(state: &AppState, to_email: &str, raw_token: &str) -> bool {
    let config = &state.config;
    if config.cf_email_api_token.is_empty()
        || config.cf_account_id.is_empty()
        || config.email_from.is_empty()
    {
        tracing::warn!(
            "email not configured (set CF_EMAIL_API_TOKEN, CF_ACCOUNT_ID, EMAIL_FROM); \
             skipping password-reset email to {to_email}"
        );
        return false;
    }

    // Links to the reset page (where the user picks a new password), not an API
    // endpoint. Path-based token to avoid quoted-printable query mangling.
    let app_origin = crate::provider_registry::resolve(
        crate::provider_registry::keys::INFRA_APP_ORIGIN,
        &config.app_origin,
    );
    let link = format!("{}/reset-password/{}", app_origin, raw_token);
    let text = format!(
        "Reset your StreamArena password.\n\nOpen this link to choose a new password:\n{link}\n\n\
         This link expires in 1 hour. If you did not request a password reset, you can ignore this email."
    );
    let html = password_reset_email_html(&link);

    let endpoint = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/email/sending/send",
        config.cf_account_id
    );
    let payload = serde_json::json!({
        "to": to_email,
        "from": config.email_from,
        "subject": "Reset your password",
        "text": text,
        "html": html,
    });

    post_cloudflare_email(state, &endpoint, &payload, "password-reset", to_email).await
}

/// StreamArena-branded HTML body for the password-reset email (brand red `#e50914`).
fn password_reset_email_html(link: &str) -> String {
    format!(
        r#"<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#ffffff;background:#141414">
  <div style="font-size:28px;font-weight:800;color:#e50914;letter-spacing:-0.5px;margin:0 0 24px">StreamArena</div>
  <h1 style="font-size:22px;margin:0 0 12px;color:#ffffff">Reset your password</h1>
  <p style="margin:0 0 24px;line-height:1.5;color:#b3b3b3">We received a request to reset your password. Tap the button below to choose a new one.</p>
  <p style="margin:0 0 28px"><a href="{link}" style="display:inline-block;background:#e50914;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:600">Reset password</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#808080">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="{link}" style="color:#e50914">{link}</a></p>
  <p style="margin:0;font-size:12px;color:#666666">This link expires in 1 hour. If you did not request a password reset, you can ignore this email.</p>
</div>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_stable_and_lowercase() {
        // Known SHA-256 of the empty string.
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // Same input → same digest; different input → different digest.
        assert_eq!(sha256_hex("token-abc"), sha256_hex("token-abc"));
        assert_ne!(sha256_hex("token-abc"), sha256_hex("token-abd"));
    }

    #[test]
    fn verification_html_embeds_link_and_brand_color() {
        let html = verification_email_html("https://streamarena.xyz/api/auth/verify/deadbeef");
        assert!(html.contains("https://streamarena.xyz/api/auth/verify/deadbeef"));
        assert!(html.contains("#e50914"));
    }
}
