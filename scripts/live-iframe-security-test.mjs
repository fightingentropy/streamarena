import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  parseLiveIframePlaybackSource,
} from "../src-ui/player/live-iframe-policy.js";

const origin = "https://streamarena.test";
const encode = (value) => `live-iframe:${encodeURIComponent(value)}`;

assert.equal(
  parseLiveIframePlaybackSource(encode("https://ntvs.cx/channel/305"), origin),
  "",
  "legacy NTVS frames must be rejected",
);
assert.equal(
  parseLiveIframePlaybackSource(encode("https://evil.example/phish"), origin),
  "",
  "arbitrary third-party frames must be rejected",
);
assert.equal(
  parseLiveIframePlaybackSource(encode("/login.html"), origin),
  "",
  "same-origin paths from query parameters must not become frames",
);
assert.equal(
  parseLiveIframePlaybackSource("live-iframe:javascript%3Aalert(1)", origin),
  "",
  "non-HTTPS schemes must be rejected",
);
const [templateSource, playerSource] = await Promise.all([
  readFile(new URL("../src-ui/player/player-shell-template.jsx", import.meta.url), "utf8"),
  readFile(new URL("../src-ui/pages/player.js", import.meta.url), "utf8"),
]);
assert.doesNotMatch(templateSource, /liveEmbedFrame|live-embed-frame/);
assert.doesNotMatch(playerSource, /setLiveIframePlaybackSource|liveEmbedFrame/);

console.log("Live iframe policy rejects arbitrary frames and the player has no iframe adoption path.");
