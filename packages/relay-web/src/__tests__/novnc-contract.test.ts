import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the wrapper against the REAL noVNC contract by reading upstream source
 * from node_modules. A hand-written `.d.ts` plus a hand-written fake once agreed
 * on `sendCredentials(password: string)` while upstream takes a credentials
 * OBJECT (`this._rfbCredentials = creds`, then VncAuth reads `.password`), so
 * every VncAuth password login actually failed. These assertions make that class
 * of drift fail CI instead of the field.
 */
const require = createRequire(import.meta.url);
// The package's `exports` is a bare string for ".", so resolve the entry and
// walk up to the package root to stay independent of the subpath layout.
const novncEntry = require.resolve("@novnc/novnc");
const novncRoot = novncEntry.replace(/[\\/]core[\\/][^\\/]+$/, "");
const novncRfb = readFileSync(resolve(novncRoot, "core/rfb.js"), "utf8");

describe("noVNC upstream API contract", () => {
  it("sendCredentials takes the credentials object and stores it", () => {
    // The signature is `sendCredentials(creds)`, not `sendCredentials(password)`.
    expect(novncRfb).toMatch(/sendCredentials\(creds\)\s*\{\s*this\._rfbCredentials = creds;/);
  });

  it("standard VncAuth derives the DES response from _rfbCredentials.password", () => {
    expect(novncRfb).toMatch(/RFB\.genDES\(this\._rfbCredentials\.password, challenge\)/);
    // A missing password re-dispatches credentialsrequired (what our old
    // string-passing bug triggered forever).
    expect(novncRfb).toMatch(
      /_negotiateStdVNCAuth\(\)[\s\S]*?if \(this\._rfbCredentials\.password === undefined\) \{\s*this\.dispatchEvent\(new CustomEvent\(\s*"credentialsrequired"/,
    );
  });

  it("scaleViewport is a writable property defaulting to false, not a constructor option", () => {
    // Constructor options are only these four.
    expect(novncRfb).toMatch(
      /this\._rfbCredentials = options\.credentials \|\| \{\};\s*this\._shared = 'shared' in options \? !!options\.shared : true;\s*this\._repeaterID = options\.repeaterID \|\| '';\s*this\._wsProtocols = options\.wsProtocols \|\| \[\];/,
    );
    expect(novncRfb).not.toMatch(/options\.scaleViewport/);
    // Post-construction accessor pair with a false default.
    expect(novncRfb).toMatch(/this\._scaleViewport = false;/);
    expect(novncRfb).toMatch(/get scaleViewport\(\) \{ return this\._scaleViewport; \}/);
    expect(novncRfb).toMatch(/set scaleViewport\(scale\) \{/);
  });
});
