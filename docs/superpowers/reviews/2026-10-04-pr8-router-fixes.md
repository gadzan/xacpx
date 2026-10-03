# PR #371 审查修复与自检

审查基准：`e57a8bef9838e0f8f3fe042aec919b67f07c7526`。实现依据：[Group 设计](../specs/2026-09-15-bots-group-conversations-design.md)、[分阶段执行方案 PR8](../plans/2026-09-15-bots-group-conversations-phased-implementation-plan.md)。实际运行契约见 [Conversation runtime](../../conversation-runtime.md)。

## 审查项闭环

| 审查项 | 修复及验证 |
| --- | --- |
| Blocker：零成员契约 | singular member/dispatch 可缺省；automatic 返回权威数组，包括 `[]`。真实 Control composition 验证首次 accept、相同 requestId replay、need-human 后取消；Web 不生成 undefined 成员。 |
| Blocker：并发路由与旧决策 | accept、settle、activation 共用 per-Run singleflight；每次取得持久化 routing generation，三类决策及错误均受所有权约束；慢 Router activation、shutdown、旧 complete/need-human/error 回归。 |
| Major：request snapshot | Router 与 store commit 复用 conversation/topic/run/human 四项 referential fence；同 Topic 外部 Run 请求损坏回归，Router 调用次数为零。 |
| Major：幂等优先级 | durable replay 先于 Router、target 与 live membership 检查；Router 移除后仍重放原 Run。 |
| Major：成员变更竞态 | 不跨模型调用持锁；返回后在所选 Bot lifecycle gates 内重读 Group membership、enabled 和执行快照，再同步落盘；移除/禁用竞态均不创建 MemberTurn。 |
| Major：精确结果关联 | 使用 MemberTurn.sourceTurnId 与 public message.sourceTurn.turnId，并限定 Conversation/Topic/Run/Bot；同 Bot 多批次 A/B、依赖 A 的 C 回归。 |
| Major：最近历史窗口 | beforeSeq 查询取最近 200 条后反转为 newest-first；500 条历史验证 seq 500..301。 |
| Major：顺序上下文隔离 | 组合固定的 pre-request baseline、自身 request 与明确引用行；不扩大连续 seq 窗口；后续排队 Run 的夹入请求不会进入前一 Run 的 successor。 |
| Medium：assignment 唯一性 | gate、store 校验 Run 内唯一，SQLite `(run_id, assignment_id)` 部分唯一索引兜底。 |
| Medium：audit 清理 | Topic/Group verified teardown 删除 routing_decisions，两种删除路径均有回归。 |
| Medium：严格 schema | 拒绝额外字段、缺失 trigger 数组和 PR8 不支持的 synthesisBotId；文档区分 supplied references 与 server-derived effective references。 |
| Medium：blockedReason producer | typed runtime permission error → SessionTurnRunner → TurnQueue → Conversation runner → dispatcher → SQLite → public DTO；真实 composition 验证 `human-authority-unknown`，不从错误文案推断权限。 |

同时修复 waiting-human 提前写 finishedAt、首批编号从 2 开始的问题。自检补充 Topic FIFO：更早的显式 Run 和零成员 automatic 请求不能被后续路由/claim 越过；settle/cancel 后唤醒合格后继。并行批次取共同 effective reference set；回归覆盖不同 supplied references 和首轮 Router pending 时取消。已有成员完成后停在 routing/waiting-human 的 automatic Run 也可取消：Run 记 cancelled/human-cancelled，保留已完成成员与结果，不误记为 completed。

## 验证结果

- 根 TypeScript `--noEmit`、全包 `bun run build:packages` 通过；最后代码调整后重新完成根构建和协议声明生成。
- Conversation、Control Bridge、relay-protocol、permissions：**573 pass / 0 fail**，23 个文件。其中 Router 专项 61 项，Conversation 总计 342 项。
- Relay Web 全量：**1929 pass**，147 个文件；构建同时通过 vue-tsc。
- 扩展 Control/Bots/State/Sessions/Integration：693 pass / 1 fail；唯一失败为 `worker binding engine resolution inherits the logical group's engine`。隔离运行原审查 HEAD 与修复代码均为 117 pass / 同一项 fail。
- 标准 `npm test` 完成前置构建、typecheck、acpx import policy 后停在 Hermes 的 bundled `/dist/` 路径用例；原审查 HEAD 同一用例也失败（两者均 9 pass / 1 fail）。不能将标准全量测试报告为通过。
- Conversation/Control/channel-relay/permissions 宽测试为 1181 pass / 1 skip / 34 fail / 4 errors。对其中 8 个失败文件在原审查 HEAD 和修复代码分别完成前置构建并逐文件对照：复现 27 个相同失败，没有新增失败名称；desktop lifecycle 两侧隔离运行都通过，宽测试中的超时未复现。

逐文件对照的已有失败包括：workspace-fs 3、workspace-git 5、Control golden fixture 9、credential 文件 POSIX 权限 2、retire terminal lock 1、terminal diagnostics 5、terminal registry lock 2。原提交对照并不等同于新 CI 全绿；仍须以更新提交的 CI 为最终合并检查。

未运行需要真实 acpx + 微信登录的 smoke tests。无可证明 capability restriction 的生产 Router 时继续返回 automatic_unsupported；PR9 handoff、完整 human continuation UX 和 Router 模型 adapter 仍按阶段边界留待后续。
