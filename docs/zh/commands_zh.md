# 微信命令参考

这篇文档列出你可以在微信里发送给 `xacpx` 的命令。README 只保留常用入口；如果你想查完整命令、别名和参数格式，看这篇。

## 阅读约定

- `<value>` 表示必填参数，例如 `<agent>`。
- `a | b` 表示二选一。
- 命令支持用引号包住带空格的值，例如 `/ws new backend -d "/Users/me/my repo"`。
- 非 `/` 开头的文本不是命令，会直接发送到当前会话。
- `/ss` 是 `/session` 的别名，`/ws` 是 `/workspace` 的别名，`/pm` 是 `/permission` 的别名，`/stop` 是 `/cancel` 的别名，`/lt` 是 `/later` 的别名。

## 快速索引

| 你想做什么 | 命令入口 |
|------------|----------|
| 查看帮助 | `/help`、`/help <topic>` |
| 管理 agent | `/agents`、`/agent ...` |
| 管理工作区 | `/workspaces`、`/workspace ...`、`/ws ...` |
| 管理会话 | `/sessions`、`/session ...`、`/ss ...`、`/use ...` |
| 接入本地 Agent 原生会话 | `/ssn ...`、`/ss attach native ...` |
| 调整回复方式 | `/replymode ...` |
| 调整 acpx mode | `/mode ...` |
| 取消当前任务 | `/cancel`、`/stop` |
| 修改配置 | `/config ...` |
| 修改权限策略 | `/permission ...`、`/pm ...` |
| 委派子任务 | `/delegate ...`、`/dg ...` |
| 管理任务组 | `/groups`、`/group ...` |
| 管理编排任务 | `/tasks`、`/task ...` |
| 定时任务 | `/later ...`、`/lt ...` |

## 帮助

| 命令 | 说明 |
|------|------|
| `/help` | 查看帮助主题列表和常用入口 |
| `/help <topic>` | 查看某个主题的命令说明 |

常用主题包括：`agent`、`workspace`、`session`、`native`（或 `ssn`）、`replymode`、`mode`、`status`、`cancel`、`config`、`permission`、`orchestration`。

示例：

```text
/help
/help ss
/help ssn
/help pm
/help orchestration
```

## Agent 管理

Agent 是你要驱动的底层工具配置，例如 `codex`、`claude`、`kimi`。

| 命令 | 说明 |
|------|------|
| `/agents` | 查看已注册的 agent |
| `/agent add <codex|claude|pi|openclaw|gemini|cursor|copilot|droid|factory-droid|factorydroid|grok-build|hermes|iflow|kilocode|kimi|kiro|mux|opencode|qoder|qwen|trae>` | 添加一个内置 agent 模板；已存在且配置不同的同名 agent 不会被覆盖 |
| `/agent rm <name>` | 删除一个 agent |

示例：

```text
/agent add codex
/agent add claude
/agent add kimi
/agents
/agent rm claude
```

## Workspace 管理

Workspace 是你电脑上的项目目录。建议使用绝对路径。

| 命令 | 说明 |
|------|------|
| `/workspaces` | 查看已注册的 workspace |
| `/workspace` / `/ws` | `/workspaces` 的常用别名 |
| `/workspace new <name> --cwd <path> [--raw]` | 添加 workspace；含空格/中文等特殊字符的名称会被自动规范化 |
| `/ws new <name> -d <path> [--raw]` | 添加 workspace 的短写法 |
| `/workspace rm <name>` | 删除 workspace |

示例：

```text
/ws new backend -d /Users/me/projects/backend
/workspaces
/workspace rm backend
```

> 名称会被规范化为 `[a-zA-Z0-9._-]+`：空格、中文、其他符号会替换成 `-`，重名时自动追加 `-2`、`-3`。如需保留含特殊字符的原始名称，加 `--raw`，例如：
>
> ```text
> /ws new "My Project" -d /Users/me/projects/my-project --raw
> ```
>
> 使用 `--raw` 后续命令需要用引号：`/ws rm "My Project"`、`/ss codex --ws "My Project"`。

## Session 会话

Session 是你在微信里操作的逻辑会话。每个会话绑定一个 agent 和一个 workspace。

### 查看、创建、切换

| 命令 | 说明 |
|------|------|
| `/sessions` | 查看会话列表 |
| `/session` / `/ss` | 查看会话列表 |
| `/ss <agent> -d <path>` | 用本地路径创建或复用会话 |
| `/ss <agent> --ws <workspace>` | 用已有 workspace 创建或复用会话 |
| `/ss new <agent> -d <path>` | 强制创建一个新会话 |
| `/ss new <agent> --ws <workspace>` | 用已有 workspace 强制创建一个新会话 |
| `/session new <alias> --agent <agent> --ws <workspace>` | 用指定别名创建会话 |
| `/session new <alias> -a <agent> --ws <workspace>` | 指定别名创建会话的短写法 |
| `/use <alias>` | 切换当前会话 |
| `/use <片段>` | 按别名片段切换：精确 > 前缀 > 子串；多命中会列出候选让你再选 |
| `/use -` | 在当前会话和上一个会话之间切换（像 shell 的 `cd -`） |
| `/session rm <alias>` | 删除逻辑会话 |

切换成功会回显当前身份，例如 `已切到 api-review · codex · backend（上一个：frontend-fix）`，不用再记别名或序号。

**实时切换与后台执行**：任务进行中也能立即 `/use` 切走。被切走的会话会在后台继续执行，但它的中间输出不再发到当前聊天；不同会话的任务并行执行，互不阻塞（切到的会话可以马上正常用）。

- 后台会话任务完成时，当前聊天会收到一条简短提醒：`✅ <alias> 已完成，/use <alias> 查看结果`（失败为 `⚠️ <alias> 失败，/use <alias> 查看详情`）。
- `/sessions` 列表里，有未读结果的会话会以 `●` 标记。
- 切回该会话时会补发它的**最终结果**（中间过程不补发），并清除未读标记；若它仍在执行，会提示 `⏳ <alias> 仍在执行中…`。

> **飞书（Feishu）的差异（B 语义）**：被切走的会话有自己独立的流式卡片，它会在聊天时间线里**继续流式刷新到完成**（不像微信那样把中间输出闸到当前会话）。因此切回时**不补发**最终结果——结果早已停留在那张卡片上。完成提醒也更短：`✅ <alias> 已完成` / `⚠️ <alias> 失败`（不带 `/use 查看结果`）。`/sessions` 列表的 `●` 未读标记仍然适用。

示例：

```text
/ss codex -d /Users/me/projects/backend
/ss claude --ws backend
/ss new codex -d /Users/me/projects/frontend
/session new api-review --agent codex --ws backend
/use api-review
/use api          # 片段匹配：唯一命中 api-review 即切换；多命中会列候选
/use -            # 切回上一个会话
/session rm old-review
```

### 绑定已有底层会话

如果底层 `acpx` 会话已经存在，可以把它挂回微信里的逻辑会话。

| 命令 | 说明 |
|------|------|
| `/session attach <alias> --agent <agent> --ws <workspace> --name <transport-session>` | 绑定已有底层会话 |
| `/ss attach <alias> -a <agent> --ws <workspace> --name <transport-session>` | 短写法 |

示例：

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

### 接入本地 native 会话（Codex 等 Agent 原生会话）

`/ss` 管 xacpx 逻辑会话；`/ssn` 管本地 native 会话。普通 `/ss codex --ws project` 不会自动枚举或接入新的 native 会话；通过 `/ssn` 接入后，会生成普通 xacpx 逻辑会话别名（例如 `codex-e8e552e7`），后续可在 `/ss` 列表里看到，并用 `/session use <alias>` 切回。

裸 `/ssn` 会直接使用当前会话上下文；如果当前没有选中的会话，请改用 `/ssn codex --ws project` 或 `/ssn codex -d /Users/me/project` 先指定上下文。更完整的使用流程、`--all`、别名和排障见 [native-sessions.md](./native-sessions_zh.md)。聊天内精简帮助可用 `/help ssn`。

| 命令 | 说明 |
|------|------|
| `/ssn` | 查看当前上下文的本地 native 会话 |
| `/ssn codex --ws project` | 查询 project 工作区的本地 Codex 会话；只有一个候选时直接接入 |
| `/ssn codex -d /Users/me/project` | 按路径查询本地 Codex 会话；只有一个候选时直接接入 |
| `/ssn codex --ws project --all` | 跨 cwd 查询该 agent 的 native 会话 |
| `/ssn 1` | 接入或切换到最近一次列表的第 1 个 native 会话 |
| `/ssn 1 -a fix-ci` | 选列表第 N 个候选并指定 xacpx 别名（微信里看不到完整 id 时用） |
| `/ssn attach <sessionId> -a fix-ci` | 用指定 xacpx 别名接入 native 会话（适合已知完整 id） |
| `/ss attach native <sessionId> -a fix-ci` | 上一条的长写法 |

示例：

```text
/ssn codex --ws project
/ssn 1
/ssn codex -d /Users/me/project
/ssn attach 019e5d48 -a fix-ci
```

### 状态、重置、取消

| 命令 | 说明 |
|------|------|
| `/status` | 查看当前会话状态 |
| `/session tail [N]` | 补拉当前会话最近 N 行历史（默认 50，上限 500） |
| `/session reset` | 重置当前会话上下文 |
| `/clear` | `/session reset` 的别名 |
| `/cancel [alias]` / `/stop [alias]` | 不带参数取消当前前台会话的在跑任务；带 alias 取消指定（含后台）会话的任务。 |

## 普通消息

只要消息不是 `/` 开头，`xacpx` 就会把它发送到当前会话。

```text
请阅读当前仓库，找出最近测试失败的根因
```

如果还没有当前会话，先执行 `/ss ...` 或 `/use ...`。

## 回复模式

回复模式控制微信里看到多少输出。

| 命令 | 说明 |
|------|------|
| `/replymode` | 查看全局默认、当前会话覆盖和实际生效值 |
| `/replymode stream` | 流式返回中间文本 |
| `/replymode verbose` | 流式返回，并显示工具调用摘要 |
| `/replymode final` | 只发送最终文本 |
| `/replymode reset` | 清除当前会话覆盖，回到全局默认 |

建议：

- 日常开发用 `stream`。
- 想看 agent 在做什么，用 `verbose`。
- 只想少收消息，用 `final`。

## acpx mode

`/mode` 直接传给底层 agent。可用值取决于你使用的 agent。

| 命令 | 说明 |
|------|------|
| `/mode` | 查看当前会话保存的 mode |
| `/mode <id>` | 设置当前会话 mode |

示例：

```text
/mode
/mode plan
```

已知常见值：

- `codex`: `plan`
- `cursor`: `agent`、`plan`、`ask`

## 配置

`/config` 只允许修改白名单里的配置项。完整配置字段说明见 [config-reference.md](./config-reference_zh.md)，微信内配置命令说明见 [config-command.md](./config-command_zh.md)。

| 命令 | 说明 |
|------|------|
| `/config` | 查看支持修改的配置路径 |
| `/config set <path> <value>` | 修改一个支持的配置值 |

当前支持的路径：

- `language`
- `transport.type`
- `transport.command`
- `transport.sessionInitTimeoutMs`
- `transport.permissionMode`
- `transport.nonInteractivePermissions`
- `transport.permissionPolicy`
- `logging.level`
- `logging.maxSizeBytes`
- `logging.maxFiles`
- `logging.retentionDays`

说明：性能 debug 日志 `logging.perf.*` 目前不在 `/config set` 白名单内；请直接编辑 `~/.xacpx/config.json`，并重启 daemon 后生效。详见 [config-reference.md](./config-reference_zh.md#loggingperf)。

- `channel.replyMode`
- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

示例：

```text
/config set channel.replyMode final
/config set logging.level debug
/config set transport.sessionInitTimeoutMs 30000
```

## 权限策略

权限策略影响底层 agent 能不能自动执行读写操作。

| 命令 | 实际配置值 | 说明 |
|------|------------|------|
| `/pm` / `/permission` | - | 查看当前权限策略 |
| `/pm set allow` | `approve-all` | 允许更多操作自动通过 |
| `/pm set read` | `approve-reads` | 自动允许读操作，写操作仍更谨慎 |
| `/pm set deny` | `deny-all` | 默认拒绝需要审批的操作 |
| `/pm auto` | - | 查看非交互权限策略 |
| `/pm auto deny` | `deny` | 非交互场景自动拒绝 |
| `/pm auto fail` | `fail` | 非交互场景直接失败 |

示例：

```text
/pm
/pm set read
/pm auto deny
```

## 多 Agent 编排

编排命令需要先有当前会话。当前会话会作为主控会话，子任务会派给其他 agent 会话执行。

如果你还不确定什么时候该用 delegate、什么时候该开 group，先看 [xacpx-group-usage-guide.md](./xacpx-group-usage-guide_zh.md)。

### 委派单个子任务

| 命令 | 说明 |
|------|------|
| `/dg <agent> <task>` | 快速委派一个子任务 |
| `/delegate <agent> <task>` | 委派一个子任务 |
| `/delegate <agent> --role <role> <task>` | 按指定角色模板委派 |
| `/delegate <agent> --group <groupId> <task>` | 把委派任务加入已有任务组 |
| `/delegate <agent> --role <role> --group <groupId> <task>` | 同时指定角色和任务组 |

示例：

```text
/dg claude 审查当前方案的 3 个最高风险点
/delegate codex --role planner 把这个需求拆成最小实现步骤
/delegate claude --group review-batch 审查接口设计
```

### 管理任务组

Group 适合把多个相互独立的子任务并行派出去，再统一查看进展。

| 命令 | 说明 |
|------|------|
| `/group new <title>` | 创建任务组 |
| `/groups` | 查看任务组列表 |
| `/groups --status <pending|running|terminal>` | 按状态过滤任务组 |
| `/groups --stuck` | 只看疑似卡住的任务组 |
| `/groups --sort <updatedAt|createdAt>` | 设置排序字段 |
| `/groups --order <asc|desc>` | 设置排序方向 |
| `/group <id>` | 查看单个任务组详情 |
| `/group add <groupId> <agent> <task>` | 往任务组里添加子任务 |
| `/group add <groupId> <agent> --role <role> <task>` | 按角色模板往任务组里添加子任务 |
| `/group cancel <groupId>` | 取消组内所有未结束任务 |

示例：

```text
/group new review-batch
/group add review-batch claude 审查接口设计
/group add review-batch codex --role reviewer 审查测试覆盖
/groups --status running --sort updatedAt --order desc
/group review-batch
/group cancel review-batch
```

当前版本没有 `/group delete`。如果你只想停止组内未结束任务，用 `/group cancel <groupId>`；如果你想清理已结束的任务，用 `/tasks clean`。

### 管理编排任务

| 命令 | 说明 |
|------|------|
| `/tasks` | 查看当前主控会话下的任务列表 |
| `/tasks --status <state>` | 按任务状态过滤 |
| `/tasks --stuck` | 只看心跳超时的 running 任务 |
| `/tasks --sort <updatedAt|createdAt>` | 设置排序字段 |
| `/tasks --order <asc|desc>` | 设置排序方向 |
| `/tasks clean` | 清理当前主控会话下已结束的任务和无效绑定 |
| `/task <id>` | 查看单个任务详情 |
| `/task approve <id>` | 批准一个 `needs_confirmation` 任务 |
| `/task reject <id>` | 拒绝一个 `needs_confirmation` 任务 |
| `/task cancel <id>` | 取消一个任务 |

`/tasks --status` 当前支持：

- `pending`
- `needs_confirmation`
- `running`
- `completed`
- `failed`
- `cancelled`

示例：

```text
/tasks
/tasks --status running --sort updatedAt --order desc
/tasks --stuck
/task task_123
/task approve task_123
/task cancel task_456
/tasks clean
```

## 定时任务

`/later`（别名 `/lt`）用于创建、查看和取消一次性定时任务。默认临时会话执行；`--bind` 绑定当前会话。

> 完整时间格式、任务状态与投递可达性等详解见 [later-command.md](./later-command_zh.md)。

### 创建定时任务

| 命令 | 说明 |
|------|------|
| `/lt <time> <message>` | 创建一次性定时任务（临时会话执行） |
| `/lt --bind <time> <message>` | 创建定时任务并绑定当前会话执行 |
| `/lt --temp <time> <message>` | 显式指定临时会话（当默认被改为 bind 时使用） |
| `/later <time> <message>` | 同 `/lt`（全名，支持相同标志） |

支持的时间格式：

| 格式 | 示例 |
|------|------|
| 相对时间（英文） | `/lt in 2h 检查 CI`、`/lt in 30m 总结`、`/lt in 1d 复查` |
| 相对时间（中文） | `/lt 30分钟后 总结进展`、`/lt 2小时后 检查`、`/lt 1天后 复查` |
| 指定日期词 | `/lt today 21:30 继续处理`、`/lt tomorrow 09:00 看 PR`、`/lt 明天 09:00 看 PR` |
| 星期几 | `/lt 周五 09:00 继续处理`、`/lt friday 09:00 看 PR` |

更多示例：

```text
/lt in 2h 检查 CI
/lt 30分钟后 总结进展
/lt tomorrow 09:00 看 PR
/lt 周五 09:00 继续处理
```

### 查看和取消

| 命令 | 说明 |
|------|------|
| `/lt list` | 查看待执行的定时任务 |
| `/lt cancel <id>` | 取消待执行定时任务 |

```text
/lt list
/lt cancel #k8f2
```

### 限制说明

- 只支持**一次性**任务，不支持重复执行。
- 定时时间必须在 **10 秒之后、7 天之内**。
- 默认在临时会话执行，加 `--bind` 改为绑定当前会话执行；默认模式可用 `later.defaultMode` 配置。
- `/lt list` 显示的是**全局**待执行任务，不限于当前会话。
- 取消操作遵循**受信渠道模型**：在群聊中只有群主可以取消。
- **不支持**延迟执行 `/` 开头的 xacpx 命令（例如 `/lt in 1h /status` 会被拒绝）。如果你需要 agent 讨论某条命令，请用普通句子描述。
- 触发通知和 agent 回复复用现有**频道路由**，微信回复额度由现有路由控制。

### 帮助

```text
/help later
```

## 群聊权限

群聊中，只有只读命令（`/help`、`/status`、`/sessions`、`/config` 等）和普通对话对所有成员开放；控制类命令（`/clear`、`/use`、`/session new`、`/mode`、`/permission`、`/later` 控制命令等）仅限会话 owner 使用：

- 协议会上报群角色的频道自动授予 owner（如元宝会识别机器人创建者）。
- 微信协议**不携带群角色信息**，需要把自己的发送者 id 配置进 `channel.ownerIds`（或 `channels[].ownerIds`）来给自己授权，见 [config-reference — `channel.ownerIds`](./config-reference_zh.md#channelownerids)。命令被拒绝时，`~/.xacpx/runtime/app.log` 中 `command.blocked` 日志条目里的 `senderId` 字段就是你的发送者 id。
- 如果频道没有上报会话类型（直聊/群聊），控制类命令会被直接拒绝（fail closed），并记录 `channel.chat_type_missing` 告警日志。

## 常见错误

### 命令被当成普通消息

只有已识别的 `/` 命令才会被解析。未知命令会作为普通文本发送给当前会话。

### 已识别命令返回参数错误

如果命令前缀是已识别的，例如 `/session`、`/group`、`/task`，但参数不匹配，`xacpx` 会返回命令格式错误。优先用 `/help <topic>` 查对应主题。

### 创建会话失败

优先检查三件事：

1. workspace 路径在运行 `xacpx` 的电脑上存在。
2. agent 已注册，可以用 `/agents` 查看。
3. 底层 agent 命令本身可运行。

如果已有底层会话，可以用 `/session attach ...` 绑定回来。
