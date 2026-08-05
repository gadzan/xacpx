# Windows orphan process hardening + adapter preinstall — Implementation Plan

> **For agentic workers:** execute task-by-task. Keep every task independently reviewable; commit only after its focused tests and `npx tsc --noEmit` pass. Windows safety claims require real Windows tests, not only Linux mocks with `platform: "win32"`.

**Goal:** Implement the approved Windows orphan-process ownership/reaping design and the coupled managed-adapter preinstall/GC design without weakening Unix behavior or ever killing an unverified PID.

**Specs:**

- `docs/superpowers/specs/2026-08-03-windows-orphan-process-fix-spec.md`
- `docs/superpowers/specs/2026-08-03-adapter-preinstall-spec.md`
- `docs/superpowers/handoff-windows-orphan-process-fix.md`

**Architecture:** Build platform safety primitives first, then immutable adapter releases, durable orphan records, and the reaper. Only then wire durability-gated session migration and bidirectional bridge launch registration. Finish with reference-safe GC, daemon lifecycle/doctor integration, and real Windows gates.

**Tech stack:** TypeScript, Node 22.12+, Bun build/tests, PowerShell/CIM plus Win32 APIs for handle-stable Windows operations, durable JSON files, and a real Unix `flock(2)` implementation.

## Global invariants

- Automatic Windows cleanup never calls `taskkill`; verification and termination use the same process handle.
- FILETIME values are canonical decimal strings in JSON/protocols and `bigint`/`uint64` in comparisons. Only CIM-derived fingerprints use `|delta| <= 9`; handle-derived identities compare exactly.
- No kill occurs before the complete initial tree and one allowed pre-kill append pass are verified. Any missing identity, failed parent proof, or append-parent liveness failure aborts the whole batch.
- Append order is fixed: CIM enumeration -> previously-opened parent-handle liveness fence -> appended-node verification -> kill. There is no post-kill enumeration.
- Record/pointer writes use same-directory tmp -> flush/fsync -> rename. Migrations write every new record before deleting an old record.
- Windows uses the IPC guard. Unix consumer/lifecycle semantics stay unchanged. Unix adapter operations use real `flock(2)` and never unlink the lock file.
- Lock order is `SessionService.stateMutex` -> adapter guard. Re-resolution calls `saveNow(nextState)` before publishing runtime state, writing intent, releasing guard, or acknowledging.
- Daemon is the only intent/owner writer. Bridge launchers never edit registry files.
- Bridge timeout means no spawn/retry/token reuse. Disconnect retains any state that might represent a spawn.
- Unix performs adapter validation/re-resolution but writes no orphan records.

## Dependency map

| Phase | Produces | Unblocks |
|---|---|---|
| A | IPC guard, process identity/tree worker, adapter lock | all safety-critical paths |
| B | immutable adapter releases and trusted decoder | re-resolution and GC |
| C | durable orphan registry and reaper | launch settlement and lifecycle |
| D | session transaction and bidirectional bridge RPC | registered launch lifecycle |
| E | GC, integration, docs, CI | release readiness |

---

## Phase A — Platform safety primitives

### Task 1: Canonical Windows IPC guard

**Files:** create `src/process/ipc-guard.ts`, `tests/unit/process/ipc-guard.test.ts`, `tests/helpers/ipc-guard-child.ts`; modify `.github/workflows/test.yml`.

- [ ] Test path equivalence (case, separators, trailing slash), junction/symlink parents, a missing leaf resolved through its nearest existing ancestor, and non-`ENOENT` realpath failure.
- [ ] Implement canonicalization exactly as the spec. Create caller-owned `configRoot` first where permitted; read-only callers use the nearest existing ancestor; never fall back to a literal key after other realpath errors.
- [ ] On Windows acquire with `net.createServer().listen(pipeName)`, resolving only on `listening`; map collisions to a typed busy error. Make `release()` idempotent. Do not introduce a Unix UDS guard.
- [ ] Add a real `windows-latest` two-process test: exactly one holder, and force-killing it permits reacquisition.
- [ ] Run the focused test and `npx tsc --noEmit`.
- [ ] Commit: `feat(process): add canonical Windows IPC guard`.

### Task 2: Windows identity and handle-stable process-tree worker

**Files:** create `src/process/windows-process-identity.ts`, `src/process/windows-process-tree.ts`, their focused tests and `tests/helpers/windows-process-fixture.ts`; modify `src/process/terminate-process-tree.ts` and Windows CI.

- [ ] Implement/test canonical FILETIME parsing, DMTF/CIM conversion, exact handle comparison, and CIM tolerance. Reject null/malformed/non-canonical values on killable paths.
- [ ] Implement one bounded PowerShell worker with embedded C# (or an equivalently reviewable native helper) exposing `OpenProcess`, `GetProcessTimes`, `QueryFullProcessImageName`, handle liveness/wait, `TerminateProcess`, and handle cleanup. A verified PID may never be killed later by PID.
- [ ] Implement the initial CIM snapshot with node and parent-generation evidence. Duplicate, missing, or invalid parent evidence fails closed.
- [ ] Verify root then every descendant top-down while retaining handles. Require node identity, complete verified ancestry, and `child.creationDate >= parent.creationDate`. Any failure returns a whole-batch `query-failed` abort with zero kills.
- [ ] Implement exactly one append pass. After its CIM enumeration completes, recheck every referenced old parent through its previously-opened handle; exited/unknown means whole-batch abort. Then verify appended nodes.
- [ ] Only after both verification phases, kill root then descendants through retained handles and confirm terminal state. Enforce enumeration <=3s and a bounded worker deadline; absent outcomes become `query-failed`.
- [ ] Preserve the Unix SIGTERM/SIGKILL implementation unchanged.
- [ ] Add injected contract tests plus real Windows cases for PID replacement, parent replacement, unverified parent, creation-order rejection, append-parent exit during enumeration, same-handle kill, and absence of post-kill enumeration.
- [ ] Run focused tests, the real Windows CI cases, and `npx tsc --noEmit`.
- [ ] Commit: `feat(process): add handle-stable Windows tree termination`.

### Task 3: Real Unix adapter flock and adapter guard wrapper

**Files:** create `src/adapters/adapter-locks.ts` and test; modify `package.json`/lockfile only if a native binding is required.

- [ ] Prove first that the chosen `flock(2)` binding/helper runs under production Node, survives `bun run build`, and ships in the npm artifact. If not, stop and amend the plan/spec; never substitute `proper-lockfile` or an existence lock.
- [ ] Windows wraps `acquireIpcGuard({ role: "adapter-op", resourceId: id, configRoot })`.
- [ ] Unix opens a stable per-adapter lock file, acquires nonblocking exclusive `flock`, retains the descriptor for the callback, and releases in `finally`. No path unlinks this file.
- [ ] Add real two-process busy/crash-release tests and a stale-empty-file test.
- [ ] Run focused tests, `bun run build`, and typecheck.
- [ ] Commit: `feat(adapters): add cross-platform adapter operation lock`.

---

## Phase B — Immutable adapter releases

### Task 4: Release identity, trusted command decoder, and Node resolver

**Files:** create `src/adapters/resolve-node-exe.ts`; modify `adapter-catalog.ts`, `adapter-registry.ts`, `resolve-agent-command.ts`, and focused tests.

- [ ] Use one canonical registry form for hash, manifest, expected values, equality, and resolution. Define/test `<version>-<registryHash8>-<uuid8>` without splitting version prerelease text.
- [ ] Export one structured decoder recognizing existing managed npx commands and trusted preinstalled `<node> <absolute-js-entry>` commands only beneath the supplied adapters root.
- [ ] Validate `args[0]` as controlled Node and use `args[1]` for containment. Cover `path.relative` boundaries, Windows case folding, realpath aliases, prefix collisions, `..foo`, and traversal.
- [ ] Resolve a stable absolute Node executable and explicitly reject Bun-as-Node. Preserve explicit agent commands and unmanaged-driver behavior.
- [ ] Run focused catalog/config/node tests and typecheck.
- [ ] Commit: `feat(adapters): define immutable release identity and decoding`.

### Task 5: Release validation, atomic pointer, and crash recovery

**Files:** create `src/adapters/adapter-preinstall.ts` and test; reuse/modify `adapter-verifier.ts` where appropriate.

- [ ] Implement the six validation items: release directory, manifest, release ID, Node executable, entry path, and optional initialize probe. Require `stat().isFile()` and Unix execute bits.
- [ ] Implement temp install -> exact-registry install -> manifest -> static validation -> probe -> immutable release rename. Never mutate an existing release.
- [ ] Publish `active.json` by same-directory tmp, flush/fsync, and rename. Readers see only the old or new complete pointer.
- [ ] Recover pointer tmp files and incomplete temp releases without deleting valid releases or permanent lock files.
- [ ] Add fault injection at every write/rename boundary and prove the old active pointer survives failures.
- [ ] Run focused test, build, and typecheck.
- [ ] Commit: `feat(adapters): install and recover immutable adapter releases`.

### Task 6: Adapter CLI and runtime resolution

**Files:** modify `adapter-cli.ts`, `cli.ts`, `resolve-agent-command.ts`, CLI i18n files, and focused tests.

- [ ] Add `preinstall` and installed-release listing without regressing list/check/update/set/reset/registry. Defer the `uninstall` command until Task 14, where the complete state + orphan reference set exists.
- [ ] Route preinstall through the adapter lock and validate before pointer publication.
- [ ] Resolve managed runtime commands from a statically valid pointer; skip only the spawn-time initialize probe. Otherwise fall back to exact npx pins.
- [ ] Derive runtime root solely from `dirname(resolveConfigPathForCurrentEnv())`.
- [ ] Add success, busy, corrupt-pointer, unsupported-runtime, i18n parity, and fallback tests.
- [ ] Run focused tests, build, and typecheck.
- [ ] Commit: `feat(adapters): expose preinstall CLI and runtime resolution`.

---

## Phase C — Durable orphan ownership and reaping

### Task 7: Generation identity and durable orphan registry

**Files:** create `src/transport/orphan-registry.ts` and test; modify `main.ts`, `run-console.ts`, and shared types only as needed.

- [ ] Create `DaemonIdentity` before `buildApp`; write `generation.json`; on Windows capture daemon creation through the handle-derived primitive. Null identity remains fail-closed.
- [ ] Add strict decoders for intent, owner, and residual schemas; persist ticks as decimal strings.
- [ ] Implement tmp -> flush/fsync -> rename and clean only `.tmp-*` debris.
- [ ] Implement write-new-before-delete-old migrations; owner -> residual deletes owner only after every residual succeeds.
- [ ] Implement ordered `listOwnerAgentCommands(["intents","owners","residuals"])` and stable filename+canonical-content revision. Invalid order throws; missing/unreadable/invalid records return `null`.
- [ ] Fault-inject every durable boundary and migration interleaving.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat(transport): add durable orphan ownership registry`.

### Task 8: Owner/residual reaper and intent cleanup

**Files:** create `src/transport/windows-orphan-reaper.ts` and test; modify `queue-owner-reaper.ts`.

- [ ] Verify owner token from CIM and exact owner fingerprint before building a root target. Verification unavailable retains all evidence.
- [ ] Implement the convergence table: batch abort retains owner and writes no residual; verified complete child outcomes may create residuals only for unconfirmed/access-denied/query-failed; unknown outcomes create none.
- [ ] Implement independent residual verification/kill with CIM tolerance, retry counters, and terminal deletion; residuals never recurse.
- [ ] Delete an intent only when age, complete no-token snapshot, non-current generation, and confirmed-dead/replaced launcher all hold. Any uncertainty retains it.
- [ ] Implement legacy migration and degraded CIM-unavailable reporting. Leave Unix queue-owner reaping unchanged.
- [ ] Test every root/child outcome, unknown outcomes, partial writes, token snapshot failure, launcher PID reuse, and current generation.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat(transport): add fail-closed Windows orphan reaper`.

### Task 9: Consumer/lifecycle fencing, stop, timer, and doctor

**Files:** modify consumer lock, `run-console.ts`, daemon controller/composition/status, `main.ts`, doctor modules, and their focused tests.

- [ ] Windows acquires consumer guard before metadata v2; metadata is diagnostic only. Unix retains its current consumer lock.
- [ ] Windows start/stop/restart uses lifecycle guard; Unix retains exclusive pid-file behavior.
- [ ] Implement four-state stop identity logic and invoke verified tree kill only in state 4. Clear frozen generation/records only after complete termination confirmation.
- [ ] Drain launches and bridge subprocesses before normal guard release.
- [ ] Run startup sweep before work and one non-overlapping 60s timer; dispose waits for an active sweep. Per-record failures log without blocking readiness.
- [ ] Extend doctor and a user-confirmed manual orphan kill. `taskkill` is allowed only there.
- [ ] Test daemon crash, duplicate consumer, stop PID reuse/null identity, incomplete kill, timer overlap, and degraded doctor output.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat(daemon): fence Windows lifecycle and reconcile orphans`.

---

## Phase D — Durability-gated launch registration

### Task 10: Session transaction and copy-on-write migration

**Files:** modify `session-service.ts`, `main.ts`, session tests, and state tests if ordering coverage is missing.

- [ ] Extend the injected writer from `Pick<StateStore, "save">` to a narrow `save` + `saveNow` interface.
- [ ] Expose a generic executor backed by the non-reentrant state mutex. Never call `setSessionTransportAgentCommand` from inside it.
- [ ] Clone current state, change only `transport_agent_command`, call `saveNow(nextState)` while guard remains held, then publish via the same whole-state replacement pattern used by orchestration.
- [ ] Failure leaves runtime state unchanged, writes no intent, rejects launch, and releases guard in `finally`; a later debounced save cannot persist the failed command.
- [ ] Test session -> adapter lock order, no reentry/ABBA, settle-before-release, and CLI/bridge context assembly.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat(sessions): add durability-gated adapter transaction`.

### Task 11: Bidirectional bridge request/response transport

**Files:** modify bridge protocol/client/transport, `bridge-main.ts`, `bridge-server.ts`, and focused/golden tests.

- [ ] Add distinct bridge-originated requests and daemon responses with collision-safe IDs; preserve existing progress events.
- [ ] Implement pending routing, timeout, cancellation, disconnect rejection, duplicate/late suppression, and shutdown cleanup on both sides.
- [ ] Add schemas for Windows register/spawned/cancel/settled and Unix resolve-command. State transitions are Task 12.
- [ ] Test request/event interleaving, malformed input, duplicates, timeout, and disconnect.
- [ ] Run bridge focused/golden tests, build, and typecheck.
- [ ] Commit: `feat(bridge): support bidirectional daemon RPC`.

### Task 12: Daemon per-token intent state machine

**Files:** create `src/transport/launch-intent-coordinator.ts` and exhaustive test; wire daemon RPC composition.

- [ ] Implement Windows registering/registered/spawn-committed/canceled/owner-committed/launch-failed/aborted keyed by `(id, sessionKey, intentToken)` with payload equality.
- [ ] Execute validate -> re-resolve -> `saveNow` -> intent write inside session lock then adapter guard. Publish registered after durable rename and before ack.
- [ ] Implement disconnect/cancel abort checkpoints immediately before write and after rename/before registered publication.
- [ ] Enforce replay table: registering waits, registered replays, spawn-committed/terminal register rejects; a new token is a new launch.
- [ ] Owner settlement independently verifies token and handle-derived fingerprint before owner-write/intent-delete. Launch-failed takes a complete token snapshot and deletes only when empty.
- [ ] Timeout/cancel promises no spawn/token reuse; disconnect retains registered/spawn-committed. Same-outcome settle replays; conflicting outcome rejects.
- [ ] Unix implements only resolve-command with no token state or orphan files.
- [ ] Add transition-table, race, durability, trust-boundary, lock-order, and Unix-boundary tests.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat(transport): coordinate durable launch intents`.

### Task 13: Queue-owner token, fencing, and handshake

**Files:** modify queue-owner launcher, bridge runtime/transport, CLI transport composition, and focused tests.

- [ ] Spawner returns PID; generate one UUIDv4 per launch and reuse it in argv, RPC, intent, owner, and residual lineage.
- [ ] Complete registration and generation fencing before spawn. Abort sends cancel and never spawns.
- [ ] Send `launcherSpawned` immediately after spawn; poll readiness <=10s.
- [ ] Success sends owner-committed and waits for daemon verification/migration. Confirmed root exit sends launch-failed; daemon performs token snapshot. Alive/unknown timeout retains intent and reports failure.
- [ ] Bridge subprocess never acquires adapter guard or touches orphan files. CLI uses the same coordinator in-process.
- [ ] Test token identity, generation abort, ack-loss/cancel ordering, live descendant, owner rejection, and absence of launcher file writes.
- [ ] Run focused launcher/bridge/CLI tests and typecheck.
- [ ] Commit: `feat(transport): register and settle queue-owner launches`.

---

## Phase E — GC and release readiness

### Task 14: Reference-safe adapter GC and uninstall

**Files:** modify adapter preinstall/catalog, `adapter-cli.ts`, `cli.ts`, CLI i18n, and registry composition; create `tests/unit/adapters/adapter-gc.test.ts`.

- [ ] Build references from active pointer, state.json, then orphan categories strictly intents -> owners -> residuals. Any read/parse/decode/realpath failure aborts GC.
- [ ] Before deletion repeat the same ordered orphan scan and require unchanged `snapshotRevision`; otherwise abandon deletion.
- [ ] Use the trusted decoder and `args[1]` containment for every command source.
- [ ] Add the `uninstall` CLI and implementation here. It holds the adapter lock and never removes active/referenced releases. Preserve visibility through all intent -> owner -> residual interleavings.
- [ ] Add the full fail-closed matrix, double-scan races, path-boundary cases, and migration tests.
- [ ] Run GC/all adapter tests and typecheck.
- [ ] Commit: `feat(adapters): add reference-safe release GC`.

### Task 15: Integration, Windows gate, docs, and readiness flip

**Files:** modify Windows CI, relevant CLI/config/daemon/doctor/Code Wiki docs, `AGENTS.md` only for stable navigation, and status lines after verification.

- [ ] Windows CI runs real IPC guard, tree/identity, stop/fencing, pointer/junction, and packaged CLI smoke tests.
- [ ] Add end-to-end fixtures for preinstall -> registration -> owner commit -> daemon restart -> reaper -> GC, and Unix resolution with zero orphan files.
- [ ] Run focused suites, then `npm test`, `bun run build:packages`, and `npx tsc --noEmit`. Do not run real WeChat/acpx smoke without configured infrastructure.
- [ ] Inspect the built/published artifact: adapter runtime files and the Unix flock dependency/helper are present; no machine-specific paths are embedded.
- [ ] Update user-facing and architectural docs. Record Job Object as deferred P3 rather than weakening guarantees.
- [ ] Mark both specs implemented only after Linux CI, Windows CI, durability fault tests, and end-to-end fixtures pass.
- [ ] Commit: `docs: finalize orphan cleanup and adapter preinstall`.

## Final acceptance checklist

- [ ] No automatic Windows path contains a `taskkill` fallback.
- [ ] Every automatic kill is handle-bound; every parent edge passes the approved proof, including post-append parent liveness.
- [ ] Whole-batch abort retains owner evidence and creates no residual.
- [ ] All pointer/record migrations pass crash fault injection.
- [ ] `saveNow(nextState)` precedes runtime publication, intent write, guard release, and ack.
- [ ] Bridge duplicate/timeout/cancel/disconnect/conflicting-outcome matrices pass.
- [ ] Unix consumer/lifecycle behavior is unchanged; Unix adapter lock is real `flock(2)` and never unlinked.
- [ ] GC refuses deletion on uncertainty and protects state/intent/owner/residual references.
- [ ] `npm test`, `bun run build:packages`, Linux CI, and targeted real Windows CI are green.
