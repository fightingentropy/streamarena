import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { Play } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

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
      style={{ alignItems: "center", width: 76, opacity: disabled ? 0.4 : 1 }}
    >
      <View style={{ height: 30, alignItems: "center", justifyContent: "center" }}>{icon}</View>
      <Text style={{ color: active ? colors.foreground : colors.muted, fontSize: 11, fontWeight: "600", marginTop: 5 }}>
        {label}
      </Text>
    </PressableScale>
  );
}

// The detail-screen action block: a full-width white Play button, then a left-aligned
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
        className="flex-row items-center justify-center rounded-md"
        style={{ backgroundColor: colors.white, paddingVertical: 12, gap: 8 }}
      >
        <Play size={20} color="#000" fill="#000" />
        <Text style={{ color: "#000", fontWeight: "800", fontSize: 16 }}>{playLabel}</Text>
      </PressableScale>
      <View style={{ flexDirection: "row", marginTop: 14, gap: 6 }}>{children}</View>
    </View>
  );
}
