// StreamArena live-HLS edge entrypoint. Domain code is split by trust boundary:
// signed bearer authorization, pinned origin transport, playlist rewriting and
// streamed media resources. Only this file owns public route dispatch.
import {
  SIGNATURE_CLOCK_SKEW_SECONDS,
  SIGNATURE_MAX_TTL_SECONDS,
  SIGNATURE_TTL_SECONDS,
} from "./constants.js";
import {
  authorizeSignedRequest,
  legacySignatureIsTemporarilyAllowed,
  parseSignatureExpiry,
  verifySignature,
} from "./authorization.js";
import { deny } from "./http.js";
import { handlePlaylist } from "./playlist.js";
import { handleResource } from "./resource.js";

export {
  SIGNATURE_CLOCK_SKEW_SECONDS,
  SIGNATURE_MAX_TTL_SECONDS,
  SIGNATURE_TTL_SECONDS,
  authorizeSignedRequest,
  legacySignatureIsTemporarilyAllowed,
  parseSignatureExpiry,
  verifySignature,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live/hls.m3u8") return handlePlaylist(request, url, env);
    if (url.pathname === "/api/live/hls-resource") return handleResource(request, url, env);
    return deny(404, "not found");
  },
};
