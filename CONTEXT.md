# xacpx

WeChat/relay 控制台，把聊天消息桥接到 acpx 代理会话。本文件只做术语表，不含实现细节。

## Language

### Agent Messaging

**Agent Messaging**:
xacpx 管理的 Agent session 之间的单向实时通信能力。它传递的是“请继续按自己的工作流处理这条信息”，不创建 Task，也不等待对端 Agent 的模型回答。
_Avoid_: 把它称为 delegate、Task 或同步 RPC。

**Messaging Node**:
持有一个 xacpx Agent Messaging runtime 的稳定安全域，通常对应一个 xacpx home 与 daemon，而不是 daemon PID、主机名或 OS 用户。

**Agent Endpoint**:
一个由 xacpx/acpx 控制面管理、可被寻址的逻辑 Agent session。Endpoint 的身份跨 turn 保持稳定；它是否能接收、steer、排队或中断由 capability 单独表达。

**Agent Address**:
Endpoint 的内部 canonical identity，由稳定的 Messaging Node identity 和 Endpoint identity 组成。它不含 cwd、PID、OS UID/SID 或 provider-native turn/thread id。

**Agent Handle**:
Agent 在 MCP tool 中使用的 opaque、可路由标识符。调用方只能将其传回 xacpx，不应解析其格式。

**Live delivery**:
目标 runtime 已接受一次实时注入或 next-turn queue 的 delivery 语义；它不表示目标 Agent 已理解、完成或回复。目标 node 不在线时 live delivery 失败，而不会延迟投递。

**Agent Mail**:
未来可选的 store-and-forward 异步通信语义，包含 inbox、TTL 和 read/ack。它与 Agent Messaging 的 live delivery 语义不同，不能作为 agent_send 的离线降级。

### 会话生命周期

**睡眠（Sleep）**:
用户主动让逻辑会话休眠：立即关闭其代理进程，但保留完整对话历史，之后可唤醒继续。面向用户的唯一叫法；代码与 RPC 协议层仍沿用 archive/archived 标识符（仅作为线上兼容的遗留拼写）。
_Avoid_: 归档、Archive（用户可见文案中）

**唤醒（Wake）**:
把睡眠中的会话恢复为可用状态。不启动进程——下一条消息到达时才冷启动。
_Avoid_: 取消归档、Unarchive（用户可见文案中）

**热（Warm）**:
会话的代理进程驻留在后台，下一条消息即时响应。
_Avoid_: 在线、running（running 专指有轮次在执行）

**冷（Cold）**:
会话的代理进程已退出（TTL 到期、睡眠或其他原因），下一条消息需要冷启动。不区分退出原因。睡眠中的会话必然是冷的。
_Avoid_: 过期、已关闭、offline
