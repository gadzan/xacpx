# Contributor Development Guide

> For anyone who wants to fix bugs, add features, write channel plugins, or read the code to understand the architecture.
> User-facing usage docs: [README.md](../README.md).

---

## Table of Contents

- [Project Snapshot](#project-snapshot)
- [5-Minute Environment Setup](#5-minute-environment-setup)
- [Repository Structure](#repository-structure)
- [Build Pipeline](#build-pipeline)
- [Three Modes for Running Locally](#three-modes-for-running-locally)
- [Testing](#testing)
- [Architecture Map](#architecture-map)
- [Subsystem Cheat Sheet](#subsystem-cheat-sheet)
- [acpx / SDK / Plugin Resolution Order](#acpx--sdk--plugin-resolution-order)
- [Config and Runtime Files](#config-and-runtime-files)
- [Code Style and Conventions](#code-style-and-conventions)
- [Finding the Entry Point by Scenario](#finding-the-entry-point-by-scenario)
- [Plan / Spec Writing Workflow](#plan--spec-writing-workflow)
- [Commits, PRs, and Releases](#commits-prs-and-releases)
- [Further Reading](#further-reading)

---

## Project Snapshot

`xacpx` is a bridging system of **"message channel ↔ command router ↔ acpx session driver"**:

- **Channels**: `weixin` is built in; `feishu` / `yuanbao` are distributed as first-party plugin packages; any npm package conforming to the `WeacpxPlugin` contract can be added.
- **Command routing**: parses slash commands such as `/ss`, `/agent`, `/group` received from WeChat/Feishu/Yuanbao/CLI; plain text is fed to the current session as a prompt.
- **Transport**: unifies "session ensure/prompt/cancel/setMode" into the `SessionTransport` interface, with two concrete implementations — `acpx-cli` (spawns `acpx` directly, optionally allocating a PTY via `node-pty`) and `acpx-bridge` (a standalone bridge subprocess + JSONL protocol).
- **Orchestration** (optional): under a coordinator session, delegates multiple workers, tracking progress, questions, human confirmation, and grouped aggregation. Can be exposed to an external MCP host via `xacpx mcp-stdio`.
- **Daemon**: `xacpx start` / `status` / `stop`, with PID + status + log landing in `~/.xacpx/runtime/`.
- **Monorepo**: `packages/channel-feishu` and `packages/channel-yuanbao` are published from the same repo as npm workspaces alongside the main package.

---

## 5-Minute Environment Setup

### Required Environment

- **Node.js ≥ 22.13** or **Bun** (Bun is used for dev scripts and builds; the runtime can also use Node)
- A usable WeChat / Feishu / Yuanbao account (depending on which channel you're testing; can be skipped if you're only reading code)
- The ability to run `acpx` and the agent CLI you want to connect (codex / claude / gemini …) locally

### Clone and Dependencies

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install            # Installs deps for both the root package and packages/* (workspaces)
```

### First Build

```bash
bun run build              # Main package: dist/cli.js + dist/bridge/bridge-main.js + dist/plugin-api.{js,d.ts}
bun run build:packages     # Main package + all packages/* (required before publishing)
```

### First Run

```bash
bun run dev                # Equivalent to bun run ./src/cli.ts run, runs the daemon in the foreground
```

Or just run a dry-run (without connecting to an IM):

```bash
bun run dry-run --chat-key wx:test -- "/ss new demo --agent codex --ws backend" "/status"
```

### First Test

```bash
npm test                   # tsc --noEmit + tests/unit/**/*.test.ts
```

Once this step passes, you're welcome to start working on the code.

---

## Repository Structure

### Top Level

```
xacpx/
├── src/                # Main package source
├── packages/           # First-party channel plugins
│   ├── channel-feishu/
│   └── channel-yuanbao/
├── tests/
│   ├── unit/           # Default unit tests
│   ├── smoke/          # Require real acpx / real accounts
│   ├── helpers/        # Shared fixtures / mocks
│   └── fixtures/       # Static data
├── docs/               # User docs + this guide + design docs
│   ├── superpowers/    # plans/ + specs/, workflow detailed below
│   └── releases/       # Historical release notes
├── scripts/            # Test runner, pre-publish checks
├── package.json        # Also the npm workspaces root
├── bun.lock
├── tsconfig.json
├── tsconfig.plugin-api.json
├── AGENTS.md           # Project conventions (CLAUDE.md is a symlink to it)
└── README.md
```

### `src/` Subdirectories

One sentence per directory to make its responsibility clear; deeper content is in the corresponding module docs.

| Directory | Responsibility | Entry / Key Files |
| --- | --- | --- |
| `src/cli.ts` | Top-level CLI entry, `xacpx <command>` dispatch | `runCli()` |
| `src/main.ts` | `buildApp()` assembles the runtime; `resolveRuntimePaths()` resolves paths | `buildApp` |
| `src/run-console.ts` | Startup sequence: channel → daemon runtime → consumer lock → channel start | `runConsole()` |
| `src/console-agent.ts` | Bridges inbound messages to the router | `ConsoleAgent` |
| `src/channels/` | Channel registry; built-in weixin; exposes `MessageChannelRuntime` to plugins | `channels/types.ts`, `channels/plugin.ts` |
| `src/commands/` | Command parsing + handlers + router | `command-router.ts`, `parse-command.ts` |
| `src/sessions/` | Logical sessions (state.json persistence) + AsyncMutex serialization | `session-service.ts` |
| `src/transport/` | acpx bridging abstraction + cli/bridge implementations | `transport/types.ts`, `acpx-cli/`, `acpx-bridge/` |
| `src/bridge/` | acpx-bridge subprocess entry and JSONL protocol | `bridge-main.ts`, `bridge-server.ts`, `bridge-runtime.ts` |
| `src/orchestration/` | Multi-agent orchestration service + IPC server/client + state machine | `orchestration-service.ts`, `orchestration-server.ts` |
| `src/mcp/` | `xacpx mcp-stdio` implementation, exposing orchestration as an MCP server | `xacpx-mcp-server.ts`, `xacpx-mcp-tools.ts` |
| `src/daemon/` | daemon controller, status/PID files, runtime metadata | `daemon-controller.ts`, `daemon-runtime.ts` |
| `src/plugins/` | plugin loading, CLI, doctor, package manager abstraction, signature verification | `plugin-loader.ts`, `plugin-cli.ts`, `plugin-doctor.ts` |
| `src/plugin-api.ts` | **Public** plugin API type re-exports (build artifact `dist/plugin-api.d.ts`) | — |
| `src/state/` | `state.json` persistence + `DebouncedStateStore` (50ms write coalescing) | `state-store.ts`, `debounced-state-store.ts` |
| `src/config/` | `config.json` load/write/default template | `config-store.ts`, `load-config.ts` |
| `src/recovery/` | Auto-recovery when an optional dependency is missing (`auto-install-optional-dep.ts`) | — |
| `src/process/` | Cross-platform subprocess wrapper | — |
| `src/logging/` | bounded `app.log`, filtered by level | `app-logger.ts` |
| `src/formatting/` | Outbound text/task rendering | — |
| `src/util/` | General utilities like `writePrivateFileAtomic` + `proper-lockfile` | `private-file.ts` |
| `src/weixin/` | Built-in weixin channel + media pipeline + consumer lock | `monitor/`, `messaging/` |
| `src/weixin-sdk.ts` | weixin SDK resolver, supports the `WEACPX_WEIXIN_SDK` override | `loadWeixinSdk()` |
| `src/dry-run.ts` | Entry for running the router without connecting to an IM | `bun run dry-run` |
| `src/login.ts` | WeChat QR code login flow | `xacpx login` |
| `src/doctor/` | `xacpx doctor` diagnostic suite | — |

### `packages/` Subpackages

Each plugin package has a consistent structure:

```
packages/channel-<name>/
├── src/
│   ├── index.ts          # Default-exports WeacpxPlugin
│   ├── channel.ts        # implements MessageChannelRuntime
│   ├── <name>-provider.ts# implements ChannelCliProvider
│   └── ...
├── dist/                  # bun build artifacts + .d.ts emitted by tsc
├── package.json           # peerDependencies.xacpx (optional)
├── tsconfig.json          # Inherits the root tsconfig, emitDeclarationOnly
└── README.md
```

To write a new channel plugin, see [docs/plugin-development.md](./plugin-development.md).

---

## Build Pipeline

Key scripts in `package.json`:

| Script | Purpose |
| --- | --- |
| `bun run build` | Main package: `bun build` produces `dist/cli.js`, `dist/bridge/bridge-main.js`, `dist/plugin-api.js` + `tsc -p tsconfig.plugin-api.json` produces `dist/plugin-api.d.ts` |
| `bun run build:plugin-api` | Refresh `dist/plugin-api.d.ts` on its own (used when writing new public types) |
| `bun run build:channel-feishu` | Main package + feishu plugin |
| `bun run build:channel-yuanbao` | Main package + yuanbao plugin |
| `bun run build:packages` | Main package + all packages/* |
| `bun run verify:publish` | `build:packages` + `scripts/verify-publish.mjs` (must run before publishing) |
| `bun run dev` | Run main package source in the foreground (no build needed first) |
| `bun run dry-run -- ...` | dry-run entry |
| `bun run login` | WeChat login |

Key points:

- `bun build --target node --external node-pty`: `node-pty` is not bundled; it is resolved from `node_modules` at runtime. `packages/*` likewise use `--external xacpx`.
- The main package only exports `xacpx/plugin-api` publicly; other paths (`xacpx/dist/*`, `xacpx/src/*`) are **not stable APIs** — don't depend on them externally.
- Plugin packages emit `.d.ts` separately via `tsc -p packages/<name>/tsconfig.json`, because bun build currently does not emit `.d.ts`.

---

## Three Modes for Running Locally

### 1. `bun run dev` — Foreground Main Package

The most common. Runs `src/cli.ts run` directly, hot edits, no dist build.

```bash
bun run dev                # Run in the foreground, Ctrl-C to exit
bun run login              # Complete the WeChat QR scan separately (or in another shell)
```

Good for: debugging the router, channel, orchestration, transport.

### 2. `dist/cli.js` — Simulating the Installed-User State

```bash
bun run build
node ./dist/cli.js start
node ./dist/cli.js status
node ./dist/cli.js stop
```

Good for: reproducing the "what users get after installing" state; testing the `bin/xacpx` entry; verifying `node-pty` resolution after bundling, etc.

### 3. `bun run dry-run` — Without Connecting to an IM

```bash
bun run dry-run --chat-key wx:test -- \
  "/agent add codex" \
  "/ws new backend -d /absolute/path/to/backend" \
  "/ss new demo -a codex --ws backend" \
  "/status"
```

Reuses the same `buildApp` + router + transport, replacing IM inbound with command-line arguments and printing outbound to the terminal. Good for reproducing command-parsing and session-lifecycle bugs; complex timing that unit tests can't reproduce can also be manually exercised here.

`--chat-key` can be any value; we recommend `wx:test` / `feishu:test` / `yuanbao:test` to simulate routing for different channels.

---

## Testing

Full description: [docs/testing.md](./testing.md). In brief:

| Directory | How to Run | When to Use |
| --- | --- | --- |
| `tests/unit/` | `npm test` / `npm run test:unit` | Default; mirrors the `src/` structure; CI runs this set |
| `tests/smoke/` | `npm run test:smoke` | Real acpx / real IM protocol; run manually locally, not in CI |
| `tests/integration/` | (not yet enabled) | Cross-module, cross-process collaboration tests, to be expanded in the future |
| `tests/helpers/`, `tests/fixtures/` | — | Shared by tests |

Test runner: `scripts/run-tests.mjs` → `scripts/run-tests-lib.mjs::buildTestPlan`. It first runs `tsc --noEmit`, then starts a separate `bun test` for each `*.test.ts`. To change runner behavior, only touch these two files.

Conventions:

- Any test that writes to disk uses `mkdtemp` for isolation and `rm -rf` to self-clean.
- For time-related assertions, **do not** use `Bun.sleep(20)` as a synchronization barrier. Either explicitly `await someExpectedPromise`, or poll until the condition is satisfied. The reason is in the pitfalls we've hit historically.
- For test cases involving `state.json` disk writes, remember to pass `stateSaveDebounceMs: 0` when calling buildApp (the wrapper is already at the top of `tests/unit/main.test.ts`).

---

## Architecture Map

Full map: [docs/code-wiki.md](./code-wiki.md). Here we only draw a single overall flow diagram, to help build a mental model first.

```
            +------------------------------------------------------+
            | User sends a message on an IM platform / CLI input   |
            +------------------------------------------------------+
                              |
                              v
   +-----------------------------------------------------+
   | MessageChannelRuntime (weixin / feishu / yuanbao …) |
   |   - chatKey construction                            |
   |   - inbound dedup, media persistence                |
   |   - outbound quota (OutboundQuota)                  |
   +-----------------------------------------------------+
                              |  agent.handle(chatKey, text)
                              v
                    +---------------------+
                    | ConsoleAgent        |
                    +---------------------+
                              |
                              v
                    +---------------------+
                    | CommandRouter       |  ← src/commands/
                    +---------------------+
                       |              |
        slash command  |              | plain text
                       v              v
              +------------+    +-------------+
              | handlers/  |    | SessionService → transport.prompt
              +------------+    +-------------+
                                       |
                                       v
              +-------------------------------------------+
              | SessionTransport (acpx-cli | acpx-bridge) |
              +-------------------------------------------+
                                       |
                                       v
                                 acpx subprocess
```

Side paths:

- **Orchestration** exposes multi-agent orchestration capability externally via `OrchestrationServer` (Unix socket / Named Pipe). `xacpx mcp-stdio` is its MCP-over-stdio client wrapper.
- **Daemon** wraps `runConsole` + IPC server + heartbeat into a background process; the foreground `xacpx run` skips the daemon wrapping.
- **State persistence** goes through `DebouncedStateStore` → `StateStore` → `writePrivateFileAtomic` (`proper-lockfile` for cross-process mutual exclusion + `write-file-atomic` for atomic rename + a Windows EBUSY fallback).

---

## Subsystem Cheat Sheet

| Subsystem | Entry | Doc |
| --- | --- | --- |
| Command parsing and routing | `src/commands/` | [commands-module.md](./commands-module.md), [commands.md](./commands.md) |
| Daemon CLI | `src/daemon/`, `src/cli.ts` | [daemon-module.md](./daemon-module.md) |
| Acpx-Bridge protocol | `src/bridge/` | [`docs/2026-03-25-weacpx-acpx-bridge-design.md`](./2026-03-25-weacpx-acpx-bridge-design.md) |
| Orchestration | `src/orchestration/` | [`docs/2026-04-13-weacpx-orchestration-design.md`](./2026-04-13-weacpx-orchestration-design.md) |
| External MCP integration | `src/mcp/` | [external-mcp.md](./external-mcp.md) |
| Channel management | `src/channels/` | [channel-management.md](./channel-management.md) |
| Channel plugin SPI | `src/plugin-api.ts`, `src/plugins/` | [plugin-development.md](./plugin-development.md) |
| Config | `src/config/` | [config-reference.md](./config-reference.md), [config-command.md](./config-command.md) |
| Testing | `tests/`, `scripts/run-tests*` | [testing.md](./testing.md) |
| Releasing | `scripts/verify-publish.mjs` | [Releases section](#releases) |

---

## acpx / SDK / Plugin Resolution Order

### acpx

`src/config/resolve-acpx-command.ts:resolveAcpxCommand`:

1. `transport.command` (explicit config override)
2. **bundled** acpx: resolved from the main package's `node_modules/acpx/...` (by default `dependencies` already declares `acpx@^0.6.1`)
3. Shell `PATH`

### weixin SDK

`src/weixin-sdk.ts:loadWeixinSdk`:

1. `WEACPX_WEIXIN_SDK` environment variable
2. The installed package `weixin-agent-sdk`

### Plugin home

`src/plugins/plugin-home.ts:resolvePluginHome`:

1. `WEACPX_PLUGIN_HOME` environment variable
2. Default `~/.xacpx/plugins/` (a standalone `package.json`, isolated from the global / project `node_modules`)

Package manager auto-detection: if `bun --version` runs, use `bun add/remove`; otherwise fall back to `npm install/uninstall` (`src/plugins/package-manager.ts`).

---

## Config and Runtime Files

By default everything is under `~/.xacpx/`:

| Path | Contents | Writer |
| --- | --- | --- |
| `~/.xacpx/config.json` | Static config: agents, workspaces, channels, plugins, transport, etc. | `ConfigStore`, CLI |
| `~/.xacpx/state.json` | sessions, chat_contexts, orchestration state | `DebouncedStateStore` (50ms coalescing) → `StateStore` |
| `~/.xacpx/runtime/daemon.pid` | Current daemon PID | `DaemonRuntime` |
| `~/.xacpx/runtime/status.json` | daemon heartbeat / start_at / log paths | Same as above |
| `~/.xacpx/runtime/app.log` | bounded application log (rotated) | `AppLogger` |
| `~/.xacpx/runtime/orchestration.sock` | Unix socket / `\\.\pipe\xacpx-orchestration-<hash>` | `OrchestrationServer` |
| `~/.xacpx/plugins/` | Plugin npm home (standalone `package.json` + `node_modules`) | `xacpx plugin add/update` |

Field details: [docs/config-reference.md](./config-reference.md).

---

## Code Style and Conventions

The hard constraints are in `AGENTS.md` (`CLAUDE.md` is a symlink to it). Highlights:

- **First principles**: start from the raw requirement, don't copy templates; if the goal is unclear, stop and align first.
- **TypeScript strict mode**: `strict: true`; don't let `any` slide; types are documentation.
- **Don't write useless comments**: unless explaining *WHY* (implicit constraints, past incidents, deliberately avoided approaches). Delete comments that explain WHAT.
- **Don't add `try/catch` / fallbacks for scenarios that can't happen**: trust the types at internal boundaries; only validate at system boundaries (user input, external APIs).
- **Tests first**: a bug fix must include a failing test → fix → test turns green. Changing code without writing tests counts as unfinished.
- **Channels**: only `weixin` is built in; non-weixin channels **must** be plugin packages, and writing a product-specific channel runtime in `src/channels/` is categorically not accepted.
- **Avoid breaking changes**: `xacpx/plugin-api` is a public type; change it carefully, and bump `XACPX_PLUGIN_API_VERSION` when necessary.

---

## Finding the Entry Point by Scenario

Newcomers most often get stuck on "I want to add X, where do I start." This table covers the most common scenarios:

| What You Want to Do | Look Here / Change Here |
| --- | --- |
| Add a new slash command | Add a token in `src/commands/parse-command.ts`; add a handler in `src/commands/handlers/`; register in `src/commands/command-router.ts`; mirror tests to `tests/unit/commands/` |
| Change a command's reply format | The render functions in `src/formatting/`; the command calls the corresponding render in the router |
| Add a new channel (Feishu/Slack/Discord …) | **Don't** change `src/channels/`; see [docs/plugin-development.md](./plugin-development.md), start a new package under `packages/channel-<type>/` |
| Change how acpx is invoked (CLI args, PTY, timeout) | `src/transport/acpx-cli/` or `src/transport/acpx-bridge/`, keeping the `SessionTransport` interface stable |
| Add / change an orchestration capability | `src/orchestration/orchestration-service.ts` + `orchestration-ipc.ts` + `orchestration-server.ts`; tests in `tests/unit/orchestration/` |
| Change daemon start/stop behavior | `src/daemon/`; if you change status fields, also update `daemon-status.ts` and the docs |
| Change `xacpx doctor` | `src/doctor/index.ts` and the individual probes |
| Change the tools exposed by `xacpx mcp-stdio` | `src/mcp/xacpx-mcp-tools.ts` |
| Change the `state.json` schema | The parsing in `src/state/types.ts` + `state-store.ts`; consider migration |
| Add a recoverable runtime error | `src/recovery/`; wire it into the corresponding command in the router |
| Add / change a global public type | Re-export in `src/plugin-api.ts` + `bun run build:plugin-api` |
| Fix the test runner | `scripts/run-tests-lib.mjs` (`buildTestPlan`) |
| Add a pre-publish preflight | `scripts/verify-publish.mjs` |

---

## Plan / Spec Writing Workflow

`docs/superpowers/specs/` and `docs/superpowers/plans/` are a non-mandatory but **strongly recommended** workflow:

- **spec** (design doc): explains "what I want to solve / why I'm doing it this way / alternatives."
  Write one before working on complex code, named `YYYY-MM-DD-<topic>-design.md`.
- **plan** (implementation plan): breaks the spec into steps that an agent / yourself can execute one by one, named `YYYY-MM-DD-<topic>.md`.

These two are usually part of the same merge in historical PRs, which makes later archaeology easier.

---

## Commits, PRs, and Releases

### Commits

- Commit messages follow the conventional commits style (`fix:`, `feat:`, `docs:`, `chore:`, `test:`).
- One commit focuses on one thing; the smaller the diff, the easier to review.
- Try to keep test and code changes in the same commit.

### PRs

- Keep the PR title concise (< 70 chars), and in the description write:
  - Why the change (link the issue / spec)
  - How it changes
  - How it's verified (manual / automated tests)
- For changes that affect daemon behavior (channel, transport, orchestration, state), it's recommended to attach a dry-run script as evidence.

### Releases

Release flow (one-liner version):

```bash
bun run verify:publish      # build:packages + scripts/verify-publish.mjs
bun run publish:xacpx
bun run publish:plugins     # When bumping first-party plugin packages
```

Remember when releasing:

- Bump `package.json` `version`; if you changed a first-party plugin, also bump the corresponding `packages/*/package.json`.
- Add release notes under `docs/releases/`.
- Create a git tag.

---

## Further Reading

- User perspective: [README.md](../README.md)
- Full command reference: [commands.md](./commands.md)
- Channel management: [channel-management.md](./channel-management.md)
- Plugin development: [plugin-development.md](./plugin-development.md)
- Config fields: [config-reference.md](./config-reference.md)
- Code map: [code-wiki.md](./code-wiki.md)
- Testing conventions: [testing.md](./testing.md)
- Release process: [Releases section](#releases)
- Multi-agent orchestration principles: [`2026-04-13-weacpx-orchestration-design.md`](./2026-04-13-weacpx-orchestration-design.md)
- Acpx-Bridge protocol: [`2026-03-25-weacpx-acpx-bridge-design.md`](./2026-03-25-weacpx-acpx-bridge-design.md)
- Project conventions (`AGENTS.md` / `CLAUDE.md`): [../AGENTS.md](../AGENTS.md)
