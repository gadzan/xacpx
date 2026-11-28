import { expect, test } from "bun:test";

import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import {
  BotOrchestrationService,
  MAX_BOTS_CREATED_PER_EXECUTION,
  MAX_BOT_SPAWN_DEPTH,
  MAX_SESSIONS_CREATED_PER_EXECUTION,
  MAX_TOTAL_BOTS,
} from "../../../src/orchestration/bot-orchestration-service";

// Mirror the daemon, where the relay plugin registers its channel id on load:
// display aliases strip the shared-scope prefix.
registerKnownChannelId("relay");

function makeDeps(overrides: Record<string, unknown> = {}) {
  const createdAliases = new Map<string, { alias: string; displayName?: string }>();
  const existing = new Set<string>(["relay:alpha"]);
  const dispatched: Array<{ botId: string; topicId: string; message: string }> = [];
  const tasks: Array<{ fromBotId: string; alias: string; task: string }> = [];
  const peerTasks: Array<{ fromBotId: string; toBotId: string; task: string }> = [];
  const bots = new Map<string, { id: string; spawnDepth?: number }>([
    ["bot-root", { id: "bot-root", spawnDepth: 0 }],
    ["bot-deep", { id: "bot-deep", spawnDepth: MAX_BOT_SPAWN_DEPTH }],
  ]);
  let botSeq = 0;
  const deps = {
    sessionAliasScope: () => "relay",
    getWorkspaces: () => [{ name: "ws", cwd: "/tmp/ws" }],
    getAgents: () => [{ name: "codex", driver: "codex" }],
    createLogicalSession: async (input: { agent: string; workspace: string; slug: string; displayName?: string; model?: string }) => {
      const internal = `relay:${input.slug}`;
      createdAliases.set(internal, { alias: internal, ...(input.displayName ? { displayName: input.displayName } : {}) });
      existing.add(internal);
      return { alias: internal, displayAlias: input.slug };
    },
    renameLogicalSession: async (input: { alias: string; displayName: string }) => input,
    existingAliases: () => [...existing],
    isHiddenSession: () => false,
    getSession: (_alias: string) => undefined as { alias: string; archived?: boolean } | undefined,
    appendDispatchedSystemMessage: async (input: { botId: string; topicId: string; message: string }) => {
      dispatched.push(input);
    },
    dispatchTaskToSession: async (input: { fromBotId: string; alias: string; task: string }) => {
      tasks.push(input);
    },
    createBot: async (input: { name: string; agent: string; createdByBotId?: string; spawnDepth?: number }) => {
      botSeq += 1;
      const id = `bot-child-${botSeq}`;
      bots.set(id, { id, spawnDepth: input.spawnDepth });
      return { id, name: input.name };
    },
    getBot: (id: string) => bots.get(id),
    countBots: () => bots.size,
    sendToBotPeer: async (input: { fromBotId: string; toBotId: string; task: string; executionToken: string }) => {
      peerTasks.push(input);
    },
    getRequestContext: () => ({ requestingBotId: "bot-root", topicId: "topic-1", executionToken: "direct-execution:test" }),
    ...overrides,
  };
  return { deps, createdAliases, existing, dispatched, tasks, peerTasks, bots };
}

test("session quota 8 enforced", async () => {
  const { deps } = makeDeps();
  const svc = new BotOrchestrationService(deps as never);
  for (let i = 0; i < MAX_SESSIONS_CREATED_PER_EXECUTION; i++) {
    await svc.createSession({ agent: "codex", workspace: "ws", name: `s${i}` });
  }
  await expect(svc.createSession({ agent: "codex", workspace: "ws", name: "overflow" })).rejects.toThrow();
});

test("bot quota 4 enforced", async () => {
  const { deps } = makeDeps();
  const svc = new BotOrchestrationService(deps as never);
  for (let i = 0; i < MAX_BOTS_CREATED_PER_EXECUTION; i++) {
    await svc.createBot({ name: `b${i}`, agent: "codex" });
  }
  await expect(svc.createBot({ name: "overflow", agent: "codex" })).rejects.toThrow();
});

test("depth over 3 rejected", async () => {
  const { deps } = makeDeps({
    getRequestContext: () => ({ requestingBotId: "bot-deep", topicId: "t", executionToken: "direct-execution:depth" }),
  });
  const svc = new BotOrchestrationService(deps as never);
  await expect(svc.createBot({ name: "too-deep", agent: "codex" })).rejects.toThrow();
});

test("total bots 64 rejected", async () => {
  const { deps } = makeDeps({ countBots: () => MAX_TOTAL_BOTS });
  const svc = new BotOrchestrationService(deps as never);
  await expect(svc.createBot({ name: "one-more", agent: "codex" })).rejects.toThrow();
});

test("alias brt_ banned and dedupe appends -2", async () => {
  const { deps, createdAliases } = makeDeps();
  const svc = new BotOrchestrationService(deps as never);
  await expect(svc.createSession({ agent: "codex", workspace: "ws", alias: "brt_shadow" })).rejects.toThrow();
  const first = await svc.createSession({ agent: "codex", workspace: "ws", name: "Alpha" });
  // Display alias is bare; the internal handle carries the channel scope.
  expect(first.alias).toBe("alpha-2");
  expect(first.handle).toBe("relay:alpha-2");
  expect(createdAliases.has("relay:alpha-2")).toBe(true);
});

test("dispatchedSession written on create and task dispatched", async () => {
  const { deps, dispatched, tasks } = makeDeps();
  const svc = new BotOrchestrationService(deps as never);
  const created = await svc.createSession({ agent: "codex", workspace: "ws", name: "with-task", task: "do work" });
  expect(dispatched.length).toBe(1);
  expect(dispatched[0]).toMatchObject({ botId: "bot-root", topicId: "topic-1" });
  // The receipt carries the display alias; the task goes to the internal handle.
  expect(dispatched[0]).toMatchObject({ dispatchedSession: { sessionAlias: "with-task" } });
  expect(tasks.length).toBe(1);
  expect(tasks[0]).toMatchObject({ fromBotId: "bot-root", alias: created.handle, task: "do work" });
});

test("task on bot_create sends to peer without dispatched session", async () => {
  const { deps, dispatched, peerTasks } = makeDeps();
  const svc = new BotOrchestrationService(deps as never);
  const created = await svc.createBot({ name: "child", agent: "codex", task: "hello child" });
  expect(peerTasks.length).toBe(1);
  expect(peerTasks[0]).toMatchObject({ fromBotId: "bot-root", toBotId: created.botId });
  expect(dispatched.length).toBe(0);
});

test("rename hidden and brt_ rejected; display alias accepted", async () => {
  const hiddenDeps = makeDeps({ isHiddenSession: () => true });
  const hiddenSvc = new BotOrchestrationService(hiddenDeps.deps as never);
  await expect(hiddenSvc.renameSession({ alias: "relay:alpha", displayName: "New" })).rejects.toThrow();
  const { deps } = makeDeps();
  const svc = new BotOrchestrationService(deps as never);
  await expect(svc.renameSession({ alias: "brt_shadow", displayName: "New" })).rejects.toThrow();
  // Display alias resolves to the internal record.
  const renamed = await svc.renameSession({ alias: "alpha", displayName: "Alpha Renamed" });
  expect(renamed).toMatchObject({ alias: "relay:alpha", displayName: "Alpha Renamed" });
});
