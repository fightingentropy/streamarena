import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { getIsOnline } from "@/lib/connectivity";
import { GlassHeader } from "@/components/nav/GlassHeader";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { BillboardHero } from "@/components/title/BillboardHero";
import { ContinueWatchingActionsSheet } from "@/components/title/ContinueWatchingActionsSheet";
import { ContinueWatchingRail } from "@/components/title/ContinueWatchingCard";
import { PosterRail, PosterRailSkeleton } from "@/components/title/PosterRail";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState } from "@/components/ui/States";
import { useAccountScope } from "@/lib/auth";
import { impactLight } from "@/lib/haptics";
import { titleHref } from "@/lib/nav";
import {
  type ContinueWatchingItem,
  deleteContinueWatching,
  HOME_RAILS,
  homeHero,
  normalizeTmdbTitle,
  type Rail,
  useContinueWatching,
  useHomeBootstrap,
} from "@/lib/streamarena";
import { colors } from "@/theme";

export default function HomeScreen() {
  const scope = useAccountScope();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: home, loading, error, refetch } = useHomeBootstrap(scope);
  const { items: continueItems, refetch: refetchContinue } = useContinueWatching(scope);

  // Continue Watching is written by the player (after ~5s of playback) and the cache is
  // invalidated, but the invalidation doesn't notify mounted hooks — so without this the
  // rail only picks up a freshly-watched title on a cold relaunch. Re-fetch whenever Home
  // regains focus (returning from the player, or switching back to this tab).
  useFocusEffect(
    useCallback(() => {
      refetchContinue();
    }, [refetchContinue]),
  );

  // Long-press context menu for a Continue Watching card. `hiddenCW` optimistically drops a
  // removed title from the rail immediately; the self-clean effect forgets ids once the
  // server list no longer carries them, so a re-watched title can reappear.
  const [menuItem, setMenuItem] = useState<ContinueWatchingItem | null>(null);
  const [hiddenCW, setHiddenCW] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setHiddenCW((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => continueItems.some((i) => i.sourceIdentity === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [continueItems]);
  const visibleContinue = useMemo(
    () => continueItems.filter((i) => !hiddenCW.has(i.sourceIdentity)),
    [continueItems, hiddenCW],
  );
  const onItemLongPress = useCallback((it: ContinueWatchingItem) => {
    impactLight();
    setMenuItem(it);
  }, []);
  const onRemoveCW = useCallback(
    (it: ContinueWatchingItem) => {
      setHiddenCW((prev) => new Set(prev).add(it.sourceIdentity));
      setMenuItem(null);
      void deleteContinueWatching(it.sourceIdentity, it.seriesId || undefined, scope)
        .then(() => refetchContinue())
        .catch(() => {});
    },
    [scope, refetchContinue],
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refetch(); // background re-fetch; updates `home` when it lands
    refetchContinue(); // pull-to-refresh should refresh the Continue Watching rail too
    setTimeout(() => setRefreshing(false), 1200);
  }, [refetch, refetchContinue]);

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const hero = useMemo(() => homeHero(home), [home]);
  const imageBase = home.imageBase;
  const rails = useMemo(
    () =>
      HOME_RAILS.map((r) => ({
        label: r.label,
        items: ((home[r.key] as Rail | undefined)?.results ?? []).map((e) => normalizeTmdbTitle(e, r.fallback)),
      })).filter((r) => r.items.length > 0),
    [home],
  );

  const warming = home._meta?.status === "warming";
  const showSkeleton = (loading || warming) && rails.length === 0;
  const isEmpty = !showSkeleton && !hero && rails.length === 0;

  const wordmark = (
    <Text style={{ color: colors.accent, fontSize: 17, fontWeight: "900", letterSpacing: 0.5 }}>NETFLIX</Text>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        {hero ? (
          <BillboardHero
            title={hero}
            imageBase={imageBase}
            onPlay={() => router.push(titleHref(hero.mediaType, hero.id))}
            onInfo={() => router.push(titleHref(hero.mediaType, hero.id))}
          />
        ) : (
          <View style={{ height: insets.top + 56 }} />
        )}

        <View style={{ marginTop: hero ? 8 : 0 }}>
          {visibleContinue.length > 0 ? (
            <ContinueWatchingRail items={visibleContinue} onItemLongPress={onItemLongPress} />
          ) : null}

          {showSkeleton ? (
            <>
              <PosterRailSkeleton />
              <PosterRailSkeleton />
              <PosterRailSkeleton />
            </>
          ) : isEmpty ? (
            error && !getIsOnline() ? (
              <EmptyState
                title="You’re offline"
                subtitle="Pull down to retry once you’re back online — your downloads are still available."
                actionLabel="Go to Downloads"
                onAction={() => router.push("/downloads")}
              />
            ) : error ? (
              <EmptyState title="Couldn’t load the catalog" subtitle="Pull down to try again." />
            ) : (
              <EmptyState title="Nothing here yet" subtitle="Pull down to refresh once the catalog warms up." />
            )
          ) : (
            rails.map((rail, i) => (
              <PosterRail
                key={rail.label}
                title={rail.label}
                items={rail.items}
                imageBase={imageBase}
                priority={i === 0 ? "high" : undefined}
              />
            ))
          )}
        </View>
      </Animated.ScrollView>

      <GlassHeader scrollY={scrollY} left={wordmark} right={<ProfileButton />} fadeStart={180} fadeEnd={380} />

      <ContinueWatchingActionsSheet item={menuItem} onClose={() => setMenuItem(null)} onRemove={onRemoveCW} />
    </View>
  );
}
