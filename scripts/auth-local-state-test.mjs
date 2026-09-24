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
  beginServerHydration,
  fetchUserApi,
  getHydrationState,
  clearUserLocalState,
  establishUserLocalState,
  getCachedUserForOffline,
  getAuthSession,
  getServerHydrationStatus,
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
  const hydrationRequests = [];
  globalThis.fetch = async (path) => {
    hydrationRequests.push(path);
    return payloads.get(path);
  };
  const result = await hydrateFromServer();
  assert(result.ok && result.didLoadPreferences && result.didLoadMyList, "Hydration did not report success.", result);
  assert(
    state.localStorage.getItem("streamarena-default-audio-lang") === "ja" &&
      state.localStorage.getItem("streamarena-resume:server") === "15" &&
      state.localStorage.getItem("streamarena-resume:stale") === null,
    "Hydration did not apply/prune server state.",
  );
  assert(
    hydrationRequests.filter((path) => path === "/api/user/watch-progress").length === 1,
    "Successful hydration did not issue exactly one progress read.",
  );
  assert(
    hydrationRequests.filter((path) => path === "/api/user/continue-watching").length === 1,
    "Successful hydration did not issue exactly one Continue Watching read.",
  );
  let hydrationStatus = getServerHydrationStatus();
  assert(
    hydrationStatus.didLoadProgress &&
      hydrationStatus.didLoadContinueWatching &&
      !hydrationStatus.authExpired &&
      Object.keys(hydrationStatus).length === 3 &&
      Object.values(hydrationStatus).every((value) => typeof value === "boolean"),
    "Successful hydration status was not recorded as boolean-only state.",
  );
  hydrationStatus.didLoadProgress = false;
  assert(
    getServerHydrationStatus().didLoadProgress,
    "Hydration status getter exposed mutable shared state.",
  );

  state.localStorage.setItem("streamarena-resume:offline-fallback", "44");
  payloads.set("/api/user/watch-progress", jsonResponse({ error: "temporary" }, 503));
  await hydrateFromServer();
  assert(
    state.localStorage.getItem("streamarena-resume:offline-fallback") === "44",
    "Partial hydration pruned offline fallback state.",
  );
  hydrationStatus = getServerHydrationStatus();
  assert(
    !hydrationStatus.didLoadProgress &&
      hydrationStatus.didLoadContinueWatching &&
      !hydrationStatus.authExpired,
    "Partial hydration status lost the successful Continue Watching read.",
  );

  payloads.set("/api/user/continue-watching", jsonResponse({ error: "temporary" }, 503));
  payloads.set(
    "/api/user/watch-progress",
    jsonResponse({ entries: [{ sourceIdentity: "server", resumeSeconds: 15 }] }),
  );
  await hydrateFromServer();
  hydrationStatus = getServerHydrationStatus();
  assert(
    hydrationStatus.didLoadProgress &&
      !hydrationStatus.didLoadContinueWatching &&
      !hydrationStatus.authExpired,
    "Partial hydration status lost the successful progress read.",
  );

  payloads.set("/api/user/watch-progress", jsonResponse({ error: "temporary" }, 503));
  await hydrateFromServer();
  hydrationStatus = getServerHydrationStatus();
  assert(
    !hydrationStatus.didLoadProgress &&
      !hydrationStatus.didLoadContinueWatching &&
      !hydrationStatus.authExpired,
    "Failed resume hydration did not expose the bounded-retry condition.",
  );

  payloads.set("/api/user/preferences", jsonResponse({ error: "expired" }, 403));
  const expired = await hydrateFromServer();
  assert(expired.authExpired, "Hydration did not surface auth expiry.");
  assert(getServerHydrationStatus().authExpired, "Hydration status lost auth expiry.");
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === null, "Hydration 403 retained private state.");
  assert(state.window.location.href === "/login.html", "Hydration 403 did not redirect to login.");
}

// Noncritical reads continue after preferences, overlapping callers share one
// request set, and published snapshots do not mutate as later endpoints finish.
{
  const state = installBrowserState();
  establishUserLocalState({ id: 7, email: "deferred@example.com" });
  let finishList;
  const list = new Promise((resolve) => { finishList = resolve; });
  const requested = [];
  globalThis.fetch = async (path) => {
    requested.push(path);
    if (path.endsWith("my-list")) return list;
    if (path.endsWith("preferences")) return jsonResponse({ "streamarena-default-audio-lang": "fr" });
    return jsonResponse({ entries: [] });
  };
  const started = beginServerHydration();
  assert(beginServerHydration() === started, "Concurrent hydration was not coalesced.");
  const preferences = await started.preferencesReady;
  assert(preferences.didLoadPreferences && !preferences.didLoadMyList, "Preferences waited for My List.");
  assert(getHydrationState().pending && state.localStorage.getItem("streamarena-default-audio-lang") === "fr", "Critical preferences were not applied before readiness.");
  const snapshot = state.events.at(-1).detail;
  finishList(jsonResponse({ entries: [{ id: "later" }] }));
  const completed = await started.complete;
  assert(completed.ok && !getHydrationState().pending && requested.length === 4, "Deferred hydration did not finish with exactly one request set.");
  assert(!snapshot.didLoadMyList && !preferences.didLoadMyList, "A published hydration snapshot mutated after publication.");
}

// Slow results from an old account cannot apply data or log out the new account,
// including a late 401 after a different owner starts its own hydration.
for (const staleStatus of [200, 401]) {
  const state = installBrowserState();
  establishUserLocalState({ id: 8, email: "old@example.com" });
  let finishOld;
  const oldResponse = new Promise((resolve) => { finishOld = resolve; });
  globalThis.fetch = async () => oldResponse;
  const old = beginServerHydration();
  establishUserLocalState({ id: 9, email: "new@example.com" });
  globalThis.fetch = async (path) => jsonResponse(path.endsWith("preferences")
    ? { "streamarena-default-audio-lang": "en" } : { entries: [] });
  await hydrateFromServer();
  finishOld(jsonResponse({ "streamarena-default-audio-lang": "stale" }, staleStatus));
  await old.complete;
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === "9" && state.localStorage.getItem("streamarena-default-audio-lang") === "en", "Old hydration altered the new account.");
  assert(!getHydrationState().authExpired && state.window.location.href === "/protected.html", "Old hydration logged out the new account.");
}

// Invalidating the same account's cache also invalidates its in-flight writes.
{
  const state = installBrowserState();
  establishUserLocalState({ id: 10, email: "logout-pending@example.com" });
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  // Only preferences is delayed; the other endpoints fail transiently.
  const delayedFetch = globalThis.fetch;
  globalThis.fetch = (path) => path.endsWith("preferences") ? delayedFetch() : Promise.resolve(jsonResponse({}, 503));
  const pending = beginServerHydration();
  clearUserLocalState();
  finish(jsonResponse({ "streamarena-default-audio-lang": "stale" }));
  await pending.complete;
  assert(state.localStorage.getItem("streamarena-default-audio-lang") === null && !getHydrationState().pending, "Logout allowed a late hydration write.");
}

// A response snapshot cannot undo local edits/deletes made during its fetch.
{
  const state = installBrowserState();
  establishUserLocalState({ id: 11, email: "edits@example.com" });
  state.localStorage.setItem("streamarena-my-list-v1", JSON.stringify([{ id: "old" }]));
  state.localStorage.setItem("streamarena-continue-watching-meta", JSON.stringify({ old: { sourceIdentity: "old" } }));
  state.localStorage.setItem("streamarena-resume:old", "10");
  state.localStorage.setItem("streamarena-resume:removed", "20");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (path) => {
    if (path.endsWith("preferences")) return jsonResponse({});
    await gate;
    if (path.endsWith("my-list")) return jsonResponse({ entries: [{ id: "stale-server" }] });
    return jsonResponse({ entries: [{ sourceIdentity: "old", resumeSeconds: 10 }, { sourceIdentity: "removed", resumeSeconds: 20 }] });
  };
  const hydration = beginServerHydration();
  await hydration.preferencesReady;
  state.localStorage.setItem("streamarena-my-list-v1", JSON.stringify([{ id: "new-edit" }]));
  state.localStorage.removeItem("streamarena-continue-watching-meta");
  state.localStorage.setItem("streamarena-resume:old", "90");
  state.localStorage.removeItem("streamarena-resume:removed");
  state.localStorage.setItem("streamarena-resume:new", "30");
  release();
  await hydration.complete;
  assert(state.localStorage.getItem("streamarena-my-list-v1").includes("new-edit"), "Late list hydration overwrote a local edit.");
  assert(state.localStorage.getItem("streamarena-continue-watching-meta") === null, "Late Continue hydration resurrected removed metadata.");
  assert(state.localStorage.getItem("streamarena-resume:old") === "90" && state.localStorage.getItem("streamarena-resume:removed") === null && state.localStorage.getItem("streamarena-resume:new") === "30", "Late hydration overwrote, resurrected, or pruned newer resume data.");
}

// A failed in-flight save from an earlier account cannot log out its successor.
{
  const state = installBrowserState();
  establishUserLocalState({ id: 12, email: "request-old@example.com" });
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const request = fetchUserApi("/api/user/watch-progress", { method: "PUT" });
  establishUserLocalState({ id: 13, email: "request-new@example.com" });
  finish(jsonResponse({ error: "expired" }, 401));
  await request;
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === "13" && state.window.location.href === "/protected.html", "A stale save response logged out the new account.");
  globalThis.fetch = async () => jsonResponse({ error: "expired" }, 401);
  await fetchUserApi("/api/user/watch-progress", { method: "PUT" });
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === null && state.window.location.href === "/login.html", "A current account's auth failure was ignored.");
}

// Session validation itself cannot switch back to an account whose response
// arrives after a new login, including a response whose JSON body was delayed.
for (const stage of ["headers", "body", "expired"]) {
  const state = installBrowserState();
  establishUserLocalState({ id: 14, email: "session-old@example.com" });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const oldUser = { id: 14, email: "session-old@example.com" };
  globalThis.fetch = async () => {
    if (stage === "body") return { ok: true, status: 200, json: () => gate };
    await gate;
    return jsonResponse(oldUser, stage === "expired" ? 401 : 200);
  };
  const request = getAuthSession();
  await Promise.resolve();
  establishUserLocalState({ id: 15, email: "session-new@example.com" });
  state.localStorage.setItem("streamarena-resume:new-owner", "40");
  finish(oldUser);
  const result = await request;
  assert(result.status === "superseded" && !result.user, "Stale auth validation returned the previous account.");
  assert(state.localStorage.getItem(USER_STATE_OWNER_KEY) === "15" && state.localStorage.getItem("streamarena-resume:new-owner") === "40", "Stale auth validation cleared or switched the new account.");
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
  const mountIndex = pageEntrySource.indexOf("mountPage(component");
  assert(
    hydrateIndex >= 0 && mountIndex > hydrateIndex,
    "Authenticated pages no longer hydrate before mounting.",
  );
  assert(!loginSource.includes("/api/user/sync"), "Login still uploads unowned browser data.");
}

console.log("Auth ownership, hydration, and logout state tests passed.");
