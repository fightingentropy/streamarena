import { useEffect, useState } from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { formatTime } from "@/lib/format";
import { colors } from "@/theme";

const TRACK_H = 4;
const THUMB = 14;
const ROW_H = 28;

type Props = {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  // Called while dragging so the controls can stay visible during the gesture.
  onScrubbing?: (active: boolean) => void;
  live?: boolean;
};

// Netflix-style scrubber ported from the Spotify app: a thin track with a small flat
// thumb, elapsed left / remaining right. Controlled (position/duration come from the
// video store); while dragging we hold a local value so the thumb doesn't snap back to
// the live position. For live streams there is no scrubber — a red LIVE badge shows.
export function Scrubber({ position, duration, onSeek, onScrubbing, live = false }: Props) {
  const [width, setWidth] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  // Never carry hold state across a source change (duration flips to 0/new); the
  // thumb must follow the live position, not a stale seekValue.
  useEffect(() => {
    setSeeking(false);
  }, [duration]);

  if (live) {
    return (
      <View className="flex-row items-center gap-2 py-2">
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} />
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700", letterSpacing: 1 }}>LIVE</Text>
      </View>
    );
  }

  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const value = seeking ? seekValue : position;
  const pct = max > 0 && width > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const fillW = pct * width;
  const thumbLeft = Math.min(Math.max(0, fillW - THUMB / 2), Math.max(0, width - THUMB));

  const posFromX = (x: number) => (max <= 0 || width <= 0 ? 0 : Math.min(1, Math.max(0, x / width)) * max);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onStart((e) => {
      setSeeking(true);
      setSeekValue(posFromX(e.x));
      onScrubbing?.(true);
    })
    .onUpdate((e) => setSeekValue(posFromX(e.x)))
    .onEnd((e) => {
      setSeeking(false);
      onScrubbing?.(false);
      onSeek(posFromX(e.x));
    })
    .onFinalize(() => {
      setSeeking(false);
      onScrubbing?.(false);
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => onSeek(posFromX(e.x)));
  const gesture = Gesture.Race(tap, pan);

  return (
    <View className="w-full">
      <GestureDetector gesture={gesture}>
        <View
          style={{ height: ROW_H, justifyContent: "center" }}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        >
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: (ROW_H - TRACK_H) / 2,
              height: TRACK_H,
              borderRadius: TRACK_H / 2,
              backgroundColor: "rgba(255,255,255,0.28)",
            }}
          />
          <View
            style={{
              position: "absolute",
              left: 0,
              top: (ROW_H - TRACK_H) / 2,
              height: TRACK_H,
              width: fillW,
              borderRadius: TRACK_H / 2,
              backgroundColor: colors.accent,
            }}
          />
          <View
            style={{
              position: "absolute",
              top: (ROW_H - THUMB) / 2,
              left: thumbLeft,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: "#fff",
            }}
          />
        </View>
      </GestureDetector>
      <View className="flex-row justify-between" style={{ marginTop: 4 }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{formatTime(value)}</Text>
        <Text style={{ color: colors.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {max > 0 ? `-${formatTime(Math.max(0, max - value))}` : formatTime(max)}
        </Text>
      </View>
    </View>
  );
}
