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

## Addendum - fifth re-review round (2026-10-01)

Reviewing the shared-registry round. The route fix was confirmed to hold on the
real wiring; the round's own rewrite introduced one new defect and left one
terminal-mismatch hole open.

### P1 - `minLength`/`maxLength`/`format` were skipped for `single-select` (FIXED)

Core is explicit that the agent's string constraints apply to the CHOSEN option,
not only to typed text: `validateElicitationAnswer`'s `single-select` case checks
the value against the offered options and then applies `minLength`, `maxLength`,
and the four formats, with the comment "The agent's own string constraints apply
to the chosen option too." `relayFieldsFrom()` carries all of them onto the wire.

The web form's `fieldProblems()` checked only that the answer was an offered
option, so a legal schema the agent itself authored went straight through:

    enum: ["2026-02-30"], format: "date"

The browser shows one option, it came from the agent, the user picks it, Submit
is enabled, the hub resolves Accepted, and core then rejects it under strict
calendar validation. `enum: ["x"]` with `minLength: 2` is the same shape with the
code-point measurement.

The constraint block is now shared and applied to `text | single-select`.
`pattern` remains the one exception for both kinds: displayed, never executed.

This is also why the round-4 "EVERY format blocks Submit" test did not catch it —
it only constructed `kind: "text"`. A test that names every format but one field
kind proves the rule for that kind, not the rule.

Three regressions added: `format` on a selected option, `minLength` on a selected
option, and the astral/code-point case on a selected option. All three fail when
the shared block is scoped back to `text` alone.

### P2 - `clear()` never notified anyone (FIXED, and it was mine)

The registry rewrite cleared `abortListeners` and then looked the sets back up,
so every read returned `undefined` and `clear()` dropped the bindings silently —
while the interface still promised "Drop every binding and notify subscribers".
The daemon stayed safe only because both brokers abort their own pending before
calling `clear()` and no `await` separates the two, which is luck, not design.

Now the listener sets are snapshotted before anything is cleared, and the
notifications fire once per dead turn after the maps are emptied.

Two regressions: `subscribeAbort -> clear() -> fired === 1`, and the same turn
bound as BOTH kinds notifies exactly once. Notifying per-kind would fence a live
permission request because an unrelated elicitation route was cleared.

### Stale prose corrected

- `InteractionFieldDto.format` said "Text-only" and "the values the renderer knows
  are `date` and `email`". It is not text-only (see the P1 above), and the only
  safe renderer behavior is to treat EVERY format as unverifiable, because
  `email`/`uri` are `ajv-formats` regexes and `date`/`date-time` need real
  calendar validation that `Date.parse` does not perform.
- `InteractionFieldDto.pattern` said a supporting renderer "compiles it in a
  guarded branch". Neither core nor the Relay renderer executes it now: it is
  display metadata, and the asking Agent validates its own pattern.

## Addendum - sixth re-review round (2026-10-01)

Full review of the single-select/`clear()` round. Two new P1s and three P2s; all
fixed.

### P1 - interaction visibility was missing the `instanceId` dimension (FIXED)

`DashboardView` subscribes to EVERY instance under the account, so a background
daemon's events keep flowing, and this store deliberately stores every
`interaction-opened` it processes with the source instance attached.

`pendingInteraction`'s scope predicate compared `conversationId` and `topicId`
only. Those are not globally unique: two daemons that copied state, restored a
backup, or were cloned produce the same `c1/t1`. So instance B's form was in
scope for A's pane — and because Submit routes to the state's own `instanceId`,
the user would read B's question in A's UI and deliver the answer to B. A
cross-instance isolation failure of the same family as the cross-topic one above,
with the third scope key missing.

The instance is now the first thing checked. `null` (no instance selected) is the
account-wide surface, where there is no instance to be wrong about, so it scopes
nothing out. Three regressions: another instance's same-topic form is not
rendered, the selected instance's is, and an unselected instance leaves both
reachable.

### P1 - an empty-string answer skipped every constraint (FIXED)

`fieldProblems()` treated `""` as absent, which the store's own semantics
contradict: answers are own properties, so a user who types `"a"` and deletes it
leaves a real `""`, and `collectInteractionAnswers()` sends that `""` verbatim.
For a REQUIRED field the `required` check caught it; for an OPTIONAL field it
skipped `minLength`/`maxLength`/`format` entirely, the hub resolved Accepted, and
core then validated the genuine `""` and rejected — form already gone.

Presence and emptiness are now separate facts: `answer === undefined` is absence,
which is what `required` governs, and anything else is an answer whose
constraints apply — including `""`. Three regressions: optional + `minLength: 1`
+ `""`, optional + `format` + `""`, and the control (optional + untouched is not
validated and IS submittable).

### P2 - unknown `format` was blocked, and a test pinned the wrong semantics (FIXED)

`formatProblem()` returned `unverifiable` for every non-`text` format, so
`some-future-format` disabled Submit permanently — while core's dispatch ends in
`default: return true`, because the ACP RFD requires clients to PRESERVE unknown
formats for the renderer to interpret. An unknown name is an annotation, not a
constraint, and blocking it invented a rule core does not have.

Now only the four names core actually validates (`email`, `uri`, `date`,
`date-time`) fail closed. The existing test had enumerated `some-future-format`
among the blocked, pinning the drift; it is split into a blocked set and an
explicitly-passed set.

### P2 - reconnect replay discarded an unsubmitted draft (FIXED)

A reconnect replays every still-open interaction, and the handler rebuilt the
entry unconditionally with `emptyAnswers()`. A user who had half-filled the form
lost the draft to a transient disconnect. Not a wrong-answer bug, since the
answer is never sent, but definite data loss introduced by the replay feature.

`interaction-opened` now recognises a requestId it already holds as a replay: the
server-shaped half (`request`, hence `expiresAt`; plus `instanceId`/`kind`, which
the event states authoritatively) comes from the replay, while `answers` and
`errorCode` stay the user's. `submitting` resets to `false`, because an ack in
flight across a disconnect is unknowable and close/reconcile converges it. A
still-open replay carries no terminal state, so an `outcome` already reached is
preserved rather than quietly hidden. The cold path is untouched.

### P2 - `controlName()` produced duplicate DOM ids (FIXED)

Sanitizing and slicing the key collided: `"a-b"` and `"ab"` both produced
`"fab"`, as did two keys sharing their first 16 sanitized characters. Duplicate
HTML ids make `<label :for>` bind to the first match, so the label names the wrong
control. Data was unaffected (the `@input` handler closes over the raw
`field.key`), so this was DOM/accessibility correctness.

The id is now index-led (`f${index}-${sanitizedKey}`), unique per rendered field
and stable across re-renders because the index comes from the field list derived
from the immutable request. `data-test` attributes still use the raw key, which is
the test contract.

## Addendum - seventh re-review round (2026-10-01)

No new P1s. Two P2s and one accessibility P3 from a full re-scan.

### P2 - Relay dropped schema-level presentation metadata (FIXED)

Core's `ChannelElicitationRequest` carries `schemaTitle` AND `schemaDescription`,
and Discord/Feishu render both. The relay channel projected only the title, and
the wire DTO had no `description` member at all — while Relay Web did not render
even the title.

This is a real loss precisely because the wire validator allows `message: ""`
("a schema with a good title needs no prose"): an agent that carries its whole
question in the schema produced a form with nothing above the fields, asking
nothing.

`schemaDescription` is now on the DTO, validated (bounded, non-string refused),
projected by the channel, and rendered by the web form beside the message with the
same no-v-html rule.

### P2 - terminal forms kept their answers and accumulated (FIXED)

`retireInteraction()` and the `interaction-closed` handler copied the whole state
into the terminal map, so a finished form held the answers the user typed until
they happened to visit that exact topic and dismiss it — or reload. The terminal
notice explains why a form went away; nothing downstream consumes the answer
text. Answers are now dropped the instant a form reaches a terminal state.

The terminal map also had no bound, and it receives entries for every topic under
every instance from the account-wide subscription. It is now capped at 32 with
the oldest evicted first (insertion order is arrival order, because every write
re-inserts through `new Map(current).set(...)`), and the current size is exposed
so the bound is observable.

### P3 - `<label for>` pointed at controls that do not exist (FIXED)

The fix for duplicate ids left the `<label for>` in place for every field kind,
but `boolean` (a button pair) and `multi-select` (a checkbox group) render no
control carrying that id. A `for` that resolves to nothing misleads assistive
technology and anything walking `for` -> element.

Those two kinds now render a `role="group"` element named by a legend span via
`aria-labelledby`, and `<label for>` is emitted only for the kinds that render
exactly one control with that id.

## Addendum - eighth re-review round (2026-10-01)

No new P1s. One P2, a wire-boundary contract drift.

### P2 - the Hub's field limits disagreed with core's normalization limits (FIXED)

`relayFieldsFrom()` is contracted to copy the form core already normalized and
bounded, field for field. That makes core's `ELICITATION_SCHEMA_LIMITS` the
authority on what a LEGAL form is, and the wire validator was out of step with it
in both directions:

  | member            | core | hub | effect |
  |-------------------|------|-----|--------|
  | field key         | 128  |  64 | stricter — a legal form failed to open |
  | field title       | 256  | 200 | stricter |
  | option value      | 256  | 200 | stricter |
  | option label      | 256  | 200 | stricter |
  | fields            |  20  | 100 | looser |
  | options per field | 100  | 200 | looser |
  | pattern           | 512  |2000 | looser |
  | default string    | 256  |8000 | looser |
  | schema title      | 256  | none | unbounded outright |

The stricter rows are functional, not cosmetic: an 80-character field key is a
perfectly legal ACP schema, core accepts it, `relayFieldsFrom()` forwards it
verbatim, and `isBoundedStr(v.key, 64)` rejected the whole request — so a legal
elicitation became a transport failure instead of a form.

The looser rows break the validator's own stated claim that it refuses shapes
"core never produced": a bound wider than core's cannot keep that, and
`schemaTitle` had no length check at all while the section comment implied one.

`INTERACTION_WIRE_LIMITS` is the wire's copy of the contract, in one table with
the core value each member mirrors, and every site reads from it. The three
bounds the validator was missing entirely — `schemaTitle` length, field and option
`description` length, and per-item `multi-select` default length — are now
enforced. (`defaultValue` was checked only as a single string, so a two-item array
of 1000-char strings passed a 256-per-item rule.)

The boundary contract is pinned by tests that assert every core MAXIMUM is
accepted and every maximum + 1 refused, for fields, options, schema metadata, and
the two count limits.

Those tests hold core's numbers as LITERALS rather than reading the table under
test. The first version imported `INTERACTION_WIRE_LIMITS` into the expectations,
which made the test self-consistent by construction — lowering the wire bound
drifted the expectation with it, and the mutation stayed green. Comparing a table
against itself proves nothing; the numbers have to be independent for a drift to
be visible.

## Addendum - ninth re-review round (2026-10-01)

Full re-review of all 55 changed files, base -> head. Result: 1 P1 + 2 P2, all
fixed here.

### P1 - reconnect reconciliation judged an account-wide map by the current pane's Run (FIXED)

The hub subscription is account-wide on purpose, and `interaction-opened` is
stored before the selected-instance fence, so `pendingInteractions` can hold
forms for several instances and topics at once. The reconcile loop then computed
`runGone` from `activeRun` — the SELECTED pane's single Run — for every entry in
the map.

So while viewing instance A, a background form from instance B was checked
against A's `activeRun`. With A idle, `runGone` was true and B's form was retired
as `withdrawn` even though the hub still held it open and the agent was still
waiting. The subscribe replay races the reconcile loop rather than preventing it:
a B form replayed moments earlier is killed by the same loop, and there is no
second authoritative replay, so it was permanently unanswerable.

The same design also fails in the other direction. Hub subscribe is a POSITIVE
replay — only still-open requests are re-sent, with no authoritative "open set
complete" message — so a form answered from another tab while this one was
disconnected stays local until the user clicks Submit and gets a 409.

Both are one root cause: interaction liveness is request-scoped, but it was being
approximated from a Run. The run check is now scoped to the interaction that
belongs to the turn this pane is actually showing (instance + conversation +
topic), and anything else keeps its open state until the hub's own close event or
replay says otherwise — which the hub already delivers authoritatively.

Two regressions, and the negative one asserts on `requestStillHeld()` rather than
`pendingInteraction`, because another instance's form is legitimately INVISIBLE in
this pane; asserting on the visible slot would pass while the entry was destroyed.
`requestStillHeld()` exists so "is this still open at all" is answerable without
inferring it from the visible slot.

### P2 - the hub did not check the response KIND before consuming the request (FIXED)

`PendingInteraction` recorded `kind`, and `validateInteractionResponse` checked
`kind` and `action` only against their own vocabularies, so nothing tied them
together. A shape-valid `{kind: "permission", action: "allow_once"}` aimed at an
open elicitation was accepted: the hub finished the request, deleted it,
broadcast a close — and only then did the connector's `parseRelayInteractionOutcome()`
reject the frame for not being an elicitation. The user lost a good form to a frame
that was never meant for it, and the close broadcast reported a human decision
that never happened.

Checked at both boundaries, deliberately: the HTTP handler AND the registry's own
`answer()`, so no future caller can bypass it. The registry refuses the ANSWER
rather than closing the window, which is what preserves the form. The regression
fails only when BOTH fences are removed — which is what makes this
defense-in-depth rather than two copies of one bug.

### P2 - `expired` was reported as the user cancelling (FIXED)

`interaction-closed(reason: "expired")` and the reconnect local-expiry path both
produced `cancelled`. `cancelled` asserts the user made a decision; a passing
deadline is the opposite, and the component's own rule is that a hub-side close is
`withdrawn` and never `cancelled`. Same terminal-label drift as the Decline/Cancel
fix.

Two EXISTING tests had pinned the wrong behaviour (`expired -> cancelled`), so
they were rewritten rather than kept green — a test that asserts a misreported
human action is pinning the defect.

### Cleanup

`tests/unit/packages/channel-relay/relay-elicitation-full-chain.test.ts` was a
0-byte file. The real full-chain coverage lives in
`relay-elicitation-browser-delivery.test.ts`, which drives a real `RelayChannel`
+ `RelayClient` + connector WS + `InstanceGateway` + registry + `WebGateway`
subscription + browser answer. The empty file only made a test entry point that
did not exist, so it was deleted.

### Explicitly NOT findings, re-verified this round

`RelayClient.stop()` does not reject in-flight `pendingRequests`, because the
close handler returns early when stopped. Traced the production shutdown order:
`buildApp.dispose()` aborts the elicitation broker first, which settles every
request through its own abort race before channel/transport teardown, so no
production request is left hanging.

Browser RPC matches on `accountId` rather than the URL's `instanceId`. The
identity model is an account-authenticated human and `requestId` is the
interaction authority; cross-instance context isolation is handled separately and
was fixed in round 6.

The global registry keys on a bare `requestId`. Production requestIds come from
the worker's `randomUUID()`, not an agent-controlled ACP JSON-RPC id, so the
theoretical collision is not an attacker-reachable path.

## Addendum - tenth re-review round (2026-10-01)

The authoritative open-set gap from round 9, closed for the state it can reach.

### P2 - a gone interaction was reported but never retired (FIXED)

Round 9 left this deliberately open: the hub's subscribe is a POSITIVE replay with
no "open set complete" boundary, so a form answered from another tab during an
outage stays local until the user acts. The authority that eventually arrives is a
409, and the store did not act on it.

`submitInteraction`'s catch set `errorCode: "interactionGone"` and stopped. Its own
comment said "A gone interaction is a normal ending, not an error to retry
forever", and the behaviour did not match it: the request stayed in
`pendingInteractions`, the terminal notice never appeared, and the component kept
rendering Submit / Decline / Cancel. So a user could click the dead form, get the
same 409, and repeat indefinitely on a request nobody was waiting for.

The hub was already fail-closed — no stale decision is accepted — so this is state
consistency rather than correctness or security. But the comment promised a normal
ending and the code parked a corpse.

`interaction-gone` now retires the form as `withdrawn` (not `cancelled` — the user
chose nothing; something else consumed it). The same fix applies to the pre-submit
expiry branch, which had the identical shape: it set an error code on a window the
user cannot act on and left the controls live.

Two EXISTING tests asserted the old behaviour — one of them with the comment "the
form must say so instead of staying up forever" directly above an assertion that
it stay up forever. Both were rewritten.

### What this does NOT close

The gap the reviewer correctly separated from this fix: if the user never clicks,
a form answered elsewhere during the outage is still displayed indefinitely, and
only an authoritative open-set snapshot can end it. Retiring on the 409 is the
smallest self-healing the hub actually offers; the protocol work remains open.

Also worth stating: the fix does not weaken the retry path. A transport failure
(`submitFailed`) is NOT authoritative about the window — the request may still be
open — so that branch still leaves the form answerable, which is asserted
separately above.

## Addendum - the reconnect open-set gap (2026-10-02)

The previous round closed the "parked corpse" — a form answered elsewhere during
an outage stayed on screen until the user clicked it and got a 409 — and named the
remaining gap exactly: that is the smallest self-healing the hub offers, but only
an **authoritative open-set snapshot** actually ends it, and that protocol work
stayed open. It is now closed.

### The hole: replay is positive-only

Every interaction control-event is a one-shot push, and `interaction-closed` is
its only negative. So a browser that was disconnected when an interaction was
answered elsewhere receives **neither**: it missed the open, and it missed the
close. Replay covered the opening direction well — subscribe re-sends everything
the registry still holds — but a replay cannot say "that is all of them". The
client therefore had no way to distinguish:

- "I have every open form" — correct after a clean reconnect, from
- "I am missing an event" — the disconnect case, where a form the hub already
  deleted is still in `pendingInteractions`.

The distinction is what makes retirement possible. Without it the client's only
defensible choice is to keep what it holds, which is precisely the indefinite
display the previous addendum was written to end.

### The change: `interaction-snapshot`

A **web event**, not a control-plane message. It rides the browser socket in the
normal server→web envelope — `RelayEnvelope { type: "web.event" }` with
`payload.kind === "interaction-snapshot"` — exactly like `state-snapshot` and
`interaction-opened`. There is deliberately no `MSG.*` constant and no
connector↔hub message for it: the connector is not a party. An earlier draft had a
`MSG.interactionSnapshot` constant and it was removed as dead weight, so do not
re-add one; the kind string is the whole contract.

Hub -> browser, on subscribe, after the state snapshot:

```text
subscribe -> [agent-directory, state-snapshot, interaction-snapshot]
```

The outer frame carries `instanceId`; each entry carries `chatKey`,
`sessionAlias`, and the full `InteractionRequestDto` — the same halves the live
`interaction-opened` carries. Carrying the whole request rather than bare
requestIds is what lets the client reuse the existing open handler for the cold
path, so the snapshot introduces no second merge rule that could drift from the
live event's.

The client reconciles three ways under the instance the snapshot names:

| local | in snapshot | effect |
|---|---|---|
| held | yes | merge: server-shaped half from the snapshot, local `answers`/`errorCode` preserved |
| held | no | **close as `gone`** — the neutral outcome; see the addendum below |
| not held | yes | cold open, routed by the entry's own `chatKey`/`sessionAlias`, not invented |

`gone` rather than `withdrawn` or `cancelled` is deliberate: the snapshot proves
the window closed and nothing more. `withdrawn` asserts nobody chose anything and
`cancelled` asserts the user chose to stop — both are claims about a cause the hub
never sent. See "Addendum - omission is not a withdrawal" below.

The instance fence runs **both** directions. The store is account-wide and holds
forms for several instances; a snapshot is a statement about exactly one, so an
omissive signal is only meaningful there. A snapshot for A retires nothing of B's,
and a snapshot naming B's form does not open it into A's pane. Either direction of
slack would let one instance's window destroy another's live form.

### Where the validation lives

Entries go through `validInteractionRequest`, the same field rules the live open
path enforces, and the frame is refused **whole** on any violation — a partially
parsed open set is worse than none, because the retirement it triggers would be
based on an incomplete list. This keeps the snapshot from becoming a route around
validation: a reconnect cannot resurrect a form the hub would never have accepted.

An empty `interactions` array is the strongest form of the frame — "nothing is open
for this instance" — and must stay valid, or reconnect silently degrades to the
positive-only behaviour precisely when the negative signal matters most.

### Proof

Per-REVIEW-RULES.md every fix carries a regression that fails without it.

Hub side (`tests/unit/packages/relay/terminal-web-inbound.test.ts`): the snapshot
is sent with the authoritative set; an interaction that resolved is absent, which
is the negative evidence; the snapshot is scoped to one instance; an entry carries
the routing a cold open needs; a malformed frame is refused. Disabling the send
fails all five.

Protocol side (`tests/unit/packages/relay-protocol/relay-interaction-protocol.test.ts`):
a populated frame parses, an empty one parses, an entry missing any of its three
halves is refused, and an entry whose request core would reject is refused.
Removing the entry checks fails the latter two; the first two guard against the
frame kind being unknown to the validator, which would be indistinguishable from
a strict rejection at a browser.

Client side (`packages/relay-web/src/__tests__/direct-bots-interactions.test.ts`):
an omitted local form is closed, a still-listed one keeps its draft, a cold form
opens, another instance's forms are untouched and do not render into this pane.
Skipping the retire loop fails the omission test only; skipping the cold-open loop
fails both cold-open tests; removing the instance fence fails the isolation test
only; re-asserting `withdrawn` on omission fails the omission test only.

### Deliberately not changed

`renderGeneration` publication semantics (from the earlier in-flight race fix) are
untouched: a generation is published only after a successful `updateCard`. That
round's reviewer explicitly forbade committing early, because it re-opens the
"failed update re-fences the live card" regression, and nothing here needs it.

The retirement is a snapshot-local reconciliation, not a new downlink queue. The
hub still answers through the existing long-lived `interactionRequest` call, so
there is no second path an answer could take and no second owner of the outcome.

### Where the validation lives

Entries go through `validInteractionRequest`, the same field rules the live open
path enforces, and the frame is refused **whole** on any violation — a partially
parsed open set is worse than none, because the retirement it triggers would be
based on an incomplete list. This keeps the snapshot from becoming a route around
validation: a reconnect cannot resurrect a form the hub would never have accepted.

An empty `interactions` array is the strongest form of the frame — "nothing is open
for this instance" — and must stay valid, or reconnect silently degrades to the
positive-only behaviour precisely when the negative signal matters most.

### Ordering invariant

The subscribe branch installs the subscription, captures the open set, and sends
every frame in **one synchronous turn**. That is what makes omission safe to act
on:

- open before the capture → in the snapshot
- closed before the capture → absent from the snapshot
- open after the send → the live event lands after the snapshot

An `await` inserted between the subscription and the capture (a database lookup,
metrics, a permission re-check) opens a window where an interaction can open, be
omitted from the snapshot, *and* have its live event land first — so the client
retires a form the hub still holds. Repairing that needs a revision / sequence
fence. The branch therefore stays synchronous, the reason is written at the top of
it, and `terminal-web-inbound.test.ts` pins it with a no-`await` assertion.

## Addendum - omission is not a withdrawal (2026-10-02)

The addendum above shipped a real defect that a review round caught. Recording it
here because the mistake generalises.

The motivating case reads like a withdrawal:

```text
Tab A disconnects
Tab B Accepts
the hub resolves and removes the interaction
Tab A reconnects
```

so the omission was mapped straight to `withdrawn`. But the motivating case is one
of at least five the snapshot cannot distinguish — `accepted`, `declined`,
`cancelled`, `expired`, `withdrawn` — and the mechanism carries no information
about which one it was. `withdrawn` asserts "nobody chose anything"; after another
tab accepted, that is false, and the UI told the user the window was pulled when
someone had answered it.

The proof that the snapshot cannot know is structural, not incidental. It reports
the **current open set**; a terminal reason exists only on a request that is no
longer open, so the frame is by construction silent about every terminal cause. Any
label chosen from an absence is invented.

So the omission now maps to a new neutral outcome, `gone`, and the notice is
`This request is no longer available.` / `该请求已不再可用。` — a statement about
availability, which is the only thing proven. The named outcomes stay reserved for
a hub close event that names one.

Saying which of the five it really was needs the hub to keep a short terminal
tombstone (`{ requestId, action, reason }`) past the close and send it to a
reconnecting browser. That is a separate capability, deliberately not guessed at
here — and not smuggled in through the open set.

## Addendum - two validation authorities, two drift bugs (2026-10-02)

The same review round caught two boundaries this work had left inconsistent with
the paths it claimed to mirror.

### Run state stopped being an authority over interaction liveness

`reconcileOnReconnect()` still retired an interaction whose owning turn had no
live Run, reasoning that a finished turn cannot still be waiting on a form. That
was defensible when the hub offered nothing better, and it is wrong now:

- `activeRun` is the **selected pane's single Run** while the pending map is
  account-wide, so it could retire a form for another instance or topic that the
  hub still held open.
- It runs **after** the authoritative snapshot has already proven the request
  open, so a weaker heuristic could undo — one microtask later — a fact the hub had
  just settled.

Two authorities over one fact is the bug regardless of which one wins on a given
run. Interaction liveness is now decided only by `interaction-opened` /
`interaction-closed`, the authoritative snapshot, `expiresAt`, and the hub's
`interaction-gone`. The loop keeps only its local, non-authoritative expiry check,
which reads the request itself. The two tests that pinned the old heuristic were
replaced by one asserting a completed Run leaves the form open.

### The snapshot entry validator had already drifted from the live path

The live `interaction-opened` event and a snapshot entry are the same fact by two
routes, and each had its own hand-written check. They had already diverged: the
snapshot required `isBoundedStr(chatKey, 128)` while the live event required only
`typeof === "string"` — the convention every other control event uses for those
fields. The snapshot was therefore **stricter** than the path it claimed to mirror,
and any field added to one wire path would silently have been missing from the
other.

Both now call one `validInteractionOpenShape()`. The bounds stay off
`chatKey`/`sessionAlias` to match the rest of the file — bounding only these would
refuse real clients whose keys exceed the cap, and the per-field bounds belong to
the request itself.

The regression asserts the **pair**, not a particular bound: a mutation is applied
once and fed to both paths, and the test requires them to agree. Whether a given
shape is accepted is the helper's business; that two wire paths cannot disagree is
the contract, and it is what a near-copy breaks. Re-introducing the original drift
fails it.

### A note on mutation testing

Three of the first mutations against this work silently did not apply: the
replacement strings used `\n` while the files use CRLF, `split().length - 1`
returned 0, and the mutation script printed "mutated" anyway. The tests stayed
green and read as "this case is not covered".

An `AMBIGUOUS occurrences=0` guard is not enough. Assert the mutation **landed** —
re-read the file and confirm the marker is present — before drawing any conclusion
from a green run. This is recorded in the addendum rather than removed because a
mutation that fails silently is indistinguishable from a missing test, which is the
exact situation it exists to prevent.

## Addendum - the missing negatives (2026-10-02)

Two more "absence is not evidence of a cause" paths, both found by walking the real
chain rather than the diff. They are the same defect as the omission addendum,
arriving through different doors, which is the useful generalisation:

> **Absence of a request, of an instance, and of a 409 all prove only that
> something is gone. None of them says who or why.**

### `subscribe` must install the subscription

The subscribe branch filtered `instanceIds` and sent the directory, state snapshot,
replay and interaction snapshot — and never called `setSubscription()`.

`WebGateway` treats a socket ABSENT from its subscription map as "receive every
control-event", so this was not a harmless omission. A browser subscribing `["i1"]`
received instance i2's live `interaction-opened`, stored it account-wide, and then
never received an i2 interaction-snapshot — because it only subscribes i1. The form
could not be retired on reconnect, so the stale-form bug this whole change exists to
fix reappeared for exactly the instances the subscription was meant to exclude.

Fixed by restoring the call ahead of every send, which also makes the branch match
the ordering invariant written at its head. The existing test was asserting only
what was SENT, which structurally cannot detect a missing subscription — the frames
look identical either way. It now asserts routing through the real `WebGateway`,
and two new tests cover install-and-scope and a re-subscribe narrowing an existing
set. Deleting the call again fails all three from outside.

### An instance deleted while disconnected

`DELETE /api/instances/:id` removes an instance from the account's owned set. The
subscribe's ownership filter then drops that instance on reconnect, so it never
receives an `interaction-snapshot` again — and the tab holds a pending interaction
for it with no open, no close, no snapshot, and no timer.

The snapshot is authoritative per instance, and its SCOPE is the set the browser is
still allowed to ask about. What went missing here is not one request but the
instance that owned the set the request would have been proven absent from, so the
negative evidence is the owned-instance list, re-checked after a successful refresh.

Only a SUCCEEDED refresh may conclude anything: a failed `/api/instances` says
nothing about what was deleted (offline, expired session and 503 are
indistinguishable), and retiring on it would let a transient error destroy live
forms — strictly worse than the bug. Scoped per instance, so X's removal never
touches Y's. Outcome is `gone`, for the same reason as the snapshot absence.

### The 409 asserted a cause the hub never sent

`submitInteraction()` still retired an `interaction-gone` failure as `withdrawn`,
which asserts "nobody chose anything". The most common real cause is the opposite:
another tab accepted, which is precisely why the request is gone. The tab then told
the user "Closed before an answer arrived" about a question that had already been
answered.

A 409 carries exactly as much information as a snapshot omission — the request is no
longer open — so it gets the same neutral `gone`. Two tests had pinned the old
label and were rewritten.

What keeps a NAMED outcome: a hub-sent `interaction-closed` carries a reason, and
local expiry reports `withdrawn` because the client knows the deadline passed. Those
name a cause. Absence never does, whether it arrives as a frame, a missing scope, or
an HTTP status.

## Addendum - docs and the test that proved the wrong thing (2026-10-02)

Two documentation defects and one test that did not test what it claimed.

`InteractionSnapshotDto` documented each entry as carrying `chatKey`, `sessionAlias`
and `instanceId`. The entry carries only the first two; `instanceId` is the
snapshot's OUTER field, and appears in an entry only because the live event is not
itself scoped. The comment sat exactly where someone changing the protocol would
read it as the contract, so it now says where each field lives and that both shapes
are validated by one helper.

The closure's protocol description now states that `interaction-snapshot` is a web
event (`type: "web.event"`, `payload.kind`), with no `MSG.*` constant and no
connector-facing message. An earlier draft had a `MSG.interactionSnapshot`
constant; it was removed as dead weight, and the doc now warns against re-adding
one so nobody builds a control-plane message out of a misread addendum.

The ordering test "an interaction opened AFTER subscribe lands after the snapshot"
issued a SECOND subscribe and compared two snapshot indices. That proves the second
snapshot ordering, not that a live open after the snapshot is delivered after it —
which is what the invariant is about. It now really broadcasts a live
`interaction-opened` through the gateway and asserts it lands after everything
subscribe sent. The no-`await` mutation still fails it, so the ordering coverage
survived the rewrite.

### The mutation guard, again

Two mutation scripts reported success without changing anything: one compared the
buffer against itself after writing, one matched a string that also appears
legitimately in an unrelated capability list. Both are the same mistake the CRLF
note already warned about — treating "the script ran" as "the mutation landed".

The reliable pattern, used for everything after: assert the replacement count is
exactly 1, then compare the buffer against the ORIGINAL file content, then verify
the specific deleted target is absent, and only then run the tests.
