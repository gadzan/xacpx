import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import type {
  ConversationTurnCancelInput,
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import { TERMINAL_RUN_STATES } from "../../../src/conversations/conversation-types";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-10-05T00:00:00.000Z";
const GROUP = "conversation_group";
const TOPIC = "topic_group";
const NAMES = [["bot_a", "Alice"], ["bot_b", "Bob Reviewer"], ["bot_c", "Carol"]] as const;

class HeldRunner implements ConversationTurnRunner {
  public runs: ConversationTurnRunInput[] = [];
  private parked?: Promise<void>;
  private releaseParked?: () => void;
  private readonly cancelled = new Set<string>();

  hold(): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.parked = promise;
    this.releaseParked = resolve;
  }

  unblock(): void {
    this.releaseParked?.();
    this.parked = undefined;
  }

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.runs.push(input);
    await this.parked;
    return this.cancelled.has(input.promptRequestId) ? { status: "cancelled" } : { status: "completed", text: "reply" };
  }

  async cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    this.cancelled.add(input.promptRequestId);
    this.unblock();
    return { outcome: "cancelled" };
  }
}

interface StopHarness {
  store: SqliteConversationStore;
  state: AppState;
  runner: HeldRunner;
  dispatcher: ConversationDispatcher;
  service: ConversationRunService;
}

async function harness(): Promise<StopHarness> {
  const store = await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-group-stop-")), "conversations.sqlite"));
  const state = createEmptyState();
  const stateMutex = new AsyncMutex();
  const config: AppConfig = {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "error", maxSizeBytes: 1024, maxFiles: 1, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "final" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  };
  const stateStore = { async save() {}, async saveNow() {} };
  const sessions = new SessionService(config, stateStore as never, state, { now: () => Date.parse(NOW), stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({
    sessions,
    transport: { async deleteSession() {}, async releaseLogicalSession() {} } as never,
  });
  const bots = new BotService(config, state, stateStore as never, { now: () => new Date(NOW), stateMutex });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore as never, {
    now: () => new Date(NOW), stateMutex, releaseOwnedSession,
  });
  const runner = new HeldRunner();
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, { now: () => new Date(NOW), ownerId: "owner" });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore as never, {
    now: () => new Date(NOW), stateMutex, releaseOwnedSession, autoKick: false,
  });
  for (const [id, name] of NAMES) {
    state.bots[id] = { id, name, agent: "codex", workspace: "backend", enabled: true,
      profileRevision: 1, createdAt: NOW, updatedAt: NOW };
  }
  state.conversations[GROUP] = { id: GROUP, kind: "group", title: "Group", botIds: NAMES.map(([id]) => id),
    createdAt: NOW, updatedAt: NOW };
  state.conversation_topics[TOPIC] = { id: TOPIC, conversationId: GROUP, title: "Topic", status: "active",
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" }, createdAt: NOW, updatedAt: NOW };
  return { store, state, runner, dispatcher, service };
}

async function drain(h: Pick<StopHarness, "dispatcher" | "store">): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await h.dispatcher.kick();
    const runs = h.store.listRuns(GROUP, TOPIC);
    if (runs.length > 0 && runs.every((run) => TERMINAL_RUN_STATES.includes(run.state))) return;
  }
  throw new Error("dispatcher never went idle");
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("cancelTopic stops the running turn, the queued turns, and clears pending wakes", async () => {
  const h = await harness();
  try {
    h.runner.hold();
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off" });
    const held = h.dispatcher.kick();
    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    await waitUntil(() => h.store.listMemberTurns(runId).some((turn) => turn.state === "running"));

    // A relay that lands while a member runs records a pending wake.
    h.store.setGroupPendingWake(TOPIC, "bot_a", true);
    expect(h.store.getGroupReadCursor(TOPIC, "bot_a")?.pendingWake).toBe(true);

    await h.service.cancelTopic(GROUP, TOPIC);
    h.runner.unblock();
    await held;
    await drain(h);

    const turns = h.store.listMemberTurns(runId);
    // The admitted turn is cancelled, and the never-started siblings never ran.
    expect(turns.filter((turn) => turn.state === "cancelled").length).toBe(turns.length);
    expect(turns.some((turn) => turn.state === "completed")).toBe(false);
    expect(h.store.getRun(runId)?.state).toBe("cancelled");
    // No wake survives the stop.
    expect(h.store.getGroupReadCursor(TOPIC, "bot_a")?.pendingWake).toBe(false);
    // Nothing is claimable afterwards.
    expect(h.store.listRuns(GROUP, TOPIC).every((run) => TERMINAL_RUN_STATES.includes(run.state))).toBe(true);
  } finally { h.store.close(); }
});

test("cancelling a topic does not disturb another topic's runs", async () => {
  const h = await harness();
  try {
    const other = "topic_other";
    h.state.conversation_topics[other] = { id: other, conversationId: GROUP, title: "Other", status: "active",
      executionTarget: { workspace: "backend", isolation: "shared-single-writer" }, createdAt: NOW, updatedAt: NOW };
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "stop me" });
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: other, requestId: "r2", text: "leave me" });

    await h.service.cancelTopic(GROUP, TOPIC);

    const stopped = h.store.listRuns(GROUP, TOPIC)[0]!;
    const kept = h.store.listRuns(GROUP, other)[0]!;
    expect(stopped.state).toBe("cancelled");
    expect(kept.state).not.toBe("cancelled");
    // The other topic's work is untouched and still claimable.
    const keptTurns = h.store.listMemberTurns(kept.id);
    expect(keptTurns.length).toBeGreaterThan(0);
    expect(keptTurns.every((turn) => turn.state !== "cancelled")).toBe(true);
  } finally { h.store.close(); }
});

test("a stopped topic accepts new work afterwards", async () => {
  const h = await harness();
  try {
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "first" });
    await h.service.cancelTopic(GROUP, TOPIC);
    await drain(h);

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "second" });
    await drain(h);
    const runs = h.store.listRuns(GROUP, TOPIC);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.state).toBe("cancelled");
    expect(runs[1]!.state).toBe("completed");
    expect(h.store.listMemberTurns(runs[1]!.id).some((turn) => turn.state === "completed")).toBe(true);
  } finally { h.store.close(); }
});

test("cancelling a topic with no runs is a no-op", async () => {
  const h = await harness();
  try {
    await h.service.cancelTopic(GROUP, TOPIC);
    expect(h.store.listRuns(GROUP, TOPIC)).toEqual([]);
    // Still usable afterwards.
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "hello" });
    await drain(h);
    expect(h.store.getRun(h.store.listRuns(GROUP, TOPIC)[0]!.id)?.state).toBe("completed");
  } finally { h.store.close(); }
});
