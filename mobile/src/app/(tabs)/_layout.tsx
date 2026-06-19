import { Tabs } from "expo-router";

// Tabs group. The real glass TabBar is mounted globally in the root layout, so the
// built-in bar is hidden here (rendering a no-op tabBar) to avoid doubling up.
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={() => null}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="search" />
      <Tabs.Screen name="live" />
      <Tabs.Screen name="downloads" />
      <Tabs.Screen name="mylist" />
    </Tabs>
  );
}
