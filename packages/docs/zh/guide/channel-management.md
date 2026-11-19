# 频道管理

## 概述

xacpx 可以同时运行多个聊天频道。每个频道接收来自不同平台的消息，并将其路由到你的 Agent 会话。频道配置保存在 `~/.xacpx/config.json` 的 `channels[]` 数组中。建议使用 CLI 管理频道——直接编辑 JSON 虽然支持，但不推荐用于日常操作。

## 内置频道与插件频道

**内置频道：**

- `weixin` — 微信频道，通过扫描二维码进行认证。

**插件提供的频道：**

- `feishu` — 由 `@ganglion/xacpx-channel-feishu` 提供。使用飞书自建应用的 App ID 和 App Secret 进行配置。详见[飞书频道](/zh/plugins/feishu)。
- `yuanbao` — 由 `@ganglion/xacpx-channel-yuanbao` 提供。使用 `appKey` 和 `appSecret` 配置，内置元宝请求签名和 WebSocket 网关。详见[元宝频道](/zh/plugins/yuanbao)。
- `discord` — 由 `@ganglion/xacpx-channel-discord` 提供。使用 Discord **Bot Token** 与 Gateway 配置；机器人是安装进服务器的，而非扫码配对。详见[Discord 频道](/zh/plugins/discord)。

第三方频道可以作为外部 npm 插件包进行分发。

## 频道标识

xacpx 目前每种频道类型只允许一个实例。频道的 `id` 必须与 `type` 相同——例如 `weixin`、`feishu`、`yuanbao` 或 `discord`。配置同类型的两个实例（如 `{ "id": "feishu-review", "type": "feishu" }`）会在启动时被拒绝。

如需在单一频道类型中运行多个机器人，请使用下文所述的多账号（`--account`）功能。

## 添加频道

### 微信

微信使用现有的二维码登录方式：

```bash
xacpx login    # 显示二维码；使用微信移动端扫描
xacpx start
```

如果配置中不存在 `channels[]`，xacpx 会自动根据旧版配置键生成一个已启用的微信频道。

仅退出微信登录：

```bash
xacpx logout
```

`login` 和 `logout` 仅影响微信，不会与飞书或元宝的凭据产生交互。

### 飞书

飞书由插件包 `@ganglion/xacpx-channel-feishu` 提供。先安装插件，再添加频道：

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu
```

建议使用交互式提示，以避免 `appSecret` 遗留在 Shell 历史中：

```text
Feishu appId:
Feishu appSecret:
```

在脚本化或非交互式环境中，可直接传入标志：

```bash
xacpx channel add feishu \
  --app-id cli_xxx \
  --app-secret your_secret \
  --domain feishu \
  --require-mention true
```

标志参考：

| 标志 | 可选值 | 默认值 | 说明 |
|---|---|---|---|
| `--domain` | `feishu` \| `lark` | `feishu` | 国内版飞书填 `feishu`，海外版 Lark 填 `lark`。 |
| `--require-mention` | `true` \| `false` | `true` | 为 `true` 时，群消息需要 @-提及机器人，xacpx 才会处理。设为 `false` 则处理所有群消息（请谨慎使用）。 |

**飞书应用前提条件：**
- 启用机器人能力。
- 将机器人添加到目标单聊或群组。
- 授予应用发送和接收消息的权限，并将其发布给相应受众。

### 元宝

元宝由插件包 `@ganglion/xacpx-channel-yuanbao` 提供：

```bash
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao --app-key <key> --app-secret <secret>
xacpx restart
```

可选标志：

```bash
xacpx channel add yuanbao \
  --app-key yb_xxx \
  --app-secret your_secret \
  --bot-id bot_123 \
  --require-mention true \
  --ws-url wss://bot-wss.yuanbao.tencent.com/wss/connection \
  --api-domain bot.yuanbao.tencent.com
```

如果配置中存在 `type: "yuanbao"` 条目但插件未安装，守护进程会打印：

```text
Channel yuanbao requires a plugin: xacpx plugin add @ganglion/xacpx-channel-yuanbao
```

### Discord

Discord 由插件包 `@ganglion/xacpx-channel-discord` 提供。与微信（扫码登录）或飞书/元宝（平台凭据配对）不同，Discord **没有登录/配对流程**：在 Discord Developer Portal 创建机器人，把它的 **Bot Token** 填进 xacpx，再把机器人邀请进服务器即可。插件为每个 token 保持一条 Gateway 连接。

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord        # token 通过保密提示输入
xacpx restart
```

两个容易漏的点：必须在 Portal 里打开 **Message Content Intent**（否则 Discord 会以 `4014` 关闭 Gateway）；访问控制比对的是 **snowflake ID**，因此在设置 `--dm-policy` / `--guild-policy` 前请先开启开发者模式并复制你的用户 ID。不要给机器人授予 Administrator。完整行为参考见包 README（`packages/channel-discord/README.md`），端到端流程见仓库中的 `docs/channel-management.md`。

## 列出频道

```bash
xacpx channel list
```

查看指定频道的详情（密钥始终脱敏显示为 `***`）：

```bash
xacpx channel show feishu
```

`channel` 命令可缩写为 `ch`：

```bash
xacpx ch list
xacpx ch show feishu
```

## 更新频道设置

要修改频道的凭据或选项，请先删除再重新添加：

```bash
xacpx channel rm feishu
xacpx channel add feishu --app-id cli_new --app-secret new_secret
xacpx restart
```

### 多账号（飞书）

单个 `feishu` 频道可以托管多个机器人，每个机器人有独立的 App ID 和 App Secret。消息按机器人路由。ChatKey 格式为 `feishu:<accountId>:<chatId>`。

```bash
# 添加第一个机器人（自动创建 feishu 频道）
xacpx channel add feishu --account main \
    --app-id cli_main --app-secret secret_main

# 添加第二个机器人
xacpx channel add feishu --account ops \
    --app-id cli_ops --app-secret secret_ops --require-mention false

# 查看某账号详情（appSecret 已脱敏）
xacpx channel show feishu --account ops

# 暂时下线某机器人但不删除
xacpx channel disable feishu --account ops
xacpx channel enable  feishu --account ops

# 删除某机器人；删除最后一个已启用账号时，整个 feishu 频道随之删除
# （仅当还有其他已启用频道时允许此操作）
xacpx channel rm feishu --account ops
```

**从单机器人配置迁移：** 首次执行 `xacpx channel add feishu --account <id>` 时，系统会自动将扁平的 `appId/appSecret` 配置迁移到 `accounts.default = {...旧的单机器人字段}` 结构，并在其旁添加新账号。

保留在顶层（跨账号共享）的字段：`textMessageFormat`、`dedupTtlMs`、`dedupMaxEntries`、`defaultAccount`。

迁移到 `accounts.default` 中的字段：`appId`、`appSecret`、`domain`、`requireMention`、`dmPolicy`、`groupPolicy`、`allowFrom` 以及所有未识别的字段。

> **修改 `defaultAccount` 会破坏现有的 chatKey。** 状态记录中保存了如 `feishu:default:oc_xxx` 这样的 chatKey 前缀。如果你在重命名默认账号时没有保留 `accounts.default` 别名，现有会话将报错"feishu account 'default' is not started"。建议：始终保留 `accounts.default` 作为稳定别名。

**手动 JSON 等效配置：**

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

**单聊/群组接入策略（飞书）：**

要限制机器人接受哪些发送者，可以按账号配置 `dmPolicy` 和 `groupPolicy`。默认值（`open`）与历史行为一致——接受任意发送者。

```jsonc
{
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
```

| 字段 | 可选值 | 说明 |
|---|---|---|
| `dmPolicy` | `open`（默认）、`allowlist`、`disabled` | 单聊接入策略。`allowlist` 只接受 `allowFrom` 中的发送者。`disabled` 丢弃所有单聊消息。 |
| `groupPolicy` | `open`（默认）、`allowlist`、`disabled` | 群组接入策略。策略通过后，`requireMention` 仍独立生效。 |
| `allowFrom` | `open_id` 字符串数组 | 当策略为 `allowlist` 时生效。`"*"` 接受任何有 `open_id` 的发送者。当策略为 `allowlist` 时不能为空。 |

被拒绝的消息会被静默丢弃（不回复）。日志记录在 `~/.xacpx/runtime/app.log` 中，事件名为 `feishu.message.policy_denied`，包含字段 `accountId`、`messageId`、`chatType`、`senderOpenId` 以及 `reason`（`dm_disabled`、`group_disabled`、`sender_not_allowlisted`、`missing_sender_id`）。

### 多账号（元宝）

元宝同样支持在同一频道中使用多个机器人，CLI 用法与飞书的 `--account` 标志完全一致：

```bash
# 添加第一个机器人
xacpx channel add yuanbao --account main \
    --app-key yb_main --app-secret secret_main

# 添加第二个机器人
xacpx channel add yuanbao --account ops \
    --app-key yb_ops --app-secret secret_ops --require-mention false

xacpx channel show yuanbao --account main
xacpx channel disable yuanbao --account ops
xacpx channel enable  yuanbao --account ops
xacpx channel rm yuanbao --account ops
```

ChatKey 格式为 `yuanbao:<accountId>:<chatType>:<target>`，其中 `chatType` 为 `direct` 或 `group`。

> **修改 `defaultAccount`** 会带来与飞书相同的 chatKey 路由问题。保留 `accounts.default` 作为别名，以避免破坏现有会话。

## 删除频道

```bash
xacpx channel rm feishu
xacpx restart
```

xacpx 不允许删除或禁用最后一个已启用的频道——守护进程必须始终保有至少一个消息入口。

## 配置变更后重启

频道配置的变更仅在守护进程重启后生效：

```bash
xacpx restart
```

部分子命令支持 `--restart` 或 `--no-restart` 标志，以在变更时控制是否立即重启：

```bash
xacpx channel add feishu --restart      # 添加后立即重启
xacpx channel add feishu --no-restart   # 先添加，稍后手动重启
```

如果你只想运行飞书而不希望每次启动时都等待微信二维码扫描：

```bash
xacpx channel disable weixin
xacpx restart
```

## 常见操作模式

**从纯微信切换到纯飞书：**

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu --app-id cli_xxx --app-secret your_secret
xacpx channel disable weixin
xacpx restart
```

**同时运行微信和飞书：**

```bash
xacpx login                              # 先认证微信
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu --app-id cli_xxx --app-secret your_secret
xacpx restart
```

**完整插件生命周期（安装 → 升级 → 卸载）：**

```bash
# 安装
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx channel add feishu
xacpx restart

# 升级
xacpx plugin update @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx restart

# 临时禁用但不卸载
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx restart

# 卸载
xacpx channel rm feishu
xacpx plugin remove @ganglion/xacpx-channel-feishu
xacpx restart
```

**排查添加后频道未激活的问题：**

```bash
xacpx restart
xacpx status
xacpx channel list
xacpx channel show feishu
```

**群消息没有响应（飞书）：**

如果 `requireMention` 为 `true`，群消息必须 @-提及机器人。确认该设置：

```bash
xacpx channel show feishu
```

取消 @-提及要求：

```bash
xacpx channel rm feishu --no-restart
xacpx channel add feishu --require-mention false
xacpx restart
```

**插件管理命令：**

```bash
xacpx plugin list
xacpx plugin update @ganglion/xacpx-channel-feishu --version 0.3.0
xacpx plugin update --all
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx plugin enable  @ganglion/xacpx-channel-feishu
xacpx plugin remove  @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx plugin doctor @ganglion/xacpx-channel-feishu
```

每次安装或升级后，在重启守护进程前请先运行 `xacpx plugin doctor`。它会验证 API 版本兼容性、检测插件间的类型冲突，并标记缺失或损坏的包。

**密钥存储说明：** `appSecret` 值存储在 `~/.xacpx/config.json` 中。建议使用交互式 `xacpx channel add` 提示，避免在共享终端或 CI 日志中传入 `--app-secret`，且绝不要将真实的 `config.json` 提交到 git。

完整的配置 schema，请参见[配置说明](/zh/reference/configuration)。
