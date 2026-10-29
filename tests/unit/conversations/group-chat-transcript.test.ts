import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { BotProfile } from "../../../src/bots/bot-types";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import { SILENCE_REPLY } from "../../../src/conversations/group-chat-wake";
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

class RecordingRunner implements ConversationTurnRunner {
  public runs: ConversationTurnRunInput[] = [];
  public result: ConversationTurnRunResult = { status: "completed", text: "reply" };
  private parked?: Promise<void>;
  private releaseParked?: () => void;
  private readonly cancelled = new Set<string>();

  /** Park every subsequent turn until `unblock()` is called. */
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
    // A stopped turn reports the stop, not a late completion.
    return this.cancelled.has(input.promptRequestId) ? { status: "cancelled" } : this.result;
  }

  async cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    this.cancelled.add(input.promptRequestId);
    this.unblock();
    return { outcome: "cancelled" };
  }
}

interface GroupChatHarness {
  store: SqliteConversationStore;
  state: AppState;
  bots: BotService;
  runner: RecordingRunner;
  dispatcher: ConversationDispatcher;
  service: ConversationRunService;
}

async function harness(): Promise<GroupChatHarness> {
  const store = await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-group-chat-")), "conversations.sqlite"));
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
  const runner = new RecordingRunner();
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, { now: () => new Date(NOW), ownerId: "owner" });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore as never, {
    now: () => new Date(NOW), stateMutex, releaseOwnedSession, autoKick: false,
  });
  for (const [id, name] of [["bot_a", "Alice"], ["bot_b", "Bob Reviewer"], ["bot_c", "Carol"]] as const) {
    state.bots[id] = { id, name, agent: "codex", workspace: "backend", enabled: true,
      profileRevision: 1, createdAt: NOW, updatedAt: NOW };
  }
  state.conversations[GROUP] = { id: GROUP, kind: "group", title: "Group", botIds: ["bot_a", "bot_b", "bot_c"],
    createdAt: NOW, updatedAt: NOW };
  state.conversation_topics[TOPIC] = { id: TOPIC, conversationId: GROUP, title: "Topic", status: "active",
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" }, createdAt: NOW, updatedAt: NOW };
  return { store, state, bots, runner, dispatcher, service };
}

/** Poll durable state; only used to observe a turn that a held runner parked. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Run the dispatcher until every Run in the topic has settled. */
async function drain(h: Pick<GroupChatHarness, "dispatcher" | "store">): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await h.dispatcher.kick();
    const runs = h.store.listRuns(GROUP, TOPIC);
    if (runs.length > 0 && runs.every((run) => TERMINAL_RUN_STATES.includes(run.state))) return;
  }
  throw new Error("dispatcher never went idle");
}

/** The prompt of a specific run's first turn for a bot in a given round. */
function promptFor(
  h: Pick<GroupChatHarness, "runner" | "store">,
  runId: string,
  botId: string,
  batch = 1,
): string {
  const turn = h.store.listMemberTurns(runId).find((candidate) => candidate.botId === botId && candidate.batch === batch)!;
  return h.runner.runs.find((run) => run.memberTurnId === turn.id)!.text;
}

function snapshotFor(bot: BotProfile) {
  return { revision: bot.profileRevision, capturedAt: NOW, presentation: { name: bot.name }, behavior: {},
    execution: { agent: bot.agent, workspace: bot.workspace } };
}

const contents = (h: Pick<GroupChatHarness, "store">) =>
  h.store.listMessages({ conversationId: GROUP, topicId: TOPIC, limit: 100 }).map((message) => message.content);

test("a group turn reads only the messages after the bot's own cursor", async () => {
  const h = await harness();
  try {
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "first question" });
    await drain(h);
    const firstRun = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    expect(promptFor(h, firstRun, "bot_a")).toContain("Human: first question");

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "second question" });
    await drain(h);
    const secondRun = h.store.listRuns(GROUP, TOPIC).at(-1)!.id;
    // The first exchange is already consumed, so only the new request is replayed.
    expect(promptFor(h, secondRun, "bot_a")).toContain("Human: second question");
    expect(promptFor(h, secondRun, "bot_a")).not.toContain("first question");
  } finally { h.store.close(); }
});

test("a bot that has read the topic but lost its session replays the recent window", async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 40; index += 1) {
      h.store.acceptRequest({ conversationId: GROUP, topicId: TOPIC, requestId: `seed-${index}`, botId: "bot_a",
        content: `seed message ${index}`, profileSnapshot: snapshotFor(h.bots.getBot("bot_a")), now: NOW });
    }
    // The seeded requests must stay silent, or their replies would crowd out
    // the window under test. Seal them through the store: the service's cancel
    // kicks the dispatcher, which would start the next seeded run.
    for (const run of h.store.listRuns(GROUP, TOPIC)) h.store.cancelRun(run.id, NOW);
    // A stale generation on the cursor means the bot's session was retired, so
    // the next turn is re-seeded from the recent window rather than resuming.
    h.store.advanceGroupReadCursor(TOPIC, "bot_b", 39, 0);

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "hello there",
      target: { mode: "members", botIds: ["bot_b"] } });
    await drain(h);
    const prompt = promptFor(h, h.store.listRuns(GROUP, TOPIC).at(-1)!.id, "bot_b");
    // The window is exactly the newest 30 rows, and the new human message is
    // one of them, so the oldest replayed seed is one newer than a bare 30.
    expect(prompt).toContain("seed message 39");
    expect(prompt).toContain("seed message 11");
    expect(prompt).toContain("hello there");
    // Anything older than the window stays out.
    expect(prompt).not.toContain("seed message 10");
    expect(prompt).not.toContain("seed message 0");
  } finally { h.store.close(); }
});

test("a cleared topic context replays the recent window under the new generation", async () => {
  const h = await harness();
  try {
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "before clear" });
    await drain(h);
    expect(h.store.getGroupReadCursor(TOPIC, "bot_a")?.contextGeneration).toBe(1);

    // Clear the topic context the way the service does: the generation bumps
    // and the bot's session is retired, so its next turn must replay context.
    h.store.markTopicResetting(TOPIC, GROUP, NOW);
    h.store.retireTopicContext({ conversationId: GROUP, topicId: TOPIC, requestId: "clear-1",
      releaseBindings: true, now: NOW });
    h.store.clearTopicResetting(TOPIC);

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "after clear" });
    await drain(h);
    const secondRun = h.store.listRuns(GROUP, TOPIC).at(-1)!.id;
    expect(promptFor(h, secondRun, "bot_a")).toContain("after clear");
    expect(h.store.getGroupReadCursor(TOPIC, "bot_a")?.contextGeneration).toBe(2);
  } finally { h.store.close(); }
});

test("a silent reply stores no message and a reply merely containing the token does", async () => {
  const h = await harness();
  try {
    h.runner.result = { status: "completed", text: `  ${SILENCE_REPLY}  ` };
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "quiet please" });
    await drain(h);
    expect(contents(h)).toEqual(["quiet please"]);

    h.runner.result = { status: "completed", text: `先说结论 ${SILENCE_REPLY} 再说细节` };
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "speak now" });
    await drain(h);
    // Every bot now speaks each round, so the human rows come first and then
    // one reply per speaking turn. No row is ever the bare silence token.
    const spoken = contents(h);
    expect(spoken[0]).toBe("quiet please");
    expect(spoken[1]).toBe("speak now");
    expect(spoken.slice(2).every((content) => content === `先说结论 ${SILENCE_REPLY} 再说细节`)).toBe(true);
    expect(spoken.some((content) => content.trim() === SILENCE_REPLY)).toBe(false);
  } finally { h.store.close(); }
});

test("a cancelled turn does not advance the read cursor", async () => {
  const h = await harness();
  try {
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "first" });
    await drain(h);
    const before = h.store.getGroupReadCursor(TOPIC, "bot_a")!;
    expect(before.lastSeq).toBeGreaterThan(0);

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "second" });
    // Park the admitted turn so the stop lands while it is genuinely running.
    h.runner.hold();
    const held = h.dispatcher.kick();
    await waitUntil(() => h.store.listMemberTurns(h.store.listRuns(GROUP, TOPIC).at(-1)!.id)
      .some((turn) => turn.botId === "bot_a" && turn.state === "running"));
    await h.service.cancelRun(h.store.listRuns(GROUP, TOPIC).at(-1)!.id);
    await held;
    await drain(h);

    const after = h.store.getGroupReadCursor(TOPIC, "bot_a")!;
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(after.pendingWake).toBe(false);
  } finally { h.store.close(); }
});
