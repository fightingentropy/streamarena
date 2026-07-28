import { Text, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { selectionAsync } from "@/lib/haptics";
import { colors } from "@/theme";

export type LiveTab = "sports" | "tv";

const TABS: { id: LiveTab; label: string }[] = [
  { id: "sports", label: "Sports" },
  { id: "tv", label: "Live TV" },
];

// A flat, leading-aligned switcher keeps the hierarchy close to a native
// iOS section bar without adding another filled surface.
export function LiveSegmented({ value, onChange }: { value: LiveTab; onChange: (tab: LiveTab) => void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        paddingHorizontal: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairline,
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
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
            style={{
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              marginRight: 26,
              paddingHorizontal: 2,
              borderBottomWidth: 2,
              borderBottomColor: active ? colors.foreground : "transparent",
            }}
          >
            <Text
              style={{
                color: active ? colors.foreground : colors.muted,
                fontSize: 15,
                fontWeight: active ? "700" : "500",
              }}
            >
              {tab.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}
