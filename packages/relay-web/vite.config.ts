/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    vue(),
    // Installable PWA + app-shell precache. This is a WS-backed live console, so
    // the goal is installability (home screen / standalone window) and instant
    // repeat loads — NOT offline data. Live data still needs the WS reconnect.
    VitePWA({
      registerType: "autoUpdate",
      // We register explicitly in main.ts so registration order is predictable.
      injectRegister: false,
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "xacpx relay",
        short_name: "xacpx",
        description:
          "Self-hosted relay dashboard for xacpx — remote-control acpx sessions.",
        lang: "en",
        theme_color: "#0E1116",
        background_color: "#0E1116",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // App is an SPA: serve cached index.html for client-side routes, but never
        // shadow the relay hub's API / WebSocket endpoints.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        // Bundled font weights + main chunk can exceed the 2 MiB default.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      // Keep the service worker out of `vite dev` to avoid stale-cache surprises.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
