# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Build & Test Commands

```bash
bun run build          # Build CLI to ./dist (outputs cli.js and bridge/bridge-main.js)
npx tsc --noEmit       # Run TypeScript typecheck
npm test               # Run typecheck, then all unit tests (tests/unit/**/*.test.ts)
npm run test:unit      # Alias for above
npm run test:smoke     # Run smoke tests (tests/smoke/**/*.test.ts) — needs real acpx + WeChat
```

`transport.permissionMode` defaults to `approve-all` when omitted, so non-interactive prompt turns do not stop on acpx permission requests unless the user explicitly configures a stricter policy.

**Local daemon CLI (before publish):**
```bash
bun run dev            # Run console in foreground (dev mode)
bun run login          # Show QR code for WeChat login
node ./dist/cli.js start   # Start daemon in background
node ./dist/cli.js status  # Check daemon status
node ./dist/cli.js stop    # Stop daemon
```

**Local dry-run (no WeChat needed):**
```bash
bun run dry-run --chat-key wx:test -- "/session new demo --agent codex --ws backend" "/status"
```

**Monorepo builds (packages/* are Bun workspaces):**
```bash
bun run build:packages       # Build root + all channel/relay packages
bun run build:relay          # Build relay hub (bundles relay-web dashboard)
bun run build:channel-relay  # Build relay channel plugin
```

## Architecture Overview

### Core Purpose
xacpx is a WeChat console that lets you remotely control `acpx` sessions. It bridges WeChat messages to agent sessions via `weixin-agent-sdk`.

### Transport Layer (src/transport/)

Two transport implementations share the `SessionTransport` interface:

- **`acpx-cli`** - Spawns `acpx` directly as a child process. Uses `node-pty` for PTY allocation.
- **`acpx-bridge`** - Runs `acpx` in a separate bridge subprocess (`src/bridge/bridge-main.ts`). Uses stdin/stdout JSON protocol.

Both transports expose: `ensureSession`, `prompt`, `setMode`, `cancel`, `hasSession`.

### Session Model

There are two session concepts:

1. **Logical session** (managed by `SessionService`) - tracks alias, agent, workspace, and chat context per user.
2. **Transport session** - the actual `acpx` named session on the backend.

`/session new` creates both. `/session attach` only creates the logical session and binds to an existing transport session. **Most bugs are mismatches between these two.**

### Config & State

- Config (`~/.xacpx/config.json`) - transport, agents, workspaces. Written via `ConfigStore`.
- State (`~/.xacpx/state.json`) - sessions, chat contexts. Written via `StateStore`.

### Acpx Resolution (priority order)

1. `transport.command` in config (explicit override)
2. Bundled `acpx` in `node_modules`
3. `acpx` in shell `PATH`

### Managed ACP Adapters

- `src/adapters/` owns xacpx's exact Codex/Claude adapter defaults, the `xacpx adapter` CLI, adapter-only npm registry policy, and the ACP initialize probe used before saving a local version override.
- Runtime resolution keeps an explicit `agents.<name>.command` highest priority; otherwise Codex/Claude use the configured or release-default exact npx pin through `transport.adapterRegistry`, which defaults to the public npm registry rather than the machine npm default.

## Boundaries (where changes go)

- Core channel work stays inside `src/channels/` — limited to Weixin plus generic channel/plugin infrastructure. New non-Weixin channels must be plugin packages under `packages/channel-*` or external npm plugins.
- Command semantics live in `src/commands/` (parse + handlers + router).
- Anything that touches `acpx` must go through transport implementations in `src/transport/`.
- Daemon lifecycle lives in `src/daemon/` and should remain compatible with `xacpx start/status/stop`.
- Windows process ownership and fail-closed orphan cleanup live in `src/transport/orphan-registry.ts` and `src/transport/windows-orphan-reaper.ts`; automatic kill paths must stay handle-bound.

## Docs to rely on (don't reverse-engineer from code first)

- Terminal CLI reference: [`docs/cli-reference.md`](docs/cli-reference.md)
- Configuration schema and defaults: [`docs/config-reference.md`](docs/config-reference.md)
- WeChat command surface: [`docs/commands.md`](docs/commands.md)
- User-facing FAQ: [`docs/faq.md`](docs/faq.md)
- Daemon subsystem: [`docs/daemon-module.md`](docs/daemon-module.md)
- Commands module: [`docs/commands-module.md`](docs/commands-module.md)
- MCP integration: [`docs/external-mcp.md`](docs/external-mcp.md)
- `xacpx doctor`: [`docs/doctor-command.md`](docs/doctor-command.md)
- Control API: [`docs/control-module.md`](docs/control-module.md)
- Relay Hub deployment: [`docs/relay-deployment.md`](docs/relay-deployment.md)
- Relay Hub module: [`docs/relay-module.md`](docs/relay-module.md)
- Relay release runbook: [`docs/relay-release.md`](docs/relay-release.md)
- Relay Web dashboard: [`docs/relay-web-module.md`](docs/relay-web-module.md)
- Relay Hub RMUX terminal (process-owned): [`docs/superpowers/specs/2026-08-12-relay-web-rmux-process-owned-design.md`](docs/superpowers/specs/2026-08-12-relay-web-rmux-process-owned-design.md)
- Relay RMUX terminal design (original lease-adopt): [`docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md`](docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md)
- Code Wiki (architecture map): [`docs/code-wiki.md`](docs/code-wiki.md)

## Gotchas

- **`node-pty` is a native module** — requires C++ build tools. If `bun install` fails on node-pty, the environment lacks a compiler toolchain.
- **`CLAUDE.md` is a symlink to `AGENTS.md`** — only edit `AGENTS.md`, never `CLAUDE.md` directly.
- **Smoke tests need real infrastructure** — `tests/smoke/` requires a real acpx binary and real WeChat login. Never run them in CI or automated checks without setup.
- **Runtime logs**: `~/.xacpx/runtime/app.log` (unified app logger); perf logs: `~/.xacpx/runtime/perf.log`. No separate `/tmp/openclaw` logger.
- **acpx source** lives at `../acpx` (sibling directory) for local development reference.

## Package Manager

Uses **Bun** for development scripts and builds. Dependencies are in `package.json`. The lockfile is `bun.lock`.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain documentation layout. See `docs/agents/domain.md`.

## Maintaining AGENTS.md

- Only write long-term stable constraints and navigation; volatile implementation details go to `docs/` or Code Wiki.
- Prefer "entry file / module directory / doc link" over specific function line numbers or internal flow details.
- Links must use repo-relative paths, never machine-specific absolute paths.
- When adding/refactoring a subsystem: first update the corresponding `docs/*.md`, then add a navigation entry here.
- Keep this file short; details exceeding one screen should migrate to `docs/` or `docs/code-wiki.md`.
