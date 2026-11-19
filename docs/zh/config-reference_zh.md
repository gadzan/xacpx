# xacpx 配置参考

`~/.xacpx/config.json` 是 xacpx 的主配置文件。

会话成员并发是 Topic 元数据，不是本文件中的守护进程级设置。通过 Control/Relay 创建 Topic 时可附带可选的 `maxConcurrentMemberTurns`（整数 1–64）；不填则保持现有调度。该限制仅在 Phase 10A 的创建时生效。它只限制成员的物理执行，不赋予文件系统并行能力。详见 [会话运行时](../conversation-runtime.md#topic-execution-concurrency-phase-10a)。

Phase 10C 的 `worktree-per-member` 同样是 Topic 元数据。它要求一个干净的已注册 Git root，并使用托管的成员目录；没有任意路径覆盖。通过 Control/Relay 显式执行 preview/integration/recovery/cleanup 需要 `files.writeEnabled: true`。agent 权限与 Phase 10B 效果策略保持独立。详见 [托管 worktree](../conversation-runtime.md#managed-worktrees-and-explicit-integration-phase-10c)。

如果你想管理微信/飞书消息频道，请看 [`docs/channel-management.md`](./channel-management_zh.md)。如果你想在聊天里直接修改一部分配置，而不是手改 JSON，请看 [`docs/config-command.md`](./config-command_zh.md)。

## 完整示例

```json
{
  "language": "zh",
  "transport": {
    "type": "acpx-bridge",
    "command": "acpx",
    "sessionInitTimeoutMs": 120000,
    "permissionMode": "approve-all",
    "nonInteractivePermissions": "deny",
    "queueOwnerTtlSeconds": 1800,
    "adapterRegistry": "https://registry.npmjs.org/",
    "adapterVersions": {
      "codex": "2.2.2",
      "claude": "0.107.2"
    }
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

## `language`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `language` | `"en"` \| `"zh"` | 否 | 选择 xacpx 运行时输出（聊天回复、CLI 输出、编排提示词等）的语言；缺省时按系统 locale 推断：先看 `$LC_ALL`/`$LC_MESSAGES`/`$LANG`，再回退到系统 locale（`zh*` → 中文，否则英文）；可用 `/config set language en` 修改；改后需 `xacpx restart` 生效 |

> **Windows 提示**：`cmd.exe`/PowerShell 默认不设置 `LANG` 等 POSIX 环境变量，自动探测改为读取系统 locale（经 `Intl`，可识别中文 Windows）。若自动结果不准，显式设置最可靠：`/config set language zh`。

---

## `transport`

与 acpx 后端的通信方式。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `"acpx-cli"` \| `"acpx-bridge"` | 否 | 通信方式，缺省 `"acpx-bridge"`。详见下方说明 |
| `command` | `string` | 否 | 显式指定 acpx 二进制路径。不填则按优先级自动查找。自定义命令对普通请求仍然可用，但无法提供 Conversation 强制只读证明 |
| `sessionInitTimeoutMs` | `number` | 否 | session 初始化超时时间（毫秒），默认 `120000`（2分钟） |
| `permissionMode` | `"approve-all"` \| `"approve-reads"` \| `"deny-all"` | 否 | 权限模式，默认 `"approve-all"` |
| `nonInteractivePermissions` | `"deny"` \| `"fail"` | 否 | 非交互场景权限策略，默认 `"deny"` |
| `permissionPolicy` | `string` | 否 | acpx permission policy 文件路径（透传为 `acpx --permission-policy <value>`）；不填则不启用 |
| `queueOwnerTtlSeconds` | `number` | 否 | acpx queue owner 空闲存活时长（秒），透传为 prompt 命令的 `acpx --ttl <value>`。默认 `1800`（30 分钟）；`0` = 永久存活。详见下方“减少 agent 冷启动”说明 |
| `turnIdleTimeoutSeconds` | `number` | 否 | 正在执行的 agent 回合的空闲看门狗。若一个回合在这么多秒内没有产生任何流式 agent 活动（output/tool/thought/usage/plan/command 事件），就会被中止并报告为 `Turn timed out due to inactivity`，回收其占用的执行槽位。计时器会在每次流式事件时重置，因此耗时较长但持续活跃工作的回合不受影响——**但如果某次工具调用在整个窗口期内都保持静默（例如 `sleep`、没有中间输出的长时间编译/clone），仍会触发超时**；存在长时间静默操作的场景，请调大该值或设为 `0`。默认 `600`（10 分钟）；`0` 禁用该看门狗。每次回收都会记录一条 `control.turn.idle_timeout` 日志（含会话与具体阈值）便于排查 |
| `preferLocalAgents` | `boolean` | 否 | 当 PATH 上存在本地安装的原生 agent CLI 时，优先用它而不是 acpx 的 `npx -y <pkg>` 回退（当前为 `opencode`、`kilocode`，以及本地回退 driver `reasonix` 和 `omp`——它们不在 acpx 注册表里，但通过 `<bin> acp` 说 ACP）。避免每次冷启动时去 npm registry 拉取——更快，也不受网络抖动影响（例如 agent 初始化时的 `ECONNRESET`）。默认 `true`；设为 `false` 则始终使用 acpx 的默认解析。单个 agent 的 `command` 覆盖仍然优先 |
| `adapterVersions` | `{ "codex"?: string, "claude"?: string }` | 否 | xacpx 托管的 ACP adapter 的本地精确版本覆盖。取值必须是精确 semver 版本，不能是范围或 tag。未填的条目使用 xacpx 测试过的默认值（本版本为 `codex` `2.2.2`、`claude` `0.107.2`）。建议用下方的 `xacpx adapter` CLI，而不是手改这个对象 |
| `adapterRegistry` | `string` | 否 | 仅用于 xacpx 托管的 Codex/Claude adapter 的 npm registry。默认 `https://registry.npmjs.org/`，且**不**继承机器/公司的 npm 默认值。用 `xacpx adapter registry set <url>` 修改；只接受不带凭据的 HTTP(S) URL |
| `acpxMaxIncomingMessageBytes` | `number` \| `null` | 否 | 高级：覆盖 acpx 0.15.1+ 对 agent → acpx 入站 ACP 消息的默认 64 MiB 上限。适用于 CLI queue-owner 通道和 Runtime worker 通道（宿主进程 env，绝不是 agent env）。`null`/不填遵循上游；`0` 禁用该限制（不推荐）。修改后需要回收热的 queue owner / Runtime worker |
| `acpxTerminalMaxOutputBytes` | `number` \| `null` | 否 | 高级：对保留的终端 stdout+stderr 字节数的宿主上限。`null`/不填遵循上游行为。通道覆盖范围与回收要求同上 |

### 托管 ACP adapter 版本

Conversation 强制只读还额外要求内置的 acpx 0.22.0 执行器、托管的 Claude ACP 0.78.0 和默认 registry。显式的 `transport.command`、PATH 回退，以及未知或不同的内置执行器版本，都会在 Run 被接受前拒绝只读策略。0.22.0 执行器由 vendored 的 native-SDK 兼容运行（`tests/compat/conversation-read-only.test.ts`）背书，CI 在 Linux 和 macOS 上把关。普通请求保留现有的命令解析与执行行为。

xacpx 默认不把 Codex 或 Claude adapter 作为包依赖安装。对这两个 driver，它通常会把一条精确的 `npx -y --registry=<registry> <package>@<version>` 命令传给 acpx。用户可以用 `xacpx adapter preinstall <codex|claude> [version]` 选择启用一个不可变的本地 release；验证通过的 active 本地 release 会取代生成的 npx 命令。解析优先级为：

1. 显式的 `agents.<name>.command`（完全由用户管理）
2. `transport.adapterVersions.<driver>`
3. 本 xacpx 版本测试并随附的精确版本

用 `xacpx adapter list` 查看本地生效版本，`xacpx adapter check` 与 npm 比对，`xacpx adapter update <name>`（或 `--all`）选择启用更新的版本。`set` 和 `update` 会先确认精确包版本已发布并完成一次真实的 ACP `initialize` 探测；只有探测成功才会改配置。adapter 版本变更需要 `xacpx restart`。xacpx 绝不会在 daemon 启动时自动更新这些 pin。

预安装的 release 位于 `~/.xacpx/adapters/<driver>/releases/` 下；`active.json` 只有在安装、包含性检查、静态校验和 ACP initialize 探测全部成功后才会原子发布。`xacpx adapter list --installed` 可以查看它们。`xacpx adapter uninstall <driver> <release-id>` 拒绝删除 active release 或被 state 引用的 release，在 Windows 上还包括持久的 intent/owner/residual 记录。引用读取是 fail-closed 的，并在删除前紧邻重复执行。

所有 adapter 版本查询、发布检查、校验下载和运行时 `npx` 启动都使用生效的 `adapterRegistry`。默认始终是公共 npm registry；xacpx 会显式覆盖 npm 的通用 registry 以及任何针对 `@agentclientprotocol` scope 的 `.npmrc` 映射。当公司 registry 代理该 scope 时，可以显式选用它：

```bash
xacpx adapter registry
xacpx adapter registry set https://npm.company.example/repository/npm-group/
xacpx adapter registry reset   # return to https://registry.npmjs.org/
```

registry URL 不得包含凭据；registry 范围的认证请在 npm 常规的 `.npmrc` 里配置。修改 registry 后重启 daemon。

### `type` 可选值

#### `"acpx-cli"`

直接在当前进程里 spawn acpx 子进程，每次操作（prompt/cancel/ensureSession）都启动一个新进程，执行完退出。内部使用 `node-pty` 分配 PTY。

适合：本地开发、调试场景。

#### `"acpx-bridge"`（默认）

启动一个独立的 bridge 子进程（`bridge-main.ts`），acpx 在里面常驻运行。所有操作通过 stdin/stdout JSON 协议以 RPC 方式发送，acpx 进程不会每次命令都重启。

适合：生产环境、更稳定的长时间运行。

### `command` 解析优先级

解析顺序（从高到低）：

1. `transport.command` —— 显式覆盖，直接胜出。
2. **内置的 `acpx` 依赖** —— xacpx 自己的 `node_modules/acpx`（pin 到精确版本，当前 `0.22.0`；无 caret），通过 `require.resolve("acpx/package.json")` 解析。
3. shell `PATH` 中的 `acpx` —— 不存在内置依赖时的回退。

显式指定 `command` 会完全跳过第 2、3 层。注意第 2 层是*内置依赖*，而不是任意的“当前项目”安装：不同或未知的内置版本在版本敏感的契约场景（例如只读强制）下仍然 fail closed。

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

1. `XACPX_CLI_COMMAND`（旧名 `WEACPX_CLI_COMMAND` 仍作为回退生效）
2. `XACPX_DAEMON_ARG0` + 当前 Node 可执行文件（旧名 `WEACPX_DAEMON_ARG0` 回退）
3. 当前进程入口 `process.argv[1]` + 当前 Node 可执行文件
4. `xacpx`

如果 xacpx 不是通过标准 CLI/daemon 启动，或路径需要特殊包装，可以显式设置 `XACPX_CLI_COMMAND`，例如：

```bash
XACPX_CLI_COMMAND="node /path/to/xacpx/dist/cli.js" xacpx run
```

---

## Tool-event 路由

### Tool-event 模式（`toolEventMode`）

`PromptOptions.toolEventMode` 控制单次 prompt 如何呈现 `tool_call` / `tool_call_update` 事件：

- `"text"` —— 传统的 emoji 前缀分段，折叠进回复文本流。
- `"structured"` —— 事件只进入 `onToolEvent` 回调。
- `"both"` —— 事件同时进入 `onToolEvent` 和传统文本分段。便于迁移或调试。

不填时，传输层会在边界处推断模式：提供了 `onToolEvent` 处理函数时为 `"structured"`，否则为 `"text"`。这保留了现有每个频道（微信、元宝、飞书 static、飞书 streaming card）当前依赖的行为。

**`onToolEvent` 的异步语义：** 传输层按事件顺序调用回调，并在派发下一个事件前 await 每次调用。prompt 完成会等待所有在途回调 settle。处理函数出错会使 prompt 以第一个观察到的错误 reject。

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
- 这个配置是**全局默认值**；频道可以通过 `channels[].replyMode` 覆盖它，会话可以通过 `/replymode` 覆盖两者。优先级：会话覆盖 → `channels[].replyMode` → `channel.replyMode` → `verbose`
- 可以通过 `/replymode` 为**当前逻辑会话**设置覆盖值
- `/replymode reset` 会清除当前会话覆盖，若设置了频道默认值（`channels[].replyMode`）则回退到它，否则回退到 `channel.replyMode`
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
| `id` | `string` | 是 | 频道唯一标识（必须非空且在 `channels[]` 中唯一；唯一内置频道是 `"weixin"`；插件注册的类型如 `"feishu"`、`"yuanbao"`、`"discord"`、`"relay"`）。核心不要求 `id === type` —— 这个相等性是各插件自己的约定（元宝 provider 对自己强制这一点）；飞书/Discord 等多账号插件每个账号使用不同的 id |
| `type` | `string` | 是 | 频道类型。内置频道类型只有 `"weixin"`。`"feishu"` 由 `@ganglion/xacpx-channel-feishu` 提供，`"yuanbao"` 由 `@ganglion/xacpx-channel-yuanbao` 提供；其它类型由已安装插件提供 |
| `enabled` | `boolean` | 否 | 是否启用。默认 `true` |
| `replyMode` | `"stream"` \| `"final"` \| `"verbose"` | 否 | 按频道的默认回复模式。设置后会覆盖该频道的全局 `channel.replyMode`；不填时该频道回退到 `channel.replyMode`。按会话的 `/replymode` 覆盖仍然优先于它。 |
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
| `options.trustGroupOwner` | `boolean` | 否 | 可选的群主命令鉴权。为 `true` 时，插件会查询飞书群主（GET `/im/v1/chats/{chat_id}`，缓存 5 分钟，10 秒超时；需要 `im:chat:readonly` scope），并对发送者即群主的群聊回合断言 `isOwner`，从而让 owner 门槛的控制类命令（`/use`、`/session new`、会话内 `scheduled_*` 工具，...）无需把发送者列进 [`channel.ownerIds`](#channelownerids) 也能使用。每个群聊回合都会记录一个显式的 owner 布尔值（非 owner、功能关闭、查询失败都记 `isOwner: false`），因此成员回合会覆盖此前 owner 回合在持久路由上的状态，而不是继承它。**只在你控制谁能把该 bot 拉进群时启用**：任何建群并把 bot 加进去的人就是群主，控制类命令以操作者权限执行；已被转让的 owner 在 5 分钟缓存过期前仍保留命令权限。失败或无群主的查询会短路缓存 30 秒，避免 scope 配错时每条群消息都付出一次 REST 请求。默认 `false` |

对于绑定 Conversation 的飞书群消息，`trustGroupOwner` 在准入时只使用未过期的 owner 缓存条目。缓存未命中时 adapter 提供 `isOwner: false`；共享的 `channel.ownerIds` / `channels[].ownerIds` 策略仍会参与最终的持久 owner 标记。入站被接受时不等 REST；接受后的后台刷新可以授权后续回合，但绝不能授权已接受的回合。普通 Session 和控制类命令路径保留上述的等待式查询。

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

### Relay 频道配置（`options`，由 `@ganglion/xacpx-channel-relay` 提供）

Relay 连接器由 `@ganglion/xacpx-channel-relay` 提供。安装插件，然后添加频道：

```bash
xacpx plugin add @ganglion/xacpx-channel-relay
xacpx channel add relay --url <hub-host> --token <access-token>
xacpx restart
```

长期实例凭据存放在 `<xacpx-home>/relay/credential.json`（模式 `0600`），**不**在 `config.json` 里。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options.url` | `string` | 是 | Hub URL。裸域名 → `wss://`；不带端口的 IPv4/`localhost`/方括号 IPv6 → `ws://…:8787`；`http(s)://` 会被改写为 `ws(s)://`。 |
| `options.pairingToken` | `string` | 是（首次配对） | 首次连接时使用的 access / pairing token。凭据交换后它可以留在配置里，但只要 `credential.json` 有效就不会再发送。 |
| `options.name` | `string` | 否 | 在 hub 上显示的实例显示名。 |
| `options.terminal` | `object` | 否 | 可选的 RMUX 终端后端。**缺省不填 / 默认关闭** —— 启用后允许能登录 hub 的人在会话工作区里打开交互式 shell。 |
| `options.desktop` | `object` | 否 | 可选的实例桌面（RFB/VNC）后端。**缺省不填 / 默认关闭** —— 启用后会对外 advertise `desktop.rfb.v1`，并允许能登录 hub 的人通过 relay-web 观看/控制实例的本地图形桌面。 |

#### `options.terminal`（对象存在或被解析时即应用默认值）

| 字段 | 类型 | 默认 | 范围 / 说明 |
|------|------|------|------|
| `enabled` | `boolean` | `false` | 总开关。为 `false` 时不 advertise 能力，残留的 registry 记录仍会在 bootstrap / 频道 disable-remove 时退役。 |
| `backend` | `"rmux"` | `"rmux"` | 只接受 `"rmux"`。 |
| `idleTimeoutSeconds` | `number` | `900` | `60..86400`。这么久没有查看者输入 → 持久化回收。独立于 owner lease / attachment TTL。 |
| `ownerLeaseTtlSeconds` | `number` | `90` | `15..600`。连接器/sidecar 死亡后 RMUX `KillOnOwnerExit` 孤儿的硬崩溃清理 TTL。**不是**重启收养窗口 —— 优雅停止会杀掉会话；新进程从不收养。 |
| `reconcileIntervalSeconds` | `number` | `30` | `5..300`。周期性 mark-and-sweep 间隔。 |
| `orphanGraceSeconds` | `number` | `max(120, ownerLeaseTtlSeconds)` | `ownerLeaseTtlSeconds..3600`。仅清点式的隔离老化，之后才 kill。 |
| `attachmentTtlSeconds` | `number` | `45` | `15..300`。hub/浏览器附着的存活（心跳）；过期只会 detach 查看者，**不会**杀掉 shell。 |
| `maxSessions` | `number` | `16` | `1..128` 并发存活/创建中的终端资源数。 |
| `maxViewersPerTerminal` | `number` | `4` | `1..16` 每个共享终端的附着数。 |
| `historyLimit` | `number` | `10000` | `0..100000` RMUX 回滚 / 恢复关键帧预算（行）。 |
| `bridgeCommand` / `rmuxCommand` | 绝对路径 | 未设置 | 可选的显式二进制（设置后两者始终优先）。未设置时，bridge 先通过 `@ganglion/xacpx-rmux-bridge-<os>-<arch>` 可选包、再通过 `PATH` 解析。平台包同时 ship **bridge 和 pin 住的 RMUX 运行时**（`bin/rmux[.exe]` + `libexec/rmux/rmux[.exe]`，`RMUX_VERSION=0.10.0` 与 bridge 的 `rmux-sdk` pin 匹配），因此生产解析顺序是：所选 bridge 旁边的内置 RMUX（source `platform-package`）→ 遗留的托管 helper `~/.local/libexec/rmux/rmux[.exe]`（source `managed-helper`）→ `PATH` 上的 `rmux-daemon` / `rmux`（source `path`）。机器本地 PATH 或 `~/.local/libexec/rmux` 里过时的 RMUX 永远不会盖过内置的那个（Windows 现场 bug：WinGet rmux 0.9.0 vs bridge rmux-sdk 0.10.0）；`xacpx doctor` 会报告选中的 source 以及期望版本与实际版本。 |

**安全**：启用终端等同于授予每个能打开该实例的 hub 账号在工作区里一个交互式 shell。终端字节从不写入消息 DB 或应用日志（只记录 ID / 大小 / 错误类别）。

#### `options.desktop`（对象存在或被解析时即应用默认值）

| 字段 | 类型 | 默认 | 范围 / 说明 |
|------|------|------|------|
| `enabled` | `boolean` | `false` | 总开关。为 `false` 时不 advertise 任何桌面能力，也不创建流状态。 |
| `backend` | `"rfb"` | `"rfb"` | 只接受 `"rfb"`（Phase A）。Windows RDP 不是后端。 |
| `port` | `number` | `5900` | `1..65535`。连接器拨号的 loopback RFB 端口。目标主机固定为 `127.0.0.1` 且不可配置 —— `host`/`hostname`/`target` 键会被拒绝。 |
| `connectTimeoutMs` | `number` | `1500` | `250..10000`。loopback RFB 探测/连接超时。 |
| `maxStreams` | `number` | `1` | 必须为 `1`（v1 每实例单查看者）。 |
| `diagnostics` | `boolean` | `false` | 可选的按隧道转发统计：隧道关闭时输出一行 `relay.desktop.tunnel_stats` info 日志（双向字节数、ws `bufferedAmount` 峰值、TCP/ws 暂停次数与累计暂停毫秒数）。只有数字和 streamId；绝不包含 payload、ticket 或凭据。 |

**安全**：启用桌面会把实例的图形桌面（键盘 + 鼠标）暴露给能登录 hub 的人。VNC server 必须在 `127.0.0.1:<port>` 上可达。外层 VncAuth 和 macOS Screen Sharing（Apple Remote Desktop，由连接器终止）被接受。未认证（`None`）、仅 Tight、仅 VeNCrypt/TLS 和专有认证都被拒绝。loopback 目标是单边的：它固定连接器拨号的位置，而不固定 server 绑定的位置。外部可达性是部署要求 —— 对 Windows TightVNC 而言，这意味着 loopback-only 访问控制加防火墙，因为 `0.0.0.0` 绑定配 loopback-only 访问控制仍然会拒绝外部连接。见 `docs/desktop-rfb-setup.md` §3 和设计文档 §5.1。VNC 密码在 relay-web 里按标签页输入，只保存在标签页内存中 —— 绝不进入 RelayEnvelope、ticket、日志或存储。ticket 一次性使用，TTL 60 秒，并绑定账号 + 实例 + 侧别；帧缓冲字节走独立的二进制 WebSocket（`/desktop/observe` + `/desktop/instance`），绝不经过控制平面。

**安装 / 排查**：[`desktop-rfb-setup.md`](../desktop-rfb-setup.md) —— 各平台 VNC server 配置（TightVNC / TigerVNC / x11vnc / WayVNC）、锁屏与 UAC 限制，以及打开时的错误码表。

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

`plugins[]` 是安装在 `~/.xacpx/plugins` 下的包的生命周期元数据。它本身不会启用频道；`channels[]` 仍然控制启动哪些频道运行时。在 daemon 运行期间更改插件的安装、更新、启用、禁用或移除状态后，请重启 daemon 以重新加载插件注册。

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
| `command` | `string` | 否 | 显式指定自定义 agent 的原始命令。优先级最高，包括高于 xacpx 托管的 Codex/Claude adapter pin。与 `argv` 互斥；Windows 上新建多 token `command` 无法无损启动，请改用 `argv`（见下）。历史 session 的 `transport_agent_command` 会原样作为 acpx `--agent` selector 传递；acpx 0.13 从旧 record 回填 built-in argv，不支持的 custom raw 仍由 acpx fail closed |
| `argv` | `string[]` | 否 | 精确的可执行文件 + 参数边界（如 `["C:\\Program Files\\agent.exe", "--acp", ...]`）。首元素必须是非空可执行文件；每个元素原样传给 acpx（空格、反斜杠、空字符串均保留）。与 `command` 互斥；这是 Windows 上唯一无损的启动形式。修改 `argv` 会产生新的 acpx session identity（内容寻址 alias）；旧 session 保留其记录的 identity |
| `model` | `string` | 否 | 该 agent 会话的默认 LLM 模型 id（如 `gpt-5.2[high]`），作为 `--model` 传给 acpx。会话级模型（`/session new --model` 或 `/model`）会覆盖它。不填时使用 agent adapter 的默认值 |
| `modelCandidates` | `string[]` | 否 | 在 Relay Web 中作为建议展示的可选模型 id。它们未经 adapter 验证。修改 `command`、`argv` 或托管 adapter pin 会使能力缓存失效，因为启动 identity 变了。不要在这个列表里放 secret 或 adapter 命令 |
| `settingsPolicy` | `"provider-only"` \| `"isolated"` \| `"full-user"` | 否 | Claude 用户设置策略。隐式默认值为 `"provider-only"`；其它 driver 忽略该字段。详见下方 |

冷模型枚举走单一的 inspector 接缝：`src/transport/acpx-model-inspector.ts` 是 `acpx/runtime` 的 `inspectAgentModels`（75 秒超时）的唯一封装，它**不创建 session、也不需要用户 prompt** 就能读取 adapter 的模型目录 —— xacpx 在上游解析 agent argv，只把快照映射到 `AgentCapabilityProbeResult`。`control.agents.capabilities.get` 会读取一个 owned runtime、已保存的模型列表或普通会话，并可以运行该探测（显式刷新总是重新探测）。无法认证或无法枚举模型的探测会返回该状态。它不会凭空编造 Claude 或 Codex 的目录。

已验证的模型列表持久化在 `state.json` 可再生的 `capability_lists` 段中，键为 agent + 工作区 cwd + 启动 identity（adapter pin/command/argv）+ 认证材料，因此 daemon 重启后仍然显示该列表。改动其中任何一个键都会得到不同的键：旧列表绝不会被新的 adapter pin 复用。显式的 "Fetch model list"（`probe: true`）总是重新探测，而不是重放已保存的列表；该刷新失败时仍会返回已保存的列表，但 state 会带一个 `reason` 标记它未经新鲜验证。损坏或格式错误的缓存条目在加载时被丢弃，绝不会阻塞启动。

#### Windows raw command 迁移

新建多 token 的 `agents.<name>.command` 在 Windows 上仍会被拒绝（xacpx 在配置解析阶段就拒绝，使新会话总是拿到结构化的 `argv`）。请把这些 agent 改成结构化 argv：

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

单 token 的配置 `command`（无空格，如 `"myagent.exe"`）只有**无损**时才会自动转换为 `["myagent.exe"]` —— 单个元素必须能用 canonical identity renderer 精确还原为原始命令。identity-safe charset 之外的 token（带反斜杠的 Windows 路径、引号等）会渲染成 JSON-quoted，写下去会 re-key acpx record，所以这类配置会被拒绝，直到改成 `argv`。

已记录原始 `transport_agent_command` 的历史 session 不同：xacpx 会原样把该字符串作为 acpx `--agent` **selector** 传递（不拆分、不猜测 argv）。acpx 0.13 会找到旧 session record，当命令在其迁移表中时回填 built-in `agent_argv`，并对无法 spawn 的 custom raw 历史 fail closed。这条路径不需要任何 `xacpx-managed-*` overlay 或启动状态迁移。

#### xacpx 托管的 acpx agent alias

结构化启动（托管 Codex/Claude pin、hermes shim、本地 fallback、用户 `argv`）通过内容寻址位置参数 alias（`xacpx-managed-<driver>-<sha256-prefix>`）暴露给 acpx。启动时 xacpx 在 proper-lockfile 保护下把 `{ "argv": [...] }` 安全合并进 `~/.acpx/config.json` 的 `agents` 节点，保留其它所有 key 与用户 agent 条目。绝不写 `.acpxrc.json`；已存在但 argv 不同的 alias 拒绝覆盖（fail closed）；不自动清理旧 alias（旧 session/旧 pin 可能仍引用）。升级不会删除或 close 任何已有 session；旧 session record 缺少 `agent_argv` 时，仅当 record 的 `agent_command` 与目标 argv 的 canonical identity 完全一致才回填，并复用同一 record id 恢复。

### Claude 第三方 provider 设置

acpx 默认把内置 Claude 会话与 Claude **用户**设置隔离。xacpx 为只配置在 `~/.claude/settings.json`（或当前生效的 `CLAUDE_CONFIG_DIR`）中的第三方 provider 增加了一个更窄的兼容层。无需显式配置：`settingsPolicy` 隐式默认为 `"provider-only"`。

`"provider-only"` 只在 xacpx 于 daemon 环境或用户设置的 `env` 对象中发现第三方 provider 标记（`ANTHROPIC_BASE_URL` 或 `ANTHROPIC_AUTH_TOKEN`）时才会激活。此时它会：

- 只把用户设置中的 `ANTHROPIC_*` 条目导入该 Claude 会话的本地 acpx 进程环境；
- 把 `model` 映射为 `ANTHROPIC_MODEL`，并只通过托管 adapter 的 `CLAUDE_MODEL_CONFIG` 接缝传递 `modelOverrides` 和 `availableModels`；
- 保持 project/local Claude 设置启用，从而保留它们正常的优先级；
- 排除用户 hooks、plugins、skills、MCP servers 和 permissions；
- 给 adapter 一个过滤后的 settings profile，同时把 Claude 的持久 session-state 目录链回原 profile，使原生 list/resume 和 transcript 持久化继续使用既有历史；Claude 自管的运行时目录（如 `session-env` 和 `shell-snapshots`）保留在过滤后的 profile 本地，因为 Claude 可能在回合中重新创建它们；
- 绝不把 provider 凭据写入 xacpx 配置/state、磁盘或 bridge 协议。

普通的一方 Claude OAuth 和仅 `ANTHROPIC_API_KEY` 的设置不会触发该兼容层，保留现有行为。

每个 Claude agent 有两个显式覆盖可用：

```json
{
  "agents": {
    "claude": {
      "driver": "claude",
      "settingsPolicy": "isolated"
    }
  }
}
```

- `"isolated"`：完全隐藏用户设置，包括 provider/model 字段。
- `"full-user"`：选择使用原始的完整用户设置。这可以在 daemon 上下文中执行全局配置的 hooks/plugins，因此只在有意如此时使用。

daemon 级的 `ANTHROPIC_*` 值覆盖从用户设置提取的值。显式的会话模型仍然覆盖 agent 模型，后者再覆盖 provider/默认模型选择。不要用字面模型 id `default` 代替缺失的 provider 设置；它是一个模型选择，不是 provider 配置来源。

用 daemon 将要使用的同一 agent/workspace 路径验证：

```bash
xacpx doctor --smoke --agent claude --workspace <workspace> --verbose
```

说明：

- 内置模板只写 `driver` 即可；xacpx 会 pin Codex/Claude adapter，其它 driver 走正常的 runtime/acpx 解析路径
- `agent.command` 主要用于自定义 agent，不建议给内置 driver 手写原始命令
- 旧版 `codex` shim 命令在加载时会被自动忽略，回退为 xacpx 当前的托管 Codex adapter pin

### 内置模板

通过微信发送 `/agent add <name>`，或在终端运行 `xacpx agent add <name>` 时使用以下内置模板；终端也可以用 `xacpx agent templates` 查看模板列表。添加已存在且配置相同的 agent 是幂等操作；如果同名 agent 已有不同配置，命令会提示先删除，不会静默覆盖自定义配置。

| 模板名 | driver | command |
|--------|--------|---------|
| `codex` | `"codex"` | 无（使用 xacpx 托管 pin） |
| `claude` | `"claude"` | 无（使用 xacpx 托管 pin） |
| `ante` | `"ante"` | 无（使用 acpx 默认；实验性 —— 需要单独的 `ante-acp` adapter，且 acpx 在断开后不会重开其会话） |
| `pi` | `"pi"` | 无（使用 acpx 默认） |
| `openclaw` | `"openclaw"` | 无（使用 acpx 默认） |
| `gemini` | `"gemini"` | 无（使用 acpx 默认） |
| `cursor` | `"cursor"` | 无（使用 acpx 默认） |
| `copilot` | `"copilot"` | 无（使用 acpx 默认） |
| `droid` | `"droid"` | 无（使用 acpx 默认） |
| `deepseek-harness` | `"deepseek-harness"` | 无（使用 acpx 默认） |
| `factory-droid` | `"factory-droid"` | 无（使用 acpx 默认） |
| `factorydroid` | `"factorydroid"` | 无（使用 acpx 默认） |
| `grok-build` | `"grok-build"` | 无（使用 acpx 默认） |
| `goose` | `"goose"` | 无（使用 acpx 默认） |
| `hermes` | `"hermes"` | 无（使用 xacpx 内置 shim） |
| `iflow` | `"iflow"` | 无（使用 acpx 默认） |
| `kilocode` | `"kilocode"` | 无（使用 acpx 默认） |
| `kimi` | `"kimi"` | 无（使用 acpx 默认） |
| `kiro` | `"kiro"` | 无（使用 acpx 默认） |
| `mcode` | `"mcode"` | 无（使用 acpx 默认） |
| `mux` | `"mux"` | 无（使用 acpx 默认） |
| `octomind` | `"octomind"` | 无（使用 acpx 默认） |
| `omp` | `"omp"` | 无（PATH 上有 `omp` 时使用 `omp acp`；acpx 不列出此 driver） |
| `opencode` | `"opencode"` | 无（使用 acpx 默认） |
| `pool` | `"pool"` | 无（使用 acpx 默认） |
| `qoder` | `"qoder"` | 无（使用 acpx 默认） |
| `qwen` | `"qwen"` | 无（使用 acpx 默认） |
| `reasonix` | `"reasonix"` | 无（PATH 上有 `reasonix` 时使用 `reasonix acp`；acpx 不列出此 driver） |
| `trae` | `"trae"` | 无（使用 acpx 默认） |
| `zeroclaw` | `"zeroclaw"` | 无（使用 acpx 默认） |

`hermes` 不在 acpx 的内置注册表中，因此 xacpx 会在 spawn 时提供其启动命令：一个随包分发的 stdio shim（`dist/adapters/hermes-acp-shim.js`），它运行 `hermes acp` 并从 initialize 响应中剥离 advertise 的 `sessionCapabilities.resume`。这绕过了 hermes-agent 每次 `session/resume` 都重放完整 transcript 的缺陷（[NousResearch/hermes-agent#32201](https://github.com/NousResearch/hermes-agent/issues/32201)），强制 acpx 走带重放保护的 `session/load` 路径；shim 命令在运行时解析，绝不写入 `config.json`。它需要本机安装 [Hermes Agent](https://hermes-agent.nousresearch.com/) 及其 ACP 额外组件（`uv pip install -e '.[acp]'`），并在 `~/.hermes/` 下配置好 provider 凭据。显式设置 `agents.<name>.command`（字面值 `hermes acp` 除外，它被视为模板默认值）会绕过 shim。注意 shim 命令内嵌了 node 可执行文件和 xacpx 安装路径，因此升级 node 或移动安装位置会改变 acpx 用于匹配会话记录的命令字符串 —— 此时 acpx 会为 hermes 新建后端会话记录，而不是复用旧记录。

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

新 Bot 默认使用由其 daemon 在 `~/.xacpx/bots/<workspace-name>/` 下创建的专用工作区。选择既有工作区时会使用该工作区。每个生成的目录都会以其路径、包含原 Bot 名称的描述和 `dedicated: true` 注册进 `workspaces`。专用工作区对该 Bot 私有：它从不出现在工作区选择器或列表中（dashboard、`/workspaces`、`xacpx workspace list`），其它 Bot、会话或群组 Topic 都无法选择它。删除 Bot（带删除工作区选项）会移除该目录及其注册。

编辑 Bot 的工作区也可能分配一个：dashboard 中既有 Bot 上的 "New workspace" 选项会让 daemon 创建并注册一个专用目录（以该 Bot 命名）并更新 profile。只有实例 advertise 了 `bots.dedicated-workspace-update.v1` 且该 Bot 尚未拥有专用工作区时才会提供该选项 —— 替换已有目录会使其注册失去 owner —— 否则请求会以 `dedicated_workspace_exists` 被拒绝。

从非空输入自动派生且不含可用 ASCII 字符的工作区名使用稳定的 `workspace-<8hex>` 回退。例如，中文目录基名不再统统变成 `workspace`，dashboard 也能从中文路径创建会话。既有的 ASCII 规范化保留；已占用的名字会收到 `-2`、`-3` 等后缀。目录路径保留其原始字符，既有注册名不迁移。

### Workspace 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | `string` | 是 | 工作区路径，acpx 的 `--cwd` 参数；支持以 `~` 开头，加载时展开为用户主目录 |
| `description` | `string` | 否 | 描述信息，供 `/workspaces` 命令展示用 |
| `dedicated` | `boolean` | 否 | 仅由 daemon 写入：`true` 标记 Bot 的私有工作区，对选择器隐藏，并在别处被显式指定为目标时拒绝。不要手写该字段。 |

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

## `files`

relay-web 文件浏览器的文件树操作配置。

### `files.writeEnabled`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `writeEnabled` | `boolean` | 否 | 启用或禁用 relay-web 中的文件写入和结构化 Git 变更。Git 变更包括 stage/unstage/commit、fetch、仅快进 pull、push、分支切换/创建、托管 worktree 创建，以及 Conversation worktree 的 preview/integration/recovery/cleanup。只读文件浏览/下载和 Git status 仍然可用。默认 `false`（禁用写入）。在 config.json 里写入该项会在 config watcher 上热应用，实例对话框的文件写入开关（`control.files.settings.update`）会立即应用它，无需重启 |

### 示例

```json
{
  "files": {
    "writeEnabled": true
  }
}
```

## `conversations.followupRedispatch`

多轮群组交接，默认开启。followup 唤醒可以派发新任务，一个 Run 的工作窗口会按 `max(8, shortage)` 续期（每个 `budgetEpoch` 审计一次），而不是在预算上失败；发送方的回归唤醒在派发时被预留；只有整个 Run 的等待图不再欠任何东西时，显式 Run 才完成。设为 `false` 可逐字节恢复 V2 之前的按批次范围行为。

```json
{
  "conversations": {
    "followupRedispatch": true
  }
}
```

---

## `conversations.router`

群组 Run 的自动协作。该段可选。不填，或 `enabled` 不为 `true`，功能即关闭。Relay Web 的实例管理对话框（会话标签页上的齿轮）是控制界面：它通过 `control.conversations.router.set` 翻转 `enabled`，没有 `command` 时由 daemon 自己补上，因此全新安装不需要操作者提供 router。`control.conversations.router.update` 为自带 router 的操作者补丁这三个字段中的任意一个。每个补丁只触及它点名的键，重新解析可用性，并热应用、无需重启，因此手编的 config.json 会保留所有不相关字段。手改文件继续可用，并在下次 daemon 启动（或下次写入）时被拾取。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | `boolean` | 否 | `true` 会在解析可用性时运行能力探测 —— 在 daemon 启动时以及每次翻转开关时。任何其它值都保持自动协作关闭 |
| `command` | `string` | 否 | 可执行文件。它必须能应答 `--capabilities` 并在任何 `--decide` 进程开始前退出。缺失时打开开关，daemon 会写入下方的内置默认 router |
| `authEnv` | `string` | 否 | 环境变量名。该变量在探测运行前必须非空。其值不写入日志 |

`--capabilities` 打印一个 JSON 对象。下面每个字段都必须为 `true`。

- `toolsDisabled`
- `filesystemDisabled`
- `terminalDisabled`
- `permissionInteractionDisabled`
- `messagingDisabled`
- `orchestrationDisabled`
- `structuredOutputOnly`

告诉模型不要用工具的 prompt 并不是这种证明。启动状态是 `disabled-by-config`、`unsupported`、`ready` 或 `failed` 之一。`unsupported` 表示报告未证明该限制。`failed` 表示命令缺失、auth 为空、探测失败、探测超时或报告无法读取。`xacpx doctor` 报告同样的状态。`ready` 和默认关闭状态通过。`unsupported` 警告。`failed` 使检查失败。

`control.conversations.router.get` 向 Relay Web 返回该可用性。`control.conversations.router.set` 翻转 `enabled` 并就地重新解析。`control.conversations.router.update` 补丁这三个字段中的任意一个，并返回可用性加已持久化的段，对话框由此可以显示已配置的内容，而不是给出一个空字段。

### 内置默认 router

配置了 Jev key 时，内置 router 每次决策最多做两次有限选择调用：先从持久结果中选择下一个动作，再选择一个启用的成员。它可以跨任务域进行调查、产出、验证、修订、回答、完成或请求人类输入。产出的工作在 "完成" 可用前需要验证最新的交付物；简单的回答不会强迫额外成员发言。动作置信度低于 0.6、未知动作或动作调用失败都会在有任何成员结果前回退为仅主控分析；其后的动作不确定性会暂停为 waiting-human。成员选择的不确定性保留一个有置信度的动作，并使用合格的 lead 或第一个候选，从而保留独立验证。重复的相同成员结果也会暂停。详见 [自动协作](../conversation-runtime.md#bundled-adaptive-collaboration)。

没有 key 时，自动协作解析为 failed / jev-not-configured，composer 将其隐藏。daemon 只通过环境把 Jev 设置传给 `--decide`（`XACPX_JEV_ENDPOINT`、`XACPX_JEV_API_KEY`、`XACPX_JEV_PROXY`、`XACPX_JEV_MODEL`），绝不通过 argv。下文描述的分发只作为无 key 代码路径保留。

### Jev 设置（`~/.xacpx/jev.json`）

不属于 config.json。与配置同目录以 0600 模式原子写入，通过 `control.jev.update`（Relay Web 实例对话框）编辑。键：`endpoint`（默认 `https://api.typesafe.ai/v1/systemone`）、`apiKey`（只以 `keyMasked` 形式上报）、`proxyUrl`（可选；为空时使用 daemon 的 `HTTPS_PROXY`/`https_proxy`）、`model`（pin 住的 `jev-1.13.0`）。`control.jev.test` 做一次真实调用，并把 451 映射为 `region-blocked`、401/403 映射为 `bad-key`。

- **代理选择。** 显式的 `proxyUrl` 优先于 `HTTPS_PROXY`/`https_proxy`；无论哪种方式，`NO_PROXY`/`no_proxy`（daemon 环境）对 endpoint 主机都生效，因此匹配的条目即使设置了显式 Jev 代理也会直接发送调用。匹配遵循 curl 约定：单独的 `*` 豁免一切；主机名匹配自身及其子域（按标签边界，`example.com`、`.example.com` 和 `*.example.com` 都匹配 `example.com` 和 `api.example.com`，绝不匹配 `badexample.com`）；IP 字面量（`10.0.0.1`、`::1`、`[::1]`）只匹配该地址，IP CIDR（`10.0.0.0/8`、`fd00::/8`）匹配其中的地址；可选的 `:port`（`example.com:8443`、`[::1]:8443`）把条目限制在目标的有效端口。条目以逗号和/或空白分隔；无法读取的条目被忽略。
- **线上 secret。** `proxyUrl` 上报时会把任何 `user:pass@` 替换为 `***@`，把该掩码值保存回去会保留已存储的凭据；把 `keyMasked` 预览作为 `apiKey` 保存回去同样会保留已存储的 key（任何其它看起来像掩码的值都会被拒绝）。每条 Jev 失败消息（网络错误、代理 CONNECT 拒绝、`http-error` 响应摘录、`control.jev.test` 结果、router 回退原因）都会把代理凭据和 API key 打码成 `***`。

打开开关且没有配置 `command` 时，会写入本仓库自己的 router `dist/conversations/default-router-main.js` 并对它探测。它是一个与任何操作者的 router 受同一契约约束的真实决策过程：它报告上述全部七项限制，`production-router.ts` 只在该报告被证明后才安装引擎，因此默认 router 是通过完全相同的证明赢得 `ready`，而不是特例。

遗留的无 key 策略会把请求向每个启用的成员分发一次，并行执行，然后完成。生产自动模式使用上述的自适应 Jev 策略。配置的自定义 command 始终优先，daemon 只在没有时才写入默认值。受限 router 绝不访问文件系统或工具；成员通过普通的持久执行器完成具体工作。

`unsupported` 状态仍然表示报告未证明该限制，`failed` 仍然表示命令缺失、auth 为空、探测失败、探测超时或报告无法读取。

### 示例

```json
{
  "conversations": {
    "router": {
      "enabled": false
    }
  }
}
```

---

## 环境变量覆盖

**前缀规则：**规范前缀是 `XACPX_`。下面每个读取方都优先 `XACPX_<SUFFIX>`，并回退到旧前缀 `WEACPX_<SUFFIX>`（后缀相同），因此旧设置继续可用；新设置应使用 `XACPX_`。没有 `WEACPX_WEIXIN_SDK` 覆盖 —— weixin-agent-sdk 入口从依赖解析，而不是从环境变量。

| 环境变量 | 说明 |
|----------|------|
| `XACPX_CONFIG`（旧名 `WEACPX_CONFIG`） | 配置文件路径（默认 `~/.xacpx/config.json`） |
| `XACPX_STATE`（旧名 `WEACPX_STATE`） | 状态文件路径（默认 `~/.xacpx/state.json`） |
| `XACPX_ILINK_APP_ID`（旧名 `WEACPX_ILINK_APP_ID`） | 微信频道出网请求所携带的 `iLink-App-Id` 头。留空时不发送该头（向后兼容） |
| `XACPX_PLUGIN_HOME`（旧名 `WEACPX_PLUGIN_HOME`） | 插件安装根目录（默认 `~/.xacpx/plugins`） |
| `XACPX_PLUGIN_REGISTRY`（旧名 `WEACPX_PLUGIN_REGISTRY`） | `xacpx plugin add/update` 使用的 npm registry（默认公共 npm，以免 bun/npm 继承会 404 `@ganglion/*` 可选包的公司镜像；必须是合法的 http(s) URL） |
| `XACPX_CLI_COMMAND` / `XACPX_DAEMON_ARG0`（旧名 `WEACPX_*`） | 用于编排 MCP 注入的显式 xacpx 命令，见 [`transport`](#transport) 的 "orchestration MCP 自动注入" |
| `XACPX_ORCHESTRATION_SOCKET`（旧名 `WEACPX_ORCHESTRATION_SOCKET`） | 编排 IPC socket 路径覆盖 |
| `XACPX_BRIDGE_*`（旧名 `WEACPX_BRIDGE_*`） | bridge/runtime 内部：`ACPX_COMMAND`、`AGENT_OVERLAYS`、`STATE_DIR`、`RUNTIME_DURABLE_DIR`、`RUNTIME_QUEUE_DIR`、`RUNTIME_FENCE_DIR`、`SESSION_INIT_TIMEOUT_MS`、`GENERATION_FILE`、`ELICITATION_FORM_CAPABLE`、`PERMISSION_INTERACTION_CAPABLE` |

核心也会用规范名（`XACPX_DAEMON_RUN` 等）写自己的子进程 env；读取方仍然两种前缀都能解析。

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
