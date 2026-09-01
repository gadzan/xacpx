import { describe, expect, it } from "vitest";
import type { MessageRecordDto, PeerMessageHistoryEntry } from "@ganglion/xacpx-relay-protocol";
import {
  placeReceivedCardsAfterTurns,
  slotAfterIndexFromStartedAt,
} from "../lib/history-turn-slots";

const iso = (ms: number) => new Date(ms).toISOString();

const received = (id: string, createdAt: number): MessageRecordDto => ({
  instanceId: "i1",
  sessionAlias: "s",
  direction: "in",
  text: id,
  createdAt: iso(createdAt),
  structured: {
    agentMessage: {
      kind: "agent_message",
      direction: "received",
      messageId: id,
      conversationId: `conv_${id}`,
      peer: { handle: "agent:n:e", displayName: "Peer", agent: "codex" },
      content: id,
      createdAt,
      status: "delivered",
    } satisfies PeerMessageHistoryEntry,
  },
});

const assistantOut = (text: string, startedAt: number, createdAt = startedAt + 5_000): MessageRecordDto => ({
  instanceId: "i1",
  sessionAlias: "s",
  direction: "out",
  text,
  createdAt: iso(createdAt),
  startedAt,
});

describe("slotAfterIndexFromStartedAt", () => {
  it("places the live slot after the triggering received card and before a mid-turn card", () => {
    const rows = [received("card1", 1_000), received("card2", 3_000)];
    expect(slotAfterIndexFromStartedAt(rows, 2_000)).toBe(0);
  });

  it("returns -1 when every row arrived after the turn started", () => {
    expect(slotAfterIndexFromStartedAt([received("card2", 3_000)], 2_000)).toBe(-1);
  });
});

describe("placeReceivedCardsAfterTurns", () => {
  it("moves a mid-turn received card to immediately after the out (hub insertion order)", () => {
    const card1 = received("card1", 1_000);
    const card2 = received("card2", 3_000);
    const out = assistantOut("reply", 2_000, 5_000);
    const placed = placeReceivedCardsAfterTurns([card1, card2, out]);
    expect(placed.map((m) => m.text)).toEqual(["card1", "reply", "card2"]);
  });

  it("leaves a triggering received card (created before startedAt) in front of the out", () => {
    const card1 = received("card1", 1_000);
    const out = assistantOut("reply", 2_000, 3_000);
    expect(placeReceivedCardsAfterTurns([card1, out]).map((m) => m.text)).toEqual(["card1", "reply"]);
  });

  it("does not reorder legacy outs that lack startedAt", () => {
    const card1 = received("card1", 1_000);
    const card2 = received("card2", 3_000);
    const legacy: MessageRecordDto = {
      instanceId: "i1",
      sessionAlias: "s",
      direction: "out",
      text: "old",
      createdAt: iso(5_000),
    };
    expect(placeReceivedCardsAfterTurns([card1, card2, legacy]).map((m) => m.text)).toEqual(["card1", "card2", "old"]);
  });

  it("does not pull a later turn's trigger backward onto an earlier out", () => {
    const card1 = received("card1", 1_000);
    const card2 = received("card2", 3_000);
    const out1 = assistantOut("t1", 2_000, 4_000);
    const card3 = received("card3", 7_000);
    const out2 = assistantOut("t2", 6_000, 8_000);
    const placed = placeReceivedCardsAfterTurns([card1, card2, out1, card3, out2]);
    expect(placed.map((m) => m.text)).toEqual(["card1", "t1", "card2", "t2", "card3"]);
  });

  it("does not nest or move sent agent-message rows (direction=sent)", () => {
    const sent: MessageRecordDto = {
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
    const out = assistantOut("reply", 2_000, 5_000);
    expect(placeReceivedCardsAfterTurns([sent, out]).map((m) => m.text)).toEqual(["sent", "reply"]);
  });

  it("is a no-op when the out is already in its live slot", () => {
    const card1 = received("card1", 1_000);
    const out = assistantOut("reply", 2_000, 4_000);
    const card2 = received("card2", 3_000);
    expect(placeReceivedCardsAfterTurns([card1, out, card2]).map((m) => m.text)).toEqual(["card1", "reply", "card2"]);
  });
});
