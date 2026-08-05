# Adapter 预安装设计（消除 npx shim 链）

**Date:** 2026-08-03（2026-08-04 第十七轮评审修订）
**Status:** Approved for implementation; implementation plan: `docs/superpowers/plans/2026-08-05-windows-orphan-process-and-adapter-preinstall.md`

## 目标

提供 **opt-in** 的 adapter 预安装能力：用户通过 CLI 把托管 adapter（codex/claude）安装到本地固定路径，session 命令从 `npx -y ...` 变为 `"<node>" "<abs-js-entry>"`，砍掉 Windows 上 `npx.cmd` → `node.exe` 的 shim 层。默认行为完全不变。

核心状态模型：**安装内容与启用状态分离 + 不可变 release + 共享 guard 协议 + GC 一致性**。

修订历史（近期）：

- **第四轮**：`validateRelease()`；owner 契约；信任边界（releaseId 格式 + containment + 命令重构）。
- **第五轮**：操作互斥换 IPC guard。
- **第六轮**：GC 同步协议（引用注册/GC 同 guard）；终路径强制 probe；`validateRelease(expected)`。
- **第七轮**（修复 2 P0 + 3 P1 + 1 P2 中的新内容；两点经核对为 stale——windows spec 接口在第九轮已扫描 intents+owners+residuals，其 §P1b-2 与组件列表逐字如此；inode/mtime 夺权机制第五轮已删）：
  1. **GC 一致性改为"迁移不变量 + 双扫描"**：登记表迁移（intent→owner→residual）遵循"先 durable 写新、后删旧"（已在 windows spec §P1b-3 规定），GC 在 guard 内做"扫描 → 决定 → 每次删除前重扫"——重扫发现任一引用来源变化即放弃该次删除。reaper 无需持有 adapter guard；
  2. guard key 统一为结构化 `{ role, configRoot, resourceId? }`（与 windows spec 签名逐字一致，不再字符串拼接）；
  3. **Unix 侧 guard 语义显式化**：IPC guard 是 Windows-only（windows spec 第九轮）；Unix 上 adapter 操作用 `flock` 风格 best-effort 文件锁，文档明确为 advisory，CM 竞态由 GC 双扫描兜底（**第八轮已废弃该方案**：advisory 锁改 `flock(2)` OS 互斥，双扫描不再兜底互斥竞态）；
  4. `doLaunch` 重解析的上下文注入与 **state 回写**定义完整（见 3.6）；
  5. runtime 静态校验升级为 `stat().isFile()` + Unix 执行位检查。
- **第八轮**（修复 1 P0 + 4 P1，评审无 stale）：
  1. **P0：Unix 操作互斥改用 `flock(2)`**——旧版 `open wx` + PID 文件协议存在 stale takeover 双持有者竞态（A、B 同判 stale，B 可删 A 的新锁再建自己的锁），且 GC 双扫描只覆盖扫描期间变化、兜不住"最终扫描→rm"窗口与 pointer swap / staging 恢复等 mutation，不再称其为 "flock 风格 advisory"；
  2. **P1：`listOwnerAgentCommands(categories)` 把扫描顺序列为 API 不变量**（windows spec 逐字同步；GC 一致性证明依赖 intents→owners→residuals 严格顺序）；
  3. **P1：bridge 路径选定方案**——整个 validate→state 回写→intent 写临界区放回 daemon 主进程（daemon 持 guard），bridge 经既有 JSON 通道发 `registerAdapterIntent` RPC；定义幂等键、超时、断连语义，删除"client 侧预解析"备选（guard 外预解析重新引入 pointer/GC 竞态）；
  4. **P1：GC fail-closed 覆盖全部引用来源**——state.json 读取、splitter 分词、路径规范化任一失败 → 本轮 GC 整体中止不删；
  5. **P1：releaseId 规则自包含**（正则 + version/registryHash8/uuid8 拼接逐字恢复）；"六项校验"补齐为六项（新增 releaseDir 目录性检查）。
- **第九轮**（本轮，随 windows spec 第十一轮评审联动修订）：
  1. **GC 删除前重扫改为比对 `snapshotRevision`**——旧版要求比较"记录序号变化"，但接口只返回 `string[]`，无法区分记录迁移/增删/替换；windows spec 接口同步改为返回 `{ commands, snapshotRevision } | null`（revision = 扫描所见全部记录文件名+内容的稳定摘要），§3.5 第 2/4 步逐字更新；
  2. **`registerAdapterIntent` RPC 携带 launcher 身份**——windows spec intent schema 新增 `launcherPid`/`launcherCreationDate`（launcher fencing 条件 4），bridge 路径下 intent 由 daemon 落盘，RPC 字段同步补齐；
  3. intent 清理引用更新为**四条件**（windows spec §P1b-4 新增 launcher 终止确认）。
- **第十轮**（本轮，随 windows spec 第十二轮评审联动修订，评审 2 P0 + 4 P1；无 stale）：
  1. **P0：`registerAdapterIntent` 幂等键改 `(id, sessionKey, intentToken)`**——旧键 `(id, sessionKey)` 把同一 session 的后续正常 launch 误判为重试：第二次 launch 的新 `intentToken` 可能收到第一次的结果，导致 token 重用、intent 不落盘、多进程共享 owner token；幂等键必须含本次 launch 的唯一 token，**相同键但 payload 不同 → 拒绝**；
  2. **P1：RPC 超时/断连增加带 token 的 cancel 协议**——超时后 daemon 可能已落盘 intent（属当前 generation，不满足 windows spec 清理条件 3、只能等重启）；bridge 超时后放弃 launch（**绝不 spawn**）并发送 `cancelAdapterIntent`；断连视为隐式取消；乱序到达按 token 拒绝，保证最终无该 token 的 intent 残留；
  3. **P1：Unix `flock` 锁文件"永不删除"不变量**——`flock` 绑定 open file description，unlink 后同路径重建是另一 inode、可另取一把锁；原"删锁文件不影响互斥"表述修正为"锁文件在系统生命周期内禁止删除"，删除不可能通过的 rm 测试；
  4. **P1：canonicalRegistry 唯一规范化形态**——原版只在 hash 计算时 `trim().replace(/\/+$/, "")`，manifest/expected 等价比较仍可能用原字符串，`https://registry.example/` 与无尾斜杠形态 hash 相同但运行时可能拒绝有效 active release；定义 canonicalRegistry 统一用于 hash、manifest 存储、expected、等价判断与运行时解析。
- **第十一轮**（本轮，随 windows spec 第十三轮评审联动修订；P0 落 windows spec——批杀/stop 改 handle-stable；本 spec 4 个 P1，无 stale）：
  1. **P1：launcher 身份不以 bridge 上报为准**——`registerAdapterIntent` payload 的 `launcherPid/launcherCreationDate` 若因 bug/PID 获取竞态/协议版本不一致而错误，清理器可能把仍存活的 launcher 判为已死，重开"intent 被删后恢复 spawn"窗口；daemon 以自己持有的 bridge child PID 为准落盘并独立查询 CreationDate，payload 仅作一致性校验（windows spec intent 字段语义同步）；
  2. **P1：RPC 定义 per-token 状态机**——`registering → registered → spawn-committed/canceled`；"在途断连即删 intent"未定义请求何时不再在途：ack 已发而 bridge 是否收到未知，立即删除可能撞上已开始的 spawn；改为 `registered` 状态断连**保守保留 intent**（由 windows spec 四条件 + generation 轮换回收），删除只发生在 cancel（bridge 主动承诺不 spawn）路径；bridge spawn 成功后须发送 `launcherSpawned` 确认；
  3. **P1：active pointer 原子发布协议恢复**——preinstall 只写 "pointer swap"，未规定 tmp 写入 → flush/fsync → 原子 rename；运行时并发读可能见半写；同时规定 crash 后 `active.json.tmp-*` 恢复规则；
  4. **P1：GC 引用判定改 `path.relative` containment**——原"规范化前缀命中"未定义路径边界、Windows 大小写与 symlink/realpath 行为；改为 `path.relative(releaseDir, entryPath)` 边界明确判定 + case-folding，realpath 失败 fail-closed。
- **第十二轮**（本轮，评审 4 P1 + 2 小问题；P1 主体落 windows spec——批杀返回值、stop 树杀、CreationDate ticks；本 spec 同步/修正如下，无 stale）：
  1. **P1：RPC/intent/登记表显式声明 Windows-only**——`registerAdapterIntent` RPC、intent 落盘、孤儿登记表引用源依赖 windows spec 的 launcher fencing 与 CIM CreationDate，是 Windows 孤儿清理机制（windows spec §P1b 显式声明）；**Unix 上引用注册段只做 validateRelease 静态校验与重解析（onReResolved 回写），不写 intent、不发 RPC**；GC 在 Unix 上的引用集合 = active pointer + state.json 两源，登记表来源不启用；
  2. **P1：`onReResolved` 在提供 `adapterContext` 时必填**——旧版类型可选但流程无条件调用，缺失回调会在版本切换时中断 transport 状态迁移；改为接口必需 + 装配期校验（缺失即报错），完全不提供 `adapterContext` 的调用方 → 引用注册段整体跳过（npx 回退语义）；
  3. 小问题：GC 引用判定边界条件修正——`rel !== ".." && !rel.startsWith(".." + path.sep)`（"不以 `..` 开头"会误拒绝合法目录名 `..foo`）；"空串保守命中"保留。
- **第十三轮**（本轮，评审 2 P0 + 6 P1 中本 spec 部分；P0 与 P1 主体同步 windows spec 第十五轮；无 stale）：
  1. **P0：GC 引用判定解析错误的命令 token**——命令格式是 `<node> <abs-js-entry>`，原判定把 `args[0]`（= nodeExecutable，位于 release 外）当 entryPath，state/intent/owner 引用旧 release 时 GC 仍可能删除；改为**共享结构化 decoder**：校验 `args[0]` 为受控 nodeExecutable 后以 `args[1]` 判定 entry containment，测试用完整命令；
  2. **P1：per-token 状态机与真实生命周期对齐**——registered 时序改为"durable 写 intent 后、发 ack 前"（写入后 ack 失败/断连不再误留 registering）；补齐 `owner-committed`（handshake 成功，intent→owner 迁移）与 `launch-failed`（handshake 确认进程已退出）终态及各自删除责任方；spawn 前 fencing abort 复用 cancel 路径；"唯一删除路径"表述修正为"删除路径全集"；
  3. **P1：Unix bridge 回写走 daemon RPC**——函数型 `onReResolved` 无法经 env/options 传给 subprocess 内联调用（第八轮"函数无法跨进程"的约束同样适用 Unix）；Unix 上 bridge 经同一 JSON 通道请求 daemon 在 guard 内执行 validate/重解析/state 回写，ack 返回最终命令后才 spawn；仅 intent 落盘与 per-token 状态机为 Windows-only；
  4. **P1：命中预装形态但 `adapterContext` 缺失必须失败**——"无 context 即跳过注册"会放过"Windows 调用方传入预装命令却漏装 context → 无 intent 直接 spawn"；改为按命令形态分类：命中预装形态 → context 缺失即 launch 失败。
- **第十四轮**（本轮，评审 2 P0 + 6 P1 中本 spec 部分；P0 与 P1 主体同步 windows spec 第十六轮；无 stale）：
  1. **P1：新增 `launchSettled` completion RPC，daemon 为 intent 落盘/删除的唯一执行者**——`owner-committed`/`launch-failed` 缺少消息载体，且"launcher 直接删 intent"会让 daemon 内存停在 `spawn-committed`；定义 `launchSettled { id, sessionKey, intentToken, outcome: "owner-committed" | "launch-failed" }`，迁移与删除统一经 daemon（幂等/乱序/断连规则见状态机）；
  2. **P1：`registering` 断连改 abort 标记 + 发布前原子检查**——"直接丢弃"与 guard 内后台写入竞态：断连后临界区仍可能 durable 写出 intent 而无人跟踪；断连置 token abort，临界区在写 intent 前无 await 间隙检查，已 abort 则不落盘；
  3. **P1：逐状态幂等表**——"重放旧结果"与"终态后拒绝"冲突；规定 registering 去重、registered 重放、spawn-committed 及全部终态拒绝（防旧 ack 二次 spawn），bridge 侧 ack 本地幂等；
  4. **P1：`LaunchToken` 唯一身份**——argv/intent/owner/residual/RPC 的 token 字段是同一 UUIDv4（windows spec 第十六轮同步）；
  5. 小问题：Unix 独立 `resolveAdapterCommand` schema（不复用含 Windows launcher 字段的 `registerAdapterIntent`）；锁顺序不变量（session lock → adapter guard）；`BatchTarget` 注释与 durable 持久性声明同步 windows spec。
- **第十五轮**（本轮，评审 1 P0 + 5 P1 中本 spec 部分；P0 落 windows spec——父链存疑整批 abort 且不落 residual；本 spec 4 个 P1 + 1 测试文字问题；无 stale）：
  1. **P1：锁顺序重构为 `withSessionLock` 执行器**——"session lock → adapter guard"与"持 guard 后 onReResolved 自行取 session lock"矛盾，且接口没有预先持锁进临界区的能力；context 新增 `withSessionLock<T>(fn)`（调用方实现：先取 session lock、执行 fn、释放），临界区整体在锁内执行，`onReResolved` 不再自行获取锁；
  2. **P1：registering 断连补发布后二次检查**——写前无 await 检查挡不住 write/flush/fsync/rename 的异步窗口；rename 完成后、进入 registered 前再次检查 aborted，已 aborted → 删除刚落盘 intent（不产生残留）；
  3. **P1：owner-committed 的 owner 身份由 daemon 独立核验生成**——payload 不再含 `ownerStartedAt`；daemon 对上报 `ownerPid` 做 handle-stable 核验（命令行含 `--xacpx-owner-token <LaunchToken>` + `GetProcessTimes`/`QueryFullProcessImageName` 捕获 fingerprint），通过才写 owner 删 intent，防 PID 复用窗口；
  4. **P1：幂等表成为唯一规范**——删除通用"相同 payload 总是重放"表述（与状态表冲突）；`launchSettled` 同 outcome 幂等重放作为显式例外写入终态规则；
  5. 测试文字问题：GC 判定用例拆分为"`args[0]` 非受控不命中"与"`args[0]` 受控 + `args[1]` 在 release 内命中"两个独立用例。
- **源码核对注记（2026-08-04，评审第十七轮联动；不新增评审轮次）**：将 spec 机制假设与仓库源码逐项对照后补注三处——(a) **bridge 协议方向**：现有 `bridge-server.ts` 协议为 daemon→bridge 请求 / bridge→daemon 事件推送（无响应语义），spec 的四条 bridge→daemon RPC 需扩展协议为双向请求-响应；(b) **session lock 载体**：SessionService `stateMutex`（自研 `src/orchestration/async-mutex.ts`，不可重入），`withSessionLock` 需暴露新公开方法，`onReResolved` 不得复用 `setSessionTransportAgentCommand`（内部自取同一 mutex → 自死锁）；(c) **共享 decoder 落点**：现有 `adapter-catalog.ts:73` `parseManagedAdapterCommand` 只认 npx 形态，扩展为受控预装形态 decoder，不另建孤立 splitter 模块。
- **第十六轮**（本轮，评审 2 P0 + 4 P1 + 2 stale 测试文字中本 spec 部分；P0 落 windows spec——父链创建时间顺序与父未核验 abort；本 spec 2 个 P0 级联动 + 2 P1 + 1 stale；无 stale）：
  1. **P0 级：state 回写必须同步落盘（`saveNow`）**——生产 `DebouncedStateStore.save()` 接受快照即返回、磁盘写入延后（debounce 50ms）；Unix 无 intent/owner registry 第二引用源，guard 释放后立即 uninstall/GC 可能读旧 state.json 删除刚启动进程引用的新 release；`onReResolved` 必须调用 `saveNow()`（同步 flush、失败即抛错 → launch 失败），**磁盘写成功前不释放 guard、不返回 ack**；
  2. **P0 级联动：父链创建时间顺序**（windows spec 第十八轮）——`child.creationDate >= parent.creationDate` 且父必须已被实际核验；
  3. **P1：`launch-failed` 删除前需完整 token 快照**——queue owner/root 退出不证明带 LaunchToken 的 descendant 已退出（token 在 agent 命令行）；daemon 删 intent 前执行完整进程快照确认无任何同 token 进程，快照失败 → 保留 intent（与 windows spec 清理条件 2 同款 fail-closed）；
  4. **P1：doLaunch 摘要流程同步 `withSessionLock`**——步骤 2/3 旧"持 guard 后调用 onReResolved"表述与新锁事务一致，防实施者按摘要引入 ABBA/self-deadlock；
  5. stale：边界章节"重复 register 幂等重放"限定为状态表 `registered`（`spawn-committed` 与终态明确拒绝）。
- **第十七轮**（本轮，评审 1 P0 + 4 P1/stale 中本 spec 部分；P0 落 windows spec——杀后二次枚举改杀前追加枚举；本 spec 1 个 P1；无 stale）：
  1. **P1：state 回写改 copy-on-write**——`saveNow()` 失败不回滚已修改的共享 `LogicalSession`，后续无关 `save()` 会把失败命令落盘；改为先构造 nextState 快照 → `saveNow(nextState)` 成功 → 发布到运行时 state（`main.ts:646` Orchestration `saveState` 同款 `replaceRuntimeState`）；`SessionService.stateStore` 依赖类型需从 `Pick<StateStore, "save">` 扩展含 `saveNow`（`session-service.ts:81`）；测试的"guard 未释放"改为"settle 前不得释放、失败回滚后 `finally` 释放"（防永久持锁）。

## 设计

### 1. 安装布局与 release 不变量

```
<runtimeRoot>/adapters/
  <id>/
    active.json                     # { "version", "releaseId", "activatedAt" }
    releases/<releaseId>/           # immutable
      node_modules/…
      installed.json
  <id>/.staging-<uuid>/
```

- **releaseId 构成（自包含定义）**：`releaseId = <version>-<registryHash8>-<uuid8>`。
  - **canonicalRegistry（唯一规范化形态，评审 P1）**：`canonicalRegistry = registry.trim().replace(/\/+$/, "")`（去首尾空白 + 去尾部斜杠）。**所有**涉及 registry 的环节一律使用该 canonical 值、不得用原字符串比较：`registryHash8` 计算、`installed.json.registry` 存储、`validateRelease` expected 字段与"等价"判定、复用判定、运行时解析（`https://registry.example/` 与 `https://registry.example` 因此 hash、等价、复用全部一致）；
  - `version`：安装参数中的 adapter 版本字符串（如 `1.0.4`）；
  - `registryHash8`：`sha256(canonicalRegistry)` 十六进制摘要的**前 8 位小写**；
  - `uuid8`：随机 UUIDv4 的**前 8 位十六进制**（每次安装新生成）；
  - 全串正则：`^[A-Za-z0-9._-]+-[0-9a-f]{8}-[0-9a-f]{8}$`——末尾两组定长 hex，version 段即使含 `-` 拆分仍无歧义；
  - 信任边界 = 格式正则 + containment（releaseDir realpath 必须位于 `<adaptersRoot>/<id>/releases/` 内，所有相对路径 join 后不得逃逸），不做"目录名 ↔ 内容"以外的来源推断；
- `<releaseDir>/installed.json`：`{ schemaVersion: 1, id, packageName, version, releaseId, registry, nodeExecutable, entryRelPath, installedAt }`（`registry` 字段存 canonicalRegistry）；"等价"仅比较 `{ packageName, version, registry, entryRelPath, nodeExecutable }`（registry 按 canonical 值比较）。

### 2. `validateRelease(releaseDir, expected)`（含 stat 校验，评审 P2）

expected：`{ id, version, packageName, registry, releaseId }`（`registry` 一律为 canonicalRegistry 形态，进入校验前规范化）；来源语义：复用时 `{id, effectiveVersion, effectiveRegistry, 候选目录名}`；runtime 解析 active 时用 pointer 字段；新装发布用安装参数。

六项校验：

1. `releaseDir` 存在且是目录（`stat().isDirectory()`）；
2. manifest 可读、schemaVersion 合法、各字段 === expected；
3. `releaseId` 格式合法（§1 正则）、`manifest.releaseId === expected.releaseId === 目录名`、containment；
4. `nodeExecutable`：规范化绝对路径、basename ∈ {`node`,`node.exe`}、**`stat().isFile()` 且 Unix 下可执行（`access(X_OK)`）**；
5. `entryRelPath` 位于 releaseDir 内、realpath 不逃逸、**`stat().isFile()`**；
6. initialize probe（spawn 命中判定豁免，见 4.2）。

命令从校验字段重构（`nodeExecutable` + `join(releaseDir, entryRelPath)`），编码协议生成字符串。

### 3. 安装/卸载/恢复/GC

#### 3.1 操作互斥（结构化 guard key + Unix `flock(2)`，评审第八轮 P0）

- Windows：`acquireIpcGuard({ role: "adapter-op", configRoot, resourceId: id })`（与 windows spec 签名逐字一致；内核排他，进程死即释放）；
- **Unix：`flock(2)` 文件锁**：锁文件 `<runtimeRoot>/adapters/.locks/adapter-op-<id>.lock`（内容不承载语义，可含持有者 pid 仅作诊断）。获取 = `open(lockPath, O_CREAT|O_RDWR, 0o644)` 后 `flock(fd, LOCK_EX | LOCK_NB)`，失败（`EWOULDBLOCK`）即报 `AdapterOpLockBusyError`；释放 = `flock(fd, LOCK_UN)` + close。**互斥由 OS 保证**：锁挂在 open file description 上，进程退出（含崩溃）内核自动释放；**不存在"判 stale → 删锁文件 → 重建"的夺权路径**——持有者进程崩溃后内核自动释放锁，无需任何 stale 判定（旧版 `open wx` + PID 判定协议已废弃：A、B 同时判 stale 时 B 可删 A 新锁再建自己的锁，双持有者竞态无法用 GC 双扫描兜底）；
- **锁文件永不删除（评审 P1 不变量）**：`flock` 绑定的是 open file description 而非路径——**锁文件被 `unlink` 后，同一路径重新创建的是另一 inode，新获取者可在新 inode 上另取一把锁**，与原持有者互斥即失效。因此协作进程在系统生命周期内**禁止删除锁文件**（崩溃残留无需清理、不影响后续获取，见 3.4）；
- 同 id 串行、跨 id 并行；获取失败明确报错。

#### 3.2 preinstall

取 guard → 崩溃恢复 → staging 安装（registry 透传）→ entry 解析 + realpath → Node resolver → 等价 release 复用判定（validateRelease 全项）→ 否则 manifest 写入 staging、staging 内 probe、`rename(staging, releases/<releaseId>/)`、**最终路径完整 validateRelease（静态 + probe，强制）**→ **pointer 原子发布（评审 P1）**：写 `active.json.tmp-<uuid>` → flush + fsync → `rename` 为 `active.json`（与 windows spec §P1b-2 durable write 协议同款；rename 原子替换，运行时的并发读者只会看到旧或新完整内容，绝不读见半写）→ 释 guard 清 staging。

#### 3.3 uninstall

取 guard → 删 pointer（立即回退 npx）→ GC（3.5）。

#### 3.4 崩溃恢复

删 `.staging-*` 与 `active.json.tmp-*`（pointer 发布残留，见 3.2；tmp 文件不承载语义，直接删除）；pointer 悬垂（release 缺失/残缺）→ 删 pointer + 记日志。Windows guard 无锁垃圾；Unix `flock` 随进程退出自动释放，锁文件残留无影响、无需清理（且按 3.1 不变量**不得删除**，仅可读取诊断）。

#### 3.5 旧 release 回收（GC：迁移不变量 + 双扫描，评审 P0）

登记表侧不变量（windows spec §P1b-3 规定）：intent→owner→residual 迁移**先 durable 写新记录、后删旧**，任一时刻至少一份副本存在。

GC 协议：

1. 持 guard；
2. **第一遍扫描引用全集**：active pointer、state.json 全部 `transport_agent_command`、登记表 `listOwnerAgentCommands(["intents", "owners", "residuals"])`（**Windows-only 引用源**——孤儿登记表属 windows spec §P1b 机制，Unix 不启用；Unix 上 GC 引用集合 = pointer + state 两源）→ 记录 `{ commands, snapshotRevision }`（与 pointer/state 命令集合一同留作比对基线）。**扫描顺序 `intents → owners → residuals` 是 `listOwnerAgentCommands` 的 API 不变量**（windows spec §P1b-2 逐字同步；实现不得硬编码其它顺序，传入乱序 categories 必须拒绝，每次扫描必须完成一类后才开始下一类）——配合迁移不变量"先 durable 写新、后删旧"，任一时刻至少有一份副本位于"尚未扫到或已扫到"的覆盖内，首扫即不漏；
3. **fail-closed（评审 P1）**：任一引用来源的读取或解析失败——pointer 读取、state.json 读取/JSON 解析、`listOwnerAgentCommands` 返回 null（Windows；Unix 不启用该来源）、命令 splitter 分词抛错、路径规范化失败——**本轮 GC 整体中止，不删任何 release** 并记日志。宁可留下旧 release，不得漏见引用；
4. 对判定无引用的每个 release：**删除前立即按同一固定顺序重扫**同一引用全集，比对登记表的 `snapshotRevision`（及 pointer/state 命令集合）与首扫基线——revision 不同说明任一记录发生迁移、增删或替换 → **放弃该 release 的删除**并记日志；
5. 删除即 `rm -rf`（best-effort，失败留待下次）。

引用判定（评审 P1 + 第十五轮 P0；**共享 decoder 源码落点**：扩展现有 `src/adapters/adapter-catalog.ts` 的 `parseManagedAdapterCommand`——当前只认 npx 形态（`npx -y <pkg>@<ver>` 等），需新增受控预装形态 `<node> <abs-js-entry>` 识别，作为 GC 判定与运行时解析的唯一 decoder；不再另建孤立 splitter 模块）：命令经共享结构化 decoder 解析：**先校验 `args[0]` 为受控 nodeExecutable**（规范化绝对路径 + basename ∈ {`node`,`node.exe`}，与 validateRelease 第 4 项一致），**再以 `args[1]` 为 entryPath 判定 containment**——命令格式是 `<node> <abs-js-entry>`，`args[0]` 是 release 外的 node 本体，误用它判定会导致"state/intent/owner 引用旧 release 时 GC 仍删除该 release"；非受控形态（如 `npx -y …` 或单段命令）→ decoder 返回不命中（该命令不构成对预装 release 的引用，无需 containment 判定）。containment：**entryPath 与 releaseDir 均先 realpath 规范化**，`rel = path.relative(realpath(releaseDir), realpath(entryPath))`，**命中 ⇔ `rel === ""`（保守命中）或（`rel !== ".."` 且 `!rel.startsWith(".." + path.sep)`）**——`..`/`../…` 开头即逃逸不命中；相对形式排除同名前缀误命中（如 `releases/<id>-extra/…` 不会命中 `<id>` 的 release），且不会误拒 `..foo` 这类合法目录名。Windows 下比较前整串大小写折叠（lowercase，与 guard key 规范化同款）。**任一解码/realpath/规范化失败 → 该引用命中不明 → 按"有引用"保守处理**（fail-closed，本轮 GC 中止不删，见第 3 条）。

#### 3.6 doLaunch 重解析：上下文注入与 state 回写（评审 P1）

launcher 侧新增注入（cli transport 由 buildApp 装配；bridge transport 经 env/options 链路与 windows spec 相同方式传入）：

```ts
interface AdapterResolutionContext {
  id: ManagedAdapterId;
  runtimeRoot: string;
  adapterRegistry?: string;
  adapterVersions?: AdapterVersionOverrides;
  /** 重解析生成新命令后的原子回写钩子（由调用方实现，见下）。提供 adapterContext 即必填（评审第十二轮）。 */
  onReResolved: (newCommand: string) => Promise<void>;
  /** 在持有 session lock 的上下文中执行 adapter 临界区（评审第十五轮；调用方实现，见锁顺序）。 */
  withSessionLock: <T>(fn: () => Promise<T>) => Promise<T>;
}
```

`LaunchQueueOwnerInput` 新增 `adapterContext?: AdapterResolutionContext`。doLaunch 引用注册段（**整体包在 `adapterContext.withSessionLock` 内执行（评审第十六轮，锁顺序 = session lock → adapter guard）；guard 由 daemon 主进程持有**，见本节末尾 bridge 选型）：

1. 取 `agentCommand`（调用方已解析）→ 形状判定其引用哪个 release；形状不命中预装形态 → 注册段整体跳过（npx 回退语义，无 intent 可写）；
2. 在 `withSessionLock` 上下文中取 adapter guard 做 `validateRelease` 静态项；有效 → 写 intent（携 `agentCommand`；**intent 落盘为 Windows-only**，见平台边界 bullet）；
3. 失效（pointer 已切走）→ 在 `withSessionLock` 上下文中重解析当前命令 → **`await adapterContext.onReResolved(newCommand)`（复用已持有的 session lock，先同步落盘回写，再写 intent；见 state 回写契约）** → 写 intent（携新命令）。

**平台边界（评审第十二/十三轮）**：引用注册段的 **intent 写入、`registerAdapterIntent` RPC 的 per-token 状态机与 launcherSpawned/cancel 消息是 Windows-only**（孤儿登记表属 windows spec §P1b 机制，launcher fencing 依赖 CreationDate）；**Unix 上本段不写 intent、无状态机，但 validate 与 state 回写走同一 daemon RPC 通道**（见 bridge 选型 bullet）——GC 在 Unix 上的引用来源只有 active pointer 与 state.json（§3.5 第 2 步）。

**装配契约（评审第十二/十三轮）**：`onReResolved` 在提供 `adapterContext` 时**必填**（接口层面必需；缺失 = 装配 bug，启动/装配期即报错，不得带着缺失回调进入 launch——否则版本切换时 transport 状态迁移中断）。**按命令形态分类而非按 context 有无**：第 1 步形状判定**命中预装形态时 `adapterContext` 必须存在**（Windows 上漏装 context 而直接 spawn 会造成无 intent 的预装命令，绕开登记）——命中预装形态 + context 缺失 → **launch 失败**（装配错误，fail-closed）；形状不命中（npx 等非受控形态）→ 注册段跳过，context 可有可无。

**state 回写契约（评审第十五/十六轮）**：`onReResolved` 由 SessionService 装配，**仅在 `withSessionLock` 提供的 session lock 上下文中被调用（不得自行获取 session lock）**；实现为原子更新 `LogicalSession.transport_agent_command` **并同步落盘**——**必须调用 `DebouncedStateStore.saveNow()`（同步 flush 到磁盘、失败即抛错 → 整个 launch 失败），不得使用 `save()`**（生产实现接受快照即返回、磁盘写入延后 debounce 50ms：guard 释放后 uninstall/GC 可能读到旧 state.json，删除刚启动进程引用的新 release；Unix 无 intent/owner registry 作为第二引用源，此要求跨平台成立）。**copy-on-write（评审第十九轮 P1）**：`saveNow()` 失败不会回滚已修改的共享对象——**先构造 nextState 快照**（仅含 `transport_agent_command` 变更的 state 副本，**不直接修改共享 `LogicalSession`**）→ `await saveNow(nextState)` 成功 → **才发布到运行时 state**（`main.ts:646` Orchestration `saveState` 同款：`replaceRuntimeState(state, nextState)`）；写盘失败 → 内存不变（无需回滚）、launch 失败。**磁盘写成功前不释放 adapter guard、不返回 ack**（不允许"intent 已从新 release 登记、state 还指旧路径"或"state 落盘未确认即回执"的漂移）。

**锁顺序（评审第十四/十五轮）**：全局统一顺序 = **session lock → adapter guard**，由 `withSessionLock` 保证——调用方（SessionService）实现 `withSessionLock(fn)` = **先取 session lock → 执行 `fn`（`fn` 内部取 adapter guard）→ 释放**；**daemon 的 validate→state 回写→（Windows）intent 写临界区整体包在 `withSessionLock` 内**（cli 与 bridge 路径一致），`onReResolved` 直接复用已持有的 session lock。**任何代码路径不得逆序**（guard 内不得再获取任何 session lock，防 ABBA/重入死锁）。preinstall/GC 只持 adapter guard、不触碰 session 锁，不参与该顺序。**源码落点（核对）**：session lock 的现实载体是 SessionService 的 `stateMutex`（自研 `src/orchestration/async-mutex.ts`，不可重入）——`withSessionLock` 需由 SessionService 暴露新公开方法（如 `withStateLock(fn)` = `mutate(fn)`）；**`onReResolved` 的实现不得复用现有 `setSessionTransportAgentCommand`（其内部自取同一 mutex，在锁内调用即自死锁）**，应在已持锁上下文中按 copy-on-write 构造快照并调用 `saveNow()`（见 state 回写契约——`persist()` 走 debounced `save()`，不满足同步落盘要求）；**`SessionService` 的 `stateStore` 依赖类型需从 `Pick<StateStore, "save">` 扩展为含 `saveNow`（`session-service.ts:81`），durable writer 接口同步扩展**。

**bridge 路径选型（评审第八轮 P1，二选一已定案：临界区回归 daemon 主进程）**：bridge subprocess 持 adapter guard 时，普通函数形式的 `onReResolved` 无法跨进程调用；而 daemon 侧在 guard 外"预解析"会重新引入 pointer/GC 竞态——两条备选不等价，spec 选定前者方向但由 daemon 持锁：

- **整个 validate→state 回写→（Windows）intent 写临界区在 daemon 主进程执行、由 daemon 持 adapter guard**。cli transport 下 launcher 与 SessionService 同进程，直接内联执行；bridge transport 下 bridge subprocess **不持 adapter guard、不做 validate、不写 state**，spawn 前经既有 bridge JSON 通道向 daemon 发送 `registerAdapterIntent { id, sessionKey, agentCommand, intentToken, launcherPid, launcherCreationDate }`（Windows 字段全集；**`intentToken` = `LaunchToken`（windows spec §P1b-1，与 argv/intent/owner/residual 同一 UUIDv4，不得分别生成）**），daemon 在 guard 内执行临界区（形状判定 → validateRelease 静态项/重解析 → state 回写 → Windows 上写 intent），ack 返回最终 `agentCommand`（与 `intentToken`）；bridge 收到 ack 后才 spawn。**intent 的落盘与删除唯一执行者是 daemon**（launcher 不得自行删除 intent；cli transport 同进程内联仍走同一代码路径）。**消息集（Windows）**：`registerAdapterIntent`（注册）、`launcherSpawned { id, sessionKey, intentToken }`（spawn 成功后立即发送）、`cancelAdapterIntent { id, sessionKey, intentToken }`（放弃，含 spawn 前 fencing abort）、**`launchSettled { id, sessionKey, intentToken, outcome: "owner-committed" | "launch-failed" }`（handshake 结果，评审第十四轮）**——owner 迁移与 launch 失败的 intent 删除均由 daemon 在收到 `launchSettled` 后执行（launcher 上报，不做文件操作）；**Unix 独立 schema `resolveAdapterCommand { id, sessionKey, agentCommand }` → ack `{ agentCommand }`**（无 intentToken/launcher 字段、无状态机、无 launcherSpawned/cancel/launchSettled）：由 daemon 执行同样的 validate/重解析/state 回写，ack 返回最终命令后才 spawn——函数型 `onReResolved` 无法经 env/options 传给 subprocess 内联调用（第八轮"函数无法跨进程"的约束同样适用于 Unix，不存在"Unix 内联执行回调"的可行路径）；**协议方向（源码核对，评审第十七轮）**：现有 bridge 协议是"daemon→bridge 请求 / bridge→daemon 事件推送（`{ id, event, ... }`，无响应语义）"（`bridge-server.ts` + `acpx-bridge-protocol.ts`）——spec 的 `registerAdapterIntent`/`launcherSpawned`/`cancelAdapterIntent`/`launchSettled` 是 **bridge→daemon 请求且需要 ack（返回最终 command / 迁移结果）**，现有事件通道不满足：**协议必须扩展为双向请求-响应**（bridge 主动发起带 `id` 的请求行、daemon 回 `{ id, ok, result }`），或由 daemon 侧在事件流上新增带 ack 的请求消息类型——实施时在 `acpx-bridge-protocol.ts`/`acpx-bridge-client.ts` 落点；
- **launcher 身份以 daemon 侧为准（评审 P1）**：payload 的 `launcherPid/launcherCreationDate` 是 bridge subprocess 自报身份，**仅供 daemon 一致性校验，不得原样落盘**——字段若因 bug、PID 获取竞态或协议版本不一致而错误，清理器可能把仍存活的 launcher 判为已死，重开"intent 被删后恢复 spawn"窗口。intent 落盘的 launcher 身份 = **daemon 自己持有的 bridge child PID** + daemon 独立查询的 CreationDate（windows spec §P1b-4 条件 4 的 fencing 依据）；与上报值不一致 → 记日志（发现协议/实现 bug），落盘一律以 daemon 侧为准；
- **幂等（评审 P0/第十五轮）**：请求以 `(id, sessionKey, intentToken)` 为幂等键——`intentToken` 是本次 launch 生成的 UUIDv4（= `LaunchToken`），同一 session 的多次 launch（每次新 token）**互不为重试**；**键相同但 payload 不同（token 复用而其它字段变化）→ 拒绝**（非法重试，不得复用旧结果、不得以旧 token 落盘）。**同 payload 重复请求的重放/拒绝语义以逐状态幂等表为唯一规范**（见下；表外不存在其它重放规则——"相同 payload 总是重放"的通用表述已废弃）；
- **per-token 状态机（评审 P1，第十四轮补齐）**：daemon 对每个 `intentToken` 维护唯一状态（Windows-only；Unix 无状态机）：
  - `registering`：请求已收到、guard 内处理中（尚未落盘）。处理失败 → 错误 ack，终态（无 intent）；处理成功 → **durable 写 intent 成功 → 先进入 `registered` → 再发 ack**——写与 ack 之间已是 registered：写成功但 ack 失败/断连时不得误留在 registering，按 registered 规则处理。**断连时置 token 为 `aborted`（评审第十四/十五轮，双检查点）**：临界区在 durable 写 intent **之前**（无 await 间隙）原子检查——已 aborted → 中止、不落盘、不写 state；**写 intent（rename）完成、进入 `registered` 前再次原子检查（评审第十五轮）**——write/flush/fsync/rename 均异步让出控制，断连可能在首次检查通过后到达——已 aborted → **删除刚落盘的 intent（daemon 自删，幂等）→ 终态 `aborted`，最终无 intent 残留**；两次检查均通过 → `registered`（其后断连到达 → 按 registered 规则保留 intent）；
  - `registered`：intent 已落盘、ack 已发出或发送中。收到 `cancelAdapterIntent`（含 spawn 前 fencing abort：launcher 在 spawn 前放弃，声明不 spawn，此时 `launcherSpawned` 未发、状态即 registered）→ 删 intent → `canceled`；收到 `launcherSpawned` → `spawn-committed`；连接断开 → **保留 intent**（见断连 bullet）；
  - `spawn-committed`：spawn 已发生。收到 `launchSettled`：`outcome: "owner-committed"`（payload `{ id, sessionKey, intentToken, outcome, ownerPid, ownerAcpxRecordId }`）→ **daemon 独立核验 owner 身份后执行 intent→owner 迁移（评审第十五轮）**：对上报 `ownerPid` 做 handle-stable 核验——`OpenProcess` → 经 handle 查命令行（确认含 `--xacpx-owner-token <LaunchToken>`，与 intent.token 一致）→ `GetProcessTimes` 捕获 creationDate（FILETIME ticks）→ `QueryFullProcessImageName`/等价捕获 executablePath → 生成**完整 owner fingerprint**；**任一核验失败（无法开 handle、token 不匹配、命令行不可读）→ 拒绝迁移**：intent 保留、记日志（协议违规/身份异常，走四条件或下次重试，绝不凭未核验 PID 写 owner）；核验通过 → daemon 按 durable 协议"先写 owner 后删 intent"（owner 记录身份字段全部为 daemon 经 handle 捕获值，不信任 launcher 上报的身份）→ `owner-committed`（终态；intent 已被 owner 记录替换、不再存在，后续回收走 reaper owner 路径）；`outcome: "launch-failed"`（handshake 确认进程已退出）→ **daemon 删除 intent 前必须执行完整 token 快照（评审第十六轮 P1）**：queue owner/root 退出不证明带 LaunchToken 的 agent descendant 已退出（token 在 agent 进程命令行）——daemon 先执行完整进程快照（CIM 枚举），确认**不存在任何命令行含 `--xacpx-owner-token <LaunchToken>` 的存活进程** → 才删 intent → `launch-failed`（终态）；**快照失败（CIM 不可用/查询失败）→ 保留 intent + 告警（fail-closed，与 windows spec 清理条件 2 同款，走四条件回收）**；`outcome` 与当前状态不符（如未收到 `launcherSpawned` 即收到 `launchSettled`）→ 拒绝并记日志（协议违规）；
  - `canceled` / `owner-committed` / `launch-failed` / `aborted`：终态；终态后迟到的 register/cancel 一律拒绝；**`launchSettled` 例外（评审第十五轮）——同 token 同 outcome 的重复 `launchSettled` 按幂等重放（不重复迁移/删除），冲突 outcome 拒绝并记日志**（tombstone 记于 daemon 内存；daemon 重启后该连接已死，同 token 请求不会再现）；
  - **删除路径全集（评审第十三/十六轮）**：intent 落盘后的删除路径共四条——(a) `registered` + `cancelAdapterIntent`（bridge 承诺不 spawn）；(b) spawn 前 fencing abort（launcher 放弃，复用 cancel）；(c) `spawn-committed` + `launchSettled{launch-failed}`（**daemon 先执行完整 token 快照确认无同 token 存活进程、快照失败则保留**，见上）；(d) `spawn-committed` + `launchSettled{owner-committed}`（先写 owner 后删 intent 的迁移）。**断连与超时永不直接删除**（保守保留，回收走 windows spec 四条件）；`registering` 失败/aborted 不落盘；
- **逐状态幂等表（评审第十四轮，取代笼统的"重放/拒绝"两说）**——对相同键 `(id, sessionKey, intentToken)` 的重复 `registerAdapterIntent`：
  | 当前状态 | 同 payload | 异 payload |
  |---|---|---|
  | `registering`（处理中） | 去重等待，返回同一 ack | 拒绝 |
  | `registered` | **重放旧结果**（intent 不重复落盘、state 不重复回写、重发同一 ack） | 拒绝 |
  | `spawn-committed` | **拒绝（不重发 ack——旧 ack 会诱使 bridge 二次 spawn）** | 拒绝 |
  | `canceled`/`owner-committed`/`launch-failed`/`aborted`（终态） | 拒绝 | 拒绝 |

  bridge 侧对同一 `intentToken` 的 ack 只接受一次（本地幂等，重复 ack 忽略），与 daemon 侧共同防止二次 spawn。`launchSettled` 幂等：同 token 同 outcome 重复 → 重放（不重复迁移/删除）；同 token 冲突 outcome → 拒绝并记日志；断连未送达的 `launchSettled` → 按断连规则保留 intent（四条件回收）；
- **超时（评审 P1）**：请求超时（默认 10s，同 handshake 上限）→ bridge 声明 launch 失败并**放弃本次 launch：绝不 spawn、不重试、不复用该 intentToken**，随后发送 `cancelAdapterIntent { id, sessionKey, intentToken }`。daemon 侧（ack 丢失场景）：ack 已发出但 bridge 未收到 → 状态为 `registered` → cancel 到达即删 intent（已执行的 state 回写不回滚，下一次 launch 重解析再校验）；`registering` 中 cancel 到达 → 处理完成后按 cancel 删除；cancel 先于 request 到达 → 状态直接置 `canceled`、迟到 register 拒绝。**各顺序均保证最终无该 token 的 intent 残留**（daemon 主进程崩溃时已写 intent 的回收才走 windows spec intent 清理四条件）；
- **断连（评审 P1）**：RPC 在途 bridge 断连 → launch 视为失败。daemon 检测到连接关闭时逐 token 处理：`registering`（未落盘）→ **置 `aborted`**（临界区在写 intent 前原子检查后中止，不落盘；已落盘则按 registered 处理）；`registered` → **保留 intent 不删**——ack 已发出但 bridge 是否收到未知，bridge 可能已收到 ack 并 spawn，立即删除会撞上已经开始/已完成的 spawn，丢掉已 spawn 进程的归因记录（"取不到证据一律保守"）；该 intent 由 windows spec 清理四条件回收，daemon 重启后 generation 轮换即满足条件 3（bridge 进程即 launcher，其死亡满足条件 4）；`spawn-committed` → 保留（归因记录）。

### 4. 运行时解析

- runtimeRoot = `dirname(configPath)`（`resolveConfigPathForCurrentEnv()`）；
- spawn 命中判定：pointer 合法 → `validateRelease` 静态项（含 isFile/执行位，probe 豁免）→ 重构命令；不符回退 npx；
- classification 双轨规则（resolution 默认 core home；classification 未传受信根不识别预装形态），形状识别 hit `<adaptersRoot>/<id>/releases/<releaseId>/node_modules/<pkg>/…`。

### 5. CLI / 6. 新文件

（同前版：`preinstall/uninstall/list`；`adapter-preinstall.ts`、`adapter-locks.ts`（Windows IPC guard wrapper + Unix `flock(2)`）、`resolve-node-exe.ts`。）

## 边界情况

- **GC 与注册竞态**：迁移不变量（先写新后删旧）+ 删除前重扫比对 `snapshotRevision`；revision 变化即放弃删除。注意双扫描只是 GC 对登记表并发的**一致性证明**，不再作为任何互斥锁竞态的兜底（第八轮 P0）；
- **Unix**：操作互斥由 `flock(2)` OS 保证；**锁文件在系统生命周期内禁止删除**（unlink 后同路径新 inode 可另取一把锁、互斥失效——不变量见 3.1）；
- **bridge RPC**：重复 `registerAdapterIntent`（同 token 同 payload）**在状态表 `registered` 才幂等重放**（`spawn-committed` 与终态明确拒绝，评审第十六轮 stale 修正）；同 token 异 payload 拒绝；**逐状态幂等表**（registered 重放、spawn-committed 及终态拒绝）；per-token 状态机（registering/registered/spawn-committed/owner-committed/launch-failed/canceled/aborted，Windows-only）；超时 → cancel 删除/拒绝迟到请求；断连 → registering 置 aborted（写前检查中止）、registered/spawn-committed **保守保留**；`launchSettled` 唯一迁移执行者（owner-committed 迁移 / **launch-failed 删除前需完整 token 快照**）；launcher 身份以 daemon 侧 child PID 为准；**Unix 独立 `resolveAdapterCommand` schema（无 intent 落盘与状态机）**；孤儿 intent（daemon 崩溃路径）由 windows spec intent 清理四条件回收；
- **state 回写失败**：整个 launch 失败，不产生 intent；state 不会长期指向已删 release；
- **复用 release 损坏 / pointer 损坏**：validateRelease 不过即回退 npx；
- **Bun**：Node resolver 拒绝退回；
- **任一引用来源读取/解析失败**（pointer、state.json、登记表、splitter、规范化）：GC 本轮整体中止不删；
- **多实例**：runtimeRoot 一律 configPath 推导。

## 测试计划

- **GC 双扫描**：首次扫描后注入新 intent/owner/residual（迁移顺序为先写后删）→ 删除前重扫 `snapshotRevision` 必变化 → 放弃删除；记录内容不变时 revision 稳定（不误放弃）；
- **GC fail-closed 矩阵（评审 P1 回归）**：state.json 读取/JSON 解析失败、splitter 分词抛错、路径规范化失败、登记表 null、pointer 不可读——每项单独注入 → 本轮 GC 一律不删；
- **扫描顺序契约（评审 P1 回归）**：`listOwnerAgentCommands` 传乱序 categories → 拒绝（throw）；固定顺序下迁移各时点扫描不漏引用（与迁移不变量联合）；
- **迁移不变量**：模拟 intent→owner→residual 迁移各时点并发 GC 扫描，引用始终至少一度可见；
- **Unix `flock`（评审 P0/P1 回归）**：双进程同 id 并发获取恰一成功、另一即得 busy 错误；持有者 `kill -9` 后另一进程可获取（内核自动释放）；**锁文件"永不删除"不变量**——协作代码路径不存在任何 unlink 锁文件的操作（3.1），崩溃残留锁文件不被清理且后续获取正常（评审 P1：unlink 后新 inode 可另取一把锁，原"rm 后不得越过持有者"测试不可能通过，已删除）；
- **releaseId（评审 P1 回归）**：构成正则用例（version 含 `-` 无歧义拆分、hash/uuid 必须 8 位小写 hex）；registry 尾斜杠/空白规范化后 hash 稳定；**`https://registry.example/` 与 `https://registry.example` 的等价判定/复用判定/validateRelease expected 全部一致（canonicalRegistry 唯一形态）**；
- **GC 引用判定（评审 P1/P0 回归）**：**结构化 decoder 取 `args[1]` 判定**——用例一：完整命令 `"<node>" "<abs-js-entry>"`，`args[0]` 为**受控 node 绝对路径**、`args[1]` 为 `releases/<id>/node_modules/<pkg>/…` → 命中（断言：state/intent/owner 引用旧 release 时 GC **不**删除该 release——`args[0]` 误判回归用例）；用例二：`args[0]` 为非受控/相对 node 路径 → **decoder 拒绝解码、不命中**（独立用例，不做 containment 判定）；用例三：npx 等非受控形态 → decoder 不命中、不做 containment；**同名前缀 `releases/<id>-extra/…` 不命中**（`path.relative` 边界明确）；**`..foo` 形式的合法目录名不误拒**（`rel !== ".." && !rel.startsWith(".." + path.sep)`）；`..`/`../…` 逃逸不命中；Windows 大小写差异命中（case-folding）；releaseDir 经 symlink 别名访问 realpath 后同一 → 命中；decoder/realpath/规范化失败 → 本轮 GC 中止不删；
- **active pointer 原子发布（评审 P1 回归）**：`active.json.tmp-<uuid>` 写入后 rename 前崩溃 → `active.json` 保持旧内容完整、tmp 残留由崩溃恢复清理；并发读者（模拟运行时解析）在发布期间只读见旧或新完整 JSON，不读见半写；
- **doLaunch 上下文**：cli/bridge 两路径注入 adapterContext；重解析后先回写 state 再写 intent（顺序断言）；回写失败 → launch 失败；**同步落盘 + copy-on-write（评审第十六/十九轮 P0 级回归）**：`onReResolved` 调用 `saveNow(nextState)`（断言：不调用 debounced `save()`、**不直接修改共享 LogicalSession——先构造快照、`saveNow` 成功后才发布（断言失败时内存不变，后续无关 `save()` 不会落盘失败命令）**）；模拟 `saveNow` 失败 → launch 失败、不写 intent；**guard 释放语义：`saveNow()` settle 前不得释放；失败（内存未变）后经 `finally` 释放——不得实现为永久持锁**；**装配契约（评审第十二/十三轮）**：提供 adapterContext 但缺 `onReResolved` → 装配/启动期报错（断言不进入 launch）；**形状命中预装形态 + context 缺失 → launch 失败（断言，防无 intent 直 spawn 绕过登记）**；形状不命中（npx 等）→ 注册段跳过（无 intent、无 RPC）；**Unix 平台边界（评审第十二/十三轮）**：Unix 上 bridge 发**独立 `resolveAdapterCommand` schema**（无 intentToken/launcher 字段），daemon 执行 validate/state 回写、ack 返回命令后才 spawn——**不写 intent、无 per-token 状态机**（断言无 intent 文件、无 launcherSpawned/cancel/launchSettled 消息）；
- **bridge `registerAdapterIntent`（评审 P0/P1 回归；Windows-only 的 intent 与状态机部分，Unix 独立 schema）**：重复请求（同 token 同 payload）**按逐状态幂等表处理**（intent 不重复落盘）；**逐状态幂等表（评审第十四轮回归）**：`registered` 重放同一 ack、`spawn-committed` 收到重复 register **拒绝且不重发 ack（断言无二次 spawn）**、终态后拒绝；**同一 session 的后续正常 launch（新 intentToken）不被当作重试，产生新 intent**；**同 token 异 payload → 拒绝**；超时 → launch 失败、cancel 送达后无 intent 泄漏（request 先到 / cancel 先到两种顺序分别断言）、**断言 launcher 未 spawn（无新进程）**；**per-token 状态机（评审 P1 回归）**：`registering` 断连 → **置 aborted、双检查点（写前检查 + rename 后进入 registered 前复查，断言两种时点断连均无 intent 残留，含竞态注入）**；写 intent durable 后、ack 发出前断连 → 按 registered 处理（intent 保留）；`registered` 断连 → **intent 保留**；收到 `launcherSpawned` 后断连 → intent 保留（spawn-committed）；spawn 前 fencing abort → cancel 删除（断言）；**`launchSettled`（评审第十四/十五轮回归）**：`owner-committed` → **daemon 对上报 ownerPid 独立核验（命令行含 LaunchToken + handle 捕获 fingerprint；断言：token 不匹配/无法开 handle → 拒绝迁移、intent 保留、不写 owner）** → 核验通过才执行先写 owner 后删 intent（断言顺序与唯一 writer——launcher 侧无文件操作）；`launch-failed` → **daemon 先执行完整 token 快照（无同 token 存活进程才删 intent；断言：模拟 agent descendant 仍存活 → intent 保留；快照失败 → intent 保留）**；同 token 冲突 outcome → 拒绝；未 spawn 即收到 launchSettled → 协议违规拒绝；**同 outcome 重复 launchSettled 幂等重放（不重复迁移/删除）**；断连未送达 → intent 保留；spawn 失败（bridge 发 cancel）→ intent 删除；**launcher 身份（评审 P1 回归）**：intent 的 `launcherPid` = daemon 持有的 bridge child PID、`launcherCreationDate` = daemon 独立查询值（断言）；bridge 上报不一致（模拟错误 PID）→ 仍以 daemon 侧为准落盘 + 一致性校验日志；bridge subprocess 全程不持 adapter guard（断言）；**锁顺序（评审第十四/十五轮）**：`withSessionLock` 实现断言——先 session lock 后 adapter guard（fn 内取 guard）、`onReResolved` 不再自行取锁（逆序路径不存在，含重入/ABBA 注入）；
- guard：Windows 结构化 key（role/resourceId）与 windows spec 签名一致；
- `validateRelease` 六项：releaseDir 非目录拒绝；`stat().isFile()` 拒绝目录；Unix 无执行位拒绝（评审 P2 回归）；
- 其余前版回归（信任边界、等价判定、终路径 probe、probe 失败不 swap）。

## 相关源码位置

- `src/adapters/adapter-preinstall.ts`（新）/ `adapter-locks.ts`（新）/ `resolve-node-exe.ts`（新）
- `src/adapters/adapter-catalog.ts` / `adapter-cli.ts` / `adapter-registry.ts` / `adapter-verifier.ts`
- `src/config/resolve-agent-command.ts` / `src/adapters/adapter-catalog.ts`（`parseManagedAdapterCommand` 扩展为共享 decoder）
- `src/process/ipc-guard.ts`（windows-orphan spec；Windows-only）
- `src/transport/acpx-queue-owner-launcher.ts`（引用注册段）
- `src/bridge/bridge-main.ts` / `bridge-runtime.ts`（`registerAdapterIntent` RPC 通道）
- `src/sessions/session-service.ts`（onReResolved 装配）
- `src/state/types.ts`（`transport_agent_command`）
- `docs/superpowers/specs/2026-08-03-windows-orphan-process-fix-spec.md`
