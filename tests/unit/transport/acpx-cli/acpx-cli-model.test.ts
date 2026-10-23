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

test("ensureSession surfaces non-model failures without the model retry", async () => {
  let attempts = 0;
  const run = mock(async () => {
    attempts += 1;
    return { code: 1, stdout: "", stderr: "unrelated boom" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run, okRunner());
  await expect(transport.ensureSession(modelSession)).rejects.toThrow("unrelated boom");
  // ensure → show probe → new (mirrors the bridge); the model retry is NOT one
  // of them, so a non-model failure surfaces as-is after the fallback chain.
  expect(attempts).toBe(3);
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


test("cold command discovery only ensures/reads advertisement and never prompts",async()=>{
 const calls:string[][]=[];
 const runner=mock(async(_command:string,args:string[])=>{calls.push(args);return {code:0,stdout:args.includes("status") ? JSON.stringify({availableCommands:[{name:"review",description:"adapter",kind:"skill"}]}) : "",stderr:""};});
 const transport=new AcpxCliTransport({command:"acpx"},runner,runner);
 expect(await transport.prepareSessionCommands(noModelSession)).toEqual([{name:"review",description:"adapter",kind:"skill"}]);
 expect(calls.some(c=>c.includes("prompt"))).toBe(false);expect(calls.some(c=>c.includes("ensure"))).toBe(true);
 const unavailable=new AcpxCliTransport({command:"acpx"},mock(async()=>({code:0,stdout:"{}",stderr:""})),runner);
 expect(await unavailable.prepareSessionCommands(noModelSession)).toBeUndefined();
});

// --- OMP native model-restore recovery (CLI setModel) ---

// OMP driver + recognized native launch (omp acp → bare omp executable).
const ompSession: ResolvedSession = {
  ...noModelSession,
  agent: "omp",
  driver: "omp",
  agentCommand: undefined,
  rawCommand: "omp acp",
};

const ompRecord = JSON.stringify({
  acpxRecordId: "omp-record-1",
  acpSessionId: "native-session-9",
  agentSessionId: "provider-session-3",
});

function restoreError(modelId: string) {
  return {
    code: 1,
    stdout: "",
    stderr: `Could not restore model ${modelId}: the provider rejected it.`,
  };
}

test("setModel recovers a native OMP model restore failure, then syncs via the ordinary setter", async () => {
  const calls: string[][] = [];
  let setterAttempts = 0;
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("set") && args.includes("model")) {
      setterAttempts += 1;
      if (setterAttempts === 1) return restoreError("gpt-5.2/high");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("show")) {
      return { code: 0, stdout: ompRecord, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const recoveries: Array<{ command: string; args?: string[]; cwd: string; agentSessionId: string; modelId: string; env?: NodeJS.ProcessEnv; timeoutMs: number }> = [];
  const transport = new AcpxCliTransport({
    command: "acpx",
    ompModelRecovery: { recoverOmpSessionModel: async (input) => { recoveries.push(input); } },
    queueOwnerAbsence: { assertAcpxQueueOwnerAbsent: async () => {} },
  }, run, okRunner());

  await transport.setModel(ompSession, "gpt-5.2/high");

  // Native helper got the full native id, exact model, cwd, bounded timeout.
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toMatchObject({
    command: "omp",
    args: [],
    cwd: "/tmp/backend",
    agentSessionId: "native-session-9",
    modelId: "gpt-5.2/high",
  });
  expect(recoveries[0]?.timeoutMs).toBeGreaterThan(0);
  // Ordinary setter ran before (failed) and after (sync) the helper.
  const setCalls = calls.filter((args) => args.includes("model") && args.includes("set"));
  expect(setCalls).toHaveLength(2);
  for (const args of setCalls) {
    expect(args.slice(args.indexOf("set"))).toEqual(["set", "-s", "backend:api-fix", "model", "gpt-5.2/high"]);
  }
});

test("setModel surfaces unrelated setter failures without any recovery", async () => {
  const run = mock(async () => ({ code: 1, stdout: "", stderr: "unrelated boom" }));
  const transport = new AcpxCliTransport({
    command: "acpx",
    ompModelRecovery: { recoverOmpSessionModel: async () => { throw new Error("must not run"); } },
    queueOwnerAbsence: { assertAcpxQueueOwnerAbsent: async () => { throw new Error("must not run"); } },
  }, run, okRunner());

  await expect(transport.setModel(ompSession, "gpt-5.2/high")).rejects.toThrow("unrelated boom");
});

test("setModel refuses recovery while a queue owner lease exists and never kills it", async () => {
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("set") && args.includes("model")) return restoreError("gpt-5.2/high");
    if (args.includes("show")) return { code: 0, stdout: ompRecord, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({
    command: "acpx",
    ompModelRecovery: { recoverOmpSessionModel: async () => { throw new Error("must not run"); } },
    queueOwnerAbsence: {
      assertAcpxQueueOwnerAbsent: async () => {
        throw new Error("session omp-record-1 still has a queue owner; wait for it to stop before restoring its model");
      },
    },
  }, run, okRunner());

  const error = await transport.setModel(ompSession, "gpt-5.2/high").catch((e: Error) => e);
  expect(error.message).toContain("still has a queue owner");
  expect(error.message).toContain("retry the model change");
});

test("setModel reports partial synchronization when the helper saved the native model but the setter fails", async () => {
  let setterAttempts = 0;
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("set") && args.includes("model")) {
      setterAttempts += 1;
      // Both attempts fail: the first triggers recovery, the sync retry fails too.
      return restoreError("gpt-5.2/high");
    }
    if (args.includes("show")) return { code: 0, stdout: ompRecord, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({
    command: "acpx",
    ompModelRecovery: { recoverOmpSessionModel: async () => {} },
    queueOwnerAbsence: { assertAcpxQueueOwnerAbsent: async () => {} },
  }, run, okRunner());

  const error = await transport.setModel(ompSession, "gpt-5.2/high").catch((e: Error) => e);
  expect(error.message).toContain('native model "gpt-5.2/high" was restored');
  expect(error.message).toContain("synchronization failed");
  expect(error.message).toContain("retry the model change");
  expect(setterAttempts).toBe(2);
});

test("setModel keeps ordinary behavior for non-OMP drivers with restore errors", async () => {
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("set") && args.includes("model")) return restoreError("gpt-5.2/high");
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({
    command: "acpx",
    ompModelRecovery: { recoverOmpSessionModel: async () => { throw new Error("must not run"); } },
    queueOwnerAbsence: { assertAcpxQueueOwnerAbsent: async () => {} },
  }, run, okRunner());

  await expect(transport.setModel(noModelSession, "gpt-5.2/high")).rejects.toThrow(/Could not restore model/);
});

test("prompts and injections are refused while a native recovery holds the physical session", async () => {
  const events: string[] = [];
  let releaseRecovery!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let recoveryStarted!: () => void;
  const recoveryRunning = new Promise<void>((resolve) => { recoveryStarted = resolve; });
  let setterAttempts = 0;
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("set") && args.includes("model")) {
      setterAttempts += 1;
      if (setterAttempts === 1) return restoreError("gpt-5.2/high");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("show")) return { code: 0, stdout: ompRecord, stderr: "" };
    if (args.includes("prompt")) events.push("prompt");
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({
    command: "acpx",
    ompModelRecovery: {
      recoverOmpSessionModel: async () => {
        events.push("recovery:start");
        recoveryStarted();
        await recoveryEntered;
        events.push("recovery:end");
      },
    },
    queueOwnerAbsence: { assertAcpxQueueOwnerAbsent: async () => {} },
  }, run, okRunner());

  const setPromise = transport.setModel(ompSession, "gpt-5.2/high");
  await recoveryRunning;

  // No prompt is admitted (and none is replayed) while the native writer runs.
  await expect(transport.prompt(ompSession, "hello")).rejects.toThrow(
    /native model restore is in progress/,
  );
  await expect(transport.injectMessage(ompSession, {
    text: "hello",
    messageId: "m-1",
    mode: "queue",
  })).rejects.toThrow(/native model restore is in progress/);
  expect(events).not.toContain("prompt");

  releaseRecovery();
  await setPromise;
  expect(events).toEqual(["recovery:start", "recovery:end"]);
});
