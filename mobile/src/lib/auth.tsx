import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import CookieManager from "@react-native-cookies/cookies";
import { API_AUTH_REQUIRED_EVENT, invalidateApiCache } from "@/lib/api";
import { on } from "@/lib/events";
import { apiFetch } from "@/lib/http";
import { storage } from "@/lib/storage";
import { setAccountScope } from "@/store/account";

// Ported from spotify/mobile/src/lib/auth.tsx. The auth-generation guard, cached
// user, timed session check, and forced-logout-on-401 are preserved. Re-pointed to
// streamarena's endpoints: GET /api/auth/me (returns the user object flat),
// POST /api/auth/login {email,password}, POST /api/auth/signup, POST /api/auth/logout.
// The native cookie jar keeps the `session` cookie across launches, so no token is
// stored; expo-secure-store/profile-image/likes wiring is dropped.

export type AuthUser = {
  id: number;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string, inviteCode?: string) => Promise<void>;
  signOut: () => Promise<void>;
  resendVerification: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_AUTH_USER_KEY = "streamarena_cached_auth_user";
const CACHED_AUTH_SIGNED_OUT_KEY = "streamarena_auth_signed_out";
const SESSION_REFRESH_TIMEOUT_MS = 2_500;

function coerceAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const id = typeof c.id === "number" ? c.id : typeof c.id === "string" && c.id.trim() ? Number(c.id) : NaN;
  if (!Number.isFinite(id) || typeof c.email !== "string") return null;
  return {
    id,
    email: c.email,
    displayName: typeof c.displayName === "string" ? c.displayName : null,
    // Default to verified when absent so we never falsely nag; the server sends an
    // explicit boolean from /api/auth/me.
    emailVerified: c.emailVerified !== false,
    isAdmin: c.isAdmin === true,
  };
}

function readCachedAuthUser(): AuthUser | null {
  try {
    return coerceAuthUser(JSON.parse(storage.getItem(CACHED_AUTH_USER_KEY) || "null"));
  } catch {
    return null;
  }
}

function writeCachedAuthUser(user: AuthUser | null, options?: { signedOut?: boolean }): void {
  try {
    if (user) {
      storage.setItem(CACHED_AUTH_USER_KEY, JSON.stringify(user));
      storage.removeItem(CACHED_AUTH_SIGNED_OUT_KEY);
    } else {
      storage.removeItem(CACHED_AUTH_USER_KEY);
      if (options?.signedOut) storage.setItem(CACHED_AUTH_SIGNED_OUT_KEY, "1");
    }
  } catch {}
}

function scopeFor(user: AuthUser | null, status: AuthContextValue["status"]): string {
  return user ? String(user.id) : status;
}

async function fetchMe(): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = apiFetch("/api/auth/me", { cache: "no-store", signal: controller?.signal });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error("Session check timed out"));
      }, SESSION_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function clearCookieJar(): Promise<void> {
  // Belt-and-suspenders: NSURLSession occasionally retains a cookie past a
  // Max-Age=0 if the logout response races, so clear the jar explicitly too.
  try {
    await CookieManager.clearAll();
  } catch {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [initialUser] = useState<AuthUser | null>(() => readCachedAuthUser());
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [status, setStatus] = useState<AuthContextValue["status"]>(() => (initialUser ? "authenticated" : "loading"));
  const authGenerationRef = useRef(0);

  const refresh = useCallback(async (options?: { showLoading?: boolean }) => {
    const generation = authGenerationRef.current;
    const isStale = () => authGenerationRef.current !== generation;
    if (options?.showLoading) setStatus("loading");
    try {
      const response = await fetchMe();
      if (isStale()) return;
      if (response.status === 401 || response.status === 403) {
        invalidateApiCache();
        writeCachedAuthUser(null, { signedOut: true });
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      if (!response.ok) throw new Error(`Session check failed with ${response.status}`);
      const nextUser = coerceAuthUser(await response.json().catch(() => null));
      if (isStale()) return;
      writeCachedAuthUser(nextUser, { signedOut: !nextUser });
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
    } catch {
      if (isStale()) return;
      const cachedUser = readCachedAuthUser();
      setUser(cachedUser);
      setStatus(cachedUser ? "authenticated" : "unauthenticated");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return on(API_AUTH_REQUIRED_EVENT, () => {
      authGenerationRef.current += 1;
      invalidateApiCache();
      writeCachedAuthUser(null, { signedOut: true });
      setUser(null);
      setStatus("unauthenticated");
    });
  }, []);

  // Keep the per-account cache/download scope in sync.
  useEffect(() => {
    setAccountScope(scopeFor(user, status));
  }, [status, user]);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
    const nextUser = coerceAuthUser(data.user ?? null);
    if (!response.ok || !nextUser) throw new Error(data.error || "Invalid email or password.");
    authGenerationRef.current += 1;
    invalidateApiCache();
    writeCachedAuthUser(nextUser);
    setAccountScope(String(nextUser.id));
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string, inviteCode?: string) => {
      const response = await apiFetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, displayName, inviteCode }),
      });
      const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
      const nextUser = coerceAuthUser(data.user ?? null);
      if (!response.ok || !nextUser) throw new Error(data.error || "Could not create your account.");
      authGenerationRef.current += 1;
      invalidateApiCache();
      writeCachedAuthUser(nextUser);
      setAccountScope(String(nextUser.id));
      setUser(nextUser);
      setStatus("authenticated");
    },
    [],
  );

  const signOut = useCallback(async () => {
    authGenerationRef.current += 1;
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    await clearCookieJar();
    invalidateApiCache();
    writeCachedAuthUser(null, { signedOut: true });
    setAccountScope("unauthenticated");
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const resendVerification = useCallback(async () => {
    const response = await apiFetch("/api/auth/resend-verification", { method: "POST" });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Failed to resend verification email.");
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, refresh, signIn, signUp, signOut, resendVerification }),
    [refresh, resendVerification, signIn, signOut, signUp, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

// Convenience: the current account scope string for useApiData/withAccountScope.
// NOTE: for a signed-out/loading user this is the sentinel "unauthenticated"/
// "loading" (a non-empty string), which is intentional as a distinct cache key.
// Do NOT use truthiness of this value to test "is signed in" — use useSignedIn().
export function useAccountScope(): string {
  const { user, status } = useAuth();
  return scopeFor(user, status);
}

// True only when a real account session is established. Use this (not `!scope`)
// to gate account-only behavior, since useAccountScope() never returns "".
export function useSignedIn(): boolean {
  return useAuth().status === "authenticated";
}

// The account scope for a real session, or null when not signed in — the value to
// pass to account-data stores so their null-guards (clear-on-signed-out, skip
// anonymous fetches) work correctly.
export function useAccountScopeOrNull(): string | null {
  const { user, status } = useAuth();
  return status === "authenticated" && user ? String(user.id) : null;
}
