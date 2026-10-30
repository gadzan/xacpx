import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { composeBotTurnPrompt } from "../../../src/bots/bot-profile-prompt";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import {
  adapterFacingPrompt,
  markCommandRevision,
  clearAdvertisedCommands,
  isAdvertisedRuntimeCommand,
  rememberAdvertisedCommands,
  refusesMultiMemberSlash,
} from "../../../src/conversations/advertised-commands";
import { SILENCE_REPLY } from "../../../src/conversations/group-chat-wake";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type { ConversationTurnRunInput } from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-10-09T00:00:00.000Z";

test("profile wrapping hides an adapter slash command that was not advertised", () => {
  const wrapped = composeBotTurnPrompt({ name: "Reviewer", instructions: "Be terse." }, "/compact");
  expect(wrapped.startsWith("You are acting as the Bot")).toBe(true);
  expect(wrapped.endsWith("/compact")).toBe(true);
  expect(wrapped).not.toBe("/compact");
});

test("an advertised command keeps the original text and the xacpx catalog is not an advertisement", () => {
  clearAdvertisedCommands();
  const identity = { conversationId: "c1", topicId: "t1", botId: "bot_a" };
  const wrapped = composeBotTurnPrompt({ name: "Reviewer", instructions: "Be terse." }, "/compact extra");
  expect(adapterFacingPrompt(identity, "/compact extra", wrapped)).toBe(wrapped);
  rememberAdvertisedCommands(identity, [{ name: "compact", description: "Compact" }]);
  expect(isAdvertisedRuntimeCommand(identity, "/status")).toBe(false);
  expect(adapterFacingPrompt(identity, "/compact extra", wrapped)).toBe("/compact extra");
  expect(refusesMultiMemberSlash("/compact", false, [identity, { ...identity, botId: "bot_b" }])).toBe(true);
  expect(refusesMultiMemberSlash("/compact", true, [identity])).toBe(false);
  clearAdvertisedCommands();
});

test("group scope header carries the Group title and description", () => {
  const wrapped = composeBotTurnPrompt({ name: "Reviewer", instructions: "Be terse." }, "do the review",
    { title: "xacpx 项目小组", description: "维护 gadzan/xacpx 开源项目群。" });
  expect(wrapped).toContain('You are collaborating in the Group "xacpx 项目小组".');
  expect(wrapped).toContain("Group description:\n维护 gadzan/xacpx 开源项目群。");
  expect(wrapped.indexOf("You are collaborating")).toBeGreaterThan(wrapped.indexOf("does not change the underlying model"));
});

test("group scope header is absent without a title or description", () => {
  const bare = composeBotTurnPrompt({ name: "Reviewer", instructions: "Be terse." }, "do the review");
  expect(bare).not.toContain("You are collaborating");
  const blank = composeBotTurnPrompt({ name: "Reviewer" }, "do the review",
    { title: "   ", description: "  " });
  expect(blank).not.toContain("You are collaborating");
});

async function harness() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-slash-prompt-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = { async save(_state: AppState) {}, async saveNow(_state: AppState) {} };
  const stateMutex = new AsyncMutex();
  const config = {
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: tmpdir() } },
    transport: { type: "acpx-cli" },
    channel: { type: "weixin" },
    channels: [],
    plugins: [],
  } as unknown as AppConfig;
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({
    sessions,
    transport: { async releaseLogicalSession() {}, async deleteSession() {} },
  });
  let nextId = 0;
  const ids = ["bot_a", "bot_b"];
  const bots = new BotService(config, state, stateStore, { stateMutex, createId: () => ids[nextId++]! });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend", instructions: "Be terse." });
  await bots.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, { stateMutex, releaseOwnedSession });
  const calls: ConversationTurnRunInput[] = [];
  const runner = {
    async run(input: ConversationTurnRunInput) {
      calls.push(input);
      // The fake adapter names only the bot it answers, so its reply relays to
      // nobody: the subject is the command text reaching the runner once, not
      // the group relay chain a reply that named nobody would start.
      const name = bots.getBot(input.botId)?.name;
      return { status: "completed" as const, text: name === undefined ? SILENCE_REPLY : `@${name} adapter saw the command` };
    },
    async cancel() { return { outcome: "cancelled" as const }; },
  };
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: () => new Date(NOW),
    ownerId: "owner",
    authorityEpoch: "epoch",
  });
  const runs = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    stateMutex,
    releaseOwnedSession,
    autoKick: false,
  });
  const group = await bots.createGroup({ title: "Slash", botIds: ["bot_a", "bot_b"] });
  const topic = await runs.createGroupTopic(group.id, "Public", { workspace: "backend", isolation: "shared-single-writer" });
  return { store, calls, dispatcher, runs, group, topic, bots };
}

test("a single-member group slash command reaches the runner as the original text", async () => {
  clearAdvertisedCommands();
  const h = await harness();
  try {
    rememberAdvertisedCommands({
      conversationId: h.group.id,
      topicId: h.topic.id,
      botId: "bot_a",
    }, [{ name: "compact" }]);
    await h.runs.acceptGroupPrompt({
      conversationId: h.group.id,
      topicId: h.topic.id,
      requestId: "req-compact",
      text: "/compact",
      target: { botId: "bot_a" },
    });
    await h.dispatcher.kick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.text).toBe("/compact");
    expect(h.calls[0]?.botId).toBe("bot_a");
  } finally {
    clearAdvertisedCommands();
    h.store.close();
  }
});

test("everyone mode refuses an advertised slash command before a run starts", async () => {
  clearAdvertisedCommands();
  const h = await harness();
  try {
    rememberAdvertisedCommands({
      conversationId: h.group.id,
      topicId: h.topic.id,
      botId: "bot_a",
    }, [{ name: "compact" }]);
    await expect(h.runs.acceptGroupPrompt({
      conversationId: h.group.id,
      topicId: h.topic.id,
      requestId: "req-broadcast",
      text: "/compact",
      target: { mode: "everyone" },
    })).rejects.toThrow(expect.objectContaining({ code: "slash_requires_single_member" }));
    expect(h.calls).toHaveLength(0);
  } finally {
    clearAdvertisedCommands();
    h.store.close();
  }
});

test("a direct advertised command is not wrapped before it reaches the runner", async () => {
  clearAdvertisedCommands();
  const h = await harness();
  try {
    const direct = await h.runs.acceptDirectPrompt({
      botId: "bot_a",
      requestId: "req-direct-plain",
      content: "/plugin:技能 参数",
    });
    markCommandRevision({conversationId:direct.run.conversationId,topicId:direct.run.topicId,botId:"bot_a"},"1:1");
    rememberAdvertisedCommands({
      conversationId: direct.run.conversationId,
      topicId: direct.run.topicId,
      botId: "bot_a",
    }, [{ name: "plugin:技能", kind: "skill" }]);
    await h.dispatcher.kick();
    expect(h.calls.at(-1)?.text).toBe("/plugin:技能 参数");
  } finally {
    clearAdvertisedCommands();
    h.store.close();
  }
});
