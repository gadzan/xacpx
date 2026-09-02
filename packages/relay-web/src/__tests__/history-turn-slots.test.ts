import { describe, expect, it } from "vitest";
import type { MessageRecordDto, PeerMessageHistoryEntry } from "@ganglion/xacpx-relay-protocol";
import {
  placeTurnsInSlots,
  slotAfterIndexFromAnchor,
} from "../lib/history-turn-slots";

const iso = (ms: number) => new Date(ms).toISOString();

const received = (id: number, messageId: string, createdAt: number): MessageRecordDto => ({
  id,
  instanceId: "i1",
  sessionAlias: "s",
  direction: "in",
  text: messageId,
  createdAt: iso(createdAt),
  structured: {
    agentMessage: {
      kind: "agent_message",
      direction: "received",
      messageId,
      conversationId: `conv_${messageId}`,
      peer: { handle: "agent:n:e", displayName: "Peer", agent: "codex" },
      content: messageId,
      createdAt,
      status: "delivered",
    } satisfies PeerMessageHistoryEntry,
  },
});

const prompt = (id: number, text: string, createdAt: number): MessageRecordDto => ({
  id,
  instanceId: "i1",
  sessionAlias: "s",
  direction: "in",
  text,
  createdAt: iso(createdAt),
});

const assistantOut = (id: number, text: string, slotAfterId: number, startedAt = 2_000): MessageRecordDto => ({
  id,
  instanceId: "i1",
  sessionAlias: "s",
  direction: "out",
  text,
  createdAt: iso(startedAt + 5_000),
  startedAt,
  slotAfterId,
});

describe("slotAfterIndexFromAnchor", () => {
  it("places the live slot after the triggering received card and before a mid-turn card", () => {
    const rows = [received(1, "card1", 1_000), received(2, "card2", 3_000)];
    expect(slotAfterIndexFromAnchor(rows, 1)).toBe(0);
  });

  it("returns -1 when every row was inserted after the turn started", () => {
    expect(slotAfterIndexFromAnchor([received(2, "card2", 3_000)], 1)).toBe(-1);
  });
});

describe("placeTurnsInSlots", () => {
  it("moves a mid-turn received card to immediately after the out (hub insertion order)", () => {
    const card1 = received(1, "card1", 1_000);
    const card2 = received(2, "card2", 3_000);
    const out = assistantOut(3, "reply", 1);
    const placed = placeTurnsInSlots([card1, card2, out]);
    expect(placed.map((m) => m.text)).toEqual(["card1", "reply", "card2"]);
  });

  it("still places a mid-turn card after the out when its peer createdAt is 30s before hub startedAt", () => {
    const card1 = received(1, "card1", 1_000);
    const card2 = received(2, "card2", 2_000 - 30_000);
    const out = assistantOut(3, "reply", 1, 2_000);
    const placed = placeTurnsInSlots([card1, card2, out]);
    expect(placed.map((m) => m.text)).toEqual(["card1", "reply", "card2"]);
  });

  it("moves a queued user prompt inserted after turn-start to after the out", () => {
    const p1 = prompt(1, "prompt1", 1_000);
    const queued = prompt(2, "queued prompt2", 3_000);
    const out = assistantOut(3, "reply", 1);
    expect(placeTurnsInSlots([p1, queued, out]).map((m) => m.text)).toEqual(["prompt1", "reply", "queued prompt2"]);
  });

  it("leaves a triggering received card (id <= slotAfterId) in front of the out", () => {
    const card1 = received(1, "card1", 1_000);
    const out = assistantOut(2, "reply", 1);
    expect(placeTurnsInSlots([card1, out]).map((m) => m.text)).toEqual(["card1", "reply"]);
  });

  it("does not reorder legacy outs that lack slotAfterId", () => {
    const card1 = received(1, "card1", 1_000);
    const card2 = received(2, "card2", 3_000);
    const legacy: MessageRecordDto = {
      instanceId: "i1",
      sessionAlias: "s",
      direction: "out",
      text: "old",
      createdAt: iso(5_000),
      startedAt: 2_000,
    };
    expect(placeTurnsInSlots([card1, card2, legacy]).map((m) => m.text)).toEqual(["card1", "card2", "old"]);
  });

  it("does not pull a later turn's trigger backward onto an earlier out", () => {
    const card1 = received(1, "card1", 1_000);
    const card2 = received(2, "card2", 3_000);
    const out1 = assistantOut(3, "t1", 1, 2_000);
    const card3 = received(4, "card3", 7_000);
    const out2 = assistantOut(5, "t2", 4, 6_000);
    const placed = placeTurnsInSlots([card1, card2, out1, card3, out2]);
    expect(placed.map((m) => m.text)).toEqual(["card1", "t1", "card2", "card3", "t2"]);
  });

  it("does not nest or drop sent agent-message rows (direction=sent)", () => {
    const sent: MessageRecordDto = {
      id: 2,
      instanceId: "i1",
      sessionAlias: "s",
      direction: "out",
      text: "sent",
      createdAt: iso(3_000),
      structured: {
        agentMessage: {
          kind: "agent_message",
          direction: "sent",
          messageId: "s1",
          conversationId: "c",
          peer: { handle: "agent:n:e", displayName: "Peer", agent: "codex" },
          content: "sent",
          createdAt: 3_000,
          status: "sent",
        },
      },
    };
    const out = assistantOut(3, "reply", 1);
    // Sent card was inserted after turn-start (id 2 > 1) so it moves after the out
    // as a standalone row — Gate B still forbids nesting received cards; sent join
    // is presentation-only and does not suppress this row.
    expect(placeTurnsInSlots([sent, out]).map((m) => m.text)).toEqual(["reply", "sent"]);
  });

  it("is a no-op when the out is already in its live slot", () => {
    const card1 = received(1, "card1", 1_000);
    const out = assistantOut(2, "reply", 1);
    const card2 = received(3, "card2", 3_000);
    expect(placeTurnsInSlots([card1, out, card2]).map((m) => m.text)).toEqual(["card1", "reply", "card2"]);
  });
});
