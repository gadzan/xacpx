# ACP Elicitation M2 — Discord Elicitation Implementation Plan (execution)

> **Status:** ready for implementation
>
> **Date:** 2026-09-22
>
> **Inputs:** `docs/superpowers/plans/2026-09-20-acp-elicitation-discord-plan.md`
> (the design) + `docs/superpowers/closures/2026-09-20-acp-elicitation-m1-closure.md`
> (the contracts M1 settled after 21 review rounds).
>
> **Dependency:** M1 is merged/mergeable. No dependency on PR #350.

---

## 0. What M1 already guarantees (do not re-derive)

The Discord renderer is a **plugin**. It consumes `xacpx/plugin-api` types and
never imports `src/interactions/*` directly. Core owns everything in this table,
so M2 must NOT re-implement or second-guess it:

| Concern | Owner | M2's obligation |
|---|---|---|
| Schema normalization + resource bounds | core | render only what arrives |
| Answer validation (constraints, code points, formats) | core | never pre-accept; send raw values |
| Exact-turn ownership (`requester.senderId`) | core | authenticate against it |
| `agent.name` identity for this turn | core | **display it**; never substitute `message` |
| External cancellation (`request.signal`) | core | **withdraw UI immediately**; never return a responder-free decision |
| Fail-closed `cancel` on unsupported/invalid | core | may also cancel for Discord platform limits |
| Answer privacy (no answers in logs/ids) | core broker + M2 memory | never put answers in custom ids |

`requestElicitation()` resolves to exactly one of three decisions, and every
member **requires** `responderId` (there is deliberately no responder-free
variant — see M1 rounds 14/15):

```ts
{ action: "accept", responderId, content }   // user reviewed + submitted
{ action: "decline", responderId }           // user explicitly refuses
{ action: "cancel", responderId }            // user dismisses
```

On `request.signal` abort: disable the UI, stop collecting, and **reject/throw
or never settle** — core settles `cancel` itself.

---

## 1. Step 1 — Add the pending-state module (`elicitation-state.ts`)

Answer state is **plugin-side memory only**. Never in Discord custom ids, never
in message content that could be logged, never persisted.

```ts
export interface PendingDiscordElicitation {
  readonly token: string;                 // opaque, random, custom-id correlate
  readonly requestId: string;             // core correlation id, not an answer
  readonly requesterId: string;           // == request.requester.senderId
  readonly channelId: string;
  readonly messageId: string;
  readonly request: ChannelElicitationRequest;
  values: Record<string, ChannelElicitationValue>;
  readonly currentField?: string;
  settled: boolean;
  readonly expiresAt: number;
}
```

Rules pinned by tests:
- **Custom ids contain ONLY `token` + routing identity.** A regression must fail
  if any answer value ever reaches a custom id (sentinel test).
- **First-terminal-wins**: `settled` is checked-and-set atomically before any
  late callback can mutate or resolve.
- **Token is not authorization.** Possession never authorizes; the callback's
  platform-authenticated user id must equal `requesterId`.

## 2. Step 2 — Token + custom-id helpers (`elicitation-ui.ts`)

Mirror `permission-ui.ts`'s shape — opaque token, parse, never guess:

```ts
export function createElicitationToken(): string;   // randomUUID, like permission
export function elicitationCustomId(token: string, action: ElicitationUiAction): string;
export function parseElicitationCustomId(customId: string): { token: string; action: ElicitationUiAction } | null;
```

`ElicitationUiAction` is a closed union: `start`, `field:<key>:open`, `review`,
`edit`, `submit`, `decline`, `cancel`. Routing identity only — never an answer.

## 3. Step 3 — Capability declaration

```ts
readonly elicitationModes = ["form"] as const;
```

Declared **only** when `requestElicitation()` is implemented. M1's
`hasElicitationFormCapability()` requires both, and M1 narrowed the plugin-facing
mode union to `"form"` only (round 17), so URL is not expressible here at all.

## 4. Step 4 — Renderability gate (Discord platform limits)

Before rendering anything, verify the form can be represented **faithfully**.
If not: return `{ action: "cancel", responderId }` and log bounded metadata
reason only. Never truncate options or merge fields to force a form through.

Limits to check (values from Discord's current API):
- 5 action rows per message, 5 buttons per row;
- string-select option count (25) and label/value length bounds;
- 5 text inputs per modal, label 45 chars, value 4000 chars;
- message/embed description length;
- field count vs. rows needed by the wizard.

Regression: a 30-option single-select cancels; a 4-field mixed form renders.

## 5. Step 5 — The wizard

### 5.1 Initial card
Agent name (from `request.agent.name`, REQUIRED — display, never substitute),
bounded `request.message`, field summary, progress, and
`Start` / `Decline` / `Cancel`.

### 5.2 Field renderers
| Kind | Discord control |
|---|---|
| boolean | Yes/No buttons |
| single-select | String Select (paginate within the 25 cap; else cancel) |
| multi-select | String Select with `min_values`/`max_values` from the field |
| text | modal TextInput, `defaultValue` as initial content where supported |
| number/integer | modal TextInput → local parse → typed value |
| date/date-time/email/uri | text input + localized hint; **core validates** |

Renderer never pre-validates against core's rules; core is authoritative.

### 5.3 Mandatory review step
Before `accept`: a review page showing every normalized field label and its
current value, with `Edit` / `Submit` / `Decline` / `Cancel`.

`Submit` is the **only** path producing `accept`. This is the ACP MUST
(review/modify before sending) that M1's contract also states.

### 5.4 Prefill policy
Core hands over only a `defaultValue` it would itself accept (M1's core-safe
pre-fill policy, rounds 13/16/20). Discord may use it as initial content — never
as a substitute for the user's answer.

## 6. Step 6 — Authorization on every callback

For every button / select / modal callback:

```text
platform authenticated user id == request.requester.senderId
```

Otherwise: do not mutate pending values, do not resolve, optionally a private
"not your request" response, and leave the original request pending. **No
owner/admin override in v1.** Custom-id token possession is never authorization.

## 7. Step 7 — Abort / timeout / stop

Subscribe to `request.signal` at dispatch. On abort or expiry, atomically:
1. settle pending state;
2. edit the message to disabled components where still possible;
3. show a localized terminal status;
4. ignore all later callbacks;
5. never submit partial values.

On plugin stop/logout/disable, settle every pending request. Existing
permission-UI cleanup paths are the precedent to reuse.

## 8. Step 8 — Rendering safety

Agent-controlled strings (`message`, titles, descriptions, option labels and
descriptions, defaults) render as literal data. Reuse
`escapeDiscordLiteralText()` from `permission-ui.ts` where semantically suitable.
Must not create: `@everyone`/`@here` effects, arbitrary user/role mentions,
markdown that obscures the form, custom-id injection, or unbounded length.

Regression set (sentinel-based, same style as M1's privacy tests):
`@everyone`, `<@123>`, markdown links, code fences, bidi chars, zero-width
chars, and a 64k string.

## 9. Step 9 — Channel wiring (`channel.ts`)

Implement `requestElicitation()` on the Discord runtime; route interaction
callbacks to the elicitation handler; declare `elicitationModes`. Keep the
permission interaction paths untouched (M1 proved the permission suite is
unchanged by the shared registry — do not disturb it).

## 10. Step 10 — Tests

Mirror the M1 test matrix in `docs/.../discord-plan.md` §13, but with the
**mutation discipline** this project now uses: every new regression must fail
when its fix is disabled, verified by mutation, not just pass.

- happy path per field kind; mixed multi-page; defaults; review/edit/submit;
- all three ACP actions distinct;
- authorization: wrong user on button/select/modal, original user still able to
  answer afterwards;
- lifecycle: timeout, upstream abort, stop/logout, duplicate button, duplicate
  modal, stale component, callback after pending removed;
- renderability gate cancels unrepresentable forms;
- answer-privacy: sentinel answer never reaches custom ids or logs;
- rendering safety: the §8 sentinel set.

## 11. Step 11 — E2E

Use the same protocol-faithful mock ACP agent technique M1 established
(`tests/fixtures/mock-elicit-cancel-agent.mjs`): a mock agent that emits
`elicitation/create`, driven through the Discord handler with simulated
interaction callbacks, asserting the same ACP turn resumes after accept, and
that decline/cancel produce no second prompt.

## 12. Definition of done

From the design §16, plus:
- Discord truthfully declares `["form"]` and nothing else;
- unrepresentable forms cancel without partial rendering;
- no answer anywhere but plugin memory;
- every regression mutation-verified;
- no dependency on PR #350; no Relay/Conversation/acpx core changes.
