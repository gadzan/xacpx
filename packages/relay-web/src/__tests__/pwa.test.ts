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
    expect(icons.length).toBeGreaterThanOrEqual(4);
    for (const icon of icons) {
      expect(existsSync(resolve(pkgRoot, "public", icon.src))).toBe(true);
    }
    // The maskable variant must be present and tagged so installs get a
    // full-bleed icon instead of a letterboxed one.
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("keeps apple-touch-icon and favicon for iOS / legacy installs", () => {
    for (const asset of pwaOptions.includeAssets ?? []) {
      expect(existsSync(resolve(pkgRoot, "public", asset as string))).toBe(true);
    }
    expect(existsSync(resolve(pkgRoot, "public/apple-touch-icon-180x180.png"))).toBe(true);
    expect(existsSync(resolve(pkgRoot, "public/favicon.ico"))).toBe(true);
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
});
