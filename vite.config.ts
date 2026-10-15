import { defineConfig } from "vite";

const apiTarget = process.env.API_URL ?? "http://127.0.0.1:8787";

const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: false,
    proxy,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    assetsDir: "assets",
    // Deux pages : l'écran de show (toile nue) et le tableau de bord.
    rollupOptions: {
      input: {
        index: "index.html",
        dashboard: "dashboard.html",
      },
    },
  },
});
