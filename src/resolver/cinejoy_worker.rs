//! A small private process pool avoids repeated Chromium startup and public
//! immutable asset downloads. A lease owns its pipes while working: cancellation
//! closes stdin immediately and retains capacity until the browser has exited.
use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;

use super::ExternalEmbedHlsResolverOutput;

const MAX_WORKERS: usize = 2;
const MAX_REPLY_BYTES: u64 = 65536;
const IDLE_TTL: Duration = Duration::from_secs(890);

static POOL: LazyLock<Pool> = LazyLock::new(Pool::new);

struct Pool {
    permits: Arc<Semaphore>,
    admissions: Semaphore,
    idle: Mutex<VecDeque<Worker>>,
}

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    output: Option<BufReader<ChildStdout>>,
    script: String,
    idle_at: Instant,
    request_id: u64,
}

// The worker is removed from the idle pool before the first await, so an aborted
// read can never leave a stale response for the next caller.
struct Lease {
    worker: Option<Worker>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(worker) = self.worker.take() else {
            return;
        };
        let permit = self.permit.take();
        let Worker {
            mut child,
            input,
            output,
            ..
        } = worker;
        drop(input);
        drop(output);
        // EOF asks the Node owner to close Chromium, including an active page.
        // Keep this slot occupied during cleanup to avoid cancellation storms
        // creating an unbounded number of dying browsers.
        tokio::spawn(async move {
            let _permit = permit;
            if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        });
    }
}

impl Pool {
    fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_WORKERS)),
            admissions: Semaphore::new(MAX_WORKERS * 2),
            idle: Mutex::new(VecDeque::new()),
        }
    }

    async fn resolve(
        &self,
        script: &str,
        watch_url: &str,
        server: &str,
        timeout_ms: u64,
    ) -> Option<ExternalEmbedHlsResolverOutput> {
        // At most two active jobs and two queued jobs, even if callers later
        // bypass the resolver service's own global/provider concurrency budgets.
        let _admission = self.admissions.try_acquire().ok()?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        timeout(Duration::from_millis(timeout_ms), async {
            let permit = self.permits.clone().acquire_owned().await.ok()?;
            let mut lease = Lease {
                worker: None,
                permit: Some(permit),
            };
            loop {
                let Some(worker) = self.idle.lock().await.pop_front() else {
                    break;
                };
                lease.worker = Some(worker);
                let worker = lease.worker.as_mut()?;
                if worker.script == script
                    && worker.idle_at.elapsed() < IDLE_TTL
                    && matches!(worker.child.try_wait(), Ok(None))
                {
                    break;
                }
                // Gracefully retire stale/changed workers too; do not leave
                // Chromium descendants behind by killing only their Node owner.
                worker.input.take();
                worker.output.take();
                if timeout(Duration::from_secs(2), worker.child.wait())
                    .await
                    .is_err()
                {
                    let _ = worker.child.kill().await;
                }
                lease.worker = None;
            }
            if lease.worker.is_none() {
                lease.worker = Some(Worker::spawn(script)?);
            }
            let remaining_ms = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64;
            if remaining_ms == 0 {
                return None;
            }
            let worker = lease.worker.as_mut()?;
            worker.request_id += 1;
            let request = json!({ "id": worker.request_id, "watchUrl": watch_url,
                "server": server, "timeoutMs": remaining_ms.min(120000) });
            let mut line = serde_json::to_vec(&request).ok()?;
            line.push(b'\n');
            worker.input.as_mut()?.write_all(&line).await.ok()?;
            worker.input.as_mut()?.flush().await.ok()?;
            let mut response = Vec::new();
            // Limit before allocation; a corrupted child cannot fill backend RAM.
            worker
                .output
                .as_mut()?
                .take(MAX_REPLY_BYTES)
                .read_until(b'\n', &mut response)
                .await
                .ok()?;
            if response.last() != Some(&b'\n') {
                return None;
            }
            let reply: Reply = serde_json::from_slice(&response).ok()?;
            if reply.id != worker.request_id || !reply.ok {
                return None;
            }
            let result = reply.result?;
            if !reply.retire {
                let mut idle = self.idle.lock().await;
                let mut worker = lease.worker.take()?;
                worker.idle_at = Instant::now();
                idle.push_back(worker);
            }
            Some(result)
        })
        .await
        .ok()?
    }
}

impl Worker {
    fn spawn(script: &str) -> Option<Self> {
        let mut child = Command::new("node")
            .arg(script)
            .arg("--cinejoy-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        Some(Self {
            input: child.stdin.take(),
            output: Some(BufReader::new(child.stdout.take()?)),
            child,
            script: script.to_owned(),
            idle_at: Instant::now(),
            request_id: 0,
        })
    }
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
    ok: bool,
    result: Option<ExternalEmbedHlsResolverOutput>,
    #[serde(default)]
    retire: bool,
}

pub(super) fn enabled(script: &str) -> bool {
    !std::env::var("CINEJOY_WARM_RESOLVER").is_ok_and(|value| value.trim() == "0")
        // Preserve custom legacy resolver scripts and incomplete old bundles.
        && Path::new(script).file_name().is_some_and(|name| name == "resolve-external-embed-hls.mjs")
        && Path::new(script).parent().is_some_and(|parent| parent.join("lib/cinejoy-worker.mjs").is_file())
}

pub(super) async fn resolve(
    script: &str,
    watch_url: &str,
    server: &str,
    timeout_ms: u64,
) -> Option<ExternalEmbedHlsResolverOutput> {
    POOL.resolve(script, watch_url, server, timeout_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        dir: std::path::PathBuf,
        script: String,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "streamarena-cinejoy-worker-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("worker.mjs");
            std::fs::write(&script, r#"
                import { createInterface } from 'node:readline';
                const lines = createInterface({input:process.stdin});
                lines.on('close',()=>process.exit(0));
                lines.on('line',line=>{
                  const request=JSON.parse(line);
                  if(request.watchUrl==='crash')process.exit(1);
                  if(request.watchUrl==='stall')return;
                  if(request.watchUrl==='huge'){process.stdout.write('x'.repeat(70000));return;}
                  const id=request.watchUrl==='bad-id'?request.id+1:request.id;
                  console.log(JSON.stringify({id,ok:true,retire:request.watchUrl==='retire',
                    result:{playbackUrl:`https://fixture.test/${process.pid}/${request.server}`,referer:'https://cinejoy.pk/'}}));
                });
                setInterval(()=>{},1000).unref();
            "#).unwrap();
            Self {
                script: script.to_string_lossy().into_owned(),
                dir,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[tokio::test]
    async fn warm_workers_reuse_process_without_crossing_reply_identity() {
        let fixture = Fixture::new();
        let pool = Pool::new();
        let first = pool
            .resolve(&fixture.script, "first", "NEBULA", 2000)
            .await
            .unwrap();
        let next = pool
            .resolve(&fixture.script, "next", "NEBULA", 2000)
            .await
            .unwrap();
        assert_eq!(first.playback_url, next.playback_url);
        assert!(
            pool.resolve(&fixture.script, "bad-id", "NEBULA", 2000)
                .await
                .is_none()
        );
        let recovered = pool
            .resolve(&fixture.script, "recover", "NEBULA", 2000)
            .await
            .unwrap();
        assert_ne!(first.playback_url, recovered.playback_url);
    }

    #[tokio::test]
    async fn crashes_oversized_replies_and_retirement_cannot_poison_next_request() {
        let fixture = Fixture::new();
        let pool = Pool::new();
        for failure in ["crash", "huge"] {
            assert!(
                pool.resolve(&fixture.script, failure, "NEBULA", 2000)
                    .await
                    .is_none()
            );
            assert!(
                pool.resolve(&fixture.script, "recover", "NEBULA", 2000)
                    .await
                    .is_some()
            );
        }
        let retired = pool
            .resolve(&fixture.script, "retire", "NEBULA", 2000)
            .await
            .unwrap();
        let fresh = pool
            .resolve(&fixture.script, "next", "NEBULA", 2000)
            .await
            .unwrap();
        assert_ne!(retired.playback_url, fresh.playback_url);
    }

    #[tokio::test]
    async fn capacity_is_bounded_and_cancellation_releases_it_after_cleanup() {
        let fixture = Fixture::new();
        let pool = Arc::new(Pool::new());
        let mut pending = Vec::new();
        for _ in 0..MAX_WORKERS {
            let pool = pool.clone();
            let script = fixture.script.clone();
            pending.push(tokio::spawn(async move {
                pool.resolve(&script, "stall", "NEBULA", 10000).await
            }));
        }
        timeout(Duration::from_secs(2), async {
            while pool.permits.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            pool.resolve(&fixture.script, "queued", "NEBULA", 30)
                .await
                .is_none()
        );
        for task in pending {
            task.abort();
            let _ = task.await;
        }
        timeout(Duration::from_secs(3), async {
            while pool.permits.available_permits() != MAX_WORKERS {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            pool.resolve(&fixture.script, "after-cancel", "NEBULA", 2000)
                .await
                .is_some()
        );
        assert_eq!(pool.idle.lock().await.len(), 1);
    }
}
