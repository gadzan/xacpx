# Bot / Group Beta 产品闭环开发方案

日期：2026-10-09。状态：待评审，尚未实施。跟踪 Issue：[#385](https://github.com/gadzan/xacpx/issues/385)。

## 1. 核查范围与结论

核查基线为远端 `main` 的 `34045768297f401aa42a62c1e38cc3e4cae67475`，以及核查时的工作分支 `codex/fix-bot-reply-line-breaks` 的 `e81c6691`。已通过远端引用确认 main 的提交；该核查分支新增回复原文保留修复，本文所涉及的 BotDialog、GroupComposer、BotService 等关键实现与该 main 一致。本次没有连接用户的 Beta 部署，也没有读取用户 Bot 配置。

上一份分析对“用户操作闭环没有完成”的判断成立，但不能直接作为实施规格。需要区分已复现的缺陷、尚未公开的后端能力、真正缺少的生命周期接口，以及有意延期的功能。

| 问题 | 核查结果 | 修正后的判断 |
| --- | --- | --- |
| 编辑 Bot 时系统指令为空 | 已在组件层复现缓存详情 + 侧栏摘要入口的回填缺陷 | 已确认的前端 Bug；该复现不涉及后端数据丢失 |
| Bot 模型只有文本输入 | 确认；新建 Session 的建议列表依赖已加载的同 Agent、同 workspace 会话 | 要同时补组件和能力发现；不能承诺每个适配器都有模型枚举能力 |
| Direct / Group Topic 只能新增 | Web 缺管理入口；Group 已有 archive / teardown；Direct 已有整段 Conversation teardown | Direct 的单 Topic 清理、重命名和恢复仍需后端实现，不能只接按钮 |
| 使用过的 Bot 无法删除 | 确认；已有 enabled 开关，但不会解决侧栏整理与删除 | 先复用停用 + 过滤；永久清理要处理 Group 历史引用，不能只清理 Direct |
| 没有 Slash / @ 自动补全 | 确认；Group 已有成员选择器和文本 @ 解析 | 补全基础设施可复用，寻址、命令能力与权限语义必须按场景保留 |
| 没有新建 Group 入口 | 确认；现有 create / update / delete RPC 可用 | 创建与管理 Web 界面可以立即接入 |
| 自动协作 | Router 引擎、协议、store 已有支持；GroupComposer 没有入口；src/main.ts 没有注入 Router | 生产能力接入也是缺口，不是只增加菜单项 |
| Bot 间私有通信 | 原始设计和运行时文档明确延期 private handoff | Group @ 是公开指派，Direct 是人与 Bot 单独对话；私有 Bot 间通信另立规格 |

### 1.1 已复现的指令回填缺陷

复现条件：

1. `control.bots.get` 已返回带非空 instructions 的详情，并写入 `direct-bots` store；创建 Bot 后缓存详情也可满足这一条件。
2. 从 InstanceTree 的编辑入口打开 BotDialog，传入的是不含 instructions 的 BotSummary。
3. BotDialog 的 instructions 从 props 初始化为空，而 detailHydrated 从缓存权威标记初始化为 true。
4. onMounted 跳过 hydrateDetail；syncHydratedFromStore 又因 detailHydrated=true 提前返回，导致缓存详情没有填入表单。

定位：[BotDialog](../../../packages/relay-web/src/components/BotDialog.vue)、[InstanceTree](../../../packages/relay-web/src/components/InstanceTree.vue)、[Direct store](../../../packages/relay-web/src/stores/direct-bots.ts)。

验证：临时组件测试通过真实 store 的 loadBotDetail 写入 `Always review security`，再用 Summary 打开编辑框；期望该指令，实际得到空字符串。同期运行 `direct-bot-components.test.ts` 的 38 项和 `group-components.test.ts` 的 42 项，80 项现有测试通过，新增复现用例失败。临时测试已移除，PR1 应将此场景加入正式回归集。

当前 dirty-only patch 通常能避免“只改名称”时把隐藏指令覆盖为空，不能据此断言已有数据丢失；用户触碰空白指令框后仍可能提交清空。用户部署若有其他问题，需要再按版本、bots.get 返回值和浏览器状态定位。

测试还发现 Group 的中英文提示含未转义的 `@name` / `@everyone`，触发 vue-i18n linked-message 编译错误。应同时修复并断言真实文案可见。

### 1.2 删除与协作的关键补充

- Direct 的 `teardownDirectConversation` 已实现拒绝新请求、取消 / 等待执行、严格释放 owned session、清理元数据和 SQLite 行；Control/Relay 没有公开 Direct 清理入口。
- Group 的 `control.groups.delete` 已调用完整的 `teardownGroupConversation`，不是直接删除 Group 元数据。
- `hasDurableBotWork` 检查所有 `member_turns.bot_id` 与 `messages.sender_bot_id`，包括已完成的 Group 历史；退出群组和清理私聊后仍可能无法删除。
- 移除 Group 成员不会立即释放其历史 member runtime；这些资源目前由 Topic teardown 释放。新 Bot 移除流程要补足按成员释放的能力。
- `src/main.ts` 已接入公开 `group_send` handoff；可以先完成显式指派与公开交接的可用流程。自动 Router 需要另外提供受限的生产实现。
- Slash 不只是前端补全：`composeBotTurnPrompt` 仅对已知 xacpx 命令跳过 profile 包装，适配器广告的其他命令仍可能被包进普通 prompt；Group 还存在公共上下文包装。必须验证端到端的命令透传。

证据入口：[运行时契约](../../conversation-runtime.md)、[原始设计 §17 / §19 / §24](../specs/2026-09-15-bots-group-conversations-design.md)、[分阶段计划](2026-09-15-bots-group-conversations-phased-implementation-plan.md)、[BotService](../../../src/bots/bot-service.ts)、[SQLite 依赖检查](../../../src/conversations/sqlite-conversation-store.ts)、[生产组合](../../../src/main.ts)。

## 2. 产品目标与范围

用户应当能只用 Relay Web 完成：配置 Bot → 复查 / 修改指令和模型 → 新建 Group → 新建 Topic → 明确选择执行成员 → 查看公开交接与执行结果 → 整理 Topic → 停用或移除不用的 Bot。

本轮交付分三个里程碑：

- A：修复指令显示，新建 / 管理 Group，可从日常列表收起停用 Bot，完成第一条公开群组任务。优先修复用户现在遇到的阻断。
- B：完整 Topic 生命周期、使用过的 Bot 移除、模型能力发现、Slash / @ 补全以及故障恢复。通过后才能宣称 Bot / Group 基础体验闭环完成。
- C：接入真实受限 Router，提供可配置、可诊断的自动协作。单独验收，不因引擎测试通过便宣称部署已经可用。

自动协作属于原设计的可选能力；它不阻塞显式协作的修复发布。私有 Bot 间消息另立规格，本轮不承诺保密通信。

优先级以“哪些问题阻断本轮 Beta 验收”组织，不将所有缺失功能笼统定为事故级 P0。

## 3. 交互与语义决策

| 操作 | 面向用户的行为 |
| --- | --- |
| 与 Bot 单独对话 | 打开该 Bot 的 Direct 页面；保留其独立 Topic / 历史，不把 Group transcript 自动复制过去 |
| Group @成员 | 修改可见的结构化执行目标，消息和交接仍在群组公共记录中 |
| Everyone | 向当前可执行成员指派本次请求；不保证所有成员物理并行执行 |
| 公开交接 | 展示谁交给谁、任务、结果与失败原因；使用既有 group_send 和 Run 生命周期 |
| 停用并收起 Bot | 使用 enabled=false，默认从日常 Bot 列表过滤；“已停用”列表可查看并重新启用 |
| 收起 Topic | 保留历史并阻止新任务；仅已结束的 Topic 可操作，界面提供恢复入口 |
| 删除 Topic | 确认后取消 / 清理该 Topic 的执行和资源，并删除其历史；失败可恢复清理 |
| 移除 Bot | 清理可执行身份和私聊资源，群组历史保留稳定身份和当时的显示快照；界面明确说明保留范围 |

停用不是停止：界面说明在途任务和待处理任务的影响，并提供独立 Stop。重新启用可能唤醒已有待处理工作，必须可见。Group 成员配置保留停用成员及状态，不因列表过滤而悄悄改组。

沿用 CONTEXT.md 的普通 Session “睡眠 / 唤醒”术语。Topic 的收起只改变 Topic 可用状态，不声称关闭物理进程，不与 Session 睡眠共用文案。

## 4. 分 PR 实施

### PR1 — 修复指令回填与协作提示

目标：消除已复现问题，优先独立发布。

- 打开表单时先从同 instanceId / botId 的权威详情初始化；“详情已缓存”和“当前表单已回填”分别处理。
- 无缓存时立即加载详情；实例选项与详情加载独立进行，避免前者阻塞后者。
- 未取得详情时为指令显示明确加载状态，避免呈现为可修改的真实空值；错误提供重试。
- 保留 dirty-only patch、实例 / Bot 切换隔离、迟到响应防护；明确空值按权威详情清空，不能使用 truthy 判断代替字段语义。
- 转义 Group 中英文 @ 文案，并验证真实渲染结果。

验证：缓存非空详情 + Summary；无缓存；完整 Detail；权威空指令；远端修订变化；慢请求；失败重试；改名不清空指令；用户主动清空可持久化。无需扩大为表单架构重写。

### PR2 — Group 创建、编辑、删除与首次使用

涉及 InstanceTree、GroupPane、新增 GroupDialog、groups store、i18n。

- 实例“群组”标签提供“新建群组”，空列表显示同一入口；不足两个 Bot 时给出创建 Bot 的可操作引导。
- 表单含名称、说明、至少两个不同 Bot、可选 Lead；UI 默认建议一个启用成员作为 Lead，后端仍保留 Lead 可选契约。
- 成员展示角色 / Agent / 启用状态，同名 Bot 用稳定 ID 区分；移除 Lead 要同步改选或明确清空。
- 接入现有 groups.create / update / delete，提交成功才更新列表和选中状态；新建成功自动选中并引导创建 Topic。
- 编辑成员遇到 group_member_has_work 时定位对应 Run，允许用户停止后重试；成员数量不能降到两个以下。
- 删除确认展示 Topic、历史与 worktree 后果；复用现有严格 teardown。RPC 超时先重新查询，不把超时显示为删除成功。
- 后续 PR4 的生命周期操作记录扩展到 Group 删除，支持刷新后的清理状态和重试。

验证：纯 UI 从空列表创建两个 Bot → 创建 Group → 创建 Topic → 发给 Lead → 改为两名成员 → 查看各自结果；验证成员更新、错误恢复、删除失败、跨页面事件同步及移动端入口。

### PR3 — Direct / Group Topic 管理

涉及 ConversationRunService、ConversationStore、Control、public-control、plugin-api、relay-protocol 校验、channel-relay、Direct / Group store 和页面。

- 用共同 Topic 管理组件提供可搜索列表、重命名、收起、恢复、删除；桌面可用下拉 / 侧面板，移动端用列表面板，避免大量横向 pills。
- 增量增加通用 `control.topics.update`（本轮只允许 title）、`control.topics.archive`、`control.topics.restore`、`control.topics.teardown`。已有 Group archive / teardown RPC 保留兼容，委托同一生命周期实现。
- Direct 单 Topic teardown 只能清理指定 conversationId × topicId × botId，复用整段 teardown 的严格 ownership / release 规则；禁止通过整段 Direct Conversation teardown 实现单 Topic 删除。
- 收起只允许没有 unsettled Run 的 Topic；恢复只允许 archived → active，不能解除 deleting 或 indeterminate。
- 默认 Direct Topic 是虚拟 / 可物化的特殊对象：第一版保留该入口；“清空默认话题”需要显式确认并安全重置上下文，不能删除元数据后让旧 binding 被意外复用。普通额外 Topic 才显示删除。
- 默认 Topic 清空要定义新的上下文 generation，并拒绝旧 generation 的新请求和迟到操作；删除 / 清空的幂等回执独立于被删除的历史保存，避免旧 requestId 被重新执行。
- 元数据更新发 topic-changed；物理删除使用现有粗粒度 refetch 或新增明确 tombstone，两个 store 均清除失效选中项和缓存，迟到响应不得复活删除项。
- 明确关联 external bindings、运行中任务和 worktree：预览并阻止静默解绑、丢失未合并改动或跨 Topic 清理。

验证：重命名保持历史和稳定 ID；收起 / 恢复不重建上下文；多个 Topic 互不影响；默认 Topic 清空；删除与发送 / materialize 竞态；外部绑定；物理释放失败；重启后重试；脏 / 未合并 worktree 阻断及恢复。

### PR4 — Bot 停用整理与受控移除

4a 可先于 PR3 发布：复用 enabled 开关，增加侧栏“已停用”过滤 / 计数 / 恢复入口，以及 Group 中停用成员与失效 Lead 的说明。保留现有后端权限和调度语义。

4b 在 PR3 后实施：

- 增加删除影响预览：Direct Topics、活动 / 待处理 / indeterminate Runs、现有 Group 成员关系、离组后的 member runtime、worktree、external bindings、历史引用。
- 增加显式受控移除接口，保留既有 bots.delete 的“只删无依赖 Bot”语义，兼容旧客户端。
- 先持久化 deleting / removal 状态，并在 accept、createTopic、成员加入、enable、runtime materialize 等入口检查。不能把“调用 Direct teardown，再调用 deleteBot”当成完整原子流程，中间不能允许新工作重新建出资源。
- SQLite 屏障继续作为 accept / dispatch 的权威来源，AppState 保存可恢复元数据；显式处理两个持久化介质之间的崩溃窗口，不假设存在跨文件原子事务。
- 活跃 Group 引用要求用户逐组处理；两人成员组不能直接移出一人。不得自动删除整个 Group 或其他成员历史。
- 为已退出 Group 的 Bot 增加严格、按成员作用域释放资源的实现；保留当时 Group transcript / Run，不调用整个 Group / Topic teardown 作为移除捷径。
- 区分执行依赖和不可变历史证据：移除可执行 Bot 后保留最小 retired identity / tombstone 与历史快照，渲染“已移除 Bot”。原 hasDurableBotWork 的 fail-closed 规则不直接放宽；新增受控路径只有在执行、ownership、dispatch、权限交互等活依赖全部清理后才能提交退休。
- 清理 Direct 历史是明确的破坏性选项；Group 历史保留。此操作不标为“擦除所有历史”。跨 Group 的历史擦除如需支持，另立有完整影响范围的功能。
- 较长清理保存操作 ID、阶段、错误及结果，刷新 / 重启后可查询和重试；不确定的执行保留屏障，不能伪装为已完成。

新增生命周期 RPC 草案：bots.remove.preview、bots.remove、lifecycle.operations.get；执行携带稳定 requestId 和预览修订，后端在提交前重新检查依赖。Topic / Group 的长期清理复用操作记录，不引入另一套任务执行引擎。

验证：未用 Bot、只创建 Topic 的 Bot、已私聊 Bot、在组 Bot、已离组但有 Group 历史的 Bot；清理与新请求 / 成员变更竞态；取消失败；进程释放失败；重启续清理；重复请求；保留其他 Bot / Group 的历史、运行时和文件。

### PR5 — 统一模型 / effort 选择与能力发现

先实现服务端能力来源，再统一 BotDialog 和 NewSessionDialog 的 ModelPicker；已有 Session composer 可复用展示组件，但其即时切换行为仍独立。

能力结果需区分 loading、ready、unsupported、needs-setup、error，而非把失败折叠成空数组。建议 DTO 包含 modelId / 显示名 / 来源 / 获取时间 / 当前值 / 默认选择语义 / effort 候选；modelId 原样传递，不拆解供应商格式。

发现顺序：

1. 当前目标的真实 owned runtime 广告，通过产品 ID 的受控接口读取。
2. 相同有效 adapter / 启动配置 / workspace / 认证上下文的有效能力缓存。
3. 同上下文的既有普通 Session 广告；由后端查完整可用范围，不只用浏览器已加载的侧栏行。
4. 没有数据时提供“获取模型列表”：通过 transport 的受控 probe 获得适配器能力，不发用户任务，不创建可见 Bot Topic；探测资源具有 ownership、超时、singleflight 与严格清理。
5. 适配器不能枚举或缺认证时明确说明；保留默认选项和高级自定义 ID。可选的用户配置候选标为建议，不伪称适配器验证结果。

不得维护前端硬编码的“Claude / Codex 完整模型列表”；不能只复用旧的 listModelSuggestions，否则全新 Agent 仍只有 default。adapter 变更需使缓存失效，秘密和内部命令不投影到 Web。

冷发现可能需要扩展 transport / acpx 的检查能力；PR 开始先验证所用 acpx 和 adapter 的实际契约。若没有安全的探测入口，明确返回 unsupported 并保留恢复引导，不在 Web 或 Control 中绕过 transport 启动临时 acpx。

模型选择与实际生效分开显示。Bot 的 model / effort 修改作用于之后接受的 Run；已接受 Run 按已有 profile snapshot 执行。无效显式模型不得静默显示已生效；沿用 Session 的默认回退时需要展示实际结果。effort 随模型刷新，无法获取时保留当前合法配置。

建议新增 `control.agents.capabilities.get`，上下文参数限定为已配置 Agent / workspace 与允许的产品资源 ID；返回不暴露 hidden alias 的安全 DTO。枚举广告不等于服务端授予模型调用权限，执行时仍以适配器结果为准。

验证矩阵：OMP、Claude、Codex、OpenCode、Cursor 的实际部署版本；有 / 无已有 Session；不同 workspace；不同 adapter pin / 自定义命令；未认证；离线；能力不支持；旧响应；模型切换后的 effort；默认与自定义 ID。记录每种适配器实际支持情况，不要求不具备枚举能力的 adapter 返回虚构列表。

### PR6 — Slash / @ 补全与可理解的公开协作

- 从 PromptInput 提取候选菜单、光标替换、键盘操作和中文输入法处理等基础能力；Direct / Group 保留各自发送、取消、幂等、断线恢复和权限来源逻辑。
- 为 Conversation 增加按 conversationId / topicId / botId 查询、缓存和重连恢复的 Slash 能力；现有 agent-commands 事件已带 Conversation correlation，但普通 chat store 和 Hub 的普通 Session 命令缓存会跳过它。
- Direct Slash 使用当前 Bot 运行时广告的命令；验证 profile 包装前后命令是否仍被 adapter 按原样解释。不把 xacpx 管理命令目录冒充 adapter Slash 列表。
- Group Slash 第一版仅允许明确选择一个成员；多成员或自动协作模式给出“先选择一个成员”的操作引导，避免向不同 adapter 广播破坏性命令。
- 用显式命令类型或受验证的命令路径保留原文执行；仍经 Conversation 的 Run / ownership / permission 边界，禁止让浏览器用 hidden alias 调普通 Session API。
- Group @ 菜单展示成员角色与状态，选择后绑定 Bot ID 并同步可见 target；支持中文、带空格名称和同名消歧。手工无法解析的 @ 显示反馈，不静默沿用错误目标；编辑 / 撤销同步更新结构化选择。
- Direct 页面提供“与其他 Bot 单独对话 / 去群组协作”的导航入口，不把 Direct @ 默认为 Agent Messaging 或私有 handoff。
- 展示 group_send 的公开交接关系、任务和结果，给出简短可操作引导；Everyone 显示实际执行成员，shared-single-writer 明确写入任务会排队。
- 发送 definitive rejection 保留草稿，uncertain 复用冻结 requestId / 目标；统一补全后不能破坏现有恢复语义。

验证：菜单 Enter / Tab 不误发送；Escape、选择范围、中文 IME；同名 / 停用 / 已移除成员；成员切换后 Slash 刷新；Direct / Group 命令实际到达适配器；请求拒绝 / 超时；断线重连后恢复广告；历史和权限不跨 Topic。

### PR7 — 自动协作生产接入（独立里程碑 C）

- 提供工具、文件系统、终端、权限交互、Messaging / Orchestration 均禁用且输出受限的 Router 实现；初始化前证明能力限制，不能只靠 prompt 写“不要用工具”。
- 增加服务端配置、安装 / 认证检查、诊断与能力广告，并在 src/main.ts 的生产组合中注入；默认不开启，复用已有 RouterEngine 的预算、期限、取消和恢复。
- GroupComposer 依据实例真实能力显示“自动协作”；不支持时显示原因与配置路径，不允许选择后直到发送才发现 automatic_unsupported。
- 显示 assignment、依赖、预算、waitingQuestion 与 blockedReason。waiting-human 依照现有无 same-Run resume 的边界操作，不能凭 UI 修改为 running。
- “由我启动这一步”若纳入本 PR，必须新增显式 human-origin 请求，服务端验证原 blocked evidence 和重复提交；不得把原模型交接提权为人工授权。否则明确显示当前可用的停止、查看任务和手工新请求流程。

验证：生产配置入口而非仅测试注入；受限能力不成立时拒绝；Router 不可用 / 超时；取消；重启；预算耗尽；等待人工；新人工请求的来源；模型选择下游任务不继承人工权限。

### PR8 — 跨版本、端到端验收与发布

验收脚本随每个 PR 增量补齐，本 PR 汇总完整路径，不将验证全部推迟到最后。

- 扩展现有 Playwright mock-hub 覆盖 Bot / Group / Topic 生命周期，跑桌面和移动端；这验证操作路径，不能代替真实后端和 adapter 验收。
- 增加真实 Control → Relay → Web 的测试部署验收，使用临时 xacpx home / SQLite / workspace，不依赖真实微信，也不触碰用户已有 Bot。
- 首次用户路径：零数据 → 两个 Bot → 填写指令 / 选择模型 → 关闭重开编辑确认 → 建组 → 新 Topic → Lead / 多成员指派 → 公开交接与结果 → 刷新 / 重连 → 重命名 / 收起 / 恢复 / 删除 Topic → 停用 / 恢复 / 移除 Bot。
- 自动协作另有真实受限 Router 的验收路径，未通过时不在发布说明中宣称可用。
- 失败路径：离线、超时后重试、旧响应、跨客户端修改、取消不确定、物理释放失败、未合并 worktree、外部绑定与旧版 connector。
- 新能力缺失时 UI 通过协议能力广告降级；旧 backend 的 unknown method 不能变成空白表单、空列表或假成功。
- 新状态字段 / SQLite 表使用增量迁移；在副本上验证升级、重启和历史读取。新增删除屏障 / tombstone 后，明确旧版是否可安全写入，未验证前不承诺直接降级。
- Relay Web 打包进 relay 发布；联合验证 core、relay-protocol、channel-relay、relay 的兼容组合、实际部署版本与 PWA 更新，避免只升级 Web 便调用旧实例未支持的 RPC。

## 5. 依赖与验收门槛

依赖：PR1 可直接发布；PR2 与 PR4a 构成里程碑 A；PR3 → PR4b；PR5 → PR6 的通用能力来源；PR2 + 能力广告 → PR7。PR8 的验收随各 PR 实施，最后汇总。

涉及后端的 PR 必须完整走过：领域服务 → Control DTO / 公共接口 → Relay protocol 类型与 parse 校验 → channel-relay bridge → Web store / 事件 → 用户操作。不得以某一层测试通过代替整条链路完成。

标准检查：

```text
npx tsc --noEmit
npm test
bun run test:web
bun run build:relay-web
bun run build:channel-relay
bun run build:relay
```

按 PR 变更范围选择相应检查；全量发布前执行联合构建和完整 Web / 单元测试。Playwright 使用 packages/relay-web 中现有 test:e2e:desktop / test:e2e:mobile。没有真实 acpx + 微信环境不跑 tests/smoke，不能把未运行的真实验收算作通过。

计划完成条件：以上纯 Web 首次使用和管理路径均能完成，清理失败可见且可恢复；适配器能力不足有明确原因和操作引导；普通 Sessions 不泄露 product-owned session；其他 Group / Topic 的历史、权限和文件不受错误清理影响。

## 6. 文档与后续工作

每个实施 PR 更新对应的 docs/conversation-runtime.md、docs/control-module.md、docs/relay-module.md、docs/relay-web-module.md；模型 / Router 配置更新 docs/config-reference.md。修订原路线图对已实现引擎、已公开 API、可用 Web 流程的完成定义。

正式开发由 GitHub 父 Issue 记录里程碑和总验收，按以上纵向切片建立子 Issue；沿用 docs/agents/issue-tracker.md 和 triage-labels.md 的规则。

本次交付仅包含源码核查、组件复现实验和开发方案；没有修改产品实现、现有用户数据或发布版本。
