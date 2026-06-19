import { useEffect, useState } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { Image, type ImageContentFit, type ImageStyle } from "expo-image";
import { Film } from "lucide-react-native";
import { toAbsoluteApiUrl } from "@/lib/config";
import { colors } from "@/theme";

// Caching image loader for posters/backdrops/stills. expo-image decodes off-thread
// and caches to disk. TMDB URLs are absolute and pass through toAbsoluteApiUrl
// unchanged; a local file:// offline still works too. On a missing/failed image it
// renders a dark placeholder with a film glyph instead of a broken box.
export function PosterImage({
  uri,
  contentFit = "cover",
  style,
  transition = 200,
  recyclingKey,
  showPlaceholderIcon = true,
  priority,
}: {
  uri?: string | null;
  contentFit?: ImageContentFit;
  style?: StyleProp<ImageStyle>;
  transition?: number;
  recyclingKey?: string;
  showPlaceholderIcon?: boolean;
  // expo-image fetch priority — set "high" for above-the-fold art (hero, first rail).
  priority?: "low" | "normal" | "high";
}) {
  const abs = uri ? toAbsoluteApiUrl(uri) : "";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [abs]);

  if (!abs || failed) {
    return (
      <View style={[{ backgroundColor: "#1a1a1a", alignItems: "center", justifyContent: "center" }, style as StyleProp<ViewStyle>]}>
        {showPlaceholderIcon ? <Film size={22} color={colors.dim} /> : null}
      </View>
    );
  }

  return (
    <Image
      style={style}
      source={{ uri: abs }}
      contentFit={contentFit}
      transition={transition}
      recyclingKey={recyclingKey ?? abs}
      cachePolicy="memory-disk"
      priority={priority}
      onError={() => setFailed(true)}
    />
  );
}
