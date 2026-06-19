import { useEffect, useState } from "react";
import { Alert, ScrollView, Switch, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { formatBytes, getDiskUsage, type DiskUsage } from "@/lib/disk-usage";
import { selectionAsync } from "@/lib/haptics";
import { useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";

const GB = 1024 * 1024 * 1024;
const CAP_OPTIONS: { label: string; bytes: number }[] = [
  { label: "No limit", bytes: 0 },
  { label: "5 GB", bytes: 5 * GB },
  { label: "10 GB", bytes: 10 * GB },
  { label: "25 GB", bytes: 25 * GB },
  { label: "50 GB", bytes: 50 * GB },
];

function SectionTitle({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 26, marginBottom: 6, paddingHorizontal: 16 }}>
      {children}
    </Text>
  );
}

function Row({ label, sublabel, active, onPress, right }: { label: string; sublabel?: string; active?: boolean; onPress?: () => void; right?: React.ReactNode }) {
  return (
    <PressableScale
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 16, gap: 12 }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: active ? "700" : "500" }}>{label}</Text>
        {sublabel ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{sublabel}</Text> : null}
      </View>
      {right ?? (active ? <Check size={20} color={colors.accent} /> : null)}
    </PressableScale>
  );
}

export default function StorageSettingsScreen() {
  const wifiOnly = useOfflineStore((s) => s.wifiOnly);
  const maxStorageBytes = useOfflineStore((s) => s.maxStorageBytes);
  const storageBytes = useOfflineStore((s) => s.storageBytes);
  const verificationStatus = useOfflineStore((s) => s.verificationStatus);
  const verifiedDownloads = useOfflineStore((s) => s.verifiedDownloads);
  const missingDownloads = useOfflineStore((s) => s.missingDownloads);
  const setWifiOnly = useOfflineStore((s) => s.setWifiOnly);
  const setMaxStorageBytes = useOfflineStore((s) => s.setMaxStorageBytes);
  const verifyDownloads = useOfflineStore((s) => s.verifyDownloads);
  const clearDownloads = useOfflineStore((s) => s.clearDownloads);
  const refreshStorage = useOfflineStore((s) => s.refreshStorage);

  const [disk, setDisk] = useState<DiskUsage | null>(null);
  useEffect(() => {
    void refreshStorage();
    void getDiskUsage().then(setDisk);
  }, [refreshStorage]);

  const verifyLabel =
    verificationStatus === "checking"
      ? "Checking…"
      : verificationStatus === "ok"
        ? `All ${verifiedDownloads} verified`
        : verificationStatus === "repair-needed"
          ? `${missingDownloads} missing — re-downloading`
          : verificationStatus === "failed"
            ? "Verification failed"
            : "Verify downloads";

  function confirmClear() {
    Alert.alert("Clear all downloads", "Delete every downloaded movie and episode from this device?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete all", style: "destructive", onPress: () => void clearDownloads() },
    ]);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingBottom: 40 }}>
      <SectionTitle>Storage</SectionTitle>
      <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 15 }}>
          {formatBytes(storageBytes)} used by downloads
        </Text>
        {disk?.free != null ? (
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 3 }}>
            {formatBytes(disk.free)} free{disk.total != null ? ` of ${formatBytes(disk.total)}` : ""} on device
          </Text>
        ) : null}
      </View>

      <SectionTitle>Download over</SectionTitle>
      <Row
        label="Wi-Fi only"
        sublabel="Pause downloads on cellular data"
        right={
          <Switch
            value={wifiOnly}
            onValueChange={(v) => {
              selectionAsync();
              setWifiOnly(v);
            }}
            trackColor={{ true: colors.accent, false: "#3a3a3a" }}
          />
        }
      />

      <SectionTitle>Storage limit</SectionTitle>
      {CAP_OPTIONS.map((opt) => (
        <Row
          key={opt.bytes}
          label={opt.label}
          active={maxStorageBytes === opt.bytes}
          onPress={() => {
            selectionAsync();
            setMaxStorageBytes(opt.bytes);
          }}
        />
      ))}

      <SectionTitle>Maintenance</SectionTitle>
      <Row label={verifyLabel} sublabel="Check downloaded files are intact" onPress={() => void verifyDownloads()} />
      <PressableScale onPress={confirmClear} style={{ paddingVertical: 14, paddingHorizontal: 16, marginTop: 4 }}>
        <Text style={{ color: colors.accent, fontSize: 15, fontWeight: "700" }}>Clear all downloads</Text>
      </PressableScale>
    </ScrollView>
  );
}
