use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::utils::now_ms;

const RESOLVE_JOB_TTL_MS: i64 = 15 * 60 * 1000;
const RESOLVE_JOB_MAX_ENTRIES: usize = 256;

#[derive(Clone, Default)]
pub struct ResolveJobStore {
    jobs: Arc<DashMap<String, Arc<ResolveJobEntry>>>,
    creation_lock: Arc<std::sync::Mutex<()>>,
}

struct ResolveJobEntry {
    user_id: i64,
    created_at_ms: i64,
    state: watch::Sender<ResolveJobState>,
    cancellation: CancellationToken,
}

#[derive(Clone)]
enum ResolveJobState {
    Pending,
    Done(Value),
    Failed { message: String },
    Cancelled,
}

impl ResolveJobStore {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(DashMap::new()),
            creation_lock: Arc::new(std::sync::Mutex::new(())),
        }
    }

    pub fn create(&self, user_id: i64) -> String {
        let _creation_guard = self
            .creation_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.prune();
        while self.jobs.len() >= RESOLVE_JOB_MAX_ENTRIES {
            if !self.evict_oldest() {
                break;
            }
        }
        let job_id = new_job_id();
        let (state, _receiver) = watch::channel(ResolveJobState::Pending);
        self.jobs.insert(
            job_id.clone(),
            Arc::new(ResolveJobEntry {
                user_id,
                created_at_ms: now_ms(),
                state,
                cancellation: CancellationToken::new(),
            }),
        );
        job_id
    }

    /// Own a resolve future on behalf of a job. Cancelling the job drops the
    /// future immediately, which in turn releases any resolver/provider
    /// permits held by the superseded request.
    pub fn spawn<F>(&self, job_id: &str, future: F) -> bool
    where
        F: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let Some(entry) = self.jobs.get(job_id).map(|entry| entry.clone()) else {
            return false;
        };
        let cancellation = entry.cancellation.clone();
        let store = self.clone();
        let job_id = job_id.to_owned();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {}
                result = future => match result {
                    Ok(payload) => store.complete(&job_id, payload).await,
                    Err(message) => store.fail(&job_id, message).await,
                },
            }
        });
        true
    }

    /// Cancel a job only when it belongs to the authenticated user. Completed
    /// jobs remain readable and cancellation is idempotent.
    pub fn cancel(&self, job_id: &str, user_id: i64) -> bool {
        let Some(entry) = self.jobs.get(job_id).map(|entry| entry.clone()) else {
            return false;
        };
        if entry.user_id != user_id {
            return false;
        }
        entry.state.send_if_modified(|state| {
            if matches!(state, ResolveJobState::Pending) {
                *state = ResolveJobState::Cancelled;
                true
            } else {
                false
            }
        });
        entry.cancellation.cancel();
        true
    }

    pub async fn complete(&self, job_id: &str, payload: Value) {
        if let Some(entry) = self.jobs.get(job_id) {
            entry.state.send_if_modified(|state| {
                if matches!(state, ResolveJobState::Pending) {
                    *state = ResolveJobState::Done(payload);
                    true
                } else {
                    false
                }
            });
        }
    }

    pub async fn fail(&self, job_id: &str, message: impl Into<String>) {
        if let Some(entry) = self.jobs.get(job_id) {
            let message = message.into();
            entry.state.send_if_modified(|state| {
                if matches!(state, ResolveJobState::Pending) {
                    *state = ResolveJobState::Failed { message };
                    true
                } else {
                    false
                }
            });
        }
    }

    pub async fn snapshot(&self, job_id: &str, user_id: i64) -> Option<Value> {
        self.snapshot_wait(job_id, user_id, Duration::ZERO).await
    }

    /// Return the current state, waiting up to `wait` for a pending job to
    /// change. A watch channel closes the race between reading `Pending` and
    /// subscribing, so a completion can never be missed between those steps.
    pub async fn snapshot_wait(&self, job_id: &str, user_id: i64, wait: Duration) -> Option<Value> {
        let entry = self.jobs.get(job_id)?.clone();
        if entry.user_id != user_id {
            return None;
        }
        if now_ms().saturating_sub(entry.created_at_ms) > RESOLVE_JOB_TTL_MS {
            if let Some((_job_id, expired)) = self.jobs.remove(job_id) {
                expired.cancellation.cancel();
            }
            return None;
        }
        let mut state = entry.state.subscribe();
        let is_pending = matches!(*state.borrow(), ResolveJobState::Pending);
        if is_pending && !wait.is_zero() {
            let _ = timeout(wait, state.changed()).await;
        }
        let payload = match &*state.borrow() {
            ResolveJobState::Pending => json!({
                "jobId": job_id,
                "status": "pending",
            }),
            ResolveJobState::Done(result) => json!({
                "jobId": job_id,
                "status": "done",
                "result": result,
            }),
            ResolveJobState::Failed { message } => json!({
                "jobId": job_id,
                "status": "error",
                "error": message,
            }),
            ResolveJobState::Cancelled => json!({
                "jobId": job_id,
                "status": "cancelled",
            }),
        };
        Some(payload)
    }

    pub fn prune(&self) {
        let now = now_ms();
        self.jobs.retain(|_, entry| {
            let keep = now.saturating_sub(entry.created_at_ms) <= RESOLVE_JOB_TTL_MS;
            if !keep {
                entry.cancellation.cancel();
            }
            keep
        });
        while self.jobs.len() > RESOLVE_JOB_MAX_ENTRIES {
            if !self.evict_oldest() {
                break;
            }
        }
    }

    fn evict_oldest(&self) -> bool {
        let oldest = self
            .jobs
            .iter()
            .min_by_key(|item| item.created_at_ms)
            .map(|item| item.key().clone());
        let Some(job_id) = oldest else {
            return false;
        };
        if let Some((_job_id, removed)) = self.jobs.remove(&job_id) {
            removed.cancellation.cancel();
            return true;
        }
        false
    }
}

fn new_job_id() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS CSPRNG unavailable — cannot create resolve job ids");
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::{Semaphore, oneshot};

    use super::{RESOLVE_JOB_MAX_ENTRIES, ResolveJobStore};

    struct DropSignal(Option<oneshot::Sender<()>>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    #[tokio::test]
    async fn long_poll_wakes_when_job_completes() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);
        let waiting_store = store.clone();
        let waiting_job_id = job_id.clone();
        let waiter = tokio::spawn(async move {
            waiting_store
                .snapshot_wait(&waiting_job_id, 42, Duration::from_secs(1))
                .await
        });

        tokio::task::yield_now().await;
        store
            .complete(&job_id, json!({ "playableUrl": "/ready" }))
            .await;

        let snapshot = tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("long poll should wake promptly")
            .expect("wait task should finish")
            .expect("job should still exist");
        assert_eq!(snapshot["status"], "done");
        assert_eq!(snapshot["result"]["playableUrl"], "/ready");
    }

    #[tokio::test]
    async fn long_poll_observes_completion_that_precedes_subscription() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);
        store.complete(&job_id, json!({ "ready": true })).await;

        let snapshot = store
            .snapshot_wait(&job_id, 42, Duration::from_secs(1))
            .await
            .expect("job should exist");
        assert_eq!(snapshot["status"], "done");
        assert_eq!(snapshot["result"]["ready"], true);
    }

    #[tokio::test]
    async fn long_poll_times_out_with_pending_snapshot() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);

        let snapshot = store
            .snapshot_wait(&job_id, 42, Duration::from_millis(1))
            .await
            .expect("job should exist");
        assert_eq!(snapshot["status"], "pending");
    }

    #[tokio::test]
    async fn snapshots_remain_scoped_to_the_creating_user() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);

        assert!(store.snapshot(&job_id, 7).await.is_none());
        assert!(store.snapshot(&job_id, 42).await.is_some());
    }

    #[tokio::test]
    async fn long_poll_wakes_when_job_fails() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);
        let waiting_store = store.clone();
        let waiting_job_id = job_id.clone();
        let waiter = tokio::spawn(async move {
            waiting_store
                .snapshot_wait(&waiting_job_id, 42, Duration::from_secs(1))
                .await
        });

        tokio::task::yield_now().await;
        store.fail(&job_id, "torrent unavailable").await;

        let snapshot = tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("long poll should wake promptly")
            .expect("wait task should finish")
            .expect("job should still exist");
        assert_eq!(snapshot["status"], "error");
        assert_eq!(snapshot["error"], "torrent unavailable");
    }

    #[tokio::test]
    async fn cancellation_is_owner_scoped_and_wakes_waiters() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);
        let waiting_store = store.clone();
        let waiting_job_id = job_id.clone();
        let waiter = tokio::spawn(async move {
            waiting_store
                .snapshot_wait(&waiting_job_id, 42, Duration::from_secs(1))
                .await
        });

        assert!(!store.cancel(&job_id, 7));
        assert!(store.cancel(&job_id, 42));

        let snapshot = tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("cancel should wake a long poll promptly")
            .expect("wait task should finish")
            .expect("cancelled job should remain readable");
        assert_eq!(snapshot["status"], "cancelled");
    }

    #[tokio::test]
    async fn cancelling_b_drops_its_future_so_c_can_take_the_permit() {
        let store = ResolveJobStore::new();
        let provider_permit = Arc::new(Semaphore::new(1));
        let (b_acquired_tx, b_acquired_rx) = oneshot::channel();
        let b_job_id = store.create(42);
        let b_permit = provider_permit.clone();
        assert!(store.spawn(&b_job_id, async move {
            let _permit = b_permit
                .acquire_owned()
                .await
                .expect("test semaphore remains open");
            let _ = b_acquired_tx.send(());
            std::future::pending::<()>().await;
            Ok(json!({ "source": "b" }))
        }));
        b_acquired_rx.await.expect("B should acquire the permit");

        assert!(store.cancel(&b_job_id, 42));

        let c_job_id = store.create(42);
        let c_permit = provider_permit.clone();
        assert!(store.spawn(&c_job_id, async move {
            let _permit = c_permit
                .acquire_owned()
                .await
                .expect("test semaphore remains open");
            Ok(json!({ "source": "c" }))
        }));
        let snapshot = store
            .snapshot_wait(&c_job_id, 42, Duration::from_secs(1))
            .await
            .expect("C job should exist");
        assert_eq!(snapshot["status"], "done");
        assert_eq!(snapshot["result"]["source"], "c");
    }

    #[tokio::test]
    async fn cancellation_cannot_be_overwritten_by_late_completion() {
        let store = ResolveJobStore::new();
        let job_id = store.create(42);
        assert!(store.cancel(&job_id, 42));
        store.complete(&job_id, json!({ "late": true })).await;

        let snapshot = store
            .snapshot(&job_id, 42)
            .await
            .expect("job should still exist");
        assert_eq!(snapshot["status"], "cancelled");
        assert!(snapshot.get("result").is_none());
    }

    #[tokio::test]
    async fn capacity_eviction_cancels_owned_work_and_never_exceeds_the_cap() {
        let store = ResolveJobStore::new();
        let first_job_id = store.create(42);
        let (started_tx, started_rx) = oneshot::channel();
        let (dropped_tx, dropped_rx) = oneshot::channel();
        assert!(store.spawn(&first_job_id, async move {
            let _drop_signal = DropSignal(Some(dropped_tx));
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
            Ok(json!({ "unexpected": true }))
        }));
        started_rx.await.expect("oldest job should start");
        tokio::time::sleep(Duration::from_millis(2)).await;

        for _ in 1..RESOLVE_JOB_MAX_ENTRIES {
            store.create(42);
        }
        assert_eq!(store.jobs.len(), RESOLVE_JOB_MAX_ENTRIES);

        let newest_job_id = store.create(42);
        assert_eq!(store.jobs.len(), RESOLVE_JOB_MAX_ENTRIES);
        assert!(store.snapshot(&first_job_id, 42).await.is_none());
        assert!(store.snapshot(&newest_job_id, 42).await.is_some());
        tokio::time::timeout(Duration::from_millis(100), dropped_rx)
            .await
            .expect("eviction should promptly cancel owned work")
            .expect("drop signal should be delivered");
    }
}
