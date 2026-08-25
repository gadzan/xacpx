# Agent Messaging — Codex Realtime v0.1 Implementation Plan

> Execution order: 3 of 3. Start only after the Phase 0 spike report says GO
> and Local queue-first v0.1 is green.

**Goal:** Upgrade local Agent Messaging from queue-only delivery to the complete
v0.1 mode matrix, with Codex same-turn steering, authoritative capability
discovery, explicit interrupt, owner-side race handling, and end-to-end proof
that the target turn id does not change.

> **Superseded (2026-08-24), interrupt portion only:** as of Peer Interrupt
> Delivery v0.4, explicit `mode: "interrupt"` for managed logical sessions is
> implemented by xacpx's own TurnQueue (reserve → cancel → true-settle →
> next-turn delivery) and does NOT require the acpx live-input runtime, the
> codex-acp steering extension, or any provider extension described below.
> Native same-turn `steer` remains an optional, separate capability. See
> `../specs/2026-08-24-xacpx-agent-messaging-peer-interrupt-delivery-v0.4-spec.md`.

**Architecture:** acpx becomes the deep live-input module. Its production
interface is one inject command/runtime operation with mode
auto/steer/queue/interrupt. The queue owner decides target state and performs
the atomic provider action. xacpx forwards message intent through its existing
message lane and consumes a typed receipt; it never reads activeTurnId or
branches on provider name.

**Spec:** [Agent Messaging design](../specs/2026-08-11-agent-messaging-design.md)

**Prerequisites:**

- [Phase 0 spike](2026-08-18-agent-messaging-steering-spike.md) has a written GO.
- [Local queue-first v0.1](2026-08-18-agent-messaging-local-v0.1.md) passes its
  release gate.
- The spike report records exact Codex App Server, codex-acp, ACP SDK, and acpx
  contracts. If it does not, stop and complete the report first.

## Scope

Included:

- Production codex-acp steering extension and capability advertisement.
- Production acpx live-input runtime, queue IPC, CLI, errors, status, and tests.
- Published exact acpx/codex-acp versions.
- xacpx capability probing and all four delivery modes.
- Codex real-session E2E and race tests.
- Queue fallback for adapters without steer.

Excluded:

- Claiming Claude or Gemini steer support.
- Relay/remote delivery.
- Cross-account grants.
- Durable agent_mail.

## Dependency and Release Order

The order is mandatory:

1. Merge and publish codex-acp with the production extension.
2. Merge and publish acpx with generic live-input support.
3. In xacpx, bump the exact acpx dependency and exact managed codex-acp pin.
4. Run the xacpx adapter initialize probe before accepting the new pin.
5. Ship xacpx only after the real Codex smoke matrix passes.

Do not temporarily point xacpx release defaults at a git URL or floating
version. Local development may use explicit commands, but the final change
must use exact published versions and update bun.lock intentionally.

## Production acpx Interface

CLI:

```
acpx <agent> inject \
  -s <session> \
  --mode <auto|steer|queue|interrupt> \
  --message-id <id> \
  --file <prompt-file>
```

Runtime:

```
injectSessionMessage({
  sessionId,
  messageId,
  prompt,
  mode,
}): Promise<LiveInputReceipt>
```

Receipt:

```
interface LiveInputReceipt {
  messageId: string;
  status: "injected" | "queued";
  modeUsed: "steer" | "queue" | "interrupt" | "prompt";
  targetState: "idle" | "running";
}
```

Capabilities:

```
interface LiveInputCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
}
```

The exact wire method names and extension metadata shape must be copied from
the accepted spike report. If they differ from the names above, update this
plan and the design spec before production implementation.

## Owner-Side Mode Matrix

```
idle + auto/queue       -> start prompt; injected/prompt
idle + steer            -> TARGET_NOT_RUNNING
idle + interrupt        -> start prompt; injected/prompt

running + steer support + auto/steer
                         -> same active turn; injected/steer
running + no steer + auto
                         -> queued/queue
running + any + queue    -> queued/queue
running + interrupt      -> cancel ACK then enqueue; queued/interrupt
unreachable              -> typed failure
```

auto may re-evaluate once after a turn-completion race:

- If the same active turn remains, retrying the provider request is forbidden;
  return DELIVERY_RACE.
- If the session is now idle, enqueue/start the message as a new prompt.
- If a different turn is active, fail DELIVERY_RACE rather than steering into
  a turn the caller did not target.

steer never falls back. auto never interrupts.

## Global Constraints

- Active-turn lookup and provider request occur in the same adapter/live-owner
  process.
- xacpx never sends expectedTurnId.
- Relay concepts do not enter acpx.
- Generic ACP adapters default to steer=false.
- A capability says the adapter supports a primitive; an individual turn may
  still reject it as non-steerable.
- messageId reaches the provider client message id.
- Multiple inject requests for one session are FIFO.
- Retry/dedupe remains keyed by xacpx messageId.

## Task 0: Freeze the Production Contract From the Spike

**Files:**

- Read:
  docs/superpowers/handoffs/2026-08-18-agent-messaging-steering-spike.md
- Modify if needed:
  docs/superpowers/specs/2026-08-11-agent-messaging-design.md
- Modify if needed:
  docs/superpowers/plans/2026-08-18-agent-messaging-realtime-v0.1.md

- [ ] Copy the exact extension method, capability advertisement, error payload,
      and provider request fields into this plan.
- [ ] Record the production codex-acp and acpx repositories/branches.
- [ ] Map every spike error to one production code.
- [ ] Confirm messageId correlation and same-turn evidence.
- [ ] Remove all provisional/experimental naming from the production contract.
- [ ] Commit documentation changes before code:
      docs(agent-messaging): freeze realtime control contract

## Task 1: Productionize the codex-acp Steering Adapter

**Files in codex-acp:**

- Modify: the ACP extension request registry/dispatcher identified by the spike.
- Modify: the Codex App Server connection owner identified by the spike.
- Modify: active thread/turn tracking identified by the spike.
- Test: the exact protocol and turn-state test files identified by the spike.
- Modify: package documentation/changelog.

- [ ] Write production tests for regular active turn, idle, review, manual
      compaction, stale expected turn, App Server rejection, and disconnect.
- [ ] Advertise steer only when the running adapter build supports the
      production extension.
- [ ] Keep queue and interrupt capability semantics separate from steer.
- [ ] Resolve the current regular turn immediately before turn/steer.
- [ ] Send expectedTurnId and clientUserMessageId.
- [ ] Normalize provider errors without exposing raw App Server internals as
      the public contract.
- [ ] Prove the extension never calls turn/start or turn/interrupt.
- [ ] Run the adapter's focused tests, full typecheck, and full test command.
- [ ] Commit:
      feat: add active-turn steering extension
- [ ] Open/merge the adapter PR, but do not publish until its release notes and
      extension contract are reviewed.

## Task 2: Add Generic Live-Input Capability to acpx

**Files in ../acpx:**

- Modify: src/acp/client.ts
- Modify: src/runtime/engine/connected-session.ts
- Modify: src/runtime/public/contract.ts
- Modify: src/runtime/public/errors.ts
- Modify: src/cli/queue/owner-turn-controller.ts
- Modify: src/cli/session/contracts.ts
- Modify: src/cli/session/prompt-runner.ts
- Modify: src/cli/session/queue-owner-runtime.ts
- Test: test/client.test.ts
- Test: test/runtime.test.ts
- Test: test/runtime-manager.test.ts
- Test: test/turn-controller.test.ts

- [ ] Add generic LiveInputCapabilities and LiveInputReceipt types.
- [ ] Decode the adapter capability advertisement established by Task 0.
- [ ] Default unknown/generic adapters to steer=false.
- [ ] Add steerActivePrompt to the active connected-session controller only;
      do not expose provider turn ids to callers.
- [ ] Implement owner-side mode selection as one runtime operation.
- [ ] Implement one-time auto race re-evaluation.
- [ ] Implement interrupt as cooperative cancel followed by owner-serialized
      prompt acceptance.
- [ ] Keep queue execution in the existing owner queue.
- [ ] Return typed errors for not running, unsupported, non-steerable,
      interrupt unsupported, race, timeout, and delivery failure.
- [ ] Test through the public runtime interface rather than private adapter
      state.
- [ ] Run:

```
cd ../acpx
pnpm run typecheck
pnpm run build:test
node --test \
  dist-test/test/client.test.js \
  dist-test/test/runtime.test.js \
  dist-test/test/runtime-manager.test.js \
  dist-test/test/turn-controller.test.js
```

- [ ] Commit:
      feat(runtime): add capability-driven live input

## Task 3: Add acpx Queue IPC, CLI, and Status

**Files in ../acpx:**

- Modify: src/cli/queue/messages.ts
- Modify: src/cli/queue/ipc.ts
- Modify: src/cli/queue/ipc-server.ts
- Modify: src/cli/command-registration.ts
- Modify: src/cli-core.ts
- Modify: src/cli/status-command.ts
- Modify: docs/CLI.md
- Modify: docs/session-control.md
- Modify: docs/exit-codes.md
- Test: test/queue-messages.test.ts
- Test: test/queue-ipc.test.ts
- Test: test/queue-ipc-server.test.ts
- Test: test/queue-owner-lifecycle.test.ts
- Add the closest CLI/status tests if none currently cover the new command.

Production queue request:

```
{
  type: "inject_message";
  requestId: string;
  ownerGeneration?: number;
  messageId: string;
  prompt: PromptInput;
  mode: "auto" | "steer" | "queue" | "interrupt";
  timeoutMs?: number;
}
```

- [ ] Parse and validate inject_message with the normal owner-generation fence.
- [ ] Route it as live control, not submit_prompt.
- [ ] Serialize inject requests per session.
- [ ] Return only after the runtime accepts steer/prompt/queue/interrupt.
- [ ] Add the inject CLI with JSON output and stable exit/detail codes.
- [ ] Accept --file so xacpx never needs shell-sensitive inline XML.
- [ ] Extend status JSON with liveInputCapabilities.
- [ ] Keep old prompt --no-wait behaviour unchanged.
- [ ] Test old owners/clients reject the unknown request clearly.
- [ ] Run:

```
cd ../acpx
pnpm run typecheck
pnpm run build:test
node --test \
  dist-test/test/queue-messages.test.js \
  dist-test/test/queue-ipc.test.js \
  dist-test/test/queue-ipc-server.test.js \
  dist-test/test/queue-owner-lifecycle.test.js
pnpm run build
```

- [ ] Commit:
      feat(cli): expose live message injection

## Task 4: Publish and Pin the Dependency Chain

**Repositories:** codex-acp, acpx, xacpx.

- [ ] Merge and publish codex-acp; record the exact version.
- [ ] Test acpx against that exact adapter version.
- [ ] Merge and publish acpx; record the exact version.
- [ ] In xacpx, update package.json acpx dependency to the exact version.
- [ ] In xacpx, update MANAGED_ADAPTERS.codex.defaultVersion to the exact
      codex-acp version.
- [ ] Run bun install so bun.lock changes only for the intended releases.
- [ ] Run the xacpx adapter initialize probe against the new Codex pin.
- [ ] Verify explicit agents.codex.command still overrides the managed pin.
- [ ] Verify an older explicit acpx command keeps queue-only compatibility.
- [ ] Commit:
      chore(adapters): pin realtime messaging support

## Task 5: Consume the Formal acpx Interface in xacpx

**Files:**

- Modify: src/transport/types.ts
- Modify: src/transport/acpx-command-builder.ts
- Modify: src/transport/acpx-cli/acpx-cli-transport.ts
- Modify: src/transport/acpx-bridge/acpx-bridge-protocol.ts
- Modify: src/transport/acpx-bridge/acpx-bridge-transport.ts
- Modify: src/bridge/bridge-server.ts
- Modify: src/bridge/bridge-runtime.ts
- Modify: relevant transport/bridge tests.

- [ ] Add optional SessionTransport.getMessageCapabilities.
- [ ] Implement it through formal acpx status JSON, with a short in-memory
      cache keyed by resolved adapter launch identity.
- [ ] Fail closed to queue=true, steer=false, interrupt=false when the formal
      capability field is absent on an older explicit acpx binary.
- [ ] Replace the queue-only inject implementation with acpx inject.
- [ ] Keep prompt --no-wait only as old-acpx fallback for auto/queue.
- [ ] Never fallback strict steer or interrupt through prompt.
- [ ] Parse LiveInputReceipt and typed acpx errors.
- [ ] Extend the Router-facing mapping with TARGET_NOT_RUNNING,
      TARGET_NOT_STEERABLE, TARGET_NOT_INTERRUPTIBLE, DELIVERY_RACE,
      DELIVERY_TIMEOUT, and DELIVERY_FAILED while keeping Bridge independent
      from orchestration error classes.
- [ ] Preserve Bridge message-lane scheduling from the Local plan.
- [ ] Prove injectMessage still bypasses a pending normal prompt.
- [ ] Test auto/steer/queue/interrupt argv, --file cleanup, receipt parsing,
      timeout, unsupported old binary, and typed error mapping.
- [ ] Run:

```
bun test tests/unit/bridge/bridge-request-scheduler.test.ts
bun test tests/unit/bridge/bridge-server.test.ts
bun test tests/unit/bridge/bridge-runtime.test.ts
bun test tests/unit/transport/acpx-command-builder.test.ts
bun test tests/unit/transport/acpx-cli/acpx-cli-transport.test.ts
bun test tests/unit/transport/acpx-bridge/acpx-bridge-transport.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): consume acpx live input

## Task 6: Enable Realtime Capabilities in AgentMessageRouter

**Files:**

- Modify: src/orchestration/agent-endpoint-registry.ts
- Modify: src/orchestration/agent-message-router.ts
- Modify: tests/unit/orchestration/agent-endpoint-registry.test.ts
- Modify: tests/unit/orchestration/agent-message-router.test.ts
- Modify: tests/unit/orchestration/agent-messaging-local-integration.test.ts

- [ ] Populate endpoint capabilities from SessionTransport rather than agent
      name checks.
- [ ] Keep capability probe failures from leaking private transport details.
- [ ] Pass requested mode unchanged to the local delivery adapter.
- [ ] Trust only the target runtime receipt for modeUsed/status/targetState.
- [ ] Preserve strict steer failure with no fallback.
- [ ] Preserve auto no-interrupt invariant.
- [ ] Preserve queue-only compatibility for unsupported adapters.
- [ ] Preserve FIFO, dedupe, rate limits, replyable, and safe logging.
- [ ] Cover the full design mode matrix.
- [ ] Add the race case where auto receives DELIVERY_RACE versus a successful
      idle re-evaluation.
- [ ] Run:

```
bun test tests/unit/orchestration/agent-endpoint-registry.test.ts
bun test tests/unit/orchestration/agent-message-router.test.ts
bun test tests/unit/orchestration/agent-messaging-local-integration.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): enable realtime delivery modes

## Task 7: Prove Real Codex Same-Turn Delivery

**Files:**

- Create: tests/smoke/agent-messaging-codex-steer.test.ts
- Modify: smoke-test documentation/runbook.
- Do not add this test to npm test or automated CI.

The test uses two xacpx-managed Codex sessions:

- A: reviewer/sender.
- B: implementer/target with a long regular turn.

- [ ] Capture B's current turn id before agent_send.
- [ ] Send one mode=steer message from A.
- [ ] Assert receipt status=injected and modeUsed=steer.
- [ ] Capture B's turn id after delivery and assert equality.
- [ ] Assert the Codex user-message event carries the xacpx messageId.
- [ ] Assert no turn/start or turn/interrupt occurred.
- [ ] Assert B's subsequent work reacts to the message.
- [ ] Send two messages and assert FIFO.
- [ ] Test mode=queue never steers.
- [ ] Test active review/non-steerable turn returns TARGET_NOT_STEERABLE.
- [ ] Test idle + steer returns TARGET_NOT_RUNNING.
- [ ] Test explicit interrupt cancels and then prompts.
- [ ] Repeat the happy path at least 20 times before release.

Run only with real infrastructure:

```
bun test tests/smoke/agent-messaging-codex-steer.test.ts
```

- [ ] Commit:
      test(agent-messaging): cover Codex same-turn steering

## Task 8: Documentation and Final Verification

**Files:**

- Modify: docs/external-mcp.md
- Modify: docs/config-reference.md if capability cache/limits become public.
- Modify: docs/code-wiki.md
- Modify: docs/superpowers/specs/2026-08-11-agent-messaging-design.md
- Modify: the spike handoff with final published versions.

- [ ] Document provider capability differences.
- [ ] Document all four modes and exact fallback rules.
- [ ] Document that active turn ids never enter xacpx.
- [ ] Document old explicit acpx binary compatibility.
- [ ] Record published acpx/codex-acp versions.
- [ ] Run in xacpx:

```
npx prettier --check \
  AGENTS.md \
  CONTEXT.md \
  docs/external-mcp.md \
  docs/code-wiki.md \
  docs/superpowers/specs/2026-08-11-agent-messaging-design.md \
  docs/superpowers/plans/2026-08-18-agent-messaging-realtime-v0.1.md
npx tsc --noEmit
npm test
bun run build
```

- [ ] Run the full acpx check before its release:

```
cd ../acpx
pnpm run check
```

- [ ] Commit:
      docs(agent-messaging): document realtime delivery

## Release Gate

Realtime v0.1 is complete only when:

- the Phase 0 GO evidence is reproduced against published versions;
- Codex regular turns support same-turn steer;
- non-steerable and idle strict-steer cases are typed failures;
- auto queues unsupported adapters and never interrupts;
- queue never steers;
- interrupt is explicit and owner-serialized;
- xacpx has no provider-name branching and no activeTurnId cache;
- receipts come from target runtime acceptance;
- 20+ real-Codex runs pass with unchanged turn id;
- both xacpx transports, all unit tests, builds, and acpx checks pass.

Claude and Gemini remain steer=false until separate provider-specific plans and
integration evidence exist.
