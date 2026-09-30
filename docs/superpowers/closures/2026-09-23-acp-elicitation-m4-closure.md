# ACP Elicitation M4 - Feishu Renderer Closure Report

```text
Milestone: M4 Feishu Renderer
Base: main @ e8e17e5d ("feat(elicitation): ACP Elicitation M1 core foundation (#355)")
Head: c55e2b88 (feat/discord-elicit-form)
Stages: Stage 1 webhook channel (b586e1a7) + Stage 2 form renderer (c55e2b88)
```

## Summary

Feishu is the second production renderer for ACP form Elicitation. It required
building the callback channel first, because the plugin's only inbound
transport — a WebSocket long connection — cannot carry card interactions at all.

## Why this needed two stages

M4 plan §2 makes authenticated responder identity a hard gate: implement only
if the callback path provides a platform-authenticated operator identity, and
otherwise leave form mode unsupported rather than weakening the broker.

Research (independently verified by reading the SDK README myself) found:

| Fact | Source |
|---|---|
| Long-connection mode "only supports event subscriptions and **does not support callback subscriptions**" | `node_modules/@larksuiteoapi/node-sdk/README.md:550` |
| Card interactions are callbacks, hosted via `CardActionHandler` + an HTTP server | README:599-620 |
| The plugin registers exactly one WS handler, `im.message.receive_v1` | `packages/channel-feishu/src/channel.ts` (start()) |
| No `card.action` / `CardActionHandler` / `onSelect` anywhere in the package | repo-wide grep |

So a card click could not reach the plugin over any existing transport. Stage 1
built the missing channel; Stage 2 built the renderer on top of it.

## Stage 1 — the card-callback channel (`b586e1a7`)

`packages/channel-feishu/src/card-action-host.ts`, opt-in via
`channel.options.accounts.<id>.cardActions`:

- **encryptKey path**: AES-256-CBC, key = `SHA-256(encryptKey)`, IV prepended,
  NUL padding. A successful decrypt IS the authenticity proof. Implemented
  rather than stubbed — the first draft declared the parameter but never checked
  it. The same key also signs a new-protocol push (SHA-256), which is the branch
  every renderer button lands in, because each one carries `schema: "2.0"`.
- **verificationToken path**: SHA-1 signature over the token, plus a
  constant-time compare of the echoed token. This is the branch a push with no
  `schema` and no `encrypt` takes — which includes the URL-verification
  challenge.
- **Both are REQUIRED.** Each handshake the endpoint has to complete needs its
  own secret: without `encryptKey` every click 401s, and without
  `verificationToken` the endpoint can never finish being configured, because the
  challenge is read only AFTER the signature verifies. `parseCardActions` refuses
  a config missing either one.
- Default bind `127.0.0.1`; a public interface is an explicit operator decision.

Also: the URL-verification challenge is echoed only when it carries a valid
token (echoing an unauthenticated one would let anyone probe the endpoint), and
the handler returns its promise so a request's completion is awaitable rather
than inferred from timing.

## Stage 2 — the form renderer (`c55e2b88`)

Cards are Card JSON 2.0 created through `cardkit.v1.card.create` and replaced
with `cardkit.v1.card.update` (monotonic `sequence`), the same production
pattern `card/streaming-card-controller.ts` already uses. `streaming_mode` is
false, because a streaming card cannot be updated from an interaction callback.

Three platform facts changed the design:

1. **Answers are name-keyed only inside a `form` container.** Outside one, an
   input reports at `action.input_value` with no name. So each field card IS a
   form, and the component `name` is the sanitized field key — never an answer.
2. **There is no multi-select component.** The SDK's union is exactly
   `'select_static' | 'select_person'` (`types/index.d.ts:293022`). A research
   agent claimed a `multi_select_static` exists; I could not corroborate it in
   the SDK or the docs and went with the SDK, so `multi-select` fails the
   renderability gate and the whole request cancels.
3. **The routing token lives in `behaviors[].value`**, documented opaque data
   echoed at `action.value` — distinct from `form_value`, where answers arrive.

Feishu's flow therefore differs from Discord's: one card per field, each card a
form whose Submit both records the field and advances; a review card then shows
everything with one Edit per field. There is no wizard "position" on the
platform side, so a stale callback cannot move a user to a field the request no
longer has.

## Bugs found by these tests

1. **Option labels were emitted unescaped.** Feishu's `plain_text` renders
   `<at>` tags despite its name, so an agent-controlled option label could fire
   a real `@everyone` mention. Fixed by escaping in `plainText()` by default
   with an explicit `literal` opt-out for the plugin's own copy.
2. **The escaper was incomplete**: missing `|` (pipe tables) and line-leading
   `#`/`>`.
3. **An inverted condition** — `if (trySettle(entry))` read as "aborted" on the
   happy path, because `trySettle` returns true when it *succeeds*. Every
   renderer test caught it.
4. **`FeishuMessageClient` in `send.ts` understated the SDK.** Widening it to
   declare `cardkit` and the `interactive` message variants let the casts go
   away, and removing them then surfaced a real `undefined` hazard (the account
   may not be started), now an explicit fail-closed throw.

## Trust model — stated honestly

Same layering as Stage 1, with the same limitation:

- A token/encrypt check proves **Feishu sent this request**.
- `operator.open_id` inside a verified body is **platform-asserted**: only
  Feishu can produce a body that passes (1) and knows the real acting user.
- This is weaker than Discord, where the framework parses identity out of the
  Gateway interaction object itself. It is materially stronger than reading an
  id out of an unauthenticated body.
- Authorization is still re-checked per control against the recorded initiator,
  so a leaked routing token cannot answer on the initiator's behalf.

## Test totals

| File | Tests |
|---|---|
| `feishu-card-action-host.test.ts` | 27 |
| `feishu-channel-card-actions.test.ts` | 8 |
| `feishu-elicitation-limits.test.ts` | 13 |
| `feishu-elicitation-renderer.test.ts` | 29 |
| **Total** | **77** |

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` (root) | 0 errors |
| `npx tsc -p packages/channel-feishu/tsconfig.json --noEmit` | 0 errors |
| Feishu package | 394 pass / 0 fail (was 335 before M4) |
| Core capability probe (`channel-elicitation-capability.test.ts`) | passes unchanged — the Feishu declaration integrates with M1 rather than standing alone |
| Full unit suite | 3680 pass / 67 fail |

## Mutation-verification table

| Mutation | Caught by |
|---|---|
| Authorization check disabled | non-initiator submit test |
| Escaper neutralized | 3 tests (mention, bold/spoiler, option label) |
| Multi-select gate disabled | 4 tests (one hangs — what a missing gate actually causes) |
| Logout cleanup skipped | listener-start test |

## Honest gaps in this milestone

| Gap | Status |
|---|---|
| Real Feishu platform handshake | **not exercised.** The renderer is proven against an injected transport; a live round trip needs a public HTTPS URL for Feishu's POST, which this deployment does not have (dev machine behind NAT, no public domain, hub has no HTTP-forwarding path to instances). The channel is opt-in and configured for exactly that moment. |
| Multi-select fields | Refused by design. Feishu cards have no multi-select component; the request cancels rather than being reshaped. |
| Review-before-submit | **closed** (this branch). Feishu's form model cannot re-open a card for editing AFTER a form submit, which is why the field page and the review page use two DIFFERENT actions: the field card's `save` records that field and advances, and only the review page's `submit` settles. Sharing one action made the review depend on mutable `visitedReview` state, so a redelivered or double-tapped `save` reached the commit branch on its second delivery and accepted the form with no click on the review page at all. |
| WeChat / Yuanbao | Out of scope; form mode remains unsupported there. |

## Next-milestone readiness

**READY** (with the deployment caveat above).

M5 Release Hardening can proceed. Its scope should include:
- the deployment runbook for `cardActions` (public URL, encryptKey/verificationToken, bind host);
- an operational check that form capability is advertised only where a channel can actually deliver it;
- the multi-select gap recorded as a known per-channel limitation.

---

# Addendum — post-review fixes (2026-09-28)

Three defects the milestone's own tests did not cover, found by a full re-review of
the branch. All three were reachable on the landed head; each is now fixed with a
regression that fails without its fix.

## P1 — the URL-verification handshake was unanswerable

`handleRequest` called `verifyCardRequest()` first, which requires all three
`x-lark-request-*` signature headers. Only afterward did it look for a
`url_verification` challenge. The official SDK's webhook adapter does the opposite:
`autoChallenge` runs `generateChallenge()` BEFORE `dispatcher.invoke()`, which is
where signature validation lives. The platform's real challenge carries no
signature headers, so the endpoint could never complete its own configuration —
it would start, answer clicks, and still fail the console's URL check.

The existing tests passed because the harness fabricated a SHA-1 signature for
challenge bodies, and one was literally named `"challenge still works, signed"`.
That asserted a handshake shape this repo invented.

Fixed by recognizing and answering the challenge first, on the only credential it
actually carries: constant-time equality of the echoed `token` against
`verificationToken`. An encrypted challenge is decrypted first, matching
`generateChallenge()`. Real card actions still require their full signature, and
a challenge is never forwarded to the renderer — so the early branch cannot become
an action bypass. The two reference tests were deleted rather than re-pinned; they
tested the invented shape.

## P1 — same-generation race between Edit and Submit

Feishu's HTTP server runs each POST independently on the same pending entry: no
queue, no claim. `renderCurrentField()` mutates `currentField` and allocates a
generation, then awaits `updateCard`; `renderGeneration` is committed only once
that succeeds. During the wait the card on screen still names the OLD number, so
a Submit from it passed the published-generation fence and
`confirmReviewed()` accepted the pre-edit answers:

```text
Save "prod" → Review g=4 → Edit(g=4): currentField moved, g=5 allocated,
updateCard(g=5) outstanding → Submit(g=4) → renderGeneration still 4 →
fence passes → accept { note: "prod" }
```

The old regression did not catch it because it awaited the Edit first, so the
generation had already advanced.

Fixed with a `claimedGeneration` high-water mark on the entry, mirroring Discord's
proven `claimedRevision`. The claim is taken synchronously AFTER the stale fence
and BEFORE the first `await`, so a callback the stale fence drops spends nothing
(otherwise a redelivered callback retires a number no card can name, and the next
Submit from the card the user is actually reading gets wedged). Only card-publishing
actions claim — `submit` claims nothing, because it publishes nothing when it
succeeds and claiming would make the very next Submit stale against its own number.
The claim-check itself applies only to `submit`: navigation and field saves are
non-terminal and must keep working through an ACK window, and Decline/Cancel stay
exempt as before. The allocator is advanced by the claim too, so a claimed number
can never be reissued to an unclaimed render.

## P2 — `cardActions.path` accepted unmatchable query/hash values

`config.ts` required a leading `/`; the host strips anything from `?` on before
comparing. `/webhook/card?tenant=x` therefore parsed, bound a listener, advertised
form capability, and 404ed every callback, because the host compares
`/webhook/card` against `/webhook/card?tenant=x`. A `#fragment` is never sent to a
server at all. The parser now defines the value as a pure pathname and rejects
`?` / `#` alongside a relative path. The existing relative-path test was widened
in place to cover all three shapes rather than duplicated.

## P2 — the opening card's Start was not versioned, so a replay could move the wizard

The one defect left after the previous round. The builder drew the opening Start
as `routingValue(token, "start")` — no `g` — and `parseElicitationAction()` only
mandated a generation for `save`/`skip`/`field`/`submit`. The handler's stale
fence therefore had nothing to compare for a Start, and a delayed redelivery of
the first click was accepted after the user had left the opening:

```text
Opening -> Start -> field A -> Save A -> field B -> replayed Start
  -> currentField reset to A, field A's card republished
```

Not a silent wrong-answer path, hence P2, but a stale callback changing live
wizard position contradicts the invariant the revision scheme exists to hold —
and the premise ("Feishu retries, users double-tap") is what every other control
already designs against. Discord had already stamped its opening Start as
revision 1.

Fixed on both halves, matching Discord's precedent and the reviewer's
recommendation:

1. `buildElicitationOpeningCard()` stamps `OPENING_GENERATION` (1) on Start, the
   revision the entry's `renderGeneration` already starts at, so the first
   field/review card takes 2.
2. `parseElicitationAction()` requires a generation for `start` as well, so a
   versionless Start — which this renderer no longer draws — is refused rather
   than honoured. Decline and Cancel stay unversioned by design.

The claim set already included `start`, so no change there; it now actually takes
effect, and a normal Start claims the next generation (a gap when the opening
send is unacknowledged, which the allocator already tolerates by design).

The 28 existing tests that drove `a: "start"` were rewritten against
`openingStart(rec)`, which reads the payload off the card that was actually sent.
Hand-written versionless Starts would have been driving a shape the renderer no
longer emits. Two `a: "start"` fixtures in the host/channel tests are opaque
transport-level payloads whose token resolves to no entry, so they never reach
the parser and were left alone.

## Test totals (final)

| File | Tests |
|---|---|
| `feishu-card-action-host.test.ts` | 31 |
| `feishu-elicitation-renderer.test.ts` | 80 (was 78 at review head) |
| `feishu-config.test.ts` | 26 |
| **Feishu package** | **489 pass / 0 fail** |

## Mutation-verification (final)

| Mutation | Caught by |
|---|---|
| Challenge branch disabled | 4 tests (plaintext, encrypted, token-only, mixed action) |
| `claimedGeneration` gate removed | in-flight Submit race test |
| `?` / `#` path rejection removed | path-shapes test |
| Opening Start generation removed | replayed-opening-Start test |

## Comment corrections (the three non-blocking nits)

- `config.ts` no longer claims the URL-verification challenge "arrives on the
  legacy (token + SHA-1) path" or is "read after the signature check" — both the
  interface docblock and the required-token error message, plus a stray duplicated
  `/**` line in that interface's docblock.
- The number-sizing comment stays as-is: it is inaccurate about the mechanism (the
  bound is measured over 24 max-expansion characters, not `String(number)`'s
  longest output) but not about the conclusion, and it is far above any real
  number, so no budget changes.
- Not fixed: the degraded-readiness log branch. When one form channel fails while
  another stays live, the listener returns early on `formCapable === true` and
  `auditCapability()`'s degraded message never fires. The capability itself stays
  truthful — this costs one observability line, not correctness. Left alone
  because removing the early return would make every ready signal run the audit.

## Addendum - third re-review round (2026-09-30)

Full re-review of the same diff. Result was **request changes: 3 P1 + 1 P2**.
All four are fixed here. Every conclusion below is what the code actually does,
not what the earlier addenda claimed it did.

### P1 #1 - agent identity vanished on the core -> relay wire (FIXED)

`ChannelElicitationRequest.agent` is REQUIRED by core and its docblock says
plainly that renderers MUST display it and MUST NOT substitute `message`,
`schemaTitle`, or `description` text for it, because that text is
agent-controlled. `InteractionRequestDto.elicitation` had only `message`,
`fields`, and `schemaTitle` — no `agent` at all. So a renderer following the
contract to the letter had no identity to display, and the relay web form showed
the trusted identity nowhere.

Fixed by carrying it end to end:

- `packages/relay-protocol/src/dtos.ts` — `agent: { name; sessionAlias? }` added
  and marked REQUIRED, with the reason recorded next to it: an identity, not
  display text, and a client must be able to show who is asking.
- `packages/relay-protocol/src/payload-validators.ts` — `isObj(agent)`, non-empty
  bounded `name`, optional bounded `sessionAlias`. A frame with a missing, empty,
  or non-string agent is REFUSED outright rather than forwarded unanswerable.
- `packages/channel-relay/src/channel.ts` — projected onto the frame, with
  `sessionAlias` carried only when present.
- `packages/relay-web` — the form renders that identity in its own element
  (`data-test="interaction-agent"`), with the "requested by" label present in
  both locales. It is deliberately not merged into the message line: the identity
  is trusted core state, while the message is agent-controlled and must not be
  able to impersonate it.

### P1 #2 - the web local validator drifted from core's (FIXED)

Two concrete drifts, both in the terminal direction:

- `text.length` measured UTF-16 units where core measures code points. `.length`
  says 2 for `"😀"` but the spec says 1, so `minLength: 2` satisfied one emoji here
  while core rejected it. Now `codePointLength()`, the same measure core uses.
- `Date.parse` plus a hand-rolled email regex approximated formats core delegates
  to `ajv-formats`. A second implementation is exactly the drift the reviewer
  predicted, and this one was already visible in the difference (a "uri" /
  "date-time" that satisfied the local check could still be rejected by core).

Now only `date` and `email` are checked locally — the two whose local reading
agrees with the reference — and every other `format`, including unknown names,
returns `unverifiable`. The caller blocks Submit on it. Fail-closed by design:
the alternative is letting the user construct an answer core will refuse to
accept after the interaction has already resolved.

Also added in the same function, from the same drift family: `single-select` now
rejects a selection outside its offered options, which is the only party the
renderer knows. And `pattern` is now DISPLAYED as metadata
(`data-test="interaction-pattern"`), because the earlier comment claimed the
pattern was shown to the user while the template never rendered it.

Why neither executes `pattern`: core's own rule is that an agent-supplied regex is
never compiled, since uncontrolled regex evaluation is a resource-exhaustion
vector, and the pattern is metadata for the agent to validate its own answer
against. The old comment said "left for core to enforce", which is not true — core
does not execute it either.

### P1 #3 - form capability declared channel-wide while only one route can serve
it (FIXED, in the renderer that over-claimed)

The channel declared `elicitationModes = ["form"]` channel-wide, but only one
route can actually render a form: the Direct Bot topic pane. The Sessions ChatPane
had no renderer at all, and its registry row had `sessionAlias: ""`.

The rendering consequence was in `direct-bots.ts`'s `pendingInteraction`: it
treated `conversation === undefined` as IN scope, i.e. belonging to whatever topic
the viewer happened to be reading. An ordinary channel turn (no product
correlation) could therefore be rendered into a topic the viewer never opened, and
answering it would silently answer a different conversation.

The scope predicate now requires a correlation and requires it to match the viewed
topic. An uncorrelated frame is scoped out of any topic view, and is reachable
only on the account-wide surface, which is where its turn was actually dispatched
from. Fail-closed in the other direction too: with no correlation there is no
topic the frame provably belongs to, and rendering it into one is the more
dangerous error.

Regression: the negative case (uncorrelated frame inside a topic view is NOT
rendered) is asserted directly, along with the positive (same frame, matching
correlation, IS rendered) and the account-wide reachability case.

### P2 - `parseHumanIngress()` dropped `chatType`, leaving the field dead (FIXED)

My previous addendum claimed HumanIngressContext carries `chatType` through. It
did not: `parseHumanIngress()` forwarded `chatKey`, `senderId`, `accountId`,
`senderName`, and `isOwner`, and silently dropped `chatType`. `HumanIngressContext`
declared it, so callers read the field and found nothing — the field was dead
while the type said otherwise, which is worse than it being absent.

It now round-trips `chatType` when it is exactly `"direct"` or `"group"`.

`undefined` is still NOT read as `"direct"`: a channel that reports nothing is a
channel whose route the renderer cannot vouch for, and that asymmetry is the
whole reason the contract makes the renderer refuse a form whose `chatType` is not
provably direct.

### Doc corrections carried over from this round

- The `pattern` claim: core does NOT enforce it, and neither does the renderer. It
  is metadata for display and for the agent's own validation. The wire carries it,
  the form shows it, nobody runs it.
- `defaultValue` is displayed only for `text` and `number`. `boolean`,
  `single-select`, and `multi-select` defaults are not surfaced, so "defaults are
  displayed" is true for two of five kinds — recorded here rather than left
  implied by the earlier wording.

### P2 - both brokers bound one collapsed route when a turn had two (FIXED)

The comment in session-handler justified binding both brokers to
`elicitationRoute ?? permissionRoute` with "a Direct Bot turn has NO permission
route by policy". That invariant is false. `resolvePermissionTurnRoute` resolves
`metadata.permissionChatKey ?? isolationChatKey`, so a Direct Bot turn carrying a
`permissionChatKey` DOES produce a permission route — the account-wide ingress
address — while `resolveElicitationTurnRoute` deliberately strips
`permissionChatKey` and keeps the product isolation key `bot:<conversation>:<topic>`.

The two are not a subset relation, they are different addresses for different
purposes. Collapsing them meant the permission broker was registered on the
elicitation route, i.e. a human permission request would be answered on
`bot:<...>` rather than on the trusted ingress key the daemon verified. Fail-closed
today only because the relay permission renderer is not open yet, which is
exactly why it had to be split BEFORE that renderer ships.

Each broker now receives its own route, sharing one minted `interactionId`, the
per-turn identity fields, and the channel's `chatType` report. The test installs
BOTH brokers and asserts the two binds carry different chatKeys, one shared
`interactionId`, and both addresses present. Reverting the permission route back
to the collapsed one turns it red.

## Addendum - fourth re-review round (2026-10-01)

Full re-review of the third round's fixes. Result was **request changes: 3 P1**,
one of which invalidated a fix I had just shipped.

### P1 #1 - the shared registry lost the second route, and the fix looked done (FIXED)

`src/main.ts` wires both brokers to ONE registry:

    elicitationBroker = new ElicitationInteractionBroker({
      registry: permissionBroker.turnRegistry, ... })

and `TurnInteractionRegistry.bindTurn()` threw on a second binding of the same
`interactionId`. So the round-3 "give each broker its own route" fix passed its
test and did nothing in production: the permission route bound first, the
elicitation bind threw duplicate, the handler's catch swallowed it, and the
registry kept only `relay:<account>`.

The broker then resolved a route from which `parseDirectConversationChatKey()`
derives no `conversation` correlation — so the uncorrelated-form gate I had just
added scoped the form OUT of the very topic it belonged to. Round 3's fix
converted a latent bug into a visibly broken Direct Bot form path.

Why the test missed it: it installed one fake `bindTurn` that recorded contexts,
so it proved the handler CALLED bind twice, not that the registry STORED two
routes. A fake that agrees with the fix is not evidence.

Fixed by making the data model carry the kind. `TurnInteractionRegistry` now keys
routes by `(interactionId, kind)`, with `kind` an explicit bind parameter, so two
different kinds never collide and each broker reads its own address. Liveness
(abort/dispose notification) stays keyed by the bare interactionId — the turn
dies once, so both kinds still fence on the same signal, and disposal only fires
when the LAST kind for a turn goes away.

`bindTurn(context, abortSignal, kind?)` takes the kind as a PARAMETER because a
context field alone forces every direct caller to know the broker's internal
kind; the first attempt with a field-only kind three test files binding routes
directly, which silently stored `"permission"` where the broker read
`"elicitation"`.

### P1 #2 - the web validator still approximated `date` and `email` (FIXED)

Round 3 fixed the code-point length measurement and failed open formats closed,
but left two hand-rolled checks that core does NOT use:

- `date` used `Date.parse`, which NORMALIZES an impossible calendar date rather
  than rejecting it. `Date.parse("2026-02-30")` is `2026-03-02T00:00:00Z`, while
  core's `isDate` range-checks the day against `daysInMonth(year, month)` and
  refuses it. Browser allowed Submit -> hub resolved -> core rejected -> the user
  could no longer correct the answer.
- `email` used `/^[^@\s]+@[^@\s]+$/`, which accepts `a..b@example.com`, `a@b`,
  and `é@example.com`; core's `ajv-formats` regex rejects all of them. Wrong in
  BOTH directions.

The browser cannot import core's answer, because `elicitation-schema.ts` pulls in
`ajv` at module scope — shipping a JSON Schema engine to read one string is not a
trade worth making.

So every format is now `unverifiable`, in BOTH places the rule was duplicated
(`formatProblem` for the Submit gate and `coerce` for input). Fail closed at
Submit, never at input: blocking a keystroke would silently discard the user's
text, whereas the Submit gate tells them the control cannot be checked yet. The
problem token is mapped to human-readable text rather than shown raw.

Core already proves the divergence in its own suite
(`elicitation-schema.test.ts` ~1960: "non-existent calendar dates are
rejected"). The web regression pins the counterexample the old check accepted.

### P1 #3 - channel-wide capability for a route-scoped renderer (FIXED, in the renderer)

Round 3 closed the half of this finding about cross-topic misrendering. The other
half remained: `elicitationModes = ["form"]` is declared CHANNEL-wide, so an
ordinary Relay session turn's agent still believes the turn can request a form.

The chain is real. `session-handler`'s `elicitationRoute ?? permissionRoute`
falls back to the permission route, which for an ordinary turn is
`relay:<accountId>`. `getChannelByChatKey` maps that to the relay channel, the
broker's capability check passes, `chatType: "direct"` from the control path
passes the privacy gate, and the hub opens an interaction. But
`conversationCorrelation()` needs a `bot:`-prefixed key, so the frame carries no
`conversation` row at all.

And there is no surface for it: `ConversationInteractionForm` is mounted only by
`ConversationMessageList`, rendered only by `DirectBotPane`, mounted only when a
Bot is selected. `ChatPane` has no interaction state. So round 3's change moved
the outcome from "shown in the wrong Bot topic" to "shown nowhere" — the form
still only ever reaches its timeout.

Fixed with a route-scoped refusal inside `requestElicitation`, matching the
existing convention (`control-bridge.ts` / `channel-scope.ts` prefix-test
chatKeys, and the renderer's own `not-direct` refusal). A turn whose chatKey is
not a Direct Conversation key is refused as `unsupported-route`, and the
capability comment now states plainly what the declaration cannot express: it is
per-channel, while the renderer is per-route.
