# relay-web 借鉴 "Z" 客户端 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 复选框跟踪。
>
> 配套设计见 [`../specs/2026-06-15-z-client-borrow-design.md`](../specs/2026-06-15-z-client-borrow-design.md)。

**Goal：** 把 "Z" 桌面客户端的上下文可见性与输入区控制密度借鉴进 relay-web —— composer 内联选择器、顶部上下文带、只读 Git 摘要、Ctrl+K 命令面板、工作计时与侧栏耗时徽标。

**Architecture：** relay-web（Vue3+Pinia+Tailwind）经 `api.rpc` 调用 relay hub→连接器→core `ControlService`。纯前端批次只改 `packages/relay-web`；Batch A 还需协议(`relay-protocol`)+连接器(`channel-relay`)+core(`ControlService`) 三层加一对 RPC。

**Tech Stack：** Vue 3 `<script setup>`、Pinia、Tailwind、vitest + @vue/test-utils；core 用 bun:test。

**排序与依赖：**
- **Batch A 依赖 `feat/session-model-selection` 先合入 core**（用其 `transport.setModel/getSessionModel`、`SessionService.setCurrentSessionModel`）。
- **B、C、E 纯前端，无依赖，可先并行做**；C 的 Git widget 复用 B 的头部容器。

测试命令：`bun run --cwd packages/relay-web test -- --run <filter>`（relay-web）、`bun test <file>`（core，逐文件）、`bun run --cwd packages/relay-web build`（含 vue-tsc）。

---

## Batch B —— 顶部上下文 chip 带（纯前端，先做）

### Task B1：ChatPane 头部上下文 chip

**Files:**
- Modify: `packages/relay-web/src/components/ChatPane.vue`
- Test: `packages/relay-web/src/__tests__/chatpane.test.ts`

- [ ] **Step 1：失败测试** —— 选中会话后，头部渲染 `data-test="ctx-chip-workspace"`、`ctx-chip-instance`、`ctx-chip-branch`，文本含 workspace/instance/branch。先确认这些数据在 chat/instances store 里的字段名（`grep` store），断言据此写。
- [ ] **Step 2：跑测试确认失败**（`test -- --run chatpane`）。
- [ ] **Step 3：实现** —— 头部加一行 flex chip：workspace、`@instance`、`branch`。branch chip `@click` 切到 Files/Changes（emit 或调 store），instance chip `@click` 打开 `ManageInstanceDialog`。无数据时 chip 隐藏（`v-if`）。
- [ ] **Step 4：跑测试通过**。
- [ ] **Step 5：commit** `feat(relay-web): top context chips (workspace @ instance · branch)`。

---

## Batch C —— 只读 Git 状态摘要（纯前端，复用 fs.diff）

### Task C1：files store 暴露紧凑 git 摘要

**Files:**
- Modify: `packages/relay-web/src/stores/files.ts`（已有 `changed`/`loadStatus`）
- Test: `packages/relay-web/src/__tests__/files.test.ts`

- [ ] **Step 1：失败测试** —— 加 getter/computed `statusSummary` 返回 `{ branch?, added: number, removed: number, changedCount: number }`，由 `loadStatus` 已拉的 diff 推导（`diff.files` 计数；+N/-N 若 `control.fs.diff` 结果无 stat 则以 changedCount 兜底）。先 `grep` `FsDiffResult` 字段确认有无 stat。
- [ ] **Step 2：跑测试确认失败**。
- [ ] **Step 3：实现** —— 在 `files.ts` 加 `statusSummary` computed；若协议无 +N/-N，仅出 `changedCount` 并在 spec 注明（不新增后端字段，保持只读复用）。
- [ ] **Step 4：跑测试通过**。
- [ ] **Step 5：commit** `feat(relay-web): expose compact git status summary from files store`。

### Task C2：头部 Git 摘要 chip

**Files:**
- Modify: `packages/relay-web/src/components/ChatPane.vue`（接 B1 的头部）
- Test: `packages/relay-web/src/__tests__/chatpane.test.ts`

- [ ] **Step 1：失败测试** —— 头部渲染 `data-test="git-summary"`，含 `● <branch>` 与改动计数；`@click` 切到 Files/Changes。
- [ ] **Step 2：失败 → 实现 → 通过**（紧凑只读 chip；点击 `rightTab='files'` + `files.tab='changes'`）。
- [ ] **Step 3：commit** `feat(relay-web): read-only git summary chip in header`。

---

## Batch E —— 细节打磨（纯前端，低风险，可并行）

### Task E1：工作计时（已工作 Ns）

**Files:**
- Modify: 状态 HUD 组件（`grep` `working`/turn-status 找到具体文件，可能在 `ChatPane.vue`/`MessageList.vue`）
- Test: 对应 `__tests__`

- [ ] **Step 1：失败测试** —— busy 时渲染 `data-test="work-elapsed"`，文本随秒递增（用注入的 `now`/计时器，测试里 mock 定时器）。
- [ ] **Step 2：失败 → 实现** —— busy 起点记 `startedAt`，`setInterval` 每秒更新 `已工作 Ns`；停止时清理。
- [ ] **Step 3：通过 → commit** `feat(relay-web): elapsed working timer in status hud`。

### Task E2：reasoning 折叠头时长

**Files:**
- Modify: `packages/relay-web/src/components/ReasoningPanel.vue`
- Test: `packages/relay-web/src/__tests__/`（reasoning 相关）

- [ ] **Step 1** 先 `grep` ReasoningPanel 是否已有 duration 数据位；无则从 reasoning 段的起止时间推导（或在 store 记 `reasoningStartedAt/EndedAt`）。
- [ ] **Step 2：失败测试** —— 折叠头渲染 `持续 Ns`（`data-test="reasoning-duration"`）。
- [ ] **Step 3：失败 → 实现 → 通过 → commit** `feat(relay-web): reasoning duration label`。

### Task E3：侧栏会话耗时徽标 + 空态

**Files:**
- Modify: `packages/relay-web/src/components/InstanceTree.vue`
- Test: `packages/relay-web/src/__tests__/instancetree.test.ts`

- [ ] **Step 1：失败测试** —— 运行中会话渲染 `data-test="session-elapsed"` 相对时长徽标；instance 无会话时渲染 `暂无会话` 空态。
- [ ] **Step 2：失败 → 实现**（相对时长用已有 lastActivity/startedAt；空态文案）。
- [ ] **Step 3：通过 → commit** `feat(relay-web): session elapsed badges + empty state in tree`。

### Task E4：警告/需授权 callout

**Files:**
- Modify: `packages/relay-web/src/components/MessageList.vue`（消息渲染分支）；复用 `FueCallout.vue`
- Test: `packages/relay-web/src/__tests__/messagelist.test.ts`

- [ ] **Step 1：失败测试** —— 标记为 warning/需授权的消息渲染成 `data-test="msg-callout"`（带 ⚠️ 样式）。先确认消息模型里如何标识这类消息（`grep` 消息 kind/type）。
- [ ] **Step 2：失败 → 实现 → 通过 → commit** `feat(relay-web): render warning/permission messages as callouts`。

---

## Batch D —— Ctrl+K 命令面板（纯前端）

### Task D1：CommandPalette 组件

**Files:**
- Create: `packages/relay-web/src/components/CommandPalette.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue`（挂载 + 全局快捷键）
- Test: `packages/relay-web/src/__tests__/commandpalette.test.ts`

- [ ] **Step 1：失败测试** —— `Cmd/Ctrl+K` 打开面板（`data-test="command-palette"`）；输入过滤跨 instance/session 与 `/command` 目录（复用 `lib/command-catalog.ts`）；回车选中会话→`chat.select`，选中命令→填充 composer。
- [ ] **Step 2：跑测试确认失败**。
- [ ] **Step 3：实现** —— 组件：搜索框 + 分组结果（Sessions / Commands）；键盘上下选择 + 回车；Esc 关闭。`DashboardView` 注册 `keydown` 监听（`Cmd/Ctrl+K`，`preventDefault`），打开/关闭。
- [ ] **Step 4：跑测试通过**。
- [ ] **Step 5：commit** `feat(relay-web): Ctrl/Cmd+K command palette (sessions + commands)`。

---

## Batch A —— composer 内联选择器（依赖 model-selection 先合入 core）

> 前置：`feat/session-model-selection` 已合入 core（含 `transport.setModel/getSessionModel`、`SessionService.setCurrentSessionModel`）。否则本批 RPC 无可调用的底座。

### Task A1：core ControlService 暴露 model get/set

**Files:**
- Modify: `src/control/control-service.ts`
- Test: `tests/unit/control/control-service-model.test.ts`

- [ ] **Step 1：失败测试**（bun:test）—— `controlService.getSessionModel(chatKey)` 返回 `{ current?, available[] }`；`setSessionModel(chatKey, id)` 调 transport.setModel + `SessionService.setCurrentSessionModel`。
- [ ] **Step 2：跑测试确认失败** `bun test tests/unit/control/control-service-model.test.ts`。
- [ ] **Step 3：实现** —— 解析当前会话（仿现有 ControlService 方法），调 `getSessionModel/setModel` + 持久化。transport 方法为 optional，缺失时返回 `{ available: [] }` 兜底。
- [ ] **Step 4：通过**。
- [ ] **Step 5：commit** `feat(control): expose session model get/set on ControlService`。

### Task A2：协议 + 连接器 RPC

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts`（`MSG.sessionModelGet/Set` + payload/result）
- Modify: `packages/channel-relay/src/control-bridge.ts`（两个 case，仿 `fs.*`）
- Test: 连接器 bridge 单测（仿现有 fs case 测试）

- [ ] **Step 1：失败测试** —— bridge 收到 `control.session.model.get/set` 调对应 ControlService 方法；缺 workspace/会话时 `bad-request`。
- [ ] **Step 2：失败 → 实现** —— 协议加类型（**用 tsc 构建 relay-protocol dist**，见 [[reference_bun_barrel_empty_export]] 记忆：桶文件需 tsc）；bridge switch 加 case。
- [ ] **Step 3：通过 → commit** `feat(relay): control.session.model get/set RPC`。

### Task A3：relay-web 模型选择器 chip

**Files:**
- Create: `packages/relay-web/src/stores/session-controls.ts`（model/permission 状态 + actions）
- Modify: `packages/relay-web/src/components/PromptInput.vue`
- Test: `packages/relay-web/src/__tests__/promptinput.test.ts` + `session-controls.test.ts`

- [ ] **Step 1：失败测试**（store）—— `loadModel(instanceId, alias)` 调 `api.rpc(..., "control.session.model.get")` 填 `current/available`；`setModel(id)` 调 set 并乐观更新；`isErrorPayload` 兜底。
- [ ] **Step 2：失败测试**（组件）—— composer 底部渲染 `data-test="model-chip"`，点开列 `available` 选择，选中调 `setModel`；无 available 时 chip 显示当前/隐藏。
- [ ] **Step 3：跑测试确认失败**。
- [ ] **Step 4：实现** —— store + PromptInput 底部一行 chip（model）；mock `api.rpc`。
- [ ] **Step 5：通过 → commit** `feat(relay-web): model selector chip in composer`。

### Task A4：composer 权限模式 chip + 工作计时

**Files:**
- Modify: `packages/relay-web/src/components/PromptInput.vue`、`stores/session-controls.ts`
- Test: `promptinput.test.ts`

- [ ] **Step 1：失败测试** —— 渲染 `data-test="permission-chip"`（读/写权限模式，复用 permission 命令语义的 RPC，或先只读显示）；busy 时显示 `work-elapsed`（与 E1 合流，避免重复实现——E1 若已做则此处只接线）。
- [ ] **Step 2：失败 → 实现 → 通过 → commit** `feat(relay-web): permission + working-timer chips in composer`。

---

## 收尾
- 全部完成后跑 `bun run --cwd packages/relay-web build`（vue-tsc）+ 受影响 core 文件逐个 `bun test`，再用 review 子代理过一遍（仿 model-selection 那批）。
- 沙箱热部署预览（hub `--web-root` 直指 worktree dist，rebuild 即生效）。

## 自检清单
- [ ] Git widget 严格只读，无任何写 git 入口
- [ ] Batch A 仅在 model-selection 合入后开工
- [ ] relay-protocol 用 tsc 构建（桶文件 tree-shake 坑）
- [ ] 纯前端批次 mock `api.rpc`；勿整目录 bun test
- [ ] 新组件 data-test 齐全，vue-tsc 干净
