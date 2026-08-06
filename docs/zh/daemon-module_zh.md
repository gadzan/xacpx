# `src/daemon` 模块说明

## 模块目标

`src/daemon` 负责把 xacpx console 变成一个**可后台运行、可查询状态、可停止**的守护进程。

它主要解决四件事：
- **启动后台进程**：把 console 以 detached 方式拉起。
- **记录运行状态**：写入 PID、状态文件和日志路径。
- **提供可观测性**：让 `status` 能知道 daemon 是否真的活着。
- **安全停止进程**：按平台终止 daemon，并清理运行时文件。

一句话：这是 **后台进程生命周期管理层**，不是业务消息处理层，也不是 CLI 参数解析层。

## 在整体架构里的位置

调用链大致是：

`CLI start/status/stop -> daemon controller -> daemon runtime files/status -> run-console -> SDK/agent 主循环`

职责边界是：
- `src/cli.ts` 负责“**用户执行了哪个命令**”。
- `src/daemon` 负责“**后台进程怎么启动、怎么判活、怎么停止**”。
- `src/run-console.ts` 负责“**daemon 进程里实际跑什么**”。
- 其他业务模块负责“**进程活着之后具体提供什么能力**”。

Windows 下 daemon 还会在 `runtime/orphans/` 发布 generation identity，并获取规范化 named-pipe consumer guard。预安装 adapter 的启动使用同一 UUID 贯穿 argv、intent、owner 与 residual；启动、周期 sweep、正常退出和 `xacpx stop` 都复用 fail-closed 登记表与 handle-stable 身份核验。自动路径不使用 `taskkill`；`xacpx orphans kill --confirm` 仅作为显式人工兜底。快照后新建子进程的彻底约束留作 Job Object P3。

## 目录结构

### `daemon-controller.ts`
外部控制入口。

职责：
- 对外提供 `start()`、`getStatus()`、`stop()`。
- 读取 PID 文件和状态文件。
- 判断进程是否仍然存在。
- 处理 stale runtime 状态并做清理。
- 在启动和停止时轮询等待 daemon 进入预期状态。

可以把它理解成：**daemon 的控制面**。

### `create-daemon-controller.ts`
控制器工厂。

职责：
- 装配 `DaemonController` 的平台相关依赖。
- 提供 detached 启动实现。
- 提供跨平台终止实现。
- 屏蔽 Windows 与非 Windows 的启动/关闭差异。

它的价值是把“**控制逻辑**”和“**平台细节**”拆开。

### `daemon-runtime.ts`
daemon 进程内的运行时登记器。

职责：
- 在 daemon 真正启动后写入 PID 文件。
- 写入 `status.json`，记录启动时间、心跳时间、配置路径、状态路径、日志路径。
- 周期性更新 heartbeat。
- 在退出时清理 PID 和状态文件。

可以把它理解成：**daemon 的自我登记面**。

### `daemon-files.ts`
运行时文件路径定义。

职责：
- 统一计算 runtime 目录。
- 统一给出：
  - `daemon.pid`
  - `status.json`
  - `stdout.log`
  - `stderr.log`
  - `app.log`

它不做读写，只负责**路径约定收口**。

### `daemon-status.ts`
状态文件存储。

职责：
- 读写 `status.json`。
- 清理状态文件。
- 定义 `DaemonStatus` 的结构。

它是一个很薄的持久化封装，避免状态文件格式散落在别处。

## 处理流程

以 `xacpx start` 为例：

1. `src/cli.ts` 创建 daemon controller。
2. controller 先检查当前 PID / status，确认不是已运行状态。
3. controller 以 detached 方式拉起新的后台进程。
4. 新进程进入 `run-console.ts`。
5. `run-console.ts` 调用 `daemonRuntime.start()` 写入 PID 和状态文件。
6. daemon 主循环运行期间，定期调用 `daemonRuntime.heartbeat()` 更新时间戳。
7. controller 在前台轮询 `status.json`，确认新进程已经报告 ready。
8. CLI 再向用户返回“已启动”。

以 `xacpx stop` 为例：

1. controller 读取 PID。
2. 如果进程还活着，按平台终止它。
3. 轮询等待进程退出。
4. 清理 PID 和状态文件。
5. 返回停止结果。

非 Windows 平台原地升级时，可能遇到旧 daemon 仍存活且 `status.json` 心跳仍新鲜、
但 PID 文件缺失的情况。普通查询保持只读并返回 indeterminate，因此 `start` 不能重复拉起。
只有显式执行 `stop` 或 `restart`，且 config/state 路径、daemon 模式 consumer lock、近期心跳
和 OS 报告的进程启动时间全部一致时，controller 才会接管 status 中的 PID。PID 复用、过期
证据或冲突元数据一律 fail-closed。终止恢复出的进程前，controller 会再次探测 OS 启动时间
指纹；指纹变化或无法取得时会保留证据并拒绝只凭 PID 终止。

新的 Windows daemon 会在真实发布版 `cli.js run` 启动路径上创建 generation identity，并把尚未
激活的 identity 上下文传给 `buildApp`；只有在可选的渠道 consumer guard 获取成功后、任何启动
协调或 orphan sweep 之前，才会持久化 generation。普通前台 `xacpx run` 不发布 daemon generation；
consumer guard 冲突而退出的进程既不能覆盖，也不能清扫现有 daemon 的 durable 证据。
升级前启动、尚未写入 durable generation identity
的 daemon 可以在原地升级后安全停止，
但不会退回到只凭 PID 强杀。controller 只有在 PID/status、近期心跳、handle 读取的创建时间与
可执行文件、当前配置根目录和精确的 `node cli.js run` 命令行全部一致时，才接管这个 legacy daemon；
接管得到的创建身份会先持久化，再进入现有的 handle-fenced 进程树终止流程。任何缺失、过期或冲突证据
仍然 fail-closed。

## 关键状态模型

daemon 当前不是靠“只看一个 PID 文件”判断是否存活，而是组合判断：
- **PID 文件**：告诉我们“之前启动的是谁”。
- **进程是否存在**：告诉我们“这个 PID 现在还活着没有”。
- **状态文件**：告诉我们“这个 daemon 是否已经完成自我登记”。

这三者组合后的结果大致有四类：
- **running**：进程存在且 PID/status 一致。
- **stopped**：没有存活 daemon 的证据。
- **stale stopped**：有旧 PID/状态，但对应进程已经不存在，控制器会清理残局。
- **indeterminate**：进程仍存活，但 PID/status 元数据不完整、不一致，或过旧而无法安全修复。
  该状态必须阻止启动第二个 daemon；PID 仍存活期间普通 status/doctor 查询保持只读。

这也是 `daemon-controller.ts` 的核心价值：它不只看文件，还做**活性校验**。

## 与 `run-console.ts` 的关系

`src/daemon` 不负责 console 的业务主循环。

它和 `run-console.ts` 的分工是：
- `src/daemon` 负责“**这个进程是不是一个可管理的 daemon**”。
- `src/run-console.ts` 负责“**这个 daemon 进程启动后做什么业务工作**”。

所以 daemon 子系统关心的是：
- 启动成功没有
- ready 了没有
- 心跳有没有更新
- 停掉没有
- 运行时文件有没有清干净

它不关心微信消息内容，也不关心命令路由细节。

## 设计原则

这个模块遵循几个原则：

- **控制面和运行面分离**：controller 管外部控制，runtime 管进程内登记。
- **路径约定集中**：所有 runtime 文件路径统一由 `daemon-files.ts` 生成。
- **状态显式化**：通过 `status.json` 暴露 daemon 自身元信息，而不靠隐式推断。
- **判活优先于判文件**：文件存在不代表进程还活着，必须做进程活性检查。
- **跨平台差异收口**：平台相关的 detached 启动和终止逻辑集中在工厂侧。

## 适合放在这里的代码

适合放进 `src/daemon` 的代码：
- daemon 启停控制逻辑。
- runtime 文件路径定义。
- PID / status / heartbeat 管理。
- 跨平台进程终止或后台拉起逻辑。

不适合放进这里的代码：
- CLI 参数解析细节。
- 微信消息轮询和处理逻辑。
- Agent 或 session 业务逻辑。
- 配置文件内容本身的业务解释。

判断标准就一句话：如果代码回答的是“**这个后台进程如何被管理**”，通常属于这里；如果回答的是“**这个进程里运行什么业务**”，通常不属于这里。

## 修改建议

如果后续要扩展 daemon 能力，建议按下面的顺序改：

1. 先明确要新增的是**控制面能力**还是**运行面能力**。
2. 如果是启停/判活/清理相关，优先改 `daemon-controller.ts`。
3. 如果是 daemon 自身登记信息扩展，优先改 `daemon-runtime.ts` 和 `daemon-status.ts`。
4. 如果是新日志或新 runtime 文件，优先改 `daemon-files.ts` 收口路径。
5. 如果涉及平台差异，再落到 `create-daemon-controller.ts`。

如果一个需求同时改到：
- 启动策略
- 状态文件结构
- 停止策略
- 平台兼容逻辑

那就应该先把“控制面”和“运行面”拆清楚，再动代码；不要把所有变化堆进一个文件。
