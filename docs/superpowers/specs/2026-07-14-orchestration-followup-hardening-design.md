# Orchestration Follow-up Hardening (#149 / #150 / #151) — Design Spec

Date: 2026-07-14
Branch: `fix/orchestration-critsec-hardening` (from `origin/main`)
Track: closes the three orchestration follow-up issues consciously deferred out of the
2026-07 architecture audit's Track 3 (core-maintainability refactor). All three are
`src/orchestration/service/` leaf-service debts left when the 4539-line facade was split.

## Context

Three independent debts, one subsystem:

- **#149** — the reentrancy guard on `OrchestrationStateKernel.mutate()` is enforced/audited
  only by an *incomplete lexical scan*; a detached async that outlives its critical section
  throws in prod but is invisible to tests.
- **#150** — `GroupService.cancelGroup`'s `group.cancelled` log is ordered against a detached
  cancellation chain's `saveState` **only by microtask-hop count**, not a provable invariant.
- **#151** — `HumanQuestionService.getActiveHumanQuestionPackage` falls back to the last message
  *regardless of delivery*, so a failed-delivery message can shadow a delivered one.

They share no files beyond the service directory and can be implemented/reviewed as three
independent task-groups in one plan → one PR.

---

## #149 — Reentrancy guard: dissolve the hazard, don't merely detect it

### The hazard (as filed)

`OrchestrationStateKernel.mutate()` is non-reentrant. Today it guards with an
`AsyncLocalStorage<true>` (`orchestration-state-kernel.ts:32,44-52`):

```ts
private readonly held = new AsyncLocalStorage<true>();
async mutate<T>(critical) {
  if (this.held.getStore()) throw new Error("nested mutate() … would deadlock …");
  return await this.stateMutex.run(() => this.held.run(true, critical));
}
```

A promise **created inside** a critical section (via `.then()` or `void f()`) inherits the ALS
store. If it calls `mutate()` **later** — after the enclosing section has already returned — it
throws, even though the mutex is now free and there is **no deadlock**. Every test passes because
no test drives such a chain into `mutate`. The filed issue asks for a checker/call-graph/ESLint
rule to *detect* this construct; the lexical scan
(`.superpowers/sdd/detached-in-critical-section.mjs`, untracked scratch, not wired to CI) can only
see the literal closure body, not helpers it calls.

### Why detection is the wrong fix

The boolean guard is a **false-positive machine**: it rejects a chain purely because that chain
was *born* inside a critical section, not because it is actually re-entering a live one. The
genuine deadlock is narrower — it happens only when the enclosing section is **still the active
critical section** when the nested `mutate` is reached (the classic awaited-nested case, where the
outer awaits the inner and the mutex tail never resolves). A chain that outlives its section and
calls `mutate` afterward simply queues on the mutex and runs — that is exactly how the existing
`startWorkerCancellation` detached chains already work (fired *outside* `mutate`, opening their
own). Detecting the false-positive construct treats the symptom; making the guard precise removes
it.

### Design — per-invocation token + `runningToken`

Replace the boolean store with a per-invocation **token**, and track the token of the critical
section **currently executing** in a plain field:

```ts
private readonly held = new AsyncLocalStorage<object>();
/** Token of the critical section whose `critical()` body is executing right now (undefined
 *  when none). The mutex serialises sections, so at most one token is ever live. */
private runningToken: object | undefined;

async mutate<T>(critical: () => Promise<T>): Promise<T> {
  const enclosing = this.held.getStore();
  // Re-entrant ONLY when this call is made from inside the section that is currently running.
  // A chain that inherited a token but outlives its section (enclosing !== runningToken) is not
  // re-entrant — it queues on the free mutex and runs, no deadlock.
  if (enclosing !== undefined && enclosing === this.runningToken) {
    throw new Error(
      "orchestration: nested mutate() detected — this would deadlock the state mutex. " +
        "Call the collaborator outside the critical section.",
    );
  }
  const token = {};
  return await this.stateMutex.run(async () => {
    const previous = this.runningToken;      // always undefined (mutex serialises); restored defensively
    this.runningToken = token;
    try {
      return await this.held.run(token, critical);
    } finally {
      this.runningToken = previous;
    }
  });
}
```

Correctness across the four cases (preserving the original ALS design intent — see the
kernel's existing comment that a plain boolean would wrongly reject a *concurrent* queued caller):

| Case | `enclosing` | `runningToken` at call | Result | Correct? |
|---|---|---|---|---|
| Separate concurrent caller (queued on mutex) | `undefined` (own context) | live token of the running one | no throw → queues | ✓ (unchanged) |
| Awaited nested `mutate` inside a section | that section's token | same token (still running) | **throw** | ✓ would deadlock |
| Detached chain, calls `mutate` **after** its section returns (the #149 case) | old token | `undefined` (or a different section) | **no throw** → runs | ✓ **fixed** |
| Detached chain awaited by its section (really nested) | that token | same token | throw | ✓ would deadlock |

The check runs *before* queuing on the mutex, so the awaited-nested case still throws instead of
hanging. `runningToken` is read/written only synchronously and the mutex serialises sections, so
there is no torn read.

**Residual (documented, not the filed hazard):** a truly-detached chain that reaches its `mutate`
call *while its enclosing section is still executing* (a long-running outer that spawned but did
not await it) still throws. That construct races the very section that created it and is worth
flagging; the filed hazard is specifically the **"日后调用" / after-completion** chain, which this
fixes.

### Consequence for the lexical scan

With detached-after-completion `mutate` now safe, there is nothing left to detect: a chain that
outlives its section is a supported pattern (identical to `startWorkerCancellation`). The scratch
scan `.superpowers/sdd/detached-in-critical-section.mjs` is removed as obsolete (it is untracked
and not a CI gate, so removal is local cleanup; if git tracks it, delete it in the PR).

---

## #150 — `cancelGroup`: make the log/save order a provable invariant

### The debt

`GroupService.cancelGroup` (`group-service.ts:119-177`) loops over a group's tasks calling
`this.cancellation.requestTaskCancellation(...)` directly (not via the facade), then logs
`orchestration.group.cancelled`. For a **running** task, `requestTaskCancellation`
(`task-cancellation-service.ts:37-143`) mutates state (`saveState` #1, awaited) and then fires a
**detached** `startWorkerCancellation` chain (bare `void (async …)()`, `:262-307`) whose final
`completeTaskCancellation` `saveState` (#2) lands an unknown number of microtask hops later.

The order between that detached `saveState` #2 and `cancelGroup`'s synchronous `group.cancelled`
log is held **only by hop slack** — the code comments (`group-service.ts:137-160`,
`task-cancellation-service.ts:112-121`) explicitly warn that a single extra `await` anywhere flips
the `cancelGroup cancels its tasks` golden fixture, and that `cancelGroup` is the only one of 30
fixtures that can observe it. That is a fragile, unprovable contract.

### Design — defer the detached dispatch past the log

The only thing that races `group.cancelled` is the **detached** chain. Make its firing happen
**after** the log, so the order is structural, not hop-lucky.

Extract the awaited, deterministic part of `requestTaskCancellation` from the detached fire:

- **New private** `applyTaskCancellationRequest(input): Promise<{ task, shouldPropagate, closedPackageId }>`
  — everything `requestTaskCancellation` does today **except** the `startWorkerCancellation(task)`
  call: the `mutate` (state transition + `saveState` #1), the `orchestration.task.cancel_requested`
  log, the `handoffQueuedQuestions` (when `closedPackageId`), and the post-non-running reconcile.
  Returns `shouldPropagate` so the caller can fire the detached chain.
- **`requestTaskCancellation`** (public, unchanged behaviour) = `applyTaskCancellationRequest` then
  `if (shouldPropagate) this.startWorkerCancellation(task)`. For a running task, `closedPackageId`
  is undefined and the task is non-terminal, so today only `startWorkerCancellation` fires — i.e.
  propagation and the handoff/reconcile tails are already mutually exclusive per task, so no
  reordering within a single task.
- **`cancelGroup`**:
  1. Phase 1 — loop, `await applyTaskCancellationRequest(...)` per non-terminal task, collecting
     the tasks whose `shouldPropagate` is true.
  2. Re-read the summary and log `orchestration.group.cancelled` (unchanged fields).
  3. Phase 2 — `for (const task of toPropagate) this.startWorkerCancellation(task)`.

Now `group.cancelled` is logged with **zero** detached chains yet fired, so every chain's
`saveState` #2 provably follows it. The hop-budget comments are replaced with a one-line statement
of the invariant.

### Golden-oracle handling

This is behaviour-preserving in outcomes (same state transitions, same worker cancellations, same
counts) but it **may** shift the recorded log/save *interleaving*. Per the Track-3 protocol:

- Record a pre-change baseline of the affected fixtures in a scratch worktree.
- Because `group.cancelled` already precedes the detached `saveState`s today (per the comments),
  the frozen `cancelGroup cancels its tasks` fixture is **expected to stay byte-identical**; if it
  shifts, the new order is the provable one and the fixture is re-baselined with a written
  justification (never blindly re-recorded).
- The full frozen 185-oracle / 30-fixture suite must stay green.

---

## #151 — `getActiveHumanQuestionPackage`: delivery-aware fallback

### The bug

`human-question-service.ts:592-595`:

```ts
const activeMessage =
  (packageRecord.awaitingReplyMessageId
    ? packageRecord.messages.find((m) => m.messageId === packageRecord.awaitingReplyMessageId)
    : undefined) ?? packageRecord.messages.at(-1);
```

When `awaitingReplyMessageId` is absent, this returns `messages.at(-1)` — the last message,
**delivered or not**. A message record carries `deliveredAt?: string` (`orchestration-types.ts:182`);
a failed delivery leaves it unset. So a failed *later* message shadows a successfully *delivered*
earlier one — the deleted `getLatestDeliveredPackageMessage` had the correct "last **delivered**"
semantics.

### Decision (behaviour) — prefer the last delivered message

```ts
const activeMessage =
  (packageRecord.awaitingReplyMessageId
    ? packageRecord.messages.find((m) => m.messageId === packageRecord.awaitingReplyMessageId)
    : undefined)
  ?? [...packageRecord.messages].reverse().find((m) => m.deliveredAt !== undefined)
  ?? packageRecord.messages.at(-1);
```

Priority: (1) the `awaitingReplyMessageId` target (unchanged); (2) the **last delivered** message;
(3) as a last resort when *nothing* has delivered yet, the last message (current behaviour).

**Why not return `null` when nothing is delivered** (the issue's third option): the method also
feeds `build-coordinator-prompt.ts:121`, which reminds the coordinator of its pending human
question. Returning `null` for a pending-but-undelivered question would *hide* it from the
coordinator and risks breaking consumers that expect a non-null active package while one exists.
The delivery-specific fields (`deliveredChatKey`, `deliveryAccountId`, `deliveredAt`) are already
conditionally spread, so an undelivered last-resort message exposes no stale delivery data. This
fix removes the concrete harm (a delivered message being shadowed) at minimal risk.

---

## Verification

Behaviour-changing where noted, so: assert the new behaviour + regression-guard the surviving
contracts (not byte-identical golden, except #150's frozen oracle which must stay green).

**#149** (`tests/unit/orchestration/service/orchestration-state-kernel.test.ts`):
- Awaited nested `mutate` inside a critical section still throws the deadlock error.
- A separate concurrent caller queued on the mutex still runs (no false throw) — regression guard
  for the original ALS design intent.
- **New behaviour:** a chain created inside a critical section that calls `mutate` *after* that
  section has returned now **succeeds** (previously threw). This is the mutation-live proof: revert
  to the boolean guard and this test reddens.
- Serialisation/atomicity of concurrent mutates is unchanged.

**#150** (`tests/unit/orchestration/service/group-service.test.ts` +
`task-cancellation-service.test.ts` + the frozen orchestration oracle):
- `group.cancelled` is logged before any deferred `startWorkerCancellation` chain's `saveState`
  (assert order directly, no longer hop-dependent).
- `requestTaskCancellation` single-task behaviour unchanged (still fires `startWorkerCancellation`
  for a running task; same logs/saves).
- The frozen 185-oracle / 30-fixture suite stays green; any re-baselined fixture is justified.
- Regression: cancelled/skipped task-id partitioning and per-task state transitions unchanged.

**#151** (`tests/unit/orchestration/service/human-question-service.test.ts`):
- `awaitingReplyMessageId` target still wins (priority regression guard — the #147 test).
- **New behaviour:** with `awaitingReplyMessageId` absent and a later message undelivered but an
  earlier one delivered, the **delivered** message is returned (mutation-live: revert to
  `messages.at(-1)` and this reddens).
- Last-resort: no message delivered yet → last message returned (documents the retained edge).

## Risk & rollout

- **#149** is the core concurrency primitive; the full 351-test orchestration suite exercises it.
  The change only *narrows* when the guard throws (no current code relies on the removed throw), so
  no existing test should change; one new test proves the loosened case.
- **#150** touches the most hop-sensitive code in the suite; the frozen oracle + the new explicit
  ordering assertion are the safety net. Prod robustness is preserved — the detached chains stay
  detached (worker IPC is never awaited by `cancelGroup`).
- **#151** is a two-line fallback change guarded by an existing priority test plus new
  delivery-aware tests.

## Out of scope

- Rewriting `startWorkerCancellation` into a fully awaitable staged API (#150 suggested it as an
  alternative — the defer approach achieves the provable invariant without changing the detached
  prod semantics, so the heavier API is unnecessary).
- A general call-graph/ESLint enforcement of "no detached mutate" (#149 suggested it — dissolving
  the hazard makes enforcement unnecessary; a truly-detached mutate is now a supported pattern).
- Returning `null` from `getActiveHumanQuestionPackage` (#151 third option — rejected above).
