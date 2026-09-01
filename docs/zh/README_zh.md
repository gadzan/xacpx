# xacpx

![xacpx_banner.png](/xacpx_banner.png)

> 用微信、飞书、元宝或 Discord 远程驱动 Codex、Claude Code 等 acpx 会话。

[![npm](https://img.shields.io/npm/v/@ganglion/xacpx?style=flat-square)](https://www.npmjs.com/package/@ganglion/xacpx)
[![Node.js Version](https://img.shields.io/node/v/@ganglion/xacpx?style=flat-square)](https://nodejs.org)
[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat-square&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS42MDE1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/gadzan/xacpx)
[![License](https://img.shields.io/npm/l/@ganglion/xacpx?style=flat-square)](../../LICENSE)

**[English](../../README.md)** · 中文

## 这是什么

`xacpx` 是一个可以通过微信、飞书、元宝或 Discord 直接控制 Codex / Claude Code / Gemini / OpenCode 等 ACP Agent 的工具。它把聊天消息通过 `acpx` 连接到 Agent CLI 会话上，让你直接在手机里：

- 新建和切换会话
- 让 Agent 继续在指定项目目录里工作
- 查看流式回复、最终结果和工具调用摘要
- 调整权限策略
- 在需要时做多 Agent 编排

如果你需要临时远程编码或办公，`xacpx` 提供的是一个方便快捷的**远程入口**，让你在微信或飞书里就能随时随地干活。

聊天不是唯一入口：xacpx 还提供可自托管的 **[relay hub](#自托管-relay-hub网页看板)**——一个多租户网页看板，在一个浏览器标签页里遥控你的所有 xacpx 实例（手机上可安装为 PWA）。

> 日常使用优先记 `/ss`：它负责创建或复用 xacpx 逻辑会话。如果你想接入本地 Codex 等 Agent 已有的原生会话，再用 `/ssn`；进阶说明见 [原生会话](./native-sessions_zh.md)。

## 5 分钟快速开始

### 前置条件

- Node.js 22.13+ 或 Bun
- 已可用的 Codex / Claude Code / Gemini / OpenCode 等你要使用的 Agent CLI
- 一台装了微信、飞书、元宝或 Discord 的手机

> 微信频道基于 `weixin-agent-sdk` 工作，飞书频道使用飞书自建应用凭据，元宝频道使用 `appKey` / `appSecret`，Discord 频道使用 Discord Bot Token 走 Gateway（把机器人安装进服务器，而不是扫码配对）；底层 Agent 会话由 `acpx` 驱动。正常情况下，你不需要额外全局安装 `acpx`。

### 安装

```bash
npm install -g @ganglion/xacpx --registry=https://registry.npmjs.org
# 或
bun add -g @ganglion/xacpx
```

### 登录并启动

```bash
xacpx login    # 显示二维码，用微信扫码登录
xacpx start    # 启动后台服务
```

如果你想用飞书、元宝或 Discord 而不是微信，先看下面的「其它频道」。

### 在微信里创建第一个会话

在微信里发这几条消息：

```text
/ss codex -d /absolute/path/to/your/repo
/help
```

然后直接发普通文本：

```text
hello
```

如果一切正常，普通文本会进入当前会话，Agent 的回复会回到微信。

### 其它频道

微信是内置默认频道。飞书、元宝和 Discord 以官方插件包形式分发，第三方频道走同样的插件流程。记不住包名时，先运行 `xacpx plugin known`。

```bash
# 飞书
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu     # 按提示输入 appId/appSecret
xacpx restart

# 元宝
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao    # 按提示输入 appKey/appSecret
xacpx restart

# Discord
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord    # 按提示输入 Bot Token
xacpx restart
```

> Discord 默认是 **allowlist（白名单）** 准入且 `allowFrom` 为空，只加 token 并不能马上发消息——机器人会连上、显示在线，却忽略所有发送者。请先按 [channel-management_zh.md](./channel-management_zh.md) 的 Discord 章节把自己的 User ID 加进白名单，再期待消息被处理。

完整凭据、参数和管理命令（`enable/disable/rm`）见 [channel-management_zh.md](./channel-management_zh.md)。想自己写频道插件见 [plugin-development_zh.md](./plugin-development_zh.md)。

## 你的日常使用流程

最常见的使用顺序只有四步：

1. **启动后台服务**：`xacpx start`
2. **创建或切换会话**：`/ss ...`、`/use ...`
3. **直接发普通文本**：非 `/` 开头的文本都会发送到当前会话
4. **必要时查看状态或取消**：`/status`、`/cancel`

### 回复模式

`xacpx` 支持三种回复模式（用 `/replymode` 按会话切换）：

- `stream`：流式返回中间文本
- `final`：只返回最终结果
- `verbose`：默认，流式文本之外额外显示工具调用摘要

例如 `verbose` 模式下，你会看到：

```text
📖 sed -n '1,220p' README.md
🔍 rg -n 'session new' src tests
💻 bun test tests/unit/main.test.ts
✏️ Edit parse-command.ts
```

## 命令速查表

入门必备。完整参考：**CLI → [cli-reference_zh.md](./cli-reference_zh.md)**，**聊天命令 → [commands_zh.md](./commands_zh.md)**。

**终端（在主机上）：**

| 命令 | 说明 |
|------|------|
| `xacpx login` / `logout` | 登录 / 登出微信 |
| `xacpx start` / `stop` / `restart` / `status` | 管理后台服务 |
| `xacpx update` | 更新 xacpx 与已安装插件 |
| `xacpx doctor` | 运行环境诊断 |
| `xacpx channel add <name>` | 添加消息频道（飞书 / 元宝 / Discord / …） |
| `xacpx ws add` / `xacpx agent add <name>` | 注册 workspace / agent |

**聊天（在微信 / 飞书 / 元宝 / Discord 里）：**

| 命令 | 说明 |
|------|------|
| `/ss <agent> -d <path>` | 在项目目录里创建或复用会话 |
| `/ss new <agent> --ws <name>` | 强制新建会话 |
| `/ssn <agent> -d <path>` | 接入本地 Agent 的[原生会话](./native-sessions_zh.md) |
| `/use <alias>` | 切换当前会话 |
| `/status` · `/cancel` | 查看状态 · 停止当前任务 |
| `/model` · `/mode` | 切换 LLM 模型 · 设置 acpx mode |
| `/replymode stream\|verbose\|final` | 改变回复流式方式 |
| `/lt <时间> <消息>` | 安排一次性未来消息（[/later](./later-command_zh.md)） |
| `/dg <agent> <task>` | 委派子任务给另一个 agent |
| `/pm set read` · `/config set <path> <value>` | 权限 · 白名单配置 |

## 多 Agent 编排与 MCP

当前会话就是主控会话；被委派的子任务（`/dg`、`/tasks`、`/task approve`）作为独立
worker 会话运行，默认需要人工确认。Codex、Claude Code 等外部 MCP host 可以把
`xacpx mcp-stdio` 配成 stdio MCP server，直接驱动 xacpx 的编排能力
（`delegate_request` / `delegate_batch` 支持 MCP Tasks）。

- 什么时候该 delegate、什么时候并行开组：[xacpx-group-usage-guide_zh.md](./xacpx-group-usage-guide_zh.md)
- 外部 MCP 配置、身份规则、工具列表、故障排查：[external-mcp_zh.md](./external-mcp_zh.md)

## 常见场景

```text
# 在手机上继续盯一个本地项目
/ss codex -d /absolute/path/to/backend
看一下今天这个接口超时问题

# 同一个聊天里切换两个项目
/ss codex -d /absolute/path/to/backend
/ss new codex -d /absolute/path/to/frontend
/ss
/use backend:codex

# 接入本地已有 Codex 原生会话
/ssn codex -d /absolute/path/to/backend
/ssn 1
```

## 自托管 relay hub——网页看板

如果你跑了一个或多个 xacpx 实例，想用浏览器（替代或补充聊天入口）统一遥控，可以自托管 **relay hub**。每个实例通过 WebSocket 拨向 hub 并注册；你登录一个多租户 web 看板，在一个地方管理所有实例的会话。

你会得到：

- **三栏 IM 式看板**——左栏实例/会话树，中栏实时聊天流，右栏定时任务 + 编排面板。界面支持 English + 中文。
- **实时流式回复**以 markdown 渲染，工具调用与子 Agent 活动内联展示；可直接在浏览器里取消运行中的任务。
- **移动端友好**——可安装为 PWA，在手机上像原生应用一样使用。
- **一个包、一个端口**——`@ganglion/xacpx-relay` **内置打包**了看板；HTTP API、网页 WebSocket 和实例网关默认共用一个端口。存储用内置的 `node:sqlite`/`bun:sqlite`——无需编译任何原生依赖。
- **多租户 + 令牌认证**——一个令牌就是一个用户，只能看到自己的实例；令牌与凭据均哈希落盘。给同伴开号可用**一次性邀请链接**（`xacpx-relay add invite`），无需在服务器上代发令牌。

```bash
npm i -g @ganglion/xacpx-relay
xacpx-relay add token        # 仅打印一次 access token
xacpx-relay start            # 默认：--host 0.0.0.0 --http-port 8787

# 在每个实例主机上：
xacpx plugin add @ganglion/xacpx-channel-relay   # 需要 xacpx >= 0.17.0-beta.6
xacpx channel add relay --url wss://relay.example.com --token <access-token> --name my-box
xacpx restart
```

登录和连接器配对共用同一个 access token。完整流程——配对、邀请码、TLS/反向代理、systemd、备份、故障排查见：**[自托管 Relay Hub](https://gadzan.github.io/xacpx/guide/relay-self-hosting)**（或 [relay-deployment.md](../relay-deployment.md) 精简 runbook）。

## 配置与运行文件

- 配置文件：`~/.xacpx/config.json`
- 状态文件：`~/.xacpx/state.json`
- 运行日志：`~/.xacpx/runtime/app.log`

更多运行时文件会放在 `~/.xacpx/runtime/` 下。完整配置字段参考见 [config-reference_zh.md](./config-reference_zh.md)。

## 从源码运行

```bash
bun install
bun run login
bun run dev
```

开发、调试与贡献细节见 [developments_zh.md](./developments_zh.md)。

## 更多文档

**安装与配置**
- [channel-management_zh.md](./channel-management_zh.md) — 配置微信 / 飞书 / 元宝 / Discord / 第三方频道
- [plugin-development_zh.md](./plugin-development_zh.md) — 自己写频道插件
- [config-reference_zh.md](./config-reference_zh.md) — 完整配置字段参考
- [config-command_zh.md](./config-command_zh.md) — 在聊天里改配置

**日常使用**
- [cli-reference_zh.md](./cli-reference_zh.md) — 完整终端 CLI 参考
- [commands_zh.md](./commands_zh.md) — 完整聊天命令参考
- [later-command_zh.md](./later-command_zh.md) — 定时任务（`/later`）
- [native-sessions_zh.md](./native-sessions_zh.md) — 接入本地 Agent 的原生会话
- [xacpx-group-usage-guide_zh.md](./xacpx-group-usage-guide_zh.md) — 什么时候该 delegate vs 开组
- [external-mcp_zh.md](./external-mcp_zh.md) — 外部 MCP coordinator 集成

**排错与验证**
- [faq_zh.md](./faq_zh.md) — 常见问题（`/ss new` 失败、`/mode <id>` 等）
- [doctor-command_zh.md](./doctor-command_zh.md) — `xacpx doctor` 诊断与 `--fix`
- [testing_zh.md](./testing_zh.md) — 测试分层与运行方式

**开发与贡献**
- [developments_zh.md](./developments_zh.md) — 从源码开发、调试或参与贡献
- [code-wiki_zh.md](./code-wiki_zh.md) — 架构地图
