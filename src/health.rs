//! Service-health instrumentation for the admin dashboard.
//!
//! Three pieces live here:
//!   * [`HttpMetrics`] — cheap, lock-free request/error counters bumped by the
//!     HTTP middleware (cumulative since process start).
//!   * [`HostProbe`] / [`HostMetrics`] — host resource gauges. File-descriptor
//!     count/limit and disk free/total come straight from libc (the fd count is
//!     the signal behind the open-file-exhaustion incidents); memory and load
//!     average come from `sysinfo`.
//!   * [`compute_status`] — rolls a set of [`HealthInputs`] into one
//!     green/amber/red [`Status`] plus a per-[`Check`] breakdown. This is the
//!     "is everything good?" verdict the dashboard renders and (later) alerts on.
//!
//! Thresholds are deliberately simple constants so they're easy to tune.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use sysinfo::System;

// ── HTTP counters ───────────────────────────────────────────────────────────

/// Lock-free request counters, cumulative since process start. Bumped once per
/// response by the HTTP middleware; reset to zero only by a restart (callers
/// computing rates must guard against the counter going backwards).
#[derive(Default)]
pub struct HttpMetrics {
    req_total: AtomicU64,
    req_4xx: AtomicU64,
    req_5xx: AtomicU64,
    live_proxy_5xx: AtomicU64,
}

impl HttpMetrics {
    /// Record one finished response. `is_live_proxy` is true for `/api/live/*`
    /// (the HLS proxy) so upstream 502s — the `fragLoadError` source — get their
    /// own tally separate from the global 5xx count.
    pub fn record(&self, status: u16, is_live_proxy: bool) {
        self.req_total.fetch_add(1, Ordering::Relaxed);
        if (400..500).contains(&status) {
            self.req_4xx.fetch_add(1, Ordering::Relaxed);
        } else if status >= 500 {
            self.req_5xx.fetch_add(1, Ordering::Relaxed);
            if is_live_proxy {
                self.live_proxy_5xx.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn snapshot(&self) -> HttpCounters {
        HttpCounters {
            reqTotal: self.req_total.load(Ordering::Relaxed),
            req4xx: self.req_4xx.load(Ordering::Relaxed),
            req5xx: self.req_5xx.load(Ordering::Relaxed),
            liveProxy5xx: self.live_proxy_5xx.load(Ordering::Relaxed),
        }
    }
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct HttpCounters {
    pub reqTotal: u64,
    pub req4xx: u64,
    pub req5xx: u64,
    pub liveProxy5xx: u64,
}

// ── Host resource gauges ──────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct HostMetrics {
    /// Open file descriptors held by this process, and the soft RLIMIT_NOFILE.
    pub fdCount: i64,
    pub fdLimit: i64,
    /// System memory, in bytes.
    pub memUsed: i64,
    pub memTotal: i64,
    /// 1-minute load average and the logical-core count, so the UI can show
    /// load-per-core without us choosing a CPU-sampling window.
    pub load1: f64,
    pub numCpus: i64,
    /// Free / total bytes on the filesystem holding the cache + DB.
    pub diskFree: i64,
    pub diskTotal: i64,
}

/// Owns the `sysinfo::System` handle so memory/load reads reuse one allocation.
/// Wrapped in a `Mutex` because both the 60s sampler and on-demand admin
/// requests call [`HostProbe::snapshot`]; contention is negligible at that rate.
pub struct HostProbe {
    system: Mutex<System>,
}

impl Default for HostProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl HostProbe {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }

    /// Sample current host gauges. `disk_path` selects the filesystem to report
    /// (pass the cache/DB path so the figure reflects where data actually grows).
    pub fn snapshot(&self, disk_path: &Path) -> HostMetrics {
        let (mem_used, mem_total) = {
            let mut system = self.system.lock().unwrap_or_else(|e| e.into_inner());
            system.refresh_memory();
            // sysinfo reports memory in bytes (>= 0.30).
            (system.used_memory() as i64, system.total_memory() as i64)
        };
        let load1 = System::load_average().one;
        let num_cpus = std::thread::available_parallelism()
            .map(|n| n.get() as i64)
            .unwrap_or(0);
        let (disk_free, disk_total) = disk_free_total(disk_path);
        HostMetrics {
            fdCount: open_fd_count(),
            fdLimit: open_fd_limit(),
            memUsed: mem_used,
            memTotal: mem_total,
            load1,
            numCpus: num_cpus,
            diskFree: disk_free,
            diskTotal: disk_total,
        }
    }
}

/// Count this process's open file descriptors by listing `/dev/fd` (on macOS and
/// the BSDs that directory reflects the *calling* process). Returns -1 if it
/// can't be read so the UI can show "unknown" rather than a bogus 0.
#[cfg(unix)]
fn open_fd_count() -> i64 {
    match std::fs::read_dir("/dev/fd") {
        // Subtract 1: the read_dir handle itself is an open fd while we count.
        Ok(entries) => (entries.count() as i64 - 1).max(0),
        Err(_) => -1,
    }
}

#[cfg(not(unix))]
fn open_fd_count() -> i64 {
    -1
}

/// The soft `RLIMIT_NOFILE` — the ceiling `main::raise_open_file_limit` lifts at
/// startup. Returns -1 on failure.
#[cfg(unix)]
fn open_fd_limit() -> i64 {
    // SAFETY: getrlimit takes a valid resource id and a pointer to a
    // locally-owned, zero-initialized rlimit; no aliasing concerns.
    unsafe {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
            return -1;
        }
        if limit.rlim_cur == libc::RLIM_INFINITY {
            return i64::MAX;
        }
        limit.rlim_cur as i64
    }
}

#[cfg(not(unix))]
fn open_fd_limit() -> i64 {
    -1
}

/// Free / total bytes on the filesystem containing `path`, via `statvfs`.
/// Returns (0, 0) on failure so callers treat the disk check as "no data".
#[cfg(unix)]
fn disk_free_total(path: &Path) -> (i64, i64) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return (0, 0);
    };
    // SAFETY: c_path is a valid NUL-terminated string for the duration of the
    // call; stat is locally owned and fully written by a successful statvfs.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
            return (0, 0);
        }
        // f_frsize is the fragment size that block counts are expressed in.
        let frsize = stat.f_frsize as i64;
        let free = (stat.f_bavail as i64).saturating_mul(frsize);
        let total = (stat.f_blocks as i64).saturating_mul(frsize);
        (free, total)
    }
}

#[cfg(not(unix))]
fn disk_free_total(_path: &Path) -> (i64, i64) {
    (0, 0)
}

// ── Status rollup ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Green,
    Amber,
    Red,
}

impl Status {
    fn rank(self) -> u8 {
        match self {
            Status::Green => 0,
            Status::Amber => 1,
            Status::Red => 2,
        }
    }

    /// The more-severe of two statuses — used to roll individual checks into one.
    fn worst(self, other: Status) -> Status {
        if other.rank() > self.rank() {
            other
        } else {
            self
        }
    }

    pub fn as_i64(self) -> i64 {
        self.rank() as i64
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub key: String,
    pub label: String,
    pub status: Status,
    pub detail: String,
}

fn check(key: &str, label: &str, status: Status, detail: String) -> Check {
    Check {
        key: key.to_owned(),
        label: label.to_owned(),
        status,
        detail,
    }
}

/// Everything [`compute_status`] needs, pre-aggregated by the caller. Window
/// figures (http / playback) are deltas over a recent span so they reflect
/// "lately", not the whole uptime.
#[derive(Debug, Clone, Default)]
pub struct HealthInputs {
    pub restarts_last_1h: i64,
    pub minutes_since_last_restart: Option<i64>,
    pub fd_count: i64,
    pub fd_limit: i64,
    pub mem_used: i64,
    pub mem_total: i64,
    pub disk_free: i64,
    pub disk_total: i64,
    pub load1: f64,
    pub num_cpus: i64,
    pub http_window_total: i64,
    pub http_window_5xx: i64,
    pub live_proxy_window_5xx: i64,
    pub worst_provider_consecutive_failures: i64,
    pub playback_window_total: i64,
    pub playback_window_failures: i64,
}

// Thresholds. AMBER = worth a glance, RED = acted-on-the-incident territory.
const FD_AMBER: f64 = 0.70;
const FD_RED: f64 = 0.90;
const DISK_FREE_AMBER: f64 = 0.15;
const DISK_FREE_RED: f64 = 0.05;
const MEM_AMBER: f64 = 0.85;
const MEM_RED: f64 = 0.95;
const LOAD_PER_CORE_AMBER: f64 = 1.0;
const LOAD_PER_CORE_RED: f64 = 2.0;
const HTTP_5XX_AMBER_PCT: f64 = 2.0;
const HTTP_5XX_RED_PCT: f64 = 10.0;
const HTTP_MIN_SAMPLE: i64 = 20; // below this, too little traffic to judge
const LIVE_5XX_AMBER: i64 = 5;
const LIVE_5XX_RED: i64 = 25;
const PROVIDER_CONSEC_AMBER: i64 = 3;
const PROVIDER_CONSEC_RED: i64 = 10;
const PLAYBACK_FAIL_AMBER_PCT: f64 = 10.0;
const PLAYBACK_FAIL_RED_PCT: f64 = 30.0;
const PLAYBACK_MIN_SAMPLE: i64 = 5;

fn pct(part: i64, whole: i64) -> f64 {
    if whole <= 0 {
        0.0
    } else {
        part as f64 / whole as f64 * 100.0
    }
}

/// Roll the inputs into one overall [`Status`] (worst of all checks) plus the
/// per-check breakdown the dashboard lists. Pure and deterministic — unit-tested.
pub fn compute_status(input: &HealthInputs) -> (Status, Vec<Check>) {
    let mut checks = Vec::new();

    // Restarts / flapping — the watchdog + bind-retry history.
    let restart_detail = match input.minutes_since_last_restart {
        Some(m) if m < 60 => format!(
            "{} restart{} in last hour (last {}m ago)",
            input.restarts_last_1h,
            if input.restarts_last_1h == 1 { "" } else { "s" },
            m
        ),
        _ => "stable — no restart in the last hour".to_owned(),
    };
    let restart_status = if input.restarts_last_1h >= 4 {
        Status::Red
    } else if input.restarts_last_1h >= 1 {
        Status::Amber
    } else {
        Status::Green
    };
    checks.push(check(
        "restarts",
        "Restarts",
        restart_status,
        restart_detail,
    ));

    // File descriptors — the exhaustion incident.
    if input.fd_limit > 0 && input.fd_count >= 0 {
        let ratio = input.fd_count as f64 / input.fd_limit as f64;
        let status = if ratio > FD_RED {
            Status::Red
        } else if ratio > FD_AMBER {
            Status::Amber
        } else {
            Status::Green
        };
        checks.push(check(
            "fileDescriptors",
            "File descriptors",
            status,
            format!(
                "{} of {} ({:.0}% of limit)",
                input.fd_count,
                input.fd_limit,
                ratio * 100.0
            ),
        ));
    }

    // Memory pressure.
    if input.mem_total > 0 {
        let ratio = input.mem_used as f64 / input.mem_total as f64;
        let status = if ratio > MEM_RED {
            Status::Red
        } else if ratio > MEM_AMBER {
            Status::Amber
        } else {
            Status::Green
        };
        checks.push(check(
            "memory",
            "Memory",
            status,
            format!("{:.0}% used", ratio * 100.0),
        ));
    }

    // Disk free.
    if input.disk_total > 0 {
        let free_ratio = input.disk_free as f64 / input.disk_total as f64;
        let status = if free_ratio < DISK_FREE_RED {
            Status::Red
        } else if free_ratio < DISK_FREE_AMBER {
            Status::Amber
        } else {
            Status::Green
        };
        checks.push(check(
            "disk",
            "Disk",
            status,
            format!("{:.0}% free", free_ratio * 100.0),
        ));
    }

    // Load average per core.
    if input.num_cpus > 0 {
        let per_core = input.load1 / input.num_cpus as f64;
        let status = if per_core > LOAD_PER_CORE_RED {
            Status::Red
        } else if per_core > LOAD_PER_CORE_AMBER {
            Status::Amber
        } else {
            Status::Green
        };
        checks.push(check(
            "load",
            "CPU load",
            status,
            format!("load {:.2} on {} cores", input.load1, input.num_cpus),
        ));
    }

    // HTTP 5xx rate over the recent window (needs enough traffic to be meaningful).
    if input.http_window_total >= HTTP_MIN_SAMPLE {
        let rate = pct(input.http_window_5xx, input.http_window_total);
        let status = if rate > HTTP_5XX_RED_PCT {
            Status::Red
        } else if rate > HTTP_5XX_AMBER_PCT {
            Status::Amber
        } else {
            Status::Green
        };
        checks.push(check(
            "httpErrors",
            "HTTP errors",
            status,
            format!(
                "{:.1}% 5xx ({} of {} reqs)",
                rate, input.http_window_5xx, input.http_window_total
            ),
        ));
    } else {
        checks.push(check(
            "httpErrors",
            "HTTP errors",
            Status::Green,
            "low traffic — nothing to flag".to_owned(),
        ));
    }

    // Live-proxy 502s — the fragLoadError signal.
    let live_status = if input.live_proxy_window_5xx >= LIVE_5XX_RED {
        Status::Red
    } else if input.live_proxy_window_5xx >= LIVE_5XX_AMBER {
        Status::Amber
    } else {
        Status::Green
    };
    checks.push(check(
        "liveStreaming",
        "Live streaming",
        live_status,
        if input.live_proxy_window_5xx > 0 {
            format!(
                "{} upstream proxy error(s) lately",
                input.live_proxy_window_5xx
            )
        } else {
            "no upstream proxy errors lately".to_owned()
        },
    ));

    // Sports/live provider health (in-memory, current).
    let provider_status = if input.worst_provider_consecutive_failures >= PROVIDER_CONSEC_RED {
        Status::Red
    } else if input.worst_provider_consecutive_failures >= PROVIDER_CONSEC_AMBER {
        Status::Amber
    } else {
        Status::Green
    };
    checks.push(check(
        "providers",
        "Providers",
        provider_status,
        if input.worst_provider_consecutive_failures > 0 {
            format!(
                "worst provider: {} consecutive failures",
                input.worst_provider_consecutive_failures
            )
        } else {
            "all providers responding".to_owned()
        },
    ));

    // Playback (VOD) failure rate — "has streaming been smooth".
    if input.playback_window_total >= PLAYBACK_MIN_SAMPLE {
        let rate = pct(input.playback_window_failures, input.playback_window_total);
        let status = if rate > PLAYBACK_FAIL_RED_PCT {
            Status::Red
        } else if rate > PLAYBACK_FAIL_AMBER_PCT {
            Status::Amber
        } else {
            Status::Green
        };
        checks.push(check(
            "playback",
            "Playback",
            status,
            format!(
                "{:.0}% of {} recent plays failed",
                rate, input.playback_window_total
            ),
        ));
    } else {
        checks.push(check(
            "playback",
            "Playback",
            Status::Green,
            "few recent plays — nothing to flag".to_owned(),
        ));
    }

    let overall = checks
        .iter()
        .fold(Status::Green, |acc, c| acc.worst(c.status));
    (overall, checks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HealthInputs {
        HealthInputs {
            fd_count: 100,
            fd_limit: 16_384,
            mem_used: 4,
            mem_total: 16,
            disk_free: 50,
            disk_total: 100,
            num_cpus: 8,
            ..Default::default()
        }
    }

    #[test]
    fn healthy_inputs_are_green() {
        let (status, checks) = compute_status(&base());
        assert_eq!(status, Status::Green);
        assert!(checks.iter().all(|c| c.status == Status::Green));
    }

    #[test]
    fn fd_exhaustion_goes_red() {
        let mut input = base();
        input.fd_count = 15_500; // ~95% of 16384
        let (status, _) = compute_status(&input);
        assert_eq!(status, Status::Red);
    }

    #[test]
    fn crash_loop_goes_red_single_restart_amber() {
        let mut input = base();
        input.restarts_last_1h = 1;
        input.minutes_since_last_restart = Some(2);
        assert_eq!(compute_status(&input).0, Status::Amber);
        input.restarts_last_1h = 5;
        assert_eq!(compute_status(&input).0, Status::Red);
    }

    #[test]
    fn low_traffic_does_not_flag_http_or_playback() {
        let mut input = base();
        input.http_window_total = 3;
        input.http_window_5xx = 3; // 100% but below min sample
        input.playback_window_total = 2;
        input.playback_window_failures = 2;
        assert_eq!(compute_status(&input).0, Status::Green);
    }

    #[test]
    fn high_5xx_rate_with_traffic_goes_red() {
        let mut input = base();
        input.http_window_total = 1000;
        input.http_window_5xx = 200; // 20%
        assert_eq!(compute_status(&input).0, Status::Red);
    }
}
