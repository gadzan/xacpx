# relay-web 借鉴 "Z" 桌面客户端 —— 分析与设计

> 来源：一张 "Z" 桌面编码 agent 客户端截图（GLM-5.2 模型选择器、Git 工具面板、工作区→任务树、composer 内联选择器）。本文是借鉴分析 + 设计决策，配套实现计划见 [`../plans/2026-06-15-relay-web-z-client-borrow.md`](../plans/2026-06-15-relay-web-z-client-borrow.md)。
>
> 这批工作延续既有的 [hapi-borrow](./2026-06-15-hapi-borrow-analysis-and-spec.md) 看板改进，目标仍是 `packages/relay-web`。
>
> 注意：交互细节部分由静态截图推断；落地时以实际行为为准。

## 1. 动机

relay-web 当前 composer 只有 textarea + Send/Stop + 斜杠命令补全（`PromptInput.vue`），看板顶部没有上下文带，没有全局搜索。"Z" 客户端在"上下文可见性"和"输入区控制密度"上做得更好，且其 composer 的**模型 / 权限 / 强度三选择器**正好与刚在 core 落地的 model-selection 特性（`feat/session-model-selection` 分支）闭环。

## 2. 源界面元素清单（四区）

1. **顶部上下文带**：任务标题 + chip 串 `仓库@主机 · 分支 · …溢出`；右侧面板开关/窗口控制。每个 chip 既显示状态又是入口。
2. **左侧栏**：固定动作（新建/搜索 Ctrl+K/技能）+ `工作区` 分组（过滤/搜索/归档）+ 两级树（工作区→任务，活动任务高亮 + 耗时徽标 `1分` + 空态 `暂无任务`）+ 底部账户/设置。
3. **中部对话流**：用户气泡右对齐；`已工作 59 秒 ⌄` 工作计时折叠；`思考过程 持续了几秒 ⌄` 带时长的 reasoning 折叠；工具聚合 `已探索 2 文件 ⌄`；`⚠️ 暂停一下` 警告 callout + 风险列表；右下浮动回到底部。
4. **右侧 Git 工具面板**：`更改 +3 -3` · `分支` · `提交 …`，面板可全屏。
5. **底部 composer**：占位 + `+` 附件 + 三内联 chip（`完全访问` 权限 / `GLM-5.2` 模型 / `最高` 强度）+ 同步指示 + 发送。

## 3. 决策矩阵

| # | 借鉴点 | relay-web 现状 | 决定 | 价值/可行性 |
|---|---|---|---|---|
| 1 | composer 内联选择器（模型/权限/工作计时） | 仅 textarea+Send/Stop（`PromptInput.vue`） | **借鉴** | ★★★ / ★★（需 1 条新 relay RPC；依赖 model-selection 分支） |
| 2 | 顶部上下文 chip 带（workspace@instance·branch） | 无顶部带 | **借鉴** | ★★★ / ★★★ 纯前端 |
| 3 | Git 状态摘要 widget（只读 `● branch · +N -N`） | 有 Files/Changes 只读 diff，无紧凑摘要 | **借鉴（只读）** | ★★ / ★★★ |
| 4 | Ctrl+K 命令面板 / 全局搜索 | 无 | **借鉴** | ★★★ / ★★ 纯前端 |
| 5 | 工作计时 + reasoning 时长 | 有 working-verb 状态，不显示耗时 | **借鉴** | ★★ / ★★★ |
| 6 | 侧栏会话耗时徽标 + 空态文案 | 有 attention 圆点，无耗时徽标/空态 | **借鉴** | ★★ / ★★★ |
| 7 | 警告/需授权 callout 样式 | 普通文本 | **借鉴** | ★★ / ★★★（复用 `FueCallout.vue`） |
| 8 | 面板全屏/折叠 chrome | 右面板仅 Tasks/Files 切 | **延后** | ★ / ★★ |
| 9 | 从 Web 直接 `提交`/写 git | — | **拒绝** | 破坏只读+容器化安全边界 |
| 10 | 桌面窗口 chrome（标题栏/最小化） | — | **拒绝** | Web 不适用 |
| 11 | `技能` 顶级入口 | 无技能体系 | **拒绝** | 无对应能力，价值低 |

## 4. 设计

### 4.1 安全边界（不可协商）
文件浏览器那批刻意做成**默认只读 + realpath 容器化**。本批的 Git widget **只读**：仅展示 `branch + 改动统计`，数据复用已有 `control.fs.diff`（`MSG.fsDiff`）。**绝不**从 Web 暴露 commit/push/写 git。

### 4.2 Batch A —— composer 内联选择器（最高协同）
- **UI**：`PromptInput.vue` 底部增加一行 chip：模型（点开列 `availableModels` 选择）、权限模式、工作计时（busy 时显示 `已工作 Ns`）。
- **数据通路**：新增 relay 控制 RPC，与现有 `fs.*` 同构：
  - `control.session.model.get` → 返回 `{ current?, available[] }`
  - `control.session.model.set` → 切换并持久化
  - `control.session.permission.get/set`（复用现有 permission 命令语义）
  - 协议：`packages/relay-protocol/src/messages.ts` 加 `MSG`/payload/result；连接器 `packages/channel-relay/src/control-bridge.ts` 加 case，调用 core `ControlService`。
  - core `ControlService`（`src/control/control-service.ts`）新增方法，转调 `feat/session-model-selection` 已落地的 `transport.getSessionModel` / `SessionService.setCurrentSessionModel` / `transport.setModel`。
- **依赖**：**Batch A 依赖 `feat/session-model-selection` 先合入 core**（transport 的 `setModel/getSessionModel` 在那条分支）。B/C/E 无此依赖，可并行先做。

### 4.3 Batch B —— 顶部上下文 chip 带（纯前端）
- `ChatPane.vue` 头部加一行 chip：`workspace @ instance · branch`，chip 可点（branch→切到 Files/Changes，instance→`ManageInstanceDialog`）。数据来自 instance/session 元数据（已在 store）。

### 4.4 Batch C —— Git 状态摘要 widget（只读）
- 头部或 Files 标签顶部紧凑 `● <branch> · +N -N`，源自 `control.fs.diff` 的 files/stat（已有）。点击展开 Changes 标签。

### 4.5 Batch D —— Ctrl+K 命令面板（纯前端）
- 新组件 `CommandPalette.vue`：`Cmd/Ctrl+K` 唤起，跨 instance/session 模糊搜索 + `/command` 目录（复用 `lib/command-catalog.ts`）。回车跳转会话或填充命令。

### 4.6 Batch E —— 细节打磨（纯前端，低风险）
- 状态 HUD/`MessageList`：busy 显示 `已工作 Ns`；`ReasoningPanel.vue` 折叠头加 `持续 Ns`（若无时长数据位则补一个）。
- `InstanceTree.vue`：会话加最近活动耗时徽标 + `暂无会话` 空态。
- 把"需授权/警告"类 agent 消息渲染为 callout（复用 `FueCallout.vue` 样式骨架）。

## 5. 范围与排序
- 独立可上线批次：A（需先合 model-selection）、B、C、E 纯前端可并行；Git widget(C 4.4) 复用 B 的头部。
- 不在本 spec：面板全屏 chrome（延后）、任何写 git（拒绝）、技能体系（拒绝）。

## 6. 测试策略
- 纯前端批次：vitest + @vue/test-utils 组件测试（沿用现有 `__tests__/` 模式），mock `api.rpc`。
- Batch A 的 RPC：core 侧 `bun test` 单文件（ControlService + 连接器 bridge case），relay-web 侧 mock rpc。
- 全程 `bun run --cwd packages/relay-web build`(含 vue-tsc) + 受影响文件逐个 `bun test`（勿整目录）。
