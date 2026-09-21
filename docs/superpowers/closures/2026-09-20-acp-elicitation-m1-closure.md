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
