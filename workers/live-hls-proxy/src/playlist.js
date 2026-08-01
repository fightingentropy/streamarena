import { authorizeSignedRequest } from "./authorization.js";
import {
  MAX_ERROR_BODY_BYTES,
  MAX_NESTED_PLAYLIST_REFERENCES,
  MAX_PLAYLIST_BYTES,
  MAX_PLAYLIST_LINES,
  MAX_PLAYLIST_URI_CHARS,
  PLAYLIST_CACHE_TTL_SECONDS,
  VOD_PLAYLIST_CACHE_TTL_SECONDS,
} from "./constants.js";
import { BodyLimitError, deny, readBoundedText, upstreamCacheStatus } from "./http.js";
import { fetchFromOrigin } from "./origin.js";

export class PlaylistLimitError extends Error {}

function rewriteProxiedLiveUrl(pathAndQuery, workerBase) {
  if (pathAndQuery.length > MAX_PLAYLIST_URI_CHARS) {
    throw new PlaylistLimitError("playlist URI too long");
  }
  if (pathAndQuery.startsWith("/api/live/hls-resource?")) {
    return `${workerBase}${pathAndQuery}&viaOrigin=1`;
  }
  return `${workerBase}${pathAndQuery}`;
}

const URI_ATTRIBUTE_PATTERN = /URI="(\/api\/live\/(?:hls\.m3u8|hls-resource)\?[^"]*)"/g;

export function rewriteOriginPlaylist(body, workerBase) {
  const lines = body.split("\n");
  if (lines.length > MAX_PLAYLIST_LINES) {
    throw new PlaylistLimitError("playlist has too many lines");
  }
  let nestedPlaylists = 0;
  const rewritten = lines.map((line) => {
    if (line.startsWith("#")) {
      return line.replace(URI_ATTRIBUTE_PATTERN, (_match, pathAndQuery) => {
        if (pathAndQuery.startsWith("/api/live/hls.m3u8?")) nestedPlaylists += 1;
        return `URI="${rewriteProxiedLiveUrl(pathAndQuery, workerBase)}"`;
      });
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("/api/live/hls.m3u8?")) {
      nestedPlaylists += 1;
      return rewriteProxiedLiveUrl(trimmed, workerBase);
    }
    if (trimmed.startsWith("/api/live/hls-resource?")) {
      return rewriteProxiedLiveUrl(trimmed, workerBase);
    }
    return line;
  });
  if (nestedPlaylists > MAX_NESTED_PLAYLIST_REFERENCES) {
    throw new PlaylistLimitError("playlist fan-out limit exceeded");
  }
  return rewritten.join("\n");
}

export async function handlePlaylist(request, url, env) {
  if (request.method !== "GET") return deny(405, "method not allowed");
  const authorized = await authorizeSignedRequest(url, env);
  if (authorized instanceof Response) return authorized;

  const immutableVod = url.searchParams.get("directSeg") === "1";
  const playlistTtl = immutableVod
    ? VOD_PLAYLIST_CACHE_TTL_SECONDS
    : PLAYLIST_CACHE_TTL_SECONDS;
  const originFetch = fetchFromOrigin(
    env,
    "/api/live/hls.m3u8",
    url.search,
    request.headers,
    playlistTtl,
  );
  if (!originFetch) return deny(503, "origin not configured");

  let upstream;
  try {
    upstream = await originFetch;
  } catch {
    return deny(502, "origin fetch failed");
  }
  if (!upstream.ok) {
    let message = "origin request failed";
    try {
      message = await readBoundedText(upstream, MAX_ERROR_BODY_BYTES);
    } catch {
      // Keep a small generic error; never buffer an unbounded origin response.
    }
    return new Response(message, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain",
        "Access-Control-Allow-Origin": "*",
        "X-Live-Proxy": "cf-worker",
        "X-Upstream-Cache": upstreamCacheStatus(upstream),
      },
    });
  }

  let body;
  try {
    body = rewriteOriginPlaylist(
      await readBoundedText(upstream, MAX_PLAYLIST_BYTES),
      url.origin,
    );
  } catch (error) {
    if (error instanceof BodyLimitError || error instanceof PlaylistLimitError) {
      return deny(502, "origin playlist exceeded safety limits");
    }
    return deny(502, "origin playlist invalid");
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "cache-control": immutableVod
        ? `public, max-age=${VOD_PLAYLIST_CACHE_TTL_SECONDS}`
        : "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Live-Proxy": "cf-worker",
      "X-Live-Proxy-Mode": "playlist",
      "X-Upstream-Cache": upstreamCacheStatus(upstream),
    },
  });
}
