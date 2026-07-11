import { memo } from "react";
import { PixelRatio } from "react-native";
import { useRouter } from "expo-router";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { titleHref } from "@/lib/nav";
import { type Title, tmdbImage } from "@/lib/streamarena";
import { layout } from "@/theme";

// A 2:3 poster tile used in rails and grids. Tapping it opens the title detail.
// Memoized: rails/grids render many of these, and the parent re-renders on scroll/state
// changes — with stable title identity (the rail useMemo) and no onPress prop, memo bails.
export const PosterCard = memo(function PosterCard({
  title,
  imageBase,
  width = layout.posterWidth,
  priority,
  onPress,
}: {
  title: Title;
  imageBase?: string;
  width?: number;
  priority?: "low" | "normal" | "high";
  onPress?: () => void;
}) {
  const router = useRouter();
  const height = Math.round(width * 1.5);
  // Pick the TMDB poster size from the tile's *physical* width: a 120pt tile is ~360px on a
  // 3x device (needs w342) but ~240px on 2x (w185 suffices) — avoids oversized decode/memory.
  const size = width * PixelRatio.get() <= 200 ? "w185" : "w342";
  return (
    <PressableScale
      onPress={onPress ?? (() => router.push(titleHref(title.mediaType, title.id)))}
      accessibilityLabel={`Open ${title.title}`}
      style={{ width }}
    >
      <PosterImage
        uri={tmdbImage(title.posterPath, size, imageBase)}
        recyclingKey={`${title.mediaType}-${title.id}`}
        priority={priority}
        style={{ width, height, borderRadius: 8, backgroundColor: "#1a1a1a" }}
      />
    </PressableScale>
  );
});
