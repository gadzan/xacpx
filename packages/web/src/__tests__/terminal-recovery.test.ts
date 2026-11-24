import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_REBASE_TOTAL_BYTES,
  TERMINAL_REBASE_CHUNK_BYTES,
} from "@ganglion/xacpx-relay-protocol";
import {
  initialRecoveryState,
  reduceRecovery,
} from "../lib/terminal-recovery";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function textB64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function withBufferHidden<T>(fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  Object.defineProperty(globalThis, "Buffer", { configurable: true, value: undefined });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, "Buffer", desc);
    else delete (globalThis as { Buffer?: unknown }).Buffer;
  }
}

describe("terminal recovery reducer", () => {
  it("waits until rebase-start, then applies empty keyframe into live", () => {
    let state = initialRecoveryState("g1");
    expect(state.phase).toBe("waiting");

    let step = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    });
    expect(step.state.phase).toBe("rebase");
    expect(step.action.type).toBe("none");

    step = reduceRecovery(step.state, { kind: "rebase-end", generation: "g1", epoch: 1 });
    expect(step.state.phase).toBe("live");
    expect(step.state.expectedSequence).toBe(0);
    expect(step.action).toEqual({ type: "apply-rebase", keyframe: new Uint8Array(0), cols: 80, rows: 24 });
  });

  it("assembles multi-chunk rebase and advances sequence on bytes", () => {
    const part1 = new Uint8Array(TERMINAL_REBASE_CHUNK_BYTES).fill(1);
    const part2 = new Uint8Array(10).fill(2);
    const total = part1.byteLength + part2.byteLength;

    let state = initialRecoveryState("g1");
    state = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "g1",
      epoch: 3,
      nextSequence: 7,
      cols: 100,
      rows: 30,
      alternate: true,
      totalBytes: total,
      chunkCount: 2,
    }).state;

    state = reduceRecovery(state, {
      kind: "rebase-chunk",
      generation: "g1",
      epoch: 3,
      index: 0,
      dataBase64: b64(part1),
    }).state;
    state = reduceRecovery(state, {
      kind: "rebase-chunk",
      generation: "g1",
      epoch: 3,
      index: 1,
      dataBase64: b64(part2),
    }).state;

    const end = reduceRecovery(state, { kind: "rebase-end", generation: "g1", epoch: 3 });
    expect(end.action.type).toBe("apply-rebase");
    if (end.action.type === "apply-rebase") {
      expect(end.action.keyframe.byteLength).toBe(total);
      expect(end.action.keyframe[0]).toBe(1);
      expect(end.action.keyframe[TERMINAL_REBASE_CHUNK_BYTES]).toBe(2);
      expect(end.action.cols).toBe(100);
      expect(end.action.rows).toBe(30);
    }
    expect(end.state.expectedSequence).toBe(7);

    const bytes = reduceRecovery(end.state, {
      kind: "bytes",
      generation: "g1",
      epoch: 3,
      sequence: 7,
      dataBase64: textB64("hi"),
    });
    expect(bytes.action.type).toBe("write-bytes");
    expect(bytes.state.expectedSequence).toBe(8);
  });

  it("resyncs when bytes arrive before rebase-start instead of dropping them", () => {
    const state = initialRecoveryState("g1");
    const early = reduceRecovery(state, {
      kind: "bytes",
      generation: "g1",
      epoch: 1,
      sequence: 0,
      dataBase64: textB64("echo"),
    });
    expect(early.state.phase).toBe("resyncing");
    expect(early.action).toEqual({ type: "request-resync", reason: "bytes-before-rebase" });
  });

  it("resyncs on sequence gap and ignores bytes until new rebase", () => {
    let state = initialRecoveryState("g1");
    state = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    }).state;
    state = reduceRecovery(state, { kind: "rebase-end", generation: "g1", epoch: 1 }).state;

    const gap = reduceRecovery(state, {
      kind: "bytes",
      generation: "g1",
      epoch: 1,
      sequence: 2,
      dataBase64: textB64("x"),
    });
    expect(gap.state.phase).toBe("resyncing");
    expect(gap.action).toEqual({ type: "request-resync", reason: "sequence-gap" });

    const ignored = reduceRecovery(gap.state, {
      kind: "bytes",
      generation: "g1",
      epoch: 1,
      sequence: 2,
      dataBase64: textB64("y"),
    });
    expect(ignored.action.type).toBe("ignore");
    expect(ignored.state.phase).toBe("resyncing");
  });

  it("resyncs on generation mismatch, bad chunk index, and bad base64", () => {
    let state = initialRecoveryState("g1");
    const gen = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "other",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    });
    expect(gen.action).toEqual({ type: "request-resync", reason: "generation-mismatch" });

    state = reduceRecovery(initialRecoveryState("g1"), {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 10,
      chunkCount: 1,
    }).state;
    const idx = reduceRecovery(state, {
      kind: "rebase-chunk",
      generation: "g1",
      epoch: 1,
      index: 1,
      dataBase64: b64(new Uint8Array(10)),
    });
    expect(idx.action).toEqual({ type: "request-resync", reason: "chunk-index-mismatch" });

    state = reduceRecovery(initialRecoveryState("g1"), {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 3,
      chunkCount: 1,
    }).state;
    const bad = reduceRecovery(state, {
      kind: "rebase-chunk",
      generation: "g1",
      epoch: 1,
      index: 0,
      dataBase64: "@@@",
    });
    expect(bad.action).toEqual({ type: "request-resync", reason: "chunk-base64-invalid" });
  });

  it("resyncs when rebase exceeds size cap or chunkCount mismatches", () => {
    const tooBig = reduceRecovery(initialRecoveryState("g1"), {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: MAX_TERMINAL_REBASE_TOTAL_BYTES + 1,
      chunkCount: 1,
    });
    expect(tooBig.action).toEqual({ type: "request-resync", reason: "rebase-too-large" });

    const badCount = reduceRecovery(initialRecoveryState("g1"), {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: TERMINAL_REBASE_CHUNK_BYTES + 1,
      chunkCount: 1, // should be 2
    });
    expect(badCount.action).toEqual({ type: "request-resync", reason: "rebase-chunk-count-mismatch" });
  });

  it("drops stale-epoch bytes after a newer rebase and rejects bytes during rebase", () => {
    let state = initialRecoveryState("g1");
    state = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    }).state;
    state = reduceRecovery(state, { kind: "rebase-end", generation: "g1", epoch: 1 }).state;

    // Newer rebase replaces epoch.
    state = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "g1",
      epoch: 2,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    }).state;
    const during = reduceRecovery(state, {
      kind: "bytes",
      generation: "g1",
      epoch: 2,
      sequence: 0,
      dataBase64: textB64("nope"),
    });
    expect(during.action).toEqual({ type: "request-resync", reason: "bytes-during-rebase" });

    state = reduceRecovery(initialRecoveryState("g1"), {
      kind: "rebase-start",
      generation: "g1",
      epoch: 2,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    }).state;
    state = reduceRecovery(state, { kind: "rebase-end", generation: "g1", epoch: 2 }).state;
    const stale = reduceRecovery(state, {
      kind: "bytes",
      generation: "g1",
      epoch: 1,
      sequence: 0,
      dataBase64: textB64("old"),
    });
    expect(stale.action.type).toBe("ignore");
    expect(stale.state.phase).toBe("live");
  });

  it("reaches live and writes bytes when global Buffer is unavailable", () => {
    const keyframe = textB64("prompt> ");
    const live = textB64("ls");
    withBufferHidden(() => {
      let state = initialRecoveryState("g1");
      state = reduceRecovery(state, {
        kind: "rebase-start",
        generation: "g1",
        epoch: 1,
        nextSequence: 0,
        cols: 80,
        rows: 24,
        alternate: false,
        totalBytes: 8,
        chunkCount: 1,
      }).state;
      state = reduceRecovery(state, {
        kind: "rebase-chunk",
        generation: "g1",
        epoch: 1,
        index: 0,
        dataBase64: keyframe,
      }).state;
      const end = reduceRecovery(state, { kind: "rebase-end", generation: "g1", epoch: 1 });
      expect(end.state.phase).toBe("live");
      expect(end.action.type).toBe("apply-rebase");
      if (end.action.type === "apply-rebase") {
        expect(new TextDecoder().decode(end.action.keyframe)).toBe("prompt> ");
      }

      const bytes = reduceRecovery(end.state, {
        kind: "bytes",
        generation: "g1",
        epoch: 1,
        sequence: 0,
        dataBase64: live,
      });
      expect(bytes.action.type).toBe("write-bytes");
      if (bytes.action.type === "write-bytes") {
        expect(new TextDecoder().decode(bytes.action.data)).toBe("ls");
      }
      expect(bytes.state.expectedSequence).toBe(1);
      expect(bytes.action.type).not.toBe("request-resync");
    });
  });

  it("marks exited and ignores further frames", () => {
    let state = initialRecoveryState("g1");
    state = reduceRecovery(state, { kind: "exit" }).state;
    expect(state.phase).toBe("exited");
    const after = reduceRecovery(state, {
      kind: "rebase-start",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    });
    expect(after.action.type).toBe("ignore");
    expect(after.state.phase).toBe("exited");
  });
});
