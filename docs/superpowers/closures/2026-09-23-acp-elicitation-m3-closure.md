# ACP Elicitation M3 — Relay Web + Conversation Closure Report

```text
Milestone: M3 Relay Web + Conversation
Base: #360 head (47ea514a) — M3 was rebased off it, NOT off main @ f9090253
Head: see git rev-parse HEAD
Commits: 11 after review + repair
```

## What shipped

The relay interaction transport, end to end, as ONE envelope carrying both
decision kinds — so the permission follow-up PR #350 explicitly deferred can
reuse it rather than growing a second mechanism.

```text
control.interaction.request   connector -> hub : OPEN an interaction
control.interaction.respond   browser   -> hub : ANSWER an opened interaction
                          kind: "permission" | "elicitation"
```

Full chain, in the direction production actually runs:

```
agent -> ACP elicitation/create -> runtime worker -> RuntimeEngine
  -> core broker (exact-turn route)          src/interactions/elicitation-interaction-broker.ts
  -> RelayChannel.requestElicitation          packages/channel-relay/src/channel.ts
  -> connector opens the interaction on the hub
  -> hub validates, registers, broadcasts     packages/relay/src/http/app.ts
                                              packages/relay/src/interaction-registry.ts
  -> browser renders the form                 packages/relay-web/src/stores/direct-bots.ts
  -> browser answers on interactionRespond    packages/relay-web/src/stores/direct-bots.ts
  -> hub resolves the OPEN and stamps identity  packages/relay/src/http/app.ts
  -> connector maps the answer to a decision  packages/channel-relay/src/relay-interaction.ts
  -> core re-validates + resumes the same turn  src/interactions/elicitation-interaction-broker.ts
```

### The direction repair (what changed after review)

The original M3 implementation had the interaction going the other way: the hub
dialed the CONNECTOR, and `RelayChannel.openRelayInteraction` answered the hub's
frame through a daemon-injected `renderElicitation`. Two things were wrong with
that, and both are now fixed:

1. **The production caller does not exist.** Core's broker calls
   `channel.requestElicitation(request)` — that is the only entry point a
   channel has, and it is the only one the capability probe trusts. Under the old
   model `requestElicitation` threw, so the broker saw a declared capability
   backed by a method it could not call, and cancelled.
2. **The production ability was never injected.** `renderElicitation` had no
   production injection site — `CreateChannelDeps` carries only media fields, so
   every real instance had `elicitationModes = []`.

The repair makes `RelayChannel.requestElicitation` the real implementation and
dials the hub out, and deletes the injected-renderer seam entirely. Capability is
now a constant (`["form"]`) because the renderer IS the transport: a build where
this channel exists but cannot reach a hub does not exist. The hub gained a
pending-interaction registry so an opened interaction can be answered by a
browser, and emits the real `interaction-opened` / `interaction-closed`
control-events it always documented but never produced.

## Layers

| Layer | Change |
|---|---|
| `relay-protocol` | message pair, DTOs, validators, `web-dtos` exhaustiveness, capability constant, shared reserve constant, exported `validateInteractionResponse`, optional product correlation ids |
| core | **B2 blocker removed**: `bot:` keys now route, and a Direct Bot turn gets an elicitation route |
| `channel-relay` | `requestElicitation` opens the interaction on the hub through the real client |
| `relay` hub | stamps the responder identity, owns the pending-interaction registry, emits `interaction-opened` / `interaction-closed`, bounds the window by the interaction's own `expiresAt` |
| `relay-web` store | pending-interaction state, submit/decline/cancel on the answer direction, reconnect re-proof |
| `relay-web` UI | form renderer in the turn banner, all five field kinds |
| tests | 9 mutation-verified regressions, including the production-shaped hub round trip |

## The B2 blocker

Direct Bot turns could not receive ANY interaction. `resolvePermissionTurnRoute`
returns `undefined` for every `bot:` chatKey, so no `interactionId` was minted and
the broker cancelled — and `getChannelIdFromChatKey` mapped the unknown prefix to
`weixin`, so even with a route the request reached the wrong channel.

Fixed in three parts, without touching permission semantics: the shared part of
the route resolver extracted behind an explicit `acceptDirectConversationKeys`
flag (permission keeps its refusal as policy), a new
`resolveElicitationTurnRoute` that accepts the product isolation key and resolves
against the persisted `HumanIngressContext`, and a prefix rule for `bot:`.

`parseDirectConversationChatKey` **parses** rather than prefix-matches, so
`bot:garbage` yields nothing: a route built from a prefix-only key could be
satisfied by any turn in any topic.

## Identity model

The load-bearing rule: **the responder identity exists in exactly one place, and
it is added by the hub from its own session authentication — never read from a
frame.** `interactionResultForBrowser` spreads `responderId: accountId` OVER
whatever the frame carried, so a connector or tampered client asserting an
identity has no effect. Core re-verifies it against the exact turn initiator
anyway, but the point is that a client-supplied value never survives to be
re-verified.

`validateInteractionResponse` *rejects* a frame carrying `responderId`/`senderId`/
`userId` rather than dropping the field: an explicit rejection surfaces the
violation, while dropping would let a client believe it asserted something.

**One asymmetry worth naming**, because it looks like a hole and is not: that
validator governs the BROWSER → hub frame, where the hub has not authenticated
the identity yet. What the CONNECTOR receives is the hub → connector RESULT, and
it legitimately carries the identity the hub stamped. So the connector strips the
identity, validates the remainder against the same validator, and reads the
stripped identity back — the hub's own stamp. A hub that stamps no identity at all
closes the interaction rather than delivering an unattributable decision.

### M1/M2 invariants kept, not traded for the Relay path

| Invariant | How M3 keeps it |
|---|---|
| Exact-turn ownership | Every answer is keyed by `requestId` to a registry entry that holds the opening instance and account. No "latest" fallback exists in the registry, the hub handler, or the connector. |
| Responder identity | Hub-authenticated only. The browser frame carries none, and the validator rejects one. |
| Direct Bot isolation | `resolveElicitationTurnRoute` resolves `bot:<c>:<t>` strictly via `parseDirectConversationChatKey`; a malformed key yields no route at all. Permission policy is untouched — `bot:` still never mints a permission route. |
| Hidden runtime aliases | `brt_*` remains rejected anywhere in the product correlation, on both the hub and web validators. The connector's correlation carries only `conversationId`/`topicId`/`promptRequestId`; the durable row ids it cannot know are absent, never `""`. |
| Permission semantics | Unchanged. `interactionPermissionV1` is deliberately absent from `RELAY_CAPABILITIES`, and the hub returns `unsupported` for a permission-kind open. |

## Bugs found by this work's own tests

1. **`isInteractionAnswerable` read `required || answered !== undefined`** —
   parses as intent, evaluates wrong: an unanswered OPTIONAL field yields
   `false || false` and blocked every all-optional form. That is precisely ACP's
   "accept with no answers" case, so the bug sat on the null-content path.
2. **Parameter property in a field initializer** — `elicitationModes =
   this.deps.renderElicitation ? [...] : []` was use-before-initialization and
   took 21 relay terminal/lifecycle tests down; the channel could not construct.
3. **Connector read `input.responderId` off the request frame** — it is not there
   and must not be; the identity is stamped on the way back.
4. **Guard order in `submitInteraction`** — required-field check ran before
   expiry, so an expired form said "you left a field blank" instead of "the
   window closed".
5. **Reconciler read `activeRun` before re-proving it** — my first placement
   would have kept a dead form alive after reconnect.
6. **Component read `request.fields[key]`** — a field that does not exist;
   answers are props, the request payload is immutable.

Two coverage gaps found by mutation, both closed:

- **The `bot:` routing rule had no test.** Mutating it went uncaught. It is the
  B2 fix, the change that makes everything else reachable, and it only had tests
  for the OTHER chatKey shapes.
- **The hub identity stamp had no test.** `interactionResultForBrowser` was an
  unexported helper — a path with no test on the single line that decides who
  core thinks answered.

## Build discipline (three instances, one root cause)

`channel-relay`, `relay`, and `relay-web` all resolve workspace deps through
symlinks into committed `dist/` directories. Consequences hit during this work:

- `tsc -p packages/relay-protocol/tsconfig.json` emits **only `.d.ts`** (its
  tsconfig is `emitDeclarationOnly`); the JS needs `npm run build:relay-protocol`
  (bun build, which also asserts the barrel was not tree-shaken to empty).
  `MSG.interactionRequest` was silently `undefined` at test time until that ran.
- `channel-relay` had a **pre-existing type error on main** (`listTopicRuns`
  missing from `PublicControlService`) purely from a stale
  `dist/plugin-api.d.ts`; it disappeared once the dist was rebuilt.

Rule: change `relay-protocol` or `src/plugin-api.ts` → rebuild before
typechecking any dependent package.

## Verification (post-rebase onto #360, and post-direction repair)

| Check | Result |
|---|---|
| Root typecheck | clean |
| relay-protocol build + typecheck | clean (dist rebuilt; `assert:relay-protocol` passes) |
| relay typecheck | clean |
| channel-relay typecheck | clean |
| relay-web typecheck | no real errors (pre-existing `.vue` transform failures, same as `main`) |
| Full unit suite | 6745 pass / 184 fail across 565 files (50 failing files) |
| **New failures caused by the M3 changes themselves** | **zero** — the only 2 files that differ from `main` are the Windows test-vintage ones described below |

### How the failure set was attributed

The exhaustive runner exits on the first failing file, so a single number is near
useless: `node scripts/run-tests.mjs tests/unit` aborts after `resolveHermesAcpShimEntry`,
which has nothing to do with this work. Every comparison below was made with a
runner that continues past failures (`file:///D:/tmp/run-all-unit.mjs`, which wraps
`buildTestPlan`), and each differing file was then re-run in isolation.

Four references were used, because two are not enough to be honest here:

| Reference | Failing files |
|---|---|
| `main` (`c93afc27`) | 49 |
| #361 head **fade6b34**, rebased onto #360 | 55 |
| The same, with the M3 direction repair stashed | 55 |
| **The same, with the M3 changes + the alias fix** | **50** |

Three classes of difference, and what happened to each:

1. **Windows process-tree suites** (`windows-process-tree`,
   `windows-orphan-reaper`) — the ONLY two that remain. `main` carries
   `3660bafb (#366) fix(windows): stop tree kill condemning shim-launched
   children`, which adds a junction-based fixture and CIM-visibility retries the
   older test file this branch inherits does not have. On a host whose `node` is
   reached through an fnm junction, the older test measures the launcher rather
   than the worker. Nothing in this diff touches that code, and the failure
   disappears the moment the branch is rebased onto a `main` that contains #366.
2. **Conversation run/lifecycle suites** — fixed here. See "The alias regression
   this rebase exposed" below: a Real bug the rebase exposed, in a Direct Bot
   session alias, now fixed with a regression test. 6 files failed before the
   fix, 0 after.
3. **`control-bridge.test.ts`** — fails on `main`, passes here. The interaction
   dispatch arm it asserted was for the OLD (hub→connector) direction, which the
   direction repair removed; the file's remaining assertions still pass. That is
   the expected shape of removing a mechanism that was tested.

## The alias regression this rebase exposed

Not part of the M3 feature, but found by it and fixed by it, because a bot turn
that cannot reach its session cannot reach the broker at all.

`getChannelIdFromChatKey` now maps a `bot:<conversationId>:<topicId>` key to the
relay channel (that rule is what makes the elicitation path reachable). Two
downstream helpers then used that channel id to scope the session alias:

- `scopeDisplayAliasToInternal("relay", "brt_bind_x")` → `relay:brt_bind_x`
- `resolveSessionAliasForInput("relay", "brt_bind_x", …)` → `relay:brt_bind_x`

The product mints that alias **unscoped** (`ownedDirectSessionAlias`), and the
session record is stored under exactly that key. So the scoped form never matched
any record and every Direct Bot prompt failed with
`session "brt_bind_…" does not exist`.

Fixed by adding `isProductOwnedSessionAlias` beside the minter (so the two cannot
drift) and teaching both helpers to pass a product alias through unchanged:
`resolveSessionAliasForInput` falls back to the bare alias against the existing
record set, and `scopeDisplayAliasToInternal` never prefixes one.

Regression: `tests/unit/channels/channel-scope-alias.test.ts` covers both entries,
including the "no record exists yet" case, and the wrong form being produced is
what the old code returned.

## Mutation-verification table (post-repair)

| Mutation | Caught by |
|---|---|
| Hub reads frame's responderId instead of stamping | 3 identity tests |
| Validator stops rejecting client-supplied identity | 1 test |
| Hidden-alias (`brt_`) rejection disabled | 1 test |
| `bot:` key no longer routes to relay | `tests/unit/channels/channel-scope.test.ts` |
| `requestElicitation` reverted to a throw | 7 channel tests |
| Handshake drops the interaction capability | handshake test |
| Web submits on `interactionRequest` instead of `interactionRespond` | 2 store tests |
| Zero-field forms banned again in the wire validator | 3 tests (protocol, hub, channel) |
| #360 `chatType` propagation removed in the rebase | handler test + route test |

Every row was produced by applying the mutation and watching the named test go
red; none is asserted from reasoning alone.

## Honest gaps

| Gap | Status |
|---|---|
| Real end-to-end against a live Feishu/Discord/WeChat session | **not exercised.** M3 is proven against the production-shaped seams at every layer — the hub's HTTP boundary, the connector's client seam, and the real protocol validators — but no live relay session or browser was driven. Deferred to M5 (release hardening). |
| `waiting-human` transition | **DEFERRED (explicit scope decision, see below).** Implemented: nothing. The form renders on the existing active/waiting turn surface. |
| Permission interaction | **carried, not rendered.** The wire shape and transport are exercised and tested; the hub returns `unsupported` and `interactionPermissionV1` is deliberately absent from `RELAY_CAPABILITIES`. |
| Multi-select | Refused by the renderability gate (Feishu has no multi-select; Discord and web render it). Relay accepts the shape; a platform without it cancels whole. |
| Durable interaction state | **DEFERRED, with a documented cancel path.** Not durable by design: a hub restart drops in-flight interactions, and every path that does so fails closed. See "Durability" below. |

### Decision: `waiting-human` is NOT part of M3's acceptance criteria

The readiness assessment lists this as an open decision, and this closure
resolves it as **option B — formal deferral** rather than implementation.

Reason, concretely: `Conversation run state` is **store-mediated**. The states a
run may occupy are owned by the durable store's transition API, and a channel or
plugin does not have a safe handle on that API — the plugin contract deliberately
gives a renderer `requestElicitation` and nothing that mutates product state. So
the options were:

- **A (implement)** would mean widening the plugin surface with a store-owned
  run-state transition, i.e. asking a renderer to mutate Conversation state. The
  exact-turn elicitation feature does not need it: the form is displayed on the
  turn's existing banner surface, which is already driven by the live turn.
  Implementing A would also introduce a wedge that does not exist today — a
  restart or a reconcile that finds `waiting-human` with no open interaction, or
  the reverse, with no API to escape from.
- **B (defer)** costs one product-visible bit: the UI shows the form on the
  existing waiting surface rather than a dedicated "waiting for you" state. No
  behavior is lost — the form is the interaction, and it is answerable.

Chosen: **B.** The transition is deferred to a milestone that owns run state,
and M3's acceptance is defined without it. Nothing in this closure claims the
transition as complete.

## Durability (deferred, with the cancel path documented)

An in-flight interaction is **not durable**: a hub restart drops it. This is
accepted for M3 with the following guarantees, all exercised by tests:

- **fail closed.** A hub that has no interaction registry at all answers
  `interaction-unavailable` (503) on both directions rather than pretending.
- **no zombie form.** Every close — resolved, withdrawn, expired — broadcasts
  `interaction-closed` to the account's browsers, so a form the hub no longer
  knows about is dropped by the client rather than left answerable.
- **reconnect reconciles.** The web store's reconnect re-proof clears a pending
  interaction whose opening instance is no longer the live one.
- **the cancel path is recorded, not a surprise.** A restart surfaces to the agent
  as an abort of that elicitation request, which is the same shape as a timeout:
  the agent sees "no answer arrived", never a fabricated decision.

Making interactions durable would mean carrying `HumanIngressContext` (and its
`authorityEpoch`) across the hub boundary and reconciling a browser session
against it after restart. That is a design of its own, not a flag.

## Timeout, abort and expiry (M3 design §9)

| Requirement | Implementation | Test |
|---|---|---|
| A 61s-into-answer interaction survives the connector's generic 60s bound | The connector passes `timeoutMs = expiresAt - now + RELAY_INTERACTION_RESPONSE_RESERVE_MS`, shared with the hub. Both ends agree on the ceiling, so neither is the surprise. | `outbound[0].timeoutMs > 120_000` in the channel test |
| An interaction past `expiresAt` is not opened at all | The hub refuses before registering, and nothing is broadcast. | "closes the interaction as expired when the window passes" |
| An answer arriving after the window closed does not win | The registry entry is gone, so the answer is `interaction-gone` (409) rather than resolved. | "treats an answer for an unknown request as gone" |
| Agent withdrawal aborts the in-flight RPC | `requestElicitation` wires `request.signal` into the send and rejects on abort; the hub's expiry broadcast then drops the browser's form. | "the request signal aborts the in-flight interaction" |
| Hub/connector disconnect fails closed, never synthesised | `dropConnection` withdraws the instance's interactions and broadcasts `interaction-closed: withdrawn`. The connector maps a non-`responded` result to `cancel`. | "a hub-side close is a cancel, never a decline the user did not make" |
| Terminal decision races a timeout | Core's own fence wins (`settleStale` after the post-decision checks), and the channel returns whatever the hub decided only when the RPC resolved. | core broker tests (M1) |

## Next-milestone readiness

**READY for M5 (release hardening)**, with these as its scope:

- deployment runbook for `cardActions` / the relay interaction path;
- a check that form capability is advertised only where a channel can deliver it
  (the M1 registry probe already does this; M5 should assert it in a built
  artifact, not only in unit tests);
- the multi-select gap recorded as a per-channel limitation;
- the `authorityEpoch` restart behaviour documented as a known cancel path
  rather than left as a surprise.
