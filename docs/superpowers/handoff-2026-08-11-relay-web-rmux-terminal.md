# Handoff: Relay Web RMUX Terminal Implementation

> **Date:** 2026-08-11
> **Author of this handoff:** Cursor Grok session that landed Tasks 8–9 (Phase C).
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
7990db8d feat(relay): propagate connector capabilities
f4cb08a3 feat(relay-protocol): define recoverable terminal wire contract
8682d9a6 docs(superpowers): update handoff after completing Task 7
2c6bea30 feat(channels): add reasoned asynchronous shutdown
a931f4bb docs(superpowers): add RMUX terminal spec, plan, and handoff for next agent
7ca16867 feat(sessions): publish durable resource lifecycle events
57acb1bd feat(plugin-api): expose session resource catalog
52179bd8 feat(sessions): persist immutable logical session ids
```

Working tree is clean after Tasks 8–9.

## Phase status

| Plan range | Status |
|---|---|
| Phase A (Tasks 1–3, RMUX upstream) | **External, blocked.** Real Rust sidecar + Node driver stay gated on RMUX publishing `rmux-sdk 0.10.x` with `adopt_owned_session` + fencing + `abandon_to_lease_expiry`. |
| Phase B (Tasks 4–7) | ✅ complete |
| Phase C / Task 8 | ✅ committed (`f4cb08a3`) |
| Phase C / Task 9 | ✅ committed (`7990db8d`) |
| Phase D (Tasks 10–14) | **next** — not started |
| Phase E (Tasks 15–17) | blocked on Phase A publish |
| Phase F (Tasks 18–23) | partial possible after D: hub wiring, web recovery reducer, controller/spectator UI can land against in-memory `RmuxTerminalDriver`. Real sidecar needs E. |
| Phase G (Tasks 24–29) | not started |

## Recommended next step

**Phase C is complete.** Proceed with Phase D (Tasks 10–14: plugin terminal config parsing, in-memory terminal driver, durable registry, attachments, runtime reconciliation). These run entirely without waiting for Phase A's RMUX upstream publish. After Phase D, implement in-memory-compatible Phase F pieces (Tasks 19–23). Phase E and real-sidecar parts of F/G stay parked until RMUX publishes the new contract.

## Key seams the next agent should know about

### From Phase B
- **`LogicalSession.logical_session_id`** is a required UUIDv4 in `src/state/types.ts`. `StateStore.load()` performs a one-shot migration for legacy records.
- **`CoreSessionResourceCatalog`** (`src/sessions/session-resource-catalog.ts`) is the channel-agnostic seam; `emit()` is real via `SessionService.commitLifecycleTransition`.
- **`ChannelStopReason`** (`src/channels/types.ts`) is part of the public channel contract. `ChannelCliDeps.retireChannel` is the async retirement hook for disable/remove.

### From Phase C
- Recoverable terminal wire contract lives in `packages/relay-protocol` (`MSG.terminalOpen`…`terminalResourceExit`, web client/server unions, `parseTerminalEventPayload`, `parseCanonicalBase64`, hard limits, `TERMINAL_ERROR_CODES`, `RELAY_CAPABILITIES`).
- Legacy live-PTY frames (`terminalId`/`data`) remain; hub `web-inbound` still only forwards the legacy path. New RMUX frames are additive and not yet routed (Phase F).
- **`normalizeCapabilities()`** validates/dedupes/caps handshake capability arrays. Unknown strings are retained for forward-compat but are not treated as terminal support.
- Hub persists `capabilities_json` on every register/auth via `InstanceStore.touch(..., capabilities)`. Disconnect keeps last-known set; web gates on `online` + both caps via **`supportsRmuxTerminal(instance)`** in `packages/relay-web/src/stores/instances.ts`.
- `RelayClient` accepts `capabilities?: string[]` at construction and always sends the snapshot (default `[]`) — do not connect then backfill.

## Environment quirks (not regressions — don't chase them)

- The test runner kills any step exceeding `RUN_TESTS_STEP_TIMEOUT_MS` (default `180_000`). Run full suites as `RUN_TESTS_STEP_TIMEOUT_MS=600000 npm test`.
- `tests/unit/packages/channel-relay/relay-client.test.ts` "reconnects after a drop; fatal handshake rejection stops retrying" is a known load-sensitive flake. Passes standalone.
- `tests/unit/commands/` oracle scenarios fail only when combined in one bun process; `npm test` runs each file individually.

## Quick smoke before resuming

```bash
cd /Users/maijiazhen/Projects/xacpx
git log --oneline -4
npx tsc --noEmit
bun test tests/unit/packages/relay-protocol/ tests/unit/packages/relay/stores-instances.test.ts tests/unit/packages/relay/gateway/instance-gateway-status.test.ts tests/unit/packages/channel-relay/relay-client.test.ts
cd packages/relay-web && npx vitest run src/__tests__/instances.test.ts
```

Then start **Task 10** (parse plugin-owned terminal config) from the plan.
