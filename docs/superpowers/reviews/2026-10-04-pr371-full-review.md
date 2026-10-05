# PR #371 独立全量审查

审查对象：[PR #371](https://github.com/gadzan/xacpx/pull/371)，基准 `origin/main`，本轮修复前 HEAD `458694e890a4982c97d94c181985c6737b5453f4`。依据 [Group 设计](../specs/2026-09-15-bots-group-conversations-design.md)、[分阶段执行方案 PR8](../plans/2026-09-15-bots-group-conversations-phased-implementation-plan.md) 和 [Conversation runtime](../../conversation-runtime.md)。本记录涵盖全量 diff 的独立审查与本轮修复，最终提交及 CI 状态由 PR checks 记录。

## 范围及结论

按用户要求派遣三个子代理，仅进行审查与独立验证，不修改共享源码或执行共享构建。发现的问题全部交由主代理修复，并加入仓库回归；完整修复说明见 [审查修复记录](2026-10-04-pr8-router-fixes.md)。

| 独立范围 | 覆盖 | 最终结论 |
| --- | --- | --- |
| Router / Run / SQLite | capability gate、deadline/abort、singleflight/generation CAS、FIFO、restart activation、预算、strict schema、request/result identity、membership gates、question migration、audit cleanup | 无未闭环 finding；独立验证 recovery 任务/权限证据和持锁期间 cancel/shutdown。 |
| Dispatcher / execution | assignment 输入、parallel/sequential frozen context、claim/start/cancel/restart fencing、single-writer、运行身份与权限来源、隐藏 session、membership/delete、teardown ownership | 无未闭环 finding；复现并关闭 pre-start failure 不唤醒、recovery 丢失 assignment、停机启动 queued Topic 三项 Major。 |
| Control / Relay / Web / protocol | zero-member DTO、幂等 replay、waitingQuestion、event/reconnect、Web 状态单调性、生成协议同步、automatic admission、blockedReason producer | 无新增 finding；公开路径与现有阶段边界一致。 |

恢复时 `origin=recovery` 的权限降级仍保留：assignment 语义按 automatic Run mode 确定，执行保持 orchestration，不恢复 human permission route/authority。shutdown 只中断本地无副作用 Router 调用，不将用户工作判失败；timeout 和 human cancel 的原有终态不变。

## 验证

- 主代理 Router + production composition：**115 pass / 0 fail**，覆盖真实 Control shutdown/reopen/activation、晚到旧 provider、持 Bot gate 的 abort、pre-start terminal failure、两种 recovery 的任务/输出要求/blockedReason/缺 task、活跃成员 settlement 与 queued Topic 隔离。
- 主代理关联 Conversation/Control Bridge/protocol/permissions：**620 pass / 0 fail**，23 个文件。
- 主代理根 TypeScript `--noEmit`、根 `bun run build`、`git diff --check` 通过。
- 子代理执行链既有专项：**200 pass / 0 fail**；仓库外最小 adversarial 复现修复前失败，修复后 **4 pass / 0 fail**。
- 子代理 Router/storage 独立恢复回归 **4 pass**，持生命周期锁 shutdown/cancel **2 pass**；释放旧 gate 后无 MemberTurn/audit 或迟到 store access。
- 子代理 public contracts 的 protocol/channel-relay/Web/production 专项：**377 pass / 0 fail**。

本轮只更改 Conversation lifecycle/execution 和相应文档、回归。上一轮 Web 全量 147 文件 **1931 pass**、全包构建结果仍记录于修复报告；本轮通过 final exact HEAD CI 再验证跨平台完整检查。已确认的 Windows 本地标准全量失败与真实 acpx/微信 smoke 未运行限制，不改记为通过。

## 阶段边界

PR8 提供受 capability gate 约束的 stateless Router 接口；未声明七项 restriction 的实现仍拒绝 automatic admission。完整 human continuation、handoff 和生产模型 adapter 按后续阶段保留。Profile revision fence 尚未由设计要求；本轮继续 enforce commit-time membership/enabled 与执行快照一致性，不扩大成全 profile optimistic concurrency。
