# PR #371 新一轮审查修复与独立自检

审查基准：`424aed6657cf39e07e3004b92c7ee1e4e983d1a8`。依据 [Group 设计](../specs/2026-09-15-bots-group-conversations-design.md)、[分阶段执行方案 PR8](../plans/2026-09-15-bots-group-conversations-phased-implementation-plan.md) 和当前 [Conversation runtime](../../conversation-runtime.md)。前轮修复及环境限制保留于 [历史记录](2026-10-04-pr8-router-fixes.md)。最终提交 SHA 和对应 CI 见 PR checks。

## 审查项及结果

| 审查项 | 核验、实现与回归 |
| --- | --- |
| Transcript 预算与最近上下文 | 原 production 顺序前提不成立：store 的 beforeSeq 查询在返回前转为升序，engine 再反转，因此实际输入仍为 newest-first `500..301`。主代理与两名子代理分别以真实 SQLite 的 500 条、每条 3,000 字符历史核验，旧实现已保留最新文本。本轮防御加固按 `seq` 降序分配 32,000 字符预算，并保留输入行顺序、身份、truncation 标记和 durable 原文。升序与混合输入在旧实现失败，修复后与降序一致；真实生产历史验证最新 16 条各保留 2,000 字符。 |
| Medium：跨批次 failure aggregate 污染 | 新 dispatch 在同一 SQLite transaction 内递增 activeBatch 并清空 failedBotIds / unavailableBotIds。已结算批次仍向下一次 Router 输入提供失败信息；新批次只呈现自己的聚合，Run-wide history、exact results、consumedMemberTurns 不变。真实失败 → 同 Bot 重试成功 → reopen/DTO 回归保留历史而清空当前失败。子代理另复现取消第二批排队成员重新带入第一批失败；cancel anchor 现优先 activeBatch，聚合失败 ID 同样限定 activeBatch，正式回归先红后绿。 |
| Minor：Web 薄 MemberTurn 覆盖证据 | 接受同状态更新时，省略的 assignment/task/expectedOutput/dependsOn、关联 ID、时间和 failure/blockedReason 保留已知值；显式空字符串、空数组和新值仍覆盖。真正的状态前进不继承旧 failure/blockedReason。三项回归覆盖 rich → thin → explicit replacement 以及 indeterminate → completed/failed。 |
| 自检新增 Major：取消期间重新路由或启动执行 | 独立复现 human Stop 尚在等待 physical cancel 时，成员自然结算触发下一批；以及 execution-start 异步 hook 后真实 Control runner 尚未登记执行、取消返回 unknown 的 provider admission 竞态。queued/running 的 completionReason 被统一视为 durable cancel intent；candidate query、generation acquisition、decision/failure commit、dispatch claim/materialize/start 及最后一次 provider admission 检查均受该 intent 约束。自然成功/失败保留真实证据并分类终态，不能继续 automatic 路由。activation 在调度前收敛 previous-owner started claims，另分类没有残留 claim、成员已结算的取消意图。真实 Control runner、自然成功/失败、三类 reopen/recovery 和同 Topic successor 回归均通过。 |

上述取消修复遵循执行方案的 exact Run cancel / suppress new dispatches 与 §22 race checklist。普通 timeout、human Stop 和 graceful shutdown 的既有区分继续保留：正常停机仍只中止本进程无副作用的 Router attempt，安全未提交工作可在下一 consumer 重算；取消过程中真实 execution proof 继续落盘，unknown 继续 fail closed 为 indeterminate。

## 独立审查

按用户已授权的子代理审查要求，三个子代理重新检查完整 PR 的各自范围、设计和执行方案，再对新增改动进行独立验证，不修改共享源码或执行共享构建。

| 范围 | 结论与独立证据 |
| --- | --- |
| Router / Run / SQLite / recovery | 未闭环 finding 为零；相关正式测试 331 项通过，独立真实链三项通过。核验 generation/CAS、shutdown/restart、membership/delete、exact evidence、预算、批次聚合、取消 intent 和 activation。 |
| Dispatcher / execution / cancellation | 未闭环 finding 为零；四项此前失败的独立取消回归全部通过，正式取消边界九项通过，既有 execution/context 专项十一项通过。真实 Control runner 用 typed harness 注入验证，不以 mock 字段代替实际 admission。 |
| Control / Relay / Web / protocol | 未闭环 finding 为零；Group store 56 项通过。核验等待问题、成员证据合并、真正的状态前进、公开 DTO 与现有协议输出。 |

预算补强仅影响 Router snapshot；assignment 实际执行、parallel frozen public context、sequential exact refs、permission provenance、zero-member replay/FIFO/cancel、question migration、audit cleanup 和 capability restriction 保持现有设计边界。完整 human continuation、PR9 handoff、生产模型 adapter 仍按原计划留待后续。

## 最终本地验证

- Conversation / Control Bridge / relay-protocol / permissions：**632 pass / 0 fail**，23 个文件。
- 其中 Router + production composition：**127 pass / 0 fail**。
- Relay Web 全量：**1934 pass / 0 fail**，147 个文件；Group store + Group components focused 97 项通过。
- 根 TypeScript `--noEmit`、全包 `bun run build:packages`（含 vue-tsc、protocol runtime export assertion）和 `git diff --check` 通过。生成协议没有新增 diff。

之前已对照确认的本地 Windows 全量失败没有改记为通过；详见历史记录。本轮没有运行需要真实 acpx + 微信登录的 smoke tests。更新提交的 Linux/macOS 全量、兼容、构建和 Web E2E 以 exact HEAD CI 为准。
