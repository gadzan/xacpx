import { describe, expect, it } from "vitest";
import type { MemberTurnSummaryDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { buildSettledStreams, interleaveGroupLiveStream } from "../lib/group-live-stream";

function turn(id: string, state: MemberTurnSummaryDto["state"] = "running"): MemberTurnSummaryDto {
  return { id, runId: "run_1", conversationId: "c1", topicId: "t1", botId: `bot_${id}`,
    state, batch: 1, memberIndex: 0 } as MemberTurnSummaryDto;
}

const tool = (): TurnPartDto => ({ type: "tool", step: { toolCallId: `t${Math.random()}`, toolName: "read", kind: "read", title: "x", status: "success" } });
const text = (value: string): TurnPartDto => ({ type: "text", text: value });

describe("interleaveGroupLiveStream", () => {
  it("orders parallel members' segments by arrival, not by member block", () => {
    const mira = turn("mira");
    const sol = turn("sol");
    const parts: Record<string, TurnPartDto[]> = {
      mira: [text("A1"), tool(), text("A2")],
      sol: [text("B1"), tool(), text("B2")],
    };
    const rows = interleaveGroupLiveStream({
      members: [mira, sol],
      liveParts: (id) => parts[id],
      segmentOrder: [
        { memberTurnId: "mira", index: 0, order: 1 },
        { memberTurnId: "sol", index: 0, order: 2 },
        { memberTurnId: "mira", index: 2, order: 3 },
        { memberTurnId: "sol", index: 2, order: 4 },
      ],
      isRunning: () => true,
    });

    expect(rows.map((row) => row.text)).toEqual(["A1", "B1", "A2", "B2"]);
    expect(rows.map((row) => row.latest)).toEqual([false, false, true, true]);
    expect(rows.every((row) => row.running)).toBe(true);
  });

  it("gives a member with no text yet a dots-only row at the tail", () => {
    const mira = turn("mira");
    const sol = turn("sol");
    const parts: Record<string, TurnPartDto[]> = { mira: [text("A1")] };
    const rows = interleaveGroupLiveStream({
      members: [mira, sol],
      liveParts: (id) => parts[id],
      segmentOrder: [{ memberTurnId: "mira", index: 0, order: 1 }],
      isRunning: () => true,
    });

    expect(rows).toHaveLength(2);
    expect(rows[1].placeholder).toBe(true);
    expect(rows[1].memberTurn.id).toBe("sol");
    expect(rows[1].latest).toBe(true);
  });

  it("keeps a finished member's segments but drops its dots", () => {
    const mira = turn("mira", "completed");
    const sol = turn("sol");
    const parts: Record<string, TurnPartDto[]> = { mira: [text("A1")], sol: [text("B1")] };
    const rows = interleaveGroupLiveStream({
      members: [mira, sol],
      liveParts: (id) => parts[id],
      segmentOrder: [
        { memberTurnId: "mira", index: 0, order: 1 },
        { memberTurnId: "sol", index: 0, order: 2 },
      ],
      isRunning: (candidate) => candidate.state === "running",
    });

    expect(rows.map((row) => row.memberTurn.id)).toEqual(["mira", "sol"]);
    expect(rows[0].running).toBe(false);
    expect(rows[1].running).toBe(true);
  });

  it("keeps unattributed snapshot segments visible, in part order, after the ordered ones", () => {
    const mira = turn("mira");
    const parts: Record<string, TurnPartDto[]> = { mira: [text("A1"), text("A2")] };
    const rows = interleaveGroupLiveStream({
      members: [mira],
      liveParts: (id) => parts[id],
      segmentOrder: [{ memberTurnId: "mira", index: 0, order: 5 }],
      isRunning: () => true,
    });

    expect(rows.map((row) => row.text)).toEqual(["A1", "A2"]);
    expect(rows[1].latest).toBe(true);
  });
});

describe("buildSettledStreams", () => {
  it("round-robins settled segments across members, not per-member blocks", () => {
    const streams = buildSettledStreams([
      { key: "msg:a", runId: "r1", memberTurnId: "a", segments: ["A1", "A2"] },
      { key: "msg:b", runId: "r1", memberTurnId: "b", segments: ["B1", "B2"] },
    ]);
    const stream = streams.get("r1")!;
    expect(stream.rows.map((row) => row.text)).toEqual(["A1", "B1", "A2", "B2"]);
    expect(stream.rows.map((row) => row.last)).toEqual([false, false, true, true]);
    expect(stream.anchorKey).toBe("msg:a");
    expect(stream.memberKeys).toEqual(["msg:a", "msg:b"]);
  });

  it("keeps the shorter member's tail and never interleaves single-member Runs", () => {
    const streams = buildSettledStreams([
      { key: "msg:a", runId: "r1", memberTurnId: "a", segments: ["A1", "A2", "A3"] },
      { key: "msg:b", runId: "r1", memberTurnId: "b", segments: ["B1"] },
      { key: "msg:c", runId: "r2", memberTurnId: "c", segments: ["C1", "C2"] },
    ]);
    expect(streams.get("r1")!.rows.map((row) => row.text)).toEqual(["A1", "B1", "A2", "A3"]);
    expect(streams.has("r2")).toBe(false);
  });
  it("treats one segment per member as a single last row in member order", () => {
    const streams = buildSettledStreams([
      { key: "msg:a", runId: "r1", memberTurnId: "a", segments: ["A1\n\nA2"] },
      { key: "msg:b", runId: "r1", memberTurnId: "b", segments: ["B1\n\nB2"] },
    ]);
    const stream = streams.get("r1")!;
    expect(stream.rows.map((row) => row.text)).toEqual(["A1\n\nA2", "B1\n\nB2"]);
    expect(stream.rows.map((row) => row.last)).toEqual([true, true]);
    expect(stream.anchorKey).toBe("msg:a");
  });
});
