# PR #285 总结：Relay Web 终端渲染器切换到 xterm.js

PR: https://github.com/gadzan/xacpx/pull/285  
最终审查提交: `29ea5a9a0e2ddd1aef538ad4d1afd605486d69a6`

## 背景与目标

本 PR 将 Relay Web 共享终端 Tab 的渲染器从 `ghostty-web` 切换为 `@xterm/xterm@^6.0.0`。

主要目标：

- 解决移动端 CJK IME 输入兼容问题。
- 让桌面端终端 scrollback 使用 xterm.js 原生滚动行为。
- 移除 ghostty-web 相关 WASM 资产和自维护的 IME textarea 锚定逻辑。
- 保持上层 `TerminalLike` / `TerminalAdapter` seam 基本稳定，减少调用方改动。

## 核心实现

### 1. 使用 xterm.js 替换 ghostty-web

`packages/relay-web/src/lib/terminal-adapter.ts` 改为懒加载：

- `@xterm/xterm`
- `@xterm/xterm/css/xterm.css`
- JetBrainsMono Nerd Font

终端仍通过 adapter 暴露 `open`、`write`、`resize`、`reset`、`focus`、`scrollLines`、theme 等统一能力。

同时删除 `packages/relay-web/public/ghostty-vt.wasm` 和 `ghostty-web` 依赖。

### 2. 删除 ghostty IME 锚定 hack

原先针对 ghostty-web 的 helper textarea 需要 adapter 主动根据 canvas 和 cursor 位置重算：

- open 后重锚定
- write 后重锚定
- resize 后重锚定
- reset/replay 后重锚定
- focus 和 viewport scroll 后重锚定

切换到 xterm.js 后，这套逻辑全部删除。xterm 自己维护 helper textarea、CompositionHelper 和 IME composition 生命周期。

### 3. viewport 几何改用 `.xterm-screen`

`fit()` 和 `localGeometry()` 不再测 ghostty canvas，而是测 xterm 的 `.xterm-screen`。

`.xterm-screen` 的宽高对应当前终端 grid 的 `cols × cellWidth` 和 `rows × cellHeight`，因此仍可用来计算本地适配尺寸和移动端软键盘打开时的 cursor-follow。

### 4. 正确处理 xterm scrollbar 宽度

初版实现直接用整个 host 宽度计算 cols，会把 scrollbar 占用区域也算进终端 grid，导致后端 PTY 比实际可见区域多 1～2 列。

最终实现按 xterm FitAddon 的规则预留 scrollbar：

- `scrollback === 0`：预留 0px
- 否则使用 `overviewRuler.width`
- 未指定时使用 xterm 默认 14px

例如 host 400px、cell 10px，最终 cols 为 `floor((400 - 14) / 10) = 38`。

### 5. 保证 xterm 异步 write 的 FIFO / rebase 原子性

xterm 的 `write()` 只是把数据放入内部 write buffer，真正 parse 是异步执行的。

如果 adapter 只按 `write()` 函数调用顺序排队，会出现：

1. stale live bytes 入 xterm buffer
2. adapter 立即执行 `reset()`
3. stale bytes 后续才被 parse，落到 reset 后的新 screen

这会破坏 terminal recovery / rebase 的原子性。

最终实现将真实 xterm `write(data, callback)` 包成 Promise，并把 `TerminalLike.write` 契约提升为“Promise resolve 表示数据已完成 parse”。adapter 的 FIFO 会 await 每个 op：

- 旧 live write parse 完后才能 reset
- `resetAndReplay()` 会 await keyframe parse 完
- 后续 live bytes 只能在 keyframe 完成后继续

同时增加 dispose gate：如果终端在 pending write 期间被 dispose，即使 xterm callback 不再触发，adapter Promise 也会以 dropped 语义 settle，不会永久挂起。

这个修复还保证了移动端 `await adapter.write()` 后调用 `revealCursor()` 时读取到的是更新后的 cursorY。

### 6. 补齐 xterm `onBinary` 原始字节输入

xterm 对旧式 mouse protocol 等不能安全 UTF-8 编码的输入不会走 `onData`，而是走 `onBinary`。

本 PR 最终增加完整 raw byte 路径：

- adapter 注册 `onBinary`
- binary string 使用 `charCodeAt(i) & 0xFF` 转为 `Uint8Array`
- `TerminalTab` 继续检查 controller / `canType`
- terminal store 新增 `sendInputBytes`
- raw bytes 直接做 canonical base64，不经过 `TextEncoder`

这样可以避免例如 `0x81` 被 UTF-8 转成 `0xC2 0x81`。

## 主要文件变化

- `packages/relay-web/src/lib/terminal-adapter.ts`
  - renderer 替换
  - xterm lazy load
  - async write parse-completion FIFO
  - scrollbar-aware fit
  - onBinary/raw-byte 支持
- `packages/relay-web/src/components/TerminalTab.vue`
  - 接入 raw binary input
  - 删除 ghostty textarea 特殊处理
- `packages/relay-web/src/lib/terminal-viewport.ts`
  - canvas 几何改为 screen 几何
  - 删除手动 IME anchor sync
- `packages/relay-web/src/stores/terminal.ts`
  - 增加 `sendInputBytes`
  - raw byte canonical base64
- `packages/relay-web/e2e/*`
  - `.xterm-screen` viewport 测试
  - IME composition 测试
  - scrollbar fit invariant
  - legacy mouse raw byte 端到端测试
- `packages/relay-web/src/__tests__/*`
  - async write FIFO race 回归测试
  - dispose-during-write 测试
  - scrollbar fit 测试
  - onBinary / raw bytes 测试
- `packages/relay-web/package.json`、lock files
  - 删除 `ghostty-web`
  - 新增 `@xterm/xterm`

## Review 中发现并修复的问题

审查过程中发现 3 个实质问题，最终均在提交 `29ea5a9a` 中修复：

1. **High：fit 未扣 scrollbar 宽度**
   - 会导致终端列数多算，右侧列位于 scrollbar 下方。
   - 已按 FitAddon 逻辑修复并增加测试。

2. **High：xterm 异步 write 破坏 rebase FIFO**
   - stale bytes 可能在 reset 后才被解析到新 screen。
   - 已改为等待 xterm write callback，并增加异步 fake 回归测试。

3. **Medium：缺失 onBinary**
   - legacy mouse report 中 >= 0x80 的字节会被 UTF-8 路径破坏。
   - 已新增 raw byte input path，并用真实 xterm mouse report E2E 验证。

## 验证结果

最终提交的验证结果：

- Vitest：1139 / 1139 通过
- `vue-tsc`：通过
- Vite production build：通过
- Playwright desktop + mobile：19 通过，3 跳过
- GitHub Actions：
  - test：success
  - Relay Web terminal E2E：success
  - terminal-windows：success

## 最终结论

PR #285 完成了 Relay Web 共享终端从 ghostty-web 到 xterm.js 的迁移，并补齐了 renderer 语义差异带来的关键边界：scrollbar-aware fit、异步 write 原子性以及 binary input。

经过第二轮审查，原有 2 个 High 和 1 个 Medium finding 均已实质修复，对应测试也直接覆盖原 failure mode。最终审查结论：**可以合并**。
