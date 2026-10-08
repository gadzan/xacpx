# PR #378 ACP notification guard 修复

审查基准：`e642e0b76be6d7fe9e4d174cd5b2b264cadaaa3a`。依据 [Phase 10B 执行方案](../plans/2026-09-15-bots-group-conversations-phased-implementation-plan.md)、[Group 设计](../specs/2026-09-15-bots-group-conversations-design.md) 和 [enforced execution effects](../../conversation-runtime.md#enforced-execution-effects-phase-10b) 契约。

## P2 闭环

旧 Guard 将所有无 id 的 Agent 方法消息直接转发，允许文件写入、terminal、权限及未知扩展方法穿透 capability filter。确认的是过滤边界缺失；本次没有证明 acpx 会执行这些非法通知，也不依赖下游拒绝通知来维持 ceiling。

Agent 方法消息现在明确区分请求和通知。无 id 时仅放行 `session/update`；其余方法一律返回 drop decision，stdio pump 不转发、不回包。带 id 的 `fs/read_text_file` 保持可用，权限请求仍返回 cancelled，其余请求仍拒绝。初始化 capability 收敛、普通 result/error 响应和 terminal metadata 保持原路径。无 id 的 read 方法也丢弃，带 id 的 update 方法不被当作合法通知。

这遵循 [JSON-RPC notification semantics](https://www.jsonrpc.org/specification#notification)；ACP 的 Agent progress 使用 [session/update notifications](https://agentclientprotocol.com/protocol/v1/overview)。SDK 的独占工具集、版本支持、调度 proof、持久化和权限来源均未更改。

## 回归与验证

- 新增 **13 项回归**在旧代码全部失败，修复后全部通过。覆盖五种 terminal 方法、未知 terminal 扩展、write、permission、elicitation、普通/下划线扩展，以及合法 update、读取请求、result/error 和 id 形态。
- 真实 Guard 子进程回归向 Agent stdout 注入十二种禁止或无效通知，Client 只收到 update、合法 read 请求和最终 response；Agent 只收到四个带 id 请求的响应，没有通知回包，后续 RPC 可完成。
- Guard 专项：**31 pass / 0 fail**。根 TypeScript `--noEmit`、`bun run build`、`git diff --check` 通过。独立 Node 探针验证打包后的 `dist/adapters/acp-read-only-guard-main.js` 同样丢弃十二种通知并保留合法 progress/response。
- 扩展的 adapters + Conversation + Control Bridge + relay-protocol 套件：**1099 pass / 2 fail**，44 个文件。所有 **766 Conversation** 与 **221 Bridge/protocol** 测试通过。两项失败是 Hermes POSIX file URL 和 Node fallback 的本地 Windows 既有问题；在仓库外提取的 exact `e642e0b7` 源码/测试快照中独立复现了相同失败，未将该扩展套件报告为全绿。

新提交的跨平台全量检查及原生 pinned Claude SDK 负向能力验证以 PR 的 exact HEAD CI 为准。本轮本地没有运行原生 SDK fixture 或真实 provider/微信 smoke；已有验证记录不改记为本次本地通过。
