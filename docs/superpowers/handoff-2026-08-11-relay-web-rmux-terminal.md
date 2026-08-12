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
| Phase B–D | ✅ |
| Phase E (Tasks 15–17) | **Blocked** on Phase A |
| Phase F Tasks 18–23 | ✅ |
| Phase G Tasks 24–25, 28–29 | ✅ |
| Phase G Tasks 26–27 | **Blocked** on RMUX publish / sidecar artifacts |
| Phase G Task 30+ | Park / product decision / deferred legacy removal |

## Recent commits (local `main`, do not push)

```
docs: document relay rmux terminal operations                         # Task 29
feat(doctor): report relay rmux terminal health                       # Task 28
test(relay): cover rmux terminal fault recovery                       # Task 25
feat(channel-relay): retire terminals on destructive channel actions  # Task 24
```

## Next step

Everything doable without real RMUX is done. Remaining:

- **Task 26–27**: real smoke + platform binary packaging (blocked)
- **Task 30**: production readiness / enablement (product decision; keep `terminal.enabled` default false)
- **Task 31**: delete legacy core terminal (deferred separate PR)

Do **not** push; do **not** flip the terminal default on.
