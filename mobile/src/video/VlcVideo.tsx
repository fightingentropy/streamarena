import { forwardRef, useImperativeHandle, useRef } from "react";
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
  style?: StyleProp<ViewStyle>;
  onLoad?: (durationSeconds: number) => void;
  onProgress?: (currentSeconds: number, durationSeconds: number) => void;
  onBuffer?: (isBuffering: boolean) => void;
  onEnd?: () => void;
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
  { uri, paused = false, style, onLoad, onProgress, onBuffer, onEnd, onError },
  ref,
) {
  const playerRef = useRef<VLCPlayer>(null);
  const durationRef = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      seek: (seconds: number) => {
        const dur = durationRef.current;
        const player = playerRef.current;
        if (dur > 0 && player) {
          player.seek(Math.max(0, Math.min(1, seconds / dur)));
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
      autoplay
      onLoad={(e) => {
        const dur = (Number(e?.duration) || 0) / 1000;
        if (dur > 0) durationRef.current = dur;
        onLoad?.(dur);
      }}
      onProgress={(e) => {
        const cur = (Number(e?.currentTime) || 0) / 1000;
        const dur = (Number(e?.duration) || 0) / 1000;
        if (dur > 0) durationRef.current = dur;
        onProgress?.(cur, dur);
      }}
      onPlaying={(e) => {
        const dur = (Number(e?.duration) || 0) / 1000;
        if (dur > 0) durationRef.current = dur;
        onBuffer?.(false);
      }}
      onBuffering={() => onBuffer?.(true)}
      onEnd={() => onEnd?.()}
      onError={() => onError?.("This source couldn't be played (VLC).")}
    />
  );
});
