# relay-web xacpx 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 relay-web 看板改造成 xacpx 品牌化、token 驱动的双主题（暗/浅）精致控制台界面，零 emoji（全 Lucide 图标）、Inter+JetBrains Mono 字体、品牌蓝绿配色。

**Architecture:** 先建一层语义化设计 token（CSS 变量 RGB 通道 + Tailwind `theme.extend.colors` 映射，`darkMode:'class'`），所有组件改用语义类（`bg-surface`/`text-fg`/`text-accent`…），一套类名两套主题自动生效；再引入字体、Lucide 图标、品牌 logo、theme store；最后逐组件套用统一映射做皮肤改造。纯皮肤层，不动数据流/协议/store 逻辑（theme store 除外）。

**Tech Stack:** Vue 3 (`<script setup lang="ts">`) + Pinia + Tailwind CSS + Vite + vitest/jsdom + `vue-tsc`；新增依赖 `lucide-vue-next`、`@fontsource/inter`、`@fontsource/jetbrains-mono`。

**前置硬约束（时机/分支）：** 本计划**仅在 PR #35（session-model-selection）与 #36（relay-web hapi-borrow）合入 main 之后**执行。在更新后的 main 上开分支 `feat/relay-web-xacpx-redesign`。所有路径相对仓库根 `packages/relay-web/`。

**设计依据：** [`docs/superpowers/specs/2026-06-15-relay-web-redesign-design.md`](../specs/2026-06-15-relay-web-redesign-design.md)。视觉参考 mockup：[`docs/design/relay-web-redesign/variant-e-xacpx.html`](../../design/relay-web-redesign/variant-e-xacpx.html)。

**已确认默认项：** 字体自托管 `@fontsource`；图标 `lucide-vue-next`；默认 dark + 首访尊重系统；字标 `xacpx · relay`；吉祥物本期延后。**Send 按钮纯品牌蓝实色（不渐变），渐变仅用于 logo。**

---

## 命令速查

```bash
cd packages/relay-web
bun run test -- --run <filter>     # 跑指定测试文件（如 instances.test）
bun run test                       # 全套 vitest
npx vue-tsc --noEmit               # 类型检查（build 的前半段）
npm run build                      # vue-tsc + vite build
```

不要整目录 bun test；按文件过滤跑。

---

## 共享约定（所有改造任务引用本节，DRY）

### A. 语义类映射（旧 → 新）
改造组件时，**机械替换**以下 Tailwind 类，并**保留所有 `data-test` 属性、props、emits、`v-model`、事件处理不变**：

| 旧（slate/sky/red 硬编码） | 新（语义 token） |
|---|---|
| 页面底 `bg-slate-100` | `bg-bg` |
| 面板/卡片 `bg-white` `bg-slate-50` | `bg-surface` |
| 下拉/弹层/对话框面 `bg-white` | `bg-raised` |
| 主文本 `text-slate-900` `text-black` | `text-fg` |
| 次文本 `text-slate-400/500/600` | `text-fg-muted` |
| 边框 `border` `border-slate-200/300` | `border-border` |
| chip 灰底 `bg-slate-100` | `bg-bg border border-border`（描边 chip） |
| 主按钮 `bg-sky-500 hover:bg-sky-600 text-white` | `bg-accent hover:bg-accent-hover text-white` |
| 链接/强调 `text-sky-500/600` | `text-accent` |
| 危险 `text-red-500` / `bg-red-50` | `text-danger` / `bg-danger/10` |
| 警告/修改标记 `text-amber-*` | `text-warn` |
| 未读点 `text-sky-500` | `text-info` |
| 运行/working 点 `text-amber-500`/绿 | `text-run-bright`（亮，带 pulse+glow） |
| 运行 HUD 文案/标签 | `text-run` |
| 选中侧栏行 | `bg-accent/10 border-l-2 border-accent` |
| focus | `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent` |
| 等宽数据/计时/计数 | 加 `font-mono`（计时计数再加 `tabular-nums`） |

### B. emoji → Lucide 图标映射
全部 emoji 用 `lucide-vue-next` 组件替换，`:size` 取 16（侧栏/chip）或 18（header）：

| emoji | Lucide | 用处 |
|---|---|---|
| 📁 | `Folder` | workspace chip |
| 🤖 | `Bot` | agent chip / 会话 agent |
| 🧠 | `Brain` | model chip |
| 🔧 | `Wrench` | 运行工具数 |
| ● 运行 | `<span class="…">` 圆点 | 状态点（非 emoji 已是字符 `●`→改 `<span>`） |
| 🔍/搜索 | `Search` | 全局搜索 |
| ⌘K | `Command` | 命令面板入口 |
| ⚙️/设置 | `Settings` | 设置 |
| ✕/关闭 | `X` | 对话框关闭 |
| ▾/▸ | `ChevronDown`/`ChevronRight` | 折叠/下拉 |
| ＋ | `Plus` | 新建会话 |
| 📋/列表 | `List` | 任务/列表 |
| 复制 | `Copy`/`Check` | CopyButton |
| git | `GitBranch` | git chip |
| 文件 | `File` | 文件树叶子 |
| 收起面板 | `PanelLeft` | 侧栏折叠 |
| ⚠ | `AlertTriangle` | 警告/错误 |

icon-only 按钮必须加 `aria-label`。状态点配文字/title，不靠颜色单独传义。

### C. 动效守卫
所有 pulse / shimmer / spinner / 主题过渡包裹 `motion-reduce:animate-none`（或 CSS `@media (prefers-reduced-motion: reduce)`）。过渡时长 150–300ms。

### D. 每个改造任务的通用验收
- `npx vue-tsc --noEmit` 绿；该组件相关 `*.test.ts` 全绿（必要时同步更新断言：emoji 文本断言 → 改为断言 Lucide 图标的 `data-test`/`aria-label` 或 svg 存在；硬编码颜色类断言 → 改语义类）。
- 暗/浅两主题各自手测一眼（截图或浏览器）：无对比度坍塌、无残留浅色硬编码。

---

## 文件结构（新增/修改总览）

**新增**
- `packages/relay-web/src/stores/theme.ts` — 主题 store（mode/apply/set/toggle）。
- `packages/relay-web/src/stores/__tests__`… 实际测试落 `src/__tests__/theme.test.ts`。
- `packages/relay-web/src/components/BrandLogo.vue` — 内联 SVG 品牌 logo。
- `packages/relay-web/src/lib/icons.ts` —（可选）集中 re-export 常用 Lucide 图标，统一 size。

**修改（基础层）**
- `packages/relay-web/tailwind.config.js`、`src/style.css`、`index.html`、`src/main.ts`、`package.json`。

**修改（组件/视图，逐个套映射）**
- 壳：`views/DashboardView.vue`、`components/ConnectionBadge.vue`
- 侧栏：`components/InstanceTree.vue`
- 聊天：`components/ChatPane.vue`、`MessageList.vue`、`StreamMarkdown.vue`、`CopyButton.vue`、`ToolCallPanel.vue`、`ToolDetail.vue`、`ReasoningPanel.vue`、`PromptInput.vue`
- 右栏：`components/FilesPanel.vue`、`TaskPanel.vue`、`OrchestrationTasks.vue`、`ScheduledTasks.vue`、`CommandPalette.vue`
- 弹层/页：`components/NewSessionDialog.vue`、`ManageInstanceDialog.vue`、`AgentsManager.vue`、`WorkspacesManager.vue`、`NoticeToast.vue`、`FueCallout.vue`、`FueDot.vue`、`views/SettingsView.vue`、`views/LoginView.vue`

---

# Phase 0 — 基础层（token / 主题 / 字体 / 图标 / logo）

### Task 1: Tailwind 配置 — darkMode + 语义色 + 字体族

**Files:** Modify `packages/relay-web/tailwind.config.js`

- [ ] **Step 1: 写配置**

```js
export default {
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--c-bg) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        raised: "rgb(var(--c-raised) / <alpha-value>)",
        border: "rgb(var(--c-border) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        "fg-muted": "rgb(var(--c-fg-muted) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "accent-hover": "rgb(var(--c-accent-hover) / <alpha-value>)",
        run: "rgb(var(--c-run) / <alpha-value>)",
        "run-bright": "rgb(var(--c-run-bright) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 2: 校验** `cd packages/relay-web && npx vue-tsc --noEmit`（应无新错误；JS 配置不参与 ts 检查，主要确认未破坏）。Expected: PASS。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/tailwind.config.js
git commit -m "feat(relay-web): tailwind darkMode + semantic color/font tokens"
```

---

### Task 2: 设计 token CSS 变量（暗/浅）+ 全局 body 基样

**Files:** Modify `packages/relay-web/src/style.css`

- [ ] **Step 1: 写 token 与基样**（RGB 通道值，支持 `/<alpha>` 透明度）

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Light theme */
  --c-bg: 246 248 251;          /* #F6F8FB */
  --c-surface: 255 255 255;     /* #FFFFFF */
  --c-raised: 255 255 255;      /* #FFFFFF (+shadow) */
  --c-border: 228 233 240;      /* #E4E9F0 */
  --c-fg: 18 24 35;             /* #121823 */
  --c-fg-muted: 91 102 117;     /* #5B6675 */
  --c-accent: 46 123 224;       /* #2E7BE0 */
  --c-accent-hover: 37 105 200; /* #2569C8 */
  --c-run: 31 157 87;           /* #1F9D57 */
  --c-run-bright: 52 192 110;   /* #34C06E */
  --c-warn: 217 119 6;          /* #D97706 */
  --c-danger: 239 68 68;        /* #EF4444 */
  --c-info: 37 99 235;          /* #2563EB */
}
.dark {
  /* Dark theme */
  --c-bg: 14 17 22;             /* #0E1116 */
  --c-surface: 21 26 33;        /* #151A21 */
  --c-raised: 27 33 42;         /* #1B212A */
  --c-border: 38 45 56;         /* #262D38 */
  --c-fg: 232 236 241;          /* #E8ECF1 */
  --c-fg-muted: 148 160 176;    /* #94A0B0 */
  --c-accent: 79 155 245;       /* #4F9BF5 */
  --c-accent-hover: 107 176 248;/* #6BB0F8 */
  --c-run: 70 194 119;          /* #46C277 */
  --c-run-bright: 105 214 137;  /* #69D689 */
  --c-warn: 251 191 36;         /* #FBBF24 */
  --c-danger: 248 113 113;      /* #F87171 */
  --c-info: 96 165 250;         /* #60A5FA */
}

/* Brand gradient — logo only */
:root { --brand-from: #4F9BF5; --brand-to: #69D689; }

html, body, #app { height: 100%; }
body { @apply bg-bg text-fg font-sans antialiased; }
```

- [ ] **Step 2: 校验**：`npm run build` 走通（Tailwind 能解析语义类）。Expected: build 成功。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/style.css
git commit -m "feat(relay-web): dark/light design tokens + global base styles"
```

---

### Task 3: 自托管字体（Inter + JetBrains Mono）

**Files:** Modify `packages/relay-web/package.json`、`src/main.ts`

- [ ] **Step 1: 安装依赖**

```bash
cd packages/relay-web
bun add @fontsource/inter @fontsource/jetbrains-mono
```

- [ ] **Step 2: 在 `src/main.ts` 顶部引入所需字重**（紧跟现有 import 之前/之后均可，置于 `createApp` 之前）

```ts
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
```

- [ ] **Step 3: 校验**：`npm run build` 成功，产物含字体资源。Expected: PASS。
- [ ] **Step 4: Commit**

```bash
git add packages/relay-web/package.json packages/relay-web/src/main.ts ../../bun.lock
git commit -m "feat(relay-web): self-host Inter + JetBrains Mono via @fontsource"
```

> 注：`bun.lock` 在仓库根；只因新增依赖而改动时才一并提交，不要提交其它无关 lock 改动。

---

### Task 4: 主题 store + 单测

**Files:** Create `packages/relay-web/src/stores/theme.ts`；Create `packages/relay-web/src/__tests__/theme.test.ts`

- [ ] **Step 1: 写失败测试** `src/__tests__/theme.test.ts`

```ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.className = "";
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to dark and applies the dark class", async () => {
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  expect(t.mode).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("toggle flips the mode, persists it, and updates the class", async () => {
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  t.toggle();
  expect(t.mode).toBe("light");
  expect(localStorage.getItem("relay-theme")).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("honors a saved preference over the default", async () => {
  localStorage.setItem("relay-theme", "light");
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  expect(t.mode).toBe("light");
});
```

- [ ] **Step 2: 跑测试确认失败** `bun run test -- --run theme.test`。Expected: FAIL（找不到 `../stores/theme`）。
- [ ] **Step 3: 实现** `src/stores/theme.ts`

```ts
import { defineStore } from "pinia";
import { ref } from "vue";

export type ThemeMode = "dark" | "light";
const KEY = "relay-theme";

function initialMode(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>(initialMode());
  function apply() {
    document.documentElement.classList.toggle("dark", mode.value === "dark");
    document.documentElement.style.colorScheme = mode.value;
  }
  function set(next: ThemeMode) {
    mode.value = next;
    localStorage.setItem(KEY, next);
    apply();
  }
  function toggle() { set(mode.value === "dark" ? "light" : "dark"); }
  apply();
  return { mode, set, toggle, apply };
});
```

- [ ] **Step 4: 跑测试确认通过** `bun run test -- --run theme.test`。Expected: 3 passed。
- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/stores/theme.ts packages/relay-web/src/__tests__/theme.test.ts
git commit -m "feat(relay-web): theme store (dark default, persist, system-aware)"
```

---

### Task 5: 首屏防闪脚本

**Files:** Modify `packages/relay-web/index.html`

- [ ] **Step 1: 在 `<head>` 内、样式表加载前插入内联脚本**

```html
<script>
  (function () {
    try {
      var m = localStorage.getItem('relay-theme');
      if (m !== 'dark' && m !== 'light') {
        m = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.documentElement.classList.toggle('dark', m === 'dark');
      document.documentElement.style.colorScheme = m;
    } catch (e) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    }
  })();
</script>
```

- [ ] **Step 2: 校验**：`npm run build` 成功；本地预览首帧无浅→暗闪烁。Expected: PASS。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/index.html
git commit -m "feat(relay-web): inline anti-flash theme bootstrap"
```

---

### Task 6: Lucide 图标 + 品牌 Logo 组件

**Files:** 安装 `lucide-vue-next`；Create `packages/relay-web/src/components/BrandLogo.vue`；Create `packages/relay-web/src/__tests__/brandlogo.test.ts`

- [ ] **Step 1: 安装图标库**

```bash
cd packages/relay-web
bun add lucide-vue-next
```

- [ ] **Step 2: 写失败测试** `src/__tests__/brandlogo.test.ts`

```ts
import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import BrandLogo from "../components/BrandLogo.vue";

it("renders the gradient X mark and the xacpx · relay wordmark", () => {
  const w = mount(BrandLogo);
  expect(w.find('[data-test="brand-x"]').exists()).toBe(true);
  expect(w.find("linearGradient").exists()).toBe(true);
  expect(w.text()).toContain("xacpx");
  expect(w.text()).toContain("relay");
});
```

- [ ] **Step 3: 跑确认失败** `bun run test -- --run brandlogo.test`。Expected: FAIL（无组件）。
- [ ] **Step 4: 实现** `src/components/BrandLogo.vue`（X 用品牌渐变描边；`relay` 角标用 `text-fg-muted`）

```vue
<script setup lang="ts">
// Inline brand mark: a rounded geometric "X" stroked with the xacpx blue→green
// gradient, followed by the "xacpx · relay" lockup. Gradient is used ONLY here.
</script>

<template>
  <div class="flex items-center gap-2 select-none">
    <svg data-test="brand-x" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="xacpxBrand" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop stop-color="#4F9BF5" />
          <stop offset="1" stop-color="#69D689" />
        </linearGradient>
      </defs>
      <path d="M5 5 L19 19 M19 5 L5 19" stroke="url(#xacpxBrand)" stroke-width="3.2"
            stroke-linecap="round" />
    </svg>
    <span class="text-[15px] font-semibold tracking-tight text-fg">xacpx</span>
    <span class="text-fg-muted text-xs">· relay</span>
  </div>
</template>
```

- [ ] **Step 5: 跑确认通过** `bun run test -- --run brandlogo.test`。Expected: passed。
- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/package.json ../../bun.lock packages/relay-web/src/components/BrandLogo.vue packages/relay-web/src/__tests__/brandlogo.test.ts
git commit -m "feat(relay-web): lucide-vue-next + xacpx BrandLogo component"
```

---

# Phase 1 — 壳层

### Task 7: DashboardView 顶栏 + 三栏 token 化

**Files:** Modify `packages/relay-web/views/DashboardView.vue`（真实路径 `src/views/DashboardView.vue`）；Test: `src/__tests__/dashboard*.test.ts`（若存在）

按【共享约定 A/B/C】改造。具体：

- [ ] **Step 1: 新增/重排顶栏**：高 ~44px（`h-11`），`bg-surface border-b border-border`，左侧放 `<BrandLogo/>` + `<ConnectionBadge/>`；右侧放：全局搜索按钮（`Search` 图标 + `⌘K`，点击触发现有 CommandPalette 打开逻辑 `paletteOpen=true`）、主题切换按钮、设置入口（`Settings` 图标，`aria-label="Settings"`）。主题切换：
```ts
import { useThemeStore } from "../stores/theme";
const theme = useThemeStore();
```
按钮：`<button :aria-label="theme.mode==='dark' ? 'Switch to light' : 'Switch to dark'" @click="theme.toggle()">` 内放 `Sun`/`Moon`（Lucide）按 `theme.mode` 切换显示。
- [ ] **Step 2: 三栏底/边框 token 化**：根容器 `bg-bg text-fg`；左右栏 `bg-surface border-border`；保留现有布局/响应式与 `@show-files`、`onGlobalKey`、`paletteOpen` 等逻辑不变。
- [ ] **Step 3: 校验**：`npx vue-tsc --noEmit` 绿；`bun run test`（DashboardView 相关测试，若有）绿；暗/浅各看一眼顶栏。
- [ ] **Step 4: Commit**

```bash
git add packages/relay-web/src/views/DashboardView.vue
git commit -m "feat(relay-web): top bar (brand logo + search + theme toggle) and tokenized shell"
```

---

### Task 8: ConnectionBadge token 化

**Files:** Modify `src/components/ConnectionBadge.vue`；Test: `src/__tests__/connection.test.ts`

- [ ] **Step 1:** 套【约定 A】：在线 = `text-run` + `bg-run/10` 圆点；断线 = `text-danger` + `bg-danger/10`；容器 `border-border`。保留 `data-test` 与连接状态 props/store 用法。emoji/字符点改 `<span class="h-2 w-2 rounded-full bg-run">`（在线）。
- [ ] **Step 2: 校验**：`bun run test -- --run connection.test` 绿（若断言文本含旧 emoji/颜色，改为断言在线态 `data-test` 与语义类）。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/ConnectionBadge.vue packages/relay-web/src/__tests__/connection.test.ts
git commit -m "feat(relay-web): tokenize ConnectionBadge"
```

---

# Phase 2 — 侧栏

### Task 9: InstanceTree 改造

**Files:** Modify `src/components/InstanceTree.vue`；Test: `src/__tests__/instancetree.test.ts`

按【共享约定】，**保留全部 `data-test`（`online-dot`/`attention-dot`/`session-elapsed`/`no-sessions`/`sessions-loading`/`new-session`/`manage-instance`/`delete-session`）、props、emits、`store.loadSessions`/`removeSession`、`chat.*` 用法、loading/empty 区分逻辑**（Task #36 已做）。

- [ ] **Step 1: 在线/离线点**：`online-dot` → `bg-run`（在线）/`bg-fg-muted`（离线）。
- [ ] **Step 2: 状态点**（`attention-dot`）：`working` → `text-run-bright animate-pulse motion-reduce:animate-none` 并加轻微 glow（内联 `style="text-shadow:0 0 8px rgb(var(--c-run-bright)/.5)"`）；`unread` → `text-info`；`running`（无 chat live）→ `text-run`。
- [ ] **Step 3: 会话行**：高 `h-7`（28px）、`text-sm`；agent 名 `font-mono text-fg-muted`；hover `hover:bg-fg/5`。**选中行**（当前 `chat.sessionAlias`）加 `bg-accent/10 border-l-2 border-accent`。
- [ ] **Step 4: 图标**：`+ new session` 前置 `<Plus :size="14"/>`；`Manage` 可前置 `<Settings2 :size="14"/>`；删除按钮 `text-danger`。`elapsedLabel` 徽标 `text-run font-mono tabular-nums`。
- [ ] **Step 5: 实例折叠箭头**：`<ChevronDown/ChevronRight :size="14"/>` 表示展开态（如当前用字符）。
- [ ] **Step 6: 校验**：`bun run test -- --run instancetree.test` 全绿（更新任何断言旧颜色/emoji 处；data-test 不变则多数断言不动）。
- [ ] **Step 7: Commit**

```bash
git add packages/relay-web/src/components/InstanceTree.vue packages/relay-web/src/__tests__/instancetree.test.ts
git commit -m "feat(relay-web): restyle InstanceTree (status dots, selected row, icons)"
```

---

# Phase 3 — 聊天区

### Task 10: ChatPane header + 上下文 chip + turn HUD

**Files:** Modify `src/components/ChatPane.vue`；Test: `src/__tests__/chatpane.test.ts`

**保留 `data-test`（`ctx-chip-workspace`/`ctx-chip-instance`/`ctx-chip-agent`/`git-summary`/`turn-hud`/`cancel-turn`/`chat-error`）与所有 store/computed/watch 逻辑、verb 轮换不变。**

- [ ] **Step 1: header**：高 ~44px，标题 `text-fg font-medium`；上下文 chip 改描边式 `bg-bg border border-border text-fg-muted text-xs rounded-md`，emoji 换图标：workspace `<Folder :size="14"/>`、instance `<AtSign :size="14"/>`、agent `<Bot :size="14"/>`、git `<GitBranch :size="14"/>` + 状态点 `text-info`。
- [ ] **Step 2: error banner**（`chat-error`）：`bg-danger/10 text-danger`，dismiss 链接 `text-danger underline`。
- [ ] **Step 3: turn HUD**（`turn-hud`）：`text-fg-muted`；运行点 `text-run-bright animate-pulse motion-reduce:animate-none`；动词+`elapsed`（`font-mono tabular-nums`）；工具数前置 `<Wrench :size="12"/>`；`cancel-turn` → `text-danger hover:underline`。
- [ ] **Step 4: 校验**：`bun run test -- --run chatpane.test` 全绿（chip 断言若查 emoji 文本，改查图标 `data-test` 或 svg 存在；`git-summary`/`turn-hud` 文本断言保留）。
- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/components/ChatPane.vue packages/relay-web/src/__tests__/chatpane.test.ts
git commit -m "feat(relay-web): restyle ChatPane header chips + turn HUD"
```

---

### Task 11: MessageList token 化

**Files:** Modify `src/components/MessageList.vue`；Test: `src/__tests__/messagelist*.test.ts`（若存在）

- [ ] **Step 1:** 套【约定 A】：user 行与 assistant 行容器/文本用 `text-fg`/`text-fg-muted`，分隔 `border-border`；user 气泡可用 `bg-accent/10`（淡蓝）区分，assistant 用 `bg-surface`/透明。正文 `text-sm leading-relaxed`（≥14px）。保留 props（`messages`/`streaming`/`live-turn`）与子组件挂载。
- [ ] **Step 2: 校验**：相关测试绿（无则跳过断言更新）；`npx vue-tsc --noEmit` 绿。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/MessageList.vue
git commit -m "feat(relay-web): tokenize MessageList"
```

---

### Task 12: StreamMarkdown + CopyButton（冷调代码主题）

**Files:** Modify `src/components/StreamMarkdown.vue`、`src/components/CopyButton.vue`；Test: `src/__tests__/copybutton.test.ts`

- [ ] **Step 1: 代码块**：容器 `bg-raised border border-border rounded-lg`，代码 `font-mono text-[13px]`；行内 code `bg-fg/5 text-fg rounded px-1`。链接 `text-accent`。若有语法高亮 token 颜色，统一为冷调（关键字 `text-accent`、字符串 `text-run`、注释 `text-fg-muted`、数字 `text-info`）。
- [ ] **Step 2: CopyButton**：用 `<Copy :size="14"/>` 默认、复制成功切 `<Check :size="14" class="text-run"/>`；`aria-label="Copy"`；保留现有复制行为与 `data-test`。
- [ ] **Step 3: 校验**：`bun run test -- --run copybutton.test` 绿。
- [ ] **Step 4: Commit**

```bash
git add packages/relay-web/src/components/StreamMarkdown.vue packages/relay-web/src/components/CopyButton.vue packages/relay-web/src/__tests__/copybutton.test.ts
git commit -m "feat(relay-web): cool code theme + icon CopyButton"
```

---

### Task 13: ToolCallPanel + ToolDetail

**Files:** Modify `src/components/ToolCallPanel.vue`、`src/components/ToolDetail.vue`；Test: 对应 `*.test.ts`（若存在）

- [ ] **Step 1:** 套【约定 A】：步骤块 `bg-surface border-border rounded-lg`；done 状态 `<Check :size="14" class="text-run"/>`、running `<Loader2 :size="14" class="animate-spin motion-reduce:animate-none text-accent"/>`、error `<AlertTriangle class="text-danger"/>`；`+N −M` diff 计数 `font-mono`（`+N` `text-run`、`−M` `text-danger`）；工具名 `font-mono text-fg`，路径 `text-fg-muted`。折叠箭头用 Chevron。保留 props/事件/`data-test`。
- [ ] **Step 2: 校验**：相关测试绿；`npx vue-tsc --noEmit` 绿。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/ToolCallPanel.vue packages/relay-web/src/components/ToolDetail.vue
git commit -m "feat(relay-web): restyle tool step panels with status icons"
```

---

### Task 14: ReasoningPanel（shimmer）

**Files:** Modify `src/components/ReasoningPanel.vue`；Test: `*.test.ts`（若存在）

- [ ] **Step 1:** 文案 `text-fg-muted`；shimmer 动画包 `motion-reduce:animate-none`；折叠/展开图标用 Chevron + `Brain :size="14"`。保留 props/`data-test`。
- [ ] **Step 2: 校验**：相关测试绿。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/ReasoningPanel.vue
git commit -m "feat(relay-web): tokenize ReasoningPanel + reduced-motion shimmer"
```

---

### Task 15: PromptInput（Send 纯蓝 + model chip + 建议浮层）

**Files:** Modify `src/components/PromptInput.vue`；Test: `src/__tests__/promptinput.test.ts`、`src/__tests__/promptinput-model.test.ts`

**保留全部 `data-test`（`composer-send`/`composer-stop`/`cmd-suggestions`/`cmd-suggestion`/`model-chip`/`model-menu`/`model-option`/`model-error`）、props、emits、composer/controls store 用法、键盘逻辑、IME guard 不变。**

- [ ] **Step 1: composer 容器**：卡片化 `bg-surface border border-border rounded-lg`；textarea `bg-transparent text-fg placeholder:text-fg-muted`。
- [ ] **Step 2: Send 按钮**（`composer-send`）：**纯品牌蓝实色**`bg-accent hover:bg-accent-hover text-white disabled:bg-fg/10 disabled:text-fg-muted`，内置 `<Send :size="14"/>`（**不要渐变**）。Stop（`composer-stop`）`bg-danger hover:opacity-90 text-white`。
- [ ] **Step 3: 建议浮层**（`cmd-suggestions`）：`bg-raised border-border shadow-lg`；选中项 `bg-accent/10`，命令名 `font-mono text-fg`，hint `text-fg-muted`。
- [ ] **Step 4: model chip**（`model-chip`）：`bg-bg border border-border text-fg-muted`，前置 `<Brain :size="14"/>`，模型 id `font-mono`，`<ChevronDown :size="12"/>`；菜单（`model-menu`）`bg-raised border-border shadow-lg`，当前项 `bg-accent/10 text-accent` + `<Check :size="14"/>`；`model-error` `text-danger`。
- [ ] **Step 5: 校验**：`bun run test -- --run promptinput.test promptinput-model.test` 全绿（断言基于 `data-test`，应基本不动；若有断言旧 `bg-sky-500` 则改 `bg-accent`）。
- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/components/PromptInput.vue packages/relay-web/src/__tests__/promptinput.test.ts packages/relay-web/src/__tests__/promptinput-model.test.ts
git commit -m "feat(relay-web): restyle composer (solid blue Send, model chip, suggestions)"
```

---

# Phase 4 — 右侧面板

### Task 16: FilesPanel

**Files:** Modify `src/components/FilesPanel.vue`；Test: `src/__tests__/files*.test.ts`（若有组件测试）

- [ ] **Step 1:** 套【约定 A】：面板视觉权重低于聊天（`bg-surface`，文本多 `text-fg-muted`）；文件树叶子 `<File :size="14"/>`、目录 `<Folder :size="14"/>` + Chevron；修改标记用 `text-warn` 小圆点；选中文件 `bg-accent/10`。Changes 摘要：`N files · +X −Y`（`font-mono`，`+X` `text-run`、`−Y` `text-danger`）。保留 `files` store 用法、tab、`data-test`。
- [ ] **Step 2: 校验**：files 相关测试绿（store 测试 `files.test.ts` 不受样式影响应仍绿）。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/FilesPanel.vue
git commit -m "feat(relay-web): restyle FilesPanel (tree + changes summary)"
```

---

### Task 17: 任务面板（TaskPanel / OrchestrationTasks / ScheduledTasks）

**Files:** Modify `src/components/TaskPanel.vue`、`src/components/OrchestrationTasks.vue`、`src/components/ScheduledTasks.vue`；Test: `*.test.ts`（若存在）

- [ ] **Step 1:** 三个文件套【约定 A/B】：容器 `bg-surface border-border`；状态徽标用语义色（运行 `text-run`、失败 `text-danger`、等待 `text-warn`、完成 `text-fg-muted`）；列表项图标用 Lucide（`List`/`Clock`/`CircleCheck` 等）。保留 props/store/`data-test`。
- [ ] **Step 2: 校验**：相关测试绿；`npx vue-tsc --noEmit` 绿。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/TaskPanel.vue packages/relay-web/src/components/OrchestrationTasks.vue packages/relay-web/src/components/ScheduledTasks.vue
git commit -m "feat(relay-web): tokenize task panels"
```

---

### Task 18: CommandPalette

**Files:** Modify `src/components/CommandPalette.vue`；Test: `src/__tests__/commandpalette.test.ts`

- [ ] **Step 1:** 套【约定 A】：浮层 `bg-raised border-border shadow-xl rounded-xl`；搜索框 `<Search :size="16"/>` + `bg-transparent text-fg`；选中行 `bg-accent/10 text-accent`；分组标题 `text-fg-muted`；命令名 `font-mono`。保留键盘导航、`select-session`/`pick-command`/`close` emits、`data-test`。
- [ ] **Step 2: 校验**：`bun run test -- --run commandpalette.test` 全绿。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/CommandPalette.vue packages/relay-web/src/__tests__/commandpalette.test.ts
git commit -m "feat(relay-web): restyle CommandPalette"
```

---

# Phase 5 — 弹层与页面

### Task 19: 对话框与管理器（NewSession / ManageInstance / Agents / Workspaces）

**Files:** Modify `src/components/NewSessionDialog.vue`、`ManageInstanceDialog.vue`、`AgentsManager.vue`、`WorkspacesManager.vue`；Test: 对应 `*.test.ts`（若存在）

- [ ] **Step 1: 统一对话框外观**：遮罩 `bg-black/50`（暗）/适配；面板 `bg-raised border border-border rounded-xl shadow-xl`；标题 `text-fg`，关闭按钮 `<X :size="16"/>` `aria-label="Close"`；输入 `bg-bg border-border text-fg placeholder:text-fg-muted focus-visible:ring-accent`；主按钮 `bg-accent hover:bg-accent-hover text-white`，危险/删除 `text-danger`/`bg-danger`。保留 props/emits（`close`/`created` 等）/store 调用/`data-test`。
- [ ] **Step 2:** 逐文件套用上式（4 个文件各一遍）。
- [ ] **Step 3: 校验**：相关测试绿；`npx vue-tsc --noEmit` 绿。
- [ ] **Step 4: Commit**

```bash
git add packages/relay-web/src/components/NewSessionDialog.vue packages/relay-web/src/components/ManageInstanceDialog.vue packages/relay-web/src/components/AgentsManager.vue packages/relay-web/src/components/WorkspacesManager.vue
git commit -m "feat(relay-web): tokenize dialogs + managers"
```

---

### Task 20: Toast 与 FUE（NoticeToast / FueCallout / FueDot）

**Files:** Modify `src/components/NoticeToast.vue`、`FueCallout.vue`、`FueDot.vue`；Test: `*.test.ts`（若存在）

- [ ] **Step 1:** NoticeToast：`bg-raised border-border shadow-lg text-fg`，按类型着色（success `text-run`、error `text-danger`、info `text-info`）；保留 `aria-live`、自动消失逻辑、`data-test`。FueCallout/FueDot：强调点用 `bg-accent`，文案 `text-fg-muted`。
- [ ] **Step 2: 校验**：相关测试绿。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/components/NoticeToast.vue packages/relay-web/src/components/FueCallout.vue packages/relay-web/src/components/FueDot.vue
git commit -m "feat(relay-web): tokenize toasts + FUE"
```

---

### Task 21: SettingsView（+ 主题偏好控件）

**Files:** Modify `src/views/SettingsView.vue`；Test: `*.test.ts`（若存在）

- [ ] **Step 1:** 套【约定 A】整页 token 化；**新增「外观/主题」设置项**：一个 Dark/Light 二选（或开关），绑定 theme store：
```ts
import { useThemeStore } from "../stores/theme";
const theme = useThemeStore();
```
控件 `@change="theme.set($event)"` 或两个按钮 `@click="theme.set('dark'|'light')"`，当前项 `bg-accent/10 text-accent`。
- [ ] **Step 2: 校验**：相关测试绿；`npx vue-tsc --noEmit` 绿；切换后整页两主题正常。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/views/SettingsView.vue
git commit -m "feat(relay-web): tokenize Settings + theme preference control"
```

---

### Task 22: LoginView（+ 品牌 logo）

**Files:** Modify `src/views/LoginView.vue`；Test: `*.test.ts`（若存在）

- [ ] **Step 1:** 套【约定 A】token 化；顶部放 `<BrandLogo/>`（放大版可直接用组件）；主按钮 `bg-accent`；输入 token 化。保留登录逻辑/`auth` store/`data-test`。
- [ ] **Step 2: 校验**：相关测试绿；两主题登录页正常。
- [ ] **Step 3: Commit**

```bash
git add packages/relay-web/src/views/LoginView.vue
git commit -m "feat(relay-web): tokenize LoginView + brand logo"
```

---

# Phase 6 — 收尾 QA

### Task 23: 双主题 + a11y + 全量校验

**Files:** 视情况微调任意上述文件

- [ ] **Step 1: 全量测试** `cd packages/relay-web && bun run test`。Expected: 全绿（含 theme/brandlogo 新测）。
- [ ] **Step 2: 类型检查** `npx vue-tsc --noEmit`。Expected: PASS。
- [ ] **Step 3: 构建** `npm run build`。Expected: PASS。
- [ ] **Step 4: 残留扫查**：

```bash
grep -rn "slate-\|sky-500\|sky-600\|bg-white\|bg-red-50\|🧠\|📁\|🤖\|🔧\|⚙️\|📋" packages/relay-web/src --include=*.vue
```
Expected: 无输出（剩余命中逐一改为语义类/Lucide）。

- [ ] **Step 5: a11y 抽查**：icon-only 按钮均有 `aria-label`；focus 环可见（键盘 Tab 走查主流程）；`prefers-reduced-motion` 开启后脉冲/shimmer/spinner 停止。
- [ ] **Step 6: 双主题人工 QA**：暗/浅各走查 主屏（侧栏运行态、聊天 HUD、composer、model 菜单、文件面板）、CommandPalette、新建会话对话框、设置、登录；对照 `docs/design/relay-web-redesign/variant-e-xacpx.html`。
- [ ] **Step 7: Commit（如有微调）**

```bash
git add -p packages/relay-web/src
git commit -m "fix(relay-web): redesign QA sweep (contrast, a11y, leftover tokens)"
```

---

## Self-Review（对照 spec）

- **token 体系（暗/浅）** → Task 1–2 ✓
- **字体 Inter+JetBrains Mono 自托管** → Task 3 ✓
- **theme store + 默认 dark + 系统感知 + 防闪 + 切换入口** → Task 4/5/7/21 ✓
- **Lucide 图标替换全部 emoji + 品牌 logo** → Task 6 + 各组件 + Task 23 grep 兜底 ✓
- **逐组件改造（23 组件 + 3 视图）** → Task 7–22 覆盖 spec §5 全部组件 ✓
- **Send 纯蓝不渐变、渐变仅 logo** → Task 15 / Task 6 ✓
- **a11y（对比/focus/reduced-motion/aria）** → 各任务【约定 C/D】+ Task 23 ✓
- **保留 data-test/props/emits/store 行为** → 每个改造任务显式要求 ✓

**Placeholder 扫查：** 基础层（Task 1–6）给完整代码；改造任务给完整语义类映射（共享约定 A/B/C）+ 每文件具体改动点 + 验收，非 “TODO/restyle it”。**注意：** 改造任务执行时需先读取 #35/#36 合并后的当前组件源码再套映射（避免本计划预写整文件因合并而过期）；这是本计划的有意设计。

**类型/命名一致性：** token 类名（`bg-bg/surface/raised/border`、`text-fg/fg-muted/accent/run/run-bright/warn/danger/info`）、CSS 变量（`--c-*`、`--brand-from/to`）、store（`useThemeStore`、`mode/set/toggle/apply`、key `relay-theme`）、组件（`BrandLogo`）全计划一致。

---

## Execution Handoff

实现 gated 在 **#35/#36 合入 main** 之后，于新分支 `feat/relay-web-xacpx-redesign` 用 **superpowers:subagent-driven-development** 逐 Task 执行（每 Task 两段评审）。
