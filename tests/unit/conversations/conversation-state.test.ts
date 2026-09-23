import { expect, test } from "bun:test";

import { parseState, type StateLoadDroppedRecord } from "../../../src/state/state-store";
import { replaceRuntimeState } from "../../../src/state/replace-runtime-state";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-09-15T10:00:00.000Z";

test("parseState accepts a group conversation with a lead in membership", () => {
  const state = parseState({
    conversations: {
      team: {
        id: "team",
        kind: "group",
        title: "Release Team",
        botIds: ["reviewer", "tester"],
        leadBotId: "reviewer",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json");

  expect(state.conversations.team).toEqual({
    id: "team",
    kind: "group",
    title: "Release Team",
    botIds: ["reviewer", "tester"],
    leadBotId: "reviewer",
    createdAt: NOW,
    updatedAt: NOW,
  });
});

test("parseState accepts a controller binding without botId", () => {
  const state = parseState({
    conversations: {
      team: {
        id: "team",
        kind: "group",
        title: "Release Team",
        botIds: ["reviewer", "tester"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversation_topics: {
      "pr-400": {
        id: "pr-400",
        conversationId: "team",
        title: "PR",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    bot_runtime_bindings: {
      bind_c: {
        id: "bind_c",
        scope: "group-controller",
        conversationId: "team",
        topicId: "pr-400",
        logicalSessionId: "66666666-6666-4666-8666-666666666666",
        sessionAlias: "group:team:controller",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json");

  expect(state.bot_runtime_bindings.bind_c?.scope).toBe("group-controller");
  expect("botId" in (state.bot_runtime_bindings.bind_c ?? {})).toBe(false);
});

test("a wrong-typed bots section resets to empty and is reported", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({ bots: ["not-an-object"] }, "state.json", dropped);

  expect(state.bots).toEqual({});
  expect(dropped).toEqual([
    { section: "bots", key: "", reason: 'field "bots" is not an object; reset to empty' },
  ]);
});

test("replaceRuntimeState copies Bot collections and leaves native session cache on the live object", () => {
  const target = createEmptyState();
  const source = createEmptyState();
  source.bots.bot_a = {
    id: "bot_a",
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    enabled: true,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  source.conversations.conv_a = {
    id: "conv_a",
    kind: "bot",
    title: "Reviewer",
    botIds: ["bot_a"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  source.native_session_lists["wx:user"] = {
    created_at: NOW,
    agent: "codex",
    cwd: "/tmp",
    sessions: [],
  };
  target.native_session_lists["wx:live"] = {
    created_at: NOW,
    agent: "claude",
    cwd: "/tmp/live",
    sessions: [],
  };

  replaceRuntimeState(target, source);

  expect(target.bots.bot_a?.name).toBe("Reviewer");
  expect(target.conversations.conv_a?.kind).toBe("bot");
  expect(target.native_session_lists["wx:live"]?.agent).toBe("claude");
  expect(target.native_session_lists["wx:user"]).toBeUndefined();
});

test("parseState defaults a missing Bot profileRevision to 1", () => {
  const state = parseState({
    bots: {
      bot_a: {
        id: "bot_a",
        name: "Reviewer",
        agent: "codex",
        workspace: "backend",
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json");
  expect(state.bots.bot_a?.profileRevision).toBe(1);
});
test("parseState accepts a group topic with an execution target and drops a junk target", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    conversations: {
      team: {
        id: "team",
        kind: "group",
        title: "Release Team",
        botIds: ["reviewer", "tester"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    conversation_topics: {
      good: {
        id: "good",
        conversationId: "team",
        title: "Sprint 1",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
        executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
      },
      bad: {
        id: "bad",
        conversationId: "team",
        title: "Bad",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
        executionTarget: { workspace: "backend", isolation: "mesh" },
      },
    },
  }, "state.json", dropped);
  expect(state.conversation_topics.good?.executionTarget).toEqual({
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  expect(state.conversation_topics.bad).toBeUndefined();
  expect(dropped.some((d) => d.section === "conversation_topics" && d.key === "bad")).toBe(true);
});
