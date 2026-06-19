import { type ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors } from "@/theme";

// Determinate circular progress ring — an arc that fills clockwise from 12 o'clock over a
// faint track. `children` render centered (e.g. a cancel ✕ or a check).
export function DownloadProgressRing({
  progress,
  size = 24,
  strokeWidth = 2.5,
  color = colors.accent,
  trackColor = "rgba(255,255,255,0.16)",
  children,
}: {
  progress: number; // 0..1
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  children?: ReactNode;
}) {
  const center = size / 2;
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Circle cx={center} cy={center} r={r} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <Circle
          cx={center}
          cy={center}
          r={r}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - p)}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </Svg>
      {children}
    </View>
  );
}

// Fill for a download whose total size the server never declares (the export streams a
// fragmented MP4 with no Content-Length, so the OS reports bytes-so-far but no total).
// Asymptotic in bytes: always climbs as data arrives, approaches but never reaches full
// until the download is actually marked ready — so the ring never sits at 100% early.
export function downloadRingFill(status: string, progress: number, bytes: number): number {
  if (status === "ready") return 1;
  if (progress > 0) return progress; // a real fraction, if a Content-Length ever shows up
  return Math.max(0.04, 1 - Math.exp(-bytes / 600_000_000));
}
