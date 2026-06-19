import { useRouter } from "expo-router";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { titleHref } from "@/lib/nav";
import { type Title, tmdbImage } from "@/lib/streamarena";
import { layout } from "@/theme";

// A 2:3 poster tile used in rails and grids. Tapping it opens the title detail.
export function PosterCard({
  title,
  imageBase,
  width = layout.posterWidth,
  onPress,
}: {
  title: Title;
  imageBase?: string;
  width?: number;
  onPress?: () => void;
}) {
  const router = useRouter();
  const height = Math.round(width * 1.5);
  return (
    <PressableScale
      onPress={onPress ?? (() => router.push(titleHref(title.mediaType, title.id)))}
      accessibilityLabel={title.title}
      style={{ width }}
    >
      <PosterImage
        uri={tmdbImage(title.posterPath, "w342", imageBase)}
        recyclingKey={`${title.mediaType}-${title.id}`}
        style={{ width, height, borderRadius: 8, backgroundColor: "#1a1a1a" }}
      />
    </PressableScale>
  );
}
