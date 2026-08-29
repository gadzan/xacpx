import { describe, expect, test } from "bun:test";

import { createDispatchGate } from "../../../../../src/bridge/engine/runtime/runtime-worker-gate";

describe("dispatch gate (round 30 Blocking 4)", () => {
  test("admission is open until close()", () => {
    const gate = createDispatchGate();
    expect(gate.admit()).toBe(true);
    void gate.track(Promise.resolve());
    expect(gate.inFlightCount).toBe(1);
  });

  test("close() waits for in-flight dispatches and blocks new admission", async () => {
    const gate = createDispatchGate();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    void gate.track(slow.then(() => {
      settled = true;
    }));
    const closed = gate.close();
    expect(gate.admit()).toBe(false);
    // Close must NOT resolve while the dispatch is still in flight —
    // convergence must not snapshot a tree an in-flight ensure can still grow.
    await Promise.race([closed, new Promise<"pending">((r) => setTimeout(() => r("pending"), 50))]).then((state) => {
      expect(state).toBe("pending");
      expect(settled).toBe(false);
    });
    release();
    await closed;
    expect(settled).toBe(true);
    expect(gate.inFlightCount).toBe(0);
    expect(gate.admit()).toBe(false);
  });

  test("a rejecting dispatch still drains close() (failure cannot wedge quiescence)", async () => {
    const gate = createDispatchGate();
    void gate.track(Promise.reject(new Error("boom")));
    await gate.close();
    expect(gate.inFlightCount).toBe(0);
  });

  test("post-close tracked dispatches still drain (late arrivals never hang close)", async () => {
    const gate = createDispatchGate();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    void gate.track(slow);
    const closed = gate.close();
    // A dispatch that raced admission and landed after close() began.
    void gate.track(Promise.resolve());
    release();
    await closed;
    expect(gate.inFlightCount).toBe(0);
  });
});
