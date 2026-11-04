# Agent 气泡重构：文本独立气泡 + 常驻过程入口 + 执行过程抽屉

- 日期：2026-11-03
- 状态：设计定稿，实施中（Autopilot-full）
- 分支：`feature/agent-bubble-text-dots-trace`
- 范围：relay-web 的 Direct Bot 与群聊渲染层。普通会话（`MessageList`/`ChatPane`）、acpx 传输、store 事件协议不改。

## 1. 背景与目标

现状：Direct Bot / 群聊的 live 行把 text、reasoning、tool 混排在 `TurnParts` 里，完成后的消息行内有一个折叠 trace 头。执行过程只有一个入口（行内折叠或群聊详情浮层），不够直接。

目标（与已验收的独立 Demo 交互一致）：

1. Agent 输出 text 时，每个 text 片段独立成泡（只含文本）。
2. 当轮未结束时，`...` 气泡常驻、可点击：
   - 挂在该成员最新 text 气泡正下方（左对齐气泡）；
   - 没有 text 时挂在空槽位，作为该 turn 第一行；
   - 群聊中每个 running MemberTurn 各有一个，互不合并；
   - waiting-human / paused 时动画静止但入口保留。
3. 点击 `...` 打开执行过程：桌面端右侧抽屉，移动端复用 `MobileSheet` 底部弹层，展示完整 trace。
4. 当轮结束后：`...` 消失，「查看过程」入口收进结论气泡内部（低调小入口）。
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

## 3. 组件与落点

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| text 段投影 | `src/lib/turn-presentation.ts` | 新增 `textSegmentsOf(parts)`：`parts.filter(p => p.type === "text")`，两条渲染路径复用 |
| 可点 dots | `src/components/ThinkingDotsTrigger.vue`（新） | `<button>` 包现有 `ThinkingDots`，保留动画样式，ARIA/焦点环齐备；`is-still` 类停动画（`animation-play-state: paused`） |
| 详情容器 | `src/components/TraceOverlay.vue`（新）+ `TraceOverlayDrawer.vue`（新） | `TraceOverlay` 只按视口分支：移动 = `MobileSheet`（自带 modal 注册），桌面 = `TraceOverlayDrawer`（自带 modal 注册 + scroll memory + 锚点离屏/外部 pointerdown 关闭）；注册生命周期与面板一致 |
| Direct Bot live 行 | `src/components/ConversationMessageList.vue` | live 行改渲染 text 段泡 + dots；完成行入口进气泡 |
| 群聊 live 行 | `src/components/GroupTranscript.vue` / `GroupAgentTurnRow.vue` | 同上，按 MemberTurn 投影 |
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

## 8. 验证计划

- 每步：`npm run test:unit`（relay-web 相关用例）+ 改动路径的手动/浏览器验证（独立 dev server + Playwright/浏览器驱动）。
- 收尾：全量 `npx tsc --noEmit`、`bun run build`、`npm run test:unit`。
- e2e：群聊双成员并行快照 + dots 打开抽屉 + 完成态入口。
