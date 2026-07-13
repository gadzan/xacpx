# Bridge-Runtime Command-Builder Extraction — Design Spec

**Date:** 2026-07-12
**Track:** 2026-07 architecture audit, Track 3 (core maintainability), block 4 / final.
**Branch:** `refactor/bridge-runtime-command-builder` @ base `origin/main` (`c1703cf`).
**Methodology:** behaviour-equivalent refactor guaranteed by black-box golden characterization oracles, same as the orchestration-service / control-service / command-router splits that preceded it.

## Goal

Extract the `this`-free argv-building and predicate logic that is duplicated between
`src/transport/acpx-cli/acpx-cli-transport.ts` (942 lines) and
`src/bridge/bridge-runtime.ts` (1093 lines) into one pure module. **Zero behaviour
change.** Both transports keep their exact current command surface; the win is a single
source of truth for the argv shape and the death of the "defaults in two places" trap.

## Non-Goals (explicit scope boundary)

The audit backlog loosely described "20+ same-named methods". Most of those are NOT
safe duplication to unify — unifying them would be a behaviour change, out of scope:

- **Transport interface methods** (`ensureSession`, `prompt`, `cancel`, `setMode`,
  `setModel`, `getSessionModel`, `hasSession`, `deleteSession`, `removeSession`,
  `freeWarmProcess`, `resumeAgentSession`, `tailSessionHistory`, `getAgentSessionId`)
  stay per-transport. They wrap genuinely different I/O plumbing.
- **The spawn/run runners** stay per-transport: CLI uses `node-pty` + `child_process`
  with a plain-Error timeout; bridge uses `child_process` inside the bridge subprocess
  with a `CommandTimeoutError` type. Different error types = different behaviour.
- **`parseStreamingDataChunk`** is already a shared import (`transport/streaming-prompt`).
  The surrounding streaming loop differs (PTY vs spawn) and is left untouched.
- **No attempt to make CLI output == bridge output.** The two intentionally diverge
  (bridge emits `--verbose` and keys on `input.name`; CLI keys on
  `session.transportSession`). Equivalence is proven strictly **per-side**.

## What Gets Extracted

A new pure module **`src/transport/acpx-command-builder.ts`** — no `this`, no I/O, no
class. Every function takes already-resolved values and returns a `string[]` (or a
parse result). Exact exports:

```ts
import type { NonInteractivePermissions, PermissionMode } from "../config/types";

// Single source of truth for the permission defaults that today live in two places
// (CLI constructor literals vs bridge use-site `?? "approve-all"`). Both callers
// reference these so a future default change is a one-line edit.
export const DEFAULT_PERMISSION_MODE: PermissionMode = "approve-all";
export const DEFAULT_NON_INTERACTIVE: NonInteractivePermissions = "deny";

export interface PermissionArgsInput {
  permissionMode: PermissionMode;              // already resolved (no ?? inside builder)
  nonInteractivePermissions: NonInteractivePermissions;
  permissionPolicy?: string;
}
export function buildPermissionArgs(input: PermissionArgsInput): string[];

export function buildQueueOwnerTtlArgs(queueOwnerTtlSeconds: number | undefined): string[];

export function buildModelArgs(model: string | undefined): string[];

export interface SessionArgsInput {
  agent: string;
  agentCommand?: string;
  cwd: string;
  model?: string;
  permission: PermissionArgsInput;
}

// The superset session-args shape. CLI calls with { format: "quiet" } and never
// passes verbose; bridge passes what it passes today (format defaults "quiet",
// verbose per-call). model is appended only when present.
export function buildSessionArgs(
  input: SessionArgsInput,
  tail: string[],
  options?: { verbose?: boolean; format?: "quiet" | "json" },
): string[];

export function buildPromptArgs(
  input: SessionArgsInput & { queueOwnerTtlSeconds: number | undefined },
  tail: string[],
): string[];

// Listing never carries a model. Distinct from buildSessionArgs so the CLI query
// path (which has no model field at all) is preserved verbatim. Internally may
// delegate to buildSessionArgs with model omitted — output must be identical.
export function buildAgentQueryArgs(
  input: { agent: string; agentCommand?: string; cwd: string; permission: PermissionArgsInput },
  format: "json" | "quiet",
  tail: string[],
): string[];

// Byte-identical today on both sides (5-term lowercase substring list).
export function isMissingAcpxSessionError(stderr: string, stdout: string): boolean;

// The `sessions show` id parse: JSON path (acpxRecordId → id) with a first-line
// fallback on JSON.parse throw, both guarded by /^[\w.:-]+$/ && length >= 8.
// Returns undefined on failure; EACH CALLER keeps its own throw so the two
// divergent error messages ("failed to resolve acpx session record id" is shared,
// but the code!==0 messages differ) are preserved.
export function parseAcpxSessionRecordId(
  stdout: string,
): { acpxRecordId: string; agentSessionId?: string } | undefined;
```

### Call-site adaptation (behaviour-preserving)

- **CLI** already resolves permission defaults in its constructor
  (`this.permissionMode = options.permissionMode ?? "approve-all"`). It keeps doing so,
  but the literal `"approve-all"` / `"deny"` become `DEFAULT_PERMISSION_MODE` /
  `DEFAULT_NON_INTERACTIVE` (output-identical string). Its private `buildArgs`,
  `buildAgentQueryArgs`, `buildPromptArgs`, `buildModelArgs`, `buildQueueOwnerTtlArgs`,
  `buildPermissionArgs` become thin adapters that construct the neutral input from
  `ResolvedSession` and delegate to the shared module. The free functions
  `isMissingAcpxSessionError` and the id-parse block inside `readSessionRecord`
  delegate too.
- **Bridge** resolves permission defaults at its call site today
  (`this.options.permissionMode ?? DEFAULT_PERMISSION_MODE`). Its private
  `buildSessionArgs`, `buildPromptArgs`, `buildQueueOwnerTtlArgs`, `buildPermissionArgs`,
  the free `modelArgs`, the free `isMissingBridgeSessionError`, and the id-parse block
  inside its `readSessionRecord` all delegate to the shared module. `buildSessionArgs`'s
  `{ verbose, format }` options pass through unchanged.

Neither transport changes its public API. `main.ts`, `bridge-server.ts`, and every
existing consumer stay untouched. No new value-import cycle is introduced (the shared
module imports only `config/types` and the shared `permission-mode-flag` helper; the
transports import the shared module — a DAG).

## Equivalence Oracle

Because the extraction target is pure functions returning `string[]`, the oracle is
**argv capture through public methods** — end-to-end, so it also pins how the builders
are *composed*, not merely their isolated outputs.

### Mechanism

Both transports already expose injectable seams:

- CLI: `runCommand: CommandRunner` (constructor arg 2) for management commands; the
  prompt path uses `streamingHooks.spawnPrompt`. The harness injects a **recording
  runner** and a **recording spawnPrompt** that append `(command, argv, timeoutMs?)`
  to one ordered log, then return a scenario-controlled `CommandResult` / fake stream.
- Bridge: `run: CommandRunner` (constructor arg 2) for management commands;
  `runPromptCommand: PromptRunner` for the prompt path; `runSessionCreate` for the
  create path. The harness injects recording versions of each.

The recorded value is the **raw argv the transport hands its seam** plus the call
outcome (returned value shape / thrown message, both scrubbed of nondeterminism). The
management runner receives raw builder output; the prompt seam receives the
post-`resolveSpawnCommand` argv — either form is a valid characterization because
`resolveSpawnCommand` is shared and unchanged, so byte-identical before==after holds
regardless.

### Two fixture sets, per-side baselines

CLI and bridge argv differ by design, so each gets its own harness + fixture set,
each recorded on the **pre-extraction** commit (Task 0 records against today's
duplicated code; the extraction tasks must keep the fixtures byte-identical). The
equivalence claim is:

> CLI-after == CLI-before  **AND**  bridge-after == bridge-before

never CLI == bridge.

### Scenario matrix (per side)

Each public method is driven under the axes that flow into the builders:

- **agent vs agentCommand** (the `--agent <cmd>` branch vs bare `<agent>`).
- **model set vs unset** (`--model` present/absent).
- **queueOwnerTtlSeconds set vs unset** (`--ttl` present/absent) — prompt path.
- **permissionPolicy set vs unset** (`--permission-policy` present/absent).
- **nonInteractivePermissions default vs custom**, **permissionMode variants**.
- **verbose probe** (bridge `ensureSession` first tries `--verbose`, falls back on
  "unknown verbose option") — bridge-only axis, both branches covered.
- **prompt with promptFile (media) vs plain text**.
- **format quiet vs json** (management vs prompt/list).

The predicates are pinned indirectly, with runner stubs returning crafted output:

- `parseAcpxSessionRecordId` — stub `sessions show` to return each parse shape.
  (a) JSON with `acpxRecordId` and (c) a bare id line (JSON.parse throws → first-line
  fallback) are driven via **`deleteSession`**, pinning the subsequent `sessions close`
  argv. (b) JSON with only `id` and (d) malformed/short are driven via
  **`getAgentSessionId`**, NOT `deleteSession`: `deleteSession` swallows the parse-failure
  throw, and — because the resolved id only feeds an unrecorded file delete — its argv is
  byte-identical whether the id came from `id` or `acpxRecordId`, so it cannot pin those
  two shapes. `getAgentSessionId` returns the record's `agentSessionId` (observably
  distinct outcome for the `id` fallback) and surfaces the throw for the malformed case.
- `isMissingAcpxSessionError` via **`removeSession`** — stub to return a
  "no named session" stderr and assert the method swallows (no throw), vs a real
  non-missing error that propagates. This golden scenario pins the **delegation** (that
  `removeSession` routes a missing-session error to swallow and any other error to
  propagate), with one representative string per branch. The predicate's full five-marker
  truth table is exhaustively mutation-guarded by the **module unit test**
  (`acpx-command-builder.test.ts` "matches the 5 markers"): deleting ANY single term
  reddens that test. Because the predicate is a pure shared function, its per-term guard
  belongs at the unit level — re-testing all five strings through the transport
  delegation would be redundant, since every one routes to the same swallow.

Every recorded scenario also captures the method's **return value or thrown message**,
scrubbed (timestamps, generated ids) exactly as the prior blocks' harnesses did.

### Mutation verification

Every builder branch and predicate term must be shown to redden at least one test:
flip a `--verbose`, drop a permission term, corrupt an id-guard, swap a default — grep-
confirm the mutation applied, run, confirm ≥1 fixture/test drifts, revert. A branch that
no mutation can redden is an untested branch and needs a scenario.

**Layering** — the guard for a given branch lives at the layer that owns it. The golden
oracles guard the transports' *composed* argv and their *delegation* (which method calls
which builder/predicate, and how it routes the result). The pure shared module's own
internal branches — each `isMissingAcpxSessionError` marker, the `parseAcpxSessionRecordId`
guards, each builder's agent/verbose/format branch — are mutation-guarded by the direct
module unit test `acpx-command-builder.test.ts`. A predicate term that reddens the module
unit test (rather than a golden fixture) fully satisfies this requirement: routing all
five missing-session strings through the transport delegation would be redundant ceremony,
since the delegation itself is already pinned by the `remove-session-missing` (swallow)
and `remove-session-real-error` (propagate) golden scenarios.

### Baseline cross-check

After extraction, check out the Task-0 commit in a detached worktree
(`ln -s <main>/node_modules <worktree>/node_modules` to satisfy deps), run the oracle
with `env -u GOLDEN_UPDATE`, and confirm the committed fixtures reproduce byte-identical
against pre-refactor code — proving they are faithful equivalence guards, not just
recordings of the post-refactor state.

## Task Decomposition (for the plan)

0. **Oracle** — two harnesses + two fixture sets, recorded on the duplicated baseline.
   Commit fixtures. This is the equivalence guard everything else leans on.
1. **Extract the shared module** `acpx-command-builder.ts` with all pure functions +
   default constants + unit tests for the module itself (direct input→argv assertions,
   complementing the end-to-end oracle).
2. **Rewire CLI** to delegate to the shared module; oracle byte-identical.
3. **Rewire bridge** to delegate to the shared module; oracle byte-identical.
4. **Cleanup** — remove the now-dead private builders / free functions on both sides,
   update `docs/` (transport + bridge module notes), baseline cross-check, final review.

Each task ends green with **every existing CLI/bridge test unchanged and passing** and
both oracle fixture sets byte-identical.

## Global Constraints

- **Zero behaviour change.** Existing `acpx-cli-transport` / `bridge-runtime` tests are
  not edited; all pass. Golden fixtures stay byte-identical after Task 0;
  `GOLDEN_UPDATE=1` is used only to record the Task-0 baseline.
- Public API preserved: `main.ts`, `bridge-server.ts`, `bridge-main.ts`, and all
  transport consumers are untouched.
- The shared module is pure: no `this`, no I/O, imports only `config/types` and the
  shared `permission-mode-flag` helper. No
  value-import back into either transport (no runtime cycle).
- Per-file `bun test` for verification (never whole-directory — state leak). `TZ=UTC`
  where a test asserts time-derived text.
- Reply in Chinese; any release notes / CHANGELOG in English.
