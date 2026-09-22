你负责执行 xacpx 的 **ACP Elicitation M2 — Discord Vertical Slice**。

M1 Core Foundation 已完成并通过（21 轮 review，全部 finding 关闭，CI 全绿）。你的任务是严格按下面的文档和契约实现 M2，**不要重新设计已settled 的东西**。

---

## 1. 必读文档（按顺序）

1. `docs/superpowers/plans/2026-09-22-acp-elicitation-m2-discord-implementation.md`
   ← **这是你的执行计划**，10 步 + definition of done，直接按它做
2. `docs/superpowers/closures/2026-09-20-acp-elicitation-m1-closure.md`
   ← M1 的 closure report。**§0 "What M1 already guarantees" 表格里的一切都不要重做**；
   §Review round 14/15 解释了为什么 abort 契约是现在这样；末尾的 mutation table
   说明这个项目要求的回归测试纪律
3. `docs/superpowers/plans/2026-09-20-acp-elicitation-discord-plan.md`
   ← 原始设计（§13 测试矩阵、§16 definition of done 是权威）
4. `src/interactions/elicitation-types.ts`
   ← **插件契约的唯一权威来源**。`MessageChannelElicitationRuntime` 上的
   MUST 清单就是你要实现的东西

不需要重读 M1 的 core-foundation plan，也不需要读 roadmap 的 M3/M4/M5 部分。

## 2. 当前状态

| 项 | 值 |
|---|---|
| M1 PR | **#355** `feat(elicitation): ACP Elicitation M1 core foundation` |
| M1 head | `84451dfa3ee4c0091727de31415fe02f321590f5`（最新，CI 全绿，mergeable） |
| M1 分支 | `feat/acp-elicitation-core-foundation` |
| #350 | 仍 OPEN — **不阻塞 M2**，不要等它 |
| 当前 main | `6346efdf` |

M2 分支从 `feat/acp-elicitation-core-foundation` 拉出（M1 未合并也要做，合入顺序不变）：

```bash
git switch feat/acp-elicitation-core-foundation
git switch -c feat/discord-elicit-form
```

## 3. 开工前必须做的一件事

`dist/plugin-api.d.ts` 是 **gitignored 的构建产物**，可能是过期的（M2 开始前它导出
0 个 `ChannelElicitation` 类型）。不重新生成，Discord 包解析不到 elicitation surface，
编译会失败：

```bash
npm run build:plugin-api
```

验证：`grep -c ChannelElicitation dist/plugin-api.d.ts` 应该 `>= 1`。

## 4. 硬约束（M1 用 21 轮 review 换来的，违反任何一条都会被打回）

### 4.1 三个 action，且每个都要 responderId

```ts
{ action: "accept", responderId, content }   // 用户 review 后提交
{ action: "decline", responderId }           // 用户明确拒绝
{ action: "cancel",  responderId }           // 用户放弃
```

**没有 responder-free variant，永远不要加。** M1 R14 加过一次，R15 作为 Blocking 撤回：
那个 variant 在真实 abort 时不可达，唯一可达的效果是让 renderer bug 在没有认证
responder 的情况下 settle 一个 user cancel — actor 边界被绕过。

### 4.2 外部 abort 不是 decision

`request.signal` abort（timeout / turn disposal / agent `$/cancel_request` /
shutdown）时：

- 立即禁用 UI、停止采集
- **reject/throw 这个 promise，或者干脆不 settle**
- core 会自己 settle 成 `cancel`

**绝不为外部 abort 伪造 responderId。**

### 4.3 答案只在插件内存

- 不放 Discord custom id（custom id 只含 opaque token + 路由身份）
- 不写日志
- 不持久化
- 不放进消息内容里会被记录的地方

### 4.4 Token 不是授权

每个 button/select/modal 回调必须校验：

```text
回调返回的平台认证 user id == request.requester.senderId
```

否则：不改 pending 值、不 resolve、可选地回一个私有"不是你的请求"、保留原请求。
**v1 不允许 owner/admin 覆盖。**

### 4.5 不要动的东西

- 不改 Relay / ConversationRun / Bot / acpx core
- 不改 permission interaction 路径（M1 证明了共享 registry 不改 permission 语义）
- 不 import `src/interactions/*` 私有模块，只消费 `xacpx/plugin-api` 类型
- 不声明 URL mode（M1 R17 已把插件侧 mode union 收窄成 `"form"`）

## 5. 回归测试纪律（M1 的血泪规则）

写完每个回归后，**必须 mutation 验证**：把修复代码改坏，确认测试失败。
M1 R14 的教训：一个测试如果去掉修复后仍然通过，它就不是回归测试，只是装饰。

具体到这个 PR，至少这些 mutation 要做：

| Mutation | 应该死掉的测试 |
|---|---|
| 去掉 responderId 校验 | 鉴权测试 |
| 让答案进入 custom id | 隐私 sentinel 测试 |
| 去掉 review 步骤直接 accept | review 测试 |
| abort 时伪造 responderId 返回 cancel | abort 测试 |
| 允许超限表单渲染 | platform-limit 测试 |

## 6. 新增的 M2 特有判断（M1 没有对应物，需要你自己拿主意）

### 6.1 Discord 平台限制 gate

Discord 组件限制是 **renderer capability**，不是 schema normalization。
渲染前必须验证表单能被忠实表示，否则返回 cancel 并只记录有界元数据。
**绝不截断选项、绝不合并字段来强行通过。**

限制值以 Discord 当前 API 为准，需要你自己查证并在注释里写来源：
- 每消息 5 个 action row，每 row 5 个 button
- string select 25 个 option
- modal 5 个 text input
- 各种 label/value/message 长度上限

### 6.2 Wizard 而非一次性表单

Discord 组件限制让 one-shot generic form 不可靠。用确定性 wizard：一步一个字段，
最后**强制** review 页（这是 ACP MUST，不是可选UX）。

### 6.3 prefill 的处理

core 交来的 `defaultValue` 已经是 "core 自己会接受的预填值"（M1 R13/16/20 的
core-safe pre-fill policy）。Discord 可以用它作初始内容，**但不能替代用户回答**。

## 7. M2 definition of done

- Discord 真实声明 `["form"]`，不声明别的
- 所有支持的字段类型都能渲染；不能忠实表示的整体 cancel
- 仅限发起者鉴权
- review/edit 存在
- accept / decline / cancel 三者可区分
- abort/timeout 后控件失效
- 答案不进 custom id / 日志
- 真实或协议忠实的 E2E 证明同一个 ACP turn 继续
- 不依赖 #350
- 每个回归都 mutation 验证过

## 8. E2E 的做法

M1 已经建立了 mock ACP agent 技术，直接复用：

```text
tests/fixtures/mock-elicit-cancel-agent.mjs    ← 参考这个的形状
tests/unit/bridge/engine/runtime/runtime-elicitation-cancel-e2e.test.ts
```

它用一个真实的 mock agent 发 `elicitation/create` 并用 JSON-RPC
`$/cancel_request` 撤回。M2 的 E2E 应该是：mock agent 发 `elicitation/create` →
Discord handler 收到 → 模拟 interaction 回调 → 提交 → 断言同一个 ACP turn 继续，
decline/cancel 各跑一遍并断言没有产生第二个 prompt。

## 9. 交付物

一个聚焦的 PR：

```text
feat(discord): render ACP form elicitation
```

不改 Relay、不动 ConversationRun/Bot/Group 文档、不改 acpx core 语义。

## 10. 完成后

写 closure report（`docs/superpowers/closures/2026-09-2x-...-m2-closure.md`），
按 M1 closure 的结构：implemented / invariants / tests / review rounds /
mutation table / next-milestone readiness。

然后按 Roadmap，M4 Feishu 可以在 M1 之后独立安排；M3 要等 #350 合并后重新读它的
最终代码再动；M5 等 M2/M3 真实端到端闭环后再做。
