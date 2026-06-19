import { View } from "react-native";
import { User } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// Top-right avatar. Tapping it opens the profile drawer. streamarena auth has no
// avatar image, so it always renders the user glyph on a dark disc.
export function ProfileButton({ size = 32 }: { size?: number }) {
  const openProfileMenu = useUiStore((s) => s.openProfileMenu);
  return (
    <PressableScale onPress={openProfileMenu} hitSlop={8} accessibilityLabel="Open profile menu">
      <View
        className="items-center justify-center overflow-hidden rounded-full"
        style={{ width: size, height: size, backgroundColor: "#2a2a2a" }}
      >
        <User size={size * 0.56} color={colors.iconIdle} />
      </View>
    </PressableScale>
  );
}
