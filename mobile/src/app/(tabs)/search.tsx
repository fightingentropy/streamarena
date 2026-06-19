import { useEffect, useRef, useState } from "react";
import { FlatList, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Search as SearchIcon, X } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { PosterCard } from "@/components/title/PosterCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState } from "@/components/ui/States";
import { normalizeSearchTitle, searchTitles, type Title } from "@/lib/streamarena";
import { colors } from "@/theme";

const COLS = 3;
const H_PADDING = 16;
const GAP = 10;

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const itemWidth = Math.floor((width - H_PADDING * 2 - GAP * (COLS - 1)) / COLS);

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
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: H_PADDING, paddingBottom: 12 }}>
        <View
          className="flex-row items-center rounded-lg"
          style={{ backgroundColor: "#242424", paddingHorizontal: 12, height: 46, gap: 10 }}
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
            style={{ flex: 1, color: colors.foreground, fontSize: 16 }}
          />
          {query.length > 0 ? (
            <PressableScale onPress={() => setQuery("")} hitSlop={8}>
              <X size={18} color={colors.muted} />
            </PressableScale>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: H_PADDING, gap: GAP }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} width={itemWidth} height={Math.round(itemWidth * 1.5)} radius={8} />
          ))}
        </View>
      ) : query.trim().length < 2 ? (
        <EmptyState title="Find something to watch" subtitle="Search by movie or show title." />
      ) : searched && results.length === 0 ? (
        <EmptyState title="No results" subtitle={`Nothing found for “${query.trim()}”.`} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.mediaType}-${item.id}`}
          numColumns={COLS}
          columnWrapperStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
          contentContainerStyle={{ gap: GAP, paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <PosterCard title={item} imageBase={imageBase} width={itemWidth} />}
        />
      )}
    </View>
  );
}
