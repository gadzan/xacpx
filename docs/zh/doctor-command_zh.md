# `xacpx doctor` 命令说明

`xacpx doctor` 会对本机的 xacpx 安装运行一系列**只读诊断**（config、运行时路径、
daemon、频道、transport、插件、orchestration IPC 等）并输出报告。加上 `--fix`
后，还会额外执行一小组安全的本地修复。

## 运行方式

```bash
xacpx doctor                       # 运行所有默认检查
xacpx doctor --verbose             # 输出更多诊断细节
xacpx doctor --smoke               # 额外运行可选的 smoke 探测
xacpx doctor --agent codex         # 指定 smoke 探测使用的 agent
xacpx doctor --workspace backend   # 指定 smoke 探测使用的 workspace
xacpx doctor --fix                 # 执行安全的本地修复，然后重新检查
```

### 退出码

- `0` —— 没有检查报告 `fail`（在 `--fix` 修复并重新检查之后）。
- `1` —— 至少有一项检查仍然是 `fail`。

未知 flag（或 `--agent`/`--workspace` 缺少取值）会打印 CLI 帮助并以 `1` 退出。

## 检查项

检查按下面的固定顺序运行和渲染。每项检查有一个稳定的 `id`（内部用于在修复
后重跑对应检查）和报告中展示的可读 label：

| 顺序 | id                      | Label             | 验证内容 |
|------|-------------------------|-------------------|----------|
| 1    | `config`                | Config            | `config.json` 能加载并通过校验。 |
| 2    | `runtime`               | Runtime           | daemon 运行时目录及其 pid/status/log 文件可用（可写或可创建）。POSIX 上还会检查运行时目录是否为私有权限（mode `0700`）。 |
| 3    | `logs`                  | Logs              | 汇总 daemon 日志文件（`app.log`/`stdout.log`/`stderr.log` 及轮转分片）的体积，增长过大时 `warn`（单文件超 50 MB，或总量超 200 MB）；运行时目录还没有日志时 `skip`。个别文件不可读会被容忍（跳过），不会 `fail`。 |
| 4    | `daemon`                | Daemon            | 通过 daemon controller 检查存活状态（running / stopped / indeterminate）。stopped 时还会扫描残留的 consumer-lock 文件。 |
| 5    | `orphans`               | Windows orphans   | Windows 下只读检查 orphan intent/owner/residual；不确定证据会保留并报告。其他平台为 `skip`。 |
| 6    | `wechat`                | WeChat            | 微信（Weixin）频道处于登录状态。 |
| 7    | `acpx`                  | acpx              | 解析到的 `acpx` 可执行文件能报告可用版本。 |
| 8    | `bridge`                | Bridge            | acpx bridge 子进程能启动并响应。 |
| 9    | `plugins`               | Plugins           | 已配置的插件均已安装、可加载且已启用。 |
| 10   | `orchestration`         | Orchestration     | `state.json` 中的 orchestration 状态健康（只读 inspect，绝不会作为副作用执行隔离）。心跳新鲜度按 `orchestration.progressHeartbeatSeconds` 校验。 |
| 11   | `orchestration-socket`  | Orchestration IPC | daemon 停止时 `skip`；只有 daemon 存活（running 或 indeterminate）时才探测 orchestration IPC 端点是否真正接受连接（只有确定性的无监听才 `fail`，可达或结果不确定时为 `pass`/`skip`）。 |
| 12   | `smoke`                 | Smoke             | 对真实会话做端到端探测。**可选项：**不传 `--smoke` 时跳过。 |

## 严重级别

每项检查报告四种严重级别之一：

- **pass** —— 健康。
- **warn** —— 降级但仍可工作（例如：daemon 未运行、微信未登录、运行时目录
  权限不是 `0700`、存在 daemon 下次启动会自动隔离的无效 state 记录）。
- **fail** —— 已损坏；任何 fail 会让退出码非零。
- **skip** —— 不适用或未请求（例如：未传 `--smoke` 时的 Smoke 检查，或因
  Config 检查失败而无法运行的检查）。

末尾的汇总行统计各级别数量，例如
`Summary: PASS 5, WARN 3, FAIL 1, SKIP 2`。

## Flags

- `--verbose` —— 在支持的检查中输出更多诊断细节（WeChat、acpx、Bridge）。
- `--smoke` —— 运行可选的 Smoke 检查（真实的端到端会话探测）。
- `--agent <name>` —— 指定 Smoke 探测使用的 agent。
- `--workspace <name>` —— 指定 Smoke 探测使用的 workspace。
- `--fix` —— 执行安全的本地修复，然后重跑受影响的检查。

## `--fix`：修复模型与安全性

默认情况下 doctor 严格只读。加 `--fix` 后，doctor 会遍历各检查并执行它们
附带的修复。修复有意保持保守：

- 只有**安全且本地**的修复才会执行。会改动状态的修复受**门控**（见下文），
  daemon 运行期间会被扣留（withheld）。
- 被扣留的修复会以 `skipped` 加原因的形式报告，而不是被执行。
- 修复抛错或返回失败时记录为 `failed`；一次糟糕的修复永远不会让 doctor
  崩溃。
- 只有至少成功应用了一项修复的检查才会被重跑，使报告反映修复后的状态。

修复完成后，doctor 打印一个 `Repairs:` 区块，每项修复一行：

```
Repairs:
- create/repair runtime dir with mode 0700: applied (runtime dir ... created/repaired with mode 0700)
- quarantine invalid state.json records: skipped (stop the daemon first: xacpx stop)
```

**不传** `--fix` 时，存在可用修复的检查会内联标注，例如：

```
WARN Runtime: daemon runtime dir should be private (mode 0700) (fixable — run: xacpx doctor --fix)
```

### 会自动执行的修复（安全 / 本地）

- `runtime.ensure-private-dir` —— 创建或修复运行时目录为 mode `0700`。
  **不受门控**（它只调整私有运行时目录自身的权限），因此 daemon 运行时也会
  执行。
- `state.quarantine` —— 隔离 `state.json` 中无效/损坏的记录（丢弃坏记录、把
  原文件备份为 `state.json.quarantine-*`，或把无法读取的文件重命名为
  `state.json.corrupt-*`）。**门控**：要求 daemon 已停止。
- `daemon.clear-stale-lock` —— 删除记录的 pid 确定已不存活的残留
  `*-consumer.lock.json` 文件。**只在 daemon 已停止时提供**（running 或
  indeterminate 的 daemon 拥有这些锁）。

### 只给建议、绝不自动执行的情况

以下情况只会以建议（suggestion）形式呈现，永远不会变成可执行的修复：

- **插件缺失或损坏** —— 安装插件需要网络。
- **插件被禁用** —— 重新启用是操作者的显式决定。
- **配置无效** —— 配置修改必须由你本人慎重进行。
- **微信未登录** —— 重新登录是交互式操作（`xacpx login`）。

### daemon 停止门控

会改动状态的修复（`state.quarantine`、`daemon.clear-stale-lock`）绝不能与
存活的 daemon 竞争 —— daemon 拥有 `state.json` 和 consumer 锁。daemon 运行
期间这些修复会被**扣留**，并以 `skipped` 加 "stop the daemon first:
`xacpx stop`" 的原因报告。先停止 daemon，重跑 `xacpx doctor --fix`，再启动
它。

daemon 存活与否的判定独立于任何检查结果：`indeterminate` 状态（daemon pid
存活但 `status.json` 缺失）被视为存活的 daemon，因此那种情况下也不会提供锁
清理。进程存在但无法发送信号（`EPERM`）同样算作存活。如果完全无法确定
daemon 状态，doctor 会按安全方向处理：视为 daemon 正在运行，扣留所有改动
状态的修复。

门控还会在执行时刻再次复核：如果在只读检测和 `--fix` 实际执行修复之间有
daemon 启动了，`state.quarantine` 会拒绝执行（报告为 `failed`，并提示先
停止 daemon），`daemon.clear-stale-lock` 会逐个重新核对每把锁，跳过持有者
已重新存活的锁。
