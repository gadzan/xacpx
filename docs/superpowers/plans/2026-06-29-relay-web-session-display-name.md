# Edit Session Display Name in relay-web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user rename a session from the relay-web sidebar's `⋯` menu, where the new name is a cosmetic display label that never changes session identity.

**Architecture:** Add an optional `display_name` to the session state record, thread it through `ResolvedSession` → `ControlSessionInfo` → `SessionDto`, set it via a new `control.sessions.rename` control RPC. This mirrors the existing per-session `model` override path end-to-end. The web renders `displayName || alias` and edits inline.

**Tech Stack:** TypeScript, Bun (core tests), Vue 3 + Pinia + vitest (relay-web), tsc (relay-protocol build).

## Global Constraints

- **`alias` stays the immutable identity.** Never rename the `state.sessions` key, the `/use` handle, or the `transportSession`. The display name is a separate field only.
- **Display name is relay-web-only.** Do NOT surface it in WeChat `/sessions` or accept it in `/use`. WeChat behavior is unchanged.
- **No uniqueness / collision handling.** It is a pure label; duplicates are allowed.
- **Empty (after trim) clears the override.** UI then falls back to showing `alias`.
- **State field is snake_case (`display_name`); DTO/ResolvedSession fields are camelCase (`displayName`).**
- **relay-protocol must be built with `tsc`, not the bun barrel build** (bun tree-shakes `export *` barrels to empty → runtime "no export named MSG").
- **i18n keys must exist in BOTH `en.ts` and `zh-CN.ts`** or `i18n-parity.test.ts` fails.
- **Core/control unit tests run under `bun test`; relay-web tests run under `npx vitest run` (never `bun test`).**

---

### Task 1: Core state field + `setDisplayName` on SessionService

**Files:**
- Modify: `src/state/types.ts` (add `display_name?` to `LogicalSession`)
- Modify: `src/transport/types.ts` (add `displayName?` to `ResolvedSession`)
- Modify: `src/sessions/session-service.ts` (`toResolvedSession` mapping + new `setDisplayName` method)
- Test: `tests/unit/sessions/session-display-name.test.ts` (new)

**Interfaces:**
- Produces: `SessionService.setDisplayName(alias: string, name?: string): Promise<void>` — `alias` is the internal (channel-scoped) state key. Trims `name`; sets `display_name` when non-empty, deletes it when empty/undefined.
- Produces: `ResolvedSession.displayName?: string` — populated by `toResolvedSession` from `session.display_name`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sessions/session-display-name.test.ts`:

```typescript
import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import { setLocale } from "../../../src/i18n";

beforeAll(() => {
  setLocale("zh");
});

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

class MemoryStateStore implements Pick<StateStore, "save"> {
  public savedStates: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }
}

test("a fresh session has no displayName", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const session = await service.createSession("api-fix", "codex", "backend");
  expect(session.displayName).toBeUndefined();
});

test("setDisplayName sets the display label, leaving alias untouched", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setDisplayName("api-fix", "  API hotfix  ");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.alias).toBe("api-fix");
  expect(resolved?.displayName).toBe("API hotfix");
});

test("setDisplayName with an empty value clears the override", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setDisplayName("api-fix", "API hotfix");
  await service.setDisplayName("api-fix", "   ");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.displayName).toBeUndefined();
});

test("setDisplayName throws for an unknown session", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await expect(service.setDisplayName("missing", "x")).rejects.toThrow('session "missing" does not exist');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/sessions/session-display-name.test.ts`
Expected: FAIL — `setDisplayName` is not a function / `displayName` undefined.

- [ ] **Step 3: Add `display_name` to the state record**

In `src/state/types.ts`, inside `interface LogicalSession`, add after the `model?: string;` line:

```typescript
  /** Per-session cosmetic display label shown in the relay-web dashboard only.
   *  Never affects identity (`alias`), `/use`, or the transport session. Cleared → UI shows alias. */
  display_name?: string;
```

- [ ] **Step 4: Add `displayName` to `ResolvedSession`**

In `src/transport/types.ts`, inside `interface ResolvedSession`, add after the `model?: string;` block (before `workspace: string;`):

```typescript
  /** Cosmetic per-session display label (relay-web only). Mirrors LogicalSession.display_name;
   *  undefined when unset. Does not affect identity or transport. */
  displayName?: string;
```

- [ ] **Step 5: Map `displayName` in `toResolvedSession`**

In `src/sessions/session-service.ts`, in the object returned by `private toResolvedSession`, add after the `model: session.model ?? agentConfig.model,` line:

```typescript
      displayName: session.display_name,
```

- [ ] **Step 6: Add the `setDisplayName` method**

In `src/sessions/session-service.ts`, immediately after the `async setSessionModel(...)` method, add:

```typescript
  /** Set (or clear) a session's relay-web display label. Identity (`alias`) is untouched. */
  async setDisplayName(alias: string, name?: string): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }

      const normalized = name?.trim();
      if (normalized) {
        session.display_name = normalized;
      } else {
        delete session.display_name;
      }

      session.last_used_at = new Date(this.now()).toISOString();
      await this.persist();
    });
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/unit/sessions/session-display-name.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/state/types.ts src/transport/types.ts src/sessions/session-service.ts tests/unit/sessions/session-display-name.test.ts
git commit -m "feat(sessions): add per-session display_name with setDisplayName"
```

---

### Task 2: control-service `setSessionDisplayName` + listSessions mapping

**Files:**
- Modify: `src/control/control-service.ts` (deps Pick, `ControlSessionInfo`, `listSessions` mapping, new method)
- Test: `tests/unit/control/control-service-display-name.test.ts` (new)

**Interfaces:**
- Consumes: `SessionService.setDisplayName(alias, name?)` from Task 1.
- Produces: `ControlService.setSessionDisplayName(chatKey: string, alias: string, displayName: string): Promise<void>` — resolves the chat-scoped display alias to its internal alias, then persists via `deps.sessions.setDisplayName`.
- Produces: `ControlSessionInfo.displayName?: string`, carried by `listSessions`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/control/control-service-display-name.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";

const session = {
  alias: "relay:internal-backend",
  agent: "codex",
  workspace: "w",
  transportSession: "t",
  cwd: "/c",
  displayName: "My label",
};

function makeDeps() {
  const calls: string[] = [];
  const deps = {
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) => `relay:internal-${alias}`,
      getSession: async (internalAlias: string) => (internalAlias === "relay:internal-backend" ? session : null),
      setDisplayName: async (alias: string, name?: string) => { calls.push(`persist:${alias}:${name ?? ""}`); },
      listAllResolvedSessions: () => [session],
    },
    activeTurns: { isActiveAnywhere: () => false },
    events: { emit: () => {} },
  };
  return { deps, calls };
}

test("setSessionDisplayName resolves the alias and persists the label", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await control.setSessionDisplayName("relay:acc", "backend", "My label");
  expect(calls).toEqual(["persist:relay:internal-backend:My label"]);
});

test("setSessionDisplayName throws when the session is not found", async () => {
  const { deps } = makeDeps();
  (deps.sessions as { getSession: unknown }).getSession = async () => null;
  const control = new ControlService(deps as never);
  await expect(control.setSessionDisplayName("relay:acc", "missing", "x")).rejects.toThrow("session not found");
});

test("listSessions carries displayName in display form", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const list = control.listSessions("relay:acc");
  expect(list[0]?.alias).toBe("internal-backend");
  expect(list[0]?.displayName).toBe("My label");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/control/control-service-display-name.test.ts`
Expected: FAIL — `setSessionDisplayName` not a function; `displayName` missing from list rows.

- [ ] **Step 3: Add `setDisplayName` to the deps Pick**

In `src/control/control-service.ts`, in `ControlServiceDeps`, change the `sessions` Pick union to include `setDisplayName`:

```typescript
  sessions: Pick<
    SessionService,
    "listAllResolvedSessions" | "removeSession" | "useSession" | "resolveAliasForChat" | "getSession" | "setSessionModel" | "setDisplayName"
  >;
```

- [ ] **Step 4: Add `displayName` to `ControlSessionInfo`**

In `src/control/control-service.ts`, in `interface ControlSessionInfo`, add after the `agentCommand?: string;` field:

```typescript
  /** Cosmetic relay-web display label; omitted when unset so the wire stays minimal. */
  displayName?: string;
```

- [ ] **Step 5: Carry `displayName` in `listSessions`**

In `listSessions`, in the `.map(...)` object, add after the `...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),` line:

```typescript
        ...(session.displayName ? { displayName: session.displayName } : {}),
```

- [ ] **Step 6: Add the `setSessionDisplayName` method**

In `src/control/control-service.ts`, immediately after the `async setSessionModel(...)` method, add:

```typescript
  /** Set (or clear) a session's relay-web display label and persist it. */
  async setSessionDisplayName(chatKey: string, alias: string, displayName: string): Promise<void> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    await this.deps.sessions.setDisplayName(session.alias, displayName);
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/unit/control/control-service-display-name.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Typecheck (confirms main.ts wiring still satisfies the widened Pick)**

Run: `npx tsc --noEmit`
Expected: no errors. (`deps.sessions` in `src/main.ts:776` is the full `SessionService`, so `setDisplayName` is already available — no wiring change needed.)

- [ ] **Step 9: Commit**

```bash
git add src/control/control-service.ts tests/unit/control/control-service-display-name.test.ts
git commit -m "feat(control): setSessionDisplayName + displayName in listSessions"
```

---

### Task 3: relay-protocol — `MSG.sessionsRename`, payload, and `SessionDto.displayName`

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts` (MSG constant, payload, result)
- Modify: `packages/relay-protocol/src/dtos.ts` (`SessionDto.displayName`)
- Test: `packages/relay-protocol/` build verification (no unit test framework here — verify via tsc build + the connector/web tests downstream)

**Interfaces:**
- Produces: `MSG.sessionsRename = "control.sessions.rename"`.
- Produces: `interface SessionsRenamePayload { chatKey: string; alias: string; displayName: string }` and `interface SessionsRenameResult { ok: true }`.
- Produces: `SessionDto.displayName?: string`.

- [ ] **Step 1: Add the MSG constant**

In `packages/relay-protocol/src/messages.ts`, in the `MSG` object, add after the `sessionsUnarchive: "control.sessions.unarchive",` line:

```typescript
  sessionsRename: "control.sessions.rename",
```

- [ ] **Step 2: Add the payload + result types**

In `packages/relay-protocol/src/messages.ts`, immediately after the `SessionsUnarchivePayload` interface, add:

```typescript
export interface SessionsRenamePayload {
  /** Server-stamped `relay:<accountId>`; scopes the alias to that channel. */
  chatKey: string;
  alias: string;
  /** New display label; empty string clears the override (UI falls back to alias). */
  displayName: string;
}
export interface SessionsRenameResult {
  ok: true;
}
```

- [ ] **Step 3: Add `displayName` to `SessionDto`**

In `packages/relay-protocol/src/dtos.ts`, in `interface SessionDto`, add after the `agentCommand?: string;` field (before the closing brace):

```typescript
  /** Cosmetic display label set from relay-web. When present, the web shows this instead of
   *  `alias`. Identity stays `alias`. Omitted when unset. */
  displayName?: string;
```

- [ ] **Step 4: Build the protocol package with tsc (NOT bun)**

Run: `cd packages/relay-protocol && npx tsc -p . && cd ../..`
Expected: exits 0; `packages/relay-protocol/dist/messages.js` contains `sessionsRename: "control.sessions.rename"`.

Verify:
Run: `grep -r "control.sessions.rename" packages/relay-protocol/dist`
Expected: at least one match in the built output.

- [ ] **Step 5: Typecheck the workspace**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/src/dtos.ts packages/relay-protocol/dist
git commit -m "feat(relay-protocol): add sessionsRename RPC + SessionDto.displayName"
```

---

### Task 4: connector — dispatch `MSG.sessionsRename`

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts` (import payload type + new `case`)
- Test: `packages/channel-relay/` — add/extend a control-bridge dispatch test if one exists; otherwise verify via typecheck + a targeted assertion test (below)

**Interfaces:**
- Consumes: `MSG.sessionsRename`, `SessionsRenamePayload` from Task 3; `ControlService.setSessionDisplayName` from Task 2.

- [ ] **Step 1: Locate the existing control-bridge test (if any)**

Run: `ls packages/channel-relay/src/__tests__ 2>/dev/null; grep -rln "sessionsArchive\|control-bridge\|handleControl" packages/channel-relay`
Expected: identifies the dispatch test file (e.g. a `control-bridge.test.ts`) or confirms none exists.

- [ ] **Step 2: Write the failing test**

If a control-bridge dispatch test exists, add a case mirroring its `sessionsArchive` test. If none exists, create `packages/channel-relay/src/__tests__/control-bridge-rename.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MSG } from "@ganglion/xacpx-relay-protocol";
import { handleControlMessage } from "../control-bridge";

describe("control-bridge sessionsRename", () => {
  it("dispatches to control.setSessionDisplayName and returns ok", async () => {
    const calls: unknown[] = [];
    const control = {
      setSessionDisplayName: async (chatKey: string, alias: string, displayName: string) => {
        calls.push([chatKey, alias, displayName]);
      },
    } as never;
    const res = await handleControlMessage(control, MSG.sessionsRename, {
      chatKey: "relay:acc",
      alias: "backend",
      displayName: "My label",
    });
    expect(calls).toEqual([["relay:acc", "backend", "My label"]]);
    expect(res).toEqual({ ok: true });
  });
});
```

> NOTE: Adjust the imported dispatch function name (`handleControlMessage`) and call shape to match the actual exported entry point found in Step 1. If the bridge has no exported pure dispatch function, instead add the assertion into the existing test harness following its established pattern.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/channel-relay && npx vitest run src/__tests__/control-bridge-rename.test.ts; cd ../..`
Expected: FAIL — unhandled MSG type (falls through to the default error payload).

- [ ] **Step 4: Add the import**

In `packages/channel-relay/src/control-bridge.ts`, in the type import block from `@ganglion/xacpx-relay-protocol`, add after `type SessionsUnarchivePayload,`:

```typescript
  type SessionsRenamePayload,
```

- [ ] **Step 5: Add the dispatch case**

In `packages/channel-relay/src/control-bridge.ts`, immediately after the `case MSG.sessionsUnarchive: { ... }` block, add:

```typescript
    case MSG.sessionsRename: {
      const input = payload as SessionsRenamePayload;
      if (!input.alias) return errorPayload("bad-request", "alias is required");
      await control.setSessionDisplayName(input.chatKey, input.alias, input.displayName ?? "");
      return { ok: true };
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/channel-relay && npx vitest run src/__tests__/control-bridge-rename.test.ts; cd ../..`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/channel-relay/src/control-bridge.ts packages/channel-relay/src/__tests__/control-bridge-rename.test.ts
git commit -m "feat(connector): dispatch control.sessions.rename to setSessionDisplayName"
```

---

### Task 5: relay-web store — `renameSession`

**Files:**
- Modify: `packages/relay-web/src/stores/instances.ts` (new action + export)
- Test: `packages/relay-web/src/__tests__/instances-rename.test.ts` (new)

**Interfaces:**
- Produces: `renameSession(instanceId: string, alias: string, displayName: string): Promise<void>` — calls `api.rpc(instanceId, "control.sessions.rename", { alias, displayName })`, then optimistically updates the matching `SessionRow.displayName` (sets to trimmed value, or `undefined` when empty).

- [ ] **Step 1: Write the failing test**

Create `packages/relay-web/src/__tests__/instances-rename.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";

describe("instances renameSession", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("calls control.sessions.rename and optimistically sets displayName", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }],
    }] as never;
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ ok: true } as never);
    await store.renameSession("i1", "backend", "  My label  ");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.rename", { alias: "backend", displayName: "My label" });
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("My label");
  });

  it("clears displayName when given an empty value", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    vi.spyOn(api, "rpc").mockResolvedValue({ ok: true } as never);
    await store.renameSession("i1", "backend", "   ");
    expect(store.instances[0]!.sessions[0]!.displayName).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/instances-rename.test.ts; cd ../..`
Expected: FAIL — `store.renameSession` is not a function.

- [ ] **Step 3: Add the `renameSession` action**

In `packages/relay-web/src/stores/instances.ts`, immediately after the `unarchiveSession` function, add:

```typescript
  // The display label lives in core session state; set it via control RPC, then optimistically
  // update the local row so the sidebar reflects the new name without a reload. Empty → cleared.
  async function renameSession(instanceId: string, alias: string, displayName: string): Promise<void> {
    const trimmed = displayName.trim();
    await api.rpc(instanceId, "control.sessions.rename", { alias, displayName: trimmed });
    const row = byId(instanceId)?.sessions.find((s) => s.alias === alias);
    if (row) row.displayName = trimmed || undefined;
  }
```

- [ ] **Step 4: Export it from the store**

In the store's `return { ... }` statement, add `renameSession` to the list (next to `removeSession, archiveSession, unarchiveSession`):

```typescript
  removeSession, archiveSession, unarchiveSession, renameSession, renameInstance, applyEvent, byId };
```

> NOTE: copy the exact existing return line and insert `renameSession,` — do not retype the whole return object from memory.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/instances-rename.test.ts; cd ../..`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/stores/instances.ts packages/relay-web/src/__tests__/instances-rename.test.ts
git commit -m "feat(relay-web): renameSession store action"
```

---

### Task 6: relay-web sidebar — Rename menu item + inline editor + display label

**Files:**
- Modify: `packages/relay-web/src/components/InstanceTree.vue` (script state, menu item, name span → inline input)
- Modify: `packages/relay-web/src/i18n/messages/en.ts` and `zh-CN.ts` (new keys)
- Test: `packages/relay-web/src/__tests__/instancetree-rename.test.ts` (new)

**Interfaces:**
- Consumes: `store.renameSession(instanceId, alias, displayName)` from Task 5.
- Consumes: i18n keys `instance.renameSession`, `instance.renamePlaceholder`.

- [ ] **Step 1: Add i18n keys (both locales)**

In `packages/relay-web/src/i18n/messages/en.ts`, in the `instance` block (near `archiveSession`), add:

```typescript
    renameSession: "Rename",
    renamePlaceholder: "Session name",
```

In `packages/relay-web/src/i18n/messages/zh-CN.ts`, in the `instance` block (near `archiveSession`), add:

```typescript
    renameSession: "重命名",
    renamePlaceholder: "会话名称",
```

- [ ] **Step 2: Write the failing component test**

Create `packages/relay-web/src/__tests__/instancetree-rename.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";

const instance = (sessions: unknown[] = []) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded: true,
  agents: [], workspaces: [], agentCatalog: [],
});

describe("InstanceTree rename", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("renders displayName instead of alias when present", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "API hotfix" }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.text()).toContain("API hotfix");
    expect(w.text()).not.toContain("backend");
  });

  it("opens an inline input from the menu and commits via renameSession on Enter", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const rename = vi.spyOn(store, "renameSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="action-rename"]').trigger("click");

    const input = w.find('[data-test="rename-input"]');
    expect(input.exists()).toBe(true);
    await input.setValue("API hotfix");
    await input.trigger("keydown.enter");

    expect(rename).toHaveBeenCalledWith("i1", "backend", "API hotfix");
  });

  it("cancels on Escape without calling renameSession", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const rename = vi.spyOn(store, "renameSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="action-rename"]').trigger("click");
    const input = w.find('[data-test="rename-input"]');
    await input.setValue("nope");
    await input.trigger("keydown.escape");

    expect(rename).not.toHaveBeenCalled();
    expect(w.find('[data-test="rename-input"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/instancetree-rename.test.ts; cd ../..`
Expected: FAIL — no `[data-test="action-rename"]` / `[data-test="rename-input"]`; alias still shown.

- [ ] **Step 4: Add rename state + handlers to the script**

In `packages/relay-web/src/components/InstanceTree.vue` `<script setup>`, after the `openMenuFor` ref declaration (the `// Desktop overflow (⋯) menu open-state` block), add:

```typescript
// Inline rename: the row currently being renamed, keyed `${instanceId}:${alias}`, plus its draft.
const renamingFor = ref<string | null>(null);
const renameDraft = ref("");

function startRename(id: string, s: { alias: string; displayName?: string }) {
  openMenuFor.value = null;
  renamingFor.value = `${id}:${s.alias}`;
  renameDraft.value = s.displayName ?? s.alias;
}
function commitRename(id: string, alias: string) {
  if (renamingFor.value !== `${id}:${alias}`) return; // already cancelled
  const next = renameDraft.value.trim();
  renamingFor.value = null;
  void store.renameSession(id, alias, next).catch(() => {});
}
function cancelRename() {
  renamingFor.value = null;
}
```

- [ ] **Step 5: Add the Rename item to the overflow menu**

In the `⋯` dropdown `<div v-if="inst.online && openMenuFor === ...">`, add as the FIRST button (before the archive button):

```html
            <button data-test="action-rename" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="startRename(inst.id, s)"><Pencil :size="12" />{{ $t("instance.renameSession") }}</button>
```

Add `Pencil` to the lucide import at the top:

```typescript
import { Archive, ChevronDown, ChevronRight, Loader2, MoreHorizontal, Pencil, Plus, Settings2, Trash2 } from "lucide-vue-next";
```

- [ ] **Step 6: Swap the name span for an inline input when renaming**

Find the session name span (the one rendering `{{ s.alias }}` with the `:class="s.archived ? 'text-fg-muted' : (isSelected(...) ? 'font-semibold text-accent' : 'text-fg')"` binding). Replace that single `<span>...{{ s.alias }}</span>` with:

```html
                <input v-if="renamingFor === `${inst.id}:${s.alias}`" data-test="rename-input"
                       v-model="renameDraft" :maxlength="60" :placeholder="$t('instance.renamePlaceholder')"
                       class="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-px text-[13px] text-fg outline-none"
                       @click.stop @keydown.enter.prevent="commitRename(inst.id, s.alias)"
                       @keydown.escape.prevent="cancelRename" @blur="commitRename(inst.id, s.alias)"
                       v-focus />
                <span v-else class="truncate text-[13px]"
                      :class="s.archived ? 'text-fg-muted' : (isSelected(inst.id, s.alias) ? 'font-semibold text-accent' : 'text-fg')">{{ s.displayName || s.alias }}</span>
```

> NOTE: preserve the original span's existing utility classes (copy them from the file — the `truncate text-[13px]` shown here is illustrative; match what's actually there). The only content change is `{{ s.alias }}` → `{{ s.displayName || s.alias }}` and wrapping it in the `v-else` branch.

- [ ] **Step 7: Add the `v-focus` directive (autofocus the input)**

In `<script setup>`, add near the other top-level declarations:

```typescript
// Local directive: focus + select an element on mount (the rename input).
const vFocus = {
  mounted(el: HTMLInputElement) { el.focus(); el.select(); },
};
```

> NOTE: If the project already exposes a shared focus directive, use that instead of declaring a local one. Check with: `grep -rn "vFocus\|v-focus\|autofocus directive" packages/relay-web/src`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/instancetree-rename.test.ts; cd ../..`
Expected: PASS (3 tests).

- [ ] **Step 9: Run the i18n parity test**

Run: `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts; cd ../..`
Expected: PASS (both locales have the new keys).

- [ ] **Step 10: Commit**

```bash
git add packages/relay-web/src/components/InstanceTree.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/instancetree-rename.test.ts
git commit -m "feat(relay-web): inline session rename from the sidebar menu"
```

---

### Task 7: relay-web ChatPane header shows display name

**Files:**
- Modify: `packages/relay-web/src/components/ChatPane.vue` (header `<h1>`)
- Test: `packages/relay-web/src/__tests__/chatpane.test.ts` (extend) OR `packages/relay-web/src/__tests__/chatpane-displayname.test.ts` (new)

**Interfaces:**
- Consumes: `currentSession.displayName` (already a computed in ChatPane resolving the row by `chat.sessionAlias`).

- [ ] **Step 1: Write the failing test**

Create `packages/relay-web/src/__tests__/chatpane-displayname.test.ts`. First inspect `chatpane.test.ts` to copy its exact mount/store-setup harness (chat store needs `instanceId` + `sessionAlias` set, and the instances store needs a matching session row):

Run: `sed -n '1,60p' packages/relay-web/src/__tests__/chatpane.test.ts`

Then author the test using that harness, asserting the header shows the display name:

```typescript
// Using the same mount + store setup as chatpane.test.ts:
//  - set chat.instanceId = "i1", chat.sessionAlias = "backend"
//  - seed instances store with a session row { alias: "backend", ..., displayName: "API hotfix" }
// Assert:
//   expect(w.find("h1").text()).toBe("API hotfix");
```

> NOTE: This step has a code block that depends on the existing ChatPane test harness shape, which the implementer must read first (the chat/instances store seeding differs per project). Mirror `chatpane.test.ts` exactly, only changing the row to include `displayName` and the assertion to the header text.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/chatpane-displayname.test.ts; cd ../..`
Expected: FAIL — header shows `backend`, not `API hotfix`.

- [ ] **Step 3: Update the header binding**

In `packages/relay-web/src/components/ChatPane.vue`, change the header `<h1>`:

```html
        <h1 class="hidden lg:block text-[14px] font-semibold tracking-tight text-fg">{{ currentSession?.displayName || chat.sessionAlias }}</h1>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/chatpane-displayname.test.ts; cd ../..`
Expected: PASS.

- [ ] **Step 5: Run the full relay-web suite + typecheck**

Run: `cd packages/relay-web && npx vitest run; cd ../..`
Expected: PASS (no regressions).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/components/ChatPane.vue packages/relay-web/src/__tests__/chatpane-displayname.test.ts
git commit -m "feat(relay-web): show session display name in the chat header"
```

---

### Task 8: Full verification + docs touch

**Files:**
- Modify: `docs/relay-web-module.md` (one line documenting the rename affordance) — only if the file documents session row actions.

- [ ] **Step 1: Run the complete core suite**

Run: `npm test`
Expected: typecheck passes, all unit tests pass.

- [ ] **Step 2: Run the complete relay-web suite**

Run: `cd packages/relay-web && npx vitest run; cd ../..`
Expected: all pass.

- [ ] **Step 3: Document the affordance (if applicable)**

Run: `grep -n "archive\|delete\|session row\|overflow" docs/relay-web-module.md`
If the doc lists session-row actions, add a line noting: "Rename (⋯ menu) sets a cosmetic per-session display label (`display_name`); identity/alias is unchanged; web-only." If the doc has no such section, skip this step.

- [ ] **Step 4: Commit (if docs changed)**

```bash
git add docs/relay-web-module.md
git commit -m "docs: note session rename affordance in relay-web"
```

---

## Self-Review Notes

**Spec coverage:**
- Display label semantics, empty-clears, no-uniqueness → Task 1 (`setDisplayName`).
- Web-only scope → no WeChat handler touched; `listSessions` is the relay/control path only.
- Threading state → DTO → Tasks 1, 2, 3.
- `control.sessions.rename` RPC → Tasks 3 (define) + 4 (dispatch).
- Sidebar `⋯` menu inline edit → Task 6.
- ChatPane header display → Task 7.
- Validation (trim, 60-char cap) → Task 1 (trim) + Task 6 (`:maxlength="60"`).
- Build caveats (tsc for protocol) → Task 3 Step 4; connector repackage/restart is a deployment step noted below.
- Tests across core/control/connector/web → each task's test step.

**Deployment note (not a code task):** After merge, to run live the connector must be repackaged, reinstalled into the plugin home, and the console restarted — otherwise a stale connector tarball won't have `MSG.sessionsRename`. (Project memory: "sandbox connector from plugin home" + "bun barrel empty export".)

**Type consistency:** `display_name` (state) ↔ `displayName` (ResolvedSession, ControlSessionInfo, SessionDto, SessionRow). RPC method string `control.sessions.rename` matches `MSG.sessionsRename`. Store action `renameSession(instanceId, alias, displayName)` matches the component call site and its test.
