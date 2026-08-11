# Handoff: Relay Web RMUX Terminal Implementation

> **Date:** 2026-08-11
> **Author of this handoff:** Kimi Code session that landed Tasks 4–6.
> **Read first if you are the next agent picking this up.**

This handoff points at, but does not duplicate, the authoritative design and plan:

- Spec: `docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md`
- Plan: `docs/superpowers/plans/2026-08-10-relay-web-rmux-terminal.md` (task checkboxes are the commit boundaries; spec wins on conflict).

## Scope rules (user-imposed, must not be violated)

- **Do not edit `../rmux` or `../acpx`.** They are dependencies, not xacpx code. Any RMUX upstream changes (adopt/fence/abandon public contract) must come from RMUX maintainers; publishing a `rmux-sdk` version that includes those is what unblocks Phase E.
- **One commit per task**, message exactly as the plan specifies. **Do not push.** If `.git/index.lock` blocks you and no real `git` process is running (`ps aux | grep git`), `rm -f` it.
- **TDD:** failing tests first, then implement, then focused tests, then commit.
- **Bun** for core unit tests (`bun test <file>`); **Vitest** for relay-web (`cd packages/relay-web && npx vitest run <file>`). Do **not** run `npm run test:smoke`.
- Read `AGENTS.md` for build/test commands, conventions, and docs nav.

## Current state of `main`

```
7ca16867 feat(sessions): publish durable resource lifecycle events
57acb1bd feat(plugin-api): expose session resource catalog
52179bd8 feat(sessions): persist immutable logical session ids
```

Working tree is clean. Untracked in this repo (still the previous agent's spec/plan + this handoff):

```
docs/superpowers/plans/2026-08-10-relay-web-rmux-terminal.md
docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md
docs/superpowers/handoff-2026-08-11-relay-web-rmux-terminal.md   ← you are here
```

## Phase status

| Plan range | Status |
|---|---|
| Phase A (Tasks 1–3, RMUX upstream) | **External, blocked.** No commits here; the previous session reverted its local commit and uncommitted draft per user. Real Rust sidecar + Node driver stay gated on RMUX publishing `rmux-sdk 0.10.x` with `adopt_owned_session` + fencing + `abandon_to_lease_expiry`. |
| Phase B / Task 4 | ✅ committed (`52179bd8`) |
| Phase B / Task 5 | ✅ committed (`57acb1bd`) |
| Phase B / Task 6 | ✅ committed (`7ca16867`) |
| Phase B / Task 7 | **not started.** Subagent was cancelled mid-flight by user; no commits, no working tree changes. |
| Phase C (Tasks 8–9) | not started |
| Phase D (Tasks 10–14) | not started |
| Phase E (Tasks 15–17) | blocked on Phase A publish |
| Phase F (Tasks 18–23) | partial possible: hub wiring, web recovery reducer, controller/spectator UI can land against the **in-memory** `RmuxTerminalDriver` while waiting for E. Real sidecar integration needs E. |
| Phase G (Tasks 24–29) | not started |

## Recommended next step

Land **Task 7** (`feat(channels): add reasoned asynchronous shutdown`) to finish Phase B. Then proceed with Phase C (Tasks 8–9), Phase D (Tasks 10–14, can run entirely with the in-memory driver), and finally the in-memory-compatible parts of Phase F (Tasks 19, 20, 21, 22, 23). Phase E and the parts of Phase F/Phase G that depend on a real RMUX daemon stay parked until RMUX upstream publishes the new contract.

## Key seams the next agent should know about

- **`LogicalSession.logical_session_id`** is a required UUIDv4 in `src/state/types.ts`. `StateStore.load()` performs a one-shot migration for legacy records (fail-closed; see `persistMigration` and `writeMigration` injection).
- **`CoreSessionResourceCatalog`** (`src/sessions/session-resource-catalog.ts`) is the channel-agnostic seam. `emit()` is now real: archive/unarchive/restore/remove all flow through `SessionService.commitLifecycleTransition` → `replaceRuntimeState` → publisher → `emit()`. `removed` carries the pre-delete snapshot. Listener throws are caught in the catalog and logged, never rolled back. Workspace-deregistered records publish nothing.
- **`SessionService.commitLifecycleTransition`** (`src/sessions/session-service.ts:644`) is the durability gate: `saveNow` → swap runtime state → publish event. Every archive/unarchive/remove/useSession-restore funnels through this. `setArchived()` has a no-op guard for already-matching state.
- **`saveNow`** on the debounced state store is the immediate durable-write seam. Use it; do not bypass it for lifecycle transitions.

## Environment quirks (not regressions — don't chase them)

- The test runner kills any step exceeding `RUN_TESTS_STEP_TIMEOUT_MS` (default `180_000`). Run full suites as `RUN_TESTS_STEP_TIMEOUT_MS=600000 npm test`; without this, `test:web` (relay-web vitest) gets SIGTERM-killed on this machine.
- `tests/unit/packages/channel-relay/relay-client.test.ts` "reconnects after a drop; fatal handshake rejection stops retrying" is a known load-sensitive flake (asserts 2 WS connections within 400ms; under parallel suite load it sees 0). Passes standalone. Pre-existing.
- `tests/unit/commands/` oracle scenarios fail only when combined in one bun process; passes standalone. `npm test` runs each file individually, so CI is green.

## Quick smoke before resuming

```bash
cd /Users/maijiazhen/Projects/xacpx
git log --oneline -4
npx tsc --noEmit
bun test tests/unit/sessions/ tests/unit/state/ tests/unit/plugins/plugin-api-types.test.ts tests/unit/run-console.test.ts
```

Then re-launch the Task 7 subagent with the same prompt that was interrupted (the prompt is reproducible from the plan's Task 7 checkboxes plus the constraints above). After Task 7 lands, Task 8 is the next straightforward unit-of-work.