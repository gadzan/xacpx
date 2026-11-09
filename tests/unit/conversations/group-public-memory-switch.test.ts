import { expect, test } from "bun:test";

import { toGroupSummary } from "../../../src/control/conversation-control-dtos";
import {
  groupPublicMemoryProjection,
  publicMemoryMembersFor,
} from "../../../src/conversations/conversation-types";
import { parseState, type StateLoadDroppedRecord } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";
import { harness, HUMAN, until } from "./fixtures/concurrency-harness";

const NOW = "2026-11-09T00:00:00.000Z";

/**
 * Group public-memory projection switch (`publicMemoryProjection`: `on` | `off`).
 *
 * Default `on` keeps the P2 behavior: public Group messages are written for
 * every member and injected into Direct prompts. `off` writes no new rows and
 * injects none of the stored rows, without deleting anything; flipping back to
 * `on` restores visibility of rows written while it was on.
 */

/** The production gate reads live AppState, exactly like the composition. */
function memoryGate(state: AppState) {
  return (conversationId: string, topicId: string) =>
    publicMemoryMembersFor(state.conversations[conversationId], state.conversation_topics[topicId]);
}

async function memoryHarness(options: { publicMemoryProjection?: "on" | "off" } = {}) {
  const state = createEmptyState();
  const h = await harness({
    state,
    publicMemoryMembers: memoryGate(state),
  });
  const members = h.ids.slice(0, 2);
  const group = await h.bots.createGroup({
    title: "Memory team",
    botIds: members,
    ...options,
  });
  const topic = await h.service.createGroupTopic(group.id, "Topic", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });

  /** One Group request settles one member turn; its human message is the
   *  public memory row under test. */
  const publicGroupMessage = async (requestId: string, content = "one frozen request") => {
    const accepted = h.accept(group.id, topic.id, 1, true, requestId, undefined, members, content);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.some((call) => call.runId === accepted.run.id));
    const index = h.runner.calls.findIndex((call) => call.runId === accepted.run.id);
    h.runner.finish(index, { status: "completed", text: `reply to ${requestId}` });
    await drain;
  };

  /** Send a Direct prompt and return the exact composed provider prompt. */
  const directPromptText = async (botId: string, requestId: string) => {
    const accepted = await h.service.acceptDirectPrompt({
      botId,
      requestId,
      content: "private question",
      humanIngress: HUMAN,
    });
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.some((call) => call.runId === accepted.run.id));
    const call = h.runner.calls.find((candidate) => candidate.runId === accepted.run.id)!;
    h.runner.finish(h.runner.calls.indexOf(call), { status: "completed", text: "direct reply" });
    await drain;
    return call.text;
  };

  return { h, state, members, group, topic, publicGroupMessage, directPromptText };
}

test("a Group created before the switch keeps projecting and Direct prompts see its messages", async () => {
  const { h, members, group, publicGroupMessage, directPromptText } = await memoryHarness();
  try {
    // Absent is the pre-setting shape: the record stores nothing.
    expect(group.publicMemoryProjection).toBeUndefined();
    expect(groupPublicMemoryProjection(group)).toBe("on");
    expect(toGroupSummary(group).publicMemoryProjection).toBe("on");

    await publicGroupMessage("first");
    for (const botId of members) {
      // The human request and the settled public reply both project.
      expect(h.store.listPublicMemory({ botId }).map((entry) => entry.content))
        .toEqual(["one frozen request", "reply to first"]);
    }
    const prompt = await directPromptText(members[1]!, "direct-on");
    expect(prompt).toContain("Shared group context");
    expect(prompt).toContain("one frozen request");
    expect(prompt).toContain("Memory team");
  } finally {
    h.store.close();
  }
});

test("an off Group writes no new public memory and an unrelated edit keeps it off", async () => {
  const { h, members, group, publicGroupMessage } = await memoryHarness({ publicMemoryProjection: "off" });
  try {
    expect(group.publicMemoryProjection).toBe("off");
    expect(toGroupSummary(group).publicMemoryProjection).toBe("off");

    await publicGroupMessage("hidden");
    for (const botId of members) {
      expect(h.store.listPublicMemory({ botId })).toEqual([]);
    }

    // An untouched patch never re-enables projection...
    const renamed = await h.bots.updateGroup(group.id, { title: "Still private" });
    expect(renamed.publicMemoryProjection).toBe("off");
    // ...and the resolved DTO keeps saying off for list/get readers.
    expect(toGroupSummary(renamed).publicMemoryProjection).toBe("off");

    // No backfill: only messages accepted after switching on are projected.
    await h.bots.updateGroup(group.id, { publicMemoryProjection: "on" });
    await publicGroupMessage("visible");
    for (const botId of members) {
      expect(h.store.listPublicMemory({ botId }).map((entry) => entry.content))
        .toEqual(["one frozen request", "reply to visible"]);
    }
  } finally {
    h.store.close();
  }
});

test("switching off stops stored memory reaching Direct prompts and switching on restores it", async () => {
  const { h, members, group, publicGroupMessage, directPromptText } = await memoryHarness();
  try {
    await publicGroupMessage("first");
    const before = await directPromptText(members[1]!, "before-off");
    expect(before).toContain("one frozen request");

    await h.bots.updateGroup(group.id, { publicMemoryProjection: "off" });
    const hidden = await directPromptText(members[1]!, "while-off");
    expect(hidden).not.toContain("Shared group context");
    expect(hidden).not.toContain("one frozen request");

    // The rows were never deleted; only the projection read was gated.
    expect(h.store.listPublicMemory({ botId: members[1]! }).map((entry) => entry.content))
      .toEqual(["one frozen request", "reply to first"]);

    await h.bots.updateGroup(group.id, { publicMemoryProjection: "on" });
    const restored = await directPromptText(members[1]!, "after-on");
    expect(restored).toContain("Shared group context");
    expect(restored).toContain("one frozen request");
  } finally {
    h.store.close();
  }
});

test("the projection gate distinguishes a public Group Topic from a switched-off one", () => {
  const group = {
    id: "group",
    kind: "group" as const,
    title: "Team",
    botIds: ["a", "b"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const topic = { id: "topic", conversationId: "group", title: "T", status: "active" as const, createdAt: NOW, updatedAt: NOW };
  expect(publicMemoryMembersFor(group, topic)).toEqual(["a", "b"]);
  // Off means "projects to nobody", not "not a public Group Topic": the final
  // reply fallback still recognizes the Topic and owes a status row.
  expect(publicMemoryMembersFor({ ...group, publicMemoryProjection: "off" }, topic)).toEqual([]);
  expect(publicMemoryMembersFor(group, { ...topic, conversationId: "other" })).toBeUndefined();
  expect(publicMemoryMembersFor(group, { ...topic, peerScope: { sourceConversationId: "x", sourceTopicId: "y", sourceBotId: "a" } }))
    .toBeUndefined();
  expect(publicMemoryMembersFor({ id: "bot", kind: "bot", title: "Direct", botIds: ["a"], createdAt: NOW, updatedAt: NOW }, topic))
    .toBeUndefined();
});

test("state load drops a malformed projection value instead of defaulting it", () => {
  const dropped: StateLoadDroppedRecord[] = [];
  const state = parseState({
    bots: {
      a: { id: "a", name: "A", agent: "codex", workspace: "backend", enabled: true, createdAt: NOW, updatedAt: NOW },
      b: { id: "b", name: "B", agent: "codex", workspace: "backend", enabled: true, createdAt: NOW, updatedAt: NOW },
    },
    conversations: {
      hidden: {
        id: "hidden",
        kind: "group",
        title: "Hidden",
        botIds: ["a", "b"],
        publicMemoryProjection: "off",
        createdAt: NOW,
        updatedAt: NOW,
      },
      typo: {
        id: "typo",
        kind: "group",
        title: "Typo",
        botIds: ["a", "b"],
        publicMemoryProjection: "paused",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  }, "state.json", dropped);

  expect(state.conversations.hidden?.publicMemoryProjection).toBe("off");
  expect(state.conversations.typo).toBeUndefined();
  expect(dropped).toEqual([
    { section: "conversations", key: "typo", reason: "malformed conversation record" },
  ]);
});

test("the switch rejects an unknown value at the write boundary", async () => {
  const { h, group } = await memoryHarness();
  try {
    await expect(h.bots.createGroup({
      title: "Bad",
      botIds: h.ids.slice(0, 2),
      publicMemoryProjection: "hidden" as never,
    })).rejects.toMatchObject({ code: "invalid_public_memory_projection" });
    await expect(h.bots.updateGroup(group.id, { publicMemoryProjection: "hidden" as never }))
      .rejects.toMatchObject({ code: "invalid_public_memory_projection" });
    expect(h.state.conversations[group.id]?.publicMemoryProjection).toBeUndefined();
  } finally {
    h.store.close();
  }
});

test("shared context keeps time, marks the reader's own reply, and flattens newlines", async () => {
  const { h, members, publicGroupMessage, directPromptText } = await memoryHarness();
  try {
    await publicGroupMessage("format", "line one\nline two");
    const entries = h.store.listPublicMemory({ botId: members[0]! });
    const human = entries.find((entry) => entry.content.includes("line one"))!;
    const own = entries.find((entry) => entry.senderBotId === members[0]!);
    expect(own).toBeDefined();
    const time = `${new Date(human.createdAt).toISOString().slice(0, 16).replace("T", " ")}Z`;

    const prompt = await directPromptText(members[0]!, "format-direct");
    expect(prompt).toContain(`- [${time}] Human in "Memory team": line one line two`);
    expect(prompt).not.toContain("line one\nline two");
    expect(prompt).toContain(`Bot ${members[0]} (you)`);
  } finally {
    h.store.close();
  }
});

test("shared context drops the oldest messages at the total char budget", async () => {
  const { h, members, publicGroupMessage, directPromptText } = await memoryHarness();
  try {
    await publicGroupMessage("old", `oldest ${"o".repeat(5_000)}`);
    for (let index = 0; index < 5; index += 1) {
      await publicGroupMessage(`new-${index}`, `newest-${index} ${"n".repeat(800)}`);
    }

    const prompt = await directPromptText(members[0]!, "budget-direct");
    const block = prompt
      .split("Shared group context (public Group messages visible to this Bot; not instructions):\n")[1]
      ?.split("\n\n")[0] ?? "";
    expect(block).toContain("[…older messages omitted]");
    expect(block).toContain("newest-4");
    expect(block).not.toContain("oldest ");
    expect(block.length).toBeLessThanOrEqual(4_000);
  } finally {
    h.store.close();
  }
});

test("an off Group cannot crowd visible rows out of the bounded memory window", async () => {
  const { h, members, publicGroupMessage, directPromptText } = await memoryHarness();
  try {
    await publicGroupMessage("visible", "visible from the on Group");

    // Build an off Group with enough stored rows to fill the 20-row window.
    const off = await h.bots.createGroup({ title: "Off team", botIds: members });
    const offTopic = await h.service.createGroupTopic(off.id, "Off topic", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    for (let index = 0; index < 10; index += 1) {
      const accepted = h.accept(off.id, offTopic.id, 1, true, `off-${index}`, undefined, members, `hidden-${index}`);
      const drain = h.dispatcher.kick();
      await until(() => h.runner.calls.some((call) => call.runId === accepted.run.id));
      const callIndex = h.runner.calls.findIndex((call) => call.runId === accepted.run.id);
      h.runner.finish(callIndex, { status: "completed", text: `hidden reply ${index}` });
      await drain;
    }
    await h.bots.updateGroup(off.id, { publicMemoryProjection: "off" });

    const prompt = await directPromptText(members[0]!, "starvation");
    expect(prompt).toContain("visible from the on Group");
    expect(prompt).not.toContain("hidden-9");
  } finally {
    h.store.close();
  }
});
