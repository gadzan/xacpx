# 消息频道管理

xacpx 可以同时启动多个消息频道。目前内置：

- `weixin`：微信频道，使用扫码登录。

插件提供：

- `feishu`：飞书频道，由 `@ganglion/xacpx-channel-feishu` 提供，使用飞书自建应用的 `App ID` / `App Secret`。
- `yuanbao`：元宝频道，由 `@ganglion/xacpx-channel-yuanbao` 提供，使用 `appKey` / `appSecret`，内置元宝签名与 WebSocket gateway。

日常用户只需要看 README 的快速步骤；这份文档记录更完整的频道管理命令、飞书配置和排错。

---

## 基本概念

频道配置写在 `~/.xacpx/config.json` 的 `channels[]` 里。推荐用 CLI 管理，不手改 JSON：

```bash
xacpx channel list
xacpx channel show <type>
xacpx channel add <type>
xacpx channel rm <type>
xacpx channel enable <type>
xacpx channel disable <type>
```

`channel` 可以简写为 `ch`：

```bash
xacpx ch list
xacpx ch show feishu
```

当前限制：同一种频道类型只能配置一个实例，所以频道 `id` 必须等于 `type`，例如 `weixin`、`feishu`、`yuanbao`。

`channel rm <type>` 在删除频道的同时会**清除该频道的存储凭证**（例如 relay 实例凭证 `~/.xacpx/relay/credential.json`，或微信登录态），这样以后重新添加会干净地重新配对/登录，而不是悄悄复用一份遗留的旧凭证。若只想删配置、保留已存凭证（例如临时禁用某频道又不想重新认证），加 `--keep-credentials`。

---

## 微信频道

微信仍然使用原来的扫码模型：

```bash
xacpx login
xacpx start
```

退出微信登录：

```bash
xacpx logout
```

注意：`login` 和 `logout` 只操作微信，不会登录或退出飞书。

如果配置里没有显式 `channels[]`，xacpx 会按旧配置自动生成一个启用的微信频道。

---

## 飞书频道

### 1. 准备飞书应用

你需要一个飞书自建应用，并拿到：

- `App ID`
- `App Secret`

通常还需要：

- 启用机器人能力。
- 把机器人添加到你要使用的单聊或群聊。
- 让应用具备接收消息、发送消息所需权限，并发布到可用范围。

飞书平台页面和权限名称可能会变化，以飞书开放平台当前界面为准。

### 2. 添加飞书频道

Feishu is provided by the first-party plugin package `@ganglion/xacpx-channel-feishu`. Install the plugin before adding the channel:

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu
```

推荐交互式输入，避免把 `appSecret` 留在 shell 历史里：

```bash
xacpx channel add feishu
```

按提示输入：

```text
Feishu appId:
Feishu appSecret:
```

也可以用参数一次性添加，适合脚本或临时环境：

```bash
xacpx channel add feishu \
  --app-id cli_xxx \
  --app-secret your_secret
```

可选参数：

```bash
xacpx channel add feishu \
  --app-id cli_xxx \
  --app-secret your_secret \
  --domain feishu \
  --require-mention true
```

说明：

- `--domain feishu`：默认值，适合飞书。
- `--domain lark`：适合 Lark。
- `--require-mention true`：群聊里默认需要 @机器人 才处理消息。
- `--require-mention false`：群聊中不要求 @机器人，谨慎使用。

### 3. 重启 daemon

频道配置变更后需要让后台进程重新加载配置：

```bash
xacpx restart
```

如果你只想使用飞书，建议先禁用微信频道，避免 daemon 启动时等待微信扫码：

```bash
xacpx channel disable weixin
xacpx restart
```

如果你想微信和飞书同时使用，请保留 `weixin` 启用，并先完成：

```bash
xacpx login
```

也可以在变更频道时直接加：

```bash
xacpx channel add feishu --restart
```

如果不想立即重启：

```bash
xacpx channel add feishu --no-restart
```

### 4. 在飞书里使用

把机器人加入会话后，在飞书里发送和微信相同的 xacpx 命令：

```text
/ss codex -d /absolute/path/to/your/repo
/help
```

之后直接发送普通文本即可进入当前会话。

---

## 元宝频道插件

元宝由一方插件包 `@ganglion/xacpx-channel-yuanbao` 提供（配置解析、元宝签名、WebSocket、消息收发、chatKey 路由、agent 调用、任务通知）。

```bash
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao --app-key <key> --app-secret <secret>
xacpx restart
```

如果已有配置里启用了 `type: "yuanbao"`，但还没安装插件，启动会提示：

```text
频道 yuanbao 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-yuanbao
```

可选参数：

```bash
xacpx channel add yuanbao \
  --app-key yb_xxx \
  --app-secret your_secret \
  --bot-id bot_123 \
  --require-mention true \
  --ws-url wss://bot-wss.yuanbao.tencent.com/wss/connection \
  --api-domain bot.yuanbao.tencent.com
```

### 元宝多 bot（同一频道多个账号）

元宝同样支持单频道多账号，CLI 用法和飞书完全对齐：

```bash
# 第一次添加 bot：会自动创建 yuanbao channel
xacpx channel add yuanbao --account main \
    --app-key yb_main --app-secret secret_main

# 再加一个 bot
xacpx channel add yuanbao --account ops \
    --app-key yb_ops --app-secret secret_ops --require-mention false

# 查看某个账号的解析后摘要（appSecret 始终脱敏）
xacpx channel show yuanbao --account main

# 临时下线 / 重新启用
xacpx channel disable yuanbao --account ops
xacpx channel enable  yuanbao --account ops

# 移除某个 bot；最后一个 *enabled* 账号被移除时整个 yuanbao channel 也会被删，
# 但只有"还有别的启用频道"时才会放行；剩余账号全 disabled 同样会被拦下。
xacpx channel rm yuanbao --account ops
```

升级路径与飞书一致：旧的扁平单 bot 配置在第一次 `xacpx channel add yuanbao --account <id> ...` 时会被自动迁移成 `accounts.default = {...旧的 per-bot 字段}` + 新账号。具体规则：

- **保留在顶层**（跨账号字段）：`gatewayModule` / `defaultAccount`。
- **会被嵌入 `accounts.default`**（per-bot 字段）：`appKey` / `appSecret` / `token` / `botId` / `apiDomain` / `wsUrl` / `requireMention` / `replyToMode` / `overflowPolicy` / `outboundQueueStrategy` / `minChars` / `maxChars` / `idleMs` / `mediaMaxMb` / `historyLimit` / `disableBlockStreaming` / `fallbackReply` / `markdownHintEnabled` / `debugBotIds`，以及任何不在顶层白名单里的其它字段。
- 同样会自动重新启用 `enabled: false` 的 channel。

chatKey 形如 `yuanbao:<accountId>:<chatType>:<target>`，其中 `chatType` 为 `direct` 或 `group`，`target` 是元宝侧的账号 / 群标识（例如 `yuanbao:main:direct:<peer>` 或 `yuanbao:ops:group:<groupId>`）。

> 当前限制：`channel add yuanbao --account <id>` 只暴露 `--app-key / --app-secret / --token / --bot-id / --api-domain / --ws-url / --require-mention / --max-chars / --idle-ms` 这些 flag；`replyToMode / overflowPolicy / outboundQueueStrategy / minChars / mediaMaxMb / historyLimit / disableBlockStreaming / fallbackReply / markdownHintEnabled / debugBotIds` 还需要手编 `accounts.<id>` 下面的 JSON。

> ⚠️ 改 `defaultAccount` 同样会让旧 chatKey 失去路由（state 里挂着 `yuanbao:default:...`）。若要切换 default，建议保留 `accounts.default` 别名。

---

## 查看和管理频道

查看所有频道：

```bash
xacpx channel list
```

查看某个频道详情：

```bash
xacpx channel show feishu
```

`appSecret` 会被显示为 `***`，不会原样打印。

禁用频道：

```bash
xacpx channel disable feishu
xacpx restart
```

重新启用频道：

```bash
xacpx channel enable feishu
xacpx restart
```

删除频道：

```bash
xacpx channel rm feishu
xacpx restart
```

xacpx 不允许删除或禁用最后一个启用的频道，避免 daemon 启动后没有任何消息入口。

---

## 配置文件形态

CLI 会写入 `channels[]`，类似：

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
        "appSecret": "your_secret",
        "domain": "feishu",
        "requireMention": true,
        "textMessageFormat": "text",
        "dedupTtlMs": 43200000,
        "dedupMaxEntries": 5000
      }
    }
  ]
}
```

`channel.replyMode` 仍然是全局默认回复模式；频道 CLI 不会通过修改 `channel.type` 来切换频道。

完整字段说明见：[docs/config-reference.md](./config-reference_zh.md)。

### 飞书多 bot（同一频道多个账号）

飞书频道支持在**一个 channel** 里挂多个 bot；每个 bot 用自己的 `appId/appSecret` 连飞书 WebSocket，入站消息按 bot 路由到 chatKey 前缀 `feishu:<accountId>:<chatId>`，互不干扰。

#### CLI 用法（推荐）

`xacpx channel add/rm/enable/disable/show feishu --account <id>` 支持多 bot 全流程，无需手编 `config.json`：

```bash
# 1) 第一次添加 bot：会自动创建 feishu channel
xacpx channel add feishu --account main \
    --app-id cli_main --app-secret secret_main

# 2) 再加一个 bot
xacpx channel add feishu --account ops \
    --app-id cli_ops --app-secret secret_ops --require-mention false

# 3) 看某个账号的解析后摘要（appSecret 始终脱敏）
xacpx channel show feishu --account ops

# 4) 临时下线某个 bot 而不删配置
xacpx channel disable feishu --account ops
xacpx channel enable  feishu --account ops

# 5) 移除某个 bot；最后一个 *enabled* 账号被移除时整个 feishu channel 也会被删，
#    但只有"还有别的启用频道"时才会放行；剩余账号全 disabled 同样会被拦下。
xacpx channel rm feishu --account ops
```

升级路径：如果 `~/.xacpx/config.json` 里已经有一个**扁平**的单 bot 配置（顶层直接写 `appId/appSecret`），第一次执行 `xacpx channel add feishu --account <id> ...` 时 CLI 会把旧配置自动迁移成 `accounts.default = {...旧的 per-bot 字段}`，并把新账号挂在 `accounts.<id>` 下。具体规则：

- **保留在顶层**（跨账号字段）：`textMessageFormat` / `dedupTtlMs` / `dedupMaxEntries` / `defaultAccount`。
- **会被嵌入 `accounts.default`**（per-bot 字段）：`appId` / `appSecret` / `domain` / `requireMention` / `dmPolicy` / `groupPolicy` / `allowFrom`，以及任何不在顶层白名单里的其它字段。
- 之前如果 channel 处于 `enabled: false`，`add --account` 会顺带把它重新置为 `enabled: true` 并打印一行提示，避免用户加完 bot 之后还以为已生效。

> 当前限制：`channel add feishu --account <id>` 暂不支持设置 `dmPolicy / groupPolicy / allowFrom`；这些字段仍需手编 `accounts.<id>` 下面的 JSON。后续可能会补 `--dm-policy / --group-policy / --allow-from` 标志。

#### 手编 config.json（备用）

把下面 JSON 写入 `~/.xacpx/config.json`，改完执行 `xacpx restart`：

```jsonc
{
  "channels": [{
    "id": "feishu",
    "type": "feishu",
    "enabled": true,
    "options": {
      "defaultAccount": "main",
      "domain": "feishu",
      "requireMention": true,
      "accounts": {
        "main":   { "appId": "cli_main",   "appSecret": "secret_main" },
        "review": { "appId": "cli_review", "appSecret": "secret_review", "requireMention": false }
      }
    }
  }]
}
```

字段说明：

- `accounts` 是按 `accountId` 索引的对象，**不是**数组。
- 顶层的 `domain / requireMention / appId / appSecret` 作为各账号的默认值；每个 `accounts.<id>` 可以覆盖这些字段。
- `defaultAccount` 选定缺省账号；省略时会优先用 `default`，否则用第一个 `accounts.<id>`。
- 至少要有一个 `enabled !== false` 且同时配齐 `appId/appSecret` 的账号，否则 daemon 启动时会拒绝该 channel。
- 不允许通过新增 `channels[]` 实例（`{ "id": "feishu-review", "type": "feishu" }`）实现多 bot —— 该形态当前仍被 `id === type` 校验拒绝。

排错时一律用 `xacpx channel show feishu` 看每个账号是否被识别（`appSecret` 仍然脱敏为 `***`）。

> ⚠️ **改 `defaultAccount` 会让旧 chatKey 失去路由**：state 文件里的会话保存的是 chatKey 前缀（如 `feishu:default:oc_xxx`）。如果你把 `defaultAccount` 从 `default` 改成别的值且**没**保留同名的 `accounts.default`，旧会话会因为 `feishu account "default" is not started` 而无法收发。两条出路：
>
> - 保留 `accounts.default`（推荐，零迁移）：`defaultAccount` 怎么改都行，只要 `accounts.default` 始终存在。
> - 重新 attach 旧会话到新 accountId 的 chatKey 前缀，或直接清掉旧会话 state 重新开始。

### 飞书 DM/群 准入策略

为避免把对外的飞书机器人裸暴露给陌生人，飞书账号支持基于发送者 `open_id` 的准入策略。默认 `open` 等价于历史行为（任何人都能发消息），只有显式切到 `allowlist` 或 `disabled` 才会收紧。配置在每个账号上独立生效，多 bot 时可以一个 bot 全开、另一个 bot 仅供 ops 使用。

```jsonc
{
  "channels": [{
    "id": "feishu",
    "type": "feishu",
    "enabled": true,
    "options": {
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "appId": "cli_main",
          "appSecret": "secret_main",
          "dmPolicy": "open",
          "groupPolicy": "open"
        },
        "ops": {
          "appId": "cli_ops",
          "appSecret": "secret_ops",
          "dmPolicy": "allowlist",
          "groupPolicy": "allowlist",
          "allowFrom": ["ou_admin1", "ou_admin2"]
        }
      }
    }
  }]
}
```

字段语义：

- `dmPolicy`：私聊准入。`open`（默认）=放行；`allowlist`=只接受 `allowFrom` 列表里的发送者；`disabled`=全部丢弃。
- `groupPolicy`：群聊准入，语义同上。`requireMention` 仍然独立生效——必须先通过 policy，再判定 mention。
- `allowFrom`：发送者 `open_id` 数组，仅 `allowlist` 模式下生效。包含 `"*"` 表示"任何带 `open_id` 的发送者"（仍能挡掉 `open_id` 缺失的事件）。
- 任一 policy 是 `allowlist` 时 `allowFrom` 不能为空，否则 daemon 启动会拒绝该 channel。

**被策略拒绝的消息**：xacpx 静默丢弃（不回复"无权限"），仅在 `~/.xacpx/runtime/app.log` 里以 `feishu.message.policy_denied` 记录 `accountId/messageId/chatType/senderOpenId/reason`，方便事后审计。Reason 取值：`dm_disabled`、`group_disabled`、`sender_not_allowlisted`、`missing_sender_id`。

---

## 密钥安全

当前版本会把飞书/元宝 `appSecret` 保存在本机 `~/.xacpx/config.json` 中。

建议：

- 优先使用交互式 `xacpx channel add feishu` / `xacpx channel add yuanbao` 输入密钥。
- 避免在共享终端、CI 日志或 shell 历史里直接写 `--app-secret`。
- 不要把真实 `config.json` 提交到 Git。

---

## 常见问题

### 添加飞书后没有生效

先确认是否重启了 daemon：

```bash
xacpx restart
xacpx status
```

再看频道是否启用：

```bash
xacpx channel list
xacpx channel show feishu
```

### 群聊里发消息没有响应

如果 `requireMention` 是 `true`，群聊消息需要 @机器人。你可以确认配置：

```bash
xacpx channel show feishu
```

如果确实想让群聊不 @ 也响应，可以删除后重新添加：

```bash
xacpx channel rm feishu --no-restart
xacpx channel add feishu --require-mention false
xacpx restart
```

### `channel add feishu` 提示缺少参数

非交互环境不会弹出输入提示，需要显式传参数：

```bash
xacpx channel add feishu --app-id cli_xxx --app-secret your_secret
```

### 已存在的频道配置不同

同一种频道类型目前只能有一个实例。如果要更换飞书应用，先删除再添加：

```bash
xacpx channel rm feishu
xacpx channel add feishu
xacpx restart
```

---

## 插件管理

非微信频道（飞书、元宝、第三方）以 npm 插件方式分发。两个层次：

- **插件**（`plugin`）：管理 npm 包本身的安装、升级、卸载、启用 / 禁用。
- **频道**（`channel`）：管理 `~/.xacpx/config.json` 里的 `channels[]`，决定 daemon 启动哪些频道。

先装插件，再加频道；先 `channel rm`，再 `plugin remove`。

### 插件存放在哪

- 默认目录：`~/.xacpx/plugins/`，里面有一个独立的 `package.json` + `node_modules/`，**不污染**全局或当前项目。
- 自定义：导出环境变量 `WEACPX_PLUGIN_HOME=/some/path`，所有 `xacpx plugin *` 命令都会切到这个目录。
- 包管理器自动选择：检测到 `bun` 就用 `bun add/remove`，否则回退到 `npm install/uninstall`。

### 安装

```bash
# 从 npm 装最新版本
xacpx plugin add @ganglion/xacpx-channel-feishu

# 从 npm 装指定版本
xacpx plugin add @ganglion/xacpx-channel-feishu --version 0.2.1

# 从本地路径装（开发自家插件、调试 fork 时常用）
xacpx plugin add ./packages/channel-my
xacpx plugin add /absolute/path/to/plugin-dir
```

参数：

| 参数 | 含义 |
| --- | --- |
| `--version <semver>` | 锁定版本；写入 `~/.xacpx/config.json` 的 `plugins[].version`。 |
| `--restart` | 安装后立即重启 daemon。 |
| `--no-restart` | 不重启；变更下次 `xacpx restart` 后生效。 |
| 默认（什么都不传） | 在交互终端里询问"现在重启？"；非交互环境里默认不重启。 |

安装时 xacpx 会立刻 `import()` 一次新装的包跑校验：`apiVersion === 1`、`name` 与包名一致、`type` 字段非空且不含 `:`、单插件内 `type` 不重复、`factory` 存在。校验失败会**立刻报错**，不会写 config，方便回滚。

> **跨插件 `type` 冲突**（A 插件与 B 插件都声明同一个 `type`）不在安装时发现——它依赖另一插件已被 import 才能比较。冲突会在 `xacpx plugin doctor` 或 daemon 启动时由 `registerChannelPlugin` 抛出来。安装新插件后**强烈建议**先 `xacpx plugin doctor`。

### 升级

```bash
# 升级单个插件到 npm registry 的最新版本
xacpx plugin update @ganglion/xacpx-channel-feishu

# 锁定到指定版本
xacpx plugin update @ganglion/xacpx-channel-feishu --version 0.3.0

# 一次升级所有已配置插件
xacpx plugin update --all
```

参数：

| 参数 | 含义 |
| --- | --- |
| `--version <semver>` | 拉指定版本，并写回 `plugins[].version`。 |
| `--all` | 升级所有 `plugins[]` 里的项。**不能**和 `--version` 同时使用。 |
| `--restart` / `--no-restart` | 同 `add`。 |

升级流程内部：先 `bun add <pkg>[@<ver>]` / `npm install <pkg>[@<ver>]`，再重新 import + validate；校验失败会报错且**不会**改 config 里的版本号——你的 daemon 重启时仍按旧版本运行（前提：旧版本仍在 node_modules 里；如果包管理器已经覆盖到新版本，你可以再 `xacpx plugin update <pkg> --version <旧版本>` 显式回滚）。

> ⚠️ 升级**只**改磁盘。运行中的 daemon 已经把旧代码 import 进内存，必须 `xacpx restart` 才能加载新版本。

### 列出与查看

```bash
xacpx plugin list
# 输出：
# 插件：
# - @ganglion/xacpx-channel-feishu@0.2.1 (enabled)
# - @ganglion/xacpx-channel-yuanbao (enabled)
```

`@<version>` 仅在用 `--version` 锁定过的项目上显示；空版本表示跟随 npm 最新。当前没有 `plugin show` 子命令，详细信息看 `~/.xacpx/config.json` 的 `plugins[]` 数组。

### 启用 / 禁用

```bash
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx plugin enable @ganglion/xacpx-channel-feishu
```

`disable` 不卸载包，只把 `plugins[].enabled` 设为 `false`。下次 daemon 启动会跳过 import，对应频道的 `channel add` 也会失败提示插件未启用。

适合临时排查：怀疑某个插件造成异常时先 `disable + restart` 看 daemon 是否正常，不用真的卸载。

### 卸载

```bash
xacpx plugin remove @ganglion/xacpx-channel-feishu
# 或简写：
xacpx plugin rm @ganglion/xacpx-channel-feishu
```

会从 plugin home 里把 npm 包卸了（`bun remove` / `npm uninstall`），同时把 `plugins[]` 里的项删除。

> ⚠️ 卸载插件**之前**应该先 `xacpx channel rm <type>`，否则 daemon 重启时会因为找不到提供方而报 `channel X is configured but no enabled plugin provides it`。

### 健康检查

```bash
xacpx plugin doctor                # 检查所有插件
xacpx plugin doctor @scope/xxx     # 只检查一个
```

输出每条 issue 的等级（`OK` / `WARN` / `ERROR`）和提示。常见情形：

| 情形 | 等级 | 含义 / 行动 |
| --- | --- | --- |
| `package not installed in plugin home` | ERROR | 配置里有但 npm 包没装。重 `xacpx plugin add`。 |
| `failed to import plugin: ...` | ERROR | 装上了但 import 失败。看错误栈，多半是依赖错版或缺 dist。 |
| `unsupported plugin apiVersion` | ERROR | 插件 API 与 xacpx 不匹配。等插件作者升级，或暂时 `disable`。 |
| `channel type X is already provided by ...` | ERROR | 两个插件抢同一类型。`disable` 其中一个。 |
| `channel X is configured but no enabled plugin provides it` | ERROR | `channels[]` 配了但 plugin 没装/没 enable。`plugin add` 或 `plugin enable`。 |
| `installed and valid but disabled` | WARN | 已装但禁用了。`plugin enable` 或保持。 |
| `provider plugin is disabled` | ERROR | 频道还在但提供方插件被禁——daemon 启动时会失败。`plugin enable` 或先 `channel disable`。 |
| `installed and valid; channels: feishu` | OK | 健康。 |

升级 / 安装新插件后**强烈建议**先 `xacpx plugin doctor` 再 `xacpx restart`，避免 daemon 起来后才发现配置坏掉。

### 完整生命周期一览

```bash
# 1. 装
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx channel add feishu        # 会按提示输入凭据
xacpx restart

# 2. 升级
xacpx plugin update @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx restart

# 3. 临时禁用
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx restart

# 4. 卸载
xacpx channel rm feishu
xacpx plugin remove @ganglion/xacpx-channel-feishu
xacpx restart
```

### 常见问题

**`xacpx plugin update --all` 跑过之后 daemon 启动失败怎么办？**

最常见是新版本插件改了 options 校验或字段。先 `xacpx plugin doctor` 看 ERROR 行；如果是某个具体插件的 import 失败，可以单独把它降级回老版本：

```bash
xacpx plugin update @ganglion/xacpx-channel-feishu --version 0.1.0
xacpx restart
```

**手工改了 `~/.xacpx/plugins/node_modules/...` 后 xacpx 没察觉？**

xacpx 不会去监听文件变化，重启 daemon 才会重新 import。`xacpx plugin update` / `add` / `remove` 都会顺带把 `~/.xacpx/plugins/package.json` 的 `dependencies` 改对，如果你绕过 xacpx 直接动 node_modules，下次 `xacpx plugin doctor` 大概率会报 `package not installed in plugin home`。建议都通过 xacpx CLI 走。

**装本地路径插件后改了源码，daemon 看不到改动？**

`xacpx plugin add ./path` 把本地路径作为 npm dependency 解析（bun add `./path` 创建一个 link，npm install 复制一份）。改完源码后：

- 用 bun：通常已经是 symlink，重新跑 `bun run build` 后 `xacpx restart` 即可。
- 用 npm：需要重跑 `xacpx plugin add ./path` 让 npm install 重新复制。

详细的插件开发、打包、发版指南见 [`docs/plugin-development.md`](./plugin-development_zh.md)。
