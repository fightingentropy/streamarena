use rusqlite::{Connection, OptionalExtension, params};

pub(super) const WATCH_PROGRESS_DOMAIN: &str = "watch_progress";
pub(super) const CONTINUE_WATCHING_DOMAIN: &str = "continue_watching";

pub(super) const TOMBSTONE_MIGRATION_SQL: &str = "
    CREATE TABLE IF NOT EXISTS user_state_tombstones (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_domain TEXT NOT NULL,
      item_identity TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, state_domain, item_identity)
    );
    CREATE INDEX IF NOT EXISTS idx_user_state_tombstones_deleted
      ON user_state_tombstones(deleted_at);
";

pub(super) fn mutation_is_blocked_by_tombstone(
    connection: &Connection,
    user_id: i64,
    domain: &str,
    identity: &str,
    updated_at: i64,
) -> Result<bool, rusqlite::Error> {
    let deleted_at = connection
        .query_row(
            "SELECT deleted_at FROM user_state_tombstones
             WHERE user_id = ? AND state_domain = ? AND item_identity = ?",
            params![user_id, domain, identity],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(deleted_at.is_some_and(|deleted_at| deleted_at >= updated_at))
}

pub(super) fn clear_obsolete_tombstone(
    connection: &Connection,
    user_id: i64,
    domain: &str,
    identity: &str,
    updated_at: i64,
) -> Result<(), rusqlite::Error> {
    connection.execute(
        "DELETE FROM user_state_tombstones
         WHERE user_id = ? AND state_domain = ? AND item_identity = ? AND deleted_at < ?",
        params![user_id, domain, identity, updated_at],
    )?;
    Ok(())
}

pub(super) fn record_tombstone(
    connection: &Connection,
    user_id: i64,
    domain: &str,
    identity: &str,
    deleted_at: i64,
) -> Result<(), rusqlite::Error> {
    connection.execute(
        "INSERT INTO user_state_tombstones
           (user_id, state_domain, item_identity, deleted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, state_domain, item_identity) DO UPDATE SET
           deleted_at = MAX(user_state_tombstones.deleted_at, excluded.deleted_at)",
        params![user_id, domain, identity, deleted_at],
    )?;
    Ok(())
}

pub(super) fn tombstone_watch_progress_series(
    connection: &Connection,
    user_id: i64,
    series_id: &str,
    tmdb_id: Option<&str>,
    deleted_at: i64,
) -> Result<(), rusqlite::Error> {
    let series_prefix = format!("series:{series_id}:episode:");
    let tmdb_prefix = tmdb_id.map(|value| format!("tmdb:tv:{value}"));
    let identities = {
        let mut statement = connection
            .prepare("SELECT source_identity FROM user_watch_progress WHERE user_id = ?")?;
        statement
            .query_map([user_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for identity in identities {
        let is_series = identity.to_ascii_lowercase().starts_with(&series_prefix);
        let is_tmdb = tmdb_prefix.as_ref().is_some_and(|prefix| {
            identity.eq_ignore_ascii_case(prefix)
                || identity
                    .to_ascii_lowercase()
                    .starts_with(&format!("{}:", prefix.to_ascii_lowercase()))
        });
        if is_series || is_tmdb {
            record_tombstone(
                connection,
                user_id,
                WATCH_PROGRESS_DOMAIN,
                &identity,
                deleted_at,
            )?;
        }
    }
    Ok(())
}

pub(super) fn tombstone_continue_series(
    connection: &Connection,
    user_id: i64,
    series_id: &str,
    tmdb_id: Option<&str>,
    deleted_at: i64,
    except_identity: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let series_prefix = format!("series:{series_id}:episode:");
    let tmdb_prefix = tmdb_id.map(|value| format!("tmdb:tv:{value}"));
    let rows = {
        let mut statement = connection.prepare(
            "SELECT source_identity, lower(series_id), tmdb_id, lower(media_type)
             FROM user_continue_watching WHERE user_id = ?",
        )?;
        statement
            .query_map([user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (identity, row_series_id, row_tmdb_id, media_type) in rows {
        if except_identity.is_some_and(|except| identity == except) {
            continue;
        }
        let is_series =
            row_series_id == series_id || identity.to_ascii_lowercase().starts_with(&series_prefix);
        let is_tmdb = tmdb_id.is_some_and(|value| {
            (media_type == "tv" && row_tmdb_id == value)
                || tmdb_prefix.as_ref().is_some_and(|prefix| {
                    identity.eq_ignore_ascii_case(prefix)
                        || identity
                            .to_ascii_lowercase()
                            .starts_with(&format!("{}:", prefix.to_ascii_lowercase()))
                })
        });
        if is_series || is_tmdb {
            record_tombstone(
                connection,
                user_id,
                CONTINUE_WATCHING_DOMAIN,
                &identity,
                deleted_at,
            )?;
        }
    }
    Ok(())
}

pub(super) fn latest_continue_series_updated_at(
    connection: &Connection,
    user_id: i64,
    series_id: &str,
    tmdb_id: Option<&str>,
) -> Result<i64, rusqlite::Error> {
    let series_prefix = format!("series:{series_id}:episode:");
    let tmdb_prefix = tmdb_id.map(|value| format!("tmdb:tv:{value}"));
    let rows = {
        let mut statement = connection.prepare(
            "SELECT source_identity, lower(series_id), tmdb_id, lower(media_type), updated_at
             FROM user_continue_watching WHERE user_id = ?",
        )?;
        statement
            .query_map([user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows
        .into_iter()
        .filter(|(identity, row_series_id, row_tmdb_id, media_type, _)| {
            row_series_id == series_id
                || identity.to_ascii_lowercase().starts_with(&series_prefix)
                || tmdb_id.is_some_and(|value| {
                    (media_type == "tv" && row_tmdb_id == value)
                        || tmdb_prefix.as_ref().is_some_and(|prefix| {
                            identity.eq_ignore_ascii_case(prefix)
                                || identity
                                    .to_ascii_lowercase()
                                    .starts_with(&format!("{}:", prefix.to_ascii_lowercase()))
                        })
                })
        })
        .map(|(_, _, _, _, updated_at)| updated_at)
        .max()
        .unwrap_or(0))
}

pub(super) fn upsert_watch_progress(
    connection: &Connection,
    user_id: i64,
    identity: &str,
    resume_seconds: f64,
    updated_at: i64,
) -> Result<bool, rusqlite::Error> {
    let tx = connection.unchecked_transaction()?;
    if mutation_is_blocked_by_tombstone(&tx, user_id, WATCH_PROGRESS_DOMAIN, identity, updated_at)?
    {
        tx.commit()?;
        return Ok(false);
    }
    clear_obsolete_tombstone(&tx, user_id, WATCH_PROGRESS_DOMAIN, identity, updated_at)?;
    let changed = tx.execute(
        "INSERT INTO user_watch_progress
           (user_id, source_identity, resume_seconds, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, source_identity) DO UPDATE SET
           resume_seconds = excluded.resume_seconds,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= user_watch_progress.updated_at",
        params![user_id, identity, resume_seconds, updated_at],
    )?;
    tx.commit()?;
    Ok(changed > 0)
}

pub(super) fn delete_item(
    connection: &Connection,
    user_id: i64,
    domain: &str,
    table: &str,
    identity: &str,
    deleted_at: i64,
) -> Result<(), rusqlite::Error> {
    debug_assert!(matches!(
        table,
        "user_watch_progress" | "user_continue_watching"
    ));
    let tx = connection.unchecked_transaction()?;
    record_tombstone(&tx, user_id, domain, identity, deleted_at)?;
    tx.execute(
        &format!("DELETE FROM {table} WHERE user_id = ? AND source_identity = ?"),
        params![user_id, identity],
    )?;
    tx.commit()
}
