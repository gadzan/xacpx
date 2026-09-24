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
