use std::collections::HashMap;
use std::env;
use std::fmt;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use zeroize::Zeroizing;

use crate::error::{ApiError, AppResult};
use crate::persistence::Db;

pub const REAL_DEBRID_TOKEN_PREF_KEY: &str = "streamarena-real-debrid-api-key";

const KEYS_ENV_NAME: &str = "REAL_DEBRID_TOKEN_ENCRYPTION_KEYS";
const ENVELOPE_PREFIX: &str = "saenc:";
const ENVELOPE_VERSION: &str = "v1";
const NONCE_BYTES: usize = 12;
const KEY_BYTES: usize = 32;
const MAX_KEYS: usize = 16;

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenMigrationReport {
    pub plaintext_encrypted: usize,
    pub keys_rotated: usize,
}

struct KeyMaterial {
    bytes: Zeroizing<[u8; KEY_BYTES]>,
}

impl fmt::Debug for KeyMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("KeyMaterial([REDACTED])")
    }
}

/// Authenticated encryption for user-owned Real-Debrid tokens.
///
/// The first configured key is active for writes. Remaining keys are
/// decrypt-only, which lets an operator deploy a new key before retiring the
/// previous one. Key bytes are never included in Debug output and are zeroized
/// when the final clone of this value is dropped.
#[derive(Clone)]
pub struct RealDebridTokenCipher {
    active_key_id: Option<String>,
    keys: Arc<HashMap<String, Arc<KeyMaterial>>>,
}

impl fmt::Debug for RealDebridTokenCipher {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RealDebridTokenCipher")
            .field("enabled", &self.is_enabled())
            .field("active_key_id", &self.active_key_id)
            .field("key_count", &self.keys.len())
            .finish()
    }
}

impl RealDebridTokenCipher {
    /// Load the operator-managed key ring. An absent variable is allowed only
    /// while no token is stored; startup migration enforces that boundary.
    /// A present but malformed variable always aborts startup.
    pub fn from_env() -> AppResult<Self> {
        match env::var(KEYS_ENV_NAME) {
            Ok(spec) => {
                let spec = Zeroizing::new(spec);
                Self::from_spec(Some(spec.as_str()))
            }
            Err(env::VarError::NotPresent) => Self::from_spec(None),
            Err(env::VarError::NotUnicode(_)) => {
                Err(configuration_error("contains non-Unicode data"))
            }
        }
    }

    fn from_spec(spec: Option<&str>) -> AppResult<Self> {
        let Some(spec) = spec else {
            return Ok(Self {
                active_key_id: None,
                keys: Arc::new(HashMap::new()),
            });
        };
        if spec.trim().is_empty() {
            return Err(configuration_error("is empty"));
        }

        let entries = spec.split(',').collect::<Vec<_>>();
        if entries.len() > MAX_KEYS {
            return Err(configuration_error("contains too many keys"));
        }

        let mut active_key_id = None;
        let mut keys = HashMap::with_capacity(entries.len());
        for (index, raw_entry) in entries.into_iter().enumerate() {
            let entry_number = index + 1;
            let Some((raw_id, raw_key)) = raw_entry.trim().split_once(':') else {
                return Err(configuration_entry_error(
                    entry_number,
                    "must use key-id:base64url-key",
                ));
            };
            let key_id = raw_id.trim();
            if !is_valid_key_id(key_id) {
                return Err(configuration_entry_error(
                    entry_number,
                    "has an invalid key id",
                ));
            }
            if raw_key.contains(':') {
                return Err(configuration_entry_error(
                    entry_number,
                    "has an invalid key encoding",
                ));
            }
            let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(raw_key.trim()).map_err(|_| {
                configuration_entry_error(entry_number, "is not unpadded base64url")
            })?);
            if decoded.len() != KEY_BYTES {
                return Err(configuration_entry_error(
                    entry_number,
                    "must decode to exactly 32 bytes",
                ));
            }
            let mut bytes = Zeroizing::new([0_u8; KEY_BYTES]);
            bytes.copy_from_slice(&decoded);

            if keys
                .insert(key_id.to_owned(), Arc::new(KeyMaterial { bytes }))
                .is_some()
            {
                return Err(configuration_entry_error(
                    entry_number,
                    "repeats an earlier key id",
                ));
            }
            if active_key_id.is_none() {
                active_key_id = Some(key_id.to_owned());
            }
        }

        Ok(Self {
            active_key_id,
            keys: Arc::new(keys),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.active_key_id.is_some()
    }

    /// Encrypt every legacy plaintext token and re-encrypt every token that
    /// uses a non-active key before the HTTP listener starts. All ciphertexts
    /// are authenticated first, and the database replacements are committed in
    /// one transaction, so a bad/missing key or storage failure cannot produce
    /// a partial migration.
    pub async fn migrate_existing_tokens(&self, db: &Db) -> AppResult<TokenMigrationReport> {
        let rows = db
            .get_user_preferences_by_key(REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
            .await?;
        if rows.is_empty() {
            return Ok(TokenMigrationReport::default());
        }
        if !self.is_enabled() {
            return Err(ApiError::internal(format!(
                "{KEYS_ENV_NAME} is required because Real-Debrid tokens are already stored"
            )));
        }

        let mut report = TokenMigrationReport::default();
        let mut replacements = Vec::new();
        for (user_id, stored_value) in rows {
            if stored_value.starts_with(ENVELOPE_PREFIX) {
                let (plaintext, key_id) = self.decrypt_envelope(user_id, &stored_value)?;
                if self.active_key_id.as_deref() != Some(key_id.as_str()) {
                    replacements.push((
                        user_id,
                        stored_value,
                        self.encrypt_for_user(user_id, plaintext.as_str())?,
                    ));
                    report.keys_rotated += 1;
                }
            } else {
                let encrypted = self.encrypt_for_user(user_id, stored_value.as_str())?;
                replacements.push((user_id, stored_value, encrypted));
                report.plaintext_encrypted += 1;
            }
        }

        if !replacements.is_empty() {
            db.replace_user_preferences_if_unchanged(
                REAL_DEBRID_TOKEN_PREF_KEY.to_owned(),
                replacements,
            )
            .await?;
        }
        Ok(report)
    }

    pub fn encrypt_for_user(&self, user_id: i64, plaintext: &str) -> AppResult<String> {
        let key_id = self.active_key_id.as_deref().ok_or_else(|| {
            ApiError::service_unavailable(
                "Real-Debrid token storage is unavailable; encryption is not configured.",
            )
        })?;
        let key = self.keys.get(key_id).ok_or_else(|| {
            ApiError::internal("Real-Debrid token encryption key ring is inconsistent.")
        })?;
        let cipher = Aes256Gcm::new_from_slice(key.bytes.as_ref()).map_err(|_| {
            ApiError::internal("Real-Debrid token encryption could not be initialized.")
        })?;

        let mut nonce_bytes = [0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce_bytes).map_err(|_| {
            ApiError::internal("OS CSPRNG unavailable; refusing to store a Real-Debrid token.")
        })?;
        let aad = associated_data(user_id, key_id);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ApiError::internal("Real-Debrid token encryption failed."))?;

        Ok(format!(
            "{ENVELOPE_PREFIX}{ENVELOPE_VERSION}:{key_id}:{}:{}",
            URL_SAFE_NO_PAD.encode(nonce_bytes),
            URL_SAFE_NO_PAD.encode(ciphertext)
        ))
    }

    /// Runtime reads accept authenticated envelopes only. Legacy plaintext is
    /// handled exclusively by the startup migration, before requests can race
    /// with it.
    pub fn decrypt_for_user(&self, user_id: i64, stored_value: &str) -> AppResult<String> {
        if !stored_value.starts_with(ENVELOPE_PREFIX) {
            return Err(ApiError::internal(
                "Stored Real-Debrid token is not encrypted; restart with a configured key ring.",
            ));
        }
        self.decrypt_envelope(user_id, stored_value)
            .map(|(plaintext, _)| plaintext.to_string())
    }

    fn decrypt_envelope(
        &self,
        user_id: i64,
        stored_value: &str,
    ) -> AppResult<(Zeroizing<String>, String)> {
        let encoded = stored_value
            .strip_prefix(ENVELOPE_PREFIX)
            .ok_or_else(decryption_error)?;
        let mut fields = encoded.split(':');
        let version = fields.next().ok_or_else(decryption_error)?;
        let key_id = fields.next().ok_or_else(decryption_error)?;
        let nonce_encoded = fields.next().ok_or_else(decryption_error)?;
        let ciphertext_encoded = fields.next().ok_or_else(decryption_error)?;
        if fields.next().is_some()
            || version != ENVELOPE_VERSION
            || !is_valid_key_id(key_id)
            || nonce_encoded.is_empty()
            || ciphertext_encoded.is_empty()
        {
            return Err(decryption_error());
        }

        let key = self.keys.get(key_id).ok_or_else(|| {
            ApiError::internal(format!(
                "Stored Real-Debrid token requires an unavailable encryption key ({key_id})."
            ))
        })?;
        let nonce = URL_SAFE_NO_PAD
            .decode(nonce_encoded)
            .map_err(|_| decryption_error())?;
        if nonce.len() != NONCE_BYTES {
            return Err(decryption_error());
        }
        let ciphertext = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(ciphertext_encoded)
                .map_err(|_| decryption_error())?,
        );
        if ciphertext.len() < 16 {
            return Err(decryption_error());
        }

        let cipher =
            Aes256Gcm::new_from_slice(key.bytes.as_ref()).map_err(|_| decryption_error())?;
        let aad = associated_data(user_id, key_id);
        let plaintext_bytes = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: ciphertext.as_slice(),
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| decryption_error())?,
        );
        let plaintext = std::str::from_utf8(plaintext_bytes.as_slice())
            .map_err(|_| decryption_error())?
            .to_owned();
        Ok((Zeroizing::new(plaintext), key_id.to_owned()))
    }
}

fn associated_data(user_id: i64, key_id: &str) -> String {
    format!(
        "streamarena|real-debrid-token|{ENVELOPE_VERSION}|preference:{REAL_DEBRID_TOKEN_PREF_KEY}|user:{user_id}|key:{key_id}"
    )
}

fn is_valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn configuration_error(detail: &str) -> ApiError {
    ApiError::internal(format!("{KEYS_ENV_NAME} {detail}."))
}

fn configuration_entry_error(entry_number: usize, detail: &str) -> ApiError {
    ApiError::internal(format!("{KEYS_ENV_NAME} entry {entry_number} {detail}."))
}

fn decryption_error() -> ApiError {
    ApiError::internal(
        "Stored Real-Debrid token could not be authenticated; check the encryption key ring.",
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEST_DB_SEQ: AtomicU64 = AtomicU64::new(0);

    fn key(byte: u8) -> String {
        URL_SAFE_NO_PAD.encode([byte; KEY_BYTES])
    }

    fn cipher(spec: &str) -> RealDebridTokenCipher {
        RealDebridTokenCipher::from_spec(Some(spec)).expect("valid test key ring")
    }

    fn error_message<T>(result: AppResult<T>) -> String {
        result
            .err()
            .and_then(|error| error.message().map(str::to_owned))
            .expect("expected error message")
    }

    #[test]
    fn round_trip_uses_random_nonces_and_user_bound_aad() {
        let cipher = cipher(&format!("primary:{}", key(7)));
        let plaintext = "abcdefghijklmnopqrstuvwxyz0123456789";
        let first = cipher.encrypt_for_user(41, plaintext).expect("encrypt");
        let second = cipher
            .encrypt_for_user(41, plaintext)
            .expect("encrypt again");

        assert_ne!(
            first, second,
            "fresh nonce must produce distinct ciphertext"
        );
        assert!(!first.contains(plaintext));
        assert_eq!(
            cipher.decrypt_for_user(41, &first).expect("decrypt"),
            plaintext
        );
        let error = error_message(cipher.decrypt_for_user(42, &first));
        assert!(!error.contains(plaintext));
    }

    #[test]
    fn rotation_reads_the_previous_key_and_rewrites_with_the_active_key() {
        let old = cipher(&format!("old:{}", key(1)));
        let old_envelope = old
            .encrypt_for_user(5, "abcdefghijklmnopqrstuvwxyz")
            .expect("old encrypt");
        let rotated = cipher(&format!("new:{},old:{}", key(2), key(1)));
        let (plaintext, old_key_id) = rotated
            .decrypt_envelope(5, &old_envelope)
            .expect("old key retained for reads");
        assert_eq!(old_key_id, "old");
        let new_envelope = rotated
            .encrypt_for_user(5, plaintext.as_str())
            .expect("new encrypt");
        assert!(new_envelope.starts_with("saenc:v1:new:"));
        assert_eq!(
            rotated
                .decrypt_for_user(5, &new_envelope)
                .expect("new decrypt"),
            plaintext.as_str()
        );

        let new_only = cipher(&format!("new:{}", key(2)));
        let error = error_message(new_only.decrypt_for_user(5, &old_envelope));
        assert!(error.contains("unavailable encryption key"));
    }

    #[test]
    fn malformed_configuration_and_tampering_fail_without_echoing_secrets() {
        let secret_key_text = "not-a-valid-secret-key";
        let error = error_message(RealDebridTokenCipher::from_spec(Some(&format!(
            "primary:{secret_key_text}"
        ))));
        assert!(!error.contains(secret_key_text));

        let duplicate = format!("same:{},same:{}", key(1), key(2));
        assert!(
            error_message(RealDebridTokenCipher::from_spec(Some(&duplicate))).contains("repeats")
        );

        let key_text = key(3);
        let cipher = cipher(&format!("primary:{key_text}"));
        assert!(!format!("{cipher:?}").contains(&key_text));
        let plaintext = "super-secret-real-debrid-token";
        let mut envelope = cipher.encrypt_for_user(9, plaintext).expect("encrypt");
        let last = envelope.pop().expect("ciphertext suffix");
        envelope.push(if last == 'A' { 'B' } else { 'A' });
        let error = error_message(cipher.decrypt_for_user(9, &envelope));
        assert!(!error.contains(plaintext));
        assert!(error.contains("could not be authenticated"));
    }

    #[tokio::test]
    async fn startup_migrates_all_plaintext_rows_atomically_and_rotates_old_rows() {
        let seq = TEST_DB_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "streamarena-secret-store-{}-{seq}",
            crate::utils::now_ms()
        ));
        let cache_path = root.join("resolver-cache.sqlite");
        let users_path = root.join("users.sqlite");
        let db = Db::initialize_test_paths(cache_path, users_path)
            .await
            .expect("initialize test db");
        let user_one = db
            .create_user(
                "one@example.com".to_owned(),
                "test-password-hash".to_owned(),
                "One".to_owned(),
            )
            .await
            .expect("create first user");
        let user_two = db
            .create_user(
                "two@example.com".to_owned(),
                "test-password-hash".to_owned(),
                "Two".to_owned(),
            )
            .await
            .expect("create second user");
        let token_one = "abcdefghijklmnopqrstuvwxyz0123456789";
        let token_two = "9876543210zyxwvutsrqponmlkjihgfedcba";
        db.upsert_user_preferences_for_users(
            REAL_DEBRID_TOKEN_PREF_KEY.to_owned(),
            vec![
                (user_one, token_one.to_owned()),
                (user_two, token_two.to_owned()),
            ],
        )
        .await
        .expect("seed plaintext");

        let conflict = db
            .replace_user_preferences_if_unchanged(
                REAL_DEBRID_TOKEN_PREF_KEY.to_owned(),
                vec![
                    (user_one, token_one.to_owned(), "must-rollback".to_owned()),
                    (
                        user_two,
                        "stale-value".to_owned(),
                        "must-not-write".to_owned(),
                    ),
                ],
            )
            .await;
        assert!(conflict.is_err(), "stale migration snapshot must fail");
        assert_eq!(
            db.get_user_preference(user_one, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
                .await
                .expect("read row after rollback")
                .as_deref(),
            Some(token_one),
            "the earlier update in the failed transaction must roll back"
        );

        let first = cipher(&format!("old:{}", key(4)));
        let report = first
            .migrate_existing_tokens(&db)
            .await
            .expect("migrate plaintext");
        assert_eq!(report.plaintext_encrypted, 2);
        assert_eq!(report.keys_rotated, 0);
        let encrypted_rows = db
            .get_user_preferences_by_key(REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
            .await
            .expect("read encrypted rows");
        assert_eq!(encrypted_rows.len(), 2);
        for (user_id, envelope) in &encrypted_rows {
            assert!(envelope.starts_with("saenc:v1:old:"));
            assert!(!envelope.contains(if *user_id == user_one {
                token_one
            } else {
                token_two
            }));
        }

        let rotated = cipher(&format!("new:{},old:{}", key(5), key(4)));
        let report = rotated
            .migrate_existing_tokens(&db)
            .await
            .expect("rotate stored rows");
        assert_eq!(report.plaintext_encrypted, 0);
        assert_eq!(report.keys_rotated, 2);
        let rotated_rows = db
            .get_user_preferences_by_key(REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
            .await
            .expect("read rotated rows");
        for (user_id, envelope) in rotated_rows {
            assert!(envelope.starts_with("saenc:v1:new:"));
            assert_eq!(
                rotated
                    .decrypt_for_user(user_id, &envelope)
                    .expect("decrypt rotated row"),
                if user_id == user_one {
                    token_one
                } else {
                    token_two
                }
            );
        }

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn startup_fails_closed_when_stored_tokens_have_no_usable_key() {
        let seq = TEST_DB_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "streamarena-secret-store-missing-key-{}-{seq}",
            crate::utils::now_ms()
        ));
        let db = Db::initialize_test_paths(
            root.join("resolver-cache.sqlite"),
            root.join("users.sqlite"),
        )
        .await
        .expect("initialize test db");
        let user_id = db
            .create_user(
                "missing-key@example.com".to_owned(),
                "test-password-hash".to_owned(),
                "Missing Key".to_owned(),
            )
            .await
            .expect("create user");
        let token = "this-token-must-never-appear-in-an-error";
        db.upsert_user_preferences_for_users(
            REAL_DEBRID_TOKEN_PREF_KEY.to_owned(),
            vec![(user_id, token.to_owned())],
        )
        .await
        .expect("seed plaintext");

        let disabled = RealDebridTokenCipher::from_spec(None).expect("disabled cipher");
        let error = error_message(disabled.migrate_existing_tokens(&db).await);
        assert!(error.contains(KEYS_ENV_NAME));
        assert!(!error.contains(token));
        assert_eq!(
            db.get_user_preference(user_id, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
                .await
                .expect("read unchanged row")
                .as_deref(),
            Some(token)
        );

        let old = cipher(&format!("old:{}", key(8)));
        let encrypted = old
            .encrypt_for_user(user_id, token)
            .expect("encrypt old row");
        db.upsert_user_preferences_for_users(
            REAL_DEBRID_TOKEN_PREF_KEY.to_owned(),
            vec![(user_id, encrypted)],
        )
        .await
        .expect("store old envelope");
        let wrong = cipher(&format!("new:{}", key(9)));
        let error = error_message(wrong.migrate_existing_tokens(&db).await);
        assert!(error.contains("unavailable encryption key"));
        assert!(!error.contains(token));

        let _ = std::fs::remove_dir_all(root);
    }
}
