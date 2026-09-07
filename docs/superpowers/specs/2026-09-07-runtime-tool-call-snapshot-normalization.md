# Runtime Tool Call Snapshot Normalization

## 1. 背景

PR #312 将新 session 的默认 engine 切换到 Runtime 后，Relay Web 中 structured tool call 的可读性发生明显回退：

* Read 文件显示为 `tool call`
* Edit / Update 文件显示为 `tool call`
* Bash / execute 命令显示为 `tool call`
* 不同工具无法从卡片标题和图标上区分

CLI engine 下同类 tool call 显示正常。

当前问题存在于已经发布的 Runtime 链路中，不是 Relay Web 自身的 presentation bug。

---

## 2. 根因

ACP 的 `tool_call` / `tool_call_update` 是 **同一 `toolCallId` 的增量事件流**，不是每帧完整 snapshot。

典型事件序列：

```text
tool_call:
  toolCallId = "call-1"
  title = "Read"
  kind = "read"
  rawInput = { path: "/src/foo.ts" }

tool_call_update:
  toolCallId = "call-1"
  status = "completed"
```

终帧可能只携带 `status` / `rawOutput`，不重复：

* title
* kind
* rawInput
* content
* locations

CLI 链路已经通过 `mergeToolCallUpdate()` 按 `toolCallId` 累积字段，因此 terminal sparse update 不会覆盖此前富信息。

Runtime 链路目前没有等价逻辑：

```text
acpx/runtime
→ runtime-adapter.ts mapEvents()
→ runtime-worker-main.ts
→ RuntimeEngine
→ mapRuntimeToolEvent()
→ ToolUseEvent
→ channel-relay
```

每个 Runtime `tool_call` event 都被独立转换成一个新的 `ToolUseEvent`。

而 Relay / state mirror 对同一 `toolCallId` 使用的是 **replace-latest snapshot semantics**：

```text
old step
→ new ToolUseEvent
→ replace whole step
```

因此 sparse terminal frame 会把 rich initial frame 擦掉。

### 2.1 `acpx@0.13.1` 的额外放大因素

Pinned `acpx@0.13.1` 在处理缺少 title 的 `tool_call_update` 时，不会留下 `title=undefined`，而是主动生成：

```text
title = "tool call"
```

例如：

```text
ACP:
  tool_call_update
  toolCallId = call_ABC123
  status = in_progress
```

会变成 Runtime event：

```text
type = tool_call
tag = tool_call_update
toolCallId = call_ABC123
status = in_progress
title = "tool call"
```

因此不能简单复制 CLI 的“所有 non-empty 字段覆盖 previous”规则。

对于 Runtime，`tool_call_update` 上的 synthetic `"tool call"` 必须视为 **missing title**，不能覆盖此前已有的具体 title。

---

# 3. 核心设计原则

## 3.1 Runtime adapter 必须输出 snapshot，而不是 delta

在 xacpx Runtime adapter 边界：

```text
ACP Runtime delta stream
```

必须被正规化为：

```text
XacpxRuntimeEvent snapshot stream
```

也就是说，对每一个已有 `toolCallId`，每次向 worker / host 下游发送的 `tool_call` event，都应该包含当前已知的累计状态。

下游不应该再理解 ACP 的 merge 语义。

---

## 3.2 Relay 不负责合并 ACP delta

不要把修复放到：

* `packages/channel-relay`
* `packages/relay`
* `packages/relay-web`

Relay 当前按 `toolCallId` replace 整个 ToolStep 的行为是正确的。

修复后的 invariant 应为：

> Relay 收到的每一个 `ToolUseEvent` 都是当前 tool call 的完整 best-known snapshot。

这样：

* Relay Web
* Feishu
* 其它 structured-tool channel

都自动获得一致行为。

---

## 3.3 Merge state 必须是 per-turn

Accumulator 必须随着一个 Runtime turn 创建、随着 turn 完成销毁。

禁止：

* RuntimeEngine 实例级长期 Map
* session 级 Map
* global Map

否则不同 turn 如果偶然复用了同一个 `toolCallId`，会发生跨 turn 信息污染。

`runtime-adapter.ts::mapEvents()` 本身对应一个 turn 的 `AsyncIterable`，因此适合作为 accumulator 生命周期边界。

---

# 4. 具体方案

## 4.1 保留 upstream event tag

当前 upstream Runtime contract 对 tool call 暴露：

```ts
tag?: AcpSessionUpdateTag
```

其中至少包括：

```text
tool_call
tool_call_update
```

xacpx 当前内部 `XacpxRuntimeEvent` 的 tool_call branch 没有保留该字段。

修改：

`src/bridge/engine/runtime/runtime-contract.ts`

为 tool call 增加：

```ts
type: "tool_call";
text: string;
tag?: string;
toolCallId?: string;
...
```

更严格也可以定义：

```ts
tag?: "tool_call" | "tool_call_update" | string;
```

然后：

`src/bridge/engine/runtime/runtime-adapter.ts`

必须 forward：

```ts
...(event.tag ? { tag: event.tag } : {})
```

这是重要的 transport semantics，不应在 adapter 第一层丢弃。

---

# 5. Runtime Tool Snapshot Accumulator

推荐放在：

```text
src/bridge/engine/runtime/runtime-adapter.ts
```

或者抽成一个同目录小模块，例如：

```text
src/bridge/engine/runtime/runtime-tool-call-merge.ts
```

如果逻辑和测试开始超过约 100 行，优先抽模块。

---

## 5.1 状态结构

每个 `mapEvents()` 创建：

```ts
const toolCalls = new Map<string, RuntimeToolCallSnapshot>();
```

Snapshot 至少保存：

```ts
interface RuntimeToolCallSnapshot {
  type: "tool_call";
  text: string;
  tag?: string;
  toolCallId: string;
  title?: string;
  status?: string;
  kind?: string;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}
```

---

## 5.2 无 `toolCallId` 的行为

如果 upstream event 没有 `toolCallId`：

* 不尝试 merge
* 保持当前 passthrough 行为
* 不生成一个 synthetic merge key

`mapRuntimeToolEvent()` 当前为了满足 `ToolUseEvent` contract 可以继续生成 fallback ID，但 accumulator 不应该以随机 ID 做跨帧合并。

没有稳定 ID 就没有可靠 merge identity。

---

# 6. Merge semantics

## 6.1 普通规则

对于同一个 `toolCallId`：

```text
new field meaningful
    → update snapshot

new field missing / empty
    → preserve previous
```

需要累计的字段：

```text
title
kind
status
rawInput
rawOutput
content
locations
```

`toolCallId` 固定。

---

## 6.2 rawInput / rawOutput 是累积关系

尤其不能写成：

```text
new rawOutput exists
→ discard rawInput
```

典型完整生命周期：

```text
initial:
  rawInput.command = "bun test"

terminal:
  rawOutput.formatted_output = "..."
  status = completed
```

最终 snapshot 应同时包含：

```text
rawInput.command
rawOutput.formatted_output
status
```

同理 Edit：

```text
initial:
  rawInput/path/content/diff

terminal:
  status + rawOutput
```

最终都必须保留。

---

## 6.3 Synthetic `"tool call"` title 特例

这是本方案最关键的 Runtime-specific 规则。

当：

```text
event.tag === "tool_call_update"
AND
event.title.trim().toLowerCase() === "tool call"
AND
previous.title is meaningful
```

则：

```text
preserve previous.title
```

不能覆盖。

伪代码：

```ts
const nextTitle = normalize(event.title);

if (
  event.tag === "tool_call_update" &&
  nextTitle.toLowerCase() === "tool call" &&
  previous.title
) {
  merged.title = previous.title;
} else if (nextTitle) {
  merged.title = nextTitle;
}
```

---

## 6.4 真正 title update 必须允许

不能粗暴写成：

```text
tool_call_update 永远不允许修改 title
```

如果 upstream 明确发：

```text
initial title = "Running command"

update title = "Building project"
```

则应该接受新 title。

只特殊处理 Runtime upstream 的 generic placeholder：

```text
"tool call"
```

---

## 6.5 `text` 字段

`text` 不是 structured presentation 的 source of truth。

它可以：

* 使用 latest meaningful `event.text`
* 或保留 latest value

但不要用 `text` 替代：

* title
* rawInput
* kind
* rawOutput

特别禁止：

```ts
summary = event.text
```

作为本次主修复。

---

# 7. mapEvents() 目标行为

最终结构建议：

```ts
async function* mapEvents(
  events: AsyncIterable<AcpRuntimeEvent>,
): AsyncIterable<XacpxRuntimeEvent> {
  const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

  for await (const event of events) {
    if (event.type === "text_delta") {
      ...
      continue;
    }

    if (event.type === "status") {
      ...
      continue;
    }

    if (event.type === "tool_call") {
      const normalized = normalizeRuntimeToolCallEvent(
        toolCalls,
        event,
      );

      yield normalized;
    }
  }
}
```

其中：

```ts
normalizeRuntimeToolCallEvent()
```

负责：

```text
upstream event
→ merge per toolCallId
→ return accumulated snapshot
```

---

# 8. RuntimeEngine 不再承担 merge

`src/bridge/engine/runtime-engine.ts`

当前：

```ts
const toolEvent = mapRuntimeToolEvent(event);
```

可以保持这种简单模式。

它应该只负责：

```text
XacpxRuntime tool snapshot
→ ToolUseEvent
```

而不是维护 per-turn Map。

这样 direct prompt / queued prompt 等所有 Runtime turn 都自动获得相同 normalization。

---

# 9. Summary parity

这是第二阶段，但建议同一个 patch 完成。

当前 CLI 的 `buildToolUseEvent()` 会通过：

```text
rawInput
fallback rawOutput
```

生成 `ToolUseEvent.summary`。

Runtime 当前 `mapRuntimeToolEvent()` 不填 summary。

建议抽出或复用 CLI 已有的 tool summary helper，使 Runtime snapshot 也能够得到：

```ts
summary?: string
```

原则：

```text
summary = summarize(merged.rawInput)
       ?? summarize(merged.rawOutput)
```

并保持已有的：

```text
summary !== title
```

去重语义。

### 不要这样修

禁止只做：

```ts
summary = event.text;
```

因为 terminal Runtime text 可能是：

```text
tool call (completed): ...
```

这样 Relay fallback title 仍然可能变成：

```text
tool call
```

或者输出摘要，而不是 path / command。

---

# 10. Tool kind parity

Pinned `acpx@0.13.1` Runtime tool kinds：

```text
read
edit
delete
move
search
execute
fetch
think
other
```

xacpx 当前 `ToolUseKind` 只支持：

```text
read
search
execute
edit
think
other
```

因此还缺：

```text
delete
move
fetch
```

建议本次顺带做完整 parity。

修改：

```text
src/channels/types.ts
```

为：

```ts
export type ToolUseKind =
  | "read"
  | "search"
  | "execute"
  | "edit"
  | "delete"
  | "move"
  | "fetch"
  | "think"
  | "other";
```

同步修改：

```text
src/transport/tool-kind-emoji.ts
```

以及所有 exhaustive `Record<ToolUseKind, ...>`。

---

# 11. Relay presentation

只有新增 kind 时才需要修改：

```text
packages/channel-relay/src/tool-presentation.ts
```

现有 read/edit/execute/search 的逻辑无需为本 bug 改写。

修复 merge 后，它们本来就能从 merged snapshot 中恢复：

### Read

```text
kind = read
rawInput.path / file_path
```

→ title = path

### Execute

```text
kind = execute
rawInput.command / cmd
```

→ title = command

### Edit

```text
kind = edit
content diff / rawInput path + old/new
```

→ diff card

所以不要在 presentation 层增加针对 `"tool call"` 的 hack。

---

## 11.1 新增 kind 建议 presentation

### delete

优先取：

```text
rawInput.file_path
rawInput.path
location
```

detail 可复用 fields，标题使用 path。

### move

优先展示：

```text
source → destination
```

可识别字段例如：

```text
from
to
source
destination
src
dest
old_path
new_path
```

无法识别时退 fields。

### fetch

优先：

```text
url
uri
href
```

detail 可使用 text/fields + rawOutput。

不要因为新 kind 增加过度 provider-specific 逻辑。

---

# 12. 必须的测试

本修复的核心是 **多帧 sequence behavior**。

只测单独的 `mapRuntimeToolEvent()` 不足以覆盖回归。

---

## Test 1 — Read sparse terminal update

输入：

```text
tool_call:
  id = "read-1"
  title = "Read"
  kind = "read"
  rawInput = {
    path: "/tmp/a.ts"
  }

tool_call_update:
  id = "read-1"
  title = "tool call"
  status = "completed"
```

断言最终 emitted snapshot：

```text
toolCallId = read-1
title = Read
kind = read
rawInput.path = /tmp/a.ts
status = completed
```

再经过 `mapRuntimeToolEvent()`：

```text
toolName = Read
kind = read
status = success
rawInput retained
```

再经过 relay presentation：

```text
title = /tmp/a.ts
detail.type = read
```

这是本 bug 的最小主回归。

---

## Test 2 — Execute keeps input and gains output

输入：

```text
tool_call:
  id = "bash-1"
  title = "Bash"
  kind = "execute"
  rawInput.command = "bun test"

tool_call_update:
  id = "bash-1"
  title = "tool call"
  status = "completed"
  rawOutput.formatted_output = "42 pass"
  rawOutput.exit_code = 0
```

最终必须同时有：

```text
title = Bash
kind = execute
rawInput.command = bun test
rawOutput.formatted_output = 42 pass
status = completed
```

Relay：

```text
title = bun test
detail.type = command
detail.command = bun test
detail.output = 42 pass
exitCode = 0
```

---

## Test 3 — Edit rich frame survives sparse completion

Initial：

```text
kind = edit
path / content / diff
```

Terminal：

```text
status = completed
title = tool call
```

最终：

```text
kind = edit
path retained
diff/content retained
status = success
```

Relay 必须仍然生成 diff detail。

---

## Test 4 — Real title update wins

输入：

```text
initial:
  title = "Read"

update:
  tag = tool_call_update
  title = "Read configuration"
```

断言：

```text
title = "Read configuration"
```

用于证明实现不是简单“update 不准修改 title”。

---

## Test 5 — Synthetic placeholder does not win

输入：

```text
initial title = "Bash"
update title = "tool call"
```

断言：

```text
title = "Bash"
```

---

## Test 6 — Missing fields preserve old fields

测试 update 分别省略：

```text
kind
rawInput
content
locations
```

断言全部保留。

---

## Test 7 — New rawOutput is appended to snapshot

Initial：

```text
rawInput exists
```

Update：

```text
rawOutput exists
```

最终：

```text
both exist
```

---

## Test 8 — Same toolCallId across two turns does not merge

Turn A：

```text
toolCallId = "1"
title = "Read"
```

结束。

Turn B：

```text
toolCallId = "1"
title = "Bash"
```

Turn B 最终不得带：

```text
Turn A rawInput/content/title
```

这是 per-turn accumulator 生命周期回归。

---

## Test 9 — No toolCallId stays passthrough

对于：

```text
tool_call without toolCallId
```

不得：

* crash
* 与其它无 ID event 合并
* 使用一个全局 fallback key

---

## Test 10 — kind parity

分别输入：

```text
delete
move
fetch
```

断言不会被 Runtime mapper 转为：

```text
other
```

如果本 patch 扩展 `ToolUseKind`，再分别验证 Relay presentation。

---

# 13. 推荐测试层级

至少覆盖三个层：

## A. Adapter normalization unit test

目标：

```text
AcpRuntimeEvent[]
→ mapEvents()
→ accumulated XacpxRuntimeEvent[]
```

这是最关键测试。

## B. RuntimeEngine structured event test

目标：

```text
merged runtime tool event
→ ToolUseEvent
```

验证：

```text
toolName
kind
summary
rawInput
rawOutput
status
```

## C. channel-relay presentation regression

使用最终 `ToolUseEvent` 验证：

```text
Read → path
Edit → diff/path
Bash → command
Search → query
```

避免 transport 修了但 UI presentation 又退化。

---

# 14. 非目标

本 patch 不处理：

* Relay Web 卡片布局重设计
* plan Runtime parity
* upstream `acpx` 修改
* tool protocol machine-name extraction 的全面 Runtime parity
* parentToolCallId/subagent metadata parity
* 修改 Relay 的 replace semantics

这些不属于当前 regressions 的根因。

---

# 15. 不建议方案

## 15.1 只补 `summary = event.text`

不接受。

它无法恢复：

```text
kind
rawInput
content
locations
```

而且 `"tool call (...)"` 本身就是错误信息源。

---

## 15.2 在 Relay 合并 ToolStepDto

不接受。

这会把 ACP transport semantics 泄漏到 channel 层，并且其它 channel 仍然出错。

---

## 15.3 terminal update 时忽略整个 event

不接受。

Terminal update 通常携带重要：

```text
status
rawOutput
exitCode
error
```

正确行为是：

```text
merge
```

而不是：

```text
drop
```

---

## 15.4 所有 `tool_call_update.title` 都忽略

不接受。

真实 title update 是合法的。

只针对已知 synthetic placeholder：

```text
"tool call"
```

在已有 richer title 时做保护。

---

# 16. 实现不变量

完成后必须满足以下 invariants：

### I1 — Identity preservation

同一个 `toolCallId` 的 sparse update 不得擦除此前已知 tool identity。

### I2 — Input preservation

terminal update 不得擦除：

```text
rawInput
content
locations
```

### I3 — Output accumulation

后续 `rawOutput` 必须可以加入此前 snapshot。

### I4 — Terminal truth

最终：

```text
completed → success
failed/error → error
```

且仍保留 rich initial metadata。

### I5 — Per-turn isolation

一个 turn 的 accumulator 不能影响其它 turn。

### I6 — Downstream snapshot contract

每一个发给 structured consumer 的 Runtime `ToolUseEvent` 都应代表：

> 当前这个 tool call 的完整 best-known state。

### I7 — Generic title cannot downgrade specificity

在已有具体 title 时：

```text
tool_call_update.title == "tool call"
```

不得把具体 title 降级为 generic placeholder。

---

# 17. 预期用户可见结果

修复前：

```text
tool call
tool call
tool call
```

修复后，例如：

```text
📖 /src/foo.ts

✏️ /src/foo.ts
  diff ...

💻 bun test
  42 pass

🔍 "worker fence" in src/
```

同一 tool call 的 running → completed 更新只更新同一张卡片：

```text
running
→
success
```

不会让标题、path、command、diff 在 terminal frame 消失。

---

# 18. 建议修改文件

主修复：

```text
src/bridge/engine/runtime/runtime-contract.ts

src/bridge/engine/runtime/runtime-adapter.ts
或
src/bridge/engine/runtime/runtime-tool-call-merge.ts

src/bridge/engine/runtime-engine.ts
```

kind parity：

```text
src/channels/types.ts
src/transport/tool-kind-emoji.ts
packages/channel-relay/src/tool-presentation.ts
```

tests：

```text
tests/unit/bridge/engine/runtime/...
tests/unit/bridge/engine/...
tests/unit/packages/channel-relay/...
```

实际测试文件名可按现有 test organization 放置，不要求为了本 spec 新建固定命名。

---

# 19. 验收条件

提交前必须全部满足：

1. Runtime Read 卡片最终仍显示文件路径，而不是 `tool call`。
2. Runtime Edit 最终仍显示 path/diff。
3. Runtime Bash 最终仍显示真实 command + output。
4. Sparse completed/error update 不擦除 initial metadata。
5. `"tool call"` synthetic update 不覆盖 rich title。
6. 真正的 non-generic title update 可以覆盖旧 title。
7. rawInput + rawOutput 可以同时存在于最终 event。
8. 两个 turn 之间 accumulator 完全隔离。
9. CLI structured tool behavior无回归。
10. Runtime text reply mode 无回归。
11. Relay replace-by-toolCallId 行为无需修改。
12. `delete/move/fetch` 如果纳入本 patch，则 Runtime → plugin API → relay presentation 全链路不再降级到 `other`。
13. `tsc --noEmit` 通过。
14. 相关 Runtime / bridge / channel-relay test suites 全绿。

---

# 20. 最终设计摘要

修复位置应位于：

```text
acpx Runtime public event
        ↓
runtime-adapter
        ↓
【per-turn, per-toolCallId snapshot normalization】
        ↓
XacpxRuntimeEvent
        ↓
Runtime worker / host
        ↓
ToolUseEvent snapshot
        ↓
Relay replace
```

核心原则：

> ACP 提供的是 delta；xacpx structured tool contract 对下游提供的必须是 snapshot。

terminal sparse update 只能补充：

```text
status
rawOutput
新的真实字段
```

不能擦除已经知道的：

```text
title
kind
rawInput
content
locations
```

尤其是 `acpx@0.13.1` 自动生成的 `"tool call"`，在 `tool_call_update` 中只能作为 fallback placeholder，不能降级一个已经具备更具体 identity 的 tool call。

---

# 21. 已知局限与 Gaps (Known Limitations)

### Claude Status-less Terminal Parity Gap

Pinned `acpx@0.13.1` Runtime `tool_call` event 没有透传 `_meta` 字段。当 Claude emitted 一个省略了 `status`、仅在 `_meta.claudeCode.toolResponse` 中携带执行结果的 sparse terminal frame 时，Runtime engine 无法区分它是 keep-alive running 还是 completed terminal，因此会保持 `running`。CLI 链路能够通过 `hasClaudeToolResponse` 判定完成并关闭 spinner。此 parity gap 需要 upstream acpx 在 Runtime `tool_call` event 中暴露 `_meta` 或规范化 `status` 信号，当前保留 mapping logic 不变。
