# PR #371 审查修复与自检

后续基于 `424aed66` 的审查、顺序前提核验、批次/Web 修复和取消竞态自检见 [2026-10-05 修复记录](2026-10-05-pr371-review-fixes.md)。下文按各轮基准保留历史验证结果。

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

## Focused 复审：remove → delete → stale Router

复审基准：`67ef023cf47b1db7243409bc9dcc1efb4f546417`。新增 Major 在真实 production composition 上先复现为 Run 停留 running/routing：`bots.getBot()` 抛出 BotError，而旧 commit catch 仅处理 ConversationError。

修复保留现有 lifecycle gates，在 commit 时先确认 Group membership，再读 Bot profile；同时将 typed BotError 当作领域拒绝落盘，规范化 `bot_not_found` → `router_unknown_member`、`bot_disabled` → `router_disabled_member`，失败仍检查 routing generation。

新增五项回归：真实 Control remove + delete + stale dispatch 链路，断言 failed/done、无 MemberTurn/dispatch、awaitRouting 收敛，且同 Topic 后续 automatic Run 自动完成；两个 BotError code 各验证当前 owner 持久化失败、旧 owner 不影响新 generation。Router 主 harness 同步改用生产 `bots.getBot()`，避免用 undefined-reader 掩盖异常类型。

相关 Conversation/Control Bridge/protocol/permissions 套件 **578 pass / 0 fail**（23 个文件，Conversation 347 项）；增强后的 Router + production composition focused 套件 **73 pass / 0 fail**（Router 65、composition 8）；根 typecheck 与根构建通过。完整微信 smoke 的环境限制仍沿用上轮记录。

## 全量复审：assignment execution、waiting question、automatic admission

复审基准：`5edad408777636d198c6bdff98e2696c2e033fb1`。依据设计 §12/§13 和执行方案 PR8 §11：具体 assignment 必须进入成员执行输入，并行成员共享的是 public snapshot，不是整个 prompt；need-human 必须有可恢复的产品数据；automatic accept 持久化零成员，由后续 decision budget 约束实际分派。

| 新审查项 | 修复及验证 |
| --- | --- |
| Blocker：task / expectedOutput 没有进入执行 | Dispatcher 在 router-origin Group prompt 中加入独立 assignment envelope；Task 与可选 Expected output 从该 MemberTurn 读取，public context 独立。真实 runner 验证各自 task、输出要求、无 sibling task、同一 public context；顺序成员同时收到自己的 task 与精确 dependency result；explicit prompt 保持原行为。真实 production Agent.chat 验证指令穿过 Control/queue/runner，来源仍是 orchestration。损坏的缺 task assignment 在 start 前失败。 |
| Medium：need-human question 不公开 | 同一 routing transaction 写 Run.waiting_question 与 audit；automatic waiting-human DTO 投影 waitingQuestion，贯通 Control detail/replay、Relay event validator、Web merge。真实 Control 验证事件和重新打开后的值；旧版 audit-only SQLite schema 在 production restart 后迁移并通过 Control 恢复。取消后不再投影 question，薄 waiting snapshot 保留已有值。 |
| Medium：automatic 误用 64 target cap | Admission 仅获取并重验一个 carrier 的生命周期锁，carrier 改变时重新获取；不为整个 enabled membership 加锁，不使用 explicit/everyone cap。静态 65 enabled 与 64 enabled + acquisition 期间并发 enable 两种情况均由 Router 选择同一个非 carrier 成员并完成，仅创建一个 MemberTurn；carrier 被 disable 的边界验证重试。explicit/everyone 原上限继续有效。 |

先用旧代码复现 task / question 缺失及静态 65-member 拒绝；并发 enable 用例在旧代码通过而静态状态失败，证实原 cap 行为不一致。最终验证：相关 23 文件 **584 pass / 0 fail**；Router + production composition **79 pass / 0 fail**；Relay Web 全量 147 文件 **1930 pass / 0 fail**；根 TypeScript typecheck、全包 `bun run build:packages`、`git diff --check` 通过，协议 JS 与声明同步重生成。

自检重新核对 routing singleflight/generation fence、zero-member FIFO/cancel/replay、remove-delete commit validation、request snapshot、exact result join、bounded history、sequential context、assignment uniqueness、audit cleanup、blockedReason provenance 及旧 schema migration，相关回归均通过。profile metadata revision fence 仍未列入现有设计要求；本次不扩大 PR8 至完整 human continuation 或模型 adapter。

本轮本地验证没有重跑已在原审查 HEAD 对照确认的 Windows 全量失败，也没有将其改记为通过；既有环境限制和失败记录继续有效。更新提交的 exact HEAD CI 另见 PR checks。

## 全量复审：routing deadline、result integrity、Web monotonicity、I/O budgets

复审基准：`67a0fe23dbe0749c4cf4975c0d4f6f067662dc3d`。依据执行方案 §21 的约 30 秒 Router deadline 与 bounded context，以及 §22 的 lifecycle、context、persistence、recovery 检查要求。

| 新审查项 | 修复及验证 |
| --- | --- |
| Major：Router 永不 settle 阻塞 Run/Topic/shutdown | Engine 自己执行可配置的 30 秒 deadline，向 adapter 传 AbortSignal，并独立 race provider 与 abort；不要求 adapter 配合。timeout 按 generation 落盘 `failed/router_timeout`，cancel、teardown 和 shutdown 主动 abort；shutdown 在关闭 SQLite 前结算 unfinished owner 为 `router_aborted`。永不 resolve 的 provider 回归验证超时释放同 Topic 后继、cancel/shutdown 有界收敛、迟到 dispatch/complete 不可覆盖、旧 timeout 不可失败新 generation；真实 production Control cancel/runtime shutdown 还验证关闭数据库后的迟到 rejection 被消费。停机结算不会唤醒 dispatcher 启动其他排队工作，回归确认另一 Topic 的 Run 保持 queued。 |
| Major：completed exact result 丢失被解释为空成功 | Router input、commit 和 dispatcher 共用 `requireMemberResult`，缺失 exact 成功证据记 `member_result_missing`；SQL 对非法 source JSON 安全返回缺失。Dispatcher 在 materialization 前与最后一个异步 start hook 后重验，失败不执行、不写 startedAt。回归覆盖结果行删除、source identity 损坏、非法 JSON，以及 start 前结果消失；真实空字符串结果仍正常路由并执行依赖成员。 |
| Medium：waiting-human 被 stale running 覆盖 | Web 拒绝同一 Run 的 waiting-human → running 回退。真实延迟的 runs.get promise 在 live waiting-human/question 事件后返回，状态和 question 均保留；原 terminal settlement 行为不变。 |
| Medium：Router I/O 只有部分边界 | Output assignment/Bot/reference ID 最长 128 字符，dependency/trigger 数组各最多 64 且拒绝重复，在 lookup 前完成 parser 检查。Input 序列化 JSON 最多 131,072 字符；request、transcript、result、历史说明及展示 metadata 采用确定性 prefix budgets 并显式标记 truncation。最多 128 个候选成员，enabled 优先且保留 Group 顺序，公开 omittedMemberCount；不增加 Group admission cap。身份和 execution 字段不截断，超预算固定结构在 adapter 调用前持久化失败。回归覆盖八类 malformed bounds、超长上下文、300-member Group 筛选与固定结构 overflow。 |

旧代码先复现六项 deadline/result-integrity 回归全部失败，修复后通过。自检另复现取消已落盘、dispatcher wake 正在等待后继 Bot 时旧 Router 尚未 abort；取消现在先启动同步 durable seal，再立即 abort，最后等待 wake，回归证明后继仍执行期间 routing ownership 已收敛。最终 focused 套件 **102 pass / 0 fail**（Router 92、production composition 10）；关联 23 文件 **607 pass / 0 fail**；Relay Web 全量 **1931 pass / 0 fail**，147 个文件。根 typecheck、全包 `bun run build:packages` 与 diff 检查通过；最后 lifecycle 调整后也重新完成根构建与相关回归。更新提交的 exact HEAD CI 另见 PR checks。

整体自检重新检查 generation/singleflight、zero-member replay/FIFO/cancel、membership/delete lifecycle gates、request fence、exact result identity、assignment execution/context isolation、audit teardown、permission provenance、waiting question migration 及协议输出。新增 truncation 只影响 Router snapshot，不改 durable 内容或实际成员 prompt；模型调用期间仍不持有 Bot 生命周期锁。按 PR8 范围保持生产 capability gate，后续 human continuation、handoff 与 model adapter 不在本次实现中。

已有本地 Windows 全量测试失败和 smoke 环境限制继续按上文记录；本轮不将这些检查报告为通过。

## Focused 复审及独立全量审查：graceful shutdown 与 recovery

复审基准：`458694e890a4982c97d94c181985c6737b5453f4`。上一节中 shutdown 写 `failed/router_aborted` 的实现与 PR8 的无副作用 Router 恢复模型冲突，本轮修正该语义；以 [Conversation runtime](../../conversation-runtime.md) 的当前契约为准。

| 审查项 | 修复及验证 |
| --- | --- |
| Major：正常停机永久失败安全可重算的 Router work | shutdown 使用独立 `router_shutdown` abort reason，仅停止本进程调用；保留 running/routing，完成成员、结果与预算不变。生产 Control/runtime 回归验证 hung Router 有界停机、reopen + activate 取得新 generation 并完成；旧 provider resolve/reject 不影响新 owner。普通 timeout 仍 failed/router_timeout，human cancel 仍 cancelled。只有该 signal 的同一 reason 对象触发恢复语义，adapter 错误不能伪装停机。 |
| 生命周期 gate acquisition 阻塞停机 | 已完成模型调用、等待所选 Bot lifecycle gate 的 attempt 同样 race parent abort；晚到 critical 在访问 store 前检查 signal。真实持锁回归验证 shutdown/cancel 在释放 Bot gate 前收敛，关闭数据库后释放旧 gate 也不创建 MemberTurn/audit 或产生迟到数据库访问。 |
| Major：pre-start terminal failure 不唤醒 automatic routing | `failOwnClaimBeforeStart` 使用既有 durable batch-settle eligibility 唤醒 Router。合法 Bot agent 修改导致 runtime revision rejection 后，Router 看到 failed assignment 并完成 Run，同 Topic 后续 Run 自动前进。completed exact result 损坏的四阶段回归也确认整个 Run 最终 failed/done，不只失败 MemberTurn。 |
| Major：recovery 丢失 assignment 指令；Medium：blockedReason 丢失 | assignment 的 Task/Expected output、缺 task 校验和 blockedReason 持久化按 durable automatic Run mode 识别，不依赖会变为 recovery 的 execution origin。两种恢复来源（pre-start retry、expired claim）各覆盖正常执行、typed permission failure、缺 task；reopen 验证 durable DTO，执行来源仍为 orchestration，human route/authority 不被恢复。真实 production permission producer 增加 expired-claim → Control detail 回归。 |
| Major：停机等待期间 active member settlement 启动 queued Topic | shutdown 入口先 stop dispatcher，再 drain routing 和已在执行的成员。三 Topic 回归确认活跃成员结果正常落盘、Router Run 留可恢复状态、另一个 queued Topic 不调用 runner。 |

按用户要求派遣三个独立子代理，从 `origin/main` 全量 diff 重新审查 Router/Run/SQLite、dispatcher/execution/recovery、Control/Relay/Web/protocol，阅读设计和 PR8 执行方案，分别独立复现并复核问题。各范围最终均无未闭环 finding；详情见 [独立审查记录](2026-10-04-pr371-full-review.md)。

本轮 focused **115 pass / 0 fail**；关联 Conversation/Control Bridge/protocol/permissions 套件 **620 pass / 0 fail**（23 个文件）；根 TypeScript typecheck、根 `bun run build` 和 `git diff --check` 通过。最终 exact HEAD 的 CI 见 PR checks。既有 Windows 全量失败和需要真实微信的 smoke 限制保持原记录，不改记为通过。
