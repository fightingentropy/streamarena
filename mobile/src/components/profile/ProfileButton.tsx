import { View } from "react-native";
import { UserRound } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// Neutral account control. A bundled stock photo made every account look like the
// same person and injected colour into otherwise monochrome chrome.
export function ProfileButton({ size = 32 }: { size?: number }) {
  const openProfileMenu = useUiStore((s) => s.openProfileMenu);
  return (
    <PressableScale onPress={openProfileMenu} hitSlop={8} accessibilityLabel="Open profile menu">
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.card,
          borderWidth: 0.5,
          borderColor: colors.hairline,
        }}
      >
        <UserRound size={Math.round(size * 0.52)} color={colors.foreground} strokeWidth={2} />
      </View>
    </PressableScale>
  );
}
