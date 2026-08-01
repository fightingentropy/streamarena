use std::collections::HashMap;
use std::sync::Mutex;

use crate::utils::now_ms;

/// Small in-memory sliding-window rate limiter.
///
/// Used to throttle authentication attempts. Keying is left to the caller:
/// login is keyed per-email and signup per-client-IP (from `X-Forwarded-For`,
/// since behind the Caddy reverse proxy the peer IP is always localhost). A
/// separate, generous global limiter backstops signup against mass account
/// creation without throttling an organic surge.
pub struct RateLimiter {
    window_ms: i64,
    max_hits: usize,
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

#[derive(Debug, Clone, Copy)]
struct FailureEntry {
    failures: u32,
    retry_at_ms: i64,
    last_failure_ms: i64,
}

/// Exponential, per-identity authentication cooldown.
///
/// The sliding-window limiter remains the hard request budget. This smaller
/// state machine adds an early 250ms, 500ms, 1s ... cooldown after failures,
/// capped at 30 seconds. It never sleeps on an async worker: callers fail fast
/// with 429 while the cooldown is active, and a successful authentication
/// clears the identity immediately.
pub struct FailureBackoff {
    base_delay_ms: i64,
    max_delay_ms: i64,
    retention_ms: i64,
    failures: Mutex<HashMap<String, FailureEntry>>,
}

impl FailureBackoff {
    pub fn new(base_delay_ms: i64, max_delay_ms: i64, retention_ms: i64) -> Self {
        Self {
            base_delay_ms: base_delay_ms.max(1),
            max_delay_ms: max_delay_ms.max(base_delay_ms.max(1)),
            retention_ms: retention_ms.max(1),
            failures: Mutex::new(HashMap::new()),
        }
    }

    pub fn retry_after_ms(&self, key: &str) -> i64 {
        self.retry_after_ms_at(key, now_ms())
    }

    pub fn record_failure(&self, key: &str) -> i64 {
        self.record_failure_at(key, now_ms())
    }

    pub fn record_success(&self, key: &str) {
        self.failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(key);
    }

    pub fn prune(&self) {
        let cutoff = now_ms() - self.retention_ms;
        self.failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .retain(|_, entry| entry.last_failure_ms > cutoff);
    }

    fn retry_after_ms_at(&self, key: &str, now: i64) -> i64 {
        self.failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(key)
            .map(|entry| entry.retry_at_ms.saturating_sub(now).max(0))
            .unwrap_or(0)
    }

    fn record_failure_at(&self, key: &str, now: i64) -> i64 {
        let mut entries = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let previous = entries.get(key).copied();
        let failures = previous
            .filter(|entry| now - entry.last_failure_ms <= self.retention_ms)
            .map(|entry| entry.failures.saturating_add(1))
            .unwrap_or(1)
            .min(31);
        let multiplier = 1i64
            .checked_shl(failures.saturating_sub(1))
            .unwrap_or(i64::MAX);
        let delay = self
            .base_delay_ms
            .saturating_mul(multiplier)
            .min(self.max_delay_ms);
        entries.insert(
            key.to_owned(),
            FailureEntry {
                failures,
                retry_at_ms: now.saturating_add(delay),
                last_failure_ms: now,
            },
        );
        delay
    }
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
    use super::{FailureBackoff, RateLimiter};

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

    #[test]
    fn failure_backoff_grows_caps_and_resets_on_success() {
        let backoff = FailureBackoff::new(250, 1_000, 60_000);
        assert_eq!(backoff.record_failure_at("viewer", 10_000), 250);
        assert_eq!(backoff.retry_after_ms_at("viewer", 10_100), 150);
        assert_eq!(backoff.record_failure_at("viewer", 10_250), 500);
        assert_eq!(backoff.record_failure_at("viewer", 10_750), 1_000);
        assert_eq!(backoff.record_failure_at("viewer", 11_750), 1_000);
        assert_eq!(backoff.retry_after_ms_at("other", 11_750), 0);
        backoff.record_success("viewer");
        assert_eq!(backoff.retry_after_ms_at("viewer", 11_750), 0);
    }

    #[test]
    fn failure_backoff_restarts_after_retention_window() {
        let backoff = FailureBackoff::new(100, 5_000, 1_000);
        assert_eq!(backoff.record_failure_at("viewer", 1_000), 100);
        assert_eq!(backoff.record_failure_at("viewer", 3_000), 100);
    }
}
