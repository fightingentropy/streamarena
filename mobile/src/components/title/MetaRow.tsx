import { Text, View } from "react-native";
import { Star } from "lucide-react-native";
import { formatRating, formatRuntime } from "@/lib/format";
import { colors } from "@/theme";

// The compact meta line under a title's hero: year · runtime · seasons, plus a
// rating chip (★ 8.7) and an HD pill. Empty parts are omitted.
export function MetaRow({
  year,
  runtimeMinutes,
  rating,
  seasons,
}: {
  year?: string;
  runtimeMinutes?: number;
  rating?: number;
  seasons?: number;
}) {
  const parts: string[] = [];
  if (year) parts.push(year);
  const runtime = formatRuntime(runtimeMinutes);
  if (runtime) parts.push(runtime);
  if (seasons && seasons > 0) parts.push(seasons === 1 ? "1 Season" : `${seasons} Seasons`);
  const ratingLabel = formatRating(rating);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
      {parts.map((part, i) => (
        <Text key={`${part}-${i}`} style={{ color: colors.muted, fontSize: 13, fontWeight: "600" }}>
          {part}
        </Text>
      ))}
      {ratingLabel ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Star size={13} color="#f5c518" fill="#f5c518" />
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>{ratingLabel}</Text>
        </View>
      ) : null}
      <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
        <Text style={{ color: colors.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>HD</Text>
      </View>
    </View>
  );
}
