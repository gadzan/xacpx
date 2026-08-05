import { expect, test } from "bun:test";

import { handleAdapterCli, type AdapterCliDeps } from "../../../src/adapters/adapter-cli";

function deps(overrides: Partial<AdapterCliDeps> = {}) {
  const lines: string[] = [];
  let saved: Record<string, string> | undefined;
  const base: AdapterCliDeps = {
    loadVersions: async () => ({}),
    saveVersions: async (versions) => { saved = versions; },
    loadRegistry: async () => undefined,
    saveRegistry: async () => {},
    getLatestVersion: async (id) => id === "codex" ? "1.1.4" : "0.59.0",
    versionExists: async () => true,
    verifyVersion: async () => {},
    preinstall: async (_id, _version) => ({ releaseId: "release-test" }),
    listInstalled: async () => [],
    print: (line) => lines.push(line),
  };
  return {
    deps: { ...base, ...overrides },
    lines,
    saved: () => saved,
  };
}

test("registry shows the official npm default and can set or reset a local override", async () => {
  const savedRegistries: Array<string | undefined> = [];
  const ctx = deps({
    loadRegistry: async () => undefined,
    saveRegistry: async (registry) => { savedRegistries.push(registry); },
  });

  expect(await handleAdapterCli(["registry"], ctx.deps)).toBe(0);
  expect(ctx.lines.join("\n")).toContain("https://registry.npmjs.org");

  expect(await handleAdapterCli(["registry", "set", "https://npm.corp.example/repository/npm"], ctx.deps)).toBe(0);
  expect(savedRegistries).toEqual(["https://npm.corp.example/repository/npm"]);

  expect(await handleAdapterCli(["registry", "reset"], ctx.deps)).toBe(0);
  expect(savedRegistries).toEqual(["https://npm.corp.example/repository/npm", undefined]);
});

test("preinstall uses the effective version/registry and installed listing is local", async () => {
  const calls: string[] = [];
  const ctx = deps({
    loadVersions: async () => ({ codex: "1.1.2" }),
    loadRegistry: async () => "https://npm.example/",
    preinstall: async (id, version, registry) => {
      calls.push(`${id}:${version}:${registry}`);
      return { releaseId: "1.1.2-deadbeef-12345678" };
    },
    listInstalled: async () => [{ id: "codex", releaseId: "1.1.2-deadbeef-12345678", active: true }],
  });
  expect(await handleAdapterCli(["preinstall", "codex"], ctx.deps)).toBe(0);
  expect(calls).toEqual(["codex:1.1.2:https://npm.example"]);
  expect(await handleAdapterCli(["list", "--installed"], ctx.deps)).toBe(0);
  expect(ctx.lines.join("\n")).toContain("1.1.2-deadbeef-12345678");
});

test("registry rejects unsafe URLs without changing config", async () => {
  let saves = 0;
  const ctx = deps({ saveRegistry: async () => { saves += 1; } });
  for (const registry of [
    "https://user:secret@npm.example/",
    "https://npm.example/repository/;touch-pwned",
  ]) {
    expect(await handleAdapterCli(["registry", "set", registry], ctx.deps)).toBe(1);
  }
  expect(saves).toBe(0);
  expect(ctx.lines.join("\n")).toContain("registry");
});

test("check queries npm through the configured adapter registry", async () => {
  const queried: string[] = [];
  const ctx = deps({
    loadRegistry: async () => "https://npm.corp.example/repository/npm/",
    getLatestVersion: async (id, registry) => {
      queried.push(`${id}:${registry}`);
      return id === "codex" ? "1.1.4" : "0.59.0";
    },
  });
  expect(await handleAdapterCli(["check"], ctx.deps)).toBe(0);
  expect(queried).toEqual([
    "codex:https://npm.corp.example/repository/npm",
    "claude:https://npm.corp.example/repository/npm",
  ]);
});

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
    loadRegistry: async () => "https://npm.corp.example/",
    versionExists: async (id, version, registry) => { events.push(`exists:${id}:${version}:${registry}`); return true; },
    verifyVersion: async (id, version, registry) => { events.push(`verify:${id}:${version}:${registry}`); },
  });
  expect(await handleAdapterCli(["set", "codex", "1.1.2"], ctx.deps)).toBe(0);
  expect(events).toEqual([
    "exists:codex:1.1.2:https://npm.corp.example",
    "verify:codex:1.1.2:https://npm.corp.example",
  ]);
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
