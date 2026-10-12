import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import {
  botRemovalRevision,
  groupRemovalBlocker,
  parseBotRemovalRecord,
  removalBlocksWork,
  tombstoneFromProfile,
  transitionBotRemoval,
  worktreeBlocksRemoval,
  type BotRemovalFacts,
  type BotRemovalRecord,
} from "../../../src/bots/bot-removal";
import {
  lifecycleOperationId,
  parseLifecycleOperation,
  transitionLifecycleOperation,
} from "../../../src/conversations/lifecycle-operation";
import { ConversationError } from "../../../src/conversations/conversation-error";
import type { BotProfile } from "../../../src/bots/bot-types";

const AT = "2026-10-09T00:00:00.000Z";

const profile: BotProfile = {
  id: "bot_a",
  name: "Reviewer",
  agent: "codex",
  workspace: "backend",
  enabled: true,
  profileRevision: 1,
  createdAt: AT,
  updatedAt: AT,
};

function facts(patch: Partial<BotRemovalFacts> = {}): BotRemovalFacts {
  return {
    directTopicIds: [],
    activeRunIds: [],
    queuedRunIds: [],
    indeterminateRunIds: [],
    memberUnsettledRunIds: [],
    groups: [],
    memberRuntimeKeys: [],
    worktreeKeys: [],
    bindingKeys: [],
    history: { directMessages: 0, directRuns: 0, groupMessages: 0, groupRuns: 0 },
    ...patch,
  };
}

test("removal phases block work except preview, and a two-member group cannot drop one member", () => {
  expect(removalBlocksWork("previewed")).toBe(false);
  expect(removalBlocksWork("deleting")).toBe(true);
  expect(removalBlocksWork("indeterminate")).toBe(true);
  expect(removalBlocksWork("retired")).toBe(true);
  expect(groupRemovalBlocker(2)).toBe("group-needs-another-member");
  expect(groupRemovalBlocker(3)).toBe("remove-member-first");
  expect(worktreeBlocksRemoval("active", "pending")).toBe(true);
  expect(worktreeBlocksRemoval("cleaned", "pending")).toBe(false);
  expect(worktreeBlocksRemoval("active", "abandoned")).toBe(false);
});

test("preview revision changes when membership or history changes", () => {
  const first = botRemovalRevision(facts());
  const regrouped = botRemovalRevision(facts({
    groups: [{ conversationId: "g1", memberCount: 2, botIds: ["bot_b", "bot_a"] }],
  }));
  const sameGroup = botRemovalRevision(facts({
    groups: [{ conversationId: "g1", memberCount: 2, botIds: ["bot_a", "bot_b"] }],
  }));
  expect(regrouped).toBe(sameGroup);
  expect(regrouped).not.toBe(first);
  expect(botRemovalRevision(facts({ history: { directMessages: 1, directRuns: 0, groupMessages: 0, groupRuns: 0 } }))).not.toBe(first);
});

test("removal retires only from deleting, and indeterminate does not look finished", () => {
  const previewed = transitionBotRemoval(undefined, "bot_a", { type: "preview", revision: "rev", at: AT });
  expect(previewed.phase).toBe("previewed");
  const deleting = transitionBotRemoval(previewed, "bot_a", {
    type: "begin",
    operationId: "bot-remove:req-1",
    requestId: "req-1",
    revision: "rev",
    clearDirectHistory: false,
    releaseDirectBindings: false,
    at: AT,
  });
  expect(deleting.phase).toBe("deleting");
  const stuck = transitionBotRemoval(deleting, "bot_a", {
    type: "indeterminate",
    error: { code: "conversation_indeterminate", message: "unknown" },
    at: AT,
  });
  expect(stuck.phase).toBe("indeterminate");
  expect(() => transitionBotRemoval(stuck, "bot_a", {
    type: "retire",
    tombstone: tombstoneFromProfile(profile, AT),
    at: AT,
  })).toThrow(BotError);
  const resumed = transitionBotRemoval(stuck, "bot_a", {
    type: "begin",
    operationId: "bot-remove:req-1",
    requestId: "req-1",
    revision: "rev",
    clearDirectHistory: true,
    releaseDirectBindings: true,
    at: AT,
  });
  expect(resumed.phase).toBe("deleting");
  expect(resumed.clearDirectHistory).toBe(false);
  const retired = transitionBotRemoval(resumed, "bot_a", {
    type: "retire",
    tombstone: tombstoneFromProfile(profile, AT),
    at: AT,
  });
  expect(retired.phase).toBe("retired");
  expect(retired.tombstone?.name).toBe("Reviewer");
  expect(transitionBotRemoval(retired, "bot_a", {
    type: "begin",
    operationId: "bot-remove:req-1",
    requestId: "req-1",
    revision: "rev",
    clearDirectHistory: false,
    releaseDirectBindings: false,
    at: AT,
  }).phase).toBe("retired");
});

test("a second removal request cannot replace one that is already deleting", () => {
  const deleting = transitionBotRemoval(undefined, "bot_a", {
    type: "begin",
    operationId: "bot-remove:req-1",
    requestId: "req-1",
    revision: "rev",
    clearDirectHistory: false,
    releaseDirectBindings: false,
    at: AT,
  });
  expect(() => transitionBotRemoval(deleting, "bot_a", {
    type: "begin",
    operationId: "bot-remove:req-2",
    requestId: "req-2",
    revision: "rev",
    clearDirectHistory: true,
    releaseDirectBindings: false,
    at: AT,
  })).toThrow(BotError);
});

test("lifecycle operations stay indeterminate until a later start completes", () => {
  const id = lifecycleOperationId("bot-remove", "req-1");
  const started = transitionLifecycleOperation(undefined, {
    type: "start",
    id,
    kind: "bot-remove",
    subjectId: "bot_a",
    requestId: "req-1",
    params: { clearDirectHistory: false, releaseDirectBindings: false },
    at: AT,
  });
  const unknown = transitionLifecycleOperation(started, {
    type: "indeterminate",
    error: { code: "conversation_indeterminate", message: "unknown" },
    at: AT,
  });
  expect(unknown.phase).toBe("indeterminate");
  expect(() => transitionLifecycleOperation(unknown, { type: "complete", at: AT })).toThrow(ConversationError);
  const again = transitionLifecycleOperation(unknown, {
    type: "start",
    id,
    kind: "bot-remove",
    subjectId: "bot_a",
    requestId: "req-1",
    at: AT,
  });
  expect(again.phase).toBe("running");
  expect(again.params).toEqual({ clearDirectHistory: false, releaseDirectBindings: false });
  const done = transitionLifecycleOperation(again, { type: "complete", at: AT });
  expect(done.phase).toBe("completed");
  expect(transitionLifecycleOperation(done, {
    type: "start",
    id,
    kind: "bot-remove",
    subjectId: "bot_a",
    requestId: "req-1",
    params: { clearDirectHistory: true, releaseDirectBindings: true },
    at: AT,
  }).phase).toBe("completed");
  expect(parseLifecycleOperation(done)?.phase).toBe("completed");
  expect(parseLifecycleOperation({ ...done, phase: "nope" })).toBeUndefined();
});

test("retired removal records without a tombstone do not parse", () => {
  const retired: BotRemovalRecord = {
    botId: "bot_a",
    phase: "retired",
    updatedAt: AT,
    tombstone: tombstoneFromProfile(profile, AT),
  };
  expect(parseBotRemovalRecord(retired, "bot_a")?.tombstone?.name).toBe("Reviewer");
  expect(parseBotRemovalRecord({ ...retired, tombstone: undefined }, "bot_a")).toBeUndefined();
  expect(parseBotRemovalRecord({ botId: "bot_a", phase: "deleting", updatedAt: AT }, "bot_a")?.phase).toBe("deleting");
});
