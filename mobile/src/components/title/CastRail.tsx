import { ScrollView, Text, View } from "react-native";
import { PosterImage } from "@/components/PosterImage";
import { type CastMember, tmdbImage } from "@/lib/streamarena";
import { colors } from "@/theme";

// Horizontal cast strip: portrait + actor name + character.
export function CastRail({ cast, imageBase }: { cast?: CastMember[]; imageBase?: string }) {
  const people = (cast ?? []).filter((c) => c.name).slice(0, 16);
  if (!people.length) return null;
  return (
    <View>
      <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", paddingHorizontal: 16, marginBottom: 12 }}>
        Cast
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
        {people.map((person, index) => (
          // TMDB can list the same person id twice (multi-character credits), so the
          // key/recyclingKey include the slot index to stay unique.
          <View key={`${person.id}-${index}`} style={{ width: 92 }}>
            <PosterImage
              uri={tmdbImage(person.profile_path, "w185", imageBase)}
              recyclingKey={`cast-${person.id}-${index}`}
              style={{ width: 92, height: 122, borderRadius: 10, backgroundColor: "#1a1a1a" }}
            />
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, fontWeight: "600", marginTop: 6 }}>
              {person.name}
            </Text>
            {person.character ? (
              <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11, marginTop: 1 }}>
                {person.character}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
