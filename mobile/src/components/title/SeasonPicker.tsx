import { ScrollView, Text } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { type TmdbSeasonSummary } from "@/lib/streamarena";
import { colors } from "@/theme";

// Quiet horizontal selector for TV seasons. Specials (season 0) are excluded.
export function SeasonPicker({
  seasons,
  selected,
  onSelect,
}: {
  seasons: TmdbSeasonSummary[];
  selected: number;
  onSelect: (seasonNumber: number) => void;
}) {
  const list = (seasons ?? []).filter((s) => typeof s.season_number === "number" && s.season_number > 0);
  if (!list.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 22 }}
    >
      {list.map((season) => {
        const active = season.season_number === selected;
        return (
          <PressableScale
            key={season.season_number}
            onPress={() => onSelect(season.season_number)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={{
              minHeight: 40,
              justifyContent: "center",
              paddingVertical: 8,
              borderBottomWidth: 2,
              borderBottomColor: active ? colors.foreground : "transparent",
            }}
          >
            <Text
              style={{
                color: active ? colors.foreground : colors.muted,
                fontSize: 14,
                fontWeight: active ? "700" : "600",
              }}
            >
              {season.name || `Season ${season.season_number}`}
            </Text>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}
