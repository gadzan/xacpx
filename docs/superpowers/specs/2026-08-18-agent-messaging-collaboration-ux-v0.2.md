# Agent Messaging Collaboration v0.2 — User Interaction & Relay Web UX Spec

> **Status:** Approved for Implementation  
> **Date:** 2026-08-18  
> **Scope:** Same-account Agent collaboration only. No cross-account collaboration, no durable mail, no realtime steering dependency.

────────

## 1. Product Goal

Agent Messaging should feel like a normal collaboration capability inside xacpx, not like a messaging protocol the user must manually operate.

The user should be able to tell the current Agent:

• “去问 Backend 这个字段能不能删。”  
• “把这个 breaking change 告诉前端 Agent。”  
• “你跟 Reviewer 对一下这个方案。”  
• In Relay Web: “跟 @Backend 对一下这个接口。”  

The current Agent then uses Agent Messaging internally to discover or resolve the correct peer and send a point-to-point message.

The user must not need to know:

• nodeId  
• endpointId  
• session IDs  
• conversationId  
• routing handles  
• Relay protocol details  

────────

## 2. Core Design Principles

### 2.1 System-maintained state, not Agent-maintained state

Any state that affects identity, discoverability, reachability, session lifecycle, working/idle/waiting state, Agent type, or workspace must be maintained or derived automatically by xacpx.

Do not require an Agent to call tools such as `set_activity`, `set_status`, or `update_presence` before or after work.

Agents may forget, fail, crash, or ignore the instruction. Collaboration correctness must not depend on model discipline.

### 2.2 Discovery is advisory; lifecycle and reachability are authoritative

Activity such as `idle` / `working` / `waiting` is useful for deciding who to contact, but it must not be treated as a lock or strong synchronization primitive.

The system must distinguish three independent concepts:

```text
Session Lifecycle
Activity
Reachability
```

These must not be collapsed into a single enum.

────────

## 3. Session State Model

### 3.1 Session Lifecycle

```ts
type SessionLifecycle =
  | "active"
  | "sleeping"
  | "archived";
```

#### active
The session participates in Agent collaboration. It may be currently visible in Relay Web, in the background, idle, working, or waiting.
An active session is eligible for discovery if its hosting daemon is online.

#### sleeping
The session still exists, but the user has explicitly removed it from active collaboration.
Rules:
• Relay Web may still display it.
• `agent_list` must not return it.
• Relay Web `@Agent` autocomplete must not return it.
• Peer messages must not automatically wake it.
• Direct stale-handle delivery must fail closed.

#### archived
The session has exited the active collaboration lifecycle.
Rules:
• Relay Web may display it in an archive/history section.
• It is never discoverable by Agents.
• It is never selectable in `@Agent` autocomplete.
• It cannot receive Agent Messaging.
• It is not automatically reactivated.

### 3.2 Activity

```ts
type AgentActivityStatus =
  | "idle"
  | "working"
  | "waiting";

interface AgentActivityView {
  status: AgentActivityStatus;
  summary?: string;
}
```

Activity is always system-derived.

#### Worker endpoint
Use existing orchestration state:
• `running` → `working`
• `isAttentionRequiredTask(task)` → `waiting`
• no active task → `idle`

Only use existing safe summary metadata: `task.summary`. Do not fall back to the raw task prompt/body.

#### Ordinary logical session
If no orchestration task exists:
• active turn → `working`
• no active turn → `idle`
• activity summary may be omitted

Do not invent a work summary from user prompts or transcripts.

### 3.3 Reachability

```ts
type Reachability =
  | "online"
  | "offline";
```

`offline` is not a session lifecycle state. It means the daemon / Relay instance hosting the session cannot currently be reached.

Examples:
• machine is offline
• xacpx daemon is stopped
• Relay socket is disconnected
• instance is unreachable

An active session may therefore be:
```text
lifecycle = active
activity = idle
reachability = offline
```
Its last activity value is stale and must not be considered authoritative while offline.

────────

## 4. Discoverability Rules

Agent discovery must use one canonical truth shared by:
• MCP `agent_list`
• `agent_send` target resolution
• Relay Web `@Agent` autocomplete

The source of truth should remain the Agent endpoint registry / published endpoint directory.

The basic rule:
```ts
discoverable =
  lifecycle === "active"
  && reachability === "online";
```

Activity does not decide discoverability.

| Lifecycle | Reachability | Activity | Discoverable |
|---|---|---|---|
| active | online | idle | yes |
| active | online | working | yes |
| active | online | waiting | yes |
| active | offline | any | no |
| sleeping | online | any | no |
| archived | any | any | no |

Relay Web may display sleeping, archived, and offline sessions to humans, but Agents must not discover them.

────────

## 5. Agent Identity & Display Model

Internal routing identity remains opaque and stable:
```ts
interface AgentAddress {
  nodeId: string;
  endpointId: string;
}
```

The user and model should instead see a compact discovery identity:
```ts
interface PeerAgentView {
  handle: string;
  displayName: string;
  agent: string;
  workspace?: string;
  activity: AgentActivityView;
}
```

### 5.1 displayName derivation
Do not create a separate Agent-profile database. Prefer existing metadata:
```text
worker.role → session.alias / display name → agent type fallback
```
`displayName` is not unique.

### 5.2 Agent type
Always expose the actual Agent / driver family (`Codex`, `Claude`, `OpenCode`, etc.).

### 5.3 Workspace
Logical workspace name (e.g. `xacpx`, `acpx`, `frontend`, `backend`, `billing`). Never expose absolute CWD.

### 5.4 Duplicate names
Duplicate `displayName` values are allowed.
Normal display:
```text
Backend · Codex · xacpx
Backend · Claude · billing
```
If still ambiguous:
```text
Backend · Codex · xacpx
MacBook Pro

Backend · Codex · xacpx
Dev Server
```
The Relay instance alias is only a final disambiguation hint.

────────

## 6. Compact Agent Presentation

Normal `agent_list` textual presentation should be compact:
```text
Peers:

1. Backend · Codex · xacpx
   working — Refactoring authentication

2. Frontend · Claude · xacpx
   working

3. Tests · Codex · xacpx
   idle
```

────────

## 7. Do Not Depend on agent_list as a Hard Prerequisite

`agent_send` supports deterministic target resolution:
```ts
type AgentTarget =
  | { handle: string }
  | {
      selector: {
        displayName?: string;
        workspace?: string;
        agent?: string;
      };
    };
```

Resolution rules:
```text
0 matches → TARGET_NOT_FOUND
1 match   → send
>1 matches → TARGET_AMBIGUOUS (returns compact candidate metadata)
```

────────

## 8. Relay Web as the Primary Human Collaboration Surface

Agent Messaging integrates directly into Relay Web's existing session chat UI rather than creating a separate collaboration dashboard.

────────

## 9. Structured @Agent Mentions in Relay Web

Relay Web supports Agent autocomplete in the message composer.

Transport representation:
```ts
{
  text: "你去跟 @Backend 对一下 legacy_id 到底删不删，我先继续改 auth。",
  agentMentions: [
    {
      range: [4, 12],
      handle: "agent:node_x:endpoint_y"
    }
  ]
}
```

────────

## 10. Trusted Collaboration Directive

Relay Web mention metadata is converted by xacpx into a trusted internal collaboration directive:
```xml
<xacpx-collaboration-directive>
  <target
    handle="agent:node_x:endpoint_y"
    display-name="Backend"
    agent="codex"
    workspace="xacpx"
  />
</xacpx-collaboration-directive>
```
• Raw user text is never parsed as privileged collaboration XML.
• The directive is constructed from trusted structured metadata.
• Injected through an internal context path owned by xacpx.

────────

## 11. Relay Web @Agent Autocomplete Source

Autocomplete uses the exact same discovery truth as MCP:
• Includes: `active + online + (idle | working | waiting)`
• Excludes: `sleeping`, `archived`, `offline`

────────

## 12. Background Session Auto-Activation

• **Active + idle + online**: Injects peer message → starts normal prompt turn → session becomes `working` → Relay Web updates live state.
• **Active + working + online**: Queued for next turn.
• **Sleeping / archived**: Delivery fails closed (`TARGET_NOT_AVAILABLE`).
• **Offline**: Fails closed (`TARGET_NODE_OFFLINE`).

────────

## 13. Relay Web Session Tree Behavior

Human visibility $\neq$ Agent discoverability. Offline / sleeping sessions remain visible to humans (e.g. disabled/greyed out), but excluded from Agent discovery and `@Agent` autocomplete.

────────

## 14. Agent Messaging as First-Class Chat Timeline Events

Sender and receiver timelines render dedicated structured collaboration event cards (not ordinary user/assistant messages).

Sender card:
```text
┌────────────────────────────────────┐
│ → Sent to Backend · Codex · xacpx  │
│                                    │
│ User schema changed:               │
│ legacy_id has been removed.        │
│                           22:46    │
└────────────────────────────────────┘
```

Receiver card:
```text
┌────────────────────────────────────┐
│ ← From Reviewer · Claude · xacpx   │
│                                    │
│ User schema changed:               │
│ legacy_id has been removed.        │
│                           22:46    │
└────────────────────────────────────┘
```

────────

## 15. Peer Message History Persistence

• **Diagnostic Trace**: Metadata-only in-memory ring buffer (SHA-256 hash, length, timestamps, no body).
• **Session Chat History**: First-class `kind: "agent_message"` history entry with full content for UI timeline reconstruction across page refresh.

────────

## 16. Background Visibility & Unread State

Reuses existing account-wide WebSocket subscriptions to immediately update session `working` and unread badges upon message arrival and turn start.

────────

## 17. User Interaction Model

1. **Natural language**: User says "去问 Backend 这个字段能不能删", Agent calls `agent_send` with `selector`.
2. **Explicit mention**: User types `@Backend`, Relay Web supplies structured mention metadata, Agent receives directive and initiates `agent_send`.

────────

## 18. Engineering Invariants

1. No Agent-written presence state
2. No raw session IDs in normal discovery UX
3. No dependency on `agent_list` before every send
4. No `@name` parsing as trusted identity
5. No waking sleeping/archived sessions
6. No offline store-and-forward
7. Foreground state does not control collaboration eligibility
8. Relay Web and MCP share one discovery truth
9. Sender and receiver both receive persistent peer-message timeline events
10. Agent Messaging remains point-to-point
11. Current Agent remains the sender for user-directed `@Agent` collaboration
12. Debug trace and chat-history content storage remain separate concerns

────────

## 19. Out of Scope

• Cross-account / cross-user collaboration  
• Durable Agent Mail / offline store-and-forward  
• Realtime same-turn Steering  
• Direct human-to-peer bypass through `@Agent`  
• Broadcast / group chat / pub/sub  
• Agent-controlled status updates  
