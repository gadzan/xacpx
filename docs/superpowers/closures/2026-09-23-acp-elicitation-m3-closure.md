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

## The production chain, and how it is proven

The requirement was not "tests pass" but "a Direct Bot ACP form request reaches a
human and the answer returns to the same turn, through production transport".
`tests/unit/packages/channel-relay/relay-elicitation-full-chain.test.ts` drives
exactly that, and every hop is real code:

```
core's broker      RelayChannel.requestElicitation(request)   real
connector          RelayClient.sendRequest                    REAL: its upward
                                                                        allowlist,
                                                                        its envelope
                                                                        encode, its
                                                                        pending-request
                                                                        bookkeeping
network            a real ws:// socket                        the only fake is the
                                                                loopback, which is
                                                                what a real one is
hub                InstanceGateway.handleMessage               REAL authenticated
                                                                        connector ingress
                    InteractionRegistry                        real stores
browser            hub HTTP RPC interactionRespond             real authenticated
                                                                        session
hub                stamps responderId from ITS session          real
hub                sends the WS response frame                 real
connector          RelayClient's pending promise               real decode
core               re-verifies responderId + answers           asserted, not stripped
```

The only faked edge is the loopback socket. **Not** `RelayClient.sendRequest`, and
**not** `InstanceGateway`'s request dispatcher — an earlier revision stubbed both
by handing the connector's frame straight to the browser HTTP RPC endpoint, which
was not a network fake but a bypass of precisely the pair of seams that had to be
proven. `relay-interaction-transport.test.ts` covers the hub half the same way: it
drives the connector through a real authenticated WebSocket rather than through the
browser surface, so the transport is exercised from the end that owns it.

Both are mutation-pinned: removing either interaction type from the client's
upward allowlist, or removing the handler from the gateway dispatcher, turns every
chain test red.

## The transport boundary that moved

Opening and withdrawing an interaction are the CONNECTOR's acts: the turn that owns
the agent is what asks the question and what goes away. Both used to live on
`POST /api/instances/:id/rpc`, which is the AUTHENTICATED BROWSER's surface — so a
connector-only control had become a browser RPC, and `withdraw` closed by bare
`requestId` with no ownership check at all.

They now live on the authenticated connector socket in `InstanceGateway`, where the
identity is the socket's own rather than anything a frame asserts:

```
open      → registry.open + broadcast interaction-opened
withdraw  → ownership check (instance AND account) → close("withdrawn")
             → registry's listener broadcasts to every browser
             → a later interactionRespond is 409 gone
```

The browser surface keeps `interactionRespond` and answers only. `interactionRequest`
and `interactionWithdraw` are not merely absent from it — they are explicitly
refused with `connector-only`, because leaving them out alone would let the generic
forward at the end of the handler pass them on anyway. The `permission` kind's
`unsupported` refusal sits on the gateway path too, since the kind is the
connector's to state.

`interactionResultForBrowser` moved beside the registry, the one component both
the connector-facing and browser-facing transports share, so the security-critical
identity stamp is applied identically on either surface. Two copies of a stamp is
how the two drift apart.

Three assertions carry the weight:

1. The decision that reaches the caller carries the hub's identity, not the
   browser's (which carried none).
2. A browser that asserts an identity gets the frame REJECTED, the interaction
   stays open, and it can still be answered honestly.
3. A window that closed before the frame arrived yields a cancel, and no form is
   ever shown for it.

## The identity chain, and the tautology that had to be broken

The invariant is three steps long, and only the first has the hub in it:

```
hub authenticates responder
  -> channel reports THAT responder
  -> core compares responder == turn initiator
```

For the comparison to mean anything, the value the channel reports must come from
the hub. An earlier revision of `requestElicitation` returned
`request.requester.senderId` on every decision, which collapsed the three steps
into `initiator == initiator` -- a comparison that passes for a decision made by
any authenticated account, or by none at all. The chain tests stayed green through
that, because the harness's initiator happened to be the same account the hub
stamped.

Breaking the tautology requires a test where the two differ, so the harness now
reads `hubAccountId` off the store the hub authenticates against rather than
naming an id, and `the responder is the hub's stamp, never the request's
initiator` opens with an initiator that is NOT the hub's account and asserts the
decision carries the hub's. Restoring the echo turns three tests red.

## Withdrawal, and why aborting locally was not enough

Core's `request.signal` firing means "stop collecting input". Until now the
channel treated it as "stop waiting": it rejected its own promise, and the hub's
pending interaction -- and therefore the form on the human's screen -- stayed
alive until the window ended, still accepting answers for a turn that no longer
existed.

The wire grew `control.interaction.withdraw`, whose contract is idempotent by
design so a withdrawal racing the human's answer is a no-op rather than an
error. The abort path sends it before settling locally, and the transport-failure
path sends it too, because a failure can arrive after the hub already opened the
interaction. On the hub, `close(..., "withdrawn")` removes the pending entry,
broadcasts to every browser, and turns a later `interactionRespond` into 409.

The regression asserts all four links -- pending entry gone, browser told,
channel reports cancel, late answer refused -- because a test that only watched
`requestElicitation()` settle would be satisfied by the local rejection alone.
Disabling either withdrawal call turns it red.

## One clock for answering, another for the trip home

`expiresAt` and the transport ceiling were the same number. Their gap is the
reserve a decision made in time needs to reach the connector, so conflating them
stretched the human's answer window by the reserve: an answer arriving at
`expiresAt + 5s` was accepted, reported to the human as answered, and delivered
to a turn that had already expired.

They are now two fields on the entry. The registry's expiry timer runs on
`answerWindowMs` (the window, without the reserve); `timeoutMs` stays the RPC
ceiling and is no longer used for the timer. `answer()` additionally re-checks
`Date.now() >= expiresAt` -- a timer is coarse, so a real answer can slip past
`expiresAt` before it fires, and that hole was open.

## Close notification is the registry's job, not the handler's

`interaction-closed` used to be emitted from whichever handler triggered the
close, which left the natural expiry path silent: a browser that outlived its
window was never told. The registry now notifies a registered listener on every
closer -- resolved, withdrawn, expired, hub close -- and `createApp` wires that
listener to the account-scoped broadcast. The handler that answers no longer
emits its own event, so the browser sees exactly one close per interaction.

## Layers

| Layer | Change ||---|---|
| `relay-protocol` | message pair + the `withdraw` message, DTOs, validators, `web-dtos` exhaustiveness, capability constant, shared reserve constant, exported `validateInteractionResponse`, optional product correlation ids |
| core | **B2 blocker removed**: `bot:` keys now route, and a Direct Bot turn gets an elicitation route |
| `channel-relay` | real `RelayClient` (upward allowlist now carries `interactionRequest`/`interactionWithdraw`), `requestElicitation` opens on the hub and reports the HUB's stamped responder, withdraws the hub interaction on abort or transport failure |
| `relay` hub | connector-socket `interactionRequest`/`interactionWithdraw` on the real gateway dispatcher, ownership-checked withdrawal, stamps the responder identity, owns the pending-interaction registry, notifies `interaction-closed` for every closer, and keeps the answer window at `expiresAt` while the RPC ceiling stays `expiresAt + reserve` |
| `relay` HTTP surface | answers only (`interactionRespond`); open and withdraw are explicitly refused as `connector-only` rather than forwarded |
| `relay-web` store | pending-interaction state, submit/decline/cancel on the answer direction, reconnect re-proof |
| `relay-web` UI | form renderer in the turn banner, all five field kinds |
| tests | 15 mutation-verified regressions, including the production-shaped hub round trip, the full chain end to end, the identity mismatch, the remote withdrawal, and the two-clock boundary |

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

## Landing status

| Step | State |
|---|---|
| PR #360 (M2 + M4, Discord + Feishu renderers) | **merged** as `e3b5b764` (squash) |
| PR #361 (this milestone) | rebased onto post-#360 `main`; head is M3's 12 commits plus the post-review fixes — #360's own 50 commits are no longer duplicated |
| Head | `301831a6` — M3's own commits plus the post-review fixes |
| CI | full run on that SHA |

The first CI run on the rebased head failed one test on both Linux and macOS.
`channel-terminal-dialect.test.ts` asserted `capturedCaps` equals `[]`, but the
value was `["interaction.elicitation.form.v1"]`. That failure was **correct and the
assertion was wrong**: a failed terminal dialect preflight makes
`bootstrapTerminal` return `[]`, so the array was exactly the interaction
capability — which is orthogonal to the terminal and does keep working when the
gate closes it. What the test must guard is that no *terminal* capability
survives, and it now asserts the two terminal names are absent. Verified
load-bearing by forcing the platform (the test is `skipIf(win32)`, so it
otherwise passes silently on a Windows checkout) and breaking the gate: red, then
green again.

The rebase absorbed the group-foundations work that landed alongside #360, which
renamed part of the control surface `channel-relay` compiles against. That
surfaced one build-discipline fact worth restating: the workspace path map sends
`xacpx/plugin-api` to `dist/plugin-api.d.ts`, so a rebase that changes `src/`
requires `bun run build` before any package typecheck is meaningful. The stale
`dist` produced a dozen `createGroup`/`updateGroup` "property does not exist"
errors in code that was in fact correct; a clean rebuild cleared them all.

Local verification on this head: root, relay-protocol, relay, channel-relay,
channel-discord and channel-feishu typechecks clean; affected suites 1648 pass /
14 fail, with the failing set byte-identical to the pre-rebase baseline (file
permissions, rmux version probes, exclusive-writer locks, a CLI path regex, and
the completion-route restart test) — all Windows-environmental or load-flakes that
pass in isolation.

## Post-review defects: browser delivery, route collapse, single-slot state, renderer

A full re-review after the transport was closed found four P1s and two P2s. The
narrow re-review of the transport itself stood; these are all in layers that the
chain test did not reach.

### A subscribed browser never received the form

Two independent breaks, and the chain test was green through both because it
captured the raw control event instead of letting it cross the web gateway's
subscription fence:

- `server.ts` wrapped interaction events with `instanceId: ""`, and
  `WebGateway.broadcast` fences control-events on each socket's instance
  subscription — which the dashboard fills with its real instance ids on connect.
  Every form was dropped.
- `InstanceGateway` had no public `broadcastControlEvent`; it exists only as a
  dependency callback, so the app's registry close listener called it on the real
  class and got `undefined`. Resolved, withdrawn and expired closes were never
  broadcast at all.

Both surfaces now stamp the connector's instance, the wrapper forwards the
event's own id, and the method is public. The regression puts a real
`WebGateway` and a real subscribed browser socket in the path and wires the
app's listener through the gateway's own method, the way production does — so
blanking the id, or suppressing `interaction-closed`, turns it red.

### The Direct Bot route collapsed, so correlation was lost

A real Direct Bot turn carries `permissionChatKey: relay:<account>`, so
`resolvePermissionTurnRoute` SUCCEEDS on it. The elicitation resolver was gated on
permission finding nothing, so it never ran, and the route collapsed to the
account-wide `relay:` address — one address for every topic. `conversationId`
and `topicId` never reached the hub, so the form could not be placed.

The resolver now runs unconditionally and is narrower by construction: it refuses
every non-`bot:` isolation key, so an ordinary channel turn still yields
`undefined`. It also stops forwarding `permissionChatKey` into the shared
resolver, which had been overriding the product key; the ingress key rides
`replyContextToken` instead. `replyContextToken` is no longer coerced into
`promptRequestId` either — it is the trusted ingress chat key, a different
concept, and the coercion produced a correlation that joined on nothing.

### The store had one slot

`pendingInteraction` was a single ref, which lost forms three ways: an event for
another topic was dropped permanently (the hub still held it, so switching back
found nothing); a form opened on topic A rendered into topic B's banner after a
switch; and a second `interaction-opened` superseded the first, though M1's
cancellation is request-scoped and the same turn can hold several pending
requests.

State is now keyed by requestId with a computed accessor scoped to the topic being
viewed — open first, then terminal. Forms for other topics are stored but not
displayed.

### The form could not complete a legal ACP form

Only two typed controls existed. `number` and `multi-select` fell through to a
text input and reached core as `string` where core expects `number` / `string[]`.
Because the transport is terminal — the hub resolves on submit and core validates
afterwards — an ordinary typo closed the form and cancelled the request with no
way to retry.

All five kinds now render, values are coerced to their wire types, and the
field's own bounds are checked locally so Submit can be blocked with a reason.
Defaults are displayed but never submitted without an edit. `format` was written
by `relayFieldsFrom` but absent from `InteractionFieldDto`, so the wire had no
type for it; eleven component regressions cover each of these.

### Close reads as "accepted" in every other tab

`interaction-closed` carried no action, so the store mapped every resolve to
`accepted`. It now carries the action the human chose, and the store reports
`declined` / `cancelled` accordingly. A tab that did not click no longer guesses.

### A missed push was permanent

`interaction-opened` is a one-shot broadcast, so a socket that connected after it
— a page load, a brief disconnect — missed the form forever while the hub still
held it and the agent still waited. The subscribe path now replays the
interactions that are genuinely still open, from the same registry, and only
those.

A doc-only move of the head invalidated the green CI run, and the rebuild exposed
one drift the Windows unit run could not see on its own: `channel-relay`'s
`relayFieldsFrom` writes `pattern` and `format` onto every text/select field, but
`InteractionFieldDto` had neither, so the package typecheck failed on a clean
checkout. Both fields existed in core's schema, which was never mirrored.

`pattern` is now on the wire, accepted only as bounded text and never compiled on
the hub. `format` stays an open bounded string rather than the enum first written:
core is the authority on which names exist and declares `format?: string`, so an
enum would need updating per new format and would reject a legal one.

The lesson worth recording is about coverage, not about the field: the local unit
run does not exercise the package build, so a typecheck-only drift between
`channel-relay` and the wire surfaces only in the CI `Build (all packages)` step.
Any change to `relay-protocol` should be verified with that step, not only with
`tsc -p packages/<p>/tsconfig.json`.
