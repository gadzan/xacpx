# Testing Guide

## Goal

Keep the test directory and execution entry points clear, stable, and maintainable.

Core production code goes in `src/`, and core tests go in `tests/`; don't scatter test files around source directories. The relay-web package has one explicit Vitest exception documented below.

## Directory Conventions

### `tests/unit/`

The default unit test directory.

Rules:

- The directory structure should mirror `src/` as much as possible
- By default, all stable, repeatable tests with no external-environment dependencies go here
- Both `npm test` and `npm run test:unit` run this directory

### `tests/integration/`

Reserved for tests that are genuinely cross-module and cross-boundary.

Only use this directory when a test clearly depends on multiple modules collaborating and is no longer suitable to keep in `tests/unit/`.

This repository does not yet enforce its use.

### `tests/smoke/`

Holds real-environment smoke test scripts or validations that need external dependencies:

- Real `acpx`
- Real bridge
- Real WeChat runtime path

These tests should not enter the default `npm test`, to avoid local or CI instability caused by environment differences.

### `tests/helpers/`

Holds test helper functions, fixture builders, and test-only utilities.

For now, if a helper is very small, you can inline it in the test file first; only extract it when reuse becomes obvious.

### `packages/relay-web/src/__tests__/` (package exception)

Relay-web component/store tests live beside that package under `src/__tests__/` because they require
Vite's Vue transform and the package's jsdom/Vitest setup. Run them with:

```bash
bun run --cwd packages/relay-web test
```

The root `npm test` includes this suite through `test:web`. This is the only supported test-under-`src`
exception; Node/core/package tests continue to live under `tests/unit/`.

## Default Commands

### Full Default Unit Tests

```bash
npm test
```

Equivalent to:

```bash
npx tsc --noEmit
node ./scripts/run-tests.mjs
```

By default it first runs the TypeScript type check, then recursively runs `tests/unit/**/*.test.ts`.

### Explicitly Run Unit Tests

```bash
npm run test:unit
```

This also first runs:

```bash
npx tsc --noEmit
```

### Build Verification

```bash
bun run build
```

## Rules When Adding New Tests

1. New tests go in `tests/unit/` by default; relay-web Vue/jsdom tests use its documented package exception
2. The directory structure should mirror `src/` as much as possible
3. Keep test file names as `*.test.ts`
4. Avoid leaving temporary troubleshooting scripts at the repository root
5. Don't stuff validations that need a real environment into the default test suite

## When to Put It in smoke

Prefer `tests/smoke/` over `tests/unit/` in the following cases:

- Needs a real `acpx` session
- Needs real `~/.acpx` state writes
- Needs a real WeChat login
- Needs external network, GUI, QR code scanning, or a local agent runtime environment

## Rules After the Migration

- `src/` holds production code only, except `packages/relay-web/src/__tests__/` as documented above
- `tests/` holds test code only
- `scripts/` holds run scripts only, not test bodies

If you need to add a new test type in the future, prefer adding a subdirectory under `tests/` rather than stuffing tests back into `src/`.

## Session Creation Experience (Smoke)

### Self-Healing for Missing Platform Packages

Reproduction:
1. Delete `node_modules/opencode-windows-x64` under the opencode install directory.
2. In WeChat, run `/ss opencode --ws weacpx`.
3. Expected message sequence:
   - 🚀 Starting `opencode`…
   - 📦 Detected missing dependency `opencode-windows-x64`, auto-installing…
   - 🔄 Installation complete, verifying session startup…
   - 🚀 Starting `opencode`… (fresh progress for the verification phase, timing restarts from 0)
   - 🔧 `opencode` initializing… (waited Ns) (only when it takes a long time)
   - ✅ Session created: ...

### Self-Healing Failure

Two kinds of failure:

- **npm installation failure** (no network, permissions, etc.): all N installations — automatically attempting the precise ones (once per candidate parent-package path, covering Bun/npm/pnpm/yarn global and local node_modules) and the global one — exit non-zero. The final message title is `❌ Auto-install failed`, listing the stderr summary of each attempt (precise steps annotate the specific path), the manual command `npm install -g <pkg>`, and the log path.
- **Installation succeeds but verification still fails** (the precise install landed in the wrong dependency tree, the resource has already been cached by acpx): the install exits 0 but re-running ensureSession still throws a missing dependency. The final message title is `⚠️ Auto-install was performed but failed to fix the session startup problem`, where each step shows "install performed but verification failed (precise / <path> | global)", and likewise attaches the manual command and the log path.
- **Cross-package-manager discovery**: before auto-installing, weacpx enumerates the candidate parent-package directories — the seed reported by the Bridge, the local node_modules visible to `require.resolve`, `$BUN_INSTALL`/`~/.bun/install/global/node_modules`, and `npm root -g` / `pnpm root -g` / `yarn global dir`. Directories that contain a `package.json` are used in turn as "precise" install steps.

### Progress Feedback Only

In the error-free scenario, `/ss <agent>`:
- < 3s: you only see 🚀 Starting
- ≥ 3s: after 🚀 you also see 🔧 Initializing… (waited Ns)
