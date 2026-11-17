# 设计：会话实时切换 + 后台执行与最终结果回放

- 日期：2026-05-30
- 状态：已通过头脑风暴，待实现计划
- 相关分支起点：`feat/memory-free-session-switching`

## 1. 背景与问题

当前在微信里，当某个 agent 会话正在执行长任务时，用户输入 `/use`（或 `/ss`、`/use -`）切换会话会被**阻塞**，必须等任务跑完才能切。

根因（已确认）：消息分两条车道。

- **normal 车道**：按 `chatKey`（整个聊天）**串行排队**。`/use`、`/ss`、`/use -` 与普通 prompt 都在这条道上，后到的必须等前面跑完。见 [`conversation-executor.ts`](../../../src/runtime/conversation-executor.ts) 的 `normalTails` 串行链，以及 [`handle-weixin-message-turn.ts`](../../../src/weixin/messaging/handle-weixin-message-turn.ts) 的 `getWeixinMessageTurnLane`。
- **control 车道**：立即执行，不排队。目前仅 `/cancel`、`/stop`、`/jx`。

此外当前**没有"前台/后台会话"概念，也没有任何输出缓冲**：`reply` 回调即时直发微信，且发送目标 `chatKey` 在消息进来那一刻就被闭包捕获。

## 2. 目标

让用户能在任务进行中**实时切换会话**：

1. 切走的会话在**后台继续执行**，但其输出**不再出现在当前前台聊天**。
2. 后台会话任务**完成时**，前台收到一条简短提醒，并在会话列表中标记"有未读结果"。
3. 用户**切回**该会话时，补发它的**最终结果**（不补发中间过程）。
4. 切到的会话立刻可正常使用（包括给它发新 prompt），无需等其它会话的任务结束。

### 非目标 / 已知限制

- 不缓冲后台期间的中间流式输出（只攒最终结果）。
- 不处理 daemon 重启时仍在执行的后台任务的续接（acpx 进程生命周期归 TTL warm window，另案）。已完成的最终结果会持久化、可跨重启回放。

## 3. 核心输出规则（已与用户确认）

**前台 = 永远实时；后台 = 静默，只攒最终结果。"被切到后台过"不是永久禁言。**

| 场景 | 行为 |
|---|---|
| 会话在**前台**且在跑 | 正常实时流式输出中间进度（与现状一致） |
| 会话被切到**后台** | 静默，前台聊天看不到它任何中间输出 |
| 后台任务**完成**，用户尚未切回 | 前台带外发一条 `✅ X 已完成`（失败为 `⚠️ X 失败`），列表标记未读 |
| 切回一个**已完成**的后台会话 | 补发其最终结果，然后清除未读 |
| 切回一个**仍在跑**的会话 | 重新变前台 → **从此刻起恢复实时流式**；后台期间错过的中间进度**不补**；附一句 `⏳ X 仍在执行中…` |

判断"前台/后台"在**发送的那一刻**进行，而非 turn 开始时——同一 turn 可能前半段静默、切回后后半段恢复实时。

## 4. 架构（采用方案 A：每会话串行）

将并发粒度从"每聊天串行"改为"每会话串行"。同一会话的任务排队，不同会话的任务天然并行——"后台执行"成为系统的自然能力。

四个单元：

1. **并发车道改造**（concurrency）
2. **前台/后台输出闸门**（foreground gate）
3. **待读结果存储**（pending-result store）
4. **切换 / 通知 / 列表渲染**（commands & UX）

### 4.1 并发车道改造

文件：[`conversation-executor.ts`](../../../src/runtime/conversation-executor.ts)、[`monitor.ts`](../../../src/weixin/monitor/monitor.ts)、[`handle-weixin-message-turn.ts`](../../../src/weixin/messaging/handle-weixin-message-turn.ts)

- 会话执行状态仍按 `chatKey` 存（cancel/stop 需看到整个聊天的活动），但内部把单条 `normalTail` 改为**按会话的多条 tail**：

  ```ts
  type ConversationState = {
    normalTails: Map<string /*sessionKey*/, Promise<unknown>>;
    activeControls: number;
  };
  ```

  同会话 → 同 tail → 串行；不同会话 → 不同 tail → 并行。

- normal 任务派发时，先快速读一次该 `chatKey` 的 `current_session` 算出 `sessionKey`，作为串行键。串行键约定：
  - 携带 prompt 的 turn：`${chatKey}::${currentSessionAlias}`。
  - 非会话型 normal 命令（如 `/config`、`/agent add`）：`${chatKey}::__chat__` 保留键。
- **`/use`、`/ss`、`/use -` 移到 control 车道**（立即执行、永不排队）——这是"切得动"的关键。
- `/cancel`、`/stop` 仍为 control，语义明确为"取消**当前前台会话**的在跑任务"，不误伤其它后台会话。

### 4.2 前台/后台输出闸门

文件：[`handle-weixin-message-turn.ts`](../../../src/weixin/messaging/handle-weixin-message-turn.ts)、[`quota-gated-reply-sink.ts`](../../../src/transport/quota-gated-reply-sink.ts)

- 提供 `isForeground(chatKey, sessionAlias): boolean`，读取 `ChatContextState.current_session` 实时判断。
- 每个 turn 的 reply/segment sink 在**发送时**调用 `isForeground`：
  - 前台 → 照常实时发（含中间进度）。
  - 后台 → 丢弃该段中间输出（不缓冲中间流）。
- turn **完成时**再判断一次：
  - 前台 → 正常发最终结果（现状不变）。
  - 后台 → 将最终结果写入待读结果存储，并触发完成提醒（见 4.4）。

### 4.3 待读结果存储（state）

文件：[`src/state/types.ts`](../../../src/state/types.ts) 及 `StateStore` 写入路径

在 `ChatContextState` 下新增 per-会话 的待读结果：

```ts
interface ChatContextState {
  current_session: string;
  previous_session?: string;
  background_results?: Record<string /*sessionAlias*/, {
    text: string;          // 要回放的最终结果（成功或错误文案）
    status: "done" | "error";
    finished_at: string;   // 绝对时间（ISO 字符串）
  }>;
}
```

- 持久化进 `~/.weacpx/state.json`：已完成的最终结果跨 daemon 重启仍可回放。
- 同一会话若在被读取前再次产生后台结果，以最新一条覆盖（最终结果语义只保留最后一份）。

### 4.4 切换 / 通知 / 列表渲染

文件：[`session-handler.ts`](../../../src/commands/handlers/session-handler.ts)、会话列表渲染（沿用 `nativeSessionListFormat` 接缝）

- **切回时**（`handleSessionUse` / `handleSessionUsePrevious`）：切到 X 后查 `background_results[X]`——
  - 命中：发送其 `text`，随后清除该条。
  - 若 X 仍在执行：附一句 `⏳ X 仍在执行中…`。
- **后台完成提醒**：后台 turn 完成时，向**当前前台聊天**带外发送 `✅ X 已完成`（失败为 `⚠️ X 失败`）。该发送在 turn 闭包之外，使用 runtime 持有的 channel 发送能力，并经 quota 闸门以避免刷屏。
- **列表标记**：`/session list` 与 `/ss` 对有未读结果的会话加标记（如 `● backend`）。沿用现有 `nativeSessionListFormat`（weixin 卡片 / 其它 table）声明式渲染，不破坏 channel 渲染接缝。

## 5. 数据流（切走 → 后台完成 → 切回）

1. 会话 X 前台执行，用户发 `/use Y`（control 车道，立即处理）→ `current_session = Y`。
2. X 的 turn 仍在 X 的 normal tail 上继续执行（后台）；其输出闸门在发送时发现 X 非前台 → 静默丢弃中间段。
3. 用户在前台对 Y 正常交互；Y 的 turn 走 Y 的独立 tail，与 X 并行。
4. X 的 turn 完成 → 写 `background_results[X]` + 向前台（Y 所在聊天）带外发 `✅ X 已完成` + 列表标记 X 未读。
5. 用户发 `/use X` → 切到 X，读到 `background_results[X]` → 补发最终结果 → 清除未读。

## 6. 边界情况

- 后台任务**报错** → 存为 `status:"error"`，切回照样回放 + 失败提醒。
- **频繁来回切** → 后台空档的中间输出丢弃；最终结果一定送达（前台实时 或 切回补发）。
- **多个后台会话同时完成** → 各自一条提醒 + 各自列表标记。
- **`/cancel`** → 仅取消当前前台会话的在跑任务。
- **带外提醒与前台流交错** → 提醒为短行，经 quota 闸门，可接受。
- **daemon 重启** → 已完成的 `background_results` 持久化可回放；仍在跑的后台任务不续接（已知限制）。

## 7. 测试策略

单元测试（`tests/unit/` 镜像 `src/` 结构）：

- 车道：不同会话并行、同会话串行；`/use`/`/ss`/`/use -` 在 prompt 进行中能被即时处理（control 车道）。
- 输出闸门：前台放行、后台压制；同一 turn 跨前后台身份切换时发送行为随之改变。
- 待读结果存储：写入 / 覆盖 / 读取 / 清除；切回回放；错误结果回放。
- 通知与列表：后台完成发提醒；列表对未读会话加标记。

冒烟测试（`tests/smoke/`，真实 acpx）：

- 真实长任务执行中途切换 → 前台静默 → 切回补发最终结果。

## 8. 涉及文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src/weixin/messaging/conversation-executor.ts` | 按会话多 tail 并发 |
| `src/weixin/monitor/monitor.ts` | 派发时解析 sessionKey、传入串行键 |
| `src/weixin/messaging/handle-weixin-message-turn.ts` | lane 分类加入 `/use`/`/ss`/`/use -`；接入前台闸门与完成回调 |
| `src/transport/quota-gated-reply-sink.ts` | 发送时调用 `isForeground` 决定发/压 |
| `src/state/types.ts` | `ChatContextState.background_results` |
| `src/sessions/session-service.ts` | 待读结果存取 API；`useSession` 返回是否有待读 |
| `src/commands/handlers/session-handler.ts` | 切回回放、`⏳` 提示 |
| 会话列表渲染 | 未读标记（卡片 / table） |
