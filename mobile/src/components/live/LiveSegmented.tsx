import { Text, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { selectionAsync } from "@/lib/haptics";
import { colors } from "@/theme";

export type LiveTab = "sports" | "tv" | "twitch";

const TABS: { id: LiveTab; label: string }[] = [
  { id: "sports", label: "Sports" },
  { id: "tv", label: "Live TV" },
  { id: "twitch", label: "Twitch" },
];

// Pill segmented control for the Live tab's three surfaces.
export function LiveSegmented({ value, onChange }: { value: LiveTab; onChange: (tab: LiveTab) => void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: colors.card,
        borderRadius: 9999,
        padding: 4,
        marginHorizontal: 16,
        gap: 4,
      }}
    >
      {TABS.map((tab) => {
        const active = tab.id === value;
        return (
          <PressableScale
            key={tab.id}
            onPress={() => {
              if (!active) {
                selectionAsync();
                onChange(tab.id);
              }
            }}
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 9,
              borderRadius: 9999,
              backgroundColor: active ? colors.accent : "transparent",
            }}
          >
            <Text style={{ color: active ? colors.white : colors.muted, fontSize: 14, fontWeight: "700" }}>{tab.label}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}
