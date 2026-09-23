# ACP Elicitation M3 — Relay Web + Conversation Closure Report

```text
Milestone: M3 Relay Web + Conversation
Base: main @ f9090253 ("feat(relay-web): add Direct Bot conversations (#350)")
Head: cb98fd29 (feat/relay-elicitation-interaction, pushed)
Commits: 7
```

## What shipped

The relay interaction transport, end to end, as ONE envelope carrying both
decision kinds — so the permission follow-up PR #350 explicitly deferred can
reuse it rather than growing a second mechanism.

```text
control.interaction.request   hub -> connector : open an interaction
control.interaction.respond   connector -> hub : deliver the decision
                          kind: "permission" | "elicitation"
```

Full chain now reachable:

```
agent -> ACP elicitation/create -> acpx -> runtime worker -> RuntimeEngine
  -> core broker (exact-turn route) -> RelayChannel.openRelayInteraction
  -> hub forwards as control-event -> browser form -> decision
  -> hub stamps responder -> connector -> core -> same agent turn resumes
```

## Layers

| Layer | Change |
|---|---|
| `relay-protocol` | message pair, DTOs, validators, `web-dtos` exhaustiveness, capability constant |
| core | **B2 blocker removed**: `bot:` keys now route, and a Direct Bot turn gets an elicitation route |
| `channel-relay` | `openRelayInteraction` answers the hub's frame through a daemon-supplied renderer |
| `relay` hub | stamps the responder identity, bounds the window by the interaction's own `expiresAt` |
| `relay-web` store | pending-interaction state, answer/submit/decline/cancel, reconnect re-proof |
| `relay-web` UI | form renderer in the turn banner, all five field kinds |
| tests | 6 mutation-verified regressions |

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

## Verification

| Check | Result |
|---|---|
| Root typecheck | clean (with an unrelated untracked `auto-migrate-agent-argv.ts` excluded — it fails on its own and is not part of this change) |
| relay / relay-protocol / channel-relay / relay-web typecheck | clean |
| Full unit suite | 3736 pass / 84 fail |
| **Failures vs `main`** | **identical set — `comm -13` empty, zero regressions** |
| relay-web | 1492 tests pass (14 `.vue`-transform file loads fail, same as main) |

Note: an earlier note in this milestone recorded a "67 fail" baseline. That was
measured on the M2 branch, which predates #350. **`main` itself carries 84
failures** — the number was a stale baseline, not a regression.

## Mutation-verification table

| Mutation | Caught by |
|---|---|
| Hub reads frame's responderId instead of stamping | 3 identity tests |
| Validator stops rejecting client-supplied identity | 1 test |
| Hidden-alias (`brt_`) rejection disabled | 1 test |
| `bot:` key no longer routes to relay | NEW test (was uncaught) |

## Honest gaps

| Gap | Status |
|---|---|
| Real end-to-end against a live Feishu/Discord/WeChat session | **not exercised.** M3 is proven against injected seams at every layer; the relay path additionally has no public URL in this deployment, so no live round trip. |
| `waiting-human` transition | **not implemented.** Nothing on `main` sets it and run state is store-mediated, so a plugin cannot. M3 renders the form on the existing waiting-turn banner and leaves the transition as decision 1 in the readiness assessment. |
| Permission interaction | **carried, not rendered.** The wire shape and transport are exercised and tested; `channel-relay` returns `unsupported` and `interactionPermissionV1` is deliberately absent from `RELAY_CAPABILITIES`. |
| Multi-select | Refused by the renderability gate (Feishu has no multi-select; Discord and web render it). Relay accepts the shape; a platform without it cancels whole. |
| Durable interaction state | Not durable by design: a hub restart drops in-flight interactions, and the abort path cancels them. Making them survive means carrying `HumanIngressContext` through the hub. |

## Next-milestone readiness

**READY for M5 (release hardening)**, with these as its scope:

- deployment runbook for `cardActions` / the relay interaction path;
- a check that form capability is advertised only where a channel can deliver it
  (the M1 registry probe already does this; M5 should assert it in a built
  artifact, not only in unit tests);
- the multi-select gap recorded as a per-channel limitation;
- the `authorityEpoch` restart behaviour documented as a known cancel path
  rather than left as a surprise.
