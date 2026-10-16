import { type ReactNode } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Play } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors, radius } from "@/theme";

// A labelled vertical action (icon over a caption) used for the secondary actions
// under the Play button (My List, Download). `active` brightens the caption.
export function DetailAction({
  icon,
  label,
  onPress,
  active = false,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressableScale
      onPress={disabled ? undefined : onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      style={{ alignItems: "center", width: 72, opacity: disabled ? 0.4 : 1 }}
    >
      <View style={{ height: 28, alignItems: "center", justifyContent: "center" }}>{icon}</View>
      <Text
        style={{
          color: active ? colors.accent : colors.muted,
          fontSize: 11.5,
          fontWeight: "600",
          marginTop: 5,
        }}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

// The detail-screen action block: a full-width coral Play button, then a left-aligned
// row of secondary DetailActions passed as children.
export function ActionRow({
  onPlay,
  playLabel = "Play",
  children,
}: {
  onPlay: () => void;
  playLabel?: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <PressableScale
        onPress={onPlay}
        style={{
          minHeight: 50,
          backgroundColor: colors.accent,
          borderRadius: radius.control,
          borderCurve: "continuous",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 18,
          gap: 8,
        }}
      >
        <Play size={20} color={colors.onAccent} fill={colors.onAccent} />
        <Text style={{ color: colors.onAccent, fontWeight: "600", fontSize: 16 }}>{playLabel}</Text>
      </PressableScale>
      <View style={{ flexDirection: "row", marginTop: 16, minHeight: 48, gap: 4 }}>{children}</View>
    </View>
  );
}
