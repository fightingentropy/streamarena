use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::Mutex;

/// Return the per-key mutex used to single-flight work for `key`.
///
/// Callers hold the returned `Arc` for the duration of the critical section so
/// idle-lock pruning (which drops entries whose strong count is 1) cannot
/// remove a lock that is still in use.
pub fn key_lock(map: &DashMap<String, Arc<Mutex<()>>>, key: &str) -> Arc<Mutex<()>> {
    map.entry(key.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::key_lock;
    use dashmap::DashMap;
    use std::sync::Arc;

    #[test]
    fn reuses_the_same_lock_for_the_same_key() {
        let locks = DashMap::new();
        let first = key_lock(&locks, "movie.mp4|a:2");
        let second = key_lock(&locks, "movie.mp4|a:2");
        let other = key_lock(&locks, "movie.mp4|a:3");

        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));
    }
}
