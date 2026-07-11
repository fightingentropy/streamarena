#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function makeStorage(entries = []) {
  return {
    entries: new Map(entries),
    get length() {
      return this.entries.size;
    },
    key(index) {
      return Array.from(this.entries.keys())[index] ?? null;
    },
    getItem(key) {
      return this.entries.has(key) ? this.entries.get(key) : null;
    },
    setItem(key, value) {
      this.entries.set(String(key), String(value));
    },
    removeItem(key) {
      this.entries.delete(key);
    },
    clear() {
      this.entries.clear();
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function installBrowserState(localEntries = [], sessionEntries = []) {
  const localStorage = makeStorage(localEntries);
  const sessionStorage = makeStorage(sessionEntries);
  const events = [];
  const window = {
    location: { href: "/protected.html" },
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: sessionStorage,
    configurable: true,
  });
  return { window, localStorage, sessionStorage, events };
}

function assert(condition, message, details = undefined) {
  if (condition) return;
  console.error(message, details || "");
  process.exit(1);
}

const auth = await import("../src-ui/lib/auth.js");
const {
  USER_STATE_OWNER_KEY,
  USER_STATE_CACHED_USER_KEY,
  clearUserLocalState,
  establishUserLocalState,
  getCachedUserForOffline,
  getAuthSession,
  hydrateFromServer,
  signOut,
} = auth;

// Explicit cleanup removes only StreamArena/watch state.
{
  const state = installBrowserState(
    [
      ["streamarena-resume:movie", "42"],
      ["streamarena-real-debrid-api-key", "secret"],
      ["streamarena-profile-avatar-image", "data:image/png;base64,AAAA"],
      ["other-app-key", "keep"],
    ],
    [
      ["watch:movie", "src=secret"],
      ["streamarena-session-cache", "secret"],
      ["other-session-key", "keep"],
    ],
  );
  state.window.__currentUser = { id: 1, email: "viewer@example.com" };
  clearUserLocalState();
  assert(!state.window.__currentUser, "Cleanup retained window.__currentUser.");
  assert(
    Array.from(state.localStorage.entries.keys()).join(",") === "other-app-key",
    "Cleanup removed or retained the wrong localStorage keys.",
    Array.from(state.localStorage.entries.keys()),
  );
  assert(
    Array.from(state.sessionStorage.entries.keys()).join(",") === "other-session-key",
    "Cleanup removed or retained the wrong sessionStorage keys.",
    Array.from(state.sessionStorage.entries.keys()),
  );
}

// A matching owner keeps its offline cache; an account switch clears it before
// binding the next user.
{
  const cachedUser = { id: 1, email: "one@example.com", displayName: "One" };
  const state = installBrowserState([
    [USER_STATE_OWNER_KEY, "1"],
    [USER_STATE_CACHED_USER_KEY, JSON.stringify(cachedUser)],
    ["streamarena-resume:movie", "42"],
    ["other-app-key", "keep"],
  ], [["watch:movie", "src=private"]]);
  const sameOwner = establishUserLocalState({ ...cachedUser, displayName: "One Updated" });
  assert(sameOwner.ok && !sameOwner.didClear, "Matching owner cache was cleared.");
  assert(
    state.localStorage.getItem("streamarena-resume:movie") === "42",
    "Matching owner lost resume data.",
  );

  const switched = establishUserLocalState({ id: 2, email: "two@example.com", displayName: "Two" });
  assert(switched.ok && switched.didClear && switched.ownerChanged, "Account switch was not detected.");
  assert(
    state.localStorage.getItem("streamarena-resume:movie") === null &&
      state.sessionStorage.getItem("watch:movie") === null,
    "Account switch leaked the previous user's cache.",
  );
  assert(
    state.localStorage.getItem(USER_STATE_OWNER_KEY) === "2" &&
      state.localStorage.getItem("other-app-key") === "keep",
    "Account switch did not bind the new owner safely.",
  );
  assert(getCachedUserForOffline()?.id === 2, "Offline user cache was not owner-validated.");
}

// Pre-marker/unowned app data is never silently adopted by whichever account
// signs in next.
{
  const state = installBrowserState([
    ["streamarena-my-list-v1", JSON.stringify([{ id: "someone-elses-title" }])],
    ["other-app-key", "keep"],
  ]);
  const established = establishUserLocalState({ id: 3, email: "three@example.com" });
  assert(established.didClear, "Unowned legacy state was silently adopted.");
  assert(
    state.localStorage.getItem("streamarena-my-list-v1") === null &&
      state.localStorage.getItem(USER_STATE_OWNER_KEY) === "3",
    "Unowned state was not cleared before binding the account.",
  );
}

// A confirmed auth failure clears private cache, while network/5xx failures
// retain a matching owner's cache for offline use.
{
  const user = { id: 4, email: "offline@example.com", displayName: "Offline" };
  let state = installBrowserState();
  establishUserLocalState(user);
  state.localStorage.setItem("streamarena-resume:offline", "33");
  globalThis.fetch = async () => jsonResponse({ error: "temporary" }, 503);
  let session = await getAuthSession();
  assert(session.status === "offline" && session.user?.id === 4, "5xx discarded offline session cache.");
  assert(state.localStorage.getItem("streamarena-resume:offline") === "33", "5xx cleared user cache.");

  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  session = await getAuthSession();
  assert(session.status === "offline" && session.user?.id === 4, "Network failure discarded offline cache.");

  globalThis.fetch = async () => jsonResponse({ error: "expired" }, 401);
  session = await getAuthSession();
  assert(session.status === "unauthorized" && !session.user, "401 was not classified as unauthorized.");
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === null, "401 retained private local state.");

  state = installBrowserState([["other-app-key", "keep"]]);
  globalThis.fetch = async () => jsonResponse({ error: "temporary" }, 500);
  session = await getAuthSession();
  assert(session.status === "unavailable" && !session.user, "Uncached 5xx was misclassified as logout.");
  assert(state.localStorage.getItem("other-app-key") === "keep", "5xx cleared unrelated state.");
}

// Hydration applies server truth before mounting can read it, prunes stale
// resume entries only when both authoritative endpoints loaded, and keeps the
// cache on partial server failure.
{
  const state = installBrowserState();
  establishUserLocalState({ id: 5, email: "hydrate@example.com" });
  state.localStorage.setItem("streamarena-resume:stale", "99");
  const payloads = new Map([
    ["/api/user/preferences", jsonResponse({ "streamarena-default-audio-lang": "ja" })],
    ["/api/user/watch-progress", jsonResponse({ entries: [{ sourceIdentity: "server", resumeSeconds: 15 }] })],
    ["/api/user/continue-watching", jsonResponse({ entries: [] })],
    ["/api/user/my-list", jsonResponse({ entries: [{ id: "movie-1" }] })],
  ]);
  globalThis.fetch = async (path) => payloads.get(path);
  const result = await hydrateFromServer();
  assert(result.ok && result.didLoadPreferences && result.didLoadMyList, "Hydration did not report success.", result);
  assert(
    state.localStorage.getItem("streamarena-default-audio-lang") === "ja" &&
      state.localStorage.getItem("streamarena-resume:server") === "15" &&
      state.localStorage.getItem("streamarena-resume:stale") === null,
    "Hydration did not apply/prune server state.",
  );

  state.localStorage.setItem("streamarena-resume:offline-fallback", "44");
  payloads.set("/api/user/watch-progress", jsonResponse({ error: "temporary" }, 503));
  await hydrateFromServer();
  assert(
    state.localStorage.getItem("streamarena-resume:offline-fallback") === "44",
    "Partial hydration pruned offline fallback state.",
  );

  payloads.set("/api/user/preferences", jsonResponse({ error: "expired" }, 403));
  const expired = await hydrateFromServer();
  assert(expired.authExpired, "Hydration did not surface auth expiry.");
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === null, "Hydration 403 retained private state.");
  assert(state.window.location.href === "/login.html", "Hydration 403 did not redirect to login.");
}

// Logout must not clear/redirect if the server failed to invalidate its
// HttpOnly cookie; a confirmed logout does both.
{
  let state = installBrowserState();
  establishUserLocalState({ id: 6, email: "logout@example.com" });
  state.localStorage.setItem("streamarena-resume:movie", "20");
  globalThis.fetch = async () => jsonResponse({ error: "database unavailable" }, 500);
  const originalWarn = console.warn;
  console.warn = () => {};
  const failed = await signOut();
  console.warn = originalWarn;
  assert(failed === false, "Failed logout was reported as successful.");
  assert(
    state.localStorage.getItem("streamarena-resume:movie") === "20" &&
      state.window.location.href === "/protected.html",
    "Failed logout cleared state or redirected into a stale-cookie bounce.",
  );

  globalThis.fetch = async () => jsonResponse({ ok: true });
  await signOut();
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === null, "Successful logout retained state.");
  assert(state.window.location.href === "/login.html", "Successful logout did not redirect.");
}

// Keep the regression's two integration boundaries explicit: authenticated
// pages await hydration before mounting, and login no longer uploads unowned
// browser data to /api/user/sync.
{
  const [pageEntrySource, loginSource] = await Promise.all([
    readFile(new URL("../src-ui/lib/page-entry.js", import.meta.url), "utf8"),
    readFile(new URL("../src-ui/pages/login.jsx", import.meta.url), "utf8"),
  ]);
  const hydrateIndex = pageEntrySource.indexOf("await hydrateFromServer()");
  const mountIndex = pageEntrySource.indexOf("mountPage(await componentPromise");
  assert(
    hydrateIndex >= 0 && mountIndex > hydrateIndex,
    "Authenticated pages no longer hydrate before mounting.",
  );
  assert(!loginSource.includes("/api/user/sync"), "Login still uploads unowned browser data.");
}

console.log("Auth ownership, hydration, and logout state tests passed.");
