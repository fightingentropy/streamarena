import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Tv } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { TWITCH_SUGGESTIONS } from "@/lib/live";
import { liveRequestFromTwitch } from "@/video/live";
import { colors } from "@/theme";
import { useStartLive } from "./useStartLive";

// Pull a bare channel name out of whatever the user pastes (name, twitch.tv URL, or
// player embed URL). Mirrors the backend's accepted input forms.
function parseChannel(input: string): string {
  const raw = input.trim().replace(/^@/, "");
  const playerMatch = raw.match(/[?&]channel=([^&]+)/i);
  if (playerMatch) return playerMatch[1];
  const urlMatch = raw.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
  if (urlMatch) return urlMatch[1];
  return raw;
}

export function TwitchView() {
  const startLive = useStartLive();
  const [value, setValue] = useState("");
  const channel = parseChannel(value);
  const valid = /^[A-Za-z0-9_]{3,32}$/.test(channel);

  const watch = (name: string, label?: string) => startLive(liveRequestFromTwitch(name, label));

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 14, paddingBottom: CONTENT_BOTTOM_INSET }} keyboardShouldPersistTaps="handled">
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 10 }}>
          Enter a Twitch channel to watch its live stream.
        </Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="channel name or twitch.tv URL"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            accessibilityLabel="Twitch channel name or URL"
            onSubmitEditing={() => valid && watch(channel)}
            style={{
              flex: 1,
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 12,
              color: colors.foreground,
              fontSize: 15,
            }}
          />
          <PressableScale
            onPress={() => watch(channel)}
            disabled={!valid}
            style={{
              backgroundColor: valid ? colors.accent : colors.card,
              borderRadius: 10,
              paddingHorizontal: 20,
              alignItems: "center",
              justifyContent: "center",
              opacity: valid ? 1 : 0.6,
            }}
          >
            <Text style={{ color: valid ? colors.white : colors.muted, fontSize: 14, fontWeight: "800" }}>Watch</Text>
          </PressableScale>
        </View>
      </View>

      <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "800", marginHorizontal: 16, marginTop: 26, marginBottom: 10 }}>
        Featured
      </Text>
      {TWITCH_SUGGESTIONS.map((s) => (
        <PressableScale
          key={s.channel}
          onPress={() => watch(s.channel, s.label)}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: "#3b1d52", alignItems: "center", justifyContent: "center" }}>
            <Tv size={20} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>{s.label}</Text>
            <Text style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>twitch.tv/{s.channel}</Text>
          </View>
        </PressableScale>
      ))}
    </ScrollView>
  );
}
