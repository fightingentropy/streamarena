use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{Response, StatusCode};
use dashmap::DashMap;
use futures_util::stream;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::sleep;
use url::form_urlencoded::byte_serialize;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::utils::{hash_stable_string, now_ms};
use crate::media::{MediaProbe, MediaService};
use crate::process::{
    RuntimeServices, normalize_audio_sync_ms, resolve_effective_remux_hwaccel_mode,
    run_process_capture_bytes,
};

const HLS_SEGMENT_DURATION_SECONDS: i64 = 6;
const HLS_SEGMENT_STALE_MS: i64 = 6 * 60 * 60 * 1000;
const HLS_SEGMENT_MAX_FILES: usize = 3000;
const HLS_TRANSCODE_IDLE_MS: i64 = 8 * 60 * 1000;
const HLS_SEGMENT_WAIT_TIMEOUT_MS: i64 = 30_000;
const HLS_SEGMENT_WAIT_POLL_MS: u64 = 180;

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
}

struct HlsJob {
    source_input: String,
    audio_stream_index: i64,
    encode_mode: String,
    allow_software_fallback: bool,
    output_prefix: String,
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
        Self {
            config,
            runtime,
            media,
            hls_jobs: Arc::new(DashMap::new()),
            hls_job_locks: Arc::new(DashMap::new()),
        }
    }

    pub async fn prune(&self) {
        self.prune_idle_hls_jobs().await;
        let _ = self.prune_hls_cache_files().await;
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
        if safe_start_seconds > 0 {
            ffmpeg_args.push("-ss".to_owned());
            ffmpeg_args.push(safe_start_seconds.to_string());
        }
        if resolved_video_mode == "normalize" {
            ffmpeg_args.extend(remux_video_encode_config.pre_input_args.clone());
        }
        ffmpeg_args.push("-i".to_owned());
        ffmpeg_args.push(source.clone());
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
        let mut child = command
            .spawn()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ApiError::internal("Failed to capture ffmpeg stdout."))?;

        // Capture stderr in a background task so ffmpeg errors are logged.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = tokio::io::BufReader::new(stderr);
                let mut output = String::new();
                let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut output).await;
                if !output.trim().is_empty() {
                    eprintln!("[remux] ffmpeg stderr: {output}");
                }
            });
        }

        let stream = stream::try_unfold(
            (stdout, child, vec![0_u8; 16 * 1024]),
            |(mut stdout, mut child, mut buffer)| async move {
                let read = stdout.read(&mut buffer).await?;
                if read == 0 {
                    let status = child.wait().await?;
                    if !status.success() {
                        eprintln!(
                            "[remux] ffmpeg exited with code {}",
                            status.code().unwrap_or(-1)
                        );
                    }
                    return Ok(None);
                }
                let bytes = Bytes::copy_from_slice(&buffer[..read]);
                Ok::<_, std::io::Error>(Some((bytes, (stdout, child, buffer))))
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
        let source_input = self.media.resolve_transcode_input(input)?;
        let segment_path = self
            .get_or_create_hls_segment(&source_input, segment_index.max(0), audio_stream_index)
            .await?;
        let bytes = fs::read(&segment_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "video/mp2t")
            .header(CACHE_CONTROL, "public, max-age=60")
            .body(Body::from(bytes))
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
        let output_prefix = build_hls_transcode_output_prefix(&self.config.hls_cache_dir, &job_key);
        let encode_config = build_hls_video_encode_config(encode_mode);
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
            tokio::spawn(async move {
                let mut reader = tokio::io::BufReader::new(stderr);
                let mut output = String::new();
                let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut output).await;
                if !output.trim().is_empty() {
                    eprintln!("[transcode] ffmpeg stderr: {output}");
                }
            });
        }
        let now = now_ms();
        let job = Arc::new(HlsJob {
            source_input: source_input.to_owned(),
            audio_stream_index,
            encode_mode: encode_config.mode.clone(),
            allow_software_fallback,
            output_prefix,
            child: Mutex::new(Some(child)),
            last_accessed_at: AtomicI64::new(now),
            finished_at: AtomicI64::new(0),
            exited: AtomicBool::new(false),
            completed: AtomicBool::new(false),
            exit_code: AtomicI32::new(-1),
        });
        self.hls_jobs.insert(job_key, job.clone());
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
                job.completed.store(status.success(), Ordering::Relaxed);
                job.exit_code.store(
                    status
                        .code()
                        .unwrap_or(if status.success() { 0 } else { 1 }),
                    Ordering::Relaxed,
                );
                job.finished_at.store(now_ms(), Ordering::Relaxed);
                *guard = None;
            }
            Ok(None) => {}
            Err(_) => {
                job.exited.store(true, Ordering::Relaxed);
                job.completed.store(false, Ordering::Relaxed);
                job.exit_code.store(1, Ordering::Relaxed);
                job.finished_at.store(now_ms(), Ordering::Relaxed);
                *guard = None;
            }
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
            self.config.hls_cache_dir.join(format!(
                "{}.ts",
                hash_stable_string(&format!(
                    "{}|a:{}|i:{}",
                    source_input, safe_audio_stream_index, safe_segment_index
                ))
            ))
        });
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
        Ok(segment_path)
    }

    async fn get_or_create_hls_segment(
        &self,
        source_input: &str,
        segment_index: i64,
        audio_stream_index: i64,
    ) -> AppResult<PathBuf> {
        let job = self
            .ensure_hls_transcode_job(source_input, audio_stream_index)
            .await?;
        self.wait_for_hls_segment_from_job(job, segment_index).await
    }

    async fn ensure_hls_cache_directory(&self) -> AppResult<()> {
        fs::create_dir_all(&self.config.hls_cache_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))
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
    // the first presentable frame starts later than audio.  When B-frames are
    // present and the audio will be re-encoded (meaning it goes through the
    // filter pipeline rather than stream-copy), force normalize mode so that
    // setpts=PTS-STARTPTS resets video PTS to 0 and eliminates the gap.
    if probe.videoBFrames > 0 {
        let has_unsafe_audio = probe
            .audioTracks
            .iter()
            .any(|track| !is_browser_safe_audio_codec(&track.codec));
        if has_unsafe_audio {
            return true;
        }
    }
    false
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

fn build_hls_transcode_output_prefix(cache_dir: &Path, job_key: &str) -> String {
    cache_dir
        .join(format!("{}-{}", hash_stable_string(job_key), now_ms()))
        .to_string_lossy()
        .to_string()
}

fn build_hls_transcode_segment_path_from_prefix(
    output_prefix: &str,
    segment_index: i64,
) -> PathBuf {
    PathBuf::from(format!("{output_prefix}-{:06}.ts", segment_index.max(0)))
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use dashmap::DashMap;

    use super::{build_hls_transcode_job_key, key_lock, normalize_remux_video_mode};

    #[test]
    fn normalizes_remux_video_modes() {
        assert_eq!(normalize_remux_video_mode("passthrough"), "copy");
        assert_eq!(normalize_remux_video_mode("rebuild"), "normalize");
        assert_eq!(normalize_remux_video_mode(""), "auto");
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
