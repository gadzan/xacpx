# Direct 会话与消息节点 fork

状态：Proposed

范围：在现有 Group Topic fork 之上，增加 Direct Bot 会话的 fork，以及 Group/Direct 共同的消息节点边界。原生 Agent session fork 不在本期。

## 1. 问题

Group Topic 的 fork 是应用层消息快照。它成立的原因是 Group prompt 每轮都从 SQLite 重建，复制消息就等于复制上下文。

Direct 会话不同。`conversation-dispatcher.ts` 对 Direct turn 只传 `userText`，历史通过持久化的 Agent session 延续。复制消息到一个新 Topic 不会进入 prompt，模型看不到，分叉只剩界面效果。因此 Direct fork 必须把有界历史作为一次性上下文注入新 Topic 的第一个 prompt。

## 2. 三种 fork

| 形态 | 源 | 目标里有什么 | 上下文如何到达模型 |
|---|---|---|---|
| Group 快照 | Group Topic | 复制到边界的消息行 | 每轮从目标 Topic 重建 |
| Direct handoff | Direct Topic | 不复制消息行，只存待注入文本 | 新 Topic 的第一个 prompt 注入一次 |
| 原生 session fork | 任意 Agent session | Provider 原生分叉 | 需要 acpx 暴露 `session/fork` |

`forkedFrom.mode` 区分前两种。原生 fork 依赖上游，见第 6 节。

## 3. 数据模型

### 3.1 公共来源点

`ThreadForkSourcePointDto` 增加消息边界。

```ts
export type ThreadForkSourcePointDto =
  | { type: "latest_stable" }
  | { type: "run"; runId: string }
  | { type: "message"; messageId: string };
```

`message` 的边界是该消息的 `seq`。它不要求消息所属 Run 已结算。用户选中一条已经写入的消息，就得到该消息之前的可见历史。

### 3.2 fork 来源记录

`ConversationTopicFork` 增加两个字段。旧行缺少 `mode` 时按 `snapshot` 读取。

```ts
export type TopicForkMode = "snapshot" | "handoff";

export interface ConversationTopicFork {
  // 现有字段不变
  mode?: TopicForkMode;
  sourceMessageId?: string;
}
```

`copiedMessages` 在 `snapshot` 下是复制的消息数，在 `handoff` 下是注入文本包含的消息数。`omittedMessages` 在两种形态下都表示被预算截断的更早消息数。

### 3.3 Direct handoff 正文

`ConversationTopic` 增加一个 core-private 字段。它不进入 `TopicSummaryDto`，避免把内部 prompt 文本暴露给客户端。

```ts
export interface TopicForkHandoff {
  text: string;
  throughSeq: number;
  messageCount: number;
  omittedMessages: number;
}

export interface ConversationTopic {
  // 现有字段不变
  forkHandoff?: TopicForkHandoff;
}
```

`forkHandoff` 只在 `forkedFrom.mode === "handoff"` 时出现。它保存渲染后的有界文本，因此源 Topic 被删除后 fork 仍能工作。

### 3.4 状态校验

`state-store.ts` 的 `isConversationTopicFork` 接受可选 `mode` 与 `sourceMessageId`。新增 `isTopicForkHandoff`，检查 `text` 非空、`throughSeq`/`messageCount`/`omittedMessages` 是非负整数，并在 `isConversationTopic` 中校验 `forkHandoff`。非法 Topic 仍按现有逻辑丢弃，不把半损坏状态带进运行时。

## 4. Phase A，Direct portable fork

### 4.1 协议

新增一个 RPC，不改现有 Group RPC 的名称与 capability。

```text
control.direct.topics.fork
capability: direct.topics.fork.v1
payload: { conversationId, sourceTopicId, targetTopicId, requestId, sourcePoint?, title? }
```

payload 与 `GroupTopicsForkPayload` 同形。协议层用独立类型名 `DirectTopicsForkPayload`，validator 复用同一个形状检查。connector 的 `supportsDirectTopicFork(control)` 同时检查 core probe 与 `forkDirectTopic` 方法，两者都通过才广告 capability。

### 4.2 服务端

`ConversationRunService.forkDirectTopic` 与 `forkGroupTopic` 并列，共用 `resolveForkPoint`。

1. 只接受 `conversation.kind === "bot"`。`kind === "group"` 返回 `conversation_not_group` 的对应错误。
2. 源 Topic 必须属于该 Direct 会话，状态为 `active` 或 `archived`，且没有 `peerScope`。Agent 私有 peer Topic 不可 fork。
3. `sourcePoint` 缺省为 `latest_stable`。`latest_stable` 取最近一个终态 Run 的边界。存在未结算 Run 时返回 `topic_fork_source_unsettled`。`run` 必须是该 Topic 的终态 Run。`message` 必须是该 Topic 的可见消息。
4. 读取边界之前最新的 500 条消息。新增 store 方法 `listRecentMessages`，SQL 为 `seq <= throughSeq ORDER BY seq DESC LIMIT n`，返回时按 `seq` 升序。`topicMessageCount` 提供总条数，用于 `omittedMessages`。
5. 渲染 handoff。纯函数 `renderTopicForkHandoff` 接受源标题、边界 seq、消息、字符预算。默认预算 `MAX_FORK_HANDOFF_CHARS = 12_000`，单条消息截断到 `MAX_FORK_HANDOFF_MESSAGE_CHARS = 2_000`。选择顺序为新到旧，优先保留最后一条 human、最后一条 bot、第一条 human，再按新到旧填满。输出按时间升序，头部写明这是背景而不是新请求，附件的文件和工具状态不会重放。
6. 创建目标 Topic。`forkedFrom.mode = "handoff"`，写入 `sourceMessageId`（消息边界时）、`throughSeq`、`messageCount`、`omittedMessages`、`rootTopicId` 和 `forkHandoff`。默认标题为 `<源标题> fork`。不设置 `executionTarget`，Direct Topic 的执行目标来自 Bot profile。
7. 幂等。同 `targetTopicId + requestId` 重放返回已有 Topic。已有 Topic 缺少 `forkHandoff` 或 `forkedFrom.mode !== "handoff"` 时返回 `topic_fork_history_missing`，不把损坏目标当成功。不同 `requestId` 返回 `topic_exists`。
8. 源 Topic 没有消息时返回 `topic_fork_empty`。

### 4.3 Prompt 注入

`composeBotTurnPrompt` 增加第五个可选参数 `historicalContext`，放在 Group scope 之后、shared group context 之前。`composeBotTurnPromptFromSnapshot` 同步透传。

`conversation-dispatcher.ts` 的 Direct 分支在 `work.run.requestMessageId` 对应的消息 `seq === 1` 且当前 Topic 有 `forkHandoff` 时传入该文本。Group 分支与后续 Direct 轮次不传。

这条规则不需要额外的消费标记。目标 Topic 没有复制消息，fork 后第一条 human 消息的 seq 恒为 1。同一请求重试时消息 id 不变，仍会注入。第二条消息 seq 为 2，不再注入。

已知边界：如果第一条请求在 provider 启动前失败，用户改用一条新消息重试，新消息的 seq 为 2，handoff 不会再次注入。该情况记录为风险，不在本期加入额外状态。重复注入到同一 session 与丢失上下文之间，当前实现选择不重复注入。

### 4.4 UI

`ForkTopicDialog` 的提交改为调用父组件传入的 `fork` 回调，不再直接依赖 `groupsStore`。GroupPane 传 `groupsStore.forkGroupTopic`，DirectBotPane 传 `directBotsStore.forkDirectTopic`。对话框的标题、错误映射、id 重铸逻辑保持不变。

DirectBotPane 补齐 GroupPane 已有的三条接线：

- 两个 `TopicSwitcher` 传 `:fork-topic`。
- `ConversationTimeline` 传 `:forked-from`、`:fork-source-available`、`@open-source-topic`。
- `TraceOverlay` 传 `:fork-available`、`@fork`。

`direct-bots.ts` 新增 `forkDirectTopic`，镜像 `groups.ts` 的 `forkGroupTopic`，调用 `control.direct.topics.fork`，成功后 `upsertTopic` 并切换到新 Topic。`instances.ts` 新增 `supportsDirectTopicFork`。

banner 增加 `mode` 文案。`snapshot` 显示已复制消息数，`handoff` 显示已携带消息数。其余来源标题、省略条数、源链接行为一致。

## 5. Phase B，消息节点

### 5.1 服务端

`resolveForkPoint` 增加 `message` 分支：

1. `store.getMessage(messageId)` 必须存在，`conversationId` 与 `topicId` 必须匹配源 Topic。
2. `throughSeq = message.seq`。
3. 不设置 `boundaryRunId`。消息边界就是可见 seq 边界，后续 Run 不会因为 seq 更大而进入副本。
4. Group 的 `copyTopicForkMessages` 使用该 `throughSeq`。Direct 的 handoff 渲染使用该 `throughSeq`。
5. `forkedFrom.sourceMessageId` 写入该消息 id。

Group 的 `latest_stable`/`run` 行为不变。Direct 的 `latest_stable`/`run` 行为不变。

### 5.2 UI

`ConversationTimeline` 增加可选 `forkMessage` 回调，`TimelineRow` 在 `ConversationMeta` 的 operations 区渲染一个 fork 图标按钮，只在回调存在时出现。GroupPane 与 DirectBotPane 在 capability 可用且消息属于当前 Topic 时传入回调，构造 `sourcePoint: { type: "message", messageId }`。

`ForkTopicDialog` 的 sourcePoint 联合类型增加 message。分叉点文案增加消息边界分支。移动端依赖 `ConversationMeta` 已有的 `@media (hover: none)` 常显规则，不需要额外的入口。

## 6. Phase C，原生 session fork

当前不可做，原因在上游而不在 xacpx。

- `acpx` 0.19.5 的 `AcpRuntime` 与 `AcpClient` 没有 `forkSession`。本地 0.22.0 源码也没有。
- ACP SDK 已有 `unstable_forkSession`，请求形状为 `{ sessionId, cwd, mcpServers? }`，响应返回新的 session id。
- xacpx 没有自己的 ACP 连接。ACP 连接由 acpx 的 `AcpClient` 持有。绕过 acpx 调用 fork 等于接管 acpx 的 session 生命周期，不是 bridge 层的小改动。
- xacpx 固定在 `acpx: "0.19.5"`。即使上游补上，也要先发版、再升级依赖、再加 capability probe。

解锁顺序：

1. acpx 在 `AcpRuntime` 暴露 `forkSession`，在 `AcpClient` 暴露 `forkSession` 与 `supportsForkSession`。
2. acpx 为 CLI engine 增加 `sessions fork`，或明确只支持 Runtime engine。
3. xacpx 在 `SessionTransport` 增加可选 `forkSession`，在 bridge protocol、bridge engine、runtime adapter 透传。
4. xacpx 增加 fail-closed 的 capability probe，只在 probe 为 true 时广告 `native.session.fork.v1`。
5. fork 创建时优先 native，失败回退本期 handoff，并记录实际 resolution。

本期不写占位代码。没有上游 API 时增加一个永远为 false 的 probe 只会制造死路径。

## 7. 协议与能力

| 能力 | 用途 |
|---|---|
| `group.topics.fork.v1` | 现有 Group fork，不变 |
| `direct.topics.fork.v1` | Direct fork，Phase A 新增 |
| `native.session.fork.v1` | 原生 fork，Phase C 待上游 |

RPC 列表：

| RPC | 会话类型 |
|---|---|
| `control.group.topics.fork` | Group |
| `control.direct.topics.fork` | Direct |

两个 RPC 共用 `ThreadForkSourcePointDto`，因此 Phase B 的消息边界同时覆盖两者。

## 8. 验证

单元测试覆盖：

- Direct fork 创建目标 Topic，写入 handoff，消息行不复制。
- 第一条 prompt 包含 handoff，第二条不包含。
- 源 Topic 删除后目标仍能发出带 handoff 的 prompt。
- 幂等重放、损坏目标 fail-closed、空源、未结算 Run、跨 Topic 消息。
- Group 消息边界只复制到该 seq，后续消息不进入副本。
- Direct 消息边界只注入到该 seq。

真实栈验证：

- 起一个 Direct Bot，发多轮消息，从 Topic 菜单 fork。
- 在新 Topic 发第一条消息，检查 provider prompt 或 trace 中出现历史块，第二条不出现。
- 删除源 Topic，再在 fork 中发消息。
- Group 从某条消息 fork，确认只复制到该消息。
- 旧 connector 不广告 capability 时入口隐藏。

## 9. 风险

| 风险 | 处理 |
|---|---|
| 首条请求在 provider 启动前失败，新消息失去 handoff | 记录为已知边界，后续版本可加入“首个成功 bot 回复前保持 pending”的状态 |
| handoff 文本进入 state.json，体量随 fork 增加 | 12k 字符上限，单条 2k；不复制消息行，净增小于 Group 快照 |
| 注入文本被当成指令 | 独立 prompt 区块，头部写明是背景；不进入 `body` 的命令识别路径 |
| Direct 新 Topic 已有独立 session，注入重复 | 只在第一条 human 消息注入；同一请求重试会重复注入，视为可接受 |
| fork-of-fork 丢失最初 handoff | 只快照可见消息，文档明确；后续可把源 `forkHandoff.text` 作为前缀 |
| 消息边界与 Run 边界语义混淆 | `sourceMessageId` 与 `sourceRunId` 互斥展示；消息边界不写 `sourceRunId` |

## 10. 验收

- [ ] `control.direct.topics.fork` 在 Direct Bot 会话创建新 Topic，返回 `forkedFrom.mode = "handoff"`。
- [ ] 新 Topic 第一条 prompt 包含边界内历史，第二条不包含。
- [ ] 源 Topic 删除后 fork 仍可对话。
- [ ] Group 与 Direct 都能以 `{ type: "message", messageId }` 为边界。
- [ ] Group 消息边界只复制到该消息的 seq。
- [ ] 旧 core/connector 不广告新 capability，入口隐藏。
- [ ] 单元测试、relay-web 测试、Playwright、真实栈全部通过。
- [ ] 原生 fork 的上游依赖与解锁步骤记录在文档中，没有死代码。
