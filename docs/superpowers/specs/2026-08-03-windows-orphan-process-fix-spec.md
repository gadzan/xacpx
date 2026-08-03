# Windows 孤儿进程清理加固设计

**Date:** 2026-08-03
**Status:** Investigation complete, design/spec ready, pending implementation plan

## 目标

解决 Windows 环境下 xacpx 长期运行/反复启停后，后台遗留大量 `claude.exe`、`qoder-cli --acp`、`node.exe` 等孤儿进程的问题。目标是在不破坏现有 session 生命周期和跨平台行为的前提下，让 xacpx 在 daemon 停止、queue owner 重启、session 归档等关键路径上可靠地回收所有派生进程。

## 背景与问题现象

在 Windows 11 开发机上观察到：

- 160+ 个 `node.exe` 进程，占用超过 6 GB 内存；
- 26 个 `claude.exe` 进程，占用 4.1 GB；
- 大量 `claude --output-format stream-json`、`qoder-cli --acp`、npx 中间进程，父进程均已死亡；
- 一个 `xacpx run` daemon 进程本身也是孤儿。

这些进程会长期存活，直到被手动清理。macOS/Linux 上同样可能存在隐患，但 Windows 问题最严重。

## 根因分析

### 1. 现有清理机制

xacpx 已经设计了多道防线：

- `terminateProcessTree`（`src/process/terminate-process-tree.ts:26-32`）：Windows 下执行 `taskkill /PID <pid> /T /F`；
- `DaemonController.stop`（`src/daemon/create-daemon-controller.ts:222-224`）：stop daemon 时调用 `terminateProcessTree`；
- `AcpxQueueOwnerLauncher`（`src/transport/acpx-queue-owner-launcher.ts:260-272`）：通过 lock 文件 `~/.acpx/queues/<hash>.lock` 记录 queue owner PID，启动/停止时调用 `terminateProcessTree`；
- `reapWarmQueueOwners`（`src/main.ts:943-969`）：daemon 启动和关闭时，根据 state.json 中的 session 列表扫描旧 queue owner 并回收；
- MCP stdio shutdown hook（`src/mcp/xacpx-mcp-server.ts:741-909`）：监听 stdin 关闭、信号、父进程死亡等事件主动退出。

### 2. 为什么现有机制拦不住

#### 2.1 `taskkill /T /F` 杀不透 `.cmd` shim 链

Windows 下常见命令链：

```
acpx queue owner
  └── cmd.exe → npx.cmd → node.exe (npx-cli)
        └── node.exe .../claude-agent-acp/bin/...
              └── claude.exe --output-format stream-json
```

`taskkill /T /F` 会杀掉目标进程及其直接子进程，但 `cmd.exe` 被强杀时，其下挂的 `node.exe` / `claude.exe` 可能脱离进程树继续运行，变成孤儿。

#### 2.2 acpx queue owner 是 detached 进程，不在 daemon 进程树内

`defaultQueueOwnerSpawner`：

```ts
const child = spawn(command, args, {
  detached: true,
  stdio: "ignore",
  env: options.env,
  windowsHide: true,
});
```

`detached: true` 使 queue owner 与 daemon 解耦。`xacpx stop` 用 `taskkill` 杀 daemon 时不会波及 queue owner，必须依赖 lock 文件。一旦 lock 文件丢失、损坏或旧 daemon 崩溃没来得及写 lock，queue owner 就会留下。

#### 2.3 lock 文件是单点

`terminateAcpxQueueOwner` 只读 `~/.acpx/queues/<hash>.lock`。若：
- 旧 daemon 崩溃/强制关机/Windows 更新重启；
- lock 文件被误删；
- queue owner 启动后写 lock 失败；
则该 queue owner 永远不会被主动回收。

#### 2.4 启动时 reap 的范围受限于 state.json

`collectReapTargets` 只收集当前 state.json 中仍存在的 session。如果 session 已被删除、归档或 state 文件损坏，对应 queue owner 就不会进入 reap 列表。

#### 2.5 托管 adapter 命令依赖 npx，引入多层 shim

`src/adapters/adapter-catalog.ts:46-54`：

```ts
return `npx -y ${adapterRegistryNpmArgs(registry).join(" ")} ${spec.packageName}@${version}`;
```

`npx -y @agentclientprotocol/claude-agent-acp@...` 在 Windows 上至少经过 `npx.cmd` → `node.exe` 两层包装。acpx 实际执行的命令字符串是 shell 命令，acpx 在 Windows 上会把它交给 `cmd.exe` 解析，进一步增加孤儿风险。

#### 2.6 xacpx daemon 本身可能成为孤儿

Windows 下 daemon 通过 PowerShell 启动器启动（`src/daemon/create-daemon-controller.ts:81-107`）。启动器进程退出后，daemon 被 Windows 服务层收养；如果启动器或父 shell 异常退出，daemon 仍在运行，但 PPID 指向的进程已经消失，形成你看到的 `xacpx run` 孤儿。

## 设计原则

1. **不破坏跨平台行为**：修复只在 Windows 下增强，macOS/Linux 保持原样。
2. **兜底优先**：宁可留下 TTL 自然过期，也不能把正在干活的进程误杀。
3. **分层清理**：daemon 层清 queue owner，queue owner 层清 agent，agent 层自力更生。
4. **幂等/幂等接近**：重复 stop/restart 不能报错，也不能重复杀错。

## 方案：四层加固

### 第一层：Windows 下用 Job Object 绑定进程树

在 `defaultQueueOwnerSpawner` / `spawnAcpxBridgeClient` 等关键 spawn 点，Windows 下创建 Job Object，把子进程加入同一 Job。父进程退出或 Job 关闭时，Windows 会自动终止 Job 内所有进程。

Node.js 实现方式：

```ts
import { spawn } from "node:child_process";

function spawnInWindowsJob(command: string, args: string[], options: SpawnOptions) {
  // 用 powershell 包装：先创建 Job，再启动目标，父进程退出时关闭 Job
  return spawn("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$job = Start-Job -ScriptBlock { & '${command}' ${args.map(a => `'${a}'`).join(' ')} }; Wait-Job $job`,
  ], options);
}
```

更可靠的做法是引入原生模块或调用 Windows API（`CreateJobObjectW` + `AssignProcessToJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）。

**改造点：**
- 新增 `src/process/spawn-in-job.ts`：提供 `spawnInDetachedJob(command, args, options)`，Windows 下用 Job Object，其他平台 fallback 到普通 `spawn`。
- 替换 `acpx-queue-owner-launcher.ts:234-252` 的 `defaultQueueOwnerSpawner` 使用 Job Object spawn。
- 替换 `acpx-bridge-client.ts:386-393` 的 bridge spawn（可选，bridge 目前不是 detached，但同样可加固）。

### 第二层：Windows 下手动遍历进程树再杀

增强 `terminateProcessTree`：Windows 下不要只依赖 `taskkill /T /F`，而是先用 `wmic process where ParentProcessId=...` / `Get-CimInstance Win32_Process` 递归收集整棵进程树，然后逐个强杀。

伪代码：

```ts
async function terminateProcessTreeWindows(pid: number): Promise<void> {
  const all = new Set<number>();
  const collect = (parentPid: number) => {
    // 用 wmic 或 PowerShell 取子进程
    const children = getChildrenOf(parentPid);
    for (const child of children) {
      if (!all.has(child)) {
        all.add(child);
        collect(child);
      }
    }
  };
  collect(pid);

  for (const target of [pid, ...all]) {
    try {
      await runCommand("taskkill", ["/PID", String(target), "/F"]);
    } catch {
      // 已经退出就忽略
    }
  }
}
```

**改造点：**
- `src/process/terminate-process-tree.ts`：Windows 分支改成“递归收集 + 逐个 `/F`”。
- 保留 `detachedProcessGroup` 参数的含义：用于 Unix 的 `-pid` 行为；Windows 下忽略该参数，统一递归杀树。

### 第三层：把 agent 命令从 `npx` shell 字符串改为 `node` 直接调用

当前托管 adapter 命令是字符串：

```ts
npx -y --registry=... --@agentclientprotocol:registry=... @agentclientprotocol/claude-agent-acp@0.59.0
```

在 Windows 上这会被交给 `cmd.exe`，形成 `cmd.exe` → `npx.cmd` → `node.exe` → ... 的链。

改为：
1. 先由 xacpx（或 acpx）确保对应 npm 包已安装到本地固定路径；
2. 直接调用 `node <absolute-path-to-bin>/claude-agent-acp`；
3. 必要时用 `npm exec --package=@agentclientprotocol/claude-agent-acp@0.59.0 -- ...` 但显式指定 `--no-shell`（如果 npm 支持）。

如果 acpx 不接受直接 JS 路径，至少把 `npx -y ...` 换成 `npm exec --no-shell ...` 或 `node <abs-path>`，减少 `cmd.exe` 中间层。

**改造点：**
- `src/adapters/adapter-catalog.ts:46-54` 的 `buildManagedAdapterCommand`：返回结构化命令 `{ command: string; args: string[] }` 而不是字符串。
- 调整 `resolveConfiguredAgentCommand` / `resolveRuntimeAgentCommand` 的调用方，让它能处理结构化命令。
- acpx 侧需要同步支持，或 xacpx 在调用 acpx 时用 `--agent-command-json` 之类的新参数传递结构化命令。

### 第四层：启动时全局孤儿扫描

不再只依赖 state.json 和 lock 文件，启动时扫描系统内所有由 xacpx / acpx 启动的进程，把“父进程已死且没有对应 live session”的进程杀掉。

扫描规则：
- 进程命令行包含 `xacpx/dist/cli.js`、`acpx`、`claude-agent-acp`、`qodercli` 等关键字；
- 父进程不存在或父进程不是 live xacpx daemon；
- 该进程对应的 session 不存在于当前 state.json；
- 排除当前 daemon 自己及其正在管理的 live session。

**改造点：**
- 新增 `src/process/orphan-process-reaper.ts`：
  - `collectWindowsXacpxProcs()`：用 `Get-CimInstance Win32_Process` 获取候选进程；
  - `isOrphan(proc)`：判断父进程是否死亡；
  - `safeKillOrphans(procs)`：批量强杀，加日志。
- 在 `src/run-console.ts:157-184` 的 `reapPromise` 中，除了 `reapStaleQueueOwners`，再调用一次全局孤儿扫描（仅 Windows，best-effort，timeout 5s）。
- `xacpx doctor` 增加一个检查项：报告系统中的 xacpx/acpx/claude/qoder-cli 孤儿进程数量。

## 组件 & 改动

### 1. `src/process/terminate-process-tree.ts`

Windows 分支改为递归遍历进程树后逐个强杀：

```ts
if (platform === "win32") {
  await terminateProcessTreeWindows(pid);
  return;
}
```

新增私有函数 `collectWindowsProcessTree(rootPid)` 和 `terminateProcessTreeWindows`。

### 2. `src/process/spawn-in-job.ts`（新增）

```ts
export interface DetachedJobSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  windowsHide?: boolean;
}

export function spawnInDetachedJob(
  command: string,
  args: string[],
  options: DetachedJobSpawnOptions,
): ChildProcess;
```

Windows 实现：
- 调用 PowerShell 脚本创建 Job Object，启动目标进程，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
- 返回的 ChildProcess 的 PID 是 powershell  wrapper 的 PID，但 Job 关闭时会杀掉整个树。

非 Windows 实现：直接 `spawn(command, args, { detached: true, stdio: "ignore" })`。

### 3. `src/transport/acpx-queue-owner-launcher.ts`

- `defaultQueueOwnerSpawner` 改用 `spawnInDetachedJob`；
- 在 lock 文件中额外记录：
  - owner PID；
  - 启动时间；
  - agent 命令摘要；
  - 可选的 Job Object handle（如果系统支持）。
- `terminateAcpxQueueOwner` 先尝试 Job Object 关闭，再 fallback 到 `terminateProcessTree`。

### 4. `src/adapters/adapter-catalog.ts`

新增：

```ts
export interface ResolvedAdapterCommand {
  command: string;
  args: string[];
}

export function buildManagedAdapterCommandResolved(
  id: ManagedAdapterId,
  version: string,
  registry?: string,
): ResolvedAdapterCommand;
```

原 `buildManagedAdapterCommand` 保留为兼容层（返回字符串，供 CLI 展示）。

内部实现改为：
- 计算 npm 包绝对安装路径；
- 返回 `{ command: process.execPath, args: ["<abs-path-to-bin>", ...extraArgs] }`。

### 5. `src/main.ts`

`reapWarmQueueOwners` 之后（或之前）增加：

```ts
await reapGlobalWindowsOrphans(config, state, logger).catch(() => {});
```

函数只在 `process.platform === "win32"` 时执行。

### 6. `src/process/orphan-process-reaper.ts`（新增）

见第四层设计。

### 7. `src/daemon/create-daemon-controller.ts`

PowerShell 启动脚本里也可以考虑把 daemon 加入 Job Object，但 daemon 本身已经 detached，且 `stop` 会单独杀它，优先级较低。可以作为后续增强。

## 边界情况

- **macOS/Linux**：上述 Windows 特有逻辑全部 bypass，保持现有 SIGTERM/SIGKILL 行为。
- **正在干活的 session**：全局孤儿扫描只杀“父进程死 + 无对应 live session”的进程，不会误杀当前 daemon 管理的 queue owner/agent。
- **acpx 升级或命令格式变化**：结构化命令 `{ command, args }` 比 shell 字符串更稳定，acpx 侧只需要能接收并转发即可。
- **权限不足**：PowerShell/WMIC 需要用户权限，正常开发环境都有。权限不足时 fallback 到现有 `taskkill`。
- **重复 stop**：`terminateProcessTree` 递归杀树时每个 PID 都是 best-effort，已经退出的进程忽略。

## 测试计划

### 单元测试

1. `terminate-process-tree.test.ts`（新增/增强）：
   - Windows 下能递归收集模拟进程树；
   - 对每个 PID 调用 `taskkill /F`；
   - 非 Windows 下保持原行为。

2. `spawn-in-job.test.ts`（新增）：
   - Windows 下调用 `powershell.exe` 并传入 `-EncodedCommand`；
   - 非 Windows 下 fallback 到普通 `spawn`。

3. `orphan-process-reaper.test.ts`（新增）：
   - 给定一组模拟进程，正确识别孤儿；
   - 排除当前 daemon 及其 live session；
   - 权限失败时优雅降级。

### 集成测试

1. 在 Windows 上：
   - `xacpx start` → 创建几个 session → `xacpx stop`；
   - 验证没有 `claude.exe`、`qoder-cli --acp`、npx 中间进程残留；
   - 验证 `~/.acpx/queues/` 下无残留 lock 文件。

2. 模拟 crash：
   - 启动 daemon；
   - 手动 `taskkill /F` 掉 daemon 进程；
   - 重新 `xacpx start`；
   - 验证启动时的 orphan reaper 清理了旧的 queue owner / agent。

### 手动验证

- 运行 `xacpx doctor` 新增的 orphan 检查项；
- 观察 Task Manager / Process Explorer，确认进程树在 stop 后被整体销毁。

## 不做的范围

- 不替换 acpx 本身；acpx 侧如果也需要加固，单独跟踪。
- 不改现有 session 生命周期语义（archive/restore/delete 行为不变）。
- 不为非 Windows 平台引入额外复杂度。
- 不改动 daemon 的 IPC/Orchestration 逻辑。

## 推荐实施顺序

1. **P0** — 增强 `terminateProcessTree` 的 Windows 递归杀树（改动最小，收益最大）。
2. **P1** — queue owner spawn 改用 Job Object，减少 detached 进程孤儿。
3. **P2** — 启动时全局孤儿扫描，兜底历史遗留。
4. **P3** — adapter 命令结构化，减少 npx/cmd shim 链（需要 acpx 配合，周期较长）。
5. **P4** — `xacpx doctor` 增加 orphan 报告。

## 相关源码位置

- `src/process/terminate-process-tree.ts`
- `src/transport/acpx-queue-owner-launcher.ts`
- `src/transport/acpx-bridge/acpx-bridge-client.ts`
- `src/daemon/create-daemon-controller.ts`
- `src/adapters/adapter-catalog.ts`
- `src/main.ts`
- `src/run-console.ts`
- `src/mcp/xacpx-mcp-server.ts`
