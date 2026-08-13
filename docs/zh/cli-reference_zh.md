# CLI 命令参考

这些命令在安装了 xacpx 的电脑终端里运行。聊天命令（在微信 / 飞书 / 元宝里发送）见 [commands_zh.md](./commands_zh.md)。

## 全部命令

| 命令 | 说明 |
|------|------|
| `xacpx login` | 登录微信 |
| `xacpx logout` | 清除本机保存的微信登录凭证 |
| `xacpx run` | 前台运行，适合调试 |
| `xacpx start` | 后台启动服务 |
| `xacpx status` | 查看后台状态、PID、配置路径、日志路径 |
| `xacpx stop` | 停止后台实例 |
| `xacpx restart` | 重启后台实例，让频道配置变更生效 |
| `xacpx update [--all\|<name>]` | 检查并更新 xacpx 与已安装插件；安装了插件时会交互式选择更新项 |
| `xacpx channel list\|show\|add\|rm\|enable\|disable [--account <id>]` | 管理消息频道；多个 bot 共用一个频道时，用 `--account <id>` 指定其中一个（多 bot） |
| `xacpx plugin list\|add\|update\|remove\|enable\|disable\|doctor\|known` | 管理插件：列出/安装/更新/删除、启用停用、运行 `doctor`，或用 `known` 查看官方包清单 |
| `xacpx plugin add @ganglion/xacpx-channel-feishu && xacpx channel add feishu` | 安装并添加飞书频道，会提示输入飞书应用凭据 |
| `xacpx plugin add @ganglion/xacpx-channel-yuanbao && xacpx channel add yuanbao` | 安装并添加元宝频道，会提示输入元宝 appKey/appSecret |
| `xacpx doctor` | 运行环境诊断 |
| `xacpx version` | 查看当前版本 |
| `xacpx agent list` | 查看本机已注册的 agent |
| `xacpx agent add <name>` | 从内置模板添加 agent；已存在且配置不同的同名 agent 不会被覆盖 |
| `xacpx agent rm <name>` | 删除 agent |
| `xacpx adapter preinstall <codex\|claude> [version]` | 可选地预安装一个不可变的本地 adapter release，并原子切换 active pointer |
| `xacpx adapter list --installed` | 列出本地 adapter release 与当前 active release |
| `xacpx adapter uninstall <codex\|claude> <release-id>` | 删除非 active、无引用的 release；引用读取不确定时拒绝删除 |
| `xacpx orphans kill --confirm` | 人工确认后，按 fail-closed 规则尝试清理 Windows orphan 登记记录 |
| `xacpx workspace list` | 查看本机已注册的 workspace |
| `xacpx workspace add [name] [--raw]` | 把当前目录注册成 workspace；不传 `name` 时使用当前目录名，含特殊字符的名称会被自动规范化 |
| `xacpx workspace rm <name>` | 删除 workspace |
| `xacpx later list` / `xacpx lt list` | 在终端查看本机待执行定时任务 |
| `xacpx later cancel <id>` / `xacpx lt cancel <id>` | 在终端取消本机待执行定时任务 |

首次运行 `xacpx start` 或 `xacpx run` 时，如果没有会话、workspace 和插件，CLI 会询问是否把当前目录创建为 workspace，并选择一个内置 agent 模板；服务启动后会通过正常会话创建流程创建初始 acpx 会话。

`workspace` 也可以简写为 `ws`：

```bash
xacpx ws add
xacpx ws list
xacpx ws rm backend
```

## `workspace` CLI

`xacpx workspace` 用来在电脑本机维护 `~/.xacpx/config.json` 里的 `workspaces` 配置。它适合先在终端里注册常用项目目录，然后在微信里用 `--ws <name>` 直接引用。

| 命令 | 说明 |
|------|------|
| `xacpx workspace list` | 列出已注册的 workspace 及其路径 |
| `xacpx workspace add` | 把当前目录注册为 workspace，名称默认取当前目录名（自动规范化） |
| `xacpx workspace add <name>` | 把当前目录注册为指定名称（含特殊字符时自动规范化） |
| `xacpx workspace add [name] --raw` | 保留原始名称（含空格等），后续命令需要用引号引用 |
| `xacpx workspace rm <name>` | 删除指定 workspace |

常见用法：

```bash
cd /absolute/path/to/backend
xacpx workspace add backend

cd /absolute/path/to/frontend
xacpx ws add frontend

xacpx ws list
xacpx ws rm frontend
```

注册后，你可以在微信里直接使用：

```text
/ss codex --ws backend
/ss new claude --ws frontend
```

注意：`workspace add` 总是注册**当前终端所在目录**。如果不传名称，会用当前目录名作为 workspace 名称。含空格、中文等字符的名称会被自动规范化为 `[a-zA-Z0-9._-]+`（例如目录 `My Project` 会保存为 `My-Project`），重名时追加 `-2`、`-3`。如需保留原始名称，加 `--raw`；之后 `xacpx workspace rm`、`/ws rm`、`--ws <name>` 都需要用引号引用，例如 `xacpx workspace rm "My Project"`。

## `agent` CLI

`xacpx agent` 用来在电脑本机维护 `~/.xacpx/config.json` 里的 `agents` 配置；`agents` 是同等别名。

| 命令 | 说明 |
|------|------|
| `xacpx agent list` | 列出已注册的 agent |
| `xacpx agent templates` | 列出可添加的内置模板 |
| `xacpx agent add <name>` | 从内置模板添加 agent，例如 `kimi`、`opencode`、`pool` |
| `xacpx agent rm <name>` | 删除指定 agent |

常见用法：

```bash
xacpx agent templates
xacpx agent add kimi
xacpx agents list
xacpx agent rm kimi
```

当前内置模板与 acpx 的 built-in agents 对齐（另含通过 xacpx 内置 ACP shim 启动的 `hermes`，以及通过本地 `<bin> acp` 启动的 `omp` 和 `reasonix`）：

```text
codex, claude, pi, openclaw, gemini, cursor, copilot, droid,
factory-droid, factorydroid, grok-build, hermes, iflow, kilocode,
kimi, kiro, mux, omp, opencode, pool, qoder, qwen, reasonix,
trae, zeroclaw
```

多数模板只写入 `driver`，实际启动命令交给 acpx 解析；例如 `/agent add kimi` 会保存 `{ "driver": "kimi" }`。`hermes` 不在 acpx 注册表中，xacpx 会在启动时注入内置 ACP shim 命令（不会向配置写入额外字段，详见 [config-reference_zh.md](./config-reference_zh.md)）。`omp` 和 `reasonix` 也不在 acpx 注册表中，但它们的本地 CLI 通过 `<bin> acp` 暴露 ACP；当 PATH 上有对应二进制时，xacpx 直接使用它，不走 acpx 的 npx 回退。配置字段见 [config-reference_zh.md](./config-reference_zh.md)。

## `doctor`

```bash
xacpx doctor
xacpx doctor --verbose
xacpx doctor --smoke
xacpx doctor --smoke --agent codex --workspace backend
xacpx doctor --fix
```

说明：

- `--verbose` 会展开每项检查的细节
- `--smoke` 会额外执行一次真实 transport 级别的最小 prompt 检查
- `--agent` / `--workspace` 只影响 `--smoke`
- 如果不传 `--smoke`，相关检查会显示为 `SKIP`
- `--fix` 会执行安全的本地修复（运行时目录权限、残留锁、无效 state 记录）并重新检查；daemon 运行期间会扣留改动状态的修复，详见 [doctor-command_zh.md](./doctor-command_zh.md)

## `update`

`xacpx update` 用来检查并安装 xacpx 本体以及已安装频道插件的新版本。

```bash
xacpx update            # 交互式：选择要更新的项
xacpx update --all      # 非交互式更新全部（本体 + 所有插件）
xacpx update <name>     # 更新单个目标（本体，或某个具体插件包）
```

说明：

- 安装了插件时，直接运行 `xacpx update` 会进入交互模式，让你选择要更新哪些目标。
- 在非交互环境下，更新本体或插件需要显式确认：用 `xacpx update --all`，或用 `xacpx update <name>` 指定目标。
- `update` 覆盖本体包和频道插件；如果想直接管理单个插件的版本，见 `xacpx plugin update <name>`（[plugin-development_zh.md](./plugin-development_zh.md)）。
- 更新后运行 `xacpx restart`，让正在运行的 daemon 加载新版本。
- 跨包改名迁移：本项目已由 `weacpx` 改名为 `xacpx`。如果你仍装着旧的 `weacpx` 包，运行 `weacpx update` 会提示自动迁移到 `xacpx`（由你确认切换）。已经在用 `xacpx`？直接用 `xacpx update` 做普通的本体自更新即可。
