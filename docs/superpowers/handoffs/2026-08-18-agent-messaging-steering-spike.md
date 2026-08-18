# Agent Messaging Steering Spike Handoff

Status: In progress — production realtime remains disabled  
Date: 2026-08-18  
Plan: [Phase 0 steering feasibility spike](../plans/2026-08-18-agent-messaging-steering-spike.md)

## Gate Summary

The architectural stop condition passed on both sides:

- acpx's persistent queue owner retains one live ACP client while a prompt is
  active and can issue a concurrent control request on that connection.
- codex-acp retains one live Codex App Server JSON-RPC connection for the ACP
  server lifetime and already has a direct `turn/steer` transport primitive.

The released codex-acp 1.1.9 steering extension does **not** pass the product
gate unchanged. Its existing `_session/steering` method falls back to starting a
new prompt when no active turn exists or an injection race occurs. It also lacks
message-id correlation and typed race/non-steerable outcomes. xacpx therefore
continues to advertise `steer=false` until the strict spike below completes.

## Frozen Source Baselines

| Component                  | Version / commit                           | Notes                                                                                                   |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| xacpx                      | current 2026-08-18 worktree                | `acpx` exact dependency 0.13.0; managed codex-acp exact pin 1.1.9                                       |
| acpx                       | `035062a9210ba0ba351a6cba3bf126dc2d70fd89` | `v0.13.0-2-g035062a`; source code matches the 0.13.0 tag aside from README/changelog commits            |
| codex-acp                  | `992299d7d54cfa2ee376a375a4447ed198f638ba` | upstream tag `v1.1.9`; npm artifact shasum `6e5a41fdf3cc6c3c9a1c5a60a2017a041a435ce3`                   |
| ACP SDK                    | 1.3.0                                      | Verified from the frozen lockfiles and clean temporary installs                                         |
| Codex package / App Server | 0.145.0 in codex-acp 1.1.9                 | Managed adapter artifact dependency                                                                     |
| Local Codex CLI            | 0.146.1                                    | Must be recorded again by the real repetition harness in case `CODEX_PATH` overrides the bundled binary |
| Node                       | 24.13.0                                    | Local spike runtime                                                                                     |

The original sibling acpx checkout had a stale installed ACP SDK 0.22.1 while
its package and lockfile require 1.3.0. The spike uses a clean temporary clone
with SDK 1.3.0, so results do not rely on that drifted install.

Temporary spike branches (not production commits):

- `/private/tmp/codex-acp-steering-spike-20260818`, branch
  `spike/agent-messaging-steer-20260818`
- `/private/tmp/acpx-steering-spike-20260818`, branch
  `spike/agent-messaging-steer-20260818`

## Frozen Experimental Contract

Adapter method:

```text
_session/steering/strict
```

Request:

```ts
interface StrictSteerRequest {
  sessionId: string;
  prompt: ContentBlock[];
  clientMessageId: string;
}
```

Result:

```ts
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

Every failure is non-retryable at this boundary. A fresh caller decision may
send a later message, but the transport must not automatically replay a strict
steer into a different turn when the original injection effect is uncertain.

acpx provisional owner request:

```ts
{
  type: "steer_prompt";
  requestId: string;
  ownerGeneration?: number;
  text: string;
  clientMessageId: string;
  timeoutMs?: number;
}
```

The final response is the adapter result above. Any earlier `accepted` frame is
only queue-owner IPC admission and is not a delivery ACK.

## Required Invariants

- The adapter resolves `{threadId, activeTurnId, turnKind}` immediately before
  `turn/steer` and accepts only a regular steerable turn.
- `expectedTurnId` is the observed active turn id.
- `clientUserMessageId` is the xacpx message id.
- A success response is allowed only when the provider response still refers
  to that same turn.
- Strict steering never calls ACP `session/prompt`, Codex `turn/start`, or
  `turn/interrupt`.
- acpx routes `steer_prompt` outside the normal prompt queue while retaining
  the queue-owner generation fence.
- Multiple steering requests for one owner are FIFO even though existing acpx
  control requests otherwise run concurrently.

## Error Mapping

| Condition                                                                 | Result            |
| ------------------------------------------------------------------------- | ----------------- |
| owner idle / starting / closing; no active regular turn                   | `NOT_RUNNING`     |
| strict extension absent or JSON-RPC method unsupported                    | `NOT_SUPPORTED`   |
| review, compaction, goal, or provider `ActiveTurnNotSteerable`            | `NOT_STEERABLE`   |
| expected turn mismatch or turn completes during injection                 | `TURN_RACE`       |
| socket, generation, timeout, disconnect, or unclassified provider failure | `DELIVERY_FAILED` |

Raw provider messages, socket paths, argv, credentials, and prompt content must
not become the stable public error message.

## Offline Audit Evidence

acpx:

- The queue owner creates one `sharedClient: AcpClient` and reuses it across
  queued turns.
- The active controller closes over that live client and current ACP session.
- Existing control requests bypass the prompt FIFO and keep the generation
  fence, but they do not provide steering FIFO or typed outcomes yet.

codex-acp 1.1.9:

- `CodexAppServerClient` owns the live App Server connection and already sends
  `turn/steer` with `threadId` and `expectedTurnId`.
- `CodexAcpServer` tracks `currentTurnId` and owns a per-session steering FIFO.
- The old extension's new-turn fallback, missing turn-kind/thread tracking,
  missing `clientUserMessageId`, and string-based errors are the concrete
  reasons it cannot be advertised as strict realtime steering.

## Verification Results

Baseline before spike edits:

- codex-acp: 38 test files passed, 340 tests passed, 28 skipped; typecheck
  passed.
- acpx: dependency tree restored to ACP SDK 1.3.0; focused spike baseline and
  post-change results are pending below.

### Real-Codex repetition table

Pending. The gate requires at least:

- 20 successful long regular-turn injections;
- 20 turn-completion race attempts, every outcome classified;
- two concurrent steering requests with FIFO evidence;
- idle, review, and compaction rejection evidence;
- exactly one `turn/start` and zero `turn/interrupt` for each successful run;
- user-message correlation by `clientUserMessageId`.

## Gate Decision

**Pending.** Do not enable xacpx realtime capabilities until the strict adapter
and owner prototypes pass their focused tests and the real repetition table is
complete. If any successful delivery cannot prove the same turn id, or any
failure silently starts a prompt, the decision is NO-GO and Local queue-first
remains the shipped behavior.
