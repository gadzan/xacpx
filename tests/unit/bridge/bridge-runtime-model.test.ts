import { expect, test } from "bun:test";
import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";
import { ModelCatalogProtocolError } from "../../../src/transport/session-model-catalog";

test("prompt injects --model when the session input carries a model", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);

  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "s1", model: "gpt-5.2[high]", text: "hi" });

  const args = calls[0];
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.2[high]");
  expect(args.indexOf("--model")).toBeLessThan(args.indexOf("prompt"));
});

test("prompt omits --model when no model is set", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);
  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "s1", text: "hi" });
  expect(calls[0]).not.toContain("--model");
});

test("setModel issues `set ... model <id>` with the new model", async () => {
  const calls: string[][] = [];
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  const run = async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push(args);
    environments.push(options?.env);
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {
    resolveSpawnEnvironment: ({ model }) => model === "claude-opus-4-8"
      ? { RESOLVED_MODEL: model }
      : undefined,
  });

  await runtime.setModel({
    agent: "claude-provider",
    driver: "claude",
    cwd: "/repo",
    name: "s1",
    modelId: "claude-opus-4-8",
  });

  const args = calls[0];
  const setIdx = args.indexOf("set");
  expect(args.slice(setIdx)).toEqual(["set", "-s", "s1", "model", "claude-opus-4-8"]);
  expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
  expect(environments).toEqual([{ RESOLVED_MODEL: "claude-opus-4-8" }]);
});

test("setModel recovers an OMP restore failure through the shared native flow", async () => {
  const ompRecord = JSON.stringify({
    acpxRecordId: "omp-record-1",
    acpSessionId: "native-session-9",
    agentSessionId: "provider-session-3",
  });
  const calls: string[][] = [];
  let setterAttempts = 0;
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("set") && args.includes("model")) {
      setterAttempts += 1;
      if (setterAttempts === 1) {
        return { code: 1, stdout: "", stderr: "Could not restore model gpt-5.2/high: the provider rejected it." };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("show")) {
      return { code: 0, stdout: ompRecord, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const recoveries: Array<{ command: string; cwd: string; agentSessionId: string; modelId: string }> = [];
  const runtime = new BridgeRuntime("acpx", run, undefined, {
    ompModelRecovery: { recoverOmpSessionModel: async (input) => { recoveries.push(input); } },
    queueOwnerAbsence: { assertAcpxQueueOwnerAbsent: async () => {} },
  });

  await runtime.setModel({
    agent: "omp",
    driver: "omp",
    rawCommand: "omp acp",
    cwd: "/tmp/backend",
    name: "backend:api-fix",
    modelId: "gpt-5.2/high",
  });

  // The helper got the ACP (native) id, not the provider fallback — this is
  // the Phase 3c record fix: the bridge used to drop acpSessionId.
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toMatchObject({
    command: "omp",
    cwd: "/tmp/backend",
    agentSessionId: "native-session-9",
    modelId: "gpt-5.2/high",
  });
  // Ordinary setter ran before (failed) and after (sync) the helper.
  expect(calls.filter((args) => args.includes("set") && args.includes("model"))).toHaveLength(2);
});

test("prompt with an MCP coordinator auto-ensures a never-ensured Bot session", async () => {
  const calls: string[][] = [];
  let shows = 0;
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      shows += 1;
      // First read: the record does not exist yet.
      if (shows === 1) return { code: 1, stdout: "", stderr: "No acpx session found for backend:demo" };
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "record-1" }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, {
    launch: async () => {},
  });

  const result = await runtime.prompt({
    agent: "codex",
    cwd: "/tmp/backend",
    name: "backend:demo",
    mcpCoordinatorSession: "backend:main",
    text: "hello",
  });

  expect(result).toEqual({ text: "" });
  // show (missing) -> ensure creates the record -> show resolves it -> prompt.
  expect(calls.some((args) => args.includes("ensure"))).toBe(true);
  expect(calls.some((args) => args.includes("prompt"))).toBe(true);
});

test("setModel throws on a non-zero exit", async () => {
  const run = async () => ({ code: 1, stdout: "", stderr: "requested model unsupported" });
  const runtime = new BridgeRuntime("acpx", run);
  await expect(runtime.setModel({ agent: "codex", cwd: "/repo", name: "s1", modelId: "bogus" })).rejects.toThrow("unsupported");
});

test("getSessionModel parses status json", async () => {
  const run = async (_command: string, args: string[]) => {
    expect(args).toContain("status");
    expect(args.slice(0, 2)).toEqual(["--format", "json"]);
    return { code: 0, stdout: JSON.stringify({ model: "gpt-5.2[high]", availableModels: ["gpt-5.2[high]", "gpt-5.2[low]"] }), stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);
  const result = await runtime.getSessionModel({ agent: "codex", cwd: "/repo", name: "s1" });
  expect(result.current).toBe("gpt-5.2[high]");
  expect(result.available).toEqual(["gpt-5.2[high]", "gpt-5.2[low]"]);
});

test("getSessionModel throws a typed error on non-json output", async () => {
  const run = async () => ({ code: 0, stdout: "not json", stderr: "" });
  const runtime = new BridgeRuntime("acpx", run);
  const error = await runtime.getSessionModel({ agent: "codex", cwd: "/repo", name: "s1" }).catch((e) => e);
  expect(error).toBeInstanceOf(ModelCatalogProtocolError);
});

test("probeAgentCapabilities delegates to the inspector without acpx sessions or records", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const spawns: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    spawns.push(args);
    throw new Error("probe must not spawn acpx");
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {
    inspectAgentModels: async (options) => {
      seen.push({ ...options });
      return { availableModelIds: ["gpt-x"] };
    },
  });
  const result = await runtime.probeAgentCapabilities({
    agent: "codex",
    cwd: "/repo",
    driver: "codex",
    acpxAgent: "codex",
    agentArgv: ["npx", "codex@1"],
    agentProcessEnv: { KEEP: "yes" },
  });
  expect(result).toEqual({ ok: true, models: [{ modelId: "gpt-x", name: "gpt-x" }], efforts: [] });
  expect(spawns).toHaveLength(0);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.["agentCommand"]).toEqual(["npx", "codex@1"]);
  expect(seen[0]?.["agentProcessEnv"]).toEqual({ KEEP: "yes" });
});

test("getSessionEffort reads the adapter-advertised effort option", async () => {
  const run = async (_command: string, args: string[]) => {
    expect(args).toContain("sessions");
    expect(args).toContain("show");
    return {
      code: 0,
      stdout: JSON.stringify({
        acpx: {
          config_options: [{
            id: "reasoning_effort",
            category: "thought_level",
            currentValue: "high",
            options: [{ value: "medium" }, { value: "high" }, { value: "xhigh" }],
          }],
        },
      }),
      stderr: "",
    };
  };
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.getSessionEffort({ agent: "codex", cwd: "/repo", name: "s1" }))
    .resolves.toEqual({ current: "high", available: ["medium", "high", "xhigh"] });
});

test("setSessionEffort uses the adapter-advertised config id", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("sessions")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpx: { config_options: [{
            id: "effort",
            category: "thought_level",
            currentValue: "medium",
            options: [{ value: "medium" }, { value: "high" }],
          }] },
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);

  await runtime.setSessionEffort({ agent: "codex", cwd: "/repo", name: "s1", effort: "high" });

  const setArgs = calls.find((args) => args.includes("set"));
  expect(setArgs?.slice(setArgs.indexOf("set"))).toEqual(["set", "-s", "s1", "effort", "high"]);
});

test("setSessionEffort rejects values not advertised by the adapter", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
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
  };
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.setSessionEffort({
    agent: "codex",
    cwd: "/repo",
    name: "s1",
    effort: "extreme",
  })).rejects.toThrow('reasoning effort "extreme" is not advertised');
  expect(calls.some((args) => args.includes("set"))).toBe(false);
});

test("effort get/set apply the bridged provider execution environment", async () => {
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  const run = async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    environments.push(options?.env);
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
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {
    resolveSpawnEnvironment: ({ driver, settingsPolicy }) => ({
      RESOLVED_DRIVER: driver ?? "",
      RESOLVED_POLICY: settingsPolicy ?? "",
    }),
  });
  const input = {
    agent: "claude-provider",
    driver: "claude" as const,
    settingsPolicy: "provider-only" as const,
    cwd: "/repo",
    name: "s1",
  };

  await runtime.getSessionEffort(input);
  await runtime.setSessionEffort({ ...input, effort: "high" });

  expect(environments).toEqual([
    { RESOLVED_DRIVER: "claude", RESOLVED_POLICY: "provider-only" },
    { RESOLVED_DRIVER: "claude", RESOLVED_POLICY: "provider-only" },
    { RESOLVED_DRIVER: "claude", RESOLVED_POLICY: "provider-only" },
  ]);
});
