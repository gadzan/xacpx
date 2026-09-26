# ACP Elicitation M2 - Discord Vertical Slice Closure Report

```text
Milestone: M2 Discord Vertical Slice
Base: e8e17e5d (main, "feat(elicitation): ACP Elicitation M1 core foundation (#355)")
Head: 366a0e82 (feat/discord-elicit-form, pre-review)
Plan: docs/superpowers/plans/2026-09-22-acp-elicitation-m2-discord-implementation.md
```

## Implemented

| File | Role |
|---|---|
| `packages/channel-discord/src/elicitation-state.ts` | Server-side pending answers; `trySettle` first-terminal-wins gate |
| `packages/channel-discord/src/elicitation-limits.ts` | Discord renderability gate (platform limits read from installed typings) |
| `packages/channel-discord/src/elicitation-ui.ts` | Token/custom-id codec, opening/field/review cards, click handler, `accept` path |
| `packages/channel-discord/src/channel.ts` | `requestElicitation()`, wizard re-render, terminal cards, stop/logout withdrawal |
| `packages/channel-discord/src/discord-client.ts` | Deliver `xacpx-elicit:` interactions (previously dropped) |
| `packages/channel-discord/src/i18n/` | en + zh wizard strings |

Wizard: opening card (agent identity + message + Start / Decline / Cancel) -> one
card per field (Next / Decline / Cancel) -> review page (Edit / Submit / Decline /
Cancel). `Submit` is the only path to `accept`.

## Invariants proven

| Invariant | Enforcement | Test |
|---|---|---|
| Renderer never invents a decision | `trySettle` + delete-before-resolve | duplicate terminal clicks |
| External abort is not a user decision | reject on signal/stop; no `responderId` | upstream abort, channel stop |
| Custom ids carry only token + routing identity | no answer parameter on the builder | zero-option, sentinel scan |
| Initiation is by platform identity, not token possession | `authorizeElicitationClick` per control | intruder start/submit |
| Submit requires a reviewed, complete form | required-field gate + review-only control | partial submit blocks |
| Agent identity is the correlated one | `agent.name`, never `message` text | impersonation ordering |
| Unrenderable forms cancel whole, not partially | `checkElicitationRenderability` pre-send | 26 options |

## Bugs found by this milestone's own tests

1. **Parser colon bug** — copying permission-ui's `lastIndexOf(":")` split put
   a field key into the token slot, so field callbacks resolved the wrong entry
   (or none). Fixed by reading the fixed-width token first.
2. **`@everyone` is not escaped** — `escapeDiscordLiteralText` omits `@` from
   its class. Permission cards survive only because every send sets
   `allowedMentions: { parse: [] }`; elicitation sends do the same, asserted
   where the message is actually sent.
3. **Field card had no path to the review page** — Submit existed only on the
   review card, so a user who answered a question was stranded. Added the
   Next/Review control.
4. **`accept` was unreachable in the first wiring** — non-decline/cancel actions
   all fell through to "advance the wizard". Caught by the accept-path tests.
5. **Key sanitizer drops, not encodes** — `env:prod\n` becomes `envprod`, not
   `envprodn`; an earlier test asserted the wrong one by reasoning instead of
   running it.

## Test totals

| File | Tests |
|---|---|
| `discord-elicitation-limits.test.ts` | 10 |
| `discord-elicitation-ui.test.ts` | 12 |
| `discord-elicitation-channel.test.ts` | 15 |
| `discord-elicitation-accept-path.test.ts` | 9 |
| `discord-elicitation-renderer.test.ts` | 12 |
| **Total** | **58** |
| E2E (`runtime-discord-elicitation-e2e.test.ts`) | 3 (accept / decline / cancel) |

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| Full unit suite | 3680 pass / 67 fail |
| Failures vs `main` | **byte-identical failure set** (verified by stash + branch switch + diff) |
| Elicitation failures | 0 |
| Discord package dir | was 124 pass / 21 fail / 3 errors -> now 148 pass / 21 fail / 3 errors |

The 67 pre-existing failures are unrelated to elicitation (Windows-specific
permission and WeChat login paths). Verified identical rather than assumed.

## Mutation-verification table

| Mutation | Caught by |
|---|---|
| `trySettle` always true (duplicate decisions) | trySettle unit test + duplicate-click test |
| `authorizeElicitationClick` never denies (settled) | duplicate/late-control tests |
| `authorizeElicitationClick` never denies (not-initiator) | 4 auth tests |
| custom id accepts a field value on terminal actions | 8 tests incl. sentinel scan |
| required-field gate in `submitAnswers` removed | partial-submit test |
| empty-select renderability check disabled | zero-option test |
| option-count limit widened to 999 | option-count test |

## Honest gaps in this milestone

| Gap | Status |
|---|---|
| Field renderers | **closed** (commit `ae49c5a8`): single/multi-select as String Select, boolean as Yes/No Select, number as modal Text Input |
| Multi-page pagination | **closed** (this branch): the review page is paginated rather than truncated. An action row holds 5 buttons and Submit/Decline/Cancel take three, so a wide form once showed only the first two per-field Edit controls — field 3+ had no route in at all, and a required field there made Submit unsatisfiable. The row now carries a Prev/Next pair and the page advances by index, so every field is reachable and answerable. |
| WeChat / other channels | Feishu (M4) not started |
| Relay Web Conversation integration (M3) | blocked on #350 |
| **Root typecheck does not cover `packages/`** | found while verifying this work; `tsconfig.json` includes `src/**/*.ts` only. Every package change MUST also run `npx tsc -p packages/<pkg>/tsconfig.json --noEmit`. Not fixed here (repo-wide tsconfig decision, not a Discord-local one). |

## Next-milestone readiness

**READY**

M4 Feishu can start on this branch's contracts (same plugin API, same three
actions, same renderability-gate shape). M3 remains blocked on PR #350; M5
follows M2/M3 end-to-end closure.
