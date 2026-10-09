# Phase 10C: owned member worktrees and explicit integration

## Baseline and scope

PR #378 was squash merged as `be14fce8066ff7b53aa79b0259f59db8ef44fef5` after
checking HEAD `eae116975f7ad6dd0a56ec705e70ddace65c26ff`, exact-head workflow
37743254044 (seven successful jobs), permissions, rules and unresolved reviews.
Implementation starts at that merge commit on a new branch from main.

Git worktrees provide separate working directories, **not an OS sandbox**.
Writable agents retain the existing same-user trust boundary. This feature does
not mint read-only proof, change origin, extend tool permissions or replace
TurnQueue. Shared policies and Direct Conversations retain their existing path.

## Ownership and persistence

The Conversation SQLite database owns a new additive registry. Each Run has an
immutable repository snapshot (registered workspace, canonical source root and
common-dir, repository identity, readable base commit). Each member resource is
owned by `(runId, botId)`; later assignments to that Bot reuse it only within
that Run. Automatic and public handoff assignments use the same frozen Run base.
Legacy Runs have no registry and obtain no implicit worktree authority.

Registry rows contain a versioned, validated record and a monotonically increasing
CAS revision. Stable resource generation is distinct from this write revision.
Resource IDs determine paths and branch names; caller strings never become paths
or Git arguments. Git's worktree lock reason records an opaque durable ownership
token. Verification compares canonical path, registration, common-dir, branch,
base ancestry and that token. Unknown/malformed ownership fails closed.
Canonical path comparison expands Windows 8.3 short-name components to their long
form, so a managed root or workspace spelled through a short name still matches
Git's recorded paths. Branch checks use Git's actual symbolic ref at every
resolution boundary. Both files and reftable ref storage are supported:
[reftable's HEAD file is a dummy](https://git-scm.com/docs/reftable),
so reading that file cannot prove the current branch. The synchronous SessionService
resolver uses the same bounded argv-only Git boundary for this read-only check.

Run acceptance and its base intent commit in the same transaction. A Run with
unresolved member results blocks the next worktree Run in its Topic until explicit
integration or abandonment. Other Topics and shared policies are unaffected.

## Resource state machine

`planned -> provisioning -> ready -> active -> awaiting-integration -> integrated
-> cleanup-pending -> cleaned`.

Failures use `provision-failed`, `missing`, `recovery-required` and `cleanup-failed`.
Intent is persisted before Git. Provisioning can adopt an already-created worktree
only after exact ownership verification; path/branch collisions are never adopted.
An active resource on restart is inspected alongside the durable MemberTurns;
existing claim recovery remains authoritative for retry/indeterminate decisions.
Writable started-result-unknown work is never retried to recover capacity.

## Git boundary

Reuse WorkspaceGit's argv execution and path comparison helpers. Require a clean,
registered Git root with a valid HEAD at fresh acceptance. Managed paths must be
outside the source tree and Git common-dir. Reject symlink components and resource
collisions. Use short hashed names for Windows, and canonical case-aware comparison.
Disable hooks, fsmonitor, automatic GC, signing and rerere for managed operations.
Unsupported submodule/sparse/custom filter or merge-driver contracts fail closed.

No automatic reset-hard, clean, force-remove or recursive directory deletion.

| Git mutation | Required evidence and interruption handling |
| --- | --- |
| `worktree add --lock` | Durable intent, deterministic unused path/branch, common base; adopt only matching lock/registration. |
| `commit-tree` / snapshot `update-ref` | Settled/released sessions, explicit preview consent, immutable tree/parent; deterministic source objects preserve retry identity. |
| snapshot `read-tree` | Authorized tree, matching member HEAD/content; index-only update, never checkout/reset files. |
| candidate `cherry-pick` / conflict `commit` | Owned candidate, expected parent and source patch persisted first; explicit staged conflict resolution, cursor advances only from matching commit evidence. |
| `worktree unlock` / non-force `remove` | Strict physical release, exact owner, clean integrated or untouched-base tree; cleanup intent persists before removal and survives interruption. |

Cleanup verifies ownership again, strictly releases physical sessions, requires a
clean tree including ignored files, and uses non-force `git worktree remove`.
Branches/snapshot refs remain as durable result evidence. A cleanup interruption
after unlock is recoverable only from its existing cleanup intent.

## Execution and scheduling

The dispatcher provisions a claimed member before materializing its owned session.
The registry reference is persisted on the LogicalSession; it is not a public cwd
override. SessionService resolves it through a core-owned verifier and supplies the
verified path as ResolvedSession.cwd. Runtime and CLI already consume that field
in their launch identity. Changing worktree requires strict release and recreation.
Reuse and start recheck ownership, filesystem identity and live dispatch fences.

Worktree writer overlap requires verified distinct resources and actual resolved
cwd bindings for every physical participant. The Topic flag alone is insufficient.
Phase 10A reservations, dependencies, same-Bot ordering and lease heartbeats remain
in the existing dispatcher. Preparation does not introduce an executor or queue.
Cancellation/teardown fences run again after every asynchronous preparation step.
Shared reader/writer classification remains Phase 10B's enforced effect proof.

## Explicit integration

Only explicit Control/Relay operations expose integration; no model tool is added.
All operations honor `files.writeEnabled`; preview also writes private Git objects
and releases owned sessions, so it shares the mutation gate.
Run queries include registry and conflict state. V1 integrates the complete frozen
set of provisioned member resources in caller-specified deterministic order, and
requires a terminal, physically quiescent Run. An indeterminate Run requires exact
result reconciliation before integration. Preview shows paths, changed files and
a bounded diff, and persists a token tied to all member HEAD/content fingerprints.

An integration request names that preview and explicitly authorizes snapshots of
uncommitted/untracked changes. It revalidates the preview and records intent first.
Private Git indexes capture complete trees without discarding existing files.
Controlled snapshot commits and base-parent patch commits preserve member results.
No implicit write to the source worktree or main occurs.

Diff previews use bounded streaming collection, drain the remaining output and check
Git's final exit status. A large legal patch cannot fail merely by exceeding the
buffered-command output limit; integration uses the complete captured Git tree.
Capture removes its private index and exact empty temporary directory without
recursive deletion, including on failure.

`preparing -> integrating -> integrated`, with `conflicted`, `failed`,
`recovery-required` and `abandoned`. The candidate uses an owned integration
worktree/branch at the common base. Ordered cherry-picks record the expected
candidate parent and source commit before each operation. Recovery adopts a
completed pick only from exact Git evidence; it never blindly repeats a pick.
Conflicts persist file names and retain both member and candidate worktrees.
Explicit continue requires resolved/staged files; explicit abandon preserves
all original results and candidate conflict files. Integration completion means
reviewable candidate, not publication to main.

Unexpected candidate files or commits reject recovery/cleanup and retain the
directory. Snapshot refs, accepted trees/parents, integration identity/order and
the applied cursor are immutable or monotonic under the registry CAS.

## Recovery, deletion and locks

Consumer activation reconciles registry resources before dispatch. Planned intents
may be provisioned idempotently; a missing previously-ready resource fails closed.
Unowned discovered worktrees are diagnostic-only and never automatically removed.
Integration interrupted after a Git operation is inspected using recorded parents,
snapshot identities and cherry-pick metadata. Ambiguity requires human recovery.

Topic/Group deletion retains existing deleting barrier, cancel/settle and strict
physical release order, then attempts owned cleanup before deleting domain rows.
Unintegrated changes or conflicts keep the barrier and registry for a retry.
Registry audit records are not cascaded away with Topic deletion.

Bot lifecycle gates precede resource-operation locks. Resource preparation releases
its Run lock before entering Bot/session materialization. No manager lock waits for
a Bot gate. CAS revisions fence asynchronous writes; the exclusive daemon consumer
lock remains the cross-process execution authority.

## Failure injection and acceptance

Real temporary Git repositories cover: intent/add/ready crash windows; common base;
reuse and different-Run separation; dirty/non-Git roots; symlink/path/branch/owner
collisions; two writers modifying the same filename in separate cwd; capacity and
same-Bot fences; cancellation/teardown during preparation; CLI/Runtime cwd identity;
missing/drifted resources; restart before/after execution start; non-conflicting,
same-line, delete/modify, binary and untracked integration; snapshot/pick/store
crash windows; continued conflicts; abandoned result retention; cleanup interruption
and refusal to remove foreign/dirty resources. SQLite migration/reopen runs under
Node and Bun. Existing Conversation, Router, handoff, effects, concurrency and
permission tests remain required, with typecheck, all builds and exact-head CI.

Non-goals: OS sandboxing, automatic conflict resolution/main merge, worktree
federation, new Router authority, private handoff, templates, analytics, runtime
concurrency editing and a second session queue.
