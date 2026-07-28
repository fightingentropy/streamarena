import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { Sheet } from "@/components/ui/Sheet";
import { selectionAsync } from "@/lib/haptics";
import { usePlayerStore } from "@/video/state";
import { colors } from "@/theme";

// In-player live source switcher: lists the channel/match's stream options and re-resolves
// the chosen one (switchLiveSource). The active option is checked.
export function LiveSourcesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const liveSources = usePlayerStore((s) => s.liveSources);
  const selectedLiveSourceId = usePlayerStore((s) => s.selectedLiveSourceId);

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.5} zIndex={120}>
      <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700", letterSpacing: -0.25, marginHorizontal: 20, marginTop: 6, marginBottom: 4 }}>Streams</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginHorizontal: 20, marginBottom: 14 }}>
        Pick a source if the current one stalls or buffers.
      </Text>
      {liveSources.map((opt) => {
        const active = opt.id === selectedLiveSourceId;
        return (
          <Pressable
            key={opt.id}
            onPress={() => {
              selectionAsync();
              if (!active) usePlayerStore.getState().switchLiveSource(opt.id);
              onClose();
            }}
            style={{ flexDirection: "row", alignItems: "center", minHeight: 54, paddingVertical: 10, paddingHorizontal: 20, gap: 12, borderBottomWidth: 0.5, borderBottomColor: colors.line }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <View style={{ width: 22, alignItems: "center" }}>{active ? <Check size={20} color={colors.accent} /> : null}</View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: active ? "700" : "500" }}>{opt.label}</Text>
              {opt.quality ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>{opt.quality}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </Sheet>
  );
}
