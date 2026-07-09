// tests/unit/orchestration/golden/golden-harness.ts
// Records everything an OrchestrationService call can observably do: the resulting
// AppState, the ORDERED log of outbound port calls across every dep, and each task's
// event sequence. Line coverage cannot see a reordered side effect; this can.
//
// Deliberately independent of orchestration-service.test.ts: that file is the
// regression oracle and must stay byte-identical, so nothing can be exported from it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
import { createConfig } from "../../commands/command-router-test-support";
import type { OrchestrationServiceDeps } from "../../../../src/orchestration/orchestration-service";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import { createEmptyState, type AppState } from "../../../../src/state/types";
import type { AppConfig } from "../../../../src/config/types";
import type { AppLogger } from "../../../../src/logging/app-logger";

export interface PortCall {
  port: string;
  request: unknown;
}

export interface GoldenSnapshot {
  state: AppState;
  calls: PortCall[];
  taskEvents: Record<string, unknown[]>;
}

function cloneState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state)) as AppState;
}

export interface GoldenHarnessOverrides {
  initialState?: AppState;
  config?: AppConfig;
  reusableWorkerSession?: string | null;
  /** Fixed instant for `deps.now`. */
  now?: string;
  /** Deterministic id sequence for `deps.createId`; throws once exhausted. */
  ids?: string[];
}

export interface GoldenHarness {
  deps: OrchestrationServiceDeps;
  getState: () => AppState;
  calls: PortCall[];
  snapshot: () => GoldenSnapshot;
}

export function makeGoldenHarness(overrides: GoldenHarnessOverrides = {}): GoldenHarness {
  let state = cloneState(overrides.initialState ?? createEmptyState());
  const config = overrides.config ?? createConfig();
  const calls: PortCall[] = [];
  const instant = overrides.now ?? "2026-04-13T10:00:00.000Z";
  const ids = overrides.ids ?? ["id-1", "id-2", "id-3", "id-4", "id-5", "id-6", "id-7", "id-8"];
  let idCursor = 0;

  const record = (port: string, request: unknown) => {
    calls.push({ port, request: JSON.parse(JSON.stringify(request ?? null)) as unknown });
  };

  const deps: OrchestrationServiceDeps = {
    now: () => new Date(instant),
    createId: () => {
      const id = ids[idCursor++];
      if (id === undefined) {
        throw new Error(
          `golden harness: createId() exhausted its pool of ${ids.length} ids — ` +
            `pass more via makeGoldenHarness({ ids: [...] })`,
        );
      }
      return id;
    },
    loadState: async () => cloneState(state),
    saveState: async (nextState) => {
      state = cloneState(nextState);
      // Record the full per-task record (minus `events`, whose signal `eventSeq` already
      // carries). A narrower digest cannot distinguish two saves that only touch bookkeeping
      // fields — noticePending, injectionPending, summary, openQuestion — and a refactor that
      // reorders those saves would slip through. `updatedAt` alone is no help: deps.now() is a
      // fixed instant, so every save in one call stamps the same timestamp.
      const tasks = nextState.orchestration.tasks ?? {};
      record("saveState", {
        tasks: Object.keys(tasks)
          .sort()
          .map((id) => {
            const { events: _events, ...rest } = tasks[id] as OrchestrationTaskRecord;
            return { ...rest, taskId: id };
          }),
      });
    },
    config,
    ensureWorkerSession: async (request) => {
      record("ensureWorkerSession", request);
      return request.workerSession;
    },
    dispatchWorkerTask: async (request) => {
      record("dispatchWorkerTask", request);
    },
    cancelWorkerTask: async (request) => {
      record("cancelWorkerTask", request);
    },
    resumeWorkerTask: async (request) => {
      record("resumeWorkerTask", request);
    },
    closeWorkerSession: async (request) => {
      record("closeWorkerSession", request);
    },
    wakeCoordinatorSession: async (request) => {
      record("wakeCoordinatorSession", request);
    },
    deliverCoordinatorMessage: async (request) => {
      record("deliverCoordinatorMessage", request);
    },
    interruptWorkerTask: async (request) => {
      record("interruptWorkerTask", request);
    },
    findReusableWorkerSession: async (request) => {
      record("findReusableWorkerSession", request);
      return overrides.reusableWorkerSession ?? null;
    },
    // Recorded (not omitted) so every `logEvent` call site is part of the oracle: without
    // this, `OrchestrationService.logEvent()` short-circuits on `if (!logger) return;`
    // (orchestration-service.ts:4372-4373) and a refactor could drop, rename, or reorder an
    // observability call without any test noticing.
    logger: (() => {
      const recordLog = (level: "debug" | "info" | "error") =>
        async (event: string, message: string, context?: Record<string, unknown>) => {
          record(`logger.${level}`, { event, message, context: context ?? null });
        };
      const logger: AppLogger = {
        debug: recordLog("debug"),
        info: recordLog("info"),
        error: recordLog("error"),
        cleanup: async () => {},
        flush: async () => {},
      };
      return logger;
    })(),
  };

  const snapshot = (): GoldenSnapshot => {
    const current = cloneState(state);
    const taskEvents: Record<string, unknown[]> = {};
    for (const [taskId, task] of Object.entries(current.orchestration.tasks ?? {})) {
      taskEvents[taskId] = (task as { events?: unknown[] }).events ?? [];
    }
    return { state: current, calls: JSON.parse(JSON.stringify(calls)) as PortCall[], taskEvents };
  };

  return { deps, getState: () => cloneState(state), calls, snapshot };
}

// --- Fixture oracle ---------------------------------------------------------------
// Deliberately not bun's toMatchSnapshot(): `bun test -u` silently rewrites a .snap to
// whatever the code now does, leaving every test green while the oracle is gone. Writing
// a fixture here requires GOLDEN_UPDATE=1, which is visible in shell history and review.

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url).pathname;

/** Deep-equals `actual` against the committed fixture `<name>.json`.
 *  With GOLDEN_UPDATE=1, writes the fixture instead of asserting (Tasks 2-6 only). */
export function expectMatchesFixture(name: string, actual: unknown): void {
  const path = `${FIXTURE_DIR}${name}.json`;
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;

  if (process.env.GOLDEN_UPDATE === "1") {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, serialized);
    return;
  }

  if (!existsSync(path)) {
    throw new Error(
      `golden fixture missing: ${name}.json — run once with GOLDEN_UPDATE=1 to create it`,
    );
  }
  // Compare parsed values, not strings: key order must not be part of the oracle.
  expect(JSON.parse(serialized) as unknown).toEqual(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
}
