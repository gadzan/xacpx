# acpx 嵌入式集成评估报告（修订版）

> 评估日期：2026-08-26（修订）
> 评估对象：将 xacpx 与 acpx 的集成方式从「CLI 子进程 spawn」迁移到「嵌入式 Runtime API（库方式）」的可行性、收益、风险与迁移路线
> 参考前作：[acpx-0.13.1-upgrade-report.md](acpx-0.13.1-upgrade-report.md)
> 依据：acpx main 分支源码（与 v0.13.1 同期）+ xacpx 全量代码调查
> 修订要点：明确 Runtime contract 缺口清单；将 xacpx 侧 API 定性为产品语义；性能结论改为待 benchmark；风险清单重写；方案升级为 B+（双 Engine + session 级归属）；迁移路线扩为六阶段；新增 G1–G12 验收门

***

## 一、结论摘要（TL;DR）

| 问题                                  | 结论                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| acpx 是否具备可用的嵌入式 API？                | **是。** `acpx/runtime` 导出完整 `AcpRuntime` 契约（`createAcpRuntime` / `createRuntimeStore` / `createAgentRegistry`），覆盖会话管理、流式 turn、取消、模式切换、elicitation                  |
| 当前 public contract 是否足够 xacpx 稳定依赖？ | **否。** 缺六类能力：`release`、`dispose`、history tail、agent-session list、hard delete、live permission update（详见 §2.4）                                                      |
| 推荐架构                                | **B+：Runtime Host + RuntimeEngine/CliEngine 双引擎 + session 级 engine 归属**。Runtime 作为 bundled acpx 的默认目标后端；**CLI 是长期兼容通道，不是临时 fallback**                             |
| 迁移前置条件                              | 必须先补齐四类语义：release/TTL/dispose、hard delete、Runtime queue、动态 permission（fail-closed）                                                                                |
| 环境隔离立场                              | 产品不要求 per-session 完整 Claude env 隔离；**每个 xacpx 实例统一 Claude 环境**。Runtime Host 继承 xacpx 实例环境，且**不得把完整 host/provider environment 或 secrets 复制进会持久化的 session options** |
| 性能结论                                | 理论收益明显（减少 CLI wrapper 进程），**具体 cold/warm latency 需要 benchmark**，不以"每次 prompt 大幅减少冷启动"为既定事实                                                                        |
| 建议节奏                                | 六阶段（PoC → Engine 架构 → 生命周期对齐 → queue + 动态权限 → 高级特性 → 默认切换）。**生命周期闭环必须发生在 Runtime 默认切换之前**                                                                         |

***

## 二、acpx 嵌入式 Runtime API 概览

### 2.1 包导出结构

```jsonc
{
  ".": "./dist/cli.js",             // CLI 入口（xacpx 当前依赖层）
  "./runtime": "./dist/runtime.js", // 嵌入式 Runtime API
  "./flows": "./dist/flows.js"      // 高层编排流
}
```

### 2.2 核心 API（源码 `src/runtime/public/contract.ts`）

```ts
import { createAcpRuntime, createRuntimeStore, createAgentRegistry } from "acpx/runtime";

const runtime = createAcpRuntime({
  cwd,
  sessionStore: createRuntimeStore({ stateDir }),   // schema acpx.session.v1
  agentRegistry: createAgentRegistry({ overrides }), // argv overlay 映射点
  mcpServers?,
  permissionMode, nonInteractivePermissions?, permissionPolicy?, // 构造时固定
  timeoutMs?, probeAgent?, verbose?,
  elicitationModes?,
  onPermissionRequest?,  // ★ 交互式权限审批回调
});
```

```ts
interface AcpRuntime {
  ensureSession(input): Promise<AcpRuntimeHandle>;  // persistent | oneshot
  startTurn(input): AcpRuntimeTurn;                 // 推荐入口
  runTurn(input): AsyncIterable<AcpRuntimeEvent>;   // 兼容入口
  getCapabilities? / getStatus? / setMode? / setConfigOption? / doctor?
  cancel(input): Promise<void>;
  close(input: { handle, reason, discardPersistentState? }): Promise<void>;
}

interface AcpRuntimeTurn {
  readonly promptStarted: Promise<void>;   // 0.13.1 起必填（patch 级 breaking 先例）
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;  // completed | cancelled | failed
  cancel / closeStream
}
```

Turn 输入：`text`、`attachments`（image/*、audio/*）、`mode: "prompt" | "steer"`、`timeoutMs`、`AbortSignal`、`onElicitation`。

事件类型：`text_delta`（含 `messageId`、`meta{origin,kind,source}`）、`tool_call`、`status`（含 `cost`、`breakdown`、`availableCommands`）、`done` / `error{code, detailCode, retryable}`。

### 2.3 进程模型

`AcpRuntimeManager` 在调用方进程内持有 `AcpClient` 连接池：适配器子进程由 runtime 直接 spawn 并长连；重连、复用策略、记录持久化、checkpoint 内建。acpx CLI 进程消失，适配器子进程仍在。

### 2.4 当前 public contract 没有的（xacpx 稳定依赖的缺口清单）

以下能力在 `AcpRuntime` public contract 中**不存在**，是 xacpx 迁移前必须在上游补齐或在 xacpx 侧显式承接的硬缺口：

| 缺失能力                    | xacpx 现有对应（产品语义）                                    | 缺口性质                                                   |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `release`（释放连接/资源但不删会话） | `freeWarmProcess`                                   | 上游缺失                                                   |
| `dispose`（runtime 整体关闭） | `SessionTransport.dispose()` / bridge `shutdown`    | 上游缺失——manager 为私有字段，无公开关闭面                             |
| history tail            | bridge `tailSessionHistory`                         | 上游无 tail API（仅整记录 load）                                |
| agent-session list      | bridge `listAgentSessions`                          | 上游无一等 API（可经 store 枚举，但非契约）                            |
| hard delete             | bridge `deleteSession` = close + 终止进程 + unlink 记录文件 | `close({discardPersistentState})` **不等价**：不保证进程终止与文件清理 |
| live permission update  | bridge `updatePermissionPolicy`（运行时即时生效）            | `AcpRuntimeOptions` 构造时固定；0.13.1 还在配置边界做快照防中途变更        |

***

## 三、xacpx 基线：产品语义，不是实现细节

以下五个 API 是**产品语义**，在 `SessionTransport` 接口与 bridge 协议中有明确契约和文档：

| API                      | 产品语义（代码依据）                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `freeWarmProcess`        | 释放会话的 warm 队主进程但**不关闭会话**（[types.ts:276](src/transport/types.ts#L276)）——用户 `/free` 等命令依赖                                                               |
| `isSessionWarm`          | 下一 prompt 立即响应还是冷启动的可观测状态（TTL 到期、archive、任意退出原因都会翻 false）                                                                                              |
| `deleteSession`          | **hard delete**：close（终止 queue owner + agent 进程）+ unlink 磁盘记录（[bridge-runtime.ts:1074](src/bridge/bridge-runtime.ts#L1074)），幂等（记录已消失时静默成功）             |
| `updatePermissionPolicy` | 运行时即时更新权限策略，对进行中/后续 turn 生效                                                                                                                            |
| `queueOwnerTtlSeconds`   | warm 队主存活窗口（config `transport.queueOwnerTtlSeconds` → bridge `ttlMs`，[bridge-runtime.ts:200](src/bridge/bridge-runtime.ts#L200)）——离线消息排队与连续 turn 复用的基础 |

**迁移红线：Runtime migration 必须保证这些语义继续成立，或者在明确产品决定后正式改变。不能默默删掉。** 任何"Runtime 模式下这个概念不存在了"式的静默降级都视为回归。

配套事实（规模与拓扑）：`src/transport/` ≈ 8,900 行 + `src/bridge/` ≈ 2,500 行、46 个 TS 文件；bridge 协议 21 个方法；queue owner 子系统含 launcher/reaper/handle-bound orphan registry；node-pty 用于 transport 交互路径与 control 终端服务（RMUX）。

***

## 四、能力矩阵（按依赖归属重新分类）

### 4.1 Direct Runtime mapping（直接映射，迁移即得）

| xacpx 能力                                | Runtime 对应                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureSession`                         | `ensureSession({ sessionKey, agent, mode, resumeSessionId, cwd, sessionOptions })`；sessionOptions 字段（model/allowedTools/maxTurns/systemPrompt）与 QueueOwnerPayload 一致 |
| `prompt`（流式）                            | `startTurn` + `events` + `result`（精确终态，持久化完成后 settle）                                                                                                                |
| `setMode`                               | `runtime.setMode`                                                                                                                                                    |
| `setModel` / `getSessionModel` / effort | `setConfigOption` + `getStatus().models`（capabilities 广播可用 key）                                                                                                      |
| `cancel`                                | `turn.cancel()` / `runtime.cancel()`（协议级，非杀进程树）                                                                                                                      |
| `hasSession` / `resumeAgentSession`     | store 检查 + `ensureSession({ resumeSessionId })`                                                                                                                      |
| `doctor`                                | `runtime.doctor()` + `probeAvailability()`                                                                                                                           |

### 4.2 xacpx-owned（xacpx 侧显式承接，不指望上游）

| xacpx 能力                                | 承接方式                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| history tail（`tailSessionHistory`）      | xacpx 经 sessionStore / 记录文件直读实现（同一 schema）；或推动上游补 tail API                                  |
| agent-session list（`listAgentSessions`） | 枚举记录文件；上游无一等 API                                                                            |
| `steer`（`injectMessage`）                | `startTurn({ mode: "steer" })` 是直接映射候选，但**语义等价需 PoC 验证**（注入时机、与进行中 turn 的交互），验证前归 xacpx 责任项 |
| 输出防护                                    | acp-output-guard 的信道截断保留（事件类型化解决不了微信消息长度限制）                                                 |

### 4.3 Upstream Runtime gap（上游缺口，迁移前置）

| xacpx 能力                            | 缺口                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `deleteSession`（hard delete）        | `close({discardPersistentState})` 不保证进程终止 + 文件 unlink；需上游补 hard-delete 语义或 xacpx 在 host 侧组合实现 |
| `freeWarmProcess` / `isSessionWarm` | Runtime 无 warm 进程概念；需上游补 `release` 语义（释放连接不删会话）+ 状态可观测，或经产品决策正式重定义                            |
| `dispose` / host 关闭                 | 无公开关闭面；需上游补 `dispose`（或文档化 manager 生命周期）                                                      |
| queue（`prompt --no-wait` 排队投递）      | 无对应；steer ≠ queue                                                                             |
| `updatePermissionPolicy`（live）      | 构造时固定 + 边界快照；需上游补动态更新（fail-closed），或接受"重建 manager"延迟语义                                        |
| `transport.command`（用户自备 acpx）      | 嵌入路径绑定 npm 库版本；由 CLI 兼容通道承接（§4.4）                                                             |

### 4.4 CLI compatibility lane（长期兼容通道，非临时 fallback）

* `transport.command` 显式指定 acpx 的用户

* PATH 解析场景

* 上游语义缺口未补齐期间的会话生命周期操作

* 用户/运维显式选择 CLI 的场景（`transport.type` 可选）

**CLI 是永久存在的兼容通道**：`acpx-cli` transport 不因 Runtime 成为默认而下线。

### 4.5 Optional future feature（非迁移阻塞，价值兑现期做）

* `onPermissionRequest` → 聊天内交互式权限审批（**注意：落地必须 fail-closed**，见 §6）

* elicitation 表单/URL 呈现（`elicitationModes` + `onElicitation`）

* `text_delta.meta` / `messageId` 驱动的诊断与正文分离

* `getStatus().usage`（累计 + per-request + cost）接入 relay web 仪表盘

***

## 五、收益分析

保留的收益：

1. **typed events**——类型化事件流替代 JSONL 逐行解析与手工 chunk 拼接（streaming-prompt 大幅缩水）
2. **structured errors**——`error{code, detailCode, retryable}` 替代 stderr 字符串启发式（`isMissingAcpxSessionError` 的 5 种匹配）
3. **usage/cost**——结构化用量与成本，直接进仪表盘
4. **interactive permissions**——聊天内权限审批（安全模型从默认放行翻转为默认询问的机会）
5. **elicitation**——CLI 路径完全不可用的能力
6. **fewer CLI wrapper processes**——bridge host 内不再每次操作 spawn 一个 acpx Node 进程；进程治理面收窄

**性能结论（修订）**：

> 理论收益明显，具体 cold/warm latency 需要 benchmark。

理由：CLI 路径的冷启动成本（Node 启动 + 模块加载 + 记录索引 + ACP 握手）理论上被长持连接消除，但实际收益取决于：

* warm 队主复用已经吃掉了多少冷启动（连续 turn 本就命中 warm owner）；

* Runtime 连接池的重建频率（重连、TTL、故障后）；

* host 序列化层新增开销。

因此 **Phase 0 必须包含 benchmark**（cold/warm 两条曲线，CLI vs Runtime），数据先行，不以"每次 prompt 都会大幅减少冷启动"作为迁移论证依据。

***

## 六、风险与缺口

### 6.1 环境与配置边界（修订）

* **删除**原评估中"per-session 完整 env 隔离是 Blocking"的表述。产品决定：**每个 xacpx 实例统一 Claude environment**，不做 per-session env 隔离。

* Runtime Host **正常继承 xacpx 实例环境**（daemon 环境）。

* **硬约束：不得把完整 host/provider environment 或 secrets 复制进会持久化的 session options**。sessionOptions（model/allowedTools/maxTurns/systemPrompt）会被 runtime 持久化到会话记录（`session/new` 的 `_meta`），任何 env 快照进入该通道都会把凭据泄漏到磁盘记录中。Engine 层必须对 sessionOptions 做白名单序列化。

### 6.2 新增风险清单

| 风险                                      | 说明                                                                                                                           | 缓解                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **retained owner resource bound**       | Runtime manager 长持适配器连接（retained session），上游无 `release`——连接/内存/子进程随会话数线性增长且无界                                                | 上游补 release/TTL；未补齐前 host 侧会话数上限 + 连接池监控                       |
| **lack of release/dispose**             | 无公开关闭面：host 想优雅退役 runtime 或单个会话资源时没有契约化手段，只能杀进程                                                                              | 上游补 `release`/`dispose`；Phase 2 生命周期对齐的前置项                     |
| **hard delete mismatch**                | `close({discardPersistentState})` ≠ xacpx `deleteSession`（进程终止 + unlink）；静默用 close 冒充 delete 会留下活进程和孤儿记录（Windows 上还有文件锁残留问题） | 上游补 hard-delete 或 host 组合实现；G4 门禁                              |
| **dual-owner race**                     | 同一会话同时被 CliEngine（队主）和 RuntimeEngine（连接池）持有时，两条写入路径竞争同一记录文件，可能互相覆盖 checkpoint                                                | **session 级 engine 归属**（B+ 核心机制）：会话绑定创建它的 engine，切换需显式迁移；G2 门禁 |
| **queue semantic mismatch**             | Runtime 无 `--no-wait` 等价；若用"提交后立刻返回"模拟，会改变离线消息的持久排队/重试/TTL 语义                                                                | Phase 3 专项；未对齐前 queue 路径留在 CLI；G6 门禁                           |
| **permission fallback fail-open**       | 若 `onPermissionRequest` 通路故障（回调丢失、超时、bridge 断连）时默认放行，等于把现有 approve-all 债务搬进新架构                                               | **fail-closed 为唯一可接受默认**：回调不可达 = 拒绝；G5 门禁                      |
| **Runtime patch-level contract change** | 0.13.1 已示范 patch 版可对库 API breaking（`promptStarted` 必填）；CLI 表面才是 acpx 的稳定契约                                                   | 精确锁版 + 升级时跑 contract diff 审查 + compat 套件 Runtime 变体            |

### 6.3 残留工程风险（保留自原评估）

* ESM 加载：acpx dist 为 ESM，需 PoC 验证 bun 构建产物加载（低风险，首项验证）

* node-pty 不可移除：control 终端服务（RMUX）仍依赖，与迁移无关

* adapters 对接：现有 `~/.acpx/config.json` overlay 机制与 `createAgentRegistry({overrides})` 的叠加方式需设计

* 测试面：compat 套件需增加 Runtime 变体（双 engine × 双 transport）

***

## 七、方案对比（B+ 修订）

### 7.1 B+：Runtime Host + RuntimeEngine/CliEngine + session 级 engine affinity

**结构：**

```
daemon ── stdin/stdout JSON 协议（复用，21 方法不变）── Runtime Host 子进程
                                                            │
                                                    Engine 抽象（host 内）
                                                   ┌────────┴────────┐
                                             RuntimeEngine      CliEngine
                                          (import acpx/runtime)  (spawn acpx CLI，现有行为封装)
```

**三个要点：**

1. **Runtime Host 子进程**：隔离边界与原方案 B 相同——acpx 库崩溃/泄漏被圈在 host，长驻 daemon 只看协议；acpx 升级只需重启 host。
2. **双 Engine**：host 内抽象 `Engine` 接口，`RuntimeEngine`（嵌入式）与 `CliEngine`（现有 spawn 行为的封装）并存。CliEngine 封装现有 bridge-runtime 的 spawn 逻辑，是**长期兼容通道**——`transport.command` 用户、PATH 场景、语义缺口未补齐期间的操作都走它。**CLI 不是临时 fallback，不会退役。**
3. **session 级 engine 归属（affinity）**：每个会话记录创建它的 engine，此后该会话的所有操作（prompt/setMode/delete/…）都路由到同一个 engine。这是 dual-owner race 的结构性解法——同一时刻一个会话至多一个持有者；engine 切换必须经显式迁移步骤（close on A → ensure on B），不允许隐式漂移。

### 7.2 与 A/C 的对比

| 维度                     | A（内嵌 daemon）   | **B+（Runtime Host + 双 Engine）** | C（现状 CLI） |
| ---------------------- | -------------- | ------------------------------- | --------- |
| 故障隔离                   | ✗（库错误进 daemon） | ✓（host 边界）                      | ✓         |
| bridge 协议复用            | 部分             | 完全（21 方法不变）                     | 完全        |
| dual-owner race 防护     | 弱              | **结构性（session affinity）**       | 单一引擎，无此问题 |
| `transport.command` 兼容 | ✗              | ✓（CliEngine 永久承接）               | ✓         |
| 生命周期语义                 | 依赖上游补齐         | 依赖上游补齐，但缺口期由 CliEngine 承接对应操作   | ✓         |
| 交互权限 / elicitation     | ✓              | ✓（RuntimeEngine 路径）             | ✗         |
| 迁移改动面                  | 大              | 中（host 内部 + Engine 路由层）         | —         |

A 不推荐（长驻 daemon 直接暴露于库风险）；C 是零风险基线但放弃全部 Runtime 价值。

***

## 八、迁移路线（六阶段）

### Phase 0 — PoC

验证五件事，任一失败即止损：

1. bun 构建产物中 `import "acpx/runtime"` 的 ESM 加载 + 类型检查通过
2. RuntimeEngine 最小闭环：ensureSession → startTurn → 事件回传 → result（对照 mock ACP agent，复用 tests/fixtures/mock-acp-agent.mjs）
3. 会话记录双向兼容：Runtime 写的记录 acpx CLI 可读，反之亦然（schema 相同，预期通过，必须实测）
4. `onPermissionRequest` 回调经 bridge 协议转发到 daemon 的通路原型（fail-closed 行为从第一天就正确）
5. **benchmark**：cold/warm latency，CLI vs Runtime 两条曲线（§5 性能结论的数据化）

### Phase 1 — Engine architecture（纯重构，无行为变化）

* host 内抽出 `Engine` 接口；现有 bridge-runtime 的 spawn 逻辑封装为 `CliEngine`

* daemon/协议层零改动；compat 套件全绿即验收

### Phase 2 — lifecycle parity（生命周期对齐）

* RuntimeEngine 补齐/映射生命周期语义：release/TTL/dispose（依赖上游补齐或 host 侧组合实现）、hard delete、isSessionWarm 等价物

* **生命周期闭环是 Runtime 默认切换的硬前置**：freeWarmProcess / isSessionWarm / deleteSession / dispose 四个语义在 RuntimeEngine 上要么等价成立、要么经正式产品决策显式改变——不允许静默降级

* G2/G3/G4 门禁在此阶段通过

### Phase 3 — Runtime queue + live permission

* 排队投递语义迁移到 Runtime 路径（顺序、深度上限、TTL、重试与 CLI 队主对齐；对不齐的部分留在 CliEngine）

* 动态权限更新（fail-closed：回调不可达 = 拒绝）

* G5/G6 门禁

### Phase 4 — advanced Runtime features（价值兑现期）

* 聊天内交互式权限审批卡片（微信/飞书/relay web）

* elicitation 呈现

* `text_delta.meta` 诊断/正文分离

* usage/cost 接入仪表盘

### Phase 5 — default switch

* bundled acpx 的默认目标后端切换为 RuntimeEngine

* **切换条件：Phase 2 生命周期闭环 + G1–G12 全绿 + benchmark 数据支持**

* CliEngine 永久保留为兼容通道；文档标注双通道与选择方式

***

## 九、测试与验收（G1–G12）

| 门禁                                     | 内容                                                                                          | 阶段           |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------ |
| **G1 记录双向兼容**                          | Runtime 写的会话记录 acpx CLI 可读（resume/list/status），反之亦然；fixtures 与真实产物互验                        | Phase 0      |
| **G2 single owner**                    | 任一会话同一时刻至多一个 engine 持有；跨 engine 操作被 affinity 路由拒绝或触发显式迁移，无 dual-owner 写入竞争                  | Phase 2      |
| **G3 warm release**                    | `freeWarmProcess` 语义在 RuntimeEngine 上等价：资源回收、`isSessionWarm` 翻 false、会话本体不失效、后续 prompt 可用   | Phase 2      |
| **G4 hard delete**                     | `deleteSession` 三效齐验：记录文件 unlink、相关进程终止、幂等（记录不存在时静默成功）；Windows 文件锁残留路径显式测试                  | Phase 2      |
| **G5 permission fail closed**          | `onPermissionRequest` 通路全故障模式（回调丢失/超时/host 断连/协议 malformed）下默认**拒绝**，绝不放行；与 fail-open 的差分测试 | Phase 3      |
| **G6 queue semantics**                 | Runtime 队列与 CLI `--no-wait` 队主在顺序性、深度上限、TTL 过期、重试、daemon 重启后的行为对齐或有文档化的显式差异                 | Phase 3      |
| **G7 事件等价**                            | typed events 与 CLI JSONL 解析产物逐字段对齐（含 thought 流、tool\_call 合并、截断边界）                          | Phase 0/2    |
| **G8 错误等价**                            | structured errors 与现有 stderr 启发式分类（missing session 等）一一映射；未映射错误不静默吞                         | Phase 2      |
| **G9 usage/cost 一致**                   | `getStatus().usage` 与现有 usage\_update 解析结果一致（含"缺失=未知≠0"语义）                                  | Phase 4      |
| **G10 cross-platform process cleanup** | host 退出/崩溃/restart 后，三平台（Windows/macOS/Linux）无残留适配器子进程；Windows 按现有 handle-bound 孤儿治理标准验收    | Phase 2      |
| **G11 engine affinity**                | 会话-engine 绑定在持久化、daemon 重启、host 重启后保持；engine 切换走显式迁移且迁移本身可失败回滚                              | Phase 1/2    |
| **G12 benchmark**                      | cold/warm latency 数据化（CLI vs Runtime），作为 Phase 5 默认切换的决策输入                                  | Phase 0 起，持续 |

***

## 十、最终推荐结论

> 推荐继续推进 acpx 嵌入式 Runtime，但采用"Runtime Host + 双 Engine + session 级归属"的 B+ 架构。Runtime 作为 bundled acpx 的默认目标后端，CLI 作为长期兼容通道。
>
> 迁移前必须先补齐 release/TTL/dispose、hard-delete、Runtime queue 和动态 permission fail-closed 四类语义。
>
> 产品不要求 per-session 完整 Claude env 隔离；每个 xacpx 实例使用统一 Claude 环境即可。Runtime Host 正常继承 xacpx 实例环境，且不得把完整 host/provider environment 或 secrets 复制进会持久化的 session options。
>
> 这一方案能够获得 Runtime 的主要收益——typed events、交互权限、elicitation、usage/cost、减少 CLI wrapper——同时保留 xacpx 现有成熟的 session 生命周期、进程治理、Windows 行为和用户自备 acpx 的兼容能力。

***

## 附录：关键源码索引

* acpx 嵌入式契约：`src/runtime/public/contract.ts`（AcpRuntime / AcpRuntimeTurn / AcpRuntimeOptions / AcpRuntimeEvent；**无 release/dispose/hard-delete/live-permission**）

* acpx 入口与工厂：`src/runtime.ts`（createAcpRuntime / createRuntimeStore / createAgentRegistry / AcpxRuntime）

* acpx 进程模型：`src/runtime/engine/{manager,reconnect,reuse-policy,connected-session}.ts`

* xacpx 产品语义：[src/transport/types.ts:276-293](src/transport/types.ts#L276)（freeWarmProcess/isSessionWarm/updatePermissionPolicy/dispose 契约文档）

* xacpx hard delete 实现：[src/bridge/bridge-runtime.ts:1074](src/bridge/bridge-runtime.ts#L1074)（close + unlink 组合）

* xacpx bridge 协议：[src/bridge/bridge-server.ts:33](src/bridge/bridge-server.ts#L33)（21 方法，含 tailSessionHistory/listAgentSessions/deleteSession/updatePermissionPolicy）

* xacpx queue owner：[src/transport/acpx-queue-owner-launcher.ts](src/transport/acpx-queue-owner-launcher.ts)、[src/transport/queue-owner-reaper.ts](src/transport/queue-owner-reaper.ts)、ttl 链路 [src/bridge/bridge-runtime.ts:200](src/bridge/bridge-runtime.ts#L200)

* xacpx 输出解析（Runtime 化后简化对象）：[src/transport/streaming-prompt.ts](src/transport/streaming-prompt.ts)、[src/adapters/acp-output-guard.ts](src/adapters/acp-output-guard.ts)

