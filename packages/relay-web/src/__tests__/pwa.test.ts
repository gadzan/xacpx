import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pwaOptions } from "../pwa-options";

// Resolve paths relative to the package root regardless of the test runner cwd.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");

describe("PWA configuration", () => {
  it("uses an autoUpdate service worker registered explicitly in main.ts", () => {
    expect(pwaOptions.registerType).toBe("autoUpdate");
    // main.ts owns registration, so the plugin must not also inject it.
    expect(pwaOptions.injectRegister).toBe(false);
  });

  it("forces skipWaiting + clientsClaim so an open tab actually reloads to a new build", () => {
    // injectRegister:false suppresses the plugin's automatic skipWaiting, and the
    // autoUpdate registerSW only reloads on the worker's `activated` event. Without
    // skipWaiting the new worker stays in "waiting" forever for an open tab, so the
    // periodic update check (lib/pwa-update.ts) would download but never reload.
    expect(pwaOptions.workbox?.skipWaiting).toBe(true);
    expect(pwaOptions.workbox?.clientsClaim).toBe(true);
  });

  it("never lets the service worker shadow the relay API / WebSocket", () => {
    const denylist = pwaOptions.workbox?.navigateFallbackDenylist ?? [];
    // Behavioral: the actual regexes must match the hub's backend routes so the
    // cached index.html is never served for them.
    const denied = (path: string) => denylist.some((re) => re.test(path));
    expect(denied("/api/me")).toBe(true);
    expect(denied("/api/instances/x/rpc")).toBe(true);
    expect(denied("/ws")).toBe(true);
    // ...but real SPA routes still fall back to the cached shell.
    expect(denied("/settings")).toBe(false);
    expect(denied("/")).toBe(false);
    expect(pwaOptions.workbox?.navigateFallback).toBe("/index.html");
  });

  it("ships every manifest icon as a committed file in public/", () => {
    const manifest = pwaOptions.manifest;
    const icons = manifest ? manifest.icons ?? [] : [];
    expect(icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of icons) {
      expect(existsSync(resolve(pkgRoot, "public", icon.src))).toBe(true);
    }
    // No maskable icons: iOS treats maskable as adaptive and shrinks the tile
    // into the safe zone, leaving a white Home Screen border. The opaque
    // full-bleed icons render edge-to-edge as plain "any" icons instead.
    const purposeTokens = (p: (typeof icons)[number]["purpose"]): string[] =>
      Array.isArray(p) ? p : typeof p === "string" ? p.split(" ") : [];
    expect(icons.every((i) => !purposeTokens(i.purpose).includes("maskable"))).toBe(true);
  });

  it("keeps apple-touch, favicon, and the SVG / Safari mask icons", () => {
    for (const asset of pwaOptions.includeAssets ?? []) {
      expect(existsSync(resolve(pkgRoot, "public", asset as string))).toBe(true);
    }
    expect(existsSync(resolve(pkgRoot, "public/apple-touch-icon-180x180.png"))).toBe(true);
    expect(existsSync(resolve(pkgRoot, "public/favicon.ico"))).toBe(true);
    expect(existsSync(resolve(pkgRoot, "public/icon.svg"))).toBe(true);
    expect(existsSync(resolve(pkgRoot, "public/mask-icon.svg"))).toBe(true);
  });

  // Behavioral guard against the GENERATED service worker — only runs when a
  // build is present (skipped in a bare `vitest` run so CI never goes flaky).
  const swPath = resolve(pkgRoot, "dist/sw.js");
  it.skipIf(!existsSync(swPath))("emits a service worker that honors the api/ws denylist", () => {
    const sw = readFileSync(swPath, "utf8");
    expect(sw).toContain("denylist");
    expect(sw).toMatch(/\/\^\\\/api\//);
    expect(sw).toMatch(/\/\^\\\/ws\//);
  });

  // Guards against the autoUpdate "downloads but never reloads" regression. With
  // skipWaiting:true, generateSW emits an UNCONDITIONAL install-time
  // `self.skipWaiting(), <wb>.clientsClaim()` bootstrap (and drops the passive
  // SKIP_WAITING message handler). Without it the worker would only skipWaiting in
  // response to a message the autoUpdate path never sends — installing but never
  // activating for an open tab. Match the unconditional form so the message-gated
  // `..."SKIP_WAITING"===e.data.type&&self.skipWaiting()` form can't satisfy it.
  it.skipIf(!existsSync(swPath))("emits a service worker that skips waiting on install", () => {
    const sw = readFileSync(swPath, "utf8");
    expect(sw).toMatch(/self\.skipWaiting\(\)\s*,\s*\w+\.clientsClaim\(\)/);
  });
});
