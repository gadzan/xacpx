import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalWebApp } from "../../../../packages/channel-web/src/app";

function control() {
  return {
    events: { subscribe: () => () => undefined },
    sessions: { list: async () => [] },
  };
}

/** A dashboard build on disk: one real chunk plus the app shell. */
function webRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xacpx-webroot-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "index-REAL.js"), "export const x = 1;\n");
  writeFileSync(join(root, "index.html"), "<!DOCTYPE html><script src=\"/assets/index-REAL.js\"></script>");
  return root;
}

function app(root: string) {
  return createLocalWebApp({
    config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
    port: 7138,
    control: control() as never,
    webRoot: root,
  }).app;
}

const headers = { host: "127.0.0.1:7138" };

describe("dashboard static serving", () => {
  test("serves a real asset as JavaScript, cacheable for a year", async () => {
    const response = await app(webRoot()).request("/assets/index-REAL.js", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  test("answers a missing asset with 404, never the HTML shell", async () => {
    // A build replaces its chunks, and a service worker that precached the old
    // shell goes looking for them. Answering with index.html meant 200 + markup
    // for a script: the browser runs markup as JavaScript and the worker caches
    // the junk under the old name, so the dead chunk is served forever.
    const response = await app(webRoot()).request("/assets/index-GONE.js", { headers });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  test("still serves the app shell for a client-side route", async () => {
    const response = await app(webRoot()).request("/settings", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("index-REAL.js");
  });
});
