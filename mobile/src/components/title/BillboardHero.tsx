import { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Info, Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { GlassSurface } from "@/components/ui/GlassSurface";
import { Scrim } from "@/components/ui/Scrim";
import { formatRating, formatYear } from "@/lib/format";
import { type Title, tmdbImage } from "@/lib/streamarena";
import { colors, layout, radius } from "@/theme";

// Full-bleed billboard at the top of Home. Artwork provides the colour; utility
// controls sit below the title on the neutral chrome layer.
export function BillboardHero({
  title,
  imageBase,
  height = layout.heroHeight,
  onPlay,
  onInfo,
  centerSlot,
}: {
  title: Title;
  imageBase?: string;
  height?: number;
  onPlay: () => void;
  onInfo: () => void;
  centerSlot?: ReactNode;
}) {
  const backdrop =
    tmdbImage(title.backdropPath, "w1280", imageBase) || tmdbImage(title.posterPath, "w780", imageBase);
  const meta = [formatYear(title.year ? `${title.year}` : undefined), formatRating(title.voteAverage) ? `★ ${formatRating(title.voteAverage)}` : ""]
    .filter(Boolean)
    .join("   ");

  return (
    <View style={{ height }}>
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
            fontWeight: "800",
            letterSpacing: 1.2,
            textTransform: "uppercase",
            marginBottom: 5,
          }}
        >
          Featured
        </Text>
        <Text numberOfLines={2} style={{ color: colors.white, fontSize: 34, lineHeight: 38, fontWeight: "700", letterSpacing: -0.75 }}>
          {title.title}
        </Text>
        {meta ? (
          <Text style={{ color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 7, fontWeight: "600" }}>{meta}</Text>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 17 }}>
          <PressableScale
            onPress={onPlay}
            accessibilityLabel={`Play ${title.title}`}
            style={{
              minHeight: 46,
              borderRadius: radius.control,
              backgroundColor: colors.white,
              paddingHorizontal: 22,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Play size={18} color="#000" fill="#000" />
            <Text style={{ color: "#000", fontWeight: "800", fontSize: 15 }}>Play</Text>
          </PressableScale>

          {centerSlot}

          <PressableScale onPress={onInfo} accessibilityLabel={`More information about ${title.title}`}>
            <GlassSurface
              pointerEvents="none"
              fallbackColor="rgba(24,24,25,0.92)"
              tintColor="rgba(255,255,255,0.04)"
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
              <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 15 }}>Info</Text>
            </GlassSurface>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}
