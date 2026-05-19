use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{Response, StatusCode};
use dashmap::DashMap;
use futures_util::stream;
use serde::Serialize;
use tokio::fs::{self, File};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant as TokioInstant, sleep, sleep_until, timeout};
use tokio_util::io::ReaderStream;
use url::form_urlencoded::byte_serialize;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::media::{MediaProbe, MediaService};
use crate::process::{
    RuntimeServices, normalize_audio_sync_ms, resolve_effective_remux_hwaccel_mode,
    run_process_capture_bytes,
};
use crate::utils::{hash_stable_string, now_ms};

const HLS_SEGMENT_DURATION_SECONDS: i64 = 6;
const HLS_SEGMENT_STALE_MS: i64 = 6 * 60 * 60 * 1000;
const HLS_SEGMENT_MAX_FILES: usize = 3000;
const HLS_TRANSCODE_IDLE_MS: i64 = 8 * 60 * 1000;
const HLS_SEGMENT_WAIT_TIMEOUT_MS: i64 = 30_000;
const HLS_SEGMENT_WAIT_POLL_MS: u64 = 180;
const REMUX_ACCURATE_SEEK_PREROLL_SECONDS: i64 = 12;
const FFMPEG_STDERR_MAX_LINES: usize = 80;
const FFMPEG_STDERR_MAX_BYTES: usize = 16 * 1024;
const HLS_CACHE_SCHEMA_VERSION: &str = "hls-v2";

const BROWSER_SAFE_AUDIO_CODECS: &[&str] = &["aac", "mp3", "mp2", "opus", "vorbis", "flac", "alac"];
const BROWSER_UNSAFE_AUDIO_CODEC_PREFIXES: &[&str] =
    &["ac3", "eac3", "dts", "dca", "truehd", "mlp", "pcm_", "wma"];

#[derive(Clone)]
pub struct StreamingService {
    config: Config,
    runtime: RuntimeServices,
    media: MediaService,
    hls_jobs: Arc<DashMap<String, Arc<HlsJob>>>,
    hls_job_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    hls_job_permits: Arc<Semaphore>,
    hls_segment_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    hls_segment_render_permits: Arc<Semaphore>,
    hls_metrics: Arc<HlsMetrics>,
    remux_permits: Arc<Semaphore>,
    remux_metrics: Arc<RemuxMetrics>,
    remux_active_jobs: Arc<DashMap<u64, i64>>,
    remux_next_job_id: Arc<AtomicU64>,
}

#[derive(Default)]
struct RemuxMetrics {
    active: AtomicI64,
    started: AtomicI64,
    completed: AtomicI64,
    failed: AtomicI64,
    canceled: AtomicI64,
    timed_out: AtomicI64,
    rejected: AtomicI64,
    spawn_errors: AtomicI64,
    read_errors: AtomicI64,
    stderr_truncated: AtomicI64,
}

#[derive(Default)]
struct HlsMetrics {
    active_transcodes: AtomicI64,
    playlist_requests: AtomicI64,
    segment_requests: AtomicI64,
    segment_cache_hits: AtomicI64,
    segment_cache_misses: AtomicI64,
    on_demand_renders: AtomicI64,
    active_segment_renders: AtomicI64,
    segment_render_started: AtomicI64,
    segment_render_completed: AtomicI64,
    segment_render_failed: AtomicI64,
    segment_render_rejected: AtomicI64,
    transcode_started: AtomicI64,
    transcode_completed: AtomicI64,
    transcode_failed: AtomicI64,
    transcode_skipped_busy: AtomicI64,
}

struct RemuxStreamGuard {
    metrics: Arc<RemuxMetrics>,
    active_jobs: Arc<DashMap<u64, i64>>,
    job_id: u64,
    _permit: OwnedSemaphorePermit,
    finished: bool,
}

struct HlsSegmentRenderGuard {
    metrics: Arc<HlsMetrics>,
    _permit: OwnedSemaphorePermit,
    finished: bool,
}

struct RemuxStreamState {
    stdout: ChildStdout,
    child: Child,
    buffer: Vec<u8>,
    guard: RemuxStreamGuard,
    deadline: TokioInstant,
    timeout_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingStats {
    remux: RemuxStats,
    hls: HlsStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxStats {
    active: i64,
    active_jobs: usize,
    max_concurrent: usize,
    queue_timeout_ms: u64,
    process_timeout_seconds: u64,
    oldest_active_seconds: i64,
    started: i64,
    completed: i64,
    failed: i64,
    canceled: i64,
    timed_out: i64,
    rejected: i64,
    spawn_errors: i64,
    read_errors: i64,
    stderr_truncated: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsStats {
    jobs: usize,
    active_jobs: usize,
    completed_jobs: usize,
    failed_jobs: usize,
    max_transcode_jobs: usize,
    max_segment_renders: usize,
    segment_queue_timeout_ms: u64,
    active_transcodes: i64,
    playlist_requests: i64,
    segment_requests: i64,
    segment_cache_hits: i64,
    segment_cache_misses: i64,
    on_demand_renders: i64,
    active_segment_renders: i64,
    segment_render_started: i64,
    segment_render_completed: i64,
    segment_render_failed: i64,
    segment_render_rejected: i64,
    transcode_started: i64,
    transcode_completed: i64,
    transcode_failed: i64,
    transcode_skipped_busy: i64,
}

struct HlsJob {
    source_input: String,
    audio_stream_index: i64,
    encode_mode: String,
    allow_software_fallback: bool,
    output_prefix: String,
    completion_marker_path: PathBuf,
    permit: Mutex<Option<OwnedSemaphorePermit>>,
    child: Mutex<Option<Child>>,
    last_accessed_at: AtomicI64,
    finished_at: AtomicI64,
    exited: AtomicBool,
    completed: AtomicBool,
    exit_code: AtomicI32,
}

#[derive(Clone)]
struct VideoEncodeConfig {
    mode: String,
    pre_input_args: Vec<String>,
    video_encode_args: Vec<String>,
}

impl StreamingService {
    pub fn new(config: Config, runtime: RuntimeServices, media: MediaService) -> Self {
        let remux_max_concurrent = config.remux_max_concurrent;
        let hls_max_transcode_jobs = config.hls_max_transcode_jobs;
        let hls_max_segment_renders = config.hls_max_segment_renders;
        Self {
            config,
            runtime,
            media,
            hls_jobs: Arc::new(DashMap::new()),
            hls_job_locks: Arc::new(DashMap::new()),
            hls_job_permits: Arc::new(Semaphore::new(hls_max_transcode_jobs)),
            hls_segment_locks: Arc::new(DashMap::new()),
            hls_segment_render_permits: Arc::new(Semaphore::new(hls_max_segment_renders)),
            hls_metrics: Arc::new(HlsMetrics::default()),
            remux_permits: Arc::new(Semaphore::new(remux_max_concurrent)),
            remux_metrics: Arc::new(RemuxMetrics::default()),
            remux_active_jobs: Arc::new(DashMap::new()),
            remux_next_job_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn prune(&self) {
        self.prune_idle_hls_jobs().await;
        let _ = self.prune_hls_cache_files().await;
    }

    pub fn stats(&self) -> StreamingStats {
        let now = now_ms();
        let oldest_active_seconds = self
            .remux_active_jobs
            .iter()
            .map(|entry| ((now - *entry.value()) / 1000).max(0))
            .max()
            .unwrap_or(0);
        let mut active_hls_jobs = 0_usize;
        let mut completed_hls_jobs = 0_usize;
        let mut failed_hls_jobs = 0_usize;
        for job in self.hls_jobs.iter() {
            let exited = job.exited.load(Ordering::Relaxed);
            let completed = job.completed.load(Ordering::Relaxed);
            if !exited {
                active_hls_jobs += 1;
            } else if completed {
                completed_hls_jobs += 1;
            } else {
                failed_hls_jobs += 1;
            }
        }
        StreamingStats {
            remux: RemuxStats {
                active: self.remux_metrics.active.load(Ordering::Relaxed),
                active_jobs: self.remux_active_jobs.len(),
                max_concurrent: self.config.remux_max_concurrent,
                queue_timeout_ms: self.config.remux_queue_timeout_ms,
                process_timeout_seconds: self.config.remux_process_timeout_seconds,
                oldest_active_seconds,
                started: self.remux_metrics.started.load(Ordering::Relaxed),
                completed: self.remux_metrics.completed.load(Ordering::Relaxed),
                failed: self.remux_metrics.failed.load(Ordering::Relaxed),
                canceled: self.remux_metrics.canceled.load(Ordering::Relaxed),
                timed_out: self.remux_metrics.timed_out.load(Ordering::Relaxed),
                rejected: self.remux_metrics.rejected.load(Ordering::Relaxed),
                spawn_errors: self.remux_metrics.spawn_errors.load(Ordering::Relaxed),
                read_errors: self.remux_metrics.read_errors.load(Ordering::Relaxed),
                stderr_truncated: self.remux_metrics.stderr_truncated.load(Ordering::Relaxed),
            },
            hls: HlsStats {
                jobs: self.hls_jobs.len(),
                active_jobs: active_hls_jobs,
                completed_jobs: completed_hls_jobs,
                failed_jobs: failed_hls_jobs,
                max_transcode_jobs: self.config.hls_max_transcode_jobs,
                max_segment_renders: self.config.hls_max_segment_renders,
                segment_queue_timeout_ms: self.config.hls_segment_queue_timeout_ms,
                active_transcodes: self.hls_metrics.active_transcodes.load(Ordering::Relaxed),
                playlist_requests: self.hls_metrics.playlist_requests.load(Ordering::Relaxed),
                segment_requests: self.hls_metrics.segment_requests.load(Ordering::Relaxed),
                segment_cache_hits: self.hls_metrics.segment_cache_hits.load(Ordering::Relaxed),
                segment_cache_misses: self
                    .hls_metrics
                    .segment_cache_misses
                    .load(Ordering::Relaxed),
                on_demand_renders: self.hls_metrics.on_demand_renders.load(Ordering::Relaxed),
                active_segment_renders: self
                    .hls_metrics
                    .active_segment_renders
                    .load(Ordering::Relaxed),
                segment_render_started: self
                    .hls_metrics
                    .segment_render_started
                    .load(Ordering::Relaxed),
                segment_render_completed: self
                    .hls_metrics
                    .segment_render_completed
                    .load(Ordering::Relaxed),
                segment_render_failed: self
                    .hls_metrics
                    .segment_render_failed
                    .load(Ordering::Relaxed),
                segment_render_rejected: self
                    .hls_metrics
                    .segment_render_rejected
                    .load(Ordering::Relaxed),
                transcode_started: self.hls_metrics.transcode_started.load(Ordering::Relaxed),
                transcode_completed: self.hls_metrics.transcode_completed.load(Ordering::Relaxed),
                transcode_failed: self.hls_metrics.transcode_failed.load(Ordering::Relaxed),
                transcode_skipped_busy: self
                    .hls_metrics
                    .transcode_skipped_busy
                    .load(Ordering::Relaxed),
            },
        }
    }

    pub async fn create_remux_response(
        &self,
        input: &str,
        start_seconds: i64,
        audio_stream_index: i64,
        subtitle_stream_index: i64,
        manual_audio_sync_ms: i64,
        preferred_video_mode: &str,
    ) -> AppResult<Response<Body>> {
        let source = self.media.resolve_transcode_input(input)?;
        let permit = match timeout(
            Duration::from_millis(self.config.remux_queue_timeout_ms),
            self.remux_permits.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => {
                return Err(ApiError::internal("Remux limiter is closed."));
            }
            Err(_) => {
                self.remux_metrics.rejected.fetch_add(1, Ordering::Relaxed);
                return Err(ApiError::too_many_requests(
                    "Server is busy preparing another stream. Please retry in a moment.",
                ));
            }
        };
        let job_id = self.remux_next_job_id.fetch_add(1, Ordering::Relaxed);
        let guard = RemuxStreamGuard::new(
            self.remux_metrics.clone(),
            self.remux_active_jobs.clone(),
            job_id,
            permit,
        );
        let safe_start_seconds = start_seconds.max(0);
        let safe_audio_stream_index = if audio_stream_index >= 0 {
            audio_stream_index
        } else {
            -1
        };
        let safe_subtitle_stream_index = if subtitle_stream_index >= 0 {
            subtitle_stream_index
        } else {
            -1
        };
        let safe_manual_audio_sync_ms = normalize_audio_sync_ms(manual_audio_sync_ms);
        let requested_video_mode = normalize_remux_video_mode(preferred_video_mode);
        let source_lower = source.trim().to_lowercase();
        let source_path_lower = source_lower
            .split(['?', '#'])
            .next()
            .unwrap_or_default()
            .to_owned();
        let looks_like_matroska_source = [".mkv", ".mk3d", ".mka", ".webm"]
            .iter()
            .any(|suffix| source_path_lower.contains(suffix));
        let mut resolved_video_mode = if requested_video_mode == "auto" {
            if looks_like_matroska_source {
                "normalize".to_owned()
            } else {
                "copy".to_owned()
            }
        } else {
            requested_video_mode.clone()
        };

        let should_probe = self.config.auto_audio_sync_enabled || requested_video_mode == "auto";
        let probe = if should_probe {
            self.media.probe_media_tracks(&source).await.ok()
        } else {
            None
        };

        let mut effective_audio_stream_index = safe_audio_stream_index;
        let mut remux_subtitle_stream_indexes = Vec::new();
        let mut selected_remux_subtitle_ordinal = None;
        if let Some(probe) = probe.as_ref() {
            if effective_audio_stream_index < 0
                && should_force_remux_for_audio_compatibility(probe, effective_audio_stream_index)
            {
                effective_audio_stream_index = get_fallback_audio_stream_index(probe);
            }

            if requested_video_mode == "auto" && resolved_video_mode != "normalize" {
                let probe_format = probe.formatName.to_lowercase();
                if probe_format.contains("matroska") || probe_format.contains("webm") {
                    resolved_video_mode = "normalize".to_owned();
                }
            }
            if requested_video_mode == "auto"
                && resolved_video_mode != "normalize"
                && should_force_normalize_video_for_browser(probe, &source)
            {
                resolved_video_mode = "normalize".to_owned();
            }

            remux_subtitle_stream_indexes = probe
                .subtitleTracks
                .iter()
                .filter(|track| track.isTextBased)
                .map(|track| track.streamIndex)
                .collect::<Vec<_>>();
            if safe_subtitle_stream_index >= 0 {
                selected_remux_subtitle_ordinal = remux_subtitle_stream_indexes
                    .iter()
                    .position(|stream_index| *stream_index == safe_subtitle_stream_index);
            }
        }
        if remux_subtitle_stream_indexes.is_empty() && safe_subtitle_stream_index >= 0 {
            remux_subtitle_stream_indexes.push(safe_subtitle_stream_index);
            selected_remux_subtitle_ordinal = Some(0);
        }
        if should_force_accurate_seek_for_remux(
            safe_start_seconds,
            &requested_video_mode,
            &resolved_video_mode,
        ) {
            resolved_video_mode = "normalize".to_owned();
        }

        let mut effective_remux_hwaccel_mode = "none".to_owned();
        let mut remux_video_encode_config = build_remux_video_encode_config("none");
        if resolved_video_mode == "normalize" {
            let ffmpeg_capabilities = self.runtime.get_ffmpeg_capabilities(false).await;
            effective_remux_hwaccel_mode = resolve_effective_remux_hwaccel_mode(
                &ffmpeg_capabilities,
                &self.config.remux_hwaccel_mode,
            );
            remux_video_encode_config =
                build_remux_video_encode_config(&effective_remux_hwaccel_mode);
        }

        let mut auto_audio_delay_ms = 0_i64;
        if self.config.auto_audio_sync_enabled
            && let Some(probe) = probe.as_ref()
        {
            let probe_format = probe.formatName.to_lowercase();
            let probe_looks_like_matroska =
                probe_format.contains("matroska") || probe_format.contains("webm");
            let audio_needs_reencode = probe
                .audioTracks
                .iter()
                .find(|track| track.streamIndex == effective_audio_stream_index)
                .or_else(|| probe.audioTracks.first())
                .map(|track| !is_browser_safe_audio_codec(&track.codec))
                .unwrap_or(false);
            let should_apply_auto_audio_delay = looks_like_matroska_source
                || probe_looks_like_matroska
                || resolved_video_mode == "normalize"
                || audio_needs_reencode;
            if should_apply_auto_audio_delay {
                let selected_audio_track = probe
                    .audioTracks
                    .iter()
                    .find(|track| track.streamIndex == effective_audio_stream_index)
                    .cloned()
                    .or_else(|| probe.audioTracks.first().cloned());
                let audio_start = selected_audio_track
                    .as_ref()
                    .map(|track| track.startTimeSeconds)
                    .unwrap_or_default();
                let normalized_b_frame_lead_seconds = if probe.videoBFrameLeadSeconds > 0.0 {
                    probe.videoBFrameLeadSeconds.min(0.35)
                } else {
                    0.0
                };
                let timestamp_offset_seconds =
                    probe.videoStartTimeSeconds - audio_start + normalized_b_frame_lead_seconds;
                if timestamp_offset_seconds.is_finite()
                    && timestamp_offset_seconds > 0.02
                    && timestamp_offset_seconds < 4.0
                {
                    auto_audio_delay_ms = (timestamp_offset_seconds * 1000.0).round() as i64;
                }
            }
        }
        let total_audio_sync_ms =
            normalize_audio_sync_ms(auto_audio_delay_ms + safe_manual_audio_sync_ms);

        let (fast_seek_seconds, accurate_trim_seconds) =
            if safe_start_seconds > 0 && resolved_video_mode == "normalize" {
                let trim = safe_start_seconds.min(REMUX_ACCURATE_SEEK_PREROLL_SECONDS);
                (safe_start_seconds - trim, trim)
            } else {
                (safe_start_seconds, 0)
            };

        let mut ffmpeg_args = vec![
            "ffmpeg".to_owned(),
            "-v".to_owned(),
            "error".to_owned(),
            "-fflags".to_owned(),
            "+genpts+igndts+discardcorrupt".to_owned(),
            "-analyzeduration".to_owned(),
            "100M".to_owned(),
            "-probesize".to_owned(),
            "100M".to_owned(),
        ];
        if fast_seek_seconds > 0 {
            ffmpeg_args.push("-ss".to_owned());
            ffmpeg_args.push(fast_seek_seconds.to_string());
        }
        if resolved_video_mode == "normalize" {
            ffmpeg_args.extend(remux_video_encode_config.pre_input_args.clone());
        }
        ffmpeg_args.push("-i".to_owned());
        ffmpeg_args.push(source.clone());
        if accurate_trim_seconds > 0 {
            ffmpeg_args.push("-ss".to_owned());
            ffmpeg_args.push(accurate_trim_seconds.to_string());
        }
        ffmpeg_args.push("-map".to_owned());
        ffmpeg_args.push("0:v:0".to_owned());
        ffmpeg_args.push("-map".to_owned());
        ffmpeg_args.push(if effective_audio_stream_index >= 0 {
            format!("0:{effective_audio_stream_index}?")
        } else {
            "0:a:0?".to_owned()
        });
        if !remux_subtitle_stream_indexes.is_empty() {
            for subtitle_stream_index in &remux_subtitle_stream_indexes {
                ffmpeg_args.push("-map".to_owned());
                ffmpeg_args.push(format!("0:{subtitle_stream_index}?"));
            }
        } else {
            ffmpeg_args.push("-sn".to_owned());
        }
        let mut audio_filters = Vec::new();
        if total_audio_sync_ms > 0 {
            audio_filters.push(format!("adelay={total_audio_sync_ms}:all=1"));
        } else if total_audio_sync_ms < 0 {
            let advance_seconds = format!("{:.3}", (total_audio_sync_ms.abs() as f64) / 1000.0)
                .trim_end_matches('0')
                .trim_end_matches('.')
                .to_owned();
            audio_filters.push(format!("atrim=start={advance_seconds}"));
            audio_filters.push("asetpts=PTS-STARTPTS".to_owned());
        }
        if resolved_video_mode == "normalize" {
            // When video PTS is also reset (setpts=PTS-STARTPTS), align audio PTS to 0
            audio_filters.push("aresample=async=1000:first_pts=0".to_owned());
        } else {
            // When video is copied, preserve audio PTS alignment with video
            audio_filters.push("aresample=async=1000".to_owned());
        }
        ffmpeg_args.push("-af".to_owned());
        ffmpeg_args.push(audio_filters.join(","));
        if resolved_video_mode == "normalize" {
            ffmpeg_args.push("-vf".to_owned());
            ffmpeg_args.push("setpts=PTS-STARTPTS".to_owned());
            ffmpeg_args.extend(remux_video_encode_config.video_encode_args.clone());
        } else {
            ffmpeg_args.push("-c:v".to_owned());
            ffmpeg_args.push("copy".to_owned());
        }
        ffmpeg_args.push("-c:a".to_owned());
        ffmpeg_args.push("aac".to_owned());
        ffmpeg_args.push("-ac".to_owned());
        ffmpeg_args.push("2".to_owned());
        ffmpeg_args.push("-b:a".to_owned());
        ffmpeg_args.push("192k".to_owned());
        if !remux_subtitle_stream_indexes.is_empty() {
            ffmpeg_args.push("-c:s".to_owned());
            ffmpeg_args.push("mov_text".to_owned());
            for (ordinal, _) in remux_subtitle_stream_indexes.iter().enumerate() {
                ffmpeg_args.push(format!("-disposition:s:{ordinal}"));
                ffmpeg_args.push(if Some(ordinal) == selected_remux_subtitle_ordinal {
                    "default".to_owned()
                } else {
                    "0".to_owned()
                });
            }
        }
        ffmpeg_args.extend([
            "-max_interleave_delta".to_owned(),
            "0".to_owned(),
            "-muxpreload".to_owned(),
            "0".to_owned(),
            "-muxdelay".to_owned(),
            "0".to_owned(),
            "-avoid_negative_ts".to_owned(),
            "make_zero".to_owned(),
            "-movflags".to_owned(),
            "frag_keyframe+empty_moov+default_base_moof".to_owned(),
            "-frag_duration".to_owned(),
            "5000000".to_owned(),
            "-f".to_owned(),
            "mp4".to_owned(),
            "pipe:1".to_owned(),
        ]);

        let mut command = Command::new("ffmpeg");
        command
            .args(ffmpeg_args.iter().skip(1))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let mut guard = guard;
                guard.mark_spawn_error();
                return Err(ApiError::internal(error.to_string()));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let mut guard = guard;
                guard.mark_spawn_error();
                return Err(ApiError::internal("Failed to capture ffmpeg stdout."));
            }
        };

        // Capture stderr in a background task so ffmpeg errors are logged.
        if let Some(stderr) = child.stderr.take() {
            spawn_bounded_ffmpeg_stderr_logger("remux", stderr, Some(self.remux_metrics.clone()));
        }

        let timeout_seconds = self.config.remux_process_timeout_seconds;
        let stream = stream::try_unfold(
            RemuxStreamState {
                stdout,
                child,
                buffer: vec![0_u8; 16 * 1024],
                guard,
                deadline: TokioInstant::now() + Duration::from_secs(timeout_seconds),
                timeout_seconds,
            },
            |mut state| async move {
                let read = tokio::select! {
                    read_result = state.stdout.read(&mut state.buffer) => {
                        match read_result {
                            Ok(read) => read,
                            Err(error) => {
                                state.guard.mark_read_error();
                                return Err(error);
                            }
                        }
                    }
                    _ = sleep_until(state.deadline) => {
                        let _ = state.child.kill().await;
                        let _ = state.child.wait().await;
                        state.guard.mark_timed_out();
                        eprintln!(
                            "[remux] ffmpeg timed out after {} seconds",
                            state.timeout_seconds
                        );
                        return Ok(None);
                    }
                };
                if read == 0 {
                    let status = state.child.wait().await?;
                    if !status.success() {
                        state.guard.mark_failed();
                        eprintln!(
                            "[remux] ffmpeg exited with code {}",
                            status.code().unwrap_or(-1)
                        );
                    } else {
                        state.guard.mark_completed();
                    }
                    return Ok(None);
                }
                let bytes = Bytes::copy_from_slice(&state.buffer[..read]);
                Ok::<_, std::io::Error>(Some((bytes, state)))
            },
        );

        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "video/mp4")
            .header(CACHE_CONTROL, "no-store")
            .header("X-Audio-Shift-Ms", total_audio_sync_ms.to_string())
            .header("X-Audio-Delay-Ms", total_audio_sync_ms.max(0).to_string())
            .header(
                "X-Audio-Advance-Ms",
                (-total_audio_sync_ms).max(0).to_string(),
            )
            .header("X-Auto-Audio-Delay-Ms", auto_audio_delay_ms.to_string())
            .header(
                "X-Manual-Audio-Sync-Ms",
                safe_manual_audio_sync_ms.to_string(),
            )
            .header(
                "X-Subtitle-Stream-Index",
                safe_subtitle_stream_index.to_string(),
            )
            .header(
                "X-Auto-Audio-Sync-Enabled",
                if self.config.auto_audio_sync_enabled {
                    "1"
                } else {
                    "0"
                },
            )
            .header("X-Remux-Video-Mode-Requested", requested_video_mode)
            .header("X-Remux-Video-Mode-Resolved", resolved_video_mode)
            .header("X-Remux-Fast-Seek-Seconds", fast_seek_seconds.to_string())
            .header(
                "X-Remux-Accurate-Trim-Seconds",
                accurate_trim_seconds.to_string(),
            )
            .header(
                "X-Remux-Hwaccel-Requested",
                self.config.remux_hwaccel_mode.clone(),
            )
            .header("X-Remux-Hwaccel-Effective", effective_remux_hwaccel_mode)
            .body(Body::from_stream(stream))
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn create_hls_playlist_response(
        &self,
        input: &str,
        audio_stream_index: i64,
    ) -> AppResult<Response<Body>> {
        self.hls_metrics
            .playlist_requests
            .fetch_add(1, Ordering::Relaxed);
        let source_input = self.media.resolve_transcode_input(input)?;
        let probe = self.media.probe_media_tracks(&source_input).await?;
        let media_duration_seconds = probe.durationSeconds.max(1) as f64;
        let segment_count =
            ((media_duration_seconds / HLS_SEGMENT_DURATION_SECONDS as f64).ceil() as i64).max(1);
        let safe_audio_stream = if audio_stream_index >= 0 {
            audio_stream_index
        } else {
            -1
        };

        let service = self.clone();
        let source_for_job = source_input.clone();
        tokio::spawn(async move {
            let _ = service
                .ensure_hls_transcode_job(&source_for_job, safe_audio_stream)
                .await;
        });

        let mut lines = vec![
            "#EXTM3U".to_owned(),
            "#EXT-X-VERSION:3".to_owned(),
            "#EXT-X-PLAYLIST-TYPE:VOD".to_owned(),
            format!("#EXT-X-TARGETDURATION:{HLS_SEGMENT_DURATION_SECONDS}"),
            "#EXT-X-MEDIA-SEQUENCE:0".to_owned(),
        ];
        for index in 0..segment_count {
            let remaining =
                media_duration_seconds - index as f64 * HLS_SEGMENT_DURATION_SECONDS as f64;
            let segment_duration = remaining.max(0.5).min(HLS_SEGMENT_DURATION_SECONDS as f64);
            let segment_url = format!(
                "/api/hls/segment.ts?input={}&index={}&audioStream={}",
                byte_serialize(source_input.as_bytes()).collect::<String>(),
                index,
                safe_audio_stream
            );
            lines.push(format!("#EXTINF:{segment_duration:.3},"));
            lines.push(segment_url);
        }
        lines.push("#EXT-X-ENDLIST".to_owned());

        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/vnd.apple.mpegurl; charset=utf-8")
            .header(CACHE_CONTROL, "no-store")
            .body(Body::from(lines.join("\n")))
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub async fn create_hls_segment_response(
        &self,
        input: &str,
        segment_index: i64,
        audio_stream_index: i64,
    ) -> AppResult<Response<Body>> {
        self.hls_metrics
            .segment_requests
            .fetch_add(1, Ordering::Relaxed);
        let source_input = self.media.resolve_transcode_input(input)?;
        let segment_path = self
            .get_or_create_hls_segment(&source_input, segment_index.max(0), audio_stream_index)
            .await?;
        let file = File::open(&segment_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let file_size = file
            .metadata()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .len();
        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "video/mp2t")
            .header(CACHE_CONTROL, "private, max-age=3600")
            .header(CONTENT_LENGTH, file_size.to_string())
            .body(Body::from_stream(ReaderStream::new(file)))
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    async fn ensure_hls_transcode_job(
        &self,
        source_input: &str,
        audio_stream_index: i64,
    ) -> AppResult<Arc<HlsJob>> {
        self.ensure_hls_transcode_job_with_mode(source_input, audio_stream_index, None)
            .await
    }

    async fn ensure_hls_transcode_job_with_mode(
        &self,
        source_input: &str,
        audio_stream_index: i64,
        preferred_mode_override: Option<(&str, bool)>,
    ) -> AppResult<Arc<HlsJob>> {
        let safe_audio_stream_index = if audio_stream_index >= 0 {
            audio_stream_index
        } else {
            -1
        };
        let job_key = build_hls_transcode_job_key(source_input, safe_audio_stream_index);
        let lock = key_lock(&self.hls_job_locks, &job_key);
        let _guard = lock.lock().await;
        self.ensure_hls_transcode_job_locked(
            source_input,
            safe_audio_stream_index,
            preferred_mode_override,
        )
        .await
    }

    async fn ensure_hls_transcode_job_locked(
        &self,
        source_input: &str,
        safe_audio_stream_index: i64,
        preferred_mode_override: Option<(&str, bool)>,
    ) -> AppResult<Arc<HlsJob>> {
        let job_key = build_hls_transcode_job_key(source_input, safe_audio_stream_index);
        if let Some(existing) = self.hls_jobs.get(&job_key) {
            let job = existing.clone();
            self.refresh_hls_job_state(&job).await;
            job.last_accessed_at.store(now_ms(), Ordering::Relaxed);
            if !job.exited.load(Ordering::Relaxed) || job.exit_code.load(Ordering::Relaxed) == 0 {
                return Ok(job);
            }
            self.hls_jobs.remove(&job_key);
            if let Some((preferred_mode, allow_software_fallback)) = preferred_mode_override {
                return self
                    .start_hls_transcode_job(
                        source_input,
                        safe_audio_stream_index,
                        preferred_mode,
                        allow_software_fallback,
                    )
                    .await;
            }
            if job.allow_software_fallback && job.encode_mode != "none" {
                return self
                    .start_hls_transcode_job(source_input, safe_audio_stream_index, "none", false)
                    .await;
            }
        }

        self.ensure_hls_cache_directory().await?;
        let (preferred_mode, allow_software_fallback) =
            if let Some((preferred_mode, allow_software_fallback)) = preferred_mode_override {
                (preferred_mode.to_owned(), allow_software_fallback)
            } else {
                let ffmpeg = self.runtime.get_ffmpeg_capabilities(false).await;
                let preferred_mode = if ffmpeg.checkedAt > 0 {
                    ffmpeg.effectiveHlsHwaccel
                } else {
                    self.config.hls_hwaccel_mode.clone()
                };
                let allow_software_fallback = preferred_mode != "none";
                (preferred_mode, allow_software_fallback)
            };
        self.start_hls_transcode_job(
            source_input,
            safe_audio_stream_index,
            &preferred_mode,
            allow_software_fallback,
        )
        .await
    }

    async fn start_hls_transcode_job(
        &self,
        source_input: &str,
        audio_stream_index: i64,
        encode_mode: &str,
        allow_software_fallback: bool,
    ) -> AppResult<Arc<HlsJob>> {
        let job_key = build_hls_transcode_job_key(source_input, audio_stream_index);
        let encode_config = build_hls_video_encode_config(encode_mode);
        let output_prefix = build_hls_transcode_output_prefix(
            &self.config.hls_cache_dir,
            &job_key,
            &encode_config.mode,
        );
        let completion_marker_path = build_hls_completion_marker_path(&output_prefix);
        if fs::metadata(&completion_marker_path).await.is_ok() {
            let now = now_ms();
            let job = Arc::new(HlsJob {
                source_input: source_input.to_owned(),
                audio_stream_index,
                encode_mode: encode_config.mode.clone(),
                allow_software_fallback,
                output_prefix,
                completion_marker_path,
                permit: Mutex::new(None),
                child: Mutex::new(None),
                last_accessed_at: AtomicI64::new(now),
                finished_at: AtomicI64::new(now),
                exited: AtomicBool::new(true),
                completed: AtomicBool::new(true),
                exit_code: AtomicI32::new(0),
            });
            self.hls_jobs.insert(job_key, job.clone());
            return Ok(job);
        }
        let _ = self.remove_incomplete_hls_outputs(&output_prefix).await;
        let permit = match self.hls_job_permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.hls_metrics
                    .transcode_skipped_busy
                    .fetch_add(1, Ordering::Relaxed);
                return Err(ApiError::too_many_requests(
                    "HLS transcode capacity is busy; serving segments on demand.",
                ));
            }
        };
        let args = build_hls_transcode_args(
            source_input,
            audio_stream_index,
            &encode_config,
            &output_prefix,
        );
        let mut command = Command::new("ffmpeg");
        command
            .args(args.iter().skip(1))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| ApiError::internal(error.to_string()))?;

        // Capture stderr in a background task so HLS transcode errors are logged.
        if let Some(stderr) = child.stderr.take() {
            spawn_bounded_ffmpeg_stderr_logger("transcode", stderr, None);
        }
        let now = now_ms();
        self.hls_metrics
            .active_transcodes
            .fetch_add(1, Ordering::Relaxed);
        self.hls_metrics
            .transcode_started
            .fetch_add(1, Ordering::Relaxed);
        let job = Arc::new(HlsJob {
            source_input: source_input.to_owned(),
            audio_stream_index,
            encode_mode: encode_config.mode.clone(),
            allow_software_fallback,
            output_prefix,
            completion_marker_path,
            permit: Mutex::new(Some(permit)),
            child: Mutex::new(Some(child)),
            last_accessed_at: AtomicI64::new(now),
            finished_at: AtomicI64::new(0),
            exited: AtomicBool::new(false),
            completed: AtomicBool::new(false),
            exit_code: AtomicI32::new(-1),
        });
        self.hls_jobs.insert(job_key, job.clone());
        let service = self.clone();
        let job_for_refresh = job.clone();
        tokio::spawn(async move {
            while !job_for_refresh.exited.load(Ordering::Relaxed) {
                sleep(Duration::from_millis(1_000)).await;
                service.refresh_hls_job_state(&job_for_refresh).await;
            }
        });
        Ok(job)
    }

    async fn refresh_hls_job_state(&self, job: &Arc<HlsJob>) {
        let mut guard = job.child.lock().await;
        let Some(child) = guard.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                job.exited.store(true, Ordering::Relaxed);
                let success = status.success();
                job.completed.store(success, Ordering::Relaxed);
                job.exit_code.store(
                    status.code().unwrap_or(if success { 0 } else { 1 }),
                    Ordering::Relaxed,
                );
                job.finished_at.store(now_ms(), Ordering::Relaxed);
                *guard = None;
                if success {
                    let _ = fs::write(&job.completion_marker_path, b"complete\n").await;
                }
                self.release_hls_job_permit(job, success).await;
            }
            Ok(None) => {}
            Err(_) => {
                job.exited.store(true, Ordering::Relaxed);
                job.completed.store(false, Ordering::Relaxed);
                job.exit_code.store(1, Ordering::Relaxed);
                job.finished_at.store(now_ms(), Ordering::Relaxed);
                *guard = None;
                self.release_hls_job_permit(job, false).await;
            }
        }
    }

    async fn release_hls_job_permit(&self, job: &Arc<HlsJob>, success: bool) {
        if job.permit.lock().await.take().is_none() {
            return;
        }
        self.hls_metrics
            .active_transcodes
            .fetch_sub(1, Ordering::Relaxed);
        if success {
            self.hls_metrics
                .transcode_completed
                .fetch_add(1, Ordering::Relaxed);
        } else {
            self.hls_metrics
                .transcode_failed
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn wait_for_hls_segment_from_job(
        &self,
        mut job: Arc<HlsJob>,
        segment_index: i64,
    ) -> AppResult<PathBuf> {
        let started_at = now_ms();
        let safe_segment_index = segment_index.max(0);

        while now_ms() - started_at < HLS_SEGMENT_WAIT_TIMEOUT_MS.max(1_000) {
            job.last_accessed_at.store(now_ms(), Ordering::Relaxed);
            let segment_path = build_hls_transcode_segment_path_from_prefix(
                &job.output_prefix,
                safe_segment_index,
            );
            if let Ok(metadata) = fs::metadata(&segment_path).await
                && metadata.is_file()
                && metadata.len() > 0
            {
                self.hls_metrics
                    .segment_cache_hits
                    .fetch_add(1, Ordering::Relaxed);
                return Ok(segment_path);
            }

            self.refresh_hls_job_state(&job).await;
            if job.exited.load(Ordering::Relaxed) {
                if job.exit_code.load(Ordering::Relaxed) == 0 {
                    return self
                        .render_hls_segment_on_demand(
                            &job.source_input,
                            safe_segment_index,
                            job.audio_stream_index,
                            Some(segment_path),
                        )
                        .await;
                }
                if job.allow_software_fallback && job.encode_mode != "none" {
                    job = self
                        .ensure_hls_transcode_job_with_mode(
                            &job.source_input,
                            job.audio_stream_index,
                            Some(("none", false)),
                        )
                        .await?;
                    continue;
                }
                return Err(ApiError::bad_gateway(format!(
                    "HLS transcode failed: exit code {}",
                    job.exit_code.load(Ordering::Relaxed)
                )));
            }

            sleep(Duration::from_millis(HLS_SEGMENT_WAIT_POLL_MS)).await;
        }

        self.render_hls_segment_on_demand(
            &job.source_input,
            safe_segment_index,
            job.audio_stream_index,
            None,
        )
        .await
    }

    async fn render_hls_segment_on_demand(
        &self,
        source_input: &str,
        segment_index: i64,
        audio_stream_index: i64,
        output_path: Option<PathBuf>,
    ) -> AppResult<PathBuf> {
        self.ensure_hls_cache_directory().await?;
        let safe_segment_index = segment_index.max(0);
        let safe_audio_stream_index = if audio_stream_index >= 0 {
            audio_stream_index
        } else {
            -1
        };
        let segment_path = output_path.unwrap_or_else(|| {
            build_hls_on_demand_segment_path(
                &self.config.hls_cache_dir,
                source_input,
                safe_audio_stream_index,
                safe_segment_index,
            )
        });
        let segment_lock_key = segment_path.to_string_lossy().to_string();
        let segment_lock = key_lock(&self.hls_segment_locks, &segment_lock_key);
        let _segment_guard = segment_lock.lock().await;
        if let Ok(metadata) = fs::metadata(&segment_path).await
            && metadata.is_file()
            && metadata.len() > 0
        {
            self.hls_metrics
                .segment_cache_hits
                .fetch_add(1, Ordering::Relaxed);
            return Ok(segment_path);
        }
        let render_permit = match timeout(
            Duration::from_millis(self.config.hls_segment_queue_timeout_ms),
            self.hls_segment_render_permits.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(ApiError::internal("HLS segment limiter is closed.")),
            Err(_) => {
                self.hls_metrics
                    .segment_render_rejected
                    .fetch_add(1, Ordering::Relaxed);
                return Err(ApiError::too_many_requests(
                    "Server is busy preparing video segments. Please retry in a moment.",
                ));
            }
        };
        let mut render_guard = HlsSegmentRenderGuard::new(self.hls_metrics.clone(), render_permit);
        self.hls_metrics
            .on_demand_renders
            .fetch_add(1, Ordering::Relaxed);
        let segment_start_seconds = safe_segment_index * HLS_SEGMENT_DURATION_SECONDS;
        let build_segment_args = |encode_config: &VideoEncodeConfig| {
            let mut args = vec!["ffmpeg".to_owned(), "-v".to_owned(), "error".to_owned()];
            args.extend(encode_config.pre_input_args.clone());
            args.extend([
                "-ss".to_owned(),
                segment_start_seconds.to_string(),
                "-i".to_owned(),
                source_input.to_owned(),
                "-t".to_owned(),
                HLS_SEGMENT_DURATION_SECONDS.to_string(),
                "-map".to_owned(),
                "0:v:0".to_owned(),
                "-map".to_owned(),
                if safe_audio_stream_index >= 0 {
                    format!("0:{safe_audio_stream_index}?")
                } else {
                    "0:a:0?".to_owned()
                },
                "-sn".to_owned(),
            ]);
            args.extend(encode_config.video_encode_args.clone());
            args.extend([
                "-c:a".to_owned(),
                "aac".to_owned(),
                "-b:a".to_owned(),
                "160k".to_owned(),
                "-f".to_owned(),
                "mpegts".to_owned(),
                "pipe:1".to_owned(),
            ]);
            args
        };

        let ffmpeg = self.runtime.get_ffmpeg_capabilities(false).await;
        let preferred_mode = if ffmpeg.checkedAt > 0 {
            ffmpeg.effectiveHlsHwaccel
        } else {
            self.config.hls_hwaccel_mode.clone()
        };
        let primary_encode_config = build_hls_video_encode_config(&preferred_mode);
        let segment_bytes = match run_process_capture_bytes(
            &build_segment_args(&primary_encode_config),
            20_000,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) if primary_encode_config.mode != "none" => {
                eprintln!(
                    "[transcode] HLS hardware acceleration ({}) failed, falling back to software encode: {}",
                    primary_encode_config.mode, error
                );
                run_process_capture_bytes(
                    &build_segment_args(&build_hls_video_encode_config("none")),
                    20_000,
                )
                .await
                .map_err(ApiError::bad_gateway)?
            }
            Err(error) => return Err(ApiError::bad_gateway(error)),
        };

        if segment_bytes.is_empty() {
            return Err(ApiError::bad_gateway(format!(
                "Unable to create HLS segment {safe_segment_index}."
            )));
        }
        fs::write(&segment_path, segment_bytes)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        render_guard.mark_completed();
        Ok(segment_path)
    }

    async fn get_or_create_hls_segment(
        &self,
        source_input: &str,
        segment_index: i64,
        audio_stream_index: i64,
    ) -> AppResult<PathBuf> {
        let safe_segment_index = segment_index.max(0);
        let safe_audio_stream_index = if audio_stream_index >= 0 {
            audio_stream_index
        } else {
            -1
        };
        let on_demand_path = build_hls_on_demand_segment_path(
            &self.config.hls_cache_dir,
            source_input,
            safe_audio_stream_index,
            safe_segment_index,
        );
        if let Ok(metadata) = fs::metadata(&on_demand_path).await
            && metadata.is_file()
            && metadata.len() > 0
        {
            self.hls_metrics
                .segment_cache_hits
                .fetch_add(1, Ordering::Relaxed);
            return Ok(on_demand_path);
        }
        self.hls_metrics
            .segment_cache_misses
            .fetch_add(1, Ordering::Relaxed);
        match self
            .ensure_hls_transcode_job(source_input, safe_audio_stream_index)
            .await
        {
            Ok(job) => {
                self.wait_for_hls_segment_from_job(job, safe_segment_index)
                    .await
            }
            Err(_) if self.hls_job_permits.available_permits() == 0 => {
                self.render_hls_segment_on_demand(
                    source_input,
                    safe_segment_index,
                    safe_audio_stream_index,
                    Some(on_demand_path),
                )
                .await
            }
            Err(error) => Err(error),
        }
    }

    async fn ensure_hls_cache_directory(&self) -> AppResult<()> {
        fs::create_dir_all(&self.config.hls_cache_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    async fn remove_incomplete_hls_outputs(&self, output_prefix: &str) -> AppResult<()> {
        let mut entries = match fs::read_dir(&self.config.hls_cache_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(ApiError::internal(error.to_string())),
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
        {
            let path = entry.path();
            if path.to_string_lossy().starts_with(output_prefix) {
                let _ = fs::remove_file(path).await;
            }
        }
        Ok(())
    }

    async fn prune_idle_hls_jobs(&self) {
        let now = now_ms();
        let keys = self
            .hls_jobs
            .iter()
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for key in keys {
            let Some(job) = self.hls_jobs.get(&key).map(|entry| entry.clone()) else {
                continue;
            };
            self.refresh_hls_job_state(&job).await;
            let inactive_for_ms = now - job.last_accessed_at.load(Ordering::Relaxed);
            let finished_at = job.finished_at.load(Ordering::Relaxed);
            let finished_for_ms = if finished_at > 0 {
                now - finished_at
            } else {
                0
            };
            if inactive_for_ms > HLS_TRANSCODE_IDLE_MS
                || (job.exited.load(Ordering::Relaxed) && finished_for_ms > HLS_SEGMENT_STALE_MS)
            {
                if let Some(mut child) = job.child.lock().await.take() {
                    let _ = child.kill().await;
                    job.exited.store(true, Ordering::Relaxed);
                    job.completed.store(false, Ordering::Relaxed);
                    job.exit_code.store(1, Ordering::Relaxed);
                    job.finished_at.store(now_ms(), Ordering::Relaxed);
                    self.release_hls_job_permit(&job, false).await;
                }
                self.hls_jobs.remove(&key);
            }
        }
    }

    async fn prune_hls_cache_files(&self) -> AppResult<()> {
        let mut entries = match fs::read_dir(&self.config.hls_cache_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(ApiError::internal(error.to_string())),
        };
        let now = now_ms();
        let mut candidates = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
        {
            let metadata = match entry.metadata().await {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => continue,
            };
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or_default();
            let path = entry.path();
            if now - modified_at > HLS_SEGMENT_STALE_MS {
                let _ = fs::remove_file(&path).await;
                continue;
            }
            candidates.push((path, modified_at));
        }

        if candidates.len() > HLS_SEGMENT_MAX_FILES {
            candidates.sort_by_key(|(_, modified_at)| *modified_at);
            let overflow = candidates.len() - HLS_SEGMENT_MAX_FILES;
            for (path, _) in candidates.into_iter().take(overflow) {
                let _ = fs::remove_file(path).await;
            }
        }
        Ok(())
    }
}

fn normalize_remux_video_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "auto" | "default" => "auto".to_owned(),
        "copy" | "passthrough" | "direct" | "streamcopy" => "copy".to_owned(),
        "normalize" | "transcode" | "aggressive" | "rebuild" => "normalize".to_owned(),
        _ => "auto".to_owned(),
    }
}

fn is_browser_safe_audio_codec(codec: &str) -> bool {
    let normalized_codec = codec.trim().to_lowercase();
    if normalized_codec.is_empty() {
        return false;
    }
    if BROWSER_SAFE_AUDIO_CODECS.contains(&normalized_codec.as_str()) {
        return true;
    }
    !BROWSER_UNSAFE_AUDIO_CODEC_PREFIXES
        .iter()
        .any(|prefix| normalized_codec.starts_with(prefix))
}

fn should_force_remux_for_audio_compatibility(
    probe: &MediaProbe,
    preferred_audio_stream_index: i64,
) -> bool {
    if probe.audioTracks.is_empty() {
        return false;
    }
    if preferred_audio_stream_index >= 0 {
        let requested_track = probe
            .audioTracks
            .iter()
            .find(|track| track.streamIndex == preferred_audio_stream_index);
        return requested_track
            .map(|track| !is_browser_safe_audio_codec(&track.codec))
            .unwrap_or(true);
    }
    probe
        .audioTracks
        .iter()
        .find(|track| track.isDefault)
        .or_else(|| probe.audioTracks.first())
        .map(|track| !is_browser_safe_audio_codec(&track.codec))
        .unwrap_or(false)
}

fn get_fallback_audio_stream_index(probe: &MediaProbe) -> i64 {
    probe
        .audioTracks
        .iter()
        .find(|track| track.isDefault)
        .or_else(|| probe.audioTracks.first())
        .map(|track| track.streamIndex)
        .unwrap_or(-1)
}

fn should_force_normalize_video_for_browser(probe: &MediaProbe, _source: &str) -> bool {
    // MP4/MOV containers use edit lists (elst atoms) to trim B-frame lead-in
    // and keep audio/video in sync.  Fragmented MP4 output (used by the remux
    // endpoint) cannot carry edit lists, so the raw video PTS is exposed and
    // the first presentable frame starts later than audio.  The remux endpoint
    // always re-encodes audio to AAC, so force normalize mode whenever B-frames
    // are present and setpts=PTS-STARTPTS can eliminate the gap.
    probe.videoBFrames > 0
}

fn should_force_accurate_seek_for_remux(
    start_seconds: i64,
    requested_video_mode: &str,
    resolved_video_mode: &str,
) -> bool {
    start_seconds > 0 && requested_video_mode == "auto" && resolved_video_mode == "copy"
}

fn build_hls_video_encode_config(hwaccel_mode: &str) -> VideoEncodeConfig {
    match hwaccel_mode.trim().to_lowercase().as_str() {
        "videotoolbox" => VideoEncodeConfig {
            mode: "videotoolbox".to_owned(),
            pre_input_args: vec!["-hwaccel".to_owned(), "videotoolbox".to_owned()],
            video_encode_args: vec![
                "-c:v".to_owned(),
                "h264_videotoolbox".to_owned(),
                "-b:v".to_owned(),
                "4500k".to_owned(),
                "-maxrate".to_owned(),
                "5500k".to_owned(),
                "-bufsize".to_owned(),
                "9000k".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-profile:v".to_owned(),
                "high".to_owned(),
                "-level:v".to_owned(),
                "4.1".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
        "cuda" => VideoEncodeConfig {
            mode: "cuda".to_owned(),
            pre_input_args: vec![
                "-hwaccel".to_owned(),
                "cuda".to_owned(),
                "-hwaccel_output_format".to_owned(),
                "cuda".to_owned(),
            ],
            video_encode_args: vec![
                "-c:v".to_owned(),
                "h264_nvenc".to_owned(),
                "-preset".to_owned(),
                "p5".to_owned(),
                "-cq".to_owned(),
                "23".to_owned(),
                "-b:v".to_owned(),
                "0".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
        "qsv" => VideoEncodeConfig {
            mode: "qsv".to_owned(),
            pre_input_args: vec!["-hwaccel".to_owned(), "qsv".to_owned()],
            video_encode_args: vec![
                "-c:v".to_owned(),
                "h264_qsv".to_owned(),
                "-global_quality".to_owned(),
                "23".to_owned(),
                "-look_ahead".to_owned(),
                "0".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
        _ => VideoEncodeConfig {
            mode: "none".to_owned(),
            pre_input_args: Vec::new(),
            video_encode_args: vec![
                "-c:v".to_owned(),
                "libx264".to_owned(),
                "-preset".to_owned(),
                "veryfast".to_owned(),
                "-crf".to_owned(),
                "23".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-profile:v".to_owned(),
                "high".to_owned(),
                "-level:v".to_owned(),
                "4.1".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
    }
}

fn build_remux_video_encode_config(hwaccel_mode: &str) -> VideoEncodeConfig {
    match hwaccel_mode.trim().to_lowercase().as_str() {
        "videotoolbox" => VideoEncodeConfig {
            mode: "videotoolbox".to_owned(),
            pre_input_args: vec!["-hwaccel".to_owned(), "videotoolbox".to_owned()],
            video_encode_args: vec![
                "-c:v".to_owned(),
                "h264_videotoolbox".to_owned(),
                "-b:v".to_owned(),
                "4500k".to_owned(),
                "-maxrate".to_owned(),
                "6500k".to_owned(),
                "-bufsize".to_owned(),
                "10000k".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
        "cuda" => VideoEncodeConfig {
            mode: "cuda".to_owned(),
            pre_input_args: vec!["-hwaccel".to_owned(), "cuda".to_owned()],
            video_encode_args: vec![
                "-c:v".to_owned(),
                "h264_nvenc".to_owned(),
                "-preset".to_owned(),
                "p5".to_owned(),
                "-cq".to_owned(),
                "23".to_owned(),
                "-b:v".to_owned(),
                "0".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
        "qsv" => VideoEncodeConfig {
            mode: "qsv".to_owned(),
            pre_input_args: vec!["-hwaccel".to_owned(), "qsv".to_owned()],
            video_encode_args: vec![
                "-c:v".to_owned(),
                "h264_qsv".to_owned(),
                "-global_quality".to_owned(),
                "23".to_owned(),
                "-look_ahead".to_owned(),
                "0".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
        _ => VideoEncodeConfig {
            mode: "none".to_owned(),
            pre_input_args: Vec::new(),
            video_encode_args: vec![
                "-c:v".to_owned(),
                "libx264".to_owned(),
                "-preset".to_owned(),
                "veryfast".to_owned(),
                "-crf".to_owned(),
                "21".to_owned(),
                "-pix_fmt".to_owned(),
                "yuv420p".to_owned(),
                "-profile:v".to_owned(),
                "high".to_owned(),
                "-level:v".to_owned(),
                "4.1".to_owned(),
                "-g".to_owned(),
                "48".to_owned(),
            ],
        },
    }
}

fn build_hls_transcode_job_key(source_input: &str, audio_stream_index: i64) -> String {
    format!("{source_input}|a:{audio_stream_index}")
}

fn build_hls_transcode_output_prefix(cache_dir: &Path, job_key: &str, encode_mode: &str) -> String {
    cache_dir
        .join(format!(
            "{}-{}",
            HLS_CACHE_SCHEMA_VERSION,
            hash_stable_string(&format!(
                "{}|segment:{}|encode:{}|{}",
                HLS_CACHE_SCHEMA_VERSION, HLS_SEGMENT_DURATION_SECONDS, encode_mode, job_key
            ))
        ))
        .to_string_lossy()
        .to_string()
}

fn build_hls_completion_marker_path(output_prefix: &str) -> PathBuf {
    PathBuf::from(format!("{output_prefix}.complete"))
}

fn build_hls_transcode_segment_path_from_prefix(
    output_prefix: &str,
    segment_index: i64,
) -> PathBuf {
    PathBuf::from(format!("{output_prefix}-{:06}.ts", segment_index.max(0)))
}

fn build_hls_on_demand_segment_path(
    cache_dir: &Path,
    source_input: &str,
    audio_stream_index: i64,
    segment_index: i64,
) -> PathBuf {
    cache_dir.join(format!(
        "{}.ts",
        hash_stable_string(&format!(
            "{}|ondemand|a:{}|i:{}|{}",
            HLS_CACHE_SCHEMA_VERSION,
            audio_stream_index,
            segment_index.max(0),
            source_input
        ))
    ))
}

fn build_hls_transcode_args(
    source_input: &str,
    audio_stream_index: i64,
    encode_config: &VideoEncodeConfig,
    output_prefix: &str,
) -> Vec<String> {
    let safe_audio_stream_index = if audio_stream_index >= 0 {
        audio_stream_index
    } else {
        -1
    };
    let mut args = vec![
        "ffmpeg".to_owned(),
        "-v".to_owned(),
        "error".to_owned(),
        "-y".to_owned(),
    ];
    args.extend(encode_config.pre_input_args.clone());
    args.extend([
        "-i".to_owned(),
        source_input.to_owned(),
        "-map".to_owned(),
        "0:v:0".to_owned(),
        "-map".to_owned(),
        if safe_audio_stream_index >= 0 {
            format!("0:{safe_audio_stream_index}?")
        } else {
            "0:a:0?".to_owned()
        },
        "-sn".to_owned(),
    ]);
    args.extend(encode_config.video_encode_args.clone());
    args.extend([
        "-c:a".to_owned(),
        "aac".to_owned(),
        "-ac".to_owned(),
        "2".to_owned(),
        "-b:a".to_owned(),
        "160k".to_owned(),
        "-f".to_owned(),
        "segment".to_owned(),
        "-segment_time".to_owned(),
        HLS_SEGMENT_DURATION_SECONDS.to_string(),
        "-segment_format".to_owned(),
        "mpegts".to_owned(),
        "-segment_list_type".to_owned(),
        "m3u8".to_owned(),
        "-segment_list_size".to_owned(),
        "0".to_owned(),
        "-segment_list".to_owned(),
        format!("{output_prefix}.m3u8"),
        "-reset_timestamps".to_owned(),
        "1".to_owned(),
        format!("{output_prefix}-%06d.ts"),
    ]);
    args
}

fn key_lock(map: &DashMap<String, Arc<Mutex<()>>>, key: &str) -> Arc<Mutex<()>> {
    map.entry(key.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

impl RemuxStreamGuard {
    fn new(
        metrics: Arc<RemuxMetrics>,
        active_jobs: Arc<DashMap<u64, i64>>,
        job_id: u64,
        permit: OwnedSemaphorePermit,
    ) -> Self {
        metrics.started.fetch_add(1, Ordering::Relaxed);
        metrics.active.fetch_add(1, Ordering::Relaxed);
        active_jobs.insert(job_id, now_ms());
        Self {
            metrics,
            active_jobs,
            job_id,
            _permit: permit,
            finished: false,
        }
    }

    fn mark_completed(&mut self) {
        if !self.finished {
            self.metrics.completed.fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }

    fn mark_failed(&mut self) {
        if !self.finished {
            self.metrics.failed.fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }

    fn mark_timed_out(&mut self) {
        if !self.finished {
            self.metrics.timed_out.fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }

    fn mark_spawn_error(&mut self) {
        if !self.finished {
            self.metrics.spawn_errors.fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }

    fn mark_read_error(&mut self) {
        if !self.finished {
            self.metrics.read_errors.fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }
}

impl Drop for RemuxStreamGuard {
    fn drop(&mut self) {
        self.active_jobs.remove(&self.job_id);
        self.metrics.active.fetch_sub(1, Ordering::Relaxed);
        if !self.finished {
            self.metrics.canceled.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl HlsSegmentRenderGuard {
    fn new(metrics: Arc<HlsMetrics>, permit: OwnedSemaphorePermit) -> Self {
        metrics
            .segment_render_started
            .fetch_add(1, Ordering::Relaxed);
        metrics
            .active_segment_renders
            .fetch_add(1, Ordering::Relaxed);
        Self {
            metrics,
            _permit: permit,
            finished: false,
        }
    }

    fn mark_completed(&mut self) {
        if !self.finished {
            self.metrics
                .segment_render_completed
                .fetch_add(1, Ordering::Relaxed);
            self.finished = true;
        }
    }
}

impl Drop for HlsSegmentRenderGuard {
    fn drop(&mut self) {
        self.metrics
            .active_segment_renders
            .fetch_sub(1, Ordering::Relaxed);
        if !self.finished {
            self.metrics
                .segment_render_failed
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn spawn_bounded_ffmpeg_stderr_logger(
    label: &'static str,
    stderr: ChildStderr,
    remux_metrics: Option<Arc<RemuxMetrics>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut captured = String::new();
        let mut captured_lines = 0_usize;
        let mut dropped_lines = 0_usize;
        let mut truncated = false;

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if captured.len() + line.len() < FFMPEG_STDERR_MAX_BYTES
                        && captured_lines < FFMPEG_STDERR_MAX_LINES
                    {
                        captured.push_str(&line);
                        captured.push('\n');
                        captured_lines += 1;
                    } else {
                        dropped_lines += 1;
                        truncated = true;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    eprintln!("[{label}] failed to read ffmpeg stderr: {error}");
                    break;
                }
            }
        }

        if truncated && let Some(metrics) = remux_metrics.as_ref() {
            metrics.stderr_truncated.fetch_add(1, Ordering::Relaxed);
        }

        let trimmed = captured.trim();
        if !trimmed.is_empty() {
            if truncated {
                eprintln!(
                    "[{label}] ffmpeg stderr (truncated, dropped {dropped_lines} lines): {trimmed}"
                );
            } else {
                eprintln!("[{label}] ffmpeg stderr: {trimmed}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use dashmap::DashMap;

    use crate::media::{AudioTrack, MediaProbe};

    use super::{
        build_hls_transcode_job_key, key_lock, normalize_remux_video_mode,
        should_force_accurate_seek_for_remux, should_force_normalize_video_for_browser,
    };

    #[test]
    fn normalizes_remux_video_modes() {
        assert_eq!(normalize_remux_video_mode("passthrough"), "copy");
        assert_eq!(normalize_remux_video_mode("rebuild"), "normalize");
        assert_eq!(normalize_remux_video_mode(""), "auto");
    }

    #[test]
    fn normalizes_remux_when_b_frames_are_present_with_safe_audio() {
        let probe = MediaProbe {
            videoBFrames: 2,
            audioTracks: vec![AudioTrack {
                codec: "aac".to_owned(),
                ..AudioTrack::default()
            }],
            ..MediaProbe::default()
        };

        assert!(should_force_normalize_video_for_browser(
            &probe,
            "movie.mp4"
        ));
    }

    #[test]
    fn normalizes_auto_remux_seeks_for_accurate_av_cuts() {
        assert!(should_force_accurate_seek_for_remux(2579, "auto", "copy"));
        assert!(!should_force_accurate_seek_for_remux(0, "auto", "copy"));
        assert!(!should_force_accurate_seek_for_remux(2579, "copy", "copy"));
        assert!(!should_force_accurate_seek_for_remux(
            2579,
            "auto",
            "normalize"
        ));
    }

    #[test]
    fn builds_hls_job_keys() {
        assert_eq!(build_hls_transcode_job_key("movie.mp4", 2), "movie.mp4|a:2");
    }

    #[test]
    fn reuses_job_locks_per_hls_key() {
        let locks = DashMap::new();
        let first = key_lock(&locks, "movie.mp4|a:2");
        let second = key_lock(&locks, "movie.mp4|a:2");
        let other = key_lock(&locks, "movie.mp4|a:3");

        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));
    }
}
