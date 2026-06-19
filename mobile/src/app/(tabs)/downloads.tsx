import { useMemo } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { AlertCircle, Check, HardDrive, Play, Settings2, Trash2 } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState } from "@/components/ui/States";
import { formatBytes } from "@/lib/disk-usage";
import { watchHref } from "@/lib/nav";
import {
  getOfflineAccountScope,
  type OfflineDownloadRecord,
  useOfflineStore,
} from "@/store/offline";
import { colors } from "@/theme";

function statusLine(record: OfflineDownloadRecord, liveBytes: number | undefined): string {
  switch (record.status) {
    case "ready":
      return formatBytes(record.bytes);
    case "downloading":
      return liveBytes && liveBytes > 0 ? `Downloading · ${formatBytes(liveBytes)}` : "Downloading…";
    case "queued":
      return "Queued";
    case "error":
      return record.error ? `Failed · tap to retry` : "Failed · tap to retry";
    default:
      return "";
  }
}

function DownloadRow({ record }: { record: OfflineDownloadRecord }) {
  const router = useRouter();
  const liveBytes = useOfflineStore((s) => s.downloadedBytes[`${record.accountScope}:${record.assetId}`]);
  const removeDownload = useOfflineStore((s) => s.removeDownload);
  const queueDownload = useOfflineStore((s) => s.queueDownload);

  const m = record.meta;
  const subtitle =
    m.mediaType === "tv" && m.seasonNumber != null && m.episodeNumber != null
      ? `S${m.seasonNumber} · E${m.episodeNumber}${m.episodeTitle ? ` · ${m.episodeTitle}` : ""}`
      : m.year || "";
  const thumb = record.posterPath || m.posterUrl || m.backdropUrl;

  function onRowPress() {
    if (record.status === "ready") {
      const params: Record<string, string> = { mediaType: m.mediaType, title: m.title };
      if (m.year) params.year = m.year;
      if (m.seasonNumber != null) params.seasonNumber = String(m.seasonNumber);
      if (m.episodeNumber != null) params.episodeNumber = String(m.episodeNumber);
      if (m.posterUrl) params.poster = m.posterUrl;
      router.push(watchHref(m.tmdbId, params));
    } else if (record.status === "error") {
      void queueDownload(m, record.scopes[0] ?? "manual");
    }
  }

  function onDelete() {
    Alert.alert("Remove download", `Delete "${m.title}" from your device?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void removeDownload(record.assetId) },
    ]);
  }

  const statusColor =
    record.status === "ready" ? colors.muted : record.status === "error" ? "#f5a524" : colors.accent;

  return (
    <PressableScale
      onPress={onRowPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}
    >
      <View style={{ width: 110, height: 62, borderRadius: 8, overflow: "hidden", backgroundColor: "#1a1a1a" }}>
        <PosterImage uri={thumb} recyclingKey={record.assetId} style={{ width: 110, height: 62 }} contentFit="cover" />
        {record.status === "ready" ? (
          <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.85)" }}>
              <Play size={13} color="#fff" fill="#fff" />
            </View>
          </View>
        ) : null}
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
          {m.title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
          {record.status === "downloading" || record.status === "queued" ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : record.status === "ready" ? (
            <Check size={13} color={colors.muted} />
          ) : record.status === "error" ? (
            <AlertCircle size={13} color="#f5a524" />
          ) : null}
          <Text style={{ color: statusColor, fontSize: 12, fontWeight: "600" }}>{statusLine(record, liveBytes)}</Text>
        </View>
      </View>

      <PressableScale onPress={record.status === "downloading" || record.status === "queued" ? () => void removeDownload(record.assetId) : onDelete} hitSlop={10} style={{ padding: 6 }} accessibilityLabel="Remove download">
        <Trash2 size={18} color={colors.muted} />
      </PressableScale>
    </PressableScale>
  );
}

export default function DownloadsScreen() {
  const router = useRouter();
  const records = useOfflineStore((s) => s.records);
  const storageBytes = useOfflineStore((s) => s.storageBytes);
  const storageLimited = useOfflineStore((s) => s.storageLimited);

  const items = useMemo(() => {
    const scope = getOfflineAccountScope();
    return Object.values(records)
      .filter((r) => r.accountScope === scope)
      .sort((a, b) => {
        // In-progress first, then most-recent.
        const rank = (s: string) => (s === "downloading" ? 0 : s === "queued" ? 1 : s === "error" ? 2 : 3);
        const d = rank(a.status) - rank(b.status);
        return d !== 0 ? d : b.updatedAt - a.updatedAt;
      });
  }, [records]);

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 28, fontWeight: "800" }}>Downloads</Text>
        <PressableScale onPress={() => router.push("/settings/storage")} hitSlop={8} accessibilityLabel="Storage settings" style={{ padding: 6 }}>
          <Settings2 size={22} color={colors.foreground} />
        </PressableScale>
      </View>

      {items.length === 0 ? (
        <EmptyState title="No downloads yet" subtitle="Tap Download on any movie or episode to watch it offline." />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
            <HardDrive size={14} color={colors.muted} />
            <Text style={{ color: colors.muted, fontSize: 13 }}>{formatBytes(storageBytes)} used by downloads</Text>
          </View>
          {storageLimited ? (
            <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, backgroundColor: "rgba(245,165,36,0.12)" }}>
              <Text style={{ color: "#f5a524", fontSize: 13, fontWeight: "600" }}>
                Storage limit reached — free space or raise the limit to continue downloading.
              </Text>
            </View>
          ) : null}
          {items.map((record) => (
            <DownloadRow key={record.assetId} record={record} />
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
