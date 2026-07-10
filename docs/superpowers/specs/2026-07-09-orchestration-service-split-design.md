# orchestration-service.ts 拆分 设计文档

**日期:** 2026-07-09
**来源:** 2026-07 全库架构审读「轨道 3 核心可维护性重构」第一块(见 memory `project-arch-audit-2026-07-backlog`)。轨道 1(可观测性,#143)与轨道 2(协议加固,#145)已合入 main。

## 目标

`src/orchestration/orchestration-service.ts` 是单文件 4539 行、单类 4162 行(326→4488)、113 个方法(46 public / 65 private)。它同时承担五类职责:委派、任务生命周期、通知投递、人机问答、取消与审批。

拆分要同时解决四条痛点(用户确认全部适用):

1. **上下文装不下 / 改动不可靠** —— 人和 agent 都无法一次性持有全文;改一处要扫全文。
2. **无法隔离测试** —— 9888 行测试全部经 `new OrchestrationService(harness.deps)` 走完整依赖;想测一条取消路径要搭整个世界。
3. **为后续重构铺路** —— 轨道 3 后续几块与轨道 4 都会碰它。
4. **并发/正确性风险被淹没** —— `pendingParallelStarts` 的 TOCTOU 窗口、`reconcileParallelSlots` 三阶段、`stateMutex` 横跨 38 处 `mutate`,在 4539 行里无法推理。

## 全局约束

- **零行为变更**,唯一例外见「非重入守卫」一节。
- **公共 API 与构造签名不变**。`OrchestrationService` 保留为门面;`main.ts:632` 的构造点、`router-types.ts` 的 28 处 `OrchestrationService["method"]` 类型索引、`control-service.ts`、`scheduled-service.ts` 均零改动。
- **`tests/unit/orchestration/orchestration-service.test.ts`(9888 行,185 tests)一字不改,全程绿。** 它是本次的回归 oracle;修改它就无法区分代码退化与搬运错误。
- **不引入任何依赖。**
- **git 卫生**:只 add 改动文件,禁 `git add -A`;不改 lockfile;英文 conventional commits。
- **测试**:逐文件 `bun test <path>`(禁整目录,state-leak 假失败);`npx tsc --noEmit`。

---

## 现状(证据)

以下数字均由脚本对 `main` 分支实测得出,非估计。

### 规模与形状

- 类跨 `orchestration-service.ts:326-4488`。方法 113 个(含 3 个 `requestDelegate` 重载签名,有实体的 111 个),46 public / 65 private。
- **实例字段只有 4 个**(`:327-337`):`stateMutex`、`pendingWorkerSessions`、`pendingLogicalTransportSessions`、`pendingParallelStarts`。其余状态全在 `AppState` 中,经 `deps.loadState`/`deps.saveState` 读写。**没有共享可变实例状态要撕开**,这是拆分可行的根本前提。
- `OrchestrationServiceDeps`(`:200-228`)注入 16 个成员,其中 `dispatchWorkerTask`/`ensureWorkerSession`/`cancelWorkerTask`/`resumeWorkerTask`/`closeWorkerSession`/`wakeCoordinatorSession`/`deliverCoordinatorMessage`/`interruptWorkerTask`/`findReusableWorkerSession` 是对外副作用端口。派发本身是注入的,不是私有方法。
- 最大的方法:`requestDelegateFromRpc` 219L、`requestDelegateForHuman` 216L、`approveTask` 182L、`runAutoRunRpcWorkerTask` 176L、`reconcileParallelSlots` 163L、`coordinatorRequestHumanInput` 139L。

### 耦合面(比预期小)

- 生产环境唯一构造点:`src/main.ts:632`。
- 消费者 4 个文件:`commands/router-types.ts`(28 处类型索引)、`control/control-service.ts`、`scheduled/scheduled-service.ts`、`state/debounced-state-store.ts`(仅注释)。

### 私有方法的纠缠度(传递闭包实测)

以 7 个职责簇的公共方法为根做可达性分析:

- **被 ≥3 簇触达的共享物 20 个**。其中既有状态原语(`mutate` 7 簇、`logEvent` 7、`isExternalCoordinatorSession` 7、`ensureGroups` 6、`appendTaskEvent` 6、`taskContext` 6、`isTerminalStatus` 6、`bumpGroupUpdated` 5),也有**人机问答机制**(`handoffQueuedQuestions` 62L、`reopenActiveHumanPackageForTask`、`buildReplacementOpenQuestion`、`recordOpenQuestionWakeError`、`ensureCoordinatorQuestionState`、`ensureHumanQuestionPackages`),还有**会话/槽位机制**(`ensureReservedWorkerSession` 5 簇、`canStartParallelTask` 5、`countActiveParallelSlots` 5、`hasActiveTaskWorkerSession` 3)。
- **单一归属的私有方法 34 个**,随宿主服务一起搬。
- **`approveTask` 不属于取消簇。** 实测:`assertWorkerSessionAvailable`、`reserveProposedWorkerSession`、`resolveWorkerSession`、`normalizeRole`、`cwdWorkerSessionPart`、`workspaceLabelFromCwd`、`assertWorkerSessionDoesNotConflictExternalCoordinator` 这 7 个"看似 Cancel+Delegation 共享"的私有方法,**全部只被 `approveTask` 拉入,停止路径(`cancelTask`/`requestTaskCancellation`/`completeTaskCancellation`/`failTaskCancellation`)一个都不碰**。`approveTask` 是"确认后启动",归启动侧。
- **人类 `/delegate` 路径与 MCP RPC 路径可干净二分。** `requestDelegate`(`:531-539`)只是 9 行重载分发器,分别调 `requestDelegateForHuman` 与 `requestDelegateFromRpc`。从两个实现各自出发,私有依赖**只共享 2 个小助手**:`assertGroupOwnership`(15L)、`normalizeGroupId`(5L)。
  > 注:若从 `requestDelegate` 出发做可达性分析会得到"两路高度重叠"的错误结论——分发器同时调用两个分支。必须从实现出发。

### 死代码(两条独立证据)

`assertProposedWorkerSessionDoesNotConflictExternalCoordinator`(5L)与 `getLatestDeliveredPackageMessage`(12L):

- 从任何公共入口都不可达;
- src 中各只有 1 处引用(即声明本身),测试中 0 处引用;
- 恰好对应 coverage 报告的两个未覆盖区间 `3781-3785`、`3873-3881`。

### 覆盖率现状

`bun test tests/unit/orchestration/orchestration-service.test.ts --coverage` → **96.08% 函数 / 97.24% 行**,185 tests 全绿。未覆盖区间 6 个:

| 未覆盖行 | 归属 | 处置 |
|---|---|---|
| 477-480 | `listGroupSummaries` | 补测 |
| 1327-1342 | `recordWorkerReply` 尾部 + `markTaskNoticePending` | 补测 |
| 2496-2527 | `markCoordinatorGroupsInjected` 尾部 + `markCoordinatorGroupsInjectionFailed` | 补测 |
| 3139-3166 | `ensureReservedWorkerSession` + `reserveLogicalTransportSession` | 补测 |
| 3781-3785 | `assertProposedWorkerSessionDoesNotConflictExternalCoordinator` | **删除** |
| 3873-3881 | `getLatestDeliveredPackageMessage` | **删除** |

### 并发不变量(实测)

- `AsyncMutex`(`src/orchestration/async-mutex.ts`,18L)是严格 FIFO 队列,**不可重入**:`run()` 内再调 `run()` 时,内层 `await previous` 等的正是外层尚未 resolve 的 `tail` → 死锁。
- 存在 10 条 public→public 调用边(`cancelGroup→getGroupSummary`、`cancelGroup→requestTaskCancellation`、`requestDelegate→requestDelegateFromRpc`、`recordTaskNoticeDelivery→markTaskNoticeDelivered`、`coordinatorReviewContestedResult→reconcileParallelSlots`、`markCoordinatorResultsInjected→markTaskInjectionApplied`、`cancelTask→requestTaskCancellation`、`requestTaskCancellation→reconcileParallelSlots`、`completeTaskCancellation→reconcileParallelSlots`、`approveTask→getTask`)。
- **10 条全部位于 `this.mutate(...)` 闭包之外**(按字符范围逐条验证)。该不变量今天成立,但**是隐式的**——因为同处一类,作者心里有数。拆分后它变成跨模块契约。

---

## 设计

### 分层

```
main.ts ──> OrchestrationService  (门面, ~150L, 公共 API 与构造签名不变)
              │
              ├── HumanDelegationService      requestDelegate(分发器) + 人类 /delegate 路径
              ├── RpcDelegationService        requestDelegateFromRpc + auto-run 启动/清理
              ├── TaskApprovalService         approveTask
              ├── TaskCancellationService     cancelTask / request~ / complete~ / failTaskCancellation
              ├── HumanQuestionService        8 个问答公共方法
              ├── CoordinatorRegistryService  registerExternalCoordinator / recordCoordinatorRouteContext
              ├── GroupService                createGroup / getGroupSummary / list~ / cancelGroup
              ├── TaskLifecycleService        recordWorkerReply / watchTask / listTasks / cleanTasks / ...
              └── NoticeDeliveryService       markTaskNotice* / listPendingCoordinator* / markCoordinator*
                        │
                        │  跨服务边(单向):
                        │    HumanDelegationService  ──> RpcDelegationService   (重载分发)
                        │    GroupService.cancelGroup ──> TaskCancellationService
                        ▼
              QuestionFlowCore        问答状态 + 人类问题包 + 投递/重开/交接/唤醒错误
                        ▼
              WorkerSessionManager    会话解析·预留·冲突断言 / 并发槽位核算 / reconcileParallelSlots
                                      持有 pendingWorkerSessions、pendingLogicalTransportSessions、
                                      pendingParallelStarts 三个 Map
                        ▼
              OrchestrationStateKernel  stateMutex + mutate / ensure*(状态形状) /
                                        appendTaskEvent / bumpGroupUpdated / logEvent /
                                        taskContext / groupContext / isTerminalStatus /
                                        isExternalCoordinatorSession / assertGroupOwnership / normalizeGroupId
```

四条承诺,每条都有上文的实测证据支撑:

1. **依赖单向、无环。** 九个服务只向下依赖三层共享物。跨服务边只有两条,反向不存在:取消路径不触碰 `buildGroupSummary`/`groupContext`;RPC 路径不回调人类路径。
2. **`approveTask` 归启动侧。** 让 `TaskCancellationService` 收敛为纯停止路径,并让 `WorkerSessionManager` 的成员集合闭合。
3. **`QuestionFlowCore` 必须独立成层。** `Cancel`、`Group`、`Lifecycle` 三簇都触达它(取消任务要将其从问答流摘除;`ensureHumanQuestionPackages` 连 `Lifecycle` 都用)。若把它藏进 `HumanQuestionService`,`Cancellation → HumanQuestion` 就成了反向依赖。
4. **并发闸门收口。** `stateMutex` 归 Kernel(所有 `mutate` 的唯一入口);三个 `pending*` Map 与槽位核算归 `WorkerSessionManager`。TOCTOU 窗口从"4539 行里的全局性质"降为"一个 ~450 行文件里的局部性质"。

### 成员分配与行数预算

方法数与 body 行数由脚本按上述归属实测得出;「预估文件行」= body × 1.15 + 40(import 与类样板)。

| 单元 | 方法数 | body 行 | 预估文件行 |
|---|---:|---:|---:|
| `OrchestrationStateKernel` | 15 | 178 | ~244 |
| `WorkerSessionManager` | 14 | 358 | ~451 |
| `QuestionFlowCore` | 19 | 544 | ~665 |
| `HumanDelegationService` | 3 | 248 | ~325 |
| `RpcDelegationService` | 8 | 586 | ~713 |
| `TaskApprovalService` | 2 | 188 | ~256 |
| `TaskCancellationService` | 5 | 267 | ~347 |
| `HumanQuestionService` | 8 | 689 | ~832 |
| `CoordinatorRegistryService` | 2 | 113 | ~169 |
| `GroupService` | 5 | 164 | ~228 |
| `TaskLifecycleService` | 12 | 423 | ~526 |
| `NoticeDeliveryService` | 16 | 370 | ~465 |

109 个方法有归属 + 2 个死方法 = 111 个有实体的方法,无孤儿、无重复归属(body 行合计 4128 + 死代码 17 = 4145,与类体 4162 的差额 17 行为类声明、4 个字段与构造函数)。最大文件从 4539 行降至 ~832 行。

`assertGroupOwnership` 与 `normalizeGroupId` 被两条委派路径共享,下沉到 Kernel(纯状态断言),以避免 `Delegation → Group` 反向边。

**明确接受的不完美:**

- `HumanQuestionService` 停在 ~832 行 / 8 个方法(平均 86 行 body/方法)。其内部已无可抽的巨型私有(都进了 `QuestionFlowCore`);再拆只能按"协调器侧 / worker 侧"硬切,而两侧共享 `coordinatorAnswerQuestion ↔ workerRaiseQuestion` 的状态机。它是一个内聚的类,不是杂物间。次大的 `RpcDelegationService`(~713 行)同理:`requestDelegateFromRpc` 219L 与 `runAutoRunRpcWorkerTask` 176L 是一条 RPC 启动流水线的两段,拆开只会制造往返调用。
- 单元数为 12(而非直觉上的 5-6)。这是证据驱动的结果,代价是门面要构造 12 个对象。

### 文件布局

新增目录 `src/orchestration/service/`,每个单元一个文件。`src/orchestration/orchestration-service.ts` 保留为门面并继续导出全部现有 `export interface`(`RequestDelegateInput` 等 30 余个),使消费者的 `import` 语句零改动。

### 非重入守卫(唯一有意的行为变更)

拆分后,`GroupService.cancelGroup → TaskCancellationService.requestTaskCancellation` 这类调用跨了模块。若有人日后把它挪进 `mutate` 闭包,症状是**静默挂死**,极难诊断。

对策:`OrchestrationStateKernel.mutate` 用 `AsyncLocalStorage`(`node:async_hooks`,Bun 与 Node 均支持,非新依赖)标记"当前异步上下文已持有锁";嵌套调用立即抛出显式错误。

**不能用简单布尔标志**:并发(非嵌套)调用者在 `await previous` 排队期间也会观察到标志为真,会被误伤。必须按异步上下文判定。

这是本次唯一的行为变更,且只在当前必然死锁的路径上生效——把 hang 变成可诊断的抛错。其余一切必须逐字节等价。

---

## 测试策略

### 三层 oracle

**第一层:现有 185 个测试一字不改,全程绿。** 保留门面即为此。

**第二层:补上 4 处真实覆盖洞**(见「覆盖率现状」表)。另 2 处是死代码,删除而非补测。

**第三层:黄金状态特征化(真正的 oracle)。**

行覆盖率在此会骗人:把方法搬到另一个类、或把一个 `mutate` 拆成两个,`events[]` 追加顺序与 `updatedAt` 会变,而覆盖率纹丝不动。

`deps.now` 与 `deps.createId` 均为注入,服务是确定性的。据此建录制型 harness:对每个公共方法跑场景,快照三样——

1. 调用后的完整 `AppState`;
2. `deps` 的**有序调用日志**(`dispatchWorkerTask`、`ensureWorkerSession`、`wakeCoordinatorSession`、`deliverCoordinatorMessage`、`cancelWorkerTask`、`resumeWorkerTask`、`closeWorkerSession`、`interruptWorkerTask`、`logger`);
3. 每个受影响任务的 `events[]` 序列。

拆分前录制为 fixture,此后每阶段必须逐字节一致。这把「副作用的顺序与次数」变成可断言之物。

### 并发特征化(现有测试完全缺失)

- **共享互斥体身份**:12 个单元共用同一个 `AsyncMutex` 实例。测试:在 Kernel 起一个不结束的 `mutate`,断言任意另一单元的 `mutate` 被阻塞。
- **`pending*` Map 实例唯一性**:断言 `HumanDelegationService`、`TaskApprovalService`、`WorkerSessionManager.reconcileParallelSlots` 看到同一份计数。分裂不会让测试变红,只会在生产上超发任务。
- **TOCTOU 窗口**:两个并发 `requestDelegate` 抢最后一个并行槽;`reconcileParallelSlots` Phase 3 与一次 delegate 交错。做法是在 `loadState`/`saveState` 上插可控 deferred barrier,把交错变确定性。这正是 `pendingParallelStarts`(`:330-337`)注释声称要关闭的窗口,而它今天没有测试。
- **非重入守卫**:嵌套 `mutate` 抛错;并发(非嵌套)`mutate` 正常排队通过。

### 隔离测试

每个单元可独立构造:只吃它需要的下层 + `deps` 的窄子集。例如 `NoticeDeliveryService` 只需 `now`/`loadState`/`saveState`/`logger`,不需要 `dispatchWorkerTask`。这直接兑现痛点 2。

---

## 落地顺序

自底向上。**每阶段结束时,185 个现有测试 + 黄金 fixture 必须全绿。** 每阶段一个 commit,可独立回滚。

| 阶段 | 内容 |
|---|---|
| 0a | 黄金特征化 harness + fixtures(对当前代码录制) |
| 0b | 补 4 处覆盖洞 |
| 0c | 删 2 个死方法 |
| 1 | `OrchestrationStateKernel` + `AsyncLocalStorage` 重入守卫 |
| 2 | `WorkerSessionManager`(三个 `pending*` Map 迁入) |
| 3 | `QuestionFlowCore` |
| 4 | 九个叶子服务,**每个一个 commit** |
| 5 | 门面瘦身为纯委派;验证 `router-types.ts` 类型索引仍编译 |

阶段 2 单列,因为它是唯一搬移**实例状态**的一步。

## 风险与对策

1. **`mutate` 粒度被无意改变。** 搬移方法时易把一个临界区拆成两个,产生新交错窗口。黄金 fixture 的有序 `deps` 调用日志能抓到;单纯的通过/失败断言抓不到。
2. **`pending*` Map 实例分裂。** 对策见「并发特征化」。
3. **`router-types.ts` 的 28 处类型索引。** 门面必须保留同名方法;`npx tsc --noEmit` 兜底(根 tsconfig 的 `include` 是 `src/**/*.ts`,`router-types.ts` 在覆盖范围内)。
4. **子代理执行的 git 副作用。** 串行;禁 `git add -A`;每阶段后由 controller 自行 `git log`/`git show --stat` 核实真实提交,不轻信完成通知。

## 明确不做(YAGNI / 越界)

- 不拆 9888 行测试文件。它是 oracle,改它就无法区分代码退化与搬运错误。
- 不改任何公共方法签名、不重命名。`main.ts` 除构造处外零改动。
- 不碰 `orchestration-server.ts` / `orchestration-client.ts` / `orchestration-ipc.ts`。
- 不修 `control-service.ts` 的三处 "wedge" 注释——那是轨道 3 第三块,单独立 spec。
- 不加背压 / watchdog(轨道 4)。
- 不引入任何依赖。
- 除 `AsyncLocalStorage` 重入守卫外,零行为变更。
