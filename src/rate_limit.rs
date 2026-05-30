use std::collections::HashMap;
use std::sync::Mutex;

use crate::utils::now_ms;

/// Small in-memory sliding-window rate limiter.
///
/// Used to throttle authentication attempts. Keying is left to the caller:
/// login is keyed per-email (so it survives the Caddy reverse proxy, where
/// the peer IP is always localhost) and signup uses a single global key to cap
/// mass account creation.
pub struct RateLimiter {
    window_ms: i64,
    max_hits: usize,
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl RateLimiter {
    pub fn new(max_hits: usize, window_ms: i64) -> Self {
        Self {
            window_ms: window_ms.max(1),
            max_hits: max_hits.max(1),
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Records an attempt for `key` and returns `true` if it is within the
    /// allowed rate, `false` if the window is already saturated.
    pub fn check_and_record(&self, key: &str) -> bool {
        let now = now_ms();
        let cutoff = now - self.window_ms;
        let mut map = self
            .hits
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let entry = map.entry(key.to_owned()).or_default();
        entry.retain(|&timestamp| timestamp > cutoff);
        if entry.len() >= self.max_hits {
            return false;
        }
        entry.push(now);
        true
    }

    /// Drops empty/expired buckets so the table does not grow unbounded.
    pub fn prune(&self) {
        let cutoff = now_ms() - self.window_ms;
        let mut map = self
            .hits
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        map.retain(|_, timestamps| {
            timestamps.retain(|&timestamp| timestamp > cutoff);
            !timestamps.is_empty()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::RateLimiter;

    #[test]
    fn blocks_after_max_hits_within_window() {
        let limiter = RateLimiter::new(3, 60_000);
        assert!(limiter.check_and_record("user"));
        assert!(limiter.check_and_record("user"));
        assert!(limiter.check_and_record("user"));
        assert!(!limiter.check_and_record("user"));
    }

    #[test]
    fn separate_keys_have_separate_budgets() {
        let limiter = RateLimiter::new(1, 60_000);
        assert!(limiter.check_and_record("a"));
        assert!(!limiter.check_and_record("a"));
        assert!(limiter.check_and_record("b"));
    }
}
