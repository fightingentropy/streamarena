import { ScrollView, Text, View } from "react-native";
import { PosterImage } from "@/components/PosterImage";
import { type CastMember, tmdbImage } from "@/lib/streamarena";
import { colors, radius } from "@/theme";

// Horizontal cast strip: portrait + actor name + character.
export function CastRail({ cast, imageBase }: { cast?: CastMember[]; imageBase?: string }) {
  const people = (cast ?? []).filter((c) => c.name).slice(0, 16);
  if (!people.length) return null;
  return (
    <View>
      <Text
        style={{
          color: colors.foreground,
          fontSize: 22,
          fontWeight: "700",
          letterSpacing: -0.35,
          paddingHorizontal: 16,
          marginBottom: 14,
        }}
      >
        Cast
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
      >
        {people.map((person, index) => (
          // TMDB can list the same person id twice (multi-character credits), so the
          // key/recyclingKey include the slot index to stay unique.
          <View key={`${person.id}-${index}`} style={{ width: 98 }}>
            <PosterImage
              uri={tmdbImage(person.profile_path, "w185", imageBase)}
              recyclingKey={`cast-${person.id}-${index}`}
              style={{
                width: 98,
                height: 132,
                borderRadius: radius.card,
                backgroundColor: colors.surfaceRaised,
              }}
            />
            <Text
              numberOfLines={1}
              style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", marginTop: 7 }}
            >
              {person.name}
            </Text>
            {person.character ? (
              <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11.5, marginTop: 2 }}>
                {person.character}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
