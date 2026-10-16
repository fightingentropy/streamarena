import { type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/ui/Text";
import { Info, Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { GlassSurface } from "@/components/ui/GlassSurface";
import { Scrim } from "@/components/ui/Scrim";
import { formatRating, formatYear } from "@/lib/format";
import { type Title, tmdbImage } from "@/lib/streamarena";
import { colors, layout, radius } from "@/theme";

// Full-bleed billboard with the same typography and coral Play action as web.
export function BillboardHero({
  title,
  imageBase,
  height = layout.heroHeight,
  onPlay,
  onInfo,
  playLabel = "Play",
  centerSlot,
}: {
  title: Title;
  imageBase?: string;
  height?: number;
  onPlay: () => void;
  onInfo: () => void;
  playLabel?: "Play" | "Resume";
  centerSlot?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  // Reserve the header and text block even on compact screens or larger type.
  const heroHeight = Math.max(height, insets.top + 52 + 260 * fontScale);
  const backdrop =
    tmdbImage(title.backdropPath, "w1280", imageBase) || tmdbImage(title.posterPath, "w780", imageBase);
  const meta = [formatYear(title.year ? `${title.year}` : undefined), formatRating(title.voteAverage) ? `★ ${formatRating(title.voteAverage)}` : ""]
    .filter(Boolean)
    .join("   ");

  return (
    <View style={{ height: heroHeight }}>
      <PosterImage uri={backdrop} style={StyleSheet.absoluteFill} contentFit="cover" />
      <Scrim
        stops={["transparent", "transparent", colors.scrimBottom, colors.background]}
        locations={[0, 0.38, 0.82, 1]}
      />
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 20, paddingHorizontal: 16 }}>
        <Text
          style={{
            color: colors.muted,
            fontSize: 11,
            lineHeight: 15,
            fontWeight: "600",
            letterSpacing: 1.2,
            textTransform: "uppercase",
            marginBottom: 5,
          }}
        >
          Featured
        </Text>
        <Text numberOfLines={2} style={{ color: colors.white, fontSize: 34, lineHeight: 39, fontWeight: "600", letterSpacing: -0.75 }}>
          {title.title}
        </Text>
        {meta ? (
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 7, fontWeight: "600" }}>{meta}</Text>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 17 }}>
          <PressableScale
            onPress={onPlay}
            accessibilityLabel={`${playLabel} ${title.title}`}
            style={{
              minHeight: 46,
              borderRadius: radius.control,
              backgroundColor: colors.accent,
              paddingHorizontal: 22,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Play size={18} color={colors.onAccent} fill={colors.onAccent} />
            <Text style={{ color: colors.onAccent, fontWeight: "600", fontSize: 15 }}>{playLabel}</Text>
          </PressableScale>

          {centerSlot}

          <PressableScale onPress={onInfo} accessibilityLabel={`More information about ${title.title}`}>
            <GlassSurface
              pointerEvents="none"
              fallbackColor={colors.surfaceRaised}
              tintColor={colors.card}
              glassStyle="clear"
              style={{
                minHeight: 46,
                borderRadius: radius.control,
                borderWidth: 0.5,
                borderColor: colors.hairline,
                paddingHorizontal: 16,
                paddingVertical: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                overflow: "hidden",
              }}
            >
              <Info size={18} color={colors.foreground} />
              <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 15 }}>Info</Text>
            </GlassSurface>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}
