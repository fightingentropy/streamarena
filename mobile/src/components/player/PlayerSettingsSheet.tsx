import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { Sheet } from "@/components/ui/Sheet";
import { selectionAsync } from "@/lib/haptics";
import { getSources, type SourceSummary } from "@/lib/streamarena";
import { usePlayerStore } from "@/video/state";
import type { PlayerTextTrack } from "@/video/tracks";
import { colors } from "@/theme";

function SectionTitle({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 22, marginBottom: 6 }}>
      {children}
    </Text>
  );
}

function Row({ label, sublabel, active, onPress }: { label: string; sublabel?: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 13, gap: 12 }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <View style={{ width: 22, alignItems: "center" }}>{active ? <Check size={20} color={colors.accent} /> : null}</View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: active ? "700" : "500" }}>{label}</Text>
        {sublabel ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>{sublabel}</Text> : null}
      </View>
    </Pressable>
  );
}

// Player settings bottom sheet: subtitle and (when present) audio tracks come straight
// from the resolved source; "Source" lazily lists alternates from /api/resolve/sources
// and re-resolves on pick (preserving position). Audio/source changes go through
// reopenWith; subtitles toggle instantly (sideloaded VTT, no re-resolve).
export function PlayerSettingsSheet({
  visible,
  onClose,
  textTracks,
}: {
  visible: boolean;
  onClose: () => void;
  textTracks: PlayerTextTrack[];
}) {
  const resolved = usePlayerStore((s) => s.resolved);
  const request = usePlayerStore((s) => s.request);
  const selectedSubtitle = usePlayerStore((s) => s.selectedSubtitle);
  const selectedAudio = usePlayerStore((s) => s.selectedAudioStreamIndex);
  const selectedSourceHash = usePlayerStore((s) => s.selectedSourceHash);
  // The strip-proxy embed path plays through libVLC, which has no working sideloaded-subtitle
  // wiring yet and whose audio-switch would force the title onto the anti-bot-blocked backend
  // transcode (a dead source). Suppress both controls so the sheet never offers a broken pick.
  const isVlc = usePlayerStore((s) => s.source?.engine === "vlc");

  const audioTracks = resolved?.tracks?.audioTracks ?? [];
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [sourcesError, setSourcesError] = useState(false);

  async function loadSources() {
    if (!request || loadingSources || sources) return;
    setLoadingSources(true);
    setSourcesError(false);
    try {
      const res = await getSources({ tmdbId: request.tmdbId, mediaType: request.mediaType, title: request.title, year: request.year, seasonNumber: request.seasonNumber, episodeNumber: request.episodeNumber });
      setSources(res.sources ?? []);
    } catch {
      // Leave `sources` null so the button stays tappable for a retry.
      setSourcesError(true);
    } finally {
      setLoadingSources(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.6} zIndex={200}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
        <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "800", marginTop: 6 }}>Playback settings</Text>

        <SectionTitle>Subtitles</SectionTitle>
        {isVlc ? (
          <Text style={{ color: colors.muted, fontSize: 13, paddingVertical: 6 }}>Subtitles aren’t available for this source yet.</Text>
        ) : (
          <>
            <Row label="Off" active={selectedSubtitle == null} onPress={() => { selectionAsync(); usePlayerStore.getState().setSubtitle(null); }} />
            {textTracks.length === 0 ? (
              <Text style={{ color: colors.muted, fontSize: 13, paddingVertical: 6 }}>No subtitles for this source.</Text>
            ) : (
              textTracks.map((t, i) => (
                <Row
                  key={`${t.streamIndex}-${i}`}
                  label={t.title}
                  sublabel={t.language !== "und" ? t.language.toUpperCase() : undefined}
                  active={selectedSubtitle === i}
                  onPress={() => { selectionAsync(); usePlayerStore.getState().setSubtitle(i); }}
                />
              ))
            )}
          </>
        )}

        {!isVlc && audioTracks.length > 1 ? (
          <>
            <SectionTitle>Audio</SectionTitle>
            {audioTracks.map((a, i) => {
              const active = selectedAudio === a.streamIndex;
              return (
                <Row
                  key={`${a.streamIndex}-${i}`}
                  label={a.label || a.title || (a.language ? a.language.toUpperCase() : `Audio ${a.streamIndex}`)}
                  sublabel={[a.codec, a.channels ? `${a.channels}ch` : null].filter(Boolean).join(" · ") || undefined}
                  active={active}
                  onPress={() => {
                    if (active) return;
                    selectionAsync();
                    usePlayerStore.getState().reopenWith({ audioStreamIndex: a.streamIndex });
                    onClose();
                  }}
                />
              );
            })}
          </>
        ) : null}

        <SectionTitle>Source</SectionTitle>
        {sources == null ? (
          <Pressable onPress={loadSources} accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 13 }}>
            {loadingSources ? <ActivityIndicator size="small" color={colors.muted} /> : null}
            <Text style={{ color: colors.accent, fontSize: 15, fontWeight: "600" }}>
              {loadingSources ? "Finding sources…" : sourcesError ? "Couldn't load sources — tap to retry" : "Choose a different source"}
            </Text>
          </Pressable>
        ) : sources.length === 0 ? (
          <Text style={{ color: colors.muted, fontSize: 13, paddingVertical: 6 }}>No alternate sources found.</Text>
        ) : (
          sources.map((s, i) => {
            const active = selectedSourceHash === s.sourceHash;
            const meta = [s.qualityLabel, s.container?.toUpperCase(), s.size, s.seeders != null ? `${s.seeders} seeders` : null].filter(Boolean).join(" · ");
            return (
              <Row
                key={`${s.sourceHash}-${i}`}
                label={s.primary || s.filename || s.provider || `Source ${i + 1}`}
                sublabel={meta || undefined}
                active={active}
                onPress={() => {
                  if (active) return;
                  selectionAsync();
                  usePlayerStore.getState().reopenWith({ sourceHash: s.sourceHash });
                  onClose();
                }}
              />
            );
          })
        )}
      </ScrollView>
    </Sheet>
  );
}
