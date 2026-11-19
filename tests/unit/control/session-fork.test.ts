import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlService } from "../../../src/control/control-service";
import { createSqlDriver } from "../../../src/conversations/sql-driver";

import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { SessionForkStore } from "../../../src/sessions/session-fork-store";
import { sessionForkPrefixAnchor, sessionForkPromptDigest } from "../../../src/sessions/session-fork-node";

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

/** One session this fake created: the transport receives agent + workspace + model. */
interface CreatedSession {
  alias: string;
  agent: string;
  workspace: string;
  model?: string;
  logicalSessionId: string;
}

interface ForkTestInput {
  store: SessionForkStore;
  created: string[];
  createdRecords: CreatedSession[];
  createdModels: Array<string | undefined>;
  effortApplied: Array<[string, string | undefined]>;
  removed: string[];
  sources?: typeof SOURCE[];
  /** Configured agents the switch may resolve. */
  configuredAgents?: Array<{ name: string; driver: string }>;
  /** Rows the fake resolves as pre-existing target sessions (legacy replay). */
  seedCreated?: CreatedSession[];
  suffixCreated?: boolean;
  throwOnTaken?: boolean;
  history: Array<{ role: "user" | "agent"; text: string }>;
}

function forkInput(
  store: SessionForkStore,
  history: Array<{ role: "user" | "agent"; text: string }>,
): ForkTestInput {
  return {
    store,
    created: [],
    createdRecords: [],
    createdModels: [],
    effortApplied: [],
    removed: [],
    history,
  };
}

function controlDeps(input: ForkTestInput) {
  const events = createControlEventBus();
  const allCreated = () => [...(input.seedCreated ?? []), ...input.createdRecords];

  const asResolved = (record: CreatedSession) => ({
    ...SOURCE,
    alias: record.alias,
    agent: record.agent,
    workspace: record.workspace,
    ...(record.model ? { model: record.model } : {}),
    transportSession: "acpx-fork",
    logicalSessionId: record.logicalSessionId,
  });
  return {
    agent: { chat: async () => ({ text: "" }) },
    sessions: {
      listAllResolvedSessions: () => [
        ...(input.sources ?? [SOURCE]),
        ...allCreated()
          .filter((record) => !input.removed.includes(record.alias))
          .map(asResolved),
      ],
      getSession: async (alias: string) => {
        const source = (input.sources ?? [SOURCE]).find(
          (candidate) => candidate.alias === alias,
        );
        if (source) return source;
        const created = allCreated().find((entry) => entry.alias === alias);
        return created && !input.removed.includes(created.alias)
          ? asResolved(created)
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
      agent: string,
      workspace: string,
      model?: string,
    ) => {
      if (input.throwOnTaken && input.created.includes(alias)) {
        throw new Error(`session "${alias}" already exists and could not derive a free alias`);
      }
      const actual = input.suffixCreated || input.created.includes(alias) ? `${alias}-2` : alias;
      const created: CreatedSession = {
        alias: actual,
        agent,
        workspace,
        ...(model ? { model } : {}),
        logicalSessionId: "logical-target",
      };
      input.created.push(actual);
      input.createdModels.push(model);
      input.createdRecords.push(created);
      return asResolved(created);
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
      list: () => input.configuredAgents ?? [],
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
  // The real transport throws when the alias is taken instead of suffixing,
  // so without serialization the loser would surface a raw internal error.
  input.throwOnTaken = true;
  const control = new ControlService(controlDeps(input) as never);

  const results = await Promise.all([
    control.forkSession({ chatKey: "relay:acct", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "req-race" }),
    control.forkSession({ chatKey: "relay:acct", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "req-race" }),
  ]);
  expect(results.map((result) => result.alias).sort()).toEqual(["backend-fork", "backend-fork"]);
  expect(input.created).toEqual(["relay:backend-fork"]);
  expect(input.removed).toEqual([]);
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

function runner(
  store: SessionForkStore,
  prompts: string[],
  failOnce = false,
  events = createControlEventBus(),
) {
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
    events,
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
    targetAgent: "codex",
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

test("a media prompt mints no node identity while a text prompt records one", async () => {
  const store = await SessionForkStore.openInMemory();
  const events = createControlEventBus();
  const started: Array<{ nodeId?: string }> = [];
  events.subscribe((event) => {
    if (event.type === "turn-started") started.push(event);
  });
  const prompts: string[] = [];
  const turn = runner(store, prompts, false, events);
  const signal = new AbortController().signal;
  await turn.run({ ...RUN, text: "text question" }, signal);
  await turn.run(
    {
      ...RUN,
      text: "look at this",
      media: [
        {
          id: "pic",
          filePath: "/tmp/uploads/pic.png",
          fileName: "pic.png",
          mimeType: "image/png",
          kind: "image",
          size: 3,
        },
      ],
    },
    signal,
  );
  expect(started).toHaveLength(2);
  expect(started[0]?.nodeId).toBeTruthy();
  expect(started[1]?.nodeId).toBeUndefined();
  const nodes = store.listTurnNodes("logical-target");
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.nodeId).toBe(started[0]?.nodeId ?? "");
  store.close();
});

const TURN_HISTORY = [
  { role: "user" as const, text: "first question" },
  { role: "agent" as const, text: "first answer" },
  { role: "user" as const, text: "second question" },
  { role: "agent" as const, text: "second answer" },
  { role: "user" as const, text: "third question" },
  { role: "agent" as const, text: "third answer" },
];

function seedTurnNodes(store: SessionForkStore, history: typeof TURN_HISTORY): void {
  let sequence = 0;
  for (const message of history) {
    if (message.role !== "user") continue;
    store.recordTurnNode({
      nodeId: `node-${sequence}`,
      sessionId: "logical-src",
      promptDigest: sessionForkPromptDigest(message.text),
      createdAt: `2026-11-16T00:00:0${sequence}.000Z`,
    });
    sequence += 1;
  }
}

test("a node fork renders only the prefix through that turn", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, [...TURN_HISTORY]);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  const result = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-node",
    sourcePoint: { type: "node", nodeId: "node-1" },
  });
  expect(result.alias).toBe("backend-fork");
  const record = store.getByTargetSessionId("logical-target")!;
  expect(record.sourcePoint).toEqual({ type: "node", nodeId: "node-1" });
  expect(record.sourceAnchor).toBe(sessionForkPrefixAnchor(TURN_HISTORY.slice(0, 4)));
  const handoff = store.getHandoff(record.id)!.text;
  expect(handoff).toContain("first question");
  expect(handoff).toContain("second question");
  expect(handoff).toContain("second answer");
  expect(handoff).not.toContain("third question");
  expect(handoff).not.toContain("third answer");
  store.close();
});

test("a node fork replay survives source growth without creating a second session", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, [...TURN_HISTORY]);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  const first = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-growth",
    sourcePoint: { type: "node", nodeId: "node-1" },
  });
  input.history.push(
    { role: "user", text: "fourth question" },
    { role: "agent", text: "fourth answer" },
  );
  const replay = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-growth",
    sourcePoint: { type: "node", nodeId: "node-1" },
  });
  expect(replay.alias).toBe(first.alias);
  expect(input.created).toEqual(["relay:backend-fork"]);
  store.close();
});

test("a fresh node fork after source growth still stops at the node", async () => {
  const store = await SessionForkStore.openInMemory();
  const grown = [
    ...TURN_HISTORY,
    { role: "user" as const, text: "fourth question" },
    { role: "agent" as const, text: "fourth answer" },
  ];
  const input = forkInput(store, grown);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-growth-fresh",
    sourcePoint: { type: "node", nodeId: "node-1" },
  });
  const fresh = store.getByRequestId("req-growth-fresh")!;
  const handoff = store.getHandoff(fresh.id)!.text;
  expect(handoff).toContain("second question");
  expect(handoff).not.toContain("fourth question");
  store.close();
});

test("a pending node replay uses the stored source point and anchor", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, [...TURN_HISTORY]);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);
  store.createPending({
    requestId: "req-pending",
    chatKey: "relay:acct",
    sourceSessionId: "logical-src",
    targetSessionId: "logical-orphan",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    createdAt: "2026-11-16T00:00:00.000Z",
    sourcePoint: { type: "node", nodeId: "node-1" },
    sourceAnchor: sessionForkPrefixAnchor(TURN_HISTORY.slice(0, 4)),
    targetAgent: "codex",
  });
  input.history.push(
    { role: "user", text: "fourth question" },
    { role: "agent", text: "fourth answer" },
  );

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-pending",
    sourcePoint: { type: "node", nodeId: "node-1" },
  });
  const record = store.getByRequestId("req-pending")!;
  expect(record.status).toBe("ready");
  const handoff = store.getHandoff(record.id)!.text;
  expect(handoff).toContain("second question");
  expect(handoff).not.toContain("fourth question");
  store.close();
});

test("a rewritten source prefix fails a node fork closed with a typed error", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, [...TURN_HISTORY]);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);
  store.createPending({
    requestId: "req-rewrite",
    chatKey: "relay:acct",
    sourceSessionId: "logical-src",
    targetSessionId: "logical-orphan",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    createdAt: "2026-11-16T00:00:00.000Z",
    sourcePoint: { type: "node", nodeId: "node-1" },
    sourceAnchor: sessionForkPrefixAnchor(TURN_HISTORY.slice(0, 4)),
    targetAgent: "codex",
  });
  input.history[2] = { role: "user", text: "rewritten second question" };

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-rewrite",
      sourcePoint: { type: "node", nodeId: "node-1" },
    }),
  ).rejects.toMatchObject({ code: "session-fork-source-changed" });
  expect(input.created).toEqual([]);
  store.close();
});

test("a cleared source record fails a node fork closed with a typed error", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, []);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-cleared",
      sourcePoint: { type: "node", nodeId: "node-1" },
    }),
  ).rejects.toMatchObject({ code: "session-fork-source-changed" });
  store.close();
});

test("a node id the core never recorded is refused as unavailable", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, [...TURN_HISTORY]);
  const control = new ControlService(controlDeps(input) as never);

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-unknown",
      sourcePoint: { type: "node", nodeId: "node-never" },
    }),
  ).rejects.toMatchObject({ code: "session-fork-node-unavailable" });
  store.close();
});

test("a node fork request id cannot be replayed at a different node", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, [...TURN_HISTORY]);
  seedTurnNodes(store, TURN_HISTORY);
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-point",
    sourcePoint: { type: "node", nodeId: "node-1" },
  });
  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-point",
      sourcePoint: { type: "node", nodeId: "node-2" },
    }),
  ).rejects.toMatchObject({ code: "session-fork-request-mismatch" });
  store.close();
});

const CONFIGURED_AGENTS = [
  { name: "codex", driver: "codex" },
  { name: "claude", driver: "claude" },
];

test("a switch creates the branch under the target agent in the same workspace", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.configuredAgents = CONFIGURED_AGENTS;
  const control = new ControlService(controlDeps(input) as never);

  expect(control.supportsSessionForkAgent()).toBe(true);
  const result = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-claude-fork",
    requestId: "req-switch",
    targetAgent: "claude",
  });
  expect(result.alias).toBe("backend-claude-fork");
  expect(result.agent).toBe("claude");
  expect(input.createdRecords).toMatchObject([
    { alias: "relay:backend-claude-fork", agent: "claude", workspace: "backend" },
  ]);
  // The source stays addressable: nothing renamed or removed it.
  expect(input.removed).toEqual([]);
  const record = store.getByTargetSessionId("logical-target")!;
  expect(record.targetAgent).toBe("claude");
  // The same bounded handoff a same-agent fork renders, consumed once by the
  // target's first prompt (covered by the SessionTurnRunner tests above).
  expect(store.getHandoff(record.id)!.text).toContain("past question");
  store.close();
});

test("a switch inherits neither the source model nor its effort", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.configuredAgents = CONFIGURED_AGENTS;
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-claude-fork",
    requestId: "req-switch-settings",
    targetAgent: "claude",
  });
  expect(input.createdModels).toEqual([undefined]);
  expect(input.effortApplied).toEqual([]);
  store.close();
});

test("a same-agent fork keeps the model, effort, and source agent", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.configuredAgents = CONFIGURED_AGENTS;
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-same-agent",
    targetAgent: "codex",
  });
  expect(input.createdModels).toEqual(["gpt-5.2[high]"]);
  expect(input.effortApplied).toEqual([["relay:backend-fork", "high"]]);
  expect(store.getByTargetSessionId("logical-target")?.targetAgent).toBe("codex");
  store.close();
});

test("an unconfigured target agent is refused before any session is created", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.configuredAgents = [{ name: "codex", driver: "codex" }];
  const control = new ControlService(controlDeps(input) as never);

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-gemini-fork",
      requestId: "req-unconfigured",
      targetAgent: "gemini",
    }),
  ).rejects.toMatchObject({ code: "session-fork-agent-unavailable" });
  expect(input.created).toEqual([]);
  expect(store.getByRequestId("req-unconfigured")).toBeUndefined();
  store.close();
});

test("a switch replay with the same target agent returns the existing branch", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.configuredAgents = CONFIGURED_AGENTS;
  const control = new ControlService(controlDeps(input) as never);

  const first = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-claude-fork",
    requestId: "req-switch-replay",
    targetAgent: "claude",
  });
  const replayed = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-claude-fork",
    requestId: "req-switch-replay",
    targetAgent: "claude",
  });
  expect(replayed.alias).toBe(first.alias);
  expect(input.created).toEqual(["relay:backend-claude-fork"]);
  store.close();
});

test("a switch replay naming a different target agent is a request mismatch", async () => {
  const store = await SessionForkStore.openInMemory();
  const input = forkInput(store, HISTORY);
  input.configuredAgents = CONFIGURED_AGENTS;
  const control = new ControlService(controlDeps(input) as never);

  await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-claude-fork",
    requestId: "req-switch-agent-mismatch",
    targetAgent: "claude",
  });
  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-claude-fork",
      requestId: "req-switch-agent-mismatch",
      targetAgent: "gemini",
    }),
  ).rejects.toMatchObject({ code: "session-fork-request-mismatch" });
  // A same-agent replay must not claim the switch record's target either.
  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-claude-fork",
      requestId: "req-switch-agent-mismatch",
    }),
  ).rejects.toMatchObject({ code: "session-fork-request-mismatch" });
  expect(input.created).toEqual(["relay:backend-claude-fork"]);
  store.close();
});

/**
 * Open a database written before the agent column existed, holding one ready
 * fork row, so the migration path and the legacy replay rule run end to end.
 */
async function legacyAgentForkStore(): Promise<SessionForkStore> {
  const path = join(mkdtempSync(join(tmpdir(), "session-fork-agent-")), "forks.sqlite");
  const legacy = await createSqlDriver(path);
  legacy.exec(`
    CREATE TABLE session_forks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL UNIQUE,
      source_alias TEXT,
      target_alias TEXT,
      chat_key TEXT,
      source_point TEXT NOT NULL,
      source_anchor TEXT,
      strategy TEXT NOT NULL,
      resolution TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    INSERT INTO session_forks
      (id, request_id, source_session_id, target_session_id, source_alias, target_alias, chat_key, source_point, strategy, status, created_at)
    VALUES ('fork_legacy', 'req-legacy-agent', 'logical-src', 'logical-target', 'backend', 'backend-fork', 'relay:acct', '{"type":"latest_stable"}', 'portable', 'ready', 'x');
  `);
  legacy.close();
  return await SessionForkStore.open(path);
}

function legacyReplayInput(store: SessionForkStore): ForkTestInput {
  const input = forkInput(store, HISTORY);
  input.configuredAgents = CONFIGURED_AGENTS;
  input.seedCreated = [{
    alias: "relay:backend-fork",
    agent: "codex",
    workspace: "backend",
    logicalSessionId: "logical-target",
  }];
  return input;
}

test("a legacy record without an agent replays only as a same-agent fork", async () => {
  const store = await legacyAgentForkStore();
  const control = new ControlService(controlDeps(legacyReplayInput(store)) as never);

  expect(store.getByRequestId("req-legacy-agent")?.targetAgent).toBeUndefined();
  const replayed = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-legacy-agent",
  });
  expect(replayed.alias).toBe("backend-fork");
  expect(replayed.agent).toBe("codex");
  store.close();
});

test("a legacy record refuses a switch replay from the live source", async () => {
  const store = await legacyAgentForkStore();
  const control = new ControlService(controlDeps(legacyReplayInput(store)) as never);

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-legacy-agent",
      targetAgent: "claude",
    }),
  ).rejects.toMatchObject({ code: "session-fork-request-mismatch" });
  store.close();
});

test("with the source deleted a legacy record replays only for its live target's agent", async () => {
  const store = await legacyAgentForkStore();
  const input = legacyReplayInput(store);
  input.sources = [];
  const control = new ControlService(controlDeps(input) as never);

  await expect(
    control.forkSession({
      chatKey: "relay:acct",
      sourceAlias: "backend",
      targetAlias: "backend-fork",
      requestId: "req-legacy-agent",
      targetAgent: "claude",
    }),
  ).rejects.toMatchObject({ code: "session-fork-request-mismatch" });
  const replayed = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-legacy-agent",
    targetAgent: "codex",
  });
  expect(replayed.alias).toBe("backend-fork");
  store.close();
});
