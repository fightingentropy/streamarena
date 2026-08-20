use rusqlite::{Connection, OptionalExtension, params};
use tokio::task;

use crate::error::{ApiError, AppResult};
use crate::utils::now_ms;

use super::{Db, return_connection, take_connection};

impl Db {
    pub async fn delete_real_debrid_playback_sessions_for_user(
        &self,
        user_id: i64,
    ) -> AppResult<()> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM playback_sessions
                 WHERE user_id = ? AND session_key LIKE ?",
                params![user_id, format!("real-debrid:user:{}:%", user_id.max(0))],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }
    pub async fn get_user_preferences(&self, user_id: i64) -> AppResult<Vec<(String, String)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection.prepare(
                    "SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?",
                )?;
                stmt.query_map([user_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            return_connection(&pool, connection);
            Ok::<Vec<(String, String)>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn get_user_preference(
        &self,
        user_id: i64,
        pref_key: String,
    ) -> AppResult<Option<String>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let value = {
                let mut stmt = connection.prepare(
                    "SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = ?",
                )?;
                stmt.query_row(params![user_id, pref_key], |row| row.get::<_, String>(0))
                    .optional()?
            };
            return_connection(&pool, connection);
            Ok::<Option<String>, rusqlite::Error>(value)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// All values for one preference key, including their owning user id. This
    /// is intentionally narrow: it supports startup secret migration without
    /// exposing unrelated user preferences to the encryption layer.
    pub async fn get_user_preferences_by_key(
        &self,
        pref_key: String,
    ) -> AppResult<Vec<(i64, String)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection.prepare(
                    "SELECT user_id, pref_value FROM user_preferences WHERE pref_key = ?",
                )?;
                stmt.query_map([pref_key], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            return_connection(&pool, connection);
            Ok::<Vec<(i64, String)>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn upsert_user_preferences(
        &self,
        user_id: i64,
        entries: Vec<(String, String)>,
    ) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let tx = connection.unchecked_transaction()?;
            for (key, value) in &entries {
                tx.execute(
                    "INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id, pref_key) DO UPDATE SET
                       pref_value = excluded.pref_value,
                       updated_at = excluded.updated_at",
                    params![user_id, key, value, now],
                )?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Apply preference upserts and deletions in one durable-user transaction.
    /// This is used for settings whose individual rows form one security
    /// decision (for example, a credential and its explicit enabled flag).
    pub async fn apply_real_debrid_preference_changes(
        &self,
        user_id: i64,
        changes: Vec<(String, Option<String>)>,
        token_key: String,
        enabled_key: String,
    ) -> AppResult<()> {
        if changes.is_empty() {
            return Ok(());
        }
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let invariant_satisfied = task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let invariant_satisfied = apply_preference_changes_with_required_token(
                &connection,
                user_id,
                changes,
                &token_key,
                &enabled_key,
            )?;
            return_connection(&pool, connection);
            Ok::<bool, rusqlite::Error>(invariant_satisfied)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        if !invariant_satisfied {
            return Err(ApiError::failed_dependency(
                "Add a Real-Debrid API token before enabling cached streaming.",
            ));
        }
        Ok(())
    }

    /// Replace one preference for multiple users in a single transaction.
    /// Used by secret migration/key rotation so an authentication or storage
    /// failure cannot leave a partially rewritten key ring generation.
    #[cfg(test)]
    pub async fn upsert_user_preferences_for_users(
        &self,
        pref_key: String,
        entries: Vec<(i64, String)>,
    ) -> AppResult<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let tx = connection.unchecked_transaction()?;
            for (user_id, value) in entries {
                tx.execute(
                    "INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id, pref_key) DO UPDATE SET
                       pref_value = excluded.pref_value,
                       updated_at = excluded.updated_at",
                    params![user_id, pref_key, value, now],
                )?;
            }
            tx.commit()?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    /// Atomically replace already-read preference values. If another process
    /// changes any row between the migration read and write, the transaction is
    /// rolled back rather than overwriting the newer value.
    pub async fn replace_user_preferences_if_unchanged(
        &self,
        pref_key: String,
        entries: Vec<(i64, String, String)>,
    ) -> AppResult<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        let all_replaced = task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let now = now_ms();
            let tx = connection.unchecked_transaction()?;
            let mut all_replaced = true;
            for (user_id, expected_value, replacement_value) in entries {
                let changed = tx.execute(
                    "UPDATE user_preferences
                     SET pref_value = ?, updated_at = ?
                     WHERE user_id = ? AND pref_key = ? AND pref_value = ?",
                    params![replacement_value, now, user_id, pref_key, expected_value],
                )?;
                if changed != 1 {
                    all_replaced = false;
                    break;
                }
            }
            if all_replaced {
                tx.commit()?;
            } else {
                drop(tx);
            }
            return_connection(&pool, connection);
            Ok::<bool, rusqlite::Error>(all_replaced)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        if !all_replaced {
            return Err(ApiError::internal(
                "A stored Real-Debrid token changed during encryption migration; restart to retry safely.",
            ));
        }
        Ok(())
    }

    /// All admin provider-URL overrides as (key, value). Loaded into the
    /// `provider_registry` at startup; see also the admin Providers dashboard.
    pub async fn get_provider_overrides(&self) -> AppResult<Vec<(String, String)>> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let rows = {
                let mut stmt = connection
                    .prepare("SELECT provider_key, override_value FROM provider_overrides")?;
                stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            return_connection(&pool, connection);
            Ok::<Vec<(String, String)>, rusqlite::Error>(rows)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn set_provider_override(&self, key: String, value: String) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "INSERT INTO provider_overrides (provider_key, override_value, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(provider_key) DO UPDATE SET
                   override_value = excluded.override_value,
                   updated_at = excluded.updated_at",
                params![key, value, now_ms()],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    pub async fn delete_provider_override(&self, key: String) -> AppResult<()> {
        let path = self.users_path.clone();
        let pool = self.users_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            connection.execute(
                "DELETE FROM provider_overrides WHERE provider_key = ?",
                params![key],
            )?;
            return_connection(&pool, connection);
            Ok::<(), rusqlite::Error>(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }
}

fn apply_preference_changes_with_required_token(
    connection: &Connection,
    user_id: i64,
    changes: Vec<(String, Option<String>)>,
    token_key: &str,
    enabled_key: &str,
) -> Result<bool, rusqlite::Error> {
    let now = now_ms();
    let tx = connection.unchecked_transaction()?;
    for (key, value) in changes {
        if let Some(value) = value {
            tx.execute(
                "INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, pref_key) DO UPDATE SET
                   pref_value = excluded.pref_value,
                   updated_at = excluded.updated_at",
                params![user_id, key, value, now],
            )?;
        } else {
            tx.execute(
                "DELETE FROM user_preferences WHERE user_id = ? AND pref_key = ?",
                params![user_id, key],
            )?;
        }
    }
    let enabled = tx
        .query_row(
            "SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = ?",
            params![user_id, enabled_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .is_some_and(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"));
    let token_exists = tx
        .query_row(
            "SELECT 1 FROM user_preferences WHERE user_id = ? AND pref_key = ?",
            params![user_id, token_key],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if enabled && !token_exists {
        drop(tx);
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use super::apply_preference_changes_with_required_token;

    #[test]
    fn real_debrid_preference_transaction_preserves_enabled_requires_token_invariant() {
        let connection = Connection::open_in_memory().expect("open sqlite");
        connection
            .execute_batch(
                "CREATE TABLE user_preferences (
                    user_id INTEGER NOT NULL,
                    pref_key TEXT NOT NULL,
                    pref_value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, pref_key)
                );",
            )
            .expect("create preferences table");
        for (key, value) in [("rd-token", "encrypted"), ("rd-enabled", "1")] {
            connection
                .execute(
                    "INSERT INTO user_preferences VALUES (1, ?, ?, 0)",
                    params![key, value],
                )
                .expect("seed preference");
        }

        assert!(
            apply_preference_changes_with_required_token(
                &connection,
                1,
                vec![
                    ("rd-token".to_owned(), None),
                    ("rd-enabled".to_owned(), Some("0".to_owned())),
                    ("local-enabled".to_owned(), Some("1".to_owned())),
                ],
                "rd-token",
                "rd-enabled",
            )
            .expect("clear and disable atomically")
        );

        assert!(
            !apply_preference_changes_with_required_token(
                &connection,
                1,
                vec![("rd-enabled".to_owned(), Some("1".to_owned()))],
                "rd-token",
                "rd-enabled",
            )
            .expect("reject stale enable plan")
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT pref_value FROM user_preferences
                     WHERE user_id = 1 AND pref_key = 'rd-enabled'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read enabled flag"),
            "0"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT pref_value FROM user_preferences
                     WHERE user_id = 1 AND pref_key = 'local-enabled'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read local flag"),
            "1"
        );
    }
}
