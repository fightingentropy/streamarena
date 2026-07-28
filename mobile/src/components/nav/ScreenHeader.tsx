import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { colors } from "@/theme";

export function ScreenHeader({
  title,
  subtitle,
  right,
  showProfile = true,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  showProfile?: boolean;
}) {
  return (
    <View
      style={{
        minHeight: 58,
        paddingHorizontal: 16,
        paddingTop: 5,
        paddingBottom: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            color: colors.foreground,
            fontSize: 34,
            lineHeight: 39,
            fontWeight: "700",
            letterSpacing: -0.9,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 2 }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (showProfile ? <ProfileButton size={38} /> : null)}
    </View>
  );
}
