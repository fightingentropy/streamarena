use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{Value, json};
use tokio::sync::RwLock;

use crate::utils::now_ms;

const RESOLVE_JOB_TTL_MS: i64 = 15 * 60 * 1000;
const RESOLVE_JOB_MAX_ENTRIES: usize = 256;

#[derive(Clone, Default)]
pub struct ResolveJobStore {
    jobs: Arc<DashMap<String, Arc<ResolveJobEntry>>>,
}

struct ResolveJobEntry {
    user_id: i64,
    created_at_ms: i64,
    state: RwLock<ResolveJobState>,
}

enum ResolveJobState {
    Pending,
    Done(Value),
    Failed { message: String },
}

impl ResolveJobStore {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(DashMap::new()),
        }
    }

    pub fn create(&self, user_id: i64) -> String {
        self.prune();
        let job_id = new_job_id();
        self.jobs.insert(
            job_id.clone(),
            Arc::new(ResolveJobEntry {
                user_id,
                created_at_ms: now_ms(),
                state: RwLock::new(ResolveJobState::Pending),
            }),
        );
        job_id
    }

    pub async fn complete(&self, job_id: &str, payload: Value) {
        if let Some(entry) = self.jobs.get(job_id) {
            *entry.state.write().await = ResolveJobState::Done(payload);
        }
    }

    pub async fn fail(&self, job_id: &str, message: impl Into<String>) {
        if let Some(entry) = self.jobs.get(job_id) {
            *entry.state.write().await = ResolveJobState::Failed {
                message: message.into(),
            };
        }
    }

    pub async fn snapshot(&self, job_id: &str, user_id: i64) -> Option<Value> {
        let entry = self.jobs.get(job_id)?.clone();
        if entry.user_id != user_id {
            return None;
        }
        if now_ms().saturating_sub(entry.created_at_ms) > RESOLVE_JOB_TTL_MS {
            self.jobs.remove(job_id);
            return None;
        }
        let payload = match &*entry.state.read().await {
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
        };
        Some(payload)
    }

    pub fn prune(&self) {
        let now = now_ms();
        self.jobs
            .retain(|_, entry| now.saturating_sub(entry.created_at_ms) <= RESOLVE_JOB_TTL_MS);
        while self.jobs.len() > RESOLVE_JOB_MAX_ENTRIES {
            let oldest = self
                .jobs
                .iter()
                .min_by_key(|item| item.created_at_ms)
                .map(|item| item.key().clone());
            let Some(job_id) = oldest else {
                break;
            };
            self.jobs.remove(&job_id);
        }
    }
}

fn new_job_id() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS CSPRNG unavailable — cannot create resolve job ids");
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}
