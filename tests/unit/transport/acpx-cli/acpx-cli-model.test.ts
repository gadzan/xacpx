import { expect, mock, test } from "bun:test";

import { AcpxCliTransport } from "../../../../src/transport/acpx-cli/acpx-cli-transport";
import type { ResolvedSession } from "../../../../src/transport/types";

// agentCommand set so ensureSession uses the normal runner (not the PTY path).
const modelSession: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  model: "gpt-5.2[high]",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

const noModelSession: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

function okRunner() {
  return mock(async () => ({ code: 0, stdout: "", stderr: "" }));
}

test("ensureSession passes --model when the session has a resolved model", async () => {
  const run = okRunner();
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  await transport.ensureSession(modelSession);
  const args = run.mock.calls[0][1] as string[];
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.2[high]");
  // global flag precedes the agent positional/subcommand
  expect(args.indexOf("--model")).toBeLessThan(args.indexOf("sessions"));
});

test("ensureSession omits --model when the session has none", async () => {
  const run = okRunner();
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  await transport.ensureSession(noModelSession);
  const args = run.mock.calls[0][1] as string[];
  expect(args).not.toContain("--model");
});

test("ensureSession retries without --model when the agent does not advertise the requested model", async () => {
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--model")) {
      return {
        code: 1,
        stdout: "",
        stderr:
          'Cannot apply --model "gpt-5.2[high]": the ACP agent did not advertise that model. Available models: gpt-5.2/high.',
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  // Resolves instead of throwing: the stale model is dropped, not fatal.
  await transport.ensureSession(modelSession);
  expect(calls.some((a) => a.includes("--model"))).toBe(true);
  expect(calls.some((a) => !a.includes("--model"))).toBe(true);
});

test("ensureSession surfaces non-model failures without retrying", async () => {
  let attempts = 0;
  const run = mock(async () => {
    attempts += 1;
    return { code: 1, stdout: "", stderr: "unrelated boom" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  await expect(transport.ensureSession(modelSession)).rejects.toThrow("unrelated boom");
  expect(attempts).toBe(1);
});

test("setModel issues `set ... model <id>` with the new model consistently", async () => {
  const run = okRunner();
  const transport = new AcpxCliTransport({
    command: "acpx",
    resolveSpawnEnvironment: ({ model }) => model === "claude-opus-4-8"
      ? { RESOLVED_MODEL: model }
      : undefined,
  }, run, okRunner());
  await transport.setModel({ ...noModelSession, driver: "claude" }, "claude-opus-4-8");
  const args = run.mock.calls[0][1] as string[];
  // operative positional command
  const setIdx = args.indexOf("set");
  expect(setIdx).toBeGreaterThanOrEqual(0);
  expect(args.slice(setIdx)).toEqual(["set", "-s", "backend:api-fix", "model", "claude-opus-4-8"]);
  // global --model agrees with the new id (not a stale old one)
  expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
  expect(run.mock.calls[0][2]).toMatchObject({
    stage: "set-model",
    env: { RESOLVED_MODEL: "claude-opus-4-8" },
  });
});

test("getSessionModel parses status json for current + available models", async () => {
  const statusJson = JSON.stringify({ model: "gpt-5.2[high]", availableModels: ["gpt-5.2[high]", "gpt-5.2[low]"] });
  const run = mock(async () => ({ code: 0, stdout: statusJson, stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  const result = await transport.getSessionModel(modelSession);
  expect(result.current).toBe("gpt-5.2[high]");
  expect(result.available).toEqual(["gpt-5.2[high]", "gpt-5.2[low]"]);
  const args = run.mock.calls[0][1] as string[];
  expect(args).toContain("status");
  expect(args.slice(0, 2)).toEqual(["--format", "json"]);
});

test("getSessionModel returns an empty available list when status output is not json", async () => {
  const run = mock(async () => ({ code: 0, stdout: "not json", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  const result = await transport.getSessionModel(modelSession);
  expect(result.available).toEqual([]);
});
