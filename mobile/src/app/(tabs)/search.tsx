import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Search as SearchIcon, SlidersHorizontal, X } from "lucide-react-native";
import { ScreenHeader } from "@/components/nav/ScreenHeader";
import { PressableScale } from "@/components/ui/PressableScale";
import { PosterCard } from "@/components/title/PosterCard";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState } from "@/components/ui/States";
import { Sheet } from "@/components/ui/Sheet";
import { useAccountScope } from "@/lib/auth";
import { clearRecentSearches, readRecentSearches, rememberSearch, useDiscovery } from "@/lib/discovery";
import { titleHref } from "@/lib/nav";
import type { MediaType } from "@/lib/streamarena";
import { colors, radius } from "@/theme";

function Chip({ label, active = false, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} style={{ minHeight: 38, justifyContent: "center", paddingHorizontal: 13, paddingVertical: 9, borderRadius: radius.control, borderWidth: 0.5, borderColor: active ? colors.foreground : colors.hairline, backgroundColor: active ? colors.surfaceRaised : colors.background }}>
    <Text style={{ color: active ? colors.foreground : colors.muted, fontSize: 13, fontWeight: "600" }}>{label}</Text>
  </PressableScale>;
}

export default function SearchScreen() {
  const scope = useAccountScope();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 1024 ? 5 : width >= 700 ? 4 : 2;
  const horizontalPadding = width >= 700 ? 20 : 16;
  const itemWidth = Math.floor((width - horizontalPadding * 2 - 12 * (columns - 1)) / columns);
  const [query, setQuery] = useState("");
  const [mediaType, setMediaType] = useState<"all" | MediaType>("all");
  const [genre, setGenre] = useState("");
  const [year, setYear] = useState("");
  const [personId, setPersonId] = useState("");
  const [recent, setRecent] = useState(() => readRecentSearches(scope));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftGenre, setDraftGenre] = useState("");
  const [draftYear, setDraftYear] = useState("");
  const { results, response, loading, error, retry, loadMore } = useDiscovery(query, { mediaType, genre, year, personId }, scope);
  useEffect(() => { setRecent(readRecentSearches(scope)); }, [scope]);

  function changeQuery(value: string) { setQuery(value); setPersonId(""); }
  function remember() { setRecent(rememberSearch(scope, query)); }
  const filtered = !!genre || !!year;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Search" />
      <View style={{ paddingHorizontal: horizontalPadding, paddingBottom: 16, gap: 12 }}>
        <View style={{ backgroundColor: colors.surfaceRaised, borderRadius: radius.control, borderWidth: 0.5, borderColor: colors.hairline, paddingHorizontal: 13, height: 50, gap: 10, flexDirection: "row", alignItems: "center" }}>
          <SearchIcon size={20} color={colors.muted} />
          <TextInput value={query} onChangeText={changeQuery} placeholder="Titles, actors, directors" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" onSubmitEditing={remember} accessibilityLabel="Search titles, actors and directors" style={{ flex: 1, color: colors.foreground, fontSize: 16 }} />
          {query.length ? <PressableScale onPress={() => changeQuery("")} hitSlop={8} accessibilityLabel="Clear search"><X size={18} color={colors.muted} /></PressableScale> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          {([["all", "All"], ["movie", "Movies"], ["tv", "Series"]] as const).map(([value, label]) => <Chip key={value} label={label} active={mediaType === value} onPress={() => setMediaType(value)} />)}
          <View style={{ flex: 1 }} />
          <PressableScale accessibilityRole="button" accessibilityLabel="Filter by genre and year" onPress={() => { Keyboard.dismiss(); setDraftGenre(genre); setDraftYear(year); setFiltersOpen(true); }} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 10 }}>
            <SlidersHorizontal size={17} color={filtered ? colors.foreground : colors.muted} /><Text style={{ color: filtered ? colors.foreground : colors.muted, fontSize: 13 }}>Filters{filtered ? " ·" : ""}</Text>
          </PressableScale>
        </View>
        {filtered ? <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ color: colors.muted, fontSize: 12, flex: 1 }}>{[response?.genres?.find((g) => g.id === genre)?.name || genre, year].filter(Boolean).join(" · ")}</Text>
          <PressableScale accessibilityLabel="Clear filters" onPress={() => { setGenre(""); setYear(""); }}><Text style={{ color: colors.foreground, fontSize: 12 }}>Clear</Text></PressableScale>
        </View> : null}
      </View>

      <FlatList
        key={`search-${columns}`} data={results} keyExtractor={(item) => `${item.mediaType}-${item.id}`} numColumns={columns}
        columnWrapperStyle={{ gap: 12, paddingHorizontal: horizontalPadding }} contentContainerStyle={{ rowGap: 22, paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        ListHeaderComponent={<View style={{ paddingHorizontal: horizontalPadding, gap: 14 }}>
          {!query && recent.length ? <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: colors.muted, fontSize: 13 }}>Recent searches</Text><PressableScale onPress={() => { clearRecentSearches(scope); setRecent([]); }} accessibilityLabel="Clear recent searches"><Text style={{ color: colors.muted, fontSize: 13 }}>Clear</Text></PressableScale></View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{recent.map((text) => <Chip key={text} label={text} onPress={() => changeQuery(text)} />)}</View>
          </View> : null}
          {(response?.people?.length ?? 0) > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
            {response?.people?.map((person) => <Chip key={person.id} label={`${person.name}${person.department ? ` · ${person.department}` : ""}`} active={response.person?.id === person.id} onPress={() => { remember(); setPersonId(String(person.id)); }} />)}
          </ScrollView> : null}
          {results.length ? <Text style={{ color: colors.muted, fontSize: 13 }}>{response?.person ? `Films and series with ${response.person.name}` : query ? `Results for “${query.trim()}”` : "Explore movies and series"}</Text> : null}
        </View>}
        ListEmptyComponent={loading ? <View style={{ padding: 42, alignItems: "center", gap: 12 }}><ActivityIndicator color={colors.muted} /><Text style={{ color: colors.muted }}>Finding titles…</Text></View> : error ? <EmptyState title="Search unavailable" subtitle={error} actionLabel="Retry search" onAction={() => void retry()} /> : <EmptyState title={query.trim().length === 1 ? "Keep typing" : "No matching titles"} subtitle={query.trim().length === 1 ? "Enter at least two characters." : response?.hasMore ? "Load more to keep looking, or adjust the filters." : "Try another title or person, or adjust the filters."} />}
        ListFooterComponent={error && results.length ? <EmptyState title="More titles couldn’t load" subtitle={error} actionLabel="Retry search" onAction={() => void retry()} /> : response?.hasMore ? <View style={{ alignItems: "center", padding: 18 }}><Chip label={loading ? "Loading…" : "Load more"} onPress={() => { if (!loading) void loadMore(); }} /></View> : null}
        renderItem={({ item }) => <PosterCard title={item} imageBase={response?.imageBase} width={itemWidth} onPress={() => { remember(); router.push(titleHref(item.mediaType, item.id)); }} />}
      />

      <Sheet visible={filtersOpen} onClose={() => setFiltersOpen(false)} heightPct={0.67}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: insets.bottom + 24 }}>
          <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "700" }}>Filter titles</Text>
          <Text style={{ color: colors.muted, fontSize: 13 }}>Genre</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Chip label="All genres" active={!draftGenre} onPress={() => setDraftGenre("")} />{response?.genres?.map((g) => <Chip key={g.id} label={g.name} active={draftGenre === g.id} onPress={() => setDraftGenre(g.id)} />)}</View>
          <Text style={{ color: colors.muted, fontSize: 13 }}>Release year</Text>
          <TextInput accessibilityLabel="Release year" keyboardType="number-pad" maxLength={4} value={draftYear} onChangeText={(value) => setDraftYear(value.replace(/\D/g, ""))} placeholder="Any year" placeholderTextColor={colors.dim} style={{ height: 46, paddingHorizontal: 12, color: colors.foreground, borderWidth: 0.5, borderColor: colors.hairline, borderRadius: radius.control }} />
          {draftYear && (!/^\d{4}$/.test(draftYear) || Number(draftYear) < 1874 || Number(draftYear) > 2100) ? <Text style={{ color: colors.muted, fontSize: 12 }}>Enter a year between 1874 and 2100.</Text> : null}
          <View style={{ flexDirection: "row", gap: 10 }}><Chip label="Reset" onPress={() => { setDraftGenre(""); setDraftYear(""); }} /><Chip label="Show titles" active onPress={() => { if (draftYear && (!/^\d{4}$/.test(draftYear) || Number(draftYear) < 1874 || Number(draftYear) > 2100)) return; setGenre(draftGenre); setYear(draftYear); setPersonId(""); setFiltersOpen(false); Keyboard.dismiss(); }} /></View>
        </ScrollView>
      </Sheet>
    </View>
  );
}
