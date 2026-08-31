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
