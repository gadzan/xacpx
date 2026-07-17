# Contributing and Development

A guide for bug fixers, feature developers, channel plugin authors, and code readers. For end-user documentation, see the [Getting Started](/guide/getting-started) guide and [README](https://github.com/gadzan/xacpx/blob/main/README.md).

## Development setup

### Prerequisites

- **Node.js ≥ 22.12** or **Bun** (Bun is used for development scripts and builds; Node can run the output)
- A WeChat, Feishu, or Yuanbao account (depending on which channel you are testing; code reading requires neither)
- `acpx` and your target agent CLI (codex / claude / gemini, etc.) runnable on the machine

### Clone and install

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install            # installs root package and all packages/* (workspaces)
```

### First build

```bash
bun run build              # main package: dist/cli.js + dist/bridge/bridge-main.js + dist/plugin-api.{js,d.ts}
bun run build:packages     # main package + all packages/* (required before publishing)
```

### First run

```bash
bun run dev                # equivalent to: bun run ./src/cli.ts run (foreground)
```

Or use dry-run mode (no IM connection required):

```bash
bun run dry-run --chat-key wx:test -- "/ss new demo --agent codex --ws backend" "/status"
```

### First test

```bash
npm test                   # tsc --noEmit + tests/unit/**/*.test.ts
```

## Build commands

| Script | Purpose |
| --- | --- |
| `bun run build` | Main package: bundle `dist/cli.js`, `dist/bridge/bridge-main.js`, `dist/plugin-api.js`; emit `dist/plugin-api.d.ts` via `tsc -p tsconfig.plugin-api.json` |
| `bun run build:plugin-api` | Refresh `dist/plugin-api.d.ts` only (use when changing public types) |
| `bun run build:channel-feishu` | Main package + Feishu plugin |
| `bun run build:channel-yuanbao` | Main package + Yuanbao plugin |
| `bun run build:packages` | Main package + all `packages/*` |
| `bun run verify:publish` | `build:packages` + `scripts/verify-publish.mjs` (run before every publish) |
| `bun run dev` | Run main package source directly (no build needed) |
| `bun run dry-run -- ...` | Dry-run entry point (no IM connection) |
| `bun run login` | WeChat QR scan login |

Build notes:
- `bun build --target node --external node-pty` — `node-pty` is not bundled; resolved from `node_modules` at runtime. `packages/*` similarly mark `xacpx` as external.
- The only stable public API export is `xacpx/plugin-api`. Other paths (`xacpx/dist/*`, `xacpx/src/*`) are internal and may change at any time.
- Plugin packages use `tsc -p packages/<name>/tsconfig.json` to emit `.d.ts` files separately, because `bun build` does not currently emit declaration files.

### Three local run modes

**Mode 1 — `bun run dev` (foreground):** The most common mode. Runs `src/cli.ts run` directly; hot-edit without rebuilding. Good for debugging router, channel, orchestration, and transport.

**Mode 2 — `dist/cli.js` (simulate installed state):**
```bash
bun run build
node ./dist/cli.js start
node ./dist/cli.js status
node ./dist/cli.js stop
```
Good for reproducing "user-installed" behavior, testing the `bin/xacpx` entry point, and verifying `node-pty` resolution after bundling.

**Mode 3 — `bun run dry-run` (no IM):**
```bash
bun run dry-run --chat-key wx:test -- \
  "/agent add codex" \
  "/ws new backend -d /absolute/path/to/backend" \
  "/ss new demo -a codex --ws backend" \
  "/status"
```
Reuses the same `buildApp` + router + transport stack, replacing IM inbound with command-line arguments and IM outbound with terminal output. Good for reproducing command parsing and session lifecycle bugs that are hard to isolate in unit tests.

## Test commands

| Directory | Command | When to use |
| --- | --- | --- |
| `tests/unit/` | `npm test` or `npm run test:unit` | Default; mirrors `src/` structure; runs in CI |
| `tests/smoke/` | `npm run test:smoke` | Real `acpx` / real IM protocols; run manually, not in CI |
| `tests/helpers/`, `tests/fixtures/` | — | Shared utilities and static data |

The test runner is `scripts/run-tests.mjs` → `scripts/run-tests-lib.mjs::buildTestPlan`. It runs `tsc --noEmit` first, then spawns a separate `bun test` process for each `*.test.ts` file. To change runner behavior, only modify those two scripts.

Testing conventions:
- Any test that writes to disk must use `mkdtemp` for isolation and clean up with `rm -rf`.
- Time-sensitive assertions must `await` an expected promise or poll until a condition is met — never use `Bun.sleep()` as a synchronization barrier.
- Tests involving `state.json` writes must pass `stateSaveDebounceMs: 0` to `buildApp()` (see the wrapper at the top of `tests/unit/main.test.ts`).

## Repository layout

### Top level

```
xacpx/
├── src/                # Main package source
├── packages/           # First-party channel plugins
│   ├── channel-feishu/
│   └── channel-yuanbao/
├── tests/
│   ├── unit/           # Default unit tests
│   ├── smoke/          # Real acpx / real account tests
│   ├── helpers/        # Shared fixtures and mocks
│   └── fixtures/       # Static test data
├── docs/               # User docs, design documents, plans
│   └── superpowers/    # plans/ and specs/
├── packages/docs/      # VitePress docs site
├── scripts/            # Test runner, publish preflight
├── package.json        # npm workspaces root
├── bun.lock
├── tsconfig.json
├── tsconfig.plugin-api.json
├── AGENTS.md           # Project conventions (CLAUDE.md is a symlink)
└── README.md
```

### `src/` subdirectories

| Directory | Responsibility |
| --- | --- |
| `src/cli.ts` | CLI entry point; dispatches all `xacpx <command>` subcommands |
| `src/main.ts` | `buildApp()` runtime assembly; `resolveRuntimePaths()` path resolution |
| `src/run-console.ts` | Startup sequence: daemon runtime → consumer lock → channel start |
| `src/console-agent.ts` | Bridges inbound messages to the router |
| `src/channels/` | Channel registry; built-in `weixin`; exposes `MessageChannelRuntime` to plugins |
| `src/commands/` | Command parsing + handlers + router |
| `src/sessions/` | Logical sessions (`state.json` persistence) + `AsyncMutex` serialization |
| `src/transport/` | `acpx` bridge abstraction + `acpx-cli` and `acpx-bridge` implementations |
| `src/bridge/` | `acpx-bridge` subprocess entry and JSONL protocol |
| `src/orchestration/` | Multi-agent orchestration service + IPC server/client + state machine |
| `src/mcp/` | `xacpx mcp-stdio` — exposes orchestration as an MCP server |
| `src/daemon/` | Daemon controller, status/PID files, runtime metadata |
| `src/plugins/` | Plugin loading, CLI, doctor, package manager abstraction, validation |
| `src/plugin-api.ts` | **Public** plugin API type re-exports (compiled to `dist/plugin-api.d.ts`) |
| `src/state/` | `state.json` persistence + `DebouncedStateStore` (50 ms write merge) |
| `src/config/` | `config.json` load / write / default template |
| `src/recovery/` | Auto-install of missing optional dependencies |
| `src/logging/` | Bounded `app.log`, level filtering |
| `src/weixin/` | Built-in WeChat channel + media pipeline + consumer lock |

### `packages/` subpackages

Each plugin package has the same structure:

```
packages/channel-<name>/
├── src/
│   ├── index.ts           # default export XacpxPlugin
│   ├── channel.ts         # implements MessageChannelRuntime
│   ├── <name>-provider.ts # implements ChannelCliProvider
│   └── ...
├── dist/                  # bun build output + tsc-emitted .d.ts files
├── package.json           # peerDependencies.xacpx (optional)
├── tsconfig.json
└── README.md
```

For writing a new channel plugin, see the [Channel Plugin Development](/plugins/development) reference.

## Package management

xacpx uses **Bun** as the primary development package manager. The lockfile is `bun.lock`.

Plugin package management (inside `~/.xacpx/plugins/`) uses automatic detection: if `bun --version` succeeds, `bun add/remove` is used; otherwise it falls back to `npm install/uninstall` (`src/plugins/package-manager.ts`).

### Plugin home resolution

1. `WEACPX_PLUGIN_HOME` environment variable.
2. Default: `~/.xacpx/plugins/` (isolated `package.json` + `node_modules`; separate from global or project `node_modules`).

### WeChat SDK resolution

1. `WEACPX_WEIXIN_SDK` environment variable.
2. Installed package `weixin-agent-sdk`.

## Release and publishing notes

```bash
bun run verify:publish      # build:packages + scripts/verify-publish.mjs
```

When releasing:
- Bump `version` in `package.json`; if first-party plugins changed, bump `packages/*/package.json` too.
- Add release notes to `docs/releases/`.
- Create a git tag.

Publish commands:
```bash
bun run publish:xacpx
bun run publish:plugins     # when upgrading first-party plugin packages
```

Tag conventions:
- Core: `vX.Y.Z`
- Plugins: `channel-<pkg>-vX.Y.Z`

Pushing a tag triggers automatic npm publish via CI.

Commit and PR conventions:
- Follow conventional commits: `fix:`, `feat:`, `docs:`, `chore:`, `test:`.
- Keep each commit focused on one change; smaller diffs are easier to review.
- Include tests in the same commit as the code change.
- PR title under 70 characters; description covers why, how, and how to verify.
- Changes that affect daemon behavior (channel, transport, orchestration, state) should include a dry-run script as evidence.

## Documentation conventions

- `AGENTS.md` (symlinked as `CLAUDE.md`) contains long-term stable constraints and navigation for contributors. Only edit `AGENTS.md` — never `CLAUDE.md` directly.
- When adding or refactoring a subsystem: update or add the corresponding `docs/*.md` page first, then add a navigation entry in `AGENTS.md`.
- When adding CLI / config / command capabilities: update `README.md` / `docs/commands.md` / `docs/config-reference.md` first, then add a link in the "Docs to rely on" section of `AGENTS.md`.
- Keep `AGENTS.md` short — move details longer than one screen into `docs/` or `docs/code-wiki.md`.

Design documents live in `docs/superpowers/`:
- **specs** (`YYYY-MM-DD-<topic>-design.md`) — explain what problem is being solved, why, and what alternatives were considered.
- **plans** (`YYYY-MM-DD-<topic>.md`) — break a spec into steps that an agent or a person can execute one at a time.

Both are typically included in the same merge as the implementation.

### Finding your way around

| Goal | Where to look / what to change |
| --- | --- |
| Add a new slash command | `src/commands/parse-command.ts` → `src/commands/handlers/` → `src/commands/command-router.ts` → `tests/unit/commands/` |
| Change a command's reply format | `src/formatting/` render functions |
| Add a new channel (Feishu, Slack, Discord, …) | **Do not** change `src/channels/` — see [Channel Plugin Development](/plugins/development) and create `packages/channel-<type>/` |
| Change acpx invocation (args, PTY, timeout) | `src/transport/acpx-cli/` or `src/transport/acpx-bridge/`; keep the `SessionTransport` interface stable |
| Add or change an orchestration capability | `src/orchestration/orchestration-service.ts` + IPC files; tests in `tests/unit/orchestration/` |
| Change daemon start/stop behavior | `src/daemon/`; if status fields change, update `daemon-status.ts` and this docs site |
| Change `xacpx doctor` | `src/doctor/index.ts` and its probes |
| Change `xacpx mcp-stdio` exposed tools | `src/mcp/xacpx-mcp-tools.ts` |
| Change `state.json` schema | `src/state/types.ts` + `state-store.ts` parsing; consider migration |
| Add or change public plugin API types | `src/plugin-api.ts` re-exports + `bun run build:plugin-api` |
| Fix the test runner | `scripts/run-tests-lib.mjs` (`buildTestPlan`) |
| Add publish preflight check | `scripts/verify-publish.mjs` |
