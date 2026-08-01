use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::utils::now_ms;

fn migration_checksum(sql: &str) -> String {
    Sha256::digest(sql.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Apply one append-only users-database migration atomically.
///
/// A stored checksum makes migration text immutable after release. The schema
/// statements and ledger row share a transaction, so a crash or bad statement
/// cannot leave an unrecorded half-migration behind.
pub(super) fn apply_named_migration(
    connection: &Connection,
    migration_id: &str,
    sql: &str,
) -> Result<(), rusqlite::Error> {
    let checksum = migration_checksum(sql);
    let existing = connection
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE migration_id = ?",
            [migration_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        return if existing == checksum {
            Ok(())
        } else {
            Err(rusqlite::Error::InvalidQuery)
        };
    }

    let tx = connection.unchecked_transaction()?;
    tx.execute_batch(sql)?;
    tx.execute(
        "INSERT INTO schema_migrations (migration_id, checksum, applied_at) VALUES (?, ?, ?)",
        params![migration_id, checksum, now_ms()],
    )?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::apply_named_migration;
    use rusqlite::{Connection, OptionalExtension};

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                   migration_id TEXT PRIMARY KEY,
                   checksum TEXT NOT NULL,
                   applied_at INTEGER NOT NULL
                 );",
            )
            .expect("migration ledger");
        connection
    }

    #[test]
    fn migration_and_ledger_commit_together_and_replay_is_idempotent() {
        let connection = connection();
        let sql = "CREATE TABLE durable_example (id INTEGER PRIMARY KEY);";
        apply_named_migration(&connection, "example-v1", sql).expect("first apply");
        apply_named_migration(&connection, "example-v1", sql).expect("idempotent replay");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = 'example-v1'",
                [],
                |row| row.get(0),
            )
            .expect("ledger count");
        assert_eq!(count, 1);
        assert!(
            apply_named_migration(
                &connection,
                "example-v1",
                "CREATE TABLE durable_example_changed (id INTEGER PRIMARY KEY);",
            )
            .is_err()
        );
    }

    #[test]
    fn failed_migration_rolls_back_every_prior_statement() {
        let connection = connection();
        let result = apply_named_migration(
            &connection,
            "broken-v1",
            "CREATE TABLE must_rollback (id INTEGER PRIMARY KEY); THIS IS NOT SQL;",
        );
        assert!(result.is_err());
        let table = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_rollback'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .expect("query schema");
        assert_eq!(table, None, "partial DDL must roll back");
        let ledger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = 'broken-v1'",
                [],
                |row| row.get(0),
            )
            .expect("ledger count");
        assert_eq!(ledger_count, 0);
    }
}
