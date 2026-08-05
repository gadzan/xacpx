# Handoff：Windows 孤儿进程清理 & Adapter 预安装

**Date:** 2026-08-03
**Audience:** 接手本任务的 agent（后续处理审查意见 + 实施）
**状态:** 两份 spec 已通过评审并批准实施；implementation plan：`docs/superpowers/plans/2026-08-05-windows-orphan-process-and-adapter-preinstall.md`；实现尚未开始。

## 1. 任务是什么

两个关联 spec，目标是解决 Windows 上 xacpx 反复启停后遗留大量 `claude.exe`/`node.exe` 等孤儿进程：

1. `docs/superpowers/specs/2026-08-03-windows-orphan-process-fix-spec.md`（**主 spec**）——孤儿进程可靠回收。第二十轮评审修订。
2. `docs/superpowers/specs/2026-08-03-adapter-preinstall-spec.md`（**P2 独立 spec**）——opt-in adapter 预安装，消除 npx shim 链。第十七轮评审修订。从主 spec 拆出，与主 spec 按共享契约联合实施。

两份 spec 互相引用共享契约（登记表、guard、接口签名），**任何修改必须保持逐字对齐**。

## 2. 先读什么

1. 主 spec 全文（方案主体：identity context → IPC guard → token argv → 登记/reaper → controller stop 状态机）。
2. adapter spec 全文（immutable release + active pointer + GC 协议）。
3. 主 spec 修订历史末尾的「评审 stale 备忘」——**重要教训**：本轮流程中多次出现评审 agent 基于旧版内容提"新"问题的情况（inode/mtime 夺权、"owner+residual"接口、字符串 guard key、"无重扫协议"等均为已修复条目）。**处理任何新评审意见时，第一步永远是 grep 当前文件核实该问题是否仍存在**；不先复现就改，会在已修复的问题上空转甚至改坏。

## 3. 已锁定的关键设计决策（不要再翻案，除非有新证据）

| 决策 | 结论 | 理由 |
|---|---|---|
| 互斥原语 | Windows：命名管道绑定（`net.Server.listen`，libuv FIRST_PIPE_INSTANCE）；Unix：consumer/pidfile 保持现状；**Unix adapter 操作用 `flock(2)`**（adapter spec 第八轮，替代 `open wx`+PID 协议——后者 stale takeover 双持有竞态无法兜底） | mkdir/rename 文件协议无 CAS 语义；Unix UDS unlink 有不可消除竞态 |
| owner 归因 | argv 注入 `--xacpx-owner-token <uuid>`（acpx `__queue-owner` 忽略尾部 argv，见 `../acpx/src/cli-core.ts:430-446`） | 共享 acpx lock 目录不证明归属 |
| 自动 fallback | 无 taskkill/T 兜底；PowerShell 不可用 → `query-failed` 保留记录；无核验强杀仅在用户确认的手动命令 | taskkill 不查 CreationDate，归因而后的复用窗口 |
| 回收判定 | daemon generation + kill-time 复核 + token/CreationDate/CIM 三因子核验 | 崩溃重启后 state 完好是常态，不能按 live session 跳过 |
| intent 清理 fencing | 四条件：>60s + 快照无 token + 非当前 generation + **launcher 已确认终止**（intent 记 `launcherPid`/`launcherCreationDate`）；shutdown drain 等 bridge 退出后才放 consumer guard | daemon 崩溃后旧 bridge 可暂停在 spawn 前，generation 检查与 spawn 非原子，不能假设旧 launcher 随 daemon 终止 |
| 保证范围 | 只覆盖"回收时刻仍链上的子树"；已断链 agent 交给 doctor/TTL | Job Object 需要原生依赖（P3 候选，需单独决策） |
| adapter release | immutable `releases/<version>-<registryHash8>-<uuid8>` + 原子 active.json pointer | 版本目录原位替换在 Windows 不可能原子 |
| GC 一致性 | 迁移不变量（先 durable 写新、后删旧） + GC 固定顺序扫描（intents→owners→residuals） + 删除前同序重扫比对 `snapshotRevision` | 避免 reaper 持 adapter guard 的耦合 |
| doLaunch 重解析 bridge 路径 | validate→state 回写→（Windows）intent 写临界区整体在 daemon 主进程（daemon 持 adapter guard）；bridge 发 RPC（Windows：`registerAdapterIntent` + `launchSettled` 等四消息、幂等键 `(id, sessionKey, intentToken)`=LaunchToken、逐状态幂等表、launcher 身份以 daemon 侧 child PID 为准、断连 registered/spawn-committed 保守保留；Unix：独立 `resolveAdapterCommand` schema，无 intent/状态机） | `onReResolved` 无法跨进程调用；guard 外预解析重新引入 pointer/GC 竞态 |
| 命令编码 | exe/entry 正斜杠规范化 + 条件双引号；禁 `\`；必须真实 acpx 端到端 round-trip 验证 | xacpx 与 acpx 的分词器都把 `\`（含双引号内）当转义 |

## 4. 跨 spec 契约面（改一处必须同步另一处）

- `src/process/ipc-guard.ts`：`acquireIpcGuard({ role, configRoot, resourceId? })`；roles：`consumer` / `lifecycle` / `adapter-op`；Windows-only。key 规范化：先 `mkdir -p`、realpath（读场景取最近已存在祖先拼接）、非 ENOENT 错误 fail closed、`/` 分隔符、Windows 小写、去尾部分隔符。
- owner 记录（`~/.xacpx/runtime/orphans/owners/…json`）：`{ schemaVersion, token, pid, queueHash, acpxRecordId, generationId, configRoot, startedAt, agentCommand, fingerprint:{executablePath, commandLine, creationDate}, killAttempts }`。intent 与 residual 同样携 `agentCommand`（residual 来自其 owner）。
- intent 记录（`intents/<token>.json`）：`{ schemaVersion: 1, kind: "intent", token, launcherPid, launcherCreationDate, generationId, configRoot, queueHash, agentCommand, createdAt }`——`launcherPid`/`launcherCreationDate` 是 launcher fencing 条件 4 的依据；bridge 路径下经 `registerAdapterIntent` RPC 由 daemon 落盘。
- **durable write 协议**：记录写入 = 同目录临时文件 → flush + fsync → `rename` 原子替换；迁移"先写新后删旧"，owner→多个 residual 时全部写成功才删 owner。
- `listOwnerAgentCommands(categories: ["intents","owners","residuals"]): Promise<{ commands: string[]; snapshotRevision: string } | null>`：扫描顺序是 API 不变量（严格 intents→owners→residuals，乱序 categories 拒绝）；目录不可读 / 任一记录缺 agentCommand / 任一解析失败 → `null`（调用方一律按"有引用"保守处理）。
- `KillOutcome` 六态（含 `skipped-replaced`）与 `BatchTarget { pid, creationDate, commandLine, executablePath }`/`ProcessTreeOutcome[]`/`TerminateProcessTreeResult`；**handle-stable 复核**（`OpenProcess` → 经 handle 查 `CreationTime` → 比较 → 同一 handle `TerminateProcess`）；**建树快照携带独立身份 + 父链**（CIM 枚举时刻一并取 CreationDate/CommandLine/ExecutablePath/parentPid/parentCreationDate，期望值禁止来自 handle 打开后）；**自顶向下父链校验**（**`child.creationDate >= parent.creationDate` 顺序校验；父必须已被实际核验——核验阶段 OpenProcess 即不存在的父 → 整批 abort**；任一祖先身份不匹配 → **整批 abort，且 abort 的子孙一律不落 residual**——killable residual 只能来自父链通过 + 指纹完整的节点）；**杀前全量核验**（任一节点身份/指纹不可得 → 整批 abort 不杀任何 PID）；**杀前追加枚举**（仅追加 `ParentProcessId ∈ 已核验且 handle 存活集合` 的节点；**时序 ① 追加枚举 → ② 父 handle 存活复核 → ③ 追加核验 → ④ 杀，任一父退出/无法确认 → 整批 abort；杀后不再枚举**——已退出的父不能担保新 child，PID 复用即误杀）；**保证范围 = 快照实际返回的节点**（枚举后新 spawn 不硬保证，Job Object 为 P3）；**CreationDate 规范格式 = FILETIME ticks，存储/传输为规范化十进制字符串（比较在 bigint/uint64；容差 |Δ| ≤ 9 仅限 CIM-derived 快照与 residual 复核，handle-derived 精确等值）**；outcome 携快照指纹；**residual 独立回收状态机**（核验 → 不匹配/已死即删、匹配则同 handle 杀、未终态保留重试；**落 residual 允许集合 = 归属已确认且指纹完整的 kill-requested-unconfirmed/access-denied/query-failed（正常批杀），未知 outcome 一律不生成**）；批会话超时未返回的 PID 一律 `query-failed`。
- `validateRelease(releaseDir, expected)`（六校验：releaseDir 目录性 / manifest / releaseId / nodeExecutable / entryRelPath / probe；spawn 命中判定豁免 probe）。
- `AdapterResolutionContext`（含 **必填** `onReResolved` + **`withSessionLock`**（session lock → adapter guard 由执行器保证，`onReResolved` 不得自行取锁；**回写必须 `DebouncedStateStore.saveNow()` 同步落盘且 copy-on-write——先构造快照、`saveNow(nextState)` 成功后才发布到运行时 state（main.ts:646 同款），不得用 debounced `save()`；磁盘写成功前不释放 guard 不返回 ack，失败经 finally 释放**；`SessionService.stateStore` 依赖类型需扩展含 `saveNow`）；**命中预装形态 + context 缺失 → launch 失败**）；bridge transport 走 RPC——**Windows**：`registerAdapterIntent`/`launcherSpawned`/`cancelAdapterIntent`/**`launchSettled`**（owner-committed：**daemon 对 ownerPid 独立核验**（命令行含 LaunchToken + handle 捕获 fingerprint）通过才迁移；launch-failed：**daemon 先完整 token 快照确认无同 token 存活进程、快照失败则保留**），**daemon 为 intent 落盘/删除唯一执行者**（handshake exited/fencing abort 均经 RPC），per-token 状态机（registering/registered/spawn-committed/owner-committed/launch-failed/canceled/aborted）、逐状态幂等表为唯一规范（**仅 `registered` 重放**、spawn-committed 及终态 register 拒绝防二次 spawn、launchSettled 同 outcome 幂等）、registering 断连置 aborted + **双检查点**（写前 + rename 后）；**Unix 独立 `resolveAdapterCommand` schema（无 intent 落盘与状态机）**；幂等键 `(id, sessionKey, intentToken)`（= `LaunchToken`，与 argv/intent/owner/residual 同一 UUID）、超时 10s + cancel（cancel 后 launcher 永不 spawn）、断连时 registered/spawn-committed **保守保留 intent**、launcher 身份以 daemon 侧 bridge child PID 为准，bridge subprocess 不持 adapter guard。

## 5. 代码现状（实施起点）

仓库 `/Users/maijiazhen/Projects/workspace-a`，包管理 Bun（`bun run build`/`npm test`/`npx tsc --noEmit`，见 `AGENTS.md`）。相关现状文件：

- `src/process/terminate-process-tree.ts` — Windows 分支目前只有 `taskkill /T /F`
- `src/transport/acpx-queue-owner-launcher.ts` — spawner `Promise<void>`→改 `{pid}`；terminator 直读 lock PID
- `src/bridge/bridge-runtime.ts:173` — BridgeRuntime 在 subprocess 内创建 launcher（登记胶水必须经 env 传入）
- `src/weixin/monitor/consumer-lock.ts` — 现有实现（Unix 保持）
- `src/daemon/daemon-controller.ts:140` — stop 目前仅 `terminateProcess`
- `src/adapters/adapter-catalog.ts` / `adapter-cli.ts` / `adapter-verifier.ts` / `adapter-registry.ts`
- `src/config/resolve-agent-command.ts` — runtimeRoot 第三参数从此处穿透
- `src/state/types.ts:32` — session 记录字段是 `transport_agent_command`（不是 `agentCommand`）
- acpx 固件事实：`../acpx/src/acp/client-process.ts:140-160` 分词器、`../acpx/src/acp/client.ts:654` spawn(she:false)、`../acpx/src/cli-core.ts:430-446` queue-owner dispatch

**源码核对补充（2026-08-04，评审第十七轮联动）**——实施前必须知道的现状事实：

- **bridge 协议单向**：`bridge-server.ts` 协议 = daemon→bridge 请求 `{ id, method, params }` → bridge 回 `{ id, ok, result }`；bridge→daemon 只有事件推送（`{ id, event, ... }`，无响应语义，见 `acpx-bridge-protocol.ts`）。spec 的 `registerAdapterIntent`/`launcherSpawned`/`cancelAdapterIntent`/`launchSettled` 是 bridge→daemon 请求且需 ack——**必须扩展协议为双向请求-响应**（或 daemon 侧事件流上加带 ack 消息），不能"直接用既有通道"。
- **session lock = `SessionService.stateMutex`**（自研 `src/orchestration/async-mutex.ts`，不可重入）；`setSessionTransportAgentCommand`（`session-service.ts:836`）内部自取该 mutex——`withSessionLock` 需 SessionService 新增公开方法（如 `withStateLock`），`onReResolved` 不得复用 `setSessionTransportAgentCommand`（锁内调用自死锁）。
- **`preferCurrentManagedAdapterCommand` 已存在**（`adapter-catalog.ts:109`，session-service.ts:727 使用）；`parseManagedAdapterCommand`（:73）只认 npx 形态——共享 decoder 的扩展点在此，不新建孤立 splitter。
- **daemon 身份**：现有 `daemon-status.ts` 的 `DaemonStatus`（status.json）无 generation/creationDate——`generation.json`/`daemonCreationDate` 全新。
- **consumer lock 元数据**：现为 `{ pid, mode, startedAt, configPath, statePath, hostname? }`，v2 字段（lockId/processCreationDate/schemaVersion）全新。
- **`quoteIfNeeded` 在 `src/util/text.ts`**（非 text.js）；`splitCommandLine` 有私有实现（`acpx-queue-owner-launcher.ts:178`）。

## 6. 实施顺序（按 spec）

1. **P0**：`src/process/windows-processes.ts` + `ipc-guard.ts` + 批杀契约（含 `query-failed` 补齐）+ `terminateProcessTree` 返回明细。
2. **P1a**：consumer lock Windows 切 IPC guard（Unix 不变）。
3. **P1b**：identity context → token argv + readiness handshake → legacy owner 迁移 → intent/owner/residual 登记 → 启动 reaper（snapshot 优先、集中批杀、二次对账 timer）。
4. **P1c/P1d**：controller stop（四态 + kill 后确认 + generation 冻结 sweep + lifecycle guard）。
5. **P2**：adapter 预安装（独立 spec，含 GC 协议、validateRelease、doLaunch 注册段、onReResolved）。
6. **P3（候选）**：Job Object——需先决策是否接受原生依赖，单独跟踪，不阻塞主线。

实施纪律：最小改动、不碰 session 生命周期语义、不改 daemon IPC、Unix 不引入新东西；每个 P 完成跑 `npm test`（typecheck + 单测）；Windows 集成测试目前没有 CI runner，手动验证记录进 PR 描述。

## 7. 新评审意见的处理流程

1. **先复现**：grep 两份 spec 当前正文 + 核对行号内容；已修复的逐条指出证据（文件:行号）回复，不改文档。
2. 真问题：判断影响面，优先改设计再改措辞；**跨 spec 契约面（第 4 节）逐字同步**。
3. 每条修复写入修订历史（新一轮 bullet + 编号对应评审点）；stale 条目追加到「评审 stale 备忘」。
4. 不要自行标 ready；ready 由主审确认后标。

## 8. 已知遗留 / 风险

- Windows 集成测试无 CI runner（start/stop/crash/powerShell 不可用/锁竞态/**launcher fencing 崩溃场景**（windows spec 第十一轮必跑项）需人工）；Unix 侧 `flock` 双进程/`kill -9` 两场景需人工（锁文件删除已被"永不删除"不变量排除，第十二轮）。
- token argv 依赖 acpx 忽略尾部参数的行为——固定受支持版本契约；若 acpx 改为 parse 尾部 argv，触发 handshake 超时路径（alive→保留 intent+报错），设计上已兜底但需回归测试。
- legacy owner 复用路径在 TTL=0 配置下只有告警+手动迁移，不作自动强杀。
- `xacpx doctor` 的 `orphan kill --confirm` 是唯一无核验强杀出口，文案必须明确风险。
