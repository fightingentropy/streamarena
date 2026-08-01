export const SIGNATURE_CONTEXT_V1 = "streamarena-live-hls-v1";
export const SIGNATURE_CONTEXT_V2 = "streamarena-live-hls-v2";
export const SIGNATURE_TTL_SECONDS = 4 * 60 * 60;
export const SIGNATURE_MAX_TTL_SECONDS = 6 * 60 * 60;
export const SIGNATURE_CLOCK_SKEW_SECONDS = 60;

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const SEGMENT_CACHE_TTL_SECONDS = 20;
export const PLAYLIST_CACHE_TTL_SECONDS = 2;
export const VOD_PLAYLIST_CACHE_TTL_SECONDS = 300;

// HLS manifests must be buffered to rewrite their child URIs, so they get a
// hard aggregate cap. Media bytes remain streamed; only the PNG-disguised TS
// compatibility path buffers a segment, under its own strict cap.
export const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_BUFFERED_PNG_SEGMENT_BYTES = 16 * 1024 * 1024;
export const MAX_PLAYLIST_LINES = 20_000;
export const MAX_NESTED_PLAYLIST_REFERENCES = 64;
export const MAX_PLAYLIST_URI_CHARS = 8_192;
export const MAX_UPSTREAM_REDIRECTS = 3;
