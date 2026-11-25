import { expect, test } from "bun:test";

import {
  defaultAcpxRunner,
  resolvePtyChildEnvironment,
  runWithSpawnTimeout,
  shellSessionCreateRunner,
  spawnCapture,
} from "../../../src/transport/acpx-spawn";
import { CommandTimeoutError } from "../../../src/transport/command-timeouts";

// Phase 1 differential pins: the unified spawn primitives must preserve both
// lanes' legacy contracts (bridge `spawnCapture` semantics + CLI
// `runCommandWithTimeout` redaction/abort semantics).

test("spawnCapture rejects with CommandTimeoutError and kills the tree on timeout", async () => {
  const killed: number[] = [];
  const spawnFn = (() => {
    let close: ((code: number | null) => void) | undefined;
    const handlers: Record<string, Array<(arg: never) => void>> = {};
    return {
      pid: 4242,
      stdout: { setEncoding: () => {}, on: (e: string, h: (c: string) => void) => { (handlers[e] ??= []).push(h as never); } },
      stderr: { setEncoding: () => {}, on: (e: string, h: (c: string) => void) => { (handlers[e] ??= []).push(h as never); } },
      on: (e: string, h: (c: never) => void) => { (handlers[e] ??= []).push(h); if (e === "close") close = h as never; },
    };
  }) as never;

  let caught: unknown;
  try {
    await spawnCapture("acpx", ["sessions", "show", "demo"], {
      timeoutMs: 10,
      stage: "has-session",
      spawnFn,
      killProcessTreeFn: async (pid: number) => { killed.push(pid); },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CommandTimeoutError);
  expect((caught as CommandTimeoutError).stage).toBe("has-session");
  expect(killed).toEqual([4242]);
});

test("spawnCapture honors an abort signal by killing the tree (CLI defaultRunner contract)", async () => {
  const killed: number[] = [];
  const controller = new AbortController();
  let child: { pid: number } | undefined;
  const spawnFn = ((..._args: unknown[]) => {
    child = { pid: 9999 };
    return {
      ...child,
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      on: () => {},
    };
  }) as never;

  const pending = spawnCapture("acpx", ["prompt"], {
    signal: controller.signal,
    spawnFn,
    killProcessTreeFn: async (pid: number) => { killed.push(pid); },
  });
  controller.abort();
  // The abort only kills; settlement still comes from the child. Emit close.
  await Bun.sleep(0);
  expect(killed).toEqual([9999]);
  void pending.catch(() => {});
});

test("runWithSpawnTimeout keeps the --format/--cwd redaction in timeout messages", async () => {
  const never = () => new Promise<never>(() => {});
  const args = [
    "--format", "quiet",
    "--cwd", "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions", "deny",
    "--agent", "./node_modules/.bin/codex-acp",
    "sessions", "new",
    "--name", "backend:api-fix",
  ];
  await expect(runWithSpawnTimeout(never as never, "acpx", args, { timeoutMs: 1 })).rejects.toThrow(
    'acpx command timed out after 1ms: --approve-all --non-interactive-permissions deny --agent ./node_modules/.bin/codex-acp sessions new --name "backend:api-fix"',
  );
});

test("runWithSpawnTimeout calls the runner directly without a timeout", async () => {
  const seen: Array<{ command: string; args: string[]; options?: unknown }> = [];
  const result = await runWithSpawnTimeout(
    async (command, args, options) => {
      seen.push({ command, args, options });
      return { code: 0, stdout: "ok", stderr: "" };
    },
    "acpx",
    ["sessions", "show", "demo"],
  );
  expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
  expect(seen).toHaveLength(1);
});

test("pty child env stays authoritative and stamps the locale", () => {
  expect(resolvePtyChildEnvironment(
    { ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1", KEEP: "base" },
    { KEEP: "filtered", ANTHROPIC_AUTH_TOKEN: "token" },
    "zh-CN",
  )).toEqual({
    KEEP: "filtered",
    ANTHROPIC_AUTH_TOKEN: "token",
    XACPX_LANG: "zh-CN",
  });
});

test("shellSessionCreateRunner threads cwd into the spawn", async () => {
  const seen: Array<{ args: unknown; options: unknown }> = [];
  const spawnFn = ((command: string, args: string[], options: { cwd?: string }) => {
    seen.push({ args: [command, ...args], options });
    return {
      pid: 1,
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      on: (e: string, h: (code: number) => void) => { if (e === "close") h(0); },
    };
  }) as never;

  // Patch spawnCapture's seam through defaultAcpxRunner is not possible here;
  // exercise the cwd threading via shellSessionCreateRunner's own seam.
  await shellSessionCreateRunner("acpx", ["sessions", "new"], "/repo", {
    spawnFn,
    killProcessTreeFn: async () => {},
  } as never);
  expect((seen[0]?.options as { cwd?: string }).cwd).toBe("/repo");
});

test("defaultAcpxRunner resolves script commands through the spawn spec", async () => {
  const seen: string[][] = [];
  const spawnFn = ((command: string, args: string[]) => {
    seen.push([command, ...args]);
    return {
      pid: 2,
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      on: (e: string, h: (code: number) => void) => { if (e === "close") h(0); },
    };
  }) as never;

  await defaultAcpxRunner("D:\\fake\\acpx.js", ["sessions", "show"], { spawnFn } as never);
  // Script commands re-execute under the current node runtime.
  expect(seen[0]?.[0]).toBe(process.execPath);
  expect(seen[0]?.slice(1)).toEqual(["D:\\fake\\acpx.js", "sessions", "show"]);
});
