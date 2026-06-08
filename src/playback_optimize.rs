use std::path::{Path, PathBuf};

use tokio::fs;
use tracing::warn;

use crate::error::{ApiError, AppResult};
use crate::media::{MediaProbe, probe_local_media_file};
use crate::process::run_process_capture_text;

const PLAYBACK_OPTIMIZE_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;

const CHROME_SUPPORTED_VIDEO_CODECS: &[&str] = &[
    "h264", "avc1", "hevc", "h265", "hev1", "hvc1", "vp8", "vp9", "av1", "mpeg4", "theora",
];
const CHROME_SUPPORTED_AUDIO_CODECS: &[&str] = &[
    "aac",
    "mp3",
    "opus",
    "vorbis",
    "flac",
    "pcm_s16le",
    "pcm_s24le",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackOptimizeMode {
    FaststartRemux,
    RemuxToMp4,
    AudioToAac,
}

#[derive(Debug, Clone)]
pub struct OptimizedPlaybackFile {
    pub path: PathBuf,
    pub filename: String,
    pub file_length: u64,
}

pub async fn optimize_playback_cache_file(
    input_path: &Path,
    output_folder: &Path,
    filename_hint: &str,
) -> AppResult<OptimizedPlaybackFile> {
    if !input_path.is_file() {
        return Err(ApiError::bad_gateway("Downloaded cache file is missing."));
    }

    let probe = probe_local_media_file(input_path).await?;
    let mode = choose_playback_optimize_mode(&probe, input_path);
    let output_filename = optimized_playback_filename(filename_hint, input_path);
    let output_path = output_folder.join(&output_filename);
    let temp_path = output_folder.join(format!(".{output_filename}.optimize.part"));

    let _ = fs::remove_file(&temp_path).await;
    run_playback_optimize(mode, input_path, &temp_path).await?;
    fs::rename(&temp_path, &output_path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let metadata = fs::metadata(&output_path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        let _ = fs::remove_file(&output_path).await;
        return Err(ApiError::bad_gateway(
            "Playback optimization produced an empty file.",
        ));
    }

    // Only remove the original once we have a validated, non-empty output, so a
    // failed optimization leaves the best-effort fallback a real file to return.
    if input_path != output_path.as_path() {
        let _ = fs::remove_file(input_path).await;
    }

    Ok(OptimizedPlaybackFile {
        path: output_path,
        filename: output_filename,
        file_length: metadata.len(),
    })
}

fn choose_playback_optimize_mode(probe: &MediaProbe, input_path: &Path) -> PlaybackOptimizeMode {
    let container = probe.formatName.trim().to_lowercase();
    let extension = input_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let is_mp4_container = container.contains("mp4") || extension == "mp4" || extension == "m4v";
    let video_codec = normalize_codec_name(&probe.videoCodec);
    let audio_codecs = probe
        .audioTracks
        .iter()
        .map(|track| normalize_codec_name(&track.codec))
        .filter(|codec| !codec.is_empty())
        .collect::<Vec<_>>();

    let video_supported =
        !video_codec.is_empty() && CHROME_SUPPORTED_VIDEO_CODECS.contains(&video_codec.as_str());
    let audio_supported = audio_codecs.is_empty()
        || audio_codecs
            .iter()
            .all(|codec| CHROME_SUPPORTED_AUDIO_CODECS.contains(&codec.as_str()));

    if !is_mp4_container {
        return if video_supported && !audio_supported {
            PlaybackOptimizeMode::AudioToAac
        } else {
            PlaybackOptimizeMode::RemuxToMp4
        };
    }

    if video_supported && audio_supported {
        PlaybackOptimizeMode::FaststartRemux
    } else if video_supported {
        PlaybackOptimizeMode::AudioToAac
    } else {
        PlaybackOptimizeMode::RemuxToMp4
    }
}

async fn run_playback_optimize(
    mode: PlaybackOptimizeMode,
    input_path: &Path,
    output_path: &Path,
) -> AppResult<()> {
    let input = input_path.to_string_lossy().to_string();
    let output = output_path.to_string_lossy().to_string();
    let mut command = vec![
        "ffmpeg".to_owned(),
        "-hide_banner".to_owned(),
        "-loglevel".to_owned(),
        "error".to_owned(),
        "-y".to_owned(),
        "-i".to_owned(),
        input,
        "-map".to_owned(),
        "0:v:0".to_owned(),
        "-map".to_owned(),
        "0:a:0?".to_owned(),
        "-sn".to_owned(),
        "-dn".to_owned(),
    ];

    match mode {
        PlaybackOptimizeMode::FaststartRemux | PlaybackOptimizeMode::RemuxToMp4 => {
            command.push("-c".to_owned());
            command.push("copy".to_owned());
        }
        PlaybackOptimizeMode::AudioToAac => {
            command.extend([
                "-c:v".to_owned(),
                "copy".to_owned(),
                "-c:a".to_owned(),
                "aac".to_owned(),
                "-b:a".to_owned(),
                "256k".to_owned(),
            ]);
        }
    }

    command.extend(["-movflags".to_owned(), "+faststart".to_owned(), output]);

    run_process_capture_text(&command, PLAYBACK_OPTIMIZE_TIMEOUT_MS)
        .await
        .map(|_| ())
        .map_err(|error| ApiError::bad_gateway(format!("Playback optimization failed: {error}")))
}

fn optimized_playback_filename(filename_hint: &str, input_path: &Path) -> String {
    let preferred = filename_hint.trim();
    if !preferred.is_empty() {
        let path = Path::new(preferred);
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str())
            && !stem.trim().is_empty()
        {
            return format!("{}.mp4", stem.trim());
        }
    }
    if let Some(stem) = input_path.file_stem().and_then(|value| value.to_str())
        && !stem.trim().is_empty()
    {
        return format!("{}.mp4", stem.trim());
    }
    "video.mp4".to_owned()
}

fn normalize_codec_name(value: &str) -> String {
    value.trim().to_lowercase()
}

pub async fn optimize_playback_cache_file_best_effort(
    input_path: &Path,
    output_folder: &Path,
    filename_hint: &str,
) -> OptimizedPlaybackFile {
    match optimize_playback_cache_file(input_path, output_folder, filename_hint).await {
        Ok(optimized) => optimized,
        Err(error) => {
            warn!(
                path = %input_path.display(),
                error = ?error,
                "Playback cache optimization failed; keeping original download"
            );
            let filename = if filename_hint.trim().is_empty() {
                input_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("video.bin")
                    .to_owned()
            } else {
                filename_hint.trim().to_owned()
            };
            let file_length = fs::metadata(input_path)
                .await
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            OptimizedPlaybackFile {
                path: input_path.to_owned(),
                filename,
                file_length,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{AudioTrack, MediaProbe};

    #[test]
    fn chooses_faststart_for_compatible_mp4() {
        let probe = MediaProbe {
            formatName: "mov,mp4,m4a,3gp,3g2,mj2".to_owned(),
            videoCodec: "hevc".to_owned(),
            audioTracks: vec![AudioTrack {
                codec: "aac".to_owned(),
                ..AudioTrack::default()
            }],
            ..MediaProbe::default()
        };
        assert_eq!(
            choose_playback_optimize_mode(&probe, Path::new("movie.mp4")),
            PlaybackOptimizeMode::FaststartRemux
        );
    }

    #[test]
    fn chooses_audio_transcode_for_eac3_mp4() {
        let probe = MediaProbe {
            formatName: "mov,mp4,m4a,3gp,3g2,mj2".to_owned(),
            videoCodec: "hevc".to_owned(),
            audioTracks: vec![AudioTrack {
                codec: "eac3".to_owned(),
                ..AudioTrack::default()
            }],
            ..MediaProbe::default()
        };
        assert_eq!(
            choose_playback_optimize_mode(&probe, Path::new("movie.mp4")),
            PlaybackOptimizeMode::AudioToAac
        );
    }

    #[test]
    fn chooses_remux_for_mkv() {
        let probe = MediaProbe {
            formatName: "matroska,webm".to_owned(),
            videoCodec: "hevc".to_owned(),
            audioTracks: vec![AudioTrack {
                codec: "aac".to_owned(),
                ..AudioTrack::default()
            }],
            ..MediaProbe::default()
        };
        assert_eq!(
            choose_playback_optimize_mode(&probe, Path::new("movie.mkv")),
            PlaybackOptimizeMode::RemuxToMp4
        );
    }

    #[test]
    fn builds_mp4_filename_from_mkv_hint() {
        assert_eq!(
            optimized_playback_filename("Interstellar.2014.mkv", Path::new("ignored.mkv")),
            "Interstellar.2014.mp4"
        );
    }
}
