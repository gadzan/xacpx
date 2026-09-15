import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { planDirectConversation } from "../../../src/conversations/direct-conversation";
import { createDirectBindingId, createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-09-15T10:00:00.000Z";
const BOT_ID = "bot_reviewer";

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

class CrashBeforeBindingStore extends MemoryStateStore {
  failBindingPublish = false;
  override async saveNow(state: AppState): Promise<void> {
    if (this.failBindingPublish && Object.keys(state.bot_runtime_bindings).length > 0) {
      throw new Error("simulated crash before binding publish");
    }
    await super.saveNow(state);
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" }, frontend: { cwd: "/tmp/frontend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 30,
      maxParallelTasksPerAgent: 1,
    },
  };
}

function createHarness(store: MemoryStateStore = new MemoryStateStore(), state = createEmptyState()) {
  const config = createConfig();
  const sessions = new SessionService(config, store, state, { now: () => Date.parse(NOW) });
  const bots = new BotService(config, state, store, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, store, {
    now: () => new Date(NOW),
  });
  return { state, store, sessions, bots, runtime };
}

function ownedSessions(state: AppState) {
  return Object.values(state.sessions).filter((session) => session.owner?.kind === "bot-direct");
}

test("planDirectConversation does not write live AppState", () => {
  const state = createEmptyState();
  const planned = planDirectConversation(state, { botId: BOT_ID, title: "Reviewer", now: NOW });
  expect(state.conversations).toEqual({});
  expect(state.conversation_topics).toEqual({});
  expect(planned.conversation.id).toBe(createDirectConversationId(BOT_ID));
  expect(planned.topic.id).toBe(createDirectTopicId(BOT_ID));
});

test("getOrCreateDirectSession creates a Bot-owned session distinct from ordinary sessions", async () => {
  const { bots, runtime, sessions, state } = createHarness();
  await sessions.createSession("api-fix", "codex", "backend");
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });

  const binding = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.scope).toBe("bot-direct");
  expect(binding.botId).toBe(BOT_ID);
  expect(binding.conversationId).toBe(createDirectConversationId(BOT_ID));
  expect(binding.id).toBe(createDirectBindingId(BOT_ID));
  expect(binding.id).not.toBe(BOT_ID);

  const owned = sessions.getLogicalSessionRecord(binding.sessionAlias);
  const ordinary = sessions.getLogicalSessionRecord("api-fix");
  expect(owned?.owner).toEqual({ kind: "bot-direct", bindingId: createDirectBindingId(BOT_ID) });
  expect(ordinary?.owner).toBeUndefined();
  expect(owned?.logical_session_id).not.toBe(ordinary?.logical_session_id);
  expect(state.conversations[binding.conversationId]?.kind).toBe("bot");
});

test("getOrCreateDirectSession reuses the binding across Bot rename", async () => {
  const { bots, runtime } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const first = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  await bots.updateBot(BOT_ID, { name: "Critic" });
  const second = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(second.id).toBe(first.id);
  expect(second.logicalSessionId).toBe(first.logicalSessionId);
  expect(second.sessionAlias).toBe(first.sessionAlias);
});

test("stale bindings are repaired by creating a new owned session", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const first = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  delete state.sessions[first.sessionAlias];
  const repaired = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(repaired.id).toBe(first.id);
  expect(repaired.logicalSessionId).not.toBe(first.logicalSessionId);
  expect(state.sessions[repaired.sessionAlias]?.owner?.bindingId).toBe(first.id);
  expect(ownedSessions(state)).toHaveLength(1);
});

test("concurrent getOrCreateDirectSession keeps one binding and one owned session", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const [first, second] = await Promise.all([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
  ]);
  expect(first.id).toBe(second.id);
  expect(first.logicalSessionId).toBe(second.logicalSessionId);
  expect(Object.values(state.bot_runtime_bindings)).toHaveLength(1);
  expect(ownedSessions(state)).toHaveLength(1);
});

test("a crash after session create repairs the missing binding without orphaning the session", async () => {
  const store = new CrashBeforeBindingStore();
  const first = createHarness(store);
  await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  store.failBindingPublish = true;
  await expect(first.runtime.getOrCreateDirectSession({ botId: BOT_ID })).rejects.toThrow("simulated crash");
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
  expect(ownedSessions(first.state)).toHaveLength(1);

  const durable = store.saved.at(-1);
  expect(durable).toBeDefined();
  const reloaded = parseState(JSON.parse(JSON.stringify(durable)) as Record<string, unknown>, "state.json");
  expect(reloaded.bot_runtime_bindings).toEqual({});
  expect(ownedSessions(reloaded)).toHaveLength(1);

  const recovered = createHarness(new MemoryStateStore(), reloaded);
  const binding = await recovered.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.id).toBe(createDirectBindingId(BOT_ID));
  expect(ownedSessions(reloaded)).toHaveLength(1);
  expect(Object.values(reloaded.bot_runtime_bindings)).toHaveLength(1);
  expect(reloaded.conversations[binding.conversationId]?.kind).toBe("bot");
});

test("promptDirect keeps origin human and applies the latest profile", async () => {
  const { bots, runtime } = createHarness();
  await bots.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    instructions: "Focus on races.",
  });
  const conversationId = createDirectConversationId(BOT_ID);
  const topicId = createDirectTopicId(BOT_ID);
  const calls: Array<{ sessionAlias: string; text: string; origin: string }> = [];
  await runtime.promptDirect(
    { botId: BOT_ID, conversationId, topicId, text: "check it" },
    {
      run: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    },
  );
  await bots.updateBot(BOT_ID, { instructions: "Be terse." });
  await runtime.promptDirect(
    { botId: BOT_ID, conversationId, topicId, text: "check it" },
    {
      run: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    },
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]?.origin).toBe("human");
  expect(calls[1]?.origin).toBe("human");
  expect(calls[0]?.sessionAlias).toBe(calls[1]?.sessionAlias);
  expect(calls[0]?.text).toContain("Focus on races.");
  expect(calls[1]?.text).toContain("Be terse.");
  expect(calls[1]?.text.includes("Focus on races.")).toBe(false);
});

test("promptDirect does not wrap a runtime command in profile text", async () => {
  const { bots, runtime } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend", instructions: "Focus." });
  let sent = "";
  await runtime.promptDirect(
    {
      botId: BOT_ID,
      conversationId: createDirectConversationId(BOT_ID),
      topicId: createDirectTopicId(BOT_ID),
      text: "/status",
    },
    {
      run: async (input) => {
        sent = input.text;
        expect(input.origin).toBe("human");
        return {};
      },
    },
  );
  expect(sent).toBe("/status");
});

test("getOrCreateDirectSession does not deadlock on the shared session mutex", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  const mutex = new AsyncMutex();
  const sessions = new SessionService(config, store, state, { now: () => Date.parse(NOW), stateMutex: mutex });
  const bots = new BotService(config, state, store, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
    stateMutex: mutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, store, {
    now: () => new Date(NOW),
    stateMutex: mutex,
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const binding = await Promise.race([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("deadlocked on shared stateMutex")), 2000);
    }),
  ]);
  expect(binding.sessionAlias).toBe(`brt_${createDirectBindingId(BOT_ID)}`);
  const reused = await Promise.race([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("deadlocked on shared stateMutex reuse")), 2000);
    }),
  ]);
  expect(reused.id).toBe(binding.id);
});

test("getOrCreateDirectSession restores a live binding after state reload", async () => {
  const first = createHarness();
  await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const created = await first.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  const reloaded = parseState(JSON.parse(JSON.stringify(first.state)) as Record<string, unknown>, "state.json");
  const recovered = createHarness(new MemoryStateStore(), reloaded);
  const restored = await recovered.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(restored.id).toBe(created.id);
  expect(restored.logicalSessionId).toBe(created.logicalSessionId);
  expect(restored.sessionAlias).toBe(created.sessionAlias);
  expect(recovered.store.saved).toHaveLength(0);
});
