import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { SessionService } from "../../../src/sessions/session-service";
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-09-15T10:00:00.000Z";

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
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

function createHarness() {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  const sessions = new SessionService(config, store, state, { now: () => Date.parse(NOW) });
  const bots = new BotService(config, state, store, {
    now: () => new Date(NOW),
    createId: () => "bot_reviewer",
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, store, {
    now: () => new Date(NOW),
    createBindingId: () => "bind_direct",
    createConversationId: () => "conversation_direct",
    createTopicId: () => "topic_default",
  });
  return { state, store, sessions, bots, runtime };
}

test("getOrCreateDirectSession creates a Bot-owned session distinct from ordinary sessions", async () => {
  const { bots, runtime, sessions, state } = createHarness();
  await sessions.createSession("api-fix", "codex", "backend");
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });

  const binding = await runtime.getOrCreateDirectSession({ botId: "bot_reviewer" });
  expect(binding.scope).toBe("bot-direct");
  expect(binding.botId).toBe("bot_reviewer");
  expect(binding.conversationId).toBe("conversation_direct");
  expect(binding.id).not.toBe("bot_reviewer");

  const owned = sessions.getLogicalSessionRecord(binding.sessionAlias);
  const ordinary = sessions.getLogicalSessionRecord("api-fix");
  expect(owned?.owner).toEqual({ kind: "bot-direct", bindingId: "bind_direct" });
  expect(ordinary?.owner).toBeUndefined();
  expect(owned?.logical_session_id).not.toBe(ordinary?.logical_session_id);
  expect(state.conversations[binding.conversationId]?.kind).toBe("bot");
});

test("getOrCreateDirectSession reuses the binding across Bot rename", async () => {
  const { bots, runtime } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const first = await runtime.getOrCreateDirectSession({ botId: "bot_reviewer" });
  await bots.updateBot("bot_reviewer", { name: "Critic" });
  const second = await runtime.getOrCreateDirectSession({ botId: "bot_reviewer" });
  expect(second.id).toBe(first.id);
  expect(second.logicalSessionId).toBe(first.logicalSessionId);
  expect(second.sessionAlias).toBe(first.sessionAlias);
});

test("stale bindings are repaired by creating a new owned session", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const first = await runtime.getOrCreateDirectSession({ botId: "bot_reviewer" });
  delete state.sessions[first.sessionAlias];
  const repaired = await runtime.getOrCreateDirectSession({ botId: "bot_reviewer" });
  expect(repaired.id).toBe(first.id);
  expect(repaired.logicalSessionId).not.toBe(first.logicalSessionId);
  expect(state.sessions[repaired.sessionAlias]?.owner?.bindingId).toBe(first.id);
});

test("promptDirect keeps origin human and applies the latest profile", async () => {
  const { bots, runtime } = createHarness();
  await bots.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    instructions: "Focus on races.",
  });
  const calls: Array<{ sessionAlias: string; text: string; origin: string }> = [];
  await runtime.promptDirect(
    { botId: "bot_reviewer", conversationId: "conversation_direct", topicId: "topic_default", text: "check it" },
    {
      run: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    },
  );
  await bots.updateBot("bot_reviewer", { instructions: "Be terse." });
  await runtime.promptDirect(
    { botId: "bot_reviewer", conversationId: "conversation_direct", topicId: "topic_default", text: "check it" },
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
    { botId: "bot_reviewer", conversationId: "conversation_direct", topicId: "topic_default", text: "/status" },
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
