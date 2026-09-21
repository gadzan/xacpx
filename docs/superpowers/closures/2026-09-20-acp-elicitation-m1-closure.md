# ACP Elicitation M1 — Core Foundation Closure Report

```text
Milestone: M1 Core Foundation
Base:      e98cb68e (main, "feat(relay-web): sticky agent avatar with working quip chip and unified send/cancel (#353)")
Head:      uncommitted working tree (no PR yet)
PR:        —
```

## Implemented

- `src/interactions/turn-interaction-registry.ts` — shared exact-turn
  registry (`bindTurn` / `resolve` / `subscribeAbort` / `clear`). Permission
  and Elicitation resolve one opaque `interactionId` through it without
  sharing business semantics (G2/G3).
- `src/permissions/permission-interaction-broker.ts` — refactored onto the
  shared registry via constructor injection; route liveness now delegated to
  `TurnInteractionRegistry`. No behavior change (verified by the existing
  permission suite).
- `src/bridge/engine/runtime/runtime-adapter.ts` — explicit elicitation
  boundary: `XacpxElicitationContext { requestId, signal }`,
  `XacpxElicitationResponse = accept | decline | cancel`, two explicit mappers
  (`toXacpxRequestId`, `toUpstreamElicitationResponse`). Removed
  `as unknown as AcpElicitationHandler`. `elicitationModes` is now a
  configurable input; empty ⇒ no ACP capability advertised.
- `src/bridge/engine/runtime/runtime-worker-protocol.ts` —
  `RuntimeWorkerElicitationRequestPayload { logicalSessionId, sessionKey,
  promptRequestId, elicitationRequestId, interactionId?, acpRequestId,
  request, workerGeneration }` and `RuntimeElicitationDecision`
  (`accept`/`decline`/`cancel`). Removed `policyGeneration`, `mode`,
  `message`, `elicitationId`, `submit`, and the `elicitation.cancel` method.
- `src/bridge/engine/runtime/runtime-worker-main.ts` — handler signature
  `(request, { requestId, signal })`, `randomUUID()` correlation ids,
  125s watchdog (was 30s), abort/deadline fencing, generation + promptRequestId
  fencing on decision.
- `src/bridge/engine/runtime/runtime-worker-client.ts` — decision type guard,
  `elicitationTimeoutMs` dep (default 125s).
- `src/bridge/engine/runtime-engine.ts` — `onElicitationRequest` typed against
  the new payload/decision; `elicitationInteractionCapable` drives
  `elicitationModes` in ensure params; `elicitationRequestTimeoutMs`.
- `src/bridge/bridge-main.ts` — daemon RPC typed, 125s watchdog, new
  `BRIDGE_ELICITATION_FORM_CAPABLE` env read.
- `src/transport/acpx-bridge/acpx-bridge-protocol.ts` — new
  `ResolveElicitationRequestParams` + strict decoder (rejects missing
  correlation fields and legacy shapes).
- `src/transport/acpx-bridge/acpx-bridge-client.ts` — `elicitationFormCapable`
  option; `XACPX_BRIDGE_ELICITATION_FORM_CAPABLE` always explicit ("0"/"1")
  so inherited env cannot enable it.
- `src/interactions/elicitation-types.ts` — plugin-facing
  `ChannelElicitationField` union, `ChannelElicitationRequest`,
  `ChannelElicitationDecision`, `ChannelElicitationMode`.
- `src/interactions/elicitation-schema.ts` — strict ACP form normalizer +
  answer validator with resource bounds; agent `pattern` preserved as display
  metadata only (never executed).
- `src/interactions/elicitation-interaction-broker.ts` — fail-closed broker:
  exact-turn ownership, origin check, initiator identity, truthful channel
  capability, responder re-verification, answer validation, first-terminal
  wins, timeout/abort/shutdown cancel, metadata-only logging.
- `src/channels/types.ts` / `src/channels/channel-registry.ts` — additive
  `requestElicitation?` + `elicitationModes?`, plus
  `hasElicitationInteractionCapability()` and `supportedElicitationModes()`
  probes (declared AND implemented).
- `src/plugin-api.ts` — exports the elicitation plugin contract.
- `src/main.ts` — broker construction sharing the permission registry, real
  `resolveElicitationRequest` dispatch (replaces hard-coded `{ action:
  "cancel" }`), capability probe, shutdown aborts pending requests.
- `src/commands/handlers/session-handler.ts` — binds the turn context into
  both brokers at prompt dispatch.

## Invariants proven

- G1 — no `ask_user` tool added; everything flows through ACP
  `elicitation/create`.
- G2 — exact-turn ownership: no `interactionId` / unknown id / disposed route ⇒
  cancel with zero channel UI.
- G3 — shared registry, independent semantics: permission suite unchanged;
  broker tests assert separate pending sets and terminal actions.
- G4 — `accept` ≠ `decline` ≠ `cancel` end-to-end; timeout/abort/shutdown/
  unsupported channel/invalid schema/invalid answer/plugin throw/wrong
  responder/stale race all ⇒ `cancel`; only explicit user refusal ⇒ `decline`.
- G5 — `scheduled` / `peer` / `orchestration` origins cancel without UI and
  are never upgraded.
- G6/G7 — no Relay/Conversation contract touched; `permissionChatKey`
  untouched; generalization happens only after route resolution.
- G8 — sentinel-answer tests prove answers never reach logs on either the
  accept path or the rejection paths (invalid answer, throwing renderer,
  unexpected key). Broker logs field count/kinds/duration only; validator
  reasons carry field keys and stable codes, never values; channel errors are
  logged by `errorType`, never by message.
- G9 — capability advertised only when the SAME channel both declares `form`
  and implements `requestElicitation` (`hasElicitationFormCapability()`);
  bridge env always explicit.
- G10 — `url` never advertised (mode list is `["form"]` only).
- G11 — runtime engine only; no CLI stdout parsing.
- G12 — unsupported channels cancel; no "next message wins".

## Tests

New (all green):

- `tests/unit/interactions/turn-interaction-registry.test.ts` — 13 tests
- `tests/unit/interactions/elicitation-schema.test.ts` — 55 tests
  (40 original + 7 string-resource-bound + 8 calendar/RFC3339)
- `tests/unit/interactions/elicitation-interaction-broker.test.ts` — 31 tests
  (28 original + 3 negative-privacy regressions)
- `tests/unit/channels/channel-elicitation-capability.test.ts` — 9 tests
  (6 original + 3 mode-aware capability regressions)
- `tests/unit/bridge/engine/runtime/runtime-adapter-elicitation.test.ts` —
  4 tests, real acpx runtime + mock ACP agent (`elicitation/create`,
  requestId/signal preservation, three-action mapping, no-mode advertisement)
- migrated `runtime-permission-interactive.test.ts` (3 tests) and
  `acpx-bridge-client.test.ts` / `bridge-protocol.test.ts` to the new protocol

Regression evidence (all numbers with the corrected acpx 0.16.0 install):

- `npx tsc --noEmit` — **0 errors** (was 1 pre-existing error caused by a
  stale 0.13.1 `node_modules/acpx`; fixed by `bun install --frozen-lockfile`).
- Permission broker suite: 27/27 pass (unchanged behavior).
- `runtime-permission-interactive.test.ts`: 11/12 pass; the single failure
  (`PR9-A E2E: escalate policy…`) reproduces identically on clean `src/` —
  pre-existing, unrelated.
- `runtime-adapter.test.ts`: 4/5 pass; the single failure (Windows EBUSY
  during temp-dir cleanup) reproduces identically on clean `src/`.
- Full unit suite (537 files): **M1 484 pass / 53 fail**, baseline
  (clean `src/`, same acpx) **479 pass / 58 fail**. A set-diff of the failing
  files shows **zero new failures**; the only delta is my 5 new test files,
  which pass.

## Review round 1 (PR #355)

Four findings from review of head `5e606f7d`, all fixed:

1. **[Blocking, G9]** `hasElicitationInteractionCapability()` was an
   existential method probe, so a channel implementing `requestElicitation`
   without declaring `form` (or declaring only `url`) still made ACP advertise
   form support — then the broker cancelled on its own mode check. Replaced
   with `hasElicitationFormCapability() =
   supportedElicitationModes().includes("form")`. 3 regression tests added.
2. **[Blocking, G8]** Answer values leaked on error paths: the validator
   echoed the rejected value in its reason and the broker logged it verbatim;
   the broker also logged `error.message`, which a renderer could fill with
   submitted form values. Validator reasons now carry field keys and stable
   codes only (unexpected keys by index), and the broker logs `errorType`
   instead of the message. 3 negative-privacy regression tests added.
3. **[Medium]** String resource bounds were incomplete: array element length,
   text `default` length and `required[]` size were unbounded. Added
   `maxOptionValueLength`, `maxDefaultValueLength`, `maxRequiredNames` and a
   total `maxNormalizedFormChars` budget (49k, just above the measured ~48.5k
   worst case). 7 tests added.
4. **[Medium]** `date` / `date-time` accepted impossible values because
   `Date.parse` normalizes 2026-02-31 into 2026-03-03, and the date-time regex
   accepted incomplete RFC3339. Replaced with a strict per-month calendar
   check (leap-year aware) and a full RFC3339 pattern requiring seconds plus a
   `Z`/±HH:MM offset, with clock/offset range checks. 8 tests added.

Note: finding 2 corrected an overstated G8 claim in the first version of this
report — the original privacy test only covered the legal-accept path, which is
why it did not catch the leak.

## Deferred

- No production channel renderer (M2 Discord, M4 Feishu).
- M3 Relay Web + Conversation integration — **blocked on PR #350** (still
  open, not merged).
- `url`-mode elicitation (G10).
- No doc updates yet (M5 owns Runtime-vs-CLI documentation).

## Known risks

- `node_modules/acpx` was 0.13.1 while `package.json`/`bun.lock` pin 0.16.0,
  which produced a pre-existing `tsc --noEmit` failure
  (`runtime-adapter.ts: processLifecycle`) and 3 pre-existing
  `runtime-adapter.test.ts` failures on clean `main`. Re-running
  `bun install --frozen-lockfile` fixed the drift: **typecheck is now fully
  clean (0 errors)** and only 1 pre-existing EBUSY cleanup failure remains.
- Worker-side watchdog is 125s while the broker business deadline is 120s;
  tests only assert the ordering invariant, not a live 120s wait.
- Remaining full-suite failures (53 files) are identical to the `main`
  baseline — Windows/POSIX path tests, real-process suites, and
  parallel-load flakiness (`channel-relay` passes 3/3 in isolation).

## Next milestone readiness

```text
Next milestone readiness: READY
```

Blocking dependency:

- None for M2 (Discord). The pre-existing `tsc` blocker is resolved by the
  dependency reinstall.
- M3 remains blocked on PR #350 (still open).
