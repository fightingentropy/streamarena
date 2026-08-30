#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  isKnownEmbedProviderHost,
  isStreamPlaylistUrl,
  shouldAllowEmbedRequest,
  shouldAbortEmbedRequest,
} from "./lib/external-embed-hls-policy.mjs";

assert.equal(
  shouldAllowEmbedRequest("https://cdn.speedracelight.com/player/app.js", "script"),
  true,
  "rotating Videasy CDN scripts on public HTTPS hosts should be allowed",
);
assert.equal(
  shouldAllowEmbedRequest("https://stream-7a2b.cdn.rest/api/config", "fetch"),
  true,
  "rotating .rest CDN fetch calls should be allowed",
);
assert.equal(
  shouldAllowEmbedRequest("https://hello.mousedoor.com/player.js", "script"),
  true,
  "legacy Videasy CDN hosts remain explicitly allowed",
);
assert.equal(
  shouldAllowEmbedRequest("https://vidlink.pro/script.js", "script"),
  true,
  "VidLink assets should remain allowed",
);
assert.equal(
  shouldAllowEmbedRequest("https://player.videasy.to/movie/155", "document"),
  true,
  "Videasy embed pages should remain allowed",
);
assert.equal(
  shouldAllowEmbedRequest("wss://cdn.speedracelight.com/socket", "websocket"),
  true,
  "public WSS support sockets should be allowed",
);
assert.equal(
  shouldAllowEmbedRequest("blob:https://player.videasy.to/abc-123", "script"),
  true,
  "blob support resources should be allowed",
);

assert.equal(
  shouldAllowEmbedRequest("https://cdn.speedracelight.com/poster.jpg", "image"),
  false,
  "images should still be blocked",
);
assert.equal(
  shouldAllowEmbedRequest("https://cdn.speedracelight.com/font.woff2", "font"),
  false,
  "fonts should still be blocked",
);
assert.equal(
  shouldAllowEmbedRequest("https://cdn.speedracelight.com/segment.ts", "media"),
  false,
  "non-playlist media should still be blocked",
);
assert.equal(
  shouldAllowEmbedRequest("http://cdn.speedracelight.com/player.js", "script"),
  false,
  "plain HTTP support resources should be blocked",
);
assert.equal(
  shouldAllowEmbedRequest("https://127.0.0.1/player.js", "script"),
  false,
  "loopback support resources should be blocked",
);
assert.equal(
  shouldAllowEmbedRequest("https://media.internal/player.js", "script"),
  false,
  ".internal support resources should be blocked",
);

assert.equal(
  isStreamPlaylistUrl("https://cdn.speedracelight.com/live/master.m3u8"),
  true,
  "public HTTPS playlists should still be accepted",
);
assert.equal(
  isStreamPlaylistUrl("http://cdn.speedracelight.com/live/master.m3u8"),
  false,
  "non-HTTPS playlists should be rejected",
);
assert.equal(
  isStreamPlaylistUrl("https://127.0.0.1/live/master.m3u8"),
  false,
  "loopback playlists should be rejected",
);
assert.equal(
  isStreamPlaylistUrl("https://cdn.speedracelight.com/live/master.mp4"),
  false,
  "non-playlist URLs should be rejected",
);

assert.equal(shouldAbortEmbedRequest("https://example.com/a.jpg", "image"), true);
assert.equal(
  shouldAbortEmbedRequest("https://example.com/master.m3u8", "media"),
  false,
  "playlist media requests should not be aborted before allow checks",
);

assert.equal(isKnownEmbedProviderHost("cdn.speedracelight.com"), true);
assert.equal(isKnownEmbedProviderHost("player.videasy.net"), true);
assert.equal(isKnownEmbedProviderHost("vidlink.pro"), true);

console.log("External embed HLS allowlist permits public HTTPS support resources.");
