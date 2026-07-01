# relay-web 终端中置化 + 快捷键条 + Nerd Font 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 relay-web 终端从右侧窄栏搬到中间列全宽覆盖，修复宽度不自适配，加可切换快捷键条，字体换成经国内镜像加载的 JetBrainsMono Nerd Font。

**Architecture:** 纯前端（`packages/relay-web`）。终端成为中间列覆盖层（与 FileViewer 对等、互斥），顶栏加专用开关按钮。adapter 用 ghostty 渲染后的 canvas 度量反推 cell 尺寸做真正的 fit。字体经 `cdn.jsdmirror.com` 按需注入两段 @font-face。透传链路（协议/hub/connector/core）不变。

**Tech Stack:** Vue 3 `<script setup>` + Pinia + Tailwind + ghostty-web（canvas 终端）+ vitest/jsdom。

## Global Constraints

- 仅改 `packages/relay-web`；**不改**协议、hub、connector、core、透传链路。
- 不引入新 npm 依赖（继续用 ghostty-web，用其暴露 API 自算 fit）。
- 字体：family 名 `"JetBrainsMono NFM"`（Nerd Font Mono），经 `https://cdn.jsdmirror.com/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts/JetBrainsMonoNerdFontMono-{Regular,Bold}.woff2` 加载（已实测 `200 font/woff2`）。字体加载失败必须静默回落 `monospace`、不阻塞终端打开。
- Ctrl 粘滞修饰键**仅作用于软键盘单字母**（`a-z` → `charCode&0x1f`）；方向键/Tab/Esc/粘贴按钮不吃 Ctrl。
- 快捷键条默认：移动端（`matchMedia('(min-width:1024px)')` 不匹配或缺失）开、桌面关；用户切换后写 `localStorage['xacpx.terminalKeybar']`（`"1"`/`"0"`）优先。
- 测试：`cd packages/relay-web && npx vitest run`（**不要**用 `bun test`——缺 jsdom 会假失败）。en/zh 两个 i18n catalog 必须键平价（`i18n-parity.test.ts` 自动校验）。
- 每个 Vue 组件挂载测试用 `global: { mocks: { $t: (k) => k } }` 或全局 i18n（见既有测试）。

---

### Task 1: 按需字体注入模块 `terminal-font.ts`

**Files:**
- Create: `packages/relay-web/src/lib/terminal-font.ts`
- Test: `packages/relay-web/src/__tests__/terminal-font.test.ts`

**Interfaces:**
- Produces: `ensureTerminalFont(): Promise<void>` — 幂等注入 `<style data-terminal-font>` 两段 @font-face（Regular/Bold），触发下载并等就绪；失败/超时静默 resolve。

- [ ] **Step 1: 写失败测试**

Create `packages/relay-web/src/__tests__/terminal-font.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("terminal-font", () => {
  beforeEach(() => {
    document.head.querySelectorAll("style[data-terminal-font]").forEach((n) => n.remove());
    vi.resetModules();
  });

  it("injects the @font-face style exactly once (idempotent)", async () => {
    (document as unknown as { fonts: unknown }).fonts = { load: vi.fn(async () => {}) };
    const mod = await import("../lib/terminal-font");
    await mod.ensureTerminalFont();
    await mod.ensureTerminalFont();
    const styles = document.head.querySelectorAll("style[data-terminal-font]");
    expect(styles.length).toBe(1);
    expect(styles[0].textContent).toContain("JetBrainsMono NFM");
    expect(styles[0].textContent).toContain("cdn.jsdmirror.com");
  });

  it("resolves even when document.fonts.load rejects (silent fallback)", async () => {
    (document as unknown as { fonts: unknown }).fonts = {
      load: vi.fn(async () => { throw new Error("blocked"); }),
    };
    const mod = await import("../lib/terminal-font");
    await expect(mod.ensureTerminalFont()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-font.test.ts`
Expected: FAIL — `Cannot find module '../lib/terminal-font'`.

- [ ] **Step 3: 实现模块**

Create `packages/relay-web/src/lib/terminal-font.ts`:

```ts
// Lazily injects the JetBrainsMono Nerd Font Mono webfont (via cdn.jsdmirror.com, a
// China-reachable mirror of jsDelivr) and waits for it to load. Called before the ghostty
// terminal is constructed so its first canvas font-measure uses the real font. Idempotent;
// failures (blocked/offline/timeout) resolve silently — the terminal falls back to monospace.

const BASE = "https://cdn.jsdmirror.com/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts";
export const TERMINAL_FONT_FAMILY = "JetBrainsMono NFM";

let injected = false;
let loaded: Promise<void> | undefined;

export function ensureTerminalFont(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    if (typeof document === "undefined") return;
    if (!injected) {
      injected = true;
      const style = document.createElement("style");
      style.dataset.terminalFont = "1";
      style.textContent = `
@font-face{font-family:"${TERMINAL_FONT_FAMILY}";font-weight:400;font-style:normal;font-display:swap;
  src:url("${BASE}/JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2");}
@font-face{font-family:"${TERMINAL_FONT_FAMILY}";font-weight:700;font-style:normal;font-display:swap;
  src:url("${BASE}/JetBrainsMonoNerdFontMono-Bold.woff2") format("woff2");}`;
      document.head.appendChild(style);
    }
    const fonts = (document as unknown as { fonts?: { load?: (f: string) => Promise<unknown> } }).fonts;
    if (fonts?.load) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, 4000); });
      await Promise.race([
        Promise.resolve(fonts.load(`13px "${TERMINAL_FONT_FAMILY}"`)).then(() => {}, () => {}),
        timeout,
      ]);
      if (timer) clearTimeout(timer);
    }
  })();
  return loaded;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-font.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/lib/terminal-font.ts packages/relay-web/src/__tests__/terminal-font.test.ts
git commit -m "feat(relay-web): lazy JetBrainsMono Nerd Font loader via jsdmirror"
```

---

### Task 2: adapter 加 `fit()` + 字体选项 + focus

**Files:**
- Modify: `packages/relay-web/src/lib/terminal-adapter.ts`（整文件替换）
- Test: `packages/relay-web/src/__tests__/terminal-adapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: `ensureTerminalFont` from `./terminal-font` (Task 1)。
- Produces（`TerminalAdapter` 新增）：
  - `fit(): { cols: number; rows: number } | null` — 从渲染后的 canvas 度量反推容器可容纳的 cols/rows；canvas 未就绪返回 `null`。
  - `focus(): void`。
  - `TerminalAdapterOptions` 新增可选 `fontFamily?: string`、`fontSize?: number`。
  - `GhosttyTerminalLike` 新增可选 `element?`、`focus?`、`paste?`。

- [ ] **Step 1: 写失败测试（追加到现有文件）**

在 `packages/relay-web/src/__tests__/terminal-adapter.test.ts` 的 `describe("terminal-adapter", ...)` 内追加：

```ts
  it("fit() computes cols/rows from the rendered canvas metrics", async () => {
    const canvas = document.createElement("canvas");
    // 80 cols * 10px = 800 wide; 24 rows * 20px = 480 tall → cellW=10, cellH=20
    canvas.getBoundingClientRect = () => ({ width: 800, height: 480 }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(canvas);
    const term = { ...fakeTerminal(), element, cols: 80, rows: 24 };
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });  // 400/10 = 40
    Object.defineProperty(el, "clientHeight", { value: 240, configurable: true }); // 240/20 = 12
    const a = createTerminalAdapter(el, { cols: 80, rows: 24, onData: () => {}, factory: () => term as never });
    await Promise.resolve();
    expect(a.fit()).toEqual({ cols: 40, rows: 12 });
  });

  it("fit() returns null before the canvas has a measurable size", async () => {
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(canvas);
    const term = { ...fakeTerminal(), element, cols: 80, rows: 24 };
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term as never,
    });
    await Promise.resolve();
    expect(a.fit()).toBeNull();
  });

  it("focus() proxies to the underlying terminal", async () => {
    const focus = vi.fn();
    const term = { ...fakeTerminal(), focus };
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term as never,
    });
    await Promise.resolve();
    a.focus();
    expect(focus).toHaveBeenCalled();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-adapter.test.ts`
Expected: FAIL — `a.fit is not a function` / `a.focus is not a function`.

- [ ] **Step 3: 替换 `terminal-adapter.ts` 全文**

Replace `packages/relay-web/src/lib/terminal-adapter.ts` with:

```ts
// Thin wrapper over ghostty-web (xterm.js-compatible API). Isolating it here means a
// future swap back to @xterm/xterm only touches this file. Adds fit() (derive cols/rows
// from ghostty's own rendered canvas metrics — most accurate) and lazy webfont loading.

import { ensureTerminalFont, TERMINAL_FONT_FAMILY } from "./terminal-font";

export interface GhosttyTerminalLike {
  open(el: HTMLElement): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  focus?(): void;
  paste?(data: string): void;
  element?: HTMLElement;
  cols: number;
  rows: number;
}

export interface TerminalAdapter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  focus(): void;
  /** Compute cols/rows that fit the host element, using the rendered canvas cell size.
   *  Returns null until the canvas has a measurable size. */
  fit(): { cols: number; rows: number } | null;
  cols(): number;
  rows(): number;
}

export interface TerminalAdapterOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  fontFamily?: string;
  fontSize?: number;
  /** Test seam. Defaults to constructing a real ghostty-web Terminal. */
  factory?: (cols: number, rows: number) => GhosttyTerminalLike;
}

// ghostty-web loads its ~400KB WASM once via the argless `init()`, which fetches
// `ghostty-vt.wasm` from the served root. We also lazily load the JetBrainsMono webfont
// before constructing the Terminal so its first font-measure is correct.
let ghosttyInit: Promise<void> | undefined;

async function defaultFactory(
  cols: number, rows: number, fontFamily: string, fontSize: number,
): Promise<GhosttyTerminalLike> {
  const mod = await import("ghostty-web");
  ghosttyInit ??= mod.init();
  await ghosttyInit;
  await ensureTerminalFont();
  return new mod.Terminal({ cols, rows, fontFamily, fontSize }) as unknown as GhosttyTerminalLike;
}

export function createTerminalAdapter(el: HTMLElement, opts: TerminalAdapterOptions): TerminalAdapter {
  let live: GhosttyTerminalLike | undefined;
  const fontFamily = opts.fontFamily ?? `"${TERMINAL_FONT_FAMILY}", monospace`;
  const fontSize = opts.fontSize ?? 13;

  const ready: Promise<GhosttyTerminalLike> = opts.factory
    ? Promise.resolve(opts.factory(opts.cols, opts.rows))
    : defaultFactory(opts.cols, opts.rows, fontFamily, fontSize);

  // open()/onData() are called ONLY inside ready.then — never synchronously. With an
  // injected factory (tests), ready is already-resolved, so .then runs next microtask;
  // await Promise.resolve() in tests before asserting.
  void ready.then((t) => {
    live = t;
    t.open(el);
    t.onData(opts.onData);
  });

  return {
    write: (d) => live?.write(d),
    resize: (c, r) => live?.resize(c, r),
    dispose: () => live?.dispose(),
    focus: () => live?.focus?.(),
    fit: () => {
      if (!live?.element || !live.cols || !live.rows) return null;
      const canvas = live.element.querySelector("canvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const cellW = rect.width / live.cols;
      const cellH = rect.height / live.rows;
      if (!(cellW > 0) || !(cellH > 0)) return null;
      return {
        cols: Math.max(2, Math.floor(el.clientWidth / cellW)),
        rows: Math.max(1, Math.floor(el.clientHeight / cellH)),
      };
    },
    cols: () => live?.cols ?? opts.cols,
    rows: () => live?.rows ?? opts.rows,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-adapter.test.ts`
Expected: PASS（原 2 + 新 3 = 5 passed）。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/lib/terminal-adapter.ts packages/relay-web/src/__tests__/terminal-adapter.test.ts
git commit -m "feat(relay-web): terminal adapter fit()/focus() + nerd-font options"
```

---

### Task 3: i18n 快捷键条文案（en + zh）

**Files:**
- Modify: `packages/relay-web/src/i18n/messages/en.ts:290-298`（terminal 块）
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts:288-296`（terminal 块）

**Interfaces:**
- Produces: i18n 键 `terminal.close`、`terminal.keybar.{show,hide,paste,esc,ctrl,tab,up,down,left,right}`（en/zh 各一套，键平价）。

- [ ] **Step 1: 运行既有平价测试，确认当前是绿的（基线）**

Run: `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 2: 改 en.ts 的 terminal 块**

把 `packages/relay-web/src/i18n/messages/en.ts` 的 terminal 块（含 `error: "Could not open the terminal.",` 后的 `},`）替换为：

```ts
  terminal: {
    title: "Terminal",
    disabled: "Terminal is disabled. Enable `terminal.enabled` in the instance config.",
    unsupported: "Terminal is unsupported on this instance platform (v1: macOS/Linux only).",
    offline: "Instance is offline.",
    noSession: "Select a session to open a terminal.",
    exited: "Terminal exited (code {code}).",
    error: "Could not open the terminal.",
    close: "Close terminal",
    keybar: {
      show: "Show shortcut bar",
      hide: "Hide shortcut bar",
      paste: "Paste",
      esc: "Esc",
      ctrl: "Ctrl",
      tab: "Tab",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
    },
  },
```

- [ ] **Step 3: 改 zh-CN.ts 的 terminal 块**

把 `packages/relay-web/src/i18n/messages/zh-CN.ts` 的 terminal 块替换为：

```ts
  terminal: {
    title: "终端",
    disabled: "终端未启用。请在实例 config 中开启 `terminal.enabled`。",
    unsupported: "该实例平台不支持终端(v1 仅 macOS/Linux)。",
    offline: "实例已离线。",
    noSession: "选择一个会话以打开终端。",
    exited: "终端已退出(退出码 {code})。",
    error: "无法打开终端。",
    close: "关闭终端",
    keybar: {
      show: "显示快捷键条",
      hide: "隐藏快捷键条",
      paste: "粘贴",
      esc: "Esc",
      ctrl: "Ctrl",
      tab: "Tab",
      up: "上",
      down: "下",
      left: "左",
      right: "右",
    },
  },
```

- [ ] **Step 4: 运行确认平价仍绿**

Run: `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts`
Expected: PASS（zh 与 en 键完全一致；无空串）。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "i18n(relay-web): terminal shortcut-bar strings (en/zh)"
```

---

### Task 4: `TerminalTab.vue` 重构为中置组件（header + 快捷键条 + fit + sticky Ctrl）

**Files:**
- Modify: `packages/relay-web/src/__tests__/setup.ts`（加 ResizeObserver / rAF polyfill）
- Modify: `packages/relay-web/src/components/TerminalTab.vue`（整文件替换）
- Test: `packages/relay-web/src/__tests__/terminal-tab.test.ts`（更新 mock + 追加用例）

**Interfaces:**
- Consumes: `createTerminalAdapter`（Task 2，含 `fit`/`focus`）、`useTerminalStore().input/resize/close/create/onOutput/onExit`、i18n `terminal.*`（Task 3）。
- Produces: `<TerminalTab :instance-id :session-alias @close>` — 全高中置终端；顶栏含 `data-test="toggle-keybar"`、`data-test="term-close"`；快捷键条含 `data-test="keybar"` 及按钮 `key-esc/key-tab/key-ctrl/key-up/key-down/key-left/key-right/key-paste`。

- [ ] **Step 1: 加测试基建 polyfill（setup.ts）**

在 `packages/relay-web/src/__tests__/setup.ts` 末尾追加（幂等，仅在缺失时装）：

```ts
// jsdom 不实现 ResizeObserver / requestAnimationFrame。终端组件依赖二者做 fit 驱动；
// 装最小 stub 让相关测试确定性（不真正观察，仅提供可构造的 API）。
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "undefined") {
  (globalThis as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  (globalThis as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: number) => clearTimeout(id);
}
```

- [ ] **Step 2: 更新 mock + 写失败测试（替换 terminal-tab.test.ts 全文）**

Replace `packages/relay-web/src/__tests__/terminal-tab.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

const adapter = {
  write: vi.fn(), resize: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
  fit: vi.fn(() => ({ cols: 80, rows: 24 })),
  cols: () => 80, rows: () => 24,
};
vi.mock("../lib/terminal-adapter", () => ({ createTerminalAdapter: vi.fn(() => adapter) }));
vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));
vi.mock("../api/events", () => ({ sendWebClientMessage: vi.fn() }));

import TerminalTab from "../components/TerminalTab.vue";
import { createTerminalAdapter } from "../lib/terminal-adapter";
import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";

const globalOpts = { mocks: { $t: (k: string) => k } };
const tick = () => new Promise((r) => setTimeout(r, 0));

// Grab the onData callback TerminalTab passed into the (mocked) adapter factory.
function onDataOf() {
  const call = vi.mocked(createTerminalAdapter).mock.calls.at(-1);
  return (call![1] as { onData: (d: string) => void }).onData;
}

describe("TerminalTab", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); localStorage.clear(); });

  it("creates a terminal and mounts the adapter when a session is selected", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(createTerminalAdapter).toHaveBeenCalled();
  });

  it("shows the no-session hint when sessionAlias is empty", () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "" }, global: globalOpts });
    expect(w.text()).toContain("terminal.noSession");
    expect(createTerminalAdapter).not.toHaveBeenCalled();
  });

  it("maps a resolved errorPayload 'terminal-disabled' to the disabled hint", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "internal", message: "terminal-disabled" } } as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.text()).toContain("terminal.disabled");
  });

  it("maps an unrecognized error message to terminal.error", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "session-not-found", message: "session-not-found" } } as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.text()).toContain("terminal.error");
  });

  it("superseded create() is closed and does not leak the terminal", async () => {
    let resolveFn!: (v: unknown) => void;
    const deferred = new Promise((res) => { resolveFn = res; });
    vi.mocked(api.rpc).mockReturnValueOnce(deferred as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "s1" }, global: globalOpts });
    vi.mocked(api.rpc).mockResolvedValueOnce({ terminalId: "t2" } as never);
    await w.setProps({ sessionAlias: "s2" });
    await tick();
    resolveFn({ terminalId: "t1" });
    await tick();
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-close", terminalId: "t1" }),
    );
  });

  it("keybar Esc sends the escape sequence to the PTY", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-esc"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", terminalId: "t1", data: "\u001b" }),
    );
  });

  it("keybar arrow-up sends the CSI up sequence", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-up"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "\u001b[A" }),
    );
  });

  it("sticky Ctrl turns the next typed letter into a control code, then disarms", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-ctrl"]').trigger("click"); // arm
    const onData = onDataOf();
    onData("c");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "\u0003" }),
    );
    vi.mocked(sendWebClientMessage).mockClear();
    onData("d"); // disarmed → plain 'd'
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "d" }),
    );
  });

  it("sticky Ctrl passes a non-letter through unchanged and disarms", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-ctrl"]').trigger("click"); // arm
    const onData = onDataOf();
    onData("1");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "1" }),
    );
  });

  it("keybar defaults visible on non-desktop (no matchMedia)", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.find('[data-test="keybar"]').exists()).toBe(true);
  });

  it("keybar honors a persisted hidden preference", async () => {
    localStorage.setItem("xacpx.terminalKeybar", "0");
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.find('[data-test="keybar"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-tab.test.ts`
Expected: FAIL — 找不到 `[data-test="key-esc"]` 等（新 UI 未实现）。

- [ ] **Step 4: 替换 `TerminalTab.vue` 全文**

Replace `packages/relay-web/src/components/TerminalTab.vue` with:

```vue
<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { ArrowLeft, Keyboard, ClipboardPaste, ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { createTerminalAdapter, type TerminalAdapter } from "../lib/terminal-adapter";
import { useTerminalStore } from "../stores/terminal";

const props = defineProps<{ instanceId: string; sessionAlias: string }>();
const emit = defineEmits<{ close: [] }>();
const terminals = useTerminalStore();
const host = ref<HTMLDivElement | null>(null);
const status = ref<"idle" | "connecting" | "open" | "exited" | "error">("idle");
const errorKey = ref<string>("");
const ctrlArmed = ref(false);

// Mobile has no physical Esc/Ctrl/arrows, so the shortcut bar defaults visible there and
// hidden on desktop (which has a real keyboard). A saved preference overrides the default.
function isDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(min-width: 1024px)").matches;
}
const keybarVisible = ref((() => {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem("xacpx.terminalKeybar") : null;
  if (saved === "1") return true;
  if (saved === "0") return false;
  return !isDesktop();
})());
function toggleKeybar() {
  keybarVisible.value = !keybarVisible.value;
  try { localStorage.setItem("xacpx.terminalKeybar", keybarVisible.value ? "1" : "0"); } catch { /* ignore */ }
}

let adapter: TerminalAdapter | null = null;
let terminalId = "";
let offOutput: (() => void) | null = null;
let offExit: (() => void) | null = null;
let resizeObs: ResizeObserver | null = null;
let epoch = 0;

// Sticky Ctrl only rewrites a single soft-keyboard letter (a-z → charCode & 0x1f, e.g. c→\x03);
// anything else passes through. Fires once, then disarms.
function handleData(d: string) {
  if (!terminalId) return;
  let out = d;
  if (ctrlArmed.value && d.length === 1) {
    const lc = d.toLowerCase().charCodeAt(0);
    if (lc >= 97 && lc <= 122) out = String.fromCharCode(lc - 96);
    ctrlArmed.value = false;
  }
  terminals.input(props.instanceId, terminalId, out);
}

function sendKey(seq: string) {
  if (!terminalId) return;
  terminals.input(props.instanceId, terminalId, seq);
  adapter?.focus();
}

async function pasteClipboard() {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) sendKey(text);
  } catch { /* clipboard blocked/unavailable — ignore */ }
}

// Fit the ghostty grid to the host using the adapter's canvas-derived cell size, then tell
// the PTY. Retries via rAF until the canvas has a measurable size. Epoch-guarded so a
// teardown/supersede stops the retry loop.
function applyFit(myEpoch = epoch) {
  if (myEpoch !== epoch || !terminalId || !adapter) return;
  const dim = adapter.fit();
  if (!dim) { requestAnimationFrame(() => applyFit(myEpoch)); return; }
  adapter.resize(dim.cols, dim.rows);
  terminals.resize(props.instanceId, terminalId, dim.cols, dim.rows);
}

function teardown() {
  epoch++;
  offOutput?.(); offOutput = null;
  offExit?.(); offExit = null;
  resizeObs?.disconnect(); resizeObs = null;
  if (terminalId) terminals.close(props.instanceId, terminalId);
  adapter?.dispose(); adapter = null; terminalId = "";
  ctrlArmed.value = false;
}

async function start() {
  teardown();
  const myEpoch = epoch;
  if (!props.sessionAlias || !host.value) { status.value = "idle"; return; }
  status.value = "connecting";
  const currentAdapter = createTerminalAdapter(host.value, {
    cols: 80, rows: 24,
    onData: handleData,
  });
  adapter = currentAdapter;
  offOutput = terminals.onOutput((id, data) => { if (id === terminalId) adapter?.write(data); });
  offExit = terminals.onExit((id, code) => { if (id === terminalId) { status.value = "exited"; errorKey.value = String(code); } });
  try {
    const newId = await terminals.create(props.instanceId, props.sessionAlias, currentAdapter.cols(), currentAdapter.rows());
    if (myEpoch !== epoch) {
      terminals.close(props.instanceId, newId);
      if (adapter === currentAdapter) currentAdapter.dispose();
      return;
    }
    terminalId = newId;
    status.value = "open";
    resizeObs = new ResizeObserver(() => applyFit());
    if (host.value) resizeObs.observe(host.value);
    applyFit(myEpoch);
  } catch (e) {
    if (myEpoch !== epoch) return;
    status.value = "error";
    const msg = e instanceof Error ? e.message : "";
    errorKey.value = msg === "terminal-disabled" ? "terminal.disabled"
      : msg === "terminal-unsupported-platform" ? "terminal.unsupported"
      : msg === "instance-offline" ? "terminal.offline"
      : "terminal.error";
  }
}

onMounted(() => void start());
watch(() => [props.instanceId, props.sessionAlias], () => void start());
onBeforeUnmount(teardown);
</script>

<template>
  <div class="flex h-full flex-col bg-bg" data-test="terminal-center">
    <!-- header -->
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <button data-test="term-close" :aria-label="$t('terminal.close')"
              class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('close')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("terminal.title") }}</button>
      <span class="h-4 w-px bg-border" aria-hidden="true" />
      <span class="min-w-0 truncate font-mono text-[12.5px] text-fg">{{ props.sessionAlias }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button data-test="toggle-keybar"
                :aria-label="keybarVisible ? $t('terminal.keybar.hide') : $t('terminal.keybar.show')"
                :title="keybarVisible ? $t('terminal.keybar.hide') : $t('terminal.keybar.show')"
                class="grid h-7 w-7 place-items-center rounded transition-colors"
                :class="keybarVisible ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-raised hover:text-fg'"
                @click="toggleKeybar"><Keyboard :size="16" /></button>
      </div>
    </div>

    <!-- body -->
    <div v-if="!props.sessionAlias" class="p-4 text-sm text-fg-muted">{{ $t("terminal.noSession") }}</div>
    <div v-else-if="status === 'error'" class="p-4 text-sm text-fg-muted">{{ $t(errorKey) }}</div>
    <div v-else-if="status === 'exited'" class="p-4 text-sm text-fg-muted">{{ $t("terminal.exited", { code: errorKey }) }}</div>
    <div ref="host" class="min-h-0 flex-1 overflow-hidden bg-black" data-test="terminal-host"></div>

    <!-- shortcut bar -->
    <div v-if="keybarVisible" data-test="keybar"
         class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-surface px-2 py-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] thin-scroll">
      <button data-test="key-esc" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b')">Esc</button>
      <button data-test="key-tab" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\t')">Tab</button>
      <button data-test="key-ctrl" :aria-pressed="ctrlArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors"
              :class="ctrlArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="ctrlArmed = !ctrlArmed">Ctrl</button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-left" :aria-label="$t('terminal.keybar.left')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[D')"><ChevronLeft :size="15" /></button>
      <button data-test="key-up" :aria-label="$t('terminal.keybar.up')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[A')"><ChevronUp :size="15" /></button>
      <button data-test="key-down" :aria-label="$t('terminal.keybar.down')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[B')"><ChevronDown :size="15" /></button>
      <button data-test="key-right" :aria-label="$t('terminal.keybar.right')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[C')"><ChevronRight :size="15" /></button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-paste" class="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="pasteClipboard">
        <ClipboardPaste :size="14" />{{ $t("terminal.keybar.paste") }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-tab.test.ts src/__tests__/terminal-adapter.test.ts`
Expected: PASS（全部）。

- [ ] **Step 6: 提交**

```bash
git add packages/relay-web/src/components/TerminalTab.vue packages/relay-web/src/__tests__/terminal-tab.test.ts packages/relay-web/src/__tests__/setup.ts
git commit -m "feat(relay-web): center terminal with shortcut bar, sticky Ctrl, and fit"
```

---

### Task 5: `DashboardView.vue` — 终端中置覆盖层 + 顶栏开关 + 右栏回退

**Files:**
- Modify: `packages/relay-web/src/views/DashboardView.vue`
- Test: `packages/relay-web/src/__tests__/dashboard-responsive.test.ts`（追加用例 + TerminalTab stub）

**Interfaces:**
- Consumes: `<TerminalTab @close>`（Task 4）、`useChatStore().instanceId/sessionAlias`、`useFilesStore().file/diffPath`。
- Produces: 顶栏 `data-test="toggle-terminal"`（无会话禁用、打开态高亮）；中间列在 `terminalOpen` 时叠 TerminalTab；右栏只剩 Files/Tasks（无 `right-tab-terminal`）。

- [ ] **Step 1: 写失败测试（追加到 dashboard-responsive.test.ts）**

先把文件顶部的 `const stubs` 改为加入 TerminalTab：

```ts
const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, TerminalTab: true, "router-link": true };
```

并在 import 区确保有 `useChatStore`（已存在）。然后在文件末尾追加：

```ts
test("terminal toggle is disabled without a session and enabled with one", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const btn = wrapper.find('[data-test="toggle-terminal"]');
  expect(btn.exists()).toBe(true);
  expect(btn.attributes("disabled")).toBeDefined();

  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();
  expect(wrapper.find('[data-test="toggle-terminal"]').attributes("disabled")).toBeUndefined();
});

test("toggling the terminal opens a center overlay and is mutually exclusive with the file viewer", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  const files = useFilesStore();
  files.file = { workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false };
  await flushPromises();

  await wrapper.find('[data-test="toggle-terminal"]').trigger("click");
  await flushPromises();
  // Terminal overlay is mounted (VTU renders a `true` stub as <terminal-tab-stub>)...
  expect(wrapper.find("terminal-tab-stub").exists()).toBe(true);
  // ...and opening it cleared the file viewer (mutual exclusion).
  expect(files.file).toBeNull();
});

test("the right rail no longer exposes a Terminal tab", async () => {
  const wrapper = mountDash();
  await flushPromises();
  expect(wrapper.find('[data-test="right-tab-terminal"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="right-tab-files"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="right-tab-tasks"]').exists()).toBe(true);
});
```

> 注：`findComponent({ name: "TerminalTab" })` 对 `stubs: { TerminalTab: true }` 生成的 stub 仍可命中（stub 保留组件名）。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-responsive.test.ts`
Expected: FAIL — 找不到 `toggle-terminal`；且 `right-tab-terminal` 仍存在。

- [ ] **Step 3: 改 `DashboardView.vue` — script**

3a. `rightTab` 类型与 `openRight` 收窄（去掉 `"terminal"`）：

把
```ts
const rightTab = ref<"tasks" | "files" | "terminal">("tasks");
```
改为
```ts
const rightTab = ref<"tasks" | "files">("tasks");
const terminalOpen = ref(false);
```

把
```ts
function openRight(tab: "tasks" | "files" | "terminal") {
```
改为
```ts
function openRight(tab: "tasks" | "files") {
```

3b. 互斥 watcher。把现有
```ts
watch(viewingFile, (v) => { if (v) rightOpen.value = false; });
```
改为
```ts
watch(viewingFile, (v) => { if (v) { rightOpen.value = false; terminalOpen.value = false; } });
watch(terminalOpen, (v) => { if (v) { files.file = null; files.diffPath = null; rightOpen.value = false; } });
// 会话被清空时自动收起终端（否则会显示无会话态且开关已禁用）。
watch(() => chat.sessionAlias, (a) => { if (!a) terminalOpen.value = false; });
```

- [ ] **Step 4: 改 `DashboardView.vue` — 顶栏开关按钮**

在全局 header 右簇里、`theme-toggle` 按钮**之前**插入（`SquareTerminal` 已在现有 import 中）：

```html
        <button
          data-test="toggle-terminal"
          :aria-label='$t("terminal.title")'
          :title='$t("terminal.title")'
          :disabled="!chat.sessionAlias"
          class="grid h-7 w-7 place-items-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          :class="terminalOpen ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-fg-muted hover:bg-raised'"
          @click="terminalOpen = !terminalOpen"
        >
          <SquareTerminal :size="15" />
        </button>
```

- [ ] **Step 5: 改 `DashboardView.vue` — 中间列叠 TerminalTab**

把中间列
```html
      <div data-test="column" class="relative flex min-w-0 flex-1 flex-col">
        <ChatPane class="absolute inset-0" :inert="viewingFile" @show-files="rightTab = 'files'" />
        <FileViewer v-if="viewingFile" class="absolute inset-0 z-10" @back="backToFileList" @close="closeFileViewer" />
      </div>
```
改为
```html
      <div data-test="column" class="relative flex min-w-0 flex-1 flex-col">
        <ChatPane class="absolute inset-0" :inert="viewingFile || terminalOpen" @show-files="rightTab = 'files'" />
        <FileViewer v-if="viewingFile" class="absolute inset-0 z-10" @back="backToFileList" @close="closeFileViewer" />
        <TerminalTab v-if="terminalOpen" class="absolute inset-0 z-20"
                     :instance-id="chat.instanceId ?? ''" :session-alias="chat.sessionAlias ?? ''"
                     @close="terminalOpen = false" />
      </div>
```

- [ ] **Step 6: 改 `DashboardView.vue` — 右栏去掉 Terminal tab**

删除右栏里的 Terminal tab 按钮块：
```html
          <button data-test="right-tab-terminal"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="rightTab === 'terminal' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'terminal'">
            <SquareTerminal :size="13" />{{ $t("terminal.title") }}
          </button>
```
并把右栏 body 里的三分支
```html
          <TaskPanel v-if="rightTab === 'tasks'" />
          <TerminalTab v-else-if="rightTab === 'terminal'" :instance-id="chat.instanceId ?? ''" :session-alias="chat.sessionAlias ?? ''" />
          <FilesPanel v-else :instance-id="chat.instanceId" />
```
改为
```html
          <TaskPanel v-if="rightTab === 'tasks'" />
          <FilesPanel v-else :instance-id="chat.instanceId" />
```

（`TerminalTab` 的 import 保留——现在用于中间列。）

- [ ] **Step 7: 运行确认通过 + typecheck**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-responsive.test.ts && npx vue-tsc --noEmit -p tsconfig.json`
Expected: 测试 PASS；typecheck 无错（`rightTab` 已无 `"terminal"` 分支残留引用）。

> 若仓库无独立 `vue-tsc` 脚本，用根 `npx tsc --noEmit` 或 `bun run build` 对应的类型检查命令替代（见 CLAUDE.md 构建段）。

- [ ] **Step 8: 提交**

```bash
git add packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/__tests__/dashboard-responsive.test.ts
git commit -m "feat(relay-web): move terminal to center overlay with a top-bar toggle"
```

---

### Task 6: 全量回归 + 构建验证

**Files:** 无新增（验证任务）。

- [ ] **Step 1: 跑 relay-web 全量单测**

Run: `cd packages/relay-web && npx vitest run`
Expected: 全绿（含 i18n-parity、terminal-*、dashboard-responsive）。

- [ ] **Step 2: 生产构建（验证 Vue SFC/类型/打包无回归）**

Run: `cd packages/relay-web && npm run build`（或仓库既有的 relay-web build 命令）
Expected: 构建成功，无类型/编译错误。

- [ ] **Step 3: 提交（若构建产物需随包，一般不提交 dist；仅在有回归修复时提交）**

无改动则跳过。

---

## Self-Review

**Spec coverage：**
- 中置覆盖层 + 互斥 + 顶栏按钮 + 右栏回退 → Task 5 ✅
- 动态宽度适配（canvas 度量 fit + rAF 重试 + epoch 守卫）→ Task 2（fit）+ Task 4（applyFit/ResizeObserver）✅
- 快捷键条（Esc/Tab/Ctrl/方向键/粘贴）+ 粘滞 Ctrl 仅字母 + 默认显隐/持久化 → Task 4 ✅
- Nerd Font（NFM，镜像按需注入，失败回落）→ Task 1 + Task 2（adapter 透传 fontFamily/fontSize）✅
- i18n en/zh → Task 3（平价由既有测试守卫）✅
- 测试计划（adapter fit、font、TerminalTab keybar/ctrl/可见性、Dashboard 切换/互斥/右栏）→ Task 2/1/4/5 ✅

**Placeholder scan：** 无 TBD/TODO；所有代码步给出完整代码。Task 5 step7 的 typecheck 命令给了回退方案（仓库脚本名可能不同）。

**Type consistency：** `fit()` 返回 `{ cols, rows } | null` 在 Task 2 定义、Task 4 `applyFit` 消费一致；`focus()`、`TERMINAL_FONT_FAMILY`、`ensureTerminalFont` 跨任务签名一致；`rightTab` 收窄为 `"tasks" | "files"` 后 Task 5 无 `"terminal"` 残留；i18n 键 `terminal.keybar.*` 在 Task 3 定义、Task 4 模板消费一致。

## 风险与缓解（承 spec）
- canvas 首帧宽 0 → `fit()` 返回 null，rAF 重试至就绪；epoch 守卫防 teardown 后野重试。
- 字体镜像不可达 → 4s 超时 + catch 回落 monospace，不阻塞 open。
- clipboard 被拒 → `pasteClipboard` try/catch 静默。
- jsdom 缺 ResizeObserver/rAF → Task 4 step1 setup polyfill。
