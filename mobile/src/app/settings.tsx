import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { ChevronRight, HardDrive, Magnet, SlidersHorizontal } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { useAuth } from "@/lib/auth";
import { API_ORIGIN } from "@/lib/config";
import { selectionAsync } from "@/lib/haptics";
import { getTorrentSettings, setTorrentStreamingEnabled } from "@/lib/streamarena";
import { colors } from "@/theme";

function SectionTitle({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.dim,
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 1.2,
        textTransform: "uppercase",
        marginTop: 26,
        marginBottom: 8,
        paddingHorizontal: 4,
      }}
    >
      {children}
    </Text>
  );
}

function Group({ children }: { children: ReactNode }) {
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

function Divider({ inset = 16 }: { inset?: number }) {
  return <View style={{ height: 0.5, marginLeft: inset, backgroundColor: colors.hairline }} />;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 20, paddingHorizontal: 16, paddingVertical: 13 }}>
      <Text style={{ color: colors.muted, fontSize: 14 }}>{label}</Text>
      <Text
        numberOfLines={1}
        style={{ color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600", textAlign: "right" }}
      >
        {value}
      </Text>
    </View>
  );
}

function NavRow({ icon, label, sublabel, onPress }: { icon: ReactNode; label: string; sublabel: string; onPress: () => void }) {
  return (
    <PressableScale
      scaleTo={1}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${sublabel}`}
      style={{ minHeight: 68, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12 }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 11,
          borderCurve: "continuous",
          backgroundColor: colors.cardActive,
        }}
      >
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{label}</Text>
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>
          {sublabel}
        </Text>
      </View>
      <ChevronRight size={18} color={colors.dim} strokeWidth={2} />
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
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: CONTENT_BOTTOM_INSET }}
    >
      <SectionTitle>Account</SectionTitle>
      <Group>
        <InfoRow label="Signed in as" value={user?.email || "—"} />
        <Divider />
        <InfoRow label="Name" value={user?.displayName || "—"} />
      </Group>

      <SectionTitle>Preferences</SectionTitle>
      <Group>
        <NavRow
          icon={<SlidersHorizontal size={19} color={colors.foreground} />}
          label="Playback"
          sublabel="Audio language, subtitles, quality"
          onPress={() => router.push("/settings/playback")}
        />
        <Divider inset={66} />
        <NavRow
          icon={<HardDrive size={19} color={colors.foreground} />}
          label="Storage & downloads"
          sublabel="Wi-Fi-only, storage limit, manage files"
          onPress={() => router.push("/settings/storage")}
        />
        <Divider inset={66} />
        <View style={{ minHeight: 68, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12 }}>
          <View
            style={{
              width: 36,
              height: 36,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 11,
              borderCurve: "continuous",
              backgroundColor: colors.cardActive,
            }}
          >
            <Magnet size={19} color={colors.foreground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>Torrent streaming</Text>
            <Text
              numberOfLines={2}
              style={{ color: torrentError ? colors.danger : colors.muted, fontSize: 12, lineHeight: 16, marginTop: 2 }}
            >
              {torrentError || "Find magnets and stream them through your Mini"}
            </Text>
          </View>
          {torrentEnabled == null || torrentSaving ? (
            <ActivityIndicator size="small" color={colors.foreground} />
          ) : (
            <Switch
              value={torrentEnabled}
              onValueChange={toggleTorrentStreaming}
              trackColor={{ true: colors.foreground, false: colors.surfaceRaised }}
              thumbColor={torrentEnabled ? colors.background : colors.foreground}
              ios_backgroundColor={colors.surfaceRaised}
              accessibilityLabel="Torrent streaming"
              accessibilityHint="Controls local torrent streaming through your Mini"
            />
          )}
        </View>
      </Group>

      <SectionTitle>Connection</SectionTitle>
      <Group>
        <InfoRow label="API origin" value={API_ORIGIN} />
        <Divider />
        <InfoRow label="App version" value={String(Constants.expoConfig?.version ?? "1.0.0")} />
      </Group>

      <View style={{ paddingTop: 32 }}>
        <PressableScale
          onPress={() => void signOut()}
          accessibilityLabel="Log out"
          style={{
            height: 52,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 14,
            borderCurve: "continuous",
            borderWidth: 0.5,
            borderColor: colors.hairline,
            backgroundColor: colors.surface,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 16, fontWeight: "600" }}>
            Log out
          </Text>
        </PressableScale>
      </View>
    </ScrollView>
  );
}
