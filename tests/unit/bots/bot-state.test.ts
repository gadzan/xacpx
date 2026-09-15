import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseState, StateStore, type StateLoadDroppedRecord } from "../../../src/state/state-store";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-09-15T10:00:00.000Z";

function preFeatureState() {
  return {
    sessions: {
      "api-fix": {
        alias: "api-fix",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:api-fix",
        logical_session_id: "33333333-3333-4333-8333-333333333333",
        transport_engine: "cli",
        created_at: NOW,
        last_used_at: NOW,
      },
    },
    chat_contexts: {
      "wx:user": { current_session: "api-fix" },
    },
  };
}

test("parseState loads pre-feature state as empty Bot and Conversation collections", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState(preFeatureState(), "state.json", dropped);

  expect(dropped).toEqual([]);
  expect(state.bots).toEqual({});
  expect(state.conversations).toEqual({});
  expect(state.conversation_topics).toEqual({});
  expect(state.bot_runtime_bindings).toEqual({});
  expect(state.sessions["api-fix"]?.owner).toBeUndefined();
  expect(state.sessions["api-fix"]?.alias).toBe("api-fix");
});

test("parseState accepts Bot, Conversation, Topic, and binding records", () => {
  const state = parseState({
    ...preFeatureState(),
    bots: {
      bot_a: {
        id: "bot_a",
        name: "Reviewer",
        role: "code review",
        instructions: "Focus on races.",
        agent: "codex",
        workspace: "backend",
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversations: {
      conv_a: {
        id: "conv_a",
        kind: "bot",
        title: "Reviewer",
        botIds: ["bot_a"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversation_topics: {
      topic_a: {
        id: "topic_a",
        conversationId: "conv_a",
        title: "Default",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    bot_runtime_bindings: {
      bind_a: {
        id: "bind_a",
        scope: "bot-direct",
        conversationId: "conv_a",
        topicId: "topic_a",
        botId: "bot_a",
        logicalSessionId: "33333333-3333-4333-8333-333333333333",
        sessionAlias: "bot:reviewer",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json");

  expect(state.bots.bot_a?.name).toBe("Reviewer");
  expect(state.conversations.conv_a?.kind).toBe("bot");
  expect(state.conversation_topics.topic_a?.status).toBe("active");
  expect(state.bot_runtime_bindings.bind_a?.scope).toBe("bot-direct");
});

test("parseState drops malformed Bot and Conversation records and reports them", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    bots: {
      "bad-enabled": {
        id: "bad-enabled",
        name: "Reviewer",
        agent: "codex",
        workspace: "backend",
        enabled: "yes",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversations: {
      "bad-group": {
        id: "bad-group",
        kind: "group",
        title: "Solo",
        botIds: ["only-one"],
        createdAt: NOW,
        updatedAt: NOW,
      },
      "lead-outside": {
        id: "lead-outside",
        kind: "group",
        title: "Team",
        botIds: ["a", "b"],
        leadBotId: "c",
        createdAt: NOW,
        updatedAt: NOW,
      },
      "dup-members": {
        id: "dup-members",
        kind: "group",
        title: "Team",
        botIds: ["a", "a"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversation_topics: {
      "bad-status": {
        id: "bad-status",
        conversationId: "x",
        title: "T",
        status: "bogus",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    bot_runtime_bindings: {
      "controller-with-bot": {
        id: "controller-with-bot",
        scope: "group-controller",
        conversationId: "g",
        topicId: "t",
        botId: "lead",
        logicalSessionId: "33333333-3333-4333-8333-333333333333",
        sessionAlias: "hidden",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json", dropped);

  expect(state.bots).toEqual({});
  expect(state.conversations).toEqual({});
  expect(state.conversation_topics).toEqual({});
  expect(state.bot_runtime_bindings).toEqual({});
  expect(dropped).toEqual([
    { section: "bots", key: "bad-enabled", reason: "malformed bot profile" },
    { section: "conversations", key: "bad-group", reason: "malformed conversation record" },
    { section: "conversations", key: "lead-outside", reason: "malformed conversation record" },
    { section: "conversations", key: "dup-members", reason: "malformed conversation record" },
    { section: "conversation_topics", key: "bad-status", reason: "malformed conversation topic" },
    { section: "bot_runtime_bindings", key: "controller-with-bot", reason: "malformed bot runtime binding" },
  ]);
});

test("parseState drops a session with a malformed owner and keeps an ownerless session", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    sessions: {
      ordinary: {
        alias: "ordinary",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:ordinary",
        logical_session_id: "33333333-3333-4333-8333-333333333333",
        created_at: NOW,
        last_used_at: NOW,
      },
      owned: {
        alias: "owned",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:owned",
        logical_session_id: "44444444-4444-4444-8444-444444444444",
        created_at: NOW,
        last_used_at: NOW,
        owner: { kind: "bot-direct", bindingId: "bind_a" },
      },
      bad: {
        alias: "bad",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:bad",
        logical_session_id: "55555555-5555-4555-8555-555555555555",
        created_at: NOW,
        last_used_at: NOW,
        owner: { kind: "session-alias", bindingId: "x" },
      },
    },
    chat_contexts: {},
  }, "state.json", dropped);

  expect(state.sessions.ordinary?.owner).toBeUndefined();
  expect(state.sessions.owned?.owner).toEqual({ kind: "bot-direct", bindingId: "bind_a" });
  expect(state.sessions.bad).toBeUndefined();
  expect(dropped).toEqual([
    { section: "sessions", key: "bad", reason: "malformed session record" },
  ]);
});

test("owner metadata round-trips through save and load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-bot-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  const state = createEmptyState();
  state.sessions.owned = {
    alias: "owned",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:owned",
    logical_session_id: "44444444-4444-4444-8444-444444444444",
    created_at: NOW,
    last_used_at: NOW,
    owner: { kind: "group-member", bindingId: "bind_g" },
  };
  state.bots.bot_a = {
    id: "bot_a",
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    enabled: true,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  await store.save(state);
  const loaded = await new StateStore(path).load();
  expect(loaded.sessions.owned?.owner).toEqual({ kind: "group-member", bindingId: "bind_g" });
  expect(loaded.bots.bot_a?.name).toBe("Reviewer");
  expect(loaded.sessions.owned?.logical_session_id).toBe("44444444-4444-4444-8444-444444444444");

  const onDisk = JSON.parse(await readFile(path, "utf8")) as {
    sessions: Record<string, { owner?: { kind: string } }>;
  };
  expect(onDisk.sessions.owned?.owner?.kind).toBe("group-member");

  await rm(dir, { recursive: true, force: true });
});

test("a missing Bot section is empty and does not persist a migration on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-bot-state-"));
  const path = join(dir, "state.json");
  await Bun.write(path, JSON.stringify(preFeatureState()));

  const store = new StateStore(path);
  const state = await store.load();
  expect(state.bots).toEqual({});
  expect(store.lastLoadReport).toBeNull();

  const onDisk = JSON.parse(await readFile(path, "utf8")) as { bots?: unknown };
  expect(onDisk.bots).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});
