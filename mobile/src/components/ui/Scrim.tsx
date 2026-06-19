import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "@/theme";

// A vertical gradient overlay for backdrops/posters (transparent → background by
// default). Absolute-fill by default; pass `style` to size it (e.g. a bottom band).
export function Scrim({
  stops = [colors.scrimTop, colors.scrimMid, colors.scrimBottom],
  locations,
  style,
}: {
  stops?: readonly [string, string, ...string[]];
  locations?: readonly [number, number, ...number[]];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <LinearGradient
      colors={stops}
      locations={locations}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}
