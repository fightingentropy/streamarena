import { Image, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useUiStore } from "@/store/ui";

// Top-right avatar. Tapping it opens the profile drawer. Shows the bundled user
// photo, clipped to a circle by the rounded container.
export function ProfileButton({ size = 32 }: { size?: number }) {
  const openProfileMenu = useUiStore((s) => s.openProfileMenu);
  return (
    <PressableScale onPress={openProfileMenu} hitSlop={8} accessibilityLabel="Open profile menu">
      <View className="overflow-hidden rounded-full" style={{ width: size, height: size, backgroundColor: "#2a2a2a" }}>
        <Image source={require("../../../assets/images/avatar.jpg")} style={{ width: size, height: size }} />
      </View>
    </PressableScale>
  );
}
