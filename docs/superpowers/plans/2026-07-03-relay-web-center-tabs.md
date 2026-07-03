# relay-web center multi-tab + session-list cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dashboard center column into a per-session tab strip (pinned Chat + closable, drag-reorderable file/diff/terminal tabs) and cap the left-rail session list at 10 per instance with show-more/collapse.

**Architecture:** A new `center-tabs` Pinia store holds per-session `{ tabs, activeId }`. `DashboardView` renders a `CenterTabStrip` plus panes: one always-mounted `ChatPane` (current session), one `FileViewer` per open file/diff tab, one `TerminalTab` per open terminal tab — all mounted while open, `v-show` only the current session's active tab (so terminals/scroll survive session and tab switches). `FileViewer` is decoupled from the single global `files.file` slot to per-instance props + return-based store reads. Tab reorder is pointer-based (mouse+touch).

**Tech Stack:** Vue 3 `<script setup>`, Pinia (setup stores), vue-i18n, Tailwind, lucide-vue-next, vitest + @vue/test-utils (jsdom). Tests run with `cd packages/relay-web && npx vitest run` (NOT bun test). Test files live in `packages/relay-web/src/__tests__/`.

## Global Constraints

- **No new dependencies.** Drag-reorder is vanilla Pointer Events (mirror `lib/use-swipe-actions.ts` / `lib/edge-swipe.ts`); relay-web artifacts must stay self-contained (no CDNs).
- **Typecheck must pass:** `cd packages/relay-web && npx vue-tsc --noEmit` rc=0.
- **Tests:** `cd packages/relay-web && npx vitest run` — all green. Add tests in `src/__tests__/`.
- **i18n parity:** every new key exists in BOTH `src/i18n/messages/en.ts` and `src/i18n/messages/zh-CN.ts` with identical placeholder names.
- **Chat is implicit** — never stored as a tab; `activeId === "chat"` means the chat pane shows. The chat tab is pinned first, non-closable, non-draggable; reorder never moves a tab before it.
- **One terminal per session** (tab id `"terminal"`); opening again focuses it.
- **Session key** is always `` `${instanceId}::${alias}` `` via a shared `sessionKey()` helper exported from the store.
- Keep existing behavior for anything not explicitly changed (session ordering, swipe actions, right-rail Files/Changes tab, mobile drawers).

---

### Task 1: `center-tabs` store

**Files:**
- Create: `packages/relay-web/src/stores/center-tabs.ts`
- Test: `packages/relay-web/src/__tests__/center-tabs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CenterTab =
    | { kind: "file"; id: string; path: string }
    | { kind: "diff"; id: string; path: string }
    | { kind: "terminal"; id: string };
  export function sessionKey(instanceId: string, alias: string): string; // `${instanceId}::${alias}`
  export const useCenterTabsStore: // setup store, returns:
  //   tabsFor(key): CenterTab[]        activeFor(key): string  (default "chat")
  //   openFile(key, path)   -> id = path,          activate
  //   openDiff(key, path)   -> id = "diff:"+path,  activate
  //   openTerminal(key)     -> id = "terminal",    activate
  //   setActive(key, id)
  //   closeTab(key, id)     -> remove; if it was active, activate left neighbor or "chat"
  //   reorder(key, draggedId, targetId) -> move dragged before target within the tab list
  //   clearSession(key)     -> delete the session's entry
  //   allOpenTabs(): { key: string; tab: CenterTab }[]  // flattened, for mounting every pane
  ```

**Behavior details:**
- `bySession = ref<Record<string, { tabs: CenterTab[]; activeId: string }>>({})`.
- `openFile/openDiff/openTerminal`: if a tab with that id exists, just activate it; else push a new tab and activate it. Never duplicate an id.
- `closeTab`: find index; remove it; if the removed tab was active, set active to `tabs[index-1]?.id ?? tabs[index]?.id ?? "chat"` (left neighbor, else the new tab at that index, else chat). If not active, leave active unchanged.
- `reorder(key, draggedId, targetId)`: no-op if either missing or equal; remove dragged, insert it at the current index of target (before it). All tabs are file/diff/terminal (chat isn't in the list), so no chat-guard needed here.
- Reactivity: mutate via reassigning `bySession.value = { ...bySession.value, [key]: next }` OR mutate nested arrays with `.value` writes that Vue tracks — prefer replacing the session object so getters recompute.
- `allOpenTabs()`: `Object.entries(bySession.value).flatMap(([key, s]) => s.tabs.map(tab => ({ key, tab })))`.

- [ ] **Step 1: Write failing tests** (`center-tabs.test.ts`, `import { setActivePinia, createPinia } from "pinia"`, `beforeEach(() => setActivePinia(createPinia()))`):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";

beforeEach(() => setActivePinia(createPinia()));
const K = sessionKey("i1", "s1");

describe("center-tabs store", () => {
  it("opens a file tab, dedupes by path, and activates it", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts");
    s.openFile(K, "a.ts"); // dedupe
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["a.ts"]);
    expect(s.activeFor(K)).toBe("a.ts");
  });

  it("diff and terminal ids are namespaced/fixed", () => {
    const s = useCenterTabsStore();
    s.openDiff(K, "a.ts");
    s.openTerminal(K);
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["diff:a.ts", "terminal"]);
    s.openTerminal(K); // one terminal per session
    expect(s.tabsFor(K).filter(t => t.kind === "terminal").length).toBe(1);
  });

  it("closing the active tab activates the left neighbor, else chat", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); // active = b.ts
    s.closeTab(K, "b.ts");
    expect(s.activeFor(K)).toBe("a.ts");
    s.closeTab(K, "a.ts");
    expect(s.activeFor(K)).toBe("chat");
    expect(s.tabsFor(K)).toEqual([]);
  });

  it("closing a non-active tab keeps the active one", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); s.setActive(K, "chat");
    s.closeTab(K, "a.ts");
    expect(s.activeFor(K)).toBe("chat");
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["b.ts"]);
  });

  it("reorder moves the dragged tab before the target", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); s.openFile(K, "c.ts");
    s.reorder(K, "c.ts", "a.ts"); // c before a
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  it("tabs are isolated per session and clearSession removes them", () => {
    const s = useCenterTabsStore();
    const K2 = sessionKey("i1", "s2");
    s.openFile(K, "a.ts"); s.openTerminal(K2);
    expect(s.tabsFor(K).length).toBe(1);
    expect(s.tabsFor(K2).length).toBe(1);
    expect(s.allOpenTabs().length).toBe(2);
    s.clearSession(K);
    expect(s.tabsFor(K)).toEqual([]);
    expect(s.allOpenTabs().length).toBe(1);
  });

  it("activeFor defaults to chat for an unknown session", () => {
    const s = useCenterTabsStore();
    expect(s.activeFor(sessionKey("x", "y"))).toBe("chat");
    expect(s.tabsFor(sessionKey("x", "y"))).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run src/__tests__/center-tabs.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `center-tabs.ts` per the interface + behavior above.
- [ ] **Step 4:** Run the test → PASS. `npx vue-tsc --noEmit` → rc=0.
- [ ] **Step 5:** Commit `feat(relay-web): center-tabs store (per-session tab sets)`.

---

### Task 2: Session-list cap in `InstanceTree.vue` (Feature 1)

**Files:**
- Modify: `packages/relay-web/src/components/InstanceTree.vue` (session `v-for` ~line 222; `orderedSessions` ~line 70)
- Modify: `packages/relay-web/src/i18n/messages/en.ts`, `zh-CN.ts` (add `instance.showMoreSessions`, `instance.collapseSessions`)
- Test: `packages/relay-web/src/__tests__/instancetree-session-cap.test.ts`

**Interfaces:**
- Consumes: existing `orderedSessions(inst.sessions)` (active first, archived last).
- Produces: nothing external.

**Behavior:**
- `const SESSION_CAP = 10;`
- Per-instance expand set: `const sessionsExpanded = ref<Set<string>>(new Set());` + `toggleSessions(id)`.
- `visibleSessions(inst)`: `const all = orderedSessions(inst.sessions); return sessionsExpanded.value.has(inst.id) ? all : all.slice(0, SESSION_CAP);`
- Below the session rows, when `orderedSessions(inst.sessions).length > SESSION_CAP`, render a button:
  - collapsed → `{{ $t("instance.showMoreSessions", { n: total - SESSION_CAP }) }}` (data-test `sessions-show-more`)
  - expanded → `{{ $t("instance.collapseSessions") }}` (data-test `sessions-collapse`)
  - `@click.stop="toggleSessions(inst.id)"`.
- Change the session `v-for` to iterate `visibleSessions(inst)` instead of `orderedSessions(inst.sessions)`.

**i18n:**
```
// en.ts  (instance: { ... })
showMoreSessions: "Show {n} more",
collapseSessions: "Collapse",
// zh-CN.ts
showMoreSessions: "再显示 {n} 个",
collapseSessions: "收起",
```

- [ ] **Step 1: Write failing test** (`instancetree-session-cap.test.ts`): mount `InstanceTree` with one instance of 13 sessions (expand the instance so rows show). Assert exactly 10 `[data-test="session-row"]` render and a `[data-test="sessions-show-more"]` exists whose text contains "3". Click it → 13 rows + `[data-test="sessions-collapse"]`. Click collapse → back to 10.
  - Check the actual session-row `data-test` in `InstanceTree.vue` and reuse it; if rows have no stable `data-test`, add `data-test="session-row"` to the row element in this task.
  - Mount pattern: follow the existing `src/__tests__/instancetree.test.ts` for store setup (`useInstancesStore`, set `instances`, `sessionsLoaded: true`, expand the instance).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the cap + button + i18n.
- [ ] **Step 4:** Run → PASS; `npx vue-tsc --noEmit` rc=0; also run `src/__tests__/instancetree.test.ts` + `instancetree-rename.test.ts` to confirm no regression.
- [ ] **Step 5:** Commit `feat(relay-web): cap session list at 10 per instance with show-more/collapse`.

---

### Task 3: Return-based file/diff reads in `files.ts`

**Files:**
- Modify: `packages/relay-web/src/stores/files.ts`
- Test: extend `packages/relay-web/src/__tests__/files.test.ts`

**Interfaces:**
- Produces:
  ```ts
  readFile(instanceId: string, workspace: string, path: string): Promise<FsReadResult>
  readDiff(instanceId: string, workspace: string, path?: string): Promise<FsDiffResult>
  ```
  Both call `api.rpc` (`control.fs.read` / `control.fs.diff`) and RETURN the unwrapped result (throw on error payload) WITHOUT mutating any global store field (`file`, `diff`, `diffPath`, `error`, `loading`). These are for the tab panes to load their own content independently.

- [ ] **Step 1: Write failing tests** in `files.test.ts`:
```ts
it("readFile returns content without touching the global file slot", async () => {
  const s = useFilesStore();
  rpc.mockResolvedValueOnce({ workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false });
  const r = await s.readFile("i1", "ws", "a.ts");
  expect(r.content).toBe("x");
  expect(s.file).toBeNull(); // global slot untouched
});
it("readDiff returns a diff without touching global diff state", async () => {
  const s = useFilesStore();
  rpc.mockResolvedValueOnce({ workspace: "ws", files: [], diff: "@@", truncated: false });
  const r = await s.readDiff("i1", "ws", "a.ts");
  expect(r.diff).toBe("@@");
  expect(s.diff).toBeNull();
  expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws", path: "a.ts" });
});
```
(Match the existing `files.test.ts` rpc-mock harness — it uses a module `rpc` mock.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `readFile`/`readDiff` (thin: `unwrap(await api.rpc(...))`, omit `path` from the diff payload when undefined, mirroring `loadDiff`). Add both to the store's returned object.
- [ ] **Step 4:** Run → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 5:** Commit `feat(relay-web): return-based readFile/readDiff (no global slot mutation)`.

---

### Task 4: Decouple `FileViewer.vue` to props + own content

**Files:**
- Modify: `packages/relay-web/src/components/FileViewer.vue`
- Test: `packages/relay-web/src/__tests__/fileviewer.test.ts` (extend) + keep `files-i18n.test.ts` green

**Interfaces:**
- Consumes: `files.readFile`, `files.readDiff` (Task 3).
- Produces (props):
  ```ts
  defineProps<{ instanceId: string; workspace: string; path?: string; diffPath?: string }>()
  // exactly one of path / diffPath is set. Emits: (e: "close") and (e: "back").
  ```

**Behavior:**
- Replace reads of `files.file`/`files.diff`/`files.diffPath` with LOCAL refs `file`, `diff`, `loading`, `error`.
- On mount and when `[instanceId, workspace, path, diffPath]` change: if `path` → `file.value = await files.readFile(...)`, `diff.value = null`; else if `diffPath` → `diff.value = await files.readDiff(instanceId, workspace, diffPath)`, `file.value = null`. Guard against races (capture a local token / check the props still match after await).
- Keep the existing rendering (binary notice, truncated, diff rendering, back/close buttons, i18n keys) but sourced from local refs.
- `files-i18n.test.ts` currently mounts `FileViewer` and sets `files.file` directly — it MUST be updated in THIS task to pass props instead (e.g. mount with `props: { instanceId:'i1', workspace:'ws', path:'src/a.ts' }` and stub `files.readFile` to resolve the fixture). Update it so it still asserts the same zh-CN affordances.

- [ ] **Step 1:** Update `fileviewer.test.ts` + `files-i18n.test.ts` to the props API (stub `files.readFile`/`readDiff` via `vi.spyOn`), asserting: renders file content from `path` prop; renders diff from `diffPath` prop; emits `close`. Run → FAIL.
- [ ] **Step 2:** Refactor `FileViewer.vue` to props + local loading.
- [ ] **Step 3:** Run `fileviewer.test.ts` + `files-i18n.test.ts` → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 4:** Commit `refactor(relay-web): FileViewer loads its own content from props`.

**Note for integrator (Task 7):** any current single-slot usage of `FileViewer` in `DashboardView` is replaced there; `files.file`/`diff`/`diffPath` global fields may remain for other readers (Changes-tab badges) but the center no longer drives `FileViewer` off them.

---

### Task 5: `lib/use-tab-drag.ts` — pointer-based reorder

**Files:**
- Create: `packages/relay-web/src/lib/use-tab-drag.ts`
- Test: `packages/relay-web/src/__tests__/use-tab-drag.test.ts`

**Interfaces:**
- Produces a composable that, given callbacks, tracks a horizontal pointer drag over tab elements and reports the drag source id and a live target id, committing on pointerup. Keep it framework-light and unit-testable:
  ```ts
  export interface TabDragHandlers {
    onReorder: (draggedId: string, targetId: string) => void;
  }
  export function useTabDrag(opts: TabDragHandlers): {
    draggingId: Ref<string | null>;
    overId: Ref<string | null>;
    start: (e: PointerEvent, id: string) => void;   // pointerdown on a tab
    // internal move/up handlers are wired on the element via returned bindings or attached to document
  };
  ```
- Behavior: `start` records `id`, `startX`, sets nothing dragging yet. On `pointermove` past ~4px threshold, set `draggingId=id`; determine `overId` from `document.elementFromPoint(x, y)` walking to the nearest `[data-tab-id]`. On `pointerup`, if `draggingId && overId && overId !== draggingId`, call `onReorder(draggingId, overId)`; reset. `pointercancel` resets.
- Because layout/hit-testing isn't available in jsdom, the unit test covers the *logic* you can exercise: threshold gating (a move < threshold does NOT set `draggingId`; a move ≥ threshold does), and that a synthetic pointerup with a known `overId` (inject via a test seam — e.g. accept an `elementIdAt(x,y)` function param defaulting to the DOM lookup) calls `onReorder`. Design the composable to accept an optional `resolveId?: (x: number, y: number) => string | null` so tests can inject hit-testing.

- [ ] **Step 1: Write failing tests** exercising: (a) move below threshold → `draggingId` stays null, no reorder; (b) move above threshold with injected `resolveId` → `overId` updates; (c) pointerup commits `onReorder(dragged, over)`; (d) pointercancel resets without calling `onReorder`. Run → FAIL.
- [ ] **Step 2:** Implement `use-tab-drag.ts` with the `resolveId` seam (default uses `document.elementFromPoint(...).closest('[data-tab-id]')?.getAttribute('data-tab-id')`).
- [ ] **Step 3:** Run → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 4:** Commit `feat(relay-web): pointer-based tab drag-reorder utility`.

---

### Task 6: `CenterTabStrip.vue`

**Files:**
- Create: `packages/relay-web/src/components/CenterTabStrip.vue`
- Modify: `packages/relay-web/src/i18n/messages/en.ts`, `zh-CN.ts` (add `center.chat`, `center.terminal`, `center.closeTab`)
- Test: `packages/relay-web/src/__tests__/centertabstrip.test.ts`

**Interfaces:**
- Consumes: `useCenterTabsStore` (Task 1), `useTabDrag` (Task 5), `iconForFile` (`lib/file-icons`), lucide `MessageSquare`/`SquareTerminal`/`X`.
- Props: `defineProps<{ sessionKey: string }>()`.
- Renders: a horizontal, `overflow-x-auto` strip.
  - First: the pinned chat tab — `data-test="tab-chat"`, active when `activeFor(key)==='chat'`, `@click="setActive(key,'chat')"`, no ✕, not draggable.
  - Then `tabsFor(key)`: each tab `data-test="tab"` `:data-tab-id="tab.id"`, `draggable`-like via `@pointerdown="drag.start($event, tab.id)"`, `touch-action: none`, active styling when `tab.id===activeFor(key)`, click → `setActive`, a ✕ button (`data-test="tab-close"`, `@click.stop="closeTab(key, tab.id)"`, `:aria-label="$t('center.closeTab')"`). Icon: terminal → `SquareTerminal`; file/diff → `iconForFile(tab.path)`; diff shows a small "Δ"/diff hint. Label: basename of `tab.path` (file/diff) or `$t('center.terminal')`.
  - Drag visual: apply an "over" ring when `drag.overId === tab.id`.
- The strip's `onReorder` → `store.reorder(props.sessionKey, dragged, target)`.

**i18n:** `center: { chat: "Chat"/"会话", terminal: "Terminal"/"终端", closeTab: "Close tab"/"关闭标签" }`.

- [ ] **Step 1: Write failing test** (`centertabstrip.test.ts`): pinia; open a file + terminal on the key; mount with `props:{ sessionKey:K }` and `$t` mock. Assert: a `tab-chat` element exists; two `tab` elements; clicking a `tab` calls `setActive`; clicking its `tab-close` calls `closeTab`; the active tab has the active class. (Drag is covered by Task 5; here just assert `@pointerdown` is wired by triggering `pointerdown` and checking `drag.start` isn't throwing / the element has `data-tab-id`.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `CenterTabStrip.vue` + i18n.
- [ ] **Step 4:** Run → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 5:** Commit `feat(relay-web): CenterTabStrip (pinned chat + closable, drag-reorderable tabs)`.

---

### Task 7: `DashboardView.vue` center integration

**Files:**
- Modify: `packages/relay-web/src/views/DashboardView.vue` (center region ~lines 314-325; watchers ~131-140; terminal toggle button)
- Test: `packages/relay-web/src/__tests__/dashboard-center-tabs.test.ts` (new; keep existing dashboard tests green)

**Interfaces:**
- Consumes: `useCenterTabsStore`, `sessionKey`, `CenterTabStrip`, decoupled `FileViewer` (Task 4), `TerminalTab`, `ChatPane`.

**Behavior:**
- `currentKey = computed(() => chat.instanceId && chat.sessionAlias ? sessionKey(chat.instanceId, chat.sessionAlias) : null)`.
- Replace the center block:
  ```
  <div class="center column">
    <CenterTabStrip v-if="currentKey" :session-key="currentKey" />
    <div class="relative flex-1 min-h-0">
      <ChatPane ... :inert="currentKey && centerTabs.activeFor(currentKey) !== 'chat'"
                v-show="!currentKey || centerTabs.activeFor(currentKey) === 'chat'" />
      <!-- one pane per open tab across ALL sessions, mounted while open -->
      <template v-for="{ key, tab } in centerTabs.allOpenTabs()" :key="key + '|' + tab.id">
        <FileViewer v-if="tab.kind === 'file' || tab.kind === 'diff'"
          v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
          :instance-id="keyInstance(key)" :workspace="keyWorkspace(key)"
          :path="tab.kind==='file' ? tab.path : undefined"
          :diff-path="tab.kind==='diff' ? tab.path : undefined"
          @close="centerTabs.closeTab(key, tab.id)" @back="backToFileList" />
        <TerminalTab v-else-if="tab.kind === 'terminal'"
          v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
          :instance-id="keyInstance(key)" :session-alias="keyAlias(key)" />
      </template>
    </div>
  </div>
  ```
  - Add helpers `keyInstance(key)`/`keyAlias(key)` that split on `"::"`. `keyWorkspace(key)` = the workspace for that session (look it up via instances store by instanceId+alias, mirroring the existing `activeWorkspace` logic); if not resolvable, pass the current `files.workspace` for the current session only. Since panes only *show* for the current session, resolving workspace for the current key is sufficient; for hidden non-current panes, workspace can be resolved the same way (they don't need to be visible to hold state).
- **Terminal button:** the existing terminal toggle now calls `centerTabs.openTerminal(currentKey)` (and, if desired, toggles back to chat if the terminal is already active — acceptable to just always open/focus).
- **Remove** the `viewingFile`/`terminalOpen` refs/computed and the mutual-exclusion watchers (131-140) that are now handled by the tab model. Preserve: on mobile, opening a tab may still close the right drawer overlay (`rightOpen=false`) — keep a minimal watcher on `currentKey`'s active tab if needed, else drop.
- Keep `ChatPane` a single instance bound to the current session (unchanged props).

- [ ] **Step 1: Write failing test** (`dashboard-center-tabs.test.ts`): mount `DashboardView` with a selected session (reuse existing dashboard test setup for `chat.select`), then:
  - initially the chat pane shows and `CenterTabStrip` shows only the chat tab;
  - `centerTabs.openFile(currentKey, "a.ts")` → a `FileViewer` becomes visible and the strip shows a file tab;
  - `centerTabs.openTerminal(currentKey)` → a `TerminalTab` mounts.
  Use shallow/stubbed child components where full mount is heavy (stub `FileViewer`/`TerminalTab`/`ChatPane` with `{ template: '<div data-test="...">' }` via `global.stubs`) and assert on the stubs' presence/visibility. Run → FAIL.
- [ ] **Step 2:** Implement the integration; delete dead overlay state/watchers.
- [ ] **Step 3:** Run the new test + existing `filespanel`/dashboard tests → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 4:** Commit `feat(relay-web): render center as a per-session tab strip`.

---

### Task 8: Route file/diff opening through center-tabs

**Files:**
- Modify: `packages/relay-web/src/components/FilesPanel.vue` (`openTreeFile`, `openSearchResult`, `openDiff`)
- Test: `packages/relay-web/src/__tests__/filespanel.test.ts` (extend)

**Interfaces:**
- Consumes: `useCenterTabsStore`, `sessionKey`, `useChatStore` (already imported for `activeWorkspace`).

**Behavior:**
- `currentKey`: `chat.instanceId && chat.sessionAlias ? sessionKey(chat.instanceId, chat.sessionAlias) : null`.
- `openTreeFile(rel)` / `openSearchResult(m)`: if `currentKey`, call `centerTabs.openFile(currentKey, rel)`; keep clearing `files.diffPath = null` if still used elsewhere, but do NOT call `files.openFile` (which mutates the global slot the center no longer reads). If no `currentKey`, no-op.
- `openDiff(path)`: if `currentKey`, `centerTabs.openDiff(currentKey, path)`.
- Leave the Changes/Files right-rail listing and search UI otherwise unchanged.

- [ ] **Step 1: Update/extend `filespanel.test.ts`**: with a selected session (set `chat.instanceId`/`sessionAlias`), clicking a tree file / search result / changed file calls the corresponding `centerTabs.openFile`/`openDiff` with `sessionKey(...)` and the path. (Spy on the center-tabs store methods.) Run → FAIL.
- [ ] **Step 2:** Implement the routing.
- [ ] **Step 3:** Run → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 4:** Commit `feat(relay-web): open files/diffs as center tabs from the Files rail`.

---

### Task 9: Clear a session's tabs on archive/delete

**Files:**
- Modify: wherever a session is archived/deleted and its center state should drop — most likely `DashboardView.vue` (it already reacts to session removal / alias clear) or the archive handler path from `InstanceTree`.
- Test: extend `dashboard-center-tabs.test.ts` (or a focused test)

**Behavior:**
- When a session is archived or deleted (its `alias` no longer exists / is cleared), call `centerTabs.clearSession(sessionKey(instanceId, alias))` so its tabs (and thus mounted terminal/file panes) unmount and its PTY tears down.
- Verify the terminal pane actually unmounts (its `onBeforeUnmount`/`teardown` runs) when `clearSession` removes the tab — this is the orphan-PTY safeguard.

- [ ] **Step 1: Write failing test:** open a terminal on a session, then simulate archive/delete of that session → the terminal pane is gone (`allOpenTabs()` no longer lists it / the stub unmounts). Run → FAIL.
- [ ] **Step 2:** Wire `clearSession` into the archive/delete path.
- [ ] **Step 3:** Run → PASS; `npx vue-tsc --noEmit` rc=0.
- [ ] **Step 4:** Commit `fix(relay-web): drop a session's center tabs (and PTYs) on archive/delete`.

---

### Task 10: Full-suite gate + i18n parity sweep

**Files:** none new (verification + any parity fix)

- [ ] **Step 1:** `cd packages/relay-web && npx vue-tsc --noEmit` → rc=0.
- [ ] **Step 2:** `npx vitest run` → all green (full suite).
- [ ] **Step 3:** Grep both i18n files for the new keys (`showMoreSessions`, `collapseSessions`, `center.chat`, `center.terminal`, `center.closeTab`) — confirm present in BOTH with matching placeholders. Fix any gap.
- [ ] **Step 4:** Commit only if a fix was needed: `test(relay-web): center-tabs full-suite + i18n parity`.

---

## Notes for the executor

- **Task order / dependencies:** 1 → (3 → 4), 5 → 6 → 7 → 8 → 9 → 10. Task 2 (session cap) is independent and can go anytime. Tasks 3/4 and 5/6 are two independent chains feeding Task 7.
- The heaviest, riskiest task is **7** (center integration + deleting the old overlay/watcher logic). Give it extra review attention: verify ChatPane still preserves scroll (single instance, `v-show` + `inert`), the mobile right-drawer behavior, and that hidden panes don't error when their session isn't current (workspace resolution).
- Terminal orphan-PTY safety: the only way a terminal's `teardown()` runs is component unmount — which now happens on `closeTab` (tab removed → `v-for` drops the pane) and on `clearSession`. Confirm both unmount paths in review.
