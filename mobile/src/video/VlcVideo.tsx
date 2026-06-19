import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { VLCPlayer } from "react-native-vlc-media-player";

// Imperative handle mirroring the slice of react-native-video's VideoRef the watch screen
// uses (`seek(seconds)`), so the same `videoRef.current?.seek(s)` path drives either engine.
export interface VlcVideoRef {
  seek: (seconds: number) => void;
}

interface VlcVideoProps {
  uri: string;
  paused?: boolean;
  // 0..1, forwarded to the (patched) native `volume` prop so the right-edge volume gesture
  // actually changes embed-VOD audio. Without this it was a no-op (HUD moved, audio didn't).
  volume?: number;
  style?: StyleProp<ViewStyle>;
  onLoad?: (durationSeconds: number) => void;
  onProgress?: (currentSeconds: number, durationSeconds: number) => void;
  onBuffer?: (isBuffering: boolean) => void;
  // `fraction` is VLC's 0..1 position at the finish — duration-independent, so the store can
  // tell a genuine finish from a dead embed that ends at ~0 even when media length stayed 0.
  onEnd?: (info?: { fraction?: number }) => void;
  onError?: (message: string) => void;
}

// libVLC engine options. A generous network cache absorbs the extra latency of our
// pipeline — each TS segment is pulled from the CDN, PNG-stripped, and re-served from
// loopback — so playback doesn't underrun while a segment is being fetched + stripped.
const INIT_OPTIONS = ["--network-caching=3000", "--no-audio-time-stretch"];

// libVLC reports time in milliseconds and seeks by a 0..1 fraction of total duration;
// react-native-video uses seconds. This wrapper translates both directions so the player
// state machine stays seconds-based and engine-agnostic.
export const VlcVideo = forwardRef<VlcVideoRef, VlcVideoProps>(function VlcVideo(
  { uri, paused = false, volume = 1, style, onLoad, onProgress, onBuffer, onEnd, onError },
  ref,
) {
  const playerRef = useRef<VLCPlayer>(null);
  const durationRef = useRef(0);
  // A seek requested before VLC knows the duration (media length is 0 until enough of the
  // playlist is parsed) is stashed here and replayed on the first event where duration is
  // known — otherwise a resume seek (or an early manual scrub) is silently dropped.
  const pendingSeekRef = useRef<number | null>(null);
  // Highest 0..1 position seen during playback; the finish signal so a real end is detected
  // even when media length never resolves (stays 0).
  const maxFractionRef = useRef(0);

  // A new source (fallback walk / next episode) reuses this same instance — reset the
  // duration/seek/fraction bookkeeping so stale values can't leak across streams.
  useEffect(() => {
    durationRef.current = 0;
    pendingSeekRef.current = null;
    maxFractionRef.current = 0;
  }, [uri]);

  // Replay a stashed seek once duration is known.
  const drainPendingSeek = () => {
    const dur = durationRef.current;
    const target = pendingSeekRef.current;
    if (dur > 0 && target != null && playerRef.current) {
      pendingSeekRef.current = null;
      playerRef.current.seek(Math.max(0, Math.min(1, target / dur)));
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      seek: (seconds: number) => {
        const dur = durationRef.current;
        const player = playerRef.current;
        if (dur > 0 && player) {
          player.seek(Math.max(0, Math.min(1, seconds / dur)));
        } else {
          pendingSeekRef.current = seconds;
        }
      },
    }),
    [],
  );

  return (
    <VLCPlayer
      ref={playerRef}
      style={style ?? StyleSheet.absoluteFill}
      source={{ uri, initOptions: INIT_OPTIONS }}
      paused={paused}
      volume={Math.max(0, Math.min(1, volume))}
      autoplay
      onLoad={(e) => {
        const dur = (Number(e?.duration) || 0) / 1000;
        if (dur > 0) durationRef.current = dur;
        drainPendingSeek();
        onLoad?.(dur);
      }}
      onProgress={(e) => {
        const cur = (Number(e?.currentTime) || 0) / 1000;
        const dur = (Number(e?.duration) || 0) / 1000;
        if (dur > 0) durationRef.current = dur;
        const frac = Number(e?.position);
        if (Number.isFinite(frac) && frac > maxFractionRef.current) maxFractionRef.current = frac;
        drainPendingSeek();
        onProgress?.(cur, dur);
      }}
      onPlaying={(e) => {
        const dur = (Number(e?.duration) || 0) / 1000;
        if (dur > 0) durationRef.current = dur;
        drainPendingSeek();
        onBuffer?.(false);
      }}
      onBuffering={() => onBuffer?.(true)}
      onEnd={(e) => {
        const frac = Math.max(maxFractionRef.current, Number(e?.position) || 0);
        onEnd?.({ fraction: Number.isFinite(frac) ? frac : undefined });
      }}
      onError={() => onError?.("This source couldn't be played (VLC).")}
    />
  );
});
