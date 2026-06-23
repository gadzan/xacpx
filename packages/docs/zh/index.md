---
layout: home

hero:
  name: xacpx
  text: 你的 Agent，就在聊天里
  tagline: 在微信、飞书、元宝中驱动 Codex、Claude Code、Gemini 会话——无需打开终端。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 在 GitHub 查看
      link: https://github.com/gadzan/xacpx

features:
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    title: 原生聊天操控
    details: 在消息对话框中即可创建会话、切换上下文、发送提示词、取消任务，一气呵成。
    link: /zh/guide/getting-started
    linkText: 快速开始
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>'
    title: 网页看板
    details: 自托管 relay hub，在一个多租户浏览器看板里遥控所有实例的会话——聊天、定时任务、编排。
    link: /zh/guide/relay-self-hosting
    linkText: 自托管 hub
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
    title: acpx 传输桥接
    details: 通过直连 acpx CLI 传输或隔离的 JSON 桥接子进程来运行 Agent。
    link: /zh/development/code-wiki
    linkText: 工作原理
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 1 1.73l7 4a2 2 0 0 2 0l7-4A2 2 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
    title: 可扩展频道
    details: 无需修改核心控制台，即可添加官方或第三方频道插件。
    link: /zh/plugins/development
    linkText: 开发频道插件
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>'
    title: 双层会话模型
    details: 逻辑会话将聊天上下文映射到真实的 acpx 传输会话之上，支持附加或实时切换。
    link: /zh/guide/native-sessions
    linkText: 原生会话
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    title: 定时任务
    details: 使用 /later 排队延迟执行的提示词——支持相对或绝对时间、临时或绑定会话。
    link: /zh/guide/scheduled-tasks
    linkText: 定时任务
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'
    title: 多 Agent 编排
    details: 跨 Agent 分发子任务，并通过外部 MCP 接口进行协调管理。
    link: /zh/reference/external-mcp
    linkText: 编排
---

## xacpx 是什么？

xacpx 是一个聊天频道控制台，用于远程控制 `acpx` Agent 会话。它充当聊天应用与运行在本机上的 Agent CLI 之间的桥梁，让你无需离开手机便能启动、切换和取消 Agent 任务。

你可以通过 xacpx 驱动 Codex、Claude Code、Gemini、OpenCode 以及 `acpx` 所支持的任何其他 Agent——全部在熟悉的消息界面中完成。

## 适用场景

如果你需要轻量、随时随地访问长时间运行的 Agent 会话，xacpx 正是你所需的工具。典型场景包括：

- 离开工位时监控或重定向 Agent。
- 在单个聊天对话中管理多个并行会话，涵盖不同项目。
- 无需打开终端即可将子任务委托给其他 Agent。

如果你的工作流完全在本地终端中进行，则无需使用 xacpx——它的价值体现在聊天频道层。

## 核心工作流

典型流程分为四步：

1. **启动后台守护进程** — `xacpx start`
2. **创建或切换会话** — `/ss codex -d /path/to/project` 或 `/use <alias>`
3. **发送纯文本提示词** — 任何不以 `/` 开头的消息都会被转发到当前会话
4. **查看状态或取消** — `/status`、`/cancel`

**会话模型。** xacpx 维护两个独立的会话状态层。*逻辑会话*由 xacpx 管理，保存别名、所选 Agent、工作区绑定以及每用户的聊天上下文。*传输会话*是实际运行在后端的 `acpx` 命名会话。`/session new`（简写 `/ss`）会同时创建这两者。`/session attach` 则只创建逻辑会话并绑定到一个已存在的传输会话——当你在后端已有独立运行的 `acpx` 会话，且希望在不干扰现有对话的前提下挂载 xacpx 聊天层时，这一命令非常有用。

## 支持的频道

xacpx 内置微信作为默认频道。其他频道以官方插件包形式分发：

| 频道 | 插件包 |
|---------|---------|
| 微信（内置） | — |
| 飞书 | `@ganglion/xacpx-channel-feishu` |
| 元宝 | `@ganglion/xacpx-channel-yuanbao` |

第三方频道遵循相同的插件接口。使用 `xacpx plugin add <package>` 安装频道插件，使用 `xacpx channel add <name>` 配置，然后重启守护进程。

## 网页看板（relay hub）

聊天并不是驱动 xacpx 的唯一方式。如果你跑了多个实例，可以自托管 **relay hub**——一个内置网页看板的 npm 包（`@ganglion/xacpx-relay`）。每个实例通过 WebSocket 拨入 hub 并注册；你登录一个多租户看板，在一个地方管理所有实例的会话——聊天、定时任务、编排。Agent 回复以实时 markdown 渲染，看板可作为 PWA 安装到移动端。登录与连接器配对共用同一个 access token。

完整流程见 [自托管 Relay Hub](/zh/guide/relay-self-hosting)。

## 下一步

- [快速开始](/zh/guide/getting-started) — 安装 xacpx、登录并运行第一个会话
- [命令参考](/zh/reference/commands) — 聊天命令完整列表（`/ss`、`/use`、`/cancel` 等）
- [自托管 Relay Hub](/zh/guide/relay-self-hosting) — 为多个实例运行多租户网页看板
- [配置说明](/zh/reference/configuration) — 配置文件字段、传输选项以及工作区和 Agent 注册
- [插件开发](/zh/plugins/development) — 构建你自己的频道插件
