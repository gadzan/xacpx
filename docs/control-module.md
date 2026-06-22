# `src/control` 模块说明（Control API）

`ControlService` 是面向结构化消费者（首个是 relay 连接器，见
[docs/superpowers/specs/2026-06-13-relay-hub-design.md](superpowers/specs/2026-06-13-relay-hub-design.md)）的核心控制门面。
它聚合了 `SessionService` / `ActiveTurnRegistry` / `ScheduledTaskService` /
`OrchestrationService` / `ConsoleAgent`（ChatAgent），自身无持久状态——仅在内存里
跟踪 in-flight turn（通过私有 `Map<string, AbortController>`）。

## 文件

- **`src/control/control-service.ts`** — 门面主体：sessions / scheduler /
  orchestration / prompt / executeCommand。导出类型：`ControlServiceDeps`、
  `ControlSessionInfo`、`ControlPromptInput`、`ControlPromptResult`、
  `ControlExecuteCommandInput`。
- **`src/control/control-event-bus.ts`** — `ControlEventBus` 接口与
  `createControlEventBus` 工厂：支持 `turn-output` / `turn-finished` /
  `sessions-changed` / `scheduled-changed` / `orchestration-changed` 五类事件；
  监听器异常彼此隔离（经注入的 `logger.error` 记录，不外抛）。

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

### prompt 并发保护

`prompt` 在注册 in-flight 条目之后才调用 `useSession(chatKey, alias)` 绑定当前会话。
同一 `(chatKey, sessionAlias)` 组合同时只允许一个 in-flight turn——若 key 已存在则立即返回
`{ ok: false, errorMessage: "turn-already-running" }`，不走 agent。
这一顺序（先写注册，再调 useSession）刻意闭合了并发竞态窗口。
`cancelTurn` 通过已保存的 `AbortController.abort()` 中止 turn。

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
