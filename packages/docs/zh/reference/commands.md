# 命令参考

本页列出所有可从聊天频道（微信、飞书、元宝或插件频道）发送给 xacpx 的命令。日常使用的核心命令请参阅 README；若需完整命令列表、别名及参数格式，请阅读本页。

> 想找终端里的 `xacpx` 命令（`start`、`update`、`plugin`、`channel`、`doctor` 等）？见 [CLI 命令](/zh/reference/cli)。

## 命令语法

- `<value>` 表示必填参数。
- `a | b` 表示在两个值之间二选一。
- 含有空格的值需用引号包裹：`/ws new backend -d "/Users/me/my repo"`。
- 任何**不以** `/` 开头的消息均会作为普通提示词转发给当前会话。
- **别名：** `/ss` = `/session`，`/ws` = `/workspace`，`/pm` = `/permission`，`/stop` = `/cancel`，`/lt` = `/later`，`/dg` = `/delegate`。

## 会话命令

会话是将代理、工作区和聊天上下文绑定在一起的逻辑单元。

### 列表、创建与切换

| 命令 | 说明 |
|------|------|
| `/sessions` 或 `/session` 或 `/ss` | 列出所有会话 |
| `/ss <agent> -d <path>` | 使用本地路径创建或复用会话 |
| `/ss <agent> --ws <workspace>` | 使用已注册工作区创建或复用会话 |
| `/ss new <agent> -d <path>` | 强制使用本地路径创建新会话 |
| `/ss new <agent> --ws <workspace>` | 强制使用已注册工作区创建新会话 |
| `/session new <alias> --agent <agent> --ws <workspace>` | 创建带有显式别名的会话 |
| `/session new <alias> -a <agent> --ws <workspace>` | 上述命令的简写形式 |
| `/use <alias>` | 按别名切换到指定会话 |
| `/use <fragment>` | 按别名片段切换（精确匹配 → 前缀匹配 → 子串匹配；有歧义时列出候选项） |
| `/use -` | 在当前会话与上一个会话之间切换（类似 shell 中的 `cd -`） |
| `/session rm <alias>` | 删除逻辑会话 |

切换成功后会回显新身份，例如：  
`Switched to api-review · codex · backend (previous: frontend-fix)`

**实时切换与后台执行：** 任何时候都可以使用 `/use` 切换到其他会话，即使当前任务正在执行中。被切换走的会话将在后台继续执行，其中间输出不会转发到当前聊天。不同会话中的任务并行运行，互不阻塞。

- 后台会话完成后，当前聊天会收到简短通知：`✅ <alias> done — /use <alias> to see result`（或 `⚠️ <alias> failed — /use <alias> for details`）。
- 在 `/sessions` 中，有未读结果的会话会以 `●` 标记。
- 切换回该会话时会回放**最终结果**（中间输出不会回放），并清除未读标记。若任务仍在运行，则显示 `⏳ <alias> still running…`。

> **飞书差异（流式卡片语义）：** 被切换走的会话拥有独立的流式卡片，该卡片会在聊天时间线中持续更新直到完成。切换回该会话时**不会**回放最终结果——结果已在卡片中可见。完成通知更简短：`✅ <alias> done` / `⚠️ <alias> failed`。`/sessions` 中的 `●` 未读标记仍然适用。

```text
/ss codex -d /Users/me/projects/backend
/ss claude --ws backend
/ss new codex -d /Users/me/projects/frontend
/session new api-review --agent codex --ws backend
/use api-review
/use api          # 片段匹配：唯一匹配 api-review
/use -            # 切换回上一个会话
/session rm old-review
```

### 附接到已有的传输层会话

若传输层已存在 `acpx` 会话，可将其附接到逻辑会话：

| 命令 | 说明 |
|------|------|
| `/session attach <alias> --agent <agent> --ws <workspace> --name <transport-session>` | 附接已有传输层会话 |
| `/ss attach <alias> -a <agent> --ws <workspace> --name <transport-session>` | 简写形式 |

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

### 原生代理会话（`/ssn`）

`/ssn` 将本地运行的原生代理会话（如 Codex）附接到 xacpx，结果是一个带有自动生成别名（如 `codex-e8e552e7`）的标准 xacpx 逻辑会话，之后会出现在 `/ss` 列表中。

裸命令 `/ssn` 使用当前会话上下文；若未选中任何会话，请显式指定上下文。

| 命令 | 说明 |
|------|------|
| `/ssn` | 列出当前上下文的原生会话 |
| `/ssn codex --ws project` | 列出 `project` 的 Codex 原生会话；若只有一个候选则直接附接 |
| `/ssn codex -d /Users/me/project` | 同上，按路径指定 |
| `/ssn codex --ws project --all` | 列出所有工作目录下的会话 |
| `/ssn 1` | 附接或切换到上次列表中的第 1 项 |
| `/ssn 1 -a fix-ci` | 以自定义 xacpx 别名附接第 N 项 |
| `/ssn attach <sessionId> -a fix-ci` | 以完整会话 ID 和自定义别名附接 |
| `/ss attach native <sessionId> -a fix-ci` | 上述命令的完整形式 |

```text
/ssn codex --ws project
/ssn 1
/ssn attach 019e5d48 -a fix-ci
```

### 状态、重置与取消

| 命令 | 说明 |
|------|------|
| `/status` | 显示当前会话状态 |
| `/session tail [N]` | 回放最后 N 行历史记录（默认 50，最大 500） |
| `/session reset` | 重置当前会话上下文 |
| `/clear` | `/session reset` 的别名 |
| `/cancel [alias]` 或 `/stop [alias]` | 取消正在运行的任务；不带别名时取消当前前台会话；带别名时可取消包括后台会话在内的任意会话 |

## 代理命令

代理是底层工具（如 `codex`、`claude`、`kimi`）的命名配置。

| 命令 | 说明 |
|------|------|
| `/agents` | 列出已注册的代理 |
| `/agent add <name>` | 添加内置代理模板；不会覆盖已有不同配置的同名代理 |
| `/agent rm <name>` | 删除代理 |

内置模板名称：`codex`、`claude`、`pi`、`openclaw`、`gemini`、`cursor`、`copilot`、`droid`、`factory-droid`、`factorydroid`、`grok-build`、`iflow`、`kilocode`、`kimi`、`kiro`、`mux`、`omp`、`opencode`、`qoder`、`qwen`、`reasonix`、`trae`。

```text
/agent add codex
/agent add claude
/agent add kimi
/agents
/agent rm claude
```

## 工作区命令

工作区将短名称映射到运行 xacpx 的机器上的绝对目录路径。

| 命令 | 说明 |
|------|------|
| `/workspaces` 或 `/workspace` 或 `/ws` | 列出已注册工作区 |
| `/workspace new <name> --cwd <path> [--raw]` | 添加工作区 |
| `/ws new <name> -d <path> [--raw]` | 简写形式 |
| `/workspace rm <name>` | 删除工作区 |

名称会被规范化为 `[a-zA-Z0-9._-]+`：空格、CJK 字符及其他符号替换为 `-`；重复名称获得 `-2`、`-3` 后缀。使用 `--raw` 可保留名称原样：

```text
/ws new "My Project" -d /Users/me/projects/my-project --raw
```

使用 `--raw` 后，后续命令中需对名称加引号：`/ws rm "My Project"`、`/ss codex --ws "My Project"`。

```text
/ws new backend -d /Users/me/projects/backend
/workspaces
/workspace rm backend
```

## 频道命令

回复模式控制向聊天频道发送多少输出内容。

| 命令 | 说明 |
|------|------|
| `/replymode` | 显示全局默认值、当前会话覆盖值及实际生效值 |
| `/replymode stream` | 流式传输中间文本 |
| `/replymode verbose` | 流式传输中间文本并显示工具调用摘要 |
| `/replymode final` | 仅发送最终文本 |
| `/replymode reset` | 清除当前会话覆盖值；恢复为全局默认值 |

建议：
- `stream` — 日常开发使用。
- `verbose` — 需要观察代理行为时使用。
- `final` — 希望减少消息数量时使用。

`acpx` 模式直接透传给底层代理，可用值取决于所使用的代理。

| 命令 | 说明 |
|------|------|
| `/mode` | 显示当前会话保存的模式 |
| `/mode <id>` | 为当前会话设置模式 |

已知值：`codex` 支持 `plan`；`cursor` 支持 `agent`、`plan`、`ask`。

## 配置命令

`/config` 提供对一组配置字段白名单的受限写入访问。完整字段参考请见[配置参考](/zh/reference/configuration)。关于 `/config` 命令本身的详细说明，请见 [/config 命令](/zh/reference/config-command)。

| 命令 | 说明 |
|------|------|
| `/config` | 显示可修改的路径列表 |
| `/config set <path> <value>` | 设置支持的配置值 |

当前支持的路径：

**固定字段：**
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
- `channel.replyMode`
- `language`

**动态字段**（目标必须已存在）：
- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

> **注意：** 性能调试日志设置（`logging.perf.*`）不在 `/config set` 白名单中。请直接编辑 `~/.xacpx/config.json` 并重启守护进程使其生效。

> **注意：** `channel.type` 已禁用——通过 `/config set channel.type` 设置会返回错误。该字段仅作为遗留单频道配置保留以向后兼容；多频道场景请使用 `xacpx channel ...`。

```text
/config set channel.replyMode final
/config set logging.level debug
/config set transport.sessionInitTimeoutMs 30000
```

## 权限与模式命令

权限策略控制底层代理能否自动执行读取和写入操作。

| 命令 | 配置值 | 说明 |
|------|--------|------|
| `/pm` 或 `/permission` | — | 显示当前权限策略 |
| `/pm set allow` | `approve-all` | 允许更多操作自动执行 |
| `/pm set read` | `approve-reads` | 自动批准读取；写入更为谨慎 |
| `/pm set deny` | `deny-all` | 拒绝需要审批的操作 |
| `/pm auto` | — | 显示非交互式权限策略 |
| `/pm auto deny` | `deny` | 非交互式场景下自动拒绝 |
| `/pm auto fail` | `fail` | 非交互式场景下立即失败 |

```text
/pm
/pm set read
/pm auto deny
```

## 定时任务命令

`/later`（别名 `/lt`）用于创建、列出和取消一次性定时任务。关于时间格式、任务状态和执行保障的完整说明，请见[定时任务](/zh/guide/scheduled-tasks)。

### 创建

| 命令 | 说明 |
|------|------|
| `/lt <time> <message>` | 调度任务（在临时会话中执行） |
| `/lt --bind <time> <message>` | 调度绑定到当前会话的任务 |
| `/lt --temp <time> <message>` | 显式使用临时会话 |
| `/later <time> <message>` | 与 `/lt` 相同 |

支持的时间格式：

| 格式 | 示例 |
|------|------|
| 相对时间（英文） | `/lt in 2h check CI`、`/lt in 30m summarize`、`/lt in 1d review` |
| 相对时间（中文） | `/lt 30分钟后 summarize progress`、`/lt 2小时后 check` |
| 具体日期 | `/lt today 21:30 continue`、`/lt tomorrow 09:00 check PR`、`/lt 明天 09:00 look at PR` |
| 星期几 | `/lt friday 09:00 check PR`、`/lt 周五 09:00 continue` |

完整的双语时间语法说明，请参阅[定时任务](/zh/guide/scheduled-tasks)。

### 列表与取消

| 命令 | 说明 |
|------|------|
| `/lt list` | 显示所有待执行的定时任务 |
| `/lt cancel <id>` | 取消一个待执行的任务 |

```text
/lt in 2h check CI
/lt tomorrow 09:00 check PR
/lt list
/lt cancel #k8f2
```

### 限制条件

- **仅一次性** — 任务不会重复执行。
- 计划时间必须**至少 10 秒、最多 7 天**后。
- 默认执行模式为临时会话；使用 `--bind` 可绑定当前会话。默认值可通过配置中的 `later.defaultMode` 修改。
- `/lt list` 显示**所有**全局待执行任务，不限于当前会话。
- 取消操作遵循可信频道模型：在群聊中，只有群主才能取消。
- xacpx 命令（以 `/` 开头的消息）**不能**被调度。请用普通句子描述代理应执行的操作。

## 取消命令

| 命令 | 说明 |
|------|------|
| `/cancel` 或 `/stop` | 取消当前前台会话中正在运行的任务 |
| `/cancel <alias>` 或 `/stop <alias>` | 取消任意会话（包括后台会话）中正在运行的任务 |

## 帮助命令

| 命令 | 说明 |
|------|------|
| `/help` | 列出可用的帮助主题和常用入口 |
| `/help <topic>` | 显示某主题的命令 |

常用主题：`agent`、`workspace`、`session`、`native`（或 `ssn`）、`replymode`、`mode`、`status`、`cancel`、`config`、`permission`、`orchestration`、`later`。

```text
/help
/help ss
/help ssn
/help pm
/help orchestration
/help later
```

---

## 多代理编排

编排命令需要一个活跃的当前会话作为协调者，子任务将被分发给其他代理会话。

### 分发单个子任务

| 命令 | 说明 |
|------|------|
| `/dg <agent> <task>` | 快速分发子任务 |
| `/delegate <agent> <task>` | 分发子任务 |
| `/delegate <agent> --role <role> <task>` | 使用角色模板分发 |
| `/delegate <agent> --group <groupId> <task>` | 分发到已有任务组 |
| `/delegate <agent> --role <role> --group <groupId> <task>` | 同时指定角色和任务组 |

```text
/dg claude review the 3 highest-risk points in the current plan
/delegate codex --role planner break this requirement into minimal implementation steps
/delegate claude --group review-batch review the API design
```

### 管理任务组

任务组可将多个独立的子任务并行扇出，并集中追踪进度。

| 命令 | 说明 |
|------|------|
| `/group new <title>` | 创建任务组 |
| `/groups` | 列出任务组 |
| `/groups --status <pending\|running\|terminal>` | 按状态筛选 |
| `/groups --stuck` | 仅显示疑似卡住的任务组 |
| `/groups --sort <updatedAt\|createdAt>` | 排序字段 |
| `/groups --order <asc\|desc>` | 排序方向 |
| `/group <id>` | 显示单个任务组的详情 |
| `/group add <groupId> <agent> <task>` | 向任务组添加子任务 |
| `/group add <groupId> <agent> --role <role> <task>` | 使用角色模板添加子任务 |
| `/group cancel <groupId>` | 取消任务组中所有未完成的任务 |

没有 `/group delete`。若需停止未完成的任务，使用 `/group cancel <groupId>`；若需清理已完成的任务，使用 `/tasks clean`。

```text
/group new review-batch
/group add review-batch claude review API design
/group add review-batch codex --role reviewer review test coverage
/groups --status running --sort updatedAt --order desc
/group review-batch
/group cancel review-batch
```

### 管理编排任务

| 命令 | 说明 |
|------|------|
| `/tasks` | 列出当前协调者会话下的任务 |
| `/tasks --status <state>` | 按状态筛选 |
| `/tasks --stuck` | 仅显示心跳过期的任务 |
| `/tasks --sort <updatedAt\|createdAt>` | 排序字段 |
| `/tasks --order <asc\|desc>` | 排序方向 |
| `/tasks clean` | 移除已完成的任务和过期绑定 |
| `/task <id>` | 显示单个任务的详情 |
| `/task approve <id>` | 批准处于 `needs_confirmation` 状态的任务 |
| `/task reject <id>` | 拒绝处于 `needs_confirmation` 状态的任务 |
| `/task cancel <id>` | 取消任务 |

`/tasks --status` 支持的状态：`pending`、`needs_confirmation`、`running`、`completed`、`failed`、`cancelled`。

```text
/tasks
/tasks --status running --sort updatedAt --order desc
/tasks --stuck
/task task_123
/task approve task_123
/task cancel task_456
/tasks clean
```
