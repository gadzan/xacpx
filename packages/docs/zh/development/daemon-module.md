# 守护进程模块

## 模块目标

`src/daemon` 将 xacpx 控制台转变为一个**可启动、可查询、可停止的后台进程**。

它解决四个问题：
- **启动后台进程** — 以分离模式启动控制台。
- **记录运行状态** — 写入 PID、状态文件和日志路径。
- **提供可观测性** — 让 `xacpx status` 能够判断守护进程是否真正存活。
- **安全停止进程** — 按平台规范终止守护进程并清理运行时文件。

一句话概括：这是**后台进程生命周期管理层**——不是业务消息处理层，也不是 CLI 参数解析层。

## 运行时文件

所有运行时文件路径集中管理于 `daemon-files.ts`——其他任何地方都不计算这些路径。源码：[`src/daemon/daemon-files.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-files.ts)

| 文件 | 内容 |
| --- | --- |
| `~/.xacpx/runtime/daemon.pid` | 正在运行的守护进程的 PID |
| `~/.xacpx/runtime/status.json` | 启动时间、心跳时间、配置路径、状态路径、日志路径 |
| `~/.xacpx/runtime/stdout.log` | 守护进程标准输出 |
| `~/.xacpx/runtime/stderr.log` | 守护进程标准错误 |
| `~/.xacpx/runtime/app.log` | 结构化应用日志（有界/滚动） |
| `~/.xacpx/runtime/runtime-consumer.lock.json` | 由 OS 持有、与频道无关的核心消费者锁的稳定元数据路径 |

### 模块文件

| 文件 | 职责 |
| --- | --- |
| [`daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-controller.ts) | 外部控制接口 — `start()`、`getStatus()`、`stop()` |
| [`create-daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/create-daemon-controller.ts) | 控制器工厂 — 平台特定的启动和终止实现 |
| [`daemon-runtime.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-runtime.ts) | 进程内注册 — 写入 PID、状态文件和心跳 |
| [`daemon-files.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-files.ts) | 运行时文件路径定义 — 所有路径的单一真实来源 |
| [`daemon-status.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-status.ts) | 状态文件持久化 — 读取 / 写入 / 清除 `status.json`；定义 `DaemonStatus` 结构 |
| [`runtime-consumer-lock.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/runtime-consumer-lock.ts) | 由 OS 持有的核心消费者锁（POSIX 上为 `flock`，Windows 上为 runtime-owner IPC 守卫），外加每个可锁频道各一道兼容围栏 |
| [`windows-daemon-runtime.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/windows-daemon-runtime.ts) | Windows 守护进程代际身份与孤儿登记簿 |
| [`posix-daemon-recovery.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/posix-daemon-recovery.ts) | POSIX 仅状态恢复的守护进程身份验证——消费者锁与 OS 启动时间证明 |
| [`private-runtime-dir.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/private-runtime-dir.ts) | 私有运行时目录约束（`0700`） |

## 启动生命周期

`xacpx start` 执行序列：

1. `src/cli.ts` 创建守护进程控制器。
2. 控制器读取当前 PID 和状态，确认守护进程尚未运行。
3. 控制器以分离模式启动新的后台进程。
4. 新进程进入 `run-console.ts`。
5. `run-console.ts` 调用 `daemonRuntime.start()`，写入 PID 和状态文件。
6. 主循环期间，`daemonRuntime.heartbeat()` 定期更新时间戳。
7. 控制器在前台轮询 `status.json`，直至看到新进程的 PID 报告为就绪状态。
8. CLI 向用户报告"已启动"。

**控制面与运行时的分离：** `daemon-controller.ts` 管理外部控制；`daemon-runtime.ts` 管理进程内自注册。双方仅通过共享的运行时文件通信——不存在从一方到另一方的直接调用。

## 状态生命周期

`xacpx status` 通过三个信号判断守护进程的存活状态：

- **PID 文件** — 告知我们最后启动了哪个进程。
- **进程是否存在** — 告知我们该 PID 是否仍在运行。
- **状态文件** — 告知我们守护进程是否完成了自注册。

由此产生的状态：

| 状态 | 条件 |
| --- | --- |
| `running` | PID 文件存在，进程存在，有效状态文件存在 |
| `stopped` | 没有存活守护进程的证据 |
| `stopped`（`stale: true`） | 已消亡进程遗留的旧 PID 或状态——控制器负责清理残留 |
| `indeterminate` | 进程存活，但其 PID/状态元数据不完整、不一致或过于陈旧而无法安全修复——阻止第二次启动；该 PID 存活期间 status/doctor 探测保持只读 |

`DaemonController.getStatus()` 不只是检查文件——它会对实际进程执行**存活检查**。这是其核心价值：文件的存在并不能保证进程还在运行。源码：[`src/daemon/daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-controller.ts)

## 停止生命周期

`xacpx stop` 执行序列：

1. 控制器读取 PID 文件。
2. 若进程存活，以平台适配的方式终止它。
3. 轮询直至进程退出。
4. 清理 PID 和状态文件。
5. 返回停止结果。

平台特定的启动和终止行为封装在 `create-daemon-controller.ts` 中，从而使 `daemon-controller.ts` 中的控制逻辑保持平台无关性。

## 测试说明

- 守护进程模块位于进程模型的边界，因此大多数测试属于集成级别：启动真实子进程，轮询状态文件，然后停止它。
- 写入运行时文件的测试必须使用 `mkdtemp` 进行隔离，并通过 `rm -rf` 清理。
- 使用 `xacpx status` 的输出来验证守护进程状态，而不是直接读取 `status.json`——这与用户走的路径相同，可以验证完整的状态逻辑。
- 等待守护进程就绪时，不要用 `Bun.sleep()` 作为同步屏障；改用 `until` 循环轮询 `status.json`，或使用控制器轮询逻辑返回的 promise。

### 扩展守护进程模块

添加新的守护进程能力时，请按以下顺序操作：

1. 判断新需求属于**控制面能力**（start/stop/存活检查）还是**运行时能力**（守护进程运行期间做什么）。
2. 控制面变更 → `daemon-controller.ts`。
3. 新的进程内自注册信息 → `daemon-runtime.ts` + `daemon-status.ts`。
4. 新的运行时文件 → 先在 `daemon-files.ts` 中集中定义路径。
5. 平台差异 → `create-daemon-controller.ts`。

如果一个变更同时涉及启动策略、状态文件结构、停止策略和平台兼容性，应在编写代码之前将控制面变更与运行时变更分开处理。

属于这里的代码：
- 守护进程 start / stop 控制逻辑。
- 运行时文件路径定义。
- PID / 状态 / 心跳管理。
- 跨平台进程终止和分离式启动。

不属于这里的代码：
- CLI 参数解析。
- 微信消息轮询与处理。
- 智能体或会话业务逻辑。
- 配置文件内容的解析。
