# Bot / Group / Session conversation UI unification

Date: 2026-10-13. Scope: `packages/relay-web`.

## Problem

The Direct Bot and Group panes had grown their own transcript and composer
markup. The session pane (ChatPane + MessageList + PromptInput) was the polished
surface. Three panes, three grammars:

- user bubble: `rounded-2xl bg-accent text-accent-fg` (bot/group) vs
  `rounded-2xl rounded-tr-md border-accent/15 bg-accent/10` (session)
- bot reply: `rounded-xl border bg-surface/40 p-3 shadow-sm` wrapper
  (bot/group) vs bare TurnParts in a `cv-bubble` with a sticky avatar (session)
- row width: `max-w-[85%] sm:max-w-[85%]` (bot/group) vs a shared `max-w-3xl`
  centered column (session)
- scroller padding: `px-3 py-4 sm:px-6` (bot/group) vs
  `py-4 pl-3 pr-3 lg:py-5 lg:pl-5 lg:pr-5` (session)
- composer: `rounded-xl border bg-bg p-1.5` with an `h-8 w-8` send button
  (bot/group) vs `rounded-2xl border bg-surface shadow-dock` with an
  `h-7 w-7` send button (session)
- pane header: `px-4 py-2.5 bg-surface` with a `h-9 w-9 rounded-xl` avatar
  (bot/group) vs `min-h-11 lg:h-11 bg-surface/60 backdrop-blur-md` with chips
  (session)

The session pane also carried `text-accent-fg` nowhere: the class does not
exist in `tailwind.config.js`, so `bg-accent text-accent-fg` rendered the
default inherited color instead of white. Eight bot/group call sites were
affected. Replaced with `text-white`, which is what the session pane and the
rest of the dashboard use on `bg-accent`.

## Decision

Unify on the session pane's grammar by extracting shared components, then
migrating all three panes onto them. No new abstraction where the shape is
already local.

New shared components:

- `TranscriptRow.vue` — one row. Owns the sticky assistant avatar, the speaker
  label, and the virtualization (`content-visibility`) that the session pane had
  and the others lacked. `own` renders the reader's message right-aligned with
  no avatar.
- `ConversationComposer.vue` — the composer card. Owns the rounded surface,
  the growing textarea, and the send/stop button. Panes keep their own
  affordances through the `menus`, `controls-top`, `controls`, and `actions`
  slots. Pane-specific test ids pass through `sendTestId`, `stopTestId`,
  `textareaTestId`, so no existing selector moved.
- `TranscriptJumpLatest.vue` — the jump-latest pill and its bottom scrim,
  previously only in MessageList.

Deliberately not extracted:

- Scroll behavior. The three panes fetch history through different stores with
  different anchors (identity-based in GroupTranscript, distance-based in
  ConversationMessageList, live-bubble-aware in MessageList). Extracting a
  composable would have meant changing fetch semantics, which is behavior, not
  styling. Rejected per the Laziness Protocol.
- The Group run card and member rows. Group-specific structure with no session
  counterpart. Only the surrounding row grammar moved.

## What moved

Transcripts: both bot/group rows now render through `TranscriptRow` with the
session pane's bubble, avatar, timestamp, and copy-button grammar. Both
scrollers now use the session pane's padding and the `max-w-3xl` centered
column. Both gained the jump-latest affordance.

Composers: all three render the same card. The Direct Bot and Group composers
lost their local textarea refs, resize logic, and send/stop buttons in favor of
the shared card's, keeping their own completion menus, target picker, disabled
states, and placeholders.

Headers: Direct Bot and Group headers now use the session pane's height,
surface treatment, and icon size. Topic strips and banners share the session
pane's padding and blur.

## Verification

- `npx vitest run` in `packages/relay-web` — full unit suite green.
- `npx vue-tsc --noEmit` — clean.
- `e2e/zz-visual-parity.spec.ts` — throwaway spec that renders the same
  exchange on all three panes and screenshots each. Deleted after the
  comparison.

## Regression risk

`ConversationComposer` now owns the textarea, so pane-side keyboard logic that
read `selectionStart`/`selectionEnd` directly had to move to the `caret` event.
Three places were affected: the Direct Bot composer's caret tracking, the Group
composer's `collapsedCaret`, and PromptInput's `caretAtStart`/`collapsed`. The
composer emits `caret` on input, keyup, click, select, and on external value
changes (a send clears the field, history recall fills it), so no path can
leave the pane reading a stale caret.

jsdom does not move the selection on a programmatic `setValue`, so `onInput`
derives the caret from the value length rather than `selectionStart`. That
keeps the history-recall test honest.
