import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Captions, Layers, Pause, Play, Radio, RotateCcw, RotateCw, SkipForward, X } from "lucide-react-native";
import { GlassSurface } from "@/components/ui/GlassSurface";
import { PressableScale } from "@/components/ui/PressableScale";
import { notificationError, selectionAsync } from "@/lib/haptics";
import { usePlayerStore } from "@/video/state";
import type { PlayerTextTrack } from "@/video/tracks";
import { colors, radius } from "@/theme";
import { LiveSourcesSheet } from "./LiveSourcesSheet";
import { PlayerSettingsSheet } from "./PlayerSettingsSheet";
import { Scrubber } from "./Scrubber";
import { SourcesSheet } from "./SourcesSheet";

const AUTO_HIDE_MS = 3500;
const SKIP_SECONDS = 10;

type Props = {
  title?: string;
  subtitle?: string;
  live?: boolean;
  textTracks?: PlayerTextTrack[];
  // When set (TV with a following episode), shows a Next-episode control.
  onNext?: () => void;
  onClose: () => void;
};

// Round translucent control button (close / skip).
function CircleButton({
  onPress,
  size = 40,
  bg = "rgba(8,8,9,0.64)",
  active = false,
  solid = false,
  accessibilityLabel,
  children,
}: {
  onPress: () => void;
  size?: number;
  bg?: string;
  active?: boolean;
  solid?: boolean;
  accessibilityLabel: string;
  children: React.ReactNode;
}) {
  const button = (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      hitSlop={10}
      style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
    >
      {children}
    </PressableScale>
  );

  if (solid) {
    return (
      <PressableScale
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        hitSlop={10}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </PressableScale>
    );
  }

  return (
    <GlassSurface
      fallbackColor={active ? "rgba(255,255,255,0.20)" : bg}
      tintColor={active ? "rgba(255,255,255,0.15)" : "rgba(8,8,9,0.42)"}
      glassStyle="clear"
      interactive
      blurIntensity={30}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        borderWidth: 0.5,
        borderColor: active ? "rgba(255,255,255,0.28)" : colors.hairline,
      }}
    >
      {button}
    </GlassSurface>
  );
}

// A 10-second skip control: a circular arrow with the seconds count inside it.
function SkipButton({ direction, onPress }: { direction: "back" | "forward"; onPress: () => void }) {
  const Icon = direction === "back" ? RotateCcw : RotateCw;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={direction === "back" ? "Skip back 10 seconds" : "Skip forward 10 seconds"}
      hitSlop={12}
      style={{ width: 56, height: 56, alignItems: "center", justifyContent: "center" }}
    >
      <Icon size={40} color={colors.foreground} strokeWidth={1.5} />
      <Text style={{ position: "absolute", color: colors.foreground, fontSize: 11, fontWeight: "800" }}>
        {SKIP_SECONDS}
      </Text>
    </PressableScale>
  );
}

// Sparse glass player chrome: functional video scrims top & bottom, auto-hiding after 3.5s of
// playback, with a tap-anywhere toggle. Reads/writes the video store directly so it
// can be dropped over the <Video> without prop threading. Shows a spinner while
// resolving/buffering and an error overlay (with retry) on failure.
export function VideoControls({ title, subtitle, live = false, textTracks = [], onNext, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  // In the landscape player the safe-area context still reports the portrait insets (it
  // doesn't re-measure for this rotated modal), which floats the chrome far from the
  // top/bottom edges. Use tight landscape-appropriate padding so the title bar and the
  // scrubber hug the edges; fall back to the real insets in portrait.
  const topPad = landscape ? 10 : insets.top + 6;
  const bottomPad = landscape ? 16 : insets.bottom + 12;
  // The rotated full-screen modal can retain portrait insets on iOS. Keep a
  // conservative side gutter so controls clear the Dynamic Island and rounded
  // display corners even when left/right report zero.
  const horizontalPad = landscape ? Math.max(insets.left, insets.right, 48) : 16;
  const status = usePlayerStore((s) => s.status);
  const paused = usePlayerStore((s) => s.paused);
  const buffering = usePlayerStore((s) => s.buffering);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const error = usePlayerStore((s) => s.error);
  // Whether "Try again" can actually do anything: live needs sources to walk, VOD needs a
  // request to re-open. In the no-staged-request live deep-link case both are empty, so
  // retry() is a no-op — hide the button and leave only the working Close.
  const canRetry = usePlayerStore((s) => (s.live ? s.liveSources.length > 0 : s.request != null));
  const subtitleOn = usePlayerStore((s) => s.selectedSubtitle != null);

  const liveSourceCount = usePlayerStore((s) => s.liveSources.length);
  const [visible, setVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [streamsOpen, setStreamsOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbing = useRef(false);

  const clearHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  // Only auto-hide while actively playing (not paused, buffering, mid-scrub, or with the
  // settings sheet open).
  const scheduleHide = useCallback(() => {
    clearHide();
    if (!paused && !buffering && status === "playing" && !scrubbing.current && !settingsOpen && !sourcesOpen && !streamsOpen) {
      hideTimer.current = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    }
  }, [clearHide, paused, buffering, status, settingsOpen, sourcesOpen, streamsOpen]);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // A short error cue when playback drops into the failed state.
  useEffect(() => {
    if (status === "error") notificationError();
  }, [status]);

  // Keep chrome up whenever playback isn't running or a sheet is open.
  useEffect(() => {
    if (paused || buffering || status !== "playing" || settingsOpen || sourcesOpen || streamsOpen) {
      clearHide();
      setVisible(true);
    } else {
      scheduleHide();
    }
    return clearHide;
  }, [paused, buffering, status, settingsOpen, sourcesOpen, streamsOpen, scheduleHide, clearHide]);

  const toggleChrome = () => {
    if (visible) {
      clearHide();
      setVisible(false);
    } else {
      reveal();
    }
  };

  const onSkip = (delta: number) => {
    selectionAsync();
    usePlayerStore.getState().seekBy(delta);
    reveal();
  };
  const onPlayPause = () => {
    selectionAsync();
    usePlayerStore.getState().togglePlay();
    reveal();
  };
  const onSeek = (seconds: number) => {
    usePlayerStore.getState().seekTo(seconds);
    reveal();
  };
  const onScrubbing = (active: boolean) => {
    scrubbing.current = active;
    if (active) {
      clearHide();
      setVisible(true);
    } else {
      scheduleHide();
    }
  };

  const showSpinner = status === "resolving" || status === "loading" || (buffering && status !== "error");

  // Error overlay sits above everything and ignores auto-hide.
  if (status === "error") {
    return (
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }]}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700", textAlign: "center" }}>Playback failed</Text>
        <Text style={{ color: colors.muted, fontSize: 13, textAlign: "center", marginTop: 8 }}>
          {error || "Couldn't start this title."}
        </Text>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 22 }}>
          {canRetry ? (
            <PressableScale
              onPress={() => usePlayerStore.getState().retry()}
              accessibilityLabel="Retry"
              style={{
                minHeight: 44,
                backgroundColor: colors.foreground,
                paddingHorizontal: 22,
                justifyContent: "center",
                borderRadius: radius.control,
                borderCurve: "continuous",
              }}
            >
              <Text style={{ color: colors.black, fontSize: 14, fontWeight: "700" }}>Try again</Text>
            </PressableScale>
          ) : null}
          <PressableScale
            onPress={onClose}
            accessibilityLabel="Close"
            style={{
              minHeight: 44,
              backgroundColor: colors.cardActive,
              borderWidth: 0.5,
              borderColor: colors.hairline,
              paddingHorizontal: 22,
              justifyContent: "center",
              borderRadius: radius.control,
              borderCurve: "continuous",
            }}
          >
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>Close</Text>
          </PressableScale>
        </View>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Tap-anywhere to toggle the chrome. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={toggleChrome} />

      {showSpinner ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
          <ActivityIndicator size="large" color={colors.foreground} />
          {status === "resolving" ? (
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 14 }}>Finding a source…</Text>
          ) : null}
        </View>
      ) : null}

      {visible ? (
        <>
          {/* Top scrim + title bar */}
          <LinearGradient
            colors={["rgba(0,0,0,0.75)", "transparent"]}
            style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: topPad, paddingHorizontal: horizontalPad, paddingBottom: 28 }}
            pointerEvents="box-none"
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }} pointerEvents="box-none">
              <CircleButton onPress={onClose} accessibilityLabel="Close player">
                <X size={21} color={colors.foreground} />
              </CircleButton>
              <View style={{ flex: 1 }}>
                {title ? (
                  <Text
                    numberOfLines={1}
                    style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 }}
                  >
                    {title}
                  </Text>
                ) : null}
                {subtitle ? (
                  <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {onNext ? (
                <CircleButton
                  onPress={() => {
                    selectionAsync();
                    onNext();
                  }}
                  accessibilityLabel="Next episode"
                >
                  <SkipForward size={19} color={colors.foreground} fill={colors.foreground} />
                </CircleButton>
              ) : null}
              {live ? (
                liveSourceCount > 1 ? (
                  <CircleButton
                    onPress={() => {
                      selectionAsync();
                      setStreamsOpen(true);
                    }}
                    accessibilityLabel="Switch stream source"
                  >
                    <Radio size={20} color={colors.foreground} />
                  </CircleButton>
                ) : null
              ) : (
                <>
                  <CircleButton
                    onPress={() => {
                      selectionAsync();
                      setSourcesOpen(true);
                    }}
                    accessibilityLabel="Switch source"
                  >
                    <Layers size={20} color={colors.foreground} />
                  </CircleButton>
                  <CircleButton
                    onPress={() => {
                      selectionAsync();
                      setSettingsOpen(true);
                    }}
                    accessibilityLabel="Subtitles and playback settings"
                    active={subtitleOn}
                  >
                    <Captions size={20} color={colors.foreground} />
                  </CircleButton>
                </>
              )}
            </View>
          </LinearGradient>

          {/* Center transport */}
          {!showSpinner ? (
            <View
              style={[StyleSheet.absoluteFill, { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 44 }]}
              pointerEvents="box-none"
            >
              {!live ? <SkipButton direction="back" onPress={() => onSkip(-SKIP_SECONDS)} /> : null}
              <CircleButton
                onPress={onPlayPause}
                size={72}
                bg={colors.foreground}
                solid
                accessibilityLabel={paused ? "Play" : "Pause"}
              >
                {paused ? (
                  <Play size={34} color={colors.black} fill={colors.black} />
                ) : (
                  <Pause size={34} color={colors.black} fill={colors.black} />
                )}
              </CircleButton>
              {!live ? <SkipButton direction="forward" onPress={() => onSkip(SKIP_SECONDS)} /> : null}
            </View>
          ) : null}

          {/* Bottom scrim + scrubber */}
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.88)"]}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, paddingTop: 36, paddingHorizontal: horizontalPad, paddingBottom: bottomPad }}
            pointerEvents="box-none"
          >
            <Scrubber position={position} duration={duration} onSeek={onSeek} onScrubbing={onScrubbing} live={live} />
          </LinearGradient>
        </>
      ) : null}

      <PlayerSettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} textTracks={textTracks} />
      <SourcesSheet visible={sourcesOpen} onClose={() => setSourcesOpen(false)} />
      <LiveSourcesSheet visible={streamsOpen} onClose={() => setStreamsOpen(false)} />
    </View>
  );
}
