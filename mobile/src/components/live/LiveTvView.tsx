import { useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
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
    <PressableScale
      onPress={onPress}
      accessibilityLabel={`Filter by ${label}`}
      accessibilityState={{ selected: active }}
      style={{
        minHeight: 42,
        marginRight: 22,
        paddingHorizontal: 2,
        alignItems: "center",
        justifyContent: "center",
        borderBottomWidth: 1.5,
        borderBottomColor: active ? colors.foreground : "transparent",
      }}
    >
      <Text
        style={{
          color: active ? colors.foreground : colors.muted,
          fontSize: 14,
          fontWeight: active ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

function ChannelTile({
  channel,
  onPlay,
  width,
}: {
  channel: LiveChannel;
  onPlay: (c: LiveChannel) => void;
  width: number;
}) {
  const logo = LIVE_LOGOS[channel.id];
  return (
    <PressableScale onPress={() => onPlay(channel)} style={{ width }} accessibilityLabel={`Play ${channel.title}`}>
      {/* The logo is the card's colour; everything around it stays neutral. */}
      <View
        style={{
          aspectRatio: 16 / 9,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          borderRadius: 10,
          borderCurve: "continuous",
          borderWidth: 0.5,
          borderColor: colors.hairline,
          backgroundColor: colors.background,
        }}
      >
        {logo ? (
          <Image source={logo} style={{ width: "100%", height: "100%" }} contentFit="contain" transition={150} />
        ) : null}
      </View>
      <View style={{ paddingTop: 9, paddingHorizontal: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: colors.foreground, fontSize: 15, lineHeight: 20, fontWeight: "700" }}
        >
          {channel.title}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 1 }}>
          {channel.genre} · {channel.region}
        </Text>
      </View>
    </PressableScale>
  );
}

export function LiveTvView() {
  const { width } = useWindowDimensions();
  const startLive = useStartLive();
  const onPlay = (c: LiveChannel) => startLive(liveRequestFromChannel(c));
  const categories = liveCategories();
  const [activeCategory, setActiveCategory] = useState("All");
  const channels =
    activeCategory === "All"
      ? LIVE_CHANNELS
      : LIVE_CHANNELS.filter((channel) => channel.genre === activeCategory);
  const columns = width >= 1024 ? 4 : width >= 700 ? 3 : 2;
  const horizontalPadding = width >= 700 ? 20 : 16;
  const columnGap = width >= 700 ? 16 : 12;
  const tileWidth = Math.floor(
    (width - horizontalPadding * 2 - columnGap * (columns - 1)) / columns,
  );
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingTop: 4, paddingBottom: CONTENT_BOTTOM_INSET }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
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
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          columnGap,
          rowGap: 22,
          paddingHorizontal: horizontalPadding,
        }}
      >
        {channels.map((channel) => (
          <ChannelTile key={channel.id} channel={channel} onPlay={onPlay} width={tileWidth} />
        ))}
      </View>
    </ScrollView>
  );
}
