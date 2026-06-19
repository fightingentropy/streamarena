import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

export function ErrorText({ children }: { children: string }) {
  return (
    <Text style={{ color: "#f87171" }} className="text-sm">
      {children}
    </Text>
  );
}

export function EmptyState({
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View className="items-center px-8 py-16">
      <Text className="text-center text-base font-medium" style={{ color: colors.foreground }}>
        {title}
      </Text>
      {subtitle ? (
        <Text className="mt-2 text-center text-sm" style={{ color: colors.muted }}>
          {subtitle}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <PressableScale
          onPress={onAction}
          className="mt-5 rounded-full px-6 py-3"
          style={{ backgroundColor: colors.accent }}
          accessibilityLabel={actionLabel}
        >
          <Text className="font-semibold text-white">{actionLabel}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

export function SignedOutPrompt({ message }: { message: string }) {
  const router = useRouter();
  return (
    <View className="items-center px-8 py-16">
      <Text className="mb-4 text-center text-base" style={{ color: colors.muted }}>
        {message}
      </Text>
      <PressableScale
        onPress={() => router.push("/signin")}
        className="rounded-full px-6 py-3"
        style={{ backgroundColor: colors.accent }}
      >
        <Text className="font-semibold text-white">Sign in</Text>
      </PressableScale>
    </View>
  );
}
