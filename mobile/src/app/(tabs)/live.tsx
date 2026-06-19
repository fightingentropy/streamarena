import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { LiveSegmented, type LiveTab } from "@/components/live/LiveSegmented";
import { LiveTvView } from "@/components/live/LiveTvView";
import { SportsView } from "@/components/live/SportsView";
import { Screen } from "@/components/ui/Screen";
import { colors } from "@/theme";

export default function LiveScreen() {
  const params = useLocalSearchParams<{ tab?: string }>();
  // Twitch folded into Live TV — keep `?tab=twitch` deep links working by mapping to "tv".
  const initial: LiveTab = params.tab === "tv" || params.tab === "twitch" ? "tv" : "sports";
  const [tab, setTab] = useState<LiveTab>(initial);
  // Honor deep links that change ?tab= while the screen stays mounted (taps don't touch
  // the param, so this never fights user selection).
  useEffect(() => {
    if (params.tab === "sports") setTab("sports");
    else if (params.tab === "tv" || params.tab === "twitch") setTab("tv");
  }, [params.tab]);
  return (
    <Screen>
      <Text style={{ color: colors.foreground, fontSize: 28, fontWeight: "800", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 }}>
        Live
      </Text>
      <LiveSegmented value={tab} onChange={setTab} />
      <View style={{ flex: 1, marginTop: 8 }}>
        {tab === "sports" ? <SportsView /> : <LiveTvView />}
      </View>
    </Screen>
  );
}
