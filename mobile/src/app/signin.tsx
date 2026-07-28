import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Wordmark } from "@/components/brand/Wordmark";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      // AuthGate redirects to "/" once authenticated.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid email or password.");
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !email || !password;
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
            paddingTop: 40,
            paddingBottom: 48,
          }}
        >
          <View style={{ marginBottom: 30 }}>
            <Wordmark size={32} style={{ marginBottom: 22 }} />
            <Text
              style={{
                color: colors.foreground,
                fontSize: 36,
                lineHeight: 40,
                fontWeight: "700",
                letterSpacing: -1,
              }}
            >
              Welcome back.
            </Text>
            <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 330 }}>
              Sign in to continue watching across all your devices.
            </Text>
          </View>

          <View style={{ gap: 12 }}>
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
              autoComplete="password"
              onSubmitEditing={() => void submit()}
              returnKeyType="go"
              accessibilityLabel="Password"
              style={inputStyle}
            />
            {error ? (
              <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13, lineHeight: 18 }}>
                {error}
              </Text>
            ) : null}
            <PressableScale
              onPress={() => void submit()}
              disabled={disabled}
              accessibilityLabel="Sign in"
              accessibilityState={{ disabled, busy }}
              style={{
                height: 54,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 14,
                borderCurve: "continuous",
                backgroundColor: colors.foreground,
                opacity: disabled ? 0.46 : 1,
              }}
            >
              <Text style={{ color: colors.background, fontSize: 16, fontWeight: "700" }}>
                {busy ? "Signing in…" : "Sign in"}
              </Text>
            </PressableScale>
            <PressableScale
              onPress={() => router.replace("/register")}
              accessibilityLabel="Don’t have an account? Register"
              style={{ alignItems: "center", paddingVertical: 11 }}
            >
              <Text style={{ color: colors.muted, fontSize: 14 }}>
                Don&apos;t have an account?{" "}
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>Register</Text>
              </Text>
            </PressableScale>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
