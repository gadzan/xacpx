import { expect, test } from "bun:test";

import { createEmptyState, type AppState } from "../../../src/state/types";
import type { OrchestrationTaskStatus } from "../../../src/orchestration/orchestration-types";
import {
  retireWorkerBinding,
  type WorkerBindingRetirementEnv,
} from "../../../src/orchestration/worker-binding-retirement";

const WORKER = "backend:codex:backend:main";

function completeBinding() {
  return {
    sourceHandle: WORKER,
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    guardAcpOutput: true as const,
    logicalSessionId: "lid-1",
    transportEngine: "cli" as const,
  };
}

function makeEnv(
  seed: AppState,
  overrides: Partial<Pick<WorkerBindingRetirementEnv, "releaseWorkerSession">> & {
    onLoad?: (state: AppState) => void;
    noReleasePort?: boolean;
  } = {},
): {
  env: WorkerBindingRetirementEnv;
  releases: Array<{ logicalSessionId: string }>;
  bindings: () => Promise<AppState["orchestration"]["workerBindings"]>;
} {
  let state = structuredClone(seed);
  const releases: Array<{ logicalSessionId: string }> = [];
  const env: WorkerBindingRetirementEnv = {
    loadState: async () => {
      overrides.onLoad?.(state);
      return structuredClone(state);
    },
    saveState: async (nextState) => {
      state = structuredClone(nextState);
    },
    runExclusive: async (critical) => critical(),
    releaseWorkerSession: overrides.noReleasePort
      ? undefined
      : (overrides.releaseWorkerSession ??
        (async (request) => {
          releases.push({ logicalSessionId: request.logicalSessionId });
        })),
    isTerminalStatus: (status: OrchestrationTaskStatus) =>
      status === "completed" || status === "failed" || status === "cancelled",
  };
  return {
    env,
    releases,
    bindings: async () => (await env.loadState()).orchestration.workerBindings,
  };
}

function runningTask(taskId = "task-1") {
  return {
    taskId,
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workerSession: WORKER,
    workspace: "backend",
    targetAgent: "codex",
    task: "do work",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
    eventSeq: 1,
    events: [],
  } as never;
}

test("retires a complete binding only after verified release", async () => {
  const seed = createEmptyState();
  seed.orchestration.workerBindings[WORKER] = completeBinding();
  const { env, releases, bindings } = makeEnv(seed);

  expect(await retireWorkerBinding(env, WORKER)).toBe("retired");
  expect(releases).toEqual([{ logicalSessionId: "lid-1" }]);
  expect((await bindings())[WORKER]).toBeUndefined();
});

test("retains the binding when release cannot be verified", async () => {
  const seed = createEmptyState();
  seed.orchestration.workerBindings[WORKER] = completeBinding();
  const { env, releases, bindings } = makeEnv(seed, {
    releaseWorkerSession: async () => {
      throw new Error("release refused");
    },
  });

  expect(await retireWorkerBinding(env, WORKER)).toBe("retained");
  expect(releases).toHaveLength(0);
  expect((await bindings())[WORKER]).toMatchObject({ logicalSessionId: "lid-1" });
});

test("deletes an identity-less binding without engine release", async () => {
  const seed = createEmptyState();
  seed.orchestration.workerBindings[WORKER] = {
    sourceHandle: WORKER,
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    ephemeral: true,
  };
  const { env, releases, bindings } = makeEnv(seed);

  expect(await retireWorkerBinding(env, WORKER)).toBe("retired");
  expect(releases).toHaveLength(0);
  expect((await bindings())[WORKER]).toBeUndefined();
});

test("retains when an owner goes active before release", async () => {
  const seed = createEmptyState();
  seed.orchestration.workerBindings[WORKER] = completeBinding();
  const { env, releases, bindings } = makeEnv(seed, {
    onLoad: (state) => {
      // A concurrent delegation starts owning the session while we retire.
      if (!state.orchestration.tasks["task-1"]) {
        state.orchestration.tasks["task-1"] = runningTask();
      }
    },
  });

  expect(await retireWorkerBinding(env, WORKER)).toBe("retained");
  expect(releases).toHaveLength(0);
  expect((await bindings())[WORKER]).toBeDefined();
});

test("retains when the binding generation changes mid-retirement", async () => {
  const seed = createEmptyState();
  seed.orchestration.workerBindings[WORKER] = completeBinding();
  let loads = 0;
  const { env, releases, bindings } = makeEnv(seed, {
    onLoad: (state) => {
      loads += 1;
      // Replace the generation after the snapshot read (first load).
      if (loads === 2) {
        state.orchestration.workerBindings[WORKER] = {
          ...completeBinding(),
          logicalSessionId: "lid-2",
        };
      }
    },
  });

  expect(await retireWorkerBinding(env, WORKER)).toBe("retained");
  // The pre-release generation check fires first: the new generation is
  // untouched and no release targets the snapshotted LID anymore.
  expect(releases).toEqual([]);
  expect((await bindings())[WORKER]).toMatchObject({ logicalSessionId: "lid-2" });
});

test("missing binding reads as retired", async () => {
  const seed = createEmptyState();
  const { env, releases } = makeEnv(seed);

  expect(await retireWorkerBinding(env, WORKER)).toBe("retired");
  expect(releases).toHaveLength(0);
});

test("missing release port retains a complete binding", async () => {
  const seed = createEmptyState();
  seed.orchestration.workerBindings[WORKER] = completeBinding();
  const { env, bindings } = makeEnv(seed, { noReleasePort: true });

  expect(await retireWorkerBinding(env, WORKER)).toBe("retained");
  expect((await bindings())[WORKER]).toBeDefined();
});
