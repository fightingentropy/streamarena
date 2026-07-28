import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Href, usePathname, useRouter } from "expo-router";
import {
  DownloadsTabIcon,
  HomeTabIcon,
  LiveTabIcon,
  MyListTabIcon,
  SearchTabIcon,
} from "@/components/icons/TabIcons";
import { PressableScale } from "@/components/ui/PressableScale";
import { selectionAsync } from "@/lib/haptics";
import { colors, layout } from "@/theme";

type TabKey = "index" | "search" | "live" | "downloads" | "mylist";

const TABS = [
  { key: "index", label: "Home", path: "/" as Href, Icon: HomeTabIcon },
  { key: "search", label: "Search", path: "/search" as Href, Icon: SearchTabIcon },
  { key: "live", label: "Live", path: "/live" as Href, Icon: LiveTabIcon },
  { key: "downloads", label: "Downloads", path: "/downloads" as Href, Icon: DownloadsTabIcon },
  { key: "mylist", label: "My List", path: "/mylist" as Href, Icon: MyListTabIcon },
] as const;

// Auth + full-screen player take over the whole screen — no tab bar there.
const HIDDEN_PREFIXES = ["/signin", "/register", "/watch"];

// Which tab "owns" the current route, so the right icon stays lit on pushed screens
// (a title detail reached from any tab falls back to Home).
function activeTab(pathname: string): TabKey {
  if (pathname === "/") return "index";
  if (pathname.startsWith("/search")) return "search";
  if (pathname.startsWith("/live")) return "live";
  if (pathname.startsWith("/downloads")) return "downloads";
  if (pathname.startsWith("/mylist")) return "mylist";
  return "index";
}

// Compact, full-width iOS navigation layer. It is intentionally an anchored dark
// surface rather than a floating glass pill: artwork can scroll behind the content,
// while navigation remains stable through the home-indicator area.
export function TabBar() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();

  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const active = activeTab(pathname);

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 90,
        height: layout.mobileNavHeight + insets.bottom,
        paddingBottom: insets.bottom,
        backgroundColor: "rgba(6,6,7,0.98)",
        borderTopWidth: 0.5,
        borderTopColor: colors.hairline,
      }}
    >
      <View
        style={{
          height: layout.mobileNavHeight,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 6,
          paddingTop: 5,
          paddingBottom: 4,
        }}
      >
        {TABS.map((tab) => {
          const isActive = active === tab.key;
          const onPress = () => {
            void selectionAsync();
            if (router.canDismiss()) router.dismissAll();
            // On a pushed route, `isActive` only identifies the highlighted
            // owner, so always return to the requested tab root.
            router.navigate(tab.path);
          };
          const tint = isActive ? colors.white : colors.iconIdle;
          return (
            <PressableScale
              key={tab.key}
              scaleTo={0.985}
              onPress={onPress}
              className="flex-1"
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={tab.label}
            >
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}>
                <tab.Icon active={isActive} color={tint} size={22} />
                <Text
                  numberOfLines={1}
                  style={{
                    color: tint,
                    fontSize: 9.5,
                    fontWeight: isActive ? "700" : "600",
                    letterSpacing: 0.05,
                  }}
                >
                  {tab.label}
                </Text>
              </View>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}
