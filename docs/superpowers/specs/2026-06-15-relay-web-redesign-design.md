# relay-web 重设计（xacpx 品牌）设计规范

> 设计探索产物见 `docs/design/relay-web-redesign/`（5 个高保真 mockup + 对比页）。本规范固化最终方向 **E · xacpx**，作为后续实现计划（writing-plans）与执行的唯一依据。

**日期：** 2026-06-15
**状态：** 设计已定稿，待用户复核 → 写实现计划
**目标：** 把 relay-web 看板从“浅色单主题 + slate 硬编码 + emoji 图标”升级为一套 **xacpx 品牌化、双主题、token 驱动、零 emoji** 的精致控制台界面（Linear 级质感、冷调蓝绿、紧凑密度）。

---

## 1. 范围与时机

### 范围内
- 引入**语义化设计 token**（CSS 变量 + Tailwind 映射）与**暗/浅双主题**切换。
- 引入**字体系统**（Inter + JetBrains Mono）与**图标系统**（Lucide，替换全部 emoji）。
- 引入 **xacpx 品牌 logo**（内联 SVG 蓝绿 "X" + 字标）。
- 逐组件视觉/交互改造：壳层、侧栏、聊天区、右侧面板、对话框、设置/登录页。
- 可访问性达标（对比度、focus、reduced-motion、icon-only 按钮 aria）。

### 非目标（本期不做 / 延后）
- 吉祥物小鸟插画落地（空态/登录）——预留，后续单独评估。
- 移动端/窄屏深度适配——本期桌面优先，窄屏只保证不破版，响应式作为后续。
- 功能行为变更——纯视觉/交互皮肤层，不动数据流、协议、store 逻辑（除新增 theme store）。

### 时机与分支（硬约束）
- **实现 gated 在 PR #35（session-model-selection）/ #36（relay-web hapi-borrow）合入 main 之后**，在干净 main 上开新分支（建议 `feat/relay-web-xacpx-redesign`）。
- 理由：重设计触碰**几乎每个 relay-web 组件**，与未合的 #36 会大面积冲突。mockup 与本规范是独立产物，零冲突，可先行。

---

## 2. 设计方向：E · xacpx

- **结构/质感** = Linear/Product：柔阴影分层、选中行左侧 accent 条、卡片化 composer、hero 运行态、克制留白。
- **配色** = xacpx 品牌蓝绿（采自项目 banner）：冷调近黑底 / 清透白底，**蓝=交互、绿(调暗)=运行/成功**。
- **密度** = 紧凑（top bar/header ~44px，会话行 28px），正文仍 14px 保证易读。

### 与 mockup 的偏差（实现期采纳）
- **Send 按钮：纯品牌蓝实色，去掉蓝→绿渐变。** 渐变**仅保留给 logo "X"**。（用户反馈：不喜欢渐变按钮。）
- 其余按 E mockup 执行；任何后续微调以本节为准记录。

---

## 3. 设计 Token

实现方式：CSS 变量定义在 `src/style.css` 的 `:root`（浅色）与 `.dark`（暗色）；`tailwind.config.js` 的 `theme.extend.colors` 映射到这些变量，于是 `bg-surface / text-fg / border-border / text-accent` 等工具类**一套类名两套主题**自动生效。`darkMode: 'class'`。

### 颜色（语义名 → 暗 / 浅）

| Token | 用途 | Dark | Light |
|---|---|---|---|
| `bg` | 画布底 | `#0E1116` | `#F6F8FB` |
| `surface` | 面板/卡片 | `#151A21` | `#FFFFFF` |
| `raised` | 抬升层（下拉/弹层） | `#1B212A` | `#FFFFFF`(+shadow) |
| `border` | 边框/分隔 | `#262D38` | `#E4E9F0` |
| `fg` | 主文本 | `#E8ECF1` | `#121823` |
| `fg-muted` | 次文本 | `#94A0B0` | `#5B6675` |
| `accent` | **交互蓝**（按钮/链接/选中/focus） | `#4F9BF5` | `#2E7BE0` |
| `accent-hover` | 交互蓝 hover | `#6BB0F8` | `#2569C8` |
| `run` | **运行/成功绿（调暗）** | `#46C277` | `#1F9D57` |
| `run-bright` | 运行点 + 辉光（亮绿） | `#69D689` | `#34C06E` |
| `warn` | 警告 | `#FBBF24` | `#D97706` |
| `danger` | 危险/取消 | `#F87171` | `#EF4444` |
| `info` | 信息/未读点 | `#60A5FA` | `#2563EB` |
| `ring` | focus 环 | `accent` | `accent` |

### 品牌渐变（仅 logo）
- `--brand-from: #4F9BF5`（蓝） → `--brand-to: #69D689`（绿）。用于 logo "X" 的 `linearGradient`，**不用于任何按钮/背景**。

### 字体
- UI/正文：**Inter**（400/500/600/700）。
- 代码/数据：**JetBrains Mono**（消息代码块、别名、模型 id、路径、计时、diff 计数）。
- 计时/计数用 `font-variant-numeric: tabular-nums` 防抖动。
- **自托管优先**（`@fontsource/inter`、`@fontsource/jetbrains-mono`），避免运行时依赖 Google Fonts CDN。

### 密度 / 间距
- 8px 节奏；top bar ~44px，chat header ~44px，侧栏会话行 28px。
- chrome 字号 ~13px；transcript 正文 14px / line-height ~1.6；标题按层级 14–18px。
- 卡片圆角 `rounded-lg`；弹层/对话框 `rounded-xl`。

### 图标
- **Lucide**（建议引入 `lucide-vue-next`），统一 stroke 1.5–2、尺寸 token（侧栏 16、header 18）。
- 用到的：folder, bot, brain, git-branch, send, settings, x, chevron-down/right, circle, panel-left(收侧栏), plus, file, search, command, check, copy, alert-triangle, loader 等。
- **全面替换 emoji**：📁→folder，🤖→bot，🧠→brain，●→circle/状态点，📋→list 等。

---

## 4. 主题机制

- 新增 **`theme` store**（`src/stores/theme.ts`）：`mode: 'dark' | 'light'`；初始值 = `localStorage['relay-theme'] ?? (prefers-color-scheme)`；**默认 dark**。`apply()` 给 `document.documentElement` 切 `dark` class 并写回 localStorage。
- 切换入口：**top bar 主题切换按钮** + **设置页主题项**。
- `color-scheme` 同步设置，保证原生控件（滚动条/输入）跟随主题。
- 首屏防闪：在 `index.html` `<head>` 内联一小段脚本，挂载前就读 localStorage 设好 `dark` class。

---

## 5. 组件改造清单

> 原则：只改皮肤与图标，不改 props/事件/store 行为（theme store 除外）。每条 = 现状 → 目标。

### 壳层
- **`DashboardView.vue`**：3-pane 壳。新增 **top bar**（左：logo「xacpx · relay」+ ConnectionBadge 连接 pill；右：全局搜索/⌘K 触发 CommandPalette、主题切换、设置）。token 化背景/边框。
- **`ConnectionBadge.vue`**：连接状态 pill（在线 run 绿点 / 断线 danger），token 化。
- **logo**：内联 SVG "X"（`linearGradient #4F9BF5→#69D689`，圆润几何 X，~22–24px）+ `xacpx` 字标 + 克制的 `· relay` 角标。

### 侧栏
- **`InstanceTree.vue`**：实例可折叠；在线/离线点；会话行 28px，SVG agent 图标 + 别名 + `(agent)`；**状态点**：运行=run-bright 绿脉冲、未读=info 蓝、idle 无；**选中行** = accent 蓝淡底 + 左 accent 条；运行中 elapsed 徽标（tabular-nums）；`+ new session` / `Manage` 行；loading/空态区分（已在 #36 修复，保留）。

### 聊天区
- **`ChatPane.vue`**：header（标题 + 上下文 chip：workspace/instance/agent/git，SVG 图标，token 化）；error banner（danger 软底）；**turn HUD**（run-bright 脉冲点 + 轮换动词 + elapsed + 工具数 + Cancel）。
- **`MessageList.vue`**：user/assistant 行式排版、留白节奏、token 化。
- **`StreamMarkdown.vue`** + **`CopyButton.vue`**：markdown 与**冷调代码高亮**主题；复制按钮。
- **`ToolCallPanel.vue`** / **`ToolDetail.vue`**：工具步骤块（Read/Edit + done check + `+N −M` 计数）。
- **`ReasoningPanel.vue`**：reasoning shimmer（reduced-motion 守卫）。
- **`PromptInput.vue`**：卡片化 composer；textarea；**Send = 纯 accent 蓝实色（非渐变）**；slash 命令建议浮层；**model chip**（brain 图标 + 模型 id + chevron + 下拉，复用 #35/Batch A 的 session-controls）。

### 右侧面板
- **`FilesPanel.vue`**：文件树 + 修改标记（amber 点）+ Changes 摘要（`N files · +X −Y` 行）；token 化，视觉权重低于聊天区。
- **`TaskPanel.vue` / `OrchestrationTasks.vue` / `ScheduledTasks.vue`**：任务面板 token 化。
- **`CommandPalette.vue`**：⌘K 面板，raised 层 + accent 选中，token 化。

### 弹层 / 管理 / 页面
- **`NewSessionDialog.vue` / `ManageInstanceDialog.vue` / `AgentsManager.vue` / `WorkspacesManager.vue`**：对话框（surface + border + 输入框 + 按钮）token 化；主按钮 accent 蓝、危险 danger。
- **`NoticeToast.vue` / `FueCallout.vue` / `FueDot.vue`**：toast/FUE token 化（toast 不抢 focus，`aria-live`）。
- **`SettingsView.vue`**：token 化 + **新增主题偏好控件**。
- **`LoginView.vue`**：token 化 + 品牌 logo（可后续放吉祥物）。

---

## 6. 可访问性

- 两主题主文本对比 ≥ 4.5:1、次文本 ≥ 3:1（token 已按此挑选）。
- 可见 focus 环（accent ring）；icon-only 按钮加 `aria-label`。
- `prefers-reduced-motion`：脉冲点、reasoning shimmer、spinner、主题过渡均加守卫。
- 键盘导航保持（CommandPalette、composer、对话框 Esc）。
- 颜色不单独承载语义：状态点配文字/图标。

---

## 7. 实现路径（高层；细化由 writing-plans 出计划）

新分支 `feat/relay-web-xacpx-redesign`（off 合并后的 main）。建议阶段顺序：

0. **基础层**：tailwind.config（darkMode class + 语义色映射）、style.css token（`:root`/`.dark`）、字体（@fontsource）、图标（lucide-vue-next）、theme store + 防闪脚本 + 切换按钮。
1. **壳层**：DashboardView top bar + logo + ConnectionBadge + 3-pane token 化。
2. **侧栏**：InstanceTree。
3. **聊天区**：ChatPane / MessageList / StreamMarkdown / ToolCallPanel / ToolDetail / ReasoningPanel / PromptInput（含 model chip）。
4. **右侧面板**：FilesPanel / TaskPanel / OrchestrationTasks / ScheduledTasks / CommandPalette。
5. **弹层与页面**：各 Dialog / Manager / NoticeToast / FUE / SettingsView / LoginView。
6. **收尾**：双主题对比 QA、对比度/focus/reduced-motion 扫查、vitest（组件测试更新：emoji→图标、token class、主题切换）、`vue-tsc` 绿。

每阶段保持 `vitest` 与 `vue-tsc` 绿；现有组件测试中断言 emoji/slate 类名处需同步更新。

---

## 8. 待确认（Open Questions）

1. **字体**：自托管 `@fontsource`（推荐，离线/无 CDN）还是 Google Fonts CDN？
2. **图标库**：引入 `lucide-vue-next` 依赖（推荐）还是手写内联 SVG sprite？
3. **默认主题**：默认 dark（贴 mockup）+ 首访尊重系统偏好——确认？
4. **字标**：`xacpx · relay`（mockup 用）/ 仅 `xacpx` / 仅 `relay`？
5. **吉祥物**：本期是否在空态/登录用上小鸟，还是延后？

> 默认取推荐项（1 自托管 / 2 lucide-vue-next / 3 默认 dark+尊重系统 / 4 `xacpx · relay` / 5 延后）。如无异议即按此写实现计划。
