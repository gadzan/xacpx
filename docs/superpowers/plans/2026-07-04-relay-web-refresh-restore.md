# relay-web 刷新恢复(第 1+2 层)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器刷新后还原刷新前的中置 tab 集(文件/diff/终端)+ 激活 tab + 未保存编辑草稿,纯前端 sessionStorage 实现。

**Architecture:** 四个解耦单元:① `lib/file-drafts.ts` 草稿库(照抄 composer-drafts);② `stores/center-tabs.ts` 加 hydrate+deep-watch 持久化,终端 tab 引入 `autostart`(恢复一律 false);③ `TerminalTab.vue` 按 `autostart` 懒启动(false 显占位);④ `FileViewer.vue` 接线草稿(恢复进编辑态、靠既有 mtime 陈旧写保护兑底)。全部只动 `packages/relay-web`。

**Tech Stack:** Vue 3 setup SFC、Pinia setup store、vue-i18n、sessionStorage;测试 Vitest(jsdom)+ @vue/test-utils。

## Global Constraints

- 纯前端,只改 `packages/relay-web/`;不动后端 / 协议 / 其它包。UI-only → 只 bump hub 一个 beta。
- 持久化一律 **sessionStorage**(与 `lib/composer-drafts.ts` 同寿命),读写全 try/catch 吞异常,写失败静默降级。
- 测试跑法:`cd packages/relay-web && npx vitest run`(**绝不用 bun test**);类型 `cd packages/relay-web && npx vue-tsc --noEmit`。
- 持久盘持久化 shell 的 cwd 会在 `cd repo && git …` 后漂回仓库根;每次跑 vitest/vue-tsc 前必须重新 `cd packages/relay-web`。
- storage key 用 kebab + `.v1` 版本后缀:草稿 `xacpx.file-drafts.v1`、tab 集 `xacpx.center-tabs.v1`。
- 新增/删除 i18n 键必须 en.ts + zh-CN.ts 同步,过 `src/__tests__/i18n-parity.test.ts`。
- CodeMirror 在 jsdom 报 `getClientRects is not a function`,已在 `src/__tests__/setup.ts` stub,勿重复处理。
- 每个改动单元结束时:`npx vue-tsc --noEmit` 必须 0 报错。

---

### Task 1: 文件草稿库 `lib/file-drafts.ts`

纯函数模块,sessionStorage 读写文件编辑草稿。照抄 `packages/relay-web/src/lib/composer-drafts.ts` 的 read/write/try-catch 结构,独立 KEY。

**Files:**
- Create: `packages/relay-web/src/lib/file-drafts.ts`
- Test: `packages/relay-web/src/__tests__/file-drafts.test.ts`

**Interfaces:**
- Consumes: 浏览器 `sessionStorage`。
- Produces:
  - `draftKey(sessionKey: string, path: string): string` → `` `${sessionKey}::${path}` ``
  - `loadFileDraft(key: string): string | null`(无草稿返 `null`;空串 `""` 是合法草稿)
  - `saveFileDraft(key: string, text: string): void`(有 text 写、空则删键;写失败静默)
  - `clearFileDraft(key: string): void`

- [ ] **Step 1: 写失败的测试**

Create `packages/relay-web/src/__tests__/file-drafts.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { draftKey, loadFileDraft, saveFileDraft, clearFileDraft } from "../lib/file-drafts";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("file-drafts", () => {
  it("draftKey composes sessionKey and path", () => {
    expect(draftKey("i1::s1", "a/b.ts")).toBe("i1::s1::a/b.ts");
  });

  it("save then load round-trips the text", () => {
    const k = draftKey("i1::s1", "a.ts");
    saveFileDraft(k, "hello");
    expect(loadFileDraft(k)).toBe("hello");
  });

  it("empty string is a valid draft (distinct from absent)", () => {
    const k = draftKey("i1::s1", "a.ts");
    saveFileDraft(k, "x");
    saveFileDraft(k, ""); // deleting all content is a real draft-clear, so key is removed
    expect(loadFileDraft(k)).toBeNull();
  });

  it("returns null when no draft exists", () => {
    expect(loadFileDraft(draftKey("i1::s1", "none.ts"))).toBeNull();
  });

  it("clearFileDraft removes the key", () => {
    const k = draftKey("i1::s1", "a.ts");
    saveFileDraft(k, "hi");
    clearFileDraft(k);
    expect(loadFileDraft(k)).toBeNull();
  });

  it("tolerates corrupt storage without throwing", () => {
    sessionStorage.setItem("xacpx.file-drafts.v1", "{not json");
    expect(loadFileDraft(draftKey("i1::s1", "a.ts"))).toBeNull();
  });

  it("swallows setItem quota errors", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => saveFileDraft(draftKey("i1::s1", "a.ts"), "big")).not.toThrow();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/file-drafts.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/file-drafts"`.

- [ ] **Step 3: 实现模块**

Create `packages/relay-web/src/lib/file-drafts.ts`:

```ts
/** Per-session file edit-draft persistence (mirrors composer-drafts). An unsaved edit buffer
 *  survives a browser reload. Stored in sessionStorage (tab-scoped — dies with the tab) keyed
 *  by `${sessionKey}::${path}`, matching the center-tab's per-session identity. */
const KEY = "xacpx.file-drafts.v1";

type Drafts = Record<string, string>;

function read(): Drafts {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Drafts) : {};
  } catch {
    return {};
  }
}

function write(drafts: Drafts): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* storage full / disabled — drafts are best-effort */
  }
}

export function draftKey(sessionKey: string, path: string): string {
  return `${sessionKey}::${path}`;
}

export function loadFileDraft(key: string): string | null {
  if (!key) return null;
  const v = read()[key];
  return v ?? null; // null = absent; "" = a real (emptied) draft
}

export function saveFileDraft(key: string, text: string): void {
  if (!key) return;
  const drafts = read();
  if (text) drafts[key] = text;
  else delete drafts[key];
  write(drafts);
}

export function clearFileDraft(key: string): void {
  if (!key) return;
  const drafts = read();
  delete drafts[key];
  write(drafts);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/file-drafts.test.ts`
Expected: PASS(7 个用例全绿)。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd packages/relay-web && npx vue-tsc --noEmit
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/lib/file-drafts.ts packages/relay-web/src/__tests__/file-drafts.test.ts
git commit -m "feat(relay-web): file-drafts sessionStorage lib for edit-buffer persistence"
```

---

### Task 2: center-tabs 持久化 + 终端 `autostart`

在 `stores/center-tabs.ts` 内加 hydrate(初始化读回)+ persist(deep watch 写回),终端 tab 类型加 `autostart?: boolean`;`openTerminal` 置 `autostart:true`;hydrate 把读回的终端 tab `autostart` 强制为 `false`。

**Files:**
- Modify: `packages/relay-web/src/stores/center-tabs.ts`
- Test: `packages/relay-web/src/__tests__/center-tabs.test.ts`(扩充,已存在)

**Interfaces:**
- Consumes: `sessionStorage`、`vue` 的 `ref`/`watch`。
- Produces:`CenterTab` 终端变体新增 `autostart?: boolean`。现有 mutator 签名全不变(`openFile/openDiff/openTerminal/setActive/closeTab/reorder/clearSession/setDirty/isDirty/closeTabGuarded/tabsFor/activeFor/allOpenTabs`)。

- [ ] **Step 1: 写失败的测试**

在 `packages/relay-web/src/__tests__/center-tabs.test.ts` 顶部把 `beforeEach` 改成同时清 sessionStorage:

```ts
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear(); });
```

并在文件末尾 `describe("center-tabs store", () => { ... })` 内追加以下用例(注意:`useCenterTabsStore` 已在文件顶部 import):

```ts
  it("openTerminal marks the tab autostart:true (fresh user action spawns)", () => {
    const s = useCenterTabsStore();
    s.openTerminal(K);
    const term = s.tabsFor(K).find((t) => t.kind === "terminal");
    expect(term && term.kind === "terminal" ? term.autostart : undefined).toBe(true);
  });

  it("persists tab state to sessionStorage on mutation", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts");
    const raw = sessionStorage.getItem("xacpx.center-tabs.v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[K].tabs.map((t: { id: string }) => t.id)).toEqual(["file:a.ts"]);
    expect(JSON.parse(raw!)[K].activeId).toBe("file:a.ts");
  });

  it("hydrates tab state from sessionStorage on a fresh store", () => {
    sessionStorage.setItem(
      "xacpx.center-tabs.v1",
      JSON.stringify({ [K]: { tabs: [{ kind: "file", id: "file:a.ts", path: "a.ts" }], activeId: "file:a.ts" } }),
    );
    const s = useCenterTabsStore(); // fresh pinia from beforeEach ran BEFORE we set storage? see note
    expect(s.tabsFor(K).map((t) => t.id)).toEqual(["file:a.ts"]);
    expect(s.activeFor(K)).toBe("file:a.ts");
  });

  it("forces restored terminal tabs to autostart:false", () => {
    sessionStorage.setItem(
      "xacpx.center-tabs.v1",
      JSON.stringify({ [K]: { tabs: [{ kind: "terminal", id: "terminal", autostart: true }], activeId: "terminal" } }),
    );
    const s = useCenterTabsStore();
    const term = s.tabsFor(K).find((t) => t.kind === "terminal");
    expect(term && term.kind === "terminal" ? term.autostart : undefined).toBe(false);
  });

  it("discards corrupt storage and bad session entries without throwing", () => {
    sessionStorage.setItem("xacpx.center-tabs.v1", "{not json");
    expect(() => useCenterTabsStore()).not.toThrow();
    expect(useCenterTabsStore().tabsFor(K)).toEqual([]);

    sessionStorage.setItem(
      "xacpx.center-tabs.v1",
      JSON.stringify({ [K]: { tabs: "nope", activeId: 5 }, "i1::s2": { tabs: [{ kind: "file", id: "file:b.ts", path: "b.ts" }], activeId: "file:b.ts" } }),
    );
    const s2 = useCenterTabsStore();
    expect(s2.tabsFor(K)).toEqual([]); // bad entry dropped
    expect(s2.tabsFor(sessionKey("i1", "s2")).map((t) => t.id)).toEqual(["file:b.ts"]); // good entry kept
  });
```

> 注意 hydrate 用例:`useCenterTabsStore()` 在 `setActivePinia` 后首次调用时读 sessionStorage。`beforeEach` 先跑(清空 + 新 pinia),用例体内再 `setItem` 然后首次 `useCenterTabsStore()` —— 因 pinia 惰性实例化 store,首次调用即触发工厂里的 hydrate,能读到刚 set 的值。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/center-tabs.test.ts`
Expected: FAIL — 新增用例失败(`autostart` undefined、sessionStorage 无 `xacpx.center-tabs.v1`、hydrate 未还原)。既有用例仍应通过。

- [ ] **Step 3: 改 store**

在 `packages/relay-web/src/stores/center-tabs.ts` 做四处改动:

**(a)** import 加 `watch`:

```ts
import { ref, watch } from "vue";
```

**(b)** 终端变体类型加 `autostart`(第 9 行附近):

```ts
export type CenterTab =
  | { kind: "file"; id: string; path: string; targetLine?: number; targetRev?: number; dirty?: boolean }
  | { kind: "diff"; id: string; path: string }
  | { kind: "terminal"; id: string; autostart?: boolean };
```

**(c)** 在 `export function sessionKey(...)` 之后、`useCenterTabsStore` 之前加 STORAGE_KEY + hydrate/persist:

```ts
const STORAGE_KEY = "xacpx.center-tabs.v1";

/** Read persisted tab sets from sessionStorage. Restored terminal tabs can't reconnect to
 *  their old PTY, so force `autostart:false` — they render a lazy "start" placeholder instead
 *  of spawning a fresh shell on mount. Corrupt data or malformed session entries are dropped
 *  (bad entry skipped, good entries kept) so one broken record can't blank the whole view. */
function hydrate(): Record<string, SessionTabs> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SessionTabs> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      const v = val as { tabs?: unknown; activeId?: unknown };
      if (!Array.isArray(v.tabs) || typeof v.activeId !== "string") continue;
      const tabs = (v.tabs as CenterTab[]).map((t) =>
        t && t.kind === "terminal" ? { ...t, autostart: false } : t,
      );
      out[key] = { tabs, activeId: v.activeId };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(v: Record<string, SessionTabs>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* storage full / disabled — persistence is best-effort */
  }
}
```

**(d)** 在 `useCenterTabsStore` 工厂里,把 `bySession` 初值改成 hydrate,并加 deep watch(紧跟 `bySession` 声明之后):

```ts
  const bySession = ref<Record<string, SessionTabs>>(hydrate());
  watch(bySession, (v) => persist(v), { deep: true });
```

**(e)** `openTerminal` 置 `autostart:true`:

```ts
  function openTerminal(key: string): void {
    upsertAndActivate(key, { kind: "terminal", id: "terminal", autostart: true });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/center-tabs.test.ts`
Expected: PASS(既有 + 新增全绿)。

- [ ] **Step 5: 全量 store 相关回归 + 类型 + 提交**

跑受影响的相邻测试确认没回归:

Run: `cd packages/relay-web && npx vitest run src/__tests__/centertabstrip.test.ts src/__tests__/dashboard-center-tabs.test.ts && npx vue-tsc --noEmit`
Expected: PASS,vue-tsc 0 报错。

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/stores/center-tabs.ts packages/relay-web/src/__tests__/center-tabs.test.ts
git commit -m "feat(relay-web): persist center tabs to sessionStorage; terminal autostart flag"
```

---

### Task 3: 终端懒启动(TerminalTab 占位 + DashboardView 传 autostart + i18n)

`autostart=false` 时不 spawn,渲染"启动新终端"占位;点按钮才 `start()`。`autostart=true`(默认)维持现状。

**Files:**
- Modify: `packages/relay-web/src/components/TerminalTab.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue`(terminal tab 传 `:autostart`)
- Modify: `packages/relay-web/src/i18n/messages/en.ts`、`packages/relay-web/src/i18n/messages/zh-CN.ts`
- Test: `packages/relay-web/src/__tests__/terminal-tab.test.ts`(扩充,已存在)

**Interfaces:**
- Consumes:`CenterTab` 终端变体的 `autostart`(Task 2);`terminals.create`(既有)。
- Produces:`TerminalTab` 新增 prop `autostart?: boolean`(默认 `true`,保持既有直接挂载行为)。

- [ ] **Step 1: 写失败的测试**

在 `packages/relay-web/src/__tests__/terminal-tab.test.ts` 的 `beforeEach` 补 sessionStorage 清理(改为):

```ts
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); });
```

在 `describe("TerminalTab", ...)` 内追加(注意顶部 `globalOpts` 的 `$t` mock 把 key 原样返回,故断言占位用 data-test 而非文案):

```ts
  it("autostart=false does NOT spawn and shows the restore placeholder", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: false }, global: globalOpts });
    await tick();
    expect(createTerminalAdapter).not.toHaveBeenCalled();
    expect(w.find('[data-test="term-restore"]').exists()).toBe(true);
    expect(w.find('[data-test="term-start"]').exists()).toBe(true);
  });

  it("clicking the placeholder start button spawns the terminal", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: false }, global: globalOpts });
    await tick();
    await w.find('[data-test="term-start"]').trigger("click");
    await tick();
    expect(createTerminalAdapter).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="term-restore"]').exists()).toBe(false);
  });

  it("autostart=true (default) spawns on mount as before", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(createTerminalAdapter).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-tab.test.ts`
Expected: FAIL — autostart=false 仍 spawn、无 `term-restore`/`term-start`。

- [ ] **Step 3a: 改 TerminalTab.vue —— props + 懒启动逻辑**

`import` 行加 `computed`(第 2 行):

```ts
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
```

props 改为带默认(第 8 行):

```ts
const props = withDefaults(defineProps<{ instanceId: string; sessionAlias: string; autostart?: boolean }>(), {
  autostart: true,
});
```

在 `let adapter ...` 附近(第 52 行区域,`status` 声明之后)加懒启动状态:

```ts
// Lazy start: a tab restored from sessionStorage arrives autostart=false — it can't reconnect
// to its old PTY, so it waits on a "start new terminal" placeholder instead of spawning on
// mount. `started` gates the prop-watch so a dormant tab never auto-spawns on a prop change.
let started = false;
const showPlaceholder = computed(() => !!props.sessionAlias && status.value === "idle" && !props.autostart);
```

`start()` 里,在通过 session/host 守卫、设 `status.value = "connecting";` 之后,加 `started = true;`(第 232 行附近):

```ts
  if (!props.sessionAlias || !host.value) { status.value = "idle"; return; }
  status.value = "connecting";
  started = true;
```

`onMounted` 把无条件 `void start()` 改成看 autostart(第 293-294 行):

```ts
onMounted(() => {
  if (props.autostart) void start();
  attachTouch();
  window.visualViewport?.addEventListener("resize", updateKeyboardInset);
  window.visualViewport?.addEventListener("scroll", updateKeyboardInset);
});
```

prop-watch 改成仅已启动才重启(第 299 行):

```ts
watch(() => [props.instanceId, props.sessionAlias], () => { if (started) void start(); });
```

- [ ] **Step 3b: 改 TerminalTab.vue —— 模板占位**

在 body 区(第 331-335 行),`error`/`exited` 之后、host div 之前插入占位;host div 加 `v-show="!showPlaceholder"` 使其 dormant 时仍在 DOM(`start()` 需 `host.value`):

```html
    <!-- body -->
    <div v-if="!props.sessionAlias" class="p-4 text-sm text-fg-muted">{{ $t("terminal.noSession") }}</div>
    <div v-else-if="status === 'error'" class="p-4 text-sm text-fg-muted">{{ $t(errorKey) }}</div>
    <div v-else-if="status === 'exited'" class="p-4 text-sm text-fg-muted">{{ $t("terminal.exited", { code: errorKey }) }}</div>
    <div v-if="showPlaceholder" data-test="term-restore"
         class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="text-sm text-fg-muted">{{ $t("terminal.restoredHint") }}</p>
      <button data-test="term-start"
              class="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:bg-raised"
              @click="void start()">{{ $t("terminal.startNew") }}</button>
    </div>
    <div v-show="!showPlaceholder" ref="host" class="term-host flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-bg" data-test="terminal-host"></div>
```

- [ ] **Step 3c: 改 DashboardView.vue —— 传 autostart**

找到 TerminalTab 挂载处(约第 400-402 行 `<TerminalTab ... :session-alias="keyAlias(key)" ...>`),加 `:autostart`:

```html
            <TerminalTab v-else-if="tab.kind === 'terminal'" class="absolute inset-0 z-20"
                         v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
                         :instance-id="keyInstance(key)" :session-alias="keyAlias(key)"
                         :autostart="tab.autostart ?? false"
```

保留该标签原有的其余属性/事件(如 `@close`)不变。

- [ ] **Step 3d: 改 i18n —— 两个占位文案键**

`packages/relay-web/src/i18n/messages/en.ts` 的 `terminal:` 块内(`noSession` 之后)加:

```ts
    restoredHint: "This terminal disconnected on reload.",
    startNew: "Start new terminal",
```

`packages/relay-web/src/i18n/messages/zh-CN.ts` 的 `terminal:` 块内对应位置加:

```ts
    restoredHint: "终端会话已随刷新断开。",
    startNew: "启动新终端",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-tab.test.ts src/__tests__/i18n-parity.test.ts`
Expected: PASS(新增 3 用例 + 既有终端用例 + i18n parity 全绿)。

- [ ] **Step 5: 相邻回归 + 类型 + 提交**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-center-tabs.test.ts src/__tests__/terminal-store.test.ts && npx vue-tsc --noEmit`
Expected: PASS,vue-tsc 0 报错。

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/components/TerminalTab.vue packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/terminal-tab.test.ts
git commit -m "feat(relay-web): lazy-start restored terminal tabs with a start placeholder"
```

---

### Task 4: FileViewer 草稿接线(恢复进编辑态 + 写/清草稿)

`FileViewer.vue` 新增 `sessionKey` prop;`load()` 后若有草稿则灌入并进编辑态;编辑时写草稿、保存/取消时清草稿。`DashboardView.vue` 传 `:session-key="key"`。

**Files:**
- Modify: `packages/relay-web/src/components/FileViewer.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue`(FileViewer 传 `:session-key`)
- Test: `packages/relay-web/src/__tests__/fileviewer.test.ts`(扩充,已存在)

**Interfaces:**
- Consumes:`lib/file-drafts` 的 `draftKey/loadFileDraft/saveFileDraft/clearFileDraft`(Task 1);`sessionKey` prop。
- Produces:无(叶子组件);行为契约:有草稿且异于磁盘且可编辑 → 恢复进编辑态;编辑改动写草稿;save/cancel 清草稿。

- [ ] **Step 1: 写失败的测试**

该文件已有 helper:`mountViewer(props)`(注入 pinia、固定 `instanceId:"i1", workspace:"ws"`)、`settle()`(await 加载)、fixture `TEXT`、`useFilesStore()` + `vi.spyOn(files,"readFile").mockResolvedValue(...)`。**先把 `beforeEach` 补上 `sessionStorage.clear()`**(现有 beforeEach 未清):

```ts
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  sessionStorage.clear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
```

在 `describe("FileViewer", ...)` 内追加以下用例(复用 `mountViewer`/`settle`/`TEXT`):

```ts
  it("restores an edit draft into edit mode on load", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DRAFT BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    // Draft differs from disk + file is editable ⇒ enter edit mode with the draft buffer.
    expect(w.find('[data-test="fv-dirty-dot"]').exists()).toBe(true);
    expect(w.find('[data-test="fv-save"]').exists()).toBe(true);
    expect(w.emitted("dirty-change")?.some((e) => e[0] === true)).toBe(true);
  });

  it("does NOT enter edit mode when the draft equals disk content", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DISK BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    expect(w.find('[data-test="fv-dirty-dot"]').exists()).toBe(false);
    expect(w.find('[data-test="fv-edit"]').exists()).toBe(true); // read mode: pencil visible
  });

  it("clears the draft on cancel", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DRAFT BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    await w.get('[data-test="fv-cancel"]').trigger("click");
    expect(JSON.parse(sessionStorage.getItem("xacpx.file-drafts.v1")!)["i1::s1::src/a.ts"]).toBeUndefined();
  });

  it("clears the draft after a successful save", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    vi.spyOn(files, "saveFile").mockResolvedValue({ path: "src/a.ts", mtimeMs: 2000, size: 5 });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DRAFT BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(JSON.parse(sessionStorage.getItem("xacpx.file-drafts.v1")!)["i1::s1::src/a.ts"]).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/fileviewer.test.ts`
Expected: FAIL — 无草稿恢复逻辑,dirty dot 不出现、cancel 不清 sessionStorage。

- [ ] **Step 3a: 改 FileViewer.vue —— import + prop**

顶部 import 区加(第 8 行附近,`unified-diff` import 一带):

```ts
import { draftKey, loadFileDraft, saveFileDraft, clearFileDraft } from "../lib/file-drafts";
```

props 加 `sessionKey`(第 15-22 行 `defineProps` 块,加一行;可选默认空串以免既有直接挂载测试因缺 prop 告警):

```ts
const props = defineProps<{
  instanceId: string;
  workspace: string;
  path?: string;
  diffPath?: string;
  line?: number;
  lineRev?: number;
  sessionKey?: string;
}>();
```

- [ ] **Step 3b: 改 FileViewer.vue —— load() 恢复草稿**

在 `load()` 的 `if (path)` 分支,`emit("dirty-change", false);`(第 52 行)之后追加草稿恢复:

```ts
      file.value = result;
      diff.value = null;
      content.value = result.binary ? "" : result.content;
      editing.value = false;
      emit("dirty-change", false);
      // Restore a persisted edit draft: enter edit mode with the saved buffer. Only when the
      // draft differs from disk (equal ⇒ nothing to restore) and the file is actually editable
      // (a truncated / mtime-less file can't be saved). Staleness isn't checked here — the
      // existing save-time mtime guard (baseRev) catches a disk that changed while away.
      if (!result.binary && !result.truncated && typeof result.mtimeMs === "number") {
        const draft = loadFileDraft(draftKey(props.sessionKey ?? "", path));
        if (draft !== null && draft !== result.content) {
          baseRev.value = { mtimeMs: result.mtimeMs, size: result.size };
          content.value = draft;
          editing.value = true;
        }
      }
```

- [ ] **Step 3c: 改 FileViewer.vue —— 编辑时持久化草稿**

在 `watch(editDirty, ...)`(第 93 行)之后加一个 watch,把编辑中的 buffer 落盘:

```ts
// Persist the edit buffer while editing so a reload can restore it. Clearing the edits back to
// disk content removes the key (empty store). Only writes in edit mode with a real path.
watch(content, (val) => {
  if (!editing.value || !props.path) return;
  const key = draftKey(props.sessionKey ?? "", props.path);
  if (file.value && val !== file.value.content) saveFileDraft(key, val);
  else clearFileDraft(key);
});
```

- [ ] **Step 3d: 改 FileViewer.vue —— save/cancel 清草稿**

`save()` 成功分支,`emit("dirty-change", false);`(第 132 行)之后加:

```ts
    editing.value = false;
    baseRev.value = null;
    emit("dirty-change", false);
    if (props.path) clearFileDraft(draftKey(props.sessionKey ?? "", props.path));
```

`cancelEdit()`(第 114-120 行)结尾 `emit("dirty-change", false);` 之后加:

```ts
function cancelEdit() {
  if (file.value) content.value = file.value.content; // revert the buffer
  editing.value = false;
  baseRev.value = null;
  saveError.value = null;
  emit("dirty-change", false);
  if (props.path) clearFileDraft(draftKey(props.sessionKey ?? "", props.path));
}
```

- [ ] **Step 3e: 改 DashboardView.vue —— 传 session-key**

FileViewer 挂载处(约第 391-393 行 `:instance-id="keyInstance(key)" :workspace="keyWorkspace(key)"` 一带)加 `:session-key="key"`:

```html
            <FileViewer v-if="tab.kind === 'file' || tab.kind === 'diff'" class="absolute inset-0 z-10"
                        v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
                        :instance-id="keyInstance(key)" :workspace="keyWorkspace(key)"
                        :session-key="key"
```

保留该标签其余属性/事件(`:path` `:diff-path` `:line` `:line-rev` `@dirty-change` 等)不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/fileviewer.test.ts`
Expected: PASS(新增草稿用例 + 既有用例全绿)。

- [ ] **Step 5: 相邻回归 + 类型 + 提交**

Run: `cd packages/relay-web && npx vitest run src/__tests__/file-tree-writes.test.ts src/__tests__/dashboard-center-tabs.test.ts && npx vue-tsc --noEmit`
Expected: PASS,vue-tsc 0 报错。

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/components/FileViewer.vue packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/__tests__/fileviewer.test.ts
git commit -m "feat(relay-web): restore & persist file edit drafts across reload"
```

---

## 收尾(全部任务完成后)

- 全量测试:`cd packages/relay-web && npx vitest run`(~155s,预期全绿)+ `npx vue-tsc --noEmit` 0 报错。
- 这是 UI-only,发布时只 bump hub(`@ganglion/xacpx-relay`)一个 beta(发布流程见既有 runbook,不在本计划内)。
- 实机验收:开若干文件 tab + 一个 diff + 一个终端,编辑某文件不保存 → 硬刷新 → tab 集/激活 tab 还原、草稿在且处编辑态、终端 tab 在但显"启动新终端"占位;点占位 → 正常新 shell;关标签页重开 → 不恢复(sessionStorage 语义)。
