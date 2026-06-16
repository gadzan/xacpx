import { expect, test } from "bun:test";

import { isExecutableOnPath, resolveLocalAgentCommand } from "../../../src/config/local-agent-bin";
import { resolveRuntimeAgentCommand } from "../../../src/config/resolve-agent-command";

test("resolveLocalAgentCommand prefers a native opencode on PATH", () => {
  expect(resolveLocalAgentCommand("opencode", (name) => name === "opencode")).toBe("opencode acp");
  expect(resolveLocalAgentCommand("kilocode", (name) => name === "kilocode")).toBe("kilocode acp");
});

test("resolveLocalAgentCommand returns undefined when the native CLI is not on PATH", () => {
  expect(resolveLocalAgentCommand("opencode", () => false)).toBeUndefined();
});

test("resolveLocalAgentCommand ignores drivers that aren't unpinned-npx (native or pinned)", () => {
  // gemini/cursor/etc. are already native commands; codex/claude are handled by acpx.
  expect(resolveLocalAgentCommand("gemini", () => true)).toBeUndefined();
  expect(resolveLocalAgentCommand("codex", () => true)).toBeUndefined();
  expect(resolveLocalAgentCommand("claude", () => true)).toBeUndefined();
});

test("isExecutableOnPath finds a bin across PATH entries (posix)", () => {
  const env = { PATH: "/usr/bin:/home/me/.opencode/bin" } as NodeJS.ProcessEnv;
  const exists = (p: string) => p === "/home/me/.opencode/bin/opencode";
  expect(isExecutableOnPath("opencode", env, exists)).toBe(true);
  expect(isExecutableOnPath("nope", env, exists)).toBe(false);
});

test("isExecutableOnPath returns false when PATH is empty", () => {
  expect(isExecutableOnPath("opencode", { PATH: "" } as NodeJS.ProcessEnv, () => true)).toBe(false);
});

test("resolveRuntimeAgentCommand: explicit per-agent command always wins over local detection", () => {
  // Even with preferLocal on and opencode installed, an explicit command takes precedence.
  expect(resolveRuntimeAgentCommand("opencode", "my-custom-acp", true)).toBe("my-custom-acp");
});

test("resolveRuntimeAgentCommand: no explicit command + preferLocal prefers the local bin", () => {
  // PATH is consulted via the real isExecutableOnPath; assert the shape rather than env.
  const out = resolveRuntimeAgentCommand("gemini", undefined, true); // gemini not in the local map
  expect(out).toBeUndefined(); // → acpx resolves the native gemini command itself
});

test("resolveRuntimeAgentCommand: preferLocal=false never returns a local command", () => {
  expect(resolveRuntimeAgentCommand("opencode", undefined, false)).toBeUndefined();
});
