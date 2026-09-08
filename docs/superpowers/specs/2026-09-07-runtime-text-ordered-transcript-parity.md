# Addendum — Runtime Text / Ordered Transcript Parity

## 21. 问题

Runtime engine 启用后，Relay Web 出现此前已经修复过的文字展示回归：

```text
agent text A
tool
agent text B
tool
agent text C
```

或多个逻辑 agent message，重新表现为大段连续文字，失去此前 CLI 链路下的 paragraph / activity boundary 效果。

本问题不是 Relay Web 应重新实现文本切分，而是 Runtime 链路没有继承 CLI 已有的 transcript normalization。

---

## 22. 已有 CLI 行为

`src/transport/streaming-prompt.ts` 当前维护：

```ts
lastMessageId
lastTextTail
activitySinceLastText
hasAgentMessage
```

并在 agent message chunk 到来时判定：

```text
messageId changed
OR
tool/thought activity occurred since previous text
    + messageId unavailable
    + previous text ends at sentence boundary
```

若当前位置尚无已有 paragraph boundary，则在新文本前补：

```text
\n\n
```

另外：

```text
tool_call initial
thought chunk
```

会建立 activity boundary，并在 activity event 前 flush pending text。

这个行为是已经验证过的 CLI presentation contract，不应因为 engine 从 CLI 切到 Runtime 而改变。

---

# 23. Runtime 当前缺口

Pinned acpx Runtime 的 `text_delta` 已提供：

```ts
type: "text_delta";
text: string;
stream?: "output" | "thought";
tag?: AcpSessionUpdateTag;
messageId?: string;
meta?: {
  origin?: string;
  kind?: string;
  source?: string;
};
```

但 xacpx 当前内部 `XacpxRuntimeEvent` 只保留：

```ts
{
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
}
```

`runtime-adapter.ts::mapEvents()` 同样只转发：

```ts
yield {
  type: "text_delta",
  text: event.text,
  ...(event.stream ? { stream: event.stream } : {}),
};
```

因此 Runtime 链路当前丢失：

```text
tag
messageId
meta
```

随后 RuntimeEngine 将每个 text delta 直接下发为：

```text
prompt.segment
```

没有 CLI 的：

```text
logical-message boundary
activity boundary
paragraph reconstruction
```

---

# 24. 设计原则

不要在：

```text
relay-web
relay
channel-relay
```

层重新猜 agent message boundaries。

应继续遵循：

```text
transport/runtime normalization
        ↓
normalized prompt.segment stream
        ↓
ControlService
        ↓
Relay ordered TurnPart timeline
```

即：

> Engine 不同不能改变上层看到的 transcript semantics。

---

# 25. 保留 Runtime text metadata

修改：

```text
src/bridge/engine/runtime/runtime-contract.ts
```

使 internal text event 至少保留：

```ts
{
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
  tag?: string;
  messageId?: string;
  meta?: {
    origin?: string;
    kind?: string;
    source?: string;
  };
}
```

然后：

```text
src/bridge/engine/runtime/runtime-adapter.ts
```

完整 forward upstream allowlisted metadata：

```ts
{
  type: "text_delta",
  text: event.text,
  ...(event.stream ? { stream: event.stream } : {}),
  ...(event.tag ? { tag: event.tag } : {}),
  ...(event.messageId ? { messageId: event.messageId } : {}),
  ...(event.meta ? { meta: event.meta } : {}),
}
```

不要再次在 Runtime adapter 边界丢失 upstream 已经安全筛选过的信息。

---

# 26. 抽取共享 Text Boundary Normalizer

不要在 RuntimeEngine 里重新手抄一套与 CLI 独立发展的 heuristic。

建议从：

```text
src/transport/streaming-prompt.ts
```

抽出一个纯状态机，例如：

```text
src/transport/transcript-text-boundary.ts
```

概念 API：

```ts
interface TranscriptTextBoundaryState {
  hasAgentMessage: boolean;
  lastMessageId?: string;
  lastTextTail: string;
  activitySinceLastText: boolean;
}

function markTranscriptActivity(
  state: TranscriptTextBoundaryState,
): void;

function normalizeTranscriptTextChunk(
  state: TranscriptTextBoundaryState,
  input: {
    text: string;
    messageId?: string;
  },
): string;
```

CLI 和 Runtime 两边都使用同一个实现。

---

# 27. Normalization 规则

## 27.1 同一个 messageId

输入：

```text
messageId=A: "Hello "
messageId=A: "world."
```

输出：

```text
Hello world.
```

不能因为 token/chunk 边界插入额外 paragraph。

---

## 27.2 messageId 改变

输入：

```text
A: "First message."
B: "Second message."
```

如果 join 处没有现成 paragraph boundary：

```text
First message.

Second message.
```

---

## 27.3 已有 paragraph boundary

输入：

```text
A: "First.\n\n"
B: "Second."
```

禁止再补一次：

```text
\n\n
```

---

## 27.4 activity fallback

若 provider 没有 messageId：

```text
text: "I'll inspect it."
tool_call
text: "The problem is here."
```

tool call 建立：

```text
activitySinceLastText = true
```

previous text 又以 sentence terminal 结束，因此第二段应正规化为：

```text
"\n\nThe problem is here."
```

---

## 27.5 非 sentence-terminal fallback

例如：

```text
text: "Result:"
tool
text: "42"
```

如果沿用当前 CLI contract，不应仅因为 tool 存在就武断插入 paragraph。

Runtime 必须与 CLI 保持相同 heuristic，而不是设计第二套规则。

---

# 28. Activity events

至少以下事件应与 CLI 一致地建立 text activity boundary：

```text
initial tool_call
agent thought
```

`tool_call_update` 不应被当作一个新的 logical activity：

```text
running update
completed update
```

只是同一个 tool call 的状态变化。

这与本 spec 前半部分的：

```text
per-toolCallId snapshot normalization
```

是同一个原因。

---

# 29. 推荐统一 Runtime per-turn normalizer

既然本次还要修 tool-call delta，可以把两个问题收敛成一个 per-turn normalizer：

```text
AcpRuntimeEvent
       ↓
RuntimeTranscriptNormalizer
       ├── text boundary normalization
       │     messageId/activity/paragraph
       │
       └── tool snapshot normalization
             per-toolCallId delta → snapshot
       ↓
XacpxRuntimeEvent
```

生命周期：

```text
one Runtime turn
→ one normalizer instance
→ turn settle
→ discard all state
```

不要把任何 accumulator 挂成：

```text
RuntimeEngine global state
session lifetime state
worker lifetime state
```

防止跨 turn 污染。

---

# 30. 保持 raw-stream 性能语义

修复不能恢复旧的 30 秒 paragraph buffering。

Runtime `replyMode=stream` 仍应：

```text
text delta arrives
→ normalize boundary
→ immediately emit
```

也就是说允许把：

```text
"Second"
```

变成：

```text
"\n\nSecond"
```

但不能为了寻找 paragraph 而缓存整个段落。

目标是：

```text
raw low-latency streaming
+
correct logical boundaries
```

而不是回退到 batched streaming。

---

# 31. Relay contract

Relay 当前：

```text
连续 text part → coalesce
text → tool → text → 保持三个 ordered parts
text → reasoning → text → 保持三个 ordered parts
```

这一行为保持不变。

不要为了 Runtime 在 Relay 加：

```text
if engine === runtime
```

之类的 presentation 分支。

---

# 32. 必须新增的 regression tests

## T1 — Runtime forwards text metadata

输入 upstream：

```text
text_delta
tag=agent_message_chunk
messageId=m1
meta.origin=...
```

断言 xacpx internal Runtime event 全部保留。

---

## T2 — Same message stays contiguous

```text
m1 "Hello "
m1 "world"
```

结果：

```text
"Hello "
"world"
```

不得插入 separator。

---

## T3 — Different messageIds regain paragraph

```text
m1 "One."
m2 "Two."
```

累计结果：

```text
One.

Two.
```

---

## T4 — Existing paragraph is not duplicated

```text
m1 "One.\n\n"
m2 "Two."
```

必须仍然只有一个 logical blank line。

---

## T5 — Tool activity fallback without messageId

```text
text "I'll inspect it."
initial tool_call
text "Found it."
```

第二个 text event 必须带前导：

```text
\n\n
```

---

## T6 — Tool update does not create another activity boundary

```text
text
tool_call
tool_call_update
tool_call_update
text
```

整个 tool lifecycle 只对应一个 logical activity。

---

## T7 — Thought boundary parity

```text
agent text
thought
agent text
```

与 CLI current behavior 一致。

---

## T8 — Ordered Relay timeline

端到端喂入：

```text
text A
tool rich-running
tool sparse-completed
text B
```

Relay 最终 `parts` 必须为：

```text
[
  text(A),
  tool(completed rich snapshot),
  text(B)
]
```

不能变为：

```text
[
  tool(...),
  text(A + B)
]
```

也不能：

```text
[
  text(A + B),
  tool(...)
]
```

这条同时验证：

```text
tool snapshot merge
+
text/tool event ordering
+
ordered transcript
```

---

## T9 — Consecutive logical messages without tool

如果 Relay 按现有设计把连续 text chunk coalesce 成一个 `TurnPartDto.text`，允许仍只有一个 part，但其中必须保有：

```text
A\n\nB
```

不能变为：

```text
AB
```

不要为了这个测试改变 Relay 的 same-type coalescing contract。

---

## T10 — Stream mode remains immediate

测试第一个 Runtime text delta 不等待：

```text
paragraph completion
tool
turn completion
timer
```

就进入 `prompt.segment`。

---

# 33. 验收条件

完成后必须同时满足：

1. Runtime 与 CLI 对 logical agent-message paragraph boundary 行为一致。
2. Runtime 不再丢 `text_delta.messageId/tag/meta`。
3. Read/Edit/Bash tool card 修复后的 structured events 仍按真实时序穿插于文字之间。
4. `text → tool → text` 在 Relay history/live view 都是 ordered timeline。
5. 独立 agent message 不再无分隔地粘成一整段。
6. 不改变 Relay 的 consecutive same-type coalescing。
7. 不降低 `replyMode=stream` 首 token 延迟。
8. CLI 行为无回归。
9. Runtime direct prompt 与 queued prompt 使用同一 normalization。
10. live view 与 persisted `structured.parts` 结果一致。

---

# 34. 与 Tool Call 修复的统一 invariant

前半部分解决：

> ACP tool events 是 delta，xacpx 下游 contract 必须是 snapshot。

本部分解决：

> ACP text events 是带 logical identity/activity context 的 stream，xacpx 下游不能在 Runtime 路径把这些 boundary semantics 丢掉。

因此建议最终实现一个统一的：

```text
per-turn Runtime transcript normalization layer
```

负责：

```text
tool delta → snapshot
text metadata preservation
logical text boundary reconstruction
activity ordering
```

之后 RuntimeEngine、ControlService、Relay 都只消费已经正规化后的事件。
