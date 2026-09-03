import { expect, test } from "bun:test";

import { createEmptyState } from "../../../src/state/types";
import { stageWorkerBindingIdentity } from "../../../src/orchestration/worker-launch";

function stateWithBinding(binding: Record<string, unknown>) {
  const state = createEmptyState();
  state.orchestration.workerBindings["worker-1"] = binding as never;
  return state;
}

const input = { workerSession: "worker-1", targetAgent: "codex", workspace: "backend" };

test("missing binding stages nothing and touches nothing", () => {
  const state = createEmptyState();
  let calls = 0;
  const out = stageWorkerBindingIdentity(state, input, () => {
    calls += 1;
    return "cli";
  });
  expect(out).toEqual({ changed: false });
  expect(calls).toBe(0);
  expect(state.orchestration.workerBindings["worker-1"]).toBeUndefined();
});

test("complete binding stages nothing", () => {
  const state = stateWithBinding({ logicalSessionId: "lid-1", transportEngine: "cli" });
  let calls = 0;
  const out = stageWorkerBindingIdentity(state, input, () => {
    calls += 1;
    return "runtime";
  });
  expect(out).toEqual({ changed: false });
  expect(calls).toBe(0);
});

test("incomplete binding stages onto a clone and leaves live state untouched", () => {
  const state = stateWithBinding({ sourceHandle: "src-1" });
  const before = structuredClone(state);
  const out = stageWorkerBindingIdentity(state, input, () => "runtime");
  expect(out.changed).toBe(true);
  if (!out.changed) return;
  // Live state byte-for-byte unchanged (G11: a later saveNow failure cannot
  // leave a half-persisted affinity behind).
  expect(state).toEqual(before);
  expect(state.orchestration.workerBindings["worker-1"]).toEqual({ sourceHandle: "src-1" });
  // Clone carries fresh LID + resolved engine.
  const staged = out.nextState.orchestration.workerBindings["worker-1"]!;
  expect(typeof staged.logicalSessionId).toBe("string");
  expect(staged.logicalSessionId).not.toBe("");
  expect(staged.transportEngine).toBe("runtime");
  expect(staged.sourceHandle).toBe("src-1");
  // Simulate a saveNow failure: live is untouched, so a retry must re-stage
  // (changed:true) with a fresh identity — never reuse a half-persisted one.
  // ensure/transport calls happen only after a successful saveNow+publish.
  const retry = stageWorkerBindingIdentity(state, input, () => "runtime");
  expect(retry.changed).toBe(true);
  if (!retry.changed) return;
  expect(retry.nextState.orchestration.workerBindings["worker-1"]!.logicalSessionId).not.toBe(
    staged.logicalSessionId,
  );
  expect(state.orchestration.workerBindings["worker-1"]).toEqual({ sourceHandle: "src-1" });
});

test("strict-ineligible engine throws before any mutation", () => {
  const state = stateWithBinding({ sourceHandle: "src-1" });
  const before = structuredClone(state);
  expect(() =>
    stageWorkerBindingIdentity(state, input, () => {
      throw new Error('transport.engine = "runtime" is not eligible');
    }),
  ).toThrow(/not eligible/);
  expect(state).toEqual(before);
});

test("partial binding keeps existing LID and only resolves engine", () => {
  const state = stateWithBinding({ logicalSessionId: "lid-kept" });
  const out = stageWorkerBindingIdentity(state, input, () => "cli");
  expect(out.changed).toBe(true);
  if (!out.changed) return;
  expect(out.nextState.orchestration.workerBindings["worker-1"]!.logicalSessionId).toBe("lid-kept");
  expect(out.nextState.orchestration.workerBindings["worker-1"]!.transportEngine).toBe("cli");
  expect(state.orchestration.workerBindings["worker-1"]).toEqual({ logicalSessionId: "lid-kept" });
});
