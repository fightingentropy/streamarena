import { useEffect } from "react";
import { FlatList, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PosterCard } from "@/components/title/PosterCard";
import { ContinueWatchingRail } from "@/components/title/ContinueWatchingCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { SignedOutPrompt } from "@/components/ui/States";
import { useAccountScopeOrNull, useSignedIn } from "@/lib/auth";
import { useContinueWatching } from "@/lib/streamarena";
import { myListItemToTitle, useMyListStore } from "@/store/mylist";
import { colors } from "@/theme";

const COLS = 3;
const H_PADDING = 16;
const GAP = 10;

export default function MyListScreen() {
  const signedIn = useSignedIn();
  const accountScope = useAccountScopeOrNull();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const itemWidth = Math.floor((width - H_PADDING * 2 - GAP * (COLS - 1)) / COLS);

  const items = useMyListStore((s) => s.items);
  const hydrated = useMyListStore((s) => s.hydrated);
  const loading = useMyListStore((s) => s.loading);
  const { items: continueItems } = useContinueWatching(accountScope);

  useEffect(() => {
    useMyListStore.getState().hydrate(accountScope);
  }, [accountScope]);

  const titles = items.map(myListItemToTitle).filter((t) => t.id);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 28, fontWeight: "800", paddingHorizontal: H_PADDING, marginBottom: 12 }}>
        My List
      </Text>

      {!signedIn ? (
        <SignedOutPrompt message="Sign in to save titles to your list." />
      ) : loading && !hydrated && titles.length === 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: H_PADDING, gap: GAP }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} width={itemWidth} height={Math.round(itemWidth * 1.5)} radius={8} />
          ))}
        </View>
      ) : (
        <FlatList
          data={titles}
          keyExtractor={(t) => `${t.mediaType}-${t.id}`}
          numColumns={COLS}
          columnWrapperStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
          contentContainerStyle={{ gap: GAP, paddingTop: 2, paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            continueItems.length > 0 ? (
              <View style={{ marginBottom: 6 }}>
                <ContinueWatchingRail items={continueItems} />
              </View>
            ) : null
          }
          // Left-aligned caption (not a centered full-screen EmptyState) so it reads
          // correctly when a populated Continue Watching rail sits above it.
          ListEmptyComponent={
            <View style={{ paddingHorizontal: H_PADDING, paddingTop: continueItems.length > 0 ? 8 : 56 }}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>No saved titles yet</Text>
              <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
                Tap “My List” on any title to save it here.
              </Text>
            </View>
          }
          renderItem={({ item }) => <PosterCard title={item} width={itemWidth} />}
        />
      )}
    </View>
  );
}
