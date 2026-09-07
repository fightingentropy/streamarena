import { memo, useCallback } from "react";
import { FlatList, type ListRenderItemInfo, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { buildResumeHref, tvSeasonEpisode } from "@/lib/continue-watching";
import { type ContinueWatchingItem, type MediaType, useTitleDetails } from "@/lib/streamarena";
import { colors, layout, radius } from "@/theme";

type CardProps = {
  item: ContinueWatchingItem;
  onLongPress?: (item: ContinueWatchingItem) => void;
};

const CardItem = memo(function CardItem({ item, onLongPress }: CardProps) {
  const router = useRouter();
  const w = layout.stillWidth;
  const h = layout.stillHeight;
  const mediaType: MediaType = item.mediaType === "tv" ? "tv" : "movie";

  // Resume progress for the neutral seeker line. Mirrors the web data model:
  // estimate total seconds from the TMDB runtime, then resumeSeconds / total. useApiData
  // caches + dedupes by URL, so the rail's cards reuse one fetch per title.
  const { data: details } = useTitleDetails(item.tmdbId ?? "", mediaType, !!item.tmdbId);
  const runtimeMinutes = Number(mediaType === "tv" ? details?.episode_run_time?.[0] : details?.runtime) || 0;
  const estDurationSeconds = runtimeMinutes > 0 ? runtimeMinutes * 60 : 0;
  const resumeSeconds = Number(item.resumeSeconds) || 0;
  const progressPercent =
    estDurationSeconds > 0
      ? Math.max(0, Math.min(100, Math.round((resumeSeconds / estDurationSeconds) * 100)))
      : null;
  const progressLabel = estDurationSeconds > resumeSeconds
    ? `${mediaType === "tv" ? "About " : ""}${Math.ceil((estDurationSeconds - resumeSeconds) / 60)} min left`
    : resumeSeconds > 0 ? `${Math.floor(resumeSeconds / 60)} min watched` : "Ready to resume";

  // These cards are already mid-title, so resume straight into the player. seasonCount (TV)
  // lets the player roll into the next season on finish; see buildResumeHref for the rest.
  const onPress = () => {
    const href = buildResumeHref(item, details?.number_of_seasons);
    if (href) router.push(href);
  };
  const episode = mediaType === "tv" ? tvSeasonEpisode(item) : null;
  const episodeLabel = episode ? `S${episode.season} E${episode.episode}` : item.episode;
  const caption = [episodeLabel, progressLabel].filter(Boolean).join(" · ");

  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={300}
      style={{ width: w }}
      accessibilityLabel={`Resume ${item.title ?? ""}, ${caption}`}
    >
      <View style={{ width: w, height: h, borderRadius: radius.control, overflow: "hidden", backgroundColor: colors.surfaceRaised }}>
        <PosterImage uri={item.thumb || item.src} style={{ width: w, height: h }} />
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: "rgba(0,0,0,0.5)",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1.5,
              borderColor: "rgba(255,255,255,0.85)",
            }}
          >
            <Play size={18} color="#fff" fill="#fff" />
          </View>
        </View>
        {progressPercent !== null ? <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, backgroundColor: colors.line }}>
          <View style={{ height: "100%", width: `${progressPercent}%`, backgroundColor: colors.foreground }} />
        </View> : null}
      </View>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600", marginTop: 8, width: w }}>
        {item.title}
      </Text>
      <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 }}>{caption}</Text>
    </PressableScale>
  );
});

export function ContinueWatchingRail({
  items,
  onItemLongPress,
}: {
  items: ContinueWatchingItem[];
  onItemLongPress?: (item: ContinueWatchingItem) => void;
}) {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ContinueWatchingItem>) => <CardItem item={item} onLongPress={onItemLongPress} />,
    [onItemLongPress],
  );
  const keyExtractor = useCallback((item: ContinueWatchingItem) => item.sourceIdentity, []);
  if (!items.length) return null;
  return (
    <View style={{ marginBottom: 34 }}>
      <Text style={{ color: colors.foreground, fontSize: 22, lineHeight: 27, fontWeight: "700", letterSpacing: -0.35, paddingHorizontal: 16, marginBottom: 12 }}>
        Continue Watching
      </Text>
      <FlatList
        horizontal
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
        initialNumToRender={6}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
}
