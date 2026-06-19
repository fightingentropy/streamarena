import { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Info, Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Scrim } from "@/components/ui/Scrim";
import { formatRating, formatYear } from "@/lib/format";
import { type Title, tmdbImage } from "@/lib/streamarena";
import { colors, layout } from "@/theme";

// Full-bleed billboard at the top of Home / title detail: backdrop + fade-to-bg
// scrim, the title, a small meta line, and the action row (Play, an optional
// center slot for My List, and Info).
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
        locations={[0, 0.4, 0.86, 1]}
      />
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 22, alignItems: "center", paddingHorizontal: 20 }}>
        <Text numberOfLines={2} style={{ color: colors.white, fontSize: 28, fontWeight: "800", textAlign: "center", letterSpacing: 0.2 }}>
          {title.title}
        </Text>
        {meta ? (
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 6, fontWeight: "600" }}>{meta}</Text>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 }}>
          <PressableScale
            onPress={onPlay}
            className="flex-row items-center rounded-md"
            style={{ backgroundColor: colors.white, paddingHorizontal: 22, paddingVertical: 10, gap: 8 }}
          >
            <Play size={18} color="#000" fill="#000" />
            <Text style={{ color: "#000", fontWeight: "800", fontSize: 15 }}>Play</Text>
          </PressableScale>

          {centerSlot}

          <PressableScale
            onPress={onInfo}
            className="flex-row items-center rounded-md"
            style={{ backgroundColor: "rgba(255,255,255,0.18)", paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}
          >
            <Info size={18} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>Info</Text>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}
