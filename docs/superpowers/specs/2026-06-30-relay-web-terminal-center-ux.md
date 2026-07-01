# relay-web 终端：中置化 + 快捷键条 + Nerd Font

状态：设计已确认，待实现
日期：2026-06-30
依赖：已发布的 web 终端最小实现（`TerminalTab.vue` / `terminal-adapter.ts` / `stores/terminal.ts` / hybrid transport）。本次是纯前端（`packages/relay-web`）改造，**不动**协议、hub、connector、core。

## 背景与问题

终端当前是右栏（`DashboardView.vue`）的第三个 tab，点开后在窄栏内渲染。实机暴露两个问题：

1. **太窄**：右栏在桌面可拖宽但仍窄；移动端右栏是固定 `w-72` 抽屉、不能拖宽，终端信息展示严重受限。
2. **不适配宽度**：`terminal-adapter` 的 `cols()`/`rows()` 恒返回构造时的 `80/24`，`TerminalTab` 的 `ResizeObserver` 调 `terminals.resize(adapter.cols(), adapter.rows())` 等于**空转**——ghostty 网格始终 80 列，容器比 80 列窄时内容溢出到视窗右侧看不见。

外加两个体验诉求：

3. 移动端无物理 `Esc`/`Ctrl`/方向键，需要像 HAPI 那样的**快捷键条**（粘贴/Esc/Ctrl/Tab/方向键）。
4. 默认字体不好看，改用 **JetBrainsMono Nerd Font**，经 `cdn.jsdmirror.com` 镜像加载以绕过国内对 `cdn.jsdelivr.net` 的封锁。

## 目标 / 非目标

**目标**
- 终端搬到中间列，像 `FileViewer` 一样全宽覆盖 `ChatPane`。
- 终端真正随容器宽高自适应（正确的 fit）。
- 加可切换的快捷键条：`Esc`、`Tab`、`Ctrl`（粘滞修饰键）、`↑↓←→`、`粘贴`。
- 终端字体改为 JetBrainsMono Nerd Font Mono（经镜像按需加载）。

**非目标**
- 不改协议 / hub / connector / core（透传路径不变）。
- 不实现多终端并存、分屏、终端历史回放。
- 不引入 xterm.js / FitAddon 等新依赖（继续用 ghostty-web；用其暴露的 API 自算 fit）。
- Ctrl 组合仅作用于软键盘字母（覆盖 Ctrl+C 等核心），方向键/Tab/Esc 按钮本身不吃 Ctrl。

## 设计

### 1. 布局：终端为中间列覆盖层（与 FileViewer 对等）

`DashboardView.vue`：

- 新增 `const terminalOpen = ref(false)`。
- 中间列（现 `data-test="column"` 那个 `relative flex min-w-0 flex-1`）叠放三层，均 `absolute inset-0`、`z` 递增：
  1. `ChatPane`（常驻，`:inert="viewingFile || terminalOpen"`）。
  2. `FileViewer`（`v-if="viewingFile"`，`z-10`）。
  3. `TerminalTab`（`v-if="terminalOpen"`，`z-20`），props 传 `chat.instanceId` / `chat.sessionAlias`，监听 `@close` 置 `terminalOpen=false`。
- **互斥**：
  - `watch(terminalOpen, v => { if (v) { files.file = null; files.diffPath = null; rightOpen.value = false; } })`
  - 在已有 `watch(viewingFile, ...)` 中，`if (v) terminalOpen.value = false`。
  - 同一时刻中间列只显示一个覆盖层。
- **入口按钮**：全局顶栏 `header` 右簇（搜索/主题/设置那组）内，主题按钮左侧插入一个 `SquareTerminal` 切换按钮：
  - `data-test="toggle-terminal"`，`:aria-label` 用 `terminal.title`。
  - `:disabled="!chat.sessionAlias"`（无会话时禁用，视觉降透明度）。
  - 打开态高亮（`terminalOpen ? 'text-accent bg-accent/10' : ...`）。
  - `@click="terminalOpen = !terminalOpen"`。
  - 桌面 + 移动端都可见（顶栏本就跨尺寸常驻），解决"桌面无二级栏放按钮"的问题。
- **右栏回退**：`rightTab` 类型改回 `"tasks" | "files"`；删除右栏 Terminal tab 按钮与 `TerminalTab` 在右栏的渲染分支；`openRight` 参数类型同步收窄。右栏恢复为 Files/Tasks。

### 2. `TerminalTab.vue` 重构（全高中置组件）

结构（`flex h-full flex-col`）：

- **Header**（`h-11 shrink-0`，仿 `FileViewer`）：左侧返回/关闭按钮（`ArrowLeft`，`emit('close')`）；标题「`{{ $t('terminal.title') }} · {{ sessionAlias }}`」；右侧快捷键条开关按钮（`Keyboard` 图标，`data-test="toggle-keybar"`，高亮=显）。
- **Body**：`ref="host"` 的 `flex-1 min-h-0 overflow-hidden bg-black`，ghostty 挂载点。错误/退出/无会话态沿用现有文案分支，覆盖在 body 上。
- **Footer 快捷键条**（`v-if="keybarVisible"`，`shrink-0`，`bg-surface border-t`）：横向可滚动的按钮组，`data-test="keybar"`。

**快捷键条按钮与序列**（点击后统一 `sendKey(seq)` → `terminals.input(instanceId, terminalId, seq)` → `adapter.focus()`）：

| 按钮 | 序列 |
|---|---|
| Esc | `\x1b` |
| Tab | `\x09` |
| ↑ | `\x1b[A` |
| ↓ | `\x1b[B` |
| ← | `\x1b[D` |
| → | `\x1b[C` |
| 粘贴 | `await navigator.clipboard.readText()`（无权限/不可用则静默忽略），非空则 `sendKey(text)` |
| Ctrl | 切换 `ctrlArmed` ref（不发序列，仅点亮） |

**粘滞 Ctrl**（仅作用于软键盘字母）：`ctrlArmed` ref 由 Ctrl 按钮切换、点亮时按钮高亮。转换发生在 `createTerminalAdapter` 的 `onData` 回调（拦截软键盘下一字符）：

```ts
onData: (d) => {
  if (!terminalId) return;
  let out = d;
  if (ctrlArmed.value && d.length === 1) {
    const lc = d.toLowerCase().charCodeAt(0);
    if (lc >= 97 && lc <= 122) out = String.fromCharCode(lc - 96); // a→\x01 … c→\x03 … z→\x1a
    ctrlArmed.value = false; // 单次生效后自动解除（无论是否命中字母）
  }
  terminals.input(props.instanceId, terminalId, out);
}
```

- Ctrl 只对 `length===1` 的字母生效；非字母（数字/符号/多字符输入法串）原样发送并解除 armed。
- 快捷键条自身的方向键/Tab/Esc/粘贴**不吃** `ctrlArmed`，也不改变它（保持简单、无歧义）。

**快捷键条默认显隐**：`keybarVisible` 初值 = 移动端 `true`、桌面 `false`（用 `window.matchMedia('(min-width: 1024px)').matches` 判定，缺 `matchMedia` 视为非桌面→显示）。用户切换后写 `localStorage['xacpx.terminalKeybar']`（`"1"`/`"0"`），有存值时优先。

### 3. 动态宽度适配（修复痛点 #2）

`terminal-adapter.ts` 新增 fit 能力，用 **ghostty 自身渲染后的 canvas 度量**反推 cell 尺寸（最准，避免自测字体度量与 ghostty 内部不一致）：

- adapter 暴露 `fit(): { cols: number; rows: number } | null`：
  ```ts
  fit() {
    if (!live?.element) return null;
    const canvas = live.element.querySelector("canvas");
    if (!canvas || !live.cols || !live.rows) return null;
    const rect = canvas.getBoundingClientRect();
    const cellW = rect.width / live.cols;
    const cellH = rect.height / live.rows;
    if (!(cellW > 0) || !(cellH > 0)) return null; // 未就绪
    const cols = Math.max(2, Math.floor(el.clientWidth / cellW));
    const rows = Math.max(1, Math.floor(el.clientHeight / cellH));
    return { cols, rows };
  }
  ```
- `cols()`/`rows()` 改为返回 `live?.cols ?? opts.cols` / `live?.rows ?? opts.rows`（现已如此，保留）。
- `TerminalTab` 的 `ResizeObserver`（以及 `open` 完成、字体 load 完成后各一次）调用一个 `applyFit()`：
  ```ts
  function applyFit() {
    const dim = adapter?.fit();
    if (!dim || !terminalId) { requestAnimationFrame(applyFit); return; } // canvas 未就绪则下一帧重试
    adapter!.resize(dim.cols, dim.rows);                 // 先调 ghostty term.resize
    terminals.resize(props.instanceId, terminalId, dim.cols, dim.rows); // 再通知 PTY
  }
  ```
  - rAF 重试仅在"已 open 但 canvas 尺寸尚为 0"时发生，最多几帧收敛；`teardown`/epoch 变更后不再重试（`applyFit` 内以 `terminalId` 存在为前提，teardown 清空 `terminalId`）。为防 epoch 竞态，`applyFit` 捕获调用时的 `myEpoch`，`myEpoch !== epoch` 直接 return。

**注意**：初始仍以 `cols:80, rows:24` 构造（保证 canvas 先有确定尺寸可度量），open + 首个 rAF 后立即 fit 到真实容器。

### 4. Nerd Font（JetBrainsMono NFM，经 cdn.jsdmirror.com 按需加载）

实测确认（2026-06-30）：

- 镜像 CSS/字体路径：`https://cdn.jsdmirror.com/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts/JetBrainsMonoNerdFontMono-{Regular,Bold}.woff2`，均返回 `200 font/woff2`（各 ~1MB）。
- 选 **NFM（Nerd Font Mono）**：图标单元格宽，匹配 ghostty 等宽网格；family 名 `"JetBrainsMono NFM"`。

**按需注入**（新建 `src/lib/terminal-font.ts`，导出 `ensureTerminalFont(): Promise<void>`）：

```ts
const BASE = "https://cdn.jsdmirror.com/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts";
const FAMILY = "JetBrainsMono NFM";
let injected = false;
let loaded: Promise<void> | undefined;

export function ensureTerminalFont(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    if (!injected && typeof document !== "undefined") {
      injected = true;
      const style = document.createElement("style");
      style.dataset.terminalFont = "1";
      style.textContent = `
@font-face{font-family:"${FAMILY}";font-weight:400;font-style:normal;font-display:swap;
  src:url("${BASE}/JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2");}
@font-face{font-family:"${FAMILY}";font-weight:700;font-style:normal;font-display:swap;
  src:url("${BASE}/JetBrainsMonoNerdFontMono-Bold.woff2") format("woff2");}`;
      document.head.appendChild(style);
    }
    // 触发实际下载 + 等就绪；失败/超时静默回落（终端仍以 monospace 开）
    if (typeof document !== "undefined" && (document as any).fonts?.load) {
      await Promise.race([
        (document as any).fonts.load(`13px "${FAMILY}"`),
        new Promise((r) => setTimeout(r, 4000)),
      ]).catch(() => {});
    }
  })();
  return loaded;
}
```

- 只注入两段 `@font-face`（Regular/Bold），全走镜像，主应用首屏不加载（终端默认关闭）。
- **adapter 构造前** `await ensureTerminalFont()`，确保 ghostty 首次 `measureFont` 用到真字体；失败也继续（回落 `monospace`）。
- Terminal 构造选项：`fontFamily: '"JetBrainsMono NFM", monospace'`、`fontSize: 13`。`defaultFactory` 传入这些选项。
- `terminal-adapter` 的 `TerminalAdapterOptions` 增加可选 `fontFamily?`/`fontSize?`，`defaultFactory` 透传；测试注入的 `factory` 路径不触发字体加载。

## 数据流（不变的部分）

输入：快捷键/键入 → `terminals.input` → `/ws` 上行帧 → hub `handleWebClientMessage`（归属校验）→ `InstanceGateway.sendEvent` → connector `dispatchControlEvent` → PTY。
输出：`TerminalService.emit` → connector 透传 → hub 广播 → `/ws` → `terminals.onOutput` → `adapter.write`。
resize/close 同输入路径。**本次不改这条链路**，仅前端触发点（fit 后的 resize、快捷键的 input）变化。

## 组件边界

- `terminal-font.ts`：单一职责=按需注入 @font-face 并等就绪，幂等、可失败回落。对外仅 `ensureTerminalFont()`。
- `terminal-adapter.ts`：ghostty 封装 + `fit()` 度量。不知道 store/网络，纯 DOM 度量与字体选项透传。
- `TerminalTab.vue`：编排=生命周期（start/teardown/epoch）、fit 驱动、快捷键条 UI 与 sticky-Ctrl 转换。
- `DashboardView.vue`：仅负责覆盖层叠放与互斥、入口按钮、右栏回退。

## 测试计划（vitest，`cd packages/relay-web && npx vitest run`）

- `terminal-adapter`（或新增用例）：
  - `fit()`：注入 fake `live`（含 `element.querySelector('canvas')` 返回带 `getBoundingClientRect` 的桩 + `cols/rows`）与 host `clientWidth/Height` → 断言算出的 cols/rows。
  - canvas 未就绪（rect 宽 0）→ `fit()` 返回 `null`。
- `terminal-font`：`ensureTerminalFont()` 注入 `<style data-terminal-font>` 一次（幂等，多次调用不重复注入）；`document.fonts.load` 抛错时 promise 仍 resolve（回落不抛）。
- `TerminalTab`：
  - 点快捷键按钮 → `terminals.input` 收到对应序列（Esc=`\x1b`、方向键等）。
  - 粘滞 Ctrl：`ctrlArmed` 置真后 `onData('c')` → `terminals.input` 收到 `\x03` 且 armed 归假；`onData('1')`（非字母）→ 原样 `1` 且 armed 归假。
  - `keybarVisible` 默认：`matchMedia` 桌面→false、非桌面→true；localStorage 有值时优先。
- `DashboardView`（`dashboard-responsive.test.ts`）：
  - `toggle-terminal` 点击切换 `terminalOpen`；打开终端清空 file viewer（互斥）；打开文件时 `terminalOpen` 归假。
  - 右栏只剩 Files/Tasks 两个 tab（无 `right-tab-terminal`）。
  - 无会话时 `toggle-terminal` 禁用。
- i18n：`terminal.*` 增补 `keybar.*`（paste/esc/ctrl/tab/up/down/left/right/toggleKeybar/close）中英双语键存在（复用现有 files-i18n 风格用例校验无缺键）。

## 风险与缓解

- **canvas 度量时机**：ghostty open 后 canvas 可能首帧宽为 0 → `fit()` 返回 null，rAF 重试至就绪；epoch 守卫防 teardown 后野重试。
- **字体在国内不可达/超时**：`ensureTerminalFont` 4s 超时 + catch，回落 `monospace`，终端照常可用；失败不阻塞 open。
- **canvas 渲染时字体未加载完**：先 `await ensureTerminalFont()` 再构造 Terminal，`measureFont` 即用真字体；若字体后到，`font-display:swap` + 首次 fit 会重算网格。
- **clipboard 权限**：`readText()` 被拒/不支持时静默忽略（不弹错），用户仍可用软键盘长按粘贴。
- **移动端软键盘遮挡**：快捷键条在 body 下方 `shrink-0`，键盘弹起时布局按 `h-dvh` 收缩，快捷键条随之上移可见（沿用现有 `h-dvh` 容器）。

## 版本 / 发布

前端改动随下一个 core/relay 版本发布即可（web 静态资源由 hub 提供）。**不需要**协议/connector 版本变更。发布按既有多包流程（见 `reference_release_version_coupling`）。
