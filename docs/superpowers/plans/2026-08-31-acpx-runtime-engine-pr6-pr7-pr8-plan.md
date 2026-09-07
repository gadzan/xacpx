# xacpx × acpx Runtime：PR6–PR8 执行计划

## 0. 基线与总约束

基线：

- 仓库：`gadzan/xacpx`
- 分支：`feat/acpx-runtime-engine`
- 当前基线 commit：`b0dc15b24b6dae26da05fe5e23c7ce25044b8bde`
- 当前 #312 已完成约 PR0–PR5。
- PR6、PR7、PR8 在同一分支顺序推进，但必须作为三个独立 implementation wave：
  - PR6 完整实现、测试、CI 闭环后才能进入 PR7。
  - PR7 完整闭环后才能进入 PR8。
  - commit 不得把不同 wave 混在一起。

当前 Runtime 继续保持 **dormant**：

```text
bridge-main.ts
→ BridgeRuntime
→ CliEngine
```

本轮 PR6–PR8 **不得**：

```text
构造 RuntimeEngine 到 production bridge-main
切换 engine:auto 到 Runtime
改变默认 engine=cli
让普通 production session 获得 Runtime traffic
实现 PR9 interactive permission UI
实现 PR10 default switch
```

当前这一 staging 原则符合 spec：PR6 是 durable queue、PR7 是 live permission parity、PR8 是 MCP coordinator parity，PR10 才负责 `cli → auto` 默认切换。

同时继续保留以下三个 Runtime activation blocker，不在 PR6–PR8 中顺手扩 scope，除非某一 wave 的测试证明它直接阻塞本 wave：

```text
1. shared physical transport → Runtime physical owner aggregation / fail-closed
2. fenceDir safe default
3. Runtime owner 启动前 saveNow() crash-durable engine identity gate
```

所有 Runtime 新代码继续遵守 G13：

```text
只允许 public acpx/runtime contract
不得 import acpx/src/*
不得 import acpx/dist/*
不得依赖 Runtime 私有 manager/client
```

---

# PR6 — Runtime durable queue

## 1. 目标

实现 Runtime-bound session 的：

```text
injectMessage(mode=queue)
injectMessage(mode=auto → queue)
durable FIFO
messageId idempotency
queue limit
background drain
worker/bridge crash recovery
TTL interaction
delete/archive/cancel interaction
```

明确不实现：

```text
steer
interrupt
same-turn injection
```

当前 `RuntimeEngine.injectMessage()` 对所有 mode 都直接返回 `RUNTIME_ENGINE_UNSUPPORTED`，因此 PR6 就从这个 seam 接入。

spec 明确要求 queue 属于 **xacpx / RuntimeEngine**，不能放在 Runtime Worker 内存中；ack 必须发生在 durable persist 成功之后。 

---

## 2. 第一步：先固定现有 CLI 产品语义

实现 Runtime queue 前，先增加 differential/characterization tests，回答以下问题，不允许凭感觉决定：

```text
A. queue limit 当前是多少？
B. overflow 使用什么现有 error code / MessageInjectionError？
C. duplicate messageId 当前语义是什么？
D. cancel(active + pending queue) 到底取消什么？
E. archive 时 pending message 是保留、拒绝还是清除？
F. delete 时 pending queue 是何时删除？
G. queue 中一条 turn 最终 failed/cancelled 后，是 dequeue 还是 retry？
H. auto 当前在不能 steer 时应如何表现？
```

原则：

```text
能对齐 CLI → 对齐
spec 明确规定 → 按 spec
两边都没定义 → fail closed，并用测试锁定新语义
```

特别是 `cancel()`，spec 明确要求先做 CLI differential，不得假定 cancel 自动清空 pending queue。

---

## 3. 新增 durable queue 模块

建议新增：

```text
src/bridge/engine/runtime/runtime-queue.ts
```

必要时拆：

```text
runtime-queue.ts
runtime-queue-store.ts
```

不要把 journal 读写直接堆进 `runtime-engine.ts`。

建议数据目录：

```text
~/.xacpx/runtime/runtime-queue/
```

必须是 **xacpx-owned state**，不要错误放入：

```text
~/.acpx/sessions
```

因为 `.acpx` 是 upstream acpx session store。

优先复用已有 xacpx Runtime state root/helper，如 `defaultRuntimeDir()`。

journal：

```ts
interface RuntimeQueueRecord {
  schema: "xacpx.runtime-queue.v1";
  logicalSessionId: string;
  items: RuntimePendingMessage[];
}

interface RuntimePendingMessage {
  messageId: string;
  text: string;
  acceptedAt: string;
  mode: "queue" | "auto";
}
```

最低要求：

```text
private atomic write
write temp → rename
read-back/schema validation
corrupt/unreadable → fail closed
never treat unreadable as empty
```

journal key 必须是：

```text
logicalSessionId
```

不得以 alias/display name 作为 durable queue ownership identity。

---

## 4. enqueue transaction

`RuntimeEngine.injectMessage()`：

支持：

```text
mode=queue
mode=auto
```

第一阶段：

```text
auto → queue
```

因为 steer 仍明确 disabled。

以下仍显式失败：

```text
steer
interrupt
→ RUNTIME_ENGINE_UNSUPPORTED
```

enqueue 顺序必须是：

```text
acquire per-session queue mutation lock
↓
reject deleting/shuttingDown/invalid lifecycle
↓
load authoritative journal
↓
check duplicate messageId
↓
check queue limit
↓
append FIFO
↓
atomic persist
↓
read/verify if store abstraction requires
↓
return {
  status: "queued",
  modeUsed: "queue"
}
↓
kick drain
```

禁止：

```text
append memory
→ ack
→ later persist
```

因为：

```text
crash after ack
→ message lost
```

就是 PR6 要消灭的问题。

### duplicate messageId

相同：

```text
messageId + same payload
```

应返回已有 queued receipt，不重复 append。

如果：

```text
same messageId
but different text
```

spec 没有定义。

建议 fail closed 为 idempotency conflict，而不是静默接受其中一个；如果当前 CLI 已定义其他行为，以 differential test 为准。

---

## 5. drain 必须 single-flight

RuntimeEngine 增加类似：

```ts
private readonly draining = new Map<string, Promise<void>>();
```

同一 logical session 永远最多一个 drain loop。

算法：

```text
while:
    reload/inspect queue

    if deleting/shuttingDown:
        stop

    if active turn exists:
        stop / wait for turn settle

    if queue empty:
        schedule TTL
        return

    head = first item

    ensure same Runtime worker
    execute head as normal Runtime prompt turn
    await turn.result terminal settlement

    apply CLI-compatible terminal outcome semantics

    atomically remove head from journal
    continue
```

不要：

```text
shift durable queue before turn result
```

磁盘 journal 在 turn 完成并完成 dequeue persist 前必须仍能恢复这条消息。

---

## 6. 复用 prompt turn executor

不要复制当前 `RuntimeEngine.prompt()` 的：

```text
ensure
activeTurns
worker lifecycle
prompt RPC
error mapping
turn.result
idle scheduling
```

建议先抽一个 private primitive，例如：

```ts
executeRuntimeTurn(
  input,
  text,
  options
)
```

然后：

```text
direct prompt
queue drain
```

都走同一个 turn lifecycle。

区别只在：

```text
direct prompt:
  有 BridgePrompt event sink
  caller await result

queue drain:
  没有原始 caller
  不向已结束的 inject RPC 输出 stream event
  result 写入正常 acpx persistent record
```

不得为了 queue 再造第二套 turn state machine。

---

## 7. crash semantics

PR6 目标首先是：

```text
at-least-once durable queue
```

即：

```text
ack 后绝不 silent-loss
```

当前 spec 没有提供 exactly-once transaction。

因此：

```text
worker started turn
→ process crashes
→ durable head 尚未 remove
→ restart may replay head
```

这是可能的。

不要偷偷宣称 exactly-once。

如果现有 CLI 有更强 guarantee，则必须另行实现并测试；否则 PR6 的 acceptance contract 应明确是：

```text
no acknowledged message loss
possible replay across ambiguous crash boundary
```

---

## 8. Bridge restart recovery：必须解决的设计点

这里不能只实现：

```text
下一次用户访问 session
→ load queue
```

因为 spec 明确要求：

```text
Worker/Bridge restart
→ reload queue
→ drain
```

但当前 sample journal 只有：

```text
logicalSessionId + message items
```

而重新 spawn Runtime Worker 至少需要：

```text
agent
cwd
name/sessionKey
agent launch identity
未来还有 MCP launch identity
```

仅靠 `logicalSessionId` 无法重建 Worker。

所以 PR6 在完成前必须明确选择一个恢复方案。

优先方案：

### 方案 A — 从 xacpx authoritative session state 恢复

Bridge/RuntimeEngine startup 获得当前 logical sessions 的 `EngineSessionInput`，然后：

```text
enumerate runtime-queue journals
→ logicalSessionId lookup authoritative session
→ only runtime-bound session accepted
→ kick drain
```

这是更推荐的方案，因为 queue journal 不需要复制 agent command / argv / cwd 等 launch identity。

如果当前 Host 生命周期没有 session catalog seam，则新增一个最窄的 internal recovery seam。

不要为了方便把整个 `ResolvedSession` 无脑复制进 queue journal。

如果确实选择 journal 携带 launch snapshot，必须单独 review：

```text
schema
staleness
agent argv
path
credential leakage
MCP identity
engine migration
```

不能临时加几个字段后宣称 restart recovery 完成。

**没有真实 Bridge restart recovery test，PR6 不算完成。**

---

## 9. TTL / freeWarm

当前 Runtime TTL 只检查：

```text
!activeTurns.has(key)
```

PR6 后必须升级成：

```text
no active turn
AND
durable pending queue empty
```

只要 queue 非空：

```text
不得普通 idle cool
```

如果 worker 不存在：

```text
spawn → drain
```

`freeWarmProcess()` 同样不得让 durable pending queue 永久无人处理。

具体 archive 行为必须以第一步得到的 CLI characterization 为准。

---

## 10. delete integration

`deleteSession()` 必须加 queue lifecycle boundary。

建议：

```text
mark logical session deleting
↓
new enqueue rejected
↓
complete existing hard-delete transaction
↓
ONLY after record deletion verified successful
    delete runtime queue journal
↓
clear queue state/deleting marker
```

如果 hard delete 失败：

```text
queue journal 不得提前丢失
```

因为 tombstone retry 仍然需要一致的 session ownership state。

---

## 11. cancel integration

不要把 queue 存储 API 和 public `cancel()` 混在一起。

内部建议：

```ts
cancelActiveTurn()
cancelPendingMessage(...)
```

外层 `cancel()` 根据现有 CLI product semantics 组合。

必须有：

```text
active only
pending only
active + pending
empty
worker crashed + pending
```

的 differential tests。

---

## 12. PR6 测试 Gate

最低新增：

```text
runtime-queue.test.ts
runtime-engine-queue.test.ts
runtime-queue-recovery.test.ts
```

必须覆盖：

```text
FIFO order
ack only after durable write
write failure → inject rejects
corrupt journal → fail closed
duplicate id idempotent
duplicate id conflicting payload
overflow parity
one session single drain
different sessions independent drains
queue while direct prompt active
worker crash before turn start
worker crash during turn
worker restart recovery
Bridge Host restart recovery
no acked message loss
TTL cannot cool with queue pending
TTL resumes after queue empty
delete rejects new enqueue
failed delete retains queue journal
successful delete removes journal
archive semantics parity
cancel semantics parity
steer remains unsupported
interrupt remains unsupported
auto resolves according to locked product semantics
```

PR6 Gate：

```text
focused PR6 suites green
npm test
npx tsc --noEmit
bun run build
lint-acpx-imports
terminal-windows
terminal-rmux-windows
existing CLI compat unchanged
```

### Suggested PR6 commits

```text
test(runtime): lock queue and cancel parity semantics
feat(runtime): add durable runtime queue journal
feat(runtime): drain queued messages through shared turn lifecycle
feat(runtime): recover durable queue after worker and bridge restart
test(runtime): cover queue TTL delete crash and recovery boundaries
```

---

# PR7 — Runtime live permission parity

## 13. 目标

实现：

```text
xacpx-owned permission policy parser
xacpx-owned permission resolver
per-worker permanent onPermissionRequest callback
live permission generation
permission.update real mutation
CLI/Runtime decision parity
fail-closed explicit decisions
```

不依赖 upstream Runtime private live-update。

PR7 第一阶段仍禁止 Runtime eligibility：

```text
nonInteractivePermissions=fail
policy contains escalate
```

直到对应语义可以精确表达。

spec 对此要求是明确的。

---

## 14. 当前代码必须替换的临时实现

当前 `runtime-adapter.ts` 在构造 `AcpRuntime` 时直接传：

```text
permissionMode
nonInteractivePermissions
permissionPolicy
```



当前 worker 的：

```text
permission.update
```

实际上只是：

```text
收到 generation
→ ACK accepted:true
```

并没有更新真实 permission state。

当前 RuntimeEngine 更新策略则通过：

```text
prepare
→ terminate all idle Runtime workers
→ commit new config
→ next spawn uses new policy
```



PR7 要把这套 rotation-based 临时方案替换成真正 live snapshot。

---

## 15. 新增 permission policy parser

新增：

```text
src/bridge/engine/runtime/runtime-permission-policy.ts
```

只实现 spec 允许的公开 shape：

```ts
interface XacpxPermissionPolicy {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defaultAction?: "approve" | "deny" | "escalate";
}
```

要求：

```text
JSON object only
rules 必须 non-empty string[]
unknown shape → fail closed
invalid defaultAction → fail closed
path unreadable → fail closed
inline invalid JSON → fail closed
```

不得：

```text
policy parse failed
→ fallback approve-all
```

不得 import upstream private parser。

---

## 16. 必须先做 CLI differential policy tests

对 pinned `acpx 0.13.1` 做 public/CLI black-box differential cases：

```text
autoDeny beats autoApprove
autoApprove
escalate
default approve
default deny
default escalate
no matching policy + approve-all
no matching policy + deny-all
approve-reads + read
approve-reads + search
approve-reads + write
inline JSON
policy file
invalid file
unknown field/shape
```

目标不是复制 upstream 源码，而是确认：

```text
same input permission request
→ current CLI behavior
→ Runtime resolver behavior
```

等价。

---

## 17. 新增 permission resolver

新增：

```text
src/bridge/engine/runtime/runtime-permission-resolver.ts
```

输入：

```ts
RuntimePermissionConfig
AcpPermissionRequest public shape
AbortSignal
```

其中：

```ts
interface RuntimePermissionConfig {
  generation: number;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  permissionPolicy?: XacpxPermissionPolicy;
}
```

决策顺序按 spec：

```text
autoDeny
→ deny

autoApprove
→ approve

escalate
→ interactive/reject according to eligibility phase

defaultAction
→ action

else permissionMode

approve-all → approve

deny-all → deny

approve-reads:
    inferredKind read/search → approve
    other → interactive if supported
             otherwise nonInteractivePermissions
```

只读 public：

```text
req.raw
req.inferredKind
```

不得探测 Runtime private properties。

---

## 18. callback 必须永远 explicit

`createXacpxRuntimeAdapter()` 增加 public Runtime callback seam。

实际 API 参数名/return shape 必须先对 `acpx/runtime` 0.13.1 做 contract probe，禁止猜私有 shape。

逻辑：

```ts
onPermissionRequest = async (req, ctx) => {
  try {
    return await resolver.resolve(currentSnapshot(), req, ctx.signal);
  } catch (error) {
    safeLog(error);
    return { outcome: "reject_once" };
  }
};
```

所有异常：

```text
policy parser error
aborted signal
unexpected resolver error
malformed request
future interactive timeout
bridge disconnect
```

都必须返回 explicit deny/cancel。

绝不能：

```text
return undefined
```

因为那会重新进入 upstream fallback。

---

## 19. Worker permission state

`WorkerState` 增加：

```ts
permissionSnapshot: RuntimePermissionConfig;
permissionGeneration: number;
```

callback closure 永远读取：

```text
state.permissionSnapshot
```

而不是 Runtime 创建时闭包捕获的旧 config。

`permission.update` 变成真实 mutation：

```text
validate payload
↓
if generation <= current
    reject stale / accepted:false
↓
parse already-normalized snapshot shape
↓
atomically replace snapshot
↓
permissionGeneration = generation
↓
ACK exact generation
```

不得部分修改 object。

---

## 20. permission 变成 mutable 后，修正 Worker launch identity

当前 `sameEnsureParams()` 把：

```text
permissionMode
nonInteractivePermissions
permissionPolicy
```

算进 immutable Runtime identity。

PR7 live-update 成立后，这些字段不能再导致：

```text
policy changed
→ AcpRuntime replacement required
```

agent 必须重新定义：

```text
immutable launch identity
vs
mutable permission snapshot
```

permission fields 从 immutable identity 中移出。

但只有在 permanent callback 已成为唯一 xacpx permission authority 后才能做这一步。

---

## 21. RuntimeEngine updatePermissionPolicy transaction

不要继续通过“杀掉全部 worker”实现 live update。

但仍需保留一个 global policy transition lock，以避免：

```text
permission request
和
snapshot transition
```

跨越边界。

建议新流程：

### prepare

```text
acquire global policy lock
↓
parse + validate candidate policy
↓
ensure no active permission-sensitive business operation crosses transition
↓
do NOT terminate healthy idle workers
↓
retain old snapshot + candidate snapshot
```

当前 EngineRouter 已经具有：

```text
Runtime prepare
→ CLI update
→ Runtime commit
→ rollback on CLI failure
```

的 transaction seam。

继续利用这个 seam。

### CLI update failure

```text
Runtime snapshot remains old
release lock
return failure
```

### Runtime commit

```text
generation++
set host canonical snapshot = candidate
send permission.update(generation,candidate) to all live workers
```

transition lock 未释放前不得接新 business RPC。

---

## 22. 防止“一半 worker 新、一半旧”

这是 PR7 的核心 Gate。

如果所有 worker 都 ACK：

```text
release transition lock
success
```

如果某 worker：

```text
crash
timeout
reject update
generation mismatch
```

不得：

```text
成功返回
while one worker still uses old policy
```

推荐 fail-closed compensation：

```text
workers that ACK new snapshot → keep
workers that failed to prove update → terminate safely while transition lock held
```

因为当前 transition 阶段必须无 active turn，所以可以把无法证明已经更新的 worker 作为 stale worker 回收。

下一次 spawn：

```text
uses canonical NEW snapshot
```

这样 CLI 已 commit 新 policy 后，不需要尝试把整个系统 rollback 到旧 policy。

如果 stale worker teardown 也无法验证：

```text
policy update RPC must fail
Runtime transition remains fail-closed for that ownership
```

绝不能让这个 worker重新承接 permission-sensitive work。

---

## 23. generation tests

至少：

```text
generation 5 accepted
generation 5 duplicate rejected
generation 4 rejected
generation 6 accepted

worker A accepts / worker B fails
→ B is safely terminated
→ no live worker remains on old generation

new worker after update
→ bootstraps directly with current generation
```

日志只能包含：

```text
logical session
worker pid
generation
mode
decision
source
```

禁止 raw secret/credential/tool payload。

---

## 24. eligibility 限制

PR7 不要为了“Runtime 覆盖更多”牺牲 semantics。

继续 fail closed：

```text
nonInteractivePermissions == fail
→ Runtime ineligible

policy contains escalate
→ Runtime ineligible
```

直到能真实证明 parity。

即使当前 `engine:auto` 仍然只走 CLI，也必须把 eligibility/test groundwork 写对，避免后面 PR10 打开后暴露错误策略。

---

## 25. PR7 测试 Gate

新增建议：

```text
runtime-permission-policy.test.ts
runtime-permission-resolver.test.ts
runtime-permission-live-update.test.ts
runtime-permission-differential.test.ts
```

必须覆盖：

```text
policy parsing
inline/file parity
all resolver precedence
explicit fallback denial
callback exception → reject_once
abort → reject/cancel
generation ordering
live worker receives new snapshot
new worker receives current snapshot
busy/in-flight transition fails closed
CLI update failure leaves Runtime old
partial Runtime update leaves no stale-policy live worker
no worker rotation on successful ordinary policy update
unsupported fail semantics remains ineligible
escalate remains ineligible
G13 public Runtime imports only
```

### Suggested PR7 commits

```text
test(runtime): characterize CLI permission policy parity
feat(runtime): add xacpx-owned permission policy parser and resolver
feat(runtime): make worker permission callback snapshot-driven
feat(runtime): apply live permission generations without worker rotation
test(runtime): cover atomic fanout stale generations and fail-closed decisions
```

---

# PR8 — MCP coordinator Runtime parity

## 26. 目标

Runtime-bound coordinator/worker session 获得与现有 CLI path 等价的 xacpx orchestration MCP tools。

必须完成：

```text
delegate request E2E
scheduled tool E2E
coordinator wake
no double MCP registration
worker cooling/restart keeps MCP behavior
MCP launch identity rotation
```

spec 明确规定：

```text
mcpCoordinatorSession
mcpSourceHandle
```

属于 Worker launch identity，变化时必须 safe cool + recreate，不能对 active Runtime 热改。

---

## 27. 当前已有 seam

目前 `EngineSessionInput` 已经有：

```ts
mcpCoordinatorSession?: string;
mcpSourceHandle?: string;
```



BridgeServer 的：

```text
ensureSession
prompt
```

也已经把这两个字段传入 engine。

所以 PR8 不应该重新设计 daemon-facing bridge protocol。

真正缺失的是：

```text
RuntimeEngine
→ buildEnsureParams
→ RuntimeWorker
→ runtime-adapter
→ acpx/runtime mcpServers
```

这一段。

---

## 28. 第一步：追踪现有 CLI MCP 真实路径

在改 Runtime 前，agent 必须完整追踪当前 CLI coordinator：

```text
logical coordinator/worker state
→ mcpCoordinatorSession
→ mcpSourceHandle
→ queue-owner payload
→ MCP server config / command
→ acpx session
→ tool call
→ daemon/orchestration
```

目标：

**复用现有 xacpx MCP server/provider，实现 Runtime adapter，不重新造另一套 coordinator MCP server。**

先增加 characterization tests，证明现有 CLI：

```text
delegate request
scheduled task/tool
coordinator wake
source routing
```

具体发出了什么 MCP config 和 routing identity。

---

## 29. 新增 Runtime MCP config adapter

建议新增：

```text
src/bridge/engine/runtime/runtime-mcp.ts
```

职责严格限制为：

```text
mcpCoordinatorSession
+
mcpSourceHandle
+
existing xacpx MCP server factory/config
→ public acpx Runtime mcpServers option
```

不要：

```text
在 runtime-engine.ts 直接拼 command/env
复制 orchestration routing 逻辑
复制 MCP server implementation
```

Runtime 和 CLI 应共享同一 xacpx orchestration backend。

---

## 30. 先 probe pinned public Runtime contract

spec 只说明：

```text
Runtime public options supports mcpServers
```

具体 `acpx 0.13.1` 的：

```text
字段位置
server config shape
session option/runtime option
stdio/http semantics
```

必须通过 `acpx/runtime` public contract/type/real smoke 确认。

不得从：

```text
acpx/src
acpx/dist private implementation
```

推导。

contract probe 成功后再扩 `runtime-adapter.ts`。

---

## 31. MCP config 必须进入 immutable launch identity

`RuntimeWorkerEnsureParams` 增加 normalized MCP identity/config。

至少 identity：

```ts
{
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
}
```

`sameEnsureParams()` 必须比较：

```text
coordinator session
source handle
```

因为：

```text
same logical session
but MCP source changed
```

不能继续复用旧 AcpRuntime。

---

## 32. RuntimeEngine 必须主动处理 stale worker

不能仅依靠 Worker：

```text
ensure params differ
→ throw RUNTIME_INIT_FAILED
```

spec 要求的是：

```text
mark stale
→ safe boundary cool
→ recreate with new MCP launch identity
```

因此 RuntimeEngine 在 acquire/use worker 前要比较：

```text
requested launch identity
vs
existing worker launch identity
```

### idle worker

```text
identity differs
→ graceful shutdown
→ verify teardown
→ release old worker
→ spawn fresh worker with new MCP config
→ continue operation
```

### active turn

不得：

```text
kill active worker
```

推荐：

```text
mark staleAfterTurn
→ current turn settles
→ cool old worker
```

对于触发 identity change 的 concurrent request：

```text
wait safe recreation
```

或者：

```text
return explicit teardown/stale retryable error
```

二选一必须测试锁定，不允许让请求在旧 MCP identity 上执行。

---

## 33. MCP absence 也是 identity

以下变化都算 launch identity change：

```text
none → coordinator
coordinator → none
coordinator A → coordinator B
source A → source B
```

不能只判断：

```text
if mcpCoordinatorSession exists
```

而遗漏 removal/change。

---

## 34. Runtime adapter

`createXacpxRuntimeAdapter()` 增加最窄：

```text
mcpServers
```

support。

不要把整个 xacpx config 传入 upstream Runtime。

仍保持白名单 session options：

```text
model
必要的 MCP public config
```

不要传：

```text
process.env snapshot
unknown session config object
orchestration internal objects
```

---

## 35. worker cooling / crash recovery

MCP identity 是 durable logical-session launch context，而不是某一 worker PID 的属性。

必须证明：

```text
worker warm with MCP
→ ordinary TTL cool
→ next worker same MCP identity
→ tools still available

worker crash
→ replacement worker
→ same MCP config rebuilt
→ no duplicate MCP registration

coordinator/source changes
→ old worker never继续 serving old MCP routing
```

---

## 36. no double registration

重点检查：

```text
ensure
prompt
ensure
prompt
```

同一 Worker 内不得每次 operation 都追加一个 MCP server。

正确生命周期：

```text
one Runtime Worker generation
→ one AcpRuntime construction
→ one MCP launch config
```

MCP config 只属于 Runtime construction identity。

---

## 37. PR8 integration tests

最低真实 integration：

### Coordinator delegate request

```text
Runtime coordinator session
→ xacpx MCP delegate tool
→ daemon orchestration request
→ worker target receives task
→ result routes back correctly
```

### Scheduled tool

```text
Runtime session
→ scheduling MCP tool
→ scheduled task created
→ expected wake/delivery path executes
```

### Coordinator wake

```text
worker result/state change
→ coordinator wake
→ Runtime coordinator sees expected follow-up
```

### Lifecycle

```text
same MCP identity → same worker reuse
changed source → idle worker rotated
changed coordinator → idle worker rotated
identity changes during active turn → active turn not killed
after settle → old worker retired
new worker has new config
TTL cool/restart preserves tools
crash/restart preserves tools
no coordinator fields → no xacpx MCP injected
no duplicate MCP server after repeated ensure/prompt
```

这些是 spec PR8 的正式 Gate，不得只用 mocked `mcpServers` object unit test 代替。

---

## 38. PR8 Windows Gate

MCP 引入不能破坏 PR3–PR5 已完成的 worker ownership。

至少重新跑：

```text
terminal-windows
Windows handle-stable process identity and tree termination
host crash EOF convergence
worker fence tests
```

尤其 Windows MCP server 如果产生额外 child process，必须确认它确实属于：

```text
Runtime worker descendant ownership tree
```

并在：

```text
TTL
freeWarm
shutdown
host crash
```

时一起收敛。

不得增加裸 PID kill 特例。

---

## 39. PR8 Suggested commits

```text
test(orchestration): characterize CLI coordinator MCP routing
feat(runtime): build Runtime MCP config from xacpx coordinator identity
feat(runtime): bind MCP config to worker launch identity
feat(runtime): rotate stale MCP workers only at safe boundaries
test(runtime): cover coordinator delegate schedule wake and worker restart
test(windows): prove Runtime MCP descendants converge with worker ownership
```

---

# 40. 每个 wave 的 Stop Rule

agent 必须遵守：

```text
PR6 red
→ 不进入 PR7

PR7 red
→ 不进入 PR8
```

不能：

```text
先把 PR6/7/8 全写完
→ 最后一起修测试
```

每一个 wave 完成时都要输出：

```text
1. 实际改动文件
2. 实现的不变量
3. 明确 deferred 的语义
4. focused test 结果
5. tsc
6. build
7. lint-acpx-imports
8. full suite
9. Windows CI
10. 当前 head SHA
```

---

# 41. 最终 PR8 后仍不得做的事

即使 PR6–PR8 全部完成：

```text
不要直接 engine:auto → runtime
不要直接 production wire RuntimeEngine
```

先重新审查此前 deferred activation blockers：

```text
shared physical transport ownership
fenceDir safe default
saveNow crash-durable binding
```

然后重新跑 G1–G13。

只有这些 closure 完成后，才进入后续 activation/default-switch work。

---

# 42. PR6–PR8 完成定义

PR6 完成：

```text
durable queue
+ no acked message loss
+ restart recovery
+ queue/TTL/delete/cancel lifecycle parity
```

PR7 完成：

```text
public Runtime permission callback
+ xacpx policy parser/resolver
+ explicit fail-closed decisions
+ live generation update
+ no mixed-policy live workers
```

PR8 完成：

```text
Runtime coordinator MCP parity
+ launch identity fencing
+ safe stale-worker recreation
+ delegate/schedule/wake E2E
+ lifecycle/crash/Windows convergence
```

PR8 完成后才进行一次新的完整 architecture review，再决定是否进入 Runtime activation 工作。

---

## Implementation principle

整个 PR6–PR8 最重要的规则仍然只有三个：

```text
ownership must be provable
ack must follow durability
uncertainty must fail closed
```

不要为了尽快让 Runtime 能跑而削弱其中任何一个。