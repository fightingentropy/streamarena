#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRealDebridSettingsUpdate,
  normalizeRealDebridSettings,
  pickTorrentResolverProvider,
  resolveTorrentRequestProvider,
  shouldFallbackAutomaticTorrentResolveToExternal,
} from "../src-ui/lib/real-debrid-settings.js";

const legacy = normalizeRealDebridSettings({
  configured: true,
  maskedApiKey: "abcd…wxyz",
});
assert.deepEqual(legacy, {
  configured: true,
  enabled: true,
  active: true,
  maskedApiKey: "abcd…wxyz",
  localTorrentEnabled: false,
});

const disabled = normalizeRealDebridSettings({
  configured: true,
  enabled: false,
  maskedApiKey: "abcd…wxyz",
  apiKey: "server-must-never-return-this",
  localTorrentEnabled: true,
});
assert.equal(disabled.active, false);
assert.equal(disabled.localTorrentEnabled, true);
assert.equal(Object.hasOwn(disabled, "apiKey"), false);
assert.equal(JSON.stringify(disabled).includes("server-must-never-return-this"), false);

const missingToken = normalizeRealDebridSettings({
  configured: false,
  enabled: true,
});
assert.equal(missingToken.enabled, false);
assert.equal(missingToken.active, false);

const aliasEnabled = normalizeRealDebridSettings({
  configured: true,
  realDebridEnabled: false,
});
assert.equal(aliasEnabled.enabled, false);
assert.equal(aliasEnabled.active, false);

assert.deepEqual(buildRealDebridSettingsUpdate(), {});
assert.deepEqual(buildRealDebridSettingsUpdate({
  apiKey: "  replacement-token  ",
  apiKeyDirty: true,
  enabled: true,
}), {
  apiKey: "replacement-token",
  realDebridEnabled: true,
});
assert.deepEqual(buildRealDebridSettingsUpdate({
  enabled: false,
  enabledDirty: true,
}), {
  realDebridEnabled: false,
});
assert.deepEqual(buildRealDebridSettingsUpdate({
  localTorrentEnabled: true,
  localTorrentDirty: true,
}), {
  localTorrentEnabled: true,
});

assert.equal(pickTorrentResolverProvider({
  currentProvider: "fastest",
  realDebridActive: true,
  localTorrentEnabled: true,
}), "fastest");
assert.equal(pickTorrentResolverProvider({
  currentProvider: "fastest",
  realDebridActive: true,
}), "real-debrid");
assert.equal(pickTorrentResolverProvider({
  currentProvider: "fastest",
  localTorrentEnabled: true,
}), "local-torrent");
assert.equal(pickTorrentResolverProvider({
  currentProvider: "fastest",
  isEmbed: true,
  realDebridActive: true,
}), "fastest");
assert.equal(pickTorrentResolverProvider({
  currentProvider: "fastest",
}), "fastest");

assert.equal(resolveTorrentRequestProvider({
  currentProvider: "fastest",
  skipExternalEmbed: true,
  realDebridActive: true,
  localTorrentEnabled: true,
}), "fastest");
assert.equal(resolveTorrentRequestProvider({
  currentProvider: "fastest",
  skipExternalEmbed: true,
  localTorrentEnabled: true,
}), "local-torrent");
assert.equal(resolveTorrentRequestProvider({
  currentProvider: "real-debrid",
  skipExternalEmbed: true,
  realDebridActive: true,
  localTorrentEnabled: true,
}), "real-debrid");

assert.equal(shouldFallbackAutomaticTorrentResolveToExternal({
  skipExternalEmbed: true,
  resolverProvider: "fastest",
}), true);
assert.equal(shouldFallbackAutomaticTorrentResolveToExternal({
  skipExternalEmbed: true,
  resolverProvider: "real-debrid",
}), false);
assert.equal(shouldFallbackAutomaticTorrentResolveToExternal({
  skipExternalEmbed: true,
  resolverProvider: "fastest",
  sourceHash: "a".repeat(40),
}), false);

console.log("real-debrid-settings-test: ok");
