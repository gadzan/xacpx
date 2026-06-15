# HAPI 竞品分析 & relay-web 借鉴改进 Spec

> 日期: 2026-06-15 · 分支: `feat/relay-web-hapi-borrow-ux`
> 竞品源码: `/Users/maijiazhen/projects/hapi`（HAPI v0.20.2，Bun monorepo: cli/ hub/ web/ shared/）

## 1. 竞品定位

HAPI 与 xacpx 强同域：本地包裹 AI coding agent（Claude Code / Codex / Gemini / Cursor / OpenCode）→ hub（Socket.IO + SSE + SQLite + Telegram bot + E2E relay）→ React PWA 远程控制。核心卖点：**Seamless Handoff / Native First / AFK Without Stopping**。

与 xacpx 的根本差异：HAPI 包裹**本地交互式终端** agent，可在终端 ↔ web 之间无损切换同一会话；xacpx 不包裹本地 TTY，而是经 chat channel（微信/飞书/元宝）→ relay → acpx 会话驱动。因此 HAPI 一整类"本地↔远程切换"机制（双 launcher、双击空格夺回、JSONL transcript file-tail）**不适用** xacpx —— 概念（稳定 session-id 作为句柄、多前端 attach）可借，机制不可移植。

## 2. 可借鉴清单（5 份 subagent 内参综合）

| # | 借鉴点 | 价值 | 可行性 | 可在 sandbox 预览 | 裁决 |
|---|--------|------|--------|------------------|------|
| A | **会话列表语义化注意力指示**（HAPI `sessionAttention.ts`：permission>input>background>unread 优先级点） | 高（"哪个会话需要我"） | 高（纯 Pinia 分类器，数据已存在于 chat store `liveTurns`） | ✅ | **做** |
| B | **工具调用分组/摘要 anti-spam**（HAPI `toolGroups.ts`：连续例行工具折叠成带计数摘要） | 高（多工具回合密度） | 高（增强现有 `ToolCallPanel`） | ✅ | **做** |
| C | **Reasoning 流式自动展开 + shimmer 点，完成收起**（HAPI `reasoning.tsx`） | 中（打磨） | 高（增强 `ReasoningPanel`） | ✅ | **做** |
| D | **FUE 首次体验原语**（HAPI `use-fue.ts` + `Fue.tsx`，其 AGENTS.md 头号推荐，近乎逐字可移植到 Vue `<Teleport>`） | 中（特性发现） | 高（小、纯前端） | ✅ | **做**（精简版，挂到 B 的摘要头作为载体） |
| E | per-tool 渲染注册表 + inline diff | 中 | relay-web `ToolDetail.vue` 已具 diff/read/command/search/text/fields | 部分已有 | 暂缓 |
| F | context-budget 计量条 + 阈值变色 | 中 | **不可行**：控制事件流无 token 用量数据 | ✗ | 不做 |
| G | 远程权限审批（allow/deny） | 高 | 需 acpx escalation；已有独立未启动 plan（`2026-06-12-chat-permission-approval-v1.md`）；chat-only 无 web UI；大 | 弱 | 本批次不做（见 §5） |
| H | web 终端 / 文件浏览器 | 高 | 大型：需 connector PTY/fs RPC + 安全模型（realpath 容器化） | ✗（多 session） | 不做 |
| I | PWA + visibility-gated web push | 中 | 需 SW + VAPID 基建 | 部分 | 不做（本批次） |
| J | voice assistant | 低-中 | 大型、React-SDK 强耦合 | ✗ | 不做 |
| K | hub 后端加固（time-based stale-keepalive 拒绝、localId 幂等插入、versioned helper） | 中 | 可行但**不可预览**、价值低可见性 | 后端 | 本批次不做 |

**本批次只做 A/B/C/D**：四者构成一个内聚主题——"更密、更聪明、更易读的 relay-web 仪表盘"，全部纯 Vue/Pinia/Tailwind，**零** acpx/协议/connector 改动，可 `build` + 重启 hub 立即预览，每项可 vitest 单测。其余项要么超范围/不可预览/不可行，记录在案供后续。

## 3. 现状基线（xacpx，已核对源码）

- `stores/chat.ts`：`liveTurns: Record<"<instanceId>\0<alias>", LiveTurn>` 已**全局**跟踪所有会话的活跃回合（`ensureTurn` 对任意 turn-started 建条目，turn-finished `flushTurn` 清除）。`flushTurn` 仅在 `selected` 时把内容落成消息。→ **A 的数据已就绪**。
- `components/ToolCallPanel.vue`：单一可折叠面板，`open=true` 默认全展开列所有行，头部仅 `🔧 Tool calls (N)`。→ **B 增强此处**。
- `components/ReasoningPanel.vue`：`defaultOpen` prop（live=true / 历史=false），无流式态/shimmer。→ **C 增强此处**。
- `components/InstanceTree.vue`：会话行 `s.running` 时显示静态 `●`（amber）。`SessionDto = {alias,agent,workspace,transportSession,running}`，**无 unread 字段**。→ **A 用 chat store 的实时态替代/增强**。
- 无 FUE 原语。

## 4. 详细设计

### Feature A — 会话注意力指示
**数据**：扩展 `chat` store（它已消费全局事件流）：
- 新增 `unread: ref<Set<string>>`（key = `<instanceId>\0<alias>`）。
- `applyEvent` 的 `turn-finished` 分支：若该 key **非当前选中**且 `status ∈ {done,error}`，`unread.add(key)`。
- `select(id,alias)`：清除新选中 key 的 unread。
- 暴露 `sessionAttention(instanceId, alias): "working" | "unread" | "idle"`：
  - `working`：`liveTurns` 含该 key（实时，比 `SessionDto.running` 更即时）。
  - `unread`：`unread` 含该 key。
  - 否则 `idle`。
- 暴露 `instanceHasAttention(instanceId): boolean`（任一子会话 working/unread）→ 折叠的实例头也能显示卷起指示。

**渲染**：`InstanceTree.vue` 会话行点：`working` → amber `●` + `animate-pulse`；`unread` → sky-blue `●`（静态）；`idle` → 无点（或保留 `running` 兜底）。`offline`（`!inst.online`）实例头点维持灰色。`data-test="attention-dot"` + `data-attention` 属性供测试。

### Feature B — 工具分组摘要 + 自动折叠
增强 `ToolCallPanel.vue`：
- 头部追加**按 kind/status 的计数摘要**：例如 `📖3 💻2 ✏️1 · ✅5 ⏳1`（仅显示计数 >0 的项）。纯函数 `summarizeSteps(steps): {kind, status}` 计数，可单测。
- **自动折叠**：`steps.length > THRESHOLD(=5)` 时 `open` 初始为 `false`（默认折叠，避免长墙），≤5 维持展开。用户可点开。
- 展开后逐行不变（保留现有 per-step 行 + ToolDetail）。
- 头部摘要旁挂 Feature D 的 FUE 点（首次提示"工具步骤已折叠，点击展开"）。

### Feature C — Reasoning 流式 shimmer + 自动展开
增强 `ReasoningPanel.vue`：
- 新增 `streaming?: boolean` prop。`MessageList.vue` 对 **live** reasoning 传 `:streaming="true"`，历史传 `false`。
- `streaming` 时：标签显示 `Reasoning…` + 一个脉冲 shimmer 点（`animate-pulse` 小圆点），且强制 `open`（忽略用户折叠，直到流结束）。
- 非 streaming：维持 `defaultOpen` 行为（历史默认折叠）。

### Feature D — FUE 原语（精简 Vue 移植）
- `lib/use-fue.ts`：`useFue(featureId)` → `{ status, engage, dismiss }`，三态 `unseen → engaging → acknowledged`，localStorage `xacpx.fue.v1.<featureId>`，try/catch 容错（隐私模式），**无自动超时**（仅显式 "Got it"）。纯逻辑，可单测。
- `lib/fue-placement.ts`：`computeCalloutPlacement(anchorRect, calloutSize, viewport)` 纯函数——上下翻转 + 水平 clamp，可单测。
- `components/FueDot.vue`：8px 绝对定位圆点，`unseen` 时 `animate-pulse`。
- `components/FueCallout.vue`：`<Teleport to="body">` 弹出框（标题 + 正文 + "Got it"），用 placement 函数定位，Esc/点击 "Got it" 关闭。
- 互斥规则：FUE 点与任何特性计数徽标互斥（onboarding 信号优先），载体处遵守。

## 5. 明确不做 & 后续（记录）

- **权限审批（G）**：已有 `docs/superpowers/plans/2026-06-12-chat-permission-approval-v1.md`（未启动，chat-text only）。HAPI 模型（synced `requests` map + parked promise + RPC 解锁 + AFK visibility gate + 富答案 allow-once/for-session/mode-on-approve）价值高但需 acpx escalation 能力 + 跨 connector/协议/web 多层改动，属独立中型项目，不在"可预览小批次"内。后续若做，relay-web 侧可移植 HAPI `PermissionFooter` 按钮集 + danger tone。
- **后端加固（K）**：time-based stale-keepalive 拒绝、localId 幂等插入、`updateVersionedField` 通用乐观并发 helper——价值真实但不可预览，建议独立 PR 配后端单测。
- **doctor 增项**：HAPI doctor 反而缺 acpx 解析/版本检查（xacpx 已有）；无新增可借。
- **terminal/files（H）**：契合 relay 拓扑但需 connector 侧 PTY/fs + realpath 容器化安全模型（HAPI 自身实现 fail-open 且可绕过，**不可照抄**）。大型独立项目。

## 5b. Pass 2 — 交互设计扩展（第一轮过于保守，补做）

第一轮只取了 4 项偏"展示"的借鉴；经第二份**穷尽式交互设计内参**（hapi web 的 composer/thread/optimistic/transient/navigation/micro-interaction/density/markdown 九大 surface 全量枚举）复盘，补做以下**纯前端、可预览**的交互设计借鉴：

| 借鉴点 | hapi 出处 | 落地 |
|---|---|---|
| **Composer slash 自动补全 popover** + 键位优先级阶梯 | `HappyComposer.tsx:405-498` 1.1/1.2（被内参称为"用户觉得欠缺的中心项"） | `lib/command-catalog.ts`（curated 静态目录，后续可 RPC 驱动）+ `PromptInput.vue`：`/`前缀建议、↑↓选择、Tab/Enter 补全、点击补全 |
| **Esc 优先级**（先关 popover，再停 turn） | 1.2 #5/#6 | Esc：有 popover→先关；否则 busy→cancel |
| **IME 合成保护**（CJK 关键修正） | 1.2 #1 | `e.isComposing` 时不拦截——中文回车确认候选不误发 |
| **Send/Stop 按钮形变** + busy 时仍可输入 | 1.4 / 1.5 | 显式 Send；busy→Stop（emit cancel）；textarea busy 时不禁用（可预编排 + Esc 停） |
| **↑/↓ 历史回溯**（shell 式） | 1.2 | 光标在行首时 ↑ 召回上一条已发送 |
| **每会话草稿持久化** | 1.9 | `lib/composer-drafts.ts`（sessionStorage，按 instance+session key），切会话/刷新保留半成稿 |
| **粘到底部 + "↓ Latest" 浮标** | 2.1 / auto-scroll | `MessageList.vue`：在底部才跟随；滚上去出现跳转浮标 |
| **复制按钮**（消息 hover + execCommand 兜底） | 6.4 | `CopyButton.vue`，agent 消息悬浮显示 |
| **Diff +N/−N 统计徽标** | 8.8 | `ToolDetail.vue` diff 头部统计 |
| **循环"工作中"近义词**（vibing words） | 2a | `ChatPane.vue`（与未合并 PR #34 同源，本批次内联以保预览完整） |

**仍 deferred（带 effort/原因，源自穷尽内参；多数需后端/协议或属大型独立项）**：
- 需后端/协议：optimistic 消息生命周期（queued bar / 状态徽标 / 取消·编辑·重试，需 localId 回显 + `messages-consumed`/`message-cancelled` SSE，surface 3）、附件粘贴上传（1.6）、通知点击 deep-link `data.url`（5.4）、schedule-send UI（1.11，xacpx 有 /later 后端）。
- 大型纯前端独立项：暗色主题 + 通用 `usePersistedPref` 偏好体系（7.\*，M/L 跨切面）、Shiki 语法高亮 + CodeBlock 折叠（8.1/8.2）、tap-to-expand-dialog 详情弹层（6.1）、会话大纲跳转 + 滚动锚点保持（2.2/2.4）、长按上下文菜单（6.5）、图片查看器（6.7）。
- 小项后续：transient 三横幅（offline/syncing/reconnecting，4.1）+ syncing 状态机（4.2）、骨架屏（2.3）、空状态双 CTA（4.4）、live per-tool elapsed timer（6.2）、TodoWrite/plan checklist（8.9，依赖数据）、settings popover（1.7，依赖 model/effort 是否暴露）、haptics（1.10）、Shift+Tab 权限模式循环（1.3，依赖权限模式 UI）。
- 两个"移植时要修正、别照抄"：空状态要 gate 在 `!isLoading`（hapi 加载中也显示空态）；SW 通知点击加 `clients.matchAll`+focus 防重复开标签。

完整九大 surface 穷尽枚举见本次第二份 subagent 内参（含每项 file:line / 概念vs字面移植 / effort / 是否需后端）。

## 5c. Pass 3 — 工作空间文件浏览器 + git diff（用户点名要做，原 defer 项 H）

借鉴 hapi 的"远程查看实例机器上工作空间文件 + 内容 + git diff"。契合 relay 拓扑：connector 跑在用户机器上，本就能访问 workspace 磁盘。**全栈**实现（core → connector → protocol → relay-web），hub 无需改动（`control.fs.*` 走既有 `control.` 前缀白名单，且非 chat-scoped）。

**安全模型（关键，刻意与 hapi 的 fail-open 相反）**：`src/control/workspace-fs.ts`
- **默认拒绝**：只接受已配置的 workspace 名，绝不接受任意绝对路径（`path-must-be-relative`）。
- **realpath 容器化**：目标经 symlink 解析后必须仍在 symlink-解析后的 workspace root 内，`..` 和 symlink 都逃不出去（`path-escapes-workspace`）。已端到端验证：`../../../etc/passwd` 与 symlink 逃逸均被拒。
- **只读**：无写方法；git 走 `execFile`(参数数组、绝不 shell)跑只读子命令，路径无法注入命令。
- **有界**：目录条目 2000、文件 256 KiB、diff 512 KiB 上限；NUL 字节判定 binary 且不回传内容。
- `~` 展开（配置常用 `~`/`~/path`）。

**分层**：
- protocol：`MSG.fs{List,Read,Diff}` = `control.fs.{list,read,diff}` + `Fs{List,Read,Diff}Payload/Result` + `FsEntryDto`/`FsDiffFileDto`。
- core：`WorkspaceFs`（上述安全逻辑）+ `ControlService.{listDirectory,readWorkspaceFile,workspaceGitDiff}`，经 `xacpx/plugin-api` 暴露给 connector。
- connector：`control-bridge.ts` 三个 case 转发。
- relay-web：`stores/files.ts` + `FilesPanel.vue`（workspace 下拉 + 懒加载目录树 + 面包屑 + 文件查看器[truncated/binary 徽标] + Changes 标签的 git status 文件列表 + 着色 unified diff）；右栏 Tasks|Files 切换；`instances.loadWorkspaces`。

**测试**：`tests/unit/control/workspace-fs.test.ts`（容器化/逃逸/symlink/binary/git diff/~，10 例，真实临时目录 + git）；`packages/relay-web/src/__tests__/files.test.ts`（store 逻辑 + 错误 payload，4 例）。端到端经真实 relay 验证（list/read/diff/home-~/两类安全拒绝）。

**v1 已知边界（后续可加）**：无文件搜索（`rg --files`）、无 staged/unstaged 分离视图、diff 仅 `git diff HEAD`（fallback `git diff`）、无文件写、无 syntax 高亮（复用纯文本 + diff 着色）。

## 6. 验收

- `bun run --cwd packages/relay-web test` 全绿（新增各 feature 的 vitest）。
- `bun run --cwd packages/relay-web build`（含 `vue-tsc --noEmit`）通过。
- sandbox 重建后：仪表盘会话列表出现实时 working/unread 点；多工具回合工具面板折叠并显示计数摘要；live reasoning 流式 shimmer；首次见到折叠工具面板有 FUE 引导点。
