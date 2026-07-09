# Orchestration Service Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 4539-line `src/orchestration/orchestration-service.ts` into nine focused services layered over three shared units, with zero behaviour change, keeping `OrchestrationService` as a delegating facade.

**Architecture:** Bottom-up extraction. A recorded golden-state characterization suite is built first and must stay byte-identical through every later task. Then `OrchestrationStateKernel` (mutex + state-shape ensurers + event/log primitives), then `WorkerSessionManager` (session reservation, parallel-slot accounting, the three `pending*` maps), then `QuestionFlowCore` (coordinator question state + human question packages), then nine leaf services one commit at a time, then the facade slims to pure delegation.

**Tech Stack:** TypeScript (strict), Bun test runner, `node:async_hooks` (`AsyncLocalStorage`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-orchestration-service-split-design.md`

## Global Constraints

- **Zero behaviour change.** The single deliberate exception is the `AsyncLocalStorage` reentrancy guard in Task 8, which converts an unreachable deadlock into an explicit throw.
- **`tests/unit/orchestration/orchestration-service.test.ts` (9888 lines, 185 tests) must not be modified.** It is the regression oracle. If a task needs to change it, the task is wrong — stop and report.
- **Public API and constructor signature unchanged.** `new OrchestrationService(deps)` keeps working. `src/main.ts:632` is the only production construction site. `src/commands/router-types.ts` type-indexes 28 methods as `OrchestrationService["method"]` — the facade must keep every one of them as a real method.
- **All existing `export interface` / `export function` symbols must continue to be exported from `src/orchestration/orchestration-service.ts`** (`RequestDelegateInput`, `OrchestrationServiceDeps`, `clampWatchTimeout`, and ~30 others) so no consumer's `import` statement changes.
- **No new dependencies.** `node:async_hooks` is a Node builtin, not a dependency.
- **Method bodies move verbatim.** Do not reformat, rename locals, or "improve" a body while moving it. Adjust only `this.x(...)` call sites to the injected collaborator (`this.kernel.x(...)` etc.).
- **git hygiene:** only `git add` the files you changed; never `git add -A`; do not touch any lockfile; English conventional commits.
- **Tests:** run per-file with `bun test <path>`. Never run whole-directory `bun test` (state-leak false failures). Typecheck with `npx tsc --noEmit` at repo root (its `include` is `src/**/*.ts`, which covers every file this plan touches).
- **Branch:** `refactor/orchestration-service-split`, already created, spec committed as `fcc5d86`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `tests/unit/orchestration/golden/golden-harness.ts` | Recording deps + single ordered call log; deterministic `now`/`createId` |
| `tests/unit/orchestration/golden/orchestration-golden.test.ts` | Golden scenarios; the equivalence oracle for every later task |
| `src/orchestration/service/orchestration-state-kernel.ts` | `stateMutex` + `mutate` + reentrancy guard, `ensure*` state-shape helpers, `appendTaskEvent`, `bumpGroupUpdated`, `logEvent`, `taskContext`, `groupContext`, `isTerminalStatus`, `isExternalCoordinatorSession`, `assertGroupOwnership`, `normalizeGroupId` |
| `src/orchestration/service/worker-session-manager.ts` | Session resolution/reservation/conflict assertions, parallel-slot accounting, `reconcileParallelSlots`, `reserveLogicalTransportSession`, the three `pending*` maps |
| `src/orchestration/service/question-flow-core.ts` | Coordinator question state, human question packages, delivery/reopen/handoff/wake-error |
| `src/orchestration/service/notice-delivery-service.ts` | Task notices + coordinator injection |
| `src/orchestration/service/task-lifecycle-service.ts` | Worker replies, queries, cleanup, heartbeat, purge |
| `src/orchestration/service/coordinator-registry-service.ts` | External coordinator registration + route context |
| `src/orchestration/service/human-question-service.ts` | The eight human-question public methods |
| `src/orchestration/service/task-cancellation-service.ts` | The four cancellation methods + `startWorkerCancellation` |
| `src/orchestration/service/group-service.ts` | Group CRUD + `cancelGroup` |
| `src/orchestration/service/task-approval-service.ts` | `approveTask` |
| `src/orchestration/service/rpc-delegation-service.ts` | `requestDelegateFromRpc` + auto-run startup/cleanup |
| `src/orchestration/service/human-delegation-service.ts` | `requestDelegate` dispatcher + human `/delegate` path |

**Modified:**

- `src/orchestration/orchestration-service.ts` — shrinks from 4539 lines to a ~150-line facade that keeps all type exports and delegates all 46 public methods.

**Untouched:** `src/main.ts`, `src/commands/router-types.ts`, `src/control/control-service.ts`, `src/scheduled/scheduled-service.ts`, `src/orchestration/orchestration-server.ts`, `src/orchestration/orchestration-client.ts`, `src/orchestration/orchestration-ipc.ts`, and the 9888-line test file.

---

## Method Assignment (authoritative)

Every one of the 111 method bodies has exactly one destination. Two are deleted. This list is the contract; do not improvise.

**`OrchestrationStateKernel` (15):** `mutate`, `ensureGroups`, `ensureExternalCoordinators`, `ensureHumanQuestionPackages`, `ensureCoordinatorQuestionState`, `ensureCoordinatorRoutes`, `appendTaskEvent`, `bumpGroupUpdated`, `logEvent`, `taskContext`, `groupContext`, `isTerminalStatus`, `isExternalCoordinatorSession`, `assertGroupOwnership`, `normalizeGroupId`

**`WorkerSessionManager` (14):** `resolveWorkerSession`, `reserveProposedWorkerSession`, `ensureReservedWorkerSession`, `assertWorkerSessionAvailable`, `assertWorkerSessionDoesNotConflictExternalCoordinator`, `hasActiveTaskWorkerSession`, `countActiveParallelSlots`, `canStartParallelTask`, `reconcileParallelSlots`, `reserveLogicalTransportSession`, `normalizeRole`, `cwdWorkerSessionPart`, `workspaceLabelFromCwd`, `normalizeWorkingDirectory`

**`QuestionFlowCore` (19):** `handoffQueuedQuestions`, `reopenActiveHumanPackageForTask`, `buildReplacementOpenQuestion`, `recordOpenQuestionWakeError`, `detachTaskFromQuestionFlows`, `deliverHumanQuestionPackageMessage`, `recordPackageMessageDeliverySuccess`, `recordPackageMessageDeliveryError`, `snapshotCoordinatorDeliveryRoute`, `normalizeFrozenDeliveryRoute`, `serializeFrozenDeliveryRoute`, `resolveFrozenPackageMessageRoute`, `restoreBlockedQuestionAfterResumeFailure`, `captureTaskHumanPackageContext`, `resolveTaskFromHumanPackage`, `resolveLiveMessageTaskQuestions`, `assertCoordinatorQuestionMatch`, `assertTaskAnswerIsWithinAwaitedHumanSnapshot`, `assertCoordinatorOwnership`

**`NoticeDeliveryService` (16):** `markTaskNoticePending`, `markTaskNoticeDelivered`, `markTaskNoticeFailed`, `listPendingTaskNotices`, `recordTaskNoticeDelivery`, `listPendingCoordinatorResults`, `listPendingCoordinatorBlockers`, `listContestedCoordinatorResults`, `listPendingCoordinatorGroups`, `markCoordinatorResultsInjected`, `markCoordinatorGroupsInjected`, `markCoordinatorGroupsInjectionFailed`, `markTaskInjectionApplied`, `markTaskInjectionFailed`, `canInjectGroupIntoCoordinator`, `canInjectTaskIntoCoordinator`

**`TaskLifecycleService` (12):** `recordWorkerReply`, `getTask`, `watchTask`, `listTasks`, `cleanTasks`, `recordTaskProgress`, `listHeartbeatTasks`, `listSessionBlockingTasks`, `purgeSessionReferences`, `matchesFilter`, `removeCoordinatorMetadataIfUnused`, `removeEmptyGroupsForCoordinator`

**`CoordinatorRegistryService` (2):** `registerExternalCoordinator`, `recordCoordinatorRouteContext`

**`HumanQuestionService` (8):** `workerRaiseQuestion`, `coordinatorAnswerQuestion`, `coordinatorRetractAnswer`, `coordinatorRequestHumanInput`, `retryHumanQuestionPackageDelivery`, `claimActiveHumanReply`, `getActiveHumanQuestionPackage`, `coordinatorReviewContestedResult`

**`TaskCancellationService` (5):** `cancelTask`, `requestTaskCancellation`, `completeTaskCancellation`, `failTaskCancellation`, `startWorkerCancellation`

**`GroupService` (5):** `createGroup`, `getGroupSummary`, `listGroupSummaries`, `cancelGroup`, `buildGroupSummary`

**`TaskApprovalService` (2):** `approveTask`, `assertNeedsConfirmation`

**`RpcDelegationService` (8):** `requestDelegateFromRpc`, `runAutoRunRpcWorkerTask`, `completeAutoRunStartupCancellation`, `cleanupAutoRunStartupBinding`, `resolveRpcSourceContext`, `resolveRpcTargetLocation`, `assertRpcRequestAllowed`, `validateRpcRequest`

**`HumanDelegationService` (3):** `requestDelegate`, `requestDelegateForHuman`, `validateRequest`

**Deleted (2, unreachable dead code):** `assertProposedWorkerSessionDoesNotConflictExternalCoordinator`, `getLatestDeliveredPackageMessage`

**Module-level symbols that move with `OrchestrationStateKernel`:** the `MAX_TASK_EVENTS_PER_TASK = 200` constant (`orchestration-service.ts:34`), because `appendTaskEvent` reads it.

**Module-level free functions that stay in `orchestration-service.ts`** (they are not class methods): `clampWatchTimeout`, `clampWatchPollInterval`, `buildCoordinatorRouteChatMetadata`, `isTerminalTaskStatus`, `isAttentionRequiredTask`, `isRequestDelegateInput`. Import them into whichever service needs them.

---

## Verifying a verbatim move

Several tasks say "move verbatim". Use this to prove it. It extracts a method body from a git ref and from the working tree, and diffs them ignoring the leading-indent change and the `this.` receiver rewrites you were told to make.

```bash
# usage: ./scripts/extract-method.sh <git-ref-or-'WT'> <file> <methodName>
cat > /tmp/extract-method.py <<'PY'
import re, subprocess, sys
ref, path, name = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read() if ref == "WT" else subprocess.run(
    ["git", "show", f"{ref}:{path}"], capture_output=True, text=True, check=True).stdout
lines = src.split("\n")
start = None
for i, l in enumerate(lines):
    if re.match(rf'^\s*(private |public |protected )?(static )?(async )?{re.escape(name)}\s*[(<]', l):
        start = i
        break
if start is None:
    sys.exit(f"{name} not found in {ref}:{path}")
depth = 0; seen = False; out = []
for l in lines[start:]:
    out.append(l)
    depth += l.count("{") - l.count("}")
    if "{" in l: seen = True
    if seen and depth <= 0: break
print("\n".join(out))
PY
python3 /tmp/extract-method.py <ref> <file> <method>
```

Compare the pre-move and post-move extractions; the only permitted differences are the `this.<helper>` → `this.<collaborator>.<helper>` receiver rewrites and the `private` → `public`/omitted visibility change on helpers that cross a class boundary.

---

### Task 1: Golden characterization harness

**Files:**
- Create: `tests/unit/orchestration/golden/golden-harness.ts`
- Test: exercised by Task 2 (no test of its own — it is test infrastructure)

**Interfaces:**
- Produces: `makeGoldenHarness(overrides?): GoldenHarness` where
  `GoldenHarness = { deps: OrchestrationServiceDeps; getState(): AppState; calls: PortCall[]; snapshot(): GoldenSnapshot }`,
  `PortCall = { port: string; request: unknown }`,
  `GoldenSnapshot = { state: AppState; calls: PortCall[]; taskEvents: Record<string, unknown[]> }`.
  Also produces `expectMatchesFixture(name: string, actual: unknown): void`.
  Tasks 2-6 consume `makeGoldenHarness`, `snapshot`, and `expectMatchesFixture`.

**Why a new harness rather than reusing `makeDeps` from the 9888-line test file:** that file must not be modified, so nothing can be exported from it; and its recorders are *separate arrays per port*, which cannot detect a reordering of calls across ports. The golden oracle needs one interleaved, ordered log.

- [ ] **Step 1: Create the harness**

```ts
// tests/unit/orchestration/golden/golden-harness.ts
// Records everything an OrchestrationService call can observably do: the resulting
// AppState, the ORDERED log of outbound port calls across every dep, and each task's
// event sequence. Line coverage cannot see a reordered side effect; this can.
//
// Deliberately independent of orchestration-service.test.ts: that file is the
// regression oracle and must stay byte-identical, so nothing can be exported from it.
import { createConfig } from "../../commands/command-router-test-support";
import type { OrchestrationServiceDeps } from "../../../../src/orchestration/orchestration-service";
import { createEmptyState, type AppState } from "../../../../src/state/types";
import type { AppConfig } from "../../../../src/config/types";

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
  /** Deterministic id sequence for `deps.createId`; cycles the last entry once exhausted. */
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
    createId: () => ids[Math.min(idCursor++, ids.length - 1)]!,
    loadState: async () => cloneState(state),
    saveState: async (nextState) => {
      state = cloneState(nextState);
      record("saveState", { taskIds: Object.keys(nextState.orchestration.tasks ?? {}).sort() });
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
  };

  const snapshot = (): GoldenSnapshot => {
    const current = cloneState(state);
    const taskEvents: Record<string, unknown[]> = {};
    for (const [taskId, task] of Object.entries(current.orchestration.tasks ?? {})) {
      taskEvents[taskId] = (task as { events?: unknown[] }).events ?? [];
    }
    return { state: current, calls: calls.map((c) => ({ ...c })), taskEvents };
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
```

Add these imports at the top of the harness file:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/orchestration/golden/golden-harness.ts
git commit -m "test(orchestration): golden characterization harness with an ordered port-call log"
```

---

### Task 2: Golden fixtures — delegation, approval, parallel slots

**Files:**
- Create: `tests/unit/orchestration/golden/orchestration-golden.test.ts`

**Interfaces:**
- Consumes: `makeGoldenHarness`, `GoldenSnapshot` from Task 1.
- Produces: the file that Tasks 3-5 append to, and that every task from Task 6 onward must keep green **without regenerating snapshots**.

**Fixture policy:** these use `expectMatchesFixture(name, actual)` from Task 1, which deep-equals `actual` against a committed JSON file under `tests/unit/orchestration/golden/fixtures/<name>.json`. Those files are the oracle.

Deliberately **not** `toMatchSnapshot()`: a single `bun test -u` silently rewrites a `.snap` to whatever the code now does, leaving every test green while the oracle is destroyed. Rewriting a fixture requires setting `GOLDEN_UPDATE=1` explicitly, which shows up in shell history and in review. **Only Tasks 2-6 may set it, and only to create a fixture that does not yet exist.** From Task 7 onward, a red fixture means the refactor changed behaviour — fix the refactor, not the fixture.

- [ ] **Step 1: Write the golden scenarios**

```ts
// tests/unit/orchestration/golden/orchestration-golden.test.ts
// The equivalence oracle for the orchestration-service split. Each test drives one
// public entry point and snapshots (a) the resulting AppState, (b) the ORDERED log of
// outbound port calls, (c) every task's event sequence.
//
// DO NOT set GOLDEN_UPDATE=1 outside Tasks 2-6. A failing fixture after a refactor task
// means the refactor changed observable behaviour.
import { expect, test } from "bun:test";

import { OrchestrationService } from "../../../../src/orchestration/orchestration-service";
import { expectMatchesFixture, makeGoldenHarness } from "./golden-harness";

test("golden: requestDelegate (human path) creates a running task and dispatches", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "write the migration",
  });

  expectMatchesFixture("requestdelegate-human-path-creates-a-running", harness.snapshot());
});

test("golden: requestDelegate (human path) at parallel capacity queues instead of dispatching", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first",
    parallel: true,
  });
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "second",
    parallel: true,
  });

  expectMatchesFixture("requestdelegate-human-path-at-parallel-capacity", harness.snapshot());
});

test("golden: requestDelegateFromRpc creates a task and returns its status", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "run the audit",
  });

  expectMatchesFixture("requestdelegatefromrpc-creates-a-task-and-returns-rpc-result", result);
  expectMatchesFixture("requestdelegatefromrpc-creates-a-task-and-returns-rpc-state", harness.snapshot());
});

test("golden: approveTask starts a needs_confirmation task", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "dangerous thing",
    requireConfirmation: true,
  });
  await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" });

  expectMatchesFixture("approvetask-starts-a-needs-confirmation-task", harness.snapshot());
});

test("golden: reconcileParallelSlots drains a queued task when a slot frees", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "first", parallel: true,
  });
  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "second", parallel: true,
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "ok" });
  await service.reconcileParallelSlots();

  expectMatchesFixture("reconcileparallelslots-drains-a-queued-task-when", harness.snapshot());
});
```

> The exact `requestDelegate` / `requestDelegateFromRpc` / `approveTask` / `recordWorkerReply` argument shapes are defined by `RequestDelegateInput` (`orchestration-service.ts:36`), `RequestDelegateRpcInput` (`:52`), `ConfirmTaskInput` (`:139`), `RecordWorkerReplyInput` (`:80`). If a field name above does not compile, correct it against those interfaces — do **not** change the assertion style.

- [ ] **Step 2: Run once with `GOLDEN_UPDATE=1` to create the fixtures**

Run: `GOLDEN_UPDATE=1 bun test tests/unit/orchestration/golden/orchestration-golden.test.ts`
Expected: PASS, 5 tests, and five files appear under `tests/unit/orchestration/golden/fixtures/`.

- [ ] **Step 3: Run WITHOUT the env var to prove the fixtures are stable**

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts`
Expected: PASS, 5 tests, no file written (`git status --porcelain tests/unit/orchestration/golden/fixtures/` shows only the five new untracked files, unchanged between runs).

Run it a second time. If any fixture assertion now fails, or a fixture file's mtime changes, `deps.now`/`deps.createId` are not fully deterministic for that scenario — fix the scenario before continuing. Nothing downstream works without a stable oracle.

- [ ] **Step 4: Prove the existing oracle is untouched**

Run: `bun test tests/unit/orchestration/orchestration-service.test.ts`
Expected: PASS, 185 tests.

Run: `git status --porcelain tests/unit/orchestration/orchestration-service.test.ts`
Expected: empty output.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/fixtures/
git commit -m "test(orchestration): golden fixtures for delegation, approval, parallel slots"
```

---

### Task 3: Golden fixtures — cancellation and groups

**Files:**
- Modify: `tests/unit/orchestration/golden/orchestration-golden.test.ts` (append)

**Interfaces:**
- Consumes: `makeGoldenHarness` from Task 1.

- [ ] **Step 1: Append the scenarios**

```ts
test("golden: requestTaskCancellation then completeTaskCancellation", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "cancel me",
  });
  await service.requestTaskCancellation({ coordinatorSession: "backend:main", taskId: "task-1" });
  await service.completeTaskCancellation("task-1");

  expectMatchesFixture("requesttaskcancellation-then-completetaskcancellation", harness.snapshot());
});

test("golden: failTaskCancellation records the error and leaves the task alive", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "cancel me",
  });
  await service.requestTaskCancellation({ coordinatorSession: "backend:main", taskId: "task-1" });
  await service.failTaskCancellation("task-1", "transport exploded");

  expectMatchesFixture("failtaskcancellation-records-the-error-and-leaves", harness.snapshot());
});

test("golden: createGroup then cancelGroup cancels its tasks", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  const service = new OrchestrationService(harness.deps);

  await service.createGroup({ coordinatorSession: "backend:main", groupId: "g1", title: "review" });
  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "in group", groupId: "g1",
  });
  const result = await service.cancelGroup({ coordinatorSession: "backend:main", groupId: "g1" });

  expectMatchesFixture("creategroup-then-cancelgroup-cancels-its-tasks-cancel-group-result", result);
  expectMatchesFixture("creategroup-then-cancelgroup-cancels-its-tasks-cancel-group-state", harness.snapshot());
});

test("golden: listGroupSummaries reflects task status rollup", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.createGroup({ coordinatorSession: "backend:main", groupId: "g1", title: "review" });
  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "in group", groupId: "g1",
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "ok" });

  expectMatchesFixture("listgroupsummaries-reflects-task-status-rollup", service.listGroupSummaries({ coordinatorSession: "backend:main" }));
});
```

> Correct argument shapes against `CancelTaskInput` (`:98`), `CancelGroupResult` (`:262`), `OrchestrationGroupListFilter` (`:318`) if they do not compile.

- [ ] **Step 2: Generate and stabilize**

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts` (twice)
Expected: PASS both times; second run leaves `.snap` unchanged.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/fixtures/
git commit -m "test(orchestration): golden fixtures for cancellation and groups"
```

---

### Task 4: Golden fixtures — question flow

**Files:**
- Modify: `tests/unit/orchestration/golden/orchestration-golden.test.ts` (append)

- [ ] **Step 1: Append the scenarios**

```ts
test("golden: workerRaiseQuestion blocks the task and wakes the coordinator", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "q-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "ask me",
  });
  await service.workerRaiseQuestion({
    workerSession: "backend:claude:task-1",
    question: "which database?",
    whyBlocked: "schema ambiguous",
    whatIsNeeded: "a table name",
  });

  expectMatchesFixture("workerraisequestion-blocks-the-task-and-wakes", harness.snapshot());
});

test("golden: coordinatorAnswerQuestion resumes the worker", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "q-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "ask me",
  });
  await service.workerRaiseQuestion({
    workerSession: "backend:claude:task-1", question: "which database?",
    whyBlocked: "schema ambiguous", whatIsNeeded: "a table name",
  });
  await service.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main", taskId: "task-1", questionId: "q-1", answer: "users",
  });

  expectMatchesFixture("coordinatoranswerquestion-resumes-the-worker", harness.snapshot());
});

test("golden: coordinatorRequestHumanInput builds and delivers a question package", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "q-1", "pkg-1", "msg-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main", chatKey: "wx:room-1",
  });
  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "ask me",
  });
  await service.workerRaiseQuestion({
    workerSession: "backend:claude:task-1", question: "which database?",
    whyBlocked: "schema ambiguous", whatIsNeeded: "a table name",
  });
  await service.coordinatorRequestHumanInput({
    coordinatorSession: "backend:main",
    taskQuestions: [{ taskId: "task-1", questionId: "q-1" }],
    promptText: "need a decision",
  });

  expectMatchesFixture("coordinatorrequesthumaninput-builds-and-delivers-a-question", harness.snapshot());
});

test("golden: coordinatorRetractAnswer marks the result contested", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "q-1", "review-1", "result-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "ask me",
  });
  await service.workerRaiseQuestion({
    workerSession: "backend:claude:task-1", question: "which database?",
    whyBlocked: "schema ambiguous", whatIsNeeded: "a table name",
  });
  await service.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main", taskId: "task-1", questionId: "q-1", answer: "users",
  });
  await service.coordinatorRetractAnswer({
    coordinatorSession: "backend:main", taskId: "task-1", questionId: "q-1",
  });

  expectMatchesFixture("coordinatorretractanswer-marks-the-result-contested", harness.snapshot());
});
```

> Correct argument shapes against `WorkerRaiseQuestionInput` (`:144`), `CoordinatorTaskQuestionRef` (`:152`), and the `coordinatorAnswerQuestion` / `coordinatorRetractAnswer` inline input types if they do not compile. The `workerSession` value must match whatever `resolveWorkerSession` produced in the preceding `requestDelegate` — read it from `harness.getState().orchestration.tasks["task-1"].workerSession` if unsure.

- [ ] **Step 2: Generate and stabilize**

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts` (twice)
Expected: PASS both times; second run leaves `.snap` unchanged.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/fixtures/
git commit -m "test(orchestration): golden fixtures for the human question flow"
```

---

### Task 5: Golden fixtures — lifecycle and notices

**Files:**
- Modify: `tests/unit/orchestration/golden/orchestration-golden.test.ts` (append)

- [ ] **Step 1: Append the scenarios**

```ts
test("golden: recordWorkerReply completes the task and marks a notice pending", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "do it",
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "the answer" });

  expectMatchesFixture("recordworkerreply-completes-the-task-and-marks-state", harness.snapshot());
  expectMatchesFixture("recordworkerreply-completes-the-task-and-marks-pending-notices", service.listPendingTaskNotices());
});

test("golden: notice lifecycle pending -> delivered", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "do it",
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "the answer" });
  await service.markTaskNoticeDelivered({ taskId: "task-1" });

  expectMatchesFixture("notice-lifecycle-pending-delivered", harness.snapshot());
});

test("golden: markCoordinatorGroupsInjectionFailed records the failure", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.createGroup({ coordinatorSession: "backend:main", groupId: "g1", title: "review" });
  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "in group", groupId: "g1",
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "ok" });
  await service.markCoordinatorGroupsInjectionFailed("backend:main", ["g1"], "injection blew up");

  expectMatchesFixture("markcoordinatorgroupsinjectionfailed-records-the-failure", harness.snapshot());
});

test("golden: cleanTasks removes terminal tasks", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "do it",
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "ok" });
  const result = await service.cleanTasks({ coordinatorSession: "backend:main" });

  expectMatchesFixture("cleantasks-removes-terminal-tasks-clean-result", result);
  expectMatchesFixture("cleantasks-removes-terminal-tasks-clean-state", harness.snapshot());
});

test("golden: purgeSessionReferences drops bindings and metadata", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "do it",
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "ok" });
  await service.purgeSessionReferences("backend:main");

  expectMatchesFixture("purgesessionreferences-drops-bindings-and-metadata", harness.snapshot());
});

test("golden: reserveLogicalTransportSession reserves and releases", async () => {
  const harness = makeGoldenHarness();
  const service = new OrchestrationService(harness.deps);

  // Signature: reserveLogicalTransportSession(transportSession: string): Promise<() => Promise<void>>
  // The release function is async — await it.
  const release = await service.reserveLogicalTransportSession("backend:claude:logical-1");
  const blocked = await service
    .reserveLogicalTransportSession("backend:claude:logical-1")
    .then(() => "second reservation succeeded")
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  await release();

  expectMatchesFixture("reservelogicaltransportsession-reserves-and-releases-second-reservation", blocked);
});
```

> Correct argument shapes against `CleanTasksResult` (`:268`), `RecordTaskNoticeDeliveryInput` (`:88`), and the `markCoordinatorGroupsInjectionFailed` signature. `reserveLogicalTransportSession` is one of the four uncovered ranges — the snippet does **not** assume the second call throws; it snapshots whichever branch it takes. This is characterization, not specification.

- [ ] **Step 2: Generate and stabilize**

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts` (twice)
Expected: PASS both times (18 tests total across Tasks 2-5); second run leaves `.snap` unchanged.

- [ ] **Step 3: Confirm the golden suite pins the risky surface**

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts --coverage 2>&1 | grep "orchestration-service.ts"`
Expected: a coverage line is printed. Record the percentage in the commit body; it is informational, not a gate — the 185-test oracle already covers 97%.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/fixtures/
git commit -m "test(orchestration): golden fixtures for lifecycle, notices, reservations"
```

---

### Task 6: Complete the oracle — four coverage holes plus concurrency characterization

**Files:**
- Modify: `tests/unit/orchestration/golden/orchestration-golden.test.ts` (append)
- Create: `tests/unit/orchestration/golden/orchestration-concurrency.test.ts`

**Deliverable:** the oracle is complete. After this task, nothing about the current behaviour is unpinned. Steps 1-3 close the line-coverage gaps; steps 4-6 pin the concurrency behaviour that line coverage cannot see, and that no existing test touches.

**Context:** `bun test tests/unit/orchestration/orchestration-service.test.ts --coverage` reports 96.08% funcs / 97.24% lines with six uncovered ranges. Two of them (`3781-3785`, `3873-3881`) are dead code, deleted in Task 7. The four below are live and unguarded. Add them to the **golden** file, not the 185-test oracle.

| Range | Method |
|---|---|
| 477-480 | `listGroupSummaries` |
| 1327-1342 | `recordWorkerReply` tail + `markTaskNoticePending` |
| 2496-2527 | `markCoordinatorGroupsInjected` tail + `markCoordinatorGroupsInjectionFailed` |
| 3139-3166 | `ensureReservedWorkerSession` + `reserveLogicalTransportSession` |

- [ ] **Step 1: Read each uncovered range and write a scenario that reaches it**

For each range, open `src/orchestration/orchestration-service.ts` at those lines, identify the branch condition that is never taken, and write a golden scenario whose setup satisfies it. Example for `listGroupSummaries:477-480` — read the lines, then:

```ts
test("golden: listGroupSummaries covers the previously-unreached branch at 477-480", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);
  // Construct the state that reaches lines 477-480 (read them first; the branch is
  // most likely an empty-group or filter-miss path).
  await service.createGroup({ coordinatorSession: "backend:main", groupId: "g1", title: "empty" });
  expectMatchesFixture("listgroupsummaries-covers-the-previously-unreached-branch", service.listGroupSummaries({ coordinatorSession: "other:main" }));
});
```

Repeat for the other three ranges. Tasks 2-5 may already have covered some of them incidentally — check first (Step 2) and skip any that are already green.

- [ ] **Step 2: Measure which ranges remain uncovered by the golden suite plus the oracle**

Run:
```bash
bun test tests/unit/orchestration/orchestration-service.test.ts tests/unit/orchestration/golden/orchestration-golden.test.ts --coverage 2>&1 | grep "orchestration-service.ts"
```
Expected: an uncovered-range list. Write scenarios until only `3781-3785` and `3873-3881` (the dead code) remain.

> Running two files in one `bun test` invocation is safe here — they are the only two files, and the state-leak problem is a whole-directory issue. If you see spurious failures, run them separately and merge the coverage judgement by hand.

- [ ] **Step 3: Verify**

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts`
Expected: PASS.

Run: `bun test tests/unit/orchestration/orchestration-service.test.ts`
Expected: PASS, 185 tests, file unmodified.

- [ ] **Step 4: Write the concurrency characterization tests**

Line coverage cannot see a lost mutual exclusion or a split slot counter. Neither can the 185-test oracle: it drives the service sequentially. These tests pin the behaviour that Tasks 8 and 9 are most likely to break.

The technique is a controllable barrier: `deps.loadState` and `deps.saveState` are the only points where a critical section yields, so gating them on a deferred promise turns a race into a deterministic interleaving.

```ts
// tests/unit/orchestration/golden/orchestration-concurrency.test.ts
// Pins the concurrency behaviour of OrchestrationService. The 185-test oracle drives the
// service sequentially, so none of this is covered there — yet Task 8 (mutex extraction)
// and Task 9 (pending-* map relocation) are exactly the changes that can break it.
//
// Technique: deps.loadState / deps.saveState are the only yield points inside a critical
// section. Gating them on a deferred promise makes an interleaving deterministic.
import { expect, test } from "bun:test";

import { OrchestrationService } from "../../../../src/orchestration/orchestration-service";
import { makeGoldenHarness } from "./golden-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("concurrency: the state mutex serializes two overlapping delegations", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  const trace: string[] = [];
  const gate = deferred<void>();
  let firstLoad = true;

  const baseLoad = harness.deps.loadState;
  harness.deps.loadState = async () => {
    trace.push("load");
    if (firstLoad) {
      firstLoad = false;
      await gate.promise;
    }
    return await baseLoad();
  };
  const baseSave = harness.deps.saveState;
  harness.deps.saveState = async (state) => {
    trace.push("save");
    return await baseSave(state);
  };

  const service = new OrchestrationService(harness.deps);
  const a = service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "first",
  });
  const b = service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "second",
  });

  gate.resolve();
  await Promise.all([a, b]);

  // The second delegation must not have loaded state before the first one saved.
  // If the mutex is lost, `load load save save` appears instead.
  expect(trace.join(" ")).not.toContain("load load save");
});

test("concurrency: two parallel delegations cannot both take the last slot", async () => {
  // The parallel gate reads capacity in one mutate and persists `running` in another.
  // pendingParallelStarts exists to close that window. Drive both delegations
  // concurrently and assert exactly one dispatches while the other queues.
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  const service = new OrchestrationService(harness.deps);

  await Promise.all([
    service.requestDelegate({
      sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
      targetAgent: "claude", task: "first", parallel: true,
    }),
    service.requestDelegate({
      sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
      targetAgent: "claude", task: "second", parallel: true,
    }),
  ]);

  const state = harness.getState();
  const statuses = Object.values(state.orchestration.tasks).map((t) => t.status).sort();
  const dispatches = harness.calls.filter((c) => c.port === "dispatchWorkerTask").length;

  // Whatever the real capacity is, dispatch count must equal the number of running tasks.
  expect(dispatches).toBe(statuses.filter((s) => s === "running").length);
  expect(statuses.length).toBe(2);
});

test("concurrency: reconcileParallelSlots racing a delegation never over-dispatches", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2", "task-3"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "first", parallel: true,
  });
  await service.requestDelegate({
    sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
    targetAgent: "claude", task: "second", parallel: true,
  });
  await service.recordWorkerReply({ taskId: "task-1", summary: "done", resultText: "ok" });

  await Promise.all([
    service.reconcileParallelSlots(),
    service.requestDelegate({
      sourceHandle: "wx:user-1", coordinatorSession: "backend:main", workspace: "backend",
      targetAgent: "claude", task: "third", parallel: true,
    }),
  ]);

  const state = harness.getState();
  const running = Object.values(state.orchestration.tasks).filter((t) => t.status === "running");
  const dispatches = harness.calls.filter((c) => c.port === "dispatchWorkerTask").length;

  // Each running task was dispatched exactly once; a lost pendingParallelStarts shows up
  // as more dispatches than running tasks, or as two tasks running at capacity 1.
  expect(dispatches).toBe(
    Object.values(state.orchestration.tasks).filter((t) => t.status !== "queued").length,
  );
  expect(running.length).toBeLessThanOrEqual(
    harness.deps.config.orchestration.maxParallelTasksPerAgent,
  );
});
```

The parallel cap is `config.orchestration.maxParallelTasksPerAgent` (`src/config/types.ts:100`, non-optional; read at `orchestration-service.ts:3610`). For the "last slot" scenarios to be meaningful, pin it to 1 via a config override:

```ts
import { createConfig } from "../../commands/command-router-test-support";

const cappedConfig = {
  ...createConfig(),
  orchestration: { ...createConfig().orchestration, maxParallelTasksPerAgent: 1 },
};
const harness = makeGoldenHarness({ ids: ["task-1", "task-2"], config: cappedConfig });
```

Apply that override to both parallel scenarios. Correct the `recordWorkerReply` input shape against `RecordWorkerReplyInput` (`orchestration-service.ts:80`). **These tests characterize; if the current behaviour surprises you, snapshot the surprise and note it in the commit body — do not "fix" it in this plan.**

- [ ] **Step 5: Run the concurrency suite**

Run: `bun test tests/unit/orchestration/golden/orchestration-concurrency.test.ts`
Expected: PASS, 3 tests.

Run it five times in a row. Any flake means the barrier is not actually deterministic — fix the barrier before continuing, because a flaky oracle is worse than no oracle.

- [ ] **Step 6: Verify the whole oracle**

Run: `bun test tests/unit/orchestration/orchestration-service.test.ts` → PASS, 185 tests, file unmodified.
Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts` → PASS.
Run: `npx tsc --noEmit` → 0 errors.

- [ ] **Step 7: Commit**

```bash
git add tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/fixtures/ tests/unit/orchestration/golden/orchestration-concurrency.test.ts
git commit -m "test(orchestration): close the four live coverage gaps and pin concurrency behaviour"
```

---

### Task 7: Delete the two dead methods

**Files:**
- Modify: `src/orchestration/orchestration-service.ts`

**Evidence:** `assertProposedWorkerSessionDoesNotConflictExternalCoordinator` (5 lines) and `getLatestDeliveredPackageMessage` (12 lines) are unreachable from any public entry point. Each has exactly one textual reference in `src/` — its own declaration — and zero in `tests/`. Both coincide with uncovered coverage ranges. Deleting them cannot change behaviour.

- [ ] **Step 1: Confirm they are still dead before deleting**

```bash
for m in assertProposedWorkerSessionDoesNotConflictExternalCoordinator getLatestDeliveredPackageMessage; do
  echo "$m: src=$(grep -c "\b$m\b" src/orchestration/orchestration-service.ts) tests=$(grep -rc "\b$m\b" tests/ | grep -v ':0' | wc -l)"
done
```
Expected: `src=1 tests=0` for both. If either count differs, **stop** — something now calls them and the spec's evidence is stale.

- [ ] **Step 2: Delete both method declarations**

Remove the two methods entirely from the class body. Do not remove any import they were the last user of unless `npx tsc --noEmit` complains — check, then remove.

- [ ] **Step 3: Verify nothing moved**

Run: `bun test tests/unit/orchestration/orchestration-service.test.ts`
Expected: PASS, 185 tests.

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts`
Expected: PASS, **fixtures unchanged**. Run `git diff --stat tests/unit/orchestration/golden/fixtures/` — expected: empty.

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/orchestration-service.ts
git commit -m "refactor(orchestration): delete two methods unreachable from any public entry point"
```

---

### Task 8: Extract `OrchestrationStateKernel` with a reentrancy guard

**Files:**
- Create: `src/orchestration/service/orchestration-state-kernel.ts`
- Create: `tests/unit/orchestration/service/orchestration-state-kernel.test.ts`
- Modify: `src/orchestration/orchestration-service.ts`

**Interfaces:**
- Produces: `class OrchestrationStateKernel` with constructor `(deps: KernelDeps, stateMutex?: AsyncMutex)` where `KernelDeps = { logger?: AppLogger }`. Public methods: `mutate<T>(critical: () => Promise<T>): Promise<T>`, `ensureGroups`, `ensureExternalCoordinators`, `ensureHumanQuestionPackages`, `ensureCoordinatorQuestionState`, `ensureCoordinatorRoutes`, `appendTaskEvent`, `bumpGroupUpdated`, `logEvent`, `taskContext`, `groupContext`, `isTerminalStatus`, `isExternalCoordinatorSession`, `assertGroupOwnership`, `normalizeGroupId`. Also exports `MAX_TASK_EVENTS_PER_TASK`. Tasks 9-20 consume it.

**The guard.** `AsyncMutex` (`src/orchestration/async-mutex.ts`) is a strict FIFO queue and is **not reentrant**: `run()` inside `run()` awaits a `tail` promise that only resolves after the outer critical section returns — a deadlock. Today all ten public→public call edges sit outside `this.mutate(...)`, so this never fires. Once the class is nine classes, that invariant is a cross-module contract; the guard turns a silent hang into a diagnosable throw.

It **must** be `AsyncLocalStorage`, not a boolean. A boolean is observed as `true` by a *concurrent* (non-nested) caller while it queues in `await previous`, which would reject legitimate traffic. Verified under Bun: nested → throws; concurrent → serializes correctly; the store survives `await` inside the critical section.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestration/service/orchestration-state-kernel.test.ts
import { expect, test } from "bun:test";

import { AsyncMutex } from "../../../../src/orchestration/async-mutex";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";

test("mutate serializes concurrent callers", async () => {
  const kernel = new OrchestrationStateKernel({});
  const order: string[] = [];
  await Promise.all([
    kernel.mutate(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a-end");
    }),
    kernel.mutate(async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("mutate throws on reentry instead of deadlocking", async () => {
  const kernel = new OrchestrationStateKernel({});
  let message = "no throw";
  await kernel.mutate(async () => {
    try {
      await kernel.mutate(async () => "inner");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain("nested mutate()");
});

test("mutate uses the injected mutex instance", async () => {
  const mutex = new AsyncMutex();
  let ran = 0;
  const original = mutex.run.bind(mutex);
  mutex.run = async <T>(critical: () => Promise<T>): Promise<T> => {
    ran += 1;
    return await original(critical);
  };
  const kernel = new OrchestrationStateKernel({}, mutex);
  await kernel.mutate(async () => undefined);
  expect(ran).toBe(1);
});

test("appendTaskEvent bumps eventSeq and caps the ring at MAX_TASK_EVENTS_PER_TASK", async () => {
  const kernel = new OrchestrationStateKernel({});
  const task = { taskId: "t", eventSeq: 0, events: [] } as unknown as Parameters<
    OrchestrationStateKernel["appendTaskEvent"]
  >[0];
  for (let i = 0; i < 205; i += 1) {
    kernel.appendTaskEvent(task, "2026-04-13T10:00:00.000Z", "created", { message: `m${i}` });
  }
  expect(task.eventSeq).toBe(205);
  expect(task.events!.length).toBe(200);
  expect(task.events![0]!.seq).toBe(6);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/orchestration/service/orchestration-state-kernel.test.ts`
Expected: FAIL — `Cannot find module '.../service/orchestration-state-kernel'`.

- [ ] **Step 3: Create the kernel**

```ts
// src/orchestration/service/orchestration-state-kernel.ts
// The bottom layer of the orchestration split: the single state mutex and the state-shape,
// event-append, and logging primitives that every service above needs. Holds no domain
// policy — only the operations that were shared by three or more responsibility clusters
// in the original 4539-line class.
import { AsyncLocalStorage } from "node:async_hooks";

import type { AppLogger } from "../../logging/app-logger";
import type { AppState } from "../../state/types";
import { AsyncMutex } from "../async-mutex";
import { sameCoordinatorSession } from "../coordinator-identity";
import type {
  ExternalCoordinatorRecord,
  OrchestrationCoordinatorQuestionStateRecord,
  OrchestrationCoordinatorRouteContextRecord,
  OrchestrationGroupRecord,
  OrchestrationHumanQuestionPackageRecord,
  OrchestrationTaskEventType,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "../orchestration-types";

export const MAX_TASK_EVENTS_PER_TASK = 200;

export interface KernelDeps {
  logger?: AppLogger;
}

export class OrchestrationStateKernel {
  /** Marks the async context that currently owns the state mutex. A boolean would be
   *  observed as `true` by a concurrent (non-nested) caller queued in `await previous`,
   *  and would reject it; reentrancy is a property of the async context, not of time. */
  private readonly held = new AsyncLocalStorage<true>();
  private readonly stateMutex: AsyncMutex;

  constructor(
    private readonly deps: KernelDeps,
    stateMutex?: AsyncMutex,
  ) {
    this.stateMutex = stateMutex ?? new AsyncMutex();
  }

  /** AsyncMutex is strict-FIFO and non-reentrant: a nested run() awaits a tail promise
   *  that only resolves after the outer critical section returns. Throw instead of hanging. */
  async mutate<T>(critical: () => Promise<T>): Promise<T> {
    if (this.held.getStore()) {
      throw new Error(
        "orchestration: nested mutate() detected — this would deadlock the state mutex. " +
          "Call the collaborator outside the critical section.",
      );
    }
    return await this.stateMutex.run(() => this.held.run(true, critical));
  }
```

Then move the remaining fourteen bodies **verbatim** from `orchestration-service.ts`, changing only `private` → `public` (drop the modifier) and `this.deps.logger` → `this.deps.logger` (unchanged — `KernelDeps` has it). For reference, four of them as they must appear:

```ts
  ensureGroups(state: AppState): Record<string, OrchestrationGroupRecord> {
    if (!("groups" in state.orchestration) || !state.orchestration.groups) {
      (state.orchestration as AppState["orchestration"] & { groups: Record<string, OrchestrationGroupRecord> }).groups =
        {};
    }
    return state.orchestration.groups;
  }

  isTerminalStatus(status: OrchestrationTaskStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  isExternalCoordinatorSession(state: AppState, coordinatorSession: string): boolean {
    return this.ensureExternalCoordinators(state)[coordinatorSession] !== undefined;
  }

  appendTaskEvent(
    task: OrchestrationTaskRecord,
    at: string,
    type: OrchestrationTaskEventType,
    details: {
      status?: OrchestrationTaskStatus;
      summary?: string;
      message?: string;
    } = {},
  ): void {
    const nextSeq = (task.eventSeq ?? 0) + 1;
    task.eventSeq = nextSeq;
    const events = task.events ?? [];
    events.push({
      seq: nextSeq,
      at,
      type,
      ...(details.status ? { status: details.status } : {}),
      ...(details.summary ? { summary: details.summary } : {}),
      ...(details.message ? { message: details.message } : {}),
    });
    task.events = events.slice(-MAX_TASK_EVENTS_PER_TASK);
  }
}
```

The other ten (`ensureExternalCoordinators`, `ensureHumanQuestionPackages`, `ensureCoordinatorQuestionState`, `ensureCoordinatorRoutes`, `bumpGroupUpdated`, `logEvent`, `taskContext`, `groupContext`, `assertGroupOwnership`, `normalizeGroupId`) move verbatim. Use the extractor from "Verifying a verbatim move" to prove each body is unchanged.

- [ ] **Step 4: Wire the kernel into `OrchestrationService` without moving anything else**

In `orchestration-service.ts`: delete the fifteen method bodies and the `MAX_TASK_EVENTS_PER_TASK` constant, add a `private readonly kernel: OrchestrationStateKernel` field constructed as
```ts
this.kernel = new OrchestrationStateKernel({ logger: deps.logger }, deps.stateMutex);
```
and replace every `this.mutate(` → `this.kernel.mutate(`, `this.ensureGroups(` → `this.kernel.ensureGroups(`, and so on for all fifteen. Re-export the constant if anything outside used it (nothing does — it was module-private).

Delete the now-unused `stateMutex` field and the `AsyncMutex` import if `npx tsc --noEmit` reports them unused (root tsconfig sets `noUnusedLocals: false`, so check by hand: `grep -n "stateMutex\|AsyncMutex" src/orchestration/orchestration-service.ts`).

- [ ] **Step 5: Verify no detached async runs inside a critical section**

The guard's store is inherited by any promise created inside `critical`. If a floating promise is started inside a `mutate` and later calls `mutate` itself, it would throw spuriously. Today there is exactly one floating promise in the class — `void this.runAutoRunRpcWorkerTask({...})` at roughly line 957 — and it sits **outside** every critical section. Confirm that is still true:

```bash
python3 - <<'PY'
import re
src = open('src/orchestration/orchestration-service.ts').read()
regions = []
for m in re.finditer(r'this\.kernel\.mutate\(', src):
    p = m.end() - 1; depth = 0
    for k in range(p, len(src)):
        if src[k] == '(': depth += 1
        elif src[k] == ')':
            depth -= 1
            if depth == 0:
                regions.append((p, k)); break
bad = 0
for pat in [r'void this\.', r'setTimeout\(', r'queueMicrotask', r'setImmediate']:
    for m in re.finditer(pat, src):
        if any(a < m.start() < b for a, b in regions):
            print("detached async inside a critical section:", pat, "at offset", m.start()); bad += 1
print("OK" if bad == 0 else f"{bad} violations")
PY
```
Expected: `OK`.

- [ ] **Step 6: Verify**

Run: `bun test tests/unit/orchestration/service/orchestration-state-kernel.test.ts`
Expected: PASS, 4 tests.

Run: `bun test tests/unit/orchestration/orchestration-service.test.ts`
Expected: PASS, 185 tests. This also exercises the `InterleavingMutex` subclass the suite injects via `deps.stateMutex` — the kernel must pass it through untouched.

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts`
Expected: PASS, fixtures unchanged (`git diff --stat tests/unit/orchestration/golden/fixtures/` → empty).

Run: `bun test tests/unit/orchestration/golden/orchestration-concurrency.test.ts`
Expected: PASS, 3 tests. **This is the step that proves the guard did not break mutual exclusion.** If the serialization test fails, `mutate` is no longer routing through the injected mutex.

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration/service/orchestration-state-kernel.ts src/orchestration/orchestration-service.ts tests/unit/orchestration/service/orchestration-state-kernel.test.ts
git commit -m "refactor(orchestration): extract OrchestrationStateKernel with an AsyncLocalStorage reentrancy guard"
```

---

### Task 9: Extract `WorkerSessionManager`

**Files:**
- Create: `src/orchestration/service/worker-session-manager.ts`
- Create: `tests/unit/orchestration/service/worker-session-manager.test.ts`
- Modify: `src/orchestration/orchestration-service.ts`

**Interfaces:**
- Consumes: `OrchestrationStateKernel` (Task 8).
- Produces: `class WorkerSessionManager` with constructor `(deps: WorkerSessionDeps, kernel: OrchestrationStateKernel)` where `WorkerSessionDeps = Pick<OrchestrationServiceDeps, "now" | "createId" | "loadState" | "saveState" | "config" | "ensureWorkerSession" | "dispatchWorkerTask" | "findReusableWorkerSession" | "logger">`. Public methods are the fourteen listed in "Method Assignment". Tasks 15-19 consume it.

**This is the only task that moves instance state.** The three maps — `pendingWorkerSessions`, `pendingLogicalTransportSessions`, `pendingParallelStarts` — become private fields of `WorkerSessionManager`. There must be exactly **one** instance, constructed by the facade and injected everywhere. Two instances would split the parallel-slot accounting and silently over-dispatch tasks; no existing test would go red.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestration/service/worker-session-manager.test.ts
import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { makeGoldenHarness } from "../golden/golden-harness";

test("pendingParallelStarts is per-instance, and the facade injects exactly one manager", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const manager = new WorkerSessionManager(harness.deps, kernel);
  const other = new WorkerSessionManager(harness.deps, kernel);

  const state = await harness.deps.loadState();

  // Occupy a worker-session reservation on `manager` only. If the pending-* maps were
  // static/module-global, `other` would observe it too — and the real bug (a facade that
  // builds two managers) would be invisible. This asserts the fields are instance-scoped.
  // Signature: reserveProposedWorkerSession(workerSession: string, excludingTaskId?: string)
  //            => Promise<() => Promise<void>>   (the release function is async)
  const release = await manager.reserveProposedWorkerSession("backend:claude:w1");
  expect(other.canStartParallelTask(state, "claude")).toBe(
    manager.canStartParallelTask(state, "claude"),
  );
  await release();
});

test("the facade constructs exactly one WorkerSessionManager", async () => {
  // This asserts on source text, which is normally a smell. It is deliberate, and it is
  // the only test in this suite that can catch the bug it targets.
  //
  // The bug: the facade constructs two WorkerSessionManagers and hands different ones to,
  // say, HumanDelegationService and TaskApprovalService. Each then keeps its own
  // pendingParallelStarts counter, so both can pass the capacity gate for the same slot
  // and the process over-dispatches at capacity.
  //
  // Why no behavioural assertion reaches it: pendingParallelStarts only closes the window
  // *between* the gate mutate and the persist mutate. Reproducing a split counter requires
  // two delegations to interleave inside that window, on two different services, with the
  // agent at exactly its cap. Every scheduling detail of that is an implementation choice
  // the test cannot pin without freezing the very code under refactor. The concurrency
  // suite catches a *lost* counter; it cannot reliably catch a *duplicated* one.
  //
  // If you delete this test, delete the invariant it protects — or find a behavioural
  // assertion that fails when the facade builds two managers. Do not silently drop it.
  const source = await Bun.file("src/orchestration/orchestration-service.ts").text();
  const constructions = source.match(/new WorkerSessionManager\(/g) ?? [];
  expect(constructions.length).toBe(1);
});

test("reserveLogicalTransportSession is exclusive until released", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const manager = new WorkerSessionManager(harness.deps, kernel);

  const release = await manager.reserveLogicalTransportSession("backend:claude:logical-1");
  let second: string | undefined;
  try {
    await manager.reserveLogicalTransportSession("backend:claude:logical-1");
  } catch (error) {
    second = error instanceof Error ? error.message : String(error);
  }
  await release();
  const third = await manager.reserveLogicalTransportSession("backend:claude:logical-1");
  await third();

  expect(second).toBeDefined();
});
```

> If `reserveLogicalTransportSession` does not throw on a double reservation, change the second test to assert whatever it actually does. It is one of the four previously-uncovered ranges; characterize, do not specify. Task 6 will already have snapshotted its real behaviour — match that.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/orchestration/service/worker-session-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `worker-session-manager.ts`**

```ts
// src/orchestration/service/worker-session-manager.ts
// Worker-session naming, resolution, reservation and conflict assertions, plus the
// parallel-slot gate. Owns the three pending-* maps: they are the TOCTOU close for the
// window between the capacity-gate mutate and the persist mutate, so they must live in
// exactly one instance. The facade constructs one and injects it everywhere.
import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize } from "node:path";

import type { AppState } from "../../state/types";
import { sanitizeString } from "../../util/sanitize.js";
import { stableCoordinatorSession } from "../coordinator-identity";
import type { EnsureWorkerSessionRequest, OrchestrationServiceDeps } from "../orchestration-service";
import type { OrchestrationTaskRecord } from "../orchestration-types";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";

export type WorkerSessionDeps = Pick<
  OrchestrationServiceDeps,
  | "now"
  | "createId"
  | "loadState"
  | "saveState"
  | "config"
  | "ensureWorkerSession"
  | "dispatchWorkerTask"
  | "findReusableWorkerSession"
  | "logger"
>;

export class WorkerSessionManager {
  private readonly pendingWorkerSessions = new Map<string, number>();
  private readonly pendingLogicalTransportSessions = new Map<string, number>();
  /**
   * Per-agent counter for parallel tasks that have passed the capacity gate
   * but have not yet been persisted as `running` in state (i.e., they are
   * between the gate mutate and the inner persist mutate). This closes the
   * TOCTOU window: a concurrent `reconcileParallelSlots` Phase 3 or a second
   * delegation can see these in-flight starts as occupied slots.
   */
  private readonly pendingParallelStarts = new Map<string, number>();

  constructor(
    private readonly deps: WorkerSessionDeps,
    private readonly kernel: OrchestrationStateKernel,
  ) {}

  // ... the fourteen methods, moved verbatim ...
}
```

`WorkerSessionDeps` is a `Pick` of the real `OrchestrationServiceDeps`, so the port signatures cannot drift. This needs

```ts
import type { OrchestrationServiceDeps } from "../orchestration-service";
```

which is a **type-only** import: `verbatimModuleSyntax` erases it, so the apparent cycle (`orchestration-service` → `worker-session-manager` → `orchestration-service`) never exists at runtime. Every service in Tasks 10-19 does the same. If `npx tsc --noEmit` nonetheless reports a circular-reference error, move `OrchestrationServiceDeps` and the request interfaces it names (`EnsureWorkerSessionRequest` `:230`, `ReusableWorkerLookupRequest` `:241`, `DispatchWorkerTaskRequest` `:251`, `CancelWorkerTaskRequest` `:104`, `ResumeWorkerTaskRequest` `:112`, `WakeCoordinatorRequest` `:122`, `DeliverCoordinatorMessageRequest` `:126`) into `../orchestration-types` in this same commit and re-export them from `orchestration-service.ts` so no consumer's import statement changes.

Move all fourteen methods verbatim, rewriting `this.mutate(` → `this.kernel.mutate(`, `this.appendTaskEvent(` → `this.kernel.appendTaskEvent(`, `this.logEvent(` → `this.kernel.logEvent(`, `this.taskContext(` → `this.kernel.taskContext(`, `this.isTerminalStatus(` → `this.kernel.isTerminalStatus(`, `this.ensureGroups(` → `this.kernel.ensureGroups(`, `this.bumpGroupUpdated(` → `this.kernel.bumpGroupUpdated(`, `this.isExternalCoordinatorSession(` → `this.kernel.isExternalCoordinatorSession(`, `this.ensureExternalCoordinators(` → `this.kernel.ensureExternalCoordinators(`.

`reconcileParallelSlots` calls `this.deps.dispatchWorkerTask` and `this.ensureReservedWorkerSession` — both stay inside this class.

- [ ] **Step 4: Wire it into the facade**

Add `private readonly workerSessions: WorkerSessionManager`, constructed after the kernel:
```ts
this.workerSessions = new WorkerSessionManager(deps, this.kernel);
```
Delete the three `pending*` fields and the fourteen method bodies from `OrchestrationService`. Rewrite every remaining call site to `this.workerSessions.<method>(...)`. The two public ones (`reconcileParallelSlots`, `reserveLogicalTransportSession`) become one-line facade delegations.

- [ ] **Step 5: Verify**

Run: `bun test tests/unit/orchestration/service/worker-session-manager.test.ts`
Expected: PASS.

Run: `bun test tests/unit/orchestration/orchestration-service.test.ts`
Expected: PASS, 185 tests.

Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts`
Expected: PASS, fixtures unchanged. **The parallel-capacity and reconcile scenarios from Task 2 are the ones that catch a split `pendingParallelStarts`.** If they diverge, you constructed two managers.

Run: `bun test tests/unit/orchestration/golden/orchestration-concurrency.test.ts`
Expected: PASS, 3 tests. **This is the single most important verification in the plan.** The two parallel-slot tests are the only things standing between a split `pendingParallelStarts` and a production over-dispatch that no other test would catch.

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/service/worker-session-manager.ts src/orchestration/orchestration-service.ts tests/unit/orchestration/service/worker-session-manager.test.ts
git commit -m "refactor(orchestration): extract WorkerSessionManager and its three pending-* maps"
```

---

### Task 10: Extract `QuestionFlowCore`

**Files:**
- Create: `src/orchestration/service/question-flow-core.ts`
- Create: `tests/unit/orchestration/service/question-flow-core.test.ts`
- Modify: `src/orchestration/orchestration-service.ts`

**Interfaces:**
- Consumes: `OrchestrationStateKernel` (Task 8).
- Produces: `class QuestionFlowCore` with constructor `(deps: QuestionFlowDeps, kernel: OrchestrationStateKernel)` where `QuestionFlowDeps = Pick<OrchestrationServiceDeps, "now" | "createId" | "config" | "wakeCoordinatorSession" | "deliverCoordinatorMessage" | "resumeWorkerTask" | "logger">`. Public methods are the nineteen listed in "Method Assignment". Tasks 13-16 consume it.

**Why this is a layer and not part of `HumanQuestionService`:** the cancellation, group, and lifecycle clusters all reach into it (cancelling a task must detach it from the question flow; discarding a contested result reopens a package). Burying it inside `HumanQuestionService` would make `TaskCancellationService → HumanQuestionService` a backwards dependency.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestration/service/question-flow-core.test.ts
import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { QuestionFlowCore } from "../../../../src/orchestration/service/question-flow-core";
import { makeGoldenHarness } from "../golden/golden-harness";

test("buildReplacementOpenQuestion preserves the prior question text", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({});
  const core = new QuestionFlowCore(harness.deps, kernel);

  const task = {
    taskId: "t1",
    task: "original task text",
    openQuestion: {
      questionId: "q0",
      question: "which db?",
      whyBlocked: "ambiguous",
      whatIsNeeded: "a name",
      askedAt: "2026-04-13T10:00:00.000Z",
      status: "answered" as const,
    },
  } as unknown as Parameters<QuestionFlowCore["buildReplacementOpenQuestion"]>[0];

  const replacement = core.buildReplacementOpenQuestion(task, "q1", "2026-04-13T11:00:00.000Z");
  expect(replacement.questionId).toBe("q1");
  expect(replacement.question).toBe("which db?");
  expect(replacement.status).toBe("open");
});

test("normalizeFrozenDeliveryRoute is idempotent", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({});
  const core = new QuestionFlowCore(harness.deps, kernel);

  const route = { chatKey: "wx:room-1", accountId: "acct-1", replyContextToken: "tok" };
  const once = core.normalizeFrozenDeliveryRoute(route as never);
  const twice = core.normalizeFrozenDeliveryRoute(once as never);
  expect(twice).toEqual(once);
});
```

> Correct the argument shapes against `buildReplacementOpenQuestion` and `normalizeFrozenDeliveryRoute` as they exist in `orchestration-service.ts`. If `buildReplacementOpenQuestion` takes different parameters, mirror them exactly — this test is a smoke test for the extraction, not a redesign.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/orchestration/service/question-flow-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `question-flow-core.ts` and move the nineteen methods verbatim**

Rewrite the shared-helper receivers to `this.kernel.<helper>(...)` exactly as in Task 9. `deliverHumanQuestionPackageMessage` calls `this.deps.deliverCoordinatorMessage`; `recordOpenQuestionWakeError` and `handoffQueuedQuestions` call `this.deps.wakeCoordinatorSession`; `restoreBlockedQuestionAfterResumeFailure` is reached from the resume path. All three ports stay on `QuestionFlowDeps`.

`isQuotaDeferredError` (imported from `../../weixin/messaging/quota-errors`) and `buildCoordinatorRouteChatMetadata` (module-level free function in `orchestration-service.ts:4488`) are used by the delivery methods. Import `isQuotaDeferredError` directly; **move `buildCoordinatorRouteChatMetadata` into `question-flow-core.ts`** as a module-level function in this commit (it has no other caller — verify with `grep -c buildCoordinatorRouteChatMetadata src/orchestration/orchestration-service.ts`, expected `2`: declaration plus one call).

- [ ] **Step 4: Wire it into the facade**

```ts
this.questionFlow = new QuestionFlowCore(deps, this.kernel);
```
Delete the nineteen bodies from `OrchestrationService`; rewrite call sites to `this.questionFlow.<method>(...)`.

- [ ] **Step 5: Verify**

Run: `bun test tests/unit/orchestration/service/question-flow-core.test.ts` → PASS.
Run: `bun test tests/unit/orchestration/orchestration-service.test.ts` → PASS, 185 tests.
Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts` → PASS, fixtures unchanged.
Run: `bun test tests/unit/orchestration/golden/orchestration-concurrency.test.ts` → PASS, 3 tests.
Run: `npx tsc --noEmit` → 0 errors.

The four question-flow golden scenarios from Task 4 are the ones that catch a reordered `wakeCoordinatorSession` / `deliverCoordinatorMessage` call.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/service/question-flow-core.ts src/orchestration/orchestration-service.ts tests/unit/orchestration/service/question-flow-core.test.ts
git commit -m "refactor(orchestration): extract QuestionFlowCore as a shared layer"
```

---

### Tasks 11-19: the nine leaf services

Each of these follows the identical shape. Do them **in the order given** — later ones depend on earlier ones. Task 11 is written out in full below; the other eight mirror it exactly, differing only in the class name, the assigned methods, the `Pick<...>` port set, and the collaborators injected.

#### Worked example — Task 11: `NoticeDeliveryService`

This is the smallest leaf and depends only on the kernel. Copy its shape for Tasks 12-19.

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/unit/orchestration/service/notice-delivery-service.test.ts
import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { NoticeDeliveryService } from "../../../../src/orchestration/service/notice-delivery-service";
import { makeGoldenHarness } from "../golden/golden-harness";

test("NoticeDeliveryService constructs without the dispatch ports it never uses", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });

  // The whole point of the split: this service needs four ports, not sixteen.
  const service = new NoticeDeliveryService(
    {
      now: harness.deps.now,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      logger: harness.deps.logger,
    },
    kernel,
  );

  expect(service.listPendingTaskNotices()).toEqual([]);
});

test("markTaskNoticeDelivered clears the pending flag", async () => {
  const harness = makeGoldenHarness({
    initialState: (() => {
      const state = makeGoldenHarness().getState();
      state.orchestration.tasks["task-1"] = {
        taskId: "task-1",
        sourceHandle: "wx:user-1",
        sourceKind: "human",
        coordinatorSession: "backend:main",
        workspace: "backend",
        targetAgent: "claude",
        task: "done thing",
        status: "completed",
        summary: "ok",
        resultText: "result",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
        noticePending: true,
      } as never;
      return state;
    })(),
  });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const service = new NoticeDeliveryService(harness.deps, kernel);

  await service.markTaskNoticeDelivered({ taskId: "task-1" });

  expect(harness.getState().orchestration.tasks["task-1"]!.noticePending).toBeFalsy();
});
```

> Correct the task-record field names (`noticePending` and friends) against `OrchestrationTaskRecord` in `src/orchestration/orchestration-types.ts`, and `markTaskNoticeDelivered`'s input against `RecordTaskNoticeDeliveryInput` (`orchestration-service.ts:88`).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/orchestration/service/notice-delivery-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the service**

```ts
// src/orchestration/service/notice-delivery-service.ts
// Task notices and coordinator injection bookkeeping. Pure state transitions over
// AppState — it calls no outbound port except the logger, which is why its Pick<> is
// four members wide rather than sixteen.
import type { OrchestrationServiceDeps } from "../orchestration-service";
import type { OrchestrationTaskRecord } from "../orchestration-types";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";

export type NoticeDeliveryDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "loadState" | "saveState" | "logger"
>;

export class NoticeDeliveryService {
  constructor(
    private readonly deps: NoticeDeliveryDeps,
    private readonly kernel: OrchestrationStateKernel,
  ) {}

  // The sixteen assigned methods, moved verbatim from OrchestrationService:
  //   markTaskNoticePending, markTaskNoticeDelivered, markTaskNoticeFailed,
  //   listPendingTaskNotices, recordTaskNoticeDelivery, listPendingCoordinatorResults,
  //   listPendingCoordinatorBlockers, listContestedCoordinatorResults,
  //   listPendingCoordinatorGroups, markCoordinatorResultsInjected,
  //   markCoordinatorGroupsInjected, markCoordinatorGroupsInjectionFailed,
  //   markTaskInjectionApplied, markTaskInjectionFailed,
  //   canInjectGroupIntoCoordinator, canInjectTaskIntoCoordinator
  //
  // Receiver rewrites, and nothing else:
  //   this.mutate(              -> this.kernel.mutate(
  //   this.appendTaskEvent(     -> this.kernel.appendTaskEvent(
  //   this.logEvent(            -> this.kernel.logEvent(
  //   this.taskContext(         -> this.kernel.taskContext(
  //   this.groupContext(        -> this.kernel.groupContext(
  //   this.isTerminalStatus(    -> this.kernel.isTerminalStatus(
  //   this.ensureGroups(        -> this.kernel.ensureGroups(
  //   this.bumpGroupUpdated(    -> this.kernel.bumpGroupUpdated(
  //
  // `recordTaskNoticeDelivery` calls `this.markTaskNoticeDelivered` — both live here,
  // so that call is unchanged. `markCoordinatorResultsInjected` calls
  // `this.markTaskInjectionApplied` — likewise.
}
```

Prove each body is unchanged with the extractor from "Verifying a verbatim move".

- [ ] **Step 4: Delete the sixteen bodies from `OrchestrationService` and delegate**

```ts
  private readonly notices: NoticeDeliveryService;
  // in the constructor, after this.kernel:
  this.notices = new NoticeDeliveryService(deps, this.kernel);

  // and each public method becomes:
  async markTaskNoticeDelivered(input: RecordTaskNoticeDeliveryInput): Promise<OrchestrationTaskRecord> {
    return await this.notices.markTaskNoticeDelivered(input);
  }
```

The two private helpers (`canInjectGroupIntoCoordinator`, `canInjectTaskIntoCoordinator`) get no facade method — they were never public.

- [ ] **Step 5: Verify**

Run: `bun test tests/unit/orchestration/service/notice-delivery-service.test.ts` → PASS.
Run: `bun test tests/unit/orchestration/orchestration-service.test.ts` → PASS, 185 tests.
Run: `bun test tests/unit/orchestration/golden/orchestration-golden.test.ts` → PASS, fixtures unchanged.
Run: `bun test tests/unit/orchestration/golden/orchestration-concurrency.test.ts` → PASS, 3 tests.
Run: `npx tsc --noEmit` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/service/notice-delivery-service.ts src/orchestration/orchestration-service.ts tests/unit/orchestration/service/notice-delivery-service.test.ts
git commit -m "refactor(orchestration): extract NoticeDeliveryService"
```

#### Tasks 12-19: the same shape

**The shared recipe for every remaining leaf service task:**

- [ ] **Step 1: Create `src/orchestration/service/<name>.ts`** with a class whose constructor is `(deps: <Name>Deps, kernel: OrchestrationStateKernel, ...collaborators)`. `<Name>Deps` is a `Pick<OrchestrationServiceDeps, ...>` of only the ports the service actually calls — grep the moved bodies for `this.deps.` to determine the exact set. Move the assigned method bodies verbatim; rewrite `this.<sharedHelper>(` to `this.kernel.<sharedHelper>(`, `this.workerSessions.<m>(`, or `this.questionFlow.<m>(`.
- [ ] **Step 2: Write a smoke test** at `tests/unit/orchestration/service/<name>.test.ts` that constructs the service in isolation (kernel + `makeGoldenHarness().deps` + collaborators) and drives one representative public method, asserting the observable state change. This is the "isolation testability" deliverable — it must construct **without** the ports the service does not use.
- [ ] **Step 3: Delete the bodies from `OrchestrationService`** and replace each public method with a one-line delegation.
- [ ] **Step 4: Verify** — `bun test` the new service test, then `tests/unit/orchestration/orchestration-service.test.ts` (185 tests), then `tests/unit/orchestration/golden/orchestration-golden.test.ts` (fixtures unchanged), then `tests/unit/orchestration/golden/orchestration-concurrency.test.ts`, then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** with `git add src/orchestration/service/<name>.ts src/orchestration/orchestration-service.ts tests/unit/orchestration/service/<name>.test.ts`.

| # | Service | Depends on | Ports it needs (`Pick<OrchestrationServiceDeps, …>`) | Commit message |
|---|---|---|---|---|
| 12 | `TaskLifecycleService` | kernel | `now`, `loadState`, `saveState`, `closeWorkerSession`, `logger` | `refactor(orchestration): extract TaskLifecycleService` |
| 13 | `CoordinatorRegistryService` | kernel, questionFlow | `now`, `loadState`, `saveState`, `config`, `logger` | `refactor(orchestration): extract CoordinatorRegistryService` |
| 14 | `TaskCancellationService` | kernel, workerSessions, questionFlow | `now`, `loadState`, `saveState`, `cancelWorkerTask`, `interruptWorkerTask`, `closeWorkerSession`, `wakeCoordinatorSession`, `logger` | `refactor(orchestration): extract TaskCancellationService` |
| 15 | `HumanQuestionService` | kernel, workerSessions, questionFlow | `now`, `createId`, `loadState`, `saveState`, `resumeWorkerTask`, `wakeCoordinatorSession`, `deliverCoordinatorMessage`, `logger` | `refactor(orchestration): extract HumanQuestionService` |
| 16 | `GroupService` | kernel, cancellation | `now`, `createId`, `loadState`, `saveState`, `logger` | `refactor(orchestration): extract GroupService` |
| 17 | `TaskApprovalService` | kernel, workerSessions | `now`, `loadState`, `saveState`, `dispatchWorkerTask`, `logger` | `refactor(orchestration): extract TaskApprovalService` |
| 18 | `RpcDelegationService` | kernel, workerSessions | `now`, `createId`, `loadState`, `saveState`, `config`, `ensureWorkerSession`, `dispatchWorkerTask`, `cancelWorkerTask`, `closeWorkerSession`, `logger` | `refactor(orchestration): extract RpcDelegationService` |
| 19 | `HumanDelegationService` | kernel, workerSessions, rpcDelegation | `now`, `createId`, `loadState`, `saveState`, `config`, `ensureWorkerSession`, `dispatchWorkerTask`, `logger` | `refactor(orchestration): extract HumanDelegationService` |

**The port lists above are a starting hypothesis, not gospel.** Derive the real set by grepping the moved bodies for `this.deps.<name>`; if a service needs a port not listed, add it and note the discrepancy in the commit body.

**Task-specific notes:**

- **Task 14 (`TaskCancellationService`)** — `requestTaskCancellation` and `completeTaskCancellation` both call `reconcileParallelSlots` on `WorkerSessionManager`, **outside** any critical section. Keep it that way; moving either call inside a `mutate` now throws (Task 8's guard) instead of hanging.
- **Task 16 (`GroupService`)** — `cancelGroup` calls `TaskCancellationService.requestTaskCancellation`. This is the only service→service edge in the design and it is one-way: `TaskCancellationService` must never import `GroupService`. It also calls `getGroupSummary`, which stays inside `GroupService`.
- **Task 19 (`HumanDelegationService`)** — `requestDelegate` is a 9-line overload dispatcher (`orchestration-service.ts:531-539`) that routes to `requestDelegateForHuman` (local) or `RpcDelegationService.requestDelegateFromRpc` via the `isRequestDelegateInput` type guard. Keep the three overload signatures on the facade so `router-types.ts:85`'s `OrchestrationService["requestDelegate"]` still resolves to the overloaded type.
- **Task 18 (`RpcDelegationService`)** — `requestDelegateFromRpc` starts `void this.runAutoRunRpcWorkerTask({...})` as a **detached** promise, outside any critical section. It must stay outside, or Task 8's reentrancy guard will throw when the detached work calls `mutate`. Re-run the Task 8 Step 5 detector after this task.

---

### Task 20: Slim the facade and verify the whole split

**Files:**
- Modify: `src/orchestration/orchestration-service.ts`

**Interfaces:**
- Consumes: all twelve units.
- Produces: `OrchestrationService` — a ~150-line facade. Its 46 public methods each delegate in one line. It re-exports every `export interface` / `export function` it exported before.

- [ ] **Step 1: Confirm the class body holds nothing but delegation**

```bash
python3 - <<'PY'
import re
src = open('src/orchestration/orchestration-service.ts').read()
body = src[src.index('export class OrchestrationService'):]
# Any method whose body is more than 3 lines is not a pure delegation.
for m in re.finditer(r'^  (async )?([a-zA-Z_][\w]*)\s*[(<][^\n]*\{$', body, re.M):
    start = m.end(); depth = 1; lines = 0
    for ch in body[start:]:
        if ch == '\n': lines += 1
        if ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0: break
    if lines > 3:
        print(f"NOT A DELEGATION: {m.group(2)} ({lines} lines)")
PY
```
Expected: no output (the `constructor` is exempt — it wires twelve units; if the script flags it, ignore that one line).

- [ ] **Step 2: Confirm every consumer symbol still exists**

```bash
# All 28 type-indexed methods must still be real methods on the facade.
grep -o 'OrchestrationService\["[a-zA-Z]*"\]' src/commands/router-types.ts | sed 's/.*\["//;s/"\]//' | sort -u | while read -r m; do
  grep -q "^  \(async \)\?$m\s*[(<]" src/orchestration/orchestration-service.ts || echo "MISSING FACADE METHOD: $m"
done
echo "facade method check done"
```
Expected: only `facade method check done`.

- [ ] **Step 3: Confirm the file shrank and the units are all under 900 lines**

```bash
wc -l src/orchestration/orchestration-service.ts src/orchestration/service/*.ts | sort -n
```
Expected: `orchestration-service.ts` around 150 lines; the largest unit (`human-question-service.ts`) under 900; total across all files roughly 4400-4700.

- [ ] **Step 4: Full verification sweep**

```bash
bun test tests/unit/orchestration/orchestration-service.test.ts
bun test tests/unit/orchestration/golden/orchestration-golden.test.ts
bun test tests/unit/orchestration/golden/orchestration-concurrency.test.ts
for f in tests/unit/orchestration/service/*.test.ts; do bun test "$f"; done
bun test tests/unit/orchestration/orchestration-server.test.ts
bun test tests/unit/orchestration/async-mutex.test.ts
npx tsc --noEmit
```
Expected: every suite PASS (185 tests in the oracle), `npx tsc --noEmit` 0 errors.

```bash
git diff --stat main -- tests/unit/orchestration/orchestration-service.test.ts
```
Expected: **empty**. The oracle was never modified.

```bash
git diff --stat 'HEAD@{task-6}' -- tests/unit/orchestration/golden/fixtures/ 2>/dev/null \
  || git log --oneline -- tests/unit/orchestration/golden/fixtures/
```
Expected: no commit touches `fixtures/` after Task 6's. The golden fixtures never changed once the refactor began.

- [ ] **Step 5: Confirm the untouched files really are untouched**

```bash
git diff --stat main -- src/main.ts src/commands/router-types.ts src/control/control-service.ts src/scheduled/scheduled-service.ts src/orchestration/orchestration-server.ts src/orchestration/orchestration-client.ts src/orchestration/orchestration-ipc.ts
```
Expected: **empty**.

- [ ] **Step 6: Run the broader unit suite the way CI does**

Run: `npm test`
Expected: PASS. (`npm test` runs `node ./scripts/run-tests.mjs`, which builds `relay-protocol` first and then runs each unit test file separately.)

- [ ] **Step 7: Commit**

```bash
git add src/orchestration/orchestration-service.ts
git commit -m "refactor(orchestration): slim OrchestrationService to a delegating facade"
```

---

## Final Verification (after all tasks)

- [ ] `npx tsc --noEmit` → 0 errors.
- [ ] `npm test` → PASS.
- [ ] `git diff --stat main -- tests/unit/orchestration/orchestration-service.test.ts` → empty (the 9888-line oracle was never touched).
- [ ] `git diff --stat main -- src/main.ts src/commands/router-types.ts src/control/control-service.ts src/scheduled/scheduled-service.ts` → empty.
- [ ] No file under `tests/unit/orchestration/golden/fixtures/` has changed since Task 6.
- [ ] `wc -l src/orchestration/service/*.ts` → no file over 900 lines.
- [ ] The two dead methods are gone: `grep -rc "assertProposedWorkerSessionDoesNotConflictExternalCoordinator\|getLatestDeliveredPackageMessage" src/` → 0.
- [ ] The reentrancy guard fires: `bun test tests/unit/orchestration/service/orchestration-state-kernel.test.ts` includes the nested-mutate test.
- [ ] No detached async inside a critical section (re-run the Task 8 Step 5 detector against every file in `src/orchestration/service/`).

## Notes for the executor

- **The 9888-line test file is the oracle. If a task tempts you to edit it, the task is wrong.** Stop and report.
- **Never set `GOLDEN_UPDATE=1`.** A red fixture after a refactor task means the refactor changed behaviour.
- **Bodies move verbatim.** The only permitted edits are receiver rewrites (`this.x` → `this.kernel.x`) and visibility changes. Resist every urge to tidy a body while it is in flight — a tidy-up that changes an `events[]` order will pass tests and break production.
- **One `WorkerSessionManager` instance.** Two would split the parallel-slot accounting and no test would go red.
- **Do not bump versions or publish.** This is an internal refactor.
