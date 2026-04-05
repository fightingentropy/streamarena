import { resolve } from "node:path";

import { defineConfig } from "vite";

const pages = {
  index: resolve(__dirname, "index.html"),
  player: resolve(__dirname, "player.html"),
  settings: resolve(__dirname, "settings.html"),
  upload: resolve(__dirname, "upload.html"),
  "new-popular": resolve(__dirname, "new-popular.html"),
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
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "ui-assets",
    rollupOptions: {
      input: pages,
    },
  },
});
