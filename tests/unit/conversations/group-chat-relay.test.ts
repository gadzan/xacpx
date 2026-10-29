import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import { RELAY_CLOSING_HINT, RELAY_MAX_ROUNDS } from "../../../src/conversations/group-chat-wake";
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

/** Replies are chosen per bot, so a test can script who says what. */
class ScriptedRunner implements ConversationTurnRunner {
  public runs: ConversationTurnRunInput[] = [];
  private reply: (botId: string) => string = () => "reply";
  private parked?: Promise<void>;
  private releaseParked?: () => void;

  script(reply: (botId: string) => string): void {
    this.reply = reply;
  }

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
    return { status: "completed", text: this.reply(input.botId) };
  }

  async cancel(_input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    this.unblock();
    return { outcome: "cancelled" };
  }
}

interface RelayHarness {
  store: SqliteConversationStore;
  state: AppState;
  bots: BotService;
  runner: ScriptedRunner;
  dispatcher: ConversationDispatcher;
  service: ConversationRunService;
}

async function harness(): Promise<RelayHarness> {
  const store = await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-group-relay-")), "conversations.sqlite"));
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
  const runner = new ScriptedRunner();
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
  return { store, state, bots, runner, dispatcher, service };
}

/** Poll durable state; only used to observe a turn a held runner parked. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function drain(h: Pick<RelayHarness, "dispatcher" | "store">): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await h.dispatcher.kick();
    const runs = h.store.listRuns(GROUP, TOPIC);
    if (runs.length > 0 && runs.every((run) => TERMINAL_RUN_STATES.includes(run.state))) return;
  }
  throw new Error("dispatcher never went idle");
}

const contents = (h: Pick<RelayHarness, "store">) =>
  h.store.listMessages({ conversationId: GROUP, topicId: TOPIC, limit: 200 }).map((message) => message.content);

/** The prompt a specific member turn was given. */
const promptOfTurn = (h: Pick<RelayHarness, "runner">, memberTurnId: string): string =>
  h.runner.runs.find((run) => run.memberTurnId === memberTurnId)!.text;

const lastPromptFor = (h: Pick<RelayHarness, "runner">, botId: string): string => {
  const runs = h.runner.runs.filter((run) => run.botId === botId);
  return runs.at(-1)!.text;
};

test("a reply with no mention relays onward and the chain settles at the cap", async () => {
  const h = await harness();
  try {
    h.runner.script(() => "no mention here");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off" });
    await drain(h);

    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    const turns = h.store.listMemberTurns(runId);
    // Round 1 is the human wake; each later round is one bot the relay added.
    expect(turns.filter((turn) => turn.batch === 1)).toHaveLength(3);
    expect(Math.max(...turns.map((turn) => turn.batch))).toBe(RELAY_MAX_ROUNDS);
    // Every member spoke, and the Run finished normally at the cap.
    for (const [botId] of NAMES) {
      expect(turns.some((turn) => turn.botId === botId)).toBe(true);
    }
    expect(h.store.getRun(runId)?.state).toBe("completed");
    // Nothing is left stranded queued once the Run is terminal.
    expect(turns.every((turn) => turn.state === "completed")).toBe(true);
  } finally { h.store.close(); }
});

test("a mention relays only to the named bot and never back to the speaker", async () => {
  const h = await harness();
  try {
    // Every reply names Bob, so only Bob is ever woken after the first turn.
    h.runner.script(() => "@Bob Reviewer 请看一下");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off",
      target: { mode: "members", botIds: ["bot_a"] } });
    await drain(h);

    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    const turns = h.store.listMemberTurns(runId);
    // bot_a speaks once; only Bob Reviewer is relayed to, and Bob's own replies
    // name himself, which never wakes him again.
    expect(turns.filter((turn) => turn.botId === "bot_a")).toHaveLength(1);
    expect(turns.filter((turn) => turn.botId === "bot_b")).toHaveLength(1);
    expect(turns.some((turn) => turn.botId === "bot_c")).toBe(false);
    expect(h.store.getRun(runId)?.state).toBe("completed");
  } finally { h.store.close(); }
});

test("a silent reply relays to nobody", async () => {
  const h = await harness();
  try {
    h.runner.script((botId) => (botId === "bot_a" ? "[静默]" : "speaking up"));
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off",
      target: { mode: "members", botIds: ["bot_a"] } });
    await drain(h);

    expect(contents(h)).toEqual(["kick off"]);
    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    expect(h.store.listMemberTurns(runId)).toHaveLength(1);
    expect(h.store.getRun(runId)?.state).toBe("completed");
  } finally { h.store.close(); }
});

test("the final relay round carries the closing hint and no round passes the cap", async () => {
  const h = await harness();
  try {
    h.runner.script(() => "still talking");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off" });
    await drain(h);

    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    const turns = h.store.listMemberTurns(runId);
    expect(Math.max(...turns.map((turn) => turn.batch))).toBe(RELAY_MAX_ROUNDS);
    // The turn in the final round was told to wrap up; a first-round turn was not.
    const finalTurn = turns.filter((turn) => turn.batch === RELAY_MAX_ROUNDS).at(-1)!;
    expect(promptOfTurn(h, finalTurn.id)).toContain(RELAY_CLOSING_HINT);
    expect(promptOfTurn(h, turns.find((turn) => turn.batch === 1)!.id)).not.toContain(RELAY_CLOSING_HINT);
  } finally { h.store.close(); }
});

test("a bot mentioned while it runs takes one more turn that reads the mention", async () => {
  const h = await harness();
  try {
    h.runner.script(() => "first answer");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off",
      target: { mode: "members", botIds: ["bot_a"] } });

    // Park bot_a's admitted turn, then interject while it is genuinely running.
    h.runner.hold();
    const held = h.dispatcher.kick();
    await waitUntil(() => h.store.listMemberTurns(h.store.listRuns(GROUP, TOPIC)[0]!.id)
      .some((turn) => turn.botId === "bot_a" && turn.state === "running"));

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "@Alice 补充一下" });
    // The interjection is a fresh Run holding exactly one queued turn for bot_a.
    const secondRun = h.store.listRuns(GROUP, TOPIC).at(-1)!;
    const queued = h.store.listMemberTurns(secondRun.id).filter((turn) => turn.botId === "bot_a");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.state).toBe("queued");
    expect(secondRun.activeBatch ?? 1).toBe(1);

    h.runner.unblock();
    await held;
    await drain(h);

    // The queued turn ran after the first one ended and saw the mention.
    const initialTurn = h.store.listMemberTurns(secondRun.id)
      .find((turn) => turn.batch === 1 && turn.botId === "bot_a")!;
    const spoke = h.runner.runs.find((run) => run.memberTurnId === initialTurn.id)!;
    expect(spoke.text).toContain("Human: @Alice 补充一下");
  } finally { h.store.close(); }
});

test("a wake arriving while a bot already has a queued turn adds nothing", async () => {
  const h = await harness();
  try {
    // Everyone is woken at once, so every bot holds a queued turn immediately
    // and the first replies find their siblings already queued.
    h.runner.script(() => "no mention here");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off" });
    await drain(h);

    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    const turns = h.store.listMemberTurns(runId);
    // No bot ever holds two turns in the same round, and the chain stays at
    // the cap rather than doubling up.
    const keys = turns.map((turn) => `${turn.batch}:${turn.botId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Math.max(...turns.map((turn) => turn.batch))).toBe(RELAY_MAX_ROUNDS);
  } finally { h.store.close(); }
});

test("a human interjection stops the older Run from appending more relay turns", async () => {
  const h = await harness();
  try {
    h.runner.script(() => "no mention here");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off" });
    const firstRun = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    const firstRunTurns = h.store.listMemberTurns(firstRun).length;

    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r2", text: "new topic please" });
    await drain(h);

    // The older Run keeps its own turns but gains none from the relay.
    expect(h.store.listMemberTurns(firstRun).length).toBe(firstRunTurns);
    const secondRun = h.store.listRuns(GROUP, TOPIC).at(-1)!;
    expect(secondRun.id).not.toBe(firstRun);
    expect(h.store.listMemberTurns(secondRun.id).length).toBeGreaterThan(0);
  } finally { h.store.close(); }
});

test("a bot never speaks twice in the same round", async () => {
  const h = await harness();
  try {
    h.runner.script(() => "no mention here");
    await h.service.acceptGroupPrompt({ conversationId: GROUP, topicId: TOPIC, requestId: "r1", text: "kick off" });
    await drain(h);

    const runId = h.store.listRuns(GROUP, TOPIC)[0]!.id;
    const turns = h.store.listMemberTurns(runId);
    const seen = new Set<string>();
    for (const turn of turns) {
      const key = `${turn.batch}:${turn.botId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  } finally { h.store.close(); }
});
