# Relay-Web 普通 Agent Turn 完成后 Web Push 实现方案

## 目标

扩展现有 Web Push 功能，使用户从 **relay-web 直接向普通 session 发送 prompt** 后，当该 turn 真正结束时，也能收到桌面通知。

当前 #305 只覆盖：

```text
orchestration task
→ notifyTaskCompletion()
→ instanceNotice(kind="task-completion")
→ Hub Web Push
```

`RelayChannel.notifyTaskCompletion()` 确实只负责 orchestration completion notice。 Hub 也只在 `notice.kind === "task-completion"` 时调用 `PushNotifier`。

普通 relay-web prompt 的真实链路则是：

```text
relay-web
→ POST/RPC MSG.prompt
→ connector
→ turn-started
→ turn-output/tool-event/...
→ turn-finished
```

目前 `turn-finished` 只持久化历史和广播，不触发 Web Push。

---

# 一、核心原则

**禁止直接做：**

```ts
if (event.type === "turn-finished") {
  push();
}
```

这会把以下全部误通知：

```text
scheduled turn
peer/agent-message turn
orchestration worker/internal turn
recovery replay
state-sync 恢复
其他非 relay-web 用户直接发起的 turn
```

正确规则应该是：

> **只有“由当前账号通过 relay-web 的 MSG.prompt RPC 发起的用户交互 turn”结束时，才发普通 turn-completion Web Push。**

因此必须建立：

```text
web prompt
      ↓
prompt identity / provenance
      ↓
turn-started
      ↓
live TurnAccumulator 继承 provenance
      ↓
turn-finished
      ↓
Web Push exactly once
```

不要通过 `sessionAlias` 猜来源。

---

# 二、利用现有 `promptRequestId`

当前 Hub 的 Web RPC 层已经有非常适合做这件事的 correlation ID。

`MSG.prompt` 在转发 connector 前会：

1. 先持久化 inbound message；
2. 生成 `randomUUID()`；
3. 保存为 `promptRequestId`；
4. 注入转发给 connector 的 prompt payload。

现有代码：

```ts
const promptRequestId = randomUUID();

persistedPromptId = deps.messages.append(
  instance.id,
  p.sessionAlias,
  "in",
  p.text,
  undefined,
  attachments,
  promptRequestId,
);

(payload as Record<string, unknown>).promptRequestId =
  promptRequestId;
```

这就是本功能应该复用的唯一身份。

**不要新增另一套 notification request ID。**

---

# 三、协议要求：`turn-started` 必须可靠携带 `promptRequestId`

协议 DTO 当前已经支持：

```ts
{
  type: "turn-started";
  chatKey: string;
  sessionAlias: string;
  promptRequestId?: string;
  ...
}
```

并且注释明确说明它用于把 queued prompt drain 回关联到 Hub 已预写的 inbound row。

实现 agent 第一件事应审计：

```text
relay-web MSG.prompt
→ Hub 注入 promptRequestId
→ channel-relay
→ ControlService / TurnQueue
→ turn-started.promptRequestId
```

### Gate

无论 prompt 是：

```text
立即执行
```

还是：

```text
busy session
→ queued
→ later drain
```

最终真实的：

```text
turn-started
```

都必须携带**原始同一个**：

```text
promptRequestId
```

如果目前 immediate path 没有回显，只修这个传递链，不要在 Hub 用文本匹配兜底。

---

# 四、不要把 `promptRequestId` 加到所有 turn-finished

不需要为了这个功能把：

```ts
promptRequestId
```

继续塞进：

```text
turn-output
tool-event
turn-finished
```

Hub 本来就有 live `TurnAccumulator`，而且每个 `(instanceId, sessionAlias)` 的活动 turn 已经由：

```ts
turn-started
```

创建，由：

```ts
turn-finished
```

销毁。

直接扩展 accumulator：

```ts
interface TurnAccumulator {
  text: string;
  steps: Map<string, ToolStepDto>;
  reasoning: string;
  parts: TurnPartDto[];
  startedAt: number;
  truncated?: boolean;

  webPromptRequestId?: string;
}
```

在 `turn-started`：

```ts
const accumulator = {
  ...,
  webPromptRequestId:
    typeof event.promptRequestId === "string"
      ? event.promptRequestId
      : undefined,
};
```

然后 `turn-finished` 时：

```ts
const a = turnBuffers.get(k);
turnBuffers.delete(k);

if (a?.webPromptRequestId) {
  // eligible interactive web turn
}
```

这样来源跟着**实际 turn 生命周期**走。

---

# 五、必须区分“Web prompt”与其他可能携带 ID 的来源

更严谨的方案是 Hub 维护一个短生命周期的 provenance registry：

```ts
const pendingWebPrompts = new Set<string>();
```

当 `/rpc MSG.prompt` 被 relay-web 接收并成功准备转发时：

```ts
pendingWebPrompts.add(promptRequestId);
```

当 Hub 收到：

```text
turn-started.promptRequestId
```

只有：

```ts
pendingWebPrompts.has(event.promptRequestId)
```

时才：

```ts
accumulator.notificationOrigin = "relay-web";
pendingWebPrompts.delete(event.promptRequestId);
```

而不是：

```ts
if (event.promptRequestId) assume relay-web
```

这是更好的安全/语义边界。

建议结构：

```ts
interface TurnNotificationContext {
  origin: "relay-web";
  promptRequestId: string;
}

interface TurnAccumulator {
  ...
  notification?: TurnNotificationContext;
}
```

---

# 六、`pendingWebPrompts` 生命周期

这里必须避免内存泄漏。

推荐：

```ts
Map<
  string,
  {
    instanceId: string;
    sessionAlias: string;
    createdAt: number;
  }
>
```

而不是裸 Set。

例如：

```ts
const pendingWebPrompts = new Map<
  string,
  {
    instanceId: string;
    sessionAlias: string;
    createdAt: number;
  }
>();
```

收到 `turn-started` 时必须同时验证：

```ts
pending.instanceId === instanceId
pending.sessionAlias === event.sessionAlias
```

才 consume。

### 清理

需要：

* prompt RPC 明确失败 → 删除；
* queue cancel → 最终不要通知；
* TTL 清理遗留 entry；
* runtime close → map 自然释放。

TTL 可以比较宽：

```text
24h
```

或者跟 queue 最大生存语义对齐。

重点是不要永远积累。

---

# 七、什么时候注册 provenance

建议在 Hub `/rpc` 的 `MSG.prompt` 路径上注册。

当前代码在发送 connector RPC 前已经生成 `promptRequestId`。

给 `createApp()` 增加一个内部 callback：

```ts
export interface AppDeps {
  ...
  onWebPromptCreated?: (input: {
    promptRequestId: string;
    instanceId: string;
    sessionAlias: string;
  }) => void;

  onWebPromptRejected?: (promptRequestId: string) => void;
}
```

或者更简单：

```ts
trackWebPrompt(...)
untrackWebPrompt(...)
```

由 `server.ts` 持有 Map，`http/app.ts` 不应该自己知道 PushNotifier。

**不要让 HTTP layer 直接发通知。**

职责保持：

```text
HTTP app
→ 标记来源

server runtime
→ 管 turn 生命周期

PushNotifier
→ 只负责发送
```

---

# 八、queued prompt 是必测路径

这是本 PR 最容易写错的地方。

普通场景：

```text
Prompt A starts
Prompt B submitted while A running
→ B queued
```

对于 B：

```text
HTTP 收到 B
→ promptRequestId = B-id
→ pendingWebPrompts[B-id]
→ connector returns { queued: true, queueItemId }
```

现有 Hub 已经会把这个 prompt 标记为 queued。

后来：

```text
A finishes
→ B drains
→ turn-started(promptRequestId=B-id)
```

此时才：

```text
pendingWebPrompts[B-id]
→ accumulator.notification.origin=relay-web
→ consume registry
```

最后：

```text
B turn-finished
→ push B completion
```

不能在：

```text
MSG.prompt RPC resolves
```

时推。

也不能在：

```text
queue dequeue
```

时推。

---

# 九、Recovery / restart：明确“不补发通知”

这个功能应采取：

> **Web Push 只针对 live turn completion，不针对历史恢复。**

Hub 当前已经处理：

```text
state-sync
finishedOffline
recoveryId
cross-restart dedup
```

并能在没有 live accumulator 时用 `turn-finished.text` 修复历史。

这种：

```ts
const a = turnBuffers.get(k);
```

结果为：

```text
undefined
```

时：

**绝对不要发 turn-completion Push。**

即：

```ts
if (!a?.notification) {
  no push;
}
```

这样可以天然避免：

```text
Hub 重启
→ connector 恢复旧完成
→ 用户突然收到过去任务的通知
```

---

# 十、Peer / Agent Messaging 必须排除

当前 `turn-started` / `turn-finished` 已经支持：

```ts
peerOrigin?: PeerTurnOriginDto
```

这类 turn 是 agent-to-agent turn。

即使未来某个错误路径碰巧带有 prompt correlation，也加一个 defense-in-depth：

```ts
if (event.peerOrigin) {
  notification = undefined;
}
```

最终 Gate：

```ts
eligible =
  a.notification?.origin === "relay-web"
  && !event.peerOrigin;
```

---

# 十一、Scheduled turn 必须排除

`turn-started` 已经有：

```ts
scheduled?: ScheduledOriginDto
```

scheduled task 不是用户刚刚从 relay-web 发的 interactive prompt。

所以：

```ts
if (event.scheduled) {
  do not attach relay-web notification provenance;
}
```

即使它的 session 也是普通 session。

---

# 十二、Orchestration task 不得双通知

现在 orchestration 已经：

```text
task completion
→ instanceNotice.task-completion
→ Web Push
```

这个路径继续保持。

不要把它改成统一监听所有 `turn-finished`。

否则典型 delegated worker 会变成：

```text
worker turn-finished
→ 普通 turn push

orchestration task completion
→ task-completion push
```

用户收到两条。

正确状态：

```text
interactive relay-web prompt
→ turn completion push

orchestration task
→ existing task-completion push
```

互不覆盖。

---

# 十三、成功 / 失败 / 取消的通知语义

第一版建议：

### 成功

```ts
event.ok === true
```

→ 发通知。

### 失败

建议也发。

用户离开浏览器后，如果 agent 失败，失败本身同样值得通知。

例如：

```text
Codex
任务失败

connection reset / provider error / ...
```

### Cancelled

建议 **不发**。

原因：

```text
用户自己点击 Cancel
→ 几秒后系统又弹“任务已完成”
```

体验很差。

推荐 Gate：

```ts
if (event.cancelled === true) {
  no push;
}
```

所以：

```text
ok=true                  → notify
ok=false,cancelled=false → notify failure
cancelled=true           → no notify
```

---

# 十四、PushNotifier API 不要继续叫 `sendTaskCompletion`

当前类只有：

```ts
sendTaskCompletion(...)
```

建议抽象成：

```ts
sendCompletion(
  accountId,
  {
    kind: "task" | "turn",
    instanceId,
    instanceName,
    sessionAlias?,
    title,
    text,
    status?,
  },
)
```

或者保留兼容 wrapper：

```ts
sendTaskCompletion(...)
sendTurnCompletion(...)
```

两者内部走共享：

```ts
sendNotificationToAccount(...)
```

推荐后者，改动小：

```ts
sendTaskCompletion(...)
sendTurnCompletion(...)
```

内部：

```ts
private sendToAccount(...)
```

---

# 十五、普通 turn 通知内容

建议：

### title

```text
<instance name> · <session alias/display name>
```

例如：

```text
MacBook · backend
```

如果 Hub 当前拿不到 displayName，先：

```text
MacBook · backend
```

不要为这次功能新增一套 session metadata同步。

### body

成功：

```text
agent 最终回复文本前 200 字
```

失败：

```text
Task failed: <errorMessage>
```

如果 final text 为空：

```text
Task completed
```

---

# 十六、最好让通知点击直接定位到 session

现在 #305 payload 固定：

```ts
url: "/"
```

建议顺手增强为 relay-web 当前真实 session route。

如果已有稳定 URL，例如：

```text
/?instance=<id>&session=<alias>
```

或者 router 有 session route，就使用它。

如果没有稳定 deep-link，本 PR 不要创造复杂 routing，继续：

```ts
url: "/"
```

功能正确优先。

---

# 十七、是否在网页前台时也通知

第一版**不要做 active-tab suppression**。

原因是服务器不知道：

```text
哪个 subscription 对应哪个 tab
哪个 tab focused
用户开了多少浏览器
```

可以以后在 Service Worker：

```js
clients.matchAll(...)
```

判断同 origin 是否有 focused window 再选择 suppression。

这不是本 PR 的核心。

先保证：

```text
background / closed Chrome
→ reliable push
```

---

# 十八、Push 可观测性必须补

这次现场排障暴露出 #305 Push 链路太黑盒。

当前：

```text
无订阅 → 静默
成功 → 静默
失败 → relay.push.send_failed
```

建议加 structured logging。

### 发起 fanout

```text
relay.push.fanout
```

字段：

```ts
{
  kind: "turn-completion",
  accountId,       // 如果项目日志策略允许；不允许则不要
  instanceId,
  subscriptionCount
}
```

### 成功

```text
relay.push.sent
```

```ts
{
  kind: "turn-completion",
  instanceId,
  endpointHost
}
```

### 无订阅

```text
relay.push.no_subscriptions
```

### 失败

继续：

```text
relay.push.send_failed
```

**绝对不要打印完整 endpoint。**

当前 `safeHost()` 已经专门避免泄漏完整 Push endpoint，这个安全策略继续保持。

---

# 十九、关键测试

## Gate 1：普通 relay-web prompt

真实 Hub seam：

```text
POST/RPC MSG.prompt
→ promptRequestId
→ turn-started(same promptRequestId)
→ turn-output("done")
→ turn-finished(ok=true)
```

断言：

```text
PushNotifier.sendTurnCompletion == 1
```

内容包含：

```text
instanceId
sessionAlias
done
```

---

## Gate 2：无 prompt provenance 的 turn-finished

```text
turn-started(no promptRequestId)
→ turn-finished
```

断言：

```text
0 pushes
```

---

## Gate 3：orchestration 不重复

```text
orchestration worker turn
→ turn-finished
→ instanceNotice(task-completion)
```

断言：

```text
ordinary turn push = 0
task-completion push = 1
```

总计：

```text
1
```

不是 2。

---

## Gate 4：scheduled turn

```text
turn-started({
  scheduled: ...
})
→ turn-finished
```

断言：

```text
0 ordinary completion push
```

---

## Gate 5：peer turn

```text
turn-started({
  peerOrigin: ...
})
→ turn-finished({
  peerOrigin: ...
})
```

断言：

```text
0
```

---

## Gate 6：cancelled

```text
relay-web prompt
→ turn-started
→ turn-finished({
  ok: false,
  cancelled: true
})
```

断言：

```text
0
```

---

## Gate 7：failed

```text
relay-web prompt
→ turn-started
→ turn-finished({
  ok: false,
  errorMessage: "provider unavailable"
})
```

断言：

```text
1 push
```

body 能表达失败。

---

## Gate 8：queued prompt

必须是完整链路：

```text
Prompt A active

Web submits Prompt B
→ B gets promptRequestId
→ RPC returns queued
→ no push

A finishes
→ no B push yet

B turn-started(promptRequestId)
→ B turn-finished
→ exactly 1 push
```

这是 blocking test。

---

## Gate 9：queue cancel

```text
Web prompt B queued
→ cancel queue item
→ B never turn-started
```

断言：

```text
0 push
```

并确认 pending provenance 最终会清理。

---

## Gate 10：Hub restart / recovered finish

模拟：

```text
turn-finished
without live TurnAccumulator
```

即使：

```text
text="finished while hub down"
```

也必须：

```text
0 push
```

---

## Gate 11：duplicate finish

如果 connector 异常重复发：

```text
same turn-finished twice
```

第一次：

```text
accumulator exists → push
```

第二次：

```text
accumulator gone → no push
```

最终：

```text
exactly 1 push
```

---

# 二十、建议改动文件

主要：

```text
packages/relay/src/server.ts
packages/relay/src/http/app.ts
packages/relay/src/push.ts
```

可能需要：

```text
packages/channel-relay/src/channel.ts
packages/relay-protocol/src/dtos.ts
packages/relay-protocol/src/messages.ts
```

只有在审计发现 `promptRequestId` immediate path 没有正确传进 `turn-started` 时才改 protocol/connector。

测试：

```text
tests/unit/packages/relay/runtime-fanout.test.ts
tests/unit/packages/relay/http*.test.ts
tests/unit/packages/channel-relay/channel.test.ts
```

优先扩充已有 suite，不要重复建测试体系。

---

# 二十一、不要做的实现

明确禁止：

```ts
turn-finished => always push
```

禁止：

```ts
sessionAlias === something
```

推测来源。

禁止：

```ts
final text matching inbound prompt
```

做 correlation。

禁止：

```ts
setTimeout(...)
```

猜哪个 turn 对应哪个 request。

禁止让 relay-web 客户端自己在收到：

```text
turn-finished
```

时调用：

```text
new Notification(...)
```

这解决不了标签页关闭场景，也违背 Web Push 的设计目的。

正确 ownership 必须在 Hub。

---

# 二十二、推荐最终结构

```text
relay-web
   │
   │ MSG.prompt
   ▼
Hub HTTP RPC
   │
   ├─ persist inbound
   ├─ generate promptRequestId
   └─ pendingWebPrompts[id] = provenance
             │
             ▼
         connector
             │
             ▼
turn-started(promptRequestId)
             │
             ▼
Hub matches pending provenance
             │
             ▼
TurnAccumulator {
  notification: {
    origin: "relay-web",
    promptRequestId
  }
}
             │
     output / tools / reasoning
             │
             ▼
       turn-finished
             │
       ┌─────┴─────┐
       │           │
cancelled        normal
   │               │
 no push           ▼
             persist history
                   │
                   ▼
         PushNotifier.sendTurnCompletion()
                   │
             account subscriptions
                   │
          ┌────────┴────────┐
          ▼                 ▼
       Chrome             Safari
```

---

# PR 验收标准

在以下全部成立前不要合并：

1. relay-web 普通 prompt 成功完成 → **1 条 Push**。
2. 普通 prompt 失败 → **1 条失败 Push**。
3. 用户取消 → **0 Push**。
4. queued prompt 只在真实执行完成后 Push。
5. queued 后取消 → 0 Push。
6. orchestration completion 仍然只有原来的 1 条，不重复。
7. scheduled turn → 0 ordinary Push。
8. peer/agent-message turn → 0 ordinary Push。
9. recovery/state-sync/history replay → 0 Push。
10. duplicate `turn-finished` → exactly once。
11. Chrome 现有 `task-completion` Push 不回归。
12. Safari 支持 PR 如果已合入，两种 provider 都走同一 `sendTurnCompletion`。
13. Relay unit tests 全绿。
14. Relay-Web tests 全绿。
15. TypeScript typecheck 全绿。
16. build 全绿。
17. 手工真实 Chrome 验证：

    * 开启通知；
    * relay-web 普通 session 发 prompt；
    * 切到其他页面/关闭 relay-web；
    * agent 完成；
    * 收到系统通知。

这个方案的关键是 **“prompt provenance 跟随真实 turn”**，而不是扩大 `turn-finished` 的触发范围。这样能解决你现在真正遇到的问题，同时不会把后台 orchestration 和 agent-to-agent 活动变成通知轰炸。
