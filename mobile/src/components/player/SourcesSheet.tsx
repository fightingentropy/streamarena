import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { Sheet } from "@/components/ui/Sheet";
import { selectionAsync } from "@/lib/haptics";
import { getSources, getTorrentSettings, type SourceSummary } from "@/lib/streamarena";
import { usePlayerStore } from "@/video/state";
import { colors } from "@/theme";

// In-player source switcher (VOD): a dedicated sheet listing the title's alternate
// sources/servers, re-resolving the chosen one (reopenWith) while keeping the current
// position. Mirrors the web player's source control. The list auto-loads when the sheet
// first opens and is cached until the title changes; the active source is checked. (Live
// channels use LiveSourcesSheet, which switches pre-resolved feeds.)
export function SourcesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const request = usePlayerStore((s) => s.request);
  const selectedSourceHash = usePlayerStore((s) => s.selectedSourceHash);
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

  // If Continue Watching restored a torrent source, open the picker on its active tab.
  useEffect(() => {
    if (!visible || !torrentEnabled || !selectedSourceHash) return;
    const selected = (sources ?? []).find((source) => source.sourceHash === selectedSourceHash);
    if (selected?.isTorrent) setActiveTab("torrents");
  }, [selectedSourceHash, sources, torrentEnabled, visible]);

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.6} zIndex={200}>
      <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "800", marginBottom: 4 }}>Sources</Text>
      <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>
        Switch server if the current one buffers or won’t play.
      </Text>
      {torrentEnabled && sources ? (
        <View
          style={{
            flexDirection: "row",
            padding: 3,
            borderRadius: 10,
            backgroundColor: "rgba(255,255,255,0.06)",
            marginBottom: 8,
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
                  borderRadius: 8,
                  backgroundColor: selected ? "rgba(255,255,255,0.10)" : "transparent",
                  borderBottomWidth: 2,
                  borderBottomColor: selected ? colors.accent : "transparent",
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
                    backgroundColor: selected && tab === "torrents" ? "rgba(229,9,20,0.35)" : "rgba(255,255,255,0.08)",
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
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
        {sources == null ? (
          errored ? (
            <Pressable onPress={loadSources} accessibilityRole="button" style={{ paddingVertical: 14 }}>
              <Text style={{ color: colors.accent, fontSize: 15, fontWeight: "600" }}>Couldn’t load sources — tap to retry</Text>
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
            const active = selectedSourceHash === s.sourceHash;
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
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 13, gap: 12 }}
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
