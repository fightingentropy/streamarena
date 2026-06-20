import { type ReactNode, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Check, Download as DownloadIcon, Info, Play, Plus, Trash2 } from "lucide-react-native";
import { PosterImage } from "@/components/PosterImage";
import { useAccountScopeOrNull, useSignedIn } from "@/lib/auth";
import { buildResumeHref, playRequestFromCW } from "@/lib/continue-watching";
import { formatBytes } from "@/lib/disk-usage";
import { selectionAsync } from "@/lib/haptics";
import { titleHref } from "@/lib/nav";
import { type ContinueWatchingItem, type MediaType } from "@/lib/streamarena";
import { buildMyListItem, myListIdentity, useIsSaved, useMyListStore } from "@/store/mylist";
import { useOfflineStore, useTitleDownload } from "@/store/offline";
import { resolveOfflineMeta } from "@/video/download";
import { progressIdentity } from "@/video/identity";
import { colors } from "@/theme";

type Props = {
  item: ContinueWatchingItem | null;
  onClose: () => void;
  // Remove from Continue Watching. The host owns the list (optimistic hide + server delete +
  // refetch) so the rail updates without leaving Home.
  onRemove: (item: ContinueWatchingItem) => void;
};

// Long-press context menu for a Continue Watching card: resume, toggle My List, download the
// exact movie/episode, view details, or remove from the rail. Rendered in a React Native
// Modal (its own window) so it floats above the global <TabBar/>, which an in-tree overlay
// would sit behind.
export function ContinueWatchingActionsSheet({ item, onClose, onRemove }: Props) {
  // Retain the last item so the menu still renders content through the Modal's fade-out.
  const [data, setData] = useState<ContinueWatchingItem | null>(item);
  useEffect(() => {
    if (item) setData(item);
  }, [item]);

  return (
    <Modal
      transparent
      visible={item != null}
      animationType="fade"
      statusBarTranslucent
      // The app allows every orientation; without this the Modal's host VC defaults to
      // portrait-only and UIKit aborts ("no common orientation") if the menu is open in
      // landscape (e.g. the user rotated Home).
      supportedOrientations={["portrait", "portrait-upside-down", "landscape"]}
      onRequestClose={onClose}
    >
      {data ? <MenuContent item={data} onClose={onClose} onRemove={onRemove} /> : null}
    </Modal>
  );
}

function MenuContent({ item, onClose, onRemove }: { item: ContinueWatchingItem } & Pick<Props, "onClose" | "onRemove">) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const signedIn = useSignedIn();
  const accountScope = useAccountScopeOrNull();
  const mediaType: MediaType = item.mediaType === "tv" ? "tv" : "movie";

  // ─── My List ───
  const saved = useIsSaved(myListIdentity(mediaType, item.tmdbId ?? ""));
  const toggleList = useMyListStore((s) => s.toggle);
  useEffect(() => {
    useMyListStore.getState().hydrate(accountScope);
  }, [accountScope]);

  // ─── Download (keyed identically to the title screen so state is shared) ───
  const req = playRequestFromCW(item);
  const assetId = req ? progressIdentity(req) : "";
  const dl = useTitleDownload(assetId);
  const queueDownload = useOfflineStore((s) => s.queueDownload);
  const removeDownload = useOfflineStore((s) => s.removeDownload);
  const [preparing, setPreparing] = useState(false);

  const resumeHref = buildResumeHref(item);

  const onResume = () => {
    selectionAsync();
    onClose();
    if (resumeHref) router.push(resumeHref);
  };

  const onDetails = () => {
    selectionAsync();
    onClose();
    if (item.tmdbId) router.push(titleHref(mediaType, item.tmdbId));
  };

  const onToggleList = () => {
    if (!item.tmdbId) return;
    selectionAsync();
    toggleList(
      buildMyListItem({ tmdbId: item.tmdbId, mediaType, title: item.title ?? "", year: item.year, posterPath: item.thumb }),
    );
  };

  const onDownload = () => {
    if (!req || preparing) return;
    selectionAsync();
    switch (dl.status) {
      case "idle":
      case "error":
        setPreparing(true);
        resolveOfflineMeta(req, {
          title: item.title ?? "",
          year: item.year,
          episodeTitle: mediaType === "tv" ? item.episode || undefined : undefined,
          posterUrl: item.thumb || undefined,
          backdropUrl: item.thumb || undefined,
        })
          .then((meta) => queueDownload(meta, "manual"))
          .catch((e) => Alert.alert("Download", e instanceof Error ? e.message : "Couldn't start the download."))
          .finally(() => setPreparing(false));
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
  };

  // Download row presentation, mirroring DownloadButton's lifecycle labels.
  let dlIcon: ReactNode = <DownloadIcon size={22} color={colors.foreground} />;
  let dlLabel = "Download";
  let dlSub: string | undefined;
  if (preparing || dl.status === "queued") {
    dlIcon = <ActivityIndicator size="small" color={colors.muted} />;
    dlLabel = "Queued";
  } else if (dl.status === "downloading") {
    dlIcon = <ActivityIndicator size="small" color={colors.accent} />;
    dlLabel = "Downloading";
    dlSub = dl.bytes > 0 ? `${formatBytes(dl.bytes)} · tap to cancel` : "tap to cancel";
  } else if (dl.status === "ready") {
    dlIcon = <Check size={22} color={colors.accent} />;
    dlLabel = "Downloaded";
    dlSub = "tap to delete";
  } else if (dl.status === "error") {
    dlIcon = <DownloadIcon size={22} color="#f5a524" />;
    dlLabel = "Retry download";
  }

  const subtitle = item.episode || item.year || (mediaType === "tv" ? "Series" : "Movie");
  // In landscape the menu becomes a centered card (full-width panels get clipped by the
  // Dynamic Island / rounded corners) — same treatment as the player sheets.
  const panelWidth = landscape ? Math.min(width * 0.62, 460) : undefined;

  return (
    <View style={[StyleSheet.absoluteFill, { justifyContent: "flex-end", alignItems: landscape ? "center" : "stretch" }]}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />
      <View
        style={{
          width: panelWidth,
          backgroundColor: colors.surface,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderBottomLeftRadius: landscape ? 18 : 0,
          borderBottomRightRadius: landscape ? 18 : 0,
          marginBottom: landscape ? insets.bottom + 12 : 0,
          paddingBottom: landscape ? 8 : insets.bottom + 8,
          overflow: "hidden",
        }}
      >
        <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 4 }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.3)" }} />
        </View>

        {/* Header: poster + title */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 12 }}>
          <View style={{ width: 46, height: 64, borderRadius: 6, overflow: "hidden", backgroundColor: "#1a1a1a" }}>
            <PosterImage uri={item.thumb || item.src} style={{ width: 46, height: 64 }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 16, fontWeight: "800" }}>
              {item.title ?? "Untitled"}
            </Text>
            <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
              {subtitle}
            </Text>
          </View>
        </View>

        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: "rgba(255,255,255,0.08)", marginBottom: 4 }} />

        {resumeHref ? (
          <MenuRow icon={<Play size={22} color={colors.foreground} fill={colors.foreground} />} label="Resume" onPress={onResume} />
        ) : null}
        <MenuRow
          icon={saved ? <Check size={22} color={colors.accent} /> : <Plus size={22} color={colors.foreground} />}
          label={saved ? "Remove from My List" : "Add to My List"}
          onPress={onToggleList}
          disabled={!signedIn}
        />
        {req ? <MenuRow icon={dlIcon} label={dlLabel} sublabel={dlSub} onPress={onDownload} /> : null}
        <MenuRow icon={<Info size={22} color={colors.foreground} />} label="View details" onPress={onDetails} />
        <MenuRow
          icon={<Trash2 size={22} color={colors.accent} />}
          label="Remove from this list"
          destructive
          onPress={() => {
            selectionAsync();
            onRemove(item);
          }}
        />
      </View>
    </View>
  );
}

function MenuRow({
  icon,
  label,
  sublabel,
  destructive,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  sublabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 13, paddingHorizontal: 20, opacity: disabled ? 0.4 : 1 }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={{ width: 24, alignItems: "center" }}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: destructive ? colors.accent : colors.foreground, fontSize: 16, fontWeight: "600" }}>{label}</Text>
        {sublabel ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 1 }}>{sublabel}</Text> : null}
      </View>
    </Pressable>
  );
}
