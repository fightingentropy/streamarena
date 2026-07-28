import { useEffect, useRef, useState } from "react";
import { FlatList, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Search as SearchIcon, X } from "lucide-react-native";
import { ScreenHeader } from "@/components/nav/ScreenHeader";
import { PressableScale } from "@/components/ui/PressableScale";
import { PosterCard } from "@/components/title/PosterCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState } from "@/components/ui/States";
import { normalizeSearchTitle, searchTitles, type Title } from "@/lib/streamarena";
import { colors, radius } from "@/theme";

const GAP = 12;

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 1024 ? 5 : width >= 700 ? 4 : 2;
  const horizontalPadding = width >= 700 ? 20 : 16;
  const itemWidth = Math.floor((width - horizontalPadding * 2 - GAP * (columns - 1)) / columns);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Title[]>([]);
  const [imageBase, setImageBase] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
      setSearched(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await searchTitles(q, 40, controller.signal);
        if (controller.signal.aborted) return;
        setResults(res.results.map(normalizeSearchTitle));
        setImageBase(res.imageBase);
        setSearched(true);
      } catch (e) {
        if ((e as { name?: string })?.name !== "AbortError") {
          setResults([]);
          setSearched(true);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Search" />
      <View style={{ paddingHorizontal: horizontalPadding, paddingBottom: 16 }}>
        <View
          style={{
            backgroundColor: colors.surfaceRaised,
            borderRadius: radius.control,
            borderWidth: 0.5,
            borderColor: colors.hairline,
            paddingHorizontal: 13,
            height: 50,
            gap: 10,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <SearchIcon size={20} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search movies and shows"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search movies and shows"
            style={{ flex: 1, color: colors.foreground, fontSize: 16 }}
          />
          {query.length > 0 ? (
            <PressableScale onPress={() => setQuery("")} hitSlop={8} accessibilityLabel="Clear search">
              <X size={18} color={colors.muted} />
            </PressableScale>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: horizontalPadding, gap: GAP }}>
          {Array.from({ length: columns * 3 }).map((_, i) => (
            <View key={i} style={{ width: itemWidth }}>
              <Skeleton width={itemWidth} height={Math.round(itemWidth * 1.5)} radius={14} />
              <Skeleton width={itemWidth * 0.72} height={14} radius={4} style={{ marginTop: 8 }} />
            </View>
          ))}
        </View>
      ) : query.trim().length < 2 ? (
        <EmptyState title="Find something to watch" subtitle="Search by movie or show title." />
      ) : searched && results.length === 0 ? (
        <EmptyState title="No results" subtitle={`Nothing found for “${query.trim()}”.`} />
      ) : (
        <FlatList
          key={`search-${columns}`}
          data={results}
          keyExtractor={(item) => `${item.mediaType}-${item.id}`}
          numColumns={columns}
          columnWrapperStyle={{ gap: GAP, paddingHorizontal: horizontalPadding }}
          contentContainerStyle={{ rowGap: 24, paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <PosterCard title={item} imageBase={imageBase} width={itemWidth} />}
        />
      )}
    </View>
  );
}
