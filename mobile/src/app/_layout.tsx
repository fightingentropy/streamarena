import "react-native-url-polyfill/auto";
import "../../global.css";

import { type ReactNode, useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { AuthProvider, useAccountScopeOrNull, useAuth } from "@/lib/auth";
import { TabBar } from "@/components/nav/TabBar";
import { ProfileMenu } from "@/components/profile/ProfileMenu";
import { initOfflineSync, setOfflineAccountScope } from "@/store/offline";
import { colors } from "@/theme";

const headerOptions = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.foreground,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: "minimal",
} as const;

void SplashScreen.preventAutoHideAsync();

// Scope offline downloads to the signed-in account and mount the download pump's
// AppState/connectivity listeners. Active iOS transfers remain system-managed while
// the app is backgrounded; foreground/network edges re-kick any deferred queue work.
function OfflineBootstrap() {
  const scope = useAccountScopeOrNull();
  useEffect(() => {
    setOfflineAccountScope(scope);
  }, [scope]);
  useEffect(() => initOfflineSync(), []);
  return null;
}

// Redirect unauthenticated users to /signin, and bounce authenticated users away
// from the auth screens. Renders a dark hold while the session check is in flight.
function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    const onAuthScreen = segments[0] === "signin" || segments[0] === "register";
    if (status === "unauthenticated" && !onAuthScreen) router.replace("/signin");
    else if (status === "authenticated" && onAuthScreen) router.replace("/");
  }, [status, segments, router]);

  if (status === "loading") {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }
  return <>{children}</>;
}

export default function RootLayout() {
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
    void SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <AuthGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="signin" />
              <Stack.Screen name="register" />
              <Stack.Screen name="title/[mediaType]/[id]" options={{ headerShown: false }} />
              <Stack.Screen
                name="watch/[id]"
                options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }}
              />
              <Stack.Screen name="settings" options={{ ...headerOptions, title: "Settings" }} />
              <Stack.Screen name="settings/playback" options={{ ...headerOptions, title: "Playback" }} />
              <Stack.Screen name="settings/storage" options={{ ...headerOptions, title: "Storage" }} />
            </Stack>
            <TabBar />
            <ProfileMenu />
            <OfflineBootstrap />
          </AuthGate>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
