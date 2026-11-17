# PR checklist

## Docs (required when the diff touches `docs/**`, `packages/docs/**`, or a `packages/*/README.md`)

- [ ] **Site pages reconciled** — if a mapped source of truth changed (`docs/cli-reference.md`, `docs/commands.md`, `docs/config-reference.md`, `docs/config-command.md`, `docs/external-mcp.md`, `docs/plugin-development.md`, `docs/channel-management.md`, `docs/native-sessions.md`, `docs/testing.md`, `docs/code-wiki.md`, `docs/commands-module.md`, `docs/daemon-module.md`, `docs/developments.md`, `docs/later-command.md`, `docs/xacpx-group-usage-guide.md`, or a `packages/channel-*/README.md`), the VitePress page(s) under `packages/docs/` were updated and `npm run docs:reconcile` was run. If the delta is intentionally no-impact for the site, say so in the PR body and reconcile anyway.
- [ ] **New docs page classified** — a new `docs/<name>.md` is either registered in `packages/docs/sync-manifest.json` (with its site pages or `site: null`) or falls under an ignore glob.
- [ ] **zh parity** — a new user-facing docs page ships `docs/zh/<name>_zh.md`, or is added to `ZH_EXEMPT` in `scripts/check-doc-i18n.mjs` with a reason. An edit to an existing translated page also updates its `_zh` counterpart.
- [ ] **Brand** — no new `weacpx` spelling outside legacy/compat context (`npm run doc:i18n` is green).

## Code

- [ ] `npx tsc --noEmit` clean (or `npm test` run)
- [ ] New behavior covered by a test in `tests/unit/**` (or the PR body says why not)
- [ ] No `docs/` claim added that contradicts the code (docs are reviewed against code, not the reverse)
