import { memo, useCallback, useEffect, useMemo } from "react";
import { FlatList, type ListRenderItemInfo, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/nav/ScreenHeader";
import { PosterCard } from "@/components/title/PosterCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { SignedOutPrompt } from "@/components/ui/States";
import { useAccountScopeOrNull, useSignedIn } from "@/lib/auth";
import { type Title, useTitleDetails } from "@/lib/streamarena";
import { myListItemToTitle, useMyListStore } from "@/store/mylist";
import { colors } from "@/theme";

// Grid tile for a saved title. The stored `thumb` paints instantly as a placeholder, but
// some entries (e.g. saved on the web) hold a landscape backdrop, which looks wrong cropped
// into the 2:3 grid — so prefer the canonical TMDB poster once the (cached) details load.
// Falls back to the stored thumb when offline / before details arrive.
const MyListCard = memo(function MyListCard({ title, width }: { title: Title; width: number }) {
  const { data: details } = useTitleDetails(title.id, title.mediaType, !!title.id);
  const withPoster = useMemo(
    () => (details?.poster_path ? { ...title, posterPath: details.poster_path } : title),
    [title, details?.poster_path],
  );
  return <PosterCard title={withPoster} width={width} />;
});

const GAP = 12;

export default function MyListScreen() {
  const signedIn = useSignedIn();
  const accountScope = useAccountScopeOrNull();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 1024 ? 5 : width >= 700 ? 4 : 2;
  const horizontalPadding = width >= 700 ? 20 : 16;
  const itemWidth = Math.floor((width - horizontalPadding * 2 - GAP * (columns - 1)) / columns);

  const items = useMyListStore((s) => s.items);
  const hydrated = useMyListStore((s) => s.hydrated);
  const loading = useMyListStore((s) => s.loading);

  useEffect(() => {
    useMyListStore.getState().hydrate(accountScope);
  }, [accountScope]);

  // `items` is a stable Zustand slice (changes only on real mutation), so memoizing keeps a
  // stable `data` identity for FlatList — no re-diff/re-render of rows on unrelated renders.
  const titles = useMemo(() => items.map(myListItemToTitle).filter((t) => t.id), [items]);
  const keyExtractor = useCallback((t: (typeof titles)[number]) => `${t.mediaType}-${t.id}`, []);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<(typeof titles)[number]>) => <MyListCard title={item} width={itemWidth} />,
    [itemWidth],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="My List" />

      {!signedIn ? (
        <SignedOutPrompt message="Sign in to save titles to your list." />
      ) : loading && !hydrated && titles.length === 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: horizontalPadding, gap: GAP }}>
          {Array.from({ length: columns * 3 }).map((_, i) => (
            <View key={i} style={{ width: itemWidth }}>
              <Skeleton width={itemWidth} height={Math.round(itemWidth * 1.5)} radius={14} />
              <Skeleton width={itemWidth * 0.72} height={14} radius={4} style={{ marginTop: 8 }} />
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          key={`my-list-${columns}`}
          data={titles}
          keyExtractor={keyExtractor}
          numColumns={columns}
          columnWrapperStyle={{ gap: GAP, paddingHorizontal: horizontalPadding }}
          contentContainerStyle={{ rowGap: 24, paddingTop: 2, paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={{ paddingHorizontal: horizontalPadding, paddingTop: 56 }}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>No saved titles yet</Text>
              <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
                Tap “My List” on any title to save it here.
              </Text>
            </View>
          }
          renderItem={renderItem}
        />
      )}
    </View>
  );
}
