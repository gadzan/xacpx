import type { VitePWAOptions } from "vite-plugin-pwa";

// Single source of truth for the PWA config so vite.config.ts and the drift
// test (src/__tests__/pwa.test.ts) assert against the SAME object — no
// regex-matching of config source text.
//
// This is a WS-backed live console: the goal is installability (home screen /
// standalone window) and instant repeat loads via app-shell precache, NOT
// offline data. Live data still needs the WS reconnect.
export const pwaOptions: Partial<VitePWAOptions> = {
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
    // The brand tile is full-bleed with the X inside the maskable safe zone, so
    // each icon is declared "any maskable": desktop launchers render it
    // edge-to-edge (no white padding around a centered square) and circular
    // home-screen masks never clip the mark.
    icons: [
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png", purpose: "any maskable" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  },
  workbox: {
    globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
    // App is an SPA: serve cached index.html for client-side routes, but NEVER
    // shadow the relay hub's API / WebSocket endpoints.
    navigateFallback: "/index.html",
    navigateFallbackDenylist: [/^\/api/, /^\/ws/],
    clientsClaim: true,
    // Bundled font weights + main chunk can exceed the 2 MiB default.
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
  },
  // Keep the service worker out of `vite dev` to avoid stale-cache surprises.
  devOptions: { enabled: false },
};
