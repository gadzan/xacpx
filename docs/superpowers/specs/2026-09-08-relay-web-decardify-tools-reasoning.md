# relay-web 工具调用与思考过程去卡片化（zcode 风格流式展示）设计

日期：2026-09-08
状态：已实现

## 背景与目标

PR #329 实现了回合结束后的 trace 折叠与展开。但在回合进行中（streaming）以及用户展开中间过程时，各个推理和工具步骤依然以独立的厚重浮动卡片（`rounded-lg border border-border bg-surface shadow-e1`）呈现。在执行多次工具调用（如连续读写文件、运行命令、多次思考）时，数十个卡片层叠导致视觉极其拥挤、噪音过大。

参照 zcode 的界面风格：
- **去卡片化（De-cardified）**：中间过程是轻量级的背景元数据，不应使用厚重边框、阴影和 surface 底色独立成卡。
- **单行流式时间线**：每项以极简单行呈现——动作图标 + 操作动词（终端/编辑/写入/查阅等）+ 文件角标（TS/VUE/PY）+ 标题/路径 + 右侧 diff stat（`+4` / `−1`）、耗时和状态。
- **左导向线展开**：展开时在步骤行下方以 `border-l-2 border-border/50` 导向线缩进展示思考文本或工具输出（diff / command output），不包裹在额外的卡片中。
- **紧凑垂直节奏**：步骤行之间采用统一 `space-y-2` 呼吸间距，与正文叙述（`text`）拉开清晰层次。

## 详细设计

### 1. `ReasoningPanel.vue`
- 去除 `rounded-lg border border-border bg-surface shadow-e1`。
- 头部行：`group flex items-center gap-1.5 py-1 px-1.5 -mx-1.5 rounded-md hover:bg-fg/5 text-fg-muted hover:text-fg`。
  - 前置 Brain 图标（streaming 时 `text-accent`，常态 `text-fg-muted`）。
  - 文案：`思考` / `思考中…`（en: `Reasoning` / `Reasoning…`）。
  - streaming 脉冲圆点（`bg-accent`）。
  - 后置轻量展开指示器（`ChevronDown` / `ChevronRight`）。
- 展开正文：以 `ml-2.5 my-1 border-l-2 border-border/60 pl-3 py-0.5 text-[12px] text-fg-muted/85 whitespace-pre-wrap` 缩进呈现，去除原顶部分隔线。

### 2. `ToolStepCard.vue`
- 去除 `rounded-lg border bg-surface shadow-e1`。
- 单行头部：
  - 前置种类图标（`KIND_ICON[step.kind]`）。
  - 操作动词：`$t("tools.kinds." + kindLabel)`——`终端`（execute）、`编辑`（edit）、`写入`（write，识别新文件/写入操作）、`查阅`（read）、`搜索`（search）、`工具`（other）。
  - 文件扩展名角标：对 read/edit 步骤智能提取文件名后缀（`TS`、`VUE`、`PY`、`JSON` 等），显示为 `rounded bg-accent/10 px-1 py-0.5 text-[9px] font-semibold text-accent/80 font-mono`。
  - 目标参数/命令/文件名：`truncate font-mono text-[11.5px]`。
  - 右侧状态区：
    - Diff 变更统计：对 diff 类型详情调用 `diffLines()` 提取 `+add`（绿色 `text-run`）与 `−del`（红色 `text-danger`）。
    - 运行时长：`fmtDuration(step.durationMs)`。
    - 状态图标：`Check`（仅在无 diff 统计时展示或伴随状态）、`Loader2`（执行中旋转）、`AlertTriangle`（失败）。
    - 悬浮展开提示图标（`ChevronDown` / `ChevronRight`）。
- 展开详情：以 `ml-2.5 my-1.5 border-l-2 border-border/50 pl-3 space-y-1` 在步骤下方无缝展开 `<ToolDetail>`。

### 3. `SubagentStepCard.vue`
- 去除 `rounded-xl border bg-surface shadow-e1`。
- 头部行采用同款 `py-1 px-1.5 -mx-1.5 rounded-md hover:bg-fg/5` 单行布局，前置 `Bot` 图标与 `子代理` 标签。
- 闭合时的活动轮播与展开时的子任务时间线均以 `ml-2.5 my-0.5 border-l-2 border-border/40 pl-3` 缩进展示。

### 4. `ToolCallPanel.vue`（旧历史兼容）
- 去除外层边框与背景，头部单行对齐，展开列表缩进。

### 5. `TurnParts.vue`
- 容器采用统一 `space-y-2` 间距，使中间过程的多行步骤紧凑咬合且垂直节奏一致；折叠时通过 `extractFinalReplyText` 保证 Markdown 顶层块完整性，且与 `MessageList` 复制按钮共用同一语义结果。

### 6. i18n
- `en.ts` 与 `zh-CN.ts` 增补 `tools.kinds.*`（read, search, execute, edit, write, think, other）。
- `zh-CN.ts` 中 `reasoning` 更新为 `思考` 与 `思考中…`。

## 验证覆盖

- `packages/relay-web/src/__tests__/toolstepcard.test.ts`：
  - 断言卡片边框、背景与阴影类已被移除。
  - 断言各种类操作动词与文件角标正确展示。
  - 断言 edit 步骤展示 `+add` / `−del` 差分数据。
  - 断言新文件写入被识别为 `Write`（写入）。
- 既有测试全部兼容并绿：`toolstepcard.test.ts`、`toolcallpanel.test.ts`、`subagentstepcard.test.ts`、`tooldetail.test.ts`、`turnparts-collapse.test.ts`、`messagelist.test.ts`、`i18n-parity.test.ts`。
- Web 全套 131 文件所有测试全绿，`vue-tsc` 与根 `tsc` 零错误。
