import { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { ErrorText } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

export default function RegisterScreen() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signUp(email.trim(), password, displayName.trim(), inviteCode.trim() || undefined);
      // AuthGate redirects to "/" once authenticated.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your account.");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { color: colors.foreground, height: 52, fontSize: 16, paddingHorizontal: 14 } as const;
  const fieldBg = { backgroundColor: "#1f1f1f", borderRadius: 8 } as const;
  const canSubmit = !busy && email && password && displayName;

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View className="flex-1 justify-center px-6" style={{ gap: 14 }}>
          <Text className="text-4xl font-extrabold tracking-tight" style={{ color: colors.accent }}>
            STREAMARENA
          </Text>
          <Text className="mb-1 text-2xl font-bold" style={{ color: colors.foreground }}>
            Create account
          </Text>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Display name"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
            style={[inputStyle, fieldBg]}
          />
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            style={[inputStyle, fieldBg]}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={[inputStyle, fieldBg]}
          />
          <TextInput
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="Invite code (if required)"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            style={[inputStyle, fieldBg]}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <PressableScale
            onPress={submit}
            disabled={!canSubmit}
            className="items-center rounded-full py-3.5"
            style={{ backgroundColor: colors.accent, opacity: canSubmit ? 1 : 0.6 }}
          >
            <Text className="text-base font-bold text-white">{busy ? "Creating…" : "Create account"}</Text>
          </PressableScale>
          <PressableScale onPress={() => router.replace("/signin")} className="items-center py-2">
            <Text style={{ color: colors.muted }}>
              Already have an account?{" "}
              <Text style={{ color: colors.foreground, fontWeight: "600" }}>Sign in</Text>
            </Text>
          </PressableScale>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
