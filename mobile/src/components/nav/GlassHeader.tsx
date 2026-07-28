import { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";
import { colors } from "@/theme";

const HEADER_HEIGHT = 52;

// Scroll-edge header for screens with artwork under the status bar. The chrome is
// a quiet solid functional layer rather than decorative blur; native Liquid Glass
// is reserved for small focused controls elsewhere.
export function GlassHeader({
  scrollY,
  title,
  left,
  right,
  fadeStart = 140,
  fadeEnd = 320,
  alwaysShowTitle = false,
}: {
  scrollY?: SharedValue<number>;
  title?: string;
  left?: ReactNode;
  right?: ReactNode;
  fadeStart?: number;
  fadeEnd?: number;
  alwaysShowTitle?: boolean;
}) {
  const insets = useSafeAreaInsets();

  const bgStyle = useAnimatedStyle(() => {
    if (!scrollY) return { opacity: 1 };
    return { opacity: interpolate(scrollY.value, [fadeStart, fadeEnd], [0, 1], Extrapolation.CLAMP) };
  });

  const titleStyle = useAnimatedStyle(() => {
    if (alwaysShowTitle || !scrollY) return { opacity: 1 };
    return { opacity: interpolate(scrollY.value, [fadeStart, fadeEnd], [0, 1], Extrapolation.CLAMP) };
  });

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 50, paddingTop: insets.top }}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: "rgba(0,0,0,0.96)" },
          bgStyle,
        ]}
      >
        <View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 0.5,
            backgroundColor: colors.hairline,
          }}
        />
      </Animated.View>

      <View
        style={{
          height: HEADER_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 }}>
          {left}
          {title ? (
            <Animated.View style={titleStyle}>
              <Text
                numberOfLines={1}
                style={{
                  color: colors.foreground,
                  fontSize: 17,
                  fontWeight: "700",
                  letterSpacing: -0.25,
                }}
              >
                {title}
              </Text>
            </Animated.View>
          ) : null}
        </View>
        {right}
      </View>
    </View>
  );
}
