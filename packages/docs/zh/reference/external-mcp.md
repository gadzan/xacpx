# 外部 MCP 协调者

## 概述

`xacpx mcp-stdio` 是一个标准的 MCP stdio 服务器。外部 MCP 宿主——Codex、Claude Code 等——可连接到它并调用 xacpx 编排工具，如 `delegate_request`、`task_get`、`task_list` 和 `task_watch`。支持 MCP Tasks 的宿主可在 `delegate_request` 和 `task_watch` 上使用原生任务执行：现在发起调用，稍后获取结果。

> **工具名称前缀：** MCP 服务器以 `xacpx` 名称注册。因此工具名称使用前缀 `mcp__xacpx__*`（例如 `mcp__xacpx__delegate_request`、`mcp__xacpx__task_get`）。（v0.8.0 之前该服务器名为 `weacpx`；硬编码了旧前缀 `mcp__weacpx__*` 的宿主需更新为 `mcp__xacpx__*`。）

> **定时任务工具**（`scheduled_create`、`scheduled_list`、`scheduled_cancel`）仅对 xacpx 内部会话可用——它们复用当前的聊天路由和群主鉴权。外部 `mcp-stdio` 服务器不暴露这些工具。

**心智模型：**

- **MCP 宿主 / 当前代理** — 协调者；负责分解任务并读取结果。
- **`xacpx mcp-stdio`** — 将 MCP 工具调用转换为 xacpx 守护进程 RPC 的轻量 stdio 垫片。
- **xacpx 守护进程** — 持有所有编排状态：协调者、任务、工作者绑定。
- **工作者代理** — 由 `delegate_request` 分发的 Claude / Codex / opencode 会话。
- **`workingDirectory`** — 任务级工作目录，控制工作者的操作目录；不定义协调者身份。

**最低配置：**

```bash
xacpx start
xacpx status
```

将以下内容添加到 MCP 宿主配置：

```json
{
  "mcpServers": {
    "xacpx": {
      "command": "xacpx",
      "args": ["mcp-stdio"]
    }
  }
}
```

无需 `--workspace` 标志。xacpx 会生成一个进程级的外部协调者身份，例如 `external_codex-mcp-client:3f2a91c0`。该身份追踪哪个 MCP 子进程充当协调者，不绑定到某个目录。

## 工具接口

### 协调者工具

| 工具 | 说明 |
|------|------|
| `delegate_request` | 分发单个子任务。传入 `workingDirectory`（必填，除非已设置默认工作区）。支持 MCP Tasks 原生执行，可现在调用、稍后获取结果。 |
| `delegate_batch` | 一次分发多个子任务。两个及以上的任务会自动分组；所有任务达到终态后一并返回结果。单个任务失败时包含 `error` 字段，不影响其他任务。 |
| `task_get` | 获取任务快照：摘要、最新进度以及（终态任务的）工作者最终结果。默认不包含原始提示词；传入 `includePrompt: true` 可重新读取。`needs_confirmation` 状态的任务始终显示提示词供审批者查看。 |
| `task_list` | 列出当前协调者拥有的所有任务。 |
| `task_watch` | 长轮询任务，直到下一个事件、任务需要协调者处理，或达到终态（或超时）。返回 `events` 和 `nextAfterSeq`；下次调用时传入 `nextAfterSeq` 作为 `afterSeq` 可避免重放旧事件。终态响应包含 `- Result:`；需要处理的状态包含 `- Open question:`——无需单独调用 `task_get`。默认超时 60 秒；最长 20 分钟。 |
| `task_cancel` | 取消任务。取消 `needs_confirmation` 状态的任务等同于拒绝。取消 `queued` 状态的任务立即生效，此时尚未分配会话。 |
| `task_approve` | 批准一个由 `delegate_request` 返回为 `needs_confirmation` 状态的任务（需用户已授权）。任务随后开始运行。 |
| `agent_list` | 列出范围内已授权的对等智能体会话，包括其角色、工作区和当前活动。发送前先查看此列表，确保目标与当前任务相关。 |
| `agent_send` | 向另一个智能体发送高价值的异步对等消息。单向投递：目标运行时接受后即返回，绝不等待目标模型理解、完成或回复。 |
| `coordinator_answer_question` | 为工作者提出的阻塞问题提供答案。 |
| `coordinator_review_contested_result` | 解决工作者提出的有争议结果。 |

### 仅限工作者的工具

| 工具 | 说明 |
|------|------|
| `worker_raise_question` | 在委托任务内部调用，用于阻塞执行并向协调者提问。**不要从协调者侧调用此工具。** |

### 仅限群组执行的工具

仅在群组话题（Group Topic）执行内部暴露——外部协调者不可用：

| 工具 | 说明 |
|------|------|
| `group_say` | 通过公开消息路径发布一条简短有界的公开备注（`text`），与最终回复走同一路径；不唤醒、不分发任何其他成员。每次成员回合最多 3 次调用，每次最多 1,000 个字符。 |
| `group_send` | 在本次 Run 中公开分配给另一个当前群组 Bot 一个具体任务（`to`、`task`、可选 `expectedOutput`）。接受是持久化的，不授予任何人工许可权限。 |
| `group_read_result` | 只读：列出发已完成的分配元数据（每页 16 行）或读取已完成的公开结果（每页 4,000 个字符），范围限定于本次执行的 Run。使用 `offset` / `limit` 分页，并跟随 `nextOffset` 直至为 null。 |

## 委托生命周期

```text
delegate_request
  → 返回 taskId，状态：running（若并行槽已满则为 queued）
  → 通过 task_watch / tasks/get / task_get 监控
  → 终态：completed / failed / cancelled
         或需要处理：needs_confirmation / blocked / waiting_for_human / reviewPending
  → 通过 task_watch（内联包含）或 task_get 读取最终结果
```

当任务设置了 `parallel: true` 且目标代理的并行槽限制（`orchestration.maxParallelTasksPerAgent`，默认 3）已满时，任务以 `queued` 状态创建，不占用 `acpx` 会话。当有槽位可用时，任务按创建时间顺序晋升为 `running`。

`task_watch` 模式：

- `"next_event"` — 在下一个事件时返回；适合实时进度流式传输。
- `"until_attention_or_terminal"` — 默认；跳过常规运行中更新；等待需要协调者处理或达到终态的任务。

## 任务状态模型

| 状态 | 含义 |
|------|------|
| `pending` | 已创建但尚未启动 |
| `queued` | 等待并行执行槽位 |
| `running` | 工作者正在执行 |
| `needs_confirmation` | 等待协调者批准（`task_approve` 或 `task_cancel`/拒绝） |
| `blocked` | 工作者被阻塞；需要协调者处理 |
| `waiting_for_human` | 工作者向协调者提出了问题 |
| `completed` | 工作者成功完成 |
| `failed` | 工作者遇到错误 |
| `cancelled` | 任务已取消 |

存在开放 `reviewPending` 条目的任务在 MCP Tasks 中也表现为 `input_required`。

### MCP Tasks 协议映射

| xacpx 状态 | MCP Tasks 状态 |
|-----------|---------------|
| `running` | `working` |
| `queued` | `working`（槽位尚未可用；就绪后自动晋升） |
| `needs_confirmation` | `input_required` |
| `blocked` / `waiting_for_human` | `input_required` |
| 存在 `reviewPending` | `input_required` |
| `completed` | `completed` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

MCP Tasks 协议方法：
- `tasks/get` — 查询状态。
- `tasks/list` — 列出当前协调者的任务。
- `tasks/result` — 读取终态任务的结果；若为 `input_required`，立即返回操作指引而非阻塞。
- `tasks/cancel` — 取消任务（内部映射为 `task_cancel`）。

## 阻塞问题

当工作者需要协调者输入时，任务进入 `needs_confirmation`、`blocked` 或 `waiting_for_human`（统称：需要处理状态）。协调者应：

1. 调用 `task_get` 读取详情或待处理的问题。
2. 调用以下之一：
   - `task_approve <id>` / `task_cancel <id>`（拒绝）用于 `needs_confirmation`。
   - `coordinator_answer_question` 用于 `waiting_for_human` 问题。
   - `coordinator_review_contested_result` 用于有争议的审查。
3. 通过 `task_watch` 或 `tasks/get` 恢复监控。

使用 MCP Tasks 的宿主：对 `input_required` 状态的任务调用 `tasks/result` 会立即返回操作指引，按指引操作后再通过 `tasks/get` 或 `tasks/result` 恢复。

## 批量扇出

`delegate_batch` 分发多个任务并将它们关联到同一个组。需要并行扇出工作并获取汇总结果时使用：

```json
{
  "tasks": [
    {
      "targetAgent": "claude",
      "task": "Review PR A for correctness",
      "workingDirectory": "/repo/a",
      "parallel": true
    },
    {
      "targetAgent": "claude",
      "task": "Review PR B for correctness",
      "workingDirectory": "/repo/b",
      "parallel": true
    }
  ]
}
```

所有任务达到终态后才返回批量结果。单个任务失败时携带 `error` 字段；整批不会因此中止。

也可以在聊天中使用 `/group new` 手动创建组，然后通过 `delegate_request --group <groupId>` 或聊天中的 `/group add` 命令逐一添加任务。

## 取消

- `task_cancel` 可取消任何非终态任务。
- 取消 `needs_confirmation` 状态的任务等同于拒绝。
- 取消 `queued` 状态的任务安全且即时——尚未分配任何会话。
- 在聊天中使用 `/cancel <alias>` 或 `/stop <alias>` 可取消会话中正在运行的任务，包括后台会话。
- 在聊天中使用 `/group cancel <groupId>` 可取消任务组中所有未完成的任务。

## 集成说明

### `workingDirectory` 是必填项（且有意为之）

除非协调者已设置默认工作区，否则 `delegate_request` 需要一个非空的绝对路径。xacpx 不会回退到 MCP roots 或 `process.cwd()`：

- MCP roots 的支持不一致，可能列出多个目录。
- `process.cwd()` 取决于 MCP 宿主如何启动 stdio 子进程，不是可靠的约定。

严格规则确保工作者的工作目录始终确定。

```json
{
  "targetAgent": "claude",
  "task": "Review the current changes and flag the top 3 risks",
  "workingDirectory": "/absolute/path/to/repo"
}
```

Windows 路径示例：

```json
{
  "workingDirectory": "C:\\path\\to\\your\\repo"
}
```

### 协调者身份与 `workingDirectory`

| 概念 | 用途 | 是否含路径 |
|------|------|-----------|
| 外部协调者身份 | 标识哪个 MCP 宿主/子进程正在协调 | 否（默认） |
| `workingDirectory` | 告知工作者在哪里操作 | 是 |
| 工作者会话 | 以协调者 + cwd 为范围 | 派生自 cwd |

将身份与 cwd 分离，使同一个协调者可以向不同目录分发工作者，而不会变成不同的协调者。

### 多个并发 MCP 宿主

每个未指定 `--coordinator-session` 的 `xacpx mcp-stdio` 进程都会获得自己的进程级身份（`external_<client-name>:<instance-id>`）。多个 Codex 或 Claude Code 窗口各自拥有独立的协调者，可以向不同的 `workingDirectory` 分发任务而互不干扰。

若需在重启后或跨多个宿主共享协调者身份，请使用 `--coordinator-session`：

```json
{
  "mcpServers": {
    "xacpx": {
      "command": "xacpx",
      "args": ["mcp-stdio", "--coordinator-session", "codex:daily-review"]
    }
  }
}
```

使用固定会话时，`task_list` 会显示历次运行的任务。仅在有意共享编排上下文时使用此选项。

### 默认工作区（兼容模式）

`--workspace` 为省略 `workingDirectory` 的 `delegate_request` 调用提供回退值：

```bash
xacpx mcp-stdio --workspace backend
```

工作区必须已在 `~/.xacpx/config.json` 中注册。这是兼容性便利项；推荐在工具调用中显式传入 `workingDirectory`。

### Windows 配置

不要在 `command` 中写完整的 `node C:\...\cli.js` 字符串。许多 MCP 宿主将 `command` 视为文件名，并因 `os error 123` 失败。只将可执行文件放在 `command` 中，其余内容放在 `args` 中：

```json
{
  "type": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\path\\to\\xacpx\\dist\\cli.js", "mcp-stdio"]
}
```

若 `xacpx` 已全局安装且宿主可发现：

```json
{
  "type": "stdio",
  "command": "xacpx",
  "args": ["mcp-stdio"]
}
```

### 进程生命周期（Windows 孤儿进程预防）

`xacpx mcp-stdio` 监控 stdio 断开、`SIGINT`/`SIGTERM`/`SIGBREAK`，并每 5 秒轮询父进程。退出时向 stderr 写入诊断行：

```
[xacpx:mcp] mcp.stdio.shutdown {"reason":"parent_dead","parentPid":1234}
```

设置 `XACPX_MCP_PARENT_CHECK_INTERVAL_MS` 可调整轮询间隔（毫秒）。设为 `0` 可禁用父进程轮询（仅用于调试）。遗留的 `WEACPX_MCP_PARENT_CHECK_INTERVAL_MS` 名称仍作为回退被识别。

### `sourceHandle` 复用

对于没有显式 `--source-handle` 绑定的协调者侧工具调用，xacpx 将 `coordinatorSession` 复用为 `sourceHandle`。对于工作者侧的 `worker_raise_question`，需要单独的 `sourceHandle` 且必须显式绑定；不会静默回退。

### 故障排查

| 错误 | 原因 | 解决方法 |
|------|------|----------|
| `cannot infer workspace from MCP roots` | 旧文档建议基于 roots 推断 | 使用不带 `--workspace` 的 `xacpx mcp-stdio`；在每个任务中传入 `workingDirectory` |
| `workingDirectory is required` | 无默认工作区且省略了 `workingDirectory` | 在 `delegate_request` 调用中添加 `workingDirectory` |
| `workingDirectory must be an absolute path` | 传入了相对路径 | 使用绝对路径 |
| `os error 123`（Windows） | `command` 中包含完整命令字符串 | 只在 `command` 中放可执行文件；将脚本路径和参数移至 `args` |
| `Cannot find module '...dist\\cli.js'` | 脚本路径错误或尚未构建 | 在终端验证路径；必要时运行 `bun run build` |
| 任务已创建但工作者无结果 | 代理不可用、`acpx` 启动失败、会话被占用或权限策略阻止 | 检查 `xacpx status`、`xacpx doctor --verbose` 以及 `~/.xacpx/runtime/app.log` |
