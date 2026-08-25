# xacpx Agent Messaging — Peer Interrupt Delivery v0.4 Phased Implementation Plan

Status: Proposed execution plan  
Date: 2026-08-24  
Spec: `xacpx-agent-messaging-peer-interrupt-delivery-v0.4-spec.md`

## 1. Goal

Implement explicit cross-session preemption INTENT without relying on provider-specific steer/message-injection support.

> **Contract boundary (refined 2026-08-25):** Peer Interrupt Delivery is an
> xacpx-managed cancellation-request + true-settlement + priority-next-turn
> primitive. xacpx guarantees lane ordering and no overlap. Whether the
> existing underlying transport actually terminates the active model turn
> early is transport-owned and is not strengthened by this feature. The
> predecessor may terminalize as `cancelled` OR `completed`; xacpx never
> rewrites a natural completion into a cancellation. See the spec's
> "Contract boundary" section for the authoritative wording.

Public behavior:

```ts
agent_send({
  to,
  content,
  mode: "interrupt",
  completion?: "none" | "notify" | "result"
})
```

Busy target behavior:

```text
reserve one interrupt slot
→ request cancellation of the current xacpx-managed turn (exactly once)
→ wait for true settlement (early-cancelled OR naturally completed)
→ run interrupt peer turn before ordinary FIFO
```

Default/auto/queue behavior remains non-cancelling.

## 2. Execution Principles

Implementation Agents must follow these constraints:

1. Do not add a second `delivery` API. Use the existing `mode:"interrupt"`.
2. Do not modify ACP or require acpx/codex-acp provider extensions for this feature.
3. Do not implement Router-level `cancel(); submit();`.
4. TurnQueue owns atomic reserve/cancel/settle/drain semantics.
5. Never start the interrupting turn until the predecessor's `settled` promise has resolved and the old `inFlight` entry is gone.
6. Preserve the existing normal queue.
7. One pending interrupt per target lane.
8. Do not silently downgrade a second explicit interrupt to queue.
9. Do not infer urgency from content.
10. Write hard gates against production seams, not fake "already-settled" helpers.
11. Keep completion contracts on the existing v0.3 state machine.
12. No MessageList/UI positioning work belongs in this feature.

## 3. Recommended Commit Sequence

Use small reviewable commits:

```text
1. test(control): specify peer interrupt lane semantics
2. feat(control): add TurnQueue peer interrupt reservation
3. feat(agent-messaging): route interrupt through managed turn lane
4. feat(agent-messaging): advertise and revalidate control-plane interrupt
5. test(agent-messaging): cover completion + relay interrupt hard gates
6. docs(agent-messaging): document peer interrupt delivery
```

If UI observability is added, keep it in a separate final commit.

---

# Phase 0 — Freeze the Contract and Baseline

## Files

Read:

- `src/orchestration/agent-messaging-types.ts`
- `src/transport/message-injection.ts`
- `src/control/turn-queue.ts`
- `src/control/turn-support.ts`
- `src/control/control-service.ts`
- `src/orchestration/agent-message-router.ts`
- `src/orchestration/agent-endpoint-registry.ts`
- `src/mcp/xacpx-mcp-tools.ts`
- `src/main.ts`
- `docs/superpowers/specs/2026-08-11-agent-messaging-design.md`
- `docs/superpowers/plans/2026-08-18-agent-messaging-realtime-v0.1.md`

## Tasks

- [ ] Confirm current `AgentMessageMode` still includes `"interrupt"`.
- [ ] Confirm current Relay AgentMessage already carries `requestedMode`; avoid wire expansion if possible.
- [ ] Confirm current `AgentCapabilities` / Relay directory DTO already carries `interrupt`.
- [ ] Confirm the managed logical peer path ultimately reaches `ControlService` / `TurnQueue`.
- [ ] Confirm `TurnQueue` still owns the active turn AbortController and true `settled` promise.
- [ ] Confirm `clearSession` and `cancelQueuedItem` already call the v0.3 queued-peer cancellation hook.
- [ ] Record the current full-suite baseline before code changes.
- [ ] Add the v0.4 spec to `docs/superpowers/specs/`.
- [ ] Add this plan to `docs/superpowers/plans/`.

## Stop condition

If managed logical peer delivery bypasses TurnQueue on the current head, stop and update the plan before implementation. Do not bolt an interrupt scheduler onto the Router.

---

# Phase 1 — Write TurnQueue Hard Gates First

Primary test file:

- `tests/unit/control/turn-queue.test.ts`

Potential supporting tests:

- `tests/unit/control/control-service-agent-messaging.test.ts`

Do not implement production behavior until these tests express the intended state machine.

## Gate 1.1 — Busy interrupt waits for true settle

Arrange:

```text
runTurn(old) starts and remains unresolved
```

Act:

```text
submit peer interrupt X
```

Assert immediately:

```text
X accepted as queued/interrupt
old controller aborted exactly once
runTurn(X) count == 0
```

Then resolve old turn.

Assert:

```text
runTurn(X) count == 1
```

## Gate 1.2 — Aborted-but-unsettled predecessor

Arrange:

```text
old controller already aborted
old runTurn still unresolved
```

Act:

```text
interrupt X
```

Assert:

```text
no second abort
X reserved
no X execution before settle
one X execution after settle
```

This gate is mandatory because the project has previously had false-admission bugs in this exact window.

## Gate 1.3 — Interrupt priority

Arrange:

```text
current running
Q1 ordinary queued
Q2 ordinary queued
```

Act:

```text
interrupt I
```

After settlement assert execution:

```text
I → Q1 → Q2
```

## Gate 1.4 — Normal queue full

Fill ordinary FIFO to `QUEUE_MAX_DEPTH`.

With interrupt slot empty:

```text
interrupt I
```

Assert:

```text
accepted
normal queue unchanged
```

## Gate 1.5 — One-slot rule

Reserve I1.

Submit distinct I2 before I1 starts.

Assert:

```text
I2 rejected with queue-full semantic
abort count unchanged
I1 remains reserved
```

## Gate 1.6 — Duplicate retry

Reserve I1 with `promptRequestId=P`.

Retry same P.

Assert:

```text
deduped
one reservation
one abort
one eventual run
```

## Gate 1.7 — Lifecycle removal

Cover both:

```text
cancelQueuedItem(interrupt item)
clearSession/archive
```

Assert pending interrupt is removed and `onQueuedPeerCancelled` fires once for completion-bearing peer origins.

Commit after red tests are reviewed:

```text
test(control): specify peer interrupt lane semantics
```

---

# Phase 2 — Implement TurnQueue Interrupt Reservation

## Primary file

- `src/control/turn-queue.ts`

Potential type support:

- `src/control/turn-support.ts`

## Recommended internal state

Add:

```ts
private readonly pendingInterrupts = new Map<string, QueuedPrompt>();
```

Do not overload the normal FIFO with a magic unshift unless the implementation can still prove:

- one-slot uniqueness,
- duplicate lookup,
- queue-full independence,
- lifecycle cleanup,
- priority handoff.

A dedicated slot is easier to reason about.

## Add a dedicated API

Recommended shape:

```ts
submitPeerInterrupt(
  params: SubmitParams
):
  | { status: "injected" | "queued"; modeUsed: "interrupt" | "prompt" }
  | { status: "rejected"; reason: string };
```

Or generalize `submitPeerTurn` with a clear delivery enum if that produces less duplication.

Do not expose a generic public scheduler priority.

## Busy determination

For interrupt purposes:

```text
draining
OR any registered inFlight entry, even already-aborted
```

means the lane is not idle.

This mirrors the v0.3 peer-admission fix.

## Acceptance algorithm

Pseudo-code:

```ts
const key = resolveKey(...);

if (removing.has(key)) reject target-unavailable;

if (same request already:
      pendingInterrupt
      normal queue
      inFlight
      settled tombstone) {
  return deduplicated accepted result;
}

if (lane truly idle) {
  submit fresh peer turn through existing synchronous admission path;
  return injected/prompt;
}

if (different pendingInterrupt exists) {
  reject queue-full;
}

const item = createQueuedPeerPrompt(params);
pendingInterrupts.set(key, item);
record request-id admission tombstone only AFTER reservation exists;

const existing = inFlight.get(key);
if (existing && !existing.controller.signal.aborted) {
  existing.controller.abort();
  log abort signalled;
}

emit queue state if appropriate;
return queued/interrupt;
```

Important:

- The abort call must be idempotent.
- A pre-aborted predecessor must not be aborted again.
- The ACK is allowed before full unwind because the reservation is already owned by the lane.
- No new model turn is started by this method while the predecessor remains registered.

## Drain algorithm

Modify the post-turn handoff:

```text
if pendingInterrupt:
  drain it first
else if normal queue:
  drain normal head
else:
  idle
```

Preserve the existing `draining` guard.

## Queue visibility

At minimum internal queue snapshots/tests must be deterministic.

Options:

1. Include pending interrupt as the first queue snapshot item.
2. Keep it out of current queue UI but expose it through a future structured field.

For v0.4 core, either is acceptable if cancellation/lifecycle operations can address it correctly. Do not add a large UI protocol change just for queue decoration.

## Lifecycle

Update:

- `cancelQueuedItem`
- `clearSession`
- any queue-drop helper

to search/remove `pendingInterrupts` as well.

Reuse the existing `notifyQueuedPeerCancelled()` logic instead of creating a second completion-cancellation path.

## Tests

Make all Phase 1 tests green.

Add memory-bound/state-cleanup assertions:

- slot removed when it starts;
- slot removed when cancelled;
- slot removed when session cleared;
- no stale empty-map keys;
- request-id dedupe is bounded by the existing policy.

Commit:

```text
feat(control): add peer interrupt reservation to TurnQueue
```

---

# Phase 3 — Wire ControlService and Local Agent Messaging

## Files

- `src/control/control-service.ts`
- `src/orchestration/agent-message-router.ts`
- `src/main.ts`
- closest local delivery implementation, likely under `src/orchestration/`
- tests:
  - `tests/unit/control/control-service-agent-messaging.test.ts`
  - `tests/unit/orchestration/local-agent-message-delivery.test.ts`
  - `tests/unit/orchestration/agent-message-router.test.ts`
  - `tests/unit/orchestration/agent-messaging-local-integration.test.ts`

## Requirement

A logical target with:

```ts
requestedMode === "interrupt"
```

must route to the TurnQueue interrupt API.

It must NOT rely on:

```ts
transport.injectMessage(... mode: "interrupt")
```

for managed logical sessions.

The existing provider-specific `SessionTransport.injectMessage` path remains for steer and any legacy runtime-specific behavior.

## Suggested separation

Local delivery should conceptually become:

```text
logical + interrupt
  -> control-plane peer interrupt

logical + queue/default peer prompt
  -> current peer TurnQueue path

native steer requested
  -> existing transport/live-input path

unsupported external/worker target
  -> typed rejection
```

Avoid provider-name branches.

## Receipt mapping

Busy:

```ts
{
  status: "queued",
  modeUsed: "interrupt",
  targetState: "running"
}
```

Idle:

```ts
{
  status: "injected",
  modeUsed: "prompt",
  targetState: "idle"
}
```

## Router invariants

The Router remains responsible for:

- message ids;
- sender identity;
- history row;
- inbound dedupe;
- completion grant;
- Relay route;
- content/conversation guards.

TurnQueue remains responsible for:

- active lane state;
- cancellation signal;
- true settlement;
- priority ordering.

Do not duplicate lane state in `AgentMessageRouter`.

## Tests

Add local production-path tests proving:

- transport's `injectMessage(mode="interrupt")` is never called for logical interrupt;
- TurnQueue/control interrupt path is called instead;
- default/auto queue path still has abort count zero;
- no history duplicate is introduced.

Commit:

```text
feat(agent-messaging): route logical interrupts through managed turn control
```

---

# Phase 4 — Capability Publication and Fail-Closed Revalidation

## Files

- `src/orchestration/agent-endpoint-registry.ts`
- `src/orchestration/agent-message-router.ts`
- Relay DTO only if current schema unexpectedly lacks the field
- tests:
  - `tests/unit/orchestration/agent-endpoint-registry.test.ts`
  - `tests/unit/orchestration/agent-message-router.test.ts`
  - `tests/unit/packages/relay/gateway/agent-messaging-routing.test.ts`

## Capability policy

For v0.4:

```text
managed logical endpoint:
  interrupt=true when it is controlled by the TurnQueue/SessionTurnRunner lane

worker:
  false unless separately proven

external:
  false
```

Do not derive interrupt capability from `steer`.

Do not derive it from provider name.

## Remote

Relay directory already carries target capabilities; preserve `interrupt`.

Source may use directory capability for early rejection/UX.

Destination MUST re-resolve the endpoint and verify it is interrupt-capable before any abort side effect.

## Stale-capability gate

Arrange:

```text
source snapshot says interrupt=true
destination current target says interrupt=false
```

Assert:

```text
TARGET_NOT_INTERRUPTIBLE
cancel count = 0
no peer turn
completion reservation compensated through the existing definite-rejection path
```

If `TARGET_NOT_INTERRUPTIBLE` is already in all relevant typed error allowlists, do not create a new code.

Commit:

```text
feat(agent-messaging): advertise control-plane peer interrupt capability
```

---

# Phase 5 — Completion and Cancellation Interaction

## Files

- `src/control/turn-support.ts`
- `src/control/session-turn-runner.ts` only if needed
- `src/orchestration/agent-message-router.ts`
- `src/main.ts`
- tests:
  - `tests/integration/agent-messaging-completion-hardgate.test.ts`
  - `tests/unit/control/turn-queue.test.ts`
  - router tests

Prefer no production completion changes. The goal is to prove the existing completion machinery composes correctly with interruption.

## Hard gate 5.1 — Interrupted predecessor belongs to another peer contract

```text
C sends completion=result to B
B peer turn starts and blocks
A sends interrupt to B
```

Assert:

```text
the predecessor settles (terminal status transport-owned:
cancelled OR completed)
C gets exactly ONE terminal completion for msg_C, bound to C's
requestMessageId (status = actual predecessor outcome; no duplicate,
no cross-contract completion, no dangling contract)
A interrupt turn starts after B old turn settles
```

## Hard gate 5.2 — Interrupt request completion=result

Have the old turn emit partial assistant text (marker
OLD_PREDECESSOR_OUTPUT) — whether it later terminalizes as cancelled or
completed is transport-owned.

Have the interrupting peer turn return:

```text
FINAL_INTERRUPT_RESULT
```

Assert A receives only:

```text
FINAL_INTERRUPT_RESULT
```

and never the predecessor's partial output or completion envelope,
regardless of how the predecessor terminalized.

## Hard gate 5.3 — Pending interrupt removed pre-start

For both cancelQueuedItem and archive/clear:

```text
completion=result interrupt accepted
→ removed before execution
→ source completion terminal cancelled once
→ no target model execution
```

## Idempotency

Test retry after:

- reservation,
- abort,
- old settlement,
- interrupt turn start,
- interrupt turn completion.

No phase may produce a second abort or second target turn.

Commit:

```text
test(agent-messaging): harden interrupt completion lifecycle
```

---

# Phase 6 — Same-Account Relay Hard Gate

## Files

- `tests/integration/agent-messaging-federation-hardgate.test.ts`
- `tests/unit/orchestration/agent-messaging-remote-integration.test.ts`
- Relay gateway tests only if needed for a regression

Production Relay code should need little or no semantic change because interruption belongs at the target daemon.

## Required real topology

Use:

```text
source daemon/node A
Relay Hub
target daemon/node B
```

Target B has a real controlled busy turn held unresolved.

Source A sends:

```ts
mode: "interrupt"
completion: "result"
```

Assert:

1. Hub forwards one message request.
2. Source daemon never attempts a local target cancel.
3. Target daemon reserves one interrupt.
4. Target old AbortController is signalled once.
5. New peer turn does not start while old run remains unresolved.
6. After target settle, new peer turn starts exactly once.
7. Source receives the normal delivery receipt.
8. Source eventually receives the completion result.
9. Duplicate Relay request does not cause another abort or turn.

## Archive race

Add:

```text
interrupt accepted
→ before old turn fully settles, target lifecycle removes/archives session
```

Assert terminal cancellation/no resurrection.

Commit:

```text
test(agent-messaging): prove peer interrupt across relay
```

---

# Phase 7 — MCP Tool Guidance and Compatibility

## Files

- `src/mcp/xacpx-mcp-tools.ts`
- `tests/unit/mcp/xacpx-mcp-tools.test.ts`
- `tests/unit/mcp/xacpx-mcp-server.test.ts`
- docs

## Schema

Do not add a new field if current `mode` already supports interrupt.

Ensure public schema explicitly permits:

```text
interrupt
```

and preserves old values.

## Description

Update `agent_send` description with explicit consequences:

mode="interrupt" requests cancellation of the target's current turn and
reserves this message as its highest-priority next turn. xacpx waits for
the current turn to fully settle before starting the message and never
runs the two turns in parallel. Some runtimes may finish the current
turn instead of stopping immediately. Use only when waiting behind
ordinary queued work would materially harm the task.
Default/auto never selects interrupt, and xacpx never escalates a
message to interrupt based on its wording.

Avoid language that encourages routine interruption.

## Backward compatibility

Verify:

- existing calls without `mode` unchanged;
- `mode:"queue"` unchanged;
- `mode:"steer"` unchanged;
- old clients do not need a schema migration;
- existing receipt marker/correlation remains unchanged;
- sent/received card anchoring does not depend on mode.

Commit:

```text
docs(mcp): define explicit peer interrupt semantics
```

---

# Phase 8 — Observability and Optional Relay Web Polish

Core release does not require a new UI.

## Logging

Wire structured events:

```text
agent_messaging.peer_interrupt_reserved
agent_messaging.peer_interrupt_abort_signalled
agent_messaging.peer_interrupt_started
agent_messaging.peer_interrupt_cancelled_before_start
agent_messaging.peer_interrupt_rejected_pending
```

No message body in logs.

## Optional UI follow-up

If the existing turn DTO can carry a structured cancellation reason without widening the work substantially, add:

```ts
cancelReason: "peer-interrupt"
```

plus a safe display identity.

Relay Web may show:

```text
Interrupted by <peer display name>
```

Do not block v0.4 core on this presentation work.

---

# Phase 9 — Full Verification Matrix

Run focused tests first.

Suggested commands should be adapted to the repository's current official runners, but the verification matrix must include:

```text
TypeScript typecheck
channel-relay typecheck
Relay Web vue-tsc
TurnQueue unit suite
ControlService Agent Messaging suite
AgentMessageRouter suite
local Agent Messaging integration
completion hardgate
federation hardgate
MCP tool suite
official unit suite
full integration suite
build:packages
```

## Required hard gates checklist

- [ ] G1 idle interrupt.
- [ ] G2 busy interrupt true settlement.
- [ ] G3 aborted-but-unsettled predecessor.
- [ ] G4 priority over normal queue.
- [ ] G5 normal queue full but interrupt accepted.
- [ ] G6 second distinct interrupt rejected.
- [ ] G7 duplicate retry one abort/one turn.
- [ ] G8 cancel pending interrupt.
- [ ] G9 archive/clear pending interrupt.
- [ ] G10 interrupted completion-bearing predecessor: exactly ONE terminal
      completion bound to its own requestMessageId; status = actual
      predecessor outcome (cancelled OR completed, transport-owned);
      no duplicate, no cross-contract completion, no dangling contract.
- [ ] G11 interrupt completion result uses only new peer turn.
- [ ] G12 auto/queue never cancel.
- [ ] G13 real two-daemon Relay interrupt.
- [ ] G14 destination capability stale/fail-closed.

Do not call the feature complete if only Router mocks are green.

---

# Phase 10 — Documentation Cleanup

Update the older architecture docs so they no longer imply that explicit interrupt requires an acpx/provider live-input implementation.

Files likely needing notes:

- `docs/superpowers/specs/2026-08-11-agent-messaging-design.md`
- `docs/superpowers/plans/2026-08-18-agent-messaging-realtime-v0.1.md`
- v0.3 collaboration spec if it describes realtime delivery boundaries

Recommended note:

```text
As of Peer Interrupt Delivery v0.4, explicit interrupt for managed logical
sessions is implemented by xacpx TurnQueue as a cancellation-request +
true-settlement + priority-next-turn primitive with strict no-overlap.
Whether the underlying transport actually terminates the active model turn
early is transport-owned; the predecessor may terminalize as cancelled or
completed and xacpx never rewrites natural completion into cancellation.
Native provider steering remains optional and separate.

Do not delete historical plans; mark the interrupt portion superseded.

---

# Review Checklist for the Implementation PR

A reviewer should reject the PR if any answer below is "yes":

- Does Router call cancel and then separately submit the peer prompt?
- Can the interrupting runTurn start before the predecessor's true `settled`?
- Can two different interrupts occupy priority slots simultaneously?
- Does explicit interrupt silently become ordinary queue?
- Can `auto` invoke the cancel path?
- Does normal queue full prevent an otherwise-free interrupt slot?
- Can interrupt delete existing queued prompts?
- Can a duplicate request abort twice?
- Can archive/clear leave the interrupt's source completion pending?
- Does a remote source directly control the target turn?
- Is capability inferred from provider name or steer capability?
- Does the implementation require a new ACP extension?
- Does it add a new public `delivery` field despite existing `mode`?
- Do tests fake a settled predecessor instead of holding a real runTurn unresolved?

## Merge criteria

The implementation PR is mergeable only when:

1. All G1–G14 hard gates pass.
2. Exact-head official CI is green.
3. No provider-specific code is needed for interrupt.
4. Existing queue/steer/default behavior is regression-tested.
5. Completion and Relay hard gates use production paths.
6. Review confirms no cancel→submit race exists.
