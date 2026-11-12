# Direct 会话与消息节点 fork

状态：Accepted（Phase A 已实现；Phase B 消息节点见第 5 节，尚未实现）

范围：在现有 Group Topic fork 之上，增加 Direct Bot 会话的 fork，以及 Group/Direct 共同的消息节点边界。原生 Agent session fork 不在本期。

## 1. 问题

Group Topic 的 fork 是应用层消息快照。它成立的原因是 Group prompt 每轮都从 SQLite 重建，复制消息就等于复制上下文。

Direct 会话不同。`conversation-dispatcher.ts` 对 Direct turn 只传 `userText`，历史通过持久化的 Agent session 延续。复制消息到一个新 Topic 不会进入 prompt，模型看不到，分叉只剩界面效果。因此 Direct fork 必须把有界历史作为一次性上下文注入新 Topic 的第一个有效 prompt。

## 2. 三种 fork

| 形态 | 源 | 目标里有什么 | 上下文如何到达模型 |
|---|---|---|---|
| Group 快照 | Group Topic | 复制到边界的消息行 | 每轮从目标 Topic 重建 |
| Direct handoff | Direct Topic | 不复制消息行，SQLite 存一份渲染文本 | 目标 Topic 首个有效 prompt 注入，直到第一条 bot 回复落地 |
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

`message` 的边界是该消息的 `seq`。它不要求消息所属 Run 已结算。用户选中一条已写入的消息，就得到该消息之前的可见历史。

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

`copiedMessages` 在 `snapshot` 下是复制的消息数，在 `handoff` 下是渲染文本包含的消息数。`omittedMessages` 在两种形态下都表示边界内被预算截断的更早消息数。

### 3.3 Direct handoff 正文存放在 SQLite

渲染后的文本不进 `state.json`。`StateStore.save` 每次写整份 state，把 12k 字符放进 Topic 记录会让之后每一次 state 写入都多背 12KB。正文放进独立表，随 Topic 一起删除。

```sql
CREATE TABLE IF NOT EXISTS topic_fork_handoffs (
  topic_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  omitted_messages INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

store 接口：

interface ConversationStore {
  putTopicForkHandoff(input: {
    topicId: string;
    conversationId: string;
    text: string;
    throughSeq: number;
    messageCount: number;
    omittedMessages: number;
    createdAt: string;
    /** 仅 fork 重放时用于收敛：首次消费时间写进同一行，已存在时不再改写。 */
    consumedAt?: string;
  }): void;
  getTopicForkHandoff(topicId: string): TopicForkHandoff | undefined;
  /** 写入首次消费时间；已消费时不再改写。 */
  markTopicForkHandoffConsumed(topicId: string, consumedAt: string): void;
  /** 只数边界内的消息，用于 omittedMessages。 */
  topicMessageCountThrough(conversationId: string, topicId: string, throughSeq: number): number;
  /** 边界内最新 N 条，升序返回。 */
  listRecentMessages(input: {
    conversationId: string;
    topicId: string;
    throughSeq: number;
    limit: number;
  }): ConversationMessage[];
}
```

`deleteTopicRows` 在同一事务里删除该 Topic 的 handoff 行。目标 Topic 的元数据仍在 `forkedFrom`，因此删除正文不影响来源展示。

`ConversationTopic` 不新增字段。`forkedFrom.mode` 是唯一的形态判据，正文是否存在用 `getTopicForkHandoff` 判定，两者不一致时按损坏处理。

### 3.4 状态校验

`state-store.ts` 的 `isConversationTopicFork` 接受可选 `mode`，取值只能是 `snapshot` 或 `handoff`，并接受可选 `sourceMessageId`（非空字符串）。非法 Topic 仍按现有逻辑丢弃。

清理（`clearDefaultTopic`）退役上下文时，重建的 Topic 记录不保留 `forkedFrom`，并删除该 Topic 的 handoff 行。否则 seq 从 1 重新开始时，旧文本会被再次注入一个全新 session。

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

顺序很重要。重放判定在读取源之前完成，否则源被删除后同 `requestId` 的重试会返回 `topic_not_found`，客户端只能换新 id 再 fork 一次。

1. 基础校验。`conversation.kind` 必须是 `bot`。`targetTopicId` 必须是 `topic_` 前缀、不是 `topic_peer_`、不等于源、且不等于 `createDirectTopicId(botId)`。默认 Direct Topic 不能被当成 fork 目标。
2. 重放。`state.conversation_topics[targetTopicId]` 存在时：
   - `forkedFrom?.requestId !== requestId` 返回 `topic_exists`。
   - `forkedFrom.mode !== "handoff"` 返回 `topic_exists`。
   - `getTopicForkHandoff(targetTopicId)` 缺失，或 `text` 为空，或 `throughSeq`/`messageCount`/`omittedMessages` 与 `forkedFrom` 不一致，返回 `topic_fork_history_missing`。
   - 目标 Topic 处于 `deleting` 或正在拆除，返回 `topic_deleting`。
   - 否则返回已有 Topic。**重放路径不读源 Topic，也不重新渲染。**
3. 目标 id 无 Topic 记录但已有消息行，返回 `topic_fork_history_missing`。这条复用 Group 的孤儿检查，在 Direct 下等价于 `topicMessageCount(conversationId, targetTopicId) > 0`。
4. 读取源 Topic。必须属于该 Direct 会话，状态为 `active` 或 `archived`，且没有 `peerScope`。
5. 解析来源点。`latest_stable` 取**最近一个已结算 Run** 的边界；若没有任何已结算 Run 而存在未结算 Run，返回 `topic_fork_source_unsettled`。这与 Group 语义一致：在途 turn 不在快照内，不报错。`run` 必须是该 Topic 的终态 Run。`message` 必须是该 Topic 的消息。边界计算复用 `forkThroughSeq` 与 `message.seq`。
6. 用 `topicMessageCountThrough` 得到边界内总数，用 `listRecentMessages` 取边界内最新 500 条（升序）。
7. 渲染 handoff。纯函数 `renderTopicForkHandoff`，输出结构见 §4.3。
8. 创建目标 Topic。`forkedFrom.mode = "handoff"`，写入 `sourceMessageId`（消息边界时）、`throughSeq`、`copiedMessages`（等于 `messageCount`）、`omittedMessages`、`rootTopicId`。默认标题为 `<源标题> fork`。不设置 `executionTarget`。写入 handoff 行。
9. 先写 SQLite handoff 行，再 `persist` state。写入顺序与 Group 的复制一致。崩溃点在两者之间时，重放命中第 3 条的孤儿检查并 fail-closed，不会静默返回半成品。
10. 源 Topic 没有边界内消息时返回 `topic_fork_empty`。

### 4.3 handoff 渲染

`renderTopicForkHandoff` 是纯函数，输入 `{ sourceTitle, throughSeq, messages, parentText?, budget }`，输出 `{ text, messageCount, omittedMessages }`。

结构固定，顺序固定：

```text
Historical context from the Direct Topic "<sanitized title>" (messages up to #<throughSeq>).
This is background material, not a new request. Attached files and tool state are not replayed.

<<<HISTORY
Human: <content>
Bot <name>: <content>
...
>>>END HISTORY
```

规则：

- 标题先折叠空白并截断到 80 字符，再插入头部。标题是用户可控文本，不能换行，也不能提前闭合头部。
- 每条消息占一行或一段，前缀为 `Human:` 或 `Bot <name>:`，按时间升序。
- 消息正文超过 `MAX_FORK_HANDOFF_MESSAGE_CHARS = 2_000` 时截断，并把省略号计入上限。
- 预算 `MAX_FORK_HANDOFF_CHARS = 12_000`。先扣除头部、分隔符和截断标记的保留空间，再用剩余预算从新到旧填充。填充完成后断言 `text.length <= MAX_FORK_HANDOFF_CHARS`。
- 选择优先级：边界消息本身必选；然后是最后一条 human、最后一条 bot；再按新到旧填充。
- 边界消息因角色或超长被排除时，必须仍以截断形式收录。用户明确选了这个边界点。
- 如果一条可渲染消息都没有，返回空结果，调用方报 `topic_fork_empty`。
- `parentText` 存在时（fork-of-fork），作为最旧的一段内容放在所有可见消息之后，只使用剩余预算。计数传递：`messageCount += parent.messageCount`，`omittedMessages += parent.omittedMessages`，再加本次新截断的条数。父块被裁剪时在块首加截断标记。

### 4.4 Prompt 注入

`composeBotTurnPrompt` 增加第五个可选参数 `historicalContext`，放在 Group scope 之后、shared group context 之前。`composeBotTurnPromptFromSnapshot` 同步透传。

`historicalContext` 只能作为 header 参数传入，**不能**拼进 `body` 或 `userText`。命令识别只看 `body`，`adapterFacingPrompt` 只看 `userText`，混进去会让历史文本被当成命令。反过来这也保证历史文本不会触发命令路径。

位置固定在正文之前。dispatcher 计算 mention 偏移时用 `peerPrefix.length + text.length - userText.length`，只有 `userText` 仍是最终文本的后缀时这个式子成立。历史块附加在正文之后会让偏移错位。

注入判据，按顺序：

1. 目标 Topic 有 `getTopicForkHandoff(topicId)` 结果。
2. `handoff.consumedAt` 为空。
3. 本轮不是已知 xacpx 命令，也不是 advertised runtime 命令。命令轮只返回裸命令文本，不会带上头部；这类轮次既不能注入，也不能标记已消费。

前两条是消费标记，不能从消息行推导。命令轮会落一条 bot 回复，`hasBotMessage` 会在下一轮之前就把窗口关掉，于是历史永久丢失。因此 `topic_fork_handoffs` 增加一列：

```sql
consumed_at TEXT
```

dispatcher 在把历史块放进本轮 prompt 之后、调用 runner 之前写入 `consumed_at`。写入是幂等收敛：已消费的 handoff 只保留第一次的时间。命令轮不写。

已知边界：

- 首条请求在 provider 启动前失败，`consumed_at` 尚未写入，用户换新消息重试仍会注入。重复注入优于丢失上下文。
- 首条请求已注入但 provider 失败，`consumed_at` 已写入，不会重注。这是有意选择：fork 的价值是模型看到一次历史，而不是每次失败都重放。
- 命令轮不注入也不消费，下一条普通消息仍注入。

### 4.5 UI

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

1. `store.getMessage(messageId)` 必须存在，`conversationId` 与 `topicId` 必须匹配源 Topic，消息不能属于 `peerScope` Topic。
2. `throughSeq = message.seq`。
3. 不设置 `boundaryRunId`。seq 分配在 accept 事务内、每个 Topic 严格单调，任何在后才写入的消息都会拿到更大的 seq，因此 `seq <= throughSeq` 已经排除了后续 Run，无需额外过滤。加 `boundaryRunId` 反而会把边界消息之前的其他 Run 消息误删。
4. Group 的 `copyTopicForkMessages` 使用该 `throughSeq`。Direct 的 handoff 渲染使用该 `throughSeq`。
5. `forkedFrom.sourceMessageId` 写入该消息 id，且不写 `sourceRunId`。

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

- Direct fork 创建目标 Topic，写入 handoff 行，消息行不复制。
- 第一条 prompt 包含 handoff，第一条 bot 回复之后不再包含。
- 源 Topic 删除后目标仍能发出带 handoff 的 prompt。
- 源 Topic 删除后同 `requestId` 重放仍返回已有 Topic。
- 幂等重放、`mode` 不一致、handoff 行缺失、孤儿行、空源、未结算 Run、跨 Topic 消息。
- 默认 Direct Topic 作为目标被拒绝。
- 清理默认 Topic 后 `forkedFrom` 与 handoff 都不存在。
- 超过 500 条时只渲染窗口内消息，边界消息仍被收录。
- 渲染结果长度不超过 12,000，单条不超过 2,000。
- fork-of-fork 带上父 handoff 文本，计数累加。
- Group 消息边界只复制到该 seq，后续消息不进入副本。
- Direct 消息边界只注入到该 seq。

真实栈验证：

- 起一个 Direct Bot，发多轮消息，从 Topic 菜单 fork。
- 在新 Topic 发第一条消息，检查 provider prompt 或 trace 中出现历史块，第二条不出现。
- 删除源 Topic，再在 fork 中发消息。
- 首条消息故意失败，再发一条，确认历史块出现。
- Group 从某条消息 fork，确认只复制到该消息。
- 旧 connector 不广告 capability 时入口隐藏。

## 9. 风险

| 风险 | 处理 |
|---|---|
| 首条请求在 provider 启动前失败，用户换消息重试 | 判据是“还没有 bot 回复”，因此下一轮会重新注入。重复注入视为可接受 |
| 命令轮丢上下文 | 命令轮不消耗注入机会，下一条普通消息仍注入 |
| handoff 文本进入 state.json | 不进入。正文在 `topic_fork_handoffs`，随 Topic 删除 |
| 注入文本被当成指令 | 独立 header 区块，逐条带 `Human:` / `Bot <name>:` 前缀，标题折叠并截断；历史不进 `body`/`userText` |
| mention 偏移错位 | 历史块固定在正文之前，`userText` 仍是最终文本的后缀 |
| 默认 Direct Topic 被当成目标 | fork 时显式拒绝；清理时清除 `forkedFrom` 与 handoff 行 |
| fork-of-fork 丢失最初上下文 | 父 handoff 文本作为最旧一段内联，共用 12k 预算 |
| `omittedMessages` 把边界之后的消息算进去 | 用 `topicMessageCountThrough` 只数边界内 |
| 消息边界与 Run 边界语义混淆 | `sourceMessageId` 与 `sourceRunId` 互斥展示；消息边界不写 `sourceRunId` |

## 10. 验收

- [x] `control.direct.topics.fork` 在 Direct Bot 会话创建新 Topic，返回 `forkedFrom.mode = "handoff"` 且写入 handoff 行。
- [x] 新 Topic 第一条 prompt 包含边界内历史，第一条 bot 回复之后不再包含。
- [x] 源 Topic 删除后 fork 仍可对话，同 `requestId` 重放仍返回已有 Topic。
- [ ] Group 与 Direct 都能以 `{ type: "message", messageId }` 为边界。（Phase B，未实现）
- [ ] Group 消息边界只复制到该消息的 seq。（Phase B，未实现）
- [x] 旧 core/connector 不广告新 capability，入口隐藏。
- [x] 单元测试、relay-web 测试、Playwright、真实栈全部通过。
- [x] 原生 fork 的上游依赖与解锁步骤记录在文档中，没有死代码。
