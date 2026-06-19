import { useCallback } from "react";
import { FlatList, type ListRenderItemInfo, ScrollView, Text, View } from "react-native";
import { PosterCard } from "@/components/title/PosterCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { type Title } from "@/lib/streamarena";
import { colors, layout } from "@/theme";

// A titled horizontal rail of poster cards. Uses a windowed FlatList so only the visible
// (plus a small buffer) cards mount their image — off-screen tiles in a long rail no longer
// decode up front. `priority="high"` marks the above-the-fold first rail for earlier fetch.
export function PosterRail({
  title,
  items,
  imageBase,
  priority,
}: {
  title: string;
  items: Title[];
  imageBase?: string;
  priority?: "low" | "normal" | "high";
}) {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Title>) => <PosterCard title={item} imageBase={imageBase} priority={priority} />,
    [imageBase, priority],
  );
  const keyExtractor = useCallback((t: Title) => `${t.mediaType}-${t.id}`, []);
  if (!items.length) return null;
  return (
    <View style={{ marginBottom: 22 }}>
      <Text
        style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", paddingHorizontal: 16, marginBottom: 10 }}
      >
        {title}
      </Text>
      <FlatList
        horizontal
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
        initialNumToRender={6}
        windowSize={5}
        removeClippedSubviews
      />
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
