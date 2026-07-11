# control-service executeTurn 拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/control/control-service.ts` 的 `executeTurn`（约 290 行三态并发闸门）拆成 `TurnQueue`（并发原语）+ `SessionTurnRunner`（单次执行），零行为变更。

**Architecture:** `ControlService.executeTurn` 退化为组装 req → `TurnQueue.submit`。`TurnQueue` 持有 `inFlight`/`queues`/`draining` 三态与所有 microtask 同步时序不变量，唯一 await 点是 `runTurn` 回调；`SessionTurnRunner` 是那个回调，负责 session 解析/media/段落/`agent.chat`/事件发射。等价性靠两层测试：黑盒事件-日志 oracle（重构前 commit 独立 worktree 录基线）+ 白盒 TurnQueue 单测（零 await 同 tick 同步断言）。

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`)，Bun test，DI 注入。

## Global Constraints

- **零行为变更**。三处 wedge 隐患本身不修，只是变可测。
- **现有测试一字不改**：`tests/unit/control/control-service-queue.test.ts`、`control-service-prompt.test.ts`、`control-service-prompt-status.test.ts` 等全程绿。这是回归判据的一半。
- **基线 fixture 必须在重构前 commit（`54be207`）、独立 git worktree 里录**。`GOLDEN_UPDATE=1` 只在基线 worktree 出现，绝不对重构后的代码录基线。
- **逐文件 `bun test`**，never 整目录（模块状态泄漏 → 假失败）。
- **每个并发不变量靠变异验证**：删 `draining.add`、把 `inFlight.set` 挪到 await 后、把 busy 判定跨一个 await —— 各自必须让对应 oracle 场景或白盒断言变红。变异先 `grep` 确认应用成功再下结论。
- **值导入是真运行时循环**：子模块 `import type` 门面安全，但自由函数/常量（`turnKey`/`toErrorMessage`/`buildControlMetadata`/`raceWithTimeout`/`CANCEL_DRAIN_TIMEOUT_MS`/`QUEUE_PREVIEW_MAX`）从门面 import 回来会成环 —— 迁到中立模块 `src/control/turn-support.ts`，门面 `export { … } from "./turn-support"` 保住既有 import 路径。
- **子代理 git 卫生**：实现子代理不跑任何 git 命令；controller 自己 `git log`/`git status` 核实真实提交；会改文件的评审子代理必须 `isolation: "worktree"`。
- **TZ=UTC**：`npm test` 需要 `TZ=UTC`（`src/commands` 一个测试硬编码 UTC）。

---

## File Structure

| 文件 | 责任 | 阶段 |
|---|---|---|
| `src/control/turn-support.ts`（新） | 中立模块：`turnKey`/`toErrorMessage`/`buildControlMetadata`/`raceWithTimeout`/`CANCEL_DRAIN_TIMEOUT_MS`/`QUEUE_PREVIEW_MAX`/`QueuedPrompt` 类型 + `TurnRequest`/`TurnResult` 类型 | 1 |
| `src/control/session-turn-runner.ts`（新） | 单次 turn 执行：session 解析、archived/clear→sessions-changed、media sandbox、stream/batched 段落、`agent.chat`、8 种事件 + turn-started/finished | 1 |
| `src/control/turn-queue.ts`（新） | 并发原语：`inFlight`/`queues`/`draining`、`submit`/`cancelTurn`/`cancelQueuedItem`/`queueLength`/`isBusy`、`advanceQueue` drain 交接 | 2 |
| `src/control/control-service.ts`（改） | `executeTurn`/`advanceQueue`/三态字段迁出；`prompt`/`runScheduledTurn` 组装 req → `turnQueue.submit`；re-export turn-support | 1-3 |
| `tests/unit/control/golden/turn-oracle-harness.ts`（新） | 黑盒 harness：可控 deferred agent + 记录事件发射有序日志 + 入口返回；`expectMatchesFixture` | 0 |
| `tests/unit/control/golden/turn-oracle.test.ts`（新） | 8 个并发场景，驱动 ControlService 公开面，比对 fixture | 0 |
| `tests/unit/control/golden/fixtures/*.json`（新） | 8 个基线 fixture，在 `54be207` 录 | 0 |
| `tests/unit/control/turn-queue.test.ts`（新） | 白盒单测：喂假 `runTurn`，含零 await 同 tick 同步断言 + 三处 wedge 变异验证用例 | 2 |

---

## Task 0：黑盒事件-日志 oracle harness + 基线 fixture

**Files:**
- Create: `tests/unit/control/golden/turn-oracle-harness.ts`
- Create: `tests/unit/control/golden/turn-oracle.test.ts`
- Create: `tests/unit/control/golden/fixtures/*.json`（8 个，在基线 worktree 录）

**Interfaces:**
- Consumes: `ControlService`（公开面 `prompt`/`runScheduledTurn`/`cancelTurn`/`cancelQueuedItem`），`createControlEventBus`/`ControlEvent`（`src/control/control-event-bus`）。
- Produces: `makeTurnOracle()` 返回 `{ service, log, controls }`：
  - `log: OracleEntry[]` —— 有序日志，条目形如 `{ kind: "event", event: {type, …fields} }` 或 `{ kind: "return", label, value }`。
  - `controls.resolveChat(index?)` / `controls.rejectChat(index?, msg)` / `controls.abortChat(index?)` —— 逐个控制挂起的 `agent.chat`（FIFO）。
  - `expectMatchesFixture(name, log)` —— 深比较 parsed JSON，`GOLDEN_UPDATE=1` 时写 fixture。

- [ ] **Step 1: 建 harness，可控 deferred agent + 有序事件日志**

`tests/unit/control/golden/turn-oracle-harness.ts`：

```ts
// tests/unit/control/golden/turn-oracle-harness.ts
// Black-box characterization oracle for ControlService's turn machinery. Records, in
// order, every event ControlService emits AND every entry-call return value across a
// scenario. `deps.events.emit` is synchronous, so the log order IS the execution order
// (across microtasks) — that is how this catches a same-tick timing regression that a
// plain result assertion cannot see. Drives ControlService's PUBLIC surface only; never
// inspects the private inFlight/queues/draining maps.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
import { createControlEventBus, type ControlEvent } from "../../../../src/control/control-event-bus";
import { ControlService } from "../../../../src/control/control-service";
import type { ChatRequest, ChatResponse } from "../../../../src/weixin/agent/interface";

export type OracleEntry =
  | { kind: "event"; event: ControlEvent }
  | { kind: "return"; label: string; value: unknown };

interface PendingChat {
  request: ChatRequest;
  resolve: (r: ChatResponse) => void;
  reject: (e: unknown) => void;
}

export function makeTurnOracle(opts?: {
  useSession?: (chatKey: string, alias: string) => Promise<unknown>;
  getSession?: (alias: string) => Promise<unknown>;
}) {
  const log: OracleEntry[] = [];
  const events = createControlEventBus();
  events.subscribe((event) => log.push({ kind: "event", event: clone(event) }));

  const pending: PendingChat[] = [];
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    // Drive the reply/onThought/etc callbacks the real transport would, so the event log
    // is representative. A scenario resolves each chat explicitly via controls.
    return await new Promise<ChatResponse>((resolve, reject) => {
      pending.push({ request, resolve, reject });
    });
  };

  const service = new ControlService({
    agent: { chat },
    sessions: {
      listAllResolvedSessions: () => [],
      useSession:
        opts?.useSession ??
        (async (_c: string, alias: string) => ({ alias, agent: "claude", workspace: "/ws" })),
      resolveAliasForChat: async (_c: string, alias: string) => alias,
      getSession: opts?.getSession ?? (async () => null),
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    uploadStore: { root: "/tmp/uploads" },
  } as never);

  const record = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const value = await p;
    log.push({ kind: "return", label, value: clone(value) });
    return value;
  };

  return {
    service,
    log,
    record,
    controls: {
      resolveChat: (index = 0, text = "done") => pending.splice(index, 1)[0]?.resolve({ text }),
      rejectChat: (index = 0, message = "boom") =>
        pending.splice(index, 1)[0]?.reject(new Error(message)),
      pendingCount: () => pending.length,
    },
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url).pathname;

export function expectMatchesFixture(name: string, actual: unknown): void {
  const path = `${FIXTURE_DIR}${name}.json`;
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.GOLDEN_UPDATE === "1") {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, serialized);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`turn oracle fixture missing: ${name}.json — record with GOLDEN_UPDATE=1 on the baseline`);
  }
  expect(JSON.parse(serialized) as unknown).toEqual(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
```

- [ ] **Step 2: 核对假 deps 面足够驱动 executeTurn**

Run: `env -u GOLDEN_UPDATE bun test tests/unit/control/control-service-queue.test.ts`
Expected: PASS（确认 harness 的假 deps 形态与现有 queue 测试一致——两者共享同一最小 deps 集）。harness 若缺某个 executeTurn 用到的 dep（如 `resolveControlSession` 依赖的字段），补进 `makeTurnOracle` 的 stub，与 `control-service-prompt-status.test.ts` 的 `makeControl` 对齐。

- [ ] **Step 3: 写 8 个场景（尚无 fixture，先让它们 GOLDEN_UPDATE 录）**

`tests/unit/control/golden/turn-oracle.test.ts`。每个场景 driver 复用 `control-service-queue.test.ts` 已验证的时序手法（`await tick()` 让 turn 注册、`resolveChat` 逐个放行）。8 个场景名与 spec 一致：

```ts
// tests/unit/control/golden/turn-oracle.test.ts
import { test } from "bun:test";
import { makeTurnOracle, expectMatchesFixture } from "./turn-oracle-harness";

const tick = () => new Promise((r) => setTimeout(r, 0));
const C = { chatKey: "c", sessionAlias: "s", senderId: "u" };

test("oracle: busy second prompt enqueues", async () => {
  const o = makeTurnOracle();
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  await o.record("prompt#2", o.service.prompt({ ...C, text: "second" }));
  o.controls.resolveChat();
  await p1;
  await tick();
  expectMatchesFixture("busy-second-enqueues", o.log);
});

test("oracle: same-tick two prompts — exactly one wins", async () => {
  const o = makeTurnOracle();
  // Both submitted in ONE synchronous tick — never await the first before sending the
  // second. The event log's relative order (queue-updated vs turn-started) is the signal.
  const pA = o.service.prompt({ ...C, text: "A" });
  const pB = o.service.prompt({ ...C, text: "B" });
  await Promise.all([pA.then(() => {}), pB.then(() => {})].map(() => tick()));
  await tick();
  o.controls.resolveChat();
  o.controls.resolveChat();
  await Promise.all([pA, pB]);
  await tick();
  expectMatchesFixture("same-tick-one-wins", o.log);
});
```

其余 6 个场景（scheduled 不入队 / FIFO drain / drain 窗口入队 / stranded tail / cancel 清空清 draining / Stop-followup）按 `control-service-queue.test.ts` 与 `control-service-prompt-status.test.ts` 里对应用例的 driver 逐一翻写为记录 `o.log` 的形式。**每个 driver 只驱动、只记录，断言只有一行 `expectMatchesFixture`。**

- [ ] **Step 4: 在基线 worktree 录 fixture（关键纪律步）**

```bash
BASE=/private/tmp/claude-501/.../scratchpad/control-baseline
git worktree add --detach "$BASE" 54be207
ln -s "$PWD/node_modules" "$BASE/node_modules"
mkdir -p "$BASE/tests/unit/control/golden/fixtures"
cp tests/unit/control/golden/turn-oracle-harness.ts tests/unit/control/golden/turn-oracle.test.ts \
   "$BASE/tests/unit/control/golden/"
(cd "$BASE" && GOLDEN_UPDATE=1 bun test tests/unit/control/golden/turn-oracle.test.ts)
# 基线自我复现（GOLDEN_UPDATE 未设）
(cd "$BASE" && env -u GOLDEN_UPDATE bun test tests/unit/control/golden/turn-oracle.test.ts)
```
Expected: 8 pass；`GOLDEN_UPDATE` 未设时仍 8 pass。把 `$BASE/tests/unit/control/golden/fixtures/*.json` 拷回工作树。

- [ ] **Step 5: 工作树上复现（重构前的 executeTurn 必须复现基线）**

Run: `env -u GOLDEN_UPDATE bun test tests/unit/control/golden/turn-oracle.test.ts`
Expected: 8 pass, 0 fail。此刻工作树代码 == 基线代码，必然绿；这确认 harness 确定性（无 setTimeout race）。

- [ ] **Step 6: Commit**

```bash
git add tests/unit/control/golden/
git commit -m "test(control): black-box event-log oracle for the turn machinery (baseline)"
```

---

## Task 1：抽 SessionTurnRunner（turn 执行体）+ 中立 turn-support 模块

**Files:**
- Create: `src/control/turn-support.ts`
- Create: `src/control/session-turn-runner.ts`
- Modify: `src/control/control-service.ts`（`executeTurn` 中段调 runner；迁出自由函数并 re-export）
- Test: `tests/unit/control/golden/turn-oracle.test.ts`（不改，作判据）

**Interfaces:**
- Consumes: `ControlServiceDeps`（`agent`/`sessions`/`events`/`uploadStore`），`ControlEventBus`，`ScheduledOrigin`，`PromptAttachmentRef`。
- Produces:
  - `turn-support.ts`：`export function turnKey(chatKey, sessionAlias): string`；`export function toErrorMessage(error: unknown): string`；`export function buildControlMetadata(senderId, isOwner): ChatRequestMetadata`；`export const CANCEL_DRAIN_TIMEOUT_MS = 5000`；`export const QUEUE_PREVIEW_MAX = 120`；`export async function raceWithTimeout(promise, ms): Promise<void>`；`export interface QueuedPrompt {...}`。
  - `session-turn-runner.ts`：`export interface TurnRequest { chatKey; sessionAlias; text; senderId; isOwner?; accountId?; abortSignal?; turnStarted?; media? }`（**不含** `queueable`/`drained` —— 那是 TurnQueue 的闸门参数）；`export interface TurnResult { ok: boolean; text?: string; errorMessage?: string }`；`export class SessionTurnRunner { constructor(deps: Pick<ControlServiceDeps, "agent"|"sessions"|"events"|"uploadStore">); run(req: TurnRequest, signal: AbortSignal): Promise<TurnResult> }`。

- [ ] **Step 1: 建 `turn-support.ts`，迁入 4 个自由函数 + 2 常量 + QueuedPrompt 类型**

从 `control-service.ts` **逐字剪切** `turnKey`/`toErrorMessage`/`buildControlMetadata`/`raceWithTimeout`/`CANCEL_DRAIN_TIMEOUT_MS`/`QUEUE_PREVIEW_MAX` 及 `QueuedPrompt` 接口到新文件，加 `import type { ChatRequestMetadata } from "../weixin/agent/interface";`。**陷阱**：这些是**值**，`control-service.ts` 必须 `import { … } from "./turn-support"`（值导入），不能 `import type`——否则运行时缺失。为保住外部可能的 import 路径，`control-service.ts` 顶部加 `export { turnKey, toErrorMessage, CANCEL_DRAIN_TIMEOUT_MS } from "./turn-support";`（仅 re-export 原本可能被外部引用的；实测 `grep -rn "from.*control-service" src tests` 确认哪些符号被外部 import，只 re-export 那些）。

- [ ] **Step 2: 运行现有测试确认 turn-support 迁移无回归**

Run: `env -u GOLDEN_UPDATE bun test tests/unit/control/control-service-queue.test.ts && npx tsc --noEmit`
Expected: PASS, tsc 0 errors。

- [ ] **Step 3: 建 `session-turn-runner.ts`，把执行体逐字搬入 `run()`**

`run(req, signal)` 的体 = 当前 `control-service.ts` 中 `executeTurn` 的 **585→761 行**（`internalAlias`/`wasArchived`/`priorTransportSession` 捕获 → `useSession` → `turn-started` → 段落/media/`agent.chat` → `turn-finished` → `return { ok, text }`），**以及 finally 里的 sessions-changed 检测（779-788）**。逐字搬移规则：
  - `params.X` → `req.X`；`controller.signal` → `signal`；`this.deps` → `this.deps`（runner 也叫 deps）。
  - `useSession` 失败分支（604-614）里的 `resolveSettled()` / `advanceQueue(...)` **不搬**（那是并发状态，Task 2 之前留在 executeTurn）。改法：runner 的 `useSession` 失败**只**返回 `{ ok:false, errorMessage: toErrorMessage(error) }`；executeTurn 侧保留 settled/advanceQueue 收尾（见 Step 5）。
  - sessions-changed 的两段（turn 前捕获 + turn 后比对）**整体搬进 runner** —— 它是"一次执行的可观测效果"，与并发无关。runner 内部自己 try/catch，best-effort。
  - **陷阱（microtask hop）**：runner 的 `turn-started`/`turn-finished` emit 顺序、以及 sessions-changed 相对 turn-finished 的位置，必须与基线逐字一致。搬移后靠 oracle 场景 1（busy-second-enqueues）+ 现有 prompt-status 测试验证顺序未漂移。

- [ ] **Step 4: `SessionTurnRunner` 构造与 deps 收窄**

```ts
// src/control/session-turn-runner.ts（骨架）
import path from "node:path";
import type { ControlServiceDeps } from "./control-service";
import type { ScheduledOrigin } from "./control-event-bus";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { toErrorMessage, buildControlMetadata } from "./turn-support";

export interface TurnRequest {
  chatKey: string; sessionAlias: string; text: string; senderId: string;
  isOwner?: boolean; accountId?: string; abortSignal?: AbortSignal;
  turnStarted?: { prompt?: string; scheduled?: ScheduledOrigin; queueItemId?: string };
  media?: PromptAttachmentRef[];
}
export interface TurnResult { ok: boolean; text?: string; errorMessage?: string }

export class SessionTurnRunner {
  constructor(private readonly deps: Pick<ControlServiceDeps, "agent" | "sessions" | "events" | "uploadStore">) {}
  async run(req: TurnRequest, signal: AbortSignal): Promise<TurnResult> {
    // ← 搬入 executeTurn 585-761 + 779-788（sessions-changed），见 Step 3
  }
  private async resolveStreamMode(chatKey: string, sessionAlias: string): Promise<boolean> { /* 搬 632-638 */ return false; }
}
```
`resolveControlSession`（当前 private，用于 streamMode）：若 runner 需要它，把 `resolveControlSession` 也搬进 runner 或迁 turn-support（它只读 `sessions`）。实测其依赖后决定归属，**不留跨文件私有方法调用**。

- [ ] **Step 5: `executeTurn` 中段改调 runner**

`executeTurn` 保留闸门（502-584）+ controller/settled/inFlight 生命周期 + finally 的并发收尾（`draining.add`/`resolveSettled`/`advanceQueue`），中段替换为：

```ts
    const result = await this.runner.run(
      { chatKey: params.chatKey, sessionAlias: params.sessionAlias, text: params.text,
        senderId: params.senderId,
        ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
        ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
        ...(params.turnStarted ? { turnStarted: params.turnStarted } : {}),
        ...(params.media !== undefined ? { media: params.media } : {}) },
      controller.signal,
    );
```
`this.runner` 在构造函数里 `= new SessionTurnRunner(deps)`。useSession 失败路径：runner 返回 `{ok:false}`，executeTurn 在拿到该结果后走原 finally（`resolveSettled` + `advanceQueue`）—— **注意**当前代码 useSession 失败是 early return 不进 finally；搬移后要保证失败仍触发一次 settled+advanceQueue（等价于原 604-614）。用 `try { result = await runner.run(...) } finally { …收尾… }` 结构统一收尾路径。

- [ ] **Step 6: oracle + 现有测试全绿**

Run（逐文件）:
```
env -u GOLDEN_UPDATE bun test tests/unit/control/golden/turn-oracle.test.ts
env -u GOLDEN_UPDATE bun test tests/unit/control/control-service-queue.test.ts
env -u GOLDEN_UPDATE bun test tests/unit/control/control-service-prompt.test.ts
env -u GOLDEN_UPDATE bun test tests/unit/control/control-service-prompt-status.test.ts
npx tsc --noEmit
```
Expected: 全 pass，tsc 0 errors，**8 个 fixture 一字不改**（`git status tests/unit/control/golden/fixtures/` 为空）。若某 fixture 变红 → 事件顺序漂移，回 Step 3 对齐 emit 顺序，不得重录 fixture。

- [ ] **Step 7: Commit**

```bash
git add src/control/turn-support.ts src/control/session-turn-runner.ts src/control/control-service.ts
git commit -m "refactor(control): extract SessionTurnRunner for the per-turn execution body"
```

---

## Task 2：抽 TurnQueue（三态闸门）+ 白盒单测

**Files:**
- Create: `src/control/turn-queue.ts`
- Create: `tests/unit/control/turn-queue.test.ts`
- Modify: `src/control/control-service.ts`（`executeTurn`/`advanceQueue`/`cancelTurn`/`cancelQueuedItem`/三态字段迁出，退化为 `submit`）

**Interfaces:**
- Consumes: `turn-support`（`turnKey`/`QueuedPrompt`/`CANCEL_DRAIN_TIMEOUT_MS`/`QUEUE_PREVIEW_MAX`/`raceWithTimeout`），`SessionTurnRunner`（`TurnRequest`/`TurnResult`）。
- Produces:
```ts
// src/control/turn-queue.ts
export interface TurnQueueDeps {
  runTurn(req: TurnRequest, signal: AbortSignal): Promise<TurnResult>;
  emitQueueUpdated(chatKey: string, sessionAlias: string, items: QueuedItemSnapshot[]): void;
}
export interface SubmitParams {  // req 字段 + 闸门旗标
  chatKey: string; sessionAlias: string; text: string; senderId: string;
  isOwner?: boolean; accountId?: string; abortSignal?: AbortSignal;
  turnStarted?: TurnRequest["turnStarted"]; media?: PromptAttachmentRef[];
  queueable?: boolean;
}
export type SubmitResult = TurnResult | { ok: true; queued: true; queueItemId: string };
export class TurnQueue {
  constructor(deps: TurnQueueDeps);
  submit(params: SubmitParams): Promise<SubmitResult>;
  cancelTurn(chatKey: string, sessionAlias: string): boolean;
  cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string): { cancelled: boolean };
  queueLength(chatKey: string, sessionAlias: string): number;  // 同步查询
  isBusy(chatKey: string, sessionAlias: string): boolean;      // 同步查询
}
```

- [ ] **Step 1: 白盒 failing test —— 零 await 同 tick 同步断言（先写，先红）**

`tests/unit/control/turn-queue.test.ts`：

```ts
import { expect, test } from "bun:test";
import { TurnQueue } from "../../../src/control/turn-queue";
import type { TurnRequest, TurnResult } from "../../../src/control/session-turn-runner";

function deferredRunTurn() {
  const pending: Array<{ resolve: (r: TurnResult) => void }> = [];
  const runTurn = (_req: TurnRequest, _s: AbortSignal) =>
    new Promise<TurnResult>((resolve) => pending.push({ resolve }));
  return { runTurn, resolveNext: (r: TurnResult = { ok: true }) => pending.shift()?.resolve(r), pendingCount: () => pending.length };
}

test("submit's busy-decision + enqueue is a synchronous prefix (same tick, zero await)", () => {
  const d = deferredRunTurn();
  const tq = new TurnQueue({ runTurn: d.runTurn, emitQueueUpdated: () => {} });
  const req = { chatKey: "c", sessionAlias: "s", text: "A", senderId: "u", queueable: true };
  void tq.submit(req);                 // sync inFlight.set
  void tq.submit({ ...req, text: "B" }); // sync enqueue
  // ZERO await between submit and this assertion — pins the synchronous prefix.
  expect(tq.queueLength("c", "s")).toBe(1);
  expect(tq.isBusy("c", "s")).toBe(true);
});
```

- [ ] **Step 2: 运行确认它红（TurnQueue 尚不存在）**

Run: `env -u GOLDEN_UPDATE bun test tests/unit/control/turn-queue.test.ts`
Expected: FAIL（`Cannot find module turn-queue`）。

- [ ] **Step 3: 建 `turn-queue.ts`，把三态闸门逐字搬入**

从 `control-service.ts` 搬移：`inFlight`/`queues`/`draining` 三字段、`executeTurn` 的闸门+生命周期部分（502-584 + finally 并发收尾 762-793 除 sessions-changed 外）、`advanceQueue`（802-835）、`cancelTurn`（837-844）、`cancelQueuedItem`（850-860）、`emitQueueUpdated`（463-470）。搬移规则：
  - `executeTurn` → `submit`：中段 `await this.runner.run(...)` → `await this.deps.runTurn(req, controller.signal)`；`this.emitQueueUpdated(...)` → `this.deps.emitQueueUpdated(chatKey, sessionAlias, items)`（items 快照在 TurnQueue 内算，`QUEUE_PREVIEW_MAX` 从 turn-support）。
  - `advanceQueue` 里的 fire-and-forget `void this.executeTurn({...drained:true})` → `void this.submit({...drained:true})`。**陷阱（核心不变量）**：`draining.add` 必须在 `void this.submit(...)` **之前**（同步），`submit` 的 `inFlight.set` 必须在其首个 await（`runTurn`）**之前**（同步）。搬移后**不得**在两者间插入任何 await。
  - `drained` 旗标：`submit` 内部保留（drained 头 bypass 闸门、re-register inFlight、清 draining，全同步）。
  - `queueLength`/`isBusy`：新增同步查询——`queueLength = this.queues.get(key)?.length ?? 0`；`isBusy = this.draining.has(key) || (existing !== undefined && !existing.controller.signal.aborted)`。

- [ ] **Step 4: 白盒同 tick 断言转绿**

Run: `env -u GOLDEN_UPDATE bun test tests/unit/control/turn-queue.test.ts`
Expected: PASS。

- [ ] **Step 5: `ControlService` 退化 —— `executeTurn` 删除，`prompt`/`runScheduledTurn` 直接 `submit`**

`control-service.ts`：删掉 `executeTurn`/`advanceQueue`/`cancelTurn`/`cancelQueuedItem`/`emitQueueUpdated`/三态字段。构造函数装配：
```ts
constructor(private readonly deps: ControlServiceDeps) {
  this.runner = new SessionTurnRunner(deps);
  this.turnQueue = new TurnQueue({
    runTurn: (req, signal) => this.runner.run(req, signal),
    emitQueueUpdated: (chatKey, sessionAlias, items) =>
      this.deps.events.emit({ type: "queue-updated", chatKey, sessionAlias, items }),
  });
}
```
`prompt` → `return this.turnQueue.submit({ …, queueable: true })`；`runScheduledTurn` → `return this.turnQueue.submit({ …, senderId:"scheduler", isOwner:true, turnStarted:{...} })`（无 queueable）；`cancelTurn`/`cancelQueuedItem` → 转发 `this.turnQueue.*`。**陷阱**：`cancelTurn`/`cancelQueuedItem` 是 `ControlService` 的公开方法（被 relay/web 调），签名保持不变，只改实现为转发。

- [ ] **Step 6: 白盒补测 —— 三处 wedge + FIFO drain + Stop-followup + stranded tail**

在 `turn-queue.test.ts` 追加白盒用例（喂假 `runTurn`，逐个 resolve）：busy→enqueue、FIFO drain 各自成 turn、drain 窗口入队、drained 头 runTurn reject 仍 drain 后续（stranded tail）、cancel 清空队列清 draining（wedge #3，断言后续 submit 不 enqueue）、Stop 后 followup 等 drain（wedge #2，`cancelTurn` 后 submit 走 `raceWithTimeout` 分支）。每条用可控 `runTurn` 驱动。

- [ ] **Step 7: 变异验证三处不变量真承重**

对每个变异：`cp` 备份 `turn-queue.ts` → 施加 → `grep` 确认应用 → 跑白盒+oracle → 还原。
  - 变异 A：删 `advanceQueue` 里的 `draining.add` → wedge #3 相关白盒用例或 oracle 场景 6 必红。
  - 变异 B：`submit` 里把 `inFlight.set` 挪到首个 await 后 → 同 tick 同步断言（Step 1）必红。
  - 变异 C：busy 判定跨一个 `await Promise.resolve()` → 同 tick 同步断言必红。
记录每个变异命中的具体用例；任一变异全绿 = 该处无测试守护，补测。

- [ ] **Step 8: oracle + 现有测试 + 白盒全绿**

Run（逐文件）: oracle、`control-service-queue`、`control-service-prompt`、`control-service-prompt-status`、`turn-queue`、`npx tsc --noEmit`。
Expected: 全 pass；**8 个 fixture 一字不改**（`git status .../fixtures/` 空）。fixture 变红 → 时序漂移，回 Step 3 对齐，不重录。

- [ ] **Step 9: Commit**

```bash
git add src/control/turn-queue.ts tests/unit/control/turn-queue.test.ts src/control/control-service.ts
git commit -m "refactor(control): extract TurnQueue; executeTurn collapses to submit"
```

---

## Task 3：收尾 —— 死代码、注释迁移、行数核对

**Files:**
- Modify: `src/control/control-service.ts`

- [ ] **Step 1: 核对 control-service.ts 无遗留三态引用 / 孤儿 import**

Run:
```bash
grep -n "inFlight\|draining\|advanceQueue\|raceWithTimeout" src/control/control-service.ts
grep -c "QueuedPrompt\|QUEUE_PREVIEW_MAX\|CANCEL_DRAIN_TIMEOUT_MS" src/control/control-service.ts
```
Expected: 三态字段/闸门无残留；被搬走的符号在 control-service.ts 里出现 0 次（除必要 re-export 行）。孤儿 `import type` 手动删（tsc 抓不到——`import type` 擦除 + `noUnusedLocals` 关）。

- [ ] **Step 2: wedge 注释迁移到 TurnQueue**

三处"永久 wedge"注释（原 control-service.ts 约 562/570/831）搬到 `turn-queue.ts` 对应位置，且**在依赖同步时序的调用点写明"变异 X 会让白盒断言 Y 变红"**（照 orchestration group-service 的做法），避免下一个人误判 flaky 重录 fixture。

- [ ] **Step 3: 全量核对**

Run:
```bash
for f in $(git ls-files 'tests/unit/control/*.test.ts' 'tests/unit/control/golden/*.test.ts'); do env -u GOLDEN_UPDATE bun test "$f"; done
npx tsc --noEmit
wc -l src/control/control-service.ts src/control/turn-queue.ts src/control/session-turn-runner.ts src/control/turn-support.ts
git diff --stat origin/main -- tests/unit/control/golden/fixtures/
```
Expected: 全 pass；tsc 0；control-service.ts 显著变短；fixtures 相对 origin/main 无改动（它们是 Task 0 新增，相对 base 是 A；关键是相对 Task 0 commit 无 M）。

- [ ] **Step 4: Commit**

```bash
git add src/control/control-service.ts src/control/turn-queue.ts
git commit -m "refactor(control): migrate wedge comments to TurnQueue; drop dead code"
```

---

## 全套验证（每 Task 后 controller 核对）

```bash
env -u GOLDEN_UPDATE bun test tests/unit/control/golden/turn-oracle.test.ts   # 8 pass, fixtures unchanged
env -u GOLDEN_UPDATE bun test tests/unit/control/turn-queue.test.ts           # 白盒全绿
for f in $(git ls-files 'tests/unit/control/*.test.ts'); do env -u GOLDEN_UPDATE bun test "$f"; done
npx tsc --noEmit
git status tests/unit/control/golden/fixtures/   # 相对 Task 0 commit 无 M
```
