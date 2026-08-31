# Queue Overflow 软提示方案（xacpx 单侧，不动 acpx）

## 目标
- 高频 `ACPX_QUEUE_MESSAGE_OVERFLOW`（acpx `ipc.ts:43,273` 单行 10MiB）不再以 `⚠️ Execution error` 刷屏
- 降为 **warning 级软提示**，双语（zh/en），可观测，下一句可直接继续

## 现状链路
`bridge-runtime.prompt:589` 捕获溢出 → `cleanupOverflowedOwner`（cancel + `terminateAcpxQueueOwnerVerified`，成功时文案 `The local agent queue was stopped…`）→ 抛 `AcpxQueueOverflowError` → `bridge-server:141` 转 `code=ACPX_QUEUE_MESSAGE_OVERFLOW` → `session-recovery-handler.renderTransportError:40` 不识别直接 `throw` → `handle-weixin-message-turn:683` 以 `t().misc.executionError` 强提醒（含 stack）

- 溢出后 owner 已被杀，无幽灵 turn；`reply()` 已发出的 mid 段已送达，仅丢当轮**最终回复**的超大单行

## 设计决策
| 维度 | 决策 | 原因 |
|---|---|---|
| 降级位置 | `session-recovery-handler.renderTransportError` 拦截 `AcpxQueueOverflowError` 实例，返回 `RouterResponse` | 最靠近用户面，一处改动同时覆盖 `bridge` 与 `acpx-cli` 两条 transport；返回即走 `turn.text → handle-weixin final` 正常路径，不进 `catch→executionError` |
| 文案语气 | warning，非 error；不用 `错误信息：` 前缀，用 `⚠️` + 中性提示 | 满足“不要 error tips”诉求 |
| 双语 | 新增 `RecoveryMessages` 3 个 key，`t().recovery.*` 驱动 | 复用既有 i18n 机制，`getLocale()` 自动切 zh/en |
| 可观测性 | 在降级分支 `logger.warn` 结构化日志（code、alias、transportSession、cleanupDiagnostic 摘要） | 前端不刷屏，后端仍可告警/排障；不写 `errLog` 避免触发 error 监控 |
| 不重试 | 仍保持 `bridge-runtime` 的“不自动重试”策略 | 同 prompt 重试极大概率再次溢出，自动重试只是烧 token |

## 文件改动（4 个文件 + 1 单测）
1. `src/i18n/types.ts:242` — `RecoveryMessages` 新增：
   ```ts
   queueOverflowWarning: string;          // 标题行
   queueOverflowHint: string;             // 操作建议
   queueOverflowDetail?: (d?: string) => string; // 可选：cleanup 摘要（截断 512 已在 AcpxQueueOverflowError 内）
   ```
2. `src/i18n/messages/zh/recovery.ts` / `src/i18n/messages/en/recovery.ts`
   - zh: `queueOverflowWarning: "⚠️ 单次输出过大，已自动处理"`；`queueOverflowHint: "请让 agent 分步/摘要输出，或拆成多次发送；会话已就绪，可直接继续。"`
   - en: `queueOverflowWarning: "⚠️ Output too large — handled gracefully"`；`queueOverflowHint: "Ask the agent to summarize or send in smaller chunks, then retry. The session is ready for your next message."`
   - 避免提 `10MiB`/`ACP` 内幕，保持用户语言
3. `src/commands/handlers/session-recovery-handler.ts:13`
   ```ts
   import { AcpxQueueOverflowError } from "../../transport/acpx-queue-overflow";
   export function renderTransportError(session, error) {
     if (error instanceof AcpxQueueOverflowError) {
       // 可观测性：warn 而非 error；不在此处抛
       // logger 由调用方注入，见下
       return { text: [t().recovery.queueOverflowWarning, t().recovery.queueOverflowHint].join("\n") };
     }
     // ... 现有 No acpx session / isPartialPromptOutputError 分支不变
   }
   ```
   - 需解决 logger 注入：`renderTransportError`  currently 纯函数无 logger。方案 A（推荐）：在 `src/commands/handlers/session-handler.ts:951,956` 的 `catch` 中先 `context.logger.warn("transport.queue_overflow_downgraded", {...})` 再调 `renderTransportError`；方案 B：给 `renderTransportError` 加可选 `logger` 参数。选 A，不改函数签名。
4. `src/commands/handlers/session-handler.ts:928ff` — `handlePromptWithSession` 的 `catch` 中，对 `AcpxQueueOverflowError` 先 `logger.warn`（含 `session.alias/transportSession/cleanupDiagnostic`），再走 `renderTransportError`（不再 `throw`）。其他错误保持 `throw → executionError`。
5. 可选增强（不做也行）：`src/bridge/bridge-runtime.ts:594` 已有 cleanup 诊断，降为 warn 日志级别（现为 error 路径的一部分），避免双记

## 不改动项
- `acpx` 侧 `ipc.ts` 10MiB 常量不动
- `bridge-runtime.cleanupOverflowedOwner` 保留（必须杀 owner 防幽灵 turn）
- `bridge-server` 错误码映射保留，仅 `renderTransportError` 提前拦截，`executionError` 分支不再触达

## 文案定稿（双语）
- zh: 
  ```
  ⚠️ 单次输出过大，已自动处理
  请让 agent 分步/摘要输出，或拆成多次发送；会话已就绪，可直接继续。
  ```
- en:
  ```
  ⚠️ Output too large — handled gracefully
  Ask the agent to summarize or send in smaller chunks, then retry. The session is ready for your next message.
  ```

## 可观测性
- `logger.warn` 事件名：`transport.queue_overflow_downgraded`
- 字段：`code=ACPX_QUEUE_MESSAGE_OVERFLOW, alias, transportSession, ownerTerminationSucceeded, cancelSucceeded, diagnostic(≤512)`
- 前端：`handle-weixin-message-turn:682 errLog` 不再触发；`perfSpan.setOutcome("warning")` 可选

## 验证
- `npx tsc --noEmit` — i18n 类型收敛
- 新增单测 `tests/unit/commands/session-recovery-handler.test.ts`：`AcpxQueueOverflowError` → 返回 warning 文案且不抛；`zh/en` 各一例
- 自动化 dry-run：`bun run dry-run --chat-key wx:test -- "/session new demo --agent codex --ws backend" "/status"`（回归）
- 手动：mock `AcpxQueueOverflowError` 触发一次 prompt，确认微信收到 warning 而非 `⚠️ Execution error: Agent emitted an oversized…`

## 风险与回退
- 风险：用户误以为空成功。缓解：文案明确“未完整送达 + 如何重试”
- 回退：注释掉 `renderTransportError` 新增分支即回到强提醒；或加 `config.transport.suppressQueueOverflow=false` 开关（本方案先不加开关，保持最小改动）

---

## Review Fixes（PR #317 REQUEST_CHANGES 2026-08-31）

> 审阅结论：方向认可（降级放在 `renderTransportError` 用户面 + warning 日志正确），但把“识别到 overflow”和“已经安全收敛、可继续”混为一谈导致 2 Blocking + 1 High。

### 1) Blocking — `acpx-cli` 路径被误软化（无 cleanup）

- **问题**：`renderTransportError` 原直接认 `isAcpxQueueMessageOverflow(error)`，导致 `Message buffer exceeded …` 裸串在 `AcpxCliTransport`（无 `cleanupOverflowedOwner`）下也会被软化为“会话已就绪”。而 `BridgeRuntime` 之所以能 soft，是因为它先 `cancel + terminateAcpxQueueOwnerVerified` 再抛 `AcpxQueueOverflowError`。
- **修复**：
  - `src/transport/acpx-cli/acpx-cli-transport.ts` 新增 `cleanupOverflowedOwner()`（复用 bridge 同款：cancel → readSessionRecord → `terminateAcpxQueueOwnerVerified`，各步失败只记 diagnostic）并在 `prompt()` 外层 `catch` 中 `isAcpxQueueMessageOverflow → cleanup → throw AcpxQueueOverflowError`。
  - `src/commands/handlers/session-recovery-handler.ts` 收窄软化条件：**仅** `error instanceof AcpxQueueOverflowError` 才 soft；裸 `isAcpxQueueMessageOverflow` 保持 hard（`throw` → `executionError`），直到对应 transport 完成 cleanup 并转成 typed error。

### 2) Blocking — bridge cleanup 失败仍承诺 “session is ready”

- **问题**：`cleanupOverflowedOwner()` 可能 `cancelSucceeded=false` 或 `ownerTerminationSucceeded=false`，原 soft 文案无条件返回“会话已就绪，可直接继续”，且 `bridge-server → bridge-client` 仅透传 `code + message`，丢失了 `cleanup` 结构，导致 daemon 侧无法判断是否真 ready，下一句可能与幽灵 turn 并发。
- **修复**：
  - **i18n**：`RecoveryMessages` 新增 `queueOverflowUnconfirmedHint`（zh: “自动清理未能确认完成，请先发送 /cancel 后重试…”；en: “Automatic cleanup could not be confirmed. Please send /cancel first…”），`queueOverflowHint` 保留仅用于 confirmed 场景。
  - **协议**：`src/transport/acpx-bridge/acpx-bridge-protocol.ts` `BridgeErrorResponse.error` 新增可选 `queueOverflowCleanup?: AcpxQueueCleanupResult`；`src/bridge/bridge-server.ts` 在 `AcpxQueueOverflowError` 时附带 `...{ queueOverflowCleanup: error.cleanup }`；`src/transport/acpx-bridge/acpx-bridge-client.ts` 在 `code === ACPX_QUEUE_MESSAGE_OVERFLOW` 时重建 `AcpxQueueOverflowError(cleanup ?? message)`，保留 `ownerTerminationSucceeded` 语义跨进程。
  - **用户面**：`renderTransportError` 对 `AcpxQueueOverflowError` 再分两档：
    ```ts
    const confirmed = error.cleanup?.ownerTerminationSucceeded === true;
    return confirmed
      ? { text: [warning, hint].join("\n") }                 // ready
      : { text: [warning, unconfirmedHint].join("\n") };     // /cancel 提示，不承诺 ready
    ```
  - **可观测性**：`src/commands/handlers/session-handler.ts` `handlePromptWithSession` catch 中 `logger.warn` 分事件 `transport.queue_overflow_downgraded`（confirmed）vs `transport.queue_overflow_unconfirmed`，并透出 `confirmed` 字段。

### 3) High — 为匹配 `ACPX_` 前缀把 `\b` 全删导致误命中

- **问题**：将 `/\bQUEUE_MESSAGE_OVERFLOW\b/` 改为 `/QUEUE_MESSAGE_OVERFLOW/` 后，`NOT_QUEUE_MESSAGE_OVERFLOW_RETRY`、`QUEUE_MESSAGE_OVERFLOWED`、`SOME_QUEUE_EVENT_TOO_LARGE_BACKOFF` 等都会触发 `cleanupOverflowedOwner()`（cancel + terminate），属于破坏性误操作。
- **修复**：
  - 恢复原有带边界正则：`/\bQUEUE_EVENT_TOO_LARGE\b/`, `/\bQUEUE_MESSAGE_OVERFLOW\b/`。
  - 新增精确 `ACPX_QUEUE_MESSAGE_OVERFLOW` 匹配：`/\bACPX_QUEUE_MESSAGE_OVERFLOW\b/` + `text === ACPX_QUEUE_MESSAGE_OVERFLOW_CODE`，并在 `isAcpxQueueMessageOverflow` 中按 `text === code || ACPX_PATTERN.test(text) || QUEUE_…` 顺序判断。
  - `renderTransportError` 不再依赖 `isAcpxQueueMessageOverflow` 做软化判断，仅依赖 typed `AcpxQueueOverflowError`（其 `code` 已精确），避免文本误分类触发 UI 降级。
  - 单测：`tests/unit/transport/acpx-queue-overflow.test.ts` 补 `recognizes exact ACPX_QUEUE_MESSAGE_OVERFLOW code` + `does not match overflow substrings with extra prefix/suffix`（三例 negative）+ `still matches buffer overflow with surrounding text`。

### 回归测试补齐（PR 建议 5 项）

1. `AcpxCliTransport` raw buffer overflow：已加 `cleanupOverflowedOwner`，`prompt` 溢出后才抛 typed error，`session-recovery-handler` 仅对 typed 且 confirmed 软化。
2. `cleanup {cancelSucceeded:false, ownerTerminationSucceeded:false}`：`renderTransportError` 返回 `queueOverflowUnconfirmedHint`（含 `/cancel`），绝不返回 ready 文案。
3. bridge cleanup 成功路径：`bridge-server → bridge-client` 重建后仍为 confirmed，`session-handler` 记 `transport.queue_overflow_downgraded` 并返回 ready。
4. `ACPX_QUEUE_MESSAGE_OVERFLOW` 精确匹配通过，`...OVERFLOWED`/`...RETRY` 等带前后缀的相似串不触发（见上）。
5. `handlePromptWithSession` 级链路：`tests/unit/commands/handlers/session-handler.test.ts` 新增 3 例——confirmed→ready+warn、unconfirmed→unconfirmed+warn、raw buffer→不 warn 且保持 hard throw。

实现后 `npx tsc --noEmit`、新增单测（`acpx-queue-overflow` 3 新增、`session-recovery-handler` 6、`session-handler` 3、`bridge-server` 更新、`bridge-client` 更新）及 `bun run build` 均通过。
