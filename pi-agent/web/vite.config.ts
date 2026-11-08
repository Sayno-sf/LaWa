import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
});
