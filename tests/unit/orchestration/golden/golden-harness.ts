// tests/unit/orchestration/golden/golden-harness.ts
// Records everything an OrchestrationService call can observably do: the resulting
// AppState, the ORDERED log of outbound port calls across every dep, and each task's
// event sequence. Line coverage cannot see a reordered side effect; this can.
//
// Deliberately independent of orchestration-service.test.ts: that file is the
// regression oracle and must stay byte-identical, so nothing can be exported from it.
//
// The fixtures under ./fixtures were recorded against bf767b0 — the 4539-line
// pre-refactor OrchestrationService on main — not against the split. That is not a
// claim you have to take on trust; reproduce it:
//
//   git worktree add /tmp/baseline --detach bf767b0
//   ln -s "$PWD/node_modules" /tmp/baseline/node_modules
//   cp tests/unit/orchestration/golden/{golden-harness.ts,orchestration-golden.test.ts} \
//      /tmp/baseline/tests/unit/orchestration/golden/
//   cp tests/unit/orchestration/golden/fixtures/*.json \
//      /tmp/baseline/tests/unit/orchestration/golden/fixtures/
//   (cd /tmp/baseline && bun test tests/unit/orchestration/golden/orchestration-golden.test.ts)
//
// 24 pass, GOLDEN_UPDATE unset. The pre-refactor facade and every refactored unit satisfy
// the same thirty fixtures.
//
// "Satisfy", not "reproduce byte-for-byte". Three different claims get confused here, so
// be precise about which one you are making:
//
//   * The fixture FILES committed in the split PR are byte-identical to the base's. That
//     is a claim about git, and `git diff <base>..HEAD -- fixtures/` proves it.
//   * The snapshots the baseline and the refactor produce are structurally EQUAL. That is
//     what the tests prove — `expectMatchesFixture` compares parsed JSON, deliberately, so
//     that key order is not part of the oracle.
//   * Re-serializing the digest today would NOT give the fixture files' bytes: the digest
//     now emits collections in sorted key order, and the files were written before that.
//     Nothing depends on it, and nothing should.
//
// What is forbidden is silently re-recording against the implementation under test — that
// is how a characterization oracle launders a regression into a new baseline. bf767b0 is
// not the baseline forever, and a deliberate change cannot always be recorded anywhere
// else. The real control is that a fixture diff is reviewed as a specification:
//
//   * A behaviour-preserving change (this split): do NOT re-record. Run the existing
//     fixtures against the change; they must pass untouched.
//   * A deliberate behaviour or schema change (say, an eighth OrchestrationState
//     collection, which bf767b0 does not have): re-recording from the candidate is the
//     only way to obtain the new expectation. Re-record only the fixtures the change is
//     meant to affect, land that diff in its own PR, and review it line by line. A blanket
//     `GOLDEN_UPDATE=1` across the suite accepts every change, including the ones you did
//     not intend — that is the thing to refuse, not the re-recording itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
import { createConfig } from "../../commands/command-router-test-support";
import type { OrchestrationServiceDeps } from "../../../../src/orchestration/orchestration-service";
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

/**
 * Renders `state.orchestration` for the per-save digest, **driven by its runtime keys**.
 *
 * There is deliberately no hand-written list of collections here. An earlier version had
 * one, plus a guard asserting the list matched `OrchestrationState`. That guard could prove
 * "type matches constant" but not "constant matches the digest we actually emit" — the
 * digest was a second hand-written list. A maintainer who added `scheduledBatches`, saw the
 * guard fire, and dutifully updated the constant while forgetting the digest literal would
 * have turned CI green again with the new collection silently unrecorded.
 *
 * Reading the keys off the object closes that. A collection that appears, disappears, or is
 * added to the type all change the digest's key set, so every fixture that records an
 * affected save goes red. (Adding an eighth collection to `createEmptyOrchestrationState`
 * turns 21 of the 24 golden tests red; the other three never reach a save.)
 *
 * Each collection becomes `{ key, value }` entries, sorted by key. `{ key, value }` rather
 * than `{ ...record, key }` on purpose: spreading the record and stamping the map key over
 * it hides any intermediate save where a record's own identity field disagrees with the key
 * it is stored under — `tasks["t1"].taskId === "t2"` would be invisible.
 *
 * Nothing is projected away. Not `events` (`eventSeq` counts appends; it does not describe
 * them), not the six non-task collections, and there is no `?? {}` fallback — that would
 * render a *missing* collection and an *empty* one identically, and JSON distinguishes them.
 * Every one of those three was a real blind spot found by review, in that order.
 *
 * The fourth was the type check. `typeof x === "object"` admits arrays, `Date`s and `Map`s,
 * and `Object.keys` then renders each of them as a keyed collection: `["a"]` and `{"0":"a"}`
 * produce an identical digest, and a `Date` or `Map` produces an empty one without
 * complaint. JSON keeps `[]` and `{}` apart, so the digest must too. Only a plain object
 * survives the guard; anything else stops the run rather than quietly narrowing the oracle.
 *
 * Sorting fixes the order of collection *entries*. It does not canonicalize the property
 * order inside each record, and `expectMatchesFixture` compares parsed JSON rather than raw
 * bytes, so this is not a byte-stability guarantee — it is an entry-order guarantee.
 */
function digestOrchestrationState(orchestration: Record<string, unknown>): Record<string, unknown> {
  const digest: Record<string, unknown> = {};
  for (const collectionName of Object.keys(orchestration).sort()) {
    const collection = orchestration[collectionName];
    if (!isPlainRecord(collection)) {
      throw new Error(
        `golden harness: state.orchestration.${collectionName} is not a keyed record ` +
          `(got ${describeCollection(collection)}) — the digest can only render plain objects`,
      );
    }
    digest[collectionName] = Object.keys(collection)
      .sort()
      .map((key) => ({ key, value: collection[key] }));
  }
  return digest;
}

/** A plain `{}`-shaped object: not null, not an array, not a `Date`/`Map`/class instance. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function describeCollection(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value !== "object") return `a ${typeof value}`;
  return (value as object).constructor?.name ?? "a non-plain object";
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
      // Record the WHOLE orchestration subtree on every save, verbatim: every runtime
      // collection, every record complete, nothing projected away.
      //
      // Everything a narrower digest omits is a place a refactor can hide. A digest of task
      // records alone cannot see a save that moves a package's `awaitingReplyMessageId`, a
      // coordinator route, or a worker binding from one save to the next. A digest that drops
      // each task's `events` cannot see a save that writes an event's `message` or `status`
      // early and corrects it later — `eventSeq` counts appends, it does not describe them. In
      // every such case the final AppState, the final event log, the save count and the ordered
      // port-call log all still match; only a crash between the two saves would recover into a
      // different state.
      //
      // `updatedAt` is no help either: deps.now() is a fixed instant, so every save in one call
      // stamps the same timestamp.
      //
      // The digest is generated from `state.orchestration`'s own keys — see
      // `digestOrchestrationState`. It is never a hand-written list of collections.
      //
      // Everything that can throw runs before the harness commits anything. A save that
      // rejects must leave `state` and `calls` exactly as it found them: a service that
      // catches the rejection and re-reads via `loadState` would otherwise observe a state
      // that was never successfully persisted.
      //
      // Digest `nextState`, not a clone of it. `cloneState` round-trips through JSON, which
      // turns a `Map` into `{}` and a `Date` into a string — digesting the clone would hand
      // the guard a laundered plain object and record a silently empty collection.
      const digest = digestOrchestrationState(
        nextState.orchestration as unknown as Record<string, unknown>,
      );
      record("saveState", digest);
      state = cloneState(nextState);
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
