use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use url::Url;

use crate::config::Config;
use crate::utils::now_ms;


const FFMPEG_CAPABILITY_REFRESH_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct EncoderFlags {
    pub h264_videotoolbox: bool,
    pub h264_nvenc: bool,
    pub h264_qsv: bool,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, Serialize)]
pub struct FfmpegSnapshot {
    pub checkedAt: i64,
    pub ffmpegAvailable: bool,
    pub ffprobeAvailable: bool,
    pub ffmpegVersion: String,
    pub ffprobeVersion: String,
    pub requestedHlsHwaccel: String,
    pub effectiveHlsHwaccel: String,
    pub hwaccels: Vec<String>,
    pub encoders: EncoderFlags,
    pub notes: Vec<String>,
}

#[derive(Clone)]
pub struct RuntimeServices {
    config: Config,
    ffmpeg_snapshot: Arc<Mutex<FfmpegSnapshot>>,
}

impl RuntimeServices {
    pub fn new(config: Config) -> Self {
        Self {
            ffmpeg_snapshot: Arc::new(Mutex::new(FfmpegSnapshot {
                checkedAt: 0,
                ffmpegAvailable: false,
                ffprobeAvailable: false,
                ffmpegVersion: String::new(),
                ffprobeVersion: String::new(),
                requestedHlsHwaccel: config.hls_hwaccel_mode.clone(),
                effectiveHlsHwaccel: "none".to_owned(),
                hwaccels: Vec::new(),
                encoders: EncoderFlags {
                    h264_videotoolbox: false,
                    h264_nvenc: false,
                    h264_qsv: false,
                },
                notes: Vec::new(),
            })),
            config,
        }
    }

    pub async fn get_ffmpeg_capabilities(&self, force_refresh: bool) -> FfmpegSnapshot {
        let snapshot = self.ffmpeg_snapshot.lock().await.clone();
        if !force_refresh
            && snapshot.checkedAt > 0
            && now_ms() - snapshot.checkedAt < FFMPEG_CAPABILITY_REFRESH_MS
        {
            return snapshot;
        }
        let next = probe_ffmpeg_capabilities(&self.config).await;
        *self.ffmpeg_snapshot.lock().await = next.clone();
        next
    }

}

pub fn normalize_audio_sync_ms(value: i64) -> i64 {
    value.clamp(-2_500, 2_500)
}

#[cfg(test)]
pub fn is_loopback_hostname(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "127.0.0.1" | "::1" | "[::1]" | "localhost"
    )
}

pub fn to_absolute_playback_url(value: &str, request_url: &Url) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    Url::parse(raw)
        .or_else(|_| request_url.join(raw))
        .map(|url| url.to_string())
        .unwrap_or_default()
}

pub fn resolve_effective_remux_hwaccel_mode(
    snapshot: &FfmpegSnapshot,
    requested_mode: &str,
) -> String {
    if can_use_hwaccel_mode(snapshot, requested_mode) {
        requested_mode.to_owned()
    } else {
        "none".to_owned()
    }
}

async fn probe_ffmpeg_capabilities(config: &Config) -> FfmpegSnapshot {
    let mut snapshot = FfmpegSnapshot {
        checkedAt: now_ms(),
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        ffmpegVersion: String::new(),
        ffprobeVersion: String::new(),
        requestedHlsHwaccel: config.hls_hwaccel_mode.clone(),
        effectiveHlsHwaccel: "none".to_owned(),
        hwaccels: Vec::new(),
        encoders: EncoderFlags {
            h264_videotoolbox: false,
            h264_nvenc: false,
            h264_qsv: false,
        },
        notes: Vec::new(),
    };

    match run_process_capture(["ffmpeg", "-hide_banner", "-version"], 5_000).await {
        Ok(output) => {
            snapshot.ffmpegAvailable = true;
            snapshot.ffmpegVersion = output
                .lines()
                .find(|line| line.to_lowercase().starts_with("ffmpeg version"))
                .unwrap_or_default()
                .trim()
                .to_owned();
        }
        Err(message) => snapshot
            .notes
            .push(format!("ffmpeg unavailable: {message}")),
    }

    match run_process_capture(["ffprobe", "-hide_banner", "-version"], 5_000).await {
        Ok(output) => {
            snapshot.ffprobeAvailable = true;
            snapshot.ffprobeVersion = output
                .lines()
                .find(|line| line.to_lowercase().starts_with("ffprobe version"))
                .unwrap_or_default()
                .trim()
                .to_owned();
        }
        Err(message) => snapshot
            .notes
            .push(format!("ffprobe unavailable: {message}")),
    }

    if snapshot.ffmpegAvailable {
        match run_process_capture(["ffmpeg", "-hide_banner", "-hwaccels"], 5_000).await {
            Ok(output) => {
                snapshot.hwaccels = output
                    .lines()
                    .map(|line| line.trim().to_lowercase())
                    .filter(|line| {
                        !line.is_empty()
                            && line != "hardware acceleration methods:"
                            && !line.starts_with("ffmpeg version")
                    })
                    .collect();
            }
            Err(_) => snapshot
                .notes
                .push("Unable to read ffmpeg hwaccels.".to_owned()),
        }
        match run_process_capture(["ffmpeg", "-hide_banner", "-encoders"], 8_000).await {
            Ok(output) => {
                let lowered = output.to_lowercase();
                snapshot.encoders.h264_videotoolbox = lowered.contains("h264_videotoolbox");
                snapshot.encoders.h264_nvenc = lowered.contains("h264_nvenc");
                snapshot.encoders.h264_qsv = lowered.contains("h264_qsv");
            }
            Err(_) => snapshot
                .notes
                .push("Unable to read ffmpeg encoders.".to_owned()),
        }
    }

    if can_use_hwaccel_mode(&snapshot, &config.hls_hwaccel_mode) {
        snapshot.effectiveHlsHwaccel = config.hls_hwaccel_mode.clone();
    } else if config.hls_hwaccel_mode != "none" {
        snapshot.notes.push(format!(
            "Requested HLS hwaccel ({}) is not supported; software fallback will be used.",
            config.hls_hwaccel_mode
        ));
    }

    snapshot
}

pub async fn run_process_capture_text(
    command: &[String],
    timeout_ms: u64,
) -> Result<String, String> {
    let output = run_process_capture_output(command, timeout_ms).await?;
    Ok(String::from_utf8_lossy(&output).to_string())
}

#[allow(dead_code)]
pub async fn run_process_capture_bytes(
    command: &[String],
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    run_process_capture_output(command, timeout_ms).await
}

async fn run_process_capture<const N: usize>(
    command: [&str; N],
    timeout_ms: u64,
) -> Result<String, String> {
    let owned = command
        .iter()
        .map(|item| (*item).to_owned())
        .collect::<Vec<_>>();
    let output = run_process_capture_output(&owned, timeout_ms).await?;
    Ok(String::from_utf8_lossy(&output).to_string())
}

async fn run_process_capture_output(
    command: &[String],
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mut iter = command.iter();
    let Some(program) = iter.next() else {
        return Err("Missing executable.".to_owned());
    };
    let mut child = Command::new(program);
    child
        .args(iter)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = timeout(Duration::from_millis(timeout_ms.max(1_000)), child.output())
        .await
        .map_err(|_| "Request timed out.".to_owned())?
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("Process exited with code {:?}", output.status.code())
        } else {
            stderr
        });
    }

    Ok(output.stdout)
}

fn can_use_hwaccel_mode(snapshot: &FfmpegSnapshot, mode: &str) -> bool {
    let safe_mode = mode.trim().to_lowercase();
    if safe_mode.is_empty() || safe_mode == "auto" {
        return false;
    }
    if safe_mode == "none" {
        return true;
    }
    if !snapshot.ffmpegAvailable {
        return false;
    }
    match safe_mode.as_str() {
        "videotoolbox" => {
            snapshot.encoders.h264_videotoolbox
                && snapshot.hwaccels.iter().any(|item| item == "videotoolbox")
        }
        "cuda" => {
            snapshot.encoders.h264_nvenc && snapshot.hwaccels.iter().any(|item| item == "cuda")
        }
        "qsv" => snapshot.encoders.h264_qsv && snapshot.hwaccels.iter().any(|item| item == "qsv"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_hostname, normalize_audio_sync_ms};

    #[test]
    fn clamps_audio_sync() {
        assert_eq!(normalize_audio_sync_ms(99_000), 2_500);
    }

    #[test]
    fn detects_loopback_hosts() {
        assert!(is_loopback_hostname("localhost"));
        assert!(!is_loopback_hostname("example.com"));
    }
}
