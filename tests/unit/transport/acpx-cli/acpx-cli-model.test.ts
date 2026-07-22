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

test("getSessionEffort reads the adapter-advertised thought-level config option", async () => {
  const record = JSON.stringify({
    acpx: {
      config_options: [
        {
          id: "reasoning_effort",
          category: "thought_level",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
  });
  const run = mock(async () => ({ code: 0, stdout: record, stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());

  await expect(transport.getSessionEffort(modelSession)).resolves.toEqual({
    current: "medium",
    available: ["low", "medium", "high"],
  });
  const args = run.mock.calls[0][1] as string[];
  expect(args).toContain("sessions");
  expect(args).toContain("show");
  expect(args).toContain("backend:api-fix");
  expect(args.slice(0, 2)).toEqual(["--format", "json"]);
});

test("getSessionEffort flattens adapter-advertised grouped effort options", async () => {
  const record = JSON.stringify({
    acpx: {
      config_options: [{
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "high",
        options: [
          {
            group: "standard",
            name: "Standard",
            options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
          },
          {
            group: "extended",
            name: "Extended",
            options: [{ value: "xhigh" }],
          },
        ],
      }],
    },
  });
  const run = mock(async () => ({ code: 0, stdout: record, stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());

  await expect(transport.getSessionEffort(modelSession)).resolves.toEqual({
    current: "high",
    available: ["low", "medium", "high", "xhigh"],
  });
});

test("setSessionEffort uses the config id advertised by the adapter", async () => {
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("sessions")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpx: {
            config_options: [{
              id: "effort",
              category: "thought_level",
              currentValue: "medium",
              options: [{ value: "medium" }, { value: "high" }],
            }],
          },
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());

  await transport.setSessionEffort(modelSession, "high");

  const setArgs = calls.find((args) => args.includes("set"));
  expect(setArgs?.slice(setArgs.indexOf("set"))).toEqual([
    "set", "-s", "backend:api-fix", "effort", "high",
  ]);
});

test("setSessionEffort rejects values not advertised by the adapter", async () => {
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    return {
      code: 0,
      stdout: JSON.stringify({
        acpx: { config_options: [{
          id: "reasoning_effort",
          category: "thought_level",
          currentValue: "medium",
          options: [{ value: "medium" }, { value: "high" }],
        }] },
      }),
      stderr: "",
    };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());

  await expect(transport.setSessionEffort(modelSession, "extreme")).rejects.toThrow(
    'reasoning effort "extreme" is not advertised',
  );
  expect(calls.some((args) => args.includes("set"))).toBe(false);
});

test("effort get/set apply the session's resolved provider environment", async () => {
  const options: Array<{ env?: NodeJS.ProcessEnv } | undefined> = [];
  const run = mock(async (_command: string, args: string[], runOptions?: { env?: NodeJS.ProcessEnv }) => {
    options.push(runOptions);
    return {
      code: 0,
      stdout: args.includes("sessions")
        ? JSON.stringify({
            acpx: { config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "medium",
              options: [{ value: "medium" }, { value: "high" }],
            }] },
          })
        : "",
      stderr: "",
    };
  });
  const transport = new AcpxCliTransport({
    command: "acpx",
    resolveSpawnEnvironment: ({ driver, settingsPolicy }) => ({
      RESOLVED_DRIVER: driver ?? "",
      RESOLVED_POLICY: settingsPolicy ?? "",
    }),
  }, run, okRunner());
  const providerSession = {
    ...modelSession,
    agent: "claude-provider",
    driver: "claude" as const,
    settingsPolicy: "provider-only" as const,
  };

  await transport.getSessionEffort(providerSession);
  await transport.setSessionEffort(providerSession, "high");

  expect(options).toHaveLength(3);
  for (const runOptions of options) {
    expect(runOptions?.env).toEqual({
      RESOLVED_DRIVER: "claude",
      RESOLVED_POLICY: "provider-only",
    });
  }
});
