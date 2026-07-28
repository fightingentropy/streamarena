import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { type Episode, tmdbImage } from "@/lib/streamarena";
import { formatRuntime } from "@/lib/format";
import { colors, radius } from "@/theme";

// One episode in the season list: landscape still, number + name, runtime, and a
// 2-line overview. An optional `right` slot (e.g. a download control)
// sits at the trailing edge; tapping it doesn't trigger the row's play press.
export function EpisodeRow({
  episode,
  imageBase,
  onPress,
  right,
}: {
  episode: Episode;
  imageBase?: string;
  onPress: () => void;
  right?: ReactNode;
}) {
  const still = episode.stillUrl || tmdbImage(episode.stillPath, "w342", imageBase);
  const runtime = formatRuntime(episode.runtime);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.line,
      }}
    >
      <PressableScale
        onPress={onPress}
        accessibilityLabel={`Play episode ${episode.episodeNumber}: ${episode.name}`}
        scaleTo={0.99}
        style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}
      >
        <View
          style={{
            width: 140,
            height: 79,
            borderRadius: radius.control,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: colors.surfaceRaised,
          }}
        >
          <PosterImage
            uri={still}
            recyclingKey={`ep-${episode.seasonNumber}-${episode.episodeNumber}`}
            style={{ width: 140, height: 79 }}
          />
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text
              numberOfLines={1}
              style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "600", flex: 1 }}
            >
              {episode.episodeNumber}. {episode.name}
            </Text>
            {runtime ? <Text style={{ color: colors.muted, fontSize: 11.5 }}>{runtime}</Text> : null}
          </View>
          {episode.overview ? (
            <Text numberOfLines={2} style={{ color: colors.muted, fontSize: 12.5, marginTop: 5, lineHeight: 17 }}>
              {episode.overview}
            </Text>
          ) : null}
        </View>
      </PressableScale>
      {right ? <View style={{ marginRight: -4 }}>{right}</View> : null}
    </View>
  );
}
