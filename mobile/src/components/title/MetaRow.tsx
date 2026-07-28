import { Text, View } from "react-native";
import { Star } from "lucide-react-native";
import { formatCertification, formatRating, formatRuntime } from "@/lib/format";
import { colors } from "@/theme";

// The compact meta line under a title's hero. Empty parts are omitted and every
// badge stays monochrome so the artwork remains the only decorative colour.
export function MetaRow({
  year,
  runtimeMinutes,
  rating,
  certification,
  seasons,
}: {
  year?: string;
  runtimeMinutes?: number;
  rating?: number;
  certification?: string | null;
  seasons?: number;
}) {
  const parts: string[] = [];
  if (year) parts.push(year);
  const runtime = formatRuntime(runtimeMinutes);
  if (runtime) parts.push(runtime);
  if (seasons && seasons > 0) parts.push(seasons === 1 ? "1 Season" : `${seasons} Seasons`);
  const ratingLabel = formatRating(rating);
  const certificationLabel = formatCertification(certification);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
      {parts.map((part, i) => (
        <View key={`${part}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {i > 0 ? <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.dim }} /> : null}
          <Text style={{ color: colors.muted, fontSize: 13, fontWeight: "600" }}>{part}</Text>
        </View>
      ))}
      {ratingLabel ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Star size={13} color={colors.foreground} />
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>{ratingLabel}</Text>
        </View>
      ) : null}
      <View
        accessible
        accessibilityLabel={`Age rating ${certificationLabel}`}
        style={{
          borderWidth: 0.5,
          borderColor: colors.hairline,
          borderRadius: 5,
          paddingHorizontal: 6,
          paddingVertical: 2,
        }}
      >
        <Text style={{ color: colors.muted, fontSize: 11, fontWeight: "700" }}>{certificationLabel}</Text>
      </View>
      <View
        style={{
          borderWidth: 0.5,
          borderColor: colors.hairline,
          borderRadius: 5,
          paddingHorizontal: 5,
          paddingVertical: 2,
        }}
      >
        <Text style={{ color: colors.muted, fontSize: 10, fontWeight: "700", letterSpacing: 0.45 }}>HD</Text>
      </View>
    </View>
  );
}
