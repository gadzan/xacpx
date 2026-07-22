# `src/control` 模块说明（Control API）

`ControlService` 是面向结构化消费者（首个是 relay 连接器，见
[docs/superpowers/specs/2026-06-13-relay-hub-design.md](superpowers/specs/2026-06-13-relay-hub-design.md)）的核心控制门面。
它聚合了 `SessionService` / `ActiveTurnRegistry` / `ScheduledTaskService` /
`OrchestrationService` / `ConsoleAgent`（ChatAgent），自身无持久状态。每轮对话的
并发闸门与执行体已从门面里拆出：并发生命周期（in-flight / 队列 / drain 三态）由
`TurnQueue` 持有，单轮执行体由 `SessionTurnRunner` 承担，`ControlService.prompt` 只是把
调用转交给 `TurnQueue.submit`。

## 文件

- **`src/control/control-service.ts`** — 门面主体：sessions / scheduler /
  orchestration / prompt / executeCommand。导出类型：`ControlServiceDeps`、
  `ControlSessionInfo`、`ControlPromptInput`、`ControlPromptResult`、
  `ControlExecuteCommandInput`。`prompt` / `runScheduledTurn` / `cancelTurn` /
  `cancelQueuedItem` 都转发给 `TurnQueue`。
- **`src/control/turn-queue.ts`** — `TurnQueue`：三态并发闸门
  （`inFlight` / `queues` / `draining`）。构造时注入 `{ runTurn, emitQueueUpdated,
  detectSessionsChanged }`。**无会话依赖**——回合结束后的 `sessions-changed` 检测经
  `detectSessionsChanged` 回调穿入，而非让 `TurnQueue` 自持 `SessionService`。
- **`src/control/session-turn-runner.ts`** — `SessionTurnRunner`：单轮执行体（会话绑定、
  turn-started、媒体沙箱、stream/batched 段落重建、`agent.chat` 驱动与全部事件发射、
  turn-finished）。契约是**永不 reject**——失败以 `{ ok: false, errorMessage }` resolve，
  使 `TurnQueue` 能在纯 `finally` 里结算/推进队列而无需 catch。不持任何并发状态。
- **`src/control/turn-support.ts`** — 中立值模块：`turnKey` / `toErrorMessage` /
  `buildControlMetadata` / `raceWithTimeout` 与相关常量、`QueuedPrompt` 接口。被
  `control-service` / `turn-queue` / `session-turn-runner` 以值导入，避免运行时环依赖。
- **`src/control/control-event-bus.ts`** — `ControlEventBus` 接口与
  `createControlEventBus` 工厂：支持 `turn-output` / `turn-finished` /
  `sessions-changed` / `scheduled-changed` / `orchestration-changed` 五类事件；
  监听器异常彼此隔离（经注入的 `logger.error` 记录，不外抛）。
- **`src/control/workspace-git.ts`** — `WorkspaceGit`：配置工作区范围内的结构化 Git
  门面。只用 `execFile` 参数数组调用 Git，不接受任意命令或客户端指定 worktree 路径；
  同一工作区的 Git 写操作按 FIFO 串行。托管 worktree 的仓库目录拒绝符号链接，并在
  创建前后校验 realpath 仍位于托管根目录内。

## 方法概览

| 方法 | 说明 |
|------|------|
| `listSessions()` | 返回所有已解析逻辑会话的快照（`ControlSessionInfo[]`），含 `running` 字段（来自 `ActiveTurnRegistry`）。 |
| `createSession(alias, agent, workspace)` | 创建逻辑会话，发出 `sessions-changed` 事件。 |
| `removeSession(alias)` | 删除逻辑会话，发出 `sessions-changed` 事件；返回 `{ wasActive: boolean }`。 |
| `listScheduledTasks(chatKey)` | 返回指定 chatKey 下的待执行定时任务列表。 |
| `createScheduledTask(input)` | 创建定时任务，发出 `scheduled-changed` 事件。 |
| `cancelScheduledTask(id, chatKey)` | 取消定时任务；取消成功时发出 `scheduled-changed` 事件；返回是否成功取消。 |
| `listOrchestrationTasks(filter?)` | 列出编排任务，支持可选过滤器。 |
| `getOrchestrationTask(taskId)` | 按 taskId 获取单个编排任务（可能为 null）。 |
| `cancelOrchestrationTask(input)` | 请求取消编排任务，发出 `orchestration-changed` 事件。 |
| `prompt(input)` | 向 agent 发起一轮对话（见下方语义要点），返回 `ControlPromptResult`。 |
| `cancelTurn(chatKey, sessionAlias)` | 通过 `AbortController` 中止进行中的 turn；返回是否成功中止。 |
| `executeCommand(input)` | 不切换会话、不发事件地向 agent 执行一条命令，收集所有分片与最终文本（换行拼接）后返回字符串。 |
| `workspaceGitStatus(workspace)` | 返回分支、上游 ahead/behind、文件状态、本地分支与 worktree 列表；只读，不受写开关影响。 |
| `gitStage` / `gitUnstage` / `gitCommit` | 结构化操作 index 与提交；commit 只提交已暂存内容。 |
| `gitFetch` / `gitPull` / `gitPush` | 远端同步；pull 固定 `--ff-only`，首次 push 必须显式要求设置 upstream，不提供 force。 |
| `gitCheckout` | 切换或创建分支；工作树有未提交改动时拒绝，不自动 stash。 |
| `gitCreateWorktree` | 在 daemon 管理的 `~/.xacpx/worktrees` 下创建 worktree，并注册为 workspace；同名 workspace 的检查、创建、注册与补偿按名称串行，注册失败会回滚 worktree，补偿本身失败则以 `workspace-registration-rollback-failed` 显式报告。 |
| `get events()` | 返回注入的 `ControlEventBus` 实例，供消费者订阅事件。 |

## 注入方式

`buildApp`（`src/main.ts`）在组装 `AppRuntime` 时构造 `ControlService`，挂在
`AppRuntime.control`。`run-console.ts` 在调用 `channels.startAll()` 时，将
`runtime.control` 作为 `ChannelStartInput.control`（`src/channels/types.ts` 中的
可选字段）传给所有频道；纯文本频道可忽略该字段。

插件包经 `xacpx/plugin-api` 取得以下类型（仅类型，不含实例）：
`ControlService`、`ControlSessionInfo`、`ControlPromptInput`、
`ControlPromptResult`、`ControlExecuteCommandInput`、`ControlEvent`、
`ControlEventBus`、`ControlEventListener`。

## 语义要点

### prompt 并发保护（`TurnQueue`）

`prompt` 把调用转交给 `TurnQueue.submit`。闸门按 `(chatKey, sessionAlias)` 组合隔离，
围绕三个状态运转：

- **`inFlight`** — 每个 key 至多一个进行中的 turn。`submit` 的「忙判定 + `inFlight.set`」
  是一段**零 await 的同步前缀**，`SessionTurnRunner.run` 是正常路径上唯一的 turn-body
  await；这样同一 tick 内的第二个 `submit` 一定能读到已注册的忙态。绑定当前会话的
  `useSession` 由 runner 在这之后调用，闭合了「先注册、后绑定」的竞态窗口。
- **`queues`** — 交互式 `prompt`（`queueable: true`）遇忙时把提示词追加进 per-session FIFO
  队列并回 `{ ok: true, queued: true, queueItemId }`；定时轮次（非 `queueable`）遇忙则直接回
  `{ ok: false, errorMessage: "turn-already-running" }`，不入队。turn 结束时按 FIFO 依次
  drain，每个队列头作为下一轮 turn 运行。
- **`draining`** — 一轮结束到下一轮（drained head）重新注册 `inFlight` 之间的短暂交接窗口
  里，`submit` 把 `draining.has(key)` 也视为忙态，防止有提示词在这个缝隙里起并行 turn。

`cancelTurn` 经保存的 `AbortController.abort()` 中止进行中的 turn；`cancelQueuedItem`
按 id 移除尚未 drain 的排队项（已 drain 进 turn 的则 no-op）。这些同步时序不变量由
`tests/unit/control/turn-queue.test.ts`（白盒）与
`tests/unit/control/golden/turn-oracle.test.ts`（黑盒事件-日志 oracle）共同钉住。

### turn-output 与 turn-finished 事件

`prompt` 执行期间，每个流式分片都以 `turn-output`（含 `chunk` 字段）事件发出；
agent 返回的最终文本（`response.text`）也以同一事件再发一次。
turn 结束时无论成功或失败都发出 `turn-finished`（失败时含 `errorMessage`）。

### metadata 约定

`prompt` 和 `executeCommand` 的 metadata 固定为：
- `channel: "control"`
- `chatType: "direct"`
- `senderId`：由调用方通过输入字段提供
- `isOwner`：由调用方提供；若省略（`undefined`），则从 metadata 中完全省略该字段，
  满足核心 fail-closed 路由契约（`isOwner` 缺失 ≠ `isOwner: false`）。

### executeCommand 与 prompt 的区别

`executeCommand` 不注册 in-flight turn、不调用 `useSession`、不发出任何事件，
直接将 reply 分片与最终文本以换行连接后返回字符串。适用于不需要会话状态切换和事件流的
一次性命令执行场景。

### 斜杠命令透传（GUI-first）

control 通道是 GUI-first 的：relay-web 通过看板按钮驱动会话操作，所以用户在 web
聊天框里输入的任何 `/` 前缀文本都会被 `command-router` **原样转成 prompt 发给 agent**，
而不是当作 xacpx 命令解释（微信/飞书等无 GUI 的频道不受影响，仍走正常命令解析）。

**例外**：`session.reset`（`/clear`、`/session reset`）即使在 control 通道也仍由 xacpx
处理。web 端没有别的「清空/重置会话」入口，且 codex 等 ACP agent 不认识 `/clear`，原样转发
只会静默 no-op；而 reset 对 xacpx 会话模型是有副作用的（重建 transport 会话，并保持
native 标记），不能当作文本发给 agent。见 `src/commands/command-router.ts` 的透传分支。

reset 在回合内重建了 transport 会话，但 reset handler 不发事件，所以需要在回合结束后比较
`transportSession` 前后值，若变化则补发 `sessions-changed`（与 archived 徽标的兜底刷新同理），
否则看板会一直显示旧的 transport id / native 绑定直到下次无关刷新。`SessionTurnRunner` 只
捕获回合前的会话状态并作为 `postTurnDetection` 返回，真正的 `getSession` 比较由 `TurnQueue`
在 `draining.add` **之后**、`resolveSettled` 之前经 `detectSessionsChanged` 回调执行——那个
await 必须留在 draining 守护窗口内，否则一个被中止且带排队项的回合会让新提示词插进来抢跑
（由 golden fixture `aborted-queue-sessions-window` 钉住）。

### 模型切换与 timeout 对账

`control.session.model.set` 返回 `{ ok, current }`。正常切换时 `ok=true`；若 acpx 管理命令
timeout，ControlService 会通过 `getSessionModel` 读取 transport 权威值、将该值（包括空值）写回
逻辑会话，再返回 `current`。请求模型未实际生效时 `ok=false`，relay-web 必须采用返回的
`current`，不能盲目回滚到请求前的本地值。成功完成对账的 timeout 会把原始诊断
（stage、命令及有界 stdout/stderr tail）记录到 app log 的
`control.session.model.timeout_reconciled` 事件；对账查询本身失败时，原始 timeout 继续作为
RPC 错误返回，由 relay-web 浏览器诊断保留。同一逻辑会话的模型切换在 ControlService 内
串行执行，旧 timeout 的查询/持久化必须完成后才允许下一次切换，避免旧对账覆盖新值；不同
会话仍可并行。relay-web 同时用会话上下文与请求序号丢弃迟到响应，并把最后确认的权威模型
与当前乐观展示值分开保存；连续选择全部失败时回到权威值，而不是回到上一个乐观值。

该 RPC 的 connector 侧 60 秒 response timeout 被显式豁免：一次 30 秒 set timeout 后还可能
跟随一次 30 秒权威查询（bridge backstop 最坏为 45 秒 + 45 秒）。Hub 在下行 request envelope
中同时附带扣除 15 秒响应余量后的绝对 epoch work deadline 与 connector work budget；connector
仅在两者齐全时取更早值。绝对值保证传输耗时不会吃掉响应余量，相对 budget 限制跨机时钟偏差。
旧 Hub 或部分字段缺失时，connector fail closed，将 deadline 设为接收时刻，使请求在触碰
transport 前失败，而不是恢复到无期限排队。

### 推理强度（effort）

`control.session.effort.get` 从当前 transport session 的 acpx 记录读取 adapter 广告的
`thought_level` 配置项，返回 `{ current, available }`；未广告该能力时 `available=[]`。
xacpx 不假定固定的配置 id：Codex adapter 常见的 `reasoning_effort`、`effort`、
`thought_level` 等名称均由记录中的 `category/id` 识别。

`control.session.effort.set { sessionAlias, effort }` 先读取同一记录确定真实 config id，再通过
acpx 的既有 `set <key> <value>` 命令设置，返回 `{ ok, current }`。设置值由 adapter 广告的
`available` 驱动且在 transport 边界再次校验；具体可选值不在 xacpx 内硬编码。该路径同时支持
`acpx-cli` 与 `acpx-bridge` transport，保留会话的 driver/settings policy/provider 环境，
不修改或绕过上游 acpx。若 set 管理命令 timeout，ControlService 会通过 `getSessionEffort` 读取
transport 权威值并返回实际的 `{ current, applied }`；查询失败时仍保留原始 timeout。成功对账会记录
`control.session.effort.timeout_reconciled` 诊断事件。同一逻辑会话的 model/effort 配置写入共用串行队列，
避免旧操作最后落盘。
串行队列出闸时，ControlService 会为最坏 90 秒的 set + readback 预留完整预算；剩余时间不足的
请求在触碰 transport 前失败，避免排队重新吃掉 Hub 为状态变更保留的响应窗口。

### 事件总线覆盖范围

事件总线只保证「`ControlService` 自身发起的变更」会发事件；其它入口
（如微信频道命令）造成的变更暂不发事件，消费者如需全局快照应主动拉取。

## 文件上传（`control.upload`）

### RPC 描述

`control.upload` 将单个文件以 base64 内容上传到 daemon，写入 `~/.xacpx/runtime/uploads/<rand>/<safe-name>`。
它是**非聊天域** RPC（no `chatKey`/`senderId` 注入）：relay hub 直接转发给 daemon，不盖戳会话身份。

**请求**（`UploadPayload`，来自 `packages/relay-protocol`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `filename` | `string` | 原始文件名（服务端会 sanitize，去掉路径分隔符）。 |
| `content` | `string` | 纯 base64 编码的文件内容（无 `data:...;base64,` 前缀）。 |
| `mimeType` | `string` | 文件 MIME 类型（如 `image/png`、`text/plain`）。 |

**响应**（`UploadResult`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 随机生成的上传 ID（UUID-like），供后续 `PromptAttachmentRef` 引用。 |
| `path` | `string` | daemon 宿主机上的绝对路径（`~/.xacpx/runtime/uploads/<id>/<safe-name>`）。 |
| `filename` | `string` | 经 sanitize 后的实际存储文件名。 |
| `mimeType` | `string` | 原样回传。 |
| `size` | `number` | 文件字节数（服务端写入后计算）。 |

**安全约束：**
- 文件名 sanitize：路径分隔符（`/`、`..`）被替换，防止路径穿越写入。
- 单文件上限 **10 MB**（daemon 侧 `UploadStore` 检查，relay hub 另设同等 413 守卫）。
- relay hub 对非聊天域 RPC 不覆写 `chatKey`/`senderId`，避免把文件 ID 与某个具体会话绑定。

**TTL 清理：** `UploadStore` 在 daemon 启动时自动扫描 `~/.xacpx/runtime/uploads/`，
删除创建时间超过 **24 小时**的目录。运行期间不做清理，不影响已在途的 prompt。

### 实现位置

- `src/control/upload-store.ts` — `UploadStore`：写文件、sanitize、10MB 检查、TTL cleanup。
- `src/control/control-service.ts` — `uploadFile()` 委托给 `UploadStore`，对外暴露为 `ControlService.uploadFile()`。
- `packages/channel-relay/src/control-bridge.ts` — 分发 `control.upload` 消息到 `ControlService.uploadFile`。

## 带附件的 prompt（`control.prompt` 的 `media` 字段）

`ControlPromptInput`（及线协议 `PromptPayload`）带有可选字段 `media?: PromptAttachmentRef[]`：

```ts
interface PromptAttachmentRef {
  id: string;          // control.upload 返回的 id
  filePath: string;    // daemon 宿主机绝对路径（~/.xacpx/runtime/uploads/...）
  fileName: string;    // 文件名
  mimeType: string;
  kind: "image" | "file";
  size: number;
  previewUrl?: string; // 图片：downscaled data URL；非图片省略
}
```

`ControlService.prompt()` 将 `media` 映射为 `ChannelMediaAttachment[]`（`channelId: "relay"`），
通过已有的 `agent.chat → router → transport.prompt → prompt-media.ts` 链路转发给 agent：

- **`kind: "image"`** → ACP `image` content block（base64 或 data URL）。
- **`kind: "file"`** → ACP `resource` content block（file URI 或内容），并追加一段文字摘要：

  ```
  Attachments available as local files:
  - <filename> (<size> bytes): <daemon-absolute-path>
  ```

**重要注意事项（非图片文件的访问限制）：**
非图片文件以 **daemon 宿主机绝对路径**形式传递给 agent（resource block + 文字摘要路径）。
agent 必须对 `~/.xacpx/runtime/uploads/` 目录下的路径有**文件系统读取权限**；
该目录位于 workspace 之外，Claude Code / codex 可读取绝对路径，但若 agent 运行在
沙箱或受限工作目录中则可能无法访问。图片文件则以内容（base64）直接嵌入 ACP image block，
不存在此限制。

## 关联包

- **`packages/relay-protocol`** — relay 线协议（信封 + wire DTO），零依赖、
  不 import xacpx；core↔wire 的映射放在阶段二的连接器里。
