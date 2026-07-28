import { type ReactNode, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
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
    <View style={{ marginTop: 26, marginBottom: 8, paddingHorizontal: 4 }}>
      <Text style={{ color: colors.dim, fontSize: 11, fontWeight: "600", letterSpacing: 1.2, textTransform: "uppercase" }}>
        {children}
      </Text>
      {hint ? <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 5 }}>{hint}</Text> : null}
    </View>
  );
}

function OptionGroup({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        overflow: "hidden",
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: 0.5,
        borderColor: colors.hairline,
        backgroundColor: colors.surface,
      }}
    >
      {children}
    </View>
  );
}

function OptionRow({
  label,
  active,
  onPress,
  showDivider,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  showDivider: boolean;
}) {
  return (
    <View>
      <PressableScale
        scaleTo={1}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        style={{
          minHeight: 52,
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 13,
          paddingHorizontal: 16,
          gap: 12,
          backgroundColor: active ? colors.cardHover : "transparent",
        }}
      >
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 15, fontWeight: active ? "600" : "400" }}>
          {label}
        </Text>
        <View
          style={{
            width: 22,
            height: 22,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 11,
            borderWidth: active ? 0 : 1,
            borderColor: colors.hairline,
            backgroundColor: active ? colors.foreground : "transparent",
          }}
        >
          {active ? <Check size={14} color={colors.background} strokeWidth={3} /> : null}
        </View>
      </PressableScale>
      {showDivider ? <View style={{ height: 0.5, marginLeft: 16, backgroundColor: colors.hairline }} /> : null}
    </View>
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
        <ActivityIndicator color={colors.foreground} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: CONTENT_BOTTOM_INSET }}
    >
      <SectionTitle hint="Preferred spoken-audio language when a title offers more than one.">
        Audio language
      </SectionTitle>
      <OptionGroup>
        {AUDIO_LANG_OPTIONS.map((o, index) => (
          <OptionRow
            key={o.value}
            label={o.label}
            active={valueOf("audioLang") === o.value}
            onPress={() => choose("audioLang", o.value)}
            showDivider={index < AUDIO_LANG_OPTIONS.length - 1}
          />
        ))}
      </OptionGroup>

      <SectionTitle hint="Default subtitle track. Choose Off to start without subtitles.">Subtitles</SectionTitle>
      <OptionGroup>
        {SUBTITLE_LANG_OPTIONS.map((o, index) => (
          <OptionRow
            key={o.value}
            label={o.label}
            active={valueOf("subtitleLang") === o.value}
            onPress={() => choose("subtitleLang", o.value)}
            showDivider={index < SUBTITLE_LANG_OPTIONS.length - 1}
          />
        ))}
      </OptionGroup>

      <SectionTitle hint="Caps the source we pick. Auto always grabs the best available.">Video quality</SectionTitle>
      <OptionGroup>
        {QUALITY_OPTIONS.map((o, index) => (
          <OptionRow
            key={o.value}
            label={o.label}
            active={valueOf("quality") === o.value}
            onPress={() => choose("quality", o.value)}
            showDivider={index < QUALITY_OPTIONS.length - 1}
          />
        ))}
      </OptionGroup>

      <Text style={{ color: colors.dim, fontSize: 12, lineHeight: 17, paddingHorizontal: 4, marginTop: 24 }}>
        These preferences sync to your account and apply across your devices.
      </Text>
    </ScrollView>
  );
}
