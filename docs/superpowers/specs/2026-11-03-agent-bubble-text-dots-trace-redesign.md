# Agent 气泡重构：文本独立气泡 + 常驻过程入口 + 执行过程抽屉

- 日期：2026-11-03
- 状态：设计定稿，实施中（Autopilot-full）
- 分支：`feature/agent-bubble-text-dots-trace`
- 范围：relay-web 的 Direct Bot 与群聊渲染层。普通会话（`MessageList`/`ChatPane`）、acpx 传输、store 事件协议不改。

## 1. 背景与目标

现状：Direct Bot / 群聊的 live 行把 text、reasoning、tool 混排在 `TurnParts` 里，完成后的消息行内有一个折叠 trace 头。执行过程只有一个入口（行内折叠或群聊详情浮层），不够直接。

目标（与已验收的独立 Demo 交互一致）：

1. Agent 输出 text 时，每个 text 片段独立成泡（只含文本）；同一 text 片段内的换行（含空行）是 markdown 内容，留在同一泡内，不以分行切泡。**当轮结束后一条持久消息一泡**：持久消息是整轮一条，完成态整条渲染为一个气泡。
2. 当轮未结束时，`...` 气泡常驻、可点击：
   - 挂在该成员最新 text 气泡正下方（左对齐气泡）；
   - 没有 text 时挂在空槽位，作为该 turn 第一行；
   - 群聊中每个 running MemberTurn 各有一个，互不合并；
   - 并行成员的 text 泡按**到达顺序**交错（A1 → B1 → A2 → B2），不按成员分块；dots 挂在各自成员最新 text 泡下，每个成员至多一个；
   - 结算后仍保持交错：同一 Run 的持久回复按成员到达顺序交错（`buildSettledStreams`），每成员一行并带自己的成员身份，不退回「一个成员一整块」；
   - 气泡宽度 `fit-content`，短文本不再撑满整行；`max-width: 100%` 保证长 markdown 照常换行。
   - waiting-human / paused 时动画静止但入口保留。
3. 点击 `...` 打开执行过程：桌面端右侧抽屉，移动端复用 `MobileSheet` 底部弹层，展示完整 trace。
4. 当轮结束后：`...` 消失，「查看过程」入口收进**结论气泡**内部（低调小入口），时间与复制入口仍只出现一次。
5. 人类消息保持右对齐彩色气泡（现状已如此，不改动）。

### 展示规则（per MemberTurn 状态机）

```
queued → running ──(有 text)──▶ text+dots（dots 在最新 text 泡下）
   │        │
   │        └──(无 text)──▶ dots-only（空槽位）
   ▼                            │ turn-finished
waiting-human ──▶ dots 静止      ▼
                  （入口保留）  结论气泡 + 内嵌「查看过程」入口
```

- 失败/取消：保留状态提示（现有 RunStatusChip / 失败原因），已有 text 则入口进气泡，否则一行带入口的状态行。
- indeterminate 照旧。
- 群聊展示顺序按消息 `seq`（到达序），不按成员轮转。

## 2. 数据形状

唯一新增类型（放在 `packages/relay-web/src/lib/turn-presentation.ts`）：

```ts
interface LiveBubbleItem =
  | { kind: "text"; runId: string; memberId?: string; text: string; seq: number }
  | { kind: "dots"; runId: string; memberId?: string };
```

Direct Bot 的 `memberId` 为 `undefined`；群聊按 `MemberTurn.id` 填充。所有展示状态从既有单一事实源推导（`liveTurn.parts` / `liveTurnsByMember` / `runParts`），不新建缓存。

群聊交错顺序的唯一补充状态：`stores/groups.ts` 的 `liveSegmentOrder`（`{ memberTurnId, index, order }[]`，`order` 是帧首次到达时的自增游标）。成员内 parts 有序但成员之间无序，故只能由到达顺序提供；成员 live turn 结束后该条目随 `pruneIncompleteTraces()` 一起回收。

**段边界（跨 live / 完成态）**：气泡边界是 wire 级 text 节点或真正的消息边界，不是文本内的换行。`\n\n` 既可能是 `session-turn-runner` 在 batched 模式插入的段连接符，也可能是 agent markdown 自身的段落/表格/列表分隔；落库成一条 `ConversationMessageDto.content` 后两者字符串相同、无法区分，因此渲染层不得用空行反推段边界（#538 过度分割的根因）。live 用 `textBubblesOf(parts)` 每个 `TurnPartDto{type:"text"}` 一泡（只 `trimEnd`）；完成态一条消息一泡（`settledBubblesOf` / `finishedBubbles` / `settledStreams` 各返回单元素）；`\n` / `\r\n` / 空行 / markdown 段落、列表、表格、围栏代码块都是内容，交给 `StreamMarkdown` 在同一泡内渲染。不改持久消息与协议。

## 3. 组件与落点

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| text 段投影 | `src/lib/turn-presentation.ts` | `textSegmentsOf(parts)` 取 text parts；`textBubblesOf(parts)` 每个 text part 一泡（只 `trimEnd` 并过滤空 part），不按行切分；live 复用 |
| 可点 dots | `src/components/ThinkingDotsTrigger.vue`（新） | `<button>` 包现有 `ThinkingDots`，保留动画样式，ARIA/焦点环齐备；`is-still` 类停动画（`animation-play-state: paused`） |
| 详情容器 | `src/components/TraceOverlay.vue`（新）+ `TraceOverlayDrawer.vue`（新） | `TraceOverlay` 只按视口分支：移动 = `MobileSheet`（自带 modal 注册），桌面 = `TraceOverlayDrawer`（自带 modal 注册 + scroll memory + 锚点离屏/外部 pointerdown 关闭）；注册生命周期与面板一致 |
| Direct Bot live/完成行 | `src/components/ConversationMessageList.vue` | live 行 text 段泡 + dots；完成行 `settledBubblesOf()` 返回单元素（`message.content` 整条一泡），过程入口/附件/时间/复制只挂这一次，移除行内 tool cards |
| 群聊 live/完成行 | `src/components/GroupTranscript.vue` / `GroupAgentTurnRow.vue` | 同上，按 MemberTurn 投影；交错投影在 `src/lib/group-live-stream.ts`（`interleaveGroupLiveStream` 管 live、`buildSettledStreams` 管终态，终态每条消息单段），每个 Run 独立成流；`GroupAgentTurnRow` 的 `segment`/`rowId`/`anchorId` 保留消息 id 与「查看过程」 |
| 内容复用 | `GroupRunDetailContent.vue` / `GroupTraceTimeline.vue` | 详情内容不重写，`TraceOverlay` 包一层 |

## 4. 详情数据通道

- 群聊：沿用 `groupsStore.ensureTracePage(memberTurnId, attempt)`（`runsTraceGet` 分页 + 实时 follow），只换外壳为 `TraceOverlay`。替换锚定气泡的 `GroupRunDetailPopover`。
- Direct Bot：完成后同样走 `runsTraceGet`（payload 需要 `memberTurnId + attempt`，Direct Bot 事件已有 `activeMemberTurn`）。协议风险点已消除：核心扩展（recorder + RPC scope 放行 `kind: "bot"`，见 §7 进度 2026-11-03）后 Direct Bot 与群聊同为持久 trace。
- 实时性：弹层打开期间跟随 live stream（群聊 `refreshOpenTrace` 已有 follow 机制；Direct Bot live parts 直接喂 `GroupRunDetailContent` 的 `parts` prop）。

## 5. 旧入口清理

- Direct Bot / 群聊两条渲染路径移除行内折叠 trace 头（不再传 `collapseTrace`）；`TurnParts` 折叠逻辑本身保留（普通会话 `ToolCallPanel` 等仍在用）。
- 移除 `GroupRunDetailPopover` 的锚定定位逻辑（被 `TraceOverlay` 取代后成为死代码则删除）。

## 6. 明确不做

- 不改普通会话视图
- 不动 store 事件解析、去重、断线恢复
- 不做 trace 导出/分享
- 不给 dots 加耗时计数或状态文案

## 7. 实施进度日志

> Autopilot-full：每步完成或方案变更都记录在此。

| 时间 | 事项 | 结果 |
| --- | --- | --- |
| 2026-11-03 | 设计定稿，建分支 `feature/agent-bubble-text-dots-trace`，建本档 | 开始 §7 首项：协议验证 |
| 2026-11-03 | 协议验证：`runsTraceGet` 对 Direct Bot 两层拦截（recorder 过滤 `kind !== "group"` + RPC scope 只认 public Group），结论见 §7.1 | 群聊路径可用；Direct Bot 方向待操作者确认后继续 |
| 2026-11-03 | 操作者选定「核心扩展」：放宽 recorder + RPC scope 到 direct 会话 | 已实施：`group-member-trace-recorder` → `member-turn-trace-recorder`（`MemberTurnTraceRecorder`，identity 放行 `kind: "bot"`）；`assertPublicRunHistoryScope` 改为 `listTopics` 判定；测试更新 + 新增 direct 录制用例；docs 同步。单文件测试 66 pass；全量 conversations 套件与 tsc 后台验证中 |
| 2026-11-03 | relay-web 壳切换完成：`TraceOverlay`/`TraceOverlayDrawer`/`ThinkingDotsTrigger` 落地，群聊与 Direct Bot 的 live 行改为 text 段泡 + dots，删除 `GroupRunDetailPopover`/`GroupRunDetailSheet` | relay-web 全量 203 文件 2955 用例 pass；`vue-tsc --noEmit` pass；`detail-scroll-memory` 迁移到新壳；`useModalA11y` 增加 `onEscape`（抽屉 Escape 走焦点还原路径，不弹历史栈） |
| 2026-11-04 | #536 验收对齐(用户反馈与 demo 不符):重读 demo 源码纠正 4 处 —— ① 圆角方向:agent 气泡尖角在**左上**(4px 15px 15px 15px / dots 4px 16px 16px 16px),首版做成了左下;② 运行入口:灰色思考气泡(64×40,三点),删除状态词(spec §6 本就禁止);③ 完成态入口:「查看过程」藏进结论气泡内(hairline + 10px 灰字,hover accent),替换文字上方的状态胶囊;新增 TraceLink.vue 供群聊/Direct 共用;④ e2e/单测同步新契约(desktop 9 pass / mobile 9 pass)。教训:验收 demo 是像素级规格,实现前应逐条抄录其 CSS/交互,而不是按既有组件惯性拼装 |
| 2026-11-05 | 群聊并行成员交错：live text 段泡按到达顺序交错（A1 → B1 → A2 → B2），dots 只挂各成员最新段；`stores/groups.ts` 增加 `liveSegmentOrder` 到达戳，`lib/group-live-stream.ts` 做投影，`GroupTranscript` 每个 Run 一条流、挂在最后一个 running 成员的槽位 | 单测：`group-live-stream` 4 例 + `group-components` 交错渲染 1 例；e2e 新增 `group-live-interleave.spec.ts`。**回归**：交错后成员 settle 会换行，开着的过程抽屉被 `IntersectionObserver` 判为「行已移除」而关闭 —— 修法是在 `GroupTranscript` 里 `watch([items, liveStreamByRun], { flush: "post" })` 把 `detailTriggerEl` 重新锚到该成员当前的入口元素；`group-thinking-bubbles` 9 例（含 cancel 后 `group-detail-stopped` 仍可见）复绿 |
| 2026-11-05 | **真机验收打回**：完成态把整轮两条 text 段合进一个结论泡（`conversation.history` 每条 bot 回复是 `A1\n\nA2`），此前只改了 live 分支。修法：`splitTextBubbles`/`textBubblesOf`（空行分段、围栏代码块内空行不算边界）统一 live 与完成态，`GroupAgentTurnRow` 与 `ConversationMessageList` 完成行每段一泡，过程入口/附件/时间/复制只挂最后一段 | 单测新增 helper 3 例 + 完成行组件 1 例（201 例 pass）；e2e `settled canonical replies keep one bubble per text segment` 通过；`vue-tsc --noEmit` pass；真栈重新打包后在浏览器复核。教训：**验收必须看到终态**，live 对不代表 settle 后还对 |

| 2026-11-05 | 真机第二轮打回：① 终态按成员分块，没有交错；② 短文本气泡撑满整行。修法：`buildSettledStreams` 把同一 Run 的持久回复按段索引跨成员轮转（每段一行、自带成员身份、最后一段保留 reply id/过程入口/时间/复制），`GroupAgentTurnRow` 加 `segment`/`rowId`/`anchorId`；`.agent-bubble` 改 `width: fit-content; max-width: 100%`。演示 agent 改成每成员 4 段 + 工具边界，拉长并行过程 | 单测新增 `buildSettledStreams` 2 例 + 终态交错组件 1 例；e2e 终态断言改为 A1→B1→A2→B2；真栈冷启动浏览器 8 段并行实测 |
| 2026-11-06 | **过度分割修正**：用户反馈「气泡不应该以分行分割」。根因：`splitTextBubbles` 把任意空白行当气泡边界；而 `src/control/session-turn-runner.ts:343` 的 `emitChunk` 仅在 `!verbatim && !streamMode && emittedChunk`（batched、非首 chunk、非 verbatim）时才在段间插 `\n\n`，stream 模式完全不插，落库 `ConversationMessageDto.content` 里的 `\n\n` 全部来自 agent 自身 markdown 的段落/表格/列表分隔——连接符与内容同形，渲染层不可反推。修法：删除 `splitTextBubbles` 及所有按行切分；`textBubblesOf` 改为每个 text part 一泡（只 `trimEnd`），完成态 `settledBubblesOf`/`finishedBubbles`/`settledStreams` 各返回单元素；`group-live-stream.ts`、store、样式、协议均不改。完成态 `rowId=message.id` / `anchorId=memberTurn.id`（`row.last` 恒 true，`:seg:<index>` 分支不走），每成员一条、按消息/到达序排列 | 单测 `turn-presentation` 3 例改断言空行/CRLF 保留 + 多 part 仍多泡；`group-components` 完成态 2→1 泡、交错 4→2 泡；`group-live-stream` 补单段轮转；e2e `group-live-interleave` 终态 4→2 泡、authors 收窄；`vue-tsc --noEmit` + 4 组单测 + 3 组 e2e + 烟测见实施回报。**产品取舍（本次期望终态）**：完成态一条持久消息 = 1 泡；被 tool/thought 分隔的多 text part 轮次完成态合并为 1 泡是已知残留（pre-#538 既有），live 仍每 part 一泡，两阶段泡数不一致。若产品要求完成态仍每段一泡，唯一无损解是 Plan B（结构化 `segments` 落库，跨协议 DTO + payload-validators + 存储迁移 + 两端历史消息兼容），本次不启动。教训：**文本内的换行不是结构边界，不能用启发式从落库后的字符串反推段边界** |

## 8. 验证计划

- 每步：`npm run test:unit`（relay-web 相关用例）+ 改动路径的手动/浏览器验证（独立 dev server + Playwright/浏览器驱动）。
- 收尾：全量 `npx tsc --noEmit`、`bun run build`、`npm run test:unit`。
- e2e：群聊双成员并行快照 + dots 打开抽屉 + 完成态入口。
