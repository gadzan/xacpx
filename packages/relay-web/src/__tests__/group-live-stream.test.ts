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
  it("keeps one stable row per member showing only its newest text", () => {
    const mira = turn("mira");
    const sol = turn("sol");
    const parts: Record<string, TurnPartDto[]> = {
      mira: [text("A1"), tool(), text("A2 A3")],
      sol: [text("B1"), tool()],
    };
    const rows = interleaveGroupLiveStream({
      members: [mira, sol],
      liveParts: (id) => parts[id],
      isRunning: () => true,
    });

    expect(rows.map((row) => row.memberTurn.id)).toEqual(["mira", "sol"]);
    expect(rows.map((row) => row.text)).toEqual(["A2 A3", "B1"]);
    expect(rows.map((row) => row.index)).toEqual([2, 0]);
    expect(rows.every((row) => row.latest && !row.placeholder && row.running)).toBe(true);
  });

  it("gives a member with no text yet a dots-only row", () => {
    const mira = turn("mira");
    const sol = turn("sol");
    const parts: Record<string, TurnPartDto[]> = { mira: [text("A1")] };
    const rows = interleaveGroupLiveStream({
      members: [mira, sol],
      liveParts: (id) => parts[id],
      isRunning: () => true,
    });

    expect(rows).toHaveLength(2);
    expect(rows[1].placeholder).toBe(true);
    expect(rows[1].text).toBe("");
    expect(rows[1].memberTurn.id).toBe("sol");
  });

  it("keeps a finished member's newest text but drops its dots", () => {
    const mira = turn("mira", "completed");
    const sol = turn("sol");
    const parts: Record<string, TurnPartDto[]> = { mira: [text("A1")], sol: [text("B1")] };
    const rows = interleaveGroupLiveStream({
      members: [mira, sol],
      liveParts: (id) => parts[id],
      isRunning: (candidate) => candidate.state === "running",
    });

    expect(rows.map((row) => row.text)).toEqual(["A1", "B1"]);
    expect(rows[0].running).toBe(false);
    expect(rows[1].running).toBe(true);
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
