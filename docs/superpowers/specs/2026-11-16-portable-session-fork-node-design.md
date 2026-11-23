# Portable ordinary-session fork at a message node (PR2)

## Problem

PR1 forks an ordinary xacpx session at its latest stable head: the new
session's first prompt carries a bounded `<<<HISTORY` block of every recorded
turn. PR2 adds a node boundary: fork at one recorded user turn and carry only
the history up to and including that turn's reply. Later source turns must
never reach the target.

The boundary must survive the same life cycle as the head fork: a retry of the
same `requestId` replays the stored fork, source growth does not invalidate it,
and a reset, `/clear`, or rewrite of the source fails closed with a typed error
instead of handing off a different prefix.

## Node identity: what is stable, and what the web can see

Candidate models considered:

1. **acpx user-message id (`User.id`).** Stable once written, but acpx mints it
   itself (`randomUUID`) and exposes no way to choose it. The web transcript is
   the hub's own `messages` table, which has no acpx id, so neither side can
   compute the other's identity without a second durable mapping.
2. **User-turn ordinal computed by the web.** The web transcript is paginated
   (tail page + "load older"), so the absolute ordinal of a clicked row is not
   knowable without loading every older page. Counting from the newest row is
   unstable under growth. The ordinal also drifts from the acpx record whenever
   a prompt fails before the provider writes it, or a steering message adds an
   extra user message.
3. **Hub message row id.** Stable and directly available to the web, but the
   core owns no hub ids; the hub would have to translate every fork request,
   and the translated identity would still need a core-side mapping.
4. **Core-minted turn node id (chosen).** The core mints a node id when a prompt
   turn starts, stamps the digest of the exact prompt text it hands the agent,
   and carries the id on `turn-started`. The hub persists it on the inbound
   row; the web sends it back as `sourcePoint: { type: "node", nodeId }`. At
   fork time the core locates the turn in the acpx record by prompt digest and
   cuts the prefix there. Identity is minted by the side that owns the
   transcript, travels to the side that displays it, and is resolved without
   guessing at provider-managed ids.

Rejected models and why: (1) not controllable and not visible to the web; (2)
not computable without loading the whole transcript and drifts from the acpx
record; (3) crosses two id spaces and still needs a core-side mapping.

`nodeId` is minted only for an effective prompt turn of a session with a
logical identity and only when the fork store is available, so no row ever
offers an id the core cannot resolve. Prompts carrying media skip the ledger
entry: acpx interleaves image markers into the user text, so the digest could
never match.

## Data model

`session_forks` gains `source_anchor TEXT` (in place; pre-PR2 databases get it
with NULLs). `source_point` is now a union:

- `{ "type": "latest_stable" }` — PR1 behaviour, unchanged.
- `{ "type": "node", "nodeId": "…" }` — one recorded prompt turn.

`session_turn_nodes` is the ledger:

```sql
node_id TEXT PRIMARY KEY,
session_id TEXT NOT NULL,
sequence INTEGER NOT NULL,
prompt_digest TEXT NOT NULL,
created_at TEXT NOT NULL
```

`sequence` is allocated inside the insert transaction, so back-to-back turns
cannot share one. Rows older than 30 days are swept on every write; a node is
worthless once the acpx record's bounded window has moved past its prefix.

`source_anchor` is the digest of the exact rows a node fork rendered. It is
written with the pending record (not at resolve time), so a crash between the
pending write and the resolve can still verify the prefix on retry.

## Resolution

`resolveSessionForkNode(history, nodes, nodeId, expectedAnchor?)`:

1. Locate the node's ledger entry; missing → `session-fork-node-unavailable`.
2. Find history user turns whose prompt digest equals the entry's digest.
   None → `session-fork-source-changed` (reset, clear, or rewrite).
3. One match → that turn. Several identical prompts → rank the node among
   same-digest *recorded* turns and pick the same rank among same-digest
   history matches. `sequence` is not an index into every history user turn
   (media and pre-ledger turns occupy history slots but not sequence
   numbers). If the two same-digest lists differ in length →
   `session-fork-node-ambiguous`; the fork never guesses.
4. The prefix is every row up to the next user turn (so the node's own reply is
   included) and nothing after it.
5. `expectedAnchor` (a pending replay) must equal the new prefix digest;
   otherwise `session-fork-source-changed`.

The head fork path is untouched: `latest_stable` still renders the whole
recorded history.

## Replay and failure rules

- The request id is pinned together with the source point; the same id at a
  different node is `session-fork-request-mismatch`.
- A pending replay renders the STORED source point and anchor, not the request
  as retried, and validates them before creating the target.
- Source growth appends after the prefix: digest matches and the anchor is
  unchanged, so both a fresh request and a replay keep working.
- Source reset/`/clear` changes the logical session id and empties/replaces the
  acpx record: the ledger row is scoped to the old logical id, and the record
  no longer holds the prompt, so the fork fails closed.
- A rewrite of the node's own prompt fails closed immediately. A rewrite of an
  EARLIER turn leaves a fresh request's digest match intact; the recorded
  `source_anchor` detects it on replay. Documented limit: the current hub
  transcript is not compared against acpx on a brand-new request.

## Capability and UI

`session.fork.handoff.v1` is unchanged (PR1 head fork). PR2 adds
`session.fork.message.v1`, advertised only when:

- the head capability is present (store, RPC, connector validator), and
- the core exposes `supportsSessionForkMessage()`, and
- the connector's payload validator accepts `sourcePoint: { type: "node" }`.

An older core, connector, or hub therefore never advertises a payload it would
reject. Relay Web shows the per-message fork control only for a persisted
inbound row that carries a `nodeId` AND an instance that advertises the new
capability; the session-menu head fork stays available regardless.

The web pins one `requestId` + target alias per (instance, source alias, node)
while an attempt is unresolved, so a retry after an ambiguous failure replays
the fork instead of minting a second session. A taken target resets the pin
(the stored request names that target and could never succeed) and reloads the
session list so the next attempt proposes the next free `<alias>-fork[-N]`.
The pane holds one node fork at a time and selects the materialized alias the
daemon returns (auto-suffixes included).

## Hub plumbing

`turn-started.nodeId` is validated, mirrored in the connector's state sync,
persisted in `messages.node_id`, and exposed on `MessageRecordDto.nodeId`.
State-sync and finished-offline reconciliation stamp it too, so a hub restart
mid-turn does not lose forkability for that row. `MessageStore.attachNodeId`
resolves the row by its current coordinates (a queued prompt's id moves on
promotion and its pre-write correlation is consumed) and never renames an
already-stamped row from an uncorrelated fallback.

Deploy hub and connector together: a new connector paired with an older hub
advertises the capability but the hub persists no node id, so rows simply carry
none and the web hides the row control (fail closed, head fork still works).

## Live verification

`node ./scripts/verify-stack.mjs up --router-ready` with a mock ACP agent and
three source turns; a fork at the middle node's first prompt contains only the
first two turns, the third turn is absent, the second target prompt carries no
handoff, and a head fork still contains all three turns.
