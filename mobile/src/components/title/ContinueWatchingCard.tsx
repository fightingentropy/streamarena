import { memo, useCallback } from "react";
import { FlatList, type ListRenderItemInfo, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { titleHref, watchHref } from "@/lib/nav";
import { type ContinueWatchingItem, type MediaType, useTitleDetails } from "@/lib/streamarena";
import { colors, layout } from "@/theme";

// Pull season/episode out of a TV continue-watching entry. sourceIdentity is the canonical
// resume key (tmdb:tv:<id>:s<season>:e<episode>); fall back to the display "S1 E5" label.
// Returns null when neither yields a season+episode.
function tvSeasonEpisode(item: ContinueWatchingItem): { season: number; episode: number } | null {
  const fromId = /:s(\d+):e(\d+)\b/i.exec(item.sourceIdentity ?? "");
  if (fromId) return { season: Number(fromId[1]), episode: Number(fromId[2]) };
  const fromLabel = /\bS(\d+)\s*E(\d+)\b/i.exec(item.episode ?? "");
  if (fromLabel) return { season: Number(fromLabel[1]), episode: Number(fromLabel[2]) };
  return null;
}

const CardItem = memo(function CardItem({ item }: { item: ContinueWatchingItem }) {
  const router = useRouter();
  const w = layout.stillWidth;
  const h = layout.stillHeight;
  const mediaType: MediaType = item.mediaType === "tv" ? "tv" : "movie";

  // Resume progress for the red seeker line. Mirrors the web (src-ui/pages/home.jsx):
  // estimate total seconds from the TMDB runtime, then resumeSeconds / total. useApiData
  // caches + dedupes by URL, so the rail's cards reuse one fetch per title.
  const { data: details } = useTitleDetails(item.tmdbId ?? "", mediaType, !!item.tmdbId);
  const runtimeMinutes = Number(mediaType === "tv" ? details?.episode_run_time?.[0] : details?.runtime) || 0;
  const estDurationSeconds = runtimeMinutes > 0 ? runtimeMinutes * 60 : 0;
  const resumeSeconds = Number(item.resumeSeconds) || 0;
  // Clamp to 4–96% so a sliver always shows and a near-finished title never looks done;
  // 24% is the web's fallback for when the runtime isn't known yet.
  const progressPercent =
    estDurationSeconds > 0
      ? Math.max(4, Math.min(96, Math.round((resumeSeconds / estDurationSeconds) * 100)))
      : 24;

  // These cards are already mid-title, so resume straight into the player and skip the
  // detail/summary page. TV needs a concrete season+episode; if we can't determine one,
  // fall back to the detail page rather than open a player that can't pick an episode.
  const onPress = () => {
    if (!item.tmdbId) return;
    const extra: Record<string, string> = { mediaType };
    if (item.title) extra.title = item.title;
    if (item.year) extra.year = item.year;
    if (item.thumb) extra.poster = item.thumb;
    if (mediaType === "tv") {
      const se = tvSeasonEpisode(item);
      if (!se) {
        router.push(titleHref(mediaType, item.tmdbId));
        return;
      }
      extra.seasonNumber = String(se.season);
      extra.episodeNumber = String(se.episode);
      // seasonCount lets the player roll into the next season on finish; episodeCount is
      // unknown without a season fetch, so within-season autoplay stays optimistic.
      if (details?.number_of_seasons) extra.seasonCount = String(details.number_of_seasons);
    }
    router.push(watchHref(item.tmdbId, extra));
  };
  const label = item.episode ? `${item.title ?? ""} · ${item.episode}` : item.title ?? "";

  return (
    <PressableScale onPress={onPress} style={{ width: w }} accessibilityLabel={`Resume ${item.title ?? ""}`}>
      <View style={{ width: w, height: h, borderRadius: 6, overflow: "hidden", backgroundColor: "#1a1a1a" }}>
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
        {/* Netflix-style resume bar: faint track + red fill pinned to the bottom edge. */}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, backgroundColor: "rgba(255,255,255,0.28)" }}>
          <View style={{ height: "100%", width: `${progressPercent}%`, backgroundColor: colors.accent }} />
        </View>
      </View>
      <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 6, width: w }}>
        {label}
      </Text>
    </PressableScale>
  );
});

export function ContinueWatchingRail({ items }: { items: ContinueWatchingItem[] }) {
  const renderItem = useCallback(({ item }: ListRenderItemInfo<ContinueWatchingItem>) => <CardItem item={item} />, []);
  const keyExtractor = useCallback((item: ContinueWatchingItem) => item.sourceIdentity, []);
  if (!items.length) return null;
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", paddingHorizontal: 16, marginBottom: 10 }}>
        Continue Watching
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
