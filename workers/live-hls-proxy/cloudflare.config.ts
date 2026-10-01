import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "9349e7e9527ec0aad29368255a686ec4",
  worker: {
    name: "streamarena-live-hls-proxy",
    compatibilityDate: "2026-08-01",
    entrypoint: "src/index.js",
    // Preserve the custom playback domain and the workers.dev fallback.
    workersDev: true,
    domains: ["live.streamarena.xyz"],
    observability: { enabled: true, headSamplingRate: 0.1 },
    env: {
      ORIGIN_BASE: bindings.text("https://streamarena.xyz"),
      // cf reuses these existing remote secrets; values never belong in config.
      LIVE_HLS_PROXY_SECRET: bindings.secret(),
      ORIGIN_DIRECT_BASE: bindings.secret(),
      // The one-time legacy signature deadline is intentionally unset in production.
    },
  },
});
