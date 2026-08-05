# Windows 孤儿进程清理加固设计

**Date:** 2026-08-03（2026-08-04 第二十轮评审修订）
**Status:** Approved for implementation; implementation plan: `docs/superpowers/plans/2026-08-05-windows-orphan-process-and-adapter-preinstall.md`

## 目标

减少 Windows 环境下 xacpx 长期运行/反复启停后的孤儿进程问题，并在关键路径上可靠回收 xacpx 派生的进程。

**保证范围**：

- **自动强杀保证覆盖**：经 **owner token**（注入 owner argv，CIM 可实时核验）确认身份的 queue owner（root），及**批杀枚举快照实际返回、且整条父链身份核验通过**的子孙（见 P0b；**不承诺覆盖快照之后新 spawn 的进程**——用户进程树无法冻结，枚举→核验→杀期间新生的后代不在快照内，靠"杀前追加枚举"best-effort 追加一轮；彻底闭合需 Job Object（P3，需单独决策））。
- **不保证覆盖**：（a）回收前已 reparent/断链的 agent 进程；（b）PowerShell/CIM 不可用时的自动强杀（一律保守）；（c）token-less legacy owner（复用或手动迁移）；（d）枚举快照之后新 spawn 且未被复查追加捕获的进程。

修订历史（近期）：

- **第七轮**：互斥锁纪律；handshake 超时三态；legacy 迁移；stop 四态；收敛状态机。
- **第八轮**：互斥改 IPC guard；residual 携 agentCommand；stop kill 后确认状态机；intent 清理需完整快照；legacy+CIM 不可用返回 degraded。
- **第九轮**：IPC guard Windows-only（Unix 不引入新互斥）；Windows 排他语义精确化（net.Server.listen + listening 事件 + FIRST_PIPE_INSTANCE 依赖声明）；guard key canonical 化；intent 清理 generation 条件；adapter spec 契约同步。
- **第十轮**：canonical key 创建时序（canonicalize 前先 `mkdir -p configRoot`，目录不存在时取**最近已存在祖先的 realpath 再拼接剩余路径**从不回退到另一种 key；realpath 非 ENOENT 错误 fail closed）；intent 清理的 launcher fencing（shutdown drain + spawn 前 generation 复核）；adapter spec 的 GC 扫描顺序固定为 intents → owners → residuals。
- **第十一轮**（本轮，修复 1 P0 + 4 P1 + 1 版本标记；评审无 stale）：
  1. **P0：launcher fencing 重设计**——旧版"两机制合起来保证 launcher 已终止或必 abort"依赖未证明假设"旧 bridge 必随 daemon 终止"。崩溃场景可达：旧 bridge 写 intent → generation 复核通过 → 暂停在 spawn 前 → daemon 主进程崩溃释放 consumer guard → 新 generation 启动 → 60s 后 intent 被条件 3 删除 → 旧 bridge 恢复并 spawn 出无归因 owner。改为 **intent 记录 `launcherPid` + `launcherCreationDate`，删除前必须确认 launcher 进程本身已终止**（PID 不存在或 CreationDate 不匹配；CIM 不可用 → 永久保留）；shutdown drain 升级为**等待 bridge subprocess 退出后才释放 consumer guard**（正常 dispose 路径）；测试新增"主进程崩溃、旧 bridge 存活并暂停在 spawn 前"；
  2. **P1：`listOwnerAgentCommands` 返回 `{ commands, snapshotRevision } | null`**——GC 删除前重扫要求比较"记录变化"，仅 `string[]` 无法区分记录迁移/增删/替换；revision 为三类记录（路径+内容）的稳定摘要，adapter spec 逐字同步；
  3. **P1：扫描顺序正式成为 API 不变量**——接口注释与测试规定严格 `intents → owners → residuals`，每类扫完才开始下一类，categories 乱序/缺失拒绝；
  4. **P1：intent schema 完整化 + durable write 语义**——intent 全部字段逐字给出（含 launcherPid/launcherCreationDate）；durable = 临时文件 → write+flush+fsync → `rename` 原子替换；owner→多个 residual 时**全部 residual 写成功后才删 owner**；
  5. **P1：正文恢复自包含**——批杀契约、handshake 三态、收敛状态机、stop 四态、timer 不再以"同七/八轮"代替，完整契约恢复进正文；修订历史保持压缩；
  6. 版本标记：文件头与修订历史轮次统一（原"九轮" vs 正文"第十轮"）。
- **第十二轮**（本轮，评审 2 P0 + 4 P1；无 stale）：
  1. **P0：批杀契约恢复"杀前身份二次核验"**——`terminateProcessTree` 改为接收 `BatchTarget { pid, creationDate, commandLine, executablePath }`，在同一批 PowerShell 会话内完成"复核 root → 建树（捕获子孙身份）→ 逐 PID 复核 → 杀 → 终态复查"全链，闭合调用方核验与实际 kill 之间的 PID 复用窗口；新增 `skipped-replaced` outcome（复核不过即不杀）；
  2. **P0：bridge RPC 幂等键改 `(id, sessionKey, intentToken)`**（adapter spec 第十轮同步）——旧键把同一 session 的后续正常 launch 误判为重试；
  3. **P1：`query-failed` 进入收敛状态机**——root `query-failed` 保留 owner，子孙 `query-failed` 落 residual；收敛 switch 对未列出的 outcome 组合一律 fail-closed（保留 owner / 落 residual），不得因默认分支遗漏而删除记录；
  4. **P1：RPC 超时/断连增加 cancel/tombstone 协议**（adapter spec 第十轮同步）——超时后 bridge 放弃 launch 并发送 `cancelAdapterIntent`，断连视为隐式取消，保证当前 generation 不残留 intent；
  5. **P1：Unix flock 锁文件"永不删除"不变量**（adapter spec 第十轮同步）——unlink 后同路径新 inode 可另取一把锁，原"删锁文件不破坏互斥"表述修正为不变量；
  6. **P1：canonicalRegistry 唯一规范化形态**（adapter spec 第十轮同步）——hash/manifest/expected/等价/运行时解析统一使用。
- **第十三轮**（本轮，评审 1 P0 + 4 P1；无 stale）：
  1. **P0：批杀/stop 复核改 handle-stable**——上一轮"同一 PowerShell 会话内查询 → 比较 → 按 PID kill"只是缩短窗口、**并未闭合**：目标可在比较后退出、PID 被复用，kill 仍可能命中新进程。改为对每个目标 PID `OpenProcess` 打开 handle → 经该 handle 查询 `CreationTime` → 比较 → 对**同一 handle** `TerminateProcess`；handle 固定引用进程对象、与 PID 无关，复核与终止之间不存在复用窗口；root 与每个子孙同流程，stop 四态核验与 kill 同样合并为 handle 操作；
  2. **P1：bridge launcher 身份不以 bridge 上报为准**（adapter spec 第十一轮同步）——daemon 以自己持有的 bridge child PID 落盘 intent 并独立查询 CreationDate，上报值仅作一致性校验，防"活 launcher 被误判已死 → intent 被删后恢复 spawn"；
  3. **P1：RPC per-token 状态机**（adapter spec 第十一轮同步）——`registering → registered → spawn-committed/canceled`；`registered` 状态断连**保守保留 intent**（ack 已发、无法排除 spawn 已发生），删除只发生在 cancel（bridge 主动承诺不 spawn）路径；
  4. **P1：adapter active pointer 原子发布协议**（adapter spec 第十一轮同步）——tmp 写入 → flush/fsync → rename；
  5. **P1：GC 引用判定改 `path.relative` containment**（adapter spec 第十一轮同步）——边界明确 + Windows case-folding + realpath 失败 fail-closed。
- **第十四轮**（本轮，评审 4 P1 + 2 小问题；无 P0）：
  1. **P1：批杀返回值扩展为 `ProcessTreeOutcome[]`**——`outcomes: Map<pid, KillOutcome>` 不给调用方提供函数内部捕获的子孙身份（creationDate/commandLine/executablePath），reaper 无法据此落 residual；改为 `{ target: BatchTarget, outcome, commandLine?, executablePath? }[]`，**query-failed 未捕获完整指纹 → 不落 residual、owner 保留重试**（fail-closed）；
  2. **P1：stop 复用 `terminateProcessTree` 杀整棵 daemon 树**——原实现对 daemon 单独 `TerminateProcess`，daemon 被强杀后不执行正常 dispose，bridge 等直属子进程不保证退出；改为先经 handle 优雅退出（正常 dispose）、限时未确认 → 树杀 daemon 及其树内子进程；
  3. **P1：CreationDate 规范格式钉死为 FILETIME ticks**——CIM datetime 与 `GetProcessTimes` 之间精度/时区/舍入差异可能把真目标误判 `skipped-replaced`；统一"获取经 handle `GetProcessTimes`、落盘与比较一律 ticks 整数"；
  4. **P1：登记表/intent/registerAdapterIntent 显式声明 Windows-only**（adapter spec 第十二轮同步）——Unix 不启用孤儿登记机制，adapter 的 RPC/intent 注册段与 GC 登记表引用源随之条件化；
  5. 小问题：`path.relative` 边界条件改为 `rel !== ".." && !rel.startsWith(".." + path.sep)`（`..foo` 不误拒）。
- **第十五轮**（本轮，评审 2 P0 + 6 P1；无 stale）：
  1. **P0：建树快照必须携带独立身份**——"子孙期望值 = 建树步骤以同一 handle API 捕获"是自证：child 在 CIM 枚举后退出、PID 被复用，`OpenProcess` 打开新进程、其 CreationTime 被当作 expected，比较必然通过 → 误杀。改为 **CIM 建树快照在枚举时刻一并携带每节点 CreationDate/CommandLine/ExecutablePath**（转 ticks 作为独立身份证据），打开 handle 后再与快照身份比较；
  2. **P0：批杀顺序改为"先全量核验、后逐个杀"**——杀 root 前对所有已识别子孙完成 handle 开取 + 身份核验 + 指纹确认，任一不可得 → **整批 abort（不杀任何 PID）**，杜绝"root 已杀、child 缺指纹、owner 无法重试"的死角（原"杀前逐 PID 复核"在 root 杀后无法补证）；
  3. **P1：stop 取消不可实现的优雅阶段**——Windows 无 SIGTERM 等价信号、不做范围禁止新增 daemon IPC，外部无法触发 JS dispose/drain；状态 4 直接树杀 `terminateProcessTree`，一致性由冻结 generation + 整树确认兜底（Unix 保持 SIGTERM dispose）；
  4. **P1：FILETIME ticks 存储/传输用规范化十进制字符串**（超出 JS 安全整数，JSON number 会丢精度）、比较在 bigint/uint64 上进行；`daemonCreationDate: null` 明确进入 stop 状态 3（不 kill、不 sweep）；
  5. **P1：adapter 状态机补齐生命周期终态与删除责任方**（adapter spec 第十三轮同步）——registered 时序改为"写 intent durable 后、发 ack 前"；补 `owner-committed`/`launch-failed`；handshake exited 与 spawn 前 fencing abort 的 intent 删除路径归位；
  6. **P1：adapter GC 解析错误命令 token**（adapter spec 第十三轮同步）——命令是 `<node> <abs-js-entry>`，`args[0]` 是 release 外的 nodeExecutable；改共享结构化 decoder，以 `args[1]` 判定 entry containment；
  7. **P1：Unix bridge 回写走 daemon RPC**（adapter spec 第十三轮同步）——函数型 `onReResolved` 无法经 env/options 传给 subprocess 调用；Unix 同样经 JSON 通道由 daemon 持 guard 执行 validate/回写，仅 intent 落盘 Windows-only。
- **第十六轮**（本轮，评审 2 P0 + 6 P1 + 4 小问题；无 stale）：
  1. **P0：树边绑定父身份 + 父链校验**——`ParentProcessId` 可复用：中间节点 B 退出、PID 被 B2 复用，B2 的后代可能被挂到旧 B 分支，节点自身身份匹配仍会被误杀；快照每节点增加 `parentPid + parentCreationDate`，核验自顶向下、**任一祖先身份不匹配 → 该节点整条后代分支 fail-closed（不杀，记 query-failed）**；
  2. **P0：覆盖保证削弱 + 杀后复查二次枚举**——CIM 枚举不是原子快照、不冻结进程树，快照后新 spawn 的 child 不在 outcomes；保证范围明确为"快照实际返回的节点"，杀后复查阶段按 `ParentProcessId ∈ 本批集合` 二次枚举追加新节点 best-effort（彻底闭合 = Job Object，P3）；
  3. **P1：residual 回收状态机补全**——核验（handle CreationTime vs 记录值）→ 不匹配/不存在即删；匹配 → 同 handle 杀 → killed/exited 删、未终态保留 `killAttempts += 1`；无法复核 → 保留 + 告警；
  4. **P1：CIM↔FILETIME 比较容差**——CIM datetime 精度 1µs（10 ticks），与 `GetProcessTimes` 100ns 精确比较会误判 replaced；统一"|Δ| ≤ 9 ticks 即同一进程"（真实 PID 复用差 ≥ ms 级，不受影响）；
  5. **P1：`LaunchToken` 唯一身份**——argv、intent、owner、residual、RPC 的 token 字段是同一 UUIDv4（adapter spec 第十四轮同步）；
  6. **P1：adapter 状态机补 completion RPC 与唯一 writer**（adapter spec 第十四轮同步）——新增 `launchSettled`，intent 落盘/删除唯一执行者为 daemon；`registering` 断连改 abort 标记 + 发布前原子检查；逐状态幂等表；
  7. 小问题：BatchTarget 注释与新正文对齐（子孙身份来自建树快照）；durable 协议明确进程崩溃级持久（掉电需父目录 fsync 增强）。
- **第十七轮**（本轮，评审 1 P0 + 5 P1 + 1 测试文字问题；无 stale）：
  1. **P0：父链存疑后代不得落 residual**——上一轮"祖先不匹配 → 分支 fail-closed（query-failed）"会被 residual 状态机绕过：root 终态时这些带完整指纹的 query-failed 后代落 residual，下一轮只核验自身身份即杀——一个"无法证明属于本树"的进程仍会被自动杀。改为**祖先身份不匹配 → 整批 abort（不杀任何 PID）**，且**收敛侧规定整批 abort（root `query-failed`）时子孙一律不落 residual**——killable residual 只能来自父链核验通过的节点；
  2. **P1：handshake exited / spawn fencing 的 intent 删除改经 RPC**——windows spec 残留"删除 intent""清理自己的 intent"直删路径，与"daemon 唯一 writer"冲突；统一为 `launchSettled{launch-failed}`（handshake exited）与 `cancelAdapterIntent`（spawn 前 fencing abort），由 daemon 删除；
  3. **P1：CreationDate 容差收窄到 CIM-derived 比较**——`≤9 ticks` 只适用于建树快照（CIM）身份与 handle 值的比较；owner/daemon/launcher 等 handle-derived 值一律精确等值；删除"PID 复用差 ≥ 毫秒"这一未经平台契约证明的全局依据；
  4. **P1：owner-committed 的 owner 身份由 daemon 独立核验生成**（adapter spec 第十五轮同步）——daemon 对上报 ownerPid 做 handle-stable 核验（命令行含 LaunchToken + GetProcessTimes/QueryFullProcessImageName 捕获指纹），通过才写 owner 删 intent；
  5. **P1：adapter 锁顺序重构为 withSessionLock**（adapter spec 第十五轮同步）——"guard 内 onReResolved 自行取 session lock"与"session lock → adapter guard"矛盾；临界区整体包进调用方提供的 session-lock 执行器；
  6. **P1：registering 发布后二次检查**（adapter spec 第十五轮同步）——写前检查挡不住 write/flush/fsync/rename 异步窗口；rename 完成后、进入 registered 前再次检查 aborted，已 aborted 则删除刚落盘 intent。
- **第十八轮**（本轮，评审 2 P0 + 4 P1 + 2 stale 测试文字；无 stale）：
  1. **P0：父链校验补创建时间顺序 + 拒绝未核验的父**——可达误杀：旧进程 P（PID 500）创建无关进程 C 后退出，合法 root 后创建 B 复用 PID 500，快照把 C 挂到 B 名下，B/C 自身身份均匹配、原父链规则误杀 C；增加 **`child.creationDate >= parent.creationDate`**（父必须先于子存在）；并区分"**核验阶段已打开 handle、身份匹配后退出**的父（子归属成立）"与"**核验阶段 `OpenProcess` 即不存在、从未被身份核验**的父（整批 abort）"；
  2. **P0：Unix state 回写必须同步落盘**（adapter spec 第十六轮同步）——`DebouncedStateStore.save()` 接受快照即返回、磁盘写延后，guard 释放后 GC 可能读旧 state.json 删掉新 release；`onReResolved` 必须用 `saveNow()`（同步 flush、失败即 launch 失败），磁盘写成功前不释放 guard、不返回 ack；
  3. **P1：`launch-failed` 删除前需完整 token 快照**（adapter spec 第十六轮同步）——queue owner 退出不证明带 LaunchToken 的 descendant 已退出；daemon 删 intent 前执行完整快照确认无同 token 进程，快照失败 → 保留；
  4. **P1：未知 outcome 默认分支不再生成 residual**——未知状态可能意味着归属存疑，落 residual 会绕过父链检查；默认分支改为"保留 owner 且不生成任何新 residual"，仅 `kill-requested-unconfirmed`/`access-denied` 可落；
  5. **P1：doLaunch 摘要流程同步 withSessionLock**（adapter spec 第十六轮同步）——步骤 2/3 旧锁顺序表述与新事务一致；
  6. stale 测试文字：收敛测试"子孙 query-failed → 落 residual"限定语境（仅正常批杀中父链已通过的个别子孙）；adapter 边界"重复 register 幂等重放"限定为状态表 `registered`。
- **第十九轮**（本轮，评审 1 P0 + 4 P1/stale；无 stale）：
  1. **P0：删除"杀后二次枚举"，改为"杀前追加枚举"**——可达误杀：R 核验并被杀 → PID 被无关进程 P2 复用 → P2 创建 C → 杀后二次枚举把 C 接到 R；`C.creationDate >= R.creationDate` 且 R"曾被核验"，C 身份匹配，原规则杀 C。**已退出的父不能担保新发现的 child**（其 PID 可能已被复用）；改为在**杀前**（全量核验后）追加一轮枚举：仅追加 `ParentProcessId ∈ 已核验通过且 handle 确认存活` 的节点（父身份已核验、追加节点以追加枚举时刻捕获独立快照身份），杀后不再枚举；
  2. **P1：`query-failed` 落 residual 的正文矛盾**——收敛 fail-closed"只有 kill-requested-unconfirmed/access-denied 可落"排除了正常批杀中归属已确认、指纹完整的 query-failed 子孙；改为"归属已确认（父链通过）且指纹完整的 kill-requested-unconfirmed / access-denied / query-failed 可落，未知 outcome 一律不生成"；
  3. **P1：residual 的 CreationDate 统一 CIM-derived 容差**——设计原则把 residual 误列入 handle-derived 精确比较，但 residual 指纹取自建树快照（CIM）；明确 residual 继承 CIM-derived 指纹、复核用 |Δ| ≤ 9；
  4. **P1：state 回写改 copy-on-write（saveNow 快照先落盘后发布）**（adapter spec 第十六轮同步）——`saveNow()` 失败不回滚已修改的共享 LogicalSession，后续无关 `save()` 会把失败命令落盘；采用 main.ts:646 Orchestration saveState 同款：构造 nextState 快照 → `saveNow(nextState)` 成功 → 发布到运行时 state；`SessionService` 依赖类型需从 `Pick<StateStore, "save">` 扩展含 `saveNow`；
  5. **P1/stale：windows spec 的 launch-failed 补 token 快照前置**——handshake exited 与测试同步 adapter 契约：无同 token 存活进程才删 intent，发现 descendant 或快照失败均保留。
- **第二十轮**（本轮，评审 1 P0；其余复核通过；无 stale）：
  1. **P0：杀前追加枚举补"枚举完成后的父 handle 存活复核"**——"枚举前确认父存活"不够：父 R 在追加枚举期间自然退出、PID 被 P2 复用、P2 创建 C，本轮枚举返回 C（`C.creationDate >= R.creationDate`、C 自身匹配、"父核验后退出继续担保"规则允许）→ 误杀。时序钉死为 **① 追加枚举 → ② 父存活复核 → ③ 追加核验 → ④ 杀**：追加枚举完成后、接受任何新增父子边之前，对每个新增节点的父用此前已核验的**同一 handle** 复核存活——全部存活才接受新增边（证明捕获时旧 parent generation 未退出、PID 不可能被复用）；任一父已退出/无法确认 → **整批 abort（不杀任何 PID）**。
- **评审 stale 备忘**：连续多轮评审引用了已被替换的旧内容（inode/mtime 夺权、"owner + residual"接口、字符串形式 guard key、"无重扫协议"——这些在当前版本均不存在或与正文相反），留此备忘便于核对评审快照。

## 设计原则

1. **不破坏跨平台行为**：Windows 增强；Unix 保持既有 consumer lock 与 SIGTERM dispose 语义。
2. **warm 语义限 daemon 存活期内**。
3. **归因先于强杀**；取不到证据一律保守。
4. **互斥只用 OS 强制原语**；Unix 不引入新的互斥机制。
5. **幂等**；kill 未确认决不删除归因记录。
6. **CreationDate 规范格式（评审第十四/十五/十六轮）**：全 spec 的 CreationDate/creationDate 一律为 **FILETIME ticks**（UTC，自 1601-01-01 起的 100ns 间隔整数）。**存储与传输用规范化十进制字符串**（ticks 超出 JS 安全整数范围，JSON number 会丢精度）；**比较在 bigint/原生 uint64 上进行**，禁止把 ticks 当 JSON number 落盘或比较。获取途径按场景固定：**root 身份**来自调用方已核验记录（owner fingerprint 由 launcher 经 handle `GetProcessTimes` 捕获）；**子孙身份来自 CIM 建树快照的枚举时刻值**——两者都是独立身份证据，打开 handle 后一律经 `GetProcessTimes` 复核比对。**比较规则（评审第十六/十七轮，按来源分场景）**：CIM datetime 精度 1µs（= 10 ticks，且 WMI 表示可能截断或舍入），与 `GetProcessTimes` 的 100ns 值精确等值比较会把真实进程误判为 replaced——**唯一需要容差的比较是"建树快照（CIM-derived）子孙身份 ↔ handle 复核值"：同一判定 ⇔ 双方有效且 `|Δ| ≤ 9`**（容差幅度 = CIM 表示精度上界，**不依赖任何"PID 复用时间差"假设**）。**handle-derived 值之间的比较（owner fingerprint、daemon/launcher 身份、stop 四态）一律精确等值**（双方同经 `GetProcessTimes`，同源无损，容差不适用）。**residual 例外（评审第十九轮 P1）**：`residual.creationDate` 继承建树快照的 CIM-derived 指纹（见 §P1b-2），其复核比较一律按 CIM-derived 规则用 `|Δ| ≤ 9` 容差。CIM 仅用于命令行核验与建树枚举。**缺失（null）或格式非法的 CreationDate 一律无法复核 → 对应 fail-closed 分支**（stop 状态 3、批杀 `query-failed`、fingerprint null = 不可杀）。

## 方案

### 启动身份上下文

```ts
export interface DaemonIdentity { generationId: string; daemonPid: number; daemonCreationDate: string | null; configRoot: string }
```

`buildApp` 之前创建，贯穿 cli/bridge transport、consumer lock 元数据、`generation.json`、controller stop。

### P0a：IPC guard（Windows-only；评审 P0/P1-2/P1-6）

```ts
export interface IpcGuard { release(): Promise<void> }
export interface IpcGuardKey { role: string; configRoot: string; resourceId?: string }
export async function acquireIpcGuard(key: IpcGuardKey): Promise<IpcGuard>
// 例：{ role: "consumer", configRoot }, { role: "lifecycle", configRoot }, { role: "adapter-op", resourceId: "claude", configRoot }
```

- **Windows**：管道名 `\\.\pipe\xacpx-<sha16(canonicalKey)>`，经 `net.createServer().listen(pipeName)` 获取，**Promise 仅在 `listening` 事件后 resolve**——libuv 对首个 server 实例使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`（libuv `src/win/pipe.c`），后续同名 listen 失败，排他由内核保证；**不声称任意 named pipe 创建天然排他**（默认 `CreateNamedPipe` 允许多实例，排他性依赖 libuv 首实例标志），并要求测试固定最低 Node 版本（libuv 行为依赖）。进程退出（含崩溃）OS 自动释放，无 stale 状态；
- **Unix**：**不启用 IPC guard**——UDS 残留文件的"connect 判死后 unlink"有不可消除的双持有者竞态（评审 P0）。Unix 的 consumer 互斥保持既有实现（lock 文件 + `isProcessRunning`，`src/weixin/monitor/consumer-lock.ts` 现状），lifecycle 串行保持 `openPidFileExclusive`（`src/daemon/daemon-controller.ts:113` 现状）；
- **key 规范化（评审 P1-6 + 第十轮创建时序）**：`canonicalKey = sha256(canonicalize(configRoot) + "\0" + role + "\0" + (resourceId ?? ""))`；`canonicalize(configRoot)`：**先确保目录存在（`mkdir -p`，configRoot 是 xacpx 自有目录，创建是安全的）** → absolute → `realpathSync.native`；若目录在 canonicalize 调用时不存在且调用方不允许创建（只读场景）→ **取最近已存在祖先的 realpath，再拼接剩余相对路径**（junction/symlink 父目录下保证 key 与创建后一致，评审 P1-6 的时序竞态）；realpath 出现 ENOENT 以外错误 → **fail closed，不得回退到字面 key**。分隔符统一 `/` → Windows 下路径整体小写 → 去尾部分隔符。测试覆盖同一路径的不同表示（大小写、`\` vs `/`、尾部分隔符、junction、先取锁后建目录）映射到同一 key；
- **双进程排他测试列为 Windows 必跑项**：两个进程（或 job object 下两个 node 子进程）对同一 key listen，恰一成功；持有者 `kill -9` 后可重新获取。

roles：`consumer`（daemon/前台 consumer，替代 lock 文件互斥）、`lifecycle`（controller start/stop/restart）、以及 adapter spec 定义的 `adapter-op` + resourceId。

### P0b：Windows 递归杀树（批杀契约）

```ts
interface BatchTarget {
  pid: number;
  /** CreationDate（FILETIME ticks）；root 由调用方从已核验记录提供，子孙由建树快照（CIM 枚举时刻）提供。null = 无法复核 */
  creationDate: string | null;
  /** 归因证据（诊断/复核展示用）。 */
  commandLine?: string;
  executablePath?: string;
}

terminateProcessTree(root: BatchTarget): Promise<TerminateProcessTreeResult>
```

`ProcessTreeOutcome`：`{ target: BatchTarget, outcome: KillOutcome, commandLine?: string, executablePath?: string }`——`target` 携带该 PID 的期望/捕获身份（root 来自调用方，子孙来自**建树快照**），`commandLine`/`executablePath` 为**建树快照（CIM 枚举时刻）捕获的指纹**（供 residual 落盘与诊断；整批 abort 等未及捕获 → 缺省）。`TerminateProcessTreeResult`：`{ rootOutcome: KillOutcome, outcomes: ProcessTreeOutcome[] }`——`outcomes` 覆盖 root 与全部被识别/尝试的子孙（每个 PID 至多一条；root 条目与 `rootOutcome` 一致）。

`KillOutcome` 六态：`killed`（强杀成功且终态复查确认）、`already-exited`（杀前已不存在）、`kill-requested-unconfirmed`（kill 请求已发出、终态复查未确认终止）、`access-denied`（权限不足）、`query-failed`（查询/建树失败，无法归因或无法确认）、`skipped-replaced`（杀前复核发现 PID 被复用、身份不匹配，未杀）。

契约：

- **身份输入与 handle-stable 复核（评审 P0）**：调用方传入已初判归因的 `BatchTarget`（root 身份来自 owner 记录 fingerprint 或 controller 核验结果）。**每个目标 PID 的"复核 → 终止"必须是 handle-stable 操作**：`OpenProcess` 打开目标 → 经该 handle 查询 `CreationTime`（`GetProcessTimes`）→ 与期望值比较（**双方均为 FILETIME ticks，见设计原则 6**）→ 不匹配 → 关闭 handle、记 `skipped-replaced`、不杀；匹配 → **对同一 handle 调用 `TerminateProcess`**。handle 一旦打开即固定引用该进程对象、与 PID 无关：**复核与终止之间不存在 PID 复用窗口**。"同一 PowerShell 会话内先查询、比较、再按 PID kill"只是缩短窗口、并未闭合（目标仍可在比较后退出、PID 被复用、kill 命中新进程），不满足"绝不裸杀"，已废弃。`OpenProcess` 时 PID 已被复用 → handle 指向新进程 → `CreationTime` 复核不匹配 → `skipped-replaced`。**期望值必须独立于本次 handle 打开**（root 来自调用方已核验记录；子孙来自建树快照，见下）——把 handle 打开后查到的身份当作期望值即自证：PID 复用时会拿新进程身份与自身比较、必然通过而误杀；`OpenProcess` 返回"进程不存在" → `already-exited`；handle 查询/终止失败（权限等）→ `access-denied`/`query-failed`，不杀（fail-closed）；
- **建树快照携带独立身份与父链（评审第十五/十六轮 P0）**：CIM 枚举进程树时**一次性捕获每节点 `(pid, ParentProcessId, CreationDate, CommandLine, ExecutablePath)`**——快照身份取自枚举时刻，独立于后续 handle 打开；`CreationDate` 按设计原则 6 转为 FILETIME ticks 后作为该子孙的期望值与指纹。**每节点同时记录父身份 `(parentPid, parentCreationDate)`**（CIM 枚举时刻一并捕获）——树边只凭可复用的 `ParentProcessId` 无法绑定父 generation（见下条）；**禁止在打开 handle 后才捕获 CreationTime 充当期望值**（自证陷阱）；
- **root 复核不过即整批放弃**：root 记 `skipped-replaced` → **不建树、不杀任何 PID**（建树必须以复核后的 root 为准，避免把新进程的子孙当目标）；root 复核匹配 → 同会话内建树（快照）；
- **杀前全量核验：自顶向下 + 父链校验（评审第十六/十七/十八轮 P0）**：建树后、**杀任何 PID 之前**，按树的层级自顶向下对每个节点：`OpenProcess` → 经 handle 查 `CreationTime` 与快照 `CreationDate` 比较——**节点通过的前提 = 自身身份匹配 且 父链全部通过**。父链判定（评审第十八轮）：
  - **创建时间顺序**：`child.creationDate >= parent.creationDate`（快照 ticks 直接比较——顺序判定非等值，不适用容差）——父必须先于子存在才能创建子。可达误杀场景：旧进程 P（PID 500）创建无关进程 C 后退出，合法树成员 B 随后复用 PID 500，快照把 `C.parent=500` 连接到 B，B/C 自身 handle 身份均匹配——但 `C.creationDate < B.creationDate`，顺序校验失败 → C 归属存疑，不杀；
  - **父必须已被实际核验**：父在**杀前核验阶段**打开 handle 且身份匹配（其后被杀/复查时已退出）→ 子归属成立（父死不改变子的归属）；父在**核验阶段 `OpenProcess` 即返回"进程不存在"（从未被身份核验）→ 整批 abort**——未经核验的父不能担保子归属；
  - 父链根：root 由调用方已核验记录担保；
  **任一祖先身份不匹配（该祖先 `skipped-replaced`，父 PID 已被无关进程复用）→ 整批 abort（评审第十七轮 P0）**：root 与全部已识别子孙记 `query-failed`，**不杀任何 PID**——归属存疑的节点**绝不能生成 killable residual**（residual 只核验自身身份、不查父链，存疑节点落 residual 后仍会被自动杀；详见 §P1b-3 收敛规则）。自身不匹配 → 该节点 `skipped-replaced`（同属"父链存疑"触发条件，整批 abort）。**任一节点无法打开 handle、身份查询失败或快照指纹不全 → 整批 abort**：不杀任何 PID（root 一旦被杀，缺证的子孙已断链、无法再建树补证，owner 将永远无法收敛——证据必须在杀前拿全）；
- **杀前追加枚举（评审第十九/二十轮 P0，取代"杀后二次枚举"；best-effort 仅一轮）**：全量核验通过后、**杀任何 PID 之前**，再次枚举 `ParentProcessId ∈ 已核验通过且 handle 确认存活集合` 的进程——快照之后、核验期间新 spawn 的 child 经此追加识别。时序钉死（评审第二十轮 P0）：**① 追加枚举（CIM）→ ② 父存活复核 → ③ 追加核验 → ④ 杀**。**父存活复核**：追加枚举完成后、接受任何新增父子边之前，对每个新增节点的父，用**此前打开并已核验的同一 handle** 确认父仍未终止（handle 的终止状态可查、不受 PID 复用影响）——**全部父存活 → 证明快照捕获新增节点时旧 parent generation 尚未退出、其 PID 不可能已被复用，新增父子边可信**，进入追加核验（追加节点以追加枚举时刻捕获独立快照身份，同一套期望值/指纹规则 + 父链校验含 `child.creationDate >= parent.creationDate`，通过才可杀）；**任一新增节点的父已退出或无法确认存活 → 整批 abort（不杀任何 PID）**——枚举期间父自然退出并被复用、复用者创建 C 的窗口（`C.creationDate >= 父`、父"曾被核验"均无法区分）由此闭合。追加结果并入 `outcomes`。**杀后不得再枚举追加**（评审第十九轮 P0）：已退出的父不能担保新发现的 child；这是对"枚举后新 spawn"窗口的 best-effort 收紧，**不构成硬保证**（用户进程树无法冻结；保证范围见「目标」）；
- **指纹随 outcome 返回（评审第十四轮）**：`ProcessTreeOutcome.commandLine/executablePath` 取自建树快照（枚举时刻），供 residual 落盘与诊断；整批 abort 时各条目指纹缺省，收敛侧 fail-closed（§P1b-3）；
- **建树 deadline ≤3s**：经 PowerShell/CIM 枚举进程树超时或失败 → 该批整体 `query-failed`，不得半棵树半杀；
- **批杀内部 deadline + root 优先**：**全量核验通过后**，先杀 root 再杀子孙（核验阶段已开的 handle 复用于杀，杀阶段不存在复用窗口）；单次批会话超时未返回结果的 PID 一律记 `query-failed`，不得记 `killed`；
- **终态复查**：kill 请求后**经同一 handle 复查**确认终止（进程退出后 handle 仍可查询/等待，不受 PID 复用影响）；仍存活 → `kill-requested-unconfirmed`，记录保留、不得删除；
- **无 outcome = `query-failed`**：任何未显式产出 outcome 的 PID 都按查询失败处理（fail-closed）；
- **归因分层**：本层在同一批会话内完成"复核 root → 建树快照 → 自顶向下全量核验（父链校验）→ 杀前追加枚举 → 杀 → 终态复查"全链并接收调用方核验过的 `BatchTarget`；调用方负责 token/CommandLine 归因初判、记录提供与 outcome 收敛；**任何 PID 身份存疑 → 不杀并记 `skipped-replaced`/`query-failed`，绝不裸杀**；
- **自动路径无 taskkill fallback**：自动回收路径不调用不核验的 taskkill 兜底；taskkill 仅在 doctor 用户确认的手动命令中使用。

### P1a：consumer lock（Windows 走 guard，Unix 不变）

- Windows：先 `acquireIpcGuard({role:"consumer", configRoot})`（失败即 `ActiveWeixinConsumerLockError`）→ 写元数据文件 v2（`lockId`、`pid`、`mode`、`processCreationDate`、`schemaVersion: 2`），仅作 stop/doctor 识别用途，**不承担互斥**；
- Unix：现有 `createWeixinConsumerLock` 行为完全不变（文件 + `isProcessRunning` + 元数据）；
- `processCreationDate` 缺失一律保守视为 active（只影响提示与 stop 核验）。

### P1b：owner token + intent/登记 + reaper（**Windows-only 机制**：token argv、登记表、reaper 与 intent 清理均为 Windows 孤儿清理链路，Unix 不启用——adapter spec 的 `registerAdapterIntent` RPC 与 intent 落盘随之仅在 Windows 启用，见 adapter spec §3.6）

#### 1. token argv + readiness handshake

launcher 为本次 launch 生成随机 **`LaunchToken`（UUIDv4）——全链路唯一身份（评审第十六轮）**：argv 尾部 `--xacpx-owner-token <LaunchToken>`、intent 记录 `token` 字段、owner 记录 `token` 字段、residual 的 `ownerToken` 字段、adapter RPC 的 `intentToken` 字段，**全部是同一个 LaunchToken**（两份 spec 逐字对齐，不得分别生成）。归因依据：acpx 的 queue-owner dispatch 忽略不认识的尾部 argv（`../acpx/src/cli-core.ts:430-446`），且 spawn 时 `shell:false`（`../acpx/src/acp/client.ts:654`），token 原样出现在 agent 进程命令行，CIM `Win32_Process.CommandLine` 可实时核验。该依赖固定到受支持的 acpx 版本契约；若 acpx 未来 parse 尾部 argv，走 handshake 超时路径兜底（见下）。

**readiness handshake**：spawn 后 launcher 轮询 acpx queue lock（≤10s）确认 queue owner 就绪：

- **成功**：从 lock 记录读取 pid，**经 RPC 上报 daemon 执行登记升级（intent→owner）**——升级与 intent 落盘/删除的唯一执行者是 daemon（`launchSettled { outcome: "owner-committed" }`，见 adapter spec §3.6）；launcher 不得自行删除 intent；
- **超时三态**（按进程存活与 CIM 可用性分支）：
  - **进程仍存活（alive）**：保留 intent，向上报错（owner 可能慢启动，不得误删归因）；
  - **进程已退出（exited）**：经 RPC 上报 `launchSettled { outcome: "launch-failed" }`，**由 daemon 删除 intent**（launcher 不得自行删除，见 adapter spec §3.6）——**删除前置条件：daemon 先执行完整 token 快照，确认不存在任何命令行含 `--xacpx-owner-token <LaunchToken>` 的存活进程；发现同 token descendant 或快照失败（CIM 不可用）→ 保留 intent + 告警**（评审第十九轮，与 adapter spec §3.6 逐字一致），launch 失败；
  - **CIM 不可用（无法判定存活）**：保留 intent，向上报错（fail-closed）。

#### 2. 记录结构（与 adapter spec 契约对齐）

```
~/.xacpx/runtime/orphans/
  generation.json   intents/<token>.json   owners/<hash>-<generation>-<pid>.json   residuals/
```

- **intent 记录（完整 schema）**：`{ schemaVersion: 1, kind: "intent", token, launcherPid, launcherCreationDate, generationId, configRoot, queueHash, agentCommand, createdAt }`。字段语义：`launcherPid`/`launcherCreationDate` 是写 intent 的 launcher 进程自身（bridge transport 下为 bridge subprocess）的 PID 与 CreationDate，供 launcher fencing 用（§4）——**bridge 路径下由 daemon 以自己持有的 bridge child PID 为准写入、并独立查询 CreationDate，不原样信任 bridge 上报**（上报值仅作一致性校验，见 adapter spec §3.6）；`agentCommand` 在 intent 落盘时（spawn 前）写入，owner/residual 迁移时随迁；`generationId` = 写 intent 时的 daemon generation；
- owner 记录：`{ schemaVersion, token, pid, queueHash, acpxRecordId, generationId, configRoot, startedAt, agentCommand, fingerprint: { executablePath, commandLine, creationDate } /* null=不可杀 */, killAttempts }`（`creationDate` 为 FILETIME ticks，launcher 经 handle `GetProcessTimes` 捕获，见设计原则 6）；
- residual：`{ kind: "residual", ownerToken, pid, creationDate, commandLine, executablePath, agentCommand, generationId, killAttempts }`（`creationDate`/`commandLine`/`executablePath` 取自批杀 `ProcessTreeOutcome` 的建树快照指纹——**CIM-derived，复核比较用 |Δ| ≤ 9 容差，见设计原则 6**；**缺完整指纹的记录不得落盘**，见 §P1b-3）；
- **durable write 协议（跨 spec GC 一致性前提）**：所有记录的"写入"= 写到同目录临时文件（`<name>.tmp-<random>`）→ flush + `fsync` → `rename` 原子替换目标路径；rename 成功即视为 durable。**持久性声明（评审第十六轮小问题）**：该协议保证**进程崩溃级**持久（崩溃后临时文件残留由 reaper 启动时清理，`.tmp-*` 直接删除，不承载语义）；**不承诺掉电/OS crash 级持久**——如目标包含掉电持久，rename 后还需 `fsync` 父目录（可选增强，默认不做）。迁移类写入（intent→owner、owner→residual、登记升级）必须**新记录 rename 成功后才删除旧记录**；owner 拆分为多个 residual 时，**全部 residual 写成功后才删 owner**（部分失败 → 已写的 residual 保留，owner 保留，下次 sweep 重对账；任一时刻至少一份含 `agentCommand` 的副本存在）；
- 接口（adapter spec 契约；**第十一轮：返回 revision + 扫描顺序不变量**）：

```ts
/** 返回所有未确认终止记录的 agentCommand 及快照修订号。
 *
 *  扫描顺序是 API 不变量：严格 intents → owners → residuals，
 *  每次扫描必须完成一类后才开始下一类（adapter spec GC 一致性证明依赖此顺序；
 *  categories 参数乱序或缺失必须拒绝，实现不得硬编码其它顺序）。
 *
 *  snapshotRevision 为本次扫描所见全部记录（文件名+内容）的稳定摘要
 *  （如按扫描顺序拼接 `文件名 + "\0" + 规范化内容` 后取 sha256 hex），
 *  供 GC 删除前重扫比对：任一记录迁移、增删、替换都会改变 revision。
 *
 *  目录不可读/缺失 → null；任一记录缺 agentCommand 字段（旧 schema）→ null；
 *  任一记录 JSON 解析失败 → 同样返回 null（不得跳过单条继续）。 */
listOwnerAgentCommands(
  categories: ["intents", "owners", "residuals"],
): Promise<{ commands: string[]; snapshotRevision: string } | null>
```

#### 3. 回收与收敛状态机

reaper sweep 对每条 owner 记录：核验 token（CIM CommandLine 含 `--xacpx-owner-token <token>`）+ fingerprint（CreationTime 经 handle `GetProcessTimes` 复核，FILETIME ticks，见设计原则 6）后，以 owner fingerprint 构造 `BatchTarget`（pid + creationDate + executablePath/commandLine）批杀进程树，按 root outcome 收敛：

- **root 终态**（`killed` / `already-exited` / `skipped-replaced`）：`skipped-replaced` 说明原进程已退出（PID 被复用）且本批未杀任何 PID，同 `already-exited` 收敛。遍历 `outcomes` 中子孙条目——**终态子孙（`killed` / `already-exited` / `skipped-replaced`）不记录**；**未终态子孙（`kill-requested-unconfirmed` / `access-denied` / `query-failed`）指纹完整则落 residual**（携 owner 的 `agentCommand`；`creationDate`/`commandLine`/`executablePath` 取 `ProcessTreeOutcome` 快照指纹）→ 全部 residual 写成功后删 owner（§2 durable write 协议）；
- **root 未终态**（`kill-requested-unconfirmed` / `access-denied`）：owner 保留（`killAttempts += 1`），已识别的未终态子孙（含 `query-failed`）同样落 residual，下次 sweep 重试；
- **整批 abort（root `query-failed`，评审第十七轮 P0）**：owner 保留（`killAttempts += 1`），**已识别子孙一律不落 residual**——abort 语义 = 证据不全/归属存疑（祖先 PID 复用、无法开 handle、指纹不全）而放弃整批；其中的节点**不是可自动杀的归因目标**（residual 状态机只核验自身身份、不查父链，落 residual 即绕过错杀防线）。下次 sweep 重新枚举（PID 复用者其真实父链不在树内，新快照自然排除），不产生 killable residual；
- **verificationUnavailable**（CIM/PowerShell 不可用，无法核验或无法确认终态）：owner 与既有 residual 全部保留，只告警，不删任何记录。

**residual 指纹 fail-closed（评审第十四/十五/十七轮）**：未终态子孙落 residual 的**前提 = 归属已确认（父链核验通过）且 `ProcessTreeOutcome` 携带完整指纹**（`target.creationDate` + `commandLine`/`executablePath`）——第十七轮后"父链存疑"与"缺指纹"都只出现在整批 abort，而 abort 的子孙一律不落 residual（见上）；此条为残余兜底：任何途径出现的缺指纹/归属存疑未终态子孙 → **不落 residual，owner 保留（`killAttempts += 1`）下次 sweep 重试**（无指纹或归属存疑的 residual 无法在后续复核中安全归因，落盘即制造不可杀记录）。

**收敛 fail-closed（评审 P1/第十八/十九轮）**：状态转移只认以上显式列出的 outcome 分组；**未终态子孙落 residual 的允许集合 = 正常批杀中"归属已确认（父链通过）且指纹完整"的 `kill-requested-unconfirmed` / `access-denied` / `query-failed`**（`query-failed` 仅限正常批杀中的个别子孙——其父链已通过；整批 abort 的 `query-failed` 不落，见上）；**任何未列出的 outcome 或新态组合（未知状态）一律按"root 保留 owner 且不生成任何新 residual"处理**——未知 outcome 可能意味着归属存疑，落 residual 会绕过父链检查。实现不得因 switch/default 遗漏而删除任何记录（删除 owner 的唯一路径是 root 终态且全部未终态子孙已成功落 residual）。

**residual 回收状态机（评审第十六轮 P1，补全 P1d timer"收敛 residual"的契约依据）**：sweep 对每条 residual 独立执行（不依赖其 owner 记录——owner 可能已删）：

- **核验**：`OpenProcess(pid)` → 经 handle 查 `CreationTime`，与 `residual.creationDate` 按设计原则 6 比较（|Δ| ≤ 9 ticks 即同一进程）：
  - **PID 不存在**（原进程已退出）或**身份不匹配**（PID 复用）→ 原进程确认已死 → **删除 residual**（终态收敛）；
  - **无法打开 handle / 查询失败**（权限等）→ 保留 residual + 告警，`killAttempts += 1`，下次 sweep 重试（fail-closed，不得删除）；
- **身份匹配** → 对同一 handle `TerminateProcess` → 终态复查：
  - `killed` / `already-exited` → **删除 residual**；
  - `kill-requested-unconfirmed` / `access-denied` → 保留，`killAttempts += 1`，下次 sweep 重试；
  - `query-failed` → 保留 + 告警（fail-closed）；
- residual 不产生新 residual（无递归）；其 `agentCommand` 供 GC 引用判定持续有效直到记录删除。

**记录迁移不变量（评审 P0，跨 spec GC 一致性前提）**：任何记录迁移（intent→owner、owner→residual、登记升级）必须**先 durable 写入新记录、后删除旧记录**（具体协议见 §2 durable write）。该不变量保证任一时刻至少存在一份含 `agentCommand` 的副本，adapter spec 的 GC 因此可以用"扫描 → 决定 → 删除前重扫比对 `snapshotRevision`"协议证明引用视图一致，reaper 自身无需持有 adapter guard。

#### 4. intent 清理（generation 归属 + launcher fencing）

intent 仅在以下四条**同时**满足时才允许删除：

1. `createdAt` 距今 > 60s；
2. **一次成功且完整的进程快照确认 token 不存在**（查询失败 → 永久保留并告警）；
3. `intent.generationId !== 当前 generationId`（当前 daemon 的 launcher 可能暂停中）；
4. **launcher 本身已确认终止**（评审第十一轮 P0）：按 intent 记录的 `launcherPid` 查询——PID 不存在，或该 PID 的 CreationTime（经 handle `GetProcessTimes`，FILETIME ticks）与 `intent.launcherCreationDate` 不匹配（PID 复用，原 launcher 已死）→ 通过；**handle 查询/快照不可用 → 永久保留并告警**（fail-closed，与条件 2 一致）。

条件 4 是 launcher fencing 的核心，取代旧版未证明假设"旧 generation 的 launcher 必随 daemon 终止"。旧版缺口（可达）：旧 bridge 写 intent → spawn 前 generation 复核通过 → **暂停在 spawn 前** → daemon 主进程崩溃、consumer guard 随进程死释放 → 新 generation 启动 → 60s 后 intent 满足旧三条件被删 → 旧 bridge 恢复并 spawn 出无归因 owner。条件 4 下该场景 intent 保留（launcher 仍存活），直到 bridge 真正退出才可清理；死亡是单调的，"launcher 已死"的判定不存在 TOCTOU 复活窗口（PID 复用由 CreationDate 排除）。

辅助防御层（不承担正确性，缩短暴露窗口）：

- **shutdown drain**：daemon dispose 等待所有 in-flight `launcher.launch()` settle，且 **bridge transport 下等待 bridge subprocess 退出后才释放 consumer guard**——正常停机路径下新 generation 不可能在旧 launch 未结束时启动；
- **spawn 前 fencing**：launcher 在实际 `spawn` 前复核 `generation.json` —— 其 `generationId` 若不是自己 intent 的 generation（说明自己已被新 generation 取代）→ **abort，发送 `cancelAdapterIntent` 由 daemon 删除 intent（评审第十七轮：launcher 不得自行清理）**，launch 失败，绝不 spawn 出无归因的 owner。bridge transport 下 fencing 检查在 bridge subprocess 内完成（generation.json 路径经 env 传递）。该检查是快速放弃路径；launcher 在检查与 spawn 之间暂停的窗口由条件 4 兜底。

长期保留的 intent（launcher 挂死等）由 doctor 报告暴露，不自动强杀。

#### 5. legacy owner 迁移

对无 token 的既有 queue owner（升级前启动、命令行无 `--xacpx-owner-token`）：

- **检测**：queue lock 指向的 pid 存活且命令行不含 owner token → legacy owner；
- **默认复用 + 告警**：不杀，绑定为当前 session 的 transport owner 继续使用，向用户告警说明该进程无法被自动核验回收；
- **TTL 自然轮换**：acpx queue lock TTL 到期后自然重启，新 owner 走 token 路径；
- **TTL=0 配置**：无自然轮换机会 → 告警升级，提示用户手动重启 daemon/session 完成迁移；不自动强杀；
- **CIM 不可用**：无法核验 legacy owner 身份 → 报 `legacy-owner-unverifiable` degraded 错误，不承诺该 session 可用（fail-closed）。

### P1c：`xacpx stop`（kill 前四态 + kill 后确认）

串行化：Windows 取 `acquireIpcGuard({role:"lifecycle", configRoot})`，Unix 用既有 `openPidFileExclusive`。

流程：**冻结 `generation.json`**（标记当前 generation 进入终止流程，reaper 不再为其启动新 sweep）→ daemon 核验四态 → kill → 确认后 sweep。

**kill 前核验四态**（按 pidfile/state 记录的 `daemonPid` + `daemonCreationDate`；**核验与终止合并为 handle-stable 操作，与 P0b 同一套原语**——`OpenProcess` → 经 handle 查 `CreationTime` → 比较 → 同一 handle 终止，复核与终止间无 PID 复用窗口）：

1. **不存在**：`OpenProcess` 返回"进程不存在" → daemon 已退出 → 不 kill，直接 sweep 该 generation 的记录；
2. **PID 存在但不匹配**：经 handle 查询的 `CreationTime` 与 `daemonCreationDate` 不符（PID 复用或别的进程）→ **不 kill**（不伤及无关进程），按"不存在"同样可 sweep；
3. **查询失败**（无法打开 handle / `GetProcessTimes` 失败 / **`daemonCreationDate` 缺失（null）或格式非法**——无身份证据可复核）→ **全保守**：不 kill、不 sweep，返回失败并告警；
4. **匹配**：确认是目标 daemon → **直接复用完整 `terminateProcessTree({ pid: daemonPid, creationDate: daemonCreationDate, ... })`（P0b 同一套原语）树杀**，终止 daemon 及其树内子进程（bridge 等直属子进程一并终止，不再只对 daemon handle 单独 TerminateProcess）→ 进入 kill 后确认。**不设"先优雅退出"阶段（评审第十五轮 P1）**：Windows 无 SIGTERM 等价信号（`process.kill` 在 Windows 即 TerminateProcess），而"不做的范围"禁止新增 daemon IPC——外部不存在可触发 JS dispose / shutdown drain / bridge 正常退出的现有且可验证通道，优雅阶段不可实现；一致性由冻结 `generation.json` + 整树确认兜底（daemon 崩溃路径本就依赖同一机制）。daemon 自身的正常停机（前台 Ctrl+C 等）仍走 dispose，不受影响；Unix 保持 SIGTERM dispose 语义。

**kill 后确认**：轮询直至**整棵树确认终止**——root（daemon）经同一 handle 复查/等待（不受 PID 复用影响），树内子进程按各自终态复查；全部确认后才 sweep 该 generation 的记录并清理 `generation.json`；超时仍有未终态 → **保留冻结的 generation 与全部记录，返回失败**（下次 stop 或 reaper 重试）。Unix 保持 SIGTERM dispose 语义，同样要求确认后清理。

### P1d：二次对账 timer

daemon 存活期内周期性二次对账（补漏杀/收敛 residual）：

- **句柄管理**：timer 句柄由 runtime 持有，`unref()` 不阻塞进程退出；
- **cleanup 清除**：dispose/cleanup 时 `clearTimeout`/`clearInterval` 并等待在途 sweep settle（与 shutdown drain 同一路径）；
- **dispose guard**：sweep 在途时 dispose 不得提前释放 consumer guard（Windows）；
- 每次对账复用 §3 收敛状态机与 §4 intent 清理四条件，不引入新删除路径。

## 组件 & 改动

1. `src/process/ipc-guard.ts`（新；Windows-only 互斥原语 + key 规范化）。
2. `src/process/windows-processes.ts`（新）；`terminate-process-tree.ts`（批杀契约）。
3. `src/process/registered-orphan-reaper.ts`（新；`listOwnerAgentCommands` 固定顺序扫三类 + 返回 `{ commands, snapshotRevision } | null` + 解析失败即 null）。
4. `src/transport/acpx-queue-owner-launcher.ts`（legacy/降级、token argv、handshake 三态、`agentCommand`）。
5. `src/bridge/*`（env/options 透传）。
6. `src/weixin/monitor/consumer-lock.ts`（Windows 切 guard，Unix 不变）。
7. `src/daemon/daemon-controller.ts`（lifecycle guard/Unix pidfile、四态 + kill 后确认）。
8. `src/main.ts` / `src/run-console.ts`（identity、generation.json、reap、timer）。
9. `src/doctor/`（报告 + `xacpx orphans kill --confirm`）。

## 测试计划（本轮变更要点）

- **ipc-guard**：Windows 双进程同 key 恰一成功（必跑项）；`kill -9` 后释放；key 规范化（大小写/斜杠/尾部分隔符/junction 同 key）；Unix 下 guard 不启用、consumer lock 旧行为回归；
- **批杀契约 handle-stable 复核（评审 P0 回归，Windows 必跑项）**：目标在复核与 kill 之间退出且 PID 被复用 → 同一 handle 操作不命中新进程（断言：期望 CreationTime 不匹配的进程存活、匹配的进程被终止）；`OpenProcess` 时 PID 已被复用 → handle 指向新进程、复核不匹配 → `skipped-replaced`、未建树未杀任何 PID（root）/该子孙不杀；`OpenProcess` 返回"进程不存在" → `already-exited`；handle 查询/终止失败 → `access-denied`/`query-failed` 不杀（fail-closed）；`BatchTarget.creationDate` 为 null → 一律 `query-failed` 不杀；
- **建树快照独立身份 + 父链校验（评审第十五/十六/十七/十八轮 P0 回归，Windows 必跑项）**：child 在 CIM 枚举后退出、PID 被无关进程复用 → handle 查到的 CreationTime 与快照 CreationDate 不匹配 → 该子孙 `skipped-replaced` 不杀（断言新进程存活）；**中间节点 B 在枚举期间退出、PID 被 B2 复用，B2 的后代挂到旧 B 分支 → 整批 abort（断言：自身身份匹配的后代也不杀、root 也不杀，全部 `query-failed`）**；**创建时间顺序（评审第十八轮 P0 回归）：旧进程 P 创建无关进程 C 后退出、合法树成员 B 复用 P 的 PID，B/C 自身身份均匹配但 `C.creationDate < B.creationDate` → C 不杀（断言）**；**父未核验（评审第十八轮 P0 回归）：核验阶段父 `OpenProcess` 即"进程不存在"（从未被身份核验）→ 整批 abort（断言不杀任何 PID）**；**abort 后收敛断言：不生成任何 residual（owner 保留重试，下次枚举复用进程因真实父链不在树内被自然排除）**；**期望值取自快照而非 handle 打开后捕获**（断言实现无"打开后取 CreationTime 当期望值"路径）；任一子孙无法开 handle/查询失败/快照指纹不全 → **整批 abort（root + 全部子孙 `query-failed`，断言未杀任何 PID，包括已复核通过的 root）**；**杀前追加枚举（评审第十九/二十轮 P0 回归）**：核验后新 spawn 的 child（`ParentProcessId ∈ 已核验且 handle 存活集合`）被追加识别、按同一父链校验后杀（best-effort 断言）；**父在追加枚举过程中退出 → PID 复用 → 新父创建 C → 整批不杀（评审第二十轮竞态注入：追加枚举完成后父 handle 存活复核失败 → 整批 abort 断言，含"枚举期间父自然退出 + PID 复用"模拟）**；**父被杀后 PID 复用并创建新 child → 不得杀（断言：杀后不再枚举追加，追加 child 保持存活）**；快照指纹完整 → 正常批次杀前证据齐全；
- **handshake/fencing 删除路径（评审第十七/十九轮 P1 回归）**：handshake exited → launcher 发 `launchSettled{launch-failed}`、**daemon 先完整 token 快照（无同 token 存活进程才删 intent；断言：模拟同 token descendant 仍存活 → intent 保留；快照失败 → intent 保留）**（断言 launcher 侧无文件操作）；spawn 前 fencing abort → `cancelAdapterIntent`、daemon 删 intent（断言）；
- **residual 回收状态机（评审第十六轮 P1 回归）**：PID 不存在/身份不匹配 → residual 删除；身份匹配 → 同 handle 杀 → killed/exited → 删除；unconfirmed/access-denied → 保留 `killAttempts += 1`；无法打开 handle → 保留 + 告警（不删）；residual 不递归产生新 residual；owner 删除后 residual 独立收敛；
- **批杀返回值与指纹（评审第十四轮 P1 回归）**：`outcomes` 为 `ProcessTreeOutcome[]`、覆盖 root 与全部被识别子孙、每个 PID 至多一条；`commandLine`/`executablePath` 来自建树快照；整批 abort 条目指纹缺省；**缺完整指纹的未终态子孙不落 residual、owner 保留重试**（兜底路径）；
- **CreationDate 规范（评审第十四/十五/十六/十七/十九轮 P1 回归）**：落盘与传输为**规范化十进制字符串**、比较在 bigint/uint64 上进行（断言无 JSON number 落盘/比较路径）；**容差分场景（评审第十七/十九轮）**：CIM-derived 快照子孙比较 |Δ| ≤ 9 ticks 判定一致；**residual 复核同样用 |Δ| ≤ 9（其指纹继承 CIM 快照，断言无精确比较路径）**；**handle-derived 值（owner fingerprint、daemon/launcher 身份）精确等值（断言无容差路径）**；**LaunchToken 唯一身份**：argv token、intent.token、owner.token、residual.ownerToken、RPC intentToken 为同一 UUID（断言）；
- **stop 树杀（评审第十四/十五轮 P1 回归）**：状态 4 **直接** `terminateProcessTree` 树杀（无优雅阶段断言），**bridge 等树内子进程被终止（断言）**；整棵树未全部确认终止 → 保留冻结 generation 与记录、返回失败；`OpenProcess` 失败 → 状态 1（不存在）；CreationTime 不符 → 状态 2（不 kill）；handle 查询失败**或 `daemonCreationDate` 为 null/非法** → 状态 3（全保守，不 kill 不 sweep）；kill 后经同一 handle 复查确认；
- **收敛状态机 outcome 全覆盖（评审 P1/第十八轮回归）**：root `query-failed`（整批 abort）→ owner 保留（`killAttempts += 1`）、不删记录、**子孙一律不落 residual**；**正常批杀（root 终态）中个别子孙 `query-failed`（父链已通过、指纹完整）→ 落 residual**；root/子孙 `skipped-replaced` → 按终态收敛（不记录/可删 owner）；**未列出的 outcome 组合（模拟新态）→ 默认分支保留 owner 且不生成任何新 residual（断言无 residual 落盘）**；
- **intent 清理四条件**：完整快照无 token + >60s + 非当前 generation + launcher 已终止 → 删；当前 generation 的 intent 永不因时间被删；查询失败永久保留；launcher 存活时即使满足前三条也不删（条件 4）；PID 复用（CreationDate 不匹配）视为 launcher 已终止；
- **launcher fencing 崩溃场景（评审 P0 回归，Windows 必跑项）**：旧 bridge 写 intent 并暂停在 spawn 前 → daemon 主进程崩溃（guard 随之释放）→ 新 generation 启动 → 超过 60s 后 intent **必须保留**（launcher 存活）；旧 bridge 随后恢复并正常 spawn，intent 升级 owner 归因不丢；旧 bridge 放弃/退出后 intent 才可被四条件清理；
- **shutdown drain**：dispose 等待 in-flight launch 与 bridge subprocess 退出后才释放 consumer guard（正常停机路径断言）；
- `listOwnerAgentCommands`：三类记录覆盖；单条解析失败 → 整体 null；**扫描顺序不变量**（categories 乱序/缺失拒绝）；**snapshotRevision**：记录增/删/替换/迁移（先写新后删旧各时点）revision 必变，内容不变则 revision 稳定；
- **durable write**：owner→多个 residual 迁移，部分 residual 写失败 → owner 保留、已写 residual 保留；全部成功后 owner 才删；临时文件 rename 前崩溃不产生半写记录；
- stop kill 后确认、四态、residual agentCommand、handshake 三态、legacy 降级（既有回归保留）。

## 不做的范围

- **Unix 不引入新互斥机制**（保持现状；UDS unlink 竞态后果不可接受）；
- 文件协议互斥锁不作为并发正确性依据；
- Job Object（P3）；不自动杀活着的孤儿 daemon / legacy owner；不加 daemon IPC；不替换 acpx；adapter 预安装独立 spec；不改 session 语义；不做关键词启发式强杀。

## 推荐实施顺序

1. **P0** — `ipc-guard.ts`（Windows）+ `windows-processes.ts` + 批杀契约。
2. **P1a** — consumer lock Windows 切 guard。
3. **P1b** — identity + token + handshake + legacy + 登记/reaper。
4. **P1c/P1d** — controller stop 状态机 + 二次对账 timer。
5. **P2** — adapter 预安装（独立 spec）。**P3** — Job Object（候选）。

## 相关源码位置

- `src/process/ipc-guard.ts`（新）/ `windows-processes.ts`（新）/ `registered-orphan-reaper.ts`（新）/ `terminate-process-tree.ts`
- `src/transport/acpx-queue-owner-launcher.ts` / `src/transport/acpx-bridge/` / `src/bridge/bridge-main.ts` / `bridge-runtime.ts`
- `src/weixin/monitor/consumer-lock.ts` / `src/daemon/daemon-controller.ts`
- `src/main.ts` / `src/run-console.ts` / `src/doctor/`
