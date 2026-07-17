import { expect, test } from "bun:test";

import { handleAdapterCli, type AdapterCliDeps } from "../../../src/adapters/adapter-cli";

function deps(overrides: Partial<AdapterCliDeps> = {}) {
  const lines: string[] = [];
  let saved: Record<string, string> | undefined;
  const base: AdapterCliDeps = {
    loadVersions: async () => ({}),
    saveVersions: async (versions) => { saved = versions; },
    getLatestVersion: async (id) => id === "codex" ? "1.1.4" : "0.59.0",
    versionExists: async () => true,
    verifyVersion: async () => {},
    print: (line) => lines.push(line),
  };
  return {
    deps: { ...base, ...overrides },
    lines,
    saved: () => saved,
  };
}

test("list is local-only and shows default versus configured effective versions", async () => {
  let networkCalls = 0;
  const ctx = deps({
    loadVersions: async () => ({ codex: "1.1.2" }),
    getLatestVersion: async () => { networkCalls += 1; return "9.9.9"; },
  });
  expect(await handleAdapterCli(["list"], ctx.deps)).toBe(0);
  expect(networkCalls).toBe(0);
  expect(ctx.lines.join("\n")).toContain("codex");
  expect(ctx.lines.join("\n")).toContain("1.1.2");
  expect(ctx.lines.join("\n")).toContain("1.1.4");
});

test("set verifies a published exact version before persisting it", async () => {
  const events: string[] = [];
  const ctx = deps({
    loadVersions: async () => ({ claude: "0.58.1" }),
    versionExists: async (id, version) => { events.push(`exists:${id}:${version}`); return true; },
    verifyVersion: async (id, version) => { events.push(`verify:${id}:${version}`); },
  });
  expect(await handleAdapterCli(["set", "codex", "1.1.2"], ctx.deps)).toBe(0);
  expect(events).toEqual(["exists:codex:1.1.2", "verify:codex:1.1.2"]);
  expect(ctx.saved()).toEqual({ claude: "0.58.1", codex: "1.1.2" });
});

test("failed verification never changes configured versions", async () => {
  let saves = 0;
  const ctx = deps({
    saveVersions: async () => { saves += 1; },
    verifyVersion: async () => { throw new Error("initialize failed"); },
  });
  expect(await handleAdapterCli(["set", "codex", "1.1.2"], ctx.deps)).toBe(1);
  expect(saves).toBe(0);
  expect(ctx.lines.join("\n")).toContain("initialize failed");
});

test("update --all verifies every latest version before one atomic save", async () => {
  const events: string[] = [];
  const ctx = deps({
    getLatestVersion: async (id) => id === "codex" ? "1.1.5" : "0.60.0",
    verifyVersion: async (id, version) => { events.push(`${id}:${version}`); },
  });
  expect(await handleAdapterCli(["update", "--all"], ctx.deps)).toBe(0);
  expect(events).toEqual(["codex:1.1.5", "claude:0.60.0"]);
  expect(ctx.saved()).toEqual({ codex: "1.1.5", claude: "0.60.0" });
});

test("update --all saves nothing when any candidate fails verification", async () => {
  let saves = 0;
  const ctx = deps({
    getLatestVersion: async (id) => id === "codex" ? "1.1.5" : "0.60.0",
    saveVersions: async () => { saves += 1; },
    verifyVersion: async (id) => {
      if (id === "claude") throw new Error("initialize failed");
    },
  });
  expect(await handleAdapterCli(["update", "--all"], ctx.deps)).toBe(1);
  expect(saves).toBe(0);
  expect(ctx.lines.join("\n")).toContain("claude");
});

test("reset removes only the selected local override", async () => {
  const ctx = deps({ loadVersions: async () => ({ codex: "1.1.2", claude: "0.58.1" }) });
  expect(await handleAdapterCli(["reset", "codex"], ctx.deps)).toBe(0);
  expect(ctx.saved()).toEqual({ claude: "0.58.1" });
});
