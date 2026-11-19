# OpenBot UX borrowings for xacpx

## What this program changes

xacpx already has chat channels, a relay dashboard, group collaboration, agent messaging, remote terminal, remote desktop, durable queues, and push notifications. This program borrows three OpenBot product patterns that xacpx lacks and that affect daily use:

1. A cross-instance inbox for work that waits for a human.
2. A provider lifecycle that a person can complete from the dashboard.
3. Session continuity when an agent or context policy changes.

The rest of the OpenBot surface stays out of scope. A desktop Electron shell, an embedded browser, and a self-built agent loop do not fit xacpx's remote-first product.

## What not to copy

- Do not add a second desktop application. The relay dashboard and chat channels are the product.
- Do not implement an agent loop or model tool harness. xacpx keeps using acpx and ACP.
- Do not download provider binaries without version pins, hashes, a blocklist, and rollback.
- Do not build multi-account provider pools before provider setup, sign-in, and health are usable.

## Order

| PR | Change | Why this order |
| --- | --- | --- |
| UX1 | Cross-instance "Needs you" inbox | Reuses the existing interaction snapshot and removes the worst mobile failure: an agent waits and nobody sees it. |
| UX2 | Provider status and connection wizard | Biggest first-run failure. It needs the attention and health surfaces from UX1. |
| UX3 | Switch agent on a logical session, with history handoff | Builds on the portable fork handoff and provider status. |
| UX4 | Context policy and compaction actions | Uses the same session handoff and usage events. |
| UX5 | Queue controls | Mostly Relay Web and existing TurnQueue RPCs. |
| UX6 | Host health page and diagnostics bundle | Summarizes the status added by UX2 and the queue added by UX5. |

UX1 is the first implementation PR. It does not change the relay protocol, the connector, or the daemon. The hub already keeps the authoritative open-interaction set for every subscribed instance, and `direct-bots.ts` already stores every pending interaction by request id.

## UX1: cross-instance "Needs you" inbox

### Problem

An agent that waits for an answer already produces:

- `interaction-opened` and `interaction-closed` events.
- an authoritative `interaction-snapshot` after reconnect.
- a per-session `attention-dot`.
- a session or conversation form when the user opens the right pane.
- a Web Push notification.

The shipped inbox covers elicitation questions. `InteractionKindDto` has two members, and only `elicitation` is implemented today: `permission` is a reserved kind that the transport does not carry and the Web store drops on arrival. Permission cards therefore stay out of scope until the reserved permission interaction kind is implemented, and this PR does not implement it.

The user still has to find the right instance, session, Bot, or Group. On a phone this is the difference between answering in five seconds and missing the request until it expires.

### Data

Use the existing account-wide pending set in `packages/relay-web/src/stores/direct-bots.ts`. No new RPC and no new event.

Each open interaction already carries:

- `requestId`
- `instanceId`
- `sessionAlias` for a session turn
- `request.conversation` for a Direct or Group turn
- `request.elicitation.agent.name`
- `request.elicitation.message`, title, and fields
- `expiresAt`

The inbox reads only open entries. Terminal entries remain in the pane that shows the outcome. The inbox does not keep a second copy of the interaction, so an answer submitted in the inbox updates the same form in the pane.

### UI

Add a button in the sidebar header between the existing search and terminal controls. It shows a count when open interactions exist.

Clicking it opens a sheet on narrow screens and a popover or side panel on wide screens. The list is ordered by expiry, then by arrival. Each row shows:

- agent name
- instance name
- session alias or Bot name
- a one-line question
- time left
- a button that opens the destination

The form itself uses `ConversationInteractionForm` with the same answer, submit, decline, and cancel handlers. A successful answer closes the row through the existing `interaction-closed` event. A failed submit keeps the form and shows the existing typed error.

If the list is empty, show one calm sentence. Do not show a dismiss-less banner.

### Deep links

- A session-scoped entry calls the same path as `onSelect(instanceId, sessionAlias)`, then opens the session pane.
- A Direct entry clears the session and Group selection, calls `selectBot(instanceId, botId)`, then calls `switchTopic(topicId)` when the interaction names a topic.
- A Group entry clears the other selections and calls the Group selection path with the interaction's conversation and topic.
- An entry with no destination remains answerable inside the inbox.

The destination must use the entry's own `instanceId`. Aliases and conversation ids are not globally unique across daemons.

### Failure behavior

- Expired entries disappear through the existing expiry check.
- A reconnect replaces the open set from `interaction-snapshot`; the inbox follows the store and never keeps a ghost row.
- A submit to a closed request shows `interactionGone` and removes the row after the close event.
- Duplicate `interaction-opened` frames keep the user's draft, because the store already merges replay frames by request id.
- The inbox does not submit automatically. It does not prefill answers.

### Tests

- A session interaction on an unselected instance appears in the inbox with the instance and alias.
- A Direct interaction appears once and opens the named topic.
- A Group interaction appears once and opens the named Group topic.
- An interaction from instance A never opens instance B when both use the same alias or conversation id.
- A duplicate open frame does not duplicate the row or clear a draft.
- A close event removes the row.
- An interaction snapshot retires rows that the hub no longer holds.
- Expiry removes a row without a close event.
- The empty state shows no count and no button affordance.
- Mobile layout keeps the row and the form usable at 390 px wide.

## UX2: provider status and connection wizard

The dashboard needs a provider page for each configured agent driver. It shows install source, version, sign-in state, model catalog, last error, and update availability. The host runs install, sign-in, and update. The browser starts the action and streams progress.

The first slice reads and displays state. It does not download binaries. Download support lands behind a capability and a host confirmation. The design follows OpenBot's separation between the provider descriptor, the host-side runtime, and the browser.

## UX3: switch agent on a logical session

Add a "Continue with another agent" action. The source session history is rendered by the existing portable fork handoff. The target keeps the logical session identity and workspace, and the source stays as a branch. The target's first prompt consumes the handoff once. Replays use the stored request and source anchor.

This action requires the provider status from UX2 so the dashboard can show whether the target agent is signed in and has models.

## UX4: context policy

The context meter already shows used and total tokens. Add a per-agent policy:

- provider managed
- warn at a threshold
- compact at a threshold
- fork or handoff at a threshold

Compaction stays with the provider or the existing handoff renderer. xacpx only owns the trigger, the visible state, and the recovery action. A failed compaction must not lose the conversation or the queue.

## UX5: queue controls

Expose the existing `TurnQueue` capabilities in the QueueStrip:

- edit a queued prompt
- move it earlier or later
- run it next
- pause and resume the queue
- interrupt the running turn with a reserved item
- retry a failed item

Each control needs a typed result and a test for the busy, draining, and offline states.

## UX6: host health

Add one host health view that reads existing data:

- daemon and version
- agents and provider sign-in
- channels and plugin versions
- queue depth and oldest item
- SQLite and WAL size
- recent redacted errors

Add a diagnostics export with prompt text, tokens, cookies, file contents, and credentials removed. The export is a support artifact, not a telemetry upload.

## Open decisions

- UX1 uses a sidebar sheet, not a new route. A route would lose the chat context and make back navigation ambiguous on mobile.
- UX2 starts read-only. A download action needs a separate security review.
- UX3 reuses the portable fork handoff instead of writing a second history renderer.
- UX4 does not implement model summarization. The provider or the existing handoff owns it.
