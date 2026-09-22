# ACP Elicitation M1 — Core Foundation Closure Report

```text
Milestone: M1 Core Foundation
Base:      e98cb68e (main, "feat(relay-web): sticky agent avatar with working quip chip and unified send/cancel (#353)")
Head:      5fe0e832f8900bffa171b72b11adcc0d2bb7c2d3 + round-20 fixes (post-review)
PR:        #355 "feat(elicitation): ACP Elicitation M1 core foundation" (OPEN, mergeable)
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
  `message`, `elicitationId`, `submit`, and the original `elicitation.cancel`
  method. **A request-scoped `elicitation.cancel` was added back in review
  round 12** (M1 as-first-shipped had none), so an agent's
  `$/cancel_request` propagates instead of leaving the renderer live until the
  120s deadline; see "Review round 12" below.
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
- `tests/unit/interactions/elicitation-schema.test.ts` — 65 tests
  (40 original + 7 string-resource-bound + 8 calendar/RFC3339 + 10 ACP-shape
  and constraint-preservation regressions)
- `tests/unit/interactions/elicitation-interaction-broker.test.ts` — 31 tests
  (28 original + 3 negative-privacy regressions)
- `tests/unit/interactions/elicitation-plugin-contract.test.ts` — 5 tests,
  typed against the published `plugin-api` surface
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
   total `maxNormalizedFormChars` budget. 7 tests.
4. **[Medium]** `date` / `date-time` accepted impossible values because
   `Date.parse` normalizes 2026-02-31 into 2026-03-03, and the date-time regex
   accepted incomplete RFC3339. Replaced with a strict per-month calendar
   check (leap-year aware) and a full RFC3339 pattern requiring seconds plus a
   `Z`/±HH:MM offset, with clock/offset range checks. 8 tests.

Note: finding 2 corrected an overstated G8 claim in the first version of this
report — the original privacy test only covered the legal-accept path, which is
why it did not catch the leak.

## Review round 2 (PR #355, head `d7b26cac`)

Four further findings, all fixed:

1. **[Blocking, ACP protocol]** The normalizer required `items.type` before
   reading `items.anyOf`, but ACP defines multi-select items as a union whose
   titled member has **no `type` field** (`TitledMultiSelectItems` is
   `{ anyOf: [...] }`). Every legal titled multi-select was therefore
   cancelled. Decoding is now by union member: `anyOf` needs no `type`, `enum`
   requires `type === "string"`, mixing is rejected, neither is rejected. The
   prior test used the non-standard `{ type: "string", anyOf: [...] }` shape,
   which hid the defect.
2. **[Blocking, validation correctness]** Converting a string field with
   `enum`/`oneOf` to `single-select` dropped `minLength`/`maxLength`/`format`,
   so an offered value violating the agent's own schema was accepted. The
   field model now carries them and `validateFieldValue` re-validates. Unlike
   `pattern` (never executed, by design), these are deterministic.
3. **[Medium, budget claim retracted]** The `maxNormalizedFormChars: 49_000`
   "just above every individually-legal form" claim was **wrong** — it omitted
   options. Per-field limits compose multiplicatively: 20 fields × 100 titled
   options × (256 value + 256 label + 1000 description) ≈ **3.3M chars**, all
   individually legal. The cap is therefore documented and tested as an
   independent aggregate policy cap (256k), not a worst-case bound; a
   pathological aggregate cancels and a realistic multi-option form passes.
   The titled/untitled option value bound was also unified at 256
   (`readTitledOptions` had been using `maxFieldKeyLength` = 128).
4. **[Medium, plugin contract]** The exported accept arm required a non-null
   `content`, while core's own broker and runtime decision permit `null`.
   `content` is now `Record<...> | null` and optional, and
   `elicitation-plugin-contract.test.ts` compiles its fake channel against the
   published `src/plugin-api.js` surface so future divergence fails typecheck.

## Review round 3 (PR #355, head `b2b1d799`)

Four further findings, all fixed:

1. **[Blocking, trust boundary]** The broker handed the renderer the same
   mutable object graph it validated answers against. A renderer pushing an
   option, clearing `required`, or relaxing `minLength` silently changed core's
   validation truth — no malice required, only in-place UI tidying. The broker
   now keeps a private validation snapshot and hands out a separately cloned,
   recursively frozen presentation copy; the validator clones multi-select
   arrays. 5 tamper regressions.
2. **[Blocking, prototype keys]** `name in propertiesRecord` let
   `required: ["toString"]` pass with no such property; `source[field.key]`
   made an optional `toString` field read the inherited function as a
   submitted value; `out["__proto__"] = v` is a prototype setter, so a legal
   answer could vanish. ACP property names are not restricted away from JS
   special keys, so this is protocol correctness. `Object.hasOwn` for presence,
   `defineProperty` on a null-prototype dictionary for output. 7 tests.
3. **[Medium, fidelity]** ACP schema-level `title`/`description` were dropped,
   and `pattern` was dropped by the enum→single-select conversion — both
   permanently unrenderable because plugins never see the raw ACP object. Both
   are now bounded and carried through. 4 tests.
4. **[Medium, fail-closed]** ACP `EnumOption` requires `const` AND `title`, but
   the reader treated `title` as optional and fell back to `label: value`,
   auto-repairing a malformed option into a label the agent never chose.
   `title` is now required and bounded; missing/empty fails closed. 2 tests.

## Final test totals

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 77 |
| `elicitation-interaction-broker.test.ts` | 36 |
| `elicitation-plugin-contract.test.ts` | 5 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |

Total new: **144**. M1 unit suites 277/277 green; real-acpx E2E 15/16 (the one
failure is the pre-existing `PR9-A E2E`, reproduced on clean `src/`);
`npx tsc --noEmit` 0 errors.

## Review round 4 (PR #355, head `4083a2b7`)

Five further findings, all fixed:

1. **[Blocking, G8]** Round 1 replaced `error.message` with
   `error.constructor.name`, which is itself renderer-controlled: an overriding
   `constructor` property keeps `instanceof Error` true while the name is an
   arbitrary string (the submitted answer), and a throwing getter made the
   broker's own catch handler throw. Both sites now record the fixed literal
   `"Error"`. 2 regressions.
2. **[Blocking, ACP forward compatibility]** Multi-select decoding branched on
   `enum`/`anyOf` presence and only checked `items.type` on the enum path, so
   `{ type: "_future", anyOf: [...] }` and even `{ type: "string", anyOf: [...] }`
   took the titled path. ACP defines `MultiSelectItems` as a tagged union where
   a present `type` means a typed variant: `"string"` requires `enum`, any
   other value is a future variant a client must not render as string
   multi-select, and only the typeless `{ anyOf }` member is titled. Decoding
   is now by tag. 5 regressions, and the round 2 test that blessed the
   non-standard shape is corrected.
3. **[Medium, resource cap]** Round 3's `schemaTitle`/`schemaDescription` and
   single-select `pattern` were not counted in the aggregate cap, making its
   "every string" claim false a second time (~11.5k of undercount). Both are
   now measured. 2 regressions.
4. **[Medium, plugin API]** `ChannelElicitationRequest` advertised a mutable
   graph while the broker delivers a recursively frozen one, so
   `request.fields.sort()` would pass tsc and throw in production. The
   published contract is now deeply readonly, and the contract test pins both
   halves — each mutation is a `@ts-expect-error` AND asserted to throw.
5. **[Medium, resource boundary]** Accepted answers had no core-owned size
   bound: `maxLength` is optional and agent-supplied, so a channel could
   return unbounded free text that core accepted and copied daemon → bridge →
   worker → ACP. Added `maxAcceptedAnswerChars` (64k) enforced on the aggregate
   of key + value lengths. 4 regressions.

## Final totals after round 4

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 88 |
| `elicitation-interaction-broker.test.ts` | 38 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |

Total new: **158**. M1 unit suites 291/291 green; real-acpx E2E 15/16 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Review round 5 (PR #355, head `512e9f36`)

Five further findings, all fixed:

1. **[Blocking, validation bypass]** `decision.content` was read twice — once to
   validate, once to decide the accept shape. A getter returning a valid
   required answer then `null` produced `{ action: "accept", content: null }`
   for a form core had just approved. `action`/`responderId`/`content` are now
   each snapshotted exactly once into locals, and `isPlainDecision()` rejects
   accessors outright. 3 regressions.
2. **[Blocking, JSON Schema semantics]** `minLength`/`maxLength` compared JS
   UTF-16 code units, so `{ minLength: 2 }` accepted `"😀"` (2 units, 1 code
   point) and `{ maxLength: 1 }` rejected it — core accepting answers the
   agent's own schema rejects. Now measured in code points for text and
   single-select. 3 regressions.
3. **[Medium, pending leak]** `error instanceof Error` invokes a Proxy's
   `[[GetPrototypeOf]]`, so a throwing trap escaped the catch handler, skipped
   `unsubscribeTurnAbort()`/`settleStale()`, and leaked the pending map entry
   forever (turn dispose marks settled but never deletes). Both sites now read
   nothing from the thrown value and log the fixed literal `"thrown"`.
   Regression asserts cancel **and** `pendingCount === 0`.
4. **[Medium, SDK divergence]** "required string" was implemented as "required
   non-empty string". The pinned SDK models these as plain `z.string()` with no
   `.min(1)`, so `title: ""`, `pattern: ""` and `description: ""` are
   protocol-valid and were being cancelled — and a round 3 test had pinned the
   deviation. Missing still fails closed; present-but-empty is accepted. 3
   regressions.
5. **[Medium, log amplification]** Several failure branches interpolated
   agent-controlled strings (property keys, item types, modes, required names)
   into reasons that reach the logger verbatim through a bare
   `JSON.stringify`. Upstream's ACP message ceiling is 64 MiB. All such
   interpolations now go through `boundedKeyLabel()` (64-char prefix + length),
   and required names are bounded before lookup. 3 regressions.

## Final totals after round 5

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 103 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |

Total new: **176**. M1 unit suites 301/301 green; real-acpx E2E 15/16 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Review round 6 (PR #355, head `635e2031`)

Three further findings, all fixed:

1. **[Blocking, ACP user safety]** The renderer had no trusted "which Agent is
   asking" identity. ACP's User Interaction Requirements oblige the client to
   clearly identify the requesting Agent, and the public `agent` field was
   optional and never populated in production — so an M2 renderer would have
   had to resolve it from `chatKey`, which is the forbidden latest-session
   pattern (session selection changes mid-turn; concurrent turns make
   "current" ambiguous), or from agent-controlled `message`/`title` text, which
   is not identity. The agent name is now pinned to the runtime worker's ensure
   identity and carried worker → bridge → broker → `ChannelElicitationRequest`,
   where `agent.name` is REQUIRED. Absent ⇒ cancel with no UI. 4 regressions.
2. **[Blocking, format semantics]** `email` was
   `^[^\s@]+@[^\s@]+\.[^\s@]+$` (accepts `é@example.com`, `a..b@example.com`)
   and `uri` was `new URL()` (WHATWG, accepts IRIs and normalizes `%zz`). Since
   this PR chose to execute `format`, it must match the referenced semantics:
   RFC 5321 for `email`, RFC 3986 for `uri`. Replaced with structural parsers,
   plus strict percent-encoding validation. 9 regressions.
3. **[Medium, worker lifecycle]** A successful elicitation left its 125s
   watchdog timer and abort listener alive until expiry — unref'd, so it could
   not block exit, but a deterministic short-term leak that accumulates across
   elicitations in one long turn. The `finally` now clears the timeout, and the
   hardcoded `125_000` is replaced by the shared `ELICITATION_RPC_TIMEOUT_MS`.

### CI status for round 6

Workflow run `35565795747` (head `635e2031`) failed `terminal-windows` at
`windows-process-tree.test.ts:177` (`query-failed` vs `killed`). The 4 failing
tests reproduce **identically on clean `src/`**, so they are pre-existing
Windows real-process environment failures, not a regression from this branch.
Rerun requested; the diff from `512e9f36 → 635e2031` touches only elicitation
code.

## Final totals after round 6

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 101 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |

Total new: **174**. M1 unit suites 311/311 green; real-acpx E2E 15/16 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Review round 7 (PR #355, head `8a4be1e7`)

Three further findings, all fixed:

1. **[Blocking, identity semantics]** Round 6 made `agent.name` trusted but
   carried `ensureParams.agent`, which is `input.acpxAgent ?? input.agent` —
   the *transport selector*, not the user's Agent. `acpxAgent` is documented as
   the acpx positional agent / managed overlay alias, and structured launches
   generate `xacpx-managed-codex-9d1628a76ca9`. Displaying that prominently
   would show a user an internal selector and hash, failing the actual purpose
   of ACP's "clearly identify the Agent" requirement. The user-facing alias now
   travels on `RuntimeWorkerPromptParams.requestingAgentName` (deliberately NOT
   the construction identity, since a worker is reused across sessions with
   different aliases and a config change would show a stale name). Regression
   is a RuntimeEngine + real-worker test with
   `agent: "user-alias", acpxAgent: "xacpx-managed-..."`.
2. **[Blocking, format semantics]** Rounds 5-7 hand-rolled `email`/`uri` three
   times, each fixing one direction and breaking another. The JSON Schema spec
   recommends a well-known library over an ad-hoc approximation, so
   `ajv-formats` is now a direct dependency and the reference validator. Its
   deviations from the strictest RFC reading (quoted local part,
   address-literal domain, single-label domain, email length limit, empty URI
   authority, non-numeric port) are documented at the validator and pinned by
   tests. RFC3339 `date-time` also fixed: `T`/`Z` are case-insensitive, and
   `:60` is only valid as a real leap-second instant.
3. **[Medium, round 6 incomplete]** The abort listener was defined inside the
   Promise executor, so only the abort path removed it — round 6 cleared the
   timer but not the listener. Hoisted out and removed unconditionally in
   `finally`; a counting-signal harness asserts add/remove balance across
   repeated successful elicitations.

## Final totals after round 7

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 109 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 3 |

Total new: **188**. M1 unit suites 319/319 green; real-acpx E2E 18/19 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Review round 8 (PR #355, head `a9146440`)

Three further findings, all fixed:

1. **[Blocking, resource trust boundary]** The 64k answer cap ran *after*
   `validateFieldValue`, so a renderer could return a multi-megabyte
   `email`/`uri` string and core would hand it to the Ajv format validator
   first — Ajv documents ReDoS/unsafe-regex as a risk on untrusted input — and
   an oversized multi-select array was fully traversed, hashed and
   membership-checked before the cap rejected it. A cheap raw preflight now
   runs first, using the 100-entry `options` cap to reject impossible arrays
   with one comparison. 4 regressions, including one asserting the rejection
   reason is the size limit rather than a format error.
2. **[Blocking, RFC3339 correctness]** The leap-second table wrongly listed
   1973-06-30 .. 1979-06-30 (RFC 3339 Appendix D puts those on December 31), so
   `1973-06-30T23:59:60Z` — an instant that never existed — was accepted. The
   code also required a `Z` offset, rejecting the RFC's own example
   `1990-12-31T15:59:60-08:00`. The local wall clock is now normalised to UTC
   before the date lookup. 6 regressions covering both directions.
3. **[Medium, regression evidence]** The listener-balance suite created its own
   signal and called add/remove itself, so it proved the Web API balances
   rather than that the worker cleans up. Verified by mutation: deleting the
   worker's cleanup left it green. `bindElicitationAbort()` is now a seam both
   sides share, and the suite drives it directly plus a structural guard.
   Re-verified by mutation in both directions (no-op `release()` fails 2
   tests; removing the worker's `abort.release()` fails the guard).

## Final totals after round 8

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 115 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |

Total new: **197**. M1 unit suites 325/325 green; real-acpx E2E 24/25 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

### Regression-quality note

Round 8 finding 3 was the first finding about the *evidence* rather than the
code, and it was correct: a test that re-implements the behaviour it claims to
verify is not a regression test. Where a suite now makes a claim, that claim
has been checked by mutating the code it covers and confirming the suite fails.

## Review round 9 / final adversarial pass (head `8c39d7c7`)

Four further findings, all fixed and mutation-verified:

1. **[Blocking, schema-validation bypass]** multi-select still had a
   validation→clone TOCTOU: `validateFieldValue` reads the renderer's array
   several times, then `[...validated.value]` reads it again for output. Index
   getters could return a legal option during validation and an unvalidated
   value — or a multi-MB string that also bypasses the answer cap — at clone
   time. Arrays are now canonicalised into a core-owned snapshot before any
   validation, each index read exactly once. 2 accessor regressions.
2. **[Blocking, RFC3339]** The leap-second branch returned before the offset
   range check, so `1973-01-01T23:59:60+24:00` — an invalid `time-numoffset` —
   shifted onto a real leap date and passed. Offset parsing/range validation now
   precedes the branch. 2 regressions.
3. **[Medium, bound-after-traversal]** Three inversions in the normalizer:
   `Object.entries(properties)` before the field-count check,
   `required.every` before the length check, `readTitledOptions().map` before
   the option-count check. All bound first, and the answer entry bounds key
   enumeration by the form field count.
4. **[Medium, regression evidence]** The "oversized URI proves the format
   validator was never called" test used a *syntactically valid* URI, so it
   passed even with the preflight moved back. The input is now oversized AND
   format-invalid (`%zz`), so correct order yields `core size limit` and the old
   order yields `is not a uri`.

### Mutation verification for round 9

| Mutation | Result |
|---|---|
| array canonicalisation disabled | 2 accessor tests fail |
| offset range check removed | 2 offset tests fail |
| preflight moved back after validation | oversized-URI ordering test fails |

## Final totals

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 119 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |

Total new: **201**. M1 unit suites 329/329 green; real-acpx E2E 24/25 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Review round 10 / merge-decision check (head `50b9bfc1`)

One Blocking finding: round 9's canonicalisation traversed the renderer array
*before* any length check, silently deleting round 8's O(1) admission gate. A
sparse `new Array(100_000_000)` on a 3-option multi-select forced a 100M-entry
snapshot before the option-count check could reject it. Order is now:
read `length` once → reject on a fixed core bound (`maxOptionsPerField`, plus
the field's own option count for multi-select) **before** `new Array()` →
canonicalise within the admitted bound with one read per index, bailing as soon
as the character budget is exceeded. The character-budget check moved inside the
loop so a single oversized element aborts immediately.

Regressions use sparse arrays with a counting getter on index 0 and assert
`indexReads === 0` — proof the length guard fired before traversal, which the
previous `Array.from({ length: 10_000 })` test could not show because it only
asserted the final reason. Verified by mutation: moving the length guard after
canonicalisation fails 3 tests.

## Final totals after round 10

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 122 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |

Total new: **204**. M1 unit suites 332/332 green; real-acpx E2E 24/25 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table

Every core-side boundary this PR touches has been checked by breaking the code
and confirming a test fails:

| Round | Mutation | Caught by |
|---|---|---|
| R7 | decision accessor / double read | 3 decision tests |
| R8 | no-op `abort.release()` in helper | 2 listener tests |
| R8 | worker's `abort.release()` removed | structural guard |
| R9 | array canonicalisation disabled | 2 accessor tests |
| R9 | offset range check removed | 2 offset tests |
| R9 | preflight moved after validation | oversized-URI ordering test |
| R10 | length guard moved after canonicalisation | 3 array-admission tests |

## Review round 12 / full re-sweep (head `b67c6a52`, merge commit `ed4c51f6`)

Three findings, all fixed and mutation-verified.

### 1. [Blocking] `$/cancel_request` for one elicitation now propagates end-to-end

The worker's abort handler cleared its own pending map and rejected the local
promise and did nothing else, so a withdraw of a single `elicitation/create`
left the daemon broker — and the renderer — collecting input until the 120s
deadline even though nobody would read the answer.

```text
acpx aborts context.signal
  -> worker emits `elicitation.cancel`
  -> host worker client aborts its in-flight propagation map
  -> RuntimeEngine cancels the daemon RPC (already-supported `requestDaemon(signal)`)
  -> bridge sends `cancelRpcId`
  -> daemon drops the pending bridge RPC
  -> broker aborts THIS request's controller -> renderer stops
```

The cancellation is **request-scoped, not turn-scoped**: the worker's
`elicitation.cancel` method and the new host `inflightElicitations` map both
carry `promptRequestId` + `workerGeneration` fencing exactly like the decision
path, and the turn route stays bound so an agent can withdraw one question and
ask another.

A real-acpx E2E test drives this with a mock ACP agent that asks twice per turn
and withdraws only the first question (JSON-RPC `$/cancel_request`). The host
handler receives q1 with a live propagation that then aborts — it loses a race
against its own 2s hold — and q2 still reaches and is answered. The mock takes
the cancel via a delayed `setTimeout`, not the same write batch, because acpx
dispatches the handler synchronously from the JSON-RPC callback and a
same-batch notification would cancel the request before the host ever saw it
(which is a different, non-buggy path).

### 2. [Blocking] Two-digit years cannot borrow a real leap date

`toUtcLeapInstant` used `Date.UTC(y, m - 1, d + dayShift)`. That constructor
maps years 0..99 onto 1900+, so `0072-06-30T23:59:60Z` was evaluated as the
**1972-06-30** leap date and wrongly accepted. Replaced with Howard Hinnant's
proleptic-Gregorian day-number arithmetic (`daysFromCivil` / `civilFromDays`),
plus an explicit `y < 1972` guard since no leap second exists before the first.

The regression proves the original bug: reverting to `Date.UTC` while **keeping**
the `y < 1972` guard still passes, so only restoring the full pre-fix state
kills the tests — that mutation fails 2 tests.

### 3. [Medium] `default` is an annotation, not a validity constraint

Per JSON Schema vocabulary and ACP's pre-fill semantics a default the form
cannot safely pre-fill must not reject the form. Previously all of these
produced `malformed_schema`:

- enum/single-select default not among the offered options;
- numeric default outside `minimum`/`maximum`;
- non-string default for a text field (and non-boolean for a boolean field);
- default longer than `maxDefaultValueLength`;
- multi-select default with duplicates or non-offered entries.

They are now dropped (multi-select is filtered to the legal, deduplicated
subset), the form still renders, and the human's answer is validated against
`enum`/`pattern`/`minLength`/etc. exactly as before. Four existing tests pinned
the rejection and were **replaced** with annotation-semantics tests; a new test
asserts legal defaults still carry through so the fix is not "drop everything".

### Non-blocking item also fixed

`src/main.ts` still carried the round-7 "ensure identity" comment on
`agentName`. The code was already correct; the comment now matches and names the
round-7 finding so it cannot be reintroduced by a reader.

## Review round 13 / full re-sweep (head `32955049`, merge commit `4098fbaa`)

0 Blocking, 2 Medium. Both Mediums fixed.

### 1. [Medium] The published plugin contract was missing two ACP MUSTs

ACP's User Interaction Requirements (`docs/rfds/elicitation.mdx`) say a form
client MUST provide clear decline **and** cancel controls, and MUST let users
review and modify responses before sending. `requestElicitation`'s MUST list in
`src/interactions/elicitation-types.ts` and `src/channels/types.ts` had neither,
so a renderer could comply with xacpx's published contract and still violate
ACP — and M1 is the foundation every later renderer builds on.

The contract now states, as core-enforced-in-contract (not core-enforceable):

- expose clear, **separate** Decline and Cancel controls (ACP MUST);
- allow review and modification of responses before Accept (ACP MUST);
- present `request.message` (ACP SHOULD);
- display `request.agent.name`, never substitute agent text for identity.

Terminal-action origin is now explicit, because the old wording
("settle ... on `signal` abort by returning `{ action: "cancel", responderId }`")
was **unsatisfiable**: agent `$/cancel_request`, timeout, turn disposal and
shutdown have no responder. Core owns those paths (round 12's request-scoped
cancellation), so the renderer's contract on abort is to withdraw/disable its UI
immediately and stop collecting input — not to fabricate an identity.

Also corrected the header comment: the runtime freeze covers the **form
presentation graph** (`fields`, `options`, multi-select `defaultValue`), not the
request wrapper (`requester`/`agent`/`signal`). Authentication reads core's
private route, so the wrapper adds nothing when frozen.

### 2. [Medium] `package-lock.json` still classified Ajv as a peer dependency

Round 11 added `ajv`/`ajv-formats` as root direct dependencies but deliberately
surgical-edited the lock because local npm **10.9.3** also flipped ~13 unrelated
`peer: true` flags. That left `"node_modules/ajv": { peer: true }` inconsistent
with a root production edge.

Regenerated with `npx npm@11` (CI runs Node 24, which ships npm 11) instead of
hand-editing. The diff is **only** 24 `peer: true` flag removals and 5
`optional`/`version` key-order changes — verified programmatically that the lock
is identical once `peer`/`optional` are normalised, and `npm ci --dry-run`
installs cleanly. If a future npm major changes more than flags, the answer is
to pin the lockfile-generating npm version, not to keep a known-wrong flag.

### Also fixed (non-blocking cleanups from the same sweep)

- **Unified pre-fill policy.** `default` is dropped when the field's own
  constraints would reject it (`minLength`, `maxLength`, `format`), so a
  renderer can never show a value core is guaranteed to reject if the user
  submits it unchanged. Previously `{minLength: 3, default: "x"}` passed "x"
  through while the multi-select path already filtered. `pattern` is
  deliberately NOT enforced here — core never executes agent regex
  (resource-exhaustion vector, same reason `validateFieldValue` does not).
- Closure report header updated from "uncommitted working tree (no PR yet)" to
  the real PR #355 + head, and the early "removed `elicitation.cancel`" note now
  cross-references its round-12 reintroduction instead of contradicting it.
- PR body test count 207 → 215.

### Deferred to M2

- Reusable timeout constants (`ELICITATION_RPC_TIMEOUT_MS`) still live in the
  broker module, which drags `elicitation-schema.ts` → Ajv into the runtime
  worker's import graph. Moving them to a lightweight constants/protocol module
  is a mechanical cleanup with no behaviour change; deferred because it needs
  real memory/startup measurements to justify.

## Final totals after round 13

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 130 |
| `elicitation-interaction-broker.test.ts` | 49 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `acpx-bridge-client.test.ts` | 47 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |
| `runtime-elicitation-cancel-e2e.test.ts` (real acpx) | 1 |

Total new: **215**. M1 unit suites 347/347 green; real-acpx E2E 25/26 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table

| Round | Mutation | Caught by |
|---|---|---|
| R7 | decision accessor / double read | 3 decision tests |
| R8 | no-op `abort.release()` in helper | 2 listener tests |
| R8 | worker's `abort.release()` removed | structural guard |
| R9 | array canonicalisation disabled | 2 accessor tests |
| R9 | offset range check removed | 2 offset tests |
| R9 | preflight moved after validation | oversized-URI ordering test |
| R10 | length guard moved after canonicalisation | 3 array-admission tests |
| R11 | `typeof length === "number"` guard removed | 2 proxy-length tests |
| R11 | tombstone split removed | retention regression |
| R12 | broker `cancelElicitationRequest` disabled | 2 broker tests |
| R12 | broker external-signal chaining removed | 1 broker test |
| R12 | worker `elicitation.cancel` frame removed | cancel E2E (2/2 runs) |
| R12 | string default rejection restored | 3 schema tests |
| R12 | multi-select default filter removed | 1 schema test |
| R12 | `Date.UTC` leap-date mapping restored | 2 leap tests |
| R13 | pre-fill policy relaxed to size-only | prefill regression |

## Final totals after round 12

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 129 |
| `elicitation-interaction-broker.test.ts` | 49 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `acpx-bridge-client.test.ts` | 47 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |
| `runtime-elicitation-cancel-e2e.test.ts` (real acpx) | 1 |

Total new: **213**. M1 unit suites 345/345 green; real-acpx E2E 25/26 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Review round 11 / full re-sweep (head `879ef13b`, merge commit `ed4c51f6`)

One Blocking and one Medium, both fixed and mutation-verified.

### 1. [Blocking] A Proxy `length` defeated the round 10 admission gate

Reading the property once is not the same as snapshotting its semantics.
`Array.isArray` accepts a Proxy, and a Proxy `get("length")` trap can return an
object whose `valueOf()` re-runs on every numeric coercion — and `length` is
coerced by the two `>` admission checks, by `new Array(length)` and by the loop
condition. Returning `1` for admission and `100_000_000` afterwards rebuilt
exactly the traversal rounds 9 and 10 removed.

`length` is now reduced to a canonical primitive before any coercion:

```ts
if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
  return { ok: false, reason: "accepted answer exceeds the core size limit" };
}
```

and only that primitive is used afterwards. Regressions use Proxy-wrapped
arrays with a counting `valueOf()` and assert `valueOfCalls === 0` **and**
`indexReads === 0`, so removing the `typeof length === "number"` guard kills the
test rather than merely changing the error reason.

### 2. [Medium] The bridge replay cache retained elicitation answers

The generic `completedBridgeResponses` Map stored the full encoded response for
every bridge-originated RPC. A successful `resolveElicitationRequest` response
is the user's answer, so the answer bytes stayed alive in a long-lived daemon
Map until 256 later RPCs or a bridge disconnect evicted them — a retention path
outside the broker's privacy contract.

Duplicate suppression and response replay are now separate. Sensitive methods
keep an rpcId **tombstone** (`replayable: false`) and fail closed on a repeat
with `BRIDGE_RPC_CANCELED`, rather than replaying the answer or re-running the
renderer (which would re-prompt the user). Non-sensitive methods replay their
exact encoded response, preserving idempotence. Verified by mutation: removing
the tombstone split fails the retention regression.

### Non-blocking items from the same sweep

- **Unknown string `format`**: see Deferred — ACP RFD says unknown `format` is
  an annotation, but pinned SDK 1.4.0 narrows to the four known formats upstream,
  so no failing input is reachable today. Recorded as SDK-upgrade debt with the
  required test shape.
- **`package-lock.json`**: root direct-dependency metadata now includes `ajv` /
  `ajv-formats`. `npm ci` was unaffected (both present transitively). Done as a
  surgical edit because `npm install --package-lock-only` on the local npm
  10.9.3 rewrote unrelated `peer: true` markers relative to CI's npm 11.19.0.
- **Three stale security comments**: `elicitation-interaction-broker.ts`,
  `runtime-worker-protocol.ts` and `acpx-bridge-protocol.ts` still claimed
  `agentName` came from the worker's **ensure identity**. Code was already
  correct (per-turn prompt `input.agent`); the comments are now correct too, and
  each states explicitly that ensure identity was the round 7 Blocking finding,
  so a future reader cannot "helpfully" reintroduce it.
- **PR body test count** ("91 new tests") was stale; updated.

## Final totals after round 11

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 126 |
| `elicitation-interaction-broker.test.ts` | 41 |
| `elicitation-plugin-contract.test.ts` | 6 |
| `channel-elicitation-capability.test.ts` | 9 |
| `acpx-bridge-client.test.ts` | 47 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |

Total new: **207**. M1 unit suites 334/334 green; real-acpx E2E 24/25 (the one
failure is the pre-existing `PR9-A E2E`); `npx tsc --noEmit` 0 errors.

## Deferred

- **Unknown string `format` rejection is forward-compat debt, not a merge
  blocker.** ACP RFD says unknown string `format` is an annotation and a client
  must not reject solely for it, but `normalizeFormRequest` currently rejects
  anything outside `email | uri | date | date-time` (`elicitation-schema.ts`
  string branch). The pinned `@agentclientprotocol/sdk` **1.4.0** already
  narrows `zStringFormat` to exactly those four, so such input is normally
  rejected upstream of xacpx today — which is also why no failing behaviour can
  be produced against the current dependency stack. **Must be revisited when
  the SDK is upgraded**: widen xacpx to accept-and-ignore unknown formats, and
  keep only the four known ones as validated. Tests to add at that point:
  unknown format accepted as a plain string, and a known format still
  validated.
- `package-lock.json` now records `ajv` / `ajv-formats` as direct dependencies
  (previously missing from the lock's root metadata; `npm ci` was unaffected
  because both were already present transitively).
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

## Review round 15 (head `56a82efc`) — round 14's fix REVERTED

0 new findings, but the round-14 fix itself was a **Blocking defect in its own
regression**: the `{ action: "cancel" }` withdrawal variant was unreachable on a
real abort, and its only reachable effect was a security regression.

### What round 14 actually did

A real external abort never reaches the new branch, because the `aborted`
Promise.race rejects first, and if a renderer's decision won that race the
post-decision `controller.signal.aborted` check already routes it to
`settleStale`. So the variant was only reachable on a **live** request — where
its entire effect was to let a renderer or control-path bug settle a user
`cancel` **without the authenticated responder a user dismissal must carry**.

Result: still `cancel` (fail closed), actor boundary bypassed.

### The revert

`{ action: "cancel" }` removed from `ChannelElicitationDecision`; the
`isWithdrawal` branch removed from the broker; the `withdrawn` log event gone.
The doc contradiction is fixed too — the union doc no longer says external
cancellation "never enters this union" and then instructs a renderer to return
that union's withdrawal member.

The contract is now: **external abort is not a decision.** The renderer
withdraws its UI and rejects/throws (or never settles); core's abort race and
post-decision checks settle `cancel`. Every union member requires
`responderId`, so the type itself prevents the bypass.

### The regression that now guards it

| Mutation | Result |
|---|---|
| anonymous cancel accepted again | "a cancel without a responder id is rejected on a live request" fails |
| responder-free variant re-added (type) | NOT caught — `tsconfig.json` includes only `src/**`, so `tests/` is untypechecked; documented in the test |

The runtime guard is the one that matters, and it is the one that round 14 was
missing: round 14's test asserted an outcome (`cancel`) that was identical
whether or not the fix worked. The rule the suite now follows: a regression
must fail when the fix is disabled.

## Final totals after round 15

M1 unit suites 350/350 green; real-acpx E2E 25/26 (pre-existing `PR9-A`).
No net test-count change from round 14's 219.

## Review round 16 (head `8acb7e5b`) — full re-sweep

0 Blocking, 3 Medium, 1 Low. All fixed.

### 1. [Medium] ACP-legal unknown string `format` was rejected

`elicitation-schema.ts` accepted only `email | uri | date | date-time` and
rejected everything else as `malformed_schema → cancel`. The ACP elicitation RFD
states explicitly: *"Known formats include email, uri, date and date-time. Other
string format values are annotations. Implementations MUST preserve unknown
formats"*. So `{ type: "string", format: "hostname" }` was cancelling a form the
agent legitimately described.

Any string `format` up to `maxFormatLength` (new limit) is now accepted and
**carried through verbatim**; only the four ACP-known formats are core-validated.
`ChannelElicitationField.format` widened from the four literals to `string`, with
the contract documented on the type.

Status note, so this is not over-claimed: the pinned
`@agentclientprotocol/sdk` 1.4.0's `zStringFormat` union still has the four
literals only, so a `"hostname"` reaching xacpx today would be rejected upstream
of the normalizer. The fix makes the *core* boundary correct for when the SDK
widens — it is not a live behaviour change, and the regression tests cover the
normalizer + validator directly rather than through acpx.

### 2. [Medium] Two real gaps in the round-13 pre-fill invariant

**(a) UTF-16 vs code-point.** String `default` length was checked with JS
`.length`, while the answer validator uses `codePointLength`. So
`{minLength: 2, default: "😀"}` pre-filled a value core rejects on submit, and
`{maxLength: 1, default: "😀"}` dropped a legal one. Now uses `codePointLength`,
with the reason recorded at the call site.

**(b) Multi-select `minItems`/`maxItems` were ignored.** The default filter
handled duplicates and non-offered values but not the item bounds, so
`{minItems: 2, default: ["a"]}` pre-filled a guaranteed reject. Now bounded.

Both mutations verified: reverting to `.length` fails the code-point regression;
removing the item-bound check fails the multi-select regression.

### 3. [Medium] `src/channels/types.ts` still carried the round-14 contract

Round 15 removed the responder-free variant from the authoritative union, but
`channels/types.ts` still told renderers to settle abort with
`{ action: "cancel" }` and no `responderId`, and even claimed "the type has a
dedicated variant for exactly this" — a contract that no longer existed. A
renderer built from that copy would be unimplementable again.

Synchronised to the round-15 semantics and, per the review's suggestion, the
duplicated MUST list is now explicitly marked as a *summary that must not be
restated*, with a note that a second copy of a security contract is a second copy
that can drift (it already did once).

### 4. [Low] The "compile-time" plugin-contract tests are not typechecked by CI

`tsconfig.json` includes only `src/**/*.ts`, and `npm test` uses Bun, which
transpiles without type-checking. So the `@ts-expect-error` assertions in
`elicitation-plugin-contract.test.ts` document the contract but cannot fail CI on
type drift. Not fixed here (a dedicated type-test tsconfig is the right shape and
is its own change); recorded as M2 prep. The runtime assertions in that file are
real tests and still pass.

### Non-blocking cleanups

- PR body test count synced (215 → 224).
- Closure header updated to the exact head.
- External-abort regression comment corrected: it said the renderer "THROWS",
  while the test actually settles a responder-free cancel — the comment now says
  it models the WORST CASE (a broken renderer) and asserts core still owns the
  terminal action.
- Normalizer doc no longer claims it rejects "unknown root keys" (it does not,
  by design — ACP is a versioned protocol), and explains why ignoring them is
  correct forward compatibility.

### CI: red run attributed to flake, re-run

`8acb7e5b` failed one macOS test (`G4 barrier: concurrent deletes serialize to
exactly one executor`, expected 1 fulfilled, saw 2). Evidence it is not a real
regression: the previous head `56a82efc` was green; that diff touched no
runtime-engine/delete code; the runner executes each test file in an isolated
child process, so the new elicitation tests cannot share state with it. Verified
locally on `8acb7e5b` — the test passes 3/3 in isolation. Re-run rather than
waived; if it recurs it is a genuine fence-race bug and must be investigated.

## Final totals after round 16

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 137 |
| `elicitation-interaction-broker.test.ts` | 52 |
| `elicitation-plugin-contract.test.ts` | 7 |
| `channel-elicitation-capability.test.ts` | 9 |
| `acpx-bridge-client.test.ts` | 47 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |
| `runtime-elicitation-cancel-e2e.test.ts` (real acpx) | 1 |

Total new: **224**. M1 unit suites 356/356 green; real-acpx E2E 25/26
(pre-existing `PR9-A`); `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table

| Round | Mutation | Caught by |
|---|---|---|
| R7 | decision accessor / double read | 3 decision tests |
| R8 | no-op `abort.release()` in helper | 2 listener tests |
| R8 | worker's `abort.release()` removed | structural guard |
| R9 | array canonicalisation disabled | 2 accessor tests |
| R9 | offset range check removed | 2 offset tests |
| R9 | preflight moved after validation | oversized-URI ordering test |
| R10 | length guard moved after canonicalisation | 3 array-admission tests |
| R11 | `typeof length === "number"` guard removed | 2 proxy-length tests |
| R11 | tombstone split removed | retention regression |
| R12 | broker `cancelElicitationRequest` disabled | 2 broker tests |
| R12 | broker external-signal chaining removed | 1 broker test |
| R12 | worker `elicitation.cancel` frame removed | cancel E2E (2/2 runs) |
| R12 | string default rejection restored | 3 schema tests |
| R12 | multi-select default filter removed | 1 schema test |
| R12 | `Date.UTC` leap-date mapping restored | 2 leap tests |
| R13 | pre-fill policy relaxed to size-only | prefill regression |
| R14 | withdrawal path disabled | withdrawal regression |
| R15 | anonymous cancel accepted again | responder-required regression |
| R16 | unknown `format` dropped instead of preserved | 2 format regressions |
| R16 | `.length` instead of `codePointLength` for pre-fill | code-point regression |
| R16 | multi-select `minItems`/`maxItems` removed from pre-fill | item-bound regression |

## Review round 14 (head `e48cbe93`) — SUPERSEDED BY round 15

Kept for the audit trail: the Medium/Low findings were real and their fixes
survive, but round 14's *primary* change (the responder-free withdrawal variant)
was reverted as a Blocking defect. See "Review round 15" above.

0 Blocking, 2 findings (1 Medium, 1 Low).

### 1. [Medium] The abort contract was still unimplementable in the type system

Round 13 fixed the prose but not the type: `ChannelElicitationDecision`
still forced `responderId: string` on every variant, so "withdraw your UI, then
settle without a responder" could not be written by a renderer following the
authoritative comment. M2's Discord renderer would have hit the contradiction
directly.

Added a dedicated terminal variant:

```ts
| { action: "cancel" }   // withdrawal: no user answer, so no responderId
```

Core resolves it to `cancel` — the same action its own abort race produces, so a
renderer racing core cannot change the outcome. A withdrawal carrying answer
`content` is rejected (that content would bypass the responder-identity check
every accept goes through).

**Important scope finding, recorded so it is not over-trusted:** the repo's
documented typecheck (`npx tsc --noEmit`) has `"include": ["src/**/*.ts"]`, so
`tests/` is **not** typechecked, and `bun test` does not enforce types. A
mutation re-adding `responderId` to the withdrawal variant is therefore caught
by tsc only when the test file is compiled directly. That is why the guard is
the **runtime** test asserting an observable `elicitation.interaction.withdrawn`
log event, not the type union: the first version of the test passed with the
withdrawal path fully disabled, because cancel is also the fail-closed result.
Disabling `isWithdrawal` now fails the test.

### 2. [Low] The pre-fill comment contradicted the actual policy

The round-13 comment claimed a `pattern`-violating default would be dropped,
while `patternMatches()` unconditionally returned `true` — core deliberately
never executes agent regex (resource-exhaustion vector). Runtime behaviour was
correct; only the comment and a permanently-true helper were wrong, and both
invited a future maintainer to "fix" the helper by reintroducing agent regex
execution. Comment corrected, helper deleted, call site removed.

## Final totals after round 14

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 130 |
| `elicitation-interaction-broker.test.ts` | 52 |
| `elicitation-plugin-contract.test.ts` | 7 |
| `channel-elicitation-capability.test.ts` | 9 |
| `acpx-bridge-client.test.ts` | 47 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |
| `runtime-elicitation-cancel-e2e.test.ts` (real acpx) | 1 |

Total new: **219**. M1 unit suites 350/350 green; `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table

| Round | Mutation | Caught by |
|---|---|---|
| R7 | decision accessor / double read | 3 decision tests |
| R8 | no-op `abort.release()` in helper | 2 listener tests |
| R8 | worker's `abort.release()` removed | structural guard |
| R9 | array canonicalisation disabled | 2 accessor tests |
| R9 | offset range check removed | 2 offset tests |
| R9 | preflight moved after validation | oversized-URI ordering test |
| R10 | length guard moved after canonicalisation | 3 array-admission tests |
| R11 | `typeof length === "number"` guard removed | 2 proxy-length tests |
| R11 | tombstone split removed | retention regression |
| R12 | broker `cancelElicitationRequest` disabled | 2 broker tests |
| R12 | broker external-signal chaining removed | 1 broker test |
| R12 | worker `elicitation.cancel` frame removed | cancel E2E (2/2 runs) |
| R12 | string default rejection restored | 3 schema tests |
| R12 | multi-select default filter removed | 1 schema test |
| R12 | `Date.UTC` leap-date mapping restored | 2 leap tests |
| R13 | pre-fill policy relaxed to size-only | prefill regression |
| R14 | withdrawal path (`isWithdrawal`) disabled | withdrawal regression |

**R14 additionally documents a guard that does NOT catch its mutation:** the
type-level variant removal is invisible to `npx tsc --noEmit` because the
tsconfig excludes `tests/`. Recorded in the test itself rather than left as a
silent gap.

## Review round 17 (head `860b2ade`) — protocol re-sweep

0 Blocking, 2 Medium, 2 Low. All fixed.

### 1. [Medium] Root-schema compatibility rules ran backwards

ACP's "Restricted JSON Schema" section is explicit (verified verbatim against the
RFD):

> *Senders MUST include both `type: "object"` and `properties`. For
> compatibility, ACP readers tolerate an omitted, `null`, or malformed `type` by
> treating it as `"object"`, and tolerate omitted `properties` by treating it as
> an empty map; `null` is not valid for `properties`. This reader tolerance does
> not relax the sender requirements.*

The implementation had it inverted: it rejected `type: null` and a non-string
`type` (both of which the RFD says to tolerate as `"object"`), and accepted
`properties: null` as an empty form (which the RFD calls invalid). A secondary
defect: the omitted-`properties` path early-returned, so the existing
`required`-consistency check never ran against an empty form.

Now: a non-string `type` is tolerated as `"object"`; a **string** naming a
different type is still rejected (that is a real mismatch, not a tolerated
malformation — conflating the two would accept `type: "array"`); omitted
`properties` is an empty map and still flows through the `required` check;
`properties: null` is rejected with its own reason.

### 2. [Medium] The plugin API could advertise URL without a URL renderer

`ChannelElicitationMode` was ACP's `form | url`, and
`supportedElicitationModes()` forwarded a `"url"` declaration, so a channel
declaring only `URL` was reported as supporting a mode core cannot deliver:
`ChannelElicitationRequest` carries form data only, there is no URL dispatch,
and the RFD's URL-mode rules (display the target host, obtain consent before
navigating, `elicitationId`, `elicitation/complete`) are unimplemented.

Not a live wire bug — production only reads the form probe — but it is a
capability lie in the M1 plugin contract that M2 would build on. The plugin-facing
mode union is now `"form"` only, `supportedElicitationModes()` returns
`Array<"form">`, and the registry documents this as the single place to widen
when M2 ships URL rendering. Three tests pinned the old behaviour and were
replaced.

### 3. [Low] Dead host→worker `elicitation.cancel` request protocol removed

A second, uncalled request method existed alongside the live worker→host
**event** protocol. Its stale-identity branch deleted the pending map entry
without resolving, rejecting, or aborting the promise — so anyone wiring it up
would have hung to the 125s watchdog. The production path is the event (covered
by the real-acpx E2E), so the request method and its params type were deleted
rather than fixed.

### 4. [Low] `measureFieldChars()` omitted `field.format`

The aggregate budget's invariant is that it covers **every** string in the
normalized form; `format` was missing. Since round 16 an unknown format is an
arbitrary agent-controlled annotation, so the undercount is
`maxFields × maxFormatLength` = 1280 chars — not a resource-safety issue, but the
same class of invariant break as the round-3 pattern/schema-metadata undercount.

**Recorded honestly:** at those limits the undercount can never trip the 256k
cap, so **no behavioral test fails when the line is removed**. The fix restores
the invariant and the accompanying regression proves `format` reaches the
normalized field at all (which is what makes it countable). This is explicitly
**not** listed in the mutation table below.

## Final totals after round 17

| Suite | Tests |
|---|---|
| `turn-interaction-registry.test.ts` | 13 |
| `elicitation-schema.test.ts` | 139 |
| `elicitation-interaction-broker.test.ts` | 52 |
| `elicitation-plugin-contract.test.ts` | 7 |
| `channel-elicitation-capability.test.ts` | 9 |
| `acpx-bridge-client.test.ts` | 47 |
| `runtime-adapter-elicitation.test.ts` (real acpx) | 4 |
| `runtime-elicitation-agent-identity.test.ts` (real worker) | 3 |
| `runtime-elicitation-listener-balance.test.ts` | 6 |
| `runtime-elicitation-cancel-e2e.test.ts` (real acpx) | 1 |

Total new: **224**. M1 unit suites 360/360 green; real-acpx E2E 25/26
(pre-existing `PR9-A`); `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table

| Round | Mutation | Caught by |
|---|---|---|
| R7 | decision accessor / double read | 3 decision tests |
| R8 | no-op `abort.release()` in helper | 2 listener tests |
| R8 | worker's `abort.release()` removed | structural guard |
| R9 | array canonicalisation disabled | 2 accessor tests |
| R9 | offset range check removed | 2 offset tests |
| R9 | preflight moved after validation | oversized-URI ordering test |
| R10 | length guard moved after canonicalisation | 3 array-admission tests |
| R11 | `typeof length === "number"` guard removed | 2 proxy-length tests |
| R11 | tombstone split removed | retention regression |
| R12 | broker `cancelElicitationRequest` disabled | 2 broker tests |
| R12 | broker external-signal chaining removed | 1 broker test |
| R12 | worker `elicitation.cancel` frame removed | cancel E2E (2/2 runs) |
| R12 | string default rejection restored | 3 schema tests |
| R12 | multi-select default filter removed | 1 schema test |
| R12 | `Date.UTC` leap-date mapping restored | 2 leap tests |
| R13 | pre-fill policy relaxed to size-only | prefill regression |
| R14 | withdrawal path disabled | withdrawal regression |
| R15 | anonymous cancel accepted again | responder-required regression |
| R16 | unknown `format` dropped instead of preserved | 2 format regressions |
| R16 | `.length` instead of `codePointLength` for pre-fill | code-point regression |
| R16 | multi-select `minItems`/`maxItems` removed from pre-fill | item-bound regression |
| R17 | strict root-type check restored | root-tolerance regression |
| R17 | `properties: null` guard removed | null-properties regression |
| R17 | URL advertised again | 3 mode-capability tests |

**Explicitly NOT mutation-guarded:** the `measureFieldChars` `format` term. The
undercount it fixes is 1280 chars against a 256k cap, so no input can distinguish
the two behaviors. Documented in the code rather than claimed as covered.

1 Medium, no Blocking.

### [Medium] The round-17 root-`type` distinction does not exist

Round 17 kept rejecting a **string** `type` naming a different type on the theory
that "malformed" meant non-string. That distinction is not real, and the reviewer
caught it by reading the pinned dependency rather than the RFD alone.

The installed `@agentclientprotocol/sdk@1.4.0` declares the field as:

```js
type: defaultOnError(z.llicitationSchemaType.optional().default("object"), () => "object")
```

with `zElicitationSchemaType = z.literal("object")` and
`export function defaultOnError(schema, fallback) { return schema.catch(fallback); }`.

So `.catch(...)` salvages **every** value that fails the literal — including
`"array"` — to `"object"` before xacpx's normalizer runs. Verified empirically by
parsing `{type: "array"|"string"|7|null|{…}}` through the installed schema: all
five arrive as `"object"`, and `properties: null` still throws (correct —
round 17's fix there stands).

Consequence: the only "type mismatch" core could ever observe is one the ACP
reader layer has already normalised away. Rejecting it rejects a form the agent
sent in good faith, and the test pinning the rejection was cementing the
deviation — the same failure mode as round 16's unknown `format`.

The tolerant branch is kept (rather than deleted) so the reader-tolerance rule
stays visible at the site and a future ACP revision that stops salvaging does not
silently start rejecting: flipping it to `fail(...)` fails 2 regressions.

The `properties: null` rejection from round 17 is unchanged — the SDK's
`z.record(...).optional().default({})` has no catch, so `null` genuinely fails
upstream too.

| Mutation | Caught by |
|---|---|
| wrong root `type` rejected again | 2 root-tolerance regressions |

## Final totals after round 18

No net test-count change (224); `elicitation-schema.test.ts` 139 → 139. M1 unit
suites 360/360 green; real-acpx E2E 25/26 (pre-existing `PR9-A`);
`npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table (round 18 addition)

| Round | Mutation | Caught by |
|---|---|---|
| R17 | strict root-type check restored | root-tolerance regression |
| R18 | wrong root `type` rejected again | 2 root-tolerance regressions |

## Review round 19 (head `447ecdf7`) — presentation-metadata salvage


1 Medium, no Blocking.

### [Medium] Optional presentation metadata rejected where the ACP reader salvages

Every OPTIONAL presentation string in the pinned
`@agentclientprotocol/sdk` 1.4.0 — `requestedSchema.title`,
`requestedSchema.description`, each property's `title`/`description`, an
`EnumOption`'s optional `description`, and `default`/`_meta` — is declared as:

```ts
defaultOnError(z.string().nullish(), () => undefined)
```

and `defaultOnError` is `schema.catch(fallback)`. Confirmed empirically against
the installed package: `title: 7`, `description: false`, `title: {}` and an
option `description: 5` all parse to `undefined`, so the ACP reader normalises a
non-string to **absent** before xacpx's normalizer runs. xacpx was instead
failing the whole form as `malformed_schema`.

Added `readSalvagedMetadataString()` — non-string ⇒ absent, present string still
subject to xacpx's own length cap — and switched the five presentation sites to
it. Verified from the SDK source that this is **not** a general relaxation:

| Member | SDK declaration | xacpx behavior |
|---|---|---|
| `title` / `description` (schema + property) | `defaultOnError(...)` | salvaged |
| `EnumOption.description` | `defaultOnError(...)` | salvaged |
| `pattern` | `z.string().nullish()` — **no catch** | still rejected |
| `EnumOption.const` / `title` | `z.string()` — required | still rejected |

| Mutation | Caught by |
|---|---|
| metadata salvage removed | "malformed presentation metadata is salvaged" fails |
| `pattern` wrongly salvaged | "a malformed pattern is still rejected" fails |

## Final totals after round 19

| Suite | Tests |
|---|---|
| `elicitation-schema.test.ts` | 143 |

Total new: **228**. M1 unit suites 364/364 green; real-acpx E2E 25/26
(pre-existing `PR9-A`); `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table (round 19 addition)

| Round | Mutation | Caught by |
|---|---|---|
| R18 | wrong root `type` rejected again | 2 root-tolerance regressions |
| R19 | metadata salvage removed | metadata-salvage regression |
| R19 | `pattern` wrongly salvaged | pattern-strictness regression |

## Review round 20 (head `5fe0e832`) — multi-select item-level salvage

1 Medium, no Blocking. **Round 19's "nothing left" claim was inaccurate and is
corrected here.**

### [Medium] Multi-select `default` lacked the reader's per-item salvage

The pinned SDK declares it as

```ts
default: defaultOnError(vecSkipError(z.string()).nullish(), () => undefined)
```

and `vecSkipError` is

```js
z.array(itemSchema.catch(skippedItem)).transform((items) => items.filter((item) => item !== skippedItem))
```

— **per-item** salvage. Verified empirically against the installed package:

| Input | Reader result |
|---|---|
| `default: ["a", 7, "b"]` | `["a", "b"]` |
| `default: [null, "a"]` | `["a"]` |
| `default: 7` (non-array) | `undefined` |
| `default: ["a", "a"]` | `["a", "a"]` — **dupes preserved** |
| `items.enum: ["a", 7]` | **THROW** (no salvage) |

xacpx dropped the entire hint when any element was malformed. Same reader-parity
class as rounds 16/18/19 — and round 19's closure claimed a full SDK salvage
audit with "nothing left", which was wrong: the audit listed `default` as
salvaged for the array variant but did not check that the salvage was per-item
rather than whole-value. The claim is retracted.

`readSalvagedStringArray()` implements it in the required order:

1. O(1) admission on the RAW array length, before any allocation;
2. per-item salvage of non-strings;
3. xacpx's own policy — offered-option filter, dedupe, `minItems`/`maxItems`,
   item length bound.

Not a general relaxation: `enum` and `required` keep the strict reader, pinned by
a mutation in both directions.

Also fixed the round-19 Low: the malformed-metadata regression now covers the
root `requestedSchema.description` as well as `title`.

| Mutation | Caught by |
|---|---|
| per-item salvage removed | item-salvage regression |
| per-item salvage introduced into `enum` | enum-strictness regression |

## Final totals after round 20

| Suite | Tests |
|---|---|
| `elicitation-schema.test.ts` | 147 |

Total new: **232**. M1 unit suites 367/367 green; real-acpx E2E 25/26
(pre-existing `PR9-A`); `npx tsc --noEmit` 0 errors.

### Cumulative mutation-verification table (round 20 addition)

| Round | Mutation | Caught by |
|---|---|---|
| R19 | metadata salvage removed | metadata-salvage regression |
| R19 | `pattern` wrongly salvaged | pattern-strictness regression |
| R20 | multi-select per-item salvage removed | item-salvage regression |
| R20 | per-item salvage introduced into `enum` | enum-strictness regression |

### Corrections to earlier claims in this report

- **Round 19's "full SDK salvage audit / nothing left" was inaccurate.** It
  audited which MEMBERS salvage but not how, so it missed that the array
  variant's salvage is per-element. Corrected by this round. The audit method
  is now: for every salvaged member, also record the salvage GRANULARITY
  (whole value vs per item) before claiming coverage.
