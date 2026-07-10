# control-service executeTurn 拆分 — 设计 spec

**归属**：2026-07 架构审读轨道 3(核心可维护性重构）第二块。第一块 `orchestration-service` 拆分已合入 main（PR #146/#147，squash `648a8e4`/`07874c0`），靠一层黄金特征化 oracle 保证行为等价。本 spec 沿用同一方法论。

**状态**：已批准（brainstorming 三节全部确认，2026-07-10）。分支 `refactor/control-turn-queue-split`，base `origin/main`(`54be207`)。

---

## 目标（一句话）

把 `src/control/control-service.ts` 的 `executeTurn`（约 290 行，`inFlight`/`queues`/`draining` 三态并发闸门）拆成两个可独立测试的单元 —— `TurnQueue`（并发原语）与 `SessionTurnRunner`（单次 turn 执行）—— **零行为变更**。

## 为什么

`executeTurn` 一个方法混了五类职责：并发闸门、会话解析 + `sessions-changed` 检测、media sandbox 过滤、stream/batched 段落重建、`agent.chat` 驱动 + 8 种事件发射。核心并发不变量**全靠同步执行顺序**维持（`inFlight.set` 在首个 `await` 前、`draining.add` 在 fire-and-forget 前）——这是 microtask 时序敏感的，重排一个 `await` 就可能破坏它。代码里三处注释自陈"永久 wedge"风险（`control-service.ts` 约 562/570/831 行，行号以本 spec 落地时的实际为准）。

拆分后，那三处 wedge 的同步时序从"散落在 942 行大类里"变成"内聚在一个喂假 `runTurn` 就能穷举时序的单元"。

## 非目标

- **不碰** `control-service.ts` 里 `executeTurn` 之外的约 650 行（fs / session CRUD / scheduled / orchestration 转发）。聚焦并发闸门。
- **不修** 三处 wedge 的隐患本身。行为等价重构：现有行为（包括脆弱处）原样保留，只是变得可测。wedge 的根治属于未来行为变更 spec。
- **不改** 任何现有测试文件。它们是回归判据。

---

## 架构：三个单元的边界

### `TurnQueue`（新，`src/control/turn-queue.ts`）

并发原语。**零 `import` agent / session / uploadStore**。

- 持有 `inFlight` / `queues` / `draining` 三态。
- **所有 microtask 同步时序不变量内聚在这**：`inFlight.set` 在首个 `await` 前、`advanceQueue` 里 `draining.add` 在 fire-and-forget 的 drained turn 之前。
- 构造接收 `{ runTurn(req, signal): Promise<Result>, emitQueueUpdated(key) }`。`runTurn` 是 `submit` 内**唯一的 await 点**（除 Stop-followup 分支的 `raceWithTimeout`，见下）。
- API：
  - `submit(key, req, { queueable }): Promise<Result | { queued: true, queueItemId }>` —— 含 busy 判定、排队、drain 交接、`CANCEL_DRAIN_TIMEOUT` 等待。
  - `cancelTurn(key): boolean`
  - `cancelQueuedItem(key, itemId): { cancelled: boolean }`
  - 同步查询：`queueLength(key): number`、`isBusy(key): boolean` —— 供白盒同 tick 断言。
- `submit` 的 busy 判定 + inFlight 登记 + 入队是**纯同步前缀**（常规路径）。唯一带 `await` 的决策分支是 Stop-followup 的 `raceWithTimeout(existing.settled, CANCEL_DRAIN_TIMEOUT_MS)`（wedge #2），与当前 executeTurn 等价。

### `SessionTurnRunner`（新，`src/control/session-turn-runner.ts`）

一次 turn 的完整执行，就是 `TurnQueue` 的 `runTurn` 回调实现。**不碰任何并发状态**。

- session 解析、archived / `/clear` 检测 → `sessions-changed`。
- media sandbox 过滤（逃逸上传根就丢弃）、stream vs batched 段落重建（复用已成型的纯函数）。
- `agent.chat` 驱动 + 8 种事件发射、`turn-started` / `turn-finished`。
- 给定 req，跑一次，发事件，返回 `Result`。

### `ControlService.executeTurn`

退化为：组装 req → `this.turnQueue.submit(...)`。`prompt()`(queueable) 与 `runScheduledTurn()`(不 queueable) 几乎不变。

### 事件归属

- `queue-updated` 由 **TurnQueue** 发（它是排队状态变化的唯一来源）。
- `turn-started` / `turn-finished` / `turn-output` / `turn-thought` / `plan` / `turn-usage` / `agent-commands` / `tool-event` / `sessions-changed` 由 **SessionTurnRunner** 发（一次执行的生命周期）。
- **数据流，非归属冲突**：`turn-started` 事件始终由 runner 发；当它是一个 drained 队列头时，其 `queueItemId` 字段的值由 TurnQueue 通过 `req` 传入（TurnQueue 知道哪个队列项正在 drain，runner 只是把它盖进事件）。同理 drained 头**不**重发 `prompt` 字段（hub 已在入队时持久化，重发会双持久化）——这条约束随 `req` 从 TurnQueue 流向 runner。

---

## 等价性判据：两层测试

### 黑盒 oracle（跨重构，等价性判据）

一个 characterization harness，面向 `ControlService` 公开面（`prompt` / `runScheduledTurn` / `cancelTurn` / `cancelQueuedItem`）驱动。**不窥探 private 三态**——只记两样跨整个场景的东西：

1. **事件发射有序日志** —— 每次 `deps.events.emit(evt)` 记 `{ type + 关键字段 }`。`emit` 是同步的，harness 按调用顺序 append，**所以日志顺序 = 真实执行顺序（含跨 microtask）**。
2. **每个入口调用的返回** —— `{ ok }` / `{ queued, queueItemId }` / `{ ok:false, "turn-already-running" }`。

**驱动方式**：假 `agent.chat` 用**可控 deferred**（手动决定何时 resolve / reject / abort）；假 `events` 记有序日志；session / uploadStore 用最小 stub。

**场景集**（8 个，覆盖三处 wedge）：

1. busy 时第二个 prompt 入队（不 reject），发 `queue-updated`。
2. scheduled turn 不入队仍 reject（`queueable` 缺省）。
3. 队列 FIFO drain，每个各自成 turn。
4. drain 交接窗口到达的 prompt 被入队（无并行 turn）。
5. drained 头 `useSession` 失败仍 drain 后续队列项（无 stranded tail）。
6. **cancel 清空队列时清 `draining`（wedge #3，无永久 wedge）**。
7. **同 tick 两个 prompt 并发发起：恰一个赢，另一个入队**（见下"同 tick 时序"）。
8. **Stop 后 follow-up 等被 cancel 的 turn drain 完再跑（wedge #2，`raceWithTimeout`）**。

**同 tick 时序（场景 7 的强化）**：两个 `prompt` 在同一同步 tick 内并发发起（`const pA = svc.prompt(A); const pB = svc.prompt(B); await Promise.all([pA, pB])` —— 绝不 `await` 第一个再发第二个）。当前实现下 B 的 `queue-updated` 同步发、A 的 `turn-started` 在 await 链之后，基线日志形如 `[queue-updated([B]), turn-started(A), ...]`。任何改变这个相对顺序的时序回归（busy 判定从同步变跨 await → 两个都 `turn-started`、无 `queue-updated`）都让序列变、oracle 红。

**盲区（诚实记录）**：纯粹多一个 `await Promise.resolve()`、却不改变任何事件相对顺序的 hop 增加——黑盒看不见。由白盒层覆盖。

### 白盒 TurnQueue 单测（重构后新增，兑现"新单元可测"）

直接喂假 `runTurn`（可控 resolve 时点），穷举 busy / 排队 / drain / cancel / wedge 时序。

**同 tick 同步断言（覆盖黑盒盲区）**：`submit` 的同步前缀契约使得——

```
tq.submit(A);                        // 同步 inFlight.set
tq.submit(B);                        // 同步入队
expect(tq.queueLength(key)).toBe(1); // 同步断言,不 await
```

如果重构让 busy 判定跨了一个 `await`，这行同步断言时 `queueLength` 还是 0，直接失败——连"不改变事件顺序的纯 hop"也抓得住。

### 现有测试

`tests/unit/control/control-service-queue.test.ts`、`control-service-prompt.test.ts`、`control-service-prompt-status.test.ts` 等**一字不改**，全程绿。

---

## 阶段划分（交给 writing-plans）

| 阶段 | 做什么 | 判据 |
|---|---|---|
| **0** | 建黑盒事件-日志 harness，**在重构前 commit（`54be207`）、独立 git worktree** 对当前 `executeTurn` 录基线 fixture（8 个并发场景）。若发现现有测试未覆盖的边角，**新增**测试补上（不改现有文件） | fixture 在基线上自我复现绿，`GOLDEN_UPDATE` 仅在基线 worktree 出现 |
| **1** | 抽 `SessionTurnRunner`：把 turn 执行体搬进去，`executeTurn` 调它 | oracle + 现有测试全绿 |
| **2** | 抽 `TurnQueue`：三态闸门搬进去，`executeTurn` 退化为 `submit`；新增 TurnQueue 白盒单测（含同 tick 同步断言 + 三处 wedge 变异验证） | oracle + 现有测试 + 白盒全绿 |
| **3** | `ControlService` 收尾，删死代码，注释迁移 | 全绿 + `npx tsc --noEmit` |

## 纪律（照搬 orchestration 的血泪教训）

- **基线 fixture 必须在重构前 commit（`54be207`）、独立 worktree 里录**，再让重构后的实现复现——绝不拿重构后行为当基线，否则把回归洗进新基线。`GOLDEN_UPDATE=1` 只在基线 worktree 出现。
- **每个关键不变量靠变异验证**：删掉 `draining.add`、把 `inFlight.set` 挪到 await 后、把 busy 判定跨一个 await —— 各自必须让对应的 oracle 场景或白盒断言变红。变异先 `grep` 确认应用成功再下结论。
- **逐文件 `bun test`**，never 整目录（模块状态泄漏→假失败）。
- **子代理 git 卫生**：实现子代理不跑任何 git 命令，controller 自己 `git log` 核实真实提交；会改文件的评审子代理必须 `isolation: "worktree"`。
- **值导入是真运行时循环**：子服务 `import type` 门面安全，但自由函数/常量从门面 import 回来会成环——自由函数迁中立模块。
- **microtask hop 敏感**：`turn-finished` finally 里的 `draining.add`、`advanceQueue` 的 fire-and-forget `void executeTurn(...)` 是同步时序不变量的载体，搬运时保持同步执行顺序；hop 深度靠变异验证，不靠猜。

## 落点

- `src/control/turn-queue.ts`（新）
- `src/control/session-turn-runner.ts`（新）
- `src/control/control-service.ts`（`executeTurn`/`advanceQueue`/`cancelTurn`/`cancelQueuedItem` 迁出，退化为 `submit` 组装）
- `tests/unit/control/golden/`（新，黑盒事件-日志 harness + fixture）
- `tests/unit/control/turn-queue.test.ts`（新，白盒单测）
