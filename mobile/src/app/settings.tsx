import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { ChevronRight, HardDrive, Magnet, SlidersHorizontal } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAuth } from "@/lib/auth";
import { API_ORIGIN } from "@/lib/config";
import { selectionAsync } from "@/lib/haptics";
import { getTorrentSettings, setTorrentStreamingEnabled } from "@/lib/streamarena";
import { colors } from "@/theme";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between px-5 py-3.5">
      <Text style={{ color: colors.muted }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: colors.foreground, maxWidth: "60%" }}>
        {value}
      </Text>
    </View>
  );
}

function NavRow({ icon, label, sublabel, onPress }: { icon: React.ReactNode; label: string; sublabel: string; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 14 }}
    >
      <View style={{ width: 30, alignItems: "center" }}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>{label}</Text>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>{sublabel}</Text>
      </View>
      <ChevronRight size={20} color={colors.muted} />
    </PressableScale>
  );
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [torrentEnabled, setTorrentEnabled] = useState<boolean | null>(null);
  const [torrentSaving, setTorrentSaving] = useState(false);
  const [torrentError, setTorrentError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getTorrentSettings()
      .then((settings) => {
        if (!cancelled) setTorrentEnabled(settings.localTorrentEnabled);
      })
      .catch((error) => {
        if (!cancelled) setTorrentError(error instanceof Error ? error.message : "Couldn’t load torrent settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTorrentStreaming = (enabled: boolean) => {
    if (torrentEnabled == null || torrentSaving) return;
    const previous = torrentEnabled;
    selectionAsync();
    setTorrentEnabled(enabled);
    setTorrentSaving(true);
    setTorrentError("");
    void setTorrentStreamingEnabled(enabled)
      .then((settings) => setTorrentEnabled(settings.localTorrentEnabled))
      .catch((error) => {
        setTorrentEnabled(previous);
        setTorrentError(error instanceof Error ? error.message : "Couldn’t update torrent streaming.");
      })
      .finally(() => setTorrentSaving(false));
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingVertical: 12 }}>
      <Text className="px-5 pb-2 pt-3 text-xs font-semibold uppercase" style={{ color: colors.muted }}>
        Account
      </Text>
      <Row label="Signed in as" value={user?.email || "—"} />
      <Row label="Name" value={user?.displayName || "—"} />

      <Text className="px-5 pb-2 pt-6 text-xs font-semibold uppercase" style={{ color: colors.muted }}>
        Preferences
      </Text>
      <NavRow
        icon={<SlidersHorizontal size={20} color={colors.foreground} />}
        label="Playback"
        sublabel="Audio language, subtitles, quality"
        onPress={() => router.push("/settings/playback")}
      />
      <NavRow
        icon={<HardDrive size={20} color={colors.foreground} />}
        label="Storage & downloads"
        sublabel="Wi-Fi-only, storage limit, manage files"
        onPress={() => router.push("/settings/storage")}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 14 }}>
        <View style={{ width: 30, alignItems: "center" }}>
          <Magnet size={20} color={colors.foreground} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Torrent streaming</Text>
          <Text style={{ color: torrentError ? colors.accent : colors.muted, fontSize: 12, marginTop: 1 }}>
            {torrentError || "Find magnets and stream them through your Mini"}
          </Text>
        </View>
        {torrentEnabled == null || torrentSaving ? (
          <ActivityIndicator size="small" color={colors.muted} />
        ) : (
          <Switch
            value={torrentEnabled}
            onValueChange={toggleTorrentStreaming}
            trackColor={{ true: colors.accent, false: "#3a3a3a" }}
            accessibilityLabel="Torrent streaming"
          />
        )}
      </View>

      <Text className="px-5 pb-2 pt-6 text-xs font-semibold uppercase" style={{ color: colors.muted }}>
        Connection
      </Text>
      <Row label="API origin" value={API_ORIGIN} />
      <Row label="App version" value={String(Constants.expoConfig?.version ?? "1.0.0")} />

      <View className="px-5 pt-8">
        <PressableScale
          onPress={() => void signOut()}
          className="items-center rounded-full py-3.5"
          style={{ backgroundColor: "#1f1f1f" }}
        >
          <Text className="text-base font-semibold" style={{ color: colors.accent }}>
            Log out
          </Text>
        </PressableScale>
      </View>
    </ScrollView>
  );
}
