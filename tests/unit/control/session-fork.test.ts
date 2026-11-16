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
};

function controlDeps(input: {
  store: SessionForkStore;
  created: string[];
  history: Array<{ role: "user" | "agent"; text: string }>;
}) {
  const events = createControlEventBus();
  return {
    agent: { chat: async () => ({ text: "" }) },
    sessions: {
      listAllResolvedSessions: () => [SOURCE],
      getSession: async (alias: string) =>
        alias === SOURCE.alias
          ? SOURCE
          : input.created.includes(alias)
            ? { ...SOURCE, alias, logicalSessionId: "logical-target", transportSession: "acpx-fork" }
            : null,
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias.startsWith("relay:") ? alias : `relay:${alias}`,
      getLogicalSessionRecord: (alias: string) =>
        alias.endsWith("backend") ? { logical_session_id: "logical-src" } : undefined,
      getResolvedSessionByInternalAlias: () => undefined,
      useSession: async () => ({}),
      removeSession: async () => ({ wasActive: false }),
    },
    createSessionWithTransport: async (alias: string) => {
      input.created.push(alias);
      return {
        ...SOURCE,
        alias,
        transportSession: "acpx-fork",
        logicalSessionId: "logical-target",
      };
    },
    removeSessionWithTransport: async () => ({ wasActive: false }),
    archiveSessionWithTransport: async () => {},
    unarchiveSession: async () => {},
    listNativeSessions: async () => [],
    attachNativeSessionWithTransport: async () => SOURCE,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: { listPending: () => [], createTask: async () => { throw new Error("unused"); }, cancelPending: async () => false },
    orchestration: { listTasks: async () => [], getTask: async () => null, requestTaskCancellation: async () => { throw new Error("unused"); } },
    events,
    agents: { list: () => [], catalog: () => [], create: async () => { throw new Error("unused"); }, remove: async () => {} },
    workspaces: { list: () => [], create: async () => { throw new Error("unused"); } },
    sessionForks: input.store,
    readSessionForkHistory: async () => input.history,
  };
}

test("forking a stable session stores a portable handoff for the new logical session", async () => {
  const store = await SessionForkStore.openInMemory();
  const created: string[] = [];
  const history = [
    { role: "user" as const, text: "past question" },
    { role: "agent" as const, text: "past answer" },
  ];
  const control = new ControlService(controlDeps({ store, created, history }) as never);

  expect(control.supportsSessionForkHandoff()).toBe(true);
  const result = await control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-1",
  });
  expect(created).toEqual(["relay:backend-fork"]);
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

test("an empty source history refuses the fork before creating a session", async () => {
  const store = await SessionForkStore.openInMemory();
  const created: string[] = [];
  const control = new ControlService(controlDeps({ store, created, history: [] }) as never);

  await expect(control.forkSession({
    chatKey: "relay:acct",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "req-empty",
  })).rejects.toThrow(/no recorded history/);
  expect(created).toEqual([]);
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
    sourceSessionId: "logical-src",
    targetSessionId: "logical-target",
    createdAt: "2026-11-16T00:00:00.000Z",
  });
  store.resolvePortable({
    forkId: fork.id,
    handoff: { text: "<<<HISTORY\nHuman: old\n>>>END HISTORY", messageCount: 1, omittedMessages: 0 },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
}

const RUN = { chatKey: "c", sessionAlias: "backend-fork", senderId: "u", turnOrigin: "human" as const };

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
