import { useCallback, useState } from "react";
import { ActivityIndicator, Alert } from "react-native";
import { AlertCircle, Check, Download, X } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { DownloadProgressRing, downloadRingFill } from "@/components/ui/DownloadProgressRing";
import { DetailAction } from "@/components/title/ActionRow";
import { formatBytes } from "@/lib/disk-usage";
import { selectionAsync } from "@/lib/haptics";
import {
  type DownloadScope,
  type OfflineMeta,
  useOfflineStore,
  useTitleDownload,
} from "@/store/offline";
import { colors } from "@/theme";

type Props = {
  assetId: string;
  // Lazily resolves the source + builds the OfflineMeta (does the network resolve on tap).
  getMeta: () => Promise<OfflineMeta>;
  variant?: "action" | "icon";
  scope?: DownloadScope;
};

// Drives the download lifecycle for one asset: tap to start (resolve → queue), tap again
// to cancel an in-flight download, tap a finished one to delete, tap a failed one to
// retry. Shares the store's per-asset state via useTitleDownload so every surface (movie
// action, episode row, downloads screen) reflects the same status.
export function DownloadButton({ assetId, getMeta, variant = "action", scope = "manual" }: Props) {
  const dl = useTitleDownload(assetId);
  const [preparing, setPreparing] = useState(false);
  const queueDownload = useOfflineStore((s) => s.queueDownload);
  const removeDownload = useOfflineStore((s) => s.removeDownload);

  const start = useCallback(async () => {
    setPreparing(true);
    try {
      const meta = await getMeta();
      await queueDownload(meta, scope);
    } catch (e) {
      Alert.alert("Download", e instanceof Error ? e.message : "Couldn't start the download.");
    } finally {
      setPreparing(false);
    }
  }, [getMeta, queueDownload, scope]);

  const onPress = useCallback(() => {
    if (preparing) return;
    selectionAsync();
    switch (dl.status) {
      case "idle":
      case "error":
        void start();
        break;
      case "queued":
      case "downloading":
        void removeDownload(assetId);
        break;
      case "ready":
        Alert.alert("Remove download", "Delete this download from your device?", [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => void removeDownload(assetId) },
        ]);
        break;
    }
  }, [preparing, dl.status, start, removeDownload, assetId]);

  const busy = preparing || dl.status === "queued" || dl.status === "downloading";

  // Resolve the icon + label for the current state.
  let icon: React.ReactNode;
  let label: string;
  let active = false;
  if (preparing || dl.status === "queued") {
    icon = <ActivityIndicator size="small" color={colors.muted} />;
    label = "Queued";
  } else if (dl.status === "downloading") {
    icon = (
      <DownloadProgressRing
        progress={downloadRingFill(dl.status, dl.progress, dl.bytes)}
        size={variant === "icon" ? 24 : 28}
        strokeWidth={variant === "icon" ? 2.5 : 3}
      />
    );
    label = dl.bytes > 0 ? formatBytes(dl.bytes) : "Downloading";
    active = true;
  } else if (dl.status === "ready") {
    icon = <Check size={variant === "icon" ? 20 : 26} color={colors.accent} />;
    label = "Downloaded";
    active = true;
  } else if (dl.status === "error") {
    icon = <AlertCircle size={variant === "icon" ? 20 : 26} color="#f5a524" />;
    label = "Retry";
  } else {
    icon = <Download size={variant === "icon" ? 20 : 26} color={colors.foreground} />;
    label = "Download";
  }

  if (variant === "icon") {
    return (
      <PressableScale
        onPress={onPress}
        accessibilityLabel={`${label} ${assetId}`}
        hitSlop={8}
        style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}
      >
        {busy && dl.status === "downloading" ? (
          // Filling progress ring with a cancel ✕ in the center.
          <DownloadProgressRing progress={downloadRingFill(dl.status, dl.progress, dl.bytes)} size={30} strokeWidth={2.5}>
            <X size={12} color={colors.muted} />
          </DownloadProgressRing>
        ) : (
          icon
        )}
      </PressableScale>
    );
  }

  return <DetailAction icon={icon} label={label} onPress={onPress} active={active} />;
}
