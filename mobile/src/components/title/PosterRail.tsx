import { ScrollView, Text, View } from "react-native";
import { PosterCard } from "@/components/title/PosterCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { type Title } from "@/lib/streamarena";
import { colors, layout } from "@/theme";

// A titled horizontal rail of poster cards.
export function PosterRail({
  title,
  items,
  imageBase,
}: {
  title: string;
  items: Title[];
  imageBase?: string;
}) {
  if (!items.length) return null;
  return (
    <View style={{ marginBottom: 22 }}>
      <Text
        style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", paddingHorizontal: 16, marginBottom: 10 }}
      >
        {title}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      >
        {items.map((t) => (
          <PosterCard key={`${t.mediaType}-${t.id}`} title={t} imageBase={imageBase} />
        ))}
      </ScrollView>
    </View>
  );
}

// Placeholder rail shown while the home payload is warming.
export function PosterRailSkeleton() {
  const height = Math.round(layout.posterWidth * 1.5);
  return (
    <View style={{ marginBottom: 22 }}>
      <Skeleton width={160} height={18} radius={4} style={{ marginHorizontal: 16, marginBottom: 12 }} />
      <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} width={layout.posterWidth} height={height} radius={8} />
        ))}
      </ScrollView>
    </View>
  );
}
