// Observed from CineJoy's /servers and its native player on 2026-09-04.
// These are CineJoy server aliases, not identities shared with other addons.
export const CINEJOY_SERVERS = Object.freeze({
  LISBON: "Lisbon",
  NEBULA: "Nebula",
  SOLARA: "Solara",
});

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}

export function isCinejoyWatchUrl(value) {
  const url = safeUrl(value);
  return !!url && url.hostname === "cinejoy.to" && !url.search && !url.hash &&
    /^\/watch\/(?:movie\/[1-9]\d*|tv\/[1-9]\d*\/[1-9]\d*\/[1-9]\d*)$/.test(url.pathname);
}

export function isCinejoyPlaylistUrl(value, server) {
  const url = safeUrl(value);
  if (!url) return false;
  if (server === "LISBON") {
    return url.hostname === "info.movieboxnoob.cc" &&
      /^\/playlist\/[^/]+\.m3u8$/.test(url.pathname);
  }
  if (server === "NEBULA") {
    return url.hostname === "nebula.bright67.online" &&
      /^\/hls\/[^/]+\/master\.m3u8$/.test(url.pathname);
  }
  return server === "SOLARA" && url.hostname === "lol.movieboxnoob.cc" &&
    url.pathname === "/content" && !!url.searchParams.get("v");
}

export function isCinejoySupportRequest(value, type, method = "GET") {
  const url = safeUrl(value);
  if (!url || !["document", "script", "stylesheet", "fetch", "xhr"].includes(type)) return false;
  if (url.hostname === "cinejoy.to") return method === "GET";
  if (url.hostname === "api.shegu.st") {
    return (method === "POST" && url.pathname === "/g") ||
      (method === "GET" && ["/servers", "/crush.wasm"].includes(url.pathname));
  }
  return method === "GET" && url.hostname === "api.themoviedb.org" && url.pathname.startsWith("/3/");
}

export function selectCinejoyServer(payload, server) {
  const name = CINEJOY_SERVERS[server];
  const selected = payload?.servers?.find(item => item.name === name && item.status === "ok");
  if (!selected) throw new Error("Requested CineJoy server is unavailable.");
  return { servers: [selected] };
}
