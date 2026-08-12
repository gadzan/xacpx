# Handoff: Relay Web RMUX Terminal Implementation

> **Date:** 2026-08-12
> **Read first if you are the next agent picking this up.**

Authoritative docs:

- Spec: `docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md` (wins on conflict)
- Plan: `docs/superpowers/plans/2026-08-10-relay-web-rmux-terminal.md`

## Scope rules

- Do **not** edit `../rmux` or `../acpx`
- One commit per task; exact plan messages; **do not push**
- TDD; Bun for core/channel-relay/relay tests; Vitest for relay-web
- Do **not** run `npm run test:smoke`

## Phase status

| Plan range | Status |
|---|---|
| Phase A (Tasks 1–3) | **Blocked** — needs published `rmux-sdk 0.10.x` with adopt/fence/abandon |
| Phase B (Tasks 4–7) | ✅ |
| Phase C (Tasks 8–9) | ✅ |
| Phase D (Tasks 10–14) | ✅ |
| Phase E (Tasks 15–17) | **Blocked** on Phase A |
| Phase F Task 18 | ✅ channel-relay owns runtime (in-memory driver) |
| Phase F Tasks 19–20 | ✅ hub viewer maps + two-phase open/RPC |
| Phase F Task 21 | ✅ ghostty adapter |
| Phase F Tasks 22–23 | **next** — web recovery store + TerminalTab UX |
| Phase G | partial later; real RMUX smoke still blocked |

## Recent commits (local `main`, do not push)

```
feat(relay): coordinate terminal attachment requests
feat(relay): route terminal streams to attached viewers
feat(channel-relay): own relay rmux terminal lifecycle
feat(channel-relay): reconcile rmux terminal ownership
feat(channel-relay): add durable relay terminal runtime
```

## Next step

**Task 22** — `packages/relay-web` request client + recovery reducer/store (`feat(relay-web): recover rmux terminal attachments`), then Task 23 UI.

Use in-memory path end-to-end; real sidecar stays parked until RMUX publish.
