import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";
import { CommandTimeoutError } from "../../../src/transport/command-timeouts";

const session = {
  alias: "internal-backend",
  agent: "codex",
  workspace: "w",
  transportSession: "t",
  cwd: "/c",
  model: "gpt-5.2[high]",
};

function makeDeps() {
  const calls: string[] = [];
  const logs: Array<{
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const events: Array<{ type: string }> = [];
  const resolvedSession: typeof session & { effort?: string } = { ...session };
  const deps = {
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) =>
        `internal-${alias}`,
      getSession: async (internalAlias: string) =>
        internalAlias === "internal-backend" ? resolvedSession : null,
      setSessionModel: async (alias: string, id: string) => {
        calls.push(`persist:${alias}:${id}`);
      },
      setSessionEffort: async (alias: string, effort: string | undefined) => {
        calls.push(`persist-effort:${alias}:${effort ?? ""}`);
        resolvedSession.effort = effort;
      },
    },
    transport: {
      getSessionModel: async (s: typeof session) => ({
        current: s.model,
        available: ["gpt-5.2[high]", "gpt-5.2[low]"],
      }),
      setModel: async (s: typeof session, id: string) => {
        calls.push(`transport:${s.alias}:${id}`);
      },
      getSessionEffort: async () => ({
        current: "medium",
        available: ["low", "medium", "high"],
      }),
      setSessionEffort: async (s: typeof session, effort: string) => {
        calls.push(`effort:${s.alias}:${effort}`);
      },
    },
    logger: {
      error: async (
        event: string,
        message: string,
        context?: Record<string, unknown>,
      ) => {
        logs.push({ event, message, context });
      },
      debug: async (
        event: string,
        message: string,
        context?: Record<string, unknown>,
      ) => {
        logs.push({ event, message, context });
      },
    },
    events: { emit: (event: { type: string }) => events.push(event) },
  };
  return { deps, calls, logs, events };
}

test("getSessionModel returns current + available for a resolved session", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const r = await control.getSessionModel("relay:acc", "backend");
  expect(r).toEqual({
    current: "gpt-5.2[high]",
    available: ["gpt-5.2[high]", "gpt-5.2[low]"],
  });
});

test("getSessionModel returns an empty list when the session is not found", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const r = await control.getSessionModel("relay:acc", "missing");
  expect(r).toEqual({ available: [] });
});

test("setSessionModel switches the transport model and persists by alias", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await expect(
    control.setSessionModel("relay:acc", "backend", "claude-opus-4-8"),
  ).resolves.toEqual({
    current: "claude-opus-4-8",
    applied: true,
  });
  expect(calls).toEqual([
    "transport:internal-backend:claude-opus-4-8",
    "persist:internal-backend:claude-opus-4-8",
  ]);
});

test("setSessionModel returns pending immediately and reconciles off the request path", async () => {
  const { deps, calls, logs, events } = makeDeps();
  deps.transport.setModel = async () => {
    calls.push("transport:internal-backend:claude-opus-4-8");
    throw new CommandTimeoutError(30_000, "acpx set model", {
      stage: "set-model",
    });
  };
  deps.transport.getSessionModel = async (
    _s: typeof session,
    options?: { refresh?: boolean },
  ) => {
    calls.push(`query:${options?.refresh ? "refresh" : "read"}`);
    return { current: "claude-opus-4-8", available: ["claude-opus-4-8"] };
  };
  const control = new ControlService(deps as never);

  // The ambiguous timeout must not add a second 45s read to the request path.
  await expect(
    control.setSessionModel("relay:acc", "backend", "claude-opus-4-8"),
  ).resolves.toEqual({ current: undefined, applied: false, pending: true });
  await control.whenBackgroundIdle();

  expect(calls).toEqual([
    "transport:internal-backend:claude-opus-4-8",
    "query:refresh",
    "persist:internal-backend:claude-opus-4-8",
  ]);
  expect(logs).toEqual([
    {
      event: "control.session.model.timeout_reconciled",
      message: "Model switch timed out; adopted authoritative transport state",
      context: {
        sessionAlias: "internal-backend",
        requestedModel: "claude-opus-4-8",
        timeout:
          "acpx command timed out during set-model after 30s: acpx set model",
        observedModel: "claude-opus-4-8",
        outcome: "reconciled",
      },
    },
  ]);
  expect(events).toEqual([{ type: "sessions-changed" }]);
});

test("setSessionModel adopts the authoritative model when a timed-out switch produced a third value", async () => {
  const { deps, calls } = makeDeps();
  deps.transport.setModel = async () => {
    throw new CommandTimeoutError(30_000, "acpx set model", {
      stage: "set-model",
    });
  };
  deps.transport.getSessionModel = async () => ({
    current: "provider/fallback-model",
    available: ["gpt-5.2[high]", "claude-opus-4-8", "provider/fallback-model"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionModel("relay:acc", "backend", "claude-opus-4-8"),
  ).resolves.toEqual({ current: undefined, applied: false, pending: true });
  await control.whenBackgroundIdle();
  expect(calls).toEqual(["persist:internal-backend:provider/fallback-model"]);
});

test("a newer switch supersedes the background reconciliation of a timed-out one", async () => {
  const { deps, calls, logs } = makeDeps();
  let resolveObserved!: (value: {
    current?: string;
    available: string[];
  }) => void;
  let markQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    markQueryStarted = resolve;
  });
  deps.transport.setModel = async (s: typeof session, id: string) => {
    calls.push(`transport:${s.alias}:${id}`);
    if (id === "model-b") {
      throw new CommandTimeoutError(30_000, "acpx set model", {
        stage: "set-model",
      });
    }
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query:refresh");
    markQueryStarted();
    return await new Promise((resolve) => {
      resolveObserved = resolve;
    });
  };
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionModel("relay:acc", "backend", "model-b"),
  ).resolves.toEqual({ current: undefined, applied: false, pending: true });
  await queryStarted;
  // The write queue is free again: the newer selection must win outright.
  await expect(
    control.setSessionModel("relay:acc", "backend", "model-c"),
  ).resolves.toEqual({ current: "model-c", applied: true });

  resolveObserved({ current: "model-b", available: ["model-b", "model-c"] });
  await control.whenBackgroundIdle();

  expect(calls).toEqual([
    "transport:internal-backend:model-b",
    "query:refresh",
    "transport:internal-backend:model-c",
    "persist:internal-backend:model-c",
  ]);
  expect(logs.map((log) => log.context?.outcome)).toEqual(["superseded"]);
});

test("a failed reconciliation read keeps the persisted model and logs the failure", async () => {
  const { deps, calls, logs } = makeDeps();
  deps.transport.setModel = async () => {
    calls.push("transport:internal-backend:claude-opus-4-8");
    throw new CommandTimeoutError(30_000, "acpx set model", {
      stage: "set-model",
    });
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query:refresh");
    throw new Error("worker gone");
  };
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionModel("relay:acc", "backend", "claude-opus-4-8"),
  ).resolves.toEqual({ current: undefined, applied: false, pending: true });
  await control.whenBackgroundIdle();

  expect(calls).toEqual([
    "transport:internal-backend:claude-opus-4-8",
    "query:refresh",
  ]);
  expect(logs.map((log) => log.context?.outcome)).toEqual(["failed"]);
  expect(logs[0]?.context?.reconcileError).toBe("worker gone");
});

test("an empty reconciliation read never clears the persisted model", async () => {
  const { deps, calls, logs, events } = makeDeps();
  deps.transport.setModel = async () => {
    calls.push("transport:internal-backend:claude-opus-4-8");
    throw new CommandTimeoutError(30_000, "acpx set model", {
      stage: "set-model",
    });
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query:refresh");
    return { available: [] };
  };
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionModel("relay:acc", "backend", "claude-opus-4-8"),
  ).resolves.toEqual({ current: undefined, applied: false, pending: true });
  await control.whenBackgroundIdle();

  // Persisting an empty current means "forget the saved model", so the read must
  // never reach the session store; the previous selection survives.
  expect(calls).toEqual([
    "transport:internal-backend:claude-opus-4-8",
    "query:refresh",
  ]);
  expect(events).toEqual([]);
  expect(logs.map((log) => log.context?.outcome)).toEqual(["failed"]);
  expect(logs[0]?.context?.reason).toBe("empty-current");
});

test("setSessionModel rejects viable requests only after queue aging makes their deadline unsafe", async () => {
  const { deps, calls } = makeDeps();
  let now = 1_000;
  (deps as typeof deps & { now: () => number }).now = () => now;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  deps.transport.setModel = async (s: typeof session, id: string) => {
    calls.push(`transport:${s.alias}:${id}`);
    if (id === "model-b") {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
  };
  const control = new ControlService(deps as never);

  const first = control.setSessionModel("relay:acc", "backend", "model-b");
  await firstStarted;
  const deadlineAt = now + 90_100;
  const second = control.setSessionModel("relay:acc", "backend", "model-c", {
    deadlineAt,
  });
  const third = control.setSessionModel("relay:acc", "backend", "model-d", {
    deadlineAt,
  });
  const secondRejected = second.then(
    () => false,
    (error: unknown) =>
      error instanceof Error && error.message.includes("deadline"),
  );
  const thirdRejected = third.then(
    () => false,
    (error: unknown) =>
      error instanceof Error && error.message.includes("deadline"),
  );

  // Let both requests finish alias resolution and enter the same-session queue
  // while their deadline is still viable; only the wait behind model-b ages it out.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  now += 200;
  releaseFirst();
  await first;
  expect(await secondRejected).toBe(true);
  expect(await thirdRejected).toBe(true);
  expect(calls).not.toContain("transport:internal-backend:model-c");
  expect(calls).not.toContain("persist:internal-backend:model-c");
  expect(calls).not.toContain("transport:internal-backend:model-d");
  expect(calls).not.toContain("persist:internal-backend:model-d");
});

test("setSessionModel does not reconcile unrelated provider errors that merely mention a timeout", async () => {
  const { deps, calls, logs } = makeDeps();
  deps.transport.setModel = async () => {
    throw new Error("provider request timed out while validating credentials");
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query");
    return { current: "provider/fallback-model", available: [] };
  };
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionModel("relay:acc", "backend", "claude-opus-4-8"),
  ).rejects.toThrow("provider request timed out");
  expect(calls).toEqual([]);
  expect(logs).toEqual([]);
});

test("setSessionModel throws when the transport cannot switch models", async () => {
  const { deps } = makeDeps();
  (deps.transport as { setModel?: unknown }).setModel = undefined;
  const control = new ControlService(deps as never);
  await expect(
    control.setSessionModel("relay:acc", "backend", "x"),
  ).rejects.toThrow("does not support");
});

test("getSessionModel falls back to the resolved model when the transport can't query", async () => {
  const { deps } = makeDeps();
  (deps.transport as { getSessionModel?: unknown }).getSessionModel = undefined;
  const control = new ControlService(deps as never);
  const r = await control.getSessionModel("relay:acc", "backend");
  expect(r).toEqual({ current: "gpt-5.2[high]", available: [] });
});

test("getSessionEffort returns the adapter-advertised values", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({
    current: "medium",
    available: ["low", "medium", "high"],
  });
});

test("getSessionEffort omits an unpersisted adapter current outside the advertised efforts", async () => {
  const { deps } = makeDeps();
  deps.transport.getSessionEffort = async () => ({
    current: "xhigh",
    available: ["low", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({
    current: undefined,
    available: ["low", "high"],
  });
});

test("getSessionEffort normalizes a blank current when efforts are advertised", async () => {
  const { deps } = makeDeps();
  deps.transport.getSessionEffort = async () => ({
    current: "",
    available: ["low", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({
    current: undefined,
    available: ["low", "high"],
  });
});

test("setSessionEffort applies the selected value through the transport", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await expect(
    control.setSessionEffort("relay:acc", "backend", "high"),
  ).resolves.toEqual({
    current: "high",
    applied: true,
  });
  expect(calls).toEqual([
    "effort:internal-backend:high",
    "persist-effort:internal-backend:high",
  ]);
});

test("the selected effort survives an adapter task ending and a fresh web read", async () => {
  const { deps } = makeDeps();
  let adapterEffort = "medium";
  deps.transport.setSessionEffort = async (
    _session: typeof session,
    effort: string,
  ) => {
    adapterEffort = effort;
  };
  deps.transport.getSessionEffort = async () => ({
    current: adapterEffort,
    available: ["low", "medium", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionEffort("relay:acc", "backend", "high"),
  ).resolves.toEqual({
    current: "high",
    applied: true,
  });

  // The adapter process that accepted the setting exits with the completed
  // task. A newly opened Web page reads through a fresh adapter process.
  adapterEffort = "medium";

  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({
    current: "high",
    available: ["low", "medium", "high"],
  });
});

test("a fresh web read reconciles a persisted effort the adapter no longer advertises", async () => {
  const { deps, calls } = makeDeps();
  await deps.sessions.setSessionEffort("internal-backend", "xhigh");
  calls.length = 0;
  deps.transport.getSessionEffort = async () => ({
    current: "high",
    available: ["low", "medium", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({
    current: "high",
    available: ["low", "medium", "high"],
  });
  expect(calls).toEqual(["persist-effort:internal-backend:high"]);
});

test("a fresh web read does not return an adapter current outside its advertised efforts", async () => {
  const { deps, calls } = makeDeps();
  await deps.sessions.setSessionEffort("internal-backend", "xhigh");
  calls.length = 0;
  deps.transport.getSessionEffort = async () => ({
    current: "xhigh",
    available: ["low", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({
    current: undefined,
    available: ["low", "high"],
  });
  expect(calls).toEqual(["persist-effort:internal-backend:"]);
});

test("effort read reconciliation cannot race a newer user selection", async () => {
  const { deps, calls } = makeDeps();
  await deps.sessions.setSessionEffort("internal-backend", "xhigh");
  calls.length = 0;
  let markReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const readRelease = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  deps.transport.getSessionEffort = async () => {
    markReadStarted();
    await readRelease;
    return { current: "high", available: ["low", "medium", "high"] };
  };
  const control = new ControlService(deps as never);

  const read = control.getSessionEffort("relay:acc", "backend");
  await readStarted;
  const write = control.setSessionEffort("relay:acc", "backend", "low");
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(calls).toEqual([]);

  releaseRead();
  await expect(read).resolves.toEqual({
    current: "high",
    available: ["low", "medium", "high"],
  });
  await expect(write).resolves.toEqual({ current: "low", applied: true });
  expect(calls).toEqual([
    "persist-effort:internal-backend:high",
    "effort:internal-backend:low",
    "persist-effort:internal-backend:low",
  ]);
});

test("setSessionEffort reconciles a timed-out write that acpx actually applied", async () => {
  const { deps, calls, logs } = makeDeps();
  deps.transport.setSessionEffort = async () => {
    calls.push("effort:internal-backend:high");
    throw new CommandTimeoutError(30_000, "acpx set effort", {
      stage: "set-session-effort",
    });
  };
  deps.transport.getSessionEffort = async () => {
    calls.push("query-effort:internal-backend");
    return { current: "high", available: ["low", "medium", "high"] };
  };
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionEffort("relay:acc", "backend", "high"),
  ).resolves.toEqual({
    current: "high",
    applied: true,
  });
  expect(calls).toEqual([
    "effort:internal-backend:high",
    "query-effort:internal-backend",
    "persist-effort:internal-backend:high",
  ]);
  expect(logs).toEqual([
    {
      event: "control.session.effort.timeout_reconciled",
      message: "Effort switch timed out; adopted authoritative transport state",
      context: {
        sessionAlias: "internal-backend",
        requestedEffort: "high",
        observedEffort: "high",
        timeout:
          "acpx command timed out during set-session-effort after 30s: acpx set effort",
      },
    },
  ]);
});

test("setSessionEffort returns the authoritative effort when timeout readback observes another value", async () => {
  const { deps, calls } = makeDeps();
  deps.transport.setSessionEffort = async () => {
    throw new CommandTimeoutError(30_000, "acpx set effort", {
      stage: "set-session-effort",
    });
  };
  deps.transport.getSessionEffort = async () => ({
    current: "medium",
    available: ["low", "medium", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionEffort("relay:acc", "backend", "high"),
  ).resolves.toEqual({
    current: "medium",
    applied: false,
  });
  expect(calls).toEqual(["persist-effort:internal-backend:medium"]);
});

test("setSessionEffort omits an unsupported effort from timeout readback", async () => {
  const { deps, calls } = makeDeps();
  deps.transport.setSessionEffort = async () => {
    throw new CommandTimeoutError(30_000, "acpx set effort", {
      stage: "set-session-effort",
    });
  };
  deps.transport.getSessionEffort = async () => ({
    current: "xhigh",
    available: ["low", "high"],
  });
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionEffort("relay:acc", "backend", "high"),
  ).resolves.toEqual({
    current: undefined,
    applied: false,
  });
  expect(calls).toEqual(["persist-effort:internal-backend:"]);
});

test("setSessionEffort preserves the original timeout when effort readback fails", async () => {
  const { deps } = makeDeps();
  const timeout = new CommandTimeoutError(30_000, "acpx set effort", {
    stage: "set-session-effort",
  });
  deps.transport.setSessionEffort = async () => {
    throw timeout;
  };
  deps.transport.getSessionEffort = async () => {
    throw new Error("readback failed");
  };
  const control = new ControlService(deps as never);

  let caught: unknown;
  try {
    await control.setSessionEffort("relay:acc", "backend", "high");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(timeout);
});

test("setSessionEffort reconciliation succeeds even when diagnostic logging fails", async () => {
  const { deps } = makeDeps();
  deps.transport.setSessionEffort = async () => {
    throw new CommandTimeoutError(30_000, "acpx set effort", {
      stage: "set-session-effort",
    });
  };
  deps.transport.getSessionEffort = async () => ({
    current: "high",
    available: ["low", "medium", "high"],
  });
  deps.logger.error = async () => {
    throw new Error("logger unavailable");
  };
  const control = new ControlService(deps as never);

  await expect(
    control.setSessionEffort("relay:acc", "backend", "high"),
  ).resolves.toEqual({
    current: "high",
    applied: true,
  });
});

test("setSessionEffort serializes rapid mutations for the same session", async () => {
  const { deps, calls } = makeDeps();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  deps.transport.setSessionEffort = async (
    s: typeof session,
    effort: string,
  ) => {
    calls.push(`effort:${s.alias}:${effort}`);
    if (effort === "low") {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
  };
  const control = new ControlService(deps as never);

  const first = control.setSessionEffort("relay:acc", "backend", "low");
  await firstStarted;
  const second = control.setSessionEffort("relay:acc", "backend", "high");
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  expect(calls).toEqual(["effort:internal-backend:low"]);
  releaseFirst();
  await expect(first).resolves.toEqual({ current: "low", applied: true });
  await expect(second).resolves.toEqual({ current: "high", applied: true });
  expect(calls).toEqual([
    "effort:internal-backend:low",
    "persist-effort:internal-backend:low",
    "effort:internal-backend:high",
    "persist-effort:internal-backend:high",
  ]);
});

// A refresh re-probes the session's exact launch instead of reading the
// (possibly broken) native session; failures throw rather than reporting a
// stale or unrelated list as verified-fresh.
const launchSession = {
  ...session,
  driver: "codex-acp",
  settingsPolicy: "isolated" as const,
  agentCommand: "/usr/local/bin/acpx codex",
  acpxAgent: "overlay-alias",
  rawCommand: "codex",
  agentArgv: ["--resume", "abc"],
};

function makeRefreshDeps(
  probe: (input: unknown) => Promise<unknown> | unknown,
  options: { withProbe?: boolean } = {},
) {
  const { deps, calls } = makeDeps();
  const probeRequests: unknown[] = [];
  const transport = deps.transport as typeof deps.transport & {
    probeAgentCapabilities?: (input: unknown) => Promise<unknown>;
  };
  transport.getSessionModel = async () => {
    calls.push("native-read");
    return { current: "stale-native-model", available: ["stale-native-model"] };
  };
  if (options.withProbe !== false) {
    transport.probeAgentCapabilities = async (input) => {
      probeRequests.push(input);
      return await probe(input);
    };
  }
  deps.sessions.getSession = async () => launchSession;
  return { deps, calls, probeRequests };
}

test("getSessionModel refresh probes the exact launch and never reads the native session", async () => {
  const { deps, calls, probeRequests } = makeRefreshDeps(() => ({
    ok: true,
    models: [
      { modelId: "fresh-a", name: "Fresh A" },
      { modelId: "fresh-b", name: "Fresh B" },
    ],
    efforts: [],
  }));
  const control = new ControlService(deps as never);

  const r = await control.getSessionModel("relay:acc", "backend", { refresh: true });
  expect(r).toEqual({
    current: "gpt-5.2[high]",
    available: ["fresh-a", "fresh-b"],
  });
  expect(probeRequests).toEqual([{
    agent: "codex",
    cwd: "/c",
    driver: "codex-acp",
    settingsPolicy: "isolated",
    agentCommand: "/usr/local/bin/acpx codex",
    acpxAgent: "overlay-alias",
    rawCommand: "codex",
    agentArgv: ["--resume", "abc"],
  }]);
  expect(calls).toEqual([]);
});

test("getSessionModel refresh does not leak the session's target model or alias into the probe", async () => {
  const { deps, probeRequests } = makeRefreshDeps(() => ({
    ok: true,
    models: [{ modelId: "fresh-a", name: "Fresh A" }],
    efforts: [],
  }));
  const control = new ControlService(deps as never);

  await control.getSessionModel("relay:acc", "backend", { refresh: true });
  const serialized = JSON.stringify(probeRequests[0]);
  expect(serialized).not.toContain("gpt-5.2[high]");
  expect(serialized).not.toContain("internal-backend");
});

test("a failed refresh probe throws its diagnostic instead of reporting stale success", async () => {
  const { deps, calls } = makeRefreshDeps(() => {
    throw new Error("adapter auth expired");
  });
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionModel("relay:acc", "backend", { refresh: true }),
  ).rejects.toThrow(
    'model catalog refresh failed for agent "codex" session "internal-backend": adapter auth expired',
  );
  expect(calls).toEqual([]);
});

test("an unsuccessful refresh probe reports its failure kind instead of a cached list", async () => {
  const { deps, calls } = makeRefreshDeps(() => ({
    ok: false,
    failure: "unauthenticated",
    message: "run codex login",
  }));
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionModel("relay:acc", "backend", { refresh: true }),
  ).rejects.toThrow(
    'model catalog refresh failed for agent "codex" session "internal-backend": unauthenticated: run codex login',
  );
  expect(calls).toEqual([]);
});

test("a refresh on a transport without a probe fails loudly, not silently stale", async () => {
  const { deps, calls } = makeRefreshDeps(
    () => ({ ok: true, models: [], efforts: [] }),
    { withProbe: false },
  );
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionModel("relay:acc", "backend", { refresh: true }),
  ).rejects.toThrow("model catalog refresh requires a transport that can probe agent capabilities");
  expect(calls).toEqual([]);
});

test("a native-session restore failure falls back to the exact-launch probe", async () => {
  const { deps, calls, probeRequests } = makeRefreshDeps(() => ({
    ok: true,
    models: [{ modelId: "fresh-a", name: "Fresh A" }],
    efforts: [],
  }));
  deps.transport.getSessionModel = async () => {
    calls.push("native-read");
    throw new Error("Could not restore model provider/openai/gpt-5.2 for session internal-backend");
  };
  const control = new ControlService(deps as never);

  const r = await control.getSessionModel("relay:acc", "backend");
  expect(r).toEqual({ current: "gpt-5.2[high]", available: ["fresh-a"] });
  expect(calls).toEqual(["native-read"]);
  expect(probeRequests).toEqual([{
    agent: "codex",
    cwd: "/c",
    driver: "codex-acp",
    settingsPolicy: "isolated",
    agentCommand: "/usr/local/bin/acpx codex",
    acpxAgent: "overlay-alias",
    rawCommand: "codex",
    agentArgv: ["--resume", "abc"],
  }]);
});

test("an unrelated native-session read error is rethrown unchanged", async () => {
  const { deps, calls, probeRequests } = makeRefreshDeps(() => ({
    ok: true,
    models: [],
    efforts: [],
  }));
  deps.transport.getSessionModel = async () => {
    calls.push("native-read");
    throw new Error("acpx binary crashed");
  };
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionModel("relay:acc", "backend"),
  ).rejects.toThrow("acpx binary crashed");
  expect(probeRequests).toEqual([]);
});

test("a restore-failure fallback reports the original error when the probe also fails", async () => {
  const { deps } = makeRefreshDeps(() => {
    throw new Error("probe boom");
  });
  deps.transport.getSessionModel = async () => {
    throw new Error("Could not restore model provider/openai/gpt-5.2");
  };
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionModel("relay:acc", "backend"),
  ).rejects.toThrow("Could not restore model provider/openai/gpt-5.2");
});

// Issue #524: a cold, rotated or turn-end-stale transport snapshot answers
// `{ available: [], pending: true }` because it refreshes off the request path.
// The read must not leave the caller believing the agent advertises no models:
// the service announces the session once the catalog is real, so clients re-read
// their controls without waiting for an unrelated turn or poll.
test("a cold pending model read announces the session when the catalog lands", async () => {
  const { deps, events } = makeDeps();
  let pendingReads = 2;
  deps.transport.getSessionModel = async () => {
    if (pendingReads > 0) {
      pendingReads -= 1;
      return { available: [], pending: true };
    }
    return {
      current: "gpt-5.2[high]",
      available: ["gpt-5.2[high]", "gpt-5.2[low]"],
    };
  };
  const control = new ControlService(deps as never);

  // The request path stays non-blocking and never leaks the pending marker to the
  // control RPC (older Hubs do not know it).
  await expect(
    control.getSessionModel("relay:acc", "backend"),
  ).resolves.toEqual({ available: [] });
  // A second cold read joins the same wait instead of stacking another one.
  await expect(
    control.getSessionModel("relay:acc", "backend"),
  ).resolves.toEqual({ available: [] });
  await control.whenBackgroundIdle();

  expect(events).toEqual([
    {
      type: "sessions-changed",
      readySessionAlias: "internal-backend",
      readyTransportSession: "t",
    },
  ]);
});

test("a stale catalog read at turn end is announced so clients re-read it", async () => {
  const { deps, events } = makeDeps();
  let pendingReads = 1;
  deps.transport.getSessionModel = async () => {
    if (pendingReads > 0) {
      pendingReads -= 1;
      // What `decActiveTurn` leaves behind: the last known catalog, now stale.
      return { current: "before-turn", available: ["before-turn"], pending: true };
    }
    return { current: "after-turn", available: ["after-turn"] };
  };
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionModel("relay:acc", "backend"),
  ).resolves.toEqual({ current: "before-turn", available: ["before-turn"] });
  await control.whenBackgroundIdle();

  expect(events).toEqual([
    {
      type: "sessions-changed",
      readySessionAlias: "internal-backend",
      readyTransportSession: "t",
    },
  ]);
});

test("a pending effort read is announced by the same mechanism", async () => {
  const { deps, events } = makeDeps();
  let pendingReads = 1;
  deps.transport.getSessionEffort = async () => {
    if (pendingReads > 0) {
      pendingReads -= 1;
      return { available: [], pending: true };
    }
    return { current: "medium", available: ["low", "medium", "high"] };
  };
  const control = new ControlService(deps as never);

  await expect(
    control.getSessionEffort("relay:acc", "backend"),
  ).resolves.toEqual({ available: [] });
  await control.whenBackgroundIdle();

  expect(events).toEqual([
    {
      type: "sessions-changed",
      readySessionAlias: "internal-backend",
      readyTransportSession: "t",
    },
  ]);
});

test("a fresh catalog read never announces the session", async () => {
  const { deps, events } = makeDeps();
  const control = new ControlService(deps as never);

  await control.getSessionModel("relay:acc", "backend");
  await control.getSessionEffort("relay:acc", "backend");
  await control.whenBackgroundIdle();

  expect(events).toEqual([]);
});
