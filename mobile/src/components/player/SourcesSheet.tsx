import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { Sheet } from "@/components/ui/Sheet";
import { selectionAsync } from "@/lib/haptics";
import { getSources, getTorrentSettings, type SourceSummary } from "@/lib/streamarena";
import { usePlayerStore } from "@/video/state";
import { colors, radius } from "@/theme";
import { sourceTabForActiveSource } from "./source-selection";

// In-player source switcher (VOD): a dedicated sheet listing the title's alternate
// sources/servers, re-resolving the chosen one (reopenWith) while keeping the current
// position. Mirrors the web player's source control. The list auto-loads when the sheet
// first opens and is cached until the title changes; the active source is checked. (Live
// channels use LiveSourcesSheet, which switches pre-resolved feeds.)
export function SourcesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const request = usePlayerStore((s) => s.request);
  const selectedSourceHash = usePlayerStore((s) => s.selectedSourceHash);
  const resolvedSourceHash = usePlayerStore((s) => s.resolved?.sourceHash);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const [torrentEnabled, setTorrentEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState<"hls" | "torrents">("hls");

  const loadSources = useCallback(async () => {
    if (!request || loading || sources) return;
    setLoading(true);
    setErrored(false);
    try {
      const [res, settings] = await Promise.all([
        getSources({
          tmdbId: request.tmdbId,
          mediaType: request.mediaType,
          title: request.title,
          year: request.year,
          seasonNumber: request.seasonNumber,
          episodeNumber: request.episodeNumber,
        }),
        getTorrentSettings().catch(() => null),
      ]);
      setSources(res.sources ?? []);
      setTorrentEnabled(Boolean(settings?.localTorrentEnabled || res.sources?.some((source) => source.isTorrent)));
    } catch {
      setErrored(true);
    } finally {
      setLoading(false);
    }
  }, [loading, request, sources]);

  // Drop the cached list when the title changes (e.g. next episode) so it re-fetches.
  useEffect(() => {
    setSources(null);
    setErrored(false);
    setTorrentEnabled(false);
    setActiveTab("hls");
  }, [request]);

  // Auto-load the list the first time the sheet opens (the guard no-ops once cached/in flight).
  useEffect(() => {
    if (visible) void loadSources();
  }, [loadSources, visible]);

  const hlsSources = useMemo(() => (sources ?? []).filter((source) => !source.isTorrent), [sources]);
  const torrentSources = useMemo(() => (sources ?? []).filter((source) => source.isTorrent), [sources]);
  const visibleSources = torrentEnabled ? (activeTab === "torrents" ? torrentSources : hlsSources) : (sources ?? []);

  // The sheet stays mounted while hidden, so always realign its tab with the active
  // playback source when it opens. Otherwise a previously viewed Torrents tab remains
  // selected even after playback has switched back to HLS.
  useEffect(() => {
    if (!visible || !torrentEnabled || !sources) return;
    setActiveTab(
      sourceTabForActiveSource(sources, resolvedSourceHash || selectedSourceHash),
    );
  }, [resolvedSourceHash, selectedSourceHash, sources, torrentEnabled, visible]);

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.6} zIndex={200}>
      <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700", letterSpacing: -0.25, marginHorizontal: 20, marginTop: 6, marginBottom: 4 }}>Sources</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginHorizontal: 20, marginBottom: 14 }}>
        Switch server if the current one buffers or won’t play.
      </Text>
      {torrentEnabled && sources ? (
        <View
          style={{
            flexDirection: "row",
            padding: 3,
            borderRadius: radius.control,
            backgroundColor: colors.card,
            borderWidth: 0.5,
            borderColor: colors.hairline,
            marginHorizontal: 20,
            marginBottom: 12,
          }}
        >
          {(["hls", "torrents"] as const).map((tab) => {
            const selected = activeTab === tab;
            const count = tab === "hls" ? hlsSources.length : torrentSources.length;
            return (
              <Pressable
                key={tab}
                onPress={() => {
                  selectionAsync();
                  setActiveTab(tab);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                  paddingVertical: 9,
                  borderRadius: 9,
                  backgroundColor: selected ? colors.cardActive : "transparent",
                }}
              >
                <Text style={{ color: selected ? colors.foreground : colors.muted, fontSize: 14, fontWeight: "700" }}>
                  {tab === "hls" ? "HLS" : "Torrents"}
                </Text>
                <View
                  style={{
                    minWidth: 24,
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 10,
                    backgroundColor: selected ? colors.hairline : colors.line,
                  }}
                >
                  <Text style={{ color: selected ? colors.foreground : colors.muted, textAlign: "center", fontSize: 11, fontWeight: "700" }}>
                    {count}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
        {sources == null ? (
          errored ? (
            <Pressable onPress={loadSources} accessibilityRole="button" style={{ paddingVertical: 14 }}>
              <Text style={{ color: colors.danger, fontSize: 15, fontWeight: "600" }}>Couldn’t load sources — tap to retry</Text>
            </Pressable>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14 }}>
              <ActivityIndicator size="small" color={colors.muted} />
              <Text style={{ color: colors.muted, fontSize: 14 }}>Finding sources…</Text>
            </View>
          )
        ) : visibleSources.length === 0 ? (
          <Text style={{ color: colors.muted, fontSize: 13, paddingVertical: 14 }}>
            {activeTab === "torrents" ? "No torrent sources found." : "No HLS sources found."}
          </Text>
        ) : (
          visibleSources.map((s, i) => {
            const activeSourceHash = resolvedSourceHash || selectedSourceHash;
            const active =
              activeSourceHash?.trim().toLowerCase() ===
              s.sourceHash.trim().toLowerCase();
            const meta = [
              s.qualityLabel,
              s.container?.toUpperCase(),
              s.size,
              s.isTorrent && s.seeders != null ? `${s.seeders} seeders` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Pressable
                key={`${s.sourceHash}-${i}`}
                onPress={() => {
                  selectionAsync();
                  if (!active) usePlayerStore.getState().reopenWith({ sourceHash: s.sourceHash });
                  onClose();
                }}
                style={{ flexDirection: "row", alignItems: "center", minHeight: 54, paddingVertical: 10, gap: 12, borderBottomWidth: 0.5, borderBottomColor: colors.line }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <View style={{ width: 22, alignItems: "center" }}>{active ? <Check size={20} color={colors.accent} /> : null}</View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, fontWeight: active ? "700" : "500" }}>
                    {s.primary || s.filename || s.provider || `Source ${i + 1}`}
                  </Text>
                  {meta ? <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>{meta}</Text> : null}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Sheet>
  );
}
