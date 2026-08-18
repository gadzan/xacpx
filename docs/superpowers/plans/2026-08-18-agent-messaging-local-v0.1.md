# Agent Messaging — Local Queue-First v0.1 Implementation Plan

> Execution order: 2 of 3. This plan can proceed while the steering spike is
> running, but its public capabilities remain queue=true, steer=false.

**Goal:** Ship local Agent Messaging for xacpx-managed sessions: stable
node/endpoint identity, authorized agent_list, one-way agent_send, immediate
queue acceptance, replies through replyTo, per-target FIFO, idempotent
injection effect, limits, typed errors, and structured logs.

**Architecture:** AgentMessageRouter is the deep module. Its interface is only
listReachable(senderBinding) and send(senderBinding, input). The state-backed
AgentEndpointRegistry, handle codec, envelope renderer, FIFO, dedupe, rate
limits, and local delivery are implementation details. Agent Messaging shares
the existing orchestration IPC socket but does not become part of
OrchestrationService or create orchestration tasks.

**Spec:** [Agent Messaging design](../specs/2026-08-11-agent-messaging-design.md)

**Prerequisite:** None from the steering spike. This plan uses acpx 0.13.0
queue-owner acknowledgement through prompt --no-wait.

**Execution status (2026-08-18):** Implemented in the current xacpx worktree.
The local typecheck, focused Agent Messaging suites, full core unit suite,
relay-web suite, and production build pass. The repository's default 180-second
per-step test wrapper is shorter than this machine's 261-second relay-web run,
so the web suite was also verified directly (117 files / 1130 tests). Real
Codex steering, smoke tests, and Windows CI remain outside this queue-first
gate; no realtime capability is advertised.

## Scope

Included:

- Local Route only.
- Same-coordinator discovery/authorization.
- Internal logical coordinators and orchestration workers as receive-capable
  endpoints.
- External MCP coordinators as send-capable but receive=false identities.
- mode=auto and mode=queue, both delivered through the acpx next-turn queue.
- mode=steer and mode=interrupt return typed unsupported errors in this
  milestone.
- Both acpx-cli and acpx-bridge transports.

Excluded:

- Provider steering.
- Remote/Relay routes and remote directory.
- Cross-account trust.
- Durable mail.
- Message history UI.

## Decisions Resolved by This Plan

### Stable identities

- Messaging node identity is stored separately at
  <xacpx-home>/agent-messaging/node.json.
- The node file is versioned, written atomically with mode 0600, and created
  once per xacpx home.
- Internal logical-session endpointId reuses LogicalSession.logical_session_id.
- WorkerBindingRecord gains agentEndpointId; legacy bindings are migrated once
  and durably persisted before startup returns.
- ExternalCoordinatorRecord gains agentEndpointId so an external MCP
  coordinator has a stable canonical sender address, while receive remains
  false.

### Handles

Local public handles use this daemon-owned codec:

```
agent:<nodeId>:<endpointId>
```

The format is not a client contract. Only AgentEndpointRegistry may encode or
decode it; MCP descriptions explicitly say handles are opaque.

### Queue acknowledgement

The queue milestone moves the message lane earlier than the design roadmap:

1. Bridge/CLI injection ensures the existing managed MCP queue owner is warm.
2. It invokes acpx prompt with --no-wait.
3. It returns only after the owner accepts the prompt.

This is a queue acceptance, not a model response. The result is always:

```
{ status: "queued", modeUsed: "queue" }
```

Even when an idle owner begins draining immediately, this milestone does not
perform a racy preflight to relabel the receipt as prompt/injected. The
realtime acpx inject primitive will later return authoritative target state.

### Endpoint truth

There is no second mutable endpoint database:

- Logical endpoints derive from AppState.sessions.
- Worker endpoints derive from AppState.orchestration.workerBindings.
- External sender identities derive from externalCoordinators.
- Existing create/reuse/delete lifecycle is the source of truth.

AgentEndpointRegistry is a state-backed resolver, not a second registry that
must be kept synchronized by register/unregister calls.

## Public and Internal Interfaces

Create src/orchestration/agent-messaging-types.ts with:

```
type AgentMessageMode = "auto" | "steer" | "queue" | "interrupt";

interface AgentAddress {
  nodeId: string;
  endpointId: string;
}

interface AgentCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
}

interface AgentEndpointView {
  address: AgentAddress;
  handle: string;
  node: string;
  agent: string;
  workspace?: string;
  displayName?: string;
  state: "idle" | "running" | "unreachable";
  capabilities: AgentCapabilities;
}

interface AgentMessageReceipt {
  messageId: string;
  status: "injected" | "queued" | "failed";
  modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
  route: "local" | "relay";
  targetState?: "idle" | "running";
  deduplicated?: boolean;
  errorCode?: AgentMessagingErrorCode;
}
```

Internal sender binding:

```
interface AgentSenderBinding {
  coordinatorSession: string;
  sourceHandle?: string;
}
```

Session transport addition:

```
interface SessionMessageInput {
  text: string;
  messageId: string;
  mode: AgentMessageMode;
}

interface SessionMessageReceipt {
  status: "injected" | "queued";
  modeUsed: "steer" | "queue" | "interrupt" | "prompt";
  targetState?: "idle" | "running";
}

SessionTransport.injectMessage?(
  session: ResolvedSession,
  input: SessionMessageInput,
): Promise<SessionMessageReceipt>;
```

SessionMessageInput, SessionMessageReceipt, and transport-level injection
errors live in src/transport/message-injection.ts. AgentMessagingError remains
in the orchestration domain and maps transport failures at the Router seam.
Bridge modules must not import orchestration error classes.

The optional method keeps unrelated test transports source-compatible.
Production acpx-cli and acpx-bridge must both implement it before MCP tools are
wired.

## Global Constraints

- Message maximum is 16 KiB measured with Buffer.byteLength(content, "utf8").
- replyTo maximum is 128 bytes and must contain only opaque-id-safe characters.
- Per-target pending delivery cap defaults to 32.
- Short-window sender-to-target rate limit is configurable through injected
  router limits; do not add a public config key in this milestone.
- Logs never include full content.
- Self messaging is rejected.
- Unknown, unauthorized, and cross-coordinator handles all return
  TARGET_NOT_REACHABLE.
- Agent Messaging never calls OrchestrationService task methods.
- The task-orchestration golden suite must remain unchanged.
- No Relay interface/stub is added yet. Canonical addresses accept remote
  nodes, and Local delivery returns ROUTE_UNAVAILABLE for a different node.

## Task 0: Baseline and Characterization

**Files:**

- Read: src/state/types.ts
- Read: src/state/state-store.ts
- Read: src/orchestration/orchestration-types.ts
- Read: src/orchestration/service/coordinator-registry-service.ts
- Read: src/orchestration/service/worker-session-manager.ts
- Read: src/main.ts
- Read: src/mcp/xacpx-mcp-server.ts
- Read: src/bridge/bridge-request-scheduler.ts
- Read: src/bridge/bridge-runtime.ts
- Read: src/transport/acpx-cli/acpx-cli-transport.ts
- Read: src/transport/acpx-bridge/acpx-bridge-transport.ts

- [ ] Run the current focused baselines:

```
bun test tests/unit/state/state-store.test.ts
bun test tests/unit/orchestration/orchestration-server.test.ts
bun test tests/unit/orchestration/orchestration-client.test.ts
bun test tests/unit/mcp/xacpx-mcp-tools.test.ts
bun test tests/unit/bridge/bridge-request-scheduler.test.ts
bun test tests/unit/bridge/bridge-server.test.ts
bun test tests/unit/transport/acpx-cli/acpx-cli-transport.test.ts
bun test tests/unit/transport/acpx-bridge/acpx-bridge-transport.test.ts
npx tsc --noEmit
```

- [ ] Confirm acpx 0.13.0 accepts --no-wait after a managed queue owner is
      pre-launched.
- [ ] Confirm working-tree changes are only the approved documentation changes.
- [ ] Do not commit a baseline-only change.

## Task 1: Add Domain Types, Errors, and Handle Codec

**Files:**

- Create: src/orchestration/agent-messaging-types.ts
- Create: src/orchestration/agent-messaging-error.ts
- Create: src/orchestration/agent-handle.ts
- Create: tests/unit/orchestration/agent-handle.test.ts

- [ ] Write failing tests for round-trip local handles.
- [ ] Write failing tests for malformed, foreign-node, empty, and overlong
      handles.
- [ ] Define AgentMessagingError with a readonly code.
- [ ] Define the v0.1 error-code union:

```
TARGET_NOT_REACHABLE
TARGET_UNAVAILABLE
ROUTE_UNAVAILABLE
TARGET_NOT_STEERABLE
TARGET_NOT_INTERRUPTIBLE
MESSAGE_TOO_LARGE
MESSAGE_QUEUE_FULL
MESSAGE_RATE_LIMITED
SELF_MESSAGE_NOT_ALLOWED
DELIVERY_TIMEOUT
DELIVERY_FAILED
DELIVERY_DENIED
```

- [ ] Keep public endpoint types free of cwd, PID, OS identity, sourceHandle,
      transport session, and native session id.
- [ ] Make handle parsing return a value/result; only the router converts it
      into a public error.
- [ ] Run:

```
bun test tests/unit/orchestration/agent-handle.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): define local message domain

## Task 2: Persist Node and Endpoint Identity

**Files:**

- Create: src/orchestration/messaging-node-identity-store.ts
- Create: tests/unit/orchestration/messaging-node-identity-store.test.ts
- Modify: src/orchestration/orchestration-types.ts
- Modify: src/orchestration/worker-launch.ts
- Modify: src/orchestration/service/coordinator-registry-service.ts
- Modify: src/orchestration/service/human-delegation-service.ts
- Modify: src/orchestration/service/rpc-delegation-service.ts
- Modify: src/orchestration/service/task-approval-service.ts
- Modify: src/orchestration/service/worker-session-manager.ts
- Modify: src/state/state-store.ts
- Modify: tests/unit/state/state-store.test.ts
- Modify: tests/unit/state/types.test.ts
- Modify: affected orchestration leaf-module tests.

Node identity file:

```
{
  "version": 1,
  "nodeId": "node_<uuid>"
}
```

- [ ] Test concurrent loadOrCreate calls return one persisted id.
- [ ] Test restart/load returns the same id.
- [ ] Test a malformed existing identity file fails closed.
- [ ] Test the file is private on POSIX.
- [ ] Add agentEndpointId to WorkerBindingRecord and
      ExternalCoordinatorRecord.
- [ ] Preserve the previous endpoint id whenever a reusable binding is
      replaced.
- [ ] Generate a new endpoint id only for a genuinely new binding.
- [ ] Ensure ephemeral worker bindings get unique endpoint ids.
- [ ] Extend StateStore migration parsing so missing endpoint ids are assigned
      once, reported under migrated, and persisted before load returns.
- [ ] Keep StateStore.inspect side-effect free.
- [ ] Add fail-closed migration-write tests.
- [ ] Add collision tests: no two current logical sessions, worker bindings, or
      external coordinators may expose the same canonical endpoint address.
- [ ] Run:

```
bun test tests/unit/orchestration/messaging-node-identity-store.test.ts
bun test tests/unit/state/state-store.test.ts
bun test tests/unit/state/types.test.ts
bun test tests/unit/orchestration/service/coordinator-registry-service.test.ts
bun test tests/unit/orchestration/service/worker-session-manager.test.ts
bun test tests/unit/orchestration/service/human-delegation-service.test.ts
bun test tests/unit/orchestration/service/rpc-delegation-service.test.ts
bun test tests/unit/orchestration/service/task-approval-service.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): persist node and endpoint identity

## Task 3: Implement the State-Backed Endpoint Registry

**Files:**

- Create: src/orchestration/agent-endpoint-registry.ts
- Create: tests/unit/orchestration/agent-endpoint-registry.test.ts

Interface:

```
class AgentEndpointRegistry {
  resolveSender(binding: AgentSenderBinding): Promise<ResolvedAgentIdentity>;
  listReachable(binding: AgentSenderBinding): Promise<AgentEndpointView[]>;
  resolveTarget(
    sender: ResolvedAgentIdentity,
    handle: string,
  ): Promise<ResolvedAgentEndpoint>;
}
```

ResolvedAgentEndpoint is internal and may contain a discriminated runtime
binding for logical-session or worker-session delivery. It must never cross
IPC/MCP.

- [ ] Resolve a worker sender from sourceHandle and validate that its persisted
      coordinatorSession matches the supplied binding.
- [ ] Resolve an internal coordinator from the logical session whose
      transport_session matches coordinatorSession.
- [ ] Resolve an external coordinator from externalCoordinators, with
      receive=false.
- [ ] List only targets with the same stable coordinator session.
- [ ] Include the internal coordinator target plus all current worker bindings.
- [ ] Exclude self by canonical address.
- [ ] Exclude external coordinators as receive targets.
- [ ] Derive logical endpoint id from logical_session_id.
- [ ] Derive worker endpoint id from agentEndpointId.
- [ ] Publish only workspace config key/display label, never cwd.
- [ ] Mark a worker running when a matching active task is in its live prompt
      state; otherwise mark it idle.
- [ ] Accept a foreign-node canonical handle syntactically, then return
      ROUTE_UNAVAILABLE rather than TARGET_NOT_FOUND.
- [ ] Make unknown, unauthorized, and cross-coordinator local handles
      indistinguishable as TARGET_NOT_REACHABLE.
- [ ] Test coordinator -> worker, worker -> coordinator, worker -> peer worker,
      different coordinator, self, external sender, stale binding, missing
      workspace/agent, and foreign node.
- [ ] Run:

```
bun test tests/unit/orchestration/agent-endpoint-registry.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): resolve authorized local endpoints

## Task 4: Add the Bridge Message Lane and Queue Injection

**Files:**

- Create: src/transport/message-injection.ts
- Modify: src/transport/acpx-bridge/acpx-bridge-protocol.ts
- Modify: src/bridge/bridge-request-scheduler.ts
- Modify: src/bridge/bridge-server.ts
- Modify: src/bridge/bridge-runtime.ts
- Modify: tests/unit/bridge/bridge-request-scheduler.test.ts
- Modify: tests/unit/bridge/bridge-server.test.ts
- Modify: tests/unit/bridge/bridge-runtime.test.ts
- Modify: tests/unit/transport/acpx-bridge/bridge-protocol.test.ts

Scheduler state becomes:

```
normalTail     // prompt and management serial flow
messageTail    // peer deliveries, FIFO with each other
control        // immediate, no tail
```

- [ ] Write the failing scheduler test: one normal request remains pending while
      the first message request starts and completes.
- [ ] Write the failing scheduler test: two message requests for one session
      execute FIFO.
- [ ] Prove different-session message requests progress independently.
- [ ] Add injectMessage to BridgeMethod and SESSION_SCOPED_METHODS.
- [ ] Route injectMessage to the message lane.
- [ ] Strictly parse text, mode, and messageId.
- [ ] Define MessageInjectionError and its transport-level codes without
      importing orchestration modules.
- [ ] Add BridgeRuntime.injectMessage for auto/queue only.
- [ ] Reuse effort synchronization and managed MCP queue-owner prelaunch.
- [ ] Invoke acpx prompt with --no-wait; do not attach streaming handlers.
- [ ] Return queued/queue only after command success.
- [ ] Map steer to TARGET_NOT_STEERABLE and interrupt to
      TARGET_NOT_INTERRUPTIBLE without spawning acpx.
- [ ] Bound queue-injection command duration with the management timeout.
- [ ] Verify the generated argv includes --no-wait and the target session.
- [ ] Verify the message lane is not blocked by a normal prompt.
- [ ] Run:

```
bun test tests/unit/bridge/bridge-request-scheduler.test.ts
bun test tests/unit/bridge/bridge-server.test.ts
bun test tests/unit/bridge/bridge-runtime.test.ts
bun test tests/unit/transport/acpx-bridge/bridge-protocol.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): add bridge message lane

## Task 5: Expose Queue Injection Through Both Session Transports

**Files:**

- Modify: src/transport/types.ts
- Modify: src/transport/message-injection.ts
- Modify: src/transport/acpx-command-builder.ts
- Modify: src/transport/acpx-cli/acpx-cli-transport.ts
- Modify: src/transport/acpx-bridge/acpx-bridge-transport.ts
- Modify: tests/unit/transport/acpx-command-builder.test.ts
- Modify: tests/unit/transport/acpx-cli/acpx-cli-transport.test.ts
- Modify: tests/unit/transport/acpx-bridge/acpx-bridge-transport.test.ts
- Modify: tests/unit/transport/golden/cli-argv-oracle.test.ts only if the
  existing oracle intentionally covers the new method; do not rewrite
  unrelated prompt fixtures.

- [ ] Re-export/use SessionMessageInput and SessionMessageReceipt from the
      transport-level module and add optional SessionTransport.injectMessage.
- [ ] Add one shared command-builder helper for prompt --no-wait so CLI and
      Bridge argv cannot drift.
- [ ] Implement AcpxCliTransport.injectMessage with the same managed queue-owner
      prelaunch used by prompt.
- [ ] Implement AcpxBridgeTransport.injectMessage as one bridge request with no
      prompt streaming/event sink.
- [ ] Preserve mcpCoordinatorSession and mcpSourceHandle in both transports so
      the target owner retains its own MCP sender identity.
- [ ] Return only queue acceptance; never return agent output.
- [ ] Reject unsupported modes with typed errors before running a command.
- [ ] Test CLI command success, non-zero exit, timeout, missing session, and
      unsupported modes.
- [ ] Test Bridge request params and receipt propagation.
- [ ] Run:

```
bun test tests/unit/transport/acpx-command-builder.test.ts
bun test tests/unit/transport/acpx-cli/acpx-cli-transport.test.ts
bun test tests/unit/transport/acpx-bridge/acpx-bridge-transport.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): expose queue injection transport

## Task 6: Implement AgentMessageRouter

**Files:**

- Create: src/orchestration/agent-message-envelope.ts
- Create: src/orchestration/agent-message-router.ts
- Create: tests/unit/orchestration/agent-message-envelope.test.ts
- Create: tests/unit/orchestration/agent-message-router.test.ts

External interface:

```
class AgentMessageRouter {
  listReachable(binding: AgentSenderBinding): Promise<AgentEndpointView[]>;
  send(
    binding: AgentSenderBinding,
    input: {
      to: string;
      content: string;
      mode?: AgentMessageMode;
      replyTo?: string;
    },
  ): Promise<AgentMessageReceipt>;
}
```

Injected local delivery port:

```
interface LocalAgentMessageDelivery {
  deliver(
    target: ResolvedAgentEndpoint,
    message: AgentMessage,
    renderedText: string,
  ): Promise<SessionMessageReceipt>;
}
```

Production implements the port through SessionTransport.injectMessage; tests
use an in-memory adapter. The router owns policy and message semantics, while
the adapter owns transport-session resolution and acpx invocation.

- [ ] Write envelope tests that XML-escape content and attributes, omit
      reply-to when absent, and cannot be broken by embedded closing tags.
- [ ] Generate msg\_<uuid> through an injected createId dependency.
- [ ] Validate content byte size and replyTo before target lookup.
- [ ] Resolve sender from the trusted binding; never accept from in input.
- [ ] Reject self messaging by canonical address.
- [ ] Resolve only Local Route in this milestone.
- [ ] Compute replyable from source receive capability plus reverse local
      authorization.
- [ ] Render the source as a target-local handle.
- [ ] Serialize all deliveries to the same target address, including different
      senders, while allowing different targets in parallel.
- [ ] Enforce pending depth before adding to a target tail.
- [ ] Enforce an injected sender-to-target rate limit.
- [ ] Add a bounded TTL receipt cache keyed by messageId.
- [ ] When the same generated messageId is seen again, return the cached
      receipt with deduplicated=true and do not invoke delivery again.
- [ ] Cache only terminal acceptance/failure receipts according to a documented
      retry policy; never cache an in-flight Promise after it settles by
      rejection without a receipt.
- [ ] Map transport failures to stable AgentMessagingError codes without
      leaking socket paths or command argv.
- [ ] Log agent.message.delivery with ids, addresses, requested mode, receipt,
      latency, contentLength, and error code; omit content.
- [ ] Cover the complete queue milestone matrix:

```
auto      -> queued/queue
queue     -> queued/queue
steer     -> TARGET_NOT_STEERABLE
interrupt -> TARGET_NOT_INTERRUPTIBLE
```

- [ ] Cover FIFO, cross-target parallelism, dedupe, depth cap, rate limit,
      oversize Unicode payload, replyTo, replyable=false external sender,
      transport timeout, and delivery failure.
- [ ] Run:

```
bun test tests/unit/orchestration/agent-message-envelope.test.ts
bun test tests/unit/orchestration/agent-message-router.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): route local peer messages

## Task 7: Add Typed agent.list and agent.send Daemon RPC

**Files:**

- Modify: src/orchestration/orchestration-ipc.ts
- Modify: src/orchestration/orchestration-client.ts
- Modify: src/orchestration/orchestration-server.ts
- Modify: tests/unit/orchestration/orchestration-client.test.ts
- Modify: tests/unit/orchestration/orchestration-server.test.ts

RPC methods:

```
agent.list
agent.send
```

Agent Messaging remains a separate module. Add it to OrchestrationServerDeps:

```
agentMessaging?: Pick<AgentMessageRouter, "listReachable" | "send">;
```

Do not add list/send methods to OrchestrationService.

- [ ] Extend OrchestrationRpcMethod and strict method allowlist.
- [ ] agent.list accepts only coordinatorSession and optional sourceHandle.
- [ ] agent.send accepts only coordinatorSession, optional sourceHandle, to,
      message, optional mode, and optional replyTo.
- [ ] Reject payload-provided from, nodeId, endpointId, accountId, busId, or
      arbitrary scope.
- [ ] Preserve AgentMessagingError.code in RPC error responses.
- [ ] Introduce OrchestrationClientError with readonly code; the client must no
      longer discard server error codes.
- [ ] Keep existing ORCHESTRATION_INVALID_REQUEST and
      ORCHESTRATION_INTERNAL_ERROR behaviour unchanged for Task RPC.
- [ ] Add OrchestrationClient.agentList and agentSend.
- [ ] Test strict parsing, sender binding forwarding, receipt forwarding,
      typed business error propagation, and absence of agentMessaging config.
- [ ] Run:

```
bun test tests/unit/orchestration/orchestration-server.test.ts
bun test tests/unit/orchestration/orchestration-client.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): add daemon message RPC

## Task 8: Add MCP agent_list and agent_send

**Files:**

- Modify: src/mcp/xacpx-mcp-transport.ts
- Modify: src/mcp/xacpx-mcp-tools.ts
- Modify: src/mcp/xacpx-mcp-server.ts
- Modify: tests/unit/mcp/xacpx-mcp-transport.test.ts
- Modify: tests/unit/mcp/xacpx-mcp-tools.test.ts
- Modify: tests/unit/mcp/xacpx-mcp-server.test.ts

MCP schemas:

```
agent_list: {}

agent_send: {
  to: string;
  message: string;
  mode?: "auto" | "steer" | "queue" | "interrupt";
  replyTo?: string;
}
```

- [ ] Add listAgentEndpoints and sendAgentMessage to XacpxMcpTransport and its
      memory adapter.
- [ ] Inject coordinatorSession/sourceHandle from the registry closure.
- [ ] Prove from/coordinatorSession/sourceHandle are rejected by strict tool
      input schemas.
- [ ] Return agent_list structuredContent as { agents }.
- [ ] Return agent_send structuredContent as the exact receipt.
- [ ] For AgentMessagingError, return isError=true plus:

```
{
  "error": {
    "code": "TARGET_NOT_REACHABLE",
    "message": "..."
  }
}
```

- [ ] Preserve existing human-readable content for clients that ignore
      structuredContent.
- [ ] Add peer-message guidance to XACPX_MCP_SERVER_INSTRUCTIONS.
- [ ] Include the provided from handle and replyTo guidance; explicitly say a
      reply is optional and pure acknowledgements should not be echoed.
- [ ] Advertise agent_list/agent_send to internal coordinators, workers, and
      external coordinators. The daemon authorization remains authoritative.
- [ ] Test one-way behaviour: tool resolution depends only on delivery ACK and
      never waits on a target-model Promise.
- [ ] Run:

```
bun test tests/unit/mcp/xacpx-mcp-transport.test.ts
bun test tests/unit/mcp/xacpx-mcp-tools.test.ts
bun test tests/unit/mcp/xacpx-mcp-server.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): expose peer message MCP tools

## Task 9: Wire Production Runtime and Prove End-to-End Queue Delivery

**Files:**

- Modify: src/main.ts
- Modify: tests/unit/main.test.ts
- Create: tests/unit/orchestration/agent-messaging-local-integration.test.ts
- Modify: relevant test transport fakes only where injectMessage is exercised.

Production wiring:

1. Load/create MessagingNodeIdentity before the orchestration IPC server starts.
2. Construct AgentEndpointRegistry over the current AppState snapshot.
3. Construct AgentMessageRouter with the registry, logger, limits, clock/id
   dependencies, and one LocalAgentMessageDelivery adapter.
4. Resolve logical targets with SessionService.getPreferredSessionForTransport.
5. Resolve worker targets with the existing resolveWorkerRuntimeSession helper.
6. Set target mcpCoordinatorSession and worker mcpSourceHandle before delivery.
7. Call SessionTransport.injectMessage.
8. Pass the router into OrchestrationServer deps.

- [ ] Do not store cwd or ResolvedSession in the public endpoint view.
- [ ] Return TARGET_UNAVAILABLE when a persisted binding cannot produce a
      current ResolvedSession.
- [ ] Add buildApp tests for stable node identity across restarts.
- [ ] Add buildApp tests for worker endpoint identity across owner restarts and
      worker reuse.
- [ ] Add an integration test with two worker bindings under one coordinator:
      A lists B, sends, and receives queued ACK.
- [ ] Keep B's current transport prompt unresolved while agent.send completes.
- [ ] Resolve B's current prompt, then assert the queued xacpx-message is the
      next acpx submission.
- [ ] Test worker B can list/reply to internal coordinator A.
- [ ] Test an external coordinator can send but injected envelope has
      replyable=false.
- [ ] Test another coordinator cannot discover or send to B.
- [ ] Test both acpx-cli and acpx-bridge production construction paths expose
      injectMessage.
- [ ] Run:

```
bun test tests/unit/orchestration/agent-messaging-local-integration.test.ts
bun test tests/unit/main.test.ts
npx tsc --noEmit
```

- [ ] Commit:
      feat(agent-messaging): wire local queue delivery

## Task 10: Hardening, Documentation, and Full Verification

**Files:**

- Modify: docs/external-mcp.md
- Modify: docs/config-reference.md only if implementation exposes limits as
  configuration; this plan defaults to internal constants.
- Modify: docs/code-wiki.md
- Modify: docs/superpowers/specs/2026-08-11-agent-messaging-design.md only for
  implementation-confirmed deviations.
- Modify: AGENTS.md only if the stable navigation entry needs adjustment.

- [ ] Document Agent Messaging versus Task Orchestration.
- [ ] Document queue-first capability output and unsupported steer/interrupt.
- [ ] Document sender derivation and same-coordinator local scope.
- [ ] Document that external MCP hosts are send-capable but not receive-capable.
- [ ] Document one-way ACK and replyTo.
- [ ] Confirm logs contain no message body, cwd, PID, OS user, IPC path, or
      native session id.
- [ ] Confirm the node identity file and local IPC permissions on POSIX.
- [ ] Run focused Windows path/named-pipe parsing tests on the current platform;
      run Windows CI before release.
- [ ] Run:

```
npx prettier --check \
  AGENTS.md \
  CONTEXT.md \
  docs/external-mcp.md \
  docs/code-wiki.md \
  docs/superpowers/specs/2026-08-11-agent-messaging-design.md \
  docs/superpowers/plans/2026-08-18-agent-messaging-local-v0.1.md
npx tsc --noEmit
npm test
bun run build
```

- [ ] Do not run smoke tests without a real acpx installation and configured
      WeChat environment.
- [ ] Commit:
      docs(agent-messaging): document local queue messaging

## Release Gate

Local queue-first is ready when:

- node and endpoint identities survive daemon restart;
- sender identity cannot be supplied by MCP input;
- agent_list is same-coordinator and excludes self/private metadata;
- agent_send returns after owner queue acceptance while the target turn remains
  active;
- target receives one escaped xacpx-message as its next prompt;
- per-target FIFO, dedupe, limits, typed errors, and safe logs pass;
- both production transports work;
- existing orchestration golden tests remain unchanged;
- full typecheck, unit tests, and build pass.

Do not claim same-turn realtime support at this gate. Advertise steer=false
until the realtime plan is complete.
