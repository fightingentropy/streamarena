import { Text, View } from "react-native";
import { colors } from "@/theme";

// A wrap of pill-shaped genre chips.
export function GenreChips({ genres }: { genres: string[] }) {
  const list = genres.filter(Boolean);
  if (!list.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {list.map((genre) => (
        <View
          key={genre}
          style={{
            backgroundColor: colors.card,
            borderColor: colors.line,
            borderWidth: 1,
            borderRadius: 9999,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "600" }}>{genre}</Text>
        </View>
      ))}
    </View>
  );
}
