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
