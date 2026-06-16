#!/usr/bin/env node
function makeStorage(entries) {
  return {
    entries: new Map(entries),
    get length() {
      return this.entries.size;
    },
    key(index) {
      return Array.from(this.entries.keys())[index] ?? null;
    },
    removeItem(key) {
      this.entries.delete(key);
    },
  };
}

Object.defineProperty(globalThis, "window", {
  value: { __currentUser: { id: 1, email: "viewer@example.com" } },
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: makeStorage([
    ["streamarena-resume:movie", "42"],
    ["streamarena-real-debrid-api-key", "secret"],
    ["streamarena-profile-avatar-image", "data:image/png;base64,AAAA"],
    ["other-app-key", "keep"],
  ]),
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: makeStorage([
    ["watch:movie", "src=secret"],
    ["streamarena-session-cache", "secret"],
    ["other-session-key", "keep"],
  ]),
  configurable: true,
});

const { clearUserLocalState } = await import("../src-ui/lib/auth.js");

clearUserLocalState();

const localKeys = Array.from(globalThis.localStorage.entries.keys()).sort();
const sessionKeys = Array.from(globalThis.sessionStorage.entries.keys()).sort();

if (
  window.__currentUser ||
  localKeys.join(",") !== "other-app-key" ||
  sessionKeys.join(",") !== "other-session-key"
) {
  console.error("Auth local state cleanup failed", {
    currentUser: window.__currentUser,
    localKeys,
    sessionKeys,
  });
  process.exit(1);
}

console.log("Auth local state cleanup passed.");
