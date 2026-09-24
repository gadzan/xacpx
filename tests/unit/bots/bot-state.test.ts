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
    { section: "conversations", key: "bad-group", reason: "malformed conversation record" },
    { section: "conversations", key: "lead-outside", reason: "malformed conversation record" },
    { section: "conversations", key: "dup-members", reason: "malformed conversation record" },
    { section: "conversation_topics", key: "bad-status", reason: "malformed conversation topic" },
    { section: "bot_runtime_bindings", key: "controller-with-bot", reason: "malformed bot runtime binding" },
    { section: "bots", key: "bad-enabled", reason: "malformed bot profile" },
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

test("parseState keeps PR2 bot-direct owners and scoped owners with botId", () => {
  const state = parseState({
    conversations: {
      conv_a: {
        id: "conv_a",
        kind: "bot",
        title: "Reviewer",
        botIds: ["bot_reviewer"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversation_topics: {
      topic_b: {
        id: "topic_b",
        conversationId: "conv_a",
        title: "Default",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    sessions: {
      legacy: {
        alias: "legacy",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:legacy",
        logical_session_id: "33333333-3333-4333-8333-333333333333",
        created_at: NOW,
        last_used_at: NOW,
        owner: { kind: "bot-direct", bindingId: "bind_legacy" },
      },
      scoped: {
        alias: "scoped",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:scoped",
        logical_session_id: "44444444-4444-4444-8444-444444444444",
        created_at: NOW,
        last_used_at: NOW,
        owner: {
          kind: "bot-direct",
          bindingId: "bind_scoped",
          botId: "bot_reviewer",
          conversationId: "conv_a",
          topicId: "topic_b",
        },
      },
    },
  }, "state.json");

  expect(state.sessions.legacy?.owner).toEqual({ kind: "bot-direct", bindingId: "bind_legacy" });
  expect(state.sessions.scoped?.owner).toEqual({
    kind: "bot-direct",
    bindingId: "bind_scoped",
    botId: "bot_reviewer",
    conversationId: "conv_a",
    topicId: "topic_b",
  });
});

test("parseState keeps rootless owned sessions for verified release (never drops the handle)", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    sessions: {
      orphan: {
        alias: "orphan",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:orphan",
        logical_session_id: "55555555-5555-4555-8555-555555555555",
        created_at: NOW,
        last_used_at: NOW,
        owner: {
          kind: "group-member",
          bindingId: "bind_9b6ef659368116a1c0cf5ea554d286da",
          botId: "bot_reviewer",
          conversationId: "conv_gone",
          topicId: "topic_gone",
        },
      },
      plain: {
        alias: "plain",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:plain",
        logical_session_id: "66666666-6666-4666-8666-666666666666",
        created_at: NOW,
        last_used_at: NOW,
      },
    },
  }, "state.json", dropped);
  // The row IS the physical cleanup handle: dropping it would strand the
  // live external session with no releaseLogicalSession/deleteSession path.
  // Load keeps the ownership intact and reports it; the next verified
  // teardown covering the triple performs the physical release.
  expect(state.sessions.orphan?.owner).toEqual({
    kind: "group-member",
    bindingId: "bind_9b6ef659368116a1c0cf5ea554d286da",
    botId: "bot_reviewer",
    conversationId: "conv_gone",
    topicId: "topic_gone",
  });
  expect(state.sessions.plain?.alias).toBe("plain");
  expect(dropped).toEqual([
    {
      section: "sessions",
      key: "orphan",
      reason: 'owned session references missing conversation/topic (conversation "conv_gone", topic "topic_gone"); kept for verified release',
    },
  ]);
});

test("parseState keeps triple-less ambiguous owners hidden for operator recovery", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    bot_runtime_bindings: {
      bind_gone: {
        id: "bind_gone",
        scope: "group-member",
        conversationId: "conv_gone",
        topicId: "topic_gone",
        botId: "bot_reviewer",
        logicalSessionId: "55555555-5555-4555-8555-555555555555",
        sessionAlias: "legacy_partial",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    sessions: {
      legacy_partial: {
        alias: "legacy_partial",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:legacy_partial",
        logical_session_id: "55555555-5555-4555-8555-555555555555",
        created_at: NOW,
        last_used_at: NOW,
        owner: { kind: "group-member", bindingId: "bind_gone" },
      },
    },
  }, "state.json", dropped);
  // Binding dropped (missing root); the triple-less session keeps its owner
  // VERBATIM: deleting the ownership record without a verified physical
  // release would resurface possibly-live product runtime as an ordinary
  // session (fail-open). It stays hidden, ordinary ops reject it, and
  // activation fails closed until an operator recovers it.
  expect(state.bot_runtime_bindings.bind_gone).toBeUndefined();
  expect(state.sessions.legacy_partial?.owner).toEqual({ kind: "group-member", bindingId: "bind_gone" });
  expect(state.sessions.legacy_partial?.alias).toBe("legacy_partial");
  expect(dropped.some((entry) => entry.key === "legacy_partial" && entry.reason.includes("requires operator recovery"))).toBe(true);
});

test("parseState drops group-member bindings pointing at a Direct conversation", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    conversations: {
      conv_direct: {
        id: "conv_direct",
        kind: "bot",
        title: "Reviewer",
        botIds: ["bot_reviewer"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversation_topics: {
      topic_direct: {
        id: "topic_direct",
        conversationId: "conv_direct",
        title: "Default",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    bot_runtime_bindings: {
      bind_cross: {
        id: "bind_cross",
        scope: "group-member",
        conversationId: "conv_direct",
        topicId: "topic_direct",
        botId: "bot_reviewer",
        logicalSessionId: "88888888-8888-4888-8888-888888888888",
        sessionAlias: "brt_group_cross",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json", dropped);
  // Corrupted cross-kind ownership: Direct teardown never sweeps it, so
  // keeping it would strand it with no cleanup entry — drop with report.
  expect(state.bot_runtime_bindings.bind_cross).toBeUndefined();
  expect(dropped.map((entry) => entry.key).sort()).toEqual(["bind_cross"]);
});

test("parseState drops topics and bindings under a missing conversation", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    conversation_topics: {
      topic_x: {
        id: "topic_x",
        conversationId: "conv_gone",
        title: "Sprint",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    bot_runtime_bindings: {
      bind_x: {
        id: "bind_x",
        scope: "group-member",
        conversationId: "conv_gone",
        topicId: "topic_x",
        botId: "bot_a",
        logicalSessionId: "77777777-7777-4777-8777-777777777777",
        sessionAlias: "brt_group_x",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json", dropped);
  expect(state.conversation_topics).toEqual({});
  expect(state.bot_runtime_bindings).toEqual({});
  expect(dropped.map((entry) => entry.key).sort()).toEqual(["bind_x", "topic_x"]);
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
  const onDiskBefore = JSON.parse(await readFile(path, "utf8")) as {
    sessions: Record<string, { owner?: { kind: string } }>;
  };
  // Save itself never demotes: the raw owner bytes reach disk.
  expect(onDiskBefore.sessions.owned?.owner?.kind).toBe("group-member");
  const loader = new StateStore(path);
  const loaded = await loader.load();
  // Unresolvable partial owner stays verbatim-hidden at load (fail-closed:
  // never reinterpreted as unowned without a verified physical release).
  expect(loaded.sessions.owned?.owner).toEqual({ kind: "group-member", bindingId: "bind_g" });
  expect(loader.lastLoadReport?.dropped.some(
    (entry) => entry.key === "owned" && entry.reason.includes("requires operator recovery"),
  )).toBe(true);
  expect(loaded.bots.bot_a?.name).toBe("Reviewer");
  expect(loaded.sessions.owned?.logical_session_id).toBe("44444444-4444-4444-8444-444444444444");

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
