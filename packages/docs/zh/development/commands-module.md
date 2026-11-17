# 命令模块

## 模块目标

`src/commands` 将从聊天频道接收到的文本命令转换为系统操作。

它精确地解决三个问题：
- **识别命令** — 将 `/session new ...`、`/agent add ...` 等输入解析为结构化命令对象。
- **路由命令** — 按命令类型将请求分发给对应的处理器。
- **返回结果** — 将执行结果格式化为统一的文本响应。

这是**命令入口层**——不是业务存储层，也不是传输实现层。

## 职责

调用链如下：

```
Chat message → ConsoleAgent → CommandRouter → handler → SessionService / SessionTransport / ConfigStore → text response
```

职责边界：

- `src/commands` 回答"**用户说了什么，谁来处理**"。
- `src/sessions` 回答"**逻辑会话如何存储和切换**"。
- `src/transport` 回答"**如何与 acpx 会话通信**"。
- `src/config` 回答"**智能体 / 工作区 / 传输配置如何读写**"。

## 解析器边界

### `parse-command.ts`

命令解析器。职责：

- 识别斜杠命令。
- 提取参数、选项和 prompt 文本。
- 输出统一的命令结构供路由器消费。

解析器只**读取输入**——不执行任何操作。

别名解析已内置：`/ss` → `/session`，`/ws` → `/workspace`，`/stop` → `/cancel`。源码：[`src/commands/parse-command.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/parse-command.ts)

## 路由器边界

### `command-router.ts`

模块的主入口点。职责：

- 调用 `parseCommand()` 解析输入。
- 根据 `command.kind` 进行分发。
- 组装每个处理器所需的上下文和操作对象。
- 组合并委派给 `TransportInvoker` 和 `SessionControlService`；为会话 CRUD 方法保留公开转发。
- 捕获传输错误，记录日志，并生成诊断摘要。

将其视为**精简路由器 + 上下文组装器**——不是存放业务逻辑的地方。传输调用包装和"会话 CRUD + 传输"逻辑已抽取到 `TransportInvoker` 和 `SessionControlService`；路由器仅将它们接入处理器的 ops，并转发 CRUD 调用。

面向处理器的传输操作位于 `TransportInvoker`（[`src/commands/transport-invoker.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/transport-invoker.ts)），而非路由器中：

- `ensureTransportSession()` — 支持缺失可选依赖的自动安装和二次验证。
- `promptTransportSession()` — 统一转发 `reply` / `quota` / `media`，并确保 `mcpCoordinatorSession` 的默认值。
- `measureTransportCall()` — 统一记录成功/失败日志；从 `PromptCommandError` 中提取 `stdout`/`stderr` 诊断摘要。

源码：[`src/commands/command-router.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/command-router.ts)

### `router-types.ts`

路由层的共享类型定义：

- `RouterResponse` — 所有处理器返回的统一响应类型。
- `CommandRouterContext` — 传入处理器的上下文对象。
- 会话操作接口（`SessionLifecycleOps`、`SessionInteractionOps`、`SessionRecoveryOps` 等）。

这些类型使路由器的能力依赖关系显式化，而非散落在各个处理器中。源码：[`src/commands/router-types.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/router-types.ts)

## 处理器约定

### `handlers/`

处理器按**职责边界**拆分，而非按命令名称：

| 文件 | 职责 |
| --- | --- |
| `help-handler.ts` | 帮助命令 |
| `agent-handler.ts` | 智能体配置管理 |
| `workspace-handler.ts` | 工作区配置管理 |
| `permission-handler.ts` | 权限相关命令 |
| `session-handler.ts` | 会话主流程——创建、切换、状态、prompt、取消 |
| `session-shortcut-handler.ts` | 会话快捷方式创建/切换流程 |
| `session-recovery-handler.ts` | 会话恢复与错误渲染 |
| `session-reset-handler.ts` | 会话重置流程 |
| `native-session-handler.ts` | 原生会话列表 / 附加流程 |
| `orchestration-handler.ts` | 编排命令——委派、群组、任务批准/取消 |
| `later-handler.ts` | 定时（`/later`）延迟任务命令 |
| `config-handler.ts` | 配置命令——读写配置值 |

这种拆分方式保持了 `command-router.ts` 与各大处理器之间的松耦合。当一个处理器积累了多个不同流程（主流程 + 恢复 + 重置 + 特化渲染）时，应及早拆分为独立文件，而不是继续向单个文件叠加。

### 添加新命令

请按以下顺序操作：

1. 在 `parse-command.ts` 中定义输入结构。
2. 在 `handlers/` 中添加或扩展对应的处理器。
3. 在 `command-router.ts` 中注册分发 case。
4. 在 `tests/unit/commands/` 中同步添加测试。

### 哪些代码属于这里

回答"**这条命令应该如何处理**"的代码：
- 新的斜杠命令解析规则。
- 新的命令路由分发 case。
- 某类命令的文本响应组织方式。
- 与命令执行直接相关的轻量编排逻辑。

**不**属于这里的代码：
- 会话状态持久化细节。
- `acpx` 进程或桥接协议细节。
- 配置文件读写细节。
- 与命令无关的通用业务逻辑。

### `transport-diagnostics.ts`

传输错误诊断辅助模块。职责：
- 提取传输错误摘要。
- 提取 `ndjson` / 末尾输出 / 部分输出用于调试。
- 在传输调用失败时生成稳定、可操作的用户可见消息和日志条目。

该模块不处理恢复逻辑——仅负责诊断信息的组装。源码：[`src/commands/transport-diagnostics.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/transport-diagnostics.ts)

## 测试说明

- 单元测试在 `tests/unit/commands/` 下镜像 `src/commands/` 的结构。
- 处理器测试注入虚假的 `SessionService`、`SessionTransport` 和 `ConfigStore` 实现——处理器不得依赖具体实现。
- 解析器测试（`parse-command.test.ts`）输入原始文本字符串，并断言结果的命令 `kind` 和参数字段。
- 路由器测试以虚假的 `reply` 回调运行 `CommandRouter.handle()`，并断言响应文本及下游调用情况。
- 时间敏感的断言（例如并发 prompt 取消）必须对预期的 promise 使用 `await`，而不是使用 `Bun.sleep()`。

模块结构所强制执行的设计原则：

- **解析与执行分离** — `parse-command.ts` 无副作用。
- **路由与实现分离** — `command-router.ts` 负责分发和组装，不包含业务细节。
- **错误恢复隔离** — 恢复逻辑位于独立的处理器中，不在主流程中。
- **能力依赖显式化** — 会话操作以小型接口的形式声明在 `router-types.ts` 中。
- **响应统一化** — 路由层始终返回 `RouterResponse`，便于调用方消费。
