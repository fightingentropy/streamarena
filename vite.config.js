import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import solid from "vite-plugin-solid";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pages = {
  index: resolve(__dirname, "index.html"),
  login: resolve(__dirname, "login.html"),
  player: resolve(__dirname, "player.html"),
  settings: resolve(__dirname, "settings.html"),
  live: resolve(__dirname, "live.html"),
  sports: resolve(__dirname, "sports.html"),
  admin: resolve(__dirname, "admin.html"),
  help: resolve(__dirname, "help.html"),
  privacy: resolve(__dirname, "privacy.html"),
  terms: resolve(__dirname, "terms.html"),
  "reset-password": resolve(__dirname, "reset-password.html"),
};

export default defineConfig({
  appType: "mpa",
  server: {
    host: "localhost",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5173",
    },
  },
  plugins: [
    solid(),
    {
      name: "clean-url-rewrites",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith("/watch")) {
            const [, query] = req.url.split("?");
            req.url = `/player.html${query ? `?${query}` : ""}`;
          } else if (req.url === "/sports" || req.url?.startsWith("/sports?")) {
            const [, query] = req.url.split("?");
            req.url = `/sports.html${query ? `?${query}` : ""}`;
          } else if (req.url === "/admin" || req.url?.startsWith("/admin?")) {
            const [, query] = req.url.split("?");
            req.url = `/admin.html${query ? `?${query}` : ""}`;
          } else if (req.url === "/help" || req.url?.startsWith("/help?")) {
            const [, query] = req.url.split("?");
            req.url = `/help.html${query ? `?${query}` : ""}`;
          } else if (req.url === "/privacy" || req.url?.startsWith("/privacy?") || req.url?.startsWith("/privacy#")) {
            const [, query] = req.url.split("?");
            req.url = `/privacy.html${query ? `?${query}` : ""}`;
          } else if (req.url === "/terms" || req.url?.startsWith("/terms?")) {
            const [, query] = req.url.split("?");
            req.url = `/terms.html${query ? `?${query}` : ""}`;
          } else if (
            req.url === "/reset-password" ||
            req.url?.startsWith("/reset-password/") ||
            req.url?.startsWith("/reset-password?")
          ) {
            req.url = "/reset-password.html";
          }
          next();
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "ui-assets",
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: pages,
    },
  },
});
