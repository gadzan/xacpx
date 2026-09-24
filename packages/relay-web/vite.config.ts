/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { pwaOptions } from "./src/pwa-options";

export default defineConfig({
  // Installable PWA + app-shell precache. Config lives in src/pwa-options.ts so
  // the drift test asserts against the same object the build uses.
  plugins: [vue(), VitePWA(pwaOptions)],
  // noVNC 1.7 ships a top-level await in core/util/browser.js (WebCodecs H264
  // probe). es2022 is the first target that permits it; Chrome 89+ (2021)
  // covers every browser the dashboard already requires.
  build: { target: "es2022" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      // Desktop browser data plane is same-origin `/desktop/observe?...` in
      // production; without this entry `vite dev` would answer the upgrade
      // itself instead of proxying to the hub.
      "/desktop/observe": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Playwright specs live in e2e/ and use @playwright/test's own runner; they
    // must never be collected by vitest (which would fail with "Playwright Test
    // did not expect test.describe() to be called here").
    include: ["src/**/*.test.ts"],
  },
});
