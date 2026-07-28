import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { LiveSegmented, type LiveTab } from "@/components/live/LiveSegmented";
import { LiveTvView } from "@/components/live/LiveTvView";
import { SportsView } from "@/components/live/SportsView";
import { ScreenHeader } from "@/components/nav/ScreenHeader";
import { Screen } from "@/components/ui/Screen";

export default function LiveScreen() {
  const params = useLocalSearchParams<{ tab?: string }>();
  // Live TV is the default surface. Sports remains available through the switcher
  // and explicit `?tab=sports` deep links; legacy Twitch links fold into Live TV.
  const initial: LiveTab = params.tab === "sports" ? "sports" : "tv";
  const [tab, setTab] = useState<LiveTab>(initial);
  // Honor deep links that change ?tab= while the screen stays mounted (taps don't touch
  // the param, so this never fights user selection).
  useEffect(() => {
    if (params.tab === "sports") setTab("sports");
    else if (params.tab === "tv" || params.tab === "twitch") setTab("tv");
  }, [params.tab]);
  return (
    <Screen>
      <ScreenHeader title="Live" />
      <LiveSegmented value={tab} onChange={setTab} />
      <View style={{ flex: 1 }}>
        {tab === "sports" ? <SportsView /> : <LiveTvView />}
      </View>
    </Screen>
  );
}
