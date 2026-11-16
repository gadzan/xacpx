import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { SessionForkStore } from "../../../src/sessions/session-fork-store";

registerKnownChannelId("relay");

const SOURCE = {
  alias: "relay:backend",
  agent: "codex",
  driver: "codex",
  workspace: "backend",
  cwd: "/ws/backend",
  transportSession: "acpx-backend",
  displayName: "Backend",
  logicalSessionId: "logical-src",
  model: "gpt-5.2[high]",
  effort: "high",
};

const OTHER = {
  ...SOURCE,
  alias: "relay:other",
  displayName: "Other",
  logicalSessionId: "logical-other",
  transportSession: "acpx-other",
};

interface ForkTestInput {
  store: SessionForkStore;
  created: string[];
  createdModels: Array<string | undefined>;
  effortApplied: Array<[string, string | undefined]>;
  removed: string[];
  sources?: typeof SOURCE[];
  suffixCreated?: boolean;
  history: Array<{ role: "user" | "agent"; text: string }>;
}

function forkInput(
  store: SessionForkStore,
  history: Array<{ role: "user" | "agent"; text: string }>,
): ForkTestInput {
  return {
    store,
    created: [],
    createdModels: [],
    effortApplied: [],
    removed: [],
    history,
  };
}

function controlDeps(input: ForkTestInput) {
  const events = createControlEventBus();
  return {
    agent: { chat: async () => ({ text: "" }) },
    sessions: {
      listAllResolvedSessions: () => [
        ...(input.sources ?? [SOURCE]),
        ...input.created.map((alias) => ({
          ...SOURCE,
          alias,
          logicalSessionId: "logical-target",
          transportSession: "acpx-fork",
        })),
      ],
      getSession: async (alias: string) => {
        const source = (input.sources ?? [SOURCE]).find(
          (candidate) => candidate.alias === alias,
        );
        if (source) return source;
        const created = input.created.find((entry) => entry === alias);
        return created && !input.removed.includes(created)
          ? {
              ...SOURCE,
              alias,
              logicalSessionId: "logical-target",
              transportSession: "acpx-fork",
            }
          : null;
      },
      resolveAliasForChat: async (_chatKey: string, alias: string) =>
        alias.startsWith("relay:") ? alias : `relay:${alias}`,
      getLogicalSessionRecord: (alias: string) => {
        const source = (input.sources ?? [SOURCE]).find(
          (candidate) => candidate.alias === alias,
        );
        return source ? { logical_session_id: source.logicalSessionId } : undefined;
      },
      getResolvedSessionByInternalAlias: () => undefined,
      useSession: async () => ({}),
      removeSession: async () => ({ wasActive: false }),
      setSessionEffort: async (alias: string, effort: string | undefined) => {
        input.effortApplied.push([alias, effort]);
      },
    },
    createSessionWithTransport: async (
      alias: string,
      _agent: string,
      _workspace: string,
      model?: string,
    ) => {
      const actual = input.suffixCreated || input.created.includes(alias) ? `${alias}-2` : alias;
      input.created.push(actual);
      input.createdModels.push(model);
      return {
        ...SOURCE,
        alias: actual,
        transportSession: "acpx-fork",
        logicalSessionId: "logical-target",
      };
    },
    removeSessionWithTransport: async (alias: string) => {
      input.removed.push(alias);
      const index = input.created.indexOf(alias);
      if (index >= 0) input.created.splice(index, 1);
    },
    archiveSessionWithTransport: async () => {},
    unarchiveSession: async () => {},
    listNativeSessions: async () => [],
    attachNativeSessionWithTransport: async () => SOURCE,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {
      listPending: () => [],
      createTask: async () => {
        throw new Error("unused");
      },
      cancelPending: async () => false,
    },
    orchestration: {
      listTasks: async () => [],
      getTask: async () => null,
      requestTaskCancellation: async () => {
        throw new Error("unused");
      },
    },
    events,
    agents: {
      list: () => [],
      catalog: () => [],
      create: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
    },
    workspaces: { list: () => [], create: async () => ({ name: "x", cwd: "/x" }) },
    sessionForks: input.store,
    readSessionForkHistory: async () => input.history,
  };
}

const HISTORY = [
  { role: "user" as const, text: "past question" },
  { role: "agent" as const, text: "past answer" },
];

test("forking a stable session stores a portable handoff for the new logical session", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  expect(control.supportsSessionForkHandoff()).toBe(true);
  const result = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-1",
  });
  expect(input.created).toEqual(["relay:backend-fork"]);
  expect(result.alias).toBe("backend-fork");
  const record = store.getByTargetSessionId("logical-target")!;
  expect(record.strategy).toBe("portable");
  expect(record.status).toBe("ready");
  expect(record.sourcePoint).toEqual({ type: "latest_stable" });
  const handoff = store.getHandoff(record.id)!;
  expect(handoff.text).toContain("<<<HISTORY");
  expect(handoff.text).toContain("past question");
  expect(handoff.text).toContain("past answer");
  store.close();
});

test("the forked session inherits the source model and effort", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-model",
  });
  expect(input.createdModels).toEqual(["gpt-5.2[high]"]);
  expect(input.effortApplied).toEqual([["relay:backend-fork", "high"]]);
  store.close();
});

test("an empty source history refuses the fork before creating a session", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, []);
  const control = new ControlService(controlDeps(input) as never);

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-empty",
    }),
  ).rejects.toThrow(/no recorded history/);
  expect(input.created).toEqual([]);
  store.close();
});

test("a replayed request id with a different source is rejected", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.sources = [SOURCE, OTHER];
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-reuse",
  });
  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "other",
      targetAlias: "other-fork",
      requestId: "req-reuse",
    }),
  ).rejects.toThrow(/different scope, source, or target/);
  store.close();
});

test("a replayed request id with a different target alias is rejected", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-reuse-target",
  });
  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork-2",
      requestId: "req-reuse-target",
    }),
  ).rejects.toThrow(/different scope, source, or target/);
  expect(input.created).toEqual(["relay:backend-fork"]);
  store.close();
});

test("a resolve failure removes the pending row and the target so a retry succeeds", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  const resolve = store.resolvePortable.bind(store);
  let calls = 0;
  store.resolvePortable = ((args: Parameters<typeof resolve>[0]) => {
    calls += 1;
    if (calls === 1) throw new Error("resolve boom");
    return resolve(args);
  }) as typeof store.resolvePortable;

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-retry",
    }),
  ).rejects.toThrow(/resolve boom/);
  expect(store.getByRequestId("req-retry")).toBeUndefined();

  const result = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-retry",
  });
  expect(result.alias).toBe("backend-fork");
  expect(store.getByRequestId("req-retry")?.status).toBe("ready");
  store.close();
});

test("a replay after source deletion still returns the existing target", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  const created = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-source-gone",
  });
  expect(created.alias).toBe("backend-fork");

  input.sources = [];
  const replayed = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-source-gone",
  });
  expect(replayed.alias).toBe("backend-fork");
  expect(input.created).toEqual(["relay:backend-fork"]);
  store.close();
});

test("a replay survives a daemon-side auto-suffixed target alias", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.suffixCreated = true;
  const control = new ControlService(controlDeps(input) as never);

  const created = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-suffix",
  });
  expect(created.alias).toBe("backend-fork-2");

  const replayed = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-suffix",
  });
  expect(replayed.alias).toBe("backend-fork-2");
  expect(input.created).toEqual(["relay:backend-fork-2"]);
  store.close();
});

test("concurrent forks with the same request id converge on one target", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  const results = await Promise.all([
    control.forkSession({ chatKey: "relay:acct", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "req-race" }),
    control.forkSession({ chatKey: "relay:acct", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "req-race" }),
  ]);
  expect(results.map((result) => result.alias).sort()).toEqual(["backend-fork", "backend-fork"]);
  expect(store.getByRequestId("req-race")?.status).toBe("ready");
  store.close();
});

test("a different chat scope cannot replay another scope's request id", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({ chatKey: "relay:acct", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "req-scope" });
  await expect(
    control.forkSession({ chatKey: "relay:other-acct", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "req-scope" }),
  ).rejects.toThrow(/different scope, source, or target/);
  store.close();
});

test("a product-owned target alias is refused before creation", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await expect(
    control.forkSession({ chatKey: "relay:acct", sourceAlias: "backend", targetAlias: "brt_evil", requestId: "req-owned" }),
  ).rejects.toThrow(/not an ordinary session alias/);
  expect(input.created).toEqual([]);
  store.close();
});

function runner(store: SessionForkStore, prompts: string[], failOnce = false) {
  let calls = 0;
  return new SessionTurnRunner({
    agent: {
      chat: async (request: { text: string }) => {
        prompts.push(request.text);
        calls += 1;
        if (failOnce && calls === 1) throw new Error("provider down");
        return { text: "ok" };
      },
    },
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias,
      getSession: async () => ({ transportSession: "acpx-fork", replyMode: "stream" }),
      useSession: async () => ({}),
      getLogicalSessionRecord: () => ({ logical_session_id: "logical-target" }),
    },
    events: createControlEventBus(),
    uploadStore: { root: "/tmp/uploads" },
    sessionForks: store,
  } as never);
}

function readyHandoff(store: SessionForkStore, requestId: string): void {
  const fork = store.createPending({
    requestId,
    chatKey: "c",
    sourceSessionId: "logical-src",
    targetSessionId: "logical-target",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    createdAt: "2026-11-16T00:00:00.000Z",
  });
  store.resolvePortable({
    forkId: fork.id,
    handoff: {
      text: "<<<HISTORY\nHuman: old\n>>>END HISTORY",
      messageCount: 1,
      omittedMessages: 0,
    },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
}

const RUN = {
  chatKey: "c",
  sessionAlias: "backend-fork",
  senderId: "u",
  turnOrigin: "human" as const,
};

test("only the first effective prompt carries the handoff", async () => {
  const store = await SessionForkStore.openInMemory();
  readyHandoff(store, "req-first");
  const prompts: string[] = [];
  const turn = runner(store, prompts);
  const signal = new AbortController().signal;
  await turn.run({ ...RUN, text: "first" }, signal);
  await turn.run({ ...RUN, text: "second" }, signal);
  expect(prompts[0]).toContain("<<<HISTORY");
  expect(prompts[0]).toContain("first");
  expect(prompts[1]).not.toContain("<<<HISTORY");
  expect(prompts[1]).toBe("second");
  store.close();
});

test("a command turn neither injects nor consumes the window", async () => {
  const store = await SessionForkStore.openInMemory();
  readyHandoff(store, "req-command");
  const prompts: string[] = [];
  const turn = runner(store, prompts);
  const signal = new AbortController().signal;
  await turn.run({ ...RUN, text: "/status" }, signal);
  expect(prompts[0]).toBe("/status");
  expect(store.getByTargetSessionId("logical-target")?.status).toBe("ready");
  await turn.run({ ...RUN, text: "real question" }, signal);
  expect(prompts[1]).toContain("<<<HISTORY");
  store.close();
});

test("a provider failure consumes the window so a retry never replays it", async () => {
  const store = await SessionForkStore.openInMemory();
  readyHandoff(store, "req-retry");
  const prompts: string[] = [];
  const turn = runner(store, prompts, true);
  const signal = new AbortController().signal;
  const first = await turn.run({ ...RUN, text: "first" }, signal);
  expect(first.ok).toBe(false);
  const retry = await turn.run({ ...RUN, text: "retry" }, signal);
  expect(retry.ok).toBe(true);
  expect(prompts[0]).toContain("<<<HISTORY");
  expect(prompts[1]).not.toContain("<<<HISTORY");
  expect(store.getByTargetSessionId("logical-target")?.status).toBe("consumed");
  store.close();
});
