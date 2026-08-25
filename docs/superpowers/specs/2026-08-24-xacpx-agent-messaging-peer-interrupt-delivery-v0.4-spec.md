# xacpx Agent Messaging — Peer Interrupt Delivery v0.4 Spec

Status: Proposed  
Date: 2026-08-24  
Scope: xacpx-managed logical Agent sessions; local and same-account Relay routes  
Supersedes for interrupt semantics: the provider-owned interrupt portion of `2026-08-18-agent-messaging-realtime-v0.1.md`

## 1. Summary

Peer Interrupt Delivery allows one Agent to explicitly preempt another Agent's **current turn** without requiring the target Agent/provider to implement same-turn steering.

The mechanism is:

```text
Agent A
  │ MCP agent_send(mode="interrupt")
  ▼
xacpx AgentMessageRouter
  │
  ▼
target xacpx TurnQueue
  ├─ target idle
  │    └─ start ordinary peer turn
  │
  └─ target busy
       ├─ reserve ONE pending peer interrupt
       ├─ abort/cancel current turn through the existing xacpx turn-control path
       ├─ wait until the old turn has REALLY settled
       └─ run the peer message as the next ordinary turn,
          ahead of the normal FIFO queue
```

This is **not steering**.

- `steer`: injects into the same active model turn; provider/runtime support is required.
- `interrupt`: cancels the old turn, then starts a new ordinary peer turn; provider-specific steering is not required.
- `queue`: leaves the current turn untouched and waits for the ordinary next-turn queue.

The default path remains non-preemptive. xacpx MUST NOT infer urgency from text and MUST NOT automatically escalate a normal message into an interrupt.

## 2. Current Baseline and Design Decision

The current code already contains the public protocol vocabulary needed by v0.4:

```ts
type AgentMessageMode = "auto" | "steer" | "queue" | "interrupt";

interface AgentCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
  conversation: boolean;
  completion?: boolean;
}
```

The current transport contract also knows `interrupt`, but individual transports such as the normal acpx CLI path may reject it with `TARGET_NOT_INTERRUPTIBLE`.

Therefore v0.4 MUST **not** introduce a second public `delivery` parameter. It redefines and productionizes the existing:

```ts
agent_send({ ..., mode: "interrupt" })
```

as an xacpx control-plane primitive for managed logical sessions.

The implementation MUST NOT depend on:

```ts
SessionTransport.injectMessage({ mode: "interrupt" })
```

for logical-session Peer Interrupt Delivery.

That transport primitive remains a legacy/optional runtime capability. v0.4 interrupt is owned by xacpx's `TurnQueue` / `ControlService` lane, which already owns the active turn's abort controller and the next-turn queue.

## 3. Goals

v0.4 must provide:

1. Explicit Agent-selected preemption with `agent_send(mode="interrupt")`.
2. No provider-specific steer requirement.
3. No ACP protocol extension requirement.
4. No automatic interruption from the default `agent_send` path.
5. Exactly one cancellation request against the currently active target turn.
6. No new target peer turn until the cancelled predecessor has truly unwound.
7. The interrupting peer turn executes before the target's existing ordinary queued turns.
8. Existing queued turns are preserved; interrupt does not clear the queue.
9. One pending interrupt reservation per target lane.
10. Duplicate retries of the same message/request remain idempotent.
11. Completion contracts (`none` / `notify` / `result`) remain attached to the **new interrupting peer turn**, never to the cancelled predecessor.
12. If the cancelled predecessor itself came from a completion-bearing peer request, its original source receives a terminal `cancelled` completion exactly once.
13. Local and same-account Relay routes have identical target-side interrupt semantics.
14. Archived/removing targets are never restored merely to receive an interrupt.
15. `auto` never interrupts.

## 4. Non-goals

v0.4 does not add:

- Generic same-turn steering.
- ACP-level steering or interrupt protocol extensions.
- Resume of the cancelled turn after the interrupting message.
- Nested priority levels.
- Numeric message priorities.
- Automatic urgency classification.
- Interrupt based on natural-language keywords.
- More than one pending priority interrupt per target.
- Cross-account authorization changes.
- Durable Agent mail/store-and-forward.
- Stronger crash durability than the existing live Agent Messaging queue contract.
- Provider-specific implementations in Claude/Codex/OMP/Qoder/Cursor/etc.

Steer remains an optional independent capability.

## 5. Public MCP API

The existing `agent_send` API remains the public surface.

Conceptually:

```ts
agent_send({
  to: string,
  content: string,
  mode?: "auto" | "steer" | "queue" | "interrupt",
  completion?: "none" | "notify" | "result",
  replyTo?: string
})
```

No additional `urgent`, `priority`, `preempt`, or `delivery` field is introduced.

### 5.1 Tool description requirement

The tool description MUST make the side effect explicit.

Recommended semantics text:

> `mode="interrupt"` cancels the target Agent's current turn, waits for it to stop, then delivers this message as the target's next turn. Use it only when waiting for the current turn would materially harm the task. The default/auto mode never cancels another Agent's work.

The model may explicitly choose interrupt. xacpx never makes that choice from message content.

## 6. Mode Semantics

### 6.1 `queue`

```text
idle    -> start ordinary peer prompt
running -> append to ordinary FIFO queue
```

Never cancels.

### 6.2 `auto`

`auto` is non-preemptive.

```text
idle                         -> ordinary peer prompt
running + native steer       -> same-turn steer (existing behavior, if enabled)
running + no native steer    -> ordinary queue
```

`auto` MUST NEVER select `interrupt`.

If the project later chooses to remove steer preference from `auto`, that is a separate API decision and is not required by v0.4.

### 6.3 `steer`

Exact semantics remain unchanged:

```text
running + steer supported -> same active turn
otherwise                  -> typed failure
```

No fallback from explicit `steer` to `interrupt`.

### 6.4 `interrupt`

#### Target idle

No cancellation is performed.

```text
interrupt request
→ ordinary peer prompt
→ receipt status = injected
→ modeUsed = prompt
→ targetState = idle
```

#### Target busy

```text
interrupt request
→ install target-lane interrupt reservation
→ abort current in-flight turn exactly once
→ return accepted receipt
→ wait for predecessor true settlement
→ run interrupt reservation before ordinary queue
```

Receipt:

```ts
{
  status: "queued",
  modeUsed: "interrupt",
  targetState: "running"
}
```

"queued" means accepted for future execution; it does not mean normal FIFO priority.

#### Target has an aborted-but-unsettled predecessor

The predecessor still owns the lane.

The new interrupt:

- MUST NOT return `injected`.
- MUST NOT start a parallel turn.
- MUST NOT issue a second abort if the predecessor is already aborted.
- MUST reserve the interrupt slot and wait for true settlement.

#### Target removing / archived

Reject:

```text
TARGET_UNAVAILABLE / equivalent existing typed error
```

Never auto-restore an archived target.

## 7. Target-Lane Data Model

`TurnQueue` should own interrupt ordering.

Recommended internal shape:

```ts
private readonly pendingInterrupts = new Map<
  string, // resolved concurrency/turn key
  QueuedPrompt
>();
```

Exactly one pending interrupt is allowed per lane.

The interrupt slot is **separate from** the ordinary FIFO queue:

```text
current in-flight
      ↓
pending interrupt (0 or 1)
      ↓
normal FIFO queue
```

This means an interrupt may be accepted even when the ordinary queue is at `QUEUE_MAX_DEPTH`, provided the interrupt slot is free.

It MUST NOT evict or reorder the existing ordinary FIFO relative to itself:

```text
before:
  current
  Q1
  Q2
  Q3

interrupt I arrives:
  current is cancelled

execution:
  I
  Q1
  Q2
  Q3
```

## 8. Multiple Interrupts

If interrupt `I1` is already reserved and a different interrupt `I2` arrives before `I1` starts:

- MUST NOT cancel again.
- MUST NOT replace `I1`.
- MUST NOT silently downgrade an explicit interrupt to ordinary queue.
- Reject `I2` using the existing `MESSAGE_QUEUE_FULL` contract with a detail indicating the interrupt slot is occupied.

A retry of **the same** message/request id is not a second interrupt. It is deduplicated and returns the original accepted semantic result.

This one-slot rule is the v0.4 anti-preemption-storm mechanism. No time-based interrupt cooldown is required in v0.4.

## 9. Cancellation Ownership and Race Safety

The cancellation operation belongs inside the target turn lane.

The Router MUST NOT implement interrupt as:

```ts
await control.cancel(...);
await control.submitPeerTurn(...);
```

That creates a race between "cancel requested" and "old turn actually unwound".

Instead the operation must be atomic at the `TurnQueue` state-machine level:

```text
reserve interrupt
→ inspect current inFlight
→ abort current controller if needed
→ wait for existing.settled through normal TurnQueue unwind
→ drain interrupt reservation
```

The same lane object therefore knows:

- `inFlight`
- whether its controller is already aborted
- `settled`
- `draining`
- `removing`
- normal queued prompts
- pending interrupt

### 9.1 Synchronous acceptance invariant

Before an interrupt receipt is returned as accepted, its reservation must already exist in the target lane.

If there is a non-aborted predecessor, the target lane's abort controller must already have been signalled.

It is not necessary to wait for the predecessor's model/process to finish before returning the ACK.

### 9.2 True-settlement invariant

The interrupt peer turn may start only after:

```text
old turn run body finished or aborted
AND transport cancellation/unwind completed
AND old inFlight entry is cleared
```

No bounded timeout may cause xacpx to start the new turn in parallel with an old unresolved in-flight turn.

A timeout may turn into a typed delivery failure/cancellation, but never parallel execution.

## 10. Drain Priority

`advanceQueue()` or equivalent hand-off MUST select in this order:

```text
1. pending interrupt
2. normal FIFO head
3. idle
```

The existing `draining` guard continues to protect the hand-off window.

When a pending interrupt becomes the drained turn:

- it is removed from the interrupt slot synchronously,
- it re-registers `inFlight`,
- then the normal execution path runs.

## 11. Queue and Lifecycle Operations

All operations that currently manipulate queued peer turns must understand the interrupt slot.

### 11.1 `cancelQueuedItem`

If the id names the pending interrupt:

- remove it,
- emit queue state,
- invoke the existing queued-peer cancellation terminal path if it carries a completion contract,
- never execute it.

### 11.2 `clearSession` / archive / remove

Must remove:

```text
pending interrupt
+ ordinary queue
```

If the pending interrupt has `peerOrigin.completion !== "none"`, it must generate exactly one terminal cancelled completion through the existing `onQueuedPeerCancelled` / `completePeerTurn` state machine.

### 11.3 Ordinary active-turn cancel

v0.4 does not redefine the product's existing ordinary "Stop current turn" semantics.

Only lifecycle operations that already clear accepted queued work are required to clear the interrupt reservation.

## 12. Completion Semantics

Completion remains tied to `AgentMessage.id` and the peer turn created for that message.

Example:

```ts
agent_send({
  to: B,
  content: "Schema changed. Switch immediately.",
  mode: "interrupt",
  completion: "result"
})
```

Sequence:

```text
A reserves completion contract for msg_X
→ B accepts interrupt msg_X
→ B current turn cancelled
→ B old turn fully settles
→ B starts peer turn for msg_X
→ B peer turn finishes
→ completion(result) for msg_X routes back to A
```

The old cancelled turn's partial assistant text MUST NOT become `msg_X`'s result.

### 12.1 Interrupting a completion-bearing peer turn

If B's currently running turn was itself created by message `msg_C` with `completion=result`:

```text
C → B: msg_C result
B running msg_C
A → B: msg_A interrupt
```

Then:

```text
msg_C → terminal cancelled completion to C exactly once
msg_A → becomes next turn
msg_A completion → independent normal completion lifecycle
```

This falls out of the existing `peerOrigin` + terminal completion machinery and must be protected by an integration gate.

## 13. Idempotency

The existing message/request-id guarantees remain mandatory.

For an accepted interrupt:

- same messageId concurrent retry: no second reservation;
- same promptRequestId retry: no second abort;
- retry while predecessor is unwinding: same accepted result;
- retry after interrupt turn starts: deduplicated;
- retry after completion delivery: existing completion tombstone behavior.

The pending interrupt reservation itself must participate in the target-lane duplicate lookup alongside:

```text
settled request ids
normal queued request ids
current in-flight request id
```

## 14. Capability Model

`AgentCapabilities.interrupt` changes meaning for managed logical sessions.

It means:

> xacpx can safely preempt the target's current managed turn through its control plane and schedule a new peer turn after true settlement.

It does **not** mean the target Agent/provider has a native interrupt-message primitive.

### 14.1 v0.4 capability policy

Recommended:

```text
logical managed session:
  receive=true
  queue=true
  interrupt=true when the session is controlled by TurnQueue/SessionTurnRunner
  steer=provider/runtime-specific

worker endpoint:
  interrupt=false in v0.4 unless it is proven to use the same managed lane

external MCP coordinator:
  receive/interrupt remain false as today

remote logical endpoint:
  use target-published capability; destination revalidates
```

### 14.2 Destination revalidation

Directory capability is a hint for source UX/routing.

The destination daemon MUST independently reject an interrupt if the resolved target is not an interrupt-capable logical session.

This check must happen before any cancellation.

## 15. Relay Semantics

Relay Hub does not implement interruption.

It transports the existing AgentMessage containing:

```ts
requestedMode: "interrupt"
```

The target daemon owns all preemption behavior.

```text
source daemon
→ Relay Hub
→ target daemon
→ target TurnQueue reserve + abort + settle + next turn
```

No remote daemon cancel RPC is introduced.

Same-account authorization and existing source/target identity binding remain unchanged.

## 16. Error Semantics

Prefer existing public error codes.

Required cases:

```text
target archived/removing/unreachable
  -> existing TARGET_* / ROUTE_* failure

target is not an interrupt-capable logical endpoint
  -> TARGET_NOT_INTERRUPTIBLE

a different interrupt is already pending
  -> MESSAGE_QUEUE_FULL
     detail: target already has a pending interrupt

normal FIFO full, interrupt slot free
  -> interrupt MAY still be accepted

interrupt request removed before execution
  -> delivery/completion terminal cancelled, not failed
```

No new wire error code is required for v0.4 unless implementation constraints prove otherwise.

## 17. Observability

Add structured logs or trace fields, not free-text-only logs:

```text
agent_messaging.peer_interrupt_reserved
agent_messaging.peer_interrupt_abort_signalled
agent_messaging.peer_interrupt_started
agent_messaging.peer_interrupt_cancelled_before_start
agent_messaging.peer_interrupt_rejected_pending
```

Recommended dimensions:

```ts
{
  requestMessageId,
  sourceEndpointId,
  targetEndpointId,
  targetSessionAlias,
  predecessorWasAlreadyAborted?: boolean
}
```

Do not log message content.

A dedicated Relay Web "Interrupted by Agent X" visual marker is useful but not required for the core v0.4 release. Existing cancelled-turn rendering must remain correct.

## 18. MCP Guidance / Model Policy

The `agent_send` tool guidance should teach:

Use normal/default delivery when:

- the target can finish its current work first;
- the information is advisory;
- latency is not materially harmful.

Use `mode="interrupt"` only when:

- the target is likely acting on information that is now invalid;
- waiting for the current turn can cause meaningful wasted work or incorrect changes;
- an urgent dependency/status change must be seen before the target continues.

Do not use interrupt:

- merely to get attention;
- for routine updates;
- repeatedly because the target has not answered;
- as a substitute for `completion=result`.

xacpx itself never makes this semantic judgment.

## 19. Hard Release Gates

All gates below are release requirements, not optional unit-test ideas.

### G1 — Idle interrupt

```text
target idle
→ interrupt
→ cancel count = 0
→ exactly one peer turn starts
→ receipt injected / modeUsed prompt
```

### G2 — Busy interrupt true settlement

```text
target turn running
→ interrupt arrives
→ reservation exists
→ current AbortController signalled exactly once
→ receipt queued/interrupt
→ deliberately keep old runTurn unresolved
→ new peer runTurn count remains 0
→ resolve old runTurn
→ interrupt peer turn starts exactly once
```

### G3 — Aborted-but-unsettled predecessor

```text
old controller already aborted
old runTurn still unresolved
→ interrupt arrives
→ no second abort
→ no false injected
→ reserve and wait
→ after settle peer turn executes exactly once
```

### G4 — Priority over existing normal queue

```text
current running
Q1 queued
Q2 queued
interrupt I arrives
→ cancel current
→ execution order after settle = I, Q1, Q2
```

### G5 — Normal queue full does not consume interrupt slot

```text
normal FIFO reaches QUEUE_MAX_DEPTH
interrupt slot empty
→ interrupt accepted
→ all normal queued items preserved
```

### G6 — Second distinct interrupt rejected

```text
I1 reserved
I2 distinct request arrives before I1 starts
→ I2 MESSAGE_QUEUE_FULL
→ no second abort
→ I1 unchanged
```

### G7 — Duplicate interrupt retry

```text
I1 reserved
same request/message id retried
→ deduplicated accepted outcome
→ abort count stays 1
→ peer turn executes once
```

### G8 — Cancel pending interrupt

```text
interrupt accepted but predecessor not settled
→ cancelQueuedItem(interruptId)
→ interrupt removed
→ target peer model never runs it
→ completion-bearing source gets cancelled exactly once
```

### G9 — Archive/clear pending interrupt

Same as G8 through the real lifecycle path.

### G10 — Interrupt a completion-bearing peer turn

```text
C's completion-bearing peer turn is currently running on B
A interrupts B
→ C receives cancelled completion once
→ A's peer turn starts after settlement
→ A's completion lifecycle remains independent
```

### G11 — Interrupt + completion=result

```text
A interrupt(result) B
→ old B turn partial output exists
→ old turn cancelled
→ new peer turn returns FINAL_NEW
→ A completion result == FINAL_NEW
→ old partial output absent from result
```

### G12 — Auto/queue never cancel

For every target state:

```text
mode omitted / auto / queue
→ peer-interrupt abort path count = 0
```

Native steer may still run for `auto`; cancel may not.

### G13 — Remote same-account interrupt

Real two-daemon Relay hard gate:

```text
A on node 1
B busy on node 2
A sends interrupt
→ target node abort count 1
→ source node cannot directly cancel target
→ B new peer turn starts after old target turn settles
→ receipt and optional completion cross Relay correctly
```

### G14 — Destination capability fail-closed

Stale source directory says `interrupt=true`, target currently resolves as unsupported:

```text
→ target rejects TARGET_NOT_INTERRUPTIBLE
→ cancel count 0
→ no peer turn
→ completion/outbox reservations compensated by existing definite-rejection path
```

## 20. Acceptance Criteria

v0.4 is complete only when all of the following are true:

- `agent_send(mode="interrupt")` no longer depends on an Agent/provider-native interrupt implementation for managed logical sessions.
- Busy interrupt causes exactly one cancel signal.
- No new turn begins before the old one really settles.
- Interrupt executes before ordinary queued prompts without deleting them.
- Default/auto path never cancels.
- Duplicate retries cannot cause repeated cancellation or duplicate peer turns.
- Completion contracts survive the new lifecycle without cross-contamination.
- Local and Relay routes use the same target-side state machine.
- Archived/removing targets remain fail-closed.
- Hard gates G1–G14 pass through production seams.
- Full official unit/integration/build/CI suite is green.

## 21. Implementation Anchors in Current xacpx

The current implementation already provides most primitives:

- `src/orchestration/agent-messaging-types.ts`
  - `AgentMessageMode` already includes `interrupt`.
  - endpoint capabilities already include `interrupt`.
- `src/transport/message-injection.ts`
  - typed mode/error/receipt vocabulary already exists.
- `src/control/turn-queue.ts`
  - owns `inFlight`, `AbortController`, `settled`, `draining`, FIFO queues, request-id dedupe, and queued-peer cancellation callbacks.
- `src/control/control-service.ts`
  - owns the production TurnQueue/SessionTurnRunner integration.
- `src/orchestration/agent-message-router.ts`
  - owns source/target routing, completion grants, inbound dedupe, Relay semantics, and typed delivery errors.
- `src/orchestration/agent-endpoint-registry.ts`
  - owns local/remote capability publication and target resolution.
- `src/mcp/xacpx-mcp-tools.ts`
  - owns the model-facing `agent_send` schema and behavioral guidance.
- `src/main.ts`
  - wires completion and control callbacks.
- `tests/unit/control/turn-queue.test.ts`
  - natural home for race/order/idempotency gates.
- `tests/integration/agent-messaging-completion-hardgate.test.ts`
  - natural home for completion interaction gates.
- `tests/integration/agent-messaging-federation-hardgate.test.ts`
  - natural home for real Relay interrupt proof.

The implementation should build on these paths instead of creating a second messaging scheduler.
