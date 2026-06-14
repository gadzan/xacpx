# relay-web HAPI-borrow UX 执行计划

> Spec: `docs/superpowers/specs/2026-06-15-hapi-borrow-analysis-and-spec.md`
> 分支: `feat/relay-web-hapi-borrow-ux`（worktree）· 全部改动限 `packages/relay-web/`，零后端/协议改动。

**Goal:** 借鉴 HAPI 的 4 个前端 UX 原语（会话注意力点、工具分组摘要、reasoning 流式 shimmer、FUE 首次体验），增强 relay-web 仪表盘的信息密度与可读性。

**Tech:** Vue 3 `<script setup>` + Pinia + Tailwind + vitest（jsdom）。测试 `bun run --cwd packages/relay-web test -- <filter>`。

---

## Task 1 — FUE 原语（基础设施）

**Files:**
- Create `packages/relay-web/src/lib/use-fue.ts`
- Create `packages/relay-web/src/lib/fue-placement.ts`
- Create `packages/relay-web/src/components/FueDot.vue`
- Create `packages/relay-web/src/components/FueCallout.vue`
- Create `packages/relay-web/src/__tests__/fue.test.ts`

- `use-fue.ts`：`useFue(featureId)` 返回 `{ status: Ref<'unseen'|'engaging'|'acknowledged'>, engage(), dismiss() }`。`acknowledged` 持久化到 `localStorage['xacpx.fue.v1.'+featureId]='1'`，读写 try/catch。`engage()`：`unseen→engaging`（不写存储）。`dismiss()`：→`acknowledged` + 写存储。导出 `resetFue(featureId)`（测试/调试用）。
- `fue-placement.ts`：纯函数 `computeCalloutPlacement(anchor:{top,left,width,height}, callout:{width,height}, viewport:{width,height}, gap=8) → {top,left,placement:'above'|'below'}`：默认放 anchor 下方；下方溢出且上方更宽裕则翻到上方；`left` 以 anchor 居中后 clamp 到 [8, viewport.width-callout.width-8]。
- `FueDot.vue`：props `{ pulsing?:boolean }`；渲染 8px sky-blue 绝对定位圆点，`pulsing` 时加 `animate-pulse`。`data-test="fue-dot"`。
- `FueCallout.vue`：props `{ title, body, anchor?:DOMRect|null }`；emit `dismiss`。`<Teleport to="body">` 渲染卡片（标题 + 正文 + "Got it" 按钮）；`onMounted` 测量自身尺寸 + 用 `computeCalloutPlacement` 定位（anchor 缺省时居中兜底）；监听 Esc → emit dismiss；`data-test="fue-callout"`，按钮 `data-test="fue-dismiss"`。
- 测试：状态机 3 态流转 + localStorage 持久化（acknowledged 后重建 `useFue` 直接 `acknowledged`）；`computeCalloutPlacement` 的下方/翻转/clamp 三例。

## Task 2 — 工具分组摘要 + 自动折叠（增强 ToolCallPanel）

**Files:**
- Create `packages/relay-web/src/lib/tool-summary.ts`
- Modify `packages/relay-web/src/components/ToolCallPanel.vue`
- Modify `packages/relay-web/src/__tests__/toolcallpanel.test.ts`

- `tool-summary.ts`：纯函数 `summarizeSteps(steps): { kinds: Array<{kind,icon,count}>, statuses: Array<{status,icon,count}> }`，按 `ToolStepKind`/`ToolStepStatus` 计数（图标表与组件共用，移到此文件导出 `KIND_ICON`/`STATUS_ICON`）。导出 `AUTO_COLLAPSE_THRESHOLD = 5`。
- `ToolCallPanel.vue`：
  - `open` 初值改为 `steps.length <= AUTO_COLLAPSE_THRESHOLD`（多步默认折叠）。
  - 头部追加摘要 spans：`data-test="tool-summary"`，渲染 `summarizeSteps` 的 kind 计数 + `·` + status 计数（仅 count>0）。
  - 头部挂 `FueDot`（`featureId='tool-group-collapse'`）：仅当面板默认折叠（`steps.length>THRESHOLD`）且 FUE 未 acknowledged 时显示点；点击头部展开时 `engage()`，配 `FueCallout`（标题"工具步骤已折叠"/正文"多步工具调用默认折叠，点击查看每一步"）。FUE 点与 `tool-count` 徽标互斥（未 ack 时显示点、不显示 count；ack 后反之）。
- 测试：`summarizeSteps` 计数正确；>5 步默认折叠（无 `tool-row`）、点击头部后出现行；≤5 步默认展开；摘要 span 含正确图标计数。

## Task 3 — Reasoning 流式 shimmer + 自动展开（增强 ReasoningPanel）

**Files:**
- Modify `packages/relay-web/src/components/ReasoningPanel.vue`
- Modify `packages/relay-web/src/components/MessageList.vue`
- Modify `packages/relay-web/src/__tests__/toolcallpanel.test.ts`（ReasoningPanel 段）

- `ReasoningPanel.vue`：新增 `streaming?:boolean`。`streaming` 为真：标签文案 `Reasoning…`，标签旁渲染 shimmer 点（`data-test="reasoning-shimmer"`，`animate-pulse`），且 `open` 计算为强制真（用 `computed`：`streaming || localOpen`）。非 streaming：维持 `defaultOpen` + 用户可切换。
- `MessageList.vue`：live reasoning 块传 `:streaming="true"`；历史块（已传 `:default-open="false"`）维持。
- 测试：`streaming=true` 渲染 shimmer + body 可见且文案含 `…`；`streaming=false` 维持折叠/展开旧行为。

## Task 4 — 会话注意力点（chat store + InstanceTree）

**Files:**
- Modify `packages/relay-web/src/stores/chat.ts`
- Modify `packages/relay-web/src/components/InstanceTree.vue`
- Modify `packages/relay-web/src/__tests__/chat.test.ts`
- Modify `packages/relay-web/src/__tests__/instancetree.test.ts`

- `chat.ts`：新增 `unread = ref<Set<string>>(new Set())`。
  - `applyEvent` 的 `turn-finished`：计算 `selected`；若 **非** selected 且 `status ∈ {done,error}` → `unread.add(key)`（用新 Set 触发响应）。（selected 维持现有 flushTurn 落消息逻辑。）
  - `select(id,alias)`：清除该 key 的 unread。
  - `instance-status` offline 分支：顺带清除该 instance 前缀的 unread（实例离线无意义）。
  - 暴露 `sessionAttention(instanceId, alias): 'working'|'unread'|'idle'`（working 优先：`liveTurns` 含 key → working；else unread 含 key → unread；else idle）。
- `InstanceTree.vue`：引入 `useChatStore`；会话行点改为按 `chat.sessionAttention(inst.id, s.alias)`：`working`→amber `●`+`animate-pulse`；`unread`→sky `●`；`idle`→保留 `s.running` 兜底（运行中但事件未到时）或无点。加 `data-test="attention-dot"` + `:data-attention`。
- 测试（chat）：非选中会话 turn-finished(done) → `sessionAttention` 返回 `unread`；`select` 后清除；working 优先于 unread；offline 清除 unread。
- 测试（instancetree）：注入 chat store 状态后渲染对应 `data-attention`。

## Task 5 — 收尾

- `bun run --cwd packages/relay-web test`（全量）全绿。
- `bun run --cwd packages/relay-web build`（`vue-tsc --noEmit` + vite build）通过。
- 提交（精确路径，不 `git add -A`）。
- rebuild sandbox（build relay-web → 重启 relay hub 指向新 dist，console/connector 不动）。
