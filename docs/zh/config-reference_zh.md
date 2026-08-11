# xacpx 配置参考

`~/.xacpx/config.json` 是 xacpx 的主配置文件。

如果你想管理微信/飞书消息频道，请看 [`docs/channel-management.md`](./channel-management_zh.md)。如果你想在聊天里直接修改一部分配置，而不是手改 JSON，请看 [`docs/config-command.md`](./config-command_zh.md)。

## 完整示例

```json
{
  "transport": {
    "type": "acpx-bridge",
    "command": "acpx",
    "sessionInitTimeoutMs": 120000,
    "permissionMode": "approve-all",
    "nonInteractivePermissions": "deny",
    "queueOwnerTtlSeconds": 1800
  },
  "logging": {
    "level": "info",
    "maxSizeBytes": 2097152,
    "maxFiles": 5,
    "retentionDays": 7,
    "perf": {
      "enabled": false,
      "maxSizeBytes": 5242880,
      "maxFiles": 3,
      "retentionDays": 7
    }
  },
  "channel": {
    "replyMode": "verbose"
  },
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true }
  ],
  "plugins": [],
  "agents": {
    "codex": {
      "driver": "codex"
    },
    "claude": {
      "driver": "claude"
    }
  },
  "workspaces": {
    "backend": {
      "cwd": "/absolute/path/to/backend",
      "description": "backend repo"
    }
  },
  "orchestration": {
    "maxPendingAgentRequestsPerCoordinator": 3,
    "allowWorkerChainedRequests": false,
    "allowedAgentRequestTargets": [],
    "allowedAgentRequestRoles": [],
    "maxParallelTasksPerAgent": 3
  },
  "later": {
    "defaultMode": "temp"
  }
}
```

---

## `transport`

与 acpx 后端的通信方式。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `"acpx-cli"` \| `"acpx-bridge"` | 否 | 通信方式，缺省 `"acpx-bridge"`。详见下方说明 |
| `command` | `string` | 否 | 显式指定 acpx 二进制路径。不填则按优先级自动查找 |
| `sessionInitTimeoutMs` | `number` | 否 | session 初始化超时时间（毫秒），默认 `120000`（2分钟） |
| `permissionMode` | `"approve-all"` \| `"approve-reads"` \| `"deny-all"` | 否 | 权限模式，默认 `"approve-all"` |
| `nonInteractivePermissions` | `"deny"` \| `"fail"` | 否 | 非交互场景权限策略，默认 `"deny"` |
| `permissionPolicy` | `string` | 否 | acpx permission policy 文件路径（透传为 `acpx --permission-policy <value>`）；不填则不启用 |
| `queueOwnerTtlSeconds` | `number` | 否 | acpx queue owner 空闲存活时长（秒），透传为 prompt 命令的 `acpx --ttl <value>`。默认 `1800`（30 分钟）；`0` = 永久存活。详见下方“减少 agent 冷启动”说明 |
| `turnIdleTimeoutSeconds` | `number` | 否 | 正在执行的 agent 回合的空闲看门狗。若一个回合在这么多秒内没有产生任何流式 agent 活动（output/tool/thought/usage/plan/command 事件），就会被中止并报告为 `Turn timed out due to inactivity`，回收其占用的执行槽位。计时器会在每次流式事件时重置，因此耗时较长但持续活跃工作的回合不受影响——**但如果某次工具调用在整个窗口期内都保持静默（例如 `sleep`、没有中间输出的长时间编译/clone），仍会触发超时**；存在长时间静默操作的场景，请调大该值或设为 `0`。默认 `600`（10 分钟）；`0` 禁用该看门狗。每次回收都会记录一条 `control.turn.idle_timeout` 日志（含会话与具体阈值）便于排查 |

### `type` 可选值

#### `"acpx-cli"`

直接在当前进程里 spawn acpx 子进程，每次操作（prompt/cancel/ensureSession）都启动一个新进程，执行完退出。内部使用 `node-pty` 分配 PTY。

适合：本地开发、调试场景。

#### `"acpx-bridge"`（默认）

启动一个独立的 bridge 子进程（`bridge-main.ts`），acpx 在里面常驻运行。所有操作通过 stdin/stdout JSON 协议以 RPC 方式发送，acpx 进程不会每次命令都重启。

适合：生产环境、更稳定的长时间运行。

### `command` 解析优先级

当 `transport.command` 未指定时，按以下顺序查找 acpx：

1. 当前项目内安装的 `acpx`（`node_modules/.bin/acpx`）
2. Shell `PATH` 中的 `acpx`

显式指定 `command` 会覆盖上述行为。

### 减少 agent 冷启动（`queueOwnerTtlSeconds`）

acpx 在收到 prompt 时会拉起一个 **queue owner** 后台进程，它持有真正的 ACP agent（codex/claude 等 adapter）和模型上下文。xacpx 每条消息 spawn 的 `acpx prompt` 只是轻量前端，会通过 Unix socket 连到这个 queue owner——只要 owner 还活着，后续消息就**跳过 agent 冷启动**（adapter boot + `session/new`/`load`，通常数秒到数十秒）。

queue owner 的空闲存活时长由 acpx 的 `--ttl` 决定（acpx 自身默认 300 秒）。WeChat 对话天然有几分钟停顿，300 秒一过下一条消息就要冷启动。xacpx 默认把它设为 **1800 秒（30 分钟）**，覆盖绝大多数对话停顿；真正空闲后 agent 在 30 分钟内自动回收，daemon 停止后最多残留 30 分钟，自愈、不泄漏。

- 取值更大（如 `3600`）→ 更暖，但运行期残留窗口更长。
- `0` → 永久存活，后续消息全程零冷启动；运行期每个 session 常驻一个 agent 进程，资源占用最高。
- **daemon stop 时的清理**：xacpx 停止时会枚举自己的会话（普通用户会话 + orchestration worker 会话）并终止对应的 queue owner 进程（只杀进程、不 close acpx session，下次启动正常冷恢复）。因此即便 `ttl=0`，停止后也不会残留 owner。这是 best-effort：若清理失败或超时，owner 会按各自 TTL 自然过期（`ttl=0` 的则需手动清理），不影响停止流程。
- 普通会话：透传为 `acpx prompt --ttl <value>`，由该 prompt 拉起的 queue owner 继承此 TTL。
- orchestration coordinator 会话（设置了 `mcpCoordinatorSession`）：xacpx 会在 prompt 前预启 queue owner，该 owner 也按此 TTL 启动（内部转为毫秒），因此同样享受 warm 窗口。
- `sessions new/ensure`、`cancel` 等命令本身不带 `--ttl`，不受影响。
- 修改该值需重启 daemon 生效。

### orchestration MCP 自动注入

xacpx 会在向 acpx session 发送普通 prompt 前，临时启动 acpx 的 queue owner，并通过 `ACPX_QUEUE_OWNER_PAYLOAD` 注入名为 `xacpx` 的 stdio MCP server（工具前缀因此为 `mcp__xacpx__*`，例如 `mcp__xacpx__delegate_request`、`mcp__xacpx__scheduled_create`）。这样被 acpx 管理的 agent 可以看到 `delegate_request`、`scheduled_create` 等编排与定时任务工具。

这个兼容路径不会写入工作目录的 `.acpxrc.json`，也不会修改 `~/.acpx/config.json` 或替换 acpx home，因此不会影响 acpx 既有 sessions、流日志和 `index.json` 映射关系。

默认注入命令按以下顺序解析：

1. `WEACPX_CLI_COMMAND`
2. `WEACPX_DAEMON_ARG0` + 当前 Node 可执行文件
3. 当前进程入口 `process.argv[1]` + 当前 Node 可执行文件
4. `xacpx`

如果 xacpx 不是通过标准 CLI/daemon 启动，或路径需要特殊包装，可以显式设置 `WEACPX_CLI_COMMAND`，例如：

```bash
WEACPX_CLI_COMMAND="node /path/to/xacpx/dist/cli.js" xacpx run
```

---

## Tool-event routing

### Tool-event mode (`toolEventMode`)

`PromptOptions.toolEventMode` controls how `tool_call` / `tool_call_update`
events are surfaced for a single prompt:

- `"text"` — legacy emoji-prefixed segments folded into the reply text stream.
- `"structured"` — events go to the `onToolEvent` callback only.
- `"both"` — events go to `onToolEvent` AND legacy text segments. Useful for
  migration or debugging.

If omitted, the transport infers the mode at the boundary: `"structured"`
when an `onToolEvent` handler is provided, `"text"` otherwise. This
preserves the behavior every existing channel (Weixin, Yuanbao, Feishu
static, Feishu streaming card) relies on today.

**Async semantics for `onToolEvent`:** transports invoke the callback in
event order and await each invocation before dispatching the next. Prompt
completion waits for all in-flight callbacks to settle. A handler error
rejects the prompt with the first observed error.


---

## `logging`

运行日志配置。普通应用日志写入 `~/.xacpx/runtime/app.log`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `level` | `"error"` \| `"info"` \| `"debug"` | 否 | 应用日志级别，默认 `"info"` |
| `maxSizeBytes` | `number` | 否 | 单个 app.log 文件大小上限，默认 `2097152` |
| `maxFiles` | `number` | 否 | 保留的滚动 app.log 文件数，默认 `5`；`0` 表示超过大小后直接删除当前文件 |
| `retentionDays` | `number` | 否 | 过期滚动 app.log 清理天数，默认 `7` |
| `perf` | `object` | 否 | 性能 debug 日志配置，见下方 |

### `logging.perf`

开启后，xacpx 会把 Weixin 入站消息从收到到最终出站完成（文本 final；如有媒体则包含媒体发送完成）的关键耗时写入独立文件 `~/.xacpx/runtime/perf.log`。每个 checkpoint 一行，最后有 `turn.done` 汇总行。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | `boolean` | 否 | 是否启用 perf debug 日志，默认 `false` |
| `maxSizeBytes` | `number` | 否 | 单个 perf.log 文件大小上限，默认 `5242880` |
| `maxFiles` | `number` | 否 | 保留的滚动 perf.log 文件数，默认 `3`；`0` 表示超过大小后直接删除当前文件 |
| `retentionDays` | `number` | 否 | 过期滚动 perf.log 清理天数，默认 `7` |

注意：`logging.perf.enabled` 在 `buildApp()` 时绑定，修改该配置后需要重启 daemon 才会生效。当前只有内置 Weixin channel 接入 perf trace；其它插件 channel 即使开启该开关也不会写入自己的 turn。Weixin 出站媒体会记录 `reply.media_sent` / `reply.media_done`，耗时包含本地安全校验、上传到 Weixin CDN 以及发送媒体消息的总耗时；不细分上传与发送阶段。

---

## `channel`

全局消息平台默认配置。

### `channel.replyMode`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `replyMode` | `"stream"` \| `"final"` \| `"verbose"` | 否 | 回复模式。默认 `"verbose"` |

说明：

- `stream`：有中间文本分段时，优先流式发送
- `final`：抑制中间文本分段，只在最后发送一次最终文本
- `verbose`：在 stream 基础上额外发送工具调用等实时事件
- 这个配置是**全局默认值**
- 可以通过 `/replymode` 为**当前逻辑会话**设置覆盖值
- `/replymode reset` 会清除当前会话覆盖，回退到 `channel.replyMode`
- `final` 只影响文本是否实时发送，不改变 acpx transport 的输出生成方式

### `channel.ownerIds`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ownerIds` | `string[]` | 否 | 操作者信任的频道 owner 发送者 id 列表。来自这些发送者的群聊消息可以通过 owner 门槛的命令鉴权（控制类命令、`/later`、会话内 `scheduled_*` 工具），即使该频道协议不携带群角色信息。 |

说明：

- 微信协议**不携带任何群角色信息**，所以不配置 `ownerIds` 时，微信群里所有人（包括操作者自己）的特权命令都会被拒绝。把自己的发送者 id 加进来即可给自己授权。
- 同名字段也可以按频道配置在 `channels[].ownerIds`（使用对应频道的发送者 id 格式：微信 `from_user_id`、飞书 `open_id`、元宝账号 id）。
- `ownerIds` 中的发送者在频道自身上报的 owner 判定（如元宝的 `bot_owner_id`）之外**额外**被视为 owner，两者叠加生效。
- 把 `ownerIds` 设为空数组（`[]`）是显式撤销授权：该频道的回合会按 owner = false 记录（除非频道自身上报了 owner），并覆盖此前记录的 owner 状态。整个删掉该字段则表示「未配置」，不影响频道自身上报的 owner 判定。
- **如何找到自己的发送者 id**：在群里发送任意特权命令（如 `/clear`），拒绝记录会写入 `~/.xacpx/runtime/app.log` 的 `command.blocked` 日志条目，其中的 `senderId` 字段就是要填进 `ownerIds` 的 id。

```json
{
  "channel": {
    "type": "weixin",
    "ownerIds": ["wxid_xxxxxxxx"]
  }
}
```

### 兼容旧配置

旧配置文件中的 `wechat.replyMode` 仍然可以正常使用，加载时会自动映射到 `channel.replyMode`。保存后会写入 `channel` 格式。

---

## `channels`

多频道运行配置。定义要启动的消息频道列表。省略时根据 `channel.type`（旧单频道配置）自动生成。

推荐通过频道 CLI 管理这一段配置：

```bash
xacpx channel list
xacpx channel add feishu
xacpx channel disable weixin
xacpx restart
```

完整操作说明见：[docs/channel-management.md](./channel-management_zh.md)。

### `ChannelRuntimeConfig`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 频道唯一标识，必须与 `type` 相同（内置：`"weixin"`；插件：例如 `"feishu"`、`"yuanbao"`） |
| `type` | `string` | 是 | 频道类型。内置频道类型只有 `"weixin"`。`"feishu"` 由 `@ganglion/xacpx-channel-feishu` 提供，`"yuanbao"` 由 `@ganglion/xacpx-channel-yuanbao` 提供；其它类型由已安装插件提供 |
| `enabled` | `boolean` | 否 | 是否启用。默认 `true` |
| `ownerIds` | `string[]` | 否 | 按频道配置的受信 owner 发送者 id 列表，见 [`channel.ownerIds`](#channelownerids)。来自这些发送者的群聊消息可以通过 owner 门槛的命令鉴权。 |
| `options` | `object` | 视频道而定 | 频道配置（飞书/元宝字段见下方） |

### 飞书频道配置（`options`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options.appId` | `string` | 单 bot 时必填；多 bot 可省 | 飞书应用 App ID。顶层填一份等价于"单 bot 默认账号"；多 bot 时把每个 bot 的 `appId` 写在 `accounts.<id>.appId`，顶层可留空 |
| `options.appSecret` | `string` | 单 bot 时必填；多 bot 可省 | 飞书应用 App Secret。规则同 `appId` |
| `options.domain` | `"feishu"` \| `"lark"` | 否 | API 域名。默认 `"feishu"` |
| `options.requireMention` | `boolean` | 否 | 群聊是否需要 @机器人。默认 `true` |
| `options.textMessageFormat` | `"text"` | 否 | 发送格式。当前仅支持 `"text"` |
| `options.dedupTtlMs` | `number` | 否 | 消息去重 TTL（毫秒）。默认 `43200000`（12 小时） |
| `options.dedupMaxEntries` | `number` | 否 | 去重缓存最大条目。默认 `5000` |
| `options.defaultAccount` | `string` | 否 | 多 bot 模式下的默认账号 id；省略时优先 `default`，否则取第一个 `accounts.<id>` |
| `options.accounts` | `object` | 否 | 按 `accountId` 索引的多账号覆盖配置；每个子项可覆盖 `appId/appSecret/domain/requireMention/dmPolicy/groupPolicy/allowFrom/enabled/name`。chatKey 形如 `feishu:<accountId>:<chatId>`。详见 [docs/channel-management.md](./channel-management_zh.md#飞书多-bot同一频道多个账号) |
| `options.dmPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 否 | 私聊准入策略，默认 `"open"`（保持旧行为，任何人发起私聊都接收）。`"allowlist"` 时只接受 `allowFrom` 列表中的发送者；`"disabled"` 时全部丢弃 |
| `options.groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 否 | 群聊准入策略，默认 `"open"`。语义同 `dmPolicy`，`requireMention` 仍然独立生效 |
| `options.allowFrom` | `string[]` | 否 | 发送者 `open_id` 白名单；只在任一 policy 为 `"allowlist"` 时生效。包含 `"*"` 等价于"任何带 open_id 的发送者"。`allowlist` 模式下不能为空 |
| `options.replyMode` | `"static"` \| `"streaming"` \| `"auto"` | 否 | 回复呈现方式。默认 `"auto"`(私聊走 streaming、群聊走 static);`"static"` 为多条独立文本消息;`"streaming"` 改为一张 CardKit v2 交互卡片在一条消息里原地更新(thinking → streaming → complete/aborted/error,带耗时 footer 实时跳动、自动 reasoning 折叠、verbose 模式下工具调用渲染为可折叠 **🔧 工具调用** 面板而非内联文本、markdown 图片 URL → image_key 解析、字符级流式更新、daemon 退出时自动把卡片驱动到"已停止"状态)。机器人需具有 `cardkit:card:write` + `im:message:send_as_bot` 权限;首次创建卡片失败时会自动回退到 static 并打印 `feishu.streaming.fallback` 日志(权限缺失还会一次性把授权链接发给用户)。也可在 `options.accounts.<id>.replyMode` 上做账号级覆盖 |

### 元宝频道配置（`options`，由 `@ganglion/xacpx-channel-yuanbao` 提供）

元宝频道由插件 `@ganglion/xacpx-channel-yuanbao` 提供：插件内置元宝签名、WebSocket、消息收发、chatKey 路由、inbound → agent、去重、同会话串行和基础 outbound 策略。先 `xacpx plugin add @ganglion/xacpx-channel-yuanbao`，再添加频道；正常用户不需要配置 gateway module。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options.appKey` | `string` | 与 `appSecret` 成对必填 | 元宝机器人 App Key |
| `options.appSecret` | `string` | 与 `appKey` 成对必填 | 元宝机器人 App Secret |
| `options.token` | `string` | 否 | 静态 token；兼容 `appKey:appSecret` 形式，加载时会拆成 appKey/appSecret。真正的静态 auth token 需要同时配置 `botId` |
| `options.gatewayModule` | `string` | 否 | 兼容旧配置/开发调试用的外部 gateway 覆盖；普通用户不要配置 |
| `options.botId` | `string` | 否 | 机器人账号 ID，用于本地识别 @机器人 与过滤自消息；通常 sign-token 会返回并自动补齐 |
| `options.apiDomain` | `string` | 否 | 元宝 API 域名，默认 `"bot.yuanbao.tencent.com"` |
| `options.wsUrl` | `string` | 否 | 元宝 WebSocket 地址，默认 `"wss://bot-wss.yuanbao.tencent.com/wss/connection"` |
| `options.requireMention` | `boolean` | 否 | 群聊是否需要 @机器人。默认 `true` |
| `options.replyToMode` | `"off"` \| `"first"` \| `"all"` | 否 | 引用回复策略，默认 `"first"` |
| `options.overflowPolicy` | `"stop"` \| `"split"` | 否 | 超长文本策略，默认 `"split"` |
| `options.maxChars` | `number` | 否 | xacpx 出站文本拆分阈值，默认 `3000` |
| `options.outboundQueueStrategy` | `"immediate"` \| `"merge-text"` | 否 | gateway 可用的预留字段；xacpx 当前不执行合并队列 |
| `options.minChars` / `options.idleMs` | `number` | 否 | gateway 可用的预留字段；xacpx 当前不执行基于空闲时间的合并 |
| `options.mediaMaxMb` | `number` | 否 | 媒体大小上限，默认 `20` |
| `options.historyLimit` | `number` | 否 | gateway 可用的预留字段，默认 `100` |
| `options.disableBlockStreaming` | `boolean` | 否 | 是否禁用块状流式回复，默认 `false` |
| `options.fallbackReply` | `string` | 否 | agent 无文本返回时发送的兜底文案 |
| `options.markdownHintEnabled` | `boolean` | 否 | gateway 可用的预留字段，默认 `true` |
| `options.accounts` | `object` | 否 | 多账号覆盖配置；子项会继承顶层配置 |

### 微信频道扩展配置（`openclaw.json`）

内置 weixin 频道的 `options` 当前为空对象；以下字段从单独的 `openclaw.json` 文件读取（路径默认 `~/.xacpx/state/openclaw.json`，可用环境变量 `OPENCLAW_CONFIG` 覆盖）。这是 xacpx 从 openclaw 沿用过来的扩展点，**与主 `~/.xacpx/config.json` 不是同一个文件**。

文件根形如：
```json
{
  "channels": {
    "openclaw-weixin": {
      "routeTag": "...",
      "botAgent": "MyApp/1.0",
      "accounts": {
        "<accountId>": {
          "routeTag": "...",
          "botAgent": "MyApp/1.0 (account-A)"
        }
      }
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `routeTag` | `string` \| `number` | 否 | 写入 `SKRouteTag` 请求头，由后端用于灰度/分流；账号级 `accounts.<id>.routeTag` 优先于顶层 |
| `botAgent` | `string` | 否 | UA 风格客户端标识，写入 `base_info.bot_agent`。语法 `name/version[ (comment)]`，多 token 用空格分隔；超长（>256 字节）截断；非法 token 静默丢弃；空时回退到 `xacpx`。账号级 `accounts.<id>.botAgent` 优先于顶层 |
| `accounts.<id>` | `object` | 否 | 按 weixin 账号 id 覆盖顶层字段；目前可覆盖 `routeTag` 和 `botAgent` |

### 示例

仅微信：

```json
{
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true }
  ]
}
```

微信 + 飞书：

```json
{
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true },
    {
      "id": "feishu",
      "type": "feishu",
      "enabled": true,
      "options": {
        "appId": "cli_xxx",
        "appSecret": "...",
        "domain": "feishu"
      }
    }
  ]
}
```

元宝（需先安装 `@ganglion/xacpx-channel-yuanbao`）：

```json
{
  "plugins": [
    { "name": "@ganglion/xacpx-channel-yuanbao", "enabled": true }
  ],
  "channels": [
    {
      "id": "yuanbao",
      "type": "yuanbao",
      "enabled": true,
      "options": {
        "appKey": "yb_xxx",
        "appSecret": "...",
        "requireMention": true
      }
    }
  ]
}
```

### 兼容旧配置

旧配置文件中的 `channel.type` 仍然可以正常使用，加载时会自动生成单频道的 `channels[]`。新的多频道配置推荐使用 `xacpx channel ...` 管理。

旧版飞书配置中的 `feishu` 对象仍作为 legacy alias 兼容读取；新配置请统一写入 `options`。

---

## `plugins`

通过 `xacpx plugin add <npm-package>` 安装的外部插件包。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | npm 包名 |
| `version` | `string` | 否 | 安装时记录的版本范围或版本号 |
| `enabled` | `boolean` | 否 | 是否加载该插件，默认 `true` |

`plugins[]` is lifecycle metadata for packages installed under `~/.xacpx/plugins`. It does not enable a channel by itself; `channels[]` still controls which channel runtimes start. After changing plugin install, update, enable, disable, or remove state while the daemon is running, restart the daemon so plugin registration is reloaded.

安装插件只表示频道类型可用，不会自动启用频道。启用频道仍然需要：

```bash
xacpx channel add <channel-type>
```

详见 [`docs/plugin-development.md`](./plugin-development_zh.md)。

---

## `agents`

注册的 agent 映射表，key 为 agent 名称（供 `/agent add`、`/session new --agent` 使用）。

### Agent 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `driver` | `string` | 是 | agent 驱动类型，传递给 acpx 的第一位置参数 |
| `command` | `string` | 否 | 显式指定自定义 agent 的原始命令。与 `argv` 互斥；Windows 上 raw command 无法无损启动（acpx 拒绝），请改用 `argv`（见下） |
| `argv` | `string[]` | 否 | 精确的可执行文件 + 参数边界（如 `["C:\\Program Files\\agent.exe", "--acp", ...]`）。首元素必须是非空可执行文件；每个元素原样传给 acpx（空格、反斜杠、空字符串均保留）。与 `command` 互斥；这是 Windows 上唯一无损的启动形式。修改 `argv` 会产生新的 acpx session identity（内容寻址 alias）；旧 session 保留其记录的 identity |

说明：

- 内置模板建议只写 `driver`，让 `acpx` 自己解析对应 alias
- `agent.command` 主要用于自定义 agent，不建议给内置 driver 手写原始命令
- 旧版 `codex` raw command 配置在加载时会被自动忽略，回退为 `acpx codex ...`

#### Windows raw command 迁移

含空格的旧 Unix `command` 在 Windows 上无法启动（acpx 拒绝 raw `--agent`，猜测引号切分会破坏边界）。xacpx 会 fail closed 并给出迁移错误，而不是猜测。请改为结构化 argv：

```json
{
  "agents": {
    "my-agent": {
      "driver": "custom",
      "argv": ["C:\\Program Files\\agent\\agent.exe", "--acp", "--flag", "two words"]
    }
  }
}
```

单 token 命令（无空格，如 `"myagent.exe"`）只有**无损**时才会自动转换为 `["myagent.exe"]` —— 单个元素必须能用 canonical identity renderer 精确还原为原始命令。identity-safe charset 之外的 token（带反斜杠的 Windows 路径、引号等）会渲染成 JSON-quoted，写下去会 re-key acpx record，所以这类 session 会被 skip 并保持 fail-closed，直到用户手动迁移。

##### 启动时自动迁移

以上是手动迁移的形态。实际触发坏状态的链路对用户不可见：acpx 内置默认值为多 token 的 agent（`kimi acp`、`qwen acp`、`gemini acp`、`cursor-agent acp` 等）在首次启动后都会通过 `refreshSessionTransportAgentCommand` 把 `transport_agent_command: "<driver> acp"` 写进 `state.json`。然后在 Windows 上 daemon 重启就会撞到 fail-closed 的 throw。

为了让迁移真自动，console 生命周期会在**取得 runtime consumer lock 之后**（任何服务接触 config/state 之前）跑一遍 `migrateStateAgentArgv`（[`src/state/auto-migrate-agent-argv.ts`](../../src/state/auto-migrate-agent-argv.ts)）。这个顺序很关键：`buildApp` 在拿锁之前就加载了共享 config/state，如果 migration 内联在 buildApp 里跑，会与并发的 `xacpx migrate argv` 竞争——daemon 会把 CLI 的改动看成"已迁移"而跳过，然后拿着旧的内存快照启动。在锁内跑并在之后**原地 reload** config/state（migration 无条件重读两个文件，所有持有引用的服务——`SessionService`、transport——都会看到迁移后的值）可以关掉这个窗口：

1. **per-session planning（Path A；不写全局 argv）**：每条 session 独立评估。同一 agent 下的 sibling 不再互相卡死——Path A 永不写入 `agents.<name>.argv`，所以一条 session 的 alias 不会 re-key 另一条。

   session **完全迁移（noop）** 仅当同时具备 `transport_agent_argv` 与匹配 `deriveAgentAlias(driver, argv)` 的 canonical `transport_acpx_agent`。`resolveLaunchSpec` step 2 需要两者；**仅有 argv 视为 repair backfill**，不是已完成。

   **session-local 结构化迁移（provenance-aware）**：planned argv 会作为 **session-local 结构化启动** 通过 `xacpx-managed-<driver>-<hash>` alias 落到 session 本身——历史 session 凭借 `resolveLaunchSpec` step 2（`transport_acpx_agent` + `transport_agent_argv`）永久绑定到该 alias。**`agents.<name>.argv` 永远不写**——migration 是纯 session-local 的，未来同一 driver 的新 bare session 继续走 acpx 解析，**始终尊重 `~/.acpx/config.json` 全局 override 和 `<cwd>/.acpxrc.json` 项目级 override**。三种 provenance 决定是否给 session 派生 alias：
   - `derived`（托管 adapter npx pin、hermes shim、opencode/kilocode 本地 fallback）→ **skip**。derived 启动会随当前 pin/config 重算，固化成 session-local alias 就废掉了重算语义。session 保持 fail-closed 直到手动迁移。
   - `bare-acpx-registry`（kimi / qwen / gemini ...）→ **provision**。
   - `explicit-config`（config 已经带 argv）→ **provision**（同一个 argv 派生出同一个 alias，config 端 overlay provisioning 已建好条目）。

   单条 session skip（不影响 sibling）：
   - **不匹配当前默认的历史 custom argv**：把 registry 默认提升为 session-local alias 会遮蔽当前启动——skip（用户须手动迁移）。
   - **unknown / 无法证明的 identity**：既无 recorded command 也无 argv，或无法从 config argv / acpx record 证明 identity——只 skip 该 session。
   - 已匹配当前非 derived 默认但缺 canonical alias 的 session 会 **repair**（写 `transport_acpx_agent`）。
2. **锁内事务式 apply**：apply 阶段在 `withPrivateFileLock(statePath, …)` 内执行：
   - 锁内重新读 `state.json`，对每条计划中的 session 更新做 fresh 校验（alias 仍存在、agent 一致、identity 一致、argv 匹配或需 repair）。Path A 是 per-session：校验失败的 session 单独 skip，其它仍继续。
   - 通过 `ensureAgentOverlays` 把新 session 的 overlay（`xacpx-managed-<driver>-<hash>` 条目）**写到 `~/.acpx/config.json`**——必须先于 state 写完成；若 provisioning 抛错，abort 整个事务（不写 state）。
   - 写 state：持久化 `transport_acpx_agent`（alias）+ `transport_agent_argv`。**不写 xacpx config**。其余顶层 key 原样保留。`migrated` 在 `writeLocked` resolve 后才提交到 `result.migrated`。
   - **fresh-config 围栏（持有 config lock）**：在 state lock 内再拿与 `ConfigStore.patchRaw` 相同的 xacpx `config.json` proper-lock（顺序：state → config）。fresh-read config 并对每条 validated update 复检（agent 仍存在、driver 未变、effective default argv 仍等于 planned argv、provenance 仍允许 Path A）。该锁一直持有到 overlay provision 与 state 写完成，避免并发 CLI config writer 插进 fence→sticky elevate 窗口。
   - **重启鲁棒性**：每次启动 `autoMigrateArgv` 都会按 live state 重新 provision session overlay（`computeSessionOverlayEntries(state)`）。所有权自证：仅当 `isCanonicalManagedAliasForArgv(alias, argv)` 成立才 replay（前缀 + hash + 用 alias 内嵌 driver 重算）。裸名 / 篡改 hash 跳过；历史 sticky alias 在 `agents.<name>.driver` 变更后仍能恢复。overlay replay fail-closed。按 argv 内容哈希，幂等。
3. **错误透明暴露给运维**：任何 I/O 失败（state 读、config 读、state 写、acpx record 读、acpx index 损坏、overlay provision）都会 push 到 `result.errors` **并**通过 app logger 写日志。daemon 路径 best-effort（日志 + 继续），CLI 路径把所有错误打到 stderr 并退出码非零，operator 工具永远不会静默吞掉真实故障。"transaction failed" 消息会显式说明 overlay 是否已经在 state 写失败前被提交，**以及** state.json 可能未改或部分写入（`writePrivateFileAtomic` 的 temp+rename 在 POSIX 上原子，但 Windows 的直接写 fallback 可能留半文件），让 operator 在 partial failure 后能正确核对两边文件。

迁移按设计是 fail-closed：per-session provenance/identity 门控（planning）、fresh-state per-session 复检（lock）、以及 state 写之前的 overlay provision。本迁移**永不**给 `config.json` 加 `agents.<name>.argv`，因此不会把 session 静默 re-key 到错的 acpx record。

注意：这不是真正的两文件 transaction。state 和 acpx config 用的是各自独立的锁，state 写失败时 acpx-config 侧可能已经提交。错误消息把这种不对称显式化，让 operator 在 partial failure 后能核对两边文件。

CLI 命令 `xacpx migrate argv [--dry-run]` 把同一份 evaluate 暴露成独立的运维入口（打印计划，若有 skipped 或 error 则退出码非零）。**变更路径会获取并全程持有与 runtime 相同的 consumer lock**（后台 daemon 和前台 `xacpx run` 都持同一把锁）——daemon-status 观察只是更友好的报错，不是正确性围栏。锁忙（daemon 在跑、前台 runtime、或 daemon 正在启动）时直接拒绝并以非零退出。`--dry-run` 不拿锁，但快照可能 stale。

#### xacpx 托管的 acpx agent alias

结构化启动（托管 Codex/Claude pin、hermes shim、本地 fallback、用户 `argv`）通过内容寻址位置参数 alias（`xacpx-managed-<driver>-<sha256-prefix>`）暴露给 acpx。启动时 xacpx 在 proper-lockfile 保护下把 `{ "argv": [...] }` 安全合并进 `~/.acpx/config.json` 的 `agents` 节点，保留其它所有 key 与用户 agent 条目。绝不写 `.acpxrc.json`；已存在但 argv 不同的 alias 拒绝覆盖（fail closed）；不自动清理旧 alias（旧 session/旧 pin 可能仍引用）。升级不会删除或 close 任何已有 session；旧 session record 缺少 `agent_argv` 时，仅当 record 的 `agent_command` 与目标 argv 的 canonical identity 完全一致才回填，并复用同一 record id 恢复。

### 内置模板

通过微信发送 `/agent add <name>`，或在终端运行 `xacpx agent add <name>` 时使用以下内置模板；终端也可以用 `xacpx agent templates` 查看模板列表。添加已存在且配置相同的 agent 是幂等操作；如果同名 agent 已有不同配置，命令会提示先删除，不会静默覆盖自定义配置。

| 模板名 | driver | command |
|--------|--------|---------|
| `codex` | `"codex"` | 无（使用 acpx 默认） |
| `claude` | `"claude"` | 无（使用 acpx 默认） |
| `pi` | `"pi"` | 无（使用 acpx 默认） |
| `openclaw` | `"openclaw"` | 无（使用 acpx 默认） |
| `gemini` | `"gemini"` | 无（使用 acpx 默认） |
| `cursor` | `"cursor"` | 无（使用 acpx 默认） |
| `copilot` | `"copilot"` | 无（使用 acpx 默认） |
| `droid` | `"droid"` | 无（使用 acpx 默认） |
| `factory-droid` | `"factory-droid"` | 无（使用 acpx 默认） |
| `factorydroid` | `"factorydroid"` | 无（使用 acpx 默认） |
| `grok-build` | `"grok-build"` | 无（使用 acpx 默认） |
| `hermes` | `"hermes"` | 无（使用 xacpx 内置 shim） |
| `iflow` | `"iflow"` | 无（使用 acpx 默认） |
| `kilocode` | `"kilocode"` | 无（使用 acpx 默认） |
| `kimi` | `"kimi"` | 无（使用 acpx 默认） |
| `kiro` | `"kiro"` | 无（使用 acpx 默认） |
| `mux` | `"mux"` | 无（使用 acpx 默认） |
| `opencode` | `"opencode"` | 无（使用 acpx 默认） |
| `pool` | `"pool"` | 无（使用 acpx 默认） |
| `qoder` | `"qoder"` | 无（使用 acpx 默认） |
| `qwen` | `"qwen"` | 无（使用 acpx 默认） |
| `trae` | `"trae"` | 无（使用 acpx 默认） |
| `zeroclaw` | `"zeroclaw"` | 无（使用 acpx 默认） |

`hermes` 不在 acpx 内置注册表中，xacpx 会在启动时注入启动命令：一个随包分发的 stdio shim（`dist/adapters/hermes-acp-shim.js`），它运行 `hermes acp` 并从 initialize 响应中剥离 `sessionCapabilities.resume` 能力。这是为了绕过 hermes-agent 在每次 `session/resume` 时重放全部历史的缺陷（[NousResearch/hermes-agent#32201](https://github.com/NousResearch/hermes-agent/issues/32201)），强制 acpx 走带重放抑制的 `session/load` 路径；shim 命令在运行时解析，不会写入 `config.json`。使用前需本机安装 [Hermes Agent](https://hermes-agent.nousresearch.com/) 及其 ACP 依赖（`uv pip install -e '.[acp]'`），并在 `~/.hermes/` 下配置好模型凭据。显式设置 `agents.<name>.command`（字面值 `hermes acp` 除外，它被视为模板默认值）会绕过 shim。注意：shim 命令内嵌了 node 可执行文件和 xacpx 安装路径，升级 node 或移动安装位置会改变 acpx 用于匹配会话记录的命令字符串——此时 acpx 会为 hermes 新建后端会话记录，而不是复用旧记录。

### 示例

```json
{
  "agents": {
    "codex": {
      "driver": "codex"
    },
    "claude": {
      "driver": "claude"
    },
    "kimi": {
      "driver": "kimi"
    },
    "my-agent": {
      "driver": "custom",
      "command": "/usr/local/bin/my-agent"
    }
  }
}
```

---

## `workspaces`

注册的工作区映射表，key 为工作区名称（供 `/workspace new`、`/session new --ws` 使用）。

首次创建配置时会自动种入一个 `home` 工作区（`cwd` 为 `~`），让你开箱即用；不需要可用 `xacpx workspace rm home` 删除。

### Workspace 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | `string` | 是 | 工作区路径，acpx 的 `--cwd` 参数；支持以 `~` 开头，加载时展开为用户主目录 |
| `description` | `string` | 否 | 描述信息，供 `/workspaces` 命令展示用 |

### 示例

```json
{
  "workspaces": {
    "backend": {
      "cwd": "/Users/name/Projects/backend",
      "description": "backend repo"
    },
    "frontend": {
      "cwd": "/Users/name/Projects/frontend"
    }
  }
}
```

---

## `orchestration`

控制 agent 发起委派请求时的默认守卫策略。

### `orchestration.*`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `maxPendingAgentRequestsPerCoordinator` | `number` | 否 | `3` | 单个 coordinator 下允许同时处于 `needs_confirmation` / `running` 的 agent 发起委派任务上限 |
| `allowWorkerChainedRequests` | `boolean` | 否 | `false` | 是否允许 worker 会话再发起委派请求。默认拒绝，避免多跳扩散 |
| `allowedAgentRequestTargets` | `string[]` | 否 | `[]` | 允许 agent 发起委派时指定的目标 agent 白名单。空数组表示不额外限制 |
| `allowedAgentRequestRoles` | `string[]` | 否 | `[]` | 允许 agent 发起委派时使用的 role 白名单。空数组表示不额外限制 |
| `maxParallelTasksPerAgent` | `number` | 否 | `3` | 每个 agent 可同时运行的并行委派任务上限（整数 ≥ 1），跨所有 coordinator 和工作区全局计数。超出上限的 `parallel: true` 任务创建为 `queued` 状态，不占用 acpx session；有 slot 释放时自动按创建时间顺序升为 `running` 并开始执行。`queued` 任务仍计入 `maxPendingAgentRequestsPerCoordinator` 配额 |
| `progressHeartbeatSeconds` | `number` | 否 | `300` | 长时间运行的委派任务发送进度心跳的间隔（秒）。接受任意有限数；缺省或非有限值时回退为 `300` |

### 示例

```json
{
  "orchestration": {
    "maxPendingAgentRequestsPerCoordinator": 5,
    "allowWorkerChainedRequests": false,
    "allowedAgentRequestTargets": ["claude", "codex"],
    "allowedAgentRequestRoles": ["reviewer", "planner"],
    "maxParallelTasksPerAgent": 5
  }
}
```

---

## `later`

### `later.defaultMode`

定时任务（`/lt`）的默认执行会话模式。

- `"temp"`（默认）：到点新建临时会话执行，跑完即销毁。
- `"bind"`：到点发送到创建时绑定的当前会话。
- 单条任务可用 `--temp` / `--bind` 覆盖默认值。

---

## 环境变量覆盖

以下环境变量可覆盖配置文件路径：

| 环境变量 | 说明 |
|----------|------|
| `WEACPX_CONFIG` | 配置文件路径（默认 `~/.xacpx/config.json`） |
| `WEACPX_STATE` | 状态文件路径（默认 `~/.xacpx/state.json`） |
| `WEACPX_WEIXIN_SDK` | 强制指定 weixin-agent-sdk 入口文件路径 |
| `WEACPX_ILINK_APP_ID` | 微信频道出网请求所携带的 `iLink-App-Id` 头。留空时不发送该头（向后兼容） |

---

## 最小配置

以下配置即可正常启动：

```json
{
  "transport": {},
  "agents": {},
  "workspaces": {},
  "orchestration": {}
}
```

`transport.type` 默认为 `"acpx-bridge"`，其他字段留空或省略即可。agents 和 workspaces 可以先留空，后续在聊天里通过命令创建。

---

## 通过聊天命令修改配置

xacpx 支持通过 `/config` 和 `/config set <path> <value>` 修改**部分受支持字段**。

注意：

- `/config` 不是任意 JSON 编辑器
- 只允许修改白名单中的路径
- `agents.<name>.*` / `workspaces.<name>.*` 仅在目标已存在时允许修改

详见 [`docs/config-command.md`](./config-command_zh.md)。
