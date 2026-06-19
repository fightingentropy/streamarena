import { ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { type LiveChannel, LIVE_CHANNELS } from "@/lib/live-channels";
import { LIVE_LOGOS } from "@/lib/live-logos";
import { liveRequestFromChannel } from "@/video/live";
import { colors } from "@/theme";
import { useStartLive } from "./useStartLive";

function ChannelTile({ channel, onPlay }: { channel: LiveChannel; onPlay: (c: LiveChannel) => void }) {
  const logo = LIVE_LOGOS[channel.id];
  return (
    <PressableScale onPress={() => onPlay(channel)} style={{ width: "48%" }} accessibilityLabel={`Play ${channel.title}`}>
      <View style={{ borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card }}>
        {/* Logo on a dark plate (contain, like the web grid). */}
        <View style={{ aspectRatio: 16 / 9, backgroundColor: "#0b0b0b", alignItems: "center", justifyContent: "center" }}>
          {logo ? (
            <Image source={logo} style={{ width: "100%", height: "100%" }} contentFit="contain" transition={150} />
          ) : null}
          <View
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              backgroundColor: "rgba(0,0,0,0.55)",
              paddingHorizontal: 7,
              paddingVertical: 3,
              borderRadius: 6,
            }}
          >
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
            <Text style={{ color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 }}>LIVE</Text>
          </View>
        </View>
        <View style={{ paddingHorizontal: 11, paddingVertical: 9 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, fontWeight: "800" }}>
            {channel.title}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>
            {channel.genre} · {channel.region}
          </Text>
        </View>
      </View>
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
