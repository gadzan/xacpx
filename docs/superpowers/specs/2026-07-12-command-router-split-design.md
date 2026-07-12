# command-router 拆分 — 设计 spec

**归属**：2026-07 架构审读轨道 3(核心可维护性重构）第三块。前两块 `orchestration-service`（PR #146/#147）与 `control-service executeTurn`（PR #154，squash `10099b9`）均已合入 main，靠黄金特征化 oracle 保证行为等价。本 spec 沿用同一方法论。

**状态**：已批准（brainstorming 三节全部确认，2026-07-12）。分支 `refactor/command-router-split`，base `origin/main`(`10099b9`)。

---

## 目标（一句话）

把 `src/commands/command-router.ts`（1189 行）里的两个内聚簇 —— transport 调用封装 与 会话 CRUD —— 抽成两个可独立测试的单元 `TransportInvoker` 与 `SessionControlService`，**零行为变更**。

## 为什么

`command-router.ts` 一个类混了三件事：

1. **`handle` 54-case dispatch**（132–468 行）—— 已经是薄委派，每个 case 转给 `./handlers/*`（13 个 handler 模块已抽出）。
2. **transport 调用封装**（~350 行）—— `measureTransportCall` / `ensureTransportSession` + `createProgressHandler` / `promptTransportSession`（~99 行的 abort 处理）/ `checkTransportSession` / `setMode|setModel|getModel|cancelTransportSession` / `refreshSessionTransportAgentCommand`，把 `this.transport.*` 裹上 perf 日志、进度心跳、abort 协作、错误诊断。
3. **会话 CRUD + transport**（~200 行）—— `createSessionWithTransport` / `removeSessionWithTransport` / `archiveSessionWithTransport` / `unarchiveSession` / `listNativeSessionsForControl` / `attachNativeSessionWithTransport`，协调 `sessions` + `transport` + `orchestration` 三方做会话生命周期。

后两簇被 `createXxxOps` 工厂方法（~10 个）包装成 handler 消费的 Ops 接口，或被 `main.ts` 直接当公开 API 调用。抽出后，dispatch 与 ops 工厂留在门面里、把两个新服务接进去，两簇各自内聚可测。

> **勘界纪律**：记忆 [[reference_verbatim_move_tooling_traps]] 记录过——*上一份*针对本文件的计划把协作者假设 9/9 全搞错。本 spec 的边界全部由 2026-07-12 逐方法读源码取证（依赖、外部调用点、helper 归属），不引用 backlog 标签。

## 非目标

- **不碰** `handle` 的 54-case dispatch 逻辑（已是薄委派）与 `./handlers/*`。
- **不改** 任何现有测试文件。`command-router-*.test.ts` + `command-router-test-support.ts` 是回归判据。
- **不动** `main.ts` / `control-service.ts`：靠保留门面上的公开转发方法实现（见"公开 API 保留"）。
- **不修**任何现存行为的隐患。行为等价重构：现有行为（含 best-effort catch 边界、错误诊断细节）原样保留，只是变得可测。

---

## 架构：两个单元的边界

### `TransportInvoker`（新，`src/commands/transport-invoker.ts`）

把 `this.transport.*` 裹上 perf/进度/abort/错误诊断的封装层。

- **方法**：`measureTransportCall`（私有核心：计时 + `transport.<op>` 成功/失败日志 + `PromptCommandError` 诊断上下文）、`ensureTransportSession` + `createProgressHandler`（心跳 + debounce + auto-install 恢复）、`checkTransportSession`、`promptTransportSession`（abort 监听/`done` 竞态闭合/perf 标记）、`setModeTransportSession`、`setModelTransportSession`、`getModelTransportSession`、`cancelTransportSession`、`refreshSessionTransportAgentCommand`。
- **随迁的文件级 helper**：`isAbortError`、`inferTransportKind`（`command-router.ts` 底部本地函数）。`summarizeTransport*` 已是外部 import，两个文件共享 import 即可、不必搬。
- **依赖**：`transport`、`logger`、`config`（transport.type / preferLocalAgents）、`sessions`（仅 `refreshSessionTransportAgentCommand` 用）、`resolveSessionAgentCommand`、`autoInstall`、`discoverPaths`。
- **不碰**会话 CRUD、不碰 dispatch。

### `SessionControlService`（新，`src/commands/session-control-service.ts`）

协调 `sessions` + `transport` + `orchestration` 的会话生命周期 CRUD。

- **方法**：`createSessionWithTransport`（resolve → reserve → ensure → verify → attach → setModel → refresh，best-effort refresh）、`removeSessionWithTransport`（orchestration 阻塞守卫 → `removeSession` → best-effort `purgeSessionReferences` → 仅 `sharedAliasCount===0` 时 `transport.deleteSession`）、`archiveSessionWithTransport`（active-turn 守卫 → 非共享则 `cancel` + best-effort `freeWarmProcess` → `setArchived(true)`）、`unarchiveSession`、`listNativeSessionsForControl`、`attachNativeSessionWithTransport`。
- **依赖**：`sessions`、`transport`、`orchestration`、`activeTurns`、`config`、`logger`，**以及一个 `TransportInvoker`**（组合复用 `ensureTransportSession` / `checkTransportSession` / `refreshSessionTransportAgentCommand`）。依赖方向单向：`TransportInvoker` ← `SessionControlService`。
- `reserveLogicalTransportSession`（委派 `orchestration.reserveLogicalTransportSession`）被 CRUD 与 ops 工厂共用：留在门面，作为回调传入 `SessionControlService`，避免两处各持 orchestration 引用。

### 留在 `CommandRouter`（门面）

`handle` 54-case dispatch、~10 个 `createXxxOps`/`createXxxContext` 工厂（改为把两个新服务接进 handler Ops）、`executeCommand`（命令级 try/log/rethrow）、`replaceConfig`、`reserveLogicalTransportSession`、`clearSession`（委派 `handleSessionResetCommand`）。

### 公开 API 保留（已取证）

- `main.ts:804–811` 把 `router.createSessionWithTransport` 等 6 个方法接进 ControlService 的 deps；`control-service.ts:352–383` 经 `this.deps.*` 调用它们。
- `console-agent.ts:60` 调 `router.handle(...)`。

因此门面**保留全部 6 个 CRUD 方法 + `handle` 的公开签名**（薄转发给 `SessionControlService`，与 control-service 保留 `cancelTurn` 同理）。`main.ts` / `control-service.ts` 一字不改。

### 共享类型防环

**已取证**：`RouterResponse`、`CommandRouterContext`、各 `*Ops` 接口**已经**在中立模块 `src/commands/router-types.ts`（非 `command-router.ts`）。所以两个新单元 `import type` 它即可，无需搬类型、天然无环。唯一纪律：新单元**绝不 value-import 回 `command-router.ts`**（[[reference_verbatim_move_tooling_traps]] 的运行时环陷阱：`import type` 安全，但值/类从门面 import 回来成环）。若抽取中发现某个当前定义在 `command-router.ts` 内的**新**共享类型（如 TransportInvoker 的入参形状），放进 `router-types.ts`，不要留在门面。

---

## 等价性判据：黑盒特征化 oracle

与 orchestration/control 不同，本块**两簇内无 microtask 时序微妙点**（不是并发闸门，是"把方法搬进两个组合对象"）。可观测行为 = 门面对协作者的**有序调用序列** + 入口返回/抛出。

### 黄金 oracle（跨重构，等价性判据）

一个 characterization harness，用假协作者驱动，只记两样：

1. **有序协作者-调用日志** —— 每次 `transport.X` / `sessions.X` / `orchestration.X` / `reply(text)` / `logger.<level>(event)` 按调用顺序 append `{ target.method + 关键参数摘要 }`。所有调用被门面顺序 await，**所以日志顺序 = 真实执行顺序**。
2. **入口返回或抛出** —— 每个被驱动方法的 resolve 值 / throw。

**归一化**：剔除时间变动字段（`durationMs`、时间戳、以及 `createProgressHandler` 心跳依赖的 `Date.now()` 窗口），照 turn oracle 的 UUID/时间戳 scrub 手法，否则 fixture flaky。

**记 `logger.*`（已定）**：日志事件名进有序日志（归一化后），因为 best-effort catch 分支的唯一直接证据就是它吐的那条 `logger.error(event)`（例：`removeSessionWithTransport` 的 `purgeSessionReferences` 失败被吞、`archiveSessionWithTransport` 的 `freeWarmProcess` 失败被吞、`createSessionWithTransport` 的 refresh 失败被吞）。

**驱动范围**（聚焦两簇，不重录 54 命令）：
- 6 个 CRUD 方法直接驱动。
- TransportInvoker 路径经 `handle()` 驱动：`session.new` / `mode.set` / `model.set` / `cancel` / `prompt` / `session.reset`。
- **不覆盖**纯委派 case（help/agents/config/workspaces/groups/tasks/later）——不碰两簇，且现有 `command-router-*.test.ts` 已覆盖。

**场景集**（覆盖被搬簇的微妙序 + best-effort 分支）：

1. `createSessionWithTransport`：正常路径（reserve→ensure→verify→attach→refresh），断言调用序。
2. `createSessionWithTransport`：refresh 失败 → 吞掉、仍返回 session（best-effort，logger.error 一条）。
3. `createSessionWithTransport`：alias 已存在 → 抛，`ensure` 未被调用。
4. `removeSessionWithTransport`：orchestration 阻塞守卫命中 → 抛，`removeSession` 未被调用。
5. `removeSessionWithTransport`：正常（守卫过 → removeSession → purge → sharedAliasCount===0 → deleteSession），断言序。
6. `removeSessionWithTransport`：`sharedAliasCount>0` → **不** deleteSession。
7. `removeSessionWithTransport`：purge 抛 → 吞、流程继续到 deleteSession（logger.error 一条）。
8. `archiveSessionWithTransport`：active turn 在跑 → 抛，`cancel`/`setArchived` 未被调用。
9. `archiveSessionWithTransport`：非共享 → `cancel` + `freeWarmProcess`(best-effort) + `setArchived(true)`，断言序。
10. `archiveSessionWithTransport`：共享 → 跳过 cancel/freeWarm，直接 `setArchived(true)`。
11. `attachNativeSessionWithTransport`：transport 不支持 `resumeAgentSession` → 抛。
12. `attachNativeSessionWithTransport`：正常（reserve→resume→verify→attachNative→refresh）。
13. `listNativeSessionsForControl`：transport 无 `listAgentSessions` → `[]`；有则按 cwd 过滤查询。
14. `handle` `session.new`：ensure 进度心跳 + verify + attach 全链（经 TransportInvoker）。
15. `handle` `mode.set` / `model.set` / `cancel`：各自 `measureTransportCall` 一次 + 日志。
16. `handle` `prompt`：正常 dispatch（perf 标记序 + `transport.prompt` 调用）。
17. `handle` `prompt`：`abortSignal` 预先 aborted → 抛 AbortError、`transport.prompt` **未** dispatch。
18. `ensureTransportSession`：`MissingOptionalDepError` → auto-install 恢复路径（reply 提示 + verify 重试）。

### 现有测试

`command-router-abort/config/interaction/later/recovery/session.test.ts`、`session-archive-delete.test.ts`、`handlers/*` 等**一字不改**、全程绿，作为**次级**回归判据。

---

## 阶段划分（交给 writing-plans）

| 阶段 | 做什么 | 判据 |
|---|---|---|
| **0** | 建黑盒有序调用-日志 harness，**在重构前 commit（`10099b9`）、独立 worktree** 对当前 `CommandRouter` 录基线 fixture（上述场景）。发现现有测试未覆盖的边角 **新增**（不改现有文件） | fixture 在基线自我复现绿，`GOLDEN_UPDATE` 仅在基线 worktree |
| **1** | 抽 `TransportInvoker`：transport 封装方法 + 文件级 helper 搬进去；门面组合一个实例，`createXxxOps` 工厂改为委派它 | oracle + 现有测试全绿 |
| **2** | 抽 `SessionControlService`（组合 `TransportInvoker`）：6 个 CRUD 搬进去；门面保留公开转发方法（签名不变） | oracle + 现有测试全绿 |
| **3** | 收尾：删死代码、注释迁移、把抽取中冒出的新共享类型归入 `router-types.ts`、行数核对 | 全绿 + `npx tsc --noEmit` |

## 纪律（照搬前两块的血泪教训）

- **基线 fixture 必须在重构前 commit（`10099b9`）、独立 worktree 里录**，再让重构后实现复现——绝不拿重构后行为当基线。`GOLDEN_UPDATE=1` 只在基线 worktree 出现。
- **每个关键序/分支靠变异验证**：调换 remove 的 guard/removeSession/purge/deleteSession 顺序、把 best-effort catch 改成外抛、把 `sharedAliasCount>0` 的短路删掉 —— 各自必须让对应 oracle 场景变红。变异先 `grep` 确认应用成功再下结论。
- **值导入是真运行时循环**：新单元 `import type` 门面/共享类型安全，但值/类从 `command-router.ts` import 回来会成环——共享类型迁中立模块。
- **公开签名保 `main.ts`/`control-service.ts`/`console-agent.ts` 三处调用点不动**：门面转发，签名字节一致。
- **逐文件 `bun test`**，never 整目录（模块状态泄漏→假失败，见 [[reference_whole_dir_bun_test_state_leak]]）。
- **子代理 git 卫生**：实现子代理不跑任何 git；会改文件的评审子代理必须 `isolation: "worktree"`（见 [[feedback_subagent_git_side_effects]]）。

## 落点

- `src/commands/transport-invoker.ts`（新）
- `src/commands/session-control-service.ts`（新）
- `src/commands/command-router.ts`（两簇迁出，保留 dispatch + ops 工厂 + 公开转发；1189 → 估 ~450 行）
- `src/commands/router-types.ts`（**已存在**：`RouterResponse`/`*Ops` 的中立归属；抽取中的新共享类型追加于此）
- `tests/unit/commands/golden/`（新，黑盒有序调用-日志 harness + fixture）
