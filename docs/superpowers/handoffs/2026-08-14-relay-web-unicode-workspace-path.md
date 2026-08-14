# Handoff: Relay Web new-workspace path fails for Unicode-only basenames

> **Date:** 2026-08-14
> **Status:** Investigation complete; implementation not started.
> **Scope:** `packages/relay-web` only unless new evidence shows otherwise.

## Problem

Relay Web's **New Session → New path** flow fails when the filesystem path's final segment contains no ASCII letters/digits, e.g. a Windows path such as:

```text
D:\研发项目\测试工程
```

Paths containing spaces are not the problem. A path such as:

```text
D:\work\Repo One
```

already derives `repo-one` and is covered by tests.

The direct **Manage instance → Workspaces → Add workspace** flow can already pass Unicode/space-containing paths through unchanged, because it takes an explicit workspace name and does not derive the name from the path.

## Confirmed root cause

The failure is entirely in Relay Web's path-to-workspace-name helper:

- `packages/relay-web/src/lib/session-form.ts`
  - `workspaceNameFromPath()` extracts the final path segment.
  - It then calls `slugify()`.
  - `slugify()` intentionally collapses everything outside `[a-z0-9]`.

Therefore:

```text
D:\研发项目\测试工程
basename = 测试工程
slugify(...) = ""
```

`packages/relay-web/src/components/NewSessionDialog.vue` treats an empty derived workspace name as invalid and aborts before `createWorkspace()`.

Existing tests confirm the current ASCII policy:

- `packages/relay-web/src/__tests__/session-form.test.ts`
- `packages/relay-web/src/__tests__/newsessiondialog.test.ts`

The latter also intentionally rejects an all-symbols path such as `@@@` before any agent/workspace/session side effects.

## What is *not* broken

### Windows paths with spaces

No quoting fix is needed.

The core transport builds `acpx` arguments as a structured argv array:

```ts
["--cwd", input.cwd, ...]
```

and session creation ultimately uses Node process spawning with `cwd` as a separate option/argument. A value such as `D:\My Projects\Repo One` is therefore not split on spaces.

Relevant files:

- `src/transport/acpx-command-builder.ts`
- `src/bridge/bridge-runtime.ts`
- `src/transport/acpx-cli/acpx-cli-transport.ts`

Do **not** add shell quotes around the path. Quotation marks would become literal path characters in this flow.

### Unicode path persistence / normalization

The backend workspace-create RPC accepts the path as a string and `ConfigStore.upsertWorkspace()` persists it as JSON. Config parsing normalizes Windows syntax with `path.win32.normalize()` and converts separators to `/`; it does not strip Unicode or spaces.

Relevant files:

- `packages/relay-web/src/stores/instances.ts`
- `packages/channel-relay/src/control-bridge.ts`
- `src/config/config-store.ts`
- `src/config/load-config.ts`
- `src/commands/workspace-path.ts`
- `src/util/path.ts`

No backend/protocol/config change is expected for this bug.

## Important design constraint

Do **not** solve this by making the shared `slugify()` Unicode-preserving without first redesigning the alias contract.

The approved Relay Session-Create design explicitly chose `[a-z0-9-]` as the safe charset for generated session aliases, and `genAlias()` uses the same `slugify()` helper. Allowing arbitrary Unicode through the shared helper would therefore change session alias semantics, not just workspace path handling.

Authoritative design reference:

- `docs/superpowers/specs/2026-06-14-relay-session-create-redesign-design.md`

This bug should be fixed narrowly while preserving the existing ASCII alias behavior.

## Recommended fix

Keep `slugify()` and `genAlias()` unchanged.

Change only `workspaceNameFromPath()` so it distinguishes these two cases when the ASCII slug is empty:

1. basename contains Unicode letters/numbers (Chinese, Japanese, Korean, Cyrillic, Arabic, accented-only text, full-width digits, etc.) → return a safe ASCII fallback base such as `workspace`;
2. basename contains no letters/numbers at all (e.g. `@@@`) → keep returning `""` so the existing invalid/all-symbols guard remains intact.

A minimal shape is:

```ts
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;

export function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).pop() ?? "";
  const slug = slugify(segment);
  if (slug) return slug;
  return UNICODE_ALNUM_RE.test(segment) ? "workspace" : "";
}
```

The exact constant name is unimportant; preserve the behavior above.

Why `workspace` rather than passing Unicode through:

- preserves the existing safe ASCII workspace-name convention from the approved design;
- keeps `genAlias(workspaceName, agent)` safely ASCII;
- avoids adding transliteration dependencies or locale-specific rules;
- works with the existing `uniqueName()` de-duplication already used by `NewSessionDialog`.

Examples after the fix:

| Input path | Derived workspace base | Notes |
|---|---|---|
| `/tmp/demo-project` | `demo-project` | unchanged |
| `/Users/me/My App/` | `my-app` | unchanged |
| `C:\work\Repo One` | `repo-one` | unchanged; spaces supported |
| `C:\项目\Repo 中文` | `repo` | unchanged mixed-ASCII behavior |
| `D:\研发项目\测试工程` | `workspace` | fixed |
| `D:\研发 项目\测试 工程` | `workspace` | fixed; Unicode + spaces |
| `@@@` | `""` | intentionally remains invalid |

If `workspace` already exists, the dialog's existing `uniqueName()` logic should produce `workspace-2`, `workspace-3`, etc. The generated session alias then naturally becomes `workspace-codex`, `workspace-2-codex`, etc.

## Required tests

### 1. Helper tests — `packages/relay-web/src/__tests__/session-form.test.ts`

Add focused cases for `workspaceNameFromPath()`:

- Windows Unicode-only basename:
  - `C:\项目\测试工程` → `workspace`
- Unicode-only basename containing spaces:
  - `C:\项目 文件\测试 工程` → `workspace`
- mixed Latin + Chinese remains current behavior:
  - `C:\项目\Repo 中文` → `repo`
- all-symbols remains rejected:
  - `@@@` → `""`
- retain the existing `C:\work\Repo One` → `repo-one` regression test.

### 2. Dialog integration — `packages/relay-web/src/__tests__/newsessiondialog.test.ts`

Add a New-path test using a realistic Windows Unicode + spaces path, e.g.:

```text
D:\研发 项目\测试 工程
```

Assert:

- `createWorkspace("i1", "workspace", exactInputPath)` is called;
- no quotes are added around the path;
- `beginSessionCreation(...)` receives workspace `workspace` and generated alias `workspace-codex`.

Also add a de-dup case if practical:

- existing workspaces include `workspace` and `workspace-2`;
- Unicode-only path derives `workspace-3`;
- alias derives `workspace-3-codex`.

Keep the existing all-symbols tests green: `@@@` must still create neither agent, workspace, nor session.

### 3. Optional manager regression

`packages/relay-web/src/__tests__/managers.test.ts` can add one small test proving the direct workspace manager passes a Unicode/space path unchanged. This is not required for the code fix, but it documents the already-supported path behavior and prevents a future UI regression.

## Files expected to change

Primary:

- `packages/relay-web/src/lib/session-form.ts`
- `packages/relay-web/src/__tests__/session-form.test.ts`
- `packages/relay-web/src/__tests__/newsessiondialog.test.ts`

Optional:

- `packages/relay-web/src/__tests__/managers.test.ts`

No expected changes to protocol, channel-relay, core config, path normalization, or transport spawning.

## Acceptance criteria

The fix is done when all of the following hold:

1. New Session → New path accepts `D:\研发项目\测试工程`.
2. It creates a safe ASCII workspace name (`workspace`, de-duped when necessary).
3. Windows paths containing spaces are passed unchanged as one path value.
4. Existing Latin/ASCII-derived workspace names do not change.
5. `@@@` and equivalent all-symbol basenames remain rejected before side effects.
6. Generated session aliases remain within the existing ASCII-safe behavior.
7. No backend/protocol changes are introduced without evidence they are required.

## Validation

Focused tests first:

```bash
npm --prefix packages/relay-web test -- src/__tests__/session-form.test.ts src/__tests__/newsessiondialog.test.ts
```

Then Relay Web suite + build:

```bash
npm --prefix packages/relay-web test
npm --prefix packages/relay-web run build
```

If the change unexpectedly touches core/shared code, additionally run the relevant root typecheck/tests; a narrow implementation should not require core modifications.

## Out of scope

- Unicode-preserving session aliases.
- Transliteration of Chinese/Japanese/etc. into Latin text.
- Renaming existing workspaces.
- Changing the workspace-name convention globally.
- Shell quoting changes.
- Backend filesystem existence validation.

If product requirements later demand human-readable Unicode workspace names, treat that as a separate design change because workspace names feed alias generation and multiple command/config surfaces.
