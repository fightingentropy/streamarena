import { type ComponentType } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Href, usePathname, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { Bookmark, Download, Home, Search, Tv } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { selectionAsync } from "@/lib/haptics";
import { colors, layout } from "@/theme";

type TabKey = "index" | "search" | "live" | "downloads" | "mylist";
type IconCmp = ComponentType<{ color?: string; size?: number; strokeWidth?: number; fill?: string }>;

const TABS: { key: TabKey; label: string; path: Href; Icon: IconCmp }[] = [
  { key: "index", label: "Home", path: "/", Icon: Home },
  { key: "search", label: "Search", path: "/search", Icon: Search },
  { key: "live", label: "Live", path: "/live", Icon: Tv },
  { key: "downloads", label: "Downloads", path: "/downloads", Icon: Download },
  { key: "mylist", label: "My List", path: "/mylist", Icon: Bookmark },
];

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

// Glassmorphic bottom bar (BlurView over a fade-to-black gradient). Mounted once in
// the root layout — not via the Tabs navigator's tabBar prop — so it persists on
// pushed stack screens (title detail, settings). A tab tap unwinds any pushed screen
// (dismissAll → POP_TO_TOP) then switches tab, avoiding duplicate mounts.
export function TabBar() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();

  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const active = activeTab(pathname);

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <LinearGradient colors={["rgba(0,0,0,0.30)", "rgba(0,0,0,0.85)", "#000"]} style={{ paddingBottom: insets.bottom }}>
        <BlurView intensity={24} tint="dark" style={{ height: layout.mobileNavHeight, flexDirection: "row" }}>
          {TABS.map((tab) => {
            const isActive = active === tab.key;
            const onPress = () => {
              void selectionAsync();
              if (router.canDismiss()) router.dismissAll();
              if (!isActive) router.navigate(tab.path);
            };
            const tint = isActive ? colors.white : colors.muted;
            return (
              <PressableScale
                key={tab.key}
                scaleTo={0.985}
                onPress={onPress}
                className="flex-1 items-center justify-center gap-1"
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={tab.label}
              >
                <tab.Icon color={tint} size={23} strokeWidth={isActive ? 2.4 : 2} />
                <Text style={{ color: tint, fontSize: 10, fontWeight: isActive ? "700" : "500" }}>{tab.label}</Text>
              </PressableScale>
            );
          })}
        </BlurView>
      </LinearGradient>
    </View>
  );
}
