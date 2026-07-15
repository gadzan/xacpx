# Orchestration Follow-up Hardening (#149 / #150 / #151) Implementation Plan

> ⚠️ **POST-IMPLEMENTATION AMENDMENT (2026-07-14) — DO NOT RE-EXECUTE THIS PLAN.** This work is
> shipped and merged-ready on `fix/orchestration-critsec-hardening`. Two code blocks below were
> **superseded** by a later Codex-review round and would **reintroduce fixed bugs** if transcribed
> as originally written:
> - **Task 1 / Step 3 (kernel `mutate`)** — the original `held` + *synchronous-throw* guard still
>   false-rejects the single-`.then` same-microtask detached chain #149 names. The shipped guard
>   renames `held`→`sectionContext` and, on a suspected re-entry, `await Promise.resolve()` yields
>   once and re-checks before throwing. The block below has been updated to the shipped version.
> - **Task 3 / Step 4b (`cancelGroup`)** — the original apply-all → log → *dispatch-all* (no
>   try/finally) strands an already-committed cancellation when a later task's save fails. The
>   shipped version wraps phase 1 + log in a `try` and fires the collected chains in a `finally`.
>   The block below has been updated to the shipped version.
>
> Authoritative sources: the design spec (`docs/superpowers/specs/2026-07-14-orchestration-followup-hardening-design.md`,
> §149/§150, updated), the current source, and commits `2d19c12` (#149) / `7fa95b5` (#150).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three orchestration follow-up debts deferred from Track 3 — a false-positive reentrancy guard (#149), a hop-lucky cancel-group log ordering (#150), and a delivery-blind active-message fallback (#151).

**Architecture:** Three independent changes in `src/orchestration/service/`. #149 makes the kernel reentrancy guard precise (per-invocation token). #150 defers `cancelGroup`'s detached dispatch past its log to make the order provable. #151 makes the active-message fallback prefer the last *delivered* message. No shared files across the three.

**Tech Stack:** TypeScript, Bun test runner (`TZ=UTC bun test <file>`, per file). Core only — no packages, no protocol, no web.

## Global Constraints

- Public method signatures of `OrchestrationService` and the leaf services are preserved (these are internal refactors + one behaviour fix). New methods may be added.
- The frozen orchestration golden oracle (`tests/unit/orchestration/golden/`) must stay green. A fixture may be re-recorded ONLY for a deliberate, explained order change (never silently) per the policy in `orchestration-golden.test.ts` — behaviour-preserving changes do NOT re-record.
- Behaviour-changing tasks assert the NEW behaviour + regression-guard the surviving contracts, and every new invariant carries a mutation-live test (reverting the fix reddens exactly it).
- Run each touched test file individually under `TZ=UTC` (never a whole-dir bun run — state leak).
- Spec: `docs/superpowers/specs/2026-07-14-orchestration-followup-hardening-design.md`.

---

### Task 1: #149 — precise kernel reentrancy guard (per-invocation token)

**Files:**
- Modify: `src/orchestration/service/orchestration-state-kernel.ts:28-52`
- Test: `tests/unit/orchestration/service/orchestration-state-kernel.test.ts`

**Interfaces:**
- Consumes: `AsyncMutex` (`src/orchestration/async-mutex.ts`), `AsyncLocalStorage` (node).
- Produces: `OrchestrationStateKernel.mutate<T>(critical: () => Promise<T>): Promise<T>` — signature unchanged; the guard now throws only for genuinely re-entrant (would-deadlock) nesting, and a detached chain that outlives its section may call `mutate` without throwing.

- [ ] **Step 1: Write the failing test** — append to `orchestration-state-kernel.test.ts`:

```ts
test("mutate lets a chain that OUTLIVES its critical section call mutate (no false deadlock throw)", async () => {
  // A promise created inside a critical section inherits the ALS store. Firing it detached and
  // letting it call mutate AFTER the section returns is not re-entrant — the mutex is free — so
  // it must run, not throw. The old boolean guard threw here (invisible to every prior test).
  const kernel = new OrchestrationStateKernel({});
  let detached!: Promise<string>;
  await kernel.mutate(async () => {
    // Created inside the section, but deliberately NOT awaited here — it runs after this returns.
    detached = (async () => {
      await Promise.resolve(); // ensure it resumes after the enclosing section has settled
      return await kernel.mutate(async () => "ran-after");
    })();
  });
  expect(await detached).toBe("ran-after");
});

test("mutate still throws on a genuinely nested (awaited) reentry", async () => {
  const kernel = new OrchestrationStateKernel({});
  let message = "no throw";
  await kernel.mutate(async () => {
    try {
      await kernel.mutate(async () => "inner"); // awaited inside → would deadlock → must throw
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain("nested mutate()");
});
```

- [ ] **Step 2: Run to verify the first new test FAILS** (the boolean guard throws):

Run: `TZ=UTC bun test tests/unit/orchestration/service/orchestration-state-kernel.test.ts`
Expected: the "outlives its critical section" test FAILS (throws "nested mutate() …"); the others pass.

- [ ] **Step 3: Replace the guard with a per-invocation token** — in `orchestration-state-kernel.ts`, replace the field declaration and the `mutate` method (lines 28-52 region):

```ts
export class OrchestrationStateKernel {
  /** Token of the enclosing critical section, propagated through the async context. A per-call
   *  token (not a bare `true`) lets `mutate` tell a genuinely re-entrant caller — still inside
   *  the section that is running right now — apart from a chain that merely INHERITED a section's
   *  context but outlives it. A bare boolean also can't distinguish a concurrent queued caller,
   *  which is why this was never a plain field. */
  // ⚠️ Updated to the shipped version (see the amendment at the top). The original plan showed
  // `held` + a synchronous throw, which re-rejects the single-`.then` same-microtask detached
  // chain #149 names. The shipped guard yields one microtask on a suspected re-entry, then
  // re-checks — letting an after-completion detached chain run while still throwing on a genuine
  // awaited-nested deadlock.
  private readonly sectionContext = new AsyncLocalStorage<object>();
  /** Token of the critical section whose `critical()` body is executing at this instant, or
   *  undefined when none. Reset in mutate's `finally`, one microtask after the body returns. */
  private runningToken: object | undefined;
  private readonly stateMutex: AsyncMutex;

  constructor(
    private readonly deps: KernelDeps,
    stateMutex?: AsyncMutex,
  ) {
    this.stateMutex = stateMutex ?? new AsyncMutex();
  }

  async mutate<T>(critical: () => Promise<T>): Promise<T> {
    const enclosing = this.sectionContext.getStore();
    if (enclosing !== undefined && enclosing === this.runningToken) {
      // Suspected re-entry: yield one microtask so a RETURNING section's finally clears
      // runningToken, then re-check. Still the running token ⇒ that section never returned (it is
      // awaiting us) ⇒ real deadlock ⇒ throw. Cleared ⇒ detached-after-completion ⇒ let it run.
      await Promise.resolve();
      if (this.runningToken === enclosing) {
        throw new Error(
          "orchestration: nested mutate() detected — this would deadlock the state mutex. " +
            "Call the collaborator outside the critical section.",
        );
      }
    }
    const token = {};
    return await this.stateMutex.run(async () => {
      const previous = this.runningToken; // always undefined (mutex serialises); restored defensively
      this.runningToken = token;
      try {
        return await this.sectionContext.run(token, critical);
      } finally {
        this.runningToken = previous;
      }
    });
  }
```

> Also add a same-microtask `.then()` re-entry test (the exact #149 shape) alongside the macrotask
> "outlives" test — it throws under the superseded synchronous guard, so it is what makes the fix
> mutation-active. See `tests/unit/orchestration/service/orchestration-state-kernel.test.ts`.

- [ ] **Step 4: Run to verify all kernel tests PASS**

Run: `TZ=UTC bun test tests/unit/orchestration/service/orchestration-state-kernel.test.ts`
Expected: PASS (serialisation, awaited-nested-throws, injected-mutex, appendTaskEvent, and both new tests).

- [ ] **Step 5: Run the full orchestration suite to confirm no regression**

Run: `TZ=UTC bun test tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/orchestration-concurrency.test.ts tests/unit/orchestration/orchestration-service.test.ts`
Expected: PASS (the guard only *narrows* when it throws; no existing code relies on the removed throw).

- [ ] **Step 6: Note the obsolete scratch scan (no git action)** — `.superpowers/sdd/detached-in-critical-section.mjs` is git-ignored scratch and not a CI gate; the token fix makes detached-after-completion `mutate` safe, so the scan is obsolete. Nothing to commit; do not add it. (Optionally delete the local file.)

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: clean.
```bash
git add src/orchestration/service/orchestration-state-kernel.ts tests/unit/orchestration/service/orchestration-state-kernel.test.ts
git commit -m "fix(orchestration): make the kernel reentrancy guard precise (#149)"
```

---

### Task 2: #151 — delivery-aware active-message fallback

**Files:**
- Modify: `src/orchestration/service/human-question-service.ts:592-595`
- Test: `tests/unit/orchestration/service/human-question-service.test.ts`

**Interfaces:**
- Consumes: `OrchestrationHumanQuestionPackageRecord.messages[]` where each message carries `deliveredAt?: string` (`orchestration-types.ts:182`); `deliveredAt !== undefined` ⇒ delivered.
- Produces: `getActiveHumanQuestionPackage` — same return type; the fallback now prefers the last delivered message.

- [ ] **Step 1: Write the failing test** — append to `human-question-service.test.ts` (reuse the `makeService` helper already at the top of the file):

```ts
test("active-message fallback prefers the last DELIVERED message over a later failed one (#151)", async () => {
  // awaitingReplyMessageId is absent. msg-2 (the last message) FAILED delivery (no deliveredAt);
  // msg-1 was delivered. The active message must be msg-1, not the undelivered msg-2.
  const initialState = createEmptyState();
  initialState.orchestration.coordinatorQuestionState["coord-1"] = {
    activePackageId: "pkg-1",
    queuedQuestions: [],
  };
  initialState.orchestration.humanQuestionPackages["pkg-1"] = {
    packageId: "pkg-1",
    coordinatorSession: "coord-1",
    status: "active",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    initialTaskIds: [],
    openTaskIds: [],
    resolvedTaskIds: [],
    messages: [
      { messageId: "msg-1", kind: "initial", promptText: "delivered one", createdAt: "2026-04-13T09:00:00.000Z", deliveredAt: "2026-04-13T09:00:01.000Z" },
      { messageId: "msg-2", kind: "follow_up", promptText: "failed one", createdAt: "2026-04-13T09:30:00.000Z" },
    ],
  };
  const { humanQuestions } = makeService(initialState);
  const active = await humanQuestions.getActiveHumanQuestionPackage("coord-1");
  expect(active?.promptText).toBe("delivered one");
});

test("active-message fallback returns the last message when NOTHING is delivered yet (#151 edge)", async () => {
  const initialState = createEmptyState();
  initialState.orchestration.coordinatorQuestionState["coord-2"] = {
    activePackageId: "pkg-2",
    queuedQuestions: [],
  };
  initialState.orchestration.humanQuestionPackages["pkg-2"] = {
    packageId: "pkg-2",
    coordinatorSession: "coord-2",
    status: "active",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    initialTaskIds: [],
    openTaskIds: [],
    resolvedTaskIds: [],
    messages: [
      { messageId: "m1", kind: "initial", promptText: "pending, not delivered", createdAt: "2026-04-13T09:00:00.000Z" },
    ],
  };
  const { humanQuestions } = makeService(initialState);
  const active = await humanQuestions.getActiveHumanQuestionPackage("coord-2");
  expect(active?.promptText).toBe("pending, not delivered"); // last resort: not hidden
});
```

- [ ] **Step 2: Run to verify the first new test FAILS**

Run: `TZ=UTC bun test tests/unit/orchestration/service/human-question-service.test.ts`
Expected: the "prefers the last DELIVERED" test FAILS (current fallback returns "failed one"); the edge test passes; the existing priority test passes.

- [ ] **Step 3: Apply the fallback change** — in `human-question-service.ts`, replace the `activeMessage` derivation (lines 592-595):

```ts
    const activeMessage =
      (packageRecord.awaitingReplyMessageId
        ? packageRecord.messages.find((message) => message.messageId === packageRecord.awaitingReplyMessageId)
        : undefined)
      // #151: prefer the last DELIVERED message so a failed later message no longer shadows a
      // delivered earlier one. Fall back to the last message only when nothing has delivered yet,
      // so a pending-but-undelivered question is surfaced (not hidden) to the coordinator prompt.
      ?? [...packageRecord.messages].reverse().find((message) => message.deliveredAt !== undefined)
      ?? packageRecord.messages.at(-1);
```

- [ ] **Step 4: Run to verify all human-question tests PASS**

Run: `TZ=UTC bun test tests/unit/orchestration/service/human-question-service.test.ts`
Expected: PASS (priority regression test, both new tests, and the rest).

- [ ] **Step 5: Run the orchestration-service + golden suites (guard against a consumer relying on the old fallback)**

Run: `TZ=UTC bun test tests/unit/orchestration/orchestration-service.test.ts tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/build-coordinator-prompt.test.ts`
Expected: PASS. If any fixture asserting an undelivered-last-message active package reddens, it encoded the bug — update it to the delivered-preferring behaviour and note it in the report (do not silently re-record a golden fixture; escalate if it is a frozen oracle fixture rather than a plain assertion).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: clean.
```bash
git add src/orchestration/service/human-question-service.ts tests/unit/orchestration/service/human-question-service.test.ts
git commit -m "fix(orchestration): active-message fallback prefers the last delivered message (#151)"
```

---

### Task 3: #150 — provable cancelGroup ordering via deferred dispatch

**Files:**
- Modify: `src/orchestration/service/task-cancellation-service.ts:37-143` (extract `applyCancellationRequest`)
- Modify: `src/orchestration/service/group-service.ts:119-177` (cancelGroup: apply-all → log → dispatch-all)
- Test: `tests/unit/orchestration/service/group-service.test.ts`, `tests/unit/orchestration/service/task-cancellation-service.test.ts`
- Verify (do not blindly re-record): `tests/unit/orchestration/golden/orchestration-golden.test.ts`

**Interfaces:**
- Produces (new public on `TaskCancellationService`):
  `applyCancellationRequest(input: CancelTaskInput): Promise<{ task: OrchestrationTaskRecord; shouldPropagate: boolean }>` —
  the awaited, deterministic part of `requestTaskCancellation` (state mutate + `cancel_requested`
  log + queued-question handoff + post-terminal reconcile), WITHOUT firing the detached
  `startWorkerCancellation`. The caller fires `startWorkerCancellation(task)` when `shouldPropagate`.
- Consumes (already public): `TaskCancellationService.startWorkerCancellation(task)`.
- `requestTaskCancellation` keeps its signature and behaviour (now implemented via `applyCancellationRequest`).

> ⚠️ **Superseded ordering assertion.** The original Step 2 test below asserts the `cancelWorkerTask`
> *port* lands after the `group.cancelled` log. That port fires several awaits deep in the detached
> chain, so it stays after the log regardless of when the chain is *started* — the assertion is
> mutation-blind (it does NOT redden when the dispatch loop is moved before the log). The shipped
> test instead observes, at the **first `startWorkerCancellation` call**, whether `group.cancelled`
> is already logged (`=== 1`), which kills that mutation. See
> `tests/unit/orchestration/service/group-service.test.ts`.

- [ ] **Step 1: Record a pre-change oracle baseline (scratch, for comparison)**

Run: `TZ=UTC bun test tests/unit/orchestration/golden/orchestration-golden.test.ts 2>&1 | tail -3`
Expected: PASS. Note the pass count — this is the green baseline the change must preserve (the `creategroup-then-cancelgroup-cancels-its-tasks-*` fixtures included).

- [ ] **Step 2: Write the failing ordering test** — append to `group-service.test.ts`. The mutation-live witness: the detached chain's `cancelWorkerTask` port call must land AFTER the `group.cancelled` log. Under the current code the chain is fired inside the loop, so `cancelWorkerTask` is recorded before `group.cancelled`; the fix defers the fire until after the log. Also add the `GoldenHarness` type to the existing `../golden/golden-harness` import, and a local drain helper (the frozen harness exports no `waitForLogEvent`):

```ts
// Local copy — the frozen golden harness exports nothing (see its header comment).
async function waitForLogEvent(harness: GoldenHarness, eventName: string, afterIndex: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (
      harness.calls.slice(afterIndex).some(
        (c) => c.port.startsWith("logger.") && (c.request as { event?: unknown } | null)?.event === eventName,
      )
    ) return;
    await Bun.sleep(0);
  }
  throw new Error(`waitForLogEvent timed out waiting for "${eventName}"`);
}

test("cancelGroup logs group.cancelled BEFORE dispatching any worker-cancellation chain (#150)", async () => {
  const initialState = createEmptyState();
  initialState.orchestration.groups["g1"] = {
    groupId: "g1",
    coordinatorSession: "backend:coordinator",
    title: "T",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };
  initialState.orchestration.tasks["t-run"] = {
    taskId: "t-run",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "backend:coordinator",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "running",
    summary: "",
    resultText: "",
    groupId: "g1",
    workerSession: "w1-session", // assigned worker → cancellation propagates a detached chain
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const questionFlow = new QuestionFlowCore(harness.deps, kernel);
  const cancellation = new TaskCancellationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      cancelWorkerTask: harness.deps.cancelWorkerTask,
      interruptWorkerTask: harness.deps.interruptWorkerTask,
      wakeCoordinatorSession: harness.deps.wakeCoordinatorSession,
    },
    kernel,
    workerSessions,
    questionFlow,
  );
  const groups = new GroupService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    cancellation,
  );

  const before = harness.calls.length;
  await groups.cancelGroup({ groupId: "g1", coordinatorSession: "backend:coordinator" });
  await waitForLogEvent(harness, "orchestration.task.cancel_completed", before); // drain the detached chain

  const window = harness.calls.slice(before);
  const groupCancelledIdx = window.findIndex(
    (c) => c.port.startsWith("logger.") && (c.request as { event?: unknown } | null)?.event === "orchestration.group.cancelled",
  );
  const dispatchIdx = window.findIndex((c) => c.port === "cancelWorkerTask");
  expect(groupCancelledIdx).toBeGreaterThanOrEqual(0);
  expect(dispatchIdx).toBeGreaterThan(groupCancelledIdx); // dispatch deferred until AFTER the log — provable, not hop-luck
});
```

If the real `OrchestrationGroupRecord` / `OrchestrationTaskRecord` shapes require additional required fields, add them minimally (mirror the `makeTask` literal already in this file, plus `workerSession`); tsc will name any missing field.

- [ ] **Step 3: Run to verify the new test FAILS** under the current hop-lucky code

Run: `TZ=UTC bun test tests/unit/orchestration/service/group-service.test.ts`
Expected: the new ordering test FAILS — under the current in-loop dispatch, `cancelWorkerTask` is recorded before `group.cancelled`. (If it passes by hop-luck, the fix in Step 4 makes it structural regardless.)

- [ ] **Step 4a: Extract `applyCancellationRequest`** — in `task-cancellation-service.ts`, refactor `requestTaskCancellation` (lines 37-143). Keep the `mutate` closure byte-for-byte; move everything after it into a new public method, and drop the detached fire from it:

```ts
  async requestTaskCancellation(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    const { task, shouldPropagate } = await this.applyCancellationRequest(input);
    if (shouldPropagate) {
      // Detached, bare, unawaited on purpose: this fires a chain that opens its own mutate,
      // so it must stay outside every critical section. It is fired LAST (after applyCancellationRequest's
      // awaited tail) so a group caller can log group.cancelled before any chain begins.
      this.startWorkerCancellation(task);
    }
    return task;
  }

  /** The awaited, deterministic half of a cancellation: state transition + cancel_requested log +
   *  queued-question handoff + post-terminal reconcile — WITHOUT firing the detached
   *  startWorkerCancellation chain. `requestTaskCancellation` fires it right after; `cancelGroup`
   *  fires it AFTER its group.cancelled log so the log/save order is provable, not hop-lucky (#150). */
  async applyCancellationRequest(input: CancelTaskInput): Promise<{ task: OrchestrationTaskRecord; shouldPropagate: boolean }> {
    const prepared = await this.kernel.mutate(async () => {
      // ---- unchanged mutate body from the current requestTaskCancellation (lines 39-102) ----
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }
      if (input.sourceHandle === undefined && input.coordinatorSession === undefined) {
        throw new Error(`task "${input.taskId}" cancel request must include sourceHandle or coordinatorSession`);
      }
      if (input.sourceHandle !== undefined && task.sourceHandle !== input.sourceHandle) {
        throw new Error(`task "${input.taskId}" belongs to source "${task.sourceHandle}", not "${input.sourceHandle}"`);
      }
      if (
        input.coordinatorSession !== undefined &&
        !sameCoordinatorSession(task.coordinatorSession, input.coordinatorSession)
      ) {
        throw new Error(`task "${input.taskId}" belongs to coordinator "${task.coordinatorSession}", not "${input.coordinatorSession}"`);
      }
      if (this.kernel.isTerminalStatus(task.status)) {
        return { task: { ...task }, shouldPropagate: false, closedPackageId: undefined as string | undefined };
      }
      const now = this.deps.now().toISOString();
      if (task.status === "running") {
        const shouldPropagate = task.cancelRequestedAt === undefined;
        task.cancelRequestedAt = task.cancelRequestedAt ?? now;
        task.updatedAt = now;
        if (shouldPropagate) {
          this.kernel.appendTaskEvent(task, now, "cancel_requested", { status: task.status, message: "Cancellation requested" });
        }
        this.kernel.bumpGroupUpdated(state, task.groupId, now);
        await this.deps.saveState(state);
        return { task: { ...task }, shouldPropagate, closedPackageId: undefined as string | undefined };
      }
      const closedPackageId = this.questionFlow.detachTaskFromQuestionFlows(state, task, now);
      const wasNeedsConfirmation = task.status === "needs_confirmation";
      task.status = "cancelled";
      if (wasNeedsConfirmation && task.summary.trim().length === 0) {
        task.summary = "rejected";
      }
      task.openQuestion = undefined;
      task.cancelRequestedAt = task.cancelRequestedAt ?? now;
      task.cancelCompletedAt = now;
      task.lastCancelError = undefined;
      task.updatedAt = now;
      this.kernel.appendTaskEvent(task, now, "status_changed", { status: "cancelled", message: "Task cancelled" });
      this.kernel.bumpGroupUpdated(state, task.groupId, now);
      await this.deps.saveState(state);
      return { task: { ...task }, shouldPropagate: false, closedPackageId };
      // ---- end unchanged mutate body ----
    });

    this.kernel.logEvent(
      "orchestration.task.cancel_requested",
      "task cancellation requested",
      this.kernel.taskContext(prepared.task),
    );

    if (prepared.closedPackageId) {
      await this.questionFlow.handoffQueuedQuestions(prepared.task.coordinatorSession, prepared.closedPackageId);
    }

    // I-2: non-running cancel transitions directly to a terminal state without launchWorkerTurn.
    // Fire reconcile so the ephemeral acpx session closes and queued parallel tasks drain.
    if (!prepared.shouldPropagate && this.kernel.isTerminalStatus(prepared.task.status)) {
      try {
        await this.workerSessions.reconcileParallelSlots();
      } catch (error) {
        this.kernel.logEvent("orchestration.parallel.reconcile_failed", "reconcile failed after non-running cancel", {
          taskId: prepared.task.taskId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { task: prepared.task, shouldPropagate: prepared.shouldPropagate };
  }
```

Rationale (must hold): for a task that propagates (running), `closedPackageId` is `undefined` and the task is non-terminal, so the handoff and reconcile branches are skipped — propagation and the awaited tails are mutually exclusive per task, so moving `startWorkerCancellation` to after `applyCancellationRequest` returns is byte-identical for a single task.

- [ ] **Step 4b: Rewrite `cancelGroup`** — in `group-service.ts`, replace the loop body + trailing log so the detached dispatch happens AFTER the log **and is fired in a `finally`** so a partial failure still propagates already-committed cancellations:

```ts
    const cancelledTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];
    const toPropagate: OrchestrationTaskRecord[] = [];

    let refreshed: OrchestrationGroupSummary;
    try {
      // Phase 1 — apply every task's cancellation STATE transition (awaited, deterministic).
      // applyCancellationRequest commits each task's cancelRequestedAt in its own atomic save, so a
      // task processed before a later task's save fails is ALREADY persisted as cancel-requested —
      // and a retry would see shouldPropagate === false for it and never fire its chain. So the
      // finally must propagate the committed requests on THIS attempt.
      for (const task of summary.tasks) {
        if (this.kernel.isTerminalStatus(task.status)) {
          skippedTaskIds.push(task.taskId);
          continue;
        }
        const { task: cancelled, shouldPropagate } = await this.cancellation.applyCancellationRequest({
          taskId: task.taskId,
          coordinatorSession: input.coordinatorSession,
        });
        cancelledTaskIds.push(task.taskId);
        if (shouldPropagate) {
          toPropagate.push(cancelled);
        }
      }

      const summaryAfter = await this.getGroupSummary(input);
      if (!summaryAfter) {
        throw new Error(`group "${input.groupId}" does not exist`);
      }
      refreshed = summaryAfter;

      // group.cancelled is logged with ZERO detached chains yet fired, so every chain's terminal
      // saveState provably follows it — a structural invariant, not a microtask-hop budget (#150).
      this.kernel.logEvent("orchestration.group.cancelled", "group cancelled", {
        ...this.kernel.groupContext(refreshed.group),
        cancelled_count: cancelledTaskIds.length,
        skipped_count: skippedTaskIds.length,
      });
    } finally {
      // Fire the detached chains for every request committed so far. Happy path: after the loop,
      // refresh, and log — order unchanged. Partial failure: still propagates already-committed
      // requests, so none is stranded and the caller's retry only finishes the uncommitted rest.
      for (const task of toPropagate) {
        this.cancellation.startWorkerCancellation(task);
      }
    }

    return {
      summary: refreshed,
      cancelledTaskIds,
      skippedTaskIds,
    };
```

Ensure `OrchestrationTaskRecord` and `OrchestrationGroupSummary` are imported in `group-service.ts` (it already imports both — see the file header). Remove the now-obsolete hop-budget comment block that preceded the old `requestTaskCancellation` call.

> Add a partial-failure regression test (two running tasks with assigned workers; the second's
> save fails; then a retry) asserting **both** workers are cancelled exactly once (count per
> taskId, not a `Set`, so a double-dispatch can't hide). Deleting the `finally` strands t1 and
> reddens it. See `tests/unit/orchestration/service/group-service.test.ts`.

- [ ] **Step 5: Run the new ordering test + the two service tests**

Run: `TZ=UTC bun test tests/unit/orchestration/service/group-service.test.ts tests/unit/orchestration/service/task-cancellation-service.test.ts`
Expected: PASS, including the new ordering test now holding structurally.

- [ ] **Step 6: Run the frozen golden oracle and handle per policy**

Run: `TZ=UTC bun test tests/unit/orchestration/golden/orchestration-golden.test.ts tests/unit/orchestration/golden/orchestration-concurrency.test.ts`
Expected: PASS. The design predicts the `creategroup-then-cancelgroup-cancels-its-tasks-*` fixtures stay green (group.cancelled already preceded the detached saves). **If a fixture reddens:** confirm the diff is exactly the intended ordering change — all per-task `cancel_requested` effects, then `group.cancelled`, then the detached `cancel_completed`/save effects — and that no state VALUE changed. Only then re-record ONLY those two fixtures (`-result.json` + `-state.json`) from the candidate, and record in the task report the precise before/after ordering and why it is the provable-correct order. Do NOT re-record any other fixture. If any state value (not just order) changed, STOP — that is an unintended behaviour change.

- [ ] **Step 7: Full orchestration + typecheck**

Run: `TZ=UTC bun test tests/unit/orchestration/orchestration-service.test.ts` then `npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/service/task-cancellation-service.ts src/orchestration/service/group-service.ts tests/unit/orchestration/service/group-service.test.ts tests/unit/orchestration/service/task-cancellation-service.test.ts
# include re-recorded fixtures ONLY if Step 6 required them
git commit -m "fix(orchestration): make cancelGroup log/save order provable via deferred dispatch (#150)"
```

---

## Post-implementation (controller)

After all three tasks: whole-branch review, then push + open PR `fix/orchestration-critsec-hardening` → `main`, closing #149 / #150 / #151.
