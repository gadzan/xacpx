# `/config` 命令说明

`/config` 是一个**受限的配置写入口**。

目标不是让聊天窗口变成任意 JSON 编辑器，而是：

- 允许修改一组明确支持的配置字段
- 拒绝不支持的字段
- 拒绝不存在的动态项
- 保持 `config.json` 结构稳定可校验

---

## 命令

### 查看支持修改的字段

```text
/config
```

返回当前允许通过聊天命令修改的配置路径白名单。

### 修改配置

```text
/config set <path> <value>
```

例如：

```text
/config set channel.replyMode final
/config set channels.feishu.replyMode final
/config set logging.level debug
/config set transport.permissionMode approve-reads
/config set workspaces.backend.description backend repo
/config set language en
```

---

## 当前支持的路径

固定字段：

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
- `channels.<id>.replyMode`（频道级默认；运行时热改，立即对该频道新回合生效）
- `language`


说明：性能 debug 日志 `logging.perf.*` 不支持通过聊天里的 `/config set` 动态开关。需要手动编辑 `~/.xacpx/config.json` 的 `logging.perf`，然后重启 daemon；该 tracer 在启动时绑定。

说明：`/config set transport.type` 与 `/config set transport.command` 会写入 `~/.xacpx/config.json`，但**不会热生效**——daemon 重启前运行时传输仍保持当前取值（会记录 `config.topology_pending_restart`）。上面其余路径均为热生效。使用 `xacpx restart` 重启。

兼容旧配置：

- `channel.type`（旧单频道配置；多频道请使用 `xacpx channel ...`）
- `channels[]`（多频道运行配置；推荐使用 `xacpx channel ...` 管理）

飞书凭据和多频道配置请优先用电脑终端里的频道 CLI 管理，例如 `xacpx channel add feishu`。完整说明见 [`docs/channel-management.md`](./channel-management_zh.md)。

动态字段：

- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

---

## 规则

### 1. 只允许白名单路径

不在上面列表里的路径，`/config set` 会直接拒绝。

例如：

```text
/config set transport.missing x
```

会返回“不支持修改这个配置路径”。

### 2. 不自动创建动态项

以下路径要求目标已经存在：

- `agents.<name>.*`
- `workspaces.<name>.*`

也就是说：

- `agents.claude.driver` 只有在 `claude` 这个 agent 已经存在时才能修改
- `workspaces.backend.cwd` 只有在 `backend` 这个 workspace 已经存在时才能修改

如果不存在，会直接报错，不会自动创建。

### 3. 按字段类型校验

不同路径会按各自类型校验。

例如：

- `channel.replyMode` 只支持 `stream` / `final` / `verbose`
- `wechat.replyMode`（兼容旧配置）同样只支持 `stream` / `final` / `verbose`
- `transport.permissionMode` 只支持 `approve-all` / `approve-reads` / `deny-all`
- `logging.maxFiles`、`logging.maxSizeBytes`、`logging.retentionDays`、`transport.sessionInitTimeoutMs` 必须是正数

### 4. 修改后会立即写回 `config.json`

`/config set` 成功后会：

1. 更新内存中的当前配置
2. 持久化到 `~/.xacpx/config.json`

所以这是**真实配置修改**，不是临时会话状态。

---

## 与其它命令的关系

`/config` 不是为了替代现有高层命令。

- `agent` 的创建和删除，仍然优先用：
  - `/agent add`
  - `/agent rm`
- `workspace` 的创建和删除，优先用高层命令：
  - `/ws new`
  - `/workspace rm`
  - 或在电脑当前目录执行 `xacpx workspace add [name]` / `xacpx workspace rm <name>`
- `/replymode` 改的是**当前逻辑会话覆盖**
- `channel.replyMode` 改的是**全局默认值**

也就是说：

- `/config set channel.replyMode final`：改全局默认
- `/replymode final`：只改当前逻辑会话
- `/config set wechat.replyMode final`：兼容旧路径，等同于改 `channel.replyMode`

---

## 设计边界

这个命令故意**不支持任意深度 JSON 修改**。

原因很简单：

1. `config.json` 里既有固定字段，也有 `agents/workspaces` 这种动态 map
2. 如果完全开放任意路径写入，很容易把配置写坏
3. xacpx 的目标是“远程可控”，不是“远程手写配置文件”

所以 `/config` 的原则是：

- 只开放高频且可安全校验的字段
- 其余字段保持显式实现
