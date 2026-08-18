# xacpx Agent Messaging — Design Spec & Execution Plan

Status: Proposed / v0.2  
Date: 2026-08-11  
Scope: xacpx 内置 MCP 驱动的、location-independent Agent-to-Agent Messaging。目标覆盖同 daemon、跨 daemon、跨 OS user、跨机器，以及经显式信任关系授权的跨账号通信。

Implementation status (2026-08-18): Local queue-first v0.1 is implemented and
verified in this PR: stable node/endpoint identities, same-coordinator
discovery, one-way `agent_send`, queue acceptance, typed receipts/errors,
guardrails, both transports, daemon RPC, and MCP tools. Wire protocol constants
and Relay Hub routing scaffolding are prepared. Same-turn steering remains
gated by the separate acpx/codex-acp Phase 0 spike. Production multi-daemon
Relay wiring and remote presence will be closed in the follow-up federation milestone.

## 1. Summary

xacpx 将新增一条独立于 Task Orchestration 的 Agent Messaging 通道。一个正在运行的 Agent 通过 xacpx 自带 MCP 向另一个 xacpx-managed Agent session 发送消息：

```
Agent A
  │ MCP: agent_send(...)
  ▼
xacpx daemon ── resolve target ──► Agent Message Router
                                      ├─ same-turn steer
                                      ├─ next-turn queue
                                      └─ explicit interrupt + prompt
```

它不是 delegate_request 的变体：

- Task Orchestration 表达“完成这个任务，并最终给我结果”。
- Agent Messaging 表达“我现在要告诉你一条信息；请按自己的工作流继续处理”。

核心结论：

1. MCP 是 Agent 发消息的 API，不是实时输入注入机制。
2. xacpx daemon 是消息 router 与权限边界。
3. socket、stdio、Unix socket 和 named pipe 只是底层实现，不进入公共消息语义。
4. 同一 turn 的实时插入必须使用目标 runtime 真实支持的 steering，不能把普通 prompt 伪装成实时输入。
5. live turn 属于 acpx persistent queue owner；active-turn lookup 与 steer 必须由该 owner/adapter 原子完成。
6. agent_send 是 one-way message 加 delivery ACK，绝不等待对端模型回复。
7. 首个 rollout 可只开放 Local Route，但地址、envelope 与 router 从第一天按完整 location-independent 目标设计。
8. 跨 daemon 复用现有 Relay Hub 的持久 outbound WebSocket；不新增公网 daemon listener。
9. 跨账号只能通过显式 peer trust/grant 授权；被 Relay 看见不等于能注入 Agent。
10. agent_send 永远是 live-delivery。离线 store-and-forward 将来若需要，使用独立的 agent_mail。

## 2. Current Architecture and Constraint

xacpx 已有适合的 MCP control plane：

```
Codex / Claude / MCP host
          │ MCP stdio
          ▼
    xacpx mcp-stdio
          │ local orchestration IPC
          ▼
      xacpx daemon
```

主要入口：

- src/mcp/xacpx-mcp-server.ts
- src/mcp/xacpx-mcp-tools.ts
- src/mcp/xacpx-mcp-transport.ts
- src/orchestration/orchestration-service.ts
- src/orchestration/orchestration-client.ts

当前 XacpxMcpTransport 的 API 是 Task API，例如 delegateRequest、createGroup、getTask、listTasks、approveTask、cancelTask、watchTask、workerRaiseQuestion 与 coordinatorAnswerQuestion；它尚无通用 peer-message primitive。

现有 Bridge Server 将 prompt 等 session 操作放入 normal lane，且 normal lane 严格串行。普通 prompt 因而只能在当前 turn 完成后执行，不能实现实时注入：

```
current turn █████████████████████
                                 peer prompt ███
```

BridgeRuntime.prompt() 是通过 acpx CLI 发起 prompt，并不持有 Codex/Claude/Gemini 的 live client。活跃 persistent session 的 live ACP connection 实际上由 acpx queue owner process 持有，其他 acpx invocation 经本机 IPC 向 owner 发送 prompt、cancel、set-mode 等请求。

因此本设计的所有 realtime control 遵从以下所有权原则：

> 谁持有 live turn，谁完成 atomic steer。

xacpx 不缓存 activeTurnId 后再跨进程调用；它请求语义化的 steer(session, message)，由 acpx queue owner/adapter 在其 live runtime 内完成“确认当前 active turn + 注入”的原子操作。

## 3. Goals and Permanent Boundaries

### 3.1 Functional goals

v0.1 必须支持：

- 当前 Agent 通过 MCP 查询可通信的 Agent endpoints。
- Agent A 向 Agent B 发送消息；B 能用相同 tool 回复 A。
- B 正在运行且支持 steering 时，可向 B 的当前 turn 注入。
- B 不支持 steering 时，安全降级到 B 的 next-turn queue。
- 调用方可显式选择 interrupt + new prompt；默认绝不自动 interrupt。
- 每条消息有稳定 messageId，replyTo 用于逻辑关联。
- 同一 target 的实时消息按提交顺序投递。
- 调用只等待 delivery ACK，不等待 B 的模型输出。
- sender identity 由 xacpx 从 MCP binding 推导，模型不能伪造。

### 3.2 Architectural goals

- Agent Messaging 与 Task Orchestration 分层。
- Local、Relay 与未来 Peer Route 共享 AgentMessage、receipt 与 error model。
- 不依赖 PTY scraping，也不在 MCP 层对 Codex/Claude/Gemini 分支。
- vendor 差异只在 acpx/runtime/adapter capability 层。
- source identity 在每一个跨信任边界 hop 都重新绑定或校验。
- remote discovery 与 session private metadata 分离；默认不发布 cwd、PID、OS user 或 native thread id。
- 同账号跨 daemon 与跨账号 peer messaging 使用同一 Relay transport，只有授权策略不同。

### 3.3 Non-goals and rollout boundaries

永久边界：

- 不做匿名、无鉴权的互联网消息系统。
- endpoint id 可知不等于任何远端进程有注入权限。
- 不要求所有 provider 支持 same-turn steer。
- 不保证 external MCP host 可被反向注入。
- 不等待远端模型回答，不把消息自动转换成 Task。
- 不将 cwd、UID/SID、PID 或 native thread id 视为公共身份或权限边界。
- 不通过模拟键盘或 PTY scraping 冒充 provider steering。
- 不把 Kafka、NATS、Redis 等 broker 设为基础依赖。

实施边界：

- 首个可交付版本可以只启用 Local Route。
- Relay Route、跨账号 peer grant、durable agent_mail 可以后续实现。
- 这些延后项不得收窄公共协议；跨 daemon、跨 OS user、跨机器、跨账号是目标架构的一部分。

## 4. Ubiquitous Language and Identity Model

### 4.1 Messaging Node

Messaging Node 是持有 xacpx Agent Messaging runtime 的逻辑实例，通常对应 xacpx home + daemon 安全域，而不是 daemon PID。

```
interface MessagingNodeIdentity {
  nodeId: string;          // persisted stable opaque id
  displayName?: string;    // e.g. home-mac, work-pc
}
```

nodeId daemon restart 后不变，不从 hostname、OS username、UID/SID 或 IP 推导。Relay 的 instances.id 可映射 nodeId，但两者不是同一个协议身份。同机不同 OS user 通常拥有不同 xacpx home，因此是不同 node。

### 4.2 Agent Address and Endpoint

内部 canonical address 从第一天包含 node 与 endpoint：

```
interface AgentAddress {
  nodeId: string;
  endpointId: string;
}

interface RoutedAgentAddress extends AgentAddress {
  realmId?: string; // future optional relay/federation authority
}
```

endpointId 表示逻辑 managed session，不是某一个 turn。managed session 仍存在时，daemon/owner restart 不应无故改变它。

```
interface AgentCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
}

interface AgentEndpoint {
  address: AgentAddress;
  handle: string;
  agent: string;
  driver?: string;
  displayName?: string;
  state: "idle" | "running" | "unreachable";
  capabilities: AgentCapabilities;
  private?: {
    cwd?: string;
    sessionName?: string;
    coordinatorSession?: string;
    sourceHandle?: string;
    agentSessionId?: string;
  };
}
```

Public MCP 只暴露 opaque handle，例如 agent_01K... 或 home-mac/codex-review。模型不得解析 handle；directory/daemon 负责解析为 canonical address。

### 4.3 Sender identity and local scope

agent_send 没有 from 输入字段。MCP server/daemon 从 current binding 派生：

```
interface AgentSenderIdentity {
  address: AgentAddress;
  coordinatorSession?: string;
  sourceHandle?: string;
}
```

跨 daemon 时，Relay 还从 authenticated socket 绑定 source account 与 instance；payload 中的 accountId、nodeId、instanceId 或 from 均不可信。

首个 Local Route rollout 可以将同一 coordinatorSession 作为 discovery/authorization scope：同一 coordinator 派生的 workers 默认互相可见。它不是全局 address 的一部分，也不是跨 daemon 授权模型。完整判断是：

```
canonical target address
  + route reachability
  + source identity
  + target messaging policy / peer grant
```

相同 cwd 不会自动形成消息域。

## 5. Reachability and Capability

Agent 能调用 xacpx MCP 并不等于 xacpx 能把输入反向注入它。例如 externally-started Codex 把 xacpx mcp-stdio 当作 child MCP server 时，标准 MCP 没有通用的“将 server message 立即变成 host 当前 user input”能力。

能力必须区分：

```
send-capable    = 当前 Agent 能调用 MCP 发消息
receive-capable = xacpx/acpx 对该 target 有 runtime injection control
```

agent_list 只列 receive-capable、已授权且可被发现的 endpoint；端点存在也不表示它在线、可路由、已授权或可 steer。Router 应以稳定 typed errors 表达这些层次，而不是暴露 socket error。

Public API 对本地与远端完全相同：

```
{ to: "opaque-handle", message: "schema updated", mode: "auto" }
```

它可以走 Local Route：

```
MCP -> local daemon -> local session
```

也可以走 Relay Route：

```
MCP -> source daemon -> Relay Hub -> target daemon -> target session
```

location-independent 不表示 universally reachable。

## 6. MCP API

### 6.1 agent_list

agent_list 列出当前 sender 实际被授权且可发现的 endpoints。输入为空，不允许 scope: all 绕过 policy。

```
{}
```

示例输出：

```
{
  "agents": [
    {
      "handle": "home-mac/codex-review",
      "node": "home-mac",
      "agent": "codex",
      "workspace": "xacpx",
      "state": "running",
      "capabilities": {
        "receive": true,
        "steer": true,
        "queue": true,
        "interrupt": true
      }
    }
  ]
}
```

约束：

- 早期 Local Route 可等价于同 coordinator。
- 不返回 secret、raw IPC path、PID、OS username、native id 或 absolute cwd。
- workspace 仅是可公开 display label。
- handle opaque；v0.1 推荐 server 直接排除 sender 自己。

建议 tool description：

> List peer agent sessions that the current xacpx-managed agent is authorized to message. Endpoints may be local or remote; only reachable/discoverable endpoints are returned. Use the returned opaque handle as agent_send.to and do not parse the handle.

### 6.2 agent_send

输入 schema：

```
{
  to: string;
  message: string;
  mode?: "auto" | "steer" | "queue" | "interrupt";
  replyTo?: string;
}
```

mode 默认 auto。示例：

```
{
  "to": "agent:codex:7d2f...",
  "message": "auth.ts 的 refresh-token 分支有 race condition，先不要继续按现有实现扩展。",
  "mode": "auto"
}
```

成功 receipt：

```
{
  "messageId": "msg_01K...",
  "status": "injected",
  "modeUsed": "steer"
}
```

或 queue fallback：

```
{
  "messageId": "msg_01K...",
  "status": "queued",
  "modeUsed": "queue"
}
```

严格 steering 失败示例：

```
{
  "error": {
    "code": "TARGET_NOT_STEERABLE",
    "message": "Target does not support same-turn steering."
  }
}
```

成功表示 target runtime 已接受 injected 或 queued delivery；远端仅收到 WebSocket/Relay route 不能算成功。它不表示对端已经理解、完成或回复。

建议 tool description：

> Send a one-way peer message to another authorized agent session. The target may be local or remote. The call returns after the target runtime accepts injection/queue delivery and does not wait for the target model to reply. Use mode=auto unless same-turn steering or interrupt semantics are explicitly required.

### 6.3 One-way semantics

禁止将 agent_send 变为跨 Agent RPC：

```
A -> B, wait for B
B -> C, wait for C
C -> A, wait for A
```

这自然形成 distributed Agent deadlock。正确模型是：

```
A ─ message ─► B
A ◄ delivery ACK ─ xacpx

B needs to reply:
B ─ new agent_send(replyTo=...) ─► A
```

replyTo 只做逻辑关联，不改变 one-way delivery semantics。

## 7. Message Envelope and Target Input

内部统一 envelope：

```
type AgentMessageMode = "auto" | "steer" | "queue" | "interrupt";

interface AgentMessage {
  id: string; // UUIDv7, ULID, or equivalent globally unique id
  from: AgentAddress;
  to: AgentAddress;
  content: string;
  replyTo?: string;
  requestedMode: AgentMessageMode;
  createdAt: number;
  expiresAt?: number; // optional live-delivery deadline
}

interface AgentMessageReceipt {
  messageId: string;
  status: "injected" | "queued" | "failed";
  modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
  route?: "local" | "relay";
  targetState?: "idle" | "running";
  deduplicated?: boolean;
  errorCode?: string;
}
```

Local milestone 不要求 durable message database；有限 receipt/routing trace 即可。Relay route 应有跨 reconnect/retry window 的 messageId dedupe。

目标 Agent 接收到的是结构化 peer message，而不是伪造 User/System 文本：

```
<xacpx-message
  id="msg_01K..."
  from="home-mac/claude-reviewer"
  replyable="true"
  reply-to="msg_01J..."
>
auth.ts 的 refresh-token 分支有 race condition，先不要继续按现有实现扩展。
</xacpx-message>
```

无 replyTo 时省略 reply-to。from 是 target-local reply handle：内部使用 canonical AgentAddress，但 target daemon 通过自己的 directory/handle resolver 产生目标 Agent 可直接使用的 to handle。

replyable=true 必须同时满足 source receive-capable、reverse route 存在、以及 reverse authorization/grant 允许 target -> source。external host 不能被反向注入、或 grant 为单向时应为 false。

相关 worker guidance：

> When you receive an <xacpx-message>, treat it as a peer-agent message. If replyable=true and a reply is useful, call agent_send with the provided from handle as to, and set replyTo to the received message id. Do not assume a reply is required for every message.

## 8. Delivery Modes

### 8.1 auto

默认状态机：

```
idle                                -> prompt/start-turn
running + steer supported           -> steer current turn
running + no steer + queue          -> queue next turn
unreachable                         -> fail
```

auto 绝不自动 interrupt。

### 8.2 steer

steer 是严格 same-turn delivery：

```
running + steer=true -> steer
otherwise            -> TARGET_NOT_STEERABLE or TARGET_NOT_RUNNING
```

严禁静默 fallback 到 queue。

### 8.3 queue

queue 始终表示普通 next-turn input：

- target idle：可直接启动 prompt，receipt 是 status=injected、modeUsed=prompt。
- target busy：向 acpx owner 的 existing execution queue 提交，receipt 是 status=queued、modeUsed=queue。

xacpx 不建立第二个 prompt queue。

### 8.4 interrupt

interrupt 是显式破坏性操作：

```
interrupt current turn
  -> await interrupt ACK/terminal transition
  -> start new prompt containing peer message
```

只有 mode=interrupt 才可使用。target idle 时 v0.1 可直接 start prompt。

| Target state | Steer | Requested mode | Behaviour                            |
| ------------ | ----- | -------------- | ------------------------------------ |
| idle         | any   | auto / queue   | start prompt                         |
| idle         | any   | steer          | fail TARGET_NOT_RUNNING              |
| idle         | any   | interrupt      | start prompt                         |
| running      | yes   | auto / steer   | steer                                |
| running      | yes   | queue          | queue next turn                      |
| running      | yes   | interrupt      | interrupt then prompt                |
| running      | no    | auto           | queue next turn                      |
| running      | no    | steer          | fail TARGET_NOT_STEERABLE            |
| running      | no    | queue          | queue next turn                      |
| running      | no    | interrupt      | interrupt then prompt when supported |
| unreachable  | any   | any            | fail                                 |

## 9. Local Architecture

```
Agent A
  │ MCP tools/call
  ▼
xacpx mcp-stdio
  - derives sender identity
  - no vendor-specific logic
  │ local orchestration IPC
  ▼
xacpx daemon
  - AgentEndpointRegistry
  - AgentMessageRouter
  - authorization, FIFO, route and receipt
  │ bridge / acpx control
  ▼
acpx persistent queue owner
  - live ACP connection / active turn
  - atomic steer / queue / cancel
  │ provider-specific adapter
  ▼
Codex / Claude / Gemini
```

Responsibilities:

- MCP/Agent layer: message intent only.
- Source daemon: derive caller identity, resolve opaque handle, authorize and select route.
- Target daemon: final destination authorization, endpoint resolution, dedupe and delivery policy.
- acpx queue owner: own live session and active turn; serialize runtime primitives.
- adapter: provider-specific steer, queue and interrupt.

### 9.1 Endpoint registry

新增：

- src/orchestration/agent-messaging-types.ts
- src/orchestration/agent-endpoint-registry.ts

概念接口：

```
interface AgentEndpointRegistry {
  register(endpoint: AgentEndpoint): void;
  unregister(handle: string): void;
  resolve(sender: AgentSenderIdentity, handle: string): AgentEndpoint | null;
  listReachable(sender: AgentSenderIdentity): AgentEndpoint[];
  updateState(handle: string, patch: Partial<AgentEndpoint>): void;
}
```

Endpoint 在 worker/session create 或 attach 时注册，至少关联 coordinatorSession、sourceHandle、agent、cwd、session key/name 与 bridge/acpx routing data。公开 handle 由 daemon 生成并映射到这些私有 binding；不能让 MCP 客户端依赖 raw sourceHandle 格式。

运行状态：

- running：active owner 且 active turn。
- idle：可 resume、当前无 active turn。
- unreachable：binding 仍在但 runtime 当前无法投递。

queue owner TTL 到期不删除 endpoint；它只改变 runtime 状态。明确 delete/remove、coordinator cleanup、binding reclaim 或永久 close 才 unregister/标记不可达。

### 9.2 Message router

新增 src/orchestration/agent-message-router.ts：

```
class AgentMessageRouter {
  listReachable(sender: AgentSenderIdentity): AgentEndpoint[];
  send(input: {
    sender: AgentSenderIdentity;
    to: string;
    content: string;
    mode: AgentMessageMode;
    replyTo?: string;
  }): Promise<AgentMessageReceipt>;
}
```

职责：

- 验证 sender，拒绝 self。
- 执行 local scope / remote policy authorization。
- resolve opaque handle 到 canonical address。
- 生成全局 messageId、包装 xacpx-message。
- Local/Relay route selection，调用 target live-control transport。
- 按 target delivery FIFO，记录 trace，返回一致 receipt。

per-target FIFO 只序列化投递动作，绝不等待 target model turn 完成。例如可保存 target tail Promise；不同 target 可并行。目标行为应保证至少同一 (sourceAddress, targetAddress) FIFO，route 与 target runtime 不得并发调用 vendor steer。

## 10. MCP Transport and Daemon IPC

xacpx-mcp-transport 增加：

```
interface XacpxMcpAgentListArgs {
  coordinatorSession: string;
  sourceHandle?: string;
}

interface XacpxMcpAgentSendArgs {
  coordinatorSession: string;
  sourceHandle?: string;
  to: string;
  message: string;
  mode?: "auto" | "steer" | "queue" | "interrupt";
  replyTo?: string;
}

interface XacpxMcpTransport {
  // existing task APIs
  listAgentEndpoints(input: XacpxMcpAgentListArgs): Promise<AgentEndpoint[]>;
  sendAgentMessage(input: XacpxMcpAgentSendArgs): Promise<AgentMessageReceipt>;
}
```

createOrchestrationTransport() 继续只转发到本机 daemon RPC。tool registry closure 自动注入 coordinatorSession 与 sourceHandle；MCP schema 不接收 from、busId 或 coordinatorSession。

daemon orchestration IPC 新增：

```
agent.list
agent.send
```

agent.send params 可以带 coordinatorSession/sourceHandle/to/message/mode，但 daemon 根据 binding 构造可信 sender。MCP tool 不得直接转成 Bridge request，因为 daemon 必须先完成 authorization、endpoint resolution、message id、route policy、FIFO 与 observability。

## 11. Bridge and acpx Live Control

在 xacpx 与 acpx 控制边界新增语义化 request，而不是继续称作 prompt：

```
injectMessage({
  agent,
  cwd,
  name,
  sessionKey?,
  text,
  mode: "auto" | "steer" | "queue" | "interrupt",
  messageId,
})
-> {
  status: "injected" | "queued",
  modeUsed: "steer" | "queue" | "interrupt" | "prompt",
}
```

Bridge scheduler 增加 lane：

```
type BridgeRequestLane = "normal" | "message" | "control";
```

- normal：长时 prompt 和 management serial flow。
- message：peer delivery，按 session FIFO，但不得等待 normal prompt completion。
- control：cancel/status 等即时 control。

关键不变量：message lane 不等于 normal lane。否则 realtime steer 必然被当前 normal prompt 阻塞。

xacpx 的 BridgeRuntime.injectMessage 只调用 acpx 的正式 control API；不直接操作 provider，也不直接写 acpx queue socket。

### 11.1 Required upstream acpx primitive

acpx queue owner 已是 persistent session 的 live owner，应该公开正式 runtime/CLI control API：

```
acpx codex steer -s <session> --message-id <id> '<text>'

runtime.steerTurn({
  sessionId,
  text,
  clientMessageId,
})

Queue IPC:
{ type: "steer", text, clientMessageId? }
```

queue owner 收到 steer 后：

```
resolve current active turn
  -> confirm adapter capability and steerability
  -> provider-specific steering atomically
  -> typed ACK/error
```

没有 live owner 时 steer 不能新开 turn，应返回 not-running；adapter 不支持时返回 not-supported；不可 steer turn 和 race 也需要 typed result。steer 不进入普通 prompt queue，同 session steer requests FIFO。

xacpx 不应直接写 acpx queue socket：这会把 acpx internal IPC protocol、generation/ownership/error/reconnect 逻辑耦合进 xacpx，并阻碍 acpx 版本升级。

### 11.2 Capability model

ACP 没有统一 same-turn steer primitive，因此 live input capabilities 是 optional：

```
interface LiveInputCapabilities {
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
}
```

- Codex：Codex App Server 原生有 turn/steer 与 turn/interrupt，是首个 realtime E2E target；需要 acpx queue owner -> codex-acp extension -> app-server 的显式能力穿透。
- Claude：底层 SDK 的动态 message 不足以证明当前 claude-agent-acp 支持 same-turn semantics。验证前 advertise steer=false、queue=true；interrupt 以可靠 cancel 为准。
- Gemini：默认 steer=false、queue=true，interrupt 按实际 ACP cancel support；未来 adapter 增加能力即可，无需变 MCP API。

Codex adapter 内的正确原子操作：

```
currentTurn = activeTurn()
if (!currentTurn) -> TARGET_NOT_RUNNING
if (!currentTurn.steerable) -> TARGET_NOT_STEERABLE

appServer.request("turn/steer", {
  threadId,
  expectedTurnId: currentTurn.id,
  clientUserMessageId: messageId,
  input: [{ type: "text", text }],
})
```

若 turn 在请求过程中自然结束：mode=steer 直接失败；mode=auto 可最多一次重判，若已 idle 则作为新 prompt，不无限 retry。

## 12. Location-independent Routing

最终 fabric：

```
                 Relay Hub
           identity / routing / directory / policy
                 │                   │
             persistent WSS       persistent WSS
                 │                   │
         xacpx node A          xacpx node B
         source daemon          target daemon
         MCP -> Router       Router -> acpx -> Agent B
```

Local route 直接投递；different node 使用 Relay route。Peer route 是 Relay route 加 cross-account grant evaluation，不是新的网络 transport。

建议 route contract：

```
interface AgentMessageRoute {
  canRoute(target: AgentAddress): boolean;
  send(message: AgentMessage, ctx: RouteContext): Promise<AgentMessageReceipt>;
}
```

Route selection：

```
target.nodeId === self.nodeId
  ? localRoute.send(message)
  : relayRoute.send(message)
```

Relay/realm 不可达时返回 ROUTE_UNAVAILABLE；不 fallback 到公网直连。即使同一机器不同 OS user，也按不同 node 经 Relay 处理，不引入 machine-wide privileged broker 或放宽本地 IPC ACL。

不做 daemon-to-daemon public listener：P2P 会带来 NAT/CGNAT、firewall、TLS certificate、port discovery、IP churn、mTLS/revocation 和跨 OS service differences。现有 Relay outbound WSS 已处理在线实例寻址与 NAT traversal。

## 13. Relay Integration

Relay 分层职责：

- Source daemon：caller identity、source policy、target resolution 与 route selection。
- Relay Hub：authenticated node presence、remote directory、account/peer policy 与 forwarding。
- Target daemon：最终 endpoint policy、dedupe、endpoint resolution 与 injection authority。
- acpx/adapter：live execution；Relay 永远不理解 provider turn/steer。

### 13.1 Directory and presence

node 在 Relay auth/reconnect、endpoint register/unregister、capability/state 的重要变化时同步：

```
instance.agent-endpoints.sync
```

公开 payload：

```
interface PublishedAgentEndpoint {
  nodeId: string;
  endpointId: string;
  displayName?: string;
  agent: string;
  state: "idle" | "running";
  capabilities: AgentCapabilities;
  labels?: string[];
  updatedAt: number;
}
```

默认绝不发布 absolute cwd、PID、OS username、native session/thread id、raw sourceHandle、IPC path 或 credential。需要项目展示时只发布明确脱敏的 workspaceLabel。

Directory 是 soft presence cache：target daemon 才是 endpoint existence 真相源；stale entry 只导致 TARGET_UNAVAILABLE/TARGET_NOT_FOUND。reconnect 完整 sync 覆盖旧状态，Hub 可 TTL 清除 stale entries。ACL 必须在 Hub directory 返回前和 target delivery 时双重执行。

### 13.2 Same-account route protocol

在既有 Relay protocol/gateway 追加 additive messages：

```
instance.agent-endpoints.sync       instance -> hub event
relay.agent-directory.snapshot      hub -> instance event (optional)
relay.agent-directory.delta         hub -> instance event (optional)
agent.message.route                 instance -> hub authenticated request
agent.message.deliver               hub -> target instance request
```

完整路径：

1. Agent A 调 local MCP。
2. MCP 由 binding 派生 source endpoint。
3. source daemon 生成 global messageId，解析 target 与 local policy。
4. Relay Route 发起 authenticated route request。
5. Hub 从 authenticated socket stamp source account/instance，解析 target node。
6. Hub 在同 account policy 下 route 到 B；payload 里的 source identity 不可信。
7. Hub 向 B 请求 agent.message.deliver。
8. B 再检查 destination policy、dedupe messageId、解析 endpoint，并执行 inject/queue/interrupt。
9. target runtime receipt 经 Hub 原样回 A；只有 injected/queued 是 MCP 成功。

Hub 需要对 authenticated instance-originated request 只开放 allowlisted agent.message.route。Relay 复用其已有 instance registration、long-lived credential、online WebSocket map、socket ownership fencing、sendRequest/sendEvent、account-scoped instance、reconnect 与 heartbeat；不另造 transport。

Presence 可以内存缓存；应该持久化的是 peer links/grants 和可选 audit metadata。agent_send body 不要求 Relay 默认持久化。

### 13.3 Cross-account peer trust

跨账号默认不可见、不可发。Peer link/grant 由人通过 Relay UI/CLI invite/pair/grant 建立，Agent 不得自行扩大信任域。

语义至少支持：

```
PeerLink:
  sourceAccountId
  targetAccountId
  status: pending | active | revoked

AgentMessagingGrant:
  direction: inbound | outbound | both
  sourceNodeIds?
  targetNodeIds?
  targetEndpointIds?
  capabilities:
    message
    steer?
    interrupt?
```

每个 remote delivery 经两层授权：

```
Hub policy:
source account -> target account peer grant

Target daemon policy:
source account/node/endpoint -> target endpoint policy
```

target daemon 是最终 authority。推荐 endpoint remote policy：

```
"local-only" | "same-account" | "allowlist" | "disabled"
```

跨账号未授权时，应统一对外返回 TARGET_NOT_REACHABLE，避免泄露 endpoint existence；内部 audit 可保存真实 deny reason。

## 14. Network Semantics, Ordering and Idempotency

内部 trace stages：

```
accepted  = source daemon accepted call and generated messageId
routed    = Relay accepted target route
delivered = target daemon received and passed basic validation
injected  = target runtime accepted steer/start-turn
queued    = target live session accepted next-turn enqueue
```

MCP 成功只返回最终 injected 或 queued receipt。

Transport 是 at-least-once；injection effect 必须按 messageId exactly-once。例如 B 已 injected、ACK 丢失、A retry 时，B 必须返回先前 receipt 而不是再次 steering。Local 可以是 bounded LRU+TTL；remote dedupe window 应覆盖正常 reconnect/retry，存储实现可后定。

消息 id 使用 UUIDv7、ULID 或等价全局唯一且时间可排序的标识。至少保证同一 (sourceAddress, targetAddress) FIFO；source route 与 target delivery 都可使用 per-target lane。

queue 不等于网络 offline queue。target node offline 时：

```
TARGET_NODE_OFFLINE or ROUTE_UNAVAILABLE
```

agent_send fail-fast，不能在数小时后把旧控制文本突然 steer 当前 Agent。若需要 durable asynchronous delivery，新增 agent_mail，定义 inbox、TTL、read/ack 与 reconnect semantics。

## 15. Security, Privacy and Guardrails

认证层：

```
local sender -> OS-user-protected MCP/local IPC
source node -> Relay -> instance credential + TLS/WSS
Relay -> target node -> target authenticated WebSocket
cross account -> peer link/grant
```

target daemon 收到 remote message 后再次检查 route authentication、peer/account authorization、target endpoint policy 以及 requested mode 是否允许。例如 remote message/queue 可允许，而 remote interrupt 被独立禁止。

Relay 是可信 control-plane broker（与既有 Relay control model 一致），本设计不声明 end-to-end encrypted message body；若要防止 Relay operator 阅读正文，需要单独设计 E2EE/signature layer。

至少实现以下 loop/flood guardrails：

- message maximum 16 KiB；
- per-target pending delivery depth，例如 32；
- per sender -> target short-window rate limit；
- 工具 guidance 明确不要为纯 ACK 自动回复；
- replyTo 不触发自动 reply；
- RESOURCE_EXHAUSTED、MESSAGE_RATE_LIMITED 等 typed errors。

数值配置化，不写死在公共协议。

每次 delivery 记录结构化事件，默认不记录完整 content：

```
{
  event: "agent.message.delivery",
  messageId,
  sourceAddress,
  targetAddress,
  route,
  sourceAccountId?,
  targetAccountId?,
  requestedMode,
  modeUsed,
  status,
  targetState,
  latencyMs,
  deduplicated?,
  errorCode?
}
```

debug 可选 contentLength、safe preview、replyTo。该 trace 也将成为后续 Agent Communication Graph 的基础。

建议 typed errors：

```
TARGET_NOT_FOUND
TARGET_NOT_REACHABLE
TARGET_UNAVAILABLE
TARGET_NODE_OFFLINE
ROUTE_UNAVAILABLE
REMOTE_MESSAGING_DISABLED
DELIVERY_DENIED
PEER_GRANT_REQUIRED
TARGET_NOT_RUNNING
TARGET_NOT_STEERABLE
TARGET_NOT_INTERRUPTIBLE
MESSAGE_TOO_LARGE
MESSAGE_QUEUE_FULL
MESSAGE_RATE_LIMITED
SELF_MESSAGE_NOT_ALLOWED
DELIVERY_RACE
DELIVERY_TIMEOUT
DELIVERY_FAILED
```

## 16. Relationship to Task Orchestration

两条路径始终独立：

```
xacpx MCP
├─ Orchestration
│  ├─ delegate_request / delegate_batch
│  ├─ task_get / task_watch
│  └─ worker_raise_question / coordinator_answer_question
└─ Agent Messaging
   ├─ agent_list
   └─ agent_send
```

“帮我审查 PR，完成后给出结论”属于 Task；“User schema 刚改了，当前实现需同步调整”属于 Message。agent_send 不创建 task，task result 也不自动转为 peer message；需要转发时由 coordinator 显式调用 agent_send。

## 17. Execution Plan

实施按可独立验证的 milestones 推进，但不会收窄上述 public model。

Detailed implementation plans:

- [Phase 0 steering feasibility spike](../plans/2026-08-18-agent-messaging-steering-spike.md)
- [Local queue-first v0.1](../plans/2026-08-18-agent-messaging-local-v0.1.md)
- [Codex realtime v0.1](../plans/2026-08-18-agent-messaging-realtime-v0.1.md)

The detailed plans cover Phases 0–6. Relay, remote directory, cross-OS-user
validation, and cross-account grants remain separate future plans after the
Local/realtime interfaces have stabilized.

### Phase 0 — Live steering feasibility spike

先在 upstream acpx + codex-acp 最小 prototype 验证：

```
acpx steer
  -> queue IPC steer request
  -> codex-acp adapter extension
  -> Codex App Server turn/steer
```

必须证明：

1. Codex B 运行明显长 turn 时，第二个本机 control request 的输入进入同一 active turn。
2. 不产生 new turn/start，不 cancel 原 turn。
3. message id 可关联 Codex user-message event。
4. review/compaction 等 non-steerable turn 有 typed error。
5. turn-completion race 有稳定分类。
6. 20+ 次重复成功、delivery ACK 稳定。

不能满足时，agent_send 仍可做 queue-only，但所有 target steer=false；不得用 prompt queue 冒充 realtime。

### Phase 1 — Domain types and endpoint registry

新增：

- src/orchestration/agent-messaging-types.ts
- src/orchestration/agent-endpoint-registry.ts

实现 stable nodeId、canonical address、endpoint/receipt/message types、global message id、opaque handle mapping、same-coordinator Local policy、endpoint lifecycle 与 unit tests。

验收：同 coordinator workers 互相 list；不同 coordinator 不可见；self 排除；stale worker unavailable/unregistered；MCP 不泄漏 runtime secret。

### Phase 2 — agent_list

修改：

- src/mcp/xacpx-mcp-tools.ts
- src/mcp/xacpx-mcp-transport.ts
- src/orchestration/orchestration-client.ts
- src/orchestration/orchestration-service.ts
- relevant IPC protocol/types

新增 agent.list RPC 与 agent_list MCP tool。这一步不发消息，只稳定 identity、scope、capability 与 lifecycle。

### Phase 3 — agent_send queue-only MVP

实现 agent.send RPC、AgentMessageRouter、per-target FIFO、envelope、idempotency cache、queue delivery 与 receipts。

初始行为：

```
mode=queue -> existing acpx queue path
mode=auto  -> queue when busy; prompt when idle
mode=steer -> TARGET_NOT_STEERABLE
```

验收：A 发送给 busy B 后立即得到 queued ACK，B 当前 turn 不被打断，完成后收到 xacpx-message。该阶段独立验证 Agent identity、authorization、tool ergonomics、one-way/replyTo、loop behavior、routing 和 error model。

### Phase 4 — Formal upstream acpx live control

在 acpx 增加正式 steer runtime、CLI、queue IPC、capability 与 integration tests。可能涉及：

- src/cli-core.ts
- src/cli/session/runtime.ts
- src/cli/queue/ipc.ts
- src/cli/queue/ipc-server.ts
- src/acp/client.ts
- agent capability/extension layer

### Phase 5 — Codex adapter steering

codex-acp 映射 Codex App Server same-turn steer：跟踪 current thread/active regular turn，接受 extension request，调用 turn/steer，以 xacpx messageId 作为 clientUserMessageId，将 invalid-request/ActiveTurnNotSteerable 归一为 typed capability errors。

E2E 要证明 step 1 与 step 2 间注入后仍是同一 turn id，后续 Agent 行为受消息影响，没有 interrupt 或 turn/start。

### Phase 6 — xacpx message lane and realtime auto

修改：

- src/bridge/bridge-request-scheduler.ts
- src/bridge/bridge-server.ts
- src/bridge/bridge-runtime.ts
- src/transport/acpx-bridge/acpx-bridge-protocol.ts

新增 injectMessage 与 message lane。BridgeRuntime 依据 acpx capabilities 选择 steer、queue/prompt、interrupt；不得硬编码 agent vendor。

### Phase 7 — Claude capability spike

单独验证 Claude active response 中追加 input 的真实语义、interrupt、ordering 与 persistent resume。确认 same-turn 后才 advertise steer=true；否则保持 queue=true。

### Phase 8 — Gemini and other agents

默认 queue=true、steer=false、interrupt 由实际 ACP cancel support 决定；逐 adapter 引入 extensions。

### Phase 9 — Hardening

完成 rate limit、pending cap、idempotency LRU、structured logging、stale cleanup、daemon/owner restart semantics、Windows named pipe 与 Unix socket permission tests、docs 和 MCP prompt tuning。

### Phase 10 — Route abstraction and Relay-ready identity

建立 LocalAgentMessageRoute、RelayAgentMessageRoute interface/stub、stable nodeId persistence、remote-aware handle resolver。Local 行为不变，但 target 不再被代码假定为同 daemon；remote 无 route 明确返回 ROUTE_UNAVAILABLE。

### Phase 11 — Same-account Relay route

扩展：

- packages/relay-protocol/src/messages.ts
- packages/relay/src/gateway/instance-gateway.ts
- packages/channel-relay
- xacpx AgentMessageRouter/AgentEndpointRegistry

实现 agent.message.route、agent.message.deliver、instance.agent-endpoints.sync。验收 Mac/Windows 双向在线 delivery、offline fail-fast、reconnect retry dedupe、source identity stamping、target policy deny 与 metadata redaction。

### Phase 12 — Remote directory and presence

实现 auth/reconnect full sync、endpoint lifecycle delta、account policy filtering、TTL cleanup、Local+authorized Remote 的 agent_list、private metadata redaction。

### Phase 13 — Cross-OS-user and cross-machine validation

不新增协议，验证 Linux user A -> B、可行的 Windows account A -> B、Mac -> Windows、Windows -> Linux。所有跨 node delivery 只能经 Relay credential + target policy，绝不读取对方 runtime dir 或共享 local IPC。

### Phase 14 — Cross-account peer trust

实现 human-controlled invite/pair、node/endpoint scoped sharing、direction/mode permission、revoke、directory filtering、target daemon second authorization 与 audit trail。默认无 grant 不可见、不可达。

### Phase 15 — Optional durable Agent Mail

只有明确产品需求时再实现 agent_mail、inbox、TTL、read/ack 与 reconnect delivery；它永远不是 agent_send fallback。

## 18. File-level Change Map

MCP：

```
src/mcp/xacpx-mcp-tools.ts
  + agent_list, agent_send
src/mcp/xacpx-mcp-transport.ts
  + AgentList/AgentSend args and transport methods
```

Orchestration/daemon：

```
src/orchestration/agent-messaging-types.ts       NEW
src/orchestration/agent-endpoint-registry.ts     NEW
src/orchestration/agent-message-router.ts        NEW
src/orchestration/orchestration-client.ts        + agentList/agentSend
src/orchestration/orchestration-service.ts       + RPC handlers/binding lifecycle
```

Bridge：

```
src/transport/acpx-bridge/acpx-bridge-protocol.ts + injectMessage
src/bridge/bridge-server.ts                       + dispatch/message lane
src/bridge/bridge-request-scheduler.ts            + message lane
src/bridge/bridge-runtime.ts                      + injectMessage mapping
```

Relay/federation：

```
packages/relay-protocol/src/messages.ts
packages/relay/src/gateway/instance-gateway.ts
packages/relay/src/stores/...   // peer grants when implemented
packages/channel-relay/...
```

## 19. Test Matrix

Router unit coverage:

| Case                                | Expected                                 |
| ----------------------------------- | ---------------------------------------- |
| same local coordinator              | allowed by Local Route default           |
| different coordinator without grant | TARGET_NOT_REACHABLE                     |
| authorized remote target            | Relay Route selected                     |
| remote node offline                 | TARGET_NODE_OFFLINE / ROUTE_UNAVAILABLE  |
| self                                | SELF_MESSAGE_NOT_ALLOWED                 |
| unknown handle                      | TARGET_NOT_REACHABLE                     |
| payload too large                   | MESSAGE_TOO_LARGE                        |
| duplicate messageId                 | previous receipt, no duplicate injection |
| concurrent same target              | FIFO                                     |
| concurrent different targets        | parallel delivery allowed                |

Mode coverage must implement the full matrix in section 8. Bridge scheduler tests must prove a message request executes before a pending normal prompt settles, while two messages for one session remain ordered.

Codex E2E coverage:

- active regular turn steer;
- active review turn rejects steer;
- idle + auto starts prompt;
- turn-completion race;
- two peer messages FIFO;
- clientUserMessageId equals xacpx messageId;
- interrupt mode;
- queue mode never steers.

Cross-agent coverage:

- Codex A -> Claude B and Claude B -> Codex A;
- queue fallback and reply path if Claude has no steer.

Remote coverage:

- same-account node A -> Relay -> node B online delivery;
- offline fail-fast;
- reconnect/retry dedupe;
- per-pair FIFO;
- forged account/node fields do not override authenticated source;
- target remote policy denial;
- no cwd/private metadata leak.

Cross-account coverage:

- no grant means invisible/unreachable;
- endpoint-scoped grant leaves others hidden;
- revoke blocks future delivery;
- remote interrupt can be denied separately.

## 20. Definition of Done — Local/realtime v0.1

- agent_list lists managed endpoints in the authorized local messaging scope.
- agent_send has no from input; sender identity is unforgeable.
- It is one-way and never waits for peer model response.
- Busy non-steerable target queue fallback works.
- Codex busy regular turn supports same-turn steer.
- Codex non-steerable turns yield explicit errors.
- steer never silently falls back; auto never auto-interrupts.
- Per-target FIFO and idempotent injection effect exist.
- Local scope authorization is enforced.
- Canonical nodeId + endpointId is in the domain model; Local code does not require same daemon as a protocol premise.
- Structured delivery logs exist.
- Windows and Unix local control-plane tests exist.
- Existing Task Orchestration tests have no regressions.
- MCP docs explain peer message versus delegate task.

The first demo is two Codex sessions: reviewer A and implementer B. While B runs a long authentication refactor, A invokes mode=steer with a refresh-token race warning. Trace must show message id, source/target, requestedMode=steer, modeUsed=steer, same target turn id before/after and latency; B observes xacpx-message in the existing turn and changes direction. This demonstrates Agent Messaging is not a prompt queue.

## 21. Risks and Mitigations

| Risk                                     | Mitigation                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| ACP lacks a unified steer primitive      | capability-driven implementation; never pretend uniform support                     |
| codex-acp/claude adapter needs extension | upstream probe first; queue fallback always works                                   |
| Agent loops/flood                        | limits, pending cap, no-auto-ACK guidance                                           |
| two prompt queues cause ordering bugs    | xacpx routes only; acpx owns execution queue                                        |
| external host seems injectable           | receive=false and clear documentation                                               |
| steer race targets wrong turn            | owner-side atomic active-turn lookup + steer                                        |
| remote text expands tool-risk surface    | grants, endpoint policy, target second authorization, separate interrupt permission |
| directory leaks metadata                 | minimized published endpoint schema                                                 |
| retry injects twice                      | global messageId + target receipt dedupe                                            |
| offline stale control message            | fail-fast agent_send; separate agent_mail                                           |
| Relay gains provider knowledge           | Relay routes envelope only; target daemon/acpx remains injection authority          |

## 22. Decision Summary

| Decision                 | Choice                                            |
| ------------------------ | ------------------------------------------------- |
| Public abstraction       | Agent Messaging                                   |
| MCP tools                | agent_list, agent_send                            |
| Response model           | one-way + delivery ACK                            |
| Default delivery         | auto                                              |
| Automatic interrupt      | never                                             |
| Same-turn capability     | optional/capability-driven                        |
| First local scope        | same coordinator policy                           |
| Canonical address        | nodeId + endpointId                               |
| Location model           | Local/Relay share the same public API             |
| Remote transport         | existing Relay Hub persistent WSS                 |
| Cross-OS-user            | cross-node through Relay; no local ACL relaxation |
| Cross-account            | explicit peer link/grant + target authorization   |
| Offline agent_send       | fail; no store-and-forward                        |
| Durable async            | separate future agent_mail                        |
| Sender identity          | server-derived                                    |
| Task integration         | separate subsystem                                |
| Busy non-steerable auto  | queue fallback                                    |
| Strict steer unsupported | typed failure, no silent fallback                 |
| Ordering                 | per (sourceAddress, targetAddress) FIFO           |
| Active-turn owner        | acpx queue owner/adapter                          |
| xacpx activeTurnId cache | not required                                      |
| Direct acpx queue socket | avoid                                             |
| First realtime provider  | Codex                                             |

## 23. References

Repository:

- xacpx source and current files listed in sections 2 and 18.
- acpx persistent sessions: https://acpx.sh/sessions.html
- acpx session controls: https://acpx.sh/session-control.html
- acpx CLI reference: https://github.com/openclaw/acpx/blob/main/docs/CLI.md
- Codex App Server turn/steer: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- codex-acp adapter: https://github.com/agentclientprotocol/codex-acp
- Claude Agent SDK persistent client: https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py
- Gemini CLI ACP mode: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md

The long-term boundary remains:

```
MCP                = Agent-facing messaging API
AgentAddress       = location-independent identity
source daemon      = caller identity + route selection
Relay Hub          = authenticated remote directory + routing broker
target daemon      = destination policy + final injection authority
acpx queue owner   = live session / active-turn owner
adapter            = provider-specific steering implementation
```
