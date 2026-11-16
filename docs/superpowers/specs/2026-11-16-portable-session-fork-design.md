# Portable ordinary-session fork (PR1)

## Problem

Direct Bot Topics have a bounded one-time fork handoff. Ordinary xacpx sessions
have no fork: a user must recreate the session and manually restate context.
PR1 adds the portable strategy — copy the stable recorded head into the new
session's first prompt. PR2 will add the native `session/fork` resolver branch.

## Record and storage

`session_forks` holds `id`, `request_id` (idempotency), `source_session_id`,
`target_session_id`, `source_point` (`latest_stable` only in PR1), `strategy`
(`pending | native | portable`), `resolution`, `status`
(`pending | ready | consumed`), `created_at`, `consumed_at`.
`session_fork_handoffs` holds the rendered text plus message/omission counts.
Both live in `runtime/session-forks.sqlite`; state.json never carries the text.
The record is strategy-agnostic and is created `pending`; the resolver writes
`portable` (or the deferred `native` branch) and `ready` in one transaction.

## Fork creation

1. Resolve and assert an ordinary, non-running source.
2. Refuse an existing target or a replayed request with a missing target.
3. Read the acpx record by `--name` + cwd + agent command, map it through the
   existing neutral history mapper.
4. Render the bounded `<<<HISTORY` block (12k budget); an empty render refuses
   before any session is created.
5. Create the logical + transport session, write the pending record, resolve
   portable. A storage failure removes the just-created session.

## Injection

`SessionTurnRunner` resolves the target's logical session id, atomically takes
and marks the handoff consumed, then prepends it to `chatRequest.text`
immediately before `agent.chat`. Consequences: the first effective prompt gets
the block; a provider failure cannot re-inject on retry; command turns
(`isKnownXacpxCommandText`) and turns that bypass the runner never consume it.

## Capability and UI

`supportsSessionForkHandoff()` is false without a store, so a test/fake core
advertises nothing. The connector requires that probe and its own payload
validator before publishing `session.fork.handoff.v1`. Relay Web hides the
session menu entry until the instance advertises it.

## Review fixes (against PR586 r1)

- Model/effort inheritance: the fork passes `source.model` into
  `createSessionWithTransport` and applies `source.effort` via
  `setSessionEffort` before the record resolves, so the target runs under the
  same provider settings. `modeId`/`replyMode` are explicit PR1 limits (no
  creation-path parameter); `settingsPolicy` inherits automatically (resolved
  live from the shared agent config).
- No nested HISTORY rows: the renderer strips the known parent-handoff prefix
  from the child's recorded rows before rendering and re-carries it once as
  the parent block, preserving the chain without a transcript-in-a-row.
- Request-id replay is strict: same id with a different source or target
  alias is rejected (`session-fork-request-mismatch`); source resolution now
  precedes the replay lookup, so a replay is only meaningful while the source
  still exists.
- Pending-row recovery: a resolve failure deletes the pending row and removes
  the just-created target, so the same request id retries cleanly. A crash
  between the pending write and the resolve converges the same way on retry.
  Completed (ready/consumed) records are retained even after target deletion
  as idempotency and audit provenance — one small row per user-initiated
  fork — so the table cannot grow without an operator action behind it.

## Review fixes, round 2 (against PR586 r2)

- Row-level fence neutralization: every rendered row neutralizes literal
  `<<<HISTORY` / `>>>END HISTORY` markers (`[HISTORY` / `END HISTORY]`), so a
  bot echo, quote, or paste can never nest a second fence inside a row.
- Parent carried only when absent inline: after stripping the exact injected
  prefix, the parent block is added only when no cleaned row still contains
  the parent text. A bot echo therefore keeps a single fence pair instead of
  duplicating the chain context.
- Source-deletion-tolerant replay: the record stores the requested display
  source/target aliases; a replay compares those first, so a deleted source
  with a live target still returns the target instead of failing.
- Suffix-tolerant replay: comparison uses the requested aliases, never the
  materialized target alias, so a daemon-side auto-suffix still replays.
- `deleteForkById` runs both DELETEs in one transaction.

## Review fixes, round 3 (against PR586 r3)

- Concurrent same-request-id forks: the loser's `createPending` unique violation
  removes its just-created target, re-reads the record, validates scope/source/
  target, and returns the winner's target. Relay Web also holds a per-row
  in-flight guard so a double click sends one request.
- Legacy rows: the alias/chat columns migrate in with NULLs; empty stored
  aliases are treated as wildcards for the replay comparison, so a pre-alias
  pending row self-heals instead of being permanently unreplayable.
- Cross-chat replay: `chat_key` is persisted and compared, so another chat
  scope cannot claim a request id even with identical display aliases.
- Product namespace: a target alias in the `brt_` namespace is refused before
  creation, alongside the existing source ordinary-session assertion.
- Crash window (documented limit): if the daemon dies after
  `createSessionWithTransport` and before the pending insert, the retry sees an
  existing target and cannot tie it to the request id. The error tells the
  operator to delete the orphan or use a new request id. Closing this window
  needs the record (and request id) minted before the session, which the
  current session-creation API cannot express; PR2 can revisit.
- Retention (deliberate): completed (ready/consumed) records and their handoff
  text are kept after target deletion or reset as idempotency/audit
  provenance. Reset changes the logical session id, so the handoff can never
  fire on the replacement; the dead row is bounded by user-initiated forks and
  is not re-injected. Pending rows are deleted.
- Mixed-version skew (documented requirement): `chatKey` stamping is hub-side
  while the capability is connector-side. A new connector paired with an old
  hub advertises `session.fork.handoff.v1` but receives an unstamped RPC and
  answers `invalid-payload`. Deploy hub and connector together; the connector
  cannot see the hub build to gate on it.
