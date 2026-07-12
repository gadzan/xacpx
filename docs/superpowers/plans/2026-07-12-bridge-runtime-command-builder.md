# Bridge-Runtime Command-Builder Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the `this`-free argv-building and predicate logic duplicated between `src/transport/acpx-cli/acpx-cli-transport.ts` and `src/bridge/bridge-runtime.ts` into one pure module, with zero behaviour change proven by per-side argv-capture golden oracles.

**Architecture:** A new pure module `src/transport/acpx-command-builder.ts` exports argv builders (permission/ttl/model/session/prompt/query args), two predicates (`isMissingAcpxSessionError`, `parseAcpxSessionRecordId`), and shared default constants. Both transports keep their public API and their I/O plumbing; only their private builders/free-functions become thin adapters that construct a neutral input and delegate. Equivalence is proven per-side (CLI-after == CLI-before AND bridge-after == bridge-before) by recording the exact argv each transport hands its injected runner seams across an input matrix.

**Tech Stack:** TypeScript, Bun test runner, existing golden-oracle harness pattern (ordered record + scrubbing), the transports' existing constructor runner seams.

## Global Constraints

- **Zero behaviour change.** Existing `acpx-cli-transport` / `bridge-runtime` tests are NOT edited; all pass unchanged.
- Golden fixtures stay byte-identical after Task 0. `GOLDEN_UPDATE=1` is used ONLY to record the Task-0 baseline; never in later verification.
- Public API preserved: `main.ts`, `bridge-server.ts`, `bridge-main.ts`, and every transport consumer are untouched.
- Shared module is pure: no `this`, no I/O, imports only `../config/types`. No value-import back into either transport (no runtime cycle).
- Per-file `bun test <file>` for verification — never whole-directory (state leak). `TZ=UTC` where a test asserts time-derived text.
- Reply in Chinese; any release notes / CHANGELOG in English.
- Implementer subagents run NO git; the controller does all commits. File-mutating reviewers use `isolation:"worktree"`.

---

## File Structure

- **Create** `src/transport/acpx-command-builder.ts` — the pure shared module (Task 1).
- **Create** `tests/unit/transport/acpx-command-builder.test.ts` — direct input→argv unit tests for the module (Task 1).
- **Create** `tests/unit/transport/golden/cli-argv-oracle-harness.ts` — drives `AcpxCliTransport` with recording seams (Task 0).
- **Create** `tests/unit/transport/golden/cli-argv-oracle.test.ts` — CLI scenarios (Task 0).
- **Create** `tests/unit/transport/golden/bridge-argv-oracle-harness.ts` — drives `BridgeRuntime` with recording seams (Task 0).
- **Create** `tests/unit/transport/golden/bridge-argv-oracle.test.ts` — bridge scenarios (Task 0).
- **Create** `tests/unit/transport/golden/fixtures/cli/*.json` and `.../fixtures/bridge/*.json` — recorded argv logs (Task 0).
- **Modify** `src/transport/acpx-cli/acpx-cli-transport.ts` — private builders + free fns delegate (Task 2), dead code removed (Task 4).
- **Modify** `src/bridge/bridge-runtime.ts` — private builders + free fns delegate (Task 3), dead code removed (Task 4).
- **Modify** `docs/relay-module.md` is NOT touched; **Modify** transport/bridge module docs if present (Task 4 — check `docs/code-wiki.md` and any `docs/*bridge*`/`docs/*transport*`).

---

## Task 0: Dual argv-capture oracle (baseline)

**Files:**
- Create: `tests/unit/transport/golden/cli-argv-oracle-harness.ts`
- Create: `tests/unit/transport/golden/cli-argv-oracle.test.ts`
- Create: `tests/unit/transport/golden/bridge-argv-oracle-harness.ts`
- Create: `tests/unit/transport/golden/bridge-argv-oracle.test.ts`
- Create: `tests/unit/transport/golden/fixtures/cli/*.json`, `tests/unit/transport/golden/fixtures/bridge/*.json`

**Interfaces:**
- Produces: `runCliArgvOracle(scenario)` and `runBridgeArgvOracle(scenario)`, each returning `{ record: string[]; outcome: unknown }`. These record every argv handed to the transport's runner seams, in call order, plus the driven method's return/throw. Consumed only by the two oracle test files.

**Recording model (both harnesses):** one ordered `string[]`. Each injected runner seam, when called, appends `seam(command, [arg, arg, …], timeoutMs?)` with each arg rendered verbatim (argv is behaviourally load-bearing — do NOT collapse it). Scrub nondeterminism exactly like the command-router harness did: ISO timestamps → `<ts>`, `reset-<epoch>` → `reset-<n>` (defensive; the transports don't emit it but the scrub is cheap insurance), and any absolute path that varies by machine is NOT expected here (cwd is supplied by the scenario as a fixed literal like `/tmp/backend`). The driven method's outcome is captured as `{ ok: <returnvalue> }` or `{ threw: <message> }`, JSON-normalized.

**CLI seams to inject** (constructor `new AcpxCliTransport(options, runCommand, runPtyCommand, queueOwnerLauncher, streamingHooks)`):
- arg 2 `runCommand` — recording runner returning a scenario-controlled `CommandResult`.
- arg 3 `runPtyCommand` — recording runner (used by `ensureSession` when `session.agentCommand` is set).
- arg 4 `queueOwnerLauncher` — `{ launch: async () => {} }` stub (no-op; not part of argv).
- arg 5 `streamingHooks` — `{ spawnPrompt: <recording fake stream> }` so `prompt` argv is captured without a real child process. The fake stream must emit a `close`/exit with the scenario's stdout so `prompt` resolves.

**Bridge seams to inject** (constructor `new BridgeRuntime(command, run, runSessionCreate, options, runPromptCommand, repairSessionIndex, queueOwnerLauncher)`):
- arg 2 `run` — recording runner.
- arg 3 `runSessionCreate` — recording runner (session create path).
- arg 5 `runPromptCommand` — recording runner (prompt path).
- arg 6 `repairSessionIndex` — `async () => false` stub.
- arg 7 `queueOwnerLauncher` — `{ launch: async () => {} }` stub.

**Scenario shape:**
```ts
export interface ArgvOracleScenario {
  name: string;
  options?: Partial</* transport options */>;   // permissionMode, permissionPolicy, queueOwnerTtlSeconds, nonInteractivePermissions
  // Per-seam canned results keyed by an ordinal or a matcher on the command tail.
  // Simplest: a queue of CommandResults the recording runner shifts on each call.
  results?: Array<{ code: number; stdout: string; stderr: string }>;
  run: (transport: AcpxCliTransport | BridgeRuntime) => Promise<unknown>;
}
```
Use a simple FIFO `results` queue: each recording seam call shifts the next canned result (default `{ code: 0, stdout: "", stderr: "" }` when the queue is empty). This lets a scenario stage `sessions show` output for the id-parse path.

- [ ] **Step 1: Write the CLI harness** `cli-argv-oracle-harness.ts`

Build a recording runner factory and `runCliArgvOracle`. A neutral `ResolvedSession` seed helper produces sessions with fields `{ alias, agent, agentCommand?, cwd, transportSession, model? }` (import `ResolvedSession` from `../../../../src/transport/types`). Reuse the config test-support if one exists; otherwise construct options inline.

```ts
// Skeleton (fill method bodies):
import { AcpxCliTransport } from "../../../../src/transport/acpx-cli/acpx-cli-transport";
import type { ResolvedSession } from "../../../../src/transport/types";

function makeRecorder() { const record: string[] = []; return { record, push: (l: string) => record.push(l) }; }
function scrub(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>").replace(/reset-\d+/g, "reset-<n>");
}
function renderArgv(command: string, args: string[], timeoutMs?: number): string {
  const t = timeoutMs === undefined ? "" : ` @${timeoutMs}`;
  return `${command} ${args.map((a) => scrub(String(a))).join(" ")}${t}`;
}
```
The recording `runCommand`/`runPtyCommand` push `runCommand(${renderArgv(...)})` / `runPty(${renderArgv(...)})` and shift the next canned result. The recording `spawnPrompt` pushes `spawnPrompt(${renderArgv(...)})` and returns a minimal fake `PromptStreamProcess` that immediately emits the canned stdout then closes with code 0.

- [ ] **Step 2: Write the CLI scenarios** `cli-argv-oracle.test.ts`

One scenario per public method × axis. Each scenario calls `runCliArgvOracle`, and (GOLDEN_UPDATE-gated) compares `{ record, outcome }` to `fixtures/cli/<name>.json`. Cover at minimum:
- `ensure-agent` (bare agent, model unset), `ensure-agentcommand` (agentCommand set → PTY seam), `ensure-model` (model set → `--model`), `ensure-model-not-advertised` (first ensure throws model-not-advertised → retry without model; stage results so first call's canned result triggers the retry — verify the second argv drops `--model`).
- `prompt-text` (plain text, ttl unset), `prompt-ttl` (queueOwnerTtlSeconds set → `--ttl`), `prompt-agentcommand`, `prompt-media` (drive with a `PromptMediaInput` so the `--file` promptFile branch fires).
- `set-mode`, `set-model`, `get-session-model`, `cancel`, `resume-agent-session`.
- `list-native` (assert `--cwd`, `--filter-cwd` when filterCwd set, `--cursor` when cursor set; NO `--model`).
- `tail-history` (assert the tail candidates argv).
- `delete-session-json-record` (stage `sessions show` → JSON `{"acpxRecordId":"abcd1234"}`; assert the follow-up delete argv + return).
- `delete-session-bare-id` (stage `sessions show` → bare line `abcd1234` that fails JSON.parse → first-line fallback).
- `delete-session-malformed` (stage `sessions show` → `x` too short → method throws `failed to resolve acpx session record id`; assert `outcome.threw`).
- `remove-session-missing` (stage removeSession's command → stderr `no named session`; assert it swallows, no throw).
- `permission-policy` (options.permissionPolicy set → `--permission-policy` present in a driven method's argv), `permission-noninteractive` (custom nonInteractivePermissions).

- [ ] **Step 3: Record CLI baseline**

Run: `GOLDEN_UPDATE=1 TZ=UTC bun test tests/unit/transport/golden/cli-argv-oracle.test.ts`
Expected: fixtures written under `fixtures/cli/`. Then run WITHOUT `GOLDEN_UPDATE`:
Run: `TZ=UTC bun test tests/unit/transport/golden/cli-argv-oracle.test.ts`
Expected: PASS (0 drift).

- [ ] **Step 4: Write the bridge harness** `bridge-argv-oracle-harness.ts`

Mirror Step 1 for `BridgeRuntime` (constructor arg order above). The bridge public methods take structural inputs (`{ agent, agentCommand?, cwd, name, model? }`) not `ResolvedSession`. Provide a seed helper producing those. Recording seams: `run`, `runSessionCreate`, `runPromptCommand`.

- [ ] **Step 5: Write the bridge scenarios** `bridge-argv-oracle.test.ts`

Same method×axis matrix as CLI, PLUS the bridge-only verbose-probe axis:
- `ensure-verbose-supported` (first `sessions new --verbose` returns code 0 → `acpxVerboseSupported=true`).
- `ensure-verbose-unsupported` (first `--verbose` returns "unknown verbose option" → retry without `--verbose`; assert the second argv drops `--verbose`).
- All the same predicate/id-parse scenarios (`delete-session-*`, `remove-session-missing`) — bridge uses `isMissingBridgeSessionError` and its own `readSessionRecord` today.

- [ ] **Step 6: Record bridge baseline**

Run: `GOLDEN_UPDATE=1 TZ=UTC bun test tests/unit/transport/golden/bridge-argv-oracle.test.ts`
Then: `TZ=UTC bun test tests/unit/transport/golden/bridge-argv-oracle.test.ts`
Expected: PASS (0 drift).

- [ ] **Step 7: Mutation-verify the oracle catches builder drift**

Temporarily edit `acpx-cli-transport.ts` `buildPermissionArgs` to drop `--non-interactive-permissions`, run the CLI oracle (no GOLDEN_UPDATE), confirm ≥1 fixture drifts (FAIL). Revert. Repeat once on bridge (`buildSessionArgs` drop `--verbose`). This proves the fixtures are live guards before any real extraction. Do NOT commit the mutations.

- [ ] **Step 8: Commit**

```bash
git add tests/unit/transport/golden/
git commit -m "test(transport): add per-side argv-capture golden oracles for command-builder extraction"
```

---

## Task 1: Extract the pure command-builder module

**Files:**
- Create: `src/transport/acpx-command-builder.ts`
- Test: `tests/unit/transport/acpx-command-builder.test.ts`

**Interfaces:**
- Produces: the exact exports below. Tasks 2 and 3 consume them.

- [ ] **Step 1: Write the failing unit test** `tests/unit/transport/acpx-command-builder.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_MODE, DEFAULT_NON_INTERACTIVE,
  buildPermissionArgs, buildQueueOwnerTtlArgs, buildModelArgs,
  buildSessionArgs, buildPromptArgs, buildAgentQueryArgs,
  isMissingAcpxSessionError, parseAcpxSessionRecordId,
} from "../../../src/transport/acpx-command-builder";

const perm = { permissionMode: DEFAULT_PERMISSION_MODE, nonInteractivePermissions: DEFAULT_NON_INTERACTIVE };

describe("buildPermissionArgs", () => {
  test("defaults, no policy", () => {
    expect(buildPermissionArgs(perm)).toEqual(["--approve-all", "--non-interactive-permissions", "deny"]);
  });
  test("with policy appends --permission-policy", () => {
    expect(buildPermissionArgs({ ...perm, permissionPolicy: "p.json" }))
      .toEqual(["--approve-all", "--non-interactive-permissions", "deny", "--permission-policy", "p.json"]);
  });
});

describe("buildQueueOwnerTtlArgs", () => {
  test("number → --ttl", () => expect(buildQueueOwnerTtlArgs(1800)).toEqual(["--ttl", "1800"]));
  test("undefined → []", () => expect(buildQueueOwnerTtlArgs(undefined)).toEqual([]));
  test("NaN → []", () => expect(buildQueueOwnerTtlArgs(Number.NaN)).toEqual([]));
});

describe("buildModelArgs", () => {
  test("trimmed model", () => expect(buildModelArgs("  gpt-5.2  ")).toEqual(["--model", "gpt-5.2"]));
  test("empty/undefined → []", () => { expect(buildModelArgs("  ")).toEqual([]); expect(buildModelArgs(undefined)).toEqual([]); });
});

describe("buildSessionArgs", () => {
  test("bare agent, quiet default", () => {
    expect(buildSessionArgs({ agent: "codex", cwd: "/w", permission: perm }, ["sessions", "new"]))
      .toEqual(["--format", "quiet", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "codex", "sessions", "new"]);
  });
  test("agentCommand branch + model + verbose + json format", () => {
    expect(buildSessionArgs({ agent: "codex", agentCommand: "my-codex", cwd: "/w", model: "m", permission: perm }, ["x"], { verbose: true, format: "json" }))
      .toEqual(["--format", "json", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "--model", "m", "--verbose", "--agent", "my-codex", "x"]);
  });
});

describe("buildPromptArgs", () => {
  test("prefix carries model+ttl, agent branch", () => {
    expect(buildPromptArgs({ agent: "codex", cwd: "/w", model: "m", permission: perm, queueOwnerTtlSeconds: 900 }, ["prompt", "-s", "s", "hi"]))
      .toEqual(["--format", "json", "--json-strict", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "--model", "m", "--ttl", "900", "codex", "prompt", "-s", "s", "hi"]);
  });
});

describe("buildAgentQueryArgs", () => {
  test("never adds model", () => {
    expect(buildAgentQueryArgs({ agent: "codex", cwd: "/w", permission: perm }, "json", ["sessions", "list"]))
      .toEqual(["--format", "json", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "codex", "sessions", "list"]);
  });
});

describe("isMissingAcpxSessionError", () => {
  test("matches the 5 markers", () => {
    for (const m of ["no named session", "no cwd session", "session not found", "unknown session", "no acpx session found"])
      expect(isMissingAcpxSessionError(m.toUpperCase(), "")).toBe(true);
  });
  test("non-match", () => expect(isMissingAcpxSessionError("boom", "nope")).toBe(false));
});

describe("parseAcpxSessionRecordId", () => {
  test("json acpxRecordId + agentSessionId", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","agentSessionId":"z"}')).toEqual({ acpxRecordId: "abcd1234", agentSessionId: "z" }));
  test("json id fallback", () =>
    expect(parseAcpxSessionRecordId('{"id":"abcd1234"}')).toEqual({ acpxRecordId: "abcd1234", agentSessionId: undefined }));
  test("bare first line when JSON.parse throws", () =>
    expect(parseAcpxSessionRecordId("abcd1234\nrest")).toEqual({ acpxRecordId: "abcd1234" }));
  test("too-short id → undefined", () => expect(parseAcpxSessionRecordId('{"id":"x"}')).toBeUndefined());
  test("malformed non-json → undefined", () => expect(parseAcpxSessionRecordId("!!")).toBeUndefined());
});
```

> **NOTE for implementer:** the exact permission FLAG string (`--approve-all` above is a *placeholder for whatever `permissionModeToFlag("approve-all")` actually returns*) MUST be taken from the real `src/transport/permission-mode-flag.ts` — read that file and use the real flag in the assertions. Do not guess. If it differs, update every expected array in this test to the real flag before running.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/transport/acpx-command-builder.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Write the module** `src/transport/acpx-command-builder.ts`

```ts
import type { NonInteractivePermissions, PermissionMode } from "../config/types";
import { permissionModeToFlag } from "./permission-mode-flag";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "approve-all";
export const DEFAULT_NON_INTERACTIVE: NonInteractivePermissions = "deny";

export interface PermissionArgsInput {
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  permissionPolicy?: string;
}

export function buildPermissionArgs(input: PermissionArgsInput): string[] {
  const args = [permissionModeToFlag(input.permissionMode), "--non-interactive-permissions", input.nonInteractivePermissions];
  if (typeof input.permissionPolicy === "string" && input.permissionPolicy.trim().length > 0) {
    args.push("--permission-policy", input.permissionPolicy);
  }
  return args;
}

export function buildQueueOwnerTtlArgs(queueOwnerTtlSeconds: number | undefined): string[] {
  if (typeof queueOwnerTtlSeconds !== "number" || !Number.isFinite(queueOwnerTtlSeconds)) return [];
  return ["--ttl", String(queueOwnerTtlSeconds)];
}

export function buildModelArgs(model: string | undefined): string[] {
  const trimmed = model?.trim();
  return trimmed ? ["--model", trimmed] : [];
}

export interface SessionArgsInput {
  agent: string;
  agentCommand?: string;
  cwd: string;
  model?: string;
  permission: PermissionArgsInput;
}

export function buildSessionArgs(
  input: SessionArgsInput,
  tail: string[],
  options: { verbose?: boolean; format?: "quiet" | "json" } = {},
): string[] {
  const prefix: string[] = [
    "--format", options.format ?? "quiet",
    "--cwd", input.cwd,
    ...buildPermissionArgs(input.permission),
    ...buildModelArgs(input.model),
  ];
  if (options.verbose) prefix.push("--verbose");
  if (input.agentCommand) return [...prefix, "--agent", input.agentCommand, ...tail];
  return [...prefix, input.agent, ...tail];
}

export function buildPromptArgs(
  input: SessionArgsInput & { queueOwnerTtlSeconds: number | undefined },
  tail: string[],
): string[] {
  const prefix = [
    "--format", "json", "--json-strict",
    "--cwd", input.cwd,
    ...buildPermissionArgs(input.permission),
    ...buildModelArgs(input.model),
    ...buildQueueOwnerTtlArgs(input.queueOwnerTtlSeconds),
  ];
  if (input.agentCommand) return [...prefix, "--agent", input.agentCommand, ...tail];
  return [...prefix, input.agent, ...tail];
}

export function buildAgentQueryArgs(
  input: { agent: string; agentCommand?: string; cwd: string; permission: PermissionArgsInput },
  format: "json" | "quiet",
  tail: string[],
): string[] {
  const prefix = ["--format", format, "--cwd", input.cwd, ...buildPermissionArgs(input.permission)];
  if (input.agentCommand) return [...prefix, "--agent", input.agentCommand, ...tail];
  return [...prefix, input.agent, ...tail];
}

export function isMissingAcpxSessionError(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  return (
    combined.includes("no named session") ||
    combined.includes("no cwd session") ||
    combined.includes("session not found") ||
    combined.includes("unknown session") ||
    combined.includes("no acpx session found")
  );
}

export function parseAcpxSessionRecordId(
  stdout: string,
): { acpxRecordId: string; agentSessionId?: string } | undefined {
  try {
    const parsed = JSON.parse(stdout) as { acpxRecordId?: unknown; id?: unknown; agentSessionId?: unknown };
    const acpxRecordId = typeof parsed.acpxRecordId === "string"
      ? parsed.acpxRecordId
      : typeof parsed.id === "string" ? parsed.id : undefined;
    const agentSessionId = typeof parsed.agentSessionId === "string" ? parsed.agentSessionId : undefined;
    if (acpxRecordId && /^[\w.:-]+$/.test(acpxRecordId) && acpxRecordId.length >= 8) {
      return { acpxRecordId, agentSessionId };
    }
  } catch {
    const firstLine = stdout.trim().split(/\r?\n/, 1)[0];
    if (firstLine && /^[\w.:-]+$/.test(firstLine) && firstLine.length >= 8) {
      return { acpxRecordId: firstLine };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/transport/acpx-command-builder.test.ts`
Expected: PASS (after fixing the permission-flag string to the real value from `permission-mode-flag.ts`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/transport/acpx-command-builder.ts tests/unit/transport/acpx-command-builder.test.ts
git commit -m "feat(transport): add pure acpx-command-builder module"
```

---

## Task 2: Rewire CLI transport to delegate

**Files:**
- Modify: `src/transport/acpx-cli/acpx-cli-transport.ts`

**Interfaces:**
- Consumes: all exports from `./acpx-command-builder` (Task 1).

**Behaviour-preserving delegation.** Replace each private builder / free function body with a delegation. The private method NAMES and signatures stay identical (so no call site changes). Field mappings:

| CLI private member (current) | New body |
|---|---|
| `buildPermissionArgs()` | `return sharedBuildPermissionArgs({ permissionMode: this.permissionMode, nonInteractivePermissions: this.nonInteractivePermissions, permissionPolicy: this.permissionPolicy });` |
| `buildModelArgs(session)` | `return sharedBuildModelArgs(session.model);` |
| `buildQueueOwnerTtlArgs()` | `return sharedBuildQueueOwnerTtlArgs(this.queueOwnerTtlSeconds);` |
| `buildArgs(session, tail)` | `return sharedBuildSessionArgs(this.sessionInput(session), tail, { format: "quiet" });` |
| `buildAgentQueryArgs(query, format, tail)` | `return sharedBuildAgentQueryArgs({ agent: query.agent, agentCommand: query.agentCommand, cwd: query.cwd, permission: this.permissionInput() }, format, tail);` |
| `buildPromptArgs(session, text, promptFile?)` | build `tail` exactly as today (`promptFile ? ["prompt","-s",session.transportSession,"--file",promptFile] : ["prompt","-s",session.transportSession,text]`), then `return sharedBuildPromptArgs({ ...this.sessionInput(session), queueOwnerTtlSeconds: this.queueOwnerTtlSeconds }, tail);` |
| free `isMissingAcpxSessionError(stderr, stdout)` | delete the local; import from the shared module (same name) |
| id-parse block inside `readSessionRecord` | after the `code !== 0` throw stays, replace the try/catch parse with: `const record = parseAcpxSessionRecordId(result.stdout); if (record) return record; throw new Error("failed to resolve acpx session record id");` |

Add two small private helpers to build the neutral inputs (keeps the table DRY):
```ts
private permissionInput() {
  return { permissionMode: this.permissionMode, nonInteractivePermissions: this.nonInteractivePermissions, permissionPolicy: this.permissionPolicy };
}
private sessionInput(session: ResolvedSession) {
  return { agent: session.agent, agentCommand: session.agentCommand, cwd: session.cwd, model: session.model, permission: this.permissionInput() };
}
```
Import block adds: `import { buildPermissionArgs as sharedBuildPermissionArgs, buildModelArgs as sharedBuildModelArgs, buildQueueOwnerTtlArgs as sharedBuildQueueOwnerTtlArgs, buildSessionArgs as sharedBuildSessionArgs, buildAgentQueryArgs as sharedBuildAgentQueryArgs, buildPromptArgs as sharedBuildPromptArgs, isMissingAcpxSessionError, parseAcpxSessionRecordId } from "../acpx-command-builder";`

Also swap the constructor literals to the shared constants:
`this.permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;` and `this.nonInteractivePermissions = options.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE;` (import both constants). Output-identical.

- [ ] **Step 1: Apply the delegations** per the table above. Keep `buildModelArgs`'s explanatory comment (about acpx persisting the model) above its now-one-line body; keep `buildQueueOwnerTtlArgs`'s `--ttl` comment.

- [ ] **Step 2: Run the CLI oracle — must be byte-identical**

Run: `TZ=UTC bun test tests/unit/transport/golden/cli-argv-oracle.test.ts`
Expected: PASS (0 drift). If any fixture drifts, the delegation changed behaviour — fix the delegation, NOT the fixture.

- [ ] **Step 3: Run the existing CLI transport tests**

Run: `bun test tests/unit/transport/acpx-cli/` (per-file if a whole-dir run leaks state; run each `*.test.ts` under that dir individually if needed)
Expected: PASS, unchanged.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/transport/acpx-cli/acpx-cli-transport.ts
git commit -m "refactor(transport): CLI transport delegates argv building to acpx-command-builder"
```

---

## Task 3: Rewire bridge runtime to delegate

**Files:**
- Modify: `src/bridge/bridge-runtime.ts`

**Interfaces:**
- Consumes: all exports from `../transport/acpx-command-builder` (Task 1).

**Delegation table** (bridge inputs are structural, defaults resolved at call site using the shared constants):

| Bridge private member (current) | New body |
|---|---|
| `buildPermissionArgs()` | `return sharedBuildPermissionArgs({ permissionMode: this.options.permissionMode ?? DEFAULT_PERMISSION_MODE, nonInteractivePermissions: this.options.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE, permissionPolicy: this.options.permissionPolicy });` |
| `buildQueueOwnerTtlArgs()` | `return sharedBuildQueueOwnerTtlArgs(this.options.queueOwnerTtlSeconds);` |
| free `modelArgs(model)` | delete; the shared `buildSessionArgs`/`buildPromptArgs` already apply model internally |
| `buildSessionArgs(input, tail, options)` | `return sharedBuildSessionArgs({ agent: input.agent, agentCommand: input.agentCommand, cwd: input.cwd, model: input.model, permission: this.permissionInput() }, tail, options);` |
| `buildPromptArgs(input, tail)` | `return sharedBuildPromptArgs({ agent: input.agent, agentCommand: input.agentCommand, cwd: input.cwd, model: input.model, permission: this.permissionInput(), queueOwnerTtlSeconds: this.options.queueOwnerTtlSeconds }, tail);` |
| free `isMissingBridgeSessionError(stderr, stdout)` | delete; import `isMissingAcpxSessionError` from the shared module and update its one call site (`removeSession`) to the new name |
| id-parse block inside `readSessionRecord` | replace the try/catch parse with `const record = parseAcpxSessionRecordId(result.stdout); if (record) return record; throw new Error("failed to resolve acpx session record id");` (keep the preceding `code !== 0` throw as-is) |

Add the private helper:
```ts
private permissionInput() {
  return { permissionMode: this.options.permissionMode ?? DEFAULT_PERMISSION_MODE, nonInteractivePermissions: this.options.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE, permissionPolicy: this.options.permissionPolicy };
}
```
Import block adds: `import { buildPermissionArgs as sharedBuildPermissionArgs, buildQueueOwnerTtlArgs as sharedBuildQueueOwnerTtlArgs, buildSessionArgs as sharedBuildSessionArgs, buildPromptArgs as sharedBuildPromptArgs, isMissingAcpxSessionError, parseAcpxSessionRecordId, DEFAULT_PERMISSION_MODE, DEFAULT_NON_INTERACTIVE } from "../transport/acpx-command-builder";`

- [ ] **Step 1: Apply the delegations** per the table. Keep the `--ttl` comment above `buildQueueOwnerTtlArgs`.

- [ ] **Step 2: Run the bridge oracle — must be byte-identical**

Run: `TZ=UTC bun test tests/unit/transport/golden/bridge-argv-oracle.test.ts`
Expected: PASS (0 drift).

- [ ] **Step 3: Run the existing bridge tests**

Run: per-file `bun test tests/unit/bridge/<file>.test.ts` for each bridge test file (find with `ls tests/unit/bridge/`).
Expected: PASS, unchanged.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/bridge-runtime.ts
git commit -m "refactor(bridge): bridge-runtime delegates argv building to acpx-command-builder"
```

---

## Task 4: Cleanup, docs, baseline cross-check

**Files:**
- Modify: `src/transport/acpx-cli/acpx-cli-transport.ts`, `src/bridge/bridge-runtime.ts` (remove any now-unused imports/helpers)
- Modify: `docs/code-wiki.md` and any transport/bridge module doc (check `ls docs/ | grep -iE 'bridge|transport|module'`)

- [ ] **Step 1: Remove dead code.** Confirm no orphaned private methods or imports remain. Run `npx tsc --noEmit` — with `noUnusedLocals` (if enabled) it flags leftovers; otherwise grep for the old free-function names (`isMissingBridgeSessionError`, `modelArgs`) to confirm deletion.

Run: `grep -n "isMissingBridgeSessionError\|function modelArgs" src/bridge/bridge-runtime.ts` → expect no matches.

- [ ] **Step 2: Update docs.** Add a short note to the transport/bridge module doc (whichever exists) that argv building for both transports now lives in `src/transport/acpx-command-builder.ts` (pure, shared, single source of truth for permission/ttl/model/session/prompt args), and that the two transports keep separate I/O plumbing. Keep it factual and brief.

- [ ] **Step 3: Full unit suite (per-file runner).**

Run: `npm test` (runs typecheck + the file-isolated unit runner)
Expected: PASS.

- [ ] **Step 4: Baseline cross-check the fixtures.**

Create a detached worktree at the Task-0 commit (the commit recorded in the ledger for Task 0), symlink node_modules, and replay the oracle to prove the committed fixtures reproduce byte-identical against pre-refactor code:
```bash
BASE=<task0-commit-sha>
git worktree add /tmp/bb-baseline "$BASE"
ln -s "$(pwd)/node_modules" /tmp/bb-baseline/node_modules
cd /tmp/bb-baseline && cp -r "$(git -C "$OLDPWD" rev-parse --show-toplevel)/tests/unit/transport/golden" tests/unit/transport/ 2>/dev/null || true
# Actually: check out ONLY the current fixtures + harness onto the baseline source, then run without GOLDEN_UPDATE
env -u GOLDEN_UPDATE TZ=UTC bun test tests/unit/transport/golden/cli-argv-oracle.test.ts tests/unit/transport/golden/bridge-argv-oracle.test.ts
cd - && git worktree remove /tmp/bb-baseline --force
```
Expected: PASS — the current fixtures match the pre-refactor transports' argv. (If the harness signature changed between Task 0 and now, copy the current harness+fixtures over the baseline's source before running, so only the transport source differs.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(transport): remove duplicated argv builders; document shared command-builder"
```

---

## Self-Review (author checklist — completed)

**Spec coverage:** shared module (Task 1) ✓; per-side argv oracle (Task 0) ✓; CLI delegation (Task 2) ✓; bridge delegation (Task 3) ✓; default-constant unification (Tasks 1–3) ✓; predicates + id-parse (Task 1, pinned in Task 0) ✓; dead-code removal + docs + baseline cross-check (Task 4) ✓; non-goals (interface methods / runners / streaming untouched) respected — no task modifies them.

**Placeholder scan:** the only intentional placeholder is the permission-mode FLAG string in Task 1's test, explicitly flagged with a NOTE telling the implementer to read `permission-mode-flag.ts` and substitute the real value. No other placeholders.

**Type consistency:** `SessionArgsInput`, `PermissionArgsInput`, and every builder signature are identical across Tasks 1/2/3. The neutral input built by CLI's `sessionInput()` and bridge's inline object both match `SessionArgsInput`. `parseAcpxSessionRecordId` return shape matches both `readSessionRecord` call sites.
