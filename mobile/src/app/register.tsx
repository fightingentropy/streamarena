import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Wordmark } from "@/components/brand/Wordmark";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
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

  const inputStyle = {
    height: 54,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: 0.5,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    color: colors.foreground,
    fontSize: 16,
  } as const;
  const canSubmit = Boolean(!busy && email && password && displayName);

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: 24,
            paddingTop: 32,
            paddingBottom: 48,
          }}
        >
          <View style={{ marginBottom: 26 }}>
            <Wordmark size={32} style={{ marginBottom: 20 }} />
            <Text
              style={{
                color: colors.foreground,
                fontSize: 36,
                lineHeight: 40,
                fontWeight: "700",
                letterSpacing: -1,
              }}
            >
              Create your account.
            </Text>
            <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 330 }}>
              Keep your watchlist and playback preferences in sync.
            </Text>
          </View>

          <View style={{ gap: 12 }}>
            <TextInput
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Display name"
              placeholderTextColor={colors.dim}
              selectionColor={colors.foreground}
              autoCapitalize="words"
              autoComplete="name"
              accessibilityLabel="Display name"
              style={inputStyle}
            />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor={colors.dim}
              selectionColor={colors.foreground}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              accessibilityLabel="Email"
              style={inputStyle}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.dim}
              selectionColor={colors.foreground}
              secureTextEntry
              autoComplete="new-password"
              accessibilityLabel="Password"
              style={inputStyle}
            />
            <TextInput
              value={inviteCode}
              onChangeText={setInviteCode}
              placeholder="Invite code (if required)"
              placeholderTextColor={colors.dim}
              selectionColor={colors.foreground}
              autoCapitalize="none"
              accessibilityLabel="Invite code, if required"
              style={inputStyle}
            />
            {error ? (
              <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13, lineHeight: 18 }}>
                {error}
              </Text>
            ) : null}
            <PressableScale
              onPress={() => void submit()}
              disabled={!canSubmit}
              accessibilityLabel="Create account"
              accessibilityState={{ disabled: !canSubmit, busy }}
              style={{
                height: 54,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 14,
                borderCurve: "continuous",
                backgroundColor: colors.foreground,
                opacity: canSubmit ? 1 : 0.46,
              }}
            >
              <Text style={{ color: colors.background, fontSize: 16, fontWeight: "700" }}>
                {busy ? "Creating…" : "Create account"}
              </Text>
            </PressableScale>
            <PressableScale
              onPress={() => router.replace("/signin")}
              accessibilityLabel="Already have an account? Sign in"
              style={{ alignItems: "center", paddingVertical: 11 }}
            >
              <Text style={{ color: colors.muted, fontSize: 14 }}>
                Already have an account?{" "}
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>Sign in</Text>
              </Text>
            </PressableScale>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
