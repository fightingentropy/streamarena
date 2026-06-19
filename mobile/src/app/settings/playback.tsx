import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAccountScopeOrNull } from "@/lib/auth";
import { selectionAsync } from "@/lib/haptics";
import {
  AUDIO_LANG_OPTIONS,
  putPreferences,
  QUALITY_OPTIONS,
  SUBTITLE_LANG_OPTIONS,
  usePreferences,
} from "@/lib/streamarena";
import { colors } from "@/theme";

function SectionTitle({ children, hint }: { children: string; hint?: string }) {
  return (
    <View style={{ marginTop: 26, marginBottom: 6, paddingHorizontal: 16 }}>
      <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" }}>
        {children}
      </Text>
      {hint ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>{hint}</Text> : null}
    </View>
  );
}

function OptionRow({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 16, gap: 12 }}
    >
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 15, fontWeight: active ? "700" : "500" }}>{label}</Text>
      {active ? <Check size={20} color={colors.accent} /> : null}
    </PressableScale>
  );
}

export default function PlaybackSettingsScreen() {
  const scope = useAccountScopeOrNull();
  const { data, loading } = usePreferences(scope);
  // Optimistic overrides so a tapped row reflects instantly while the PUT round-trips.
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const valueOf = (key: string) => overrides[key] ?? data[key] ?? "auto";

  const choose = (key: string, value: string) => {
    if (valueOf(key) === value) return;
    selectionAsync();
    setOverrides((o) => ({ ...o, [key]: value }));
    void putPreferences({ [key]: value }, scope ?? undefined).catch(() => {
      // Roll back the optimistic value if the write fails.
      setOverrides((o) => {
        const next = { ...o };
        delete next[key];
        return next;
      });
    });
  };

  if (loading && Object.keys(data).length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 60 }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingBottom: 40 }}>
      <SectionTitle hint="Preferred spoken-audio language when a title offers more than one.">
        Audio language
      </SectionTitle>
      {AUDIO_LANG_OPTIONS.map((o) => (
        <OptionRow key={o.value} label={o.label} active={valueOf("audioLang") === o.value} onPress={() => choose("audioLang", o.value)} />
      ))}

      <SectionTitle hint="Default subtitle track. Choose Off to start without subtitles.">Subtitles</SectionTitle>
      {SUBTITLE_LANG_OPTIONS.map((o) => (
        <OptionRow
          key={o.value}
          label={o.label}
          active={valueOf("subtitleLang") === o.value}
          onPress={() => choose("subtitleLang", o.value)}
        />
      ))}

      <SectionTitle hint="Caps the source we pick. Auto always grabs the best available.">Video quality</SectionTitle>
      {QUALITY_OPTIONS.map((o) => (
        <OptionRow key={o.value} label={o.label} active={valueOf("quality") === o.value} onPress={() => choose("quality", o.value)} />
      ))}

      <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 16, marginTop: 26 }}>
        These preferences sync to your account and apply across your devices.
      </Text>
    </ScrollView>
  );
}
