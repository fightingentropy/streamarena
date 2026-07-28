import { type ReactNode, useEffect, useState } from "react";
import { Alert, ScrollView, Switch, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
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

function Row({
  label,
  sublabel,
  active,
  onPress,
  right,
  showDivider = false,
  labelColor = colors.foreground,
}: {
  label: string;
  sublabel?: string;
  active?: boolean;
  onPress?: () => void;
  right?: ReactNode;
  showDivider?: boolean;
  labelColor?: string;
}) {
  return (
    <View>
      <PressableScale
        scaleTo={onPress ? 0.985 : 1}
        onPress={onPress}
        accessibilityLabel={onPress ? (sublabel ? `${label}. ${sublabel}` : label) : undefined}
        accessibilityState={active == null ? undefined : { selected: active }}
        style={{
          minHeight: 54,
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 13,
          paddingHorizontal: 16,
          gap: 12,
          backgroundColor: active ? colors.cardHover : "transparent",
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: labelColor, fontSize: 15, fontWeight: active ? "600" : "500" }}>{label}</Text>
          {sublabel ? (
            <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 2 }}>{sublabel}</Text>
          ) : null}
        </View>
        {right ??
          (active == null ? null : (
            <View
              style={{
                width: 22,
                height: 22,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 11,
                borderWidth: active ? 0 : 1,
                borderColor: colors.hairline,
                backgroundColor: active ? colors.foreground : "transparent",
              }}
            >
              {active ? <Check size={14} color={colors.background} strokeWidth={3} /> : null}
            </View>
          ))}
      </PressableScale>
      {showDivider ? <View style={{ height: 0.5, marginLeft: 16, backgroundColor: colors.hairline }} /> : null}
    </View>
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

  const storageRatio = maxStorageBytes > 0 ? Math.min(storageBytes / maxStorageBytes, 1) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: CONTENT_BOTTOM_INSET }}
    >
      <SectionTitle>Storage</SectionTitle>
      <Group>
        <View style={{ paddingHorizontal: 16, paddingVertical: 16 }}>
          <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>
            {formatBytes(storageBytes)} used
          </Text>
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 }}>
            {disk?.free != null
              ? `${formatBytes(disk.free)} free${disk.total != null ? ` of ${formatBytes(disk.total)}` : ""} on device`
              : "Used by downloaded movies and episodes"}
          </Text>
          {storageRatio != null ? (
            <View
              style={{
                height: 4,
                overflow: "hidden",
                borderRadius: 2,
                backgroundColor: colors.cardActive,
                marginTop: 14,
              }}
            >
              <View
                style={{
                  width: `${storageRatio * 100}%`,
                  height: "100%",
                  borderRadius: 2,
                  backgroundColor: colors.foreground,
                }}
              />
            </View>
          ) : null}
        </View>
      </Group>

      <SectionTitle>Download over</SectionTitle>
      <Group>
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
              trackColor={{ true: colors.foreground, false: colors.surfaceRaised }}
              thumbColor={wifiOnly ? colors.background : colors.foreground}
              ios_backgroundColor={colors.surfaceRaised}
              accessibilityLabel="Wi-Fi only downloads"
              accessibilityHint="Pauses downloads while using cellular data"
            />
          }
        />
      </Group>

      <SectionTitle>Storage limit</SectionTitle>
      <Group>
        {CAP_OPTIONS.map((opt, index) => (
          <Row
            key={opt.bytes}
            label={opt.label}
            active={maxStorageBytes === opt.bytes}
            showDivider={index < CAP_OPTIONS.length - 1}
            onPress={() => {
              selectionAsync();
              setMaxStorageBytes(opt.bytes);
            }}
          />
        ))}
      </Group>

      <SectionTitle>Maintenance</SectionTitle>
      <Group>
        <Row
          label={verifyLabel}
          labelColor={verificationStatus === "failed" ? colors.danger : colors.foreground}
          sublabel="Check downloaded files are intact"
          onPress={() => void verifyDownloads()}
          showDivider
        />
        <PressableScale
          scaleTo={1}
          onPress={confirmClear}
          accessibilityLabel="Clear all downloads"
          accessibilityHint="Deletes every downloaded movie and episode from this device"
          style={{ minHeight: 52, justifyContent: "center", paddingVertical: 13, paddingHorizontal: 16 }}
        >
          <Text style={{ color: colors.danger, fontSize: 15, fontWeight: "600" }}>Clear all downloads</Text>
        </PressableScale>
      </Group>
    </ScrollView>
  );
}
