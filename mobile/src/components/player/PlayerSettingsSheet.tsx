import { Pressable, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { Sheet } from "@/components/ui/Sheet";
import { selectionAsync } from "@/lib/haptics";
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
// from the resolved source. Audio changes go through reopenWith (re-resolve, preserving
// position); subtitles toggle instantly (sideloaded VTT, no re-resolve). Switching the
// source itself lives in its own SourcesSheet, opened from the player's source button.
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
  const selectedSubtitle = usePlayerStore((s) => s.selectedSubtitle);
  const selectedAudio = usePlayerStore((s) => s.selectedAudioStreamIndex);
  // The strip-proxy embed path plays through libVLC, which has no working sideloaded-subtitle
  // wiring yet and whose audio-switch would force the title onto the anti-bot-blocked backend
  // transcode (a dead source). Suppress both controls so the sheet never offers a broken pick.
  const isVlc = usePlayerStore((s) => s.source?.engine === "vlc");

  const audioTracks = resolved?.tracks?.audioTracks ?? [];

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

      </ScrollView>
    </Sheet>
  );
}
