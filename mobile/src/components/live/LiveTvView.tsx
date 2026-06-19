import { ScrollView, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { type LiveChannel, LIVE_CHANNELS } from "@/lib/live-channels";
import { liveRequestFromChannel } from "@/video/live";
import { colors } from "@/theme";
import { useStartLive } from "./useStartLive";

// Dim genre tints so the grid reads at a glance without bundling channel logos.
const GENRE_TINT: Record<string, [string, string]> = {
  News: ["#1e3a5f", "#0f1b2e"],
  Business: ["#5a4410", "#241b07"],
  Sports: ["#14532d", "#0a2417"],
  General: ["#3b1d52", "#1a0e26"],
};

function ChannelTile({ channel, onPlay }: { channel: LiveChannel; onPlay: (c: LiveChannel) => void }) {
  const tint = GENRE_TINT[channel.genre] ?? ["#2a2a2a", "#141414"];
  return (
    <PressableScale onPress={() => onPlay(channel)} style={{ width: "48%" }} accessibilityLabel={`Play ${channel.title}`}>
      <LinearGradient
        colors={tint}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ height: 104, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 14, justifyContent: "space-between" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
          <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>LIVE</Text>
        </View>
        <View>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 16, fontWeight: "800" }}>
            {channel.title}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>
            {channel.genre} · {channel.region}
          </Text>
        </View>
      </LinearGradient>
    </PressableScale>
  );
}

export function LiveTvView() {
  const startLive = useStartLive();
  const onPlay = (c: LiveChannel) => startLive(liveRequestFromChannel(c));
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 12, paddingBottom: CONTENT_BOTTOM_INSET }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12, paddingHorizontal: 16 }}>
        {LIVE_CHANNELS.map((channel) => (
          <ChannelTile key={channel.id} channel={channel} onPlay={onPlay} />
        ))}
      </View>
    </ScrollView>
  );
}
