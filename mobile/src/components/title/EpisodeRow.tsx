import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { type Episode, tmdbImage } from "@/lib/streamarena";
import { formatRuntime } from "@/lib/format";
import { colors } from "@/theme";

// One episode in the season list: landscape still (with a play badge), number + name,
// runtime, and a 2-line overview. An optional `right` slot (e.g. a download control)
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
      <PressableScale
        onPress={onPress}
        accessibilityLabel={`Play episode ${episode.episodeNumber}: ${episode.name}`}
        style={{ flexDirection: "row", gap: 12, flex: 1, minWidth: 0 }}
      >
        <View style={{ width: 132, height: 74, borderRadius: 8, overflow: "hidden", backgroundColor: "#1a1a1a" }}>
          <PosterImage uri={still} recyclingKey={`ep-${episode.seasonNumber}-${episode.episodeNumber}`} style={{ width: 132, height: 74 }} />
          <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: "rgba(0,0,0,0.5)",
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1.5,
                borderColor: "rgba(255,255,255,0.85)",
              }}
            >
              <Play size={14} color="#fff" fill="#fff" />
            </View>
          </View>
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: "700", flex: 1 }}>
              {episode.episodeNumber}. {episode.name}
            </Text>
            {runtime ? <Text style={{ color: colors.muted, fontSize: 12 }}>{runtime}</Text> : null}
          </View>
          {episode.overview ? (
            <Text numberOfLines={2} style={{ color: colors.muted, fontSize: 12, marginTop: 4, lineHeight: 17 }}>
              {episode.overview}
            </Text>
          ) : null}
        </View>
      </PressableScale>
      {right ? <View>{right}</View> : null}
    </View>
  );
}
