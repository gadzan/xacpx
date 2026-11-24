import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pwaOptions } from "../pwa-options";

// Resolve paths relative to the package root regardless of the test runner cwd.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");

describe("PWA push injection", () => {
  it("injects the push service worker via importScripts", () => {
    expect(pwaOptions.workbox?.importScripts).toEqual(["/push-sw.js"]);
    // The push SW itself must exist in public/ so it ships at the site root.
    expect(existsSync(resolve(pkgRoot, "public/push-sw.js"))).toBe(true);
  });
});
