# xacpx × acpx Runtime 嵌入式集成落地方案

> 日期：2026-08-26  
> 状态：Implementation Plan / 可直接交给实现 Agent  
> 基础评估：《acpx 嵌入式集成评估报告（修订版）》  
> 目标仓库：`gadzan/xacpx`  
> 上游依赖：`openclaw/acpx`  
> **硬约束：不得修改、fork、patch 或依赖 acpx 私有 API；只能消费已发布的 `acpx/runtime` public contract。**

---

## 1. 实施结论

本轮采用 **xacpx-only B+**：

> **Bridge Host + 双 Engine + session 级 engine affinity + per-session Runtime Worker**

最终拓扑：

```text
xacpx daemon
    │
    │ existing acpx-bridge stdin/stdout JSON RPC
    ▼
Bridge Host
    │
    ├── EngineRouter
    │
    ├── CliEngine
    │     └── existing acpx CLI path
    │
    └── RuntimeEngine
          │
          ├── RuntimeWorker(session A)
          │      ├── import "acpx/runtime"
          │      └── ACP adapter process
          │
          ├── RuntimeWorker(session B)
          │      ├── import "acpx/runtime"
          │      └── ACP adapter process
          │
          └── RuntimeWorker(session C)
                 ├── import "acpx/runtime"
                 └── ACP adapter process
```

### 1.1 为什么必须是 per-session Runtime Worker

acpx Runtime public contract 当前没有：

```text
release(session)
dispose(runtime)
live permission update
hard delete
```

但 xacpx 不修改上游。

因此不要在 Bridge Host 内创建一个全局 `AcpRuntime` 去长期持有所有 session。

改为：

```text
一个 Runtime-bound logical session
        =
一个 xacpx-owned Runtime Worker process
        =
一个该 Worker 内的 AcpRuntime instance
```

Worker process 本身就是 xacpx 的 lifecycle primitive。

因此：

```text
freeWarmProcess
→ kill Runtime Worker
→ logical session record 不 close
```

```text
queueOwnerTtlSeconds expires
→ kill Runtime Worker
```

```text
isSessionWarm
→ Runtime Worker 是否存活
```

```text
bridge shutdown
→ kill all Runtime Workers
```

不需要上游 `release()` / `dispose()`。

---

# 2. 非目标

本轮明确不做：

1. 不修改 `openclaw/acpx`。
2. 不 import `acpx/dist/...`、`acpx/src/...` 或 Runtime manager/client 私有实现。
3. 不 monkey-patch `AcpRuntime`。
4. 不让同一 session 按方法混用 RuntimeEngine 与 CliEngine。
5. 不删除 `acpx-cli` transport。
6. 不删除现有 bridge 协议边界。
7. 不做 per-session 完整 Claude environment isolation。
8. 不在第一阶段删除旧 CLI queue-owner 代码。
9. 不在 Runtime 主链稳定前一次性接入 elicitation/UI/usage dashboard。
10. 不将 Runtime patch-level API 直接散布到 xacpx 多个模块。

---

# 3. 首要架构规则

## R1 — Engine affinity 是 session 属性，不是 request 属性

禁止：

```text
prompt       -> RuntimeEngine
queue        -> CliEngine
delete       -> CliEngine
setMode      -> RuntimeEngine
```

正确：

```text
session A -> RuntimeEngine
session B -> CliEngine
```

session A 的所有 transport 操作必须由 RuntimeEngine 承接。

如果 RuntimeEngine 当前不支持某操作：

```text
fail closed
```

或者：

```text
显式迁移整个 session
```

绝不能临时按 method fallback 到 CliEngine。

## R2 — fallback 只能发生在三个边界

允许：

### 新建 session 前

```text
engine:auto
→ runtime eligibility probe
→ choose runtime / cli
→ persist binding
```

### legacy session 首次绑定时

```text
legacy session has no engine
→ default cli
```

### 显式 migration

```text
session A on CLI
→ verify idle
→ close/cool old owner
→ persist migration intent
→ ensure using Runtime
→ commit engine=runtime
```

不允许 request-time fallback。

## R3 — Engine binding 必须持久化

当前 logical session state 增加：

```ts
export type SessionTransportEngine = "cli" | "runtime";

export interface LogicalSession {
  ...
  transport_engine?: SessionTransportEngine;
}
```

`ResolvedSession` 同步增加：

```ts
transportEngine?: SessionTransportEngine;
```

### migration rule

所有已有 state 中没有 `transport_engine` 的 session：

```text
=> cli
```

这是 fail-safe migration。

不要在升级后自动把已有 CLI session 接管到 Runtime。

原因：

- 旧 session 可能仍有 CLI queue owner
- 旧 session 可能有 custom `transport.command`
- 旧 session 可能依赖 CLI-only permission semantics
- 自动切换容易产生 dual-owner race

新建 session 在 `engine:auto` 下才根据 eligibility 选择 Runtime。

---

# 4. 配置模型

保留：

```ts
transport.type: "acpx-cli" | "acpx-bridge"
```

在 `acpx-bridge` 下新增：

```ts
type BridgeEngineMode = "auto" | "runtime" | "cli";

interface TransportConfig {
  type: "acpx-cli" | "acpx-bridge";
  engine?: BridgeEngineMode;
  ...
}
```

默认迁移策略建议分两步：

### 开发期

```text
engine default = cli
```

Runtime 必须显式：

```json
{
  "transport": {
    "type": "acpx-bridge",
    "engine": "runtime"
  }
}
```

### G1-G13 全绿后

```text
engine default = auto
```

### `transport.command`

如果配置：

```text
transport.command != undefined
```

则：

```text
engine:auto → cli
engine:runtime → configuration error
```

不要忽略用户显式自备 acpx。

---

# 5. Runtime eligibility

实现：

```ts
interface RuntimeEligibility {
  eligible: boolean;
  reason?: RuntimeIneligibleReason;
}
```

建议第一版：

```ts
type RuntimeIneligibleReason =
  | "explicit-acpx-command"
  | "runtime-import-failed"
  | "runtime-probe-failed"
  | "unsupported-permission-mode"
  | "unsupported-permission-policy"
  | "unsupported-session-shape"
  | "record-compatibility-failed";
```

## 5.1 `engine:auto`

```text
if transport.command:
    CLI

if runtime bootstrap/probe failed:
    CLI

if session has persisted transport_engine:
    use persisted engine

if new session and eligible:
    Runtime

else:
    CLI
```

## 5.2 `engine:runtime`

严格模式：

```text
ineligible
→ throw diagnostic error
```

不能静默 fallback。

用于开发、CI 和定位 Runtime 缺口。

---

# 6. 建议代码目录

推荐新增：

```text
src/bridge/engine/
  bridge-engine.ts
  engine-router.ts
  session-engine-binding.ts

  cli/
    cli-engine.ts

  runtime/
    runtime-engine.ts
    runtime-worker-manager.ts
    runtime-worker-client.ts
    runtime-worker-protocol.ts
    runtime-worker-main.ts
    runtime-adapter.ts
    runtime-session-state.ts
    runtime-queue.ts
    runtime-permission-resolver.ts
    runtime-permission-policy.ts
    runtime-event-mapper.ts
    runtime-error-mapper.ts
```

现有：

```text
src/bridge/bridge-runtime.ts
```

最终变成 facade / router。

不要继续把 Runtime 逻辑塞进这个已经很大的文件。

---

# 7. BridgeEngine 内部接口

建议定义一个和当前 BridgeRuntime method shape 接近的接口，使 `BridgeServer` 几乎不变。

```ts
export interface BridgeEngine {
  readonly kind: "cli" | "runtime";

  ensureSession(input: BridgeSessionInput, emit?: BridgeEventSink): Promise<Record<string, never>>;
  hasSession(input: BridgeSessionInput): Promise<{ exists: boolean }>;
  tailSessionHistory(input: BridgeSessionInput & { lines: number }): Promise<{ text: string }>;
  listAgentSessions?(input: AgentSessionListInput): Promise<AgentSessionListResult | undefined>;
  resumeAgentSession(input: ResumeAgentSessionInput): Promise<Record<string, never>>;
  prompt(input: PromptInput, emit: BridgePromptEventSink): Promise<{ text: string }>;
  injectMessage(input: InjectMessageInput): Promise<SessionMessageReceipt>;
  setMode(...args: unknown[]): Promise<Record<string, never>>;
  setModel(...args: unknown[]): Promise<Record<string, never>>;
  getSessionModel(...args: unknown[]): Promise<{ current?: string; available: string[] }>;
  setSessionEffort(...args: unknown[]): Promise<Record<string, never>>;
  getSessionEffort(...args: unknown[]): Promise<SessionEffortState>;
  cancel(...args: unknown[]): Promise<{ cancelled: boolean; message: string }>;
  removeSession(...args: unknown[]): Promise<Record<string, never>>;
  deleteSession(...args: unknown[]): Promise<Record<string, never>>;
  freeWarmProcess(...args: unknown[]): Promise<Record<string, never>>;
  isSessionWarm(...args: unknown[]): Promise<{ warm: boolean }>;
  getAgentSessionId(...args: unknown[]): Promise<{ agentSessionId?: string }>;
  updatePermissionPolicy(policy: PermissionPolicyInput): Promise<Record<string, never>>;
  shutdown(): Promise<Record<string, never>>;
}
```

### 注意

不要为了追求接口纯洁一次性把全部 BridgeRuntime type 重写。

第一阶段可以先：

```text
BridgeRuntime
  └─ EngineRouter
       ├─ CliEngine adapter around old BridgeRuntime implementation
       └─ RuntimeEngine
```

然后再逐渐拆旧逻辑。

---

# 8. CliEngine 落地原则

第一步是 **纯重构，零行为变化**。

将现有 `BridgeRuntime` 里的 CLI 实现迁入：

```text
src/bridge/engine/cli/cli-engine.ts
```

但：

- command builder 不改
- queue owner 不改
- Windows orphan/launcher 逻辑不改
- environment 逻辑不改
- hard delete 不改
- error strings 尽量不改
- bridge protocol 不改

验收：

```text
existing unit tests
existing compat tests
Windows tests
E2E
```

全部无差异通过。

只有完成这一步以后，才加入 RuntimeEngine。

---

# 9. Runtime Worker 设计

## 9.1 Worker 粒度

每个 Runtime session 一个 Worker。

Worker key 必须使用稳定 transport identity，不要只用 display alias。

建议：

```ts
type RuntimeWorkerKey = {
  logicalSessionId: string;
  transportSession: string;
};
```

首选：

```text
logical_session_id
```

因为 alias 可 rename。

如果 bridge params 当前没有 `logicalSessionId`，需要从 daemon → `AcpxBridgeTransport.toParams()` → bridge protocol 增加这个字段。

不要用：

```text
displayName
alias only
```

作为 worker ownership identity。

## 9.2 Worker process

新增 build entry：

```text
src/bridge/engine/runtime/runtime-worker-main.ts
```

`package.json` build 增加：

```text
./src/bridge/engine/runtime/runtime-worker-main.ts
```

目标产物例如：

```text
dist/runtime-worker-main.js
```

Worker 只能使用：

```ts
import {
  createAcpRuntime,
  createRuntimeStore,
  createAgentRegistry,
} from "acpx/runtime";
```

禁止：

```ts
import ... from "acpx/dist/..."
import ... from "acpx/src/..."
```

---

# 10. Runtime Worker protocol

不要复用 daemon ↔ bridge 的整个协议。

Worker protocol 应很小，只服务单 session。

建议 JSON Lines：

```ts
type RuntimeWorkerRequest =
  | { id: string; method: "ensure"; params: unknown }
  | { id: string; method: "prompt"; params: unknown }
  | { id: string; method: "setMode"; params: unknown }
  | { id: string; method: "setConfigOption"; params: unknown }
  | { id: string; method: "status"; params: unknown }
  | { id: string; method: "cancel"; params: unknown }
  | { id: string; method: "close"; params: unknown }
  | { id: string; method: "permission.update"; params: unknown }
  | { id: string; method: "shutdown"; params: unknown };
```

事件：

```ts
type RuntimeWorkerEvent =
  | { id: string; event: "text_delta"; payload: unknown }
  | { id: string; event: "thought"; payload: unknown }
  | { id: string; event: "tool"; payload: unknown }
  | { id: string; event: "plan"; payload: unknown }
  | { id: string; event: "usage"; payload: unknown }
  | { id: string; event: "commands"; payload: unknown }
  | { id: string; event: "permission.request"; payload: unknown };
```

Bridge Host 负责：

```text
worker event
→ existing bridge prompt.* event
→ daemon
```

这样 daemon-facing 21-method bridge contract 最大限度保持不变。

---

# 11. Runtime public adapter

新增唯一允许 import `acpx/runtime` 的模块：

```text
runtime-adapter.ts
```

例如：

```ts
export interface XacpxRuntimeAdapter {
  ensure(...args: unknown[]): Promise<RuntimeSessionHandle>;
  startTurn(...args: unknown[]): RuntimeTurnHandle;
  setMode(...args: unknown[]): Promise<void>;
  setConfig(...args: unknown[]): Promise<void>;
  getStatus(...args: unknown[]): Promise<RuntimeStatus>;
  cancel(...args: unknown[]): Promise<void>;
  close(...args: unknown[]): Promise<void>;
}
```

`runtime-worker-main.ts` 不直接把 acpx types 泄漏到其余 xacpx。

### 目的

acpx Runtime patch 版本可能发生 public contract 变化。

未来升级只允许主要修改：

```text
runtime-adapter.ts
runtime-adapter contract tests
```

不要让 `AcpRuntimeTurn` / `AcpRuntimeEvent` 类型渗透整个仓库。

---

# 12. Session record / store

Runtime Worker 使用 acpx public：

```ts
createRuntimeStore({ stateDir })
```

必须和 xacpx 当前 CLI 使用的 acpx stateDir 指向同一个合法 session store。

Phase 0 必须验证：

```text
CLI create
→ Runtime read/resume

Runtime create
→ CLI sessions show/list/status
```

任何一边失败：

```text
Runtime default switch blocked
```

---

# 13. Runtime handle 生命周期

Worker 内维护：

```ts
interface WorkerRuntimeState {
  runtime: XacpxRuntimeAdapter;
  handle?: RuntimeSessionHandle;
  activeTurn?: ActiveRuntimeTurn;
  lastActivityAt: number;
  permissionSnapshot: RuntimePermissionConfig;
  permissionGeneration: number;
  shuttingDown: boolean;
}
```

`ensure`：

```text
worker starts
→ create Runtime
→ ensureSession(sessionKey ...)
→ cache handle
→ ready
```

后续 control/prompt 使用同一个 handle。

Worker 被 kill 后：

```text
handle lost
```

但 acpx session record 保留。

下一次 Worker：

```text
ensure same persistent sessionKey
→ reconnect / resume from record
```

---

# 14. freeWarmProcess

RuntimeEngine 实现：

```ts
async freeWarmProcess(session) {
  const worker = workers.get(session.logicalSessionId);
  if (!worker) return;
  await worker.requestCool();
}
```

`requestCool()` 规则：

### idle worker

```text
no active turn
→ terminate worker process tree
```

### active worker

`freeWarmProcess` 不允许在 active turn 中直接杀 agent。

建议：

```text
mark coolAfterIdle = true
→ current turn settles
→ terminate
```

archive 场景必须以现有 archive 行为为契约，不能自行猜测。

---

# 15. isSessionWarm

Runtime 模式定义：

```text
Worker process alive
AND worker bootstrap complete
AND not shuttingDown
```

返回 true。

不要把：

```text
session record exists
```

当成 warm。

不要把：

```text
Worker process exists 但 Runtime bootstrap failed
```

当成 warm。

`RuntimeWorkerManager` 维护状态：

```ts
type WorkerLifecycle =
  | "starting"
  | "ready"
  | "busy"
  | "idle"
  | "cooling"
  | "stopped"
  | "failed";
```

warm：

```text
ready | busy | idle
```

---

# 16. TTL

RuntimeEngine 自己实现 `queueOwnerTtlSeconds`。

Worker 每次 turn result settled 后刷新 idle clock。

当：

```text
activeTurn == undefined
pendingQueue.length == 0
```

开始 TTL。

TTL 到期：

```text
send graceful worker shutdown
short grace
→ terminate process tree
```

`queueOwnerTtlSeconds = 0`：

```text
disable idle reap
```

但：

```text
daemon/bridge shutdown
freeWarmProcess
archive
delete
```

仍然必须能回收。

---

# 17. Worker 终止为什么可以代替 release()

关键要求：

Worker cooling 时：

```text
DO NOT call runtime.close()
```

因为 `close()` 会改变 logical record closed state。

正常 cool：

```text
turn.result settled
→ worker exits
→ process/stdio closes
→ OS child process tree cleaned
→ acpx persistent record remains open
```

下一次：

```text
new Worker
→ ensure existing persistent session
```

这就是 xacpx 自己实现的 release。

### 重要测试

必须确认 acpx Runtime 在 `turn.result` resolve 之前已完成必要 record checkpoint。

Worker 只能在：

```text
result settled
```

之后执行 idle cooling。

不能：

```text
last text_delta received
→ immediately kill
```

否则可能截断最终 persistence。

---

# 18. Bridge shutdown / Runtime dispose 等价语义

不需要 acpx `dispose()`。

BridgeRuntime/EngineRouter shutdown：

```text
stop accepting new bridge requests
        ↓
CliEngine existing shutdown
        +
RuntimeWorkerManager.shutdownAll()
        ↓
for each worker:
    graceful shutdown request
    wait bounded grace
    terminateProcessTree()
        ↓
await all process exits
```

然后 Bridge Host 才退出。

Windows 必须沿用 xacpx 现有 process-tree / owner identity 安全策略，不增加裸 `process.kill(pid)` 作为主实现。

---

# 19. hard delete

Runtime-bound session：

```text
deleteSession
```

执行顺序建议：

```text
1. acquire session bridge lane
2. mark session deleting
3. reject new queue.enqueue
4. resolve acpxRecordId
5. if worker alive:
       cancel active turn if required
       runtime.close({ discardPersistentState: true })
       terminate worker process tree
6. verify worker/adapter process gone
7. xacpx deleteAcpxSessionFiles({ acpxRecordId })
8. clear worker registry
9. return success
```

### 幂等

以下全部成功：

```text
record already gone
worker already gone
both gone
```

### Windows

必须测试：

```text
close
→ child exit
→ file handle release
→ unlink
```

必要时采用有界 retry/backoff。

不能：

```text
unlink failure
→ silently success
```

---

# 20. removeSession

与 hard delete 分离。

Runtime：

```text
removeSession
→ runtime.close()
→ terminate Worker
→ record remains
```

之后是否可 resume 必须与当前 xacpx/acpx CLI `sessions close` 语义做差分测试。

如果目标 Runtime 版本的 `close()` 与现有 removeSession 产品语义不等价，则：

```text
RuntimeEngine.removeSession = unsupported
```

并且 Runtime session 的该操作显式失败。

不能调用 CliEngine 做 method fallback。

Runtime 成为默认前必须解决或正式产品化这一差异。

---

# 21. Runtime queue

queue 完全由 xacpx 实现。

不使用：

```text
acpx CLI --no-wait
```

不把：

```text
steer
```

当 queue。

推荐 durable queue owner 位于 Bridge Host / RuntimeEngine，而不是 Worker。

```ts
interface RuntimePendingMessage {
  messageId: string;
  text: string;
  acceptedAt: string;
  mode: "queue" | "auto";
}
```

RuntimeEngine session state：

```ts
interface RuntimeEngineSessionState {
  activeTurn?: ActiveTurnRef;
  pendingQueue: RuntimePendingMessage[];
  worker?: RuntimeWorkerRef;
}
```

## enqueue

```text
if shuttingDown/deleting/archived:
    reject

if duplicate messageId:
    return previous receipt / idempotent acknowledgement

if queue at max:
    throw existing MessageInjectionError overflow equivalent

append FIFO
persist durable journal
ack
```

## drain

```text
while no active turn and pendingQueue non-empty:
    ensure worker
    shift first
    startTurn(mode="prompt")
    await result
    persist queue head removal
    continue
```

---

# 22. Queue durability

Runtime Worker crash 时，如果 pending queue 只在内存：

```text
pending messages lost
```

这不能默默接受。

推荐 xacpx 自己做最小 durable journal：

```text
~/.xacpx/runtime/runtime-queue/<logical-session-id>.json
```

格式：

```ts
interface RuntimeQueueRecord {
  schema: "xacpx.runtime-queue.v1";
  logicalSessionId: string;
  items: Array<{
    messageId: string;
    text: string;
    acceptedAt: string;
  }>;
}
```

写入：

```text
atomic write
```

ack 规则：

```text
persist succeeded
→ queue accepted receipt
```

完成 turn：

```text
remove head
→ persist
```

Worker/Bridge 重启：

```text
reload queue
→ drain
```

这样才能保证：

```text
crash after ack
→ message not silently lost
```

---

# 23. Queue 与 freeWarm/TTL 的关系

只有：

```text
active turn absent
pending queue empty
```

时才允许普通 TTL cooling。

如果 queue 非空：

```text
Worker must exist / be spawned
→ drain
```

archive/delete：

```text
explicit lifecycle transition
```

可以拒绝/清理 pending items，但必须按现有产品语义测试并返回明确结果。

---

# 24. cancel

Runtime-bound session：

### active turn

```text
runtime turn.cancel()
```

### pending queue

当前 `SessionTransport.cancel()` 的产品语义要与 CLI 做差分测试。

不要假设 cancel 自动清全部 queue。

建议 Runtime queue API 内部分开：

```text
cancelActiveTurn()
cancelPendingMessage(messageId)
```

外层 `cancel()` 再按现有语义组合。

---

# 25. steer

第一版不要把 steer 接进现有 `injectMessage`。

支持矩阵：

```text
queue → implemented
steer → disabled / experimental
```

只有真实测试：

```text
active Runtime turn
→ Runtime steer
→ same-turn behavior observed
```

通过后再开放。

---

# 26. Permission：不改 acpx 的实现方案

acpx Runtime public API 提供：

```ts
onPermissionRequest(req, ctx)
```

RuntimeWorker 创建 Runtime 时注册一个**永久 callback closure**。

callback 读取 xacpx 自己最新的：

```ts
interface RuntimePermissionConfig {
  generation: number;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  permissionPolicy?: XacpxPermissionPolicy;
}
```

不会依赖 Runtime 私有 live-update API。

---

# 27. Permission policy parser

xacpx 当前 `transport.permissionPolicy` 是 acpx permission policy spec/path。

xacpx 新增自己的兼容 parser：

```text
runtime-permission-policy.ts
```

只实现现有 CLI 语义需要的公开字段：

```ts
interface XacpxPermissionPolicy {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defaultAction?: "approve" | "deny" | "escalate";
}
```

规则：

- JSON object only
- rule 必须是非空 string[]
- `defaultAction` 只允许 `approve | deny | escalate`
- unknown shape fail closed
- policy load failure 不得回退 approve-all
- 路径/inline JSON 解析与目标 acpx CLI 做差分测试

不要 import `acpx/src/permission-policy.ts`。

---

# 28. Permission resolver

新增：

```text
runtime-permission-resolver.ts
```

目标：

> 对同一个 permission request，RuntimeEngine 与当前 acpx CLI 得到等价 allow/deny/escalate 结果。

建议实现与目标 acpx 行为一致的最小规则：

```text
policy autoDeny first
→ deny

policy autoApprove
→ approve

policy escalate
→ interactive escalation / reject when unavailable

policy defaultAction
→ action

else permissionMode:
  approve-all
    → approve

  deny-all
    → deny

  approve-reads
    inferredKind read/search
      → approve
    other
      → interactive if supported
      → otherwise nonInteractivePermissions
```

`AcpPermissionRequest` public type已经提供：

```text
raw
inferredKind
```

因此不要读取 Runtime 私有对象。

---

# 29. Permission callback 必须 explicit

核心安全规则：

```ts
onPermissionRequest = async (req, ctx) => {
  try {
    return await permissionResolver.resolve(
      currentPermissionConfig,
      req,
      ctx.signal,
    );
  } catch (error) {
    log(error);
    return { outcome: "reject_once" };
  }
};
```

Host-side failure：

```text
daemon RPC timeout
bridge disconnect
malformed response
unknown policy
policy file unreadable
aborted UI
```

必须：

```text
reject / cancel
```

不能：

```text
return undefined
```

否则 acpx 会继续走内部 fallback，可能和 xacpx 当前策略不同。

---

# 30. `nonInteractivePermissions = fail`

这一项必须单独做 parity。

`fail` 和：

```text
reject_once
```

不是完全相同语义。

因此第一阶段如果：

```text
nonInteractivePermissions == "fail"
```

则 Runtime eligibility：

```text
false
→ CliEngine
```

只有当 Runtime callback + result mapping 能精确表达现有失败语义后，才解除限制。

不要为了提高 Runtime 覆盖率牺牲语义。

---

# 31. permissionPolicy escalate

同样分阶段。

### Runtime interactive permission UI 未接好前

如果 policy 含：

```text
escalate
```

则：

```text
CLI
```

### 高级权限阶段

实现：

```text
Runtime Worker
→ permission.request
→ Bridge Host
→ daemon
→ channel/UI
→ approve/deny
```

timeout/disconnect：

```text
deny
```

然后才允许这些 policy 使用 Runtime。

---

# 32. updatePermissionPolicy

daemon 现有：

```text
transport.updatePermissionPolicy()
```

bridge method 保持不变。

EngineRouter：

```text
CliEngine.updatePermissionPolicy(next)
RuntimeEngine.updatePermissionPolicy(next)
```

RuntimeEngine：

```text
1. load + validate new policy
2. increment permission generation
3. update central immutable permission snapshot
4. notify all live Runtime Workers
5. worker callback immediately reads new snapshot
```

因此不需要上游 Runtime live-update API。

### 原子性

如果新 policy 文件无效：

```text
reject update
→ old policy remains active
```

不能一半 Worker 新、一半 Worker 旧。

---

# 33. Permission generation

Worker IPC：

```ts
{
  method: "permission.update",
  generation: 12,
  policy: ...
}
```

Worker 只接受：

```text
generation > current generation
```

防乱序。

permission 日志包含：

```text
session
worker pid
generation
mode
decision
source
```

不要记录 secrets/raw credential。

---

# 34. Claude environment

产品硬约束：

```text
one xacpx instance
→ one Claude environment
```

Runtime Worker：

```text
inherits Bridge Host / xacpx instance process.env
```

不做 per-session env snapshot。

### 禁止

```ts
sessionOptions: {
  env: { ...process.env }
}
```

因为 session options 会进入持久化 record。

Runtime adapter 建立白名单：

```ts
buildRuntimeSessionOptions(session): SessionAgentOptions {
  return {
    ...(model ? { model } : {}),
  };
}
```

不要透传未知 object。

---

# 35. Agent registry / argv overlay

当前 xacpx 已有精确：

```text
agentArgv
agentCommand
acpxAgent
```

Runtime path 推荐为当前 Worker 构造窄 registry：

```text
session agent alias
→ exact argv
```

例如：

```ts
createAgentRegistry({
  overrides: {
    [runtimeAgentName]: exactArgv,
  },
});
```

避免把整套 xacpx agent config 都同步进每个 Worker。

Windows 必须保留 exact argv boundaries。

---

# 36. MCP coordinator

这是 Runtime 迁移必须单独验证的点。

当前 CLI coordinator 依赖 queue-owner payload 做 MCP injection。

Runtime public options支持：

```text
mcpServers
```

Runtime Worker 启动时应根据：

```text
mcpCoordinatorSession
mcpSourceHandle
```

构造对应 xacpx MCP server 配置。

### 规则

MCP config 属于 worker launch identity。

如果同一 session 的 coordinator/source identity 改变：

```text
mark Worker stale
→ safe boundary cool
→ recreate Worker with new MCP config
```

不能热改 active Runtime 的 launch identity。

Phase 0/2 必须有 coordinator/worker integration test。

---

# 37. history tail

不需要上游。

继续复用 xacpx 现有 session record / event log helper。

建议抽成 engine-neutral：

```text
src/transport/acpx-session-history.ts
```

CliEngine/RuntimeEngine 共用。

不要 RuntimeEngine 为 tail 单独 spawn CLI。

---

# 38. agent-session list

第一版继续由现有 CLI/helper 服务。

这是允许的，因为 `listAgentSessions` 是：

```text
agent-level discovery
```

不是针对一个已绑定 logical session 的 mutation。

它不构成 dual owner。

允许：

```text
list native sessions
→ CLI utility
```

但：

```text
prompt/delete/setMode for Runtime-bound session
→ must stay RuntimeEngine
```

---

# 39. hasSession / record lookup

RuntimeEngine 不需要启动 Worker 只为了判断 record 是否存在。

优先使用 engine-neutral session store/read helper：

```text
has record
+
record logical status
```

只有需要 ACP connection 的 operation 才 spawn Worker。

这样 session polling 不会无故把冷 session 加热。

---

# 40. setMode / setModel / effort

如果 Worker warm：

```text
send worker control RPC
```

如果 cold：

```text
spawn Worker
→ ensure
→ control operation
→ start TTL
```

第一版建议 control operation 使用正常 TTL，保持后续 prompt warm。

---

# 41. Runtime event mapping

新增：

```text
runtime-event-mapper.ts
```

只负责：

```text
AcpRuntimeEvent
→ existing BridgePromptStreamEvent
```

例如：

```text
text_delta output
→ prompt.segment

text_delta thought
→ prompt.thought

tool_call
→ prompt.tool_event

status usage
→ prompt.usage

status availableCommands
→ prompt.commands

plan
→ prompt.plan
```

### 必须保留

`AcpxBridgeTransport` 上层已有：

- callback serialization
- quota sink
- thought callback
- plan replace semantics
- usage replace semantics
- command list
- toolEventMode

不要在 RuntimeEngine 重做这些上层逻辑。

---

# 42. Runtime error mapping

新增：

```text
runtime-error-mapper.ts
```

目标：

```text
AcpRuntime error/result
→ existing Bridge error contract
```

定义稳定 xacpx internal error codes：

```ts
type RuntimeBridgeErrorCode =
  | "RUNTIME_SESSION_MISSING"
  | "RUNTIME_INIT_FAILED"
  | "RUNTIME_TURN_FAILED"
  | "RUNTIME_TURN_CANCELLED"
  | "RUNTIME_PERMISSION_DENIED"
  | "RUNTIME_WORKER_CRASHED"
  | "RUNTIME_QUEUE_OVERFLOW"
  | "RUNTIME_ENGINE_UNSUPPORTED";
```

不要把 acpx Runtime patch-specific `detailCode` 当作 xacpx public contract。

---

# 43. Worker crash semantics

如果 Worker crash：

### no active turn / no pending queue

```text
mark cold
→ next operation respawns
```

### active turn

```text
reject active bridge request
→ RUNTIME_WORKER_CRASHED
```

### pending durable queue exists

```text
respawn worker
→ recover journal
→ continue drain
```

需要 crash-loop guard：

```text
maxRestartsPerWindow
```

连续 bootstrap crash：

```text
stop restart
→ mark Runtime session unhealthy
→ surface diagnostic
```

不要自动把同 session 切到 CliEngine。

---

# 44. Worker process ownership

Worker 必须由 Bridge Host spawn。

Bridge Host 记录：

```ts
interface RuntimeWorkerProcessIdentity {
  pid: number;
  logicalSessionId: string;
  startedAt: string;
  generation: string;
}
```

Windows 沿用现有 process identity verification / tree termination helper。

禁止仅靠：

```text
PID exists
```

判断 ownership 后杀进程。

PID reuse 必须 fail closed。

---

# 45. Engine affinity 持久化事务

新增 binding 时：

```text
resolve eligibility
→ choose engine
→ persist LogicalSession.transport_engine
→ only then launch owner
```

不要：

```text
launch Runtime Worker
→ later persist engine
```

否则 daemon crash 中间会留下无归属 owner。

如果 transport session 是 transient：

```text
engine choice lives in transient runtime context
```

但仍然一个 transient session 只能一个 engine。

---

# 46. 显式 engine migration

第一版可以不向用户开放 CLI↔Runtime migration 命令。

内部只实现测试 helper。

未来 migration transaction：

```text
1. session lock
2. assert no active turn
3. assert pending queue empty
4. cool old owner
5. persist migration intent
6. ensure target engine
7. verify same agent/cwd/session identity
8. persist transport_engine = target
9. clear intent
```

失败：

```text
rollback to source binding
```

不要自动 background migration。

---

# 47. Legacy migration

state loader：

```text
if session.transport_engine missing:
    assign "cli"
```

应作为一次持久化 migration。

日志：

```text
state.session_transport_engine_migrated
```

包含：

```text
logical_session_id
alias
engine=cli
```

不记录 agent credentials。

---

# 48. Bridge protocol 变化

daemon ↔ Bridge 的现有 21 method 尽量不变。

只增加 session params：

```text
logicalSessionId
transportEngine
```

推荐 daemon 明确传：

```text
transportEngine
```

Bridge Host 做一致性校验：

```text
request says runtime
but worker/session registry says cli
→ reject
```

不要让 Bridge Host 自己重新推导 engine，避免 daemon/host state 分叉。

---

# 49. 新的 bridge-originated permission RPC

如果需要 interactive permission，在现有双向 RPC 增加：

```ts
type BridgeOriginatedMethod =
  | ExistingBridgeOriginatedMethod
  | "resolvePermissionRequest";
```

params：

```ts
interface ResolvePermissionRequestParams {
  logicalSessionId: string;
  sessionKey: string;
  requestId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  policyGeneration: number;
}
```

response：

```ts
type PermissionDecision =
  | { outcome: "allow_once" }
  | { outcome: "allow_always" }
  | { outcome: "reject_once" }
  | { outcome: "reject_always" }
  | { outcome: "cancel" };
```

bridge RPC timeout：

```text
reject_once / cancel
```

不能 undefined。

---

# 50. Dependency strategy

xacpx 继续坚持 acpx：

```text
exact pin only
```

不使用：

```text
^0.x
~
latest
```

实施前选择一个已经发布、Runtime public contract 通过 PoC 的 exact acpx 版本。

如果目标是评估报告对应的 `0.13.1`，则单独做 dependency baseline PR：

```text
0.13.0 → 0.13.1
```

并先跑现有 CLI 全套回归。

这个 PR 不混入 Runtime 架构代码。

---

# 51. Runtime compatibility fingerprint

由于不能控制上游 Runtime patch breaking，启动/CI 做 contract probe。

至少验证：

```text
import acpx/runtime succeeds
createAcpRuntime exists
createRuntimeStore exists
createAgentRegistry exists
startTurn result has:
  promptStarted
  events
  result
```

结合：

```text
exact version
+
runtime contract smoke
```

双重保护。

---

# 52. 推荐 PR 拆分

不要做一个巨型 PR。

建议至少拆成以下序列。

## PR 0 — acpx dependency baseline / PoC

### 目标

确定 Runtime public contract baseline。

### 改动

- exact pin 到目标版本（若需要）
- PoC test harness
- packaged `dist` Runtime import smoke
- CLI↔Runtime record compatibility test
- cold/warm benchmark harness

### 不做

- 不改 default engine
- 不改 state engine binding
- 不上线 Runtime session

### Gate

```text
existing CLI CI green
G1 record compatibility green
runtime import smoke green
```

---

## PR 1 — Engine abstraction，纯重构

### 目标

把现有 CLI BridgeRuntime 封装成 CliEngine。

### 新增

```text
bridge-engine.ts
engine-router.ts
cli-engine.ts
```

### 要求

行为零变化。

### Gate

```text
all existing tests green
```

---

## PR 2 — persistent engine affinity

### 目标

加入：

```text
transport.engine
LogicalSession.transport_engine
ResolvedSession.transportEngine
```

legacy：

```text
missing => cli
```

### 测试

- state migration
- create runtime-bound session
- restart keeps binding
- rename keeps binding
- archive/restore keeps binding
- custom transport.command cannot bind runtime
- strict runtime config fails loudly when ineligible

---

## PR 3 — Runtime Worker infrastructure

### 目标

建立：

```text
RuntimeWorkerManager
RuntimeWorkerClient
runtime-worker-main
runtime-adapter
```

只支持：

```text
spawn
ping/bootstrap
ensure smoke
shutdown
```

### 测试

- one session → one worker
- same session reuses worker
- different sessions never share worker
- worker crash cleanup
- Windows identity verification
- bridge shutdown kills all workers

---

## PR 4 — Runtime prompt + typed events

### 目标

Runtime-bound session 可以：

```text
ensure
prompt
cancel
setMode
setModel/config
status/effort
```

### 重点

- typed event mapping
- callback order parity
- final text parity
- active turn idle timeout integration
- structured error mapping

---

## PR 5 — Runtime lifecycle parity

### 目标

不改 upstream 实现：

```text
freeWarmProcess
isSessionWarm
TTL
remove
delete
shutdown
```

### 核心

```text
kill Worker = release
```

### Gate

- G3 warm release
- G4 hard delete
- G10 process cleanup

Runtime 不满足这些前：

```text
engine:auto must not select runtime
```

---

## PR 6 — Runtime durable queue

### 目标

xacpx-owned FIFO queue。

### 包含

- durable journal
- idempotent messageId
- queue limit
- drain
- cancel semantics
- crash recovery
- TTL interaction
- archive/delete interaction

### Gate

G6。

---

## PR 7 — Runtime live permission parity

### 目标

不依赖 upstream live-update。

### 包含

- xacpx permission policy parser
- permission resolver
- permission generation
- Runtime Worker update
- callback explicit decision
- fail-closed tests
- CLI differential tests

### 第一版 eligibility 限制

如果尚不能精确表达：

```text
nonInteractivePermissions=fail
escalate
```

继续 force CLI。

### Gate

G5。

---

## PR 8 — MCP coordinator Runtime parity

### 目标

Runtime-bound coordinator/worker 可以获得同样的 xacpx orchestration MCP tools。

### Gate

- delegate request E2E
- scheduled tool E2E
- coordinator wake
- no double MCP registration
- Worker cool/restart resumes correctly

---

## PR 9 — advanced Runtime features

- interactive permission UI
- elicitation
- usage/cost dashboard
- available commands
- meta diagnostics

这些都不是 default switch 前的架构核心。

---

## PR 10 — engine:auto default switch

只有 G1-G13 全绿后做。

改：

```text
acpx-bridge engine default
cli → auto
```

保留：

```text
engine=cli
acpx-cli transport
transport.command
```

永久兼容。

---

# 53. 测试矩阵

每个关键 transport 语义至少跑：

```text
CliEngine
RuntimeEngine
```

分类：

```text
transport semantic parity
engine-specific implementation
legacy CLI compatibility
Runtime-only capability
```

不要机械让所有 CLI implementation test 跑 Runtime。

---

# 54. 必测生命周期

Runtime：

```text
ensure → prompt → warm=true
freeWarm → warm=false
prompt → worker respawn → history preserved

TTL → worker gone
prompt → resume

archive → worker gone
restore → cold resume

remove → worker gone + logical close semantics parity

delete → worker gone + record/history gone

bridge shutdown → all workers gone
bridge crash → no uncontrolled worker orphan
```

---

# 55. 必测 queue

```text
A active
B queued
C queued
→ A/B/C order

duplicate messageId
→ no double execution

queue overflow
→ explicit error

worker crash after B ack before execution
→ B recovered

worker crash while A active
→ A fails
→ B recovery policy deterministic

archive with pending B/C
→ behavior explicitly tested

delete with pending
→ no execution after delete

TTL never fires while queue non-empty
```

---

# 56. 必测 permission

差分基准：

```text
same permission request
same config
CLI semantics vs xacpx Runtime resolver
```

覆盖：

```text
approve-all
deny-all
approve-reads:
  read
  search
  edit
  delete
  execute
  unknown

policy:
  autoDeny
  autoApprove
  escalate
  default approve
  default deny

malformed policy
missing policy file
policy update while worker warm
policy update while turn active
permission RPC timeout
bridge disconnect
worker abort
```

所有 host failure：

```text
must not allow
```

---

# 57. Windows 必测

Windows 是 merge gate，不是 follow-up。

覆盖：

1. Runtime Worker spawn 不弹额外 console window。
2. Worker exit 后 adapter child 不残留。
3. TTL cleanup。
4. freeWarm cleanup。
5. bridge shutdown cleanup。
6. bridge crash orphan cleanup。
7. PID reuse fail closed。
8. hard delete 文件锁释放。
9. state/queue journal atomic replace。
10. structured argv 边界不丢失。
11. 中文/空格 cwd。
12. restart 后 engine affinity 不漂移。

---

# 58. Benchmark

比较：

```text
CliEngine vs RuntimeEngine
```

场景：

### cold first prompt

```text
no queue owner / no Runtime Worker
→ first output
```

### warm follow-up

```text
existing CLI queue owner
vs
existing Runtime Worker
```

### control

```text
setMode
setModel
status
```

### cold resume after TTL

```text
persistent history exists
owner gone
→ first output
```

### queue

```text
active turn
→ enqueue ack latency
→ next turn start latency
```

Default switch 的判断：

```text
semantic parity first
performance no material regression
then evaluate gain
```

---

# 59. Logging / observability

新增事件建议：

```text
transport.engine.selected
transport.engine.ineligible
transport.engine.binding_migrated

runtime.worker.spawn
runtime.worker.ready
runtime.worker.crashed
runtime.worker.cool
runtime.worker.ttl_expired
runtime.worker.terminated

runtime.queue.enqueued
runtime.queue.started
runtime.queue.completed
runtime.queue.recovered
runtime.queue.overflow

runtime.permission.decision
runtime.permission.update
runtime.permission.rpc_failed

runtime.compat.probe_failed
```

字段：

```text
logicalSessionId
session alias（非唯一，仅诊断）
engine
worker pid
generation
reason
duration
queue depth
```

不要记录：

- API key
- full process.env
- raw auth credentials
- secret-bearing policy content
- unrestricted tool raw input

---

# 60. Rollback

生产出现 Runtime 问题时必须能：

```text
transport.engine = cli
restart
```

但已有：

```text
transport_engine=runtime
```

session 不应在 restart 后被静默改为 CLI。

因此 `engine=cli` 默认只控制新 session。

已有 Runtime session 必须：

```text
keep runtime
```

或者通过明确 migration command 切换。

在 migration 工具未完成前，生产 Runtime rollout 应采用有限 cohort / 显式 `engine=runtime` 测试，不直接全量切换。

---

# 61. Default switch 前最终 Gate

## G1 Record compatibility

CLI ↔ Runtime record 双向。

## G2 Single owner

一个 logical session 同一时刻一个 Engine。

## G3 Warm release

Worker kill 后 record open、history 完整、可 resume。

## G4 Hard delete

进程 + record/history 都消失，幂等。

## G5 Permission fail closed

所有 host failure 不放行。

## G6 Queue semantics

FIFO、durable ack、crash recovery、overflow、cancel、archive/delete。

## G7 Events

typed event 与现有 consumer 语义一致。

## G8 Errors

missing/session/init/permission/cancel 等错误不会静默变化。

## G9 Usage

缺失仍表示 unknown，不当 0。

## G10 Cross-platform cleanup

Windows/macOS/Linux 无 Runtime Worker/adapter orphan。

## G11 Engine affinity persistence

restart/rename/archive 后不漂移。

## G12 Benchmark

有 cold/warm/control/queue 数据。

## G13 No private acpx API

CI/static check：

```text
xacpx source may import:
  "acpx/runtime"

must not import:
  "acpx/dist/*"
  "acpx/src/*"
```

建议增加 repository lint。

---

# 62. Implementation Agent 工作规则

交给实现 Agent 时明确：

1. 每个 PR 先读当前 main，不能按本文旧行号直接改。
2. PR 0/1 必须先完成，禁止直接在 `bridge-runtime.ts` 里硬塞 Runtime。
3. 不修改 acpx 仓库。
4. 不 vendor 整个 acpx Runtime。
5. 不 import private API。
6. 不按 method fallback。
7. 不自动迁移 legacy session 到 Runtime。
8. 不因 Runtime unsupported 而静默改变 `delete/freeWarm/queue/permission` 语义。
9. Windows 生命周期测试必须和实现同 PR。
10. 每个 PR 必须包含 focused unit tests、relevant compat tests、typecheck、build、existing CI。
11. Runtime default switch 必须单独 PR，不能和实现代码混在一起。
12. 任何无法做到等价的边界：收窄 Runtime eligibility，保留 CliEngine，不用“best effort”掩盖语义差异。

---

# 63. 推荐第一批开工任务

实现 Agent 可以直接从以下顺序开始：

### Task 1

建立 Runtime PoC：

```text
real packaged dist
→ import acpx/runtime
→ create Runtime
→ mock ACP agent
→ ensure
→ startTurn
→ result
```

### Task 2

建立 CLI↔Runtime record bidirectional fixture test。

### Task 3

把现有 BridgeRuntime 抽成 `CliEngine`，行为零变化。

### Task 4

给 LogicalSession 增加 `transport_engine`，legacy 默认 CLI。

### Task 5

建立 RuntimeWorkerManager + empty Worker protocol，只做 spawn/ping/shutdown。

### Task 6

Runtime Worker 内接 `runtime-adapter`，完成 ensure。

### Task 7

接 prompt typed events。

在 Task 1–7 全部稳定以前，不开始 durable queue 或 interactive permission UI。

---

# 64. 预计主要改动文件

当前代码结构下，实施过程中重点会涉及：

```text
package.json
src/config/types.ts
src/state/types.ts
src/sessions/session-service.ts
src/main.ts

src/transport/types.ts
src/transport/acpx-bridge/acpx-bridge-transport.ts
src/transport/acpx-bridge/acpx-bridge-protocol.ts
src/transport/acpx-bridge/acpx-bridge-client.ts

src/bridge/bridge-main.ts
src/bridge/bridge-server.ts
src/bridge/bridge-runtime.ts

src/bridge/engine/**                 # new
```

以及测试：

```text
tests/unit/bridge/**
tests/unit/transport/acpx-bridge/**
tests/unit/sessions/**
tests/compat/**
tests/smoke/**
Windows-specific process/lifecycle suites
```

原则上上层 `AcpxBridgeTransport` 只新增 session identity/engine params，不重写其 streaming/quota/callback 语义。

---

# 65. 最终架构目标

最终不是：

```text
xacpx
→ acpx CLI everywhere
```

也不是：

```text
xacpx daemon
→ one global AcpRuntime
```

而是：

```text
xacpx daemon
        │
        ▼
Bridge Host
        │
        ├── persistent Engine affinity
        │
        ├── CliEngine
        │      └── long-term compatibility
        │
        └── RuntimeEngine
               │
               ├── xacpx-owned durable queue
               ├── xacpx-owned TTL/lifecycle
               ├── xacpx-owned permission resolver
               └── per-session Runtime Worker
                       └── only public acpx/runtime
```

这个结构的核心收益：

- **0 upstream modifications**
- Runtime failure 仍不进入 daemon
- session lifecycle 完全受 xacpx 控制
- `freeWarmProcess` 可精确实现
- TTL 可精确实现
- hard delete 仍归 xacpx
- queue 不依赖 CLI owner
- permission live update 不依赖 Runtime private manager
- CLI 永久保留
- Runtime patch breaking 被限制在 adapter 层
- Windows process ownership 仍由 xacpx 治理

---

# 66. 最终实施决策

> **批准实施 xacpx-only B+。**
>
> 不修改 `openclaw/acpx`。xacpx 只依赖 `acpx/runtime` 已发布 public contract。Runtime public contract 缺失的生命周期能力，不再作为上游依赖，而由 xacpx 通过 per-session Runtime Worker、Engine affinity、durable queue、permission resolver 和现有 process-tree 治理自行实现。
>
> Runtime Worker process 是 `release/dispose` 的替代 primitive：普通 cooling/TTL/freeWarm 只终止 Worker，不调用 Runtime close，因此 logical session record 保持 open；下一 turn 新建 Worker 并从 persistent record reconnect/resume。
>
> 同一 logical session 永远只允许一个 Engine。CLI 兼容只能在新建/显式迁移边界选择，禁止 method-level fallback。
>
> Legacy session 默认继续绑定 CLI；Runtime 只从新建 session/显式迁移开始逐步 rollout。G1–G13 全绿之前，不将 `engine:auto` 的默认选择切到 Runtime。
