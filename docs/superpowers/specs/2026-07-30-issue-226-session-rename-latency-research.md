# Issue #226：运行中会话重命名延迟调研

**日期：** 2026-07-30
**状态：** 调研完成，未修改实现
**范围：** [GitHub issue #226](https://github.com/gadzan/xacpx/issues/226)、Relay Web → Relay Hub → channel-relay → Core 的重命名链路、相关设计与测试

## 结论

Issue #226 是确定性的同会话 RPC 串行阻塞，不是 Vue 渲染或
`sessions-changed` 丢失：

1. Relay Web 在 Enter 后立即退出输入态，但 `renameSession()` 要先等待
   `control.sessions.rename` RPC 完成，成功后才写本地 `row.displayName`。所以现有注释和测试虽然称它为
   “optimistic”，实际不是“请求发出即更新”。
   来源：[InstanceTree 提交逻辑](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/components/InstanceTree.vue#L149-L167)、
   [instances store 重命名逻辑](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/stores/instances.ts#L295-L302)。
2. Relay Hub 把 `control.prompt` 与 `control.sessions.rename` 都映射到相同的
   `${instanceId}\0${sessionAlias}` 锁键；请求获得锁后一直持有到
   `gateway.sendRequest()` 返回。长 prompt 的响应要等 agent 回合结束，因此同一 alias 的 rename 只能排在它后面。
   来源：[受锁 RPC 的 alias 归类](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay/src/http/app.ts#L101-L116)、
   [锁实现](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay/src/http/app.ts#L118-L139)、
   [请求取得锁并等待网关响应](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay/src/http/app.ts#L392-L420)、
   [finally 释放锁](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay/src/http/app.ts#L443-L451)。
3. Prompt 完成后，rename 才被下发、持久化并返回；Web 随后更新本地行。因此现象精确吻合
   issue：“Enter 后看起来没成功，agent 执行结束后才显示新名称”。
   来源：[issue #226 正文](https://github.com/gadzan/xacpx/issues/226)。

最小根因修复是：**保留 rename 的 chat scope 盖戳，但把
`MSG.sessionsRename` 从 Hub 的 `rpcSessionAlias()` 串行集合中移除。**
建议同时把 Web 改成真正的乐观更新，并实现带请求代次/当前值检查的失败回滚；前者解决服务端阻塞，
后者提供即时反馈和稳健的错误体验。

## 复现序列

1. 在 Relay Web 选中会话 `S`，发送一个会持续执行的 prompt。
2. 该 prompt 的 HTTP RPC 在 Hub 取得 `(instanceId, S)` keyed lock，并等待 agent 回合完成。
3. Agent 仍执行时，从 `S` 的菜单进入 Rename，输入新名称并按 Enter。
4. 输入框立即消失，但 store 发出的 rename HTTP RPC 卡在同一个 keyed lock，尚未到达 connector。
5. Sidebar 继续从 `row.displayName || alias` 渲染旧值；用户也没有 pending 状态，容易重复提交。
6. Agent 回合完成，prompt RPC 释放锁；rename 才下发、持久化、触发
   `sessions-changed` 并返回。此时 Sidebar 才显示新名称。

来源：[issue #226 现象](https://github.com/gadzan/xacpx/issues/226)、
[Enter 提交后立即退出输入态](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/components/InstanceTree.vue#L158-L166)、
[Hub 取得并持有同会话锁](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay/src/http/app.ts#L392-L420)。

## 现有语义与为什么 rename 可以绕过 turn 锁

会话重命名只设置可选的展示标签，`alias`、`transportSession`、`/use` 身份都不变；设计文档明确将
“重命名底层 alias / transport session”列为范围外。因此它不改变当前回合的路由身份。
来源：[display-name 设计的 Goal / Decisions](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/docs/superpowers/specs/2026-06-29-relay-web-session-display-name-design.md#L6-L24)、
[Out of scope](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/docs/superpowers/specs/2026-06-29-relay-web-session-display-name-design.md#L99-L105)。

Connector 对多个下行 request 本身支持异步并发：收到 request 后调用 `onRequest`，不等待前一个
request 完成；control bridge 也以 fire-and-forget 方式启动
`dispatchControlRequest()`。
来源：[RelayClient request 分派](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/channel-relay/src/relay-client.ts#L246-L279)、
[control bridge 异步 dispatch](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/channel-relay/src/control-bridge.ts#L130-L143)。

Core 的展示名写入也已有自身的一致性边界：

- `ControlService.setSessionDisplayName()` 解析 scoped alias，调用 session service 持久化，成功后发
  `sessions-changed`。
  来源：[ControlService](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/src/control/control-service.ts#L547-L553)。
- `SessionService.setDisplayName()` 只修改 `display_name` 与 `last_used_at`，并通过共享
  `stateMutex` 的 `mutate()` 持久化。
  来源：[setDisplayName](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/src/sessions/session-service.ts#L785-L803)、
  [mutate 使用共享 mutex](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/src/sessions/session-service.ts#L849-L857)。
- 仓库的 bridge scheduler 已明确建立先例：同一 session 的 control 请求可以在 normal
  请求未完成时执行。
  来源：[bridge scheduler 并发测试](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/tests/unit/bridge/bridge-request-scheduler.test.ts#L46-L73)。

据此推断，展示名无需 Hub 的“整回合”锁；移出该锁不会使 alias/transport 身份在 turn 中途变化，
逻辑状态写入仍由 Core mutex 串行。这个判断不应外推到 create/remove/archive/unarchive：
它们改变会话生命周期，仍应保留现有排序。

## 回归来源

Hub 的 keyed RPC lock 由提交
[`feb4999d` / PR #187](https://github.com/gadzan/xacpx/commit/feb4999d732ec76d8f209e7f650bed46f9e99d76)
引入；该提交同时处理“删除后同名重建不得恢复旧历史”和删除成功后清 Hub transcript。
从提交 diff 看，lock 与 prompt、command、create/remove/archive/unarchive 一起进入 HTTP RPC
代理。这里关于 lock 保护生命周期/历史顺序的目的，是基于同一提交上下文的推断。

随后提交
[`08d5204` / PR #212](https://github.com/gadzan/xacpx/commit/08d5204286575a693f3e40881d86e31e4834fdeb)
修复 rename 没有 `chatKey`、错误被 Web 吞掉、其他 dashboard 不会实时刷新的问题。该提交同时做了两件不同性质的事：

- 正确地把 `MSG.sessionsRename` 加入 `CHAT_SCOPED_TYPES`，让 Hub 覆写可信
  `chatKey`；这必须保留。当前注释也说明 connector payload validator 需要该字段。
  来源：[chat-scoped 集合](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay/src/http/app.ts#L52-L74)、
  [chatKey stamping 测试](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/tests/unit/packages/relay/http-app.test.ts#L302-L322)。
- 不必要地把 `MSG.sessionsRename` 也加入 `rpcSessionAlias()` 的生命周期锁集合，从而引入
  issue #226。
  来源：[提交 diff](https://github.com/gadzan/xacpx/commit/08d5204286575a693f3e40881d86e31e4834fdeb)。

因此修复不能简单回退整个 #212；应只解耦“chat scope stamping”和“同会话 RPC locking”。

## 建议修复

### 1. 必需：解除 Hub 对 rename 的整回合串行

在 `packages/relay/src/http/app.ts` 的 `rpcSessionAlias()` 中移除
`type === MSG.sessionsRename`；不要从 `CHAT_SCOPED_TYPES` 移除它。

预期时序变为：

1. prompt 继续持有同会话的 lifecycle RPC lock；
2. rename 不申请该锁，立刻经 gateway 下发；
3. Core 在共享 state mutex 内写入 `display_name`；
4. `sessions-changed` 上行，所有打开的 dashboard 重拉权威列表；
5. rename RPC 返回成功。

### 2. 建议：Web 做真正的乐观更新，并带条件回滚

当前 store 是“RPC 成功后更新”，不是乐观更新。建议：

1. 保存旧 `displayName`；
2. 调用 RPC 前立即把本地行设置为 trimmed 新值；
3. RPC 失败时，仅在该行仍对应本次尝试时回滚旧值并继续抛错；
4. 用 `(instanceId, alias)` 的 mutation revision / request token 防止较早失败覆盖较新的成功重命名。

仅做这一步而不解除 Hub lock 不足以修复根因：

- 持久化仍要等 agent 回合结束；
- 期间任意 `sessions-changed` 会触发 `loadSessions()`，它直接以服务端数组替换
  `inst.sessions`，可能用旧权威值覆盖乐观标签；
  来源：[sessions-changed 重拉](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/stores/instances.ts#L313-L329)、
  [loadSessions 整体替换](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/stores/instances.ts#L87-L112)。
- 用户连续重命名时，乱序成功/失败可能把较新的标签回滚成旧值。

如果实现真正 optimism，`loadSessions()` 还应合并仍 pending 的 rename overlay，直到对应请求成功并由
权威列表确认，或请求失败并条件回滚。

## 拒绝的替代方案

### 只做前端乐观更新

拒绝作为完整修复。它会让单个浏览器暂时显示新值，但 rename 仍未到达 Core；agent 回合结束前的
会话列表重拉还可能用旧值覆盖本地值，其他 dashboard 也看不到已持久化的新名称。

### 把本地更新继续放在 RPC 成功后，只加 loading 状态

拒绝。Loading 能降低重复提交概率，但仍保留不必要的整回合延迟，未修复根因。

### 从 `CHAT_SCOPED_TYPES` 删除 rename

拒绝。#212 已证明 connector 的 rename payload 需要 Hub 盖戳的可信 `chatKey`；删除会使 rename
重新变成 `invalid-payload` 或解析到错误 scope。

### 让所有会话管理 RPC 都绕过 keyed lock

拒绝。Create/remove/archive/unarchive 改变会话生命周期；本调研只证明纯展示元数据 rename
不需要 turn 锁，没有证据支持扩大到生命周期操作。

### 回退整个 #212

拒绝。#212 同时修复了 chat scope、RPC error unwrap、错误 toast 与跨 dashboard 的
`sessions-changed`；问题只在它把 rename 偶合到 lifecycle lock。

## 测试缺口与建议用例

现有覆盖验证了：

- Enter 会调用 store，Escape 取消，Enter + blur 不会重复提交；
  来源：[InstanceTree rename 测试](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/__tests__/instancetree-rename.test.ts#L23-L71)。
- RPC 立即 resolve 后本地值正确，RPC error 后旧值保留；
  来源：[instances rename 测试](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/packages/relay-web/src/__tests__/instances-rename.test.ts#L9-L57)。
- Core 持久化成功后会发 `sessions-changed`。
  来源：[ControlService display-name 测试](https://github.com/gadzan/xacpx/blob/6248fe2e9df5db855f28306acc3d365a0889874d/tests/unit/control/control-service-display-name.test.ts#L33-L56)。

这些测试都没有构造“同 alias 的 prompt 尚未 resolve”或“rename RPC 尚未 resolve”，所以无法发现
#226。建议增加：

1. **Hub 并发回归测试（关键）：** 用 deferred gateway 挂起 `control.prompt`，随后向同一
   instance + alias 发 `control.sessions.rename`；断言 rename 已到达 gateway 且能在 prompt
   release 前返回。再用 remove/archive 等生命周期操作做反例，断言它们仍等待。
2. **Web 真 optimism 测试：** deferred rename RPC 未完成时，立即断言 sidebar/store 已显示新值。
3. **失败条件回滚：** 单次失败恢复旧值并显示既有错误 toast。
4. **连续 rename 乱序：** A 后 B，A 迟到失败不得回滚 B。
5. **pending overlay 对账：** rename 未完成期间触发 `loadSessions()` 返回旧标签，不得覆盖仍 pending
   的本地值；成功后的权威新标签应清除 overlay。

## 本次验证

调研期间运行了现有相关测试；它们全部通过，也印证了上述并发覆盖缺口：

- `bun run --cwd packages/relay-web test -- src/__tests__/instances-rename.test.ts src/__tests__/instancetree-rename.test.ts`
  — 2 个文件、8 个测试通过。
- `bun test tests/unit/packages/relay/http-app.test.ts tests/unit/control/control-service-display-name.test.ts`
  — 2 个文件、37 个测试通过。

未运行 smoke tests；本次未修改实现。

## 非目标

- 不改 alias、transport session 或 `/use` 语义。
- 不让 create/remove/archive/unarchive 绕过生命周期锁。
- 不以静默吞错换取“即时感”；#212 增加的 error unwrap、upgrade hint、toast 和
  `sessions-changed` 都应保留。
