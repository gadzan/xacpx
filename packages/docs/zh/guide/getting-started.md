# 快速开始

本指南将引导你完成 xacpx 的安装、连接聊天频道，以及运行第一个 Agent 会话的全过程。

## 环境要求

- **Node.js 22.12+**（或使用 Bun 作为本地开发的替代运行时）
- **Agent CLI** — Codex、Claude Code、Gemini、OpenCode，或任何 `acpx` 所支持的 Agent。无需全局安装 `acpx`，xacpx 自带捆绑版本。
- **支持的聊天客户端** — 在手机上安装微信、飞书或元宝（或配置为机器人应用）

## 安装 xacpx

全局安装 `@ganglion/xacpx` 包：

```bash
npm install -g @ganglion/xacpx --registry=https://registry.npmjs.org
# 或使用 Bun
bun add -g @ganglion/xacpx
```

安装完成后，`xacpx` 二进制文件即可在 Shell 中使用。通过以下命令验证：

```bash
xacpx version
```

## 运行控制台

xacpx 以后台守护进程方式运行。启动命令：

```bash
xacpx start
```

在前台运行（调试时很有用）：

```bash
xacpx run
```

随时查看守护进程状态：

```bash
xacpx status
```

停止守护进程：

```bash
xacpx stop
```

修改频道配置后重启守护进程：

```bash
xacpx restart
```

## 登录微信

微信是内置的默认频道。使用以下命令进行身份验证：

```bash
xacpx login
```

终端中会显示二维码，使用微信移动端扫描即可。认证成功后，凭据会保存在本地，后续启动时自动复用。

如果你更倾向于使用飞书或元宝，请先跳转至[配置频道和工作区](#配置频道和工作区)。

## 创建第一个会话

`xacpx start` 完成后，在微信对话框中发送以下消息：

```text
/ss codex -d /absolute/path/to/your/project
/help
```

`/ss` 命令一步完成：创建一个逻辑会话（xacpx 管理的别名、Agent 绑定、工作区绑定和聊天上下文）以及对应的传输会话（后端实际的 `acpx` 命名会话）。会话创建后立即设为当前聊天的活跃会话。

会话激活后，任何不以 `/` 开头的消息都会作为提示词转发给 Agent：

```text
Summarize the recent changes in this repo
```

Agent 的回复会实时流回聊天。

**`/ss` 常用标志语法：**

```text
/ss <agent> -d <absolute-path>
/ss <agent> --ws <workspace-name>
/ss new <agent> -d <absolute-path>   # 即使已存在会话也强制新建
```

使用 `--ws <name>` 可引用你事先通过 `xacpx workspace add` 注册的工作区；使用 `-d` 可直接指定绝对路径，无需预注册。

**切换会话：**

```text
/ss                  # 列出活跃会话
/use <alias>         # 按别名切换活跃会话
```

**取消当前任务：**

```text
/cancel
/stop
```

## 附加到已有的 acpx 会话

如果你已在后端独立运行了一个 `acpx` 会话（例如手动创建的），可以将 xacpx 挂载到该会话上，且不会干扰现有会话状态。

`/session attach` 命令只创建逻辑会话——即 xacpx 别名、Agent 和工作区绑定——并将其链接到指定的传输会话名称，不会创建新的 `acpx` 会话。

```text
/ss attach <alias> -a <agent> --ws <workspace> --name <acpx-session-name>
```

其中 `-a <agent>`（`--agent` 的简写）用于选择绑定的 Agent，`--name <acpx-session-name>` 是已有 `acpx` 传输会话的名称。

例如，如果你手动创建了一个会话：

```bash
./node_modules/.bin/acpx --verbose --cwd /absolute/path/to/project codex sessions new --name my-session
```

可在聊天中附加它：

```text
/ss attach demo -a codex --ws backend --name my-session
```

附加后，该会话的行为与通过 `/ss new` 创建的会话完全一致。完整语法请参见[命令参考](/zh/reference/commands)。

## 配置频道和工作区

### 添加频道

微信已内置。要添加飞书或元宝，请安装对应的插件包并进行配置：

```bash
# 飞书
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu     # 按提示输入 appId / appSecret
xacpx restart

# 元宝
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao    # 按提示输入 appKey / appSecret
xacpx restart
```

列出官方支持的插件包：

```bash
xacpx plugin known
```

完整的频道配置选项——包括 `enable`、`disable`、`rm`——请参见[配置说明](/zh/reference/configuration)。

### 注册工作区

工作区将一个简短名称映射到本机的绝对路径。在终端中注册：

```bash
cd /path/to/your/project
xacpx workspace add backend   # 将当前目录注册为 "backend"
# 简写别名：
xacpx ws add frontend
xacpx ws list
xacpx ws rm frontend
```

注册后，可在聊天命令中通过名称引用工作区：

```text
/ss codex --ws backend
```

包含空格或特殊字符的名称会自动规范化，仅保留字母、数字、点、下划线和连字符。传入 `--raw` 可保留原始名称，但此后在所有地方引用时都需要加引号。

### 注册 Agent

默认配置已包含 `codex` 和 `claude`。可从内置模板列表中添加其他 Agent：

```bash
xacpx agent templates         # 列出可用模板
xacpx agent add kimi          # 添加 kimi 模板
xacpx agent list
xacpx agent rm kimi
```

## 本地干运行

本节适用于从仓库源码参与开发的贡献者，使用发布二进制包的用户可跳过。

你可以使用内置的干运行模式在无需微信账号或任何聊天凭据的情况下测试控制台：

```bash
bun run dry-run --chat-key wx:test -- "/status"
```

传入多个斜杠命令作为额外参数，可模拟连续对话序列：

```bash
bun run dry-run --chat-key wx:test -- "/session new demo --agent codex --ws backend" "/status"
```

这对在开发过程中验证命令路由和会话状态逻辑非常有用。

## 常见问题排查

**守护进程未运行。** 执行 `xacpx status` 确认状态。若守护进程意外退出，查看日志 `~/.xacpx/runtime/app.log`。

**会话创建失败（`/ss new` 报错）。** 最常见的原因是底层 `acpx` 会话未能正常启动。先在终端中验证 Agent 二进制文件能否正常工作。如有必要，手动创建 `acpx` 会话，再使用 `/session attach` 将 xacpx 绑定到它。

**微信二维码未出现。** 直接运行 `xacpx login` 重新认证。扫码后，使用 `xacpx restart` 重启守护进程。

**插件频道未激活。** 执行 `xacpx channel add` 后，务必运行 `xacpx restart` 以重新加载频道配置。使用 `xacpx channel list` 确认频道已启用。

**`acpx` 未找到或版本错误。** xacpx 按以下优先级解析 `acpx`：配置键 `transport.command`（显式覆盖）、`node_modules` 中的捆绑副本、Shell `PATH` 中的 `acpx`。如果你的 `transport.command` 中有一个指向缺失二进制文件的旧条目，请从 `~/.xacpx/config.json` 中删除它，以回退到捆绑版本。

**运行环境诊断。** 进行全面的预检：

```bash
xacpx doctor
xacpx doctor --verbose
```

完整命令参考请见[命令参考](/zh/reference/commands)。所有配置字段请见[配置说明](/zh/reference/configuration)。

---

## 本地开发（从源码）

如果你在仓库源码中工作，而非使用已发布的包，请使用以下命令代替已安装的 `xacpx` 二进制文件：

```bash
bun run dev            # 在前台运行控制台（开发模式）
bun run login          # 显示微信登录二维码
node ./dist/cli.js start    # 在后台启动守护进程
node ./dist/cli.js status   # 查看守护进程状态
node ./dist/cli.js stop     # 停止守护进程
```

如果尚未构建，请先构建 CLI：

```bash
bun run build
```
