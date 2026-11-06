# Trace 抽屉实时展示：固定 Live Stack + 稳定全量过程

- 日期：2026-11-06
- 状态：提案，未实现
- 范围：relay-web 的执行过程抽屉（桌面右侧抽屉、移动 bottom sheet）
- 前置：`docs/design/2026-11-06-bot-conversation-architecture.md`
- 不在范围：trace 采集、存储、RPC、ConversationTimeline、普通会话 `MessageList`

---

## 0. 决策摘要

1. **不再自动折叠 trace**。删除“超过 6 步只留最后 3 步”的窗口和“显示之前的 N 个步骤”。
2. **抽屉顶部增加固定 Live Stack**：最近 2–3 条事件，最新在上，动画堆叠；快速输出时合并更新。
3. **下方保留时间顺序的全量过程**：所有步骤都在，默认紧凑，手动展开；展开状态在更新和重渲染后保持。
4. **滚动跟随可暂停**：用户在底部时跟随新事件；向上阅读时冻结位置，显示“N 条新事件”，不把读者顶走。
5. **视窗外使用 `content-visibility: auto`**：不布局、不绘制；先不引入自定义虚拟列表，避免可变高度、展开高度和滚动锚点互相打架。
6. **不改后端**。Live Stack 和全量过程都从现有 `deriveTurnPresentation(parts).nodes` 派生，复用 `node.key`。

一句话：**把“现在发生了什么”固定在顶部，把“完整过程”稳定地留在下面；不靠折叠制造空间。**

---

## 1. 问题：丢的不是信息，是阅读位置

当前实现：

- `GroupTraceTimeline.vue` 有 `FOLD_THRESHOLD = 6` 和 `tailSize = 3`。步骤超过 6 个后只渲染最后 3 个，其余藏在“显示之前的 N 个步骤”。
- 每个工具/子代理默认收起，`openKeys` 在用户点击后才有值。
- `ReasoningPanel` 默认收起。
- `ToolDetail` 的 `ExpandableBlock` 超过 200px 截断，点击 “Show more” 才展开。
- `SubagentStepCard` 默认收起，运行中输出还有 `max-h-48`。

快速执行时，新步骤不断到达，折叠窗口不断前移：

```text
t0  可见: 1 2 3 [4 5 6]        // 6 步，最后 3 步可见
t1  可见: 1 2 3 4 [5 6 7]      // 窗口前移，4 消失
t2  可见: 1 2 3 4 5 [6 7 8]    // 5 消失，用户刚展开的 4 也被卸载
```

用户看到的是：

- 列表高度和滚动位置不断跳；
- 刚点开的步骤被下一次更新移出窗口；
- 折叠按钮文字和位置也在变；
- 输出太快时，还没读完就被新内容覆盖。

所以问题不是“折叠控件不好看”，而是**列表窗口在持续移动，且移动会卸载用户正在看的内容**。简单地把 `folded` 设为常开，会让长 trace 的 DOM 和滚动高度失控，也不是完整方案。

---

## 2. 目标与非目标

### 2.1 目标

- 执行中打开抽屉，最新事件始终在视野内。
- 新事件到达时，已有内容的阅读位置不跳。
- 用户展开的步骤不会被新输出自动收起。
- 快速输出时，视觉上只看到节流后的“最新状态”，不是每一帧都闪烁。
- 完整过程仍可按时间顺序阅读。
- 视窗外内容不参与布局/绘制，长 trace 不拖垮抽屉。

### 2.2 非目标

- 不改 trace 数据格式、分页协议、后端记录。
- 不把整个 trace 做成反向时间线。
- 不自动“展开全部”；是否展开某个步骤由用户决定。
- 不引入第三方虚拟列表库。
- 不改普通会话的 `MessageList` / `TurnParts` 折叠行为。

---

## 3. 目标界面

```text
┌ 抽屉头：Reviewer · 正在执行 ──────────────────┐
│ LIVE                                         │
│ [12:03:41] Bash · pnpm test        running   │  ← 最新
│ [12:03:39] Read · src/auth.ts       done     │     固定，最多 3 条
│ [12:03:37] Reasoning · 检查并发…    done     │     （移动端 2 条）
├──────────────────────────────────────────────┤
│ 完整过程 · 时间顺序                           │
│ 01  Reasoning …                              │
│ 02  Read src/auth.ts                         │
│ 03  Bash pnpm test                           │
│ …                                            │
│ [滚动区域]                                    │
└──────────────────────────────────────────────┘
```

- **Live Stack 固定在抽屉内容顶部**，不随下方全量过程滚动。
- **全量过程在下方滚动**，按时间顺序，不再自动折叠。
- 运行结束，Live Stack 收成一行“执行完成 / 失败 / 取消”的摘要；全量过程保留。

### 3.1 运行态

- Live Stack 显示最近 2–3 个节点，最新的在最上面。
- 新节点从顶部滑入；旧节点向下移动并淡出/压缩。
- 同一个 `key` 的状态更新原地替换，不重新入场。
- 全量过程追加新行，但不移动用户当前的滚动位置；只有用户在底部时才跟随。

### 3.2 完成态

- Live Stack 停在一个终态摘要，不再动画。
- 全量过程保持原样；默认紧凑，用户已展开的步骤仍然展开。
- 可提供显式的“展开全部 / 收起全部”，但不自动执行。

---

## 4. 详细行为

### 4.1 Live Stack

| 项目 | 行为 |
|---|---|
| 数据源 | `presentation.nodes` 的最后 2–3 个节点，反转成最新在上 |
| 去重 | 按 `node.key`；同一 reasoning/tool 更新只改内容，不新建行 |
| 节流 | 100–150ms 合并；一帧内最多一次视觉更新 |
| 动画 | `transform` + `opacity`，约 160ms；不做高度动画；`prefers-reduced-motion` 关闭 |
| 行数 | 桌面 3，移动 2；固定高度，避免挤压下方 |
| 内容 | 标题、类型、状态、耗时；流式文本/推理只显示最后 1–2 行预览 |
| 交互 | 点击某行 → 滚到全量过程中的对应节点；不直接展开大段输出 |
| 终态 | 运行结束显示“执行完成/失败/取消”摘要，停止入场动画 |

快速输出时，Live Stack 只呈现“节流后的最新快照”；中间事件不会丢失，它们仍按时间顺序进入下方全量过程。

### 4.2 全量过程

- 删除 `FOLD_THRESHOLD`、`tailSize`、`folded`、`firstVisibleStepIndex`、`hiddenStepCount`。
- `nodes = presentation.nodes`，不再按步骤数过滤。
- 工具/子代理/推理恢复正常信息层级，但**默认紧凑**：
  - 工具行：标题 + 类型 + 状态 + 耗时；点击展开详情。
  - 子代理：标题 + 状态；点击展开子步骤/输出。
  - 推理：默认一行；点击展开全文。
- 展开状态不再放在 `GroupTraceTimeline` 的局部 `openKeys` 里，而是提升到抽屉层，按 `memberTurnId + attempt + node.key` 记录。
  - 新事件追加不会清空集合。
  - 组件重渲染、滚动窗口变化、切回 attempt 都保持。
  - 关闭抽屉后是否保留由抽屉状态决定；建议同一会话内保留，切换成员/attempt 时重置。
- 不自动展开任何步骤；用户手动点开的步骤永远不被新输出自动收起。

### 4.3 滚动与跟随

全量过程是唯一的滚动容器；Live Stack 固定在它上方。

| 状态 | 行为 |
|---|---|
| 用户在底部 | 新节点追加到末尾时，保持贴底 |
| 用户向上滚动 | 停止跟随；新节点仍进入列表，但不移动视口 |
| 有未读事件 | 底部显示“N 条新事件 ↓”，点击回到底部 |
| 用户点击 Live Stack 行 | 滚到对应节点；高亮该行 |
| 切换 attempt / member | 重置跟随；按新 attempt 的 key 恢复展开状态 |

不采用“最新事件插入顶部并推走所有内容”的全量列表做法，因为那会让正在阅读历史的用户不断失去位置。最新内容由固定 Live Stack 承担。

### 4.4 视窗外不渲染

第一版：

- 全量过程每一行加 `content-visibility: auto`，配合 `contain-intrinsic-size: auto 72px`。
- 浏览器跳过视窗外行的布局和绘制；DOM 保留，用于稳定滚动高度和浏览器 find-in-page。
- 展开的行、当前 Live Stack 行、失败行始终正常渲染。
- 不给整个列表加 `overflow: hidden` 或固定高度，避免破坏滚动锚点和无障碍。

第二版（仅当实测仍有压力）：

- 引入可变高度窗口化：测量行高、维护偏移索引、只挂载视口 ± overscan 的行。
- 展开状态必须已经提升到抽屉层，否则窗口化会丢状态。
- 窗口化与 `content-visibility` 不同：前者卸载 DOM，后者只跳过渲染。先做前者成本低、风险小。

### 4.5 快速输出与动画预算

- 新节点入场：每个 key 只入场一次。
- 同一 key 的流式文本/状态更新：原地更新，不触发布局动画。
- 事件速率超过阈值（例如 10 条/秒）：暂停入场动画，只更新 Live Stack 内容；全量过程照常追加。
- 动画只做 `transform` / `opacity`，不 `height` / `top`；减少主线程布局。
- 使用 `requestAnimationFrame` 或 100–150ms 定时器合并；不要在每次 part 更新时直接改 DOM。

---

## 5. 组件与状态结构

```text
TraceOverlay / TraceOverlayDrawer
  GroupRunDetailHeader                 // 现有
  GroupRunDetailContent
    TraceLiveStack                     // 新：固定最新 2–3 条
    GroupTraceTimeline                 // 改：全量、无自动折叠、展开状态受控
      TraceNodeRow                     // 可选：从模板中抽出
```

### 5.1 状态归属

| 状态 | 归属 | key |
|---|---|---|
| 展开的节点 | 抽屉层 composable / `GroupRunDetailContent` | `memberTurnId:attempt:node.key` |
| 跟随模式 | 抽屉层 | `memberTurnId:attempt` |
| 未读事件数 | 抽屉层 | `memberTurnId:attempt` |
| Live Stack 快照 | `TraceLiveStack` 内部，输入是节流后的 nodes | `node.key` |
| 滚动位置 | 现有 `useDetailScrollMemory` | `memberTurnId:attempt` |

不把展开状态放在 `GroupTraceTimeline` 或每个步骤组件里；组件会被重渲染、虚拟化或重新挂载，局部状态会丢。

### 5.2 数据投影

不改 `deriveTurnPresentation` 的输出。新增一个轻量投影：

```ts
interface TraceLiveItem {
  key: string;
  kind: "reasoning" | "tool" | "subagent" | "markdown" | "agent-message";
  title: string;
  status?: "running" | "success" | "error";
  preview?: string;
  updatedAt?: number;
}
```

- `key` 直接来自 `presentation.nodes[].key`，与全量列表一致。
- `preview` 取该节点的最后 1–2 行，不复制完整输出。
- 状态从 `ToolStepDto.status` / `resolveSubagentStatus` 派生。
- 不新增后端字段，不新增事件总线。

---

## 6. 实施顺序

### P1a：稳定全量过程

1. `GroupTraceTimeline.vue` 删除折叠窗口、`visibleTail`、`folded`、折叠按钮。
2. `nodes` 改为 `presentation.nodes` 全量。
3. 把展开状态提升到 `GroupRunDetailContent` 或抽屉 composable；`GroupTraceTimeline` 接收受控 `expandedKeys` + `toggle`。
4. 工具/子代理/推理默认紧凑，但展开后不自动收起。
5. 滚动跟随逻辑：在底部才跟随；向上滚动冻结；未读计数。

### P1b：Live Stack

1. 新增 `TraceLiveStack.vue`，输入当前 `nodes`、`streaming`。
2. 取最后 2–3 个节点，反转显示；按 `key` 去重。
3. 加 100–150ms 节流；同 key 更新不重新入场。
4. `TransitionGroup` 做 `transform`/`opacity` 动画；尊重 reduced motion。
5. 点击行 → 发出 `reveal(key)`，全量列表滚动并高亮。

### P1c：视窗外优化

1. 全量行加 `content-visibility: auto` + `contain-intrinsic-size`。
2. 测长 trace 的滚动、展开、find-in-page、移动端。
3. 如果仍然卡，再评估窗口化；不先上复杂虚拟列表。

### P2（可选）

- “最新在前 / 时间顺序”切换。
- “展开全部 / 收起全部”。
- true windowing（可变高度 + overscan）。
- trace 导出/分享不在本轮。

---

## 7. 测试与验收

### 单元测试

- `group-trace-timeline.test.ts`
  - 不再断言“折叠 earlier steps”。
  - 7 个步骤全部存在；第一个和最后一个都能直接找到。
  - 追加新步骤后，已展开的步骤仍展开。
  - 删除 `group-trace-fold` 断言。
- 新增 `trace-live-stack.test.ts`
  - 最新 3 条，最新在上。
  - 同 key 更新不新增行、不触加入场动画。
  - 新 key 进入时旧行仍保留。
  - 终态摘要替换运行态。
- `trace-drawer-state.test.ts`（或 composable 测试）
  - 切换 attempt 重置；同一 attempt 追加不丢展开状态。
  - 向上滚动停止跟随；回到底部恢复。
- `expandableblock.test.ts`
  - 现有默认 clamp 行为不变；如果加 `full`，full 模式无 toggle（本方案不强制依赖 full）。

### 浏览器验收

- 打开运行中的抽屉，快速产生 30+ 事件：
  - Live Stack 始终显示最新事件，不闪烁；
  - 全量列表不自动折叠；
  - 用户展开一个工具后，再产生 20 条事件，展开状态不丢。
- 向上滚动：
  - 视口不跳；
  - 出现“N 条新事件”提示；
  - 点击回到底部。
- 移动端 bottom sheet：
  - Live Stack 2 行不挤压正文；
  - 滚动、展开、关闭重开正常。
- 长输出：
  - 视窗外行不布局/绘制；
  - 展开长 diff/命令输出后滚动仍稳定。
- 终态：
  - Live Stack 停止动画；
  - 全量过程保留；
  - 失败/取消状态仍醒目。

### 验收标准

- 执行中不再出现因折叠窗口移动导致的可见跳动。
- 最新事件在 150ms 内出现在 Live Stack。
- 用户展开的步骤不会因新事件自动收起。
- 用户向上阅读时，新事件不会移动视口。
- 长 trace 滚动流畅；视窗外内容不参与绘制。
- 不改后端、不改普通会话行为。

---

## 8. 风险与取舍

| 风险 | 处理 |
|---|---|
| Live Stack 占用垂直空间 | 桌面 3 行、移动 2 行；固定高度；完成后收起 |
| 快速输出仍然视觉过载 | 100–150ms 节流；同 key 原地更新；高速时关闭入场动画 |
| 全量过程仍然很长 | 默认紧凑；手动展开；`content-visibility`；窗口化留作 P2 |
| `content-visibility` 不等于卸载 DOM | 明确为“不布局/不绘制”；若内存仍是问题再做窗口化 |
| 展开状态与虚拟化冲突 | 状态先提升到抽屉层，按稳定 key 记录 |
| 用户想倒序看 | 不在本轮做；Live Stack 已满足“最新在顶部”；P2 可加排序切换 |
| 移动端 sticky + 软键盘 | Live Stack 放在滚动容器外/顶部；bottom sheet 单独验收 |

### 拒绝的方案

1. **直接把 `folded` 设为 false**：解决折叠但长 trace DOM/滚动高度失控，快速输出仍会抖动。
2. **整个 trace 反向时间线**：最新在顶部，但完整过程倒序读、工具链和 markdown 叙事难理解。
3. **只显示最新几条，不保留历史**：运行中够用，但完成后无法回看完整过程。
4. **每来一条事件就动画**：输出快时动画本身成为抖动源。
5. **第一版就上可变高度虚拟列表**：展开高度、滚动锚点、find-in-page 都容易坏；先用原生 `content-visibility`。

---

## 9. 与总架构的关系

- 本方案属于 `docs/design/2026-11-06-bot-conversation-architecture.md` 的 P1「详情与 trace」子项。
- 不改变 ConversationTimeline、Roundtable、Run/MemberTurn 的任何数据或调度。
- 实现顺序建议：先完成 P1a 稳定全量过程，再接 P1b Live Stack；两者可以独立回退。
- 如果总架构的详情抽屉组件在 P1 中被合并/重命名，本方案跟随新的外壳，不另起一套抽屉。
