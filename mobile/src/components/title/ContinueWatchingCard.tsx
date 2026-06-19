import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Play } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { titleHref } from "@/lib/nav";
import { type ContinueWatchingItem } from "@/lib/streamarena";
import { colors, layout } from "@/theme";

function CardItem({ item }: { item: ContinueWatchingItem }) {
  const router = useRouter();
  const w = layout.stillWidth;
  const h = layout.stillHeight;
  const onPress = () => {
    if (item.tmdbId && item.mediaType) router.push(titleHref(item.mediaType, item.tmdbId));
  };
  const label = item.episode ? `${item.title ?? ""} · ${item.episode}` : item.title ?? "";

  return (
    <PressableScale onPress={onPress} style={{ width: w }} accessibilityLabel={`Resume ${item.title ?? ""}`}>
      <View style={{ width: w, height: h, borderRadius: 6, overflow: "hidden", backgroundColor: "#1a1a1a" }}>
        <PosterImage uri={item.thumb || item.src} style={{ width: w, height: h }} />
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: "rgba(0,0,0,0.5)",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1.5,
              borderColor: "rgba(255,255,255,0.85)",
            }}
          >
            <Play size={18} color="#fff" fill="#fff" />
          </View>
        </View>
      </View>
      <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 6, width: w }}>
        {label}
      </Text>
    </PressableScale>
  );
}

export function ContinueWatchingRail({ items }: { items: ContinueWatchingItem[] }) {
  if (!items.length) return null;
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", paddingHorizontal: 16, marginBottom: 10 }}>
        Continue Watching
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {items.map((item) => (
          <CardItem key={item.sourceIdentity} item={item} />
        ))}
      </ScrollView>
    </View>
  );
}
