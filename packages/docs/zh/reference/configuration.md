# 配置参考

`~/.xacpx/config.json` 是 xacpx 的主配置文件。若需从终端管理聊天频道（微信、飞书、元宝），请参阅[频道管理](/zh/guide/channel-management)。若需从聊天界面修改部分字段，请参阅 [/config 命令](/zh/reference/config-command)。

## 文件位置

| 文件 | 默认路径 | 用途 |
|------|----------|------|
| 配置文件 | `~/.xacpx/config.json` | 主配置 |
| 状态文件 | `~/.xacpx/state.json` | 会话、聊天上下文、守护进程状态 |
| 插件目录 | `~/.xacpx/plugins/` | 由 `xacpx plugin add` 安装的插件包 |
| 运行时日志 | `~/.xacpx/runtime/app.log` | 应用日志 |
| 性能日志 | `~/.xacpx/runtime/perf.log` | 性能调试日志（启用后生效） |

环境变量覆盖：

| 变量 | 说明 |
|------|------|
| `WEACPX_CONFIG` | 覆盖配置文件路径（默认：`~/.xacpx/config.json`） |
| `WEACPX_STATE` | 覆盖状态文件路径（默认：`~/.xacpx/state.json`） |
| `WEACPX_WEIXIN_SDK` | 强制指定 `weixin-agent-sdk` 入口文件路径 |
| `WEACPX_ILINK_APP_ID` | 微信频道出站请求中发送的 `iLink-App-Id` 请求头；省略则不发送该头（向后兼容） |

## 顶层结构

```jsonc
{
  "language": "zh",
  "transport": { ... },
  "logging": { ... },
  "channel": { ... },
  "channels": [ ... ],
  "plugins": [ ... ],
  "agents": { ... },
  "workspaces": { ... },
  "orchestration": { ... },
  "later": { ... }
}
```

**最小可用配置：** 以下内容即可启动 xacpx。`transport.type` 默认为 `"acpx-bridge"`；`agents` 和 `workspaces` 可在之后通过聊天命令填充。

```json
{
  "transport": {},
  "agents": {},
  "workspaces": {},
  "orchestration": {}
}
```

## 语言

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `language` | `"en"` \| `"zh"` | 否 | 选择 xacpx 运行时输出（聊天回复、CLI 输出、编排提示词等）的语言；缺省时首次启动按系统 locale（`$LANG` 等，`zh*` → 中文，否则英文）推断并写入配置；可用 `/config set language en` 修改；改后需 `xacpx restart` 生效 |

## 传输层配置

控制 xacpx 与 `acpx` 后端的通信方式。

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `type` | `"acpx-cli"` \| `"acpx-bridge"` | 否 | 通信模式；省略时默认为 `"acpx-bridge"` |
| `command` | `string` | 否 | `acpx` 二进制文件的显式路径；覆盖自动解析逻辑 |
| `sessionInitTimeoutMs` | `number` | 否 | 会话初始化超时时间（毫秒，默认：`120000`） |
| `permissionMode` | `"approve-all"` \| `"approve-reads"` \| `"deny-all"` | 否 | 权限模式；**省略时默认为 `"approve-all"`**，即非交互式提示词回合不会因权限请求停止，除非显式配置更严格的策略 |
| `nonInteractivePermissions` | `"deny"` \| `"fail"` | 否 | 非交互式场景的权限策略（默认：`"deny"`） |
| `permissionPolicy` | `string` | 否 | `acpx` 权限策略文件路径；以 `acpx --permission-policy <value>` 形式传入 |
| `queueOwnerTtlSeconds` | `number` | 否 | `acpx` 队列所有者进程的空闲存活时间（秒）；以 `--ttl` 形式传入（默认：`1800`；`0` = 永久保活） |

### 传输类型

**`"acpx-cli"`** — 每次操作（prompt/cancel/ensureSession）都启动一个新的 `acpx` 子进程，使用 `node-pty` 分配 PTY。适合本地开发和调试。

**`"acpx-bridge"`** — 启动一个持久的桥接子进程（`bridge-main.ts`）。所有操作通过 stdin/stdout JSON RPC 发送；`acpx` 进程在命令之间不重启。适合生产环境和长期运行的部署。

### `acpx` 二进制文件解析顺序

未设置 `transport.command` 时，xacpx 按以下顺序查找 `acpx`：

1. `node_modules/.bin/acpx`（项目内置）
2. shell `PATH` 中的 `acpx`

显式设置 `transport.command` 将完全覆盖此查找逻辑。

### 减少冷启动（`queueOwnerTtlSeconds`）

`acpx` 收到提示词时会启动一个**队列所有者**后台进程，用于持有 ACP 代理和模型上下文。xacpx 后续的每条消息都通过 Unix socket 连接到同一个所有者——跳过适配器启动 + `session/new`/`load` 冷启动阶段（通常需要数秒至数十秒）。

所有者的空闲存活时间由 `--ttl` 设置。xacpx 默认为 `1800` 秒（30 分钟），可覆盖大多数对话间歇。真正空闲后，代理会在 30 分钟内自动回收。

- 较大的值（如 `3600`）可使代理保持更长时间的预热状态，但会延长守护进程停止后的残留窗口。
- `0` = 永久保活；每个会话维持一个持久的代理进程；资源占用最高。
- 执行 `xacpx stop` 时，xacpx 会尽力终止已知会话的队列所有者进程（失败不阻塞关闭）。`ttl=0` 且在非正常关闭后存活的会话需要手动清理。
- 修改此值需要重启守护进程。

### 编排 MCP 自动注入

向 `acpx` 会话发送提示词之前，xacpx 会启动 `acpx` 队列所有者，并通过 `ACPX_QUEUE_OWNER_PAYLOAD` 注入一个名为 `xacpx` 的 MCP stdio 服务器。因此 MCP 工具前缀为 `mcp__xacpx__*`（例如 `mcp__xacpx__delegate_request`），使托管代理能够访问编排工具（`delegate_request` 等）和定时任务工具。

此注入不会修改 `.acpxrc.json`、`~/.acpx/config.json` 或替换 `acpx` 主目录，因此已有的会话、流式日志和索引映射均不受影响。

注入命令解析顺序：
1. 环境变量 `WEACPX_CLI_COMMAND`
2. `WEACPX_DAEMON_ARG0` + 当前 Node 可执行文件
3. `process.argv[1]` + 当前 Node 可执行文件
4. `xacpx`

若 xacpx 不是通过标准 CLI 或守护进程方式启动，请显式设置 `WEACPX_CLI_COMMAND`：

```bash
WEACPX_CLI_COMMAND="node /path/to/xacpx/dist/cli.js" xacpx run
```

## 代理

已注册的代理映射表。键为代理名称，用于 `/agent add`、`/session new --agent` 等命令。

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `driver` | `string` | 是 | 代理驱动类型；作为第一个位置参数传给 `acpx` |
| `command` | `string` | 否 | 自定义代理的原始命令；内置驱动不推荐使用 |

内置模板（仅需设置 `driver`，由 `acpx` 解析别名）：

| 模板 | Driver |
|------|--------|
| `codex` | `"codex"` |
| `claude` | `"claude"` |
| `pi` | `"pi"` |
| `openclaw` | `"openclaw"` |
| `gemini` | `"gemini"` |
| `cursor` | `"cursor"` |
| `copilot` | `"copilot"` |
| `droid` | `"droid"` |
| `factory-droid` | `"factory-droid"` |
| `factorydroid` | `"factorydroid"` |
| `grok-build` | `"grok-build"` |
| `iflow` | `"iflow"` |
| `kilocode` | `"kilocode"` |
| `kimi` | `"kimi"` |
| `kiro` | `"kiro"` |
| `mux` | `"mux"` |
| `omp` | `"omp"` |
| `opencode` | `"opencode"` |
| `qoder` | `"qoder"` |
| `qwen` | `"qwen"` |
| `reasonix` | `"reasonix"` |
| `trae` | `"trae"` |

通过聊天使用 `/agent add <name>` 添加模板，或在终端使用 `xacpx agent add <name>` 添加。添加配置完全相同的代理是幂等的；若名称冲突但配置不同，会提示先删除现有代理。

```json
{
  "agents": {
    "codex": { "driver": "codex" },
    "claude": { "driver": "claude" },
    "kimi": { "driver": "kimi" },
    "my-agent": { "driver": "custom", "command": "/usr/local/bin/my-agent" }
  }
}
```

## 工作区

已注册的工作区映射表。键为工作区名称，用于 `/workspace new`、`/session new --ws` 等命令。

首次运行时会自动创建 `home` 工作区（`cwd: "~"`）；可使用 `xacpx workspace rm home` 删除。

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `cwd` | `string` | 是 | 工作区路径；以 `acpx --cwd` 形式传入；支持 `~` 展开 |
| `description` | `string` | 否 | 在 `/workspaces` 输出中显示的描述 |

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

## 频道

`channels` 数组列出需要启动的消息频道运行时。

在终端管理频道：

```bash
xacpx channel list
xacpx channel add feishu
xacpx channel disable weixin
xacpx restart
```

### `ChannelRuntimeConfig` 字段

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `id` | `string` | 是 | 唯一频道标识符；须与 `type` 匹配（内置：`"weixin"`；插件：`"feishu"`、`"yuanbao"` 等） |
| `type` | `string` | 是 | 频道类型。内置：`"weixin"`。`"feishu"` 来自 `@ganglion/xacpx-channel-feishu`；`"yuanbao"` 来自 `@ganglion/xacpx-channel-yuanbao` |
| `enabled` | `boolean` | 否 | 频道是否激活（默认：`true`） |
| `options` | `object` | 视情况而定 | 频道专属配置（见下文） |

### 飞书频道选项

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `options.appId` | `string` | 单 Bot 模式必填 | 飞书 App ID |
| `options.appSecret` | `string` | 单 Bot 模式必填 | 飞书 App Secret |
| `options.domain` | `"feishu"` \| `"lark"` | 否 | API 域名（默认：`"feishu"`） |
| `options.requireMention` | `boolean` | 否 | 群聊中是否需要 @提及（默认：`true`） |
| `options.textMessageFormat` | `"text"` | 否 | 消息发送格式；目前仅支持 `"text"` |
| `options.dedupTtlMs` | `number` | 否 | 消息去重 TTL（毫秒，默认：`43200000`，即 12 小时） |
| `options.dedupMaxEntries` | `number` | 否 | 去重缓存最大条目数（默认：`5000`） |
| `options.defaultAccount` | `string` | 否 | 多 Bot 模式的默认账号 ID；回退顺序：`"default"` → 第一个条目 |
| `options.accounts` | `object` | 否 | 按 `accountId` 索引的账号级覆盖；每个条目可覆盖 `appId`、`appSecret`、`domain`、`requireMention`、`dmPolicy`、`groupPolicy`、`allowFrom`、`enabled`、`name` |
| `options.dmPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 否 | 私聊准入策略（默认：`"open"`） |
| `options.groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 否 | 群聊准入策略（默认：`"open"`）；`requireMention` 独立生效 |
| `options.allowFrom` | `string[]` | 否 | 发送者 `open_id` 白名单；当任一策略为 `"allowlist"` 时生效 |
| `options.replyMode` | `"static"` \| `"streaming"` \| `"auto"` | 否 | 回复渲染模式；默认 `"auto"`（私聊 → streaming，群聊 → static）。`"streaming"` 使用 CardKit v2 交互卡片实时更新（思考 → 流式 → 完成/中止/错误，含实时页脚计时器、推理折叠、详细模式下可折叠的工具调用面板、Markdown 图片 URL → image_key 解析、字符级流式传输）。需要机器人权限 `cardkit:card:write` + `im:message:send_as_bot`；首次卡片创建失败时回退到 `static` 并记录 `feishu.streaming.fallback`。可通过 `options.accounts.<id>.replyMode` 按账号覆盖 |

### 元宝频道选项

由 `@ganglion/xacpx-channel-yuanbao` 提供。使用 `xacpx plugin add @ganglion/xacpx-channel-yuanbao` 安装，然后添加频道。

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `options.appKey` | `string` | 与 `appSecret` 一起必填 | 元宝机器人 App Key |
| `options.appSecret` | `string` | 与 `appKey` 一起必填 | 元宝机器人 App Secret |
| `options.token` | `string` | 否 | 静态 token；也接受 `appKey:appSecret` 形式（加载时拆分）。真正的静态认证 token 还需要 `botId` |
| `options.botId` | `string` | 否 | 用于 @提及识别和自身消息过滤的机器人账号 ID；通常由 sign-token 返回并自动填充 |
| `options.apiDomain` | `string` | 否 | 元宝 API 域名（默认：`"bot.yuanbao.tencent.com"`） |
| `options.wsUrl` | `string` | 否 | 元宝 WebSocket URL（默认：`"wss://bot-wss.yuanbao.tencent.com/wss/connection"`） |
| `options.requireMention` | `boolean` | 否 | 群聊中是否需要 @提及（默认：`true`） |
| `options.replyToMode` | `"off"` \| `"first"` \| `"all"` | 否 | 引用回复策略（默认：`"first"`） |
| `options.overflowPolicy` | `"stop"` \| `"split"` | 否 | 长输出溢出策略（默认：`"split"`） |
| `options.maxChars` | `number` | 否 | 出站文本的字符数拆分阈值（默认：`3000`） |
| `options.mediaMaxMb` | `number` | 否 | 最大媒体文件大小（MB，默认：`20`） |
| `options.fallbackReply` | `string` | 否 | 代理无文本输出时发送的文本 |
| `options.accounts` | `object` | 否 | 账号级覆盖；条目继承顶层配置 |

### 微信扩展配置（`openclaw.json`）

内置 `weixin` 频道的 `options` 是空对象。附加的微信字段从 `~/.xacpx/state/openclaw.json` 读取（可通过 `OPENCLAW_CONFIG` 覆盖路径）。该文件独立于 `~/.xacpx/config.json`。

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

| 字段 | 类型 | 是否必填 | 说明 |
|------|------|----------|------|
| `routeTag` | `string` \| `number` | 否 | 写入 `SKRouteTag` 请求头，用于后端路由或 A/B 测试；账号级配置优先 |
| `botAgent` | `string` | 否 | 写入 `base_info.bot_agent` 的客户端标识；语法为 `name/version[ (comment)]`；截断至 256 字节；为空时回退为 `xacpx`；账号级配置优先 |
| `accounts.<id>` | `object` | 否 | `routeTag` 和 `botAgent` 的账号级覆盖 |

### 向后兼容性

- 旧的单频道配置 `channel.type` 仍可加载，并自动映射为单条 `channels[]` 记录。
- 旧的顶层 `feishu` 对象仍作为遗留别名被识别；新配置应使用 `options`。
- `wechat.replyMode` 在加载时仍会映射到 `channel.replyMode`。

## 权限

`/pm`（或 `/permission`）命令在聊天中暴露以下配置值：

| `/pm` 命令 | 配置值 | 效果 |
|-----------|--------|------|
| `/pm set allow` | `transport.permissionMode: "approve-all"` | 更多操作自动批准 |
| `/pm set read` | `transport.permissionMode: "approve-reads"` | 读取自动批准；写入更为谨慎 |
| `/pm set deny` | `transport.permissionMode: "deny-all"` | 拒绝需要审批的操作 |
| `/pm auto deny` | `transport.nonInteractivePermissions: "deny"` | 非交互式场景自动拒绝 |
| `/pm auto fail` | `transport.nonInteractivePermissions: "fail"` | 非交互式场景立即失败 |

## 默认值

### 日志

| 字段 | 默认值 |
|------|--------|
| `logging.level` | `"info"` |
| `logging.maxSizeBytes` | `2097152`（2 MB） |
| `logging.maxFiles` | `5` |
| `logging.retentionDays` | `7` |
| `logging.perf.enabled` | `false` |
| `logging.perf.maxSizeBytes` | `5242880`（5 MB） |
| `logging.perf.maxFiles` | `3` |
| `logging.perf.retentionDays` | `7` |

`logging.perf` 追踪器在 `buildApp()` 时绑定；修改后需重启守护进程。目前仅内置微信频道写入性能追踪数据；即使启用该选项，其他频道也不会发出回合记录。

### 回复模式

`channel.replyMode` 默认为 `"verbose"`。使用 `/replymode` 设置会话级覆盖；使用 `/replymode reset` 清除覆盖。

### 定时任务

`later.defaultMode` 默认为 `"temp"`（在临时会话中执行）。设置为 `"bind"` 可在创建任务的会话中执行。

### 编排

| 字段 | 默认值 |
|------|--------|
| `orchestration.maxPendingAgentRequestsPerCoordinator` | `3` |
| `orchestration.allowWorkerChainedRequests` | `false` |
| `orchestration.allowedAgentRequestTargets` | `[]`（无限制） |
| `orchestration.allowedAgentRequestRoles` | `[]`（无限制） |
| `orchestration.progressHeartbeatSeconds` | `300`（非有限值时回退为 `300`） |
| `orchestration.maxParallelTasksPerAgent` | `3` |

## 示例

### 完整示例

```json
{
  "language": "zh",
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
    "codex": { "driver": "codex" },
    "claude": { "driver": "claude" }
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

### 仅微信

```json
{
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true }
  ]
}
```

### 微信 + 飞书

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

### 元宝（需要 `@ganglion/xacpx-channel-yuanbao`）

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

### 更严格的编排限制

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
