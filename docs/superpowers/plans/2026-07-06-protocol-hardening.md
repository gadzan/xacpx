# Protocol Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hand-written runtime payload validation + a type-level message↔payload binding to the relay control-RPC protocol, so malformed frames crossing a trust boundary are rejected instead of blindly `as`-cast and executed.

**Architecture:** One source of truth in `relay-protocol`: a registry keyed by control-RPC message type whose values are hand-written validators (`unknown → Payload | null`). The registry doubles as the type-level binding (`PayloadFor<T>` + `parseControlPayload<T>`). Three trust boundaries adopt it: (A) the connector's `control-bridge` dispatch (where fs/prompt actually execute), (B) the hub's `onEvent` instance-event path (reusing the existing `validControlEvent`), (C) the hub's HTTP `/rpc` route for the three RPCs it persists before forwarding.

**Tech Stack:** TypeScript (strict), Bun test runner, `@ganglion/xacpx-relay-protocol` (zero-dependency published package), Hono (hub HTTP), `ws`.

## Global Constraints

- **No new dependencies.** The whole repo has zero schema/validation libraries; `relay-protocol` is a zero-dependency published package pinned `^0.1.0` by hub/connector/web. Keep it dependency-free. Hand-write validators in the existing `web-dtos.ts` style.
- **Privacy red line** (inherited from Track 1 observability): rejection logs and error messages MUST NOT contain payload values — no fs paths, prompt text, upload content, or credentials. Only `type`, `instanceId`, and a structural `reason` (which field is missing / wrong type).
- **Protocol compatibility unbroken.** Pure additive validation (what it rejects was already malformed); do not change any payload structure or the envelope shallow-check. Protocol stays `0.1.x` / `^0.1.0`. Adding the two `Terminal*Payload` interfaces is additive.
- **git hygiene:** only `git add` the files you changed, never `git add -A`; do not touch any lockfile; English conventional commits.
- **Tests:** run per-file with `bun test <path>` (CI runs them under Node too). Type-level bindings are verified by `npx tsc --noEmit` at repo root. Do NOT run whole-directory `bun test` (state-leak false failures). Running tests/tsc may regenerate `packages/relay-protocol/dist/index.js` as a false diff — `git checkout -- packages/relay-protocol/dist` before committing if so.

---

### Task 1: Extract shared field predicates into `validate-primitives.ts`

**Files:**
- Create: `packages/relay-protocol/src/validate-primitives.ts`
- Modify: `packages/relay-protocol/src/web-dtos.ts:115-117` (delete the three local predicates, import them instead)
- Test: `tests/unit/packages/relay-protocol/validate-primitives.test.ts`

**Interfaces:**
- Produces: `isObj(v: unknown): v is Record<string, unknown>`, `isStr(v: unknown): boolean`, `optStr(v: unknown): boolean`, `optNum(v: unknown): boolean`, `optBool(v: unknown): boolean` — exported from `validate-primitives.ts`. Task 2 consumes all of them.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/packages/relay-protocol/validate-primitives.test.ts`:

```ts
// tests/unit/packages/relay-protocol/validate-primitives.test.ts
import { expect, test } from "bun:test";
import { isObj, isStr, optStr, optNum, optBool } from "../../../../packages/relay-protocol/src/validate-primitives";

test("isObj accepts plain objects, rejects null and non-objects", () => {
  expect(isObj({})).toBe(true);
  expect(isObj({ a: 1 })).toBe(true);
  expect(isObj(null)).toBe(false);
  expect(isObj(undefined)).toBe(false);
  expect(isObj("x")).toBe(false);
  expect(isObj(3)).toBe(false);
});

test("isStr is true only for strings", () => {
  expect(isStr("")).toBe(true);
  expect(isStr("a")).toBe(true);
  expect(isStr(1)).toBe(false);
  expect(isStr(undefined)).toBe(false);
});

test("optStr allows undefined or string, rejects other types", () => {
  expect(optStr(undefined)).toBe(true);
  expect(optStr("a")).toBe(true);
  expect(optStr(null)).toBe(false);
  expect(optStr(1)).toBe(false);
});

test("optNum allows undefined or number", () => {
  expect(optNum(undefined)).toBe(true);
  expect(optNum(2)).toBe(true);
  expect(optNum("2")).toBe(false);
});

test("optBool allows undefined or boolean", () => {
  expect(optBool(undefined)).toBe(true);
  expect(optBool(true)).toBe(true);
  expect(optBool(0)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay-protocol/validate-primitives.test.ts`
Expected: FAIL — `Cannot find module '.../validate-primitives'`.

- [ ] **Step 3: Create `validate-primitives.ts`**

```ts
// packages/relay-protocol/src/validate-primitives.ts
// Shared runtime field predicates for wire-payload validation. Kept dependency-free
// and framework-free so both web-dtos.ts (relay→web push) and payload-validators.ts
// (hub↔connector control RPCs) draw from one implementation instead of drifting copies.

/** True for a non-null object; narrows to an indexable record for field access. */
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Required string. */
export const isStr = (v: unknown): boolean => typeof v === "string";

/** Optional string: absent or a string. */
export const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";

/** Optional number: absent or a number. */
export const optNum = (v: unknown): boolean => v === undefined || typeof v === "number";

/** Optional boolean: absent or a boolean. */
export const optBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";
```

- [ ] **Step 4: Rewire `web-dtos.ts` to import the three it uses**

In `packages/relay-protocol/src/web-dtos.ts`, delete the three local definitions at lines 115-117:

```ts
const isStr = (v: unknown): boolean => typeof v === "string";
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const optNum = (v: unknown): boolean => v === undefined || typeof v === "number";
```

Add an import near the top of the file (with the other imports; `web-dtos.ts` currently imports from `./dtos.js` and `./envelope.js` — add this line):

```ts
import { isStr, optStr, optNum } from "./validate-primitives.js";
```

Leave everything else in `web-dtos.ts` untouched — do NOT refactor its validator internals.

- [ ] **Step 5: Run tests to verify green**

Run: `bun test tests/unit/packages/relay-protocol/validate-primitives.test.ts`
Expected: PASS (5 tests).

Run the existing web-dtos suite to prove the extraction is behavior-preserving:
Run: `bun test tests/unit/packages/relay-protocol/web-dtos.test.ts`
Expected: PASS (unchanged count).

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git checkout -- packages/relay-protocol/dist 2>/dev/null || true
git add packages/relay-protocol/src/validate-primitives.ts packages/relay-protocol/src/web-dtos.ts tests/unit/packages/relay-protocol/validate-primitives.test.ts
git commit -m "refactor(relay-protocol): extract shared field predicates into validate-primitives"
```

---

### Task 2: Build the control-payload validator registry + type-level binding

**Files:**
- Create: `packages/relay-protocol/src/payload-validators.ts`
- Modify: `packages/relay-protocol/src/messages.ts` (append two payload interfaces after line 443)
- Modify: `packages/relay-protocol/src/index.ts` (export the new module)
- Modify: `packages/relay-protocol/src/web-dtos.ts` (export `validControlEvent` for Task 4's reuse)
- Test: `tests/unit/packages/relay-protocol/payload-validators.test.ts`

**Interfaces:**
- Consumes: `isObj, isStr, optStr, optNum, optBool` from Task 1; all `*Payload` types from `messages.ts`.
- Produces:
  - `type Validator<T> = (payload: unknown) => T | null`
  - `type ControlRpcType` — union of the 35 control-RPC `MSG` literal types listed below.
  - `const CONTROL_PAYLOAD_VALIDATORS` — `satisfies Record<ControlRpcType, Validator<unknown>>`.
  - `type PayloadFor<T extends ControlRpcType>` = `NonNullable<ReturnType<(typeof CONTROL_PAYLOAD_VALIDATORS)[T]>>`.
  - `function parseControlPayload<T extends ControlRpcType>(type: T, payload: unknown): PayloadFor<T> | null` — Task 3 and Task 5 consume this.
  - `interface TerminalCreatePayload { chatKey: string; sessionAlias: string; cols?: number; rows?: number }` and `interface TerminalAttachPayload { terminalId: string }` in `messages.ts`.
  - `validControlEvent(e: unknown): boolean` becomes exported from `web-dtos.ts` — Task 4 consumes it.

- [ ] **Step 1: Add the two terminal payload interfaces to `messages.ts`**

`control-bridge.ts` currently types the `terminalCreate`/`terminalAttach` arms with anonymous inline shapes. Give them named interfaces so the validator registry can bind them. Append to the end of `packages/relay-protocol/src/messages.ts` (after `SessionModelResult`, line 450):

```ts
export interface TerminalCreatePayload {
  chatKey: string;
  sessionAlias: string;
  cols?: number;
  rows?: number;
}

export interface TerminalAttachPayload {
  terminalId: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/packages/relay-protocol/payload-validators.test.ts`. This covers a representative slice of validators (happy path + missing-required + wrong-type), the registry's exhaustiveness, and the type-level binding.

```ts
// tests/unit/packages/relay-protocol/payload-validators.test.ts
import { expect, test } from "bun:test";
import {
  MSG,
  parseControlPayload,
  CONTROL_PAYLOAD_VALIDATORS,
  type PayloadFor,
  type FsWritePayload,
  type PromptPayload,
} from "../../../../packages/relay-protocol/src/index";

test("parseControlPayload accepts a well-formed fsWrite payload", () => {
  const ok = parseControlPayload(MSG.fsWrite, {
    workspace: "home", path: "a.txt", content: "hi",
    expected: { mtimeMs: 1, size: 2 },
  });
  expect(ok).not.toBeNull();
  expect(ok?.workspace).toBe("home");
});

test("parseControlPayload rejects fsWrite missing required fields", () => {
  expect(parseControlPayload(MSG.fsWrite, { workspace: "home", path: "a.txt" })).toBeNull(); // no content/expected
  expect(parseControlPayload(MSG.fsWrite, { workspace: "home", path: "a.txt", content: "x", expected: { mtimeMs: 1 } })).toBeNull(); // expected.size missing
  expect(parseControlPayload(MSG.fsWrite, null)).toBeNull();
  expect(parseControlPayload(MSG.fsWrite, "nope")).toBeNull();
});

test("parseControlPayload rejects fsWrite with wrong field types", () => {
  expect(parseControlPayload(MSG.fsWrite, { workspace: 1, path: "a", content: "x", expected: { mtimeMs: 1, size: 2 } })).toBeNull();
  expect(parseControlPayload(MSG.fsWrite, { workspace: "w", path: "a", content: 5, expected: { mtimeMs: 1, size: 2 } })).toBeNull();
});

test("parseControlPayload validates prompt: required strings, optional media array", () => {
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u" })).not.toBeNull();
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u", media: [] })).not.toBeNull();
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", senderId: "u" })).toBeNull(); // no text
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u", media: "x" })).toBeNull(); // media not array
});

test("fsCreate enforces the kind literal union", () => {
  expect(parseControlPayload(MSG.fsCreate, { workspace: "w", path: "p", kind: "file" })).not.toBeNull();
  expect(parseControlPayload(MSG.fsCreate, { workspace: "w", path: "p", kind: "dir" })).not.toBeNull();
  expect(parseControlPayload(MSG.fsCreate, { workspace: "w", path: "p", kind: "socket" })).toBeNull();
});

test("chatKey-only and chatKey+alias families validate their shape", () => {
  expect(parseControlPayload(MSG.sessionsList, { chatKey: "relay:a1" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsList, {})).toBeNull();
  expect(parseControlPayload(MSG.sessionsRemove, { chatKey: "relay:a1", alias: "s" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsRemove, { chatKey: "relay:a1" })).toBeNull();
});

test("upload requires filename, content, mimeType strings", () => {
  expect(parseControlPayload(MSG.upload, { filename: "a", content: "b64", mimeType: "text/plain" })).not.toBeNull();
  expect(parseControlPayload(MSG.upload, { filename: "a", content: "b64" })).toBeNull();
});

test("every registered validator returns null for a non-object payload", () => {
  for (const type of Object.keys(CONTROL_PAYLOAD_VALIDATORS) as (keyof typeof CONTROL_PAYLOAD_VALIDATORS)[]) {
    expect(CONTROL_PAYLOAD_VALIDATORS[type](null)).toBeNull();
    expect(CONTROL_PAYLOAD_VALIDATORS[type](42)).toBeNull();
  }
});

// --- Type-level binding (checked by `npx tsc --noEmit`, not at runtime) ---
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// PayloadFor<MSG.fsWrite> is exactly FsWritePayload (not `unknown`, not a widened shape).
type _fsWriteBound = Expect<Equal<PayloadFor<typeof MSG.fsWrite>, FsWritePayload>>;
type _promptBound = Expect<Equal<PayloadFor<typeof MSG.prompt>, PromptPayload>>;

test("type-level bindings compile", () => {
  // The `_fsWriteBound`/`_promptBound` aliases above fail `tsc` if PayloadFor drifts
  // from the hand-written payload type. This runtime assertion just anchors the test.
  const _use: [_fsWriteBound, _promptBound] = [true, true];
  expect(_use).toEqual([true, true]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay-protocol/payload-validators.test.ts`
Expected: FAIL — `parseControlPayload` / `CONTROL_PAYLOAD_VALIDATORS` not exported.

- [ ] **Step 4: Create `payload-validators.ts`**

```ts
// packages/relay-protocol/src/payload-validators.ts
// Runtime validators for hub→connector control RPCs. Each validator checks a payload's
// SHAPE (field presence + type, including literal unions and nested objects) and returns
// the narrowed payload, or null when malformed. Semantic checks (non-empty, valid ISO date,
// existence) stay in the connector's dispatch — these only guard the wire shape.
//
// The registry keys are the control-RPC MessageTypes; `satisfies Record<ControlRpcType, …>`
// makes tsc fail if a control RPC is added to the union without a validator (or vice versa),
// and `parseControlPayload` forces every connector dispatch arm to register its message type.
import {
  MSG,
  type AgentsCreatePayload,
  type AgentsRemovePayload,
  type CommandExecutePayload,
  type FsCopyPayload,
  type FsCreatePayload,
  type FsDeletePayload,
  type FsDiffPayload,
  type FsDownloadPayload,
  type FsListPayload,
  type FsReadPayload,
  type FsRenamePayload,
  type FsSearchPayload,
  type FsWritePayload,
  type OrchestrationCancelPayload,
  type OrchestrationGetPayload,
  type PromptCancelPayload,
  type PromptPayload,
  type QueueCancelPayload,
  type ScheduledCancelPayload,
  type ScheduledCreatePayload,
  type ScheduledListPayload,
  type SessionModelGetPayload,
  type SessionModelSetPayload,
  type SessionsArchivePayload,
  type SessionsCreatePayload,
  type SessionsListPayload,
  type SessionsNativeListPayload,
  type SessionsRemovePayload,
  type SessionsRenamePayload,
  type SessionsUnarchivePayload,
  type TerminalAttachPayload,
  type TerminalCreatePayload,
  type UploadPayload,
  type WorkspacesCreatePayload,
  type WorkspacesRemovePayload,
} from "./messages.js";
import { isObj, isStr, optStr, optNum, optBool } from "./validate-primitives.js";

export type Validator<T> = (payload: unknown) => T | null;

/** Non-null-object view for field access, or null. */
const fields = (p: unknown): Record<string, unknown> | null => (isObj(p) ? p : null);

const isArr = (v: unknown): boolean => Array.isArray(v);
const optArr = (v: unknown): boolean => v === undefined || Array.isArray(v);

// --- session / agent / workspace ---
const validateSessionsList: Validator<SessionsListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) ? (o as SessionsListPayload) : null;
};
const validateSessionsCreate: Validator<SessionsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) && isStr(o.agent) && isStr(o.workspace)
    && optStr(o.agentSessionId) && optStr(o.model) ? (o as SessionsCreatePayload) : null;
};
const validateSessionsNativeList: Validator<SessionsNativeListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.agent) && isStr(o.workspace) ? (o as SessionsNativeListPayload) : null;
};
const validateSessionsRemove: Validator<SessionsRemovePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? (o as SessionsRemovePayload) : null;
};
const validateSessionsArchive: Validator<SessionsArchivePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? (o as SessionsArchivePayload) : null;
};
const validateSessionsUnarchive: Validator<SessionsUnarchivePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? (o as SessionsUnarchivePayload) : null;
};
const validateSessionsRename: Validator<SessionsRenamePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) && isStr(o.displayName) ? (o as SessionsRenamePayload) : null;
};
const validateWorkspacesCreate: Validator<WorkspacesCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.cwd) && optStr(o.description) ? (o as WorkspacesCreatePayload) : null;
};
const validateAgentsCreate: Validator<AgentsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.driver) ? (o as AgentsCreatePayload) : null;
};
const validateAgentsRemove: Validator<AgentsRemovePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) ? (o as AgentsRemovePayload) : null;
};
const validateWorkspacesRemove: Validator<WorkspacesRemovePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) ? (o as WorkspacesRemovePayload) : null;
};

// --- prompt / command / queue ---
const validatePrompt: Validator<PromptPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.text) && isStr(o.senderId)
    && optBool(o.isOwner) && optArr(o.media) ? (o as PromptPayload) : null;
};
const validatePromptCancel: Validator<PromptCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? (o as PromptCancelPayload) : null;
};
const validateQueueCancel: Validator<QueueCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.itemId) ? (o as QueueCancelPayload) : null;
};
const validateCommandExecute: Validator<CommandExecutePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.text) && isStr(o.senderId) && optBool(o.isOwner)
    ? (o as CommandExecutePayload) : null;
};

// --- scheduled ---
const validateScheduledList: Validator<ScheduledListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) ? (o as ScheduledListPayload) : null;
};
const validateScheduledCreate: Validator<ScheduledCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.executeAt) && isStr(o.message)
    ? (o as ScheduledCreatePayload) : null;
};
const validateScheduledCancel: Validator<ScheduledCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id) && isStr(o.chatKey) ? (o as ScheduledCancelPayload) : null;
};

// --- orchestration ---
const validateOrchestrationGet: Validator<OrchestrationGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.taskId) ? (o as OrchestrationGetPayload) : null;
};
const validateOrchestrationCancel: Validator<OrchestrationCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.taskId) ? (o as OrchestrationCancelPayload) : null;
};

// --- fs (read family: workspace + optional path) ---
const validateFsList: Validator<FsListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.path) ? (o as FsListPayload) : null;
};
const validateFsRead: Validator<FsReadPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as FsReadPayload) : null;
};
const validateFsDiff: Validator<FsDiffPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.path) ? (o as FsDiffPayload) : null;
};
const validateFsSearch: Validator<FsSearchPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.query)
    && (o.mode === undefined || o.mode === "name" || o.mode === "content")
    && optBool(o.matchCase) && optBool(o.wholeWord) && optBool(o.regex)
    && optStr(o.include) && optStr(o.exclude) && optStr(o.path)
    ? (o as FsSearchPayload) : null;
};

// --- fs (mutating family) ---
const validateFsCreate: Validator<FsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) && (o.kind === "file" || o.kind === "dir")
    ? (o as FsCreatePayload) : null;
};
const validateFsRename: Validator<FsRenamePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) && isStr(o.newName) ? (o as FsRenamePayload) : null;
};
const validateFsDelete: Validator<FsDeletePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as FsDeletePayload) : null;
};
const validateFsCopy: Validator<FsCopyPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as FsCopyPayload) : null;
};
const validateFsDownload: Validator<FsDownloadPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as FsDownloadPayload) : null;
};
const validateFsWrite: Validator<FsWritePayload> = (p) => {
  const o = fields(p);
  if (!o || !isStr(o.workspace) || !isStr(o.path) || !isStr(o.content)) return null;
  const exp = fields(o.expected);
  if (!exp || typeof exp.mtimeMs !== "number" || typeof exp.size !== "number") return null;
  return o as FsWritePayload;
};

// --- model / terminal / upload ---
const validateSessionModelGet: Validator<SessionModelGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? (o as SessionModelGetPayload) : null;
};
const validateSessionModelSet: Validator<SessionModelSetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.modelId) ? (o as SessionModelSetPayload) : null;
};
const validateTerminalCreate: Validator<TerminalCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && optNum(o.cols) && optNum(o.rows)
    ? (o as TerminalCreatePayload) : null;
};
const validateTerminalAttach: Validator<TerminalAttachPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.terminalId) ? (o as TerminalAttachPayload) : null;
};
const validateUpload: Validator<UploadPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.filename) && isStr(o.content) && isStr(o.mimeType) ? (o as UploadPayload) : null;
};

/** The control-RPC message types that carry a client-supplied payload to validate.
 *  Excludes: handshake (instanceRegister/instanceAuth — validated in instance-gateway),
 *  event-direction (instanceEvent/instanceNotice — boundary B via validControlEvent),
 *  terminal I/O events (terminalInput/Resize/Close — validated by parseWebClientMessage),
 *  and the four no-payload list RPCs (agentsList/workspacesList/agentsCatalog/orchestrationList). */
export type ControlRpcType =
  | typeof MSG.sessionsList | typeof MSG.sessionsCreate | typeof MSG.sessionsNativeList
  | typeof MSG.sessionsRemove | typeof MSG.sessionsArchive | typeof MSG.sessionsUnarchive
  | typeof MSG.sessionsRename | typeof MSG.workspacesCreate | typeof MSG.agentsCreate
  | typeof MSG.agentsRemove | typeof MSG.workspacesRemove | typeof MSG.prompt
  | typeof MSG.promptCancel | typeof MSG.queueCancel | typeof MSG.commandExecute
  | typeof MSG.scheduledList | typeof MSG.scheduledCreate | typeof MSG.scheduledCancel
  | typeof MSG.orchestrationGet | typeof MSG.orchestrationCancel | typeof MSG.fsList
  | typeof MSG.fsRead | typeof MSG.fsDiff | typeof MSG.fsSearch | typeof MSG.fsCreate
  | typeof MSG.fsRename | typeof MSG.fsDelete | typeof MSG.fsCopy | typeof MSG.fsDownload
  | typeof MSG.fsWrite | typeof MSG.sessionModelGet | typeof MSG.sessionModelSet
  | typeof MSG.terminalCreate | typeof MSG.terminalAttach | typeof MSG.upload;

/** Registry: control-RPC type → shape validator. `satisfies` locks both directions —
 *  a ControlRpcType with no validator, or a validator whose key isn't a ControlRpcType,
 *  is a compile error. */
export const CONTROL_PAYLOAD_VALIDATORS = {
  [MSG.sessionsList]: validateSessionsList,
  [MSG.sessionsCreate]: validateSessionsCreate,
  [MSG.sessionsNativeList]: validateSessionsNativeList,
  [MSG.sessionsRemove]: validateSessionsRemove,
  [MSG.sessionsArchive]: validateSessionsArchive,
  [MSG.sessionsUnarchive]: validateSessionsUnarchive,
  [MSG.sessionsRename]: validateSessionsRename,
  [MSG.workspacesCreate]: validateWorkspacesCreate,
  [MSG.agentsCreate]: validateAgentsCreate,
  [MSG.agentsRemove]: validateAgentsRemove,
  [MSG.workspacesRemove]: validateWorkspacesRemove,
  [MSG.prompt]: validatePrompt,
  [MSG.promptCancel]: validatePromptCancel,
  [MSG.queueCancel]: validateQueueCancel,
  [MSG.commandExecute]: validateCommandExecute,
  [MSG.scheduledList]: validateScheduledList,
  [MSG.scheduledCreate]: validateScheduledCreate,
  [MSG.scheduledCancel]: validateScheduledCancel,
  [MSG.orchestrationGet]: validateOrchestrationGet,
  [MSG.orchestrationCancel]: validateOrchestrationCancel,
  [MSG.fsList]: validateFsList,
  [MSG.fsRead]: validateFsRead,
  [MSG.fsDiff]: validateFsDiff,
  [MSG.fsSearch]: validateFsSearch,
  [MSG.fsCreate]: validateFsCreate,
  [MSG.fsRename]: validateFsRename,
  [MSG.fsDelete]: validateFsDelete,
  [MSG.fsCopy]: validateFsCopy,
  [MSG.fsDownload]: validateFsDownload,
  [MSG.fsWrite]: validateFsWrite,
  [MSG.sessionModelGet]: validateSessionModelGet,
  [MSG.sessionModelSet]: validateSessionModelSet,
  [MSG.terminalCreate]: validateTerminalCreate,
  [MSG.terminalAttach]: validateTerminalAttach,
  [MSG.upload]: validateUpload,
} satisfies Record<ControlRpcType, Validator<unknown>>;

/** The payload type bound to a control-RPC message, derived from its validator's return. */
export type PayloadFor<T extends ControlRpcType> =
  NonNullable<ReturnType<(typeof CONTROL_PAYLOAD_VALIDATORS)[T]>>;

/** Type-safe replacement for `payload as XxxPayload`: validates shape, returns the bound
 *  payload type or null. */
export function parseControlPayload<T extends ControlRpcType>(type: T, payload: unknown): PayloadFor<T> | null {
  const validate = CONTROL_PAYLOAD_VALIDATORS[type] as Validator<PayloadFor<T>>;
  return validate(payload);
}
```

- [ ] **Step 5: Export the new module + `validControlEvent`**

In `packages/relay-protocol/src/index.ts`, add:

```ts
export * from "./validate-primitives.js";
export * from "./payload-validators.js";
```

In `packages/relay-protocol/src/web-dtos.ts`, change the `validControlEvent` declaration (currently `function validControlEvent(e: unknown): boolean {` at line 162) to be exported:

```ts
export function validControlEvent(e: unknown): boolean {
```

- [ ] **Step 6: Run tests to verify green**

Run: `bun test tests/unit/packages/relay-protocol/payload-validators.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: 0 errors. (If a validator's returned shape drifts from its payload type, the `_fsWriteBound`/`_promptBound` aliases in the test fail here.)

Re-run the existing protocol suites to confirm no regression:
Run: `bun test tests/unit/packages/relay-protocol/web-dtos.test.ts tests/unit/packages/relay-protocol/messages.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git checkout -- packages/relay-protocol/dist 2>/dev/null || true
git add packages/relay-protocol/src/payload-validators.ts packages/relay-protocol/src/messages.ts packages/relay-protocol/src/index.ts packages/relay-protocol/src/web-dtos.ts tests/unit/packages/relay-protocol/payload-validators.test.ts
git commit -m "feat(relay-protocol): control-payload validator registry with type-level binding"
```

---

### Task 3: Boundary A — validate control RPCs in the connector dispatch

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts:151-359` (the `dispatchControlRequest` switch)
- Test: `tests/unit/packages/channel-relay/control-bridge.test.ts` (extend)

**Interfaces:**
- Consumes: `parseControlPayload`, `TerminalCreatePayload`, `TerminalAttachPayload` from Task 2.
- Produces: no new exports; every casting arm now rejects malformed payloads with `errorPayload("invalid-payload", …)`.

**Method:** For each arm that currently does `const input = payload as XxxPayload` (or `const i = payload as XxxPayload`), replace the cast with a `parseControlPayload` call and an early `invalid-payload` return. **Keep every existing semantic check** below the cast (non-empty checks, `Date.parse` validity, etc.) — the validator only guarantees wire shape. The four no-payload arms (`agentsList`, `workspacesList`, `agentsCatalog`, `orchestrationList`) are unchanged. The rejection message carries only the message type, never payload contents (privacy).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/packages/channel-relay/control-bridge.test.ts`. These use the existing `req` / `makeFakeControl` / `createControlBridge` helpers already in that file (see its top). Add near the other tests:

```ts
test("boundary A: malformed fsWrite is rejected and never touches the filesystem", async () => {
  const control = makeFakeControl();
  const bridge = createControlBridge(control.control as never);
  const responses: unknown[] = [];
  // missing `content` and `expected` → invalid shape
  bridge(req(MSG.fsWrite, { workspace: "home", path: "a.txt" }), (p) => responses.push(p));
  await new Promise((r) => setTimeout(r, 0));
  expect(responses[0]).toEqual({ error: { code: "invalid-payload", message: expect.stringContaining(MSG.fsWrite) } });
  expect(control.calls.fsWrite).toBeUndefined();
});

test("boundary A: malformed prompt is rejected and control.prompt is never called", async () => {
  const control = makeFakeControl();
  const bridge = createControlBridge(control.control as never);
  const responses: unknown[] = [];
  bridge(req(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s" /* no text/senderId */ }), (p) => responses.push(p));
  await new Promise((r) => setTimeout(r, 0));
  expect(responses[0]).toEqual({ error: { code: "invalid-payload", message: expect.stringContaining(MSG.prompt) } });
  expect(control.calls.prompt).toBeUndefined();
});

test("boundary A: a well-formed prompt still dispatches to control.prompt", async () => {
  const control = makeFakeControl();
  const bridge = createControlBridge(control.control as never);
  const responses: unknown[] = [];
  bridge(req(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u" }), (p) => responses.push(p));
  await new Promise((r) => setTimeout(r, 0));
  expect(responses[0]).toEqual({ ok: true, text: "done" });
  expect(control.calls.prompt?.length).toBe(1);
});
```

Note: `makeFakeControl` in the file returns `{ control, calls }` (it records calls into a `calls` record and exposes `control`). Confirm the exact return shape at the top of the file and adjust the destructuring (`control.control` / `control.calls`) to match how other tests in the file consume it — mirror an existing test's usage exactly. `control.fsWrite` may not exist on the fake; add an `fsWrite` recorder to `makeFakeControl` if the happy-path/rejection test needs it (record into `calls.fsWrite`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/packages/channel-relay/control-bridge.test.ts`
Expected: FAIL — malformed payloads currently dispatch (or throw) instead of returning `invalid-payload`.

- [ ] **Step 3: Update the import + every casting arm**

In `control-bridge.ts`, add `parseControlPayload` to the `@ganglion/xacpx-relay-protocol` import block, and add `type TerminalCreatePayload`, `type TerminalAttachPayload`. Then rewrite each casting arm. Two representative examples (apply the same transform to ALL 35 casting arms enumerated in Task 2's `ControlRpcType`):

`sessionsList` (was lines 154-157):
```ts
    case MSG.sessionsList: {
      const input = parseControlPayload(MSG.sessionsList, payload);
      if (!input) return errorPayload("invalid-payload", `${MSG.sessionsList}: malformed payload`);
      return { sessions: control.listSessions(input.chatKey) };
    }
```

`fsWrite` (was lines 320-328) — keep the existing semantic checks below the parse:
```ts
    case MSG.fsWrite: {
      const i = parseControlPayload(MSG.fsWrite, payload);
      if (!i) return errorPayload("invalid-payload", `${MSG.fsWrite}: malformed payload`);
      if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
      return await control.fsWrite(i.workspace, i.path, i.content, i.expected);
    }
```

For `terminalCreate` / `terminalAttach`, the parse now returns the named `TerminalCreatePayload` / `TerminalAttachPayload`:
```ts
    case MSG.terminalCreate: {
      const input = parseControlPayload(MSG.terminalCreate, payload);
      if (!input) return errorPayload("invalid-payload", `${MSG.terminalCreate}: malformed payload`);
      if (!input.sessionAlias) return errorPayload("bad-request", "sessionAlias is required");
      return await control.createTerminal(input.chatKey, input.sessionAlias, input.cols ?? 80, input.rows ?? 24);
    }
    case MSG.terminalAttach: {
      const input = parseControlPayload(MSG.terminalAttach, payload);
      if (!input) return errorPayload("invalid-payload", `${MSG.terminalAttach}: malformed payload`);
      if (!input.terminalId) return errorPayload("bad-request", "terminalId is required");
      return control.attachTerminal(input.terminalId);
    }
```

Apply the identical pattern to the remaining arms: `sessionsCreate`, `sessionsNativeList`, `sessionsRemove`, `sessionsArchive`, `sessionsUnarchive`, `sessionsRename`, `workspacesCreate`, `agentsCreate`, `agentsRemove`, `workspacesRemove`, `prompt`, `promptCancel`, `queueCancel`, `commandExecute`, `scheduledList`, `scheduledCreate`, `scheduledCancel`, `orchestrationGet`, `orchestrationCancel`, `fsList`, `fsRead`, `fsDiff`, `fsSearch`, `fsCreate`, `fsRename`, `fsDelete`, `fsCopy`, `fsDownload`, `sessionModelGet`, `sessionModelSet`, `upload`. In each: replace `payload as XxxPayload` with `parseControlPayload(MSG.xxx, payload)` + the `if (!input/!i) return errorPayload("invalid-payload", …)` guard; keep the existing semantic checks and the `control.*` call verbatim. `prompt` becomes:
```ts
    case MSG.prompt: {
      const input = parseControlPayload(MSG.prompt, payload);
      if (!input) return errorPayload("invalid-payload", `${MSG.prompt}: malformed payload`);
      return await control.prompt(input);
    }
```

After the edits, remove any now-unused single `type XxxPayload` imports that are no longer referenced (tsc under `noUnusedLocals`, if enabled, will flag them; otherwise leave them — do not remove imports still used elsewhere). Do NOT touch `dispatchControlEvent` (lines 393-409, the downward terminal-event path — out of scope).

- [ ] **Step 4: Run tests to verify green**

Run: `bun test tests/unit/packages/channel-relay/control-bridge.test.ts`
Expected: PASS (existing tests + 3 new).

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git checkout -- packages/relay-protocol/dist 2>/dev/null || true
git add packages/channel-relay/src/control-bridge.ts tests/unit/packages/channel-relay/control-bridge.test.ts
git commit -m "feat(channel-relay): validate control-RPC payloads at the connector boundary"
```

---

### Task 4: Boundary B — validate instance events in the hub's onEvent

**Files:**
- Modify: `packages/relay/src/server.ts:145-217` (the `onEvent` handler)
- Test: `tests/unit/packages/relay/runtime-fanout.test.ts` (extend)

**Interfaces:**
- Consumes: `validControlEvent` (now exported from `relay-protocol`, Task 2) and the existing `logger` in scope (a `RelayLogger` from Track 1, already used at `server.ts:216`).
- Produces: malformed instance events are dropped (not broadcast, not persisted) and logged as `relay.event.invalid`.

- [ ] **Step 1: Write the failing test**

The suite already has a `fire(event)` helper that invokes `onEvent` directly (see `runtime-fanout.test.ts` top). Add a test that a malformed event is dropped and does not reach the web socket or the DB:

```ts
test("boundary B: a malformed control event is dropped, not broadcast or persisted", async () => {
  const runtime = await seeded();
  const web = new FakeSocket();
  runtime.webGateway.register("a1", web as never);
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  // turn-finished missing the required `sessionAlias` (and `ok`) → invalid shape.
  fire({ type: "turn-finished", chatKey: "relay:a1" });

  expect(web.sent.length).toBe(0); // not broadcast
  const history = runtime.messages.listBySession("a1", "i1", "backend", { limit: 10 });
  expect(history.messages.length).toBe(0); // not persisted
});
```

If `listBySession`'s exact signature differs, mirror the call already used elsewhere in the relay suite (`server.ts:205` calls `messages.listBySession(accountId, instanceId, event.sessionAlias, { limit: 1 })`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay/runtime-fanout.test.ts`
Expected: FAIL — the malformed event is currently broadcast (`web.sent.length` is 1), because `onEvent` casts `as ControlEventDto` with no validation.

- [ ] **Step 3: Add the validation guard in `onEvent`**

In `packages/relay/src/server.ts`, add `validControlEvent` to the `@ganglion/xacpx-relay-protocol` import. Then in the `onEvent` handler, replace the unchecked cast at line 151:

```ts
        if (envelope.type === MSG.instanceEvent) {
          const event = (envelope.payload as InstanceEventPayload).event as ControlEventDto;
```

with a validation gate that drops + logs malformed events before any broadcast/persist:

```ts
        if (envelope.type === MSG.instanceEvent) {
          const raw = (envelope.payload as InstanceEventPayload | undefined)?.event;
          if (!validControlEvent(raw)) {
            // A malformed event from a buggy/hostile connector must not broadcast to
            // browsers or seed history. Drop it; log type + instanceId only (no payload).
            logger.debug("relay.event.invalid", "dropped malformed instance event", {
              instanceId,
              eventType: typeof raw === "object" && raw !== null ? String((raw as { type?: unknown }).type) : "(none)",
            });
            return;
          }
          const event = raw as ControlEventDto;
```

Leave the rest of the `onEvent` body (the `event.type === "turn-started"` chain) unchanged — it now runs only on validated events. The outer `try/catch` (persist_failed) stays.

- [ ] **Step 4: Run tests to verify green**

Run: `bun test tests/unit/packages/relay/runtime-fanout.test.ts`
Expected: PASS (existing broadcast test + the new drop test). The existing "control events broadcast…" test still passes because its events are well-formed.

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git checkout -- packages/relay-protocol/dist 2>/dev/null || true
git add packages/relay/src/server.ts tests/unit/packages/relay/runtime-fanout.test.ts
git commit -m "feat(relay): validate inbound instance events, drop malformed frames"
```

---

### Task 5: Boundary C — validate the three persisted RPCs in the hub HTTP route

**Files:**
- Modify: `packages/relay/src/http/app.ts:298-366` (the `/api/instances/:id/rpc` handler)
- Test: `tests/unit/packages/relay/http-app.test.ts` (extend)

**Interfaces:**
- Consumes: `parseControlPayload` (Task 2).
- Produces: a malformed `prompt` / `commandExecute` / `upload` returns HTTP 400 `{ error: { code: "invalid-payload", ... } }` before any `messages.append`, so a bad frame cannot poison history.

**Note on ordering:** `prompt` and `commandExecute` are chat-scoped — the handler stamps `chatKey`/`senderId`/`isOwner` at lines 315-322 BEFORE this validation runs, so the full payload (including the server-stamped fields the validators require) is present. `upload` is not chat-scoped; its validator needs no stamped fields. Validate AFTER the stamp block, at the top of the existing `try`.

- [ ] **Step 1: Write the failing test**

Extend `tests/unit/packages/relay/http-app.test.ts`. Mirror the harness the file already uses to build the Hono app + an authenticated session (copy an existing `/rpc` test's setup). Add:

```ts
test("boundary C: malformed prompt returns 400 and persists nothing", async () => {
  // ...reuse the file's existing app + authed-cookie setup + a registered instance...
  const res = await app.request(`/api/instances/${instanceId}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: authCookie },
    body: JSON.stringify({ type: "control.prompt", payload: { sessionAlias: 123 /* wrong type */ } }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid-payload");
  // history for the session is still empty
  const history = runtime.messages.listBySession(account.id, instanceId, "s", { limit: 10 });
  expect(history.messages.length).toBe(0);
});
```

Adjust variable names (`app`, `instanceId`, `authCookie`, `account`, `runtime`) to match the existing test setup in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay/http-app.test.ts`
Expected: FAIL — currently a malformed prompt is forwarded (or 500s), not a clean 400.

- [ ] **Step 3: Add validation at the top of the `try`**

In `packages/relay/src/http/app.ts`, add `parseControlPayload` to the `@ganglion/xacpx-relay-protocol` import. Then, immediately after the stamp block (after line 322, before the existing `try {` at line 323 — or as the first statements inside the `try`), add a shape gate for the three persisted types:

```ts
      // Shape-validate the RPCs the hub persists BEFORE forwarding, so a malformed frame
      // can't poison history ahead of the connector's own boundary check. Error body carries
      // no payload contents (privacy). Other control.* types are validated at the connector.
      if (body.type === MSG.prompt && !parseControlPayload(MSG.prompt, payload)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      if (body.type === MSG.commandExecute && !parseControlPayload(MSG.commandExecute, payload)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      if (body.type === MSG.upload && !parseControlPayload(MSG.upload, payload)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
```

Place these lines so they run before the `MSG.upload` size check (line 324) and before the `messages.append` at line 350. Keep the existing upload size check and prompt-persist logic as-is (they now run only on shape-valid payloads).

- [ ] **Step 4: Run tests to verify green**

Run: `bun test tests/unit/packages/relay/http-app.test.ts`
Expected: PASS (existing `/rpc` tests + the new 400 test). Existing happy-path `/rpc` tests still pass because their payloads are well-formed.

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git checkout -- packages/relay-protocol/dist 2>/dev/null || true
git add packages/relay/src/http/app.ts tests/unit/packages/relay/http-app.test.ts
git commit -m "feat(relay): shape-validate persisted RPCs in the hub HTTP route"
```

---

## Final Verification (after all tasks)

- [ ] Root typecheck: `npx tsc --noEmit` → 0 errors.
- [ ] Per-file test sweep (CI-equivalent, per-file to avoid state-leak false failures):
  - `bun test tests/unit/packages/relay-protocol/validate-primitives.test.ts`
  - `bun test tests/unit/packages/relay-protocol/payload-validators.test.ts`
  - `bun test tests/unit/packages/relay-protocol/web-dtos.test.ts`
  - `bun test tests/unit/packages/channel-relay/control-bridge.test.ts`
  - `bun test tests/unit/packages/relay/runtime-fanout.test.ts`
  - `bun test tests/unit/packages/relay/http-app.test.ts`
- [ ] Revert any false dist diff: `git checkout -- packages/relay-protocol/dist`.
- [ ] Confirm no payload values appear in any log/error added (grep the diff for the rejection sites; they carry only `type`/`instanceId`/`reason`).
- [ ] Protocol version unchanged (`packages/relay-protocol/package.json` still `0.1.11`); no payload structure changed.

## Notes for the executor

- **Publishing is deferred** (user decision): this branch merges code only; real-world effect needs a core+relay+channel-relay beta, batched with later tracks. Do not bump versions or publish.
- **Do not** introduce any dependency, change payload structures, or touch the envelope shallow-check.
- **Privacy is a hard gate** — a reviewer will reject any rejection log/error that embeds a payload value.
