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
| `xacpx adapter list\|check [codex\|claude]` | 查看生效的受管 ACP adapter 版本，可选与 npm 对比 |
| `xacpx adapter update <codex\|claude>` / `xacpx adapter update --all` | 校验并把最新的已发布 adapter 版本保存到本地 |
| `xacpx adapter set <codex\|claude> <version>` / `reset <codex\|claude>` | 校验一个精确版本覆盖，或回到本 xacpx 版本测试过的默认值 |
| `xacpx adapter registry [set <url>\|reset]` | 查看、更改或重置仅用于受管 adapter 的 npm registry |
| `xacpx adapter preinstall <codex\|claude> [version]` | 可选地预安装一个不可变的本地 adapter release，并原子切换 active pointer |
| `xacpx adapter list --installed` | 列出本地 adapter release 与当前 active release |
| `xacpx adapter uninstall <codex\|claude> <release-id>` | 删除非 active、无引用的 release；引用读取不确定时拒绝删除 |
| `xacpx orphans kill --confirm` | 人工确认后，按 fail-closed 规则尝试清理耐久的 Windows orphan 记录 |
| `xacpx session inspect <alias>` | 查看物理 worker fence、generation、containment 以及共享它的别名 |
| `xacpx session recover <alias> --expected-generation <generation> [--accept-legacy-orphan-risk]` | 在核查所有权证据后恢复离线的 worker fence |
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

## `session` 恢复 CLI

```bash
xacpx session inspect backend
xacpx session recover backend --expected-generation <generation-from-inspect>
xacpx session recover backend --expected-generation <generation-from-inspect> --accept-legacy-orphan-risk
```

恢复前先停止正在运行的前台或后台 runtime。`recover` 会持有 runtime consumer lock，当另有 runtime 持有它时拒绝执行。`inspect` 是时间点读取。两条命令都通过配置的 session transport 解析别名，并显示物理 fence key 以及共享该 fence 的其他别名；恢复作用于那个共享的物理目标。

恢复要求精确的被 inspect 的 generation 和已证明消失的 worker 身份，包括已 discharge 和已 spool 的 fence。已 spool 的 fence 还要求残留记录可读，且该 generation 没有待处理的记录。任何携带 Job 证据的 Windows fence 都要求规范代（canonical generation）的 Job 为空或不存在，且 supervisor 可证明已消失；已 attest 的 admitted fence 还要求其 worker 已消失。supervisor 只有在宿主持久化其出生记录之后才被授权创建 Job，因此没有记录 supervisor 的声明不可能执行过任何操作，而仍然存活的已记录 supervisor 即使 Job 不存在也会阻止恢复。活跃或未知的证据会拒绝恢复。恢复仅限 Windows：POSIX runtime 通过进程组门（process-group gate）discharge 其 fence。没有 Job 名的声明保持仅自动（automatic-only）。

当 runtime 在线时不需要这个 CLI：在线 delete/close 路径会从 quiescence 探针应用同样的证明并自行 discharge fence——对已证明消失的所有者，陈旧的 `claiming`/`owned` fence 会被处理；一旦 supervisor 可证明消失且该代的 Job 为空或不存在，陈旧的 `admitted` fence 也会被处理（已 attest 的记录还需要其 worker 出生记录消失）。活跃、未知或无 Job 证据的记录在那里继续被拒绝，这时才轮到 `recover` 上场。

没有 Job 证据的遗留 admitted fence 需要 `--accept-legacy-orphan-risk`、已证明消失的 worker 身份和可读且无待处理的残留记录。这明确接受了后代进程比记录的 worker 活得更久的风险。该标志不会覆盖活跃 worker、未知身份、畸形的残留证据或不完整的 Job 遏制证明。

这些命令使用 runtime 的常规 fence 目录设置。`--fence-dir <path>` 覆盖 fence 目录；`--durable-dir <path>` 选择其 `worker-fences` 子目录。恢复在改动 fence 前会写一份保留 fence 字节的独占备份和一个单独的 JSON 审计文件。审计先记录一次尝试，只在成功退役后才记录 `applied`。两个文件都保留以备诊断。

## `workspace` CLI

`xacpx workspace` 用来在电脑本机维护 `~/.xacpx/config.json` 里的 `workspaces` 配置。它适合先在终端里注册常用项目目录，然后在微信里用 `--ws <name>` 直接引用。

| 命令 | 说明 |
|------|------|
| `xacpx workspace list` | 列出已注册的 workspace 及其路径 |
| `xacpx workspace add` | 把当前目录注册为 workspace，名称默认取当前目录名（自动规范化） |
| `xacpx workspace add <name>` | 把当前目录注册为指定名称（含特殊字符时自动规范化） |
| `xacpx workspace add [name] --raw` | 保留原始名称（含空格等），后续命令需要用引号引用 |
| `xacpx workspace rm <name>` | 删除指定 workspace（daemon 运行时拒绝执行） |

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

如果一个非空名称在规范化后丢掉了所有字符（例如 `测试项目`），它生成的名称是 `workspace-<8hex>`，由修剪后的原始输入一致地派生。不同的名称仍可能碰撞，因此既有的数字后缀分配规则同样适用。已注册的 workspace 名称和目录路径不会被重命名。

`workspace rm` 在 xacpx daemon 运行中（或状态不确定时）会拒绝执行。daemon 持有自己的配置快照和会话绑定，而这个终端 CLI 没有可用的 control IPC 删除工作区，直接改 `config.json` 会与进行中的委派竞态。请改用控制台 `/workspace rm` 或 Control API，或先执行 `xacpx stop`。即使 daemon 已停止，如果 `state.json` 仍有 session 或 worker binding 引用该工作区，也会拒绝；请先通过 daemon 移除这些记录。

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

当前内置模板与 acpx 的 built-in agents 对齐（另含通过 xacpx 内置 ACP shim 启动的 `hermes`）：

```text
codex, claude, ante, pi, openclaw, gemini, cursor, copilot, droid,
deepseek-harness, factory-droid, factorydroid, goose, grok-build,
hermes, iflow, kilocode, kimi, kiro, mcode, mux, octomind, omp,
opencode, pool, qoder, qwen, reasonix, trae, zeroclaw
```

多数模板只写入 `driver`。受管的 `codex` 和 `claude` adapter 由 xacpx 提供精确的 npx pin；其他启动命令走正常的 runtime/acpx 解析路径。例如 `/agent add kimi` 会保存 `{ "driver": "kimi" }`。`hermes` 不在 acpx 注册表中，xacpx 会在启动时注入内置 ACP shim 命令（不会向配置写入额外字段，详见 [config-reference_zh.md](./config-reference_zh.md)）。`omp` 和 `reasonix` 也不在 acpx 注册表中，但它们的本地 CLI 通过 `<bin> acp` 暴露 ACP；当 PATH 上有对应二进制时，xacpx 直接使用它，不走 acpx 的 npx 回退。配置字段见 [config-reference_zh.md](./config-reference_zh.md)。

## `adapter` CLI

Codex 和 Claude adapter 在运行时通过 npm 的 exec cache 下载，因此不会增加 xacpx 安装后的依赖体积。尽管如此，xacpx 仍为每个包持有一个经过测试的确切默认版本，而不是接受 acpx 的浮动范围。

```bash
xacpx adapter list                 # 仅本地；不请求 registry
xacpx adapter check               # 用 npm latest 对比两个生效 pin
xacpx adapter check codex
xacpx adapter update codex        # 通过 ACP initialize 探针后采用 latest
xacpx adapter update --all        # 所有探针通过后才写入一次配置
xacpx adapter set codex 1.1.2     # 仅精确 semver；保存前先校验
xacpx adapter reset codex         # 删除本地覆盖；使用 release 默认值
xacpx adapter registry            # 查看生效的 registry 及其来源
xacpx adapter registry set https://npm.company.example/repository/npm-group/
xacpx adapter registry reset      # 回到公共 npm registry
```

`set` 和 `update` 使用包/二进制允许列表和结构化进程参数。候选版本必须在 npm 中存在，并能应答一个真实的 ACP protocol-version-1 `initialize` 请求，然后才会写入 `transport.adapterVersions`。如果任何 `update --all` 探针失败，它的候选版本都不会被保存。变更不会在 daemon 启动时自动应用；成功变更后，运行 `xacpx restart`。

adapter registry 默认为 `https://registry.npmjs.org/`，独立于机器上的通用 npm registry 和已有的 `@agentclientprotocol:registry` scope 映射。它被一致地用于最新版本查询、精确版本检查、验证下载和运行时 `npx` 启动。只有当你的公司 registry 代理或托管 `@agentclientprotocol/codex-acp` 和 `@agentclientprotocol/claude-agent-acp` 时才设置它。registry 认证保持在 npm 的 scoped `.npmrc` 中；URL 里的凭据会被拒绝。

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
