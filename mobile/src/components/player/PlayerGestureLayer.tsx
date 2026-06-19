import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Brightness from "expo-brightness";
import { Sun, Volume2, VolumeX } from "lucide-react-native";
import { usePlayerStore } from "@/video/state";

type Hud = { kind: "brightness" | "volume"; value: number };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Wraps the player content and adds Netflix-style vertical-pan gestures: drag the LEFT
// half to change screen brightness (expo-brightness), the RIGHT half to change player
// volume. The pan only claims dominant vertical drags (activeOffsetY) and yields to
// horizontal swipes (failOffsetX), so the scrubber, skip buttons, and tap-to-toggle
// chrome — all descendants — keep working untouched. Runs on the JS thread so the
// callbacks can call the async brightness API and the zustand store directly.
export function PlayerGestureLayer({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const [hud, setHud] = useState<Hud | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pan working state (set on begin, read on update).
  const zone = useRef<"brightness" | "volume">("brightness");
  const startValue = useRef(0);
  // Mirror of the OS brightness so we don't re-read it every gesture.
  const brightnessRef = useRef(1);

  useEffect(() => {
    let active = true;
    void Brightness.getBrightnessAsync()
      .then((b) => {
        if (active) brightnessRef.current = b;
      })
      .catch(() => {});
    return () => {
      active = false;
      if (hudTimer.current) clearTimeout(hudTimer.current);
      // Hand brightness back to the system when leaving the player.
      void Brightness.restoreSystemBrightnessAsync().catch(() => {});
    };
  }, []);

  const showHud = (next: Hud) => {
    if (hudTimer.current) clearTimeout(hudTimer.current);
    setHud(next);
  };
  const scheduleHudHide = () => {
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHud(null), 650);
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY([-12, 12])
    .failOffsetX([-22, 22])
    .onBegin((e) => {
      zone.current = e.x < width / 2 ? "brightness" : "volume";
      startValue.current = zone.current === "brightness" ? brightnessRef.current : usePlayerStore.getState().volume;
    })
    .onUpdate((e) => {
      // A full swing spans ~65% of the screen height; drag up to increase.
      const delta = -e.translationY / (height * 0.65);
      const value = clamp01(startValue.current + delta);
      if (zone.current === "brightness") {
        brightnessRef.current = value;
        void Brightness.setBrightnessAsync(value).catch(() => {});
        showHud({ kind: "brightness", value });
      } else {
        usePlayerStore.getState().setVolume(value);
        showHud({ kind: "volume", value });
      }
    })
    .onFinalize(scheduleHudHide);

  return (
    <GestureDetector gesture={pan}>
      <View style={{ flex: 1 }}>
        {children}
        {hud ? <GestureHud hud={hud} /> : null}
      </View>
    </GestureDetector>
  );
}

function GestureHud({ hud }: { hud: Hud }) {
  const pct = Math.round(hud.value * 100);
  const Icon = hud.kind === "brightness" ? Sun : hud.value <= 0.001 ? VolumeX : Volume2;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}
    >
      <View style={{ backgroundColor: "rgba(0,0,0,0.62)", borderRadius: 16, paddingVertical: 18, paddingHorizontal: 18, alignItems: "center", width: 92 }}>
        <Icon size={26} color="#fff" />
        <View style={{ height: 6, width: "100%", backgroundColor: "rgba(255,255,255,0.25)", borderRadius: 3, marginTop: 14, overflow: "hidden" }}>
          <View style={{ height: "100%", width: `${pct}%`, backgroundColor: "#fff" }} />
        </View>
        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700", marginTop: 8 }}>{pct}%</Text>
      </View>
    </View>
  );
}
