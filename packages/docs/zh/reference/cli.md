# CLI 命令

这些命令在电脑终端里运行（`xacpx` 可执行文件）。在微信/飞书/元宝聊天里发送的斜杠命令请见[命令参考](/zh/reference/commands)。

## 总览

```
xacpx login | logout | run | start | status | stop | restart
xacpx update [--all | <name>]
xacpx channel | ch  list | show | add | rm | enable | disable  [--account <id>]
xacpx plugin  list | add | update | remove | enable | disable | doctor | known
xacpx doctor [--verbose] [--smoke] [--agent <a>] [--workspace <w>] [--fix]
xacpx version
xacpx agent | agents  list | add | rm | templates
xacpx workspace | ws  list | add [name] [--raw] | rm <name>
xacpx later | lt  list | cancel <id>
xacpx mcp-stdio [--coordinator-session <s>] [--source-handle <h>] [--workspace <name>]
```

## 守护进程生命周期

| 命令 | 说明 |
|---|---|
| `xacpx login` | 登录微信（显示二维码扫码） |
| `xacpx logout` | 清除本机保存的微信登录凭证 |
| `xacpx run` | 前台运行控制台（适合调试） |
| `xacpx start` | 后台启动服务 |
| `xacpx status` | 查看后台状态、PID、配置路径、日志路径 |
| `xacpx stop` | 停止后台实例 |
| `xacpx restart` | 重启后台实例，让频道/配置变更生效 |
| `xacpx version` | 查看当前版本 |

首次运行 `xacpx start` 或 `xacpx run` 时，如果没有会话、workspace 和插件，CLI 会询问是否把当前目录注册为 workspace，并让你选择一个内置 agent 模板，然后通过正常会话创建流程创建初始 acpx 会话。

## 更新 —— `xacpx update`

`xacpx update` 用来检查并安装 xacpx 本体以及已安装频道插件的新版本。

```bash
xacpx update            # 交互式：选择要更新的项
xacpx update --all      # 非交互式更新全部（本体 + 所有插件）
xacpx update <name>     # 更新单个目标（本体，或某个具体插件包）
```

- 安装了插件时，直接运行 `xacpx update` 会进入交互模式，让你选择要更新哪些目标。
- 在非交互环境下，更新本体或插件需要显式确认：用 `--all`，或用 `xacpx update <name>` 指定目标。
- 如果想直接管理单个插件的版本，用 `xacpx plugin update <name>`（见下方[频道](#频道-xacpx-channel) / [插件](#插件-xacpx-plugin)）。
- 更新后运行 `xacpx restart`，让正在运行的 daemon 加载新版本。
- **跨包改名迁移：** 本项目已由 `weacpx` 改名为 `xacpx`。只有仍安装着旧 `weacpx` 包的用户才需要运行 `weacpx update`，它会提示自动迁移到 `xacpx`（由你确认切换）。已经在使用 `xacpx` 的用户直接用 `xacpx update` 做普通的本体自更新即可。

## 频道 —— `xacpx channel`

`xacpx channel`（别名 `ch`）管理 `~/.xacpx/config.json` 里配置的消息频道。微信是内置的；飞书、元宝以及第三方频道需要先作为插件安装（见[插件](#插件-xacpx-plugin)）。

| 命令 | 说明 |
|---|---|
| `xacpx channel list` | 列出已配置的频道 |
| `xacpx channel show <name>` | 查看某个频道解析后的配置 |
| `xacpx channel add <name>` | 添加频道；会提示输入所需凭据 |
| `xacpx channel rm <name>` | 删除频道 |
| `xacpx channel enable <name>` | 启用一个已配置的频道 |
| `xacpx channel disable <name>` | 停用频道但保留其配置 |
| `... [--account <id>]` | 多个账号共用一个频道时，指定其中一个 bot（多 bot） |

多个 bot 共用一个频道时，`--account <id>` 用来选择 `show` / `enable` / `disable` / `rm` 操作针对哪个账号。完整的凭据配置和多 bot 模型见[频道管理](/zh/guide/channel-management)。

## 插件 —— `xacpx plugin`

`xacpx plugin` 管理提供非微信频道（及其它扩展）的 npm 插件包。

| 命令 | 说明 |
|---|---|
| `xacpx plugin known` | 查看官方插件包清单（如飞书/元宝包名） |
| `xacpx plugin list` | 列出已安装插件及其版本 |
| `xacpx plugin add <package>` | 安装一个插件包 |
| `xacpx plugin update <name>` | 更新单个已安装插件 |
| `xacpx plugin remove <name>` | 删除一个已安装插件 |
| `xacpx plugin enable <name>` | 启用一个已安装插件 |
| `xacpx plugin disable <name>` | 停用插件但不删除 |
| `xacpx plugin doctor` | 诊断插件安装/加载问题 |

```bash
xacpx plugin known
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu     # 按提示输入 appId/appSecret
xacpx restart
```

端到端流程见[频道管理](/zh/guide/channel-management)，自己写插件见[频道插件开发](/zh/plugins/development)。

## 诊断 —— `xacpx doctor`

```bash
xacpx doctor
xacpx doctor --verbose
xacpx doctor --smoke
xacpx doctor --smoke --agent codex --workspace backend
xacpx doctor --fix
```

- `--verbose` 会展开每项检查的细节。
- `--smoke` 会额外执行一次真实 transport 级别的最小 prompt 检查。
- `--agent` / `--workspace` 只影响 `--smoke`。
- 如果不传 `--smoke`，相关检查会显示为 `SKIP`。
- `--fix` 会执行安全的本地修复（运行时目录权限、残留 consumer 锁、无效 state 记录）并重跑受影响的检查。会改动状态的修复在 daemon 运行期间会被扣留（提示先 stop daemon）。

## 工作区 —— `xacpx workspace`

`xacpx workspace`（别名 `ws`）维护 `~/.xacpx/config.json` 里的 `workspaces` 配置。把常用项目目录注册在这里，然后在聊天里用 `--ws <name>` 引用。

| 命令 | 说明 |
|---|---|
| `xacpx workspace list` | 列出已注册的 workspace 及其路径 |
| `xacpx workspace add` | 注册当前目录（名称默认取当前目录名，自动规范化） |
| `xacpx workspace add <name>` | 把当前目录注册为指定名称 |
| `xacpx workspace add [name] --raw` | 保留原始名称（含空格等）；后续命令需要用引号引用 |
| `xacpx workspace rm <name>` | 删除一个 workspace |

```bash
cd /absolute/path/to/backend
xacpx workspace add backend
xacpx ws list
xacpx ws rm backend
```

`workspace add` 总是注册**当前终端所在目录**。含空格/中文等字符的名称会被规范化为 `[a-zA-Z0-9._-]+`（例如 `My Project` → `My-Project`），重名时追加 `-2`、`-3`。加 `--raw` 保留原名；之后 `rm` / `--ws <name>` 需要用引号引用，例如 `xacpx workspace rm "My Project"`。

## Agent —— `xacpx agent`

`xacpx agent`（别名 `agents`）维护 `~/.xacpx/config.json` 里的 `agents` 配置。

| 命令 | 说明 |
|---|---|
| `xacpx agent list` | 列出已注册的 agent |
| `xacpx agent templates` | 列出可添加的内置模板 |
| `xacpx agent add <name>` | 从内置模板添加 agent，例如 `kimi`、`opencode` |
| `xacpx agent rm <name>` | 删除一个 agent |

## 定时任务 —— `xacpx later`

`xacpx later`（别名 `lt`）在终端查看和取消本机待执行的定时任务。CLI 只做**查看和取消**——定时任务在聊天里用 `/later` 创建（见[定时任务](/zh/guide/scheduled-tasks)）。

| 命令 | 说明 |
|---|---|
| `xacpx later list` | 查看待执行的定时任务 |
| `xacpx later cancel <id>` | 取消一个待执行的定时任务 |

## MCP 服务 —— `xacpx mcp-stdio`

把 xacpx 的多 Agent 编排能力作为 stdio MCP server 暴露给外部 MCP host（Codex / Claude Code）。

```bash
xacpx mcp-stdio
xacpx mcp-stdio --coordinator-session <session> --source-handle <handle> --workspace <name>
```

| 参数 | 说明 |
|---|---|
| `--coordinator-session <s>` | 把 MCP server 绑定到指定的主控会话 |
| `--source-handle <h>` | 主控绑定的 source handle |
| `--workspace <name>` | 被委派 worker 的默认工作区 |

身份规则、`workingDirectory` 语义、完整工具列表和故障排查见[外部 MCP 协调器](/zh/reference/external-mcp)。

## Relay hub — `xacpx-relay`

[自托管 Relay Hub](/zh/guide/relay-self-hosting) 用的**独立**命令（不属于 `xacpx` CLI）。在 relay 各包发布到 npm 之前，从仓库 checkout 用 `node packages/relay/dist/cli.js <命令>` 调用。

```bash
xacpx-relay start [--db <path>] [--web-root <dir>] [--host 0.0.0.0] [--http-port 8787] [--ws-port 8788] [--history-retention-days 30] [--request-timeout-ms 120000] [--trust-proxy]
xacpx-relay add token [--label <note>] [--db <path>]
xacpx-relay add invite [--label <note>] [--ttl <30m|12h|7d>] [--url <hub-base-url>] [--db <path>]
xacpx-relay ls [--db <path>]
xacpx-relay rm token <value-or-id> [--db <path>]
xacpx-relay rm invite <code-or-id> [--db <path>]
```

| 命令 | 说明 |
|---|---|
| `start` | 启动 hub。`--db` 默认 `~/.xacpx-relay/relay.db`（自动创建目录）。`--web-root` 默认指向内置的 `packages/relay-web/dist`，不传也能提供看板 UI。没有 `stop`/`status`——用 `SIGTERM`。 |
| `add token` | 创建用户并生成登录令牌，**只打印一次**。同一个令牌既用于网页看板登录（粘贴到"访问令牌"输入框），也用于连接器（`--token`）。 |
| `add invite` | 生成**一次性邀请码**并打印兑换链接（`/invite/<code>`）。对方打开链接、点击兑换即可自助创建账号并获得令牌。`--ttl` 默认 `7d`。详见[邀请码](/zh/guide/relay-self-hosting#add-invite-通过链接邀请他人)。 |
| `ls` | 列出所有令牌（短 id、标签、创建时间、已连接实例数）及未用/已用邀请码。 |
| `rm token <value-or-id>` | 删除该令牌对应的用户（级联删除所有关联数据）。 |
| `rm invite <code-or-id>` | 删除邀请码（不影响已兑换出的账号）。 |

**示例——生成令牌：**

```
$ xacpx-relay add token --label "my-instance"
access token: bBS9nN2W2MwdrdksoLTLrQeMLMah9M5flTOyEcBbIHc
(store it now — not shown again)
hint: use this token for web login AND: xacpx channel add relay --url ws://<host>:<ws-port> --token <token>
```

**连接器命令**——将实例接入 hub：

```bash
xacpx channel add relay --url <host> --token <token> [--name <label>]
```

`--url` 是指向实例网关（默认端口 8788）或 TLS 代理的智能简写：

| 输入 | 解析后的 URL |
|---|---|
| `relay.example.com` | `wss://relay.example.com` |
| `1.2.3.4` | `ws://1.2.3.4:8788` |
| `1.2.3.4:9000` | `ws://1.2.3.4:9000` |
| `localhost` | `ws://localhost:8788` |
| `host:9000` | `ws://host:9000` |
| `ws://…` / `wss://…` | 原样使用 |
| `http://…` / `https://…` | 映射为 `ws://…` / `wss://…` |

完整部署流程见[自托管 Relay Hub](/zh/guide/relay-self-hosting)。
