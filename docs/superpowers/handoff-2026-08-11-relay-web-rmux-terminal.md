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
| Phase F Tasks 18–23 | ✅ (in-memory driver / fake path; no real RMUX sidecar) |
| Phase G Task 24+ | **next** where doable without real RMUX; Task 26 still blocked |

## Recent commits (local `main`, do not push)

```
feat(relay-web): add shared terminal control and global close   # Task 23
feat(relay-web): recover rmux terminal attachments              # Task 22
feat(relay): coordinate terminal attachment requests            # Task 20
feat(relay): route terminal streams to attached viewers         # Task 19
feat(channel-relay): own relay rmux terminal lifecycle          # Task 18
```

## Next step

**Phase G** — start with Task 24 (`feat(channel-relay): retire terminals on destructive channel actions`) and Task 25 fake E2E where possible. Skip / park Task 26 until RMUX publish.

Blocked forever until RMUX publish: Phase A Tasks 1–3, Phase E Tasks 15–17, Task 26 smoke.
