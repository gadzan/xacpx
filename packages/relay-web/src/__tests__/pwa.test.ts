import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve paths relative to the package root regardless of the test runner cwd.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const viteConfig = readFileSync(resolve(pkgRoot, "vite.config.ts"), "utf8");

describe("PWA configuration", () => {
  it("registers vite-plugin-pwa with autoUpdate", () => {
    expect(viteConfig).toContain("vite-plugin-pwa");
    expect(viteConfig).toContain("VitePWA(");
    expect(viteConfig).toMatch(/registerType:\s*"autoUpdate"/);
  });

  it("never lets the service worker shadow the relay API / WebSocket", () => {
    // navigateFallback must deny /api and /ws so cached index.html is not served
    // for the hub's backend routes.
    expect(viteConfig).toContain("navigateFallbackDenylist");
    expect(viteConfig).toMatch(/\/\^\\\/api\//);
    expect(viteConfig).toMatch(/\/\^\\\/ws\//);
  });

  it("ships every manifest icon as a committed file in public/", () => {
    // Pull the icon `src` filenames straight out of the manifest block so a
    // renamed/missing icon (which would break installability) fails the build.
    const srcs = [...viteConfig.matchAll(/src:\s*"([^"]+\.png)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThanOrEqual(4);
    for (const src of srcs) {
      expect(existsSync(resolve(pkgRoot, "public", src))).toBe(true);
    }
  });

  it("keeps apple-touch-icon and favicon for iOS / legacy installs", () => {
    expect(existsSync(resolve(pkgRoot, "public/apple-touch-icon-180x180.png"))).toBe(true);
    expect(existsSync(resolve(pkgRoot, "public/favicon.ico"))).toBe(true);
  });
});
