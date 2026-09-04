use std::os::unix::fs::MetadataExt;

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DatabaseFileIdentity {
    canonical_path: PathBuf,
    device: u64,
    inode: u64,
}

impl DatabaseFileIdentity {
    pub(crate) fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub(crate) fn device(&self) -> u64 {
        self.device
    }

    pub(crate) fn inode(&self) -> u64 {
        self.inode
    }
}

pub(crate) fn database_file_identity(path: &Path) -> AppResult<DatabaseFileIdentity> {
    let raw_metadata = std::fs::symlink_metadata(path)
        .map_err(|_| ApiError::internal("Benchmark database identity unavailable."))?;
    if raw_metadata.file_type().is_symlink() || !raw_metadata.is_file() {
        return Err(ApiError::internal(
            "Benchmark database identity unavailable.",
        ));
    }
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|_| ApiError::internal("Benchmark database identity unavailable."))?;
    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|_| ApiError::internal("Benchmark database identity unavailable."))?;
    if !metadata.is_file() {
        return Err(ApiError::internal(
            "Benchmark database identity unavailable.",
        ));
    }
    Ok(DatabaseFileIdentity {
        canonical_path,
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

impl Db {
    #[cfg(test)]
    pub(crate) async fn initialize_test_paths(
        cache_path: PathBuf,
        users_path: PathBuf,
    ) -> AppResult<Self> {
        let cache_dir = cache_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        tokio::fs::create_dir_all(cache_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let cache_for_task = cache_path.clone();
        let users_for_task = users_path.clone();
        task::spawn_blocking(move || initialize_databases(&cache_for_task, &users_for_task))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let cache_file_identity = database_file_identity(&cache_path)?;
        let users_file_identity = database_file_identity(&users_path)?;

        Ok(Self {
            cache_path: Arc::new(cache_path),
            cache_pool: Arc::new(std::sync::Mutex::new(Vec::new())),
            cache_file_identity: Arc::new(cache_file_identity),
            users_path: Arc::new(users_path),
            users_pool: Arc::new(std::sync::Mutex::new(Vec::new())),
            users_file_identity: Arc::new(users_file_identity),
        })
    }

    /// Return the immutable identities captured after database initialization,
    /// but only while the configured paths still resolve to those same files.
    /// This prevents a benchmark from attesting a replacement inode while
    /// pooled SQLite connections continue using the file opened at startup.
    pub(crate) fn benchmark_database_file_identities(
        &self,
    ) -> AppResult<(DatabaseFileIdentity, DatabaseFileIdentity)> {
        let current_cache = database_file_identity(&self.cache_path)?;
        let current_users = database_file_identity(&self.users_path)?;
        if current_cache != *self.cache_file_identity || current_users != *self.users_file_identity
        {
            return Err(ApiError::internal(
                "Benchmark database identity drift detected.",
            ));
        }
        Ok((
            self.cache_file_identity.as_ref().clone(),
            self.users_file_identity.as_ref().clone(),
        ))
    }

    /// Commit a benchmark-owned cold probe without overwriting a row that won
    /// the race in another process or server instance. The returned payload is
    /// the exact JSON text written to SQLite and is used only for an opaque
    /// ownership digest.
    pub(crate) async fn insert_media_probe_cache_if_absent(
        &self,
        probe_key: String,
        payload: Value,
    ) -> AppResult<Option<String>> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let payload_json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_owned());
            let inserted = connection.execute(
                "
                INSERT INTO media_probe_cache (
                  probe_key,
                  payload_json,
                  updated_at
                )
                VALUES (?, ?, ?)
                ON CONFLICT(probe_key) DO NOTHING
                ",
                params![probe_key, payload_json, now_ms()],
            )?;
            return_connection(&pool, connection);
            Ok::<Option<String>, rusqlite::Error>((inserted == 1).then_some(payload_json))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Existence-only read for the benchmark claim path. Unlike the ordinary
    /// cache accessor, this never deletes stale or malformed rows.
    pub(crate) async fn media_probe_cache_row_exists(&self, probe_key: String) -> AppResult<bool> {
        let path = self.cache_path.clone();
        let pool = self.cache_pool.clone();
        task::spawn_blocking(move || {
            let connection = take_connection(&pool, &path)?;
            let exists = connection
                .query_row(
                    "SELECT 1 FROM media_probe_cache WHERE probe_key = ? LIMIT 1",
                    [probe_key.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            return_connection(&pool, connection);
            Ok::<bool, rusqlite::Error>(exists)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_paths(label: &str) -> (PathBuf, PathBuf) {
        let nonce = format!("{}-{}", std::process::id(), now_ms());
        let cache = std::env::temp_dir().join(format!("streamarena-{label}-{nonce}.sqlite"));
        let users = std::env::temp_dir().join(format!("streamarena-{label}-{nonce}-users.sqlite"));
        (cache, users)
    }

    async fn cleanup(cache: PathBuf, users: PathBuf) {
        let _ = tokio::fs::remove_file(cache).await;
        let _ = tokio::fs::remove_file(users).await;
    }

    #[tokio::test]
    async fn benchmark_probe_insert_is_atomic_and_never_overwrites_the_winner() {
        let (cache, users) = unique_paths("benchmark-probe-insert");
        let db = Db::initialize_test_paths(cache.clone(), users.clone())
            .await
            .expect("initialize benchmark databases");
        let key = "source:benchmark-probe".to_owned();

        assert!(!db.media_probe_cache_row_exists(key.clone()).await.unwrap());
        let inserted = db
            .insert_media_probe_cache_if_absent(key.clone(), json!({ "winner": 1 }))
            .await
            .unwrap()
            .expect("first writer owns the row");
        assert_eq!(inserted, r#"{"winner":1}"#);
        assert!(
            db.insert_media_probe_cache_if_absent(key.clone(), json!({ "winner": 2 }))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            db.get_media_probe_cache(key).await.unwrap(),
            Some(json!({ "winner": 1 }))
        );

        drop(db);
        cleanup(cache, users).await;
    }

    #[tokio::test]
    async fn benchmark_database_identity_rejects_an_atomic_path_replacement() {
        let (cache, users) = unique_paths("benchmark-db-identity");
        let db = Db::initialize_test_paths(cache.clone(), users.clone())
            .await
            .expect("initialize benchmark databases");
        db.benchmark_database_file_identities()
            .expect("startup identities are current");

        let replacement = cache.with_extension("replacement");
        std::fs::write(&replacement, b"replacement").expect("replacement file");
        std::fs::rename(&replacement, &cache).expect("atomic replacement");
        let error = db
            .benchmark_database_file_identities()
            .expect_err("replacement inode must fail closed");
        assert_eq!(
            error.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );

        drop(db);
        cleanup(cache, users).await;
    }
}
