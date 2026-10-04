# Milestone: M5 Release Hardening — Closure

**Milestone:** M5 Release Hardening (deployment/release evidence + capability truthfulness)
**Base:** `origin/main` @ `85d653e7`
**Date:** 2026-10-03
**Status:** see *Verdict* below.

---

## 0. What this milestone is, and is not

M5 is not a renderer milestone. Its scope, as originally recorded, is **deployment
and release evidence** plus **capability truthfulness** — proving that what the
system advertises is what the shipped artifact can actually deliver.

The scope was never written as one document. Three closure docs each carry a
"Next-milestone readiness" list, and this closure is measured against all three:

| Source | Recorded M5 scope |
|---|---|
| `2026-09-22-acp-elicitation-m2-closure.md:106-108` | "M5 follows M2/M3 end-to-end closure" |
| `2026-09-23-acp-elicitation-m3-closure.md:476-482` | deployment runbook for `cardActions`/relay interaction path; a check that form capability is advertised only where a channel can deliver it, asserted **in a built artifact, not only in unit tests**; the multi-select gap recorded as a per-channel limitation; the `authorityEpoch` restart behaviour documented as a known cancel path |
| `2026-09-23-acp-elicitation-m4-closure.md:157-160` | deployment runbook for `cardActions` (public URL, encryptKey/verificationToken, bind host); an operational check that form capability is advertised only where a channel can actually deliver it; the multi-select gap recorded as a known per-channel limitation |

No single M1 roadmap document exists in the repo; the three lists above are the
authoritative record and are reconciled here rather than invented.

---

## 1. Current-state matrix

Four dispositions, exactly as the working agreement requires.

### 1.1 Completed — implemented, shipped, and verified

| Item | Evidence |
|---|---|
| Core interaction foundation (registry, two kinds, first-terminal-decision-wins) | `src/interactions/elicitation-interaction-broker.ts`, M1 closure |
| Discord form renderer | `packages/channel-discord/src/elicitation-*.ts`, M2 closure |
| Relay/Conversation interaction transport (hub registry, responder stamp, ownership) | `packages/relay/src/interaction-registry.ts`, M3 closure |
| Feishu form renderer + card-callback listener | `packages/channel-feishu/src/elicitation-*.ts`, `card-action-host.ts`, M4 closure |
| `ChannelElicitationMode` narrowed to `"form"` | `src/interactions/elicitation-types.ts:221` |
| Feishu `cardActions`-gated capability declaration | `packages/channel-feishu/src/channel.ts:152-215` |
| Feishu mixed-account capability gating | `packages/channel-feishu/src/channel.ts:129-140` (`inboundOnlyAccounts`) |
| Discord / channel-relay capability declarations | `packages/channel-discord/src/channel.ts`, `packages/channel-relay/src/channel.ts:262-273` |
| Feishu multi-select fail-closed (no reshaping) | `packages/channel-feishu/src/elicitation-limits.ts:66` + tests |
| **Built-artifact capability gate** (this closure) | `tests/smoke/acp-elicitation-capability-artifact.test.ts`, 6/6 pass, enforced in CI after `Build (all packages)` |
| **Feishu deployment runbook** (this closure) | `docs/feishu-cardactions-deployment.md` |
| **Relay interaction runbook** (this closure) | `docs/relay-interaction-deployment.md` |
| Tracked `dist` hygiene for `relay-protocol` | `assert:relay-protocol` in `package.json:52` |

### 1.2 Implemented, closure previously informal — now recorded

| Item | Where it lands |
|---|---|
| listener-startup fail-closed on capability | §3.3 below, with the code path named |
| `authorityEpoch` restart semantics | §4 below, quoted from production code and the M3 readiness analysis |
| Runtime vs CLI / ACP interaction limits | §5 below |
| mixed-account capability rationale | §3.4 below (already in code comments, now in an operator-facing doc) |

### 1.3 Explicitly deferred

| Item | Why deferred | Where recorded |
|---|---|---|
| Reconnect authoritative open-set snapshot | the whole `interaction-snapshot` work; PR #369, unmerged at this base | M4 closure addenda; PR #369 |
| Relay Permission renderer | transport carries the kind; nothing renders it | §6 below |
| Durable interaction across hub restart | needs a full caller-chain resume design | §6 below |
| `waiting-human` Run state | read but never written; product semantics deferred | §6 below |
| ACP URL-mode elicitation | core contract is deliberately `form`-only | §6 below |

### 1.4 Out of scope for M5 (per the original roadmap and the working agreement)

WeChat / Yuanbao form rendering; unrelated Run/Conversation lifecycle
refactors; unifying permission and elicitation protocols; a generic
interaction mega-abstraction; any new milestone beyond M5.

---

## 2. Built-artifact capability gate — implemented

The M3 scope list asks for a capability check "in a built artifact, not only in
unit tests". This is the item the milestone most needed, because the existing
checks are source-level: `tests/unit/channels/channel-elicitation-capability.test.ts`
imports `MessageChannelRegistry` from `src/`, so it pins the source, not the
shipped bundle. `elicitationModes` is derived from **config plus constructor
wiring** — exactly the parts a bundler, a tree-shake, or a stale tracked `dist`
can silently change.

`tests/smoke/acp-elicitation-capability-artifact.test.ts` loads the production
bundles (`packages/channel-*/dist/index.js`, the file the plugin loader consumes)
and asserts:

| Case | Assertion |
|---|---|
| Feishu, no account has `cardActions` | `elicitationModes` is `[]` |
| Feishu, one account has `cardActions`, one does not | `elicitationModes` is `[]` |
| Feishu, every inbound account has `cardActions` | `elicitationModes` is `["form"]` |
| Feishu, with form declared | does **not** contain `"url"` |
| Discord | `elicitationModes` is exactly `["form"]` |
| channel-relay connector registration | contains `interaction.elicitation.form.v1`; contains no permission capability |

The relay case is not a class-field check. `elicitationModes` is not the relay
channel's real surface — what it hands `createClient` on its **production start
path** is, because that is the list the connector sends to the hub on hello. The
test drives a real `start()` against the built bundle and captures that list, so
the capability assembly and registration are the shipped ones. It awaits a
deferred that `createClient` resolves rather than polling, so a timeout means
"registration never happened" rather than "the poll was too short".

**It refuses to pass on source.** If `dist/index.js` is missing, the probe throws
rather than silently reading `undefined` — a gate that cannot fail is not a gate.

### 2.1 It is enforced, not manual

The Linux leg of `.github/workflows/test.yml` runs this probe **after
`Build (all packages)`**, which is the step that produces the bundles it consumes.
Without that, the gate could be green locally and skipped in CI entirely — the
exact gap between "asserted in a built artifact" and "asserted in a built artifact,
by the thing that decides whether a PR merges".

Not duplicated on macOS: one enforced gate closes the hole, and the channel
bundles are platform-independent JS.

### 2.2 Mutation proof

| Mutation | Expected failing test | Actual failing test |
|---|---|---|
| declare form when **any** account has `cardActions` (the capability lie) | mixed-account case | `feishu bundle: a MIXED account set declares no channel-wide form capability` |
| Discord bundle declares no form (`["form"]` → `[]`) | Discord case | `discord bundle: form capability is declared, not merely not-wrong` |
| connector registration omits the interaction capability | relay case | `relay bundle: the connector hello advertises the interaction capability it can deliver` |

Each was applied to source, the affected bundle rebuilt, and the gate re-run; each
failed exactly the case named, 5 pass / 1 fail in all three runs. The gate is
load-bearing, not decorative.

The Discord mutation is the one that matters most for the artefact claim: an
earlier revision of that test asserted only "every declared mode is in the allowed
set" and "url is absent", both of which hold on an empty array — so a
tree-shaken or stale bundle would have passed. `toEqual(["form"])` cannot.

Each mutation script asserted its target count was exactly 1, that the write
changed the file, and that the target string was gone before any test ran — the
discipline this milestone's earlier rounds repeatedly had to relearn.

---

## 3. Feishu deployment — the capability model an operator needs

Full runbook: **`docs/feishu-cardactions-deployment.md`**. The capability-relevant
conclusions, because they are the ones M5 asked to have stated:

### 3.1 Default loopback bind is the safe default

`FeishuCardActionConfig.host` defaults to `127.0.0.1`
(`packages/channel-feishu/src/config.ts:91`). A card-callback listener on a public
interface is an unauthenticated endpoint: `verificationToken` plus `encryptKey`
authenticate the *payload*, but nothing authenticates the *caller*. Exposing it is
an operator's explicit choice, and it must be paired with TLS and an
access-control layer.

### 3.2 `encryptKey` AND `verificationToken` are both required

Not redundant. `verifyCardRequest` picks the signing secret by protocol
(`card-action-host.ts:334-336`): a new-protocol callback (carrying `encrypt` or
`schema`) is verified with **SHA-256 over the encrypt key**, and a legacy push
(no `schema`, no `encrypt`) with **SHA-1 over the token**. Every button the
renderer emits carries `schema: "2.0"`, so every real click is new-protocol,
which is why the key is mandatory.

The token is separately required for three branches: the **URL-verification
challenge** arrives with **no signature headers at all** and its echoed token is
the only credential; it is the legacy signing secret; and it is compared
explicitly on the legacy and new-protocol-**unencrypted** branches.

`config.ts` holds the *configuration* contract for these credentials, not
`verifyCardRequest`; the verification logic lives in `card-action-host.ts`. The
deployment runbook carries the full four-branch table.

### 3.3 Two authentication paths, deliberately

The URL-verification challenge is authenticated **solely by constant-time `token`
equality** against `verificationToken`, and is recognized **before**
`verifyCardRequest()` runs. That matches the official SDK's `autoChallenge`, which
runs before `dispatcher.invoke()`.

Real card actions take the opposite path: they must pass the full signature check,
plus the timestamp freshness window. Recognizing the challenge by token does
**not** open a bypass for real actions — on the legacy and unencrypted branches
an unknown or missing payload token is a 401.

One asymmetry is deliberate and worth stating because the earlier revision of
this closure got it backwards: the **encrypted** new-protocol branch returns
immediately after a successful decrypt and does **not** compare the token. Its
authenticity chain is the encrypt-key signature plus decryption, and a captured
ciphertext cannot pass because the signature also covers a fresh timestamp. The
legacy branch, conversely, compares `record.token` explicitly and treats an
unconfigured token as a rejection. Whether the encrypted branch *should* also
compare the token is a production change, not a doc correction.

### 3.4 Two capability notions: declared (config) and live (registry readiness)

The channel declares `elicitationModes` **from config, in the constructor**
(`channel.ts:152-215`). That is the **declared** half — "is this build configured
to be able to deliver a form".

It cannot be the **live** half, because a bind can fail *after* construction
(`EADDRINUSE`, a taken port, a permissions error), and nothing in the config knows
that at the time. The live half is a separate mechanism, and it is what makes a
bind failure fail closed:

```text
FeishuChannel.start() throws
  → registry records the channel in failedStartupChannels
    (src/channels/channel-registry.ts:132-136, in a `finally`, so it is recorded
    AS IT HAPPENS — `allSettled` is not a readiness barrier)
  → readiness listener corrects the bridge's capability flag immediately
    (src/run-console.ts:332-335)
  → auditCapability computes DECLARED minus LIVE (run-console.ts:354-359)
  → some still live   → elicit_form_degraded, continue
  → none live         → elicit_form_lost, REFUSE STARTUP (run-console.ts:369-388),
                        fatal regardless of channelStartupPolicy
```

Fatal deliberately: the flag is already baked into the runtime at construction,
and the bridge protocol has no capability-update channel, so the honest
alternatives are refusing the run or lying while running. The readiness signal
never resolves on success, so a bind that fails *after* a clean audit still fails
the run (`run-console.ts:390-398`).

Removing `cardActions` is the other direction — an operator deliberately declaring
an account non-form-capable, which works through the declared half. It is **not**
the mechanism that keeps a bind failure truthful.

Full operator-facing text: `docs/feishu-cardactions-deployment.md` §5.3.

### 3.5 A mixed account set cannot be described truthfully

`elicitationModes` is **channel-scoped** (one answer for the whole plugin) while
`requestElicitation` is **account-scoped**: it resolves the account from the
`chatKey` and throws when that account has no card-callback listener.

So an account without `cardActions` still starts its WebSocket, still receives
messages, and still receives human turns — while being unable to deliver a form.
Declaring form for such a channel therefore advertises a capability that fails on
**every** request routed to the listener-less account.

The declared rule: form capability only when **no** live account is inbound-only
(`inboundOnlyAccounts`, `channel.ts:129-140`). A mixed configuration declares
nothing — honest, and still fully usable for messaging.

This is the case the built-artifact gate pins.

---

## 4. Restart: the documented fail-closed cancel path

`authorityEpoch` is a fresh UUID minted per dispatcher
(`src/conversations/conversation-composition.ts:108`) and stamped onto the durable
dispatch row **together with** `humanIngress`.

The restart behaviour, from `docs/superpowers/plans/2026-09-23-acp-elicitation-m3-readiness.md:81-92`:

- **Core daemon restart mid-turn** → new UUID, old row's epoch no longer matches
  → every in-flight human dispatch degrades to `orchestration` → the broker
  cancels (`route.origin !== 'human'`).
- **Lease expiry / recovered claim** → `humanIngress` is explicitly *"Discarded on
  recovery"*.

Both are plausible inside a 2-minute human interaction window
(`ELICITATION_INTERACTION_TIMEOUT_MS = 120_000`, watchdog 125s).

**This is a cancel path by design, not a durability feature.** The consequence for
a renderer, stated in that analysis and still binding:

> the relay renderer must NOT assume that a `waiting-human` Run, or a pending
> elicitation, implies the route is still bindable. The correct behaviour on a lost
> route is **cancel**, and the web UI should render that as a cancellation rather
> than an error.

Whatever durability work follows (see §6) must not weaken this: a lost route
cancels, it does not guess.

---

## 5. Runtime vs CLI / ACP interaction

| Surface | Interaction support | Notes |
|---|---|---|
| Core runtime (daemon, `authorityEpoch` per process) | Full: open → route → answer → resolve | Requires a same-epoch trusted human ingress |
| CLI (interactive acpx session) | Not routed through the web interaction transport | A CLI-local prompt is a different mechanism; it does not emit `humanIngress` for a relay browser |
| Relay Web / Direct Bot | Full, with the hub stamping responder identity | The hub adds the identity from its authenticated session; the browser never supplies one |

The binding constraint is the same one §4 describes: `accept` stamps epoch and
`humanIngress` **together or neither**, and `recoverExpiredClaims` /
`releaseClaimToPending` null both. So an interaction that outlives its daemon
process is **cancelled**, not resumed. Any future durability work resolves that at
the level of the durable boundary, not by patching the interaction path.

---

## 6. Deferred, with the reason each stays open

| Deferred | Why | Blocked on |
|---|---|---|
| Relay Permission renderer | The wire already carries `kind: "permission"` and the registry stores the payload for replay (`packages/relay/src/interaction-registry.ts:109`), but `InteractionRequestDto.permission` is marked *"Reserved; M3 does not implement it"* (`packages/relay-protocol/src/dtos.ts:905-911`) and `relay-web` has **no** permission branch — both the live-open and snapshot paths bail on any non-elicitation kind | a renderer + capability `interactionPermissionV1` before any advertisement |
| Durable interaction across hub restart | Persisting the hub registry alone is fake durability: the connector's pending RPC also dies, so nothing is waiting for the answer | a full caller-chain resume design |
| `waiting-human` Run state | Read in ≥8 places (`src/conversations/conversation-run-service.ts:568,573,692,970,1067,1073,1643,1650`), **never written** — the M3 readiness doc predicted exactly this (B4) | a design, then implementation; must be driven by authoritative open-interaction state |
| ACP URL-mode | `ChannelElicitationMode` is `"form"` only, and the declaration comment says why (`src/interactions/elicitation-types.ts:221`): ACP defines `form | url`, but there is no URL dispatch, no `elicitationId`, no `elicitation/complete`, and no consent-before-navigation implementation. Widening the union would advertise a capability core cannot deliver | an ACP-conformant URL contract: target-host display, consent before navigation, `elicitationId`, `elicitation/complete`, per-channel capability proof |

Each is a capability of its own, each starts only once the renderer and authority
chain genuinely exist, and none may be advertised before it is deliverable.

---

## 7. Verification layers

Per the working agreement, these are kept distinct rather than merged into "E2E
complete":

| Layer | Status |
|---|---|
| Production code path exercised | **yes** — the capability gate constructs the real built bundles |
| Built artifact verified | **yes** — `tests/smoke/acp-elicitation-capability-artifact.test.ts`, 6/6 (Feishu ×3, Feishu no-URL, Discord, channel-relay registration) |
| Injected / loopback transport verified | **yes** — the gate's Feishu construction is production-shaped; the existing unit suites cover the rest |
| Real platform round trip | **not exercised** — no public HTTPS endpoint, no Feishu console credentials, no live relay deployment available in this environment |
| Live deployment validation | **blocked by environment** — see above |

The live limitation is stated, not papered over. No "live platform verified" claim
is made anywhere in this milestone.

### 7.1 Reproducibility

| Command | Result |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | 0 errors |
| `bun test tests/smoke/acp-elicitation-capability-artifact.test.ts` | 6 pass / 0 fail |
| `bun test tests/unit/packages/channel-feishu/` | 490 pass / 0 fail — **identical** on clean `origin/main` (490 / 0, same 33 files) |
| `bun test tests/unit/channels/ tests/unit/interactions/` | 393 pass / 4 fail — **identical** on clean `origin/main`, same 397 tests, same 4 failing names |

None of these is a branch-only failure. The 4 are the pre-existing plugin-install
hints (Feishu/Yuanbao "runtime missing"), present with byte-identical results on
both refs.

**A baseline trap worth recording.** An earlier comparison on this branch reported
`channel-feishu` as 195 pass / 16 fail against a clean-main worktree, which looked
like a *regression in the safe direction*. It was not: that worktree had only
`dist/plugin-api.d.ts` and no `dist/plugin-api.js`, so the `xacpx/plugin-api` alias
failed and the suite could not load — 211 tests instead of 490. The worktree was
measuring the absence of a build step, not the code. Both refs were re-run after
installing the artifact, and they agree exactly.

The rule this reinforces: the `xacpx/plugin-api` alias resolves to
`dist/plugin-api.js`, so **any** package-level comparison requires that artifact to
exist in the worktree. "Fewer tests ran" is a symptom to investigate, never a
result to accept.

---

## Verdict

```text
M5 CODE COMPLETE
LIVE DEPLOYMENT VALIDATION BLOCKED BY ENVIRONMENT
```

Code complete: every scope item the three readiness lists recorded has a
production-path or built-artifact evidence trail, and the one genuinely new
check M5 asked for — capability in a built artifact — now exists and is
mutation-proven.

Live deployment validation is blocked because this environment has no public
HTTPS endpoint, no Feishu console credentials, and no live relay hub to point a
card callback at. The runbooks in
`docs/feishu-cardactions-deployment.md` and
`docs/relay-interaction-deployment.md` are written so an operator with those
prerequisites can execute the round trip; the failure is environmental, and
saying so is more useful than a fake passing check.
