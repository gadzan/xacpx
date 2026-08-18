# Agent Messaging Phase 0 — Codex Steering Feasibility Spike

> Execution order: 1 of 3. This plan is a gate, not a production rollout.

**Goal:** Prove that the acpx persistent queue owner can inject an xacpx message
into the same active regular Codex turn through a codex-acp extension, with a
stable delivery acknowledgement and classified race/error behaviour.

**Architecture:** The queue owner already owns the live AcpClient and exposes
cancel/mode/config control through QueueOwnerTurnController. The spike adds one
provisional live-input control beside those controls. Active-turn lookup and
the provider call stay inside the live owner/adapter process. xacpx does not
cache a turn id and does not participate in the provisional protocol.

**Spec:** [Agent Messaging design](../specs/2026-08-11-agent-messaging-design.md)

**Observed baseline (refresh before executing):**

- xacpx pins acpx 0.13.0.
- xacpx managed Codex adapter default is @agentclientprotocol/codex-acp 1.1.9.
- Local acpx source is ../acpx.
- acpx QueueOwnerActiveSessionController currently exposes active-prompt,
  cancel, set-mode, set-model, and set-config controls.
- acpx queue requests currently include submit_prompt, cancel_prompt,
  set_mode, set_model, set_config_option, and close_session.

## Scope

Included:

- One provisional Codex steering extension.
- One provisional acpx queue-owner request that reaches the live adapter.
- Typed outcomes for success, idle, unsupported, non-steerable turn, race, and
  transport failure.
- A repeatable real-Codex harness and a written spike report.

Excluded:

- xacpx MCP tools.
- Public acpx CLI compatibility commitments.
- Claude or Gemini.
- queue fallback, interrupt mode, Relay, persistence, or UI.
- Publishing package versions.

## Gate Contract

The spike may use provisional names, but it must produce this semantic result:

```
type SteerSpikeResult =
  | {
      ok: true;
      messageId: string;
      activeTurnId: string;
      sameTurn: true;
    }
  | {
      ok: false;
      code:
        | "NOT_RUNNING"
        | "NOT_SUPPORTED"
        | "NOT_STEERABLE"
        | "TURN_RACE"
        | "DELIVERY_FAILED";
      retryable: boolean;
      message: string;
    };
```

The message id must reach the Codex user-message event as the provider client
message id, or the spike report must explain why the correlation is impossible.

## Global Constraints

- The spike must never implement steering as a second prompt.
- The queue owner is the only process allowed to inspect the current active
  turn and call the adapter steering extension.
- No xacpx production file changes during this spike.
- Do not publish acpx or codex-acp packages from the spike branches.
- Keep provisional protocol symbols explicitly marked experimental.
- Real-Codex tests are manual/integration tests and must not enter default CI.

## Task 1: Freeze Exact Source Baselines

**Files:**

- Read: ../acpx/package.json
- Read: ../acpx/src/acp/client.ts
- Read: ../acpx/src/runtime/engine/connected-session.ts
- Read: ../acpx/src/cli/queue/owner-turn-controller.ts
- Read: ../acpx/src/cli/queue/messages.ts
- Read: ../acpx/src/cli/queue/ipc.ts
- Read: ../acpx/src/cli/queue/ipc-server.ts
- Read: ../acpx/src/cli/session/queue-owner-runtime.ts
- Read: codex-acp package.json and its ACP connection/turn tracking files
- Create after the spike:
  docs/superpowers/handoffs/2026-08-18-agent-messaging-steering-spike.md

- [ ] Record the exact git commit of acpx and codex-acp used by the spike.
- [ ] Record Node, Codex CLI/App Server, ACP SDK, and package versions.
- [ ] Identify the codex-acp module that owns the Codex App Server connection.
- [ ] Identify where codex-acp observes thread id, turn/start, turn/completed,
      regular/review/compaction turn kinds, and current active turn id.
- [ ] Confirm the exact Codex turn/steer request and success/error payloads
      against the version under test.
- [ ] Record the existing extension convention, if codex-acp already has one.
      If none exists, use a clearly experimental method name for the spike.

**Stop condition:** If the adapter does not hold the live App Server connection
for the duration of an ACP prompt, record the finding and stop. The proposed
owner-side path is not feasible in that adapter shape.

## Task 2: Add a Provisional codex-acp Steering Extension

**Files:**

- Modify: the codex-acp module that owns the App Server connection.
- Modify: the codex-acp ACP request dispatcher/extension registry.
- Test: the closest codex-acp protocol and turn-state test files.

Provisional interface:

```
session/steer {
  sessionId: string;
  text: string;
  clientMessageId: string;
}
```

Implementation invariants:

- Resolve thread id and current active turn inside the adapter.
- Accept only a regular steerable turn.
- Call Codex turn/steer with expectedTurnId equal to the active turn observed
  immediately before the request.
- Use clientMessageId for provider-side event correlation.
- Do not start a new turn.
- Do not interrupt the active turn.
- Map no active turn, unsupported turn kind, ActiveTurnNotSteerable, and
  expected-turn mismatch into distinct provisional error codes.

- [ ] Write a failing adapter test for a regular active turn.
- [ ] Write failing tests for idle, review/compaction, and turn-id mismatch.
- [ ] Implement the smallest extension dispatcher and active-turn lookup.
- [ ] Assert one turn/start before and after steering.
- [ ] Assert the returned activeTurnId is unchanged.
- [ ] Assert the user-message event contains clientMessageId.
- [ ] Run the adapter repository's focused tests and typecheck.
- [ ] Commit on the spike branch:
      spike(codex-acp): expose provisional active-turn steering

## Task 3: Route the Provisional Control Through the acpx Owner

**Files in ../acpx:**

- Modify: src/acp/client.ts
- Modify: src/runtime/engine/connected-session.ts
- Modify: src/cli/queue/owner-turn-controller.ts
- Modify: src/cli/queue/messages.ts
- Modify: src/cli/queue/ipc.ts
- Modify: src/cli/queue/ipc-server.ts
- Modify: src/cli/session/queue-owner-runtime.ts
- Test: test/client.test.ts
- Test: test/turn-controller.test.ts
- Test: test/queue-messages.test.ts
- Test: test/queue-ipc.test.ts
- Test: test/queue-ipc-server.test.ts
- Test: test/queue-owner-lifecycle.test.ts

Provisional owner request:

```
{
  type: "steer_prompt";
  requestId: string;
  ownerGeneration?: number;
  text: string;
  clientMessageId: string;
  timeoutMs?: number;
}
```

- [ ] Add AcpClient.experimentalSteerActivePrompt with no fallback to prompt.
- [ ] Add steerActivePrompt to FullConnectedSessionController and
      QueueOwnerActiveSessionController.
- [ ] Make QueueOwnerTurnController reject idle/starting/closing states with
      typed results rather than enqueueing.
- [ ] Add parse/encode tests for steer_prompt and its response.
- [ ] Handle steer_prompt as a control request so it bypasses the normal prompt
      queue while retaining the queue-owner generation fence.
- [ ] Preserve same-session request FIFO for multiple steering requests.
- [ ] Return only after the adapter acknowledges turn/steer.
- [ ] Add tests proving a steer request runs while submit_prompt is active.
- [ ] Add tests proving it never invokes the submit_prompt queue.
- [ ] Run:

```
cd ../acpx
pnpm run typecheck
pnpm run build:test
node --test \
  dist-test/test/client.test.js \
  dist-test/test/turn-controller.test.js \
  dist-test/test/queue-messages.test.js \
  dist-test/test/queue-ipc.test.js \
  dist-test/test/queue-ipc-server.test.js \
  dist-test/test/queue-owner-lifecycle.test.js
```

- [ ] Commit on the spike branch:
      spike(acpx): route provisional steer through live queue owner

## Task 4: Build the Real-Codex Repetition Harness

**Files:**

- Create on the spike branch: an acpx integration script under scripts/spikes/
  using the repository's existing CLI/runtime entry point.
- Do not wire the script into default test or package scripts.

Each run must:

1. Create or ensure one named Codex session.
2. Start a deterministic long regular turn that emits its turn id.
3. Wait until the turn is active.
4. Send one steer request from a second process with a unique message id.
5. Capture turn/start, user-message, turn/completed, ACK, and timing data.
6. Assert there is exactly one turn/start and the active turn id is unchanged.
7. Cleanly close the session after evidence is written.

- [ ] Run the happy path at least 20 times.
- [ ] Run two concurrent steering requests and verify FIFO.
- [ ] Run steering against an idle session.
- [ ] Run against review and manual compaction when reproducible.
- [ ] Force the turn-completion race by steering near completion at least 20
      times; every outcome must be success or a classified race.
- [ ] Confirm no case silently starts another turn.
- [ ] Confirm no case invokes turn/interrupt.
- [ ] Record p50/p95 acknowledgement latency without message content.

## Task 5: Write the Gate Report

**Files:**

- Create:
  docs/superpowers/handoffs/2026-08-18-agent-messaging-steering-spike.md
- Optionally update:
  docs/superpowers/specs/2026-08-11-agent-messaging-design.md

The report must contain:

- source commits and dependency versions;
- exact extension request/response;
- exact capability advertisement mechanism;
- error mapping;
- the 20+ run table;
- same-turn evidence;
- race classification;
- whether the provisional changes are suitable for production hardening;
- production file map for codex-acp and acpx;
- explicit GO or NO-GO.

- [ ] If GO, replace provisional names with the production contract described
      in the realtime implementation plan.
- [ ] If NO-GO, keep Codex steer=false and continue only with the queue-first
      local plan.
- [ ] Do not merge spike commits directly. Reimplement production changes
      test-first from the report so temporary instrumentation does not leak.

## Exit Criteria

- Same active Codex turn observed before and after every successful injection.
- No additional turn/start and no interrupt.
- Stable delivery ACK tied to message id.
- Regular, idle, non-steerable, unsupported, and race outcomes classified.
- At least 20 repeatable happy-path runs.
- A written GO/NO-GO report exists.
