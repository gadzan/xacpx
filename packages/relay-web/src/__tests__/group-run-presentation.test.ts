import { describe, expect, it } from "vitest";
import type { ConversationMessageDto, ConversationRunDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";
import {
  computePopoverPlacement,
  projectGroupTranscript,
  resolveMemberOwner,
  traceEventsToParts,
  type GroupRunRecord,
} from "../lib/group-run-presentation";
const scope = { conversationId: "conv", topicId: "topic" };

function run(id: string, over: Partial<ConversationRunDto> = {}): ConversationRunDto {
  return {
    id, ...scope, requestMessageId: "req_msg", requestId: `req_${id}`,
    mode: "explicit", state: "completed", profileRevision: 1, createdAt: "now",
    ...over,
  };
}

function turn(id: string, runId: string, botId: string, over: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    id, runId, ...scope, botId, batch: 1, memberIndex: 0, attempt: 1,
    origin: "human-explicit", state: "completed", createdAt: "now",
    promptRequestId: `src_${id}`, ...over,
  };
}

function message(id: string, seq: number, over: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return { id, ...scope, seq, role: "human", content: id, createdAt: "now", ...over };
}

function record(r: ConversationRunDto, turns: MemberTurnSummaryDto[]): GroupRunRecord {
  return { run: r, memberTurns: turns };
}

describe("resolveMemberOwner", () => {
  it("joins a reply through the exact promptRequestId", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, {
      role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1", content: "done",
    });
    expect(resolveMemberOwner(rec, reply).owner?.id).toBe("t1");
  });

  it("falls back only to a provably unique same-bot member", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", content: "done" });
    expect(resolveMemberOwner(rec, reply).owner?.id).toBe("t1");
  });

  it("refuses the unique-member fallback when two same-bot members exist", () => {
    const rec = record(run("r1"), [
      turn("t1", "r1", "bot_a"),
      turn("t2", "r1", "bot_a", { batch: 2, memberIndex: 1 }),
    ]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", content: "done" });
    expect(resolveMemberOwner(rec, reply).problem).toBe("ambiguous-owner");
  });

  it("rejects a reply whose promptRequestId names a turn outside the run", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, {
      role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_other", content: "done",
    });
    expect(resolveMemberOwner(rec, reply).problem).toBe("owner-mismatch");
  });

  it("rejects an exact join whose bot contradicts the reply sender", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, {
      role: "bot", runId: "r1", senderBotId: "bot_b", promptRequestId: "src_t1", content: "done",
    });
    expect(resolveMemberOwner(rec, reply).problem).toBe("owner-mismatch");
  });

  it("reports a missing run instead of guessing", () => {
    const reply = message("m2", 2, { role: "bot", runId: "gone", senderBotId: "bot_a", content: "done" });
    expect(resolveMemberOwner(undefined, reply).problem).toBe("missing-run");
  });

  it.each([
    ["run id", { id: "another-run" }],
    ["conversation", { conversationId: "another-conversation" }],
    ["topic", { topicId: "another-topic" }],
  ])("rejects a record with a mismatched %s", (_label, overrides) => {
    const rec = record(run("r1", overrides), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1" });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "owner-mismatch" });
  });

  it.each([
    ["run", { runId: "another-run" }],
    ["conversation", { conversationId: "another-conversation" }],
    ["topic", { topicId: "another-topic" }],
  ])("rejects an exact source owned by a member in another %s", (_label, overrides) => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a", overrides)]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1" });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "owner-mismatch" });
  });

  it.each([undefined, ""]) ("requires a nonempty exact sender (%s)", (senderBotId) => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId, promptRequestId: "src_t1" });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "owner-mismatch" });
  });

  it.each([undefined, "src_t1"]) ("rejects duplicate member identities with source %s", (promptRequestId) => {
    const rec = record(run("r1"), [
      turn("t1", "r1", "bot_a"),
      turn("t1", "r1", "bot_b", { promptRequestId: "other-source" }),
    ]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "ambiguous-owner" });
  });

  it.each([undefined, "shared-source"]) ("rejects duplicated source ownership with source %s", (promptRequestId) => {
    const rec = record(run("r1"), [
      turn("t1", "r1", "bot_a", { promptRequestId: "shared-source" }),
      turn("t2", "r1", "bot_b", { promptRequestId: "shared-source" }),
    ]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "ambiguous-owner" });
  });

  it("does not hide a contradictory unscoped same-bot member during legacy fallback", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a"), turn("foreign", "other-run", "bot_a")]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a" });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "ambiguous-owner" });
  });

  it("does not interpret an empty source as a legacy source", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const reply = message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "" });
    expect(resolveMemberOwner(rec, reply)).toEqual({ problem: "owner-mismatch" });
  });

  it("does not join bot-role Handoff announcements as replies", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const handoff = message("h1", 2, {
      role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1",
      handoff: { senderMemberTurnId: "t0", to: "bot_a", assignmentId: "a", memberTurnId: "t1", task: "work" },
    });
    expect(resolveMemberOwner(rec, handoff)).toEqual({});
  });
});

describe("projectGroupTranscript", () => {
  it("anchors the bubble on the canonical reply and keeps other replies plain", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({
      messages: [
        message("req_msg", 1),
        message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1", content: "one" }),
        message("m3", 3, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1", content: "two" }),
      ],
      runs: { r1: rec },
    });
    const anchored = items.filter((item) => item.kind === "message" && item.bubbleAnchor);
    expect(anchored).toHaveLength(1);
    expect((anchored[0] as { message: ConversationMessageDto }).message.id).toBe("m2");
  });

  it("renders an activity row after the owning request for a member with no reply", () => {
    const rec = record(run("r1", { state: "running" }), [
      turn("t1", "r1", "bot_a", { state: "running" }),
    ]);
    const items = projectGroupTranscript({
      messages: [message("req_msg", 1)],
      runs: { r1: rec },
    });
    const activities = items.filter((item) => item.kind === "member-activity");
    expect(activities).toHaveLength(1);
    expect((activities[0] as { memberTurn: MemberTurnSummaryDto }).memberTurn.id).toBe("t1");
    // It sits directly after the owning human request.
    expect(items[1]?.kind).toBe("member-activity");
  });

  it("renders exactly one neutral routing entry for a zero-member run", () => {
    const rec = record(run("r1", { mode: "automatic", state: "running" }), []);
    const items = projectGroupTranscript({
      messages: [message("req_msg", 1)],
      runs: { r1: rec },
    });
    const routing = items.filter((item) => item.kind === "routing");
    expect(routing).toHaveLength(1);
    expect((routing[0] as { run: GroupRunRecord }).run.run.id).toBe("r1");
  });

  it("renders an unresolved labeled entry for an ambiguous reply and never drops it", () => {
    const rec = record(run("r1"), [
      turn("t1", "r1", "bot_a"),
      turn("t2", "r1", "bot_a", { batch: 2, memberIndex: 1 }),
    ]);
    const items = projectGroupTranscript({
      messages: [
        message("req_msg", 1),
        message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", content: "ambiguous" }),
      ],
      runs: { r1: rec },
    });
    const unresolved = items.filter((item) => item.kind === "unresolved");
    expect(unresolved).toHaveLength(1);
    expect((unresolved[0] as { explanation: string }).explanation).toBe("ambiguous-owner");
    // The canonical message itself is preserved once (inside the unresolved item).
    const plain = items.filter((item) => item.kind === "message");
    expect(plain).toHaveLength(1);
  });

  it("keeps members with a proven reply free of activity rows (same bot twice)", () => {
    const rec = record(run("r1"), [
      turn("t1", "r1", "bot_a"),
      turn("t2", "r1", "bot_a", { batch: 2, memberIndex: 1 }),
    ]);
    const items = projectGroupTranscript({
      messages: [
        message("req_msg", 1),
        message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1", content: "first" }),
        message("m3", 3, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t2", content: "second" }),
      ],
      runs: { r1: rec },
    });
    expect(items.filter((item) => item.kind === "member-activity")).toHaveLength(0);
    expect(items.filter((item) => item.kind === "message" && item.bubbleAnchor)).toHaveLength(2);
  });

  it("keeps handoff and system messages in their seq positions untouched", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({
      messages: [
        message("req_msg", 1),
        message("h1", 2, { role: "system", senderBotId: "bot_a", runId: "r1", content: "", handoff: { senderMemberTurnId: "t0", to: "bot_a", assignmentId: "a", memberTurnId: "t1", task: "work" } }),
        message("m3", 3, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1", content: "done" }),
      ],
      runs: { r1: rec },
    });
    expect(items.map((item) => (item.kind === "message" ? item.message.id : item.key[0] === "a" ? "ACT" : item.key[0] === "r" ? "ROUTE" : "UNRES")))
      .toEqual(["req_msg", "h1", "m3"]);
  });

  it("keeps stable item keys across promotion", () => {
    const rec = record(run("r1", { state: "running" }), [turn("t1", "r1", "bot_a", { state: "running" })]);
    const before = projectGroupTranscript({ messages: [message("req_msg", 1)], runs: { r1: rec } });
    const after = projectGroupTranscript({
      messages: [
        message("req_msg", 1),
        message("m2", 2, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1", content: "done" }),
      ],
      runs: { r1: rec },
    });
    expect(before.find((item) => item.kind === "member-activity")?.key).toBe("activity:r1:t1");
    // After the reply arrives, the member anchors on the canonical message and
    // no activity row lingers.
    expect(after.find((item) => item.kind === "member-activity")).toBeUndefined();
    expect(after.find((item) => item.kind === "message" && item.bubbleAnchor && item.memberTurn?.id === "t1")).toBeDefined();
  });

  it("keeps old runs independent even when member ids collide", () => {
    const old = record(run("old", { requestMessageId: "old-request" }), [turn("t1", "old", "bot_a")]);
    const current = record(run("current", { requestMessageId: "current-request", state: "running" }), [
      turn("t1", "current", "bot_a", { state: "running" }),
    ]);
    const items = projectGroupTranscript({
      messages: [message("old-request", 1), message("old-reply", 2, {
        role: "bot", runId: "old", senderBotId: "bot_a", promptRequestId: "src_t1",
      }), message("current-request", 3)],
      runs: { old, current },
    });
    expect(items.filter((item) => item.kind === "message" && item.bubbleAnchor))
      .toMatchObject([{ message: { id: "old-reply" }, run: { run: { id: "old" } } }]);
    expect(items.filter((item) => item.kind === "member-activity"))
      .toMatchObject([{ key: "activity:current:t1", run: { run: { id: "current" } } }]);
  });

  it.each(["bot", "system"] as const)("does not anchor activity to a %s request-id collision", (role) => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({
      messages: [message("req_msg", 1, { role }), message("nearby", 2)], runs: { r1: rec },
    });
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "member-activity"]);
    expect(items[2]).toMatchObject({ requestMessageId: undefined, explanation: "request-mismatch" });
  });

  it.each([
    { conversationId: "foreign" }, { topicId: "foreign" },
  ])("does not anchor to a human request outside its exact scope (%j)", (overrides) => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({
      messages: [message("req_msg", 1, overrides), message("nearby", 2)], runs: { r1: rec },
    });
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "member-activity"]);
    expect(items[2]).toMatchObject({ requestMessageId: undefined, explanation: "request-mismatch" });
  });

  it("retains orphan activity without assigning the run's first visible message as its request", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({
      messages: [message("first-visible", 2, { role: "system", runId: "r1" }), message("nearby", 3)],
      runs: { r1: rec },
    });
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "member-activity"]);
    expect(items[2]).toMatchObject({ requestMessageId: undefined, explanation: "missing-request" });
  });

  it("waits for the exact request rather than flushing activity at an earlier run message", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({
      messages: [message("earlier", 1, { role: "system", runId: "r1" }), message("req_msg", 2), message("later", 3)],
      runs: { r1: rec },
    });
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "member-activity", "message"]);
    expect(items[2]).toMatchObject({ requestMessageId: "req_msg", explanation: undefined });
  });

  it("retains one terminal routing entry per zero-member run with independent requests", () => {
    const items = projectGroupTranscript({
      messages: [message("first-request", 1), message("second-request", 2)],
      runs: {
        old: record(run("old", { requestMessageId: "first-request", mode: "automatic", state: "failed" }), []),
        current: record(run("current", { requestMessageId: "second-request", mode: "automatic", state: "waiting-human" }), []),
        orphan: record(run("orphan", { requestMessageId: "missing", state: "cancelled" }), []),
      },
    });
    expect(items.map((item) => item.kind === "routing" ? item.key : item.kind)).toEqual([
      "message", "routing:old", "message", "routing:current", "routing:orphan",
    ]);
    expect(items[4]).toMatchObject({ requestMessageId: undefined, explanation: "missing-request" });
  });

  it("orders unreplied member activities by batch, member index and id", () => {
    const rec = record(run("r1"), [
      turn("late", "r1", "bot_a", { batch: 2 }),
      turn("z", "r1", "bot_b", { memberIndex: 1 }),
      turn("a", "r1", "bot_c", { memberIndex: 1 }),
      turn("first", "r1", "bot_d"),
    ]);
    const items = projectGroupTranscript({ messages: [message("req_msg", 1)], runs: { r1: rec } });
    expect(items.filter((item) => item.kind === "member-activity").map((item) => item.memberTurn.id))
      .toEqual(["first", "a", "z", "late"]);
  });

  it("preserves every canonical reply once at original seq through ambiguous ownership", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a"), turn("t2", "r1", "bot_a")]);
    const request = message("req_msg", 1);
    const ambiguous = message("ambiguous", 3, { role: "bot", runId: "r1", senderBotId: "bot_a" });
    const items = projectGroupTranscript({
      messages: [ambiguous, message("system", 2, { role: "system" }), request, ambiguous], runs: { r1: rec },
    });
    const canonical = items.flatMap((item) => item.kind === "message" || item.kind === "unresolved" ? [item.message] : []);
    expect(canonical.map((item) => item.id)).toEqual(["req_msg", "system", "ambiguous"]);
    expect(canonical[2]).toBe(ambiguous);
    expect(items.filter((item) => item.kind === "member-activity")).toHaveLength(2);
    expect(items.find((item) => item.kind === "unresolved")).toMatchObject({ explanation: "ambiguous-owner" });
  });

  it("retains duplicate-identity activity with an explanation instead of merging replies", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a"), turn("t1", "r1", "bot_a")]);
    const items = projectGroupTranscript({ messages: [message("req_msg", 1), message("reply", 2, {
      role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1",
    })], runs: { r1: rec } });
    expect(items.filter((item) => item.kind === "member-activity")).toMatchObject([{ explanation: "ambiguous-owner" }]);
    expect(items.find((item) => item.kind === "unresolved")).toMatchObject({ explanation: "ambiguous-owner" });
    expect(items.some((item) => item.kind === "message" && item.bubbleAnchor)).toBe(false);
  });

  it("labels a missing scoped run without losing the reply", () => {
    const reply = message("reply", 2, { role: "bot", runId: "missing", senderBotId: "bot_a" });
    expect(projectGroupTranscript({ messages: [reply], runs: {} }))
      .toEqual([{ kind: "unresolved", key: "unresolved:reply", message: reply, run: undefined, explanation: "missing-run" }]);
  });

  it("keeps bot-role Handoffs plain and gives the member only its earliest real reply bubble", () => {
    const rec = record(run("r1"), [turn("t1", "r1", "bot_a")]);
    const handoff = message("handoff", 2, {
      role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1",
      handoff: { senderMemberTurnId: "sender", to: "bot_a", assignmentId: "a", memberTurnId: "t1", task: "work" },
    });
    const items = projectGroupTranscript({ messages: [
      message("later", 4, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1" }),
      handoff, message("req_msg", 1),
      message("earliest", 3, { role: "bot", runId: "r1", senderBotId: "bot_a", promptRequestId: "src_t1" }),
    ], runs: { r1: rec } });
    expect(items.filter((item) => item.kind === "message").map((item) => [item.message.id, item.bubbleAnchor]))
      .toEqual([["req_msg", false], ["handoff", false], ["earliest", true], ["later", false]]);
    const handoffItem = items.find((item) => item.kind === "message" && item.message === handoff) as
      | { memberTurn?: unknown; run?: unknown } | undefined;
    expect(handoffItem && !("memberTurn" in handoffItem)).toBe(true);
    expect(items.some((item) => item.kind === "member-activity")).toBe(false);
  });
});

describe("traceEventsToParts", () => {
  const base = { seq: 0, createdAt: "now" };

  it("coalesces adjacent text and reasoning without changing order", () => {
    const { parts } = traceEventsToParts([
      { ...base, seq: 1, kind: "text", payload: { text: "Hel" } },
      { ...base, seq: 2, kind: "text", payload: { text: "lo" } },
      { ...base, seq: 3, kind: "reasoning", payload: { text: "thi" } },
      { ...base, seq: 4, kind: "reasoning", payload: { text: "nking" } },
      { ...base, seq: 5, kind: "text", payload: { text: " world" } },
    ]);
    expect(parts.map((p) => (p.type === "tool" ? "tool" : `${p.type}:${"text" in p ? p.text : ""}`)))
      .toEqual(["text:Hello", "reasoning:thinking", "text: world"]);
  });

  it("upserts tool updates by toolCallId in stream order", () => {
    const { parts } = traceEventsToParts([
      { ...base, seq: 1, kind: "tool", payload: { step: { toolCallId: "tc1", toolName: "bash", kind: "execute", status: "running", title: "run" } } },
      { ...base, seq: 2, kind: "tool", payload: { step: { toolCallId: "tc1", toolName: "bash", kind: "execute", status: "success", title: "run" } } },
    ]);
    expect(parts[0]).toMatchObject({ type: "tool", step: { toolCallId: "tc1", status: "success" } });
  });

  it("treats plan events as replace-latest and records the terminal marker", () => {
    const first = [{ content: "a", status: "pending" as const }];
    const second = [{ content: "a", status: "completed" as const }, { content: "b", status: "in_progress" as const }];
    const result = traceEventsToParts([
      { ...base, seq: 1, kind: "plan", payload: { entries: first } },
      { ...base, seq: 2, kind: "plan", payload: { entries: second } },
      { ...base, seq: 3, kind: "terminal", payload: { ok: true } },
    ]);
    expect(result.plan).toEqual(second);
    expect(result.terminal).toEqual({ ok: true });
  });
});

describe("computePopoverPlacement", () => {
  const viewport = { width: 1000, height: 800 };
  const popover = { width: 420, height: 300 };

  it("places below a mid-screen anchor", () => {
    const placement = computePopoverPlacement(
      { top: 200, left: 300, width: 44, height: 44 },
      viewport, popover,
    );
    expect(placement.placement).toBe("below");
    expect(placement.top).toBe(200 + 44 + 8);
  });

  it("flips above when the anchor sits near the bottom edge", () => {
    const placement = computePopoverPlacement(
      { top: 700, left: 300, width: 44, height: 44 },
      viewport, popover,
    );
    expect(placement.placement).toBe("above");
    expect(placement.top).toBe(700 - 8 - 300);
  });

  it("shifts into the viewport near the right edge", () => {
    const placement = computePopoverPlacement(
      { top: 200, left: 900, width: 44, height: 44 },
      viewport, popover,
    );
    expect(placement.left).toBe(1000 - 8 - 420);
  });

  it("clamps inside a narrow mobile viewport", () => {
    const placement = computePopoverPlacement(
      { top: 100, left: 4, width: 44, height: 44 },
      { width: 360, height: 640 }, popover,
    );
    expect(placement.left).toBe(8);
    expect(placement.left + 420 <= 360 - 8 + 1 || placement.left === 8).toBe(true);
  });
});
