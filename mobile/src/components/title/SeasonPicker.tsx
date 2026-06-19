import { ScrollView, Text } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { type TmdbSeasonSummary } from "@/lib/streamarena";
import { colors } from "@/theme";

// Horizontal pill selector for TV seasons. Specials (season 0) are excluded.
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {list.map((season) => {
        const active = season.season_number === selected;
        return (
          <PressableScale
            key={season.season_number}
            onPress={() => onSelect(season.season_number)}
            accessibilityState={{ selected: active }}
            style={{
              backgroundColor: active ? colors.accent : colors.card,
              borderColor: active ? colors.accent : colors.line,
              borderWidth: 1,
              borderRadius: 9999,
              paddingHorizontal: 16,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: active ? colors.white : colors.muted, fontSize: 13, fontWeight: "700" }}>
              {season.name || `Season ${season.season_number}`}
            </Text>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}
