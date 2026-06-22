import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { type LiveChannel, LIVE_CHANNELS } from "@/lib/live-channels";
import { LIVE_LOGOS } from "@/lib/live-logos";
import { liveRequestFromChannel } from "@/video/live";
import { colors } from "@/theme";
import { useStartLive } from "./useStartLive";

const LIVE_CATEGORY_ORDER = ["Sports", "News", "General", "Business"];

// Chip list from the genres actually present, in a friendly order (mirrors the web grid).
function liveCategories(): string[] {
  const present = new Set<string>();
  for (const channel of LIVE_CHANNELS) {
    if (channel.genre) present.add(channel.genre);
  }
  const ordered = LIVE_CATEGORY_ORDER.filter((genre) => present.has(genre));
  for (const genre of present) {
    if (!ordered.includes(genre)) ordered.push(genre);
  }
  return ["All", ...ordered];
}

function CategoryChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} accessibilityLabel={`Filter by ${label}`}>
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 999,
          borderWidth: 1,
          backgroundColor: active ? "#fff" : "rgba(255,255,255,0.06)",
          borderColor: active ? "#fff" : "rgba(255,255,255,0.18)",
        }}
      >
        <Text style={{ color: active ? "#0b0b0b" : colors.foreground, fontSize: 13, fontWeight: "700" }}>{label}</Text>
      </View>
    </PressableScale>
  );
}

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
  const categories = liveCategories();
  const [activeCategory, setActiveCategory] = useState("All");
  const channels =
    activeCategory === "All"
      ? LIVE_CHANNELS
      : LIVE_CHANNELS.filter((channel) => channel.genre === activeCategory);
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 12, paddingBottom: CONTENT_BOTTOM_INSET }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 14 }}
      >
        {categories.map((category) => (
          <CategoryChip
            key={category}
            label={category}
            active={category === activeCategory}
            onPress={() => setActiveCategory(category)}
          />
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12, paddingHorizontal: 16 }}>
        {channels.map((channel) => (
          <ChannelTile key={channel.id} channel={channel} onPlay={onPlay} />
        ))}
      </View>
    </ScrollView>
  );
}
