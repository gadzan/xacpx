# `/config` 命令

## 概述

`/config` 是一个可在聊天窗口中使用的**受限配置写入接口**。其设计目标不是将聊天窗口变成任意 JSON 编辑器，而是：

- 允许对一组明确定义的配置字段进行安全修改。
- 拒绝不支持或不存在的字段。
- 保持 `config.json` 的结构稳定且可验证。

所有配置字段的完整参考（包括未通过 `/config` 暴露的字段），请见[配置参考](/zh/reference/configuration)。

## 显示配置

```text
/config
```

返回可通过聊天修改的配置路径白名单，无需任何参数。

## 读取某个值

没有显式的 `/config get` 命令。使用 `/config` 查看当前白名单，字段说明和默认值请参阅[配置参考](/zh/reference/configuration)。`/status` 命令可显示当前会话状态。

## 设置某个值

```text
/config set <path> <value>
```

示例：

```text
/config set channel.replyMode final
/config set logging.level debug
/config set transport.permissionMode approve-reads
/config set workspaces.backend.description backend repo
/config set transport.sessionInitTimeoutMs 30000
```

### 当前支持的路径

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

**动态字段**（命名目标必须已存在）：

- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

> **性能日志**（`logging.perf.*`）不在 `/config set` 白名单中。若需启用，请直接编辑 `~/.xacpx/config.json` 并重启守护进程——性能追踪器在启动时绑定。

> **传输拓扑**（`transport.type`、`transport.command`）会写入磁盘但不会热生效：守护进程重启前，运行时传输仍保持当前取值（会记录 `config.topology_pending_restart`）。上面其余路径均为热生效。使用 `xacpx restart` 重启。

> **飞书凭据和多频道配置**最好在终端管理：`xacpx channel add feishu`。

## 删除某个值

`/config` 不提供删除操作。若需移除某个字段，请直接编辑 `~/.xacpx/config.json`。若需移除代理或工作区，请使用专用命令：

```text
/agent rm <name>
/workspace rm <name>
```

## 安全规则

### 1. 仅限白名单路径

白名单之外的任何路径均会被拒绝：

```text
/config set transport.missing x
→ "This configuration path is not supported"
```

### 2. 动态条目必须已存在

以下路径要求命名目标已存在：

- `agents.<name>.*` — 名为 `<name>` 的代理必须已注册。
- `workspaces.<name>.*` — 名为 `<name>` 的工作区必须已存在。

对不存在的代理或工作区设置字段会返回错误；xacpx 不会自动创建。请先使用 `/agent add` 或 `/ws new`。

### 3. 类型校验

每个路径都会对值进行类型验证：

| 路径 | 接受的值 |
|------|----------|
| `channel.replyMode` | `stream`、`final`、`verbose` |
| `transport.permissionMode` | `approve-all`、`approve-reads`、`deny-all` |
| `transport.nonInteractivePermissions` | `deny`、`fail` |
| `logging.maxFiles` | 正整数 |
| `logging.maxSizeBytes` | 正整数 |
| `logging.retentionDays` | 正整数 |
| `transport.sessionInitTimeoutMs` | 正整数 |

### 4. 修改立即持久化

成功执行 `/config set` 后：

1. 更新内存中的配置。
2. 将修改写入 `~/.xacpx/config.json`。

这是真实的、持久的配置变更——不是临时的会话级覆盖。

## 示例

```text
/config set channel.replyMode final          # 修改全局默认回复模式
/config set logging.level debug              # 启用调试日志
/config set transport.permissionMode approve-reads
/config set transport.sessionInitTimeoutMs 60000
/config set agents.codex.driver codex
/config set workspaces.backend.description backend mono-repo
```

**与其他命令的关系：**

| 目标 | 使用 |
|------|------|
| 修改全局默认回复模式 | `/config set channel.replyMode <value>` |
| 仅覆盖当前会话的回复模式 | `/replymode <value>` |
| 清除当前会话的覆盖值 | `/replymode reset` |
| 添加新代理 | `/agent add <name>` |
| 删除代理 | `/agent rm <name>` |
| 添加新工作区 | `/ws new <name> -d <path>` |
| 删除工作区 | `/workspace rm <name>` |
| 编辑不在白名单中的字段 | 直接编辑 `~/.xacpx/config.json` |

`/config` 有意**不**设计为通用 JSON 编辑器。只有高频使用、可安全验证的字段才会暴露。其他字段需要直接编辑文件并重启守护进程。
