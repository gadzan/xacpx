# acpx 嵌入式集成评估报告

> 评估日期：2026-08-26
> 评估对象：将 xacpx 与 acpx 的集成方式从「CLI 子进程 spawn」迁移到「嵌入式 Runtime API（库方式）」的可行性、收益、风险与迁移路线
> 参考前作：[acpx-0.13.1-upgrade-report.md](acpx-0.13.1-upgrade-report.md) §5.3-4
> 依据：acpx main 分支源码（commit 与 v0.13.1 同期）+ xacpx 全量代码调查

***

## 一、结论摘要（TL;DR）

| 问题                                     | 结论                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| acpx 是否具备可用的嵌入式 API？                   | **是。** `acpx/runtime` 子路径导出完整的 `AcpRuntime` 契约（`createAcpRuntime` / `createRuntimeStore` / `createAgentRegistry`），覆盖会话管理、流式 turn、取消、模式切换、权限策略、elicitation |
| 能否覆盖 xacpx 现有 `SessionTransport` 全部能力？ | **核心能力全覆盖，3 处缺口**：运行时更新 permission policy、queue owner（`--ttl`/warm 进程）模型、`transport.command` 用户自备 acpx 的能力                                                |
| 最大收益是什么？                               | ① 每 prompt 一次 acpx Node 进程冷启动消失；② **聊天内交互式权限审批**（`onPermissionRequest`）；③ **elicitation 表单/URL 呈现**；④ 类型化事件流替代 JSONL 解析                                   |
| 最大风险是什么？                               | ① **Runtime API 的跨版本稳定性弱于 CLI 表面**（0.13.1 已证明：库 API 可在 patch 版 breaking，CLI 未变）；② 嵌入 daemon 进程后故障隔离与内存隔离丧失                                                |
| 推荐方案                                   | **方案 B：Runtime Host 子进程**——复用现有 bridge 架构，把 bridge 子进程内部的「spawn acpx CLI」替换为「import acpx/runtime」。保住故障隔离、复用 2.5k 行 bridge 协议、消灭每 op 进程冷启动，迁移面最小           |
| 建议节奏                                   | 分四阶段，先 PoC 验证 3 个缺口的最小补法，再灰度。**不建议一步替换 daemon 内嵌（方案 A）**                                                                                                  |

***

## 二、acpx 嵌入式 Runtime API 概览

### 2.1 包导出结构（acpx package.json `exports`）

```jsonc
{
  ".": "./dist/cli.js",          // CLI 入口（xacpx 当前只用到这一层）
  "./runtime": "./dist/runtime.js", // 嵌入式 Runtime API
  "./flows": "./dist/flows.js"      // 高层编排流（本次未深入）
}
```

### 2.2 核心 API（源码 [contract.ts](https://github.com/openclaw/acpx/blob/main/src/runtime/public/contract.ts)）

**创建与配置：**

```ts
import { createAcpRuntime, createRuntimeStore, createAgentRegistry } from "acpx/runtime";

const runtime = createAcpRuntime({
  cwd,                                    // 工作目录
  sessionStore: createRuntimeStore({ stateDir }), // 默认文件存储（~/.acpx/sessions，schema acpx.session.v1）
  agentRegistry: createAgentRegistry({ overrides }), // xacpx 的 argv overlay 可映射到 overrides
  mcpServers?,                            // MCP 服务器声明（对应 xacpx 的 AcpxMcpServerSpec）
  permissionMode,                         // 对应 --permission-mode
  nonInteractivePermissions?,             // 对应 --non-interactive-permissions
  permissionPolicy?,                      // 对应 --permission-policy
  timeoutMs?, probeAgent?, verbose?,
  elicitationModes?,                      // 嵌入方可渲染的 elicitation 形态
  onPermissionRequest?,                   // ★ 交互式权限审批回调
});
```

**会话与 turn 生命周期：**

```ts
interface AcpRuntime {
  ensureSession(input): Promise<AcpRuntimeHandle>;   // persistent | oneshot 两种模式
  startTurn(input): AcpRuntimeTurn;                  // 推荐入口
  runTurn(input): AsyncIterable<AcpRuntimeEvent>;    // 兼容入口（终端事件混在流里）
  getCapabilities? / getStatus? / setMode? / setConfigOption? / doctor?
  cancel(input): Promise<void>;
  close(input: { handle, reason, discardPersistentState? }): Promise<void>;
}

interface AcpRuntimeTurn {
  readonly promptStarted: Promise<void>;   // 0.13.1 起必填（breaking 项）
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;  // completed | cancelled | failed
  cancel(input?): Promise<void>;
  closeStream(input?): Promise<void>;
}
```

**Turn 输入支持：** `text`、`attachments`（image/\* 与 audio/\* → ACP content blocks）、`mode: "prompt" | "steer"`（**steer 正对 xacpx 的 injectMessage 语义**）、`timeoutMs`、`AbortSignal`、`onElicitation`。

**事件类型（替代 xacpx 手工解析的 JSONL）：**

| 事件                                                                                       | xacpx 现有对应物                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `text_delta { text, stream: output\|thought, messageId?, meta?{origin,kind,source} }`    | `agent_message_chunk` / `agent_thought_chunk` 手工拼接（[streaming-prompt.ts](src/transport/streaming-prompt.ts)） |
| `tool_call { toolCallId, status, title, kind, locations, rawInput, rawOutput, content }` | `tool_call`/`tool_call_update` 合并逻辑（mergeToolCallUpdate）                                                     |
| `status { text, used, size, cost?, breakdown?, availableCommands? }`                     | `usage_update` / `available_commands_update` 解析                                                              |
| `done` / `error { code, detailCode, retryable }`                                         | 进程退出码 + stderr 启发式（`isMissingAcpxSessionError`）                                                              |

### 2.3 进程模型

`AcpRuntimeManager`（[manager.ts](https://github.com/openclaw/acpx/blob/main/src/runtime/engine/manager.ts)）在**调用方进程内**持有 `AcpClient` 连接池：ACP 适配器（codex/claude）由 runtime 直接作为子进程 spawn 并保持长连；断线重连（reconnect.ts）、连接复用策略（reuse-policy.ts）、会话记录持久化、checkpoint 全部内建。**acpx 自身的 CLI 进程消失，但适配器子进程仍在。**

***

## 三、xacpx 现状基线（迁移的出发点）

| 维度          | 现状                                                                                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码规模        | `src/transport/` ≈ 8,900 行 + `src/bridge/` ≈ 2,500 行，共 46 个 TS 文件                                                                                                                                                                |
| 抽象边界        | `SessionTransport` 接口（[types.ts](src/transport/types.ts#L230)）：`ensureSession / prompt / setMode / cancel / hasSession / deleteSession / freeWarmProcess / isSessionWarm / getAgentSessionId / updatePermissionPolicy / dispose` |
| transport 1 | `acpx-cli`：每个操作 spawn 一次 acpx Node 进程（含 Node 冷启动 + ACP 连接建立）；PTY 路径用于交互场景                                                                                                                                                        |
| transport 2 | `acpx-bridge`：常驻 bridge 子进程经 stdin/stdout JSON 协议（21 个方法，[bridge-server.ts](src/bridge/bridge-server.ts#L33)），**bridge 内部仍 spawn acpx CLI**                                                                                      |
| queue owner | `--ttl` warm 队主进程：`prompt --no-wait` 投递离线消息、连续 turn 复用 warm agent（[acpx-queue-owner-launcher.ts](src/transport/acpx-queue-owner-launcher.ts)）                                                                                    |
| 孤儿治理        | handle-bound 的 orphan registry + Windows reaper，daemon 停止时杀 warm 队主但不关会话                                                                                                                                                         |
| 输出安全        | [acp-output-guard.ts](src/adapters/acp-output-guard.ts) 对超大 ACP 更新做有界截断                                                                                                                                                          |
| PTY         | transport 交互路径 + control 终端服务（RMUX）两处使用 node-pty                                                                                                                                                                                 |

***

## 四、能力映射矩阵（SessionTransport → 嵌入式 API）

| xacpx 能力                                                  | 嵌入式对应                                                                                      | 判定                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ensureSession`                                           | `runtime.ensureSession({ sessionKey, agent, mode, resumeSessionId, cwd, sessionOptions })` | ✅ 直接映射；sessionOptions（model/allowedTools/maxTurns/systemPrompt）与 QueueOwnerPayload.sessionOptions 字段一致 |
| `prompt`（流式）                                              | `startTurn` + `events` 异步迭代 + `result`                                                     | ✅ **更强**：类型化事件、精确终态（含持久化完成后才 settle）、turn 级 cancel                                                     |
| `prompt --no-wait`（排队投递）                                  | 无直接对应                                                                                      | ⚠️ 缺口 1：需 xacpx 自持队列（orchestration/agent-message-router 已有雏形）                                          |
| `injectMessage`                                           | `startTurn({ mode: "steer" })`                                                             | ✅ steer 即转向注入                                                                                          |
| `setMode`                                                 | `runtime.setMode`                                                                          | ✅                                                                                                      |
| `setModel` / `getSessionModel` / `setSessionEffort`       | `setConfigOption(key, value)` + `getStatus().models`                                       | ✅ 模型/effort 走 config-option 通道（capabilities 会广播可用 key）                                                 |
| `cancel`                                                  | `turn.cancel()` / `runtime.cancel()`                                                       | ✅ 语义更精确（不再靠杀进程树）                                                                                       |
| `hasSession` / `tailSessionHistory` / `listAgentSessions` | `sessionStore.load()` + 直接枚举记录文件                                                           | ✅ 记录同 schema（acpx.session.v1），双向兼容                                                                     |
| `resumeAgentSession`                                      | `ensureSession({ resumeSessionId })`                                                       | ✅                                                                                                      |
| `deleteSession`                                           | `close({ discardPersistentState: true })`                                                  | ✅ 近似，语义需逐项核对                                                                                           |
| `freeWarmProcess` / `isSessionWarm`                       | 无对应（in-process 连接池自管理）                                                                     | ⚠️ 缺口 2：queue owner 模型整体消失，队主 launcher/reaper/orphan 大部分退役                                             |
| `updatePermissionPolicy`（运行时）                             | 无对应——`AcpRuntimeOptions` 构造时固定，0.13.1 还特意在配置边界做快照防中途变更                                     | ⚠️ 缺口 3：需重建 manager 或接受"策略变更=新配置边界"                                                                    |
| `transport.command`（用户自备 acpx）                            | 无对应（绑定 npm 库版本）                                                                            | ⚠️ 缺口 4：用户失去覆盖能力，需保留 CLI transport 作为退路                                                                |
| 交互式权限审批                                                   | `onPermissionRequest` 回调                                                                   | ★ **净新增能力**                                                                                            |
| elicitation（表单/URL）                                       | `elicitationModes` + `onElicitation`                                                       | ★ **净新增能力**（CLI 路径完全不可用）                                                                               |
| 输出防护                                                      | 事件已类型化，但聊天信道长度限制仍需截断                                                                       | ✅ acp-output-guard 可简化保留                                                                               |
| doctor                                                    | `runtime.doctor()` + `probeAvailability()`                                                 | ✅ 与 xacpx doctor 天然集成                                                                                  |

***

## 五、收益分析

### 5.1 性能（确定性收益）

1. **消灭每 op 的 Node 进程冷启动**：CLI 路径每次 prompt/ensure/setMode 都要启动一个 acpx Node 进程（解释器启动 + 模块加载 + 记录索引扫描 + ACP 握手）。嵌入式下 ACP 适配器连接由 manager 长持，turn 间隔只付协议往返成本。bridge 模式下收益同样成立——bridge 子进程内部不再反复 spawn acpx。
2. **连接复用与重连内建**：manager 的 reconnect/reuse-policy 替代 xacpx 自研的 warm 队主复用逻辑（isOwnerAlive/握手轮询）。
3. **取消不再依赖进程树终止**：`turn.cancel()` 是协议级取消，替代 `terminateProcessTree` + Windows 身份探测的启发式路径。

### 5.2 功能（净新增）

1. **聊天内交互式权限审批**：现状因非交互环境被迫 `permissionMode: "approve-all"` 默认放行（AGENTS.md 明确记载）。嵌入后 `onPermissionRequest` 可把权限请求路由到微信/飞书卡片按钮（批准/拒绝），relay web 更可直接渲染。这是**安全模型的实质升级**。
2. **Elicitation 呈现**：0.13.1 的 turn 级 form/URL elicitation 仅嵌入方可感——xacpx 可把适配器的信息征询（如表单填写）转成聊天交互卡片。
3. **`text_delta`** **来源元数据**：`messageId` + `meta{origin,kind,source}` 允许把适配器诊断从模型正文中剥离（前一份报告 §5.3-1 的优化在嵌入路径上是原生支持的）。
4. **精确错误语义**：`error { code, detailCode, retryable }` 替代 stderr 字符串匹配（`isMissingAcpxSessionError` 的 5 种启发式）。
5. **用量与成本结构化**：`getStatus().usage`（累计 + per-request 明细 + cost）直接喂给 relay web 仪表盘。

### 5.3 架构简化

* JSONL 逐行解析层（streaming-prompt 的手工 chunk 拼接、段落边界推断）大幅缩水——事件已结构化。

* queue owner 子系统（launcher/reaper/orphan registry 中与 acpx CLI 进程相关的部分）随进程模型消失而退役。

* Windows 平台负担显著下降：无 acpx CLI 进程即无 acpx 孤儿；仅剩适配器子进程由 acpx runtime 自管（0.13.1 刚修复其终端清理）。

***

## 六、风险与代价

### 6.1 版本耦合升级风险（★ 最重要）

0.13.1 释放了明确信号：**acpx 把 CLI 表面当作稳定契约，把 Runtime API 当作可演进契约**（patch 版本即可要求 `promptStarted` 必填）。嵌入式后，xacpx 每次升级 acpx 都可能面对库级 breaking；而 CLI 路径下 xacpx 三年来依赖的只是一个命令行表面。

缓解：xacpx 已精确锁版（`"acpx": "0.13.0"` 无范围），升级节奏本就自主；嵌入后把升级审查从"读 release notes 的 CLI 部分"变为"读 Runtime API diff + 跑 compat 套件"。

### 6.2 故障与内存隔离丧失（方案 A 特有）

CLI/bridge 模式下 acpx 崩溃最多丢一个子进程；直接内嵌 daemon 后，runtime 或适配器连接的未捕获异常、内存泄漏都会进入 xacpx 守护进程。xacpx 的 daemon 是长驻服务（`xacpx start`），这正是最怕泄漏的进程形态。

缓解：方案 B（见 §7）保留子进程边界。

### 6.3 能力缺口（§4 的 4 个 ⚠️）

1. **排队投递**：`--no-wait` 消失后，离线消息排队需 xacpx 自实现。agent-message-router 已有 inbound/outbox 缓存语义，可承接，但属于新工程。
2. **运行时权限策略更新**：只能在配置边界快照后生效——与 bridge `updatePermissionPolicy` 的即时语义不同，需产品层确认可接受度。
3. **`transport.command`** **退化**：文档承诺的三级解析（config → bundled → PATH）在嵌入路径只剩 bundled。必须保留 CLI transport 作为兼容选项，`transport.type` 增加 `"acpx-runtime"` 而非替换默认值。
4. **测试面**：46 个 transport/bridge 文件、tests/compat 双 transport 冒烟都要增加嵌入路径变体。

### 6.4 工程依赖

* 模块系统：acpx dist 为 ESM，xacpx 用 bun 构建混合产物，需验证 daemon 打包产物对 `acpx/runtime` 的加载（低风险，但要在 PoC 首项验证）。

* node-pty **不可移除**：control 终端服务（RMUX）仍需要它，与本次迁移无关。

* adapters 子系统（xacpx 的 npx pin / registry 策略）与嵌入式 `agentRegistry.overrides` 的对接方式需设计——overlay 写 `~/.acpx/config.json` 的现有机制可以继续用（createAgentRegistry 的 overrides 与配置文件二选一或叠加）。

***

## 七、架构方案对比

### 方案 A：直接内嵌 daemon 进程

daemon 内 `import { createAcpRuntime }`，SessionTransport 新增 `acpx-runtime` 实现。

* 优点：链路最短、延迟最低、无 IPC 序列化。

* 缺点：§6.2 隔离丧失全部暴露于长驻 daemon；升级 acpx 需重启 daemon 才能生效（现在 bridge 重启即可）。

* 判定：**不推荐作为第一步**。

### 方案 B：Runtime Host 子进程（推荐）

**保留 bridge 的进程拓扑与 JSON 协议，把** **[bridge-runtime.ts](src/bridge/bridge-runtime.ts)** **内部所有** **`spawn(acpx, ...)`** **替换为进程内** **`createAcpRuntime`** **调用。**

* bridge 子进程 = 嵌入 host：acpx 库崩溃/泄漏被隔离在 host，daemon 只看协议。

* 2,514 行 bridge 协议层（21 个方法、progress 编码、流式回传）**原样复用**，`AcpxBridgeTransport` 无感。

* 每 op 冷启动消失（host 内 manager 长持连接），性能收益拿到。

* `updatePermissionPolicy` 可实现为"host 内重建 manager"（配置边界语义自然成立）。

* 排队投递缺口在 host 内用 steer/队列自实现，或暂保持 CLI `prompt --no-wait` 混合过渡。

* 退出路径干净：不稳定就回滚 host 内部实现，协议不动。

### 方案 C：维持 CLI 现状

* 零风险，但 §5.2 的交互式权限、elicitation、性能收益全部放弃；`approve-all` 默认放行的安全债继续存在。

### 对比一览

| 维度                     | A（内嵌 daemon）        | B（runtime host 子进程）  | C（现状 CLI） |
| ---------------------- | ------------------- | -------------------- | --------- |
| 每 op 冷启动               | 消除                  | 消除                   | 存在        |
| 故障隔离                   | ✗                   | ✓（host 边界）           | ✓         |
| bridge 协议复用            | 部分                  | 完全                   | 完全        |
| 交互式权限 / elicitation    | ✓                   | ✓                    | ✗         |
| acpx 升级影响面             | daemon 全量           | host 进程              | 子进程       |
| 迁移改动面                  | 大（transport+daemon） | 中（bridge-runtime 内部） | —         |
| `transport.command` 兼容 | ✗                   | ✗（host 内）            | ✓         |

***

## 八、分阶段迁移路线（以方案 B 为主线）

**Phase 0 — PoC（验证 4 件事）**

1. bun 打包产物中 `import "acpx/runtime"` 的 ESM 加载与类型检查通过；
2. bridge-runtime 内用 `createAcpRuntime` 跑通 ensureSession → startTurn → 事件回传 → result 的最小闭环（对照 mock ACP agent，复用 tests/fixtures/mock-acp-agent.mjs）；
3. 会话记录双向兼容验证：嵌入式 host 写的记录能被 acpx 0.13.1 CLI 读取（反之亦然）——schema 相同，预期通过，但必须实测；
4. `onPermissionRequest` 回调经 bridge 协议转发到 daemon 的消息通路原型。

**Phase 1 — bridge host 替换（灰度）**

* `transport.type: "acpx-bridge"` 下 bridge 子进程改为 runtime host，协议不变；

* 新增 config 开关（如 `bridge.mode: "runtime" | "cli"`）保留 CLI 回退；

* compat 套件增加 `acpx-runtime` 变体；queue owner 路径暂维持 CLI。

**Phase 2 — 能力解锁（价值兑现期）**

* 交互式权限审批：`onPermissionRequest` → 微信/飞书卡片按钮（approve/deny + 超时默认策略），替代 approve-all 默认；

* `text_delta.meta` 驱动的诊断/正文分离；

* `getStatus().usage/cost` 接入 relay web 仪表盘；

* elicitation 卡片（视产品需求优先级）。

**Phase 3 — 收尾与退役评估**

* 排队投递迁移到 host 内 steer 队列后，评估 queue owner 子系统（launcher/reaper/部分 orphan registry）退役；

* `acpx-cli` transport 保留（`transport.command` 用户与 PATH 场景），文档标注 `acpx-runtime` 为推荐路径。

***

## 九、最终建议

1. **方向上值得做**：交互式权限审批一项就足以论证迁移（把默认放行的安全模型翻转为默认询问）；性能与事件类型化是顺带红利。
2. **路径上选方案 B**：bridge 拓扑与协议是 xacpx 已验证的资产，方案 B 把迁移面压缩到 bridge-runtime 内部，同时保住长驻 daemon 最需要的故障隔离。
3. **顺序上先 PoC 后承诺**：Phase 0 的 4 项验证（尤其 ESM 加载与记录双向兼容）成本很低，任何一项失败都能在投入工程量之前止损。
4. **与 0.13.1 升级解耦**：先完成 0.13.0 → 0.13.1 的依赖升级（前一份报告），嵌入式迁移基于 0.13.1 起步——`promptStarted` 必填、elicitation、权限快照语义都是 0.13.1+ 的基线行为。

***

## 附录：关键源码索引

* acpx 嵌入式契约：`src/runtime/public/contract.ts`（AcpRuntime/AcpRuntimeTurn/AcpRuntimeOptions/AcpRuntimeEvent）

* acpx 入口与工厂：`src/runtime.ts`（createAcpRuntime / createRuntimeStore / createAgentRegistry / AcpxRuntime）

* acpx 进程模型：`src/runtime/engine/{manager,reconnect,reuse-policy,connected-session}.ts`

* xacpx 抽象边界：[src/transport/types.ts](src/transport/types.ts#L230)

* xacpx bridge 协议：[src/bridge/bridge-server.ts](src/bridge/bridge-server.ts#L33)、[src/bridge/bridge-runtime.ts](src/bridge/bridge-runtime.ts)

* xacpx queue owner：[src/transport/acpx-queue-owner-launcher.ts](src/transport/acpx-queue-owner-launcher.ts)、[src/transport/queue-owner-reaper.ts](src/transport/queue-owner-reaper.ts)

* xacpx 输出解析（嵌入式后简化对象）：[src/transport/streaming-prompt.ts](src/transport/streaming-prompt.ts)、[src/adapters/acp-output-guard.ts](src/adapters/acp-output-guard.ts)

