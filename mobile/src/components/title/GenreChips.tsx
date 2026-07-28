import { Text } from "react-native";
import { colors } from "@/theme";

// Compact inline genres avoid adding a second layer of decorative cards.
export function GenreChips({ genres }: { genres: string[] }) {
  const list = genres.filter(Boolean);
  if (!list.length) return null;
  return (
    <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20, fontWeight: "600" }}>
      {list.join("  •  ")}
    </Text>
  );
}
