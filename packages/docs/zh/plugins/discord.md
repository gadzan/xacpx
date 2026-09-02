# Discord 频道

## 概述

`@ganglion/xacpx-channel-discord` 是 xacpx 的官方 Discord 频道插件。它通过 Discord Gateway 连接机器人，把私信、服务器频道消息、Thread、命令、文本以及支持的附件路由到 xacpx 的命令和会话系统。

Discord 是**机器人 Token 频道**，不是扫码登录频道。这里没有 `xacpx login discord`：你需要先创建 Discord Application/Bot、把机器人安装到服务器，然后在 xacpx 中配置 Bot Token。

## 安装

先安装插件：

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
```

然后添加 Discord 频道。推荐使用交互式输入，避免 Token 留在 shell history：

```bash
xacpx channel add discord
# Discord bot token: <粘贴 Token>
```

自动化场景也可以显式传入：

```bash
xacpx channel add discord --token '<BOT_TOKEN>'
```

如果准备使用默认 allowlist 安全策略，先不要急着重启：默认 `allowFrom` 为空，会拒绝所有人。先完成下面的访问控制配置。

## 创建 Discord Bot

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)。
2. 创建一个 **Application**。
3. 进入 **Bot** 页面，创建或确认 Bot 用户。
4. 复制 **Bot Token**。Token 等同密码；一旦泄露，应立即在 Portal 中 Reset Token、更新 xacpx 配置并重启守护进程。

### Message Content Intent

在 **Bot → Privileged Gateway Intents** 中打开 **Message Content Intent**。

插件默认请求 Message Content（`options.intents.messageContent: true`）。如果本地配置为 `true`，但 Portal 没开这个开关，Discord 会以 **4014（disallowed intents）** 拒绝 Gateway identify，表现为机器人无法上线。

如果你明确只想运行 mention-only Bot，可以设置：

```jsonc
{
  "intents": { "messageContent": false }
}
```

关闭该 Intent 后，私信以及真正 `@提及` 机器人的消息仍可带有内容。**只回复机器人消息并不能替代 Message Content 权限**：xacpx 可以识别 reply 关系，但 Discord 可能把这条 reply 的正文作为空内容交给 Bot。普通服务器使用建议直接开启 Message Content。

## 把 Bot 安装到服务器

通过 Discord 的 **OAuth2 → URL Generator** 或 **Installation** 页面生成带 `bot` scope 的邀请链接，并把 Bot 加入服务器。

不要给 Administrator。消息频道通常只需要：

```text
View Channels
Send Messages
Read Message History
Add Reactions
Attach Files
Send Messages in Threads   # 使用 Thread / Forum 时需要
```

`Send Messages in Threads` 与普通 `Send Messages` 是两项独立权限。

## 配置访问控制

Discord 权限判断使用数字 **snowflake ID**，不是用户名或显示昵称。

先开启 **Discord 设置 → 高级 → 开发者模式**，然后右键用户使用 **Copy ID / 复制 ID** 获取自己的 User ID。需要按服务器细分时，同样可以复制 Guild、Channel、Role ID。

`xacpx channel add discord` 目前没有 `--allow-from` 参数，因此需要编辑 `~/.xacpx/config.json`，把自己的 User ID 加到 allowlist：

```jsonc
{
  "channels": [
    {
      "id": "discord",
      "type": "discord",
      "enabled": true,
      "options": {
        "token": "<BOT_TOKEN>",
        "dmPolicy": "allowlist",
        "guildPolicy": "allowlist",
        "allowFrom": ["<你的_DISCORD_USER_ID>"],
        "requireMention": true
      }
    }
  ]
}
```

默认安全策略是刻意收紧的：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `dmPolicy` | `allowlist` | 私信只接受 `allowFrom` 中的发送者 |
| `guildPolicy` | `allowlist` | 服务器中只接受 allowlist 用户 |
| `allowFrom` | 空 | 在加入 ID 前拒绝所有发送者 |
| `requireMention` | `true` | 服务器消息必须 @Bot 或回复 Bot |
| `allowBots` | `false` | 忽略其他机器人发来的消息 |

`allowFrom` 中填写 `"*"` 可以接受任何发送者，但只建议用于受控环境。公共服务器不要长期使用 `guildPolicy: "open"` + `requireMention: false`。

## 重启并验证

```bash
xacpx channel show discord
xacpx plugin doctor
xacpx restart
```

`xacpx plugin doctor` 只做本地配置诊断，**不会**实时调用 Discord API 验证 Token。

真实连通性要看三件事：

1. 守护进程启动时没有 Discord Gateway 错误；
2. Discord 中 Bot 显示在线；
3. 消息可以完整往返一次。

使用 allowlist 中的服务器账号测试：

```text
@你的Bot /help
@你的Bot /ss codex -d /项目的绝对路径
@你的Bot 检查一下当前 git diff
```

私信 Bot 时不需要 @mention：

```text
/help
/ss codex -d /项目的绝对路径
跑一下测试并总结失败原因
```

私信仍然受 `dmPolicy` 和 `allowFrom` 控制。

## 临时烟雾测试

如果只想在受控测试服务器快速验证 Gateway → xacpx → Agent 链路，可以临时开放策略，但继续要求 @mention：

```bash
xacpx channel add discord \
  --token '<BOT_TOKEN>' \
  --dm-policy open \
  --guild-policy open \
  --require-mention true
```

确认链路正常后，应恢复 allowlist 作为日常配置。

## 配置说明

一个较完整的单账号配置如下：

```jsonc
{
  "channels": [
    {
      "id": "discord",
      "type": "discord",
      "enabled": true,
      "options": {
        "token": "<BOT_TOKEN>",
        "applicationId": "123456789012345678",
        "replyMode": "auto",
        "tableMode": "code",
        "requireMention": true,
        "dmPolicy": "allowlist",
        "guildPolicy": "allowlist",
        "allowFrom": ["<你的_DISCORD_USER_ID>"],
        "guilds": {
          "<GUILD_ID>": {
            "users": [],
            "roles": [],
            "channels": {
              "<CHANNEL_ID>": { "requireMention": false }
            }
          }
        },
        "allowBots": false,
        "intents": {
          "messageContent": true,
          "guildMembers": false
        },
        "media": {
          "maxBytes": 8388608,
          "maxAttachments": 10
        }
      }
    }
  ]
}
```

基础消息流唯一必需的凭据是 `token`。当前消息路径下 `applicationId` 是可选项。

某个 Guild 配置只要有非空的 `users` 或 `roles`，就会启用该 Guild 自己的 allowlist；如果 Guild 条目只是修改 `channels.<id>.requireMention` 之类的频道设置，用户 allowlist 仍然来自全局 `allowFrom`。

## 回复模式

`options.replyMode` 控制 Discord 的回复渲染：

| 模式 | 行为 |
| --- | --- |
| `auto` | 默认；当前解析为 streaming |
| `streaming` | 生成期间原地编辑 preview，完成时删除 preview，再发送最终答案 |
| `static` | 不显示 preview，只发送最终分片结果 |

Discord 单条消息上限为 2000 字符，最终答案会自动分片。preview 创建或编辑失败时会自动降级到静态发送。

## Thread 与会话

Discord 的 ChatKey 会区分私信、服务器频道和 Thread：

```text
discord:<accountId>:dm:<dmChannelId>
discord:<accountId>:g:<channelId>
discord:<accountId>:t:<threadId>
```

每个 Thread / Forum Post 都是独立的 xacpx 聊天上下文，因此会得到独立的会话映射。若 xacpx 回复过程中 Thread 已归档或消失，文本、媒体和后台完成通知会尽可能降级发送到父频道。

## 多个 Discord Bot

使用命名账号添加多个 Bot：

```bash
xacpx channel add discord --account work --token '<WORK_BOT_TOKEN>'
xacpx channel add discord --account personal --token '<PERSONAL_BOT_TOKEN>'
```

每个账号的覆盖配置位于 `options.accounts.<id>`。所有启用的账号必须解析到**不同的 Bot Token**。xacpx 会拒绝单进程中重复的启用 Token，同时通过 per-token consumer lock 防止两个 xacpx 进程同时驱动同一个 Discord Bot。

## 媒体

Discord 入站附件可以在配置的大小和数量上限内传给 Agent。出站文件只允许来自 media-store 根目录或允许的工作区根目录；逃逸这些目录的路径以及 URL 形式路径都会被拒绝。

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| Bot 一直离线 / Gateway 4014 | 在 Portal 开启 Message Content Intent；或有意把本地 `intents.messageContent` 设为 `false` |
| Bot 在线但完全不回复 | 把自己的数字 Discord User ID 加入 `allowFrom`；默认列表为空 |
| 服务器消息被忽略 | 默认 `requireMention: true`，请真正 `@Bot`，并检查 `guildPolicy` |
| 关闭 Message Content 后，回复 Bot 的正文为空 | 使用显式 `@Bot`，或重新开启 Message Content |
| Thread 回复失败 | 授予 `Send Messages in Threads`；归档 Thread 会在可解析时降级到父频道 |
| 附件发送失败 | 授予 `Attach Files`，并检查 `media.maxBytes` / `media.maxAttachments` |
| 不确定配置是否正确 | 使用 `xacpx channel show discord` 和 `xacpx plugin doctor`；实时 Gateway 结果看守护进程日志 |

被策略拒绝的消息会静默丢弃，并在 xacpx app log 中以 `discord.message.policy_denied` 记录。

## 更新与卸载

```bash
xacpx plugin update @ganglion/xacpx-channel-discord
xacpx restart
```

卸载：

```bash
xacpx channel rm discord
xacpx plugin remove @ganglion/xacpx-channel-discord
```
