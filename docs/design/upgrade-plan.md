# xacpx relay-web 方案 B：UI / 样式升级执行规范

本文档给**只有仓库、不能联系其他 bot** 的执行 agent 使用。Gadzan 是唯一中间人。视觉验收由 UI/UX 设计师完成，材料经 Gadzan 转交。实现完成不等于 UI 验收通过。

历史审计快照是 `gadzan/xacpx` main `5b89cab95ab95fd412da7341418738f369dcf289`（2026-11-15 16:18，Asia/Shanghai；`release: relay 0.14.12-beta.22`）。那只是摸底基线，**不要回退仓库去对齐它**。下文中的出现次数、行号、对比度数字都是该快照上的搜索锚点或实测记录，**不是验收条件**。你必须在开始时记录自己的实际 base / head，并据此重新搜索、重新测量。

---

## 0. 可直接复制给执行者的启动提示

把下面整段（含文档本身）交给执行 agent。若对方已经拿着本文件，只复制代码块即可。

```
你是独立执行者。请严格按本文件实现 xacpx（https://github.com/gadzan/xacpx）仓库中 relay-web 的方案 B UI/样式升级。

硬约束：
1. 只改 packages/relay-web 的前端样式、组件，以及测试 / mock fixture / 证据包。不要改协议或后端行为，不要操作或部署生产，不要自动开放防火墙、不要开隧道，不要把凭据写进文档或证据包。
2. 范围已定为方案 B（WP-1 至 WP-18）。不要做方案 C（Radix 式 12 级色阶、1.125 比例字号），不要新增「跟随系统」主题，不要改 ConversationComposer 的既有动画与发送区 transition。
3. 你只有当前仓库，没有审计机器上的截图、技能或内部联系人。不要联系幕僚长或其他 bot，也不要声称能直接联系视觉验收人。Gadzan 是唯一中间人。实现完成不等于 UI 验收通过；按文末模板把 commit、测试、截图包、预览说明和剩余风险交给 Gadzan，由他转交验收。
4. 用户批准方案 B 只表示按该范围改 UI，不代表批准合并或部署。
5. 先记录开始时的实际 git base/head，以及它相对 5b89cab95ab95fd412da7341418738f369dcf289 的差异。不要为对齐审计而 checkout 或 reset 到该快照。历史次数和行号只是搜索锚点。
6. 必须在真实运行的 Vue 应用上取证，禁止用静态仿稿代替。优先用仓库已有的 Playwright mock hub 与现有 e2e fixture（可扩展，但不要接真实会话）。先固定同一套数据与视口拍 before，再改代码，再拍 after。验收人需要整页未裁原图；localhost 对验收人不可达，截图包必须能离线验收。若另提供测试服务，只允许非生产测试环境，访问方式由 Gadzan 转发，不要自行对公网暴露。

请先完整阅读本文件，再按「执行工作流」开始，不要自行扩大范围。
```

---

## 1. 文档用途与授权边界

- 执行者根据**当前克隆的仓库**即可安装、复现、改代码、跑测试、出证据。
- 不要依赖本机以外的截图目录、设计技能、内部备忘或即时通讯联系人。
- 工作包只写目标和依赖关系，**不设优先级、不排期、不规定 PR 顺序或合并节奏**。
- 视觉变化明显的包必须等 Gadzan 转交的视觉验收；未验收不得声称「UI 已通过」。
- 本文不是合并、发布或生产变更授权。

---

## 2. 已核实的仓库事实（执行前仍须对照当前树确认）

核对本节的时间：2026-11-16 11:32–11:40，Asia/Shanghai。仓库：`https://github.com/gadzan/xacpx`，默认分支 `main`，当时 HEAD 为 `5b89cab95ab95fd412da7341418738f369dcf289`（与历史审计快照相同）。你开始干活时若 HEAD 已前进，以你当时的 ref 为准，并记下差异，不要回退。

下面命令均来自当时仓库中的 `package.json`、CI、文档或源码，**未编造**。若你手上的文件与此不一致，以当前仓库为准，并在证据包里写明差异。

### 2.1 包管理与运行时

| 项 | 当时核实到的内容 |
|---|---|
| Node | 根 `package.json` `engines.node` 为 `>=22.13.0`。无 `.nvmrc`、无 `.node-version`。CI（`.github/workflows/test.yml`）使用 Node **24** |
| Bun | CI 使用 Bun **1.3.14**（`oven-sh/setup-bun@v2`）。根目录有 `bun.lock` 与 `bunfig.toml`（registry: `https://registry.npmjs.org`） |
| 安装 | CI 在仓库根执行 `npm ci`（同时存在 `package-lock.json`）。README「Running from source」写的是 `bun install`。`AGENTS.md` 写开发脚本与构建用 Bun，lockfile 写的是 `bun.lock`。**两套锁文件都在仓库里。** 建议与 CI 对齐：根目录 `npm ci`；若你改用 `bun install`，必须在日志中说明原因，并确认与 `package-lock.json` / `bun.lock` 没有各装各的 |
| 根清单版本 | 当时 `@ganglion/xacpx` 为 `0.24.10-beta.17`（该提交的 release 说明同时含 relay `0.14.12-beta.22`） |
| relay-web 清单 | `@ganglion/xacpx-relay-web` `0.1.0`，private，Vue 3 + Vite + Tailwind 3.4 + Vitest + Playwright `^1.62.1` |

### 2.2 已核实的命令

在仓库根：

```bash
# 安装（与当时 CI 一致）
npm ci

# relay-web 单元测试（根脚本会转到包内）
bun run test:web
# 等价：bun run --cwd packages/relay-web test

# 仅构建看板（会先 build relay-protocol）
bun run build:relay-web

# 类型检查 + 根单元测试（范围大于本次 UI 工作；按需运行，不要为了「全绿」去跑需要真实 acpx / 微信的 smoke）
npm test
```

以下开发命令在仓库根执行；随后列出的脚本名定义于 `packages/relay-web/package.json`：

```bash
# 开发服务器（文档写法）。vite.config.ts 把 /api、/ws、/desktop/observe 代理到 http(s)://127.0.0.1:8787
bun run --cwd packages/relay-web dev

# 包内脚本：
#   dev                 vite
#   build               vue-tsc --noEmit && vite build
#   preview             vite preview
#   test                vitest run
#   test:e2e            playwright test
#   test:e2e:desktop    playwright test --project=chromium-desktop
#   test:e2e:mobile     playwright test --project=chromium-mobile
#   codemod:radius      node scripts/codemod-radius.mjs
#   codemod:type        node scripts/codemod-type.mjs
```

当时 CI 的 relay-web e2e 作业（`relay-web-e2e`，工作目录 `packages/relay-web`）是：

```bash
# 依赖仍在仓库根安装
npm ci

bunx playwright install --with-deps chromium
bun run test:e2e
```

注意：

- 当时 CI **只安装 Chromium**。`playwright.config.ts` 当时也只有 `chromium-desktop` 与 `chromium-mobile` 两个 project，**没有 WebKit / Firefox project**。
- 桌面 project 视口写死为 **1440×900**。移动 project 使用 `devices["Pixel 7"]`，再设 `hasTouch: true`、`isMobile: true`。其 CSS 视口与 DPR **以你安装后的 Playwright 设备描述为准**，不要假定等于验收矩阵的 390×844。
- `darwin` 上配置会改用系统 Chrome channel（`channel: "chrome"`），因为注释写明部分 macOS 装不了 Playwright 自带的 Chromium。
- 端口：`PLAYWRIGHT_PORT` 默认 **4173**，`baseURL` 为 `http://127.0.0.1:${port}`。webServer 命令为：
  `bunx vite --port ${port} --strictPort --host 127.0.0.1`
  `reuseExistingServer` 在非 CI 时为 true。
- `testIdAttribute` 为 `data-test`。worker 数为 1，`fullyParallel: false`。
- Vite 默认开发端口（未在 `vite.config.ts` 写死）通常是 **5173**；以实际启动日志为准，可用 `--port` 覆盖。
- `vite.config.ts` 只配置了 `server.proxy`，**没有**看到 `preview.proxy`。因此人用预览优先走 **Vite dev**（与 Playwright webServer 相同路径），不要默认以为 `vite preview` 也会把 `/api`、`/ws` 转到 mock hub。若你验证了 preview 也能代理，再在日志里写明。
- `docs/testing.md` 当时只覆盖根单元测试与 relay-web Vitest，**没有**写 Playwright 命令。Playwright 以 `packages/relay-web/package.json`、`playwright.config.ts` 和 CI 为准。
- `docs/relay-web-module.md` 记录：开发用 `bun run --cwd packages/relay-web dev`，代理到 `:8787`；测试条目只写了根上的 `bun run test:web`（Vitest）。设置页路由为 **`/settings`**。语言偏好键 `relay-locale`，主题键见第 4 节。
- 不要跑 `tests/smoke/` 或需要真实微信 / 真实 acpx 会话的流程。仓库另有 `docs/verification-stack.md` / `scripts/verify-stack.mjs`（隔离的 daemon + 真 hub + 看板）。**本次不要用它当主路径**，它不是 mock，也更接近真实会话。

### 2.3 Mock 入口（必须用真实 Vue 应用）

入口文件：

- `packages/relay-web/e2e/mock-hub.ts`：进程内 mock hub。`startMockHub()` 用 Node `http.listen(0, "127.0.0.1")` 绑**随机端口**，当时**没有**端口参数，也**没有**独立 CLI 或 `/health` 路由。
- `packages/relay-web/e2e/fixtures.ts`：Playwright fixture 会启动上述 hub；把浏览器里路径为 `/api` 或 `/api/*` 的 HTTP 转到 `http://127.0.0.1:${hub.port}`；并用 `addInitScript` 把页面里的 `WebSocket` 在路径 `/ws`、`/desktop/observe` 时改写到该端口。Vite HMR 的 WebSocket 不得改写。
- 登录辅助：`loginAndShowInstances(page)`。先 `page.goto("/")`。`GET /api/me` 被 stub 为已登录（`{ username: "e2e" }`），所以通常会跳过登录页；若仍看到 `data-test="token-input"`，填 `e2e-token` 并点 `data-test="signin"`。然后等待 `data-test="session-row"` 可见。

默认 mock 数据很窄：一个在线实例 `i1`（名 `e2e-pc`），RPC `control.sessions.list` 默认只有会话别名 `demo`。它**不够**覆盖 Direct、群组、空会话、运行详情、补全等场景。

现有 spec 的扩展方式（不要另造一套协议）：在测试里对 `**/api/instances/i1/rpc`（必要时还有 `**/api/instances`）做 `page.route`，按 `type` 返回 `control.bots.list`、`control.groups.list`、`control.conversations.list`、`control.topics.list`、`control.conversation.history` / `timeline`、`control.conversation.completions.get`、`control.runs.*` 等，未命中则 `route.fallback()` 回默认 hub。可参考：

- Direct 与补全：`e2e/direct-completions.spec.ts`（含 `control.conversation.completions.get`；点击补全不得隐式发送）
- 群组时间线 / handoff / 停止全部 / 详情抽屉：`e2e/conversation-timeline.spec.ts`（`openTimeline()` 是完整 harness）
- Bot / 群组管理对话框：`e2e/bot-group-dialogs.spec.ts`（`instance-nav-bots` / `instance-nav-groups`，并已用 390×844 视口）
- 运行详情：`e2e/run-detail-drawer.spec.ts`、`e2e/run-detail-drawer-trace.spec.ts`
- 输入区芯片菜单：`e2e/composer-chip-dropdowns.spec.ts`（模型/力度菜单必须在输入区上方可命中，禁止被 overflow 裁切）
- 手机布局：`e2e/mobile-layout.spec.ts`（当时部分热区断言是 **≥40**，发送按钮已是 ≥44；输入框 16px）

健康检查（当时源码可依赖的，不是虚构的 /health）：

- Mock hub：`GET http://127.0.0.1:${HUB_PORT}/api/me` 期望 200，body 含 `"username":"e2e"`。
- Vite：`GET http://127.0.0.1:${VITE_PORT}/` 期望 200，且是实际 Vue 应用的 `index.html`，不是静态仿稿。

### 2.4 执行者必须自行确认的缺口（本节未编造结论）

1. 你开始时的 `git rev-parse HEAD`、当前分支、相对 `5b89cab…` 的 commit 列表与 `packages/relay-web` 文件差异。
2. Playwright 已安装版本里 `devices["Pixel 7"]` 的 viewport 与 `deviceScaleFactor`。
3. 本机 `bun run --cwd packages/relay-web dev` 实际监听的 host/port。
4. 若要提供可在浏览器里点的测试服务：需要自己扩展 `startMockHub`（例如可选端口，默认仍为 0）并写一个非生产 starter，把 hub 绑到 Vite 代理目标（文档写的是 `127.0.0.1:8787`），同时复用与截图相同的 RPC fixture。当时仓库**没有**现成的「一键人用 mock 预览」命令。
5. 当前树里 `text-accent` / `text-danger` / `text-fg-muted/…` 等的实际出现次数与文件，不要沿用历史计数当 Done。

---

## 3. 范围：只做方案 B

### 3.1 要做

方案 B = 原方案 A 的硬规则与 token 收敛，加上组件统一与已有状态补全，对应 **WP-1 至 WP-18**（见第 8 节）。视觉语言保持：冷灰画布、白卡片、单一系统蓝；深色按钮底 `#409CFF`、按钮上的深色字；浅色蓝字 `#005FC2`；轻边框与轻阴影；更多毛玻璃；顶栏圆钮和名字胶囊用玻璃加细半透明边，不要重描边；选中项不要左侧强调条；下拉点外关闭；能用点击 Tooltip / ⓘ 就不要用内联提示灰字。

### 3.2 明确排除

- 方案 C：12 级灰/蓝色阶、按 1.125 比例重做字号阶梯（不要引入 `caption` / `title-sm` / `title` / `title-lg` 那套新阶梯名来当规范）。
- 设置里新增「跟随系统」主题选项（这是新功能，不在 B 内）。
- 改动 `ConversationComposer` 的既有动画、时长、缓动、圆角动画（16↔24）、以及该组件上已有的 `transition-all`。
- 协议、relay 服务端、connector、生产部署、真实会话取证。
- 为了对齐 2026-11-15 审计而回退或改写与 UI 无关的提交。

### 3.3 已合规、本次不要回退的行为

- 选中行没有左侧强调条。工具/推理详情里的灰色缩进线不是选中态，不要当成违规去删。
- `@media (pointer: coarse)` 下 input / textarea / select 强制 16px（`src/style.css`）。
- `viewport-fit=cover` 与 `safe-area-inset-*`。
- 毛玻璃的 `@supports not` 与 `prefers-reduced-transparency` 实色降级。
- 全局 `:focus-visible` 双圈（按钮/链接）与输入框 2px accent 环；`data-ring="container"` 与 `aria-invalid="true"` 的退出逻辑保留。
- 深色模式靠灰阶分层，不要加发光描边。

---

## 4. 设计 token（全部内嵌，不依赖外部设计文档）

颜色变量在 `packages/relay-web/src/style.css`；Tailwind 映射在 `packages/relay-web/tailwind.config.js`。颜色角色是 RGB 三元组，和 `<alpha-value>` 一起用。主题靠 `html.dark`（`darkMode: "class"`），选择写入 `localStorage` 键 `relay-theme`。

### 4.1 现有颜色（当时 `style.css` 的值；若当前树已变，以当前树为准并记录）

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--c-bg` | #F3F4F6 | #111214 | 画布 |
| `--c-surface` | #EDEFF2 | #1A1B1D | 侧栏 |
| `--c-surface-2` | #E5E7EB | #2C2D32 | 实心悬停 / track |
| `--c-raised` | #FFFFFF | #25262A | 浮起卡片、选中行 |
| `--c-fg` | #1D1D1F | #F5F5F7 | 正文 |
| `--c-fg-muted` | #65656B | #AEAEB2 | 次要文字（承载信息时用实色，不要再叠 /40–/90） |
| `--c-accent` | #0071E3 | #409CFF | 实心按钮底、选中填充、进度。浅色底上的字当时注释为 4.70:1；深色按钮字为 `#0B1422`（`--c-on-accent`），注释为 6.52:1 |
| `--c-accent-hover` | #0066CC | #5AA9FF | 实心悬停 |
| `--c-accent-text` | #005FC2 | #409CFF | 蓝色文字和链接。浅色在画布上历史实测约 5.59:1 |
| `--c-on-accent` | #FFFFFF | #0B1422 | 实心强调按钮上的字 |
| `--c-danger` | #D92D20 | #FF6961 | 危险实心按钮底；默认不要拿它当正文色 |
| `--c-on-danger` | #FFFFFF | #2A0A08 | 危险实心按钮上的字，**必须实测**对比度 |
| `--c-danger-overlay` | #C4180B | #FF7E76 | 遮罩上的危险文字。浅色值可作 `--c-danger-text` 候选；深色 overlay **不是** `#FF6961`，不要把两个值当成同一个 |
| `--c-border` | #3C3C43 | #FFFFFF | 注释写明只配 alpha 用，禁止当实色边框 |
| `--hairline` | rgba(60,60,67,.11) | rgba(255,255,255,.10) | 发丝边 |
| `--hairline-strong` | rgba(60,60,67,.18) | rgba(255,255,255,.16) | 稍强发丝边 |
| `--fill-hover` / `--fill-strong` / `--fill-track` | rgba(118,118,128,.10 / .14 / .12) | rgba(235,235,245,.07 / .11 / .09) | 悬停与轨道 |
| `--accent-soft` | rgba(0,113,227,.11) | rgba(64,156,255,.16) | 淡蓝底 |
| `--scrim` | rgba(0,0,0,.26) | rgba(0,0,0,.45) | 遮罩 |

方案 B **新增或改用**：

- `--c-danger-text`：用于危险**文字**。浅色候选 #C4180B（与当时 `--c-danger-overlay` 相同）。深色必须在画布 / surface-2 / raised 上重测后再定，候选包括现有 `--c-danger`（#FF6961）和 `--c-danger-overlay`（#FF7E76），取满足对比度的那个并记录测量。不要未测就写死。
- 蓝色正文与链接默认走 `text-accent-text`，不要用 `text-accent`。
- 描边与分割线走 `--hairline` / `--hairline-strong`，不要把 `--c-border` 当实色。

### 4.2 毛玻璃（现有 token，方案 B 要收成三档并真正用起来）

当时值：

- `--glass-bg`：浅 `rgba(255,255,255,.72)`，深 `rgba(37,38,42,.72)`（对话头、手机顶栏）
- `--glass-bg-strong`：浅 / 深 同底 .84（菜单、tooltip、toast、对话框、输入卡片）
- `--glass-blur: 20px`，`--glass-saturate: 1.6`
- `--glass-border: var(--hairline)`；顶部 1px 内高光 `--glass-highlight`
- 类名：`.glass`、`.glass-strong`。降级：无 `backdrop-filter` 或 `prefers-reduced-transparency` 时退回 `rgb(var(--c-raised))`

方案 B 收成三档，**不要另起一套视觉**：

| 档 | 建议 | 用在 |
|---|---|---|
| `glass-1` | 复用 `--glass-bg` 72% + 现有 blur/saturate | 顶栏、对话头、面板头 |
| `glass-2` | 复用 `--glass-bg-strong` 84% | 浮层、菜单、对话框 |
| `glass-control` | 把 Direct 手机顶栏已经认可的圆钮 / 名字胶囊 / 头像盘配方提到 `style.css` | 悬浮圆钮与名字胶囊 |

遮罩 blur 统一为 **3px**（不要 4px 与 3px 混用）。玻璃上的文字对比度必须按**合成后的背景**计算，不能只拿未模糊的实色底算。

### 4.3 现有字号 token（方案 B 只使用这些，不要引用方案 C 的新阶梯）

`tailwind.config.js`：

| token | px / 行高 | 角色 |
|---|---|---|
| `xs` | 12 / 18 | 元信息、时间、角标；**最小字号** |
| `ui` | 13 / 20 | 侧栏行、菜单行、chip |
| `sm` | 14 / 22 | 正文、按钮、桌面输入 |
| `base` | 16 / 24 | 触屏输入、接近 17px 散值标题时的现有 token |
| `xl` | 20 / 28 | 页面主标题（现用量很少） |

历史锚点：`text-[17px]` 曾出现在 `MobileSheet`、`AddInstanceDialog` 等标题。方案 B 把这类散值映射到**上表已有 token**（最接近的是 `text-base` 16/24），**不要**为此引入 C 的 `title` / `title-sm`。若 17→16 肉眼有差别，在证据里写明，不要声称「视觉不变」。

小于 12px 的信息文字（10 / 11）升到 `xs`（12/18）；12.5px 不低于下限，但属于散值，映射到现有字号 token 后核对可读性。角标和计数用 12px + `tabular-nums`。

### 4.4 圆角（沿用现有值，统一语义名）

| token | 值 | 用在 |
|---|---|---|
| `item` / `--r-item` | 5 | 菜单行、列表行内小块 |
| `sm` | 6 | tooltip、行内代码、小 chip |
| `input` / `--r-input` | 7 | 单行输入 |
| `btn` / `--r-btn` | 8 | 按钮、图标按钮、分段轨道 |
| `menu` / `--r-menu` / `lg` | 10 | 菜单容器、toast |
| `card` / `--r-card` | 12 | 卡片、代码块、设置分组 |
| `dialog` / `--r-dialog` / `2xl` | 16 | 对话框、抽屉圆角 |
| 现有 `rounded-t-[24px]` | 24 | 仅手机 Sheet 顶部；可收成语义名，但值不变 |
| `pill` / `--r-pill` | 999 | 胶囊、圆钮、头像 |
| 输入框卡片 | 16↔24 | **属于 Composer 动画，禁止纳入迁移** |

仓库已有 `packages/relay-web/scripts/codemod-radius.mjs`（`bun run --cwd packages/relay-web codemod:radius`）。可扩展映射后机械迁移，但必须人工核对 Composer 与例外。另有 `codemod:type.mjs`。

### 4.5 阴影（沿用现有值，按层级收口）

`press` 用于分段选中块；`select` 用于侧栏选中行；`pop` / `glass-float` 用于菜单、tooltip、toast、悬浮圆钮；`dialog` 用于对话框和抽屉。`card` 给输入框卡片。去掉裸 `shadow`、`shadow-sm`、`shadow-md` 和任意值阴影（核对后替换为上表）。

### 4.6 动效

| token | 值 | 用在 |
|---|---|---|
| `--dur-fast` | 120ms | 颜色、背景、按下回弹 |
| `--dur-base` | 150ms | 菜单、tooltip 入场 |
| `--dur-sheet` | 180ms | Sheet、toast、抽屉 |
| `--ease` / `ease-ui` | cubic-bezier(.23,1,.32,1) | 以上全部 |
| Composer | 200ms cubic-bezier(0,0,.2,1) | **完全不动** |

统一规则（内部必须自洽，禁止一段禁止 `box-shadow` 过渡、另一段又建议 `transition-[box-shadow]`）：

- 禁止 `transition-all`（Composer 里已有的两处除外，不要去改）。
- 只显式列出实际变化的属性。优先 `opacity`、`transform`、`background-color`。
- 不要过渡 `backdrop-filter`。
- 若某控件的阴影确实会变（例如卡片选中），可以**显式**过渡 `box-shadow`，并在该组件内保持一致；不要全局禁止后再局部推荐，也不要用 `transition-all` 偷带阴影。
- 非 Composer 的位移 / 缩放动画补 `motion-reduce:transition-none` 或等价的 `prefers-reduced-motion`。先核对只用于定位的 `-translate-*`，那些不是动画，不要误伤。
- 菜单 / tooltip / toast 入场若要对齐，使用 150ms、`scale(.96)→1` 加淡入，`transform-origin` 对触发点；已有实现逐个对齐，不要重做一套。

### 4.7 z-index token（新建，但是基线而不是唯一机制）

建议：`base 0` / `sticky 10` / `header 30` / `popover 40` / `dialog 50` / `dialog-nested 60` / `toast 70` / `lightbox 100`。

嵌套对话框、`Teleport` / portal、焦点陷阱与还原**不能**只靠把 z 值写死。要保持现有焦点行为（见 `bot-group-dialogs.spec.ts`），并保留现有宽度例外（包括 **4xl** 以及复杂对话框）。不要把所有对话框都削成同一宽度。

---

## 5. 必须遵守的技术规则（修正旧稿歧义）

1. **不要盲目替换 `text-accent` 图标。** `text-accent` 用在正文、链接、文字按钮上时，改为 `text-accent-text`（或同等 token），并重测对比度。图标、装饰性图形、选中填充里的小 icon：先判断它是不是文字；再测图形对比度（见下条）。已满足的图标不要批量改掉。lint 若无法区分文字与图标，就不要做「一刀切归零」，改为允许名单或只扫描文本节点 / 非 icon 组件。
2. **对比度。** 正常文字 ≥ 4.5:1；大字（至少 18pt，即 24 CSS px；或至少 14pt 粗体，即约 18.67 CSS px）可 ≥ 3:1。必要的图形和控件边界 ≥ 3:1。装饰性发丝边**不强制** 3:1。玻璃、半透明描边、叠在照片或模糊底上的字，必须按合成背景测。危险**实心**按钮还要测 `--c-on-danger` 落在 `--c-danger` 上的对比（浅色与深色都要）。
3. **透明度。** 承载信息的文字用实色（`fg-muted`、`accent-text`、`danger-text` 等），不要用 `fg-muted/40–90` 这类叠加透明度凑层次。装饰分隔、disabled 控件、纯装饰点可以用透明或 `fill-*`，但 disabled 不是「把正文再减透明」的借口；disabled 必须仍能辨认状态，且不要冒充可点。
4. **触屏热区至少 44×44 CSS 像素，且相邻热区不要重叠。** 优先用真实布局（内边距、扩大可点击包裹）达到 44。伪元素扩展可以辅助，但 **不能只靠 `getBoundingClientRect()` 验收**——伪元素往往不计入该矩形。必须在热区四边中点做点击 / 轻触，确认打到的是目标控件；并测与相邻控件的间隙，避免误触。`min-height: 44px`（或 `min-h-11`）如果把视觉高度或排版撑大了，必须在证据里写「布局/视觉有变化」，**禁止**声称「视觉尺寸不变」。视觉面可以保持 28 / 32 的按钮高度，用外面 44 的命中盒，但命中盒不得互相重叠。
5. **输入补全不要无条件改成 Sheet。** 旧稿「<1024px 变成 Sheet」会打断光标与输入。补全列表必须留在输入框附近，保持 combobox / listbox 行为（见 `direct-completions.spec.ts`：Tab / 点击只填入，不隐式发送）。点外与 Esc 关闭可以与 `DropdownPanel` / `use-dropdown` 对齐，但不要改成全屏 Sheet，除非该控件本来就不是输入补全。
6. **菜单、select、listbox 的键盘语义按角色保持。** 复用组件不能改变现有业务。原生 `<select>` 可改为 `SelectMenu`，但键盘（方向键、Home/End、Enter、Esc、字符跳转若已有）与取值行为要保持。菜单不是 listbox，listbox 不是 menu，不要混用 ARIA 角色。
7. **对话框。** 统一外壳可以收敛遮罩、焦点陷阱、安全区内边距；但嵌套、portal、滚动锁定与焦点还原要按实际 DOM 测，不能只改 z-index。保留现有宽度（含 4xl）和复杂对话框例外，在证据里列出例外清单。
8. **Composer 完全保护。** 不要改 `ConversationComposer.vue` 的动画、过渡属性、时长、缓动、圆角变换，以及为它服务的注释 / token 例外。不要为了消灭 `transition-all` 或统一圆角而「顺便」改它。其附近的模型 / 力度芯片菜单（`composer-chip-dropdowns.spec.ts`）要继续可命中，也不要被新的 overflow 裁掉。
9. **空状态与补全数据。** 起步 chip 只能来自当时 mock 里 `control.conversation.completions.get`（或等价现有 API）的真实 `commands.items` / 现有话题。若 `items` 为空或 `status` 不是 ready，就不要画假的 `/review` 等命令，也不要发送。Chip 点击只填进输入框。
10. **只细化已有状态，不增加虚构业务。** loading / error / empty / focus / disabled 以产品里已经存在的状态为准，补对比度、热区、空状态布局和可见提示。不要为了「状态完整」编造新的业务流程、新设置项或新协议字段。
11. **新文案必须中英都加。** `docs/relay-web-module.md` 与 `src/__tests__/i18n-parity.test.ts` 要求 `en.ts` 与 `zh-CN.ts` key 一致且非空。

---

## 6. 执行工作流

按阶段做。阶段之间可以按依赖合并提交，但不表示有规定的排期顺序。

### 阶段 0：记录基线

```bash
git status
git branch --show-current
git rev-parse HEAD
git log --oneline 5b89cab95ab95fd412da7341418738f369dcf289..HEAD -- packages/relay-web
git diff --stat 5b89cab95ab95fd412da7341418738f369dcf289 -- packages/relay-web
```

把 base SHA、head SHA、分支名、与历史快照的差异写入证据包 `manifest.json`。若工作区已有无关改动，保留原样并记录，使用独立分支或 worktree 隔离本次工作；不要删除、覆盖、reset 或擅自 stash 别人的改动。

### 阶段 1：安装与自检

按第 2 节安装。然后：

```bash
bun run test:web
cd packages/relay-web && bunx playwright install --with-deps chromium
# WebKit 取证另装（当时 CI 不装，需在证据里标明环境是否成功）：
# bunx playwright install --with-deps webkit
bun run test:e2e
```

若 e2e 或单元测试在改代码前就失败，先记录，不要把既有失败写成你的回归。WebKit 装不上或跑不起来时，写明原因，不要假装测过。Playwright WebKit **不等于** 真实 Safari；真实 Safari / iOS Safari 若未能在真机或 macOS Safari 上打开同一 fixture，必须列为未测项。

### 阶段 2：固定 fixture，拍摄 before

1. 为验收矩阵中的每一页准备**可重复**的 mock 数据。优先抽取现有 spec 里的 `page.route` harness（如 `openTimeline`、`direct-completions` 的 bot/conversation/completions、空 sessions 的登录后不选中等），整理成可复用的测试辅助，而不是复制一份静态 HTML。
2. 用同一 fixture 在改代码前拍完整矩阵（第 7 节）。文件名、视口、主题、引擎、DPR、fixture id 写入 manifest。
3. 同步记录关键测量：对比度（含玻璃合成底、危险实心按钮字色）、热区（含中点点击，不只是 bounding box）、控制台错误（可过滤 mock 未提供的 PWA/图标 404，参见 `conversation-timeline.spec.ts` 的 `watchConsoleErrors`，但产品脚本错误不得过滤）。

### 阶段 3：按工作包改代码

每个包开始前用当前树重新搜索锚点。改完该包就更新该包的 DoD 证据，不要等全部结束才第一次截图。Composer 保护名单每包都要自检。

### 阶段 4：拍摄 after，跑回归

- after 必须与 before **同一 fixture、同一 CSS 视口、同一主题、同一引擎、尽量同一 DPR**。
- 跑 `bun run test:web` 与 `bun run test:e2e`，以及你为 DoD 新增或扩展的 spec。
- 把测试输出、未测项、console 错误、与 before 的差异说明放进证据包。

### 阶段 5：打包回传

按第 7.3 节目录打包，按第 9 节模板写给 Gadzan。不要自行合并 PR，不要部署生产。

---

## 7. 截图矩阵、行为回归与测试服务

### 7.1 截图矩阵

视口（CSS 像素，验收标准）：

- 桌面：`1440×900`
- 手机：`390×844`

主题：浅色、深色（通过 `localStorage.relay-theme` 与 `html.dark`，或设置页已有分段控件）。

引擎：

- Chromium（必做，与 CI 一致）
- Playwright WebKit（尽量做，并标明「这是 WebKit，不是 Safari」）
- 真实 Safari / iOS Safari：能做最好；做不到必须列入未测项，不要用 WebKit 截图冒充

DPR：每张图记录实际 `deviceScaleFactor` 或截图设备像素。不要为了文件大小去缩放后再当原图。必须是**整页未裁原图**（允许极长页分段拼接，但要标明，且不得裁掉边距、滚动条区域以外的内容装饰；优先 full-page）。不要用设计工具重绘。

建议场景（可按当前产品增删，但增删必须在 manifest 说明；before/after 集合要一致）：

| id | 场景 | 桌面 | 手机 | 主要覆盖 |
|---|---|---|---|---|
| 01 | 首页 / 会话列表 | 要 | 要 | 侧栏、分段、FAB |
| 02 | 侧栏 Bots | 要 | 要 | 列表、新建入口 |
| 03 | Direct 对话（含 Markdown / 代码块） | 要 | 要 | 发丝边、连字、气泡 |
| 04 | 输入框聚焦（已输入文字） | 要 | 要 | 焦点环、Composer 未变质检 |
| 05 | 侧栏群组 | 要 | 要 | |
| 06 | 群聊（handoff、活动行、轮次条、停止全部） | 要 | 要 | 热区、handoff 可见文字 |
| 07 | 运行详情抽屉 | 要 | 要 | 重复状态、卡片套卡片 |
| 08 | 设置页 `/settings` | 要 | 要 | 分组列表、分段、返回 |
| 09 | 登录页（必要时强制未登录态） | 要 | 要 | 不要为了拍登录页去改生产鉴权 |
| 10 | 桌面未选中任何会话 | 要 | 可省略 | 空列 |
| 11 | Direct 空状态（无消息） | 要 | 要 | 空状态、chip 或无数据时的真实空态 |
| 12 | 打开终端会话 | 要 | 要 | 仅视觉，不测真实 PTY 业务回归以外的东西 |
| 13 | 手机「更多」Sheet | — | 要 | |
| 14 | 键盘焦点环（至少返回键或等价控件） | 建议 | 要 | |
| 15+ | 你改到的 loading / error / empty / disabled / 对话框 / 补全列表 | 按需 | 按需 | 只拍已有状态 |

命名建议：`{id}-{scene}-{d1440|m390}-{light|dark}-{chromium|webkit|safari}.png`。after 与 before 分目录，文件名其余部分相同。

### 7.2 行为回归

至少覆盖（扩展现有 spec，不要另起无法在 CI 同类环境跑的框架）：

- 现有 `bun run test:e2e` 全绿，或对改代码前已失败的用例单独记为已知失败。
- 热区 44 CSS px：扩展 `mobile-layout.spec.ts`（把仍为 40 的断言提高到 44，并补 copy、topic pill、stop-all、设置分段、人名 / 「查看过程」等你改过的控件）。断言方式必须包含命中测试，而不是只读 `boundingBox`。
- 补全与下拉：扩展 `direct-completions.spec.ts`、`composer-chip-dropdowns.spec.ts`；点外关闭、Esc、键盘语义、不隐式发送。
- 对话框：扩展 `bot-group-dialogs.spec.ts` 一类已有焦点 / Esc / 背景点击测试。
- 详情抽屉：扩展 `run-detail-drawer.spec.ts`。
- 若改了减少动效：补 `prefers-reduced-motion` 相关断言或手动证据。
- i18n parity、与 UI 相关的 Vitest。

### 7.3 证据包目录（相对仓库，可以新增；本次规范不替你生成代码）

建议根目录（不要放进已被忽略且不好交接的 `packages/relay-web/test-results/` 里当唯一交付，那个目录已被 `packages/relay-web/.gitignore` 忽略）：

```
artifacts/ui-upgrade-b/
  manifest.json
  NOTES.md
  before/          # 整页未裁原图
  after/
  measurements/    # 对比度、热区点击记录、计算脚本与原始数据
  tests/           # vitest / playwright 完整输出
  logs/            # 服务启动日志、console errors、未过滤的页面报错
  scripts/         # 你用来启动 mock 预览或批量截图的脚本（可提交）
```

`manifest.json` 至少包含：开始与结束的 git SHA、分支、相对 `5b89cab…` 的差异摘要、Node/Bun/Playwright 版本、每个截图的场景 / 视口 / 主题 / 引擎 / DPR / fixture id / 文件路径、测试命令与结果、预览服务说明（若有）、未测项、已知风险。

### 7.4 可访问测试服务（可选，截图包才是离线验收底线）

原则：

- 必须跑**实际 Vue 应用** + mock，禁止静态仿稿。
- 优先 mock；只允许非生产测试环境。
- 默认只绑 `127.0.0.1`。**不要**自动开放防火墙、不要开 ngrok/cloudflared 等隧道、不要暴露生产、不要把 token 写进文档。若 Gadzan 需要远程访问，由他把访问方式转给验收人（SSH 端口转发等由他决定）。
- `localhost` / `127.0.0.1` 对验收人通常不可达，所以即使服务在跑，也必须同时交付截图包。

当时可依据的启动方式（端口均可配置；下列为默认或文档值，以你的实现为准）：

```bash
# 1) 先提供一个仅用于测试的 mock hub 进程（当时 startMockHub 只听随机端口，
#    你需要扩展可选 port，并加载与截图相同的 RPC fixture）。
#    建议默认 HUB_HOST=127.0.0.1 HUB_PORT=8787，以便对齐 vite.config.ts 的代理目标。
#    健康检查：
curl -sS -D- http://127.0.0.1:8787/api/me
#    期望：HTTP 200，JSON 含 "username":"e2e"

# 2) 再启动实际 Vite dev（不要默认改用未确认代理的 vite preview）
#    端口可配，例如 5173 或 4173；明确绑定 127.0.0.1。
bun run --cwd packages/relay-web dev -- --host 127.0.0.1 --port 5173 --strictPort
#    健康检查：
curl -sS -D- http://127.0.0.1:5173/
#    期望：HTTP 200，且是 Vite + Vue 的 index.html
```

入口路径（文档与现有测试用到的）：

- `/`：看板。通常已登录，侧栏可见会话；再按 fixture 点 `instance-nav-bots` / `instance-nav-groups` / `session-row`。
- `/settings`：设置页。
- 登录页：仅当 `/api/me` 被你有意改成未登录时出现。测试 token 示例为 `e2e-token`（只存在于本地 mock，不要写成真实凭据）。

服务管理：

- 有效时段：你与 Gadzan 约定；到期或验收结束后必须关掉进程，不要挂在后台当长期服务。
- 停止：先停 Vite，再停 mock hub；在 NOTES 里写进程识别方式与你实际使用的端口。
- 不要把服务绑到 `0.0.0.0` 除非 Gadzan 书面要求，且仍不得对公网暴露。

Playwright 自己的 webServer（`bunx vite --port 4173 --strictPort --host 127.0.0.1` + fixture 内随机端口 hub）适合自动截图与 e2e，不适合把「随机 hub 端口」直接给人口头访问。人用预览必须把 hub 稳定地放到代理目标端口，或明确写出你改过的代理配置（仅测试环境）。

---

## 8. 工作包（仅依赖，不设优先级）

历史次数与行号是 2026-11-15 快照上的搜索锚点，执行时按当前树重搜。每个包都要有 before/after 或等价测量。标了「需视觉验收」的，实现完成仍须经 Gadzan 转交设计师。

公共依赖：所有包都依赖阶段 0–2 的基线与 fixture；都不得改 Composer 动画，不得改协议/后端。

### WP-1 蓝色文字 token

- **目标：** 作为文字使用的 `text-accent` 改为 `text-accent-text`（浅色 #005FC2）。`accent` 留给实心底、选中填充，以及通过 3:1 测标的图标。
- **搜索锚点：** `packages/relay-web/src` 内 `text-accent`（历史约 122 处，`text-accent-text` 约 18 处）。曾集中在 FilesPanel、InstanceTree 文字按钮、SubagentStepCard、ConversationPromptInput、AgentMessageCard。
- **要求：** 见第 5 节第 1 条。不要盲目替换图标。lint 必须能区分或维护例外，禁止误伤。
- **DoD：** 当前树中「非例外的文字用途 `text-accent`」可说明已清；浅色文字在画布 / surface-2 / accent-soft 上 ≥4.5:1；相关 e2e 未回退。
- **证据：** 重计数 diff、对比度表、01/02/11 等含蓝字页面的 before/after。视觉变化轻微，仍要截图。

### WP-2 危险文字 token

- **目标：** 新增 `--c-danger-text`，文字用途的 `text-danger` 迁过去。`--c-danger` 只给实心底与通过测标的图标。
- **搜索锚点：** `text-danger`（历史约 125 处）。实例：`ConversationStatusBar` 的「全部停止」（`data-test=conversation-stop-all`）。
- **要求：** 浅色候选 #C4180B；深色必须实测。实心危险按钮测 `--c-on-danger` on `--c-danger`。
- **DoD：** 危险文字在目标背景上 ≥4.5:1（或符合大字规则）；实心按钮字色达标；图标例外有清单。
- **证据：** 对比度表（含深浅、含实心按钮）、06 等截图。

### WP-3 次要文字去透明度

- **目标：** 承载信息的 `text-fg-muted/40–90` 改为实色 `fg-muted`。装饰分隔改用 `fill-strong` 等色块，不用文字透明。去掉 uppercase + tracking 的眉标题写法，改为至少 12px / medium 的 `fg-muted`。
- **搜索锚点：** `fg-muted/70` 等（历史约 28 处）。`TraceLiveStack` 曾有 10px 全大写加字距加 /70。
- **要求：** 区分信息文字与装饰 / disabled。不要把 disabled 做成看不清的正文。
- **DoD：** 信息类透明文字用法可说明已清；对比度达标；无 10px 信息文字。
- **证据：** rg diff、对比度、相关抽屉 / trace 截图。

### WP-4 触屏热区

- **目标：** 触屏高频控件命中区 ≥44×44 CSS px 且不重叠。e2e 门槛从 40 提到 44，并补齐遗漏控件。
- **搜索锚点：** `CopyButton`（`data-test=copy-button`，历史视觉约 22×22）、话题胶囊 `group-topic-pill` / `topic-menu`、`transcript-speaker`、`timeline-open-detail`、handoff 按钮、`conversation-stop-all`、`instance-nav-*`、设置分段、「返回」、`mobile-layout.spec.ts` 里仍为 40 的断言。
- **要求：** 见第 5 节第 4 条。仅在粗指针 / 触屏策略下扩大命中，桌面密度能保持则保持；若 `min-height: 44` 改变了布局，必须如实记录。
- **DoD：** 目标控件在 390×844、触屏条件下，四边中点命中正确且不误触邻居；回归通过。
- **证据：** 测量 JSON、中点点击记录、mobile-layout 扩展结果、必要时的 after 截图。不能只交 boundingBox。

依赖：若 WP-14 改了按钮结构，热区要在按钮迁移后重测；两者谁先谁后不强制，但后做的要重验。

### WP-5 发丝边替换（需视觉验收）

- **目标：** 把当实色用的 `--c-border` / `border-border` / `bg-border` 改为 hairline。代码块改为凹面：`background: var(--fill-track)`，`border: 1px solid var(--hairline)`，圆角 `--r-card`（12），无阴影。引用：`border-left: 2px solid var(--hairline-strong)`，文字 `fg-muted`（这是引用格式，不是选中态，不违反「不要左侧强调条」）。表格与 hr 用 hairline。`CodeEditor` 一并列进范围。
- **搜索锚点：** `StreamMarkdown.vue`、`CodeEditor`、`ConversationInteractionForm`、`ComposerAttachments`、`ToolDetail`、`TerminalTab`、`PromptInput` 等 `border-border` / `bg-border`（历史约 StreamMarkdown 7、CodeEditor 2、Tailwind 14）。
- **要求：** 深色下禁止再出现近白粗框。不要把代码块做成卡片套卡片。
- **DoD：** 锚点用法可说明已清；03/06 before/after 可对比；无故意加粗描边。
- **证据：** 整页原图 03/06 深浅、桌面手机。

依赖：WP-17 的交互表单也会改边框，注意不要互相覆盖；后做的包要包含表单 after。

### WP-6 圆角语义迁移

- **目标：** 按第 4.4 节把散落圆角迁到语义 token；清遗留 `rounded` / `rounded-xl` / `rounded-md` / `rounded-[2px]` 等（核对后）。扩展现有 radius codemod，跑其单测。
- **搜索锚点：** `rounded-card` 等语义类当时用量为 0；`rounded-sm`、`rounded-xl`、`AddInstanceDialog`、`SettingsView`。
- **要求：** **输入框 / Composer 除外。** Sheet 顶部 24px 只改名不改值。
- **DoD：** Composer 动画与 16↔24 圆角未被改；codemod 测试通过；例外清单可审。
- **证据：** rg diff、抽查截图、codemod 测试输出。

依赖：与 WP-13 / WP-14 / WP-16 的圆角会交叉，后做者复检。

### WP-7 动效 token、去掉非 Composer 的 `transition-all`、减少动效缺口

- **目标：** 散值时长改为 `--dur-*` + `ease-ui`。按第 4.6 节改写 `transition-all`（历史非 Composer 锚点：`AgentMessageCard`、`QueueStrip`）。补 `motion-reduce`。可选对齐菜单 / tooltip / toast 的 150ms 入场。
- **搜索锚点：** `transition-all`、`duration-[`、`var(--dur-`、`ease-ui`、无 `motion-reduce` 但含 transform/keyframes 的文件（历史搜索锚点，需重核：DashboardView、InviteView、ToastHost、AgentMessageCard、FileTreeNode、CenterTabStrip、ManageInstanceDialog、SelectMenu、PromptInput、BotDialog、TranscriptJumpLatest、ImageLightbox、SessionModelBanner、Tooltip、ActionToast；定位用 translate 不要误标）。
- **要求：** Composer 两处 `transition-all` 不动。规则内部自洽。
- **DoD：** 非例外 `transition-all` 可说明已清；减少动效下无多余位移动画；e2e 未因动画变时序而间歇失败（必要时改等待而不是加长 sleep）。
- **证据：** rg diff、reduced-motion 记录或测试。

### WP-8 最小字号与散值

- **目标：** 小于 12px 的信息文字升到 `xs`。12.5px 等散值收到现有 type token。17px 标题收到现有 `text-base`（或你在现有五档里更能自洽的一档），**不要引用方案 C 字号表**。
- **搜索锚点：** `text-[10px]`、`text-[11px]`、`text-[17px]`、`font-size: 12.5px` 等。
- **要求：** 若 17→16 有可见变化，写明。不要为了「最小 12」把装饰性纯图形尺寸误改。
- **DoD：** 信息文字无 <12px；散值可说明已清或列入例外。
- **证据：** rg diff、受影响标题 / 角标截图。

### WP-9 玻璃 token 三档（需视觉验收）

- **目标：** 在 `style.css` 落地 `glass-1` / `glass-2` / `glass-control`；面板头与桌面对话头改用 `.glass` / `glass-1`；遮罩 blur 统一 3px。让 `--glass-bg` 真正被用到。
- **搜索锚点：** `DirectBotPane` 局部 `.glass-btn` / `.glass-chip` / `.glass-disc`；`ChatPane`、`TerminalTab`、`DesktopTab`、`FileViewer` 的 `bg-surface/60 backdrop-blur-md`；`DashboardView` 的 `bg-surface/80 backdrop-blur`；`backdrop-blur-sm`、`backdrop-blur-[3px]`。
- **要求：** 降级分支保持。合成对比度要测。不要加新的重描边。
- **DoD：** 配方可数清为三档；降级与减少透明可见；相关页面 after 可审。
- **证据：** 03/06/12/13 等，含浅深、以及一份降级或减少透明的证据（可截图或说明如何触发）。

依赖：WP-10 使用 `glass-control`，若 WP-10 先做，之后也要把配方收进全局 token。

### WP-10 手机顶栏统一（需视觉验收）

- **目标：** 群组与会话的手机顶栏改用与 Direct 相同的悬浮圆钮 + 名字胶囊语言（群组位置用拼合头像）。这是把已有语言推广到另外两个页面，不是新视觉体系，但必须视觉验收。
- **搜索锚点：** `DirectBotPane.vue`、`GroupPane.vue`、`DashboardView.vue` 手机顶栏；`data-test=mobile-session-bar`、`mobile-back`、`mobile-more`。
- **要求：** 三套顶栏在 390 宽下结构一致；安全区保留；焦点环仍可见；热区 44。不要给桌面强行套手机悬浮顶栏。
- **DoD：** 03/06/12 手机浅深 after 可对比；`mobile-layout.spec.ts` 与返回逻辑仍成立。
- **证据：** 整页原图 + 顶栏特写（特写是附加，不能代替整页原图）。

依赖：最好能用到 WP-9 的 `glass-control`。

### WP-11 下拉与补全收口

- **目标：** 去掉残存原生 `<select>`（历史锚点 `GroupRunDetailHeader` 尝试次数）。手写补全 / 选择弹层收敛为可复用列表（例如 `CompletionList`），视觉与点外关闭、Esc 复用 `DropdownPanel` / `use-dropdown`。
- **搜索锚点：** 原生 `select`；`ConversationPromptInput`、`GroupComposer`、`ModelPicker` 手写弹层；`SelectMenu.vue`、`ContextMenu.vue`、`lib/use-dropdown.ts`。
- **要求：** 见第 5 节第 5–6 条。不要无条件改 Sheet。不要破坏 `composer-chip-dropdowns` 的命中行为。
- **DoD：** 目标原生 select 可说明已迁；补全键盘与「只填入不发送」仍过；点外 / Esc 一致。
- **证据：** 扩展后的 e2e、补全与 Select 的截图（含键盘 focus 如可拍）。

依赖：WP-15 的起步 chip 若复用补全数据或组件，需与本包数据规则一致。

### WP-12 Tooltip 替换不可见的 title，handoff 露出文字（需视觉验收）

- **目标：** 触屏上看不到的关键信息不要只放在 `title` 里。handoff 行在头像后加一行截断文字（例如「→ Bob · 任务」），12px `fg-muted`。不直观的图标按钮改用已有 `Tooltip.vue` 的点击显示（触屏已支持点按约 2s）。「查看 ○ 的过程」在群聊中的重复噪音：降到与时间戳同一行的图标按钮 + 点击 Tooltip，不再单独占一行（这是已有入口的呈现收紧，不是新功能）。
- **搜索锚点：** `title=`（历史约 126 处）、`<Tooltip>`（历史约 1 处，`InstanceTree`）、`TimelineRow` handoff、`timeline-open-detail`。
- **要求：** 有 `aria-label` 的纯图标可保留 desktop `title`，但不能只靠它。不要引入内联长提示灰字。
- **DoD：** 手机群聊能直接看到 handoff 任务要点；点击 Tooltip 可测；相关热区仍达标。
- **证据：** 06 手机 before/after、触屏点按记录。

### WP-13 DialogShell 与 z-index token

- **目标：** 收敛对话框外壳（scrim、焦点陷阱复用现有 `use-modal-a11y`、安全区）。建立 z-index token。迁移现有 `role="dialog"` 对话框，但保留宽度与复杂例外。
- **搜索锚点：** 带 `role="dialog"` 的文件（历史约 22 个）；`ForkTopicDialog`、`DirectoryPicker` 等嵌套；宽度 `[380px]` / `md` / `lg` / `xl` / `4xl`。
- **要求：** 见第 5 节第 7 条与第 4.7 节。
- **DoD：** 已迁对话框的打开 / Esc / 焦点还原 / 背景点击仍过；例外清单列出未迁或特殊宽度；嵌套场景用手测或测试覆盖。
- **证据：** 对话框 e2e、至少一种嵌套或 4xl 例外的截图与说明。

依赖：与 WP-6 圆角、WP-9 玻璃交叉。

### WP-14 UiButton

- **目标：** 用 `UiButton`（或同等单一组件）收敛主按钮及次级 / 幽灵 / 危险变体。尺寸视觉面 sm 28 / md 32，圆角 btn 8。触屏命中 44，视觉面可保留 28/32，只要不重叠、不把布局撑乱；若撑乱必须如实记录。
- **搜索锚点：** `bg-accent` + `text-on-accent` 主按钮（历史约 39 处、13 种组合）；`SettingsView`「添加实例」曾 `h-11 rounded-xl`。
- **要求：** 危险实心变体测字色。不要改 Composer 发送按钮的动画外壳；若发送按钮要接入组件，必须证明动画未被改变，否则列为例外。
- **DoD：** 主路径按钮可说明已迁或列入例外；对比度与热区达标；设置页不再混用三种完全不同的主按钮尺寸语言（与 WP-16 一起看）。
- **证据：** 组件用法说明、08 等截图、对比度与热区。

依赖：与 WP-4、WP-16 交叉。

### WP-15 Direct 空状态（需视觉验收）

- **目标：** 无消息时，空状态在消息区垂直居中。上方为 Bot 头像（可沿用手机头像盘尺寸 56）、名字与 workspace · agent。下方 2–3 个起步 chip **仅来自真实 completions 或已有话题**；点击填入输入框，**不发送**。无数据则不画假命令，只保留说明性空状态。
- **搜索锚点：** `DirectBotPane.vue` 内联空状态、`EmptySessionState.vue`、`control.conversation.completions.get`（见 `direct-completions.spec.ts`）。
- **要求：** 见第 5 节第 9–10 条。不要因此改 Composer 动画。
- **DoD：** 有数据 / 无数据两种空态都有证据；点击 chip 只填入；e2e 覆盖。
- **证据：** 11 的有数据与无数据截图、e2e。

依赖：补全数据形状与 WP-11 一致；不强制先完成 WP-11。

### WP-16 设置页分组列表（需视觉验收）

- **目标：** `/settings` 改为分组列表：raised 白卡（深色用 raised）、行高 44、行间发丝线。外观和语言分段与侧栏分段同一套。内联提示灰字收进 ⓘ / 点击 Tooltip。顶栏返回与对话页手机顶栏语言一致（玻璃返回圆钮）。**不要**做「跟随系统」。
- **搜索锚点：** `views/SettingsView.vue`；历史问题包括分段约 30 高、主按钮 44 高大圆角、退出登录幽灵按钮、「← 返回」约 22 高。
- **要求：** 行本身应是可点热区 44。不要引入新的主题模式。
- **DoD：** 08 浅深、桌面手机 after 可审；分段与返回热区达标；提示在触屏可看。
- **证据：** 整页原图 08、ⓘ 点按。

依赖：WP-9/10 的玻璃控件、WP-14 的按钮、WP-12 的 Tooltip。

### WP-17 详情抽屉与交互表单（需视觉验收）

- **目标：** 运行详情去掉重复的「运行中」状态（只保留头部）。成员列表去掉外层卡片，改为列表行，选中用 `fill-strong`。交互表单去掉实色粗描边 + `shadow-sm` 卡片，外层改与 `.agent-bubble` 同族（发丝边、轻阴影），选项用 `fill-track` + `rounded-item`，选中用 `accent-soft` + `accent-text`。
- **搜索锚点：** `GroupRunDetailHeader.vue`、`ConversationRunDetailContent.vue`、`ConversationInteractionForm.vue`；截图场景 07。
- **要求：** 不删功能，只去重复与卡片套卡片。表单选中不要左侧色条。
- **DoD：** 抽屉里运行状态只出现一次；表单视觉纳入发丝边体系；`run-detail-drawer.spec.ts` 仍过。
- **证据：** 07 before/after，以及一条交互表单状态（有则必拍，没有则在未测/不适用里写清）。

依赖：WP-5 的 hairline；WP-11 若改了尝试次数 select，抽屉头部要回归。

### WP-18 代码连字

- **目标：** `.stream-md pre, code { font-variant-ligatures: none }`（选择器以当前 DOM 为准），避免 JetBrains Mono 把 `!==` 一类连成易误认字形。
- **搜索锚点：** `StreamMarkdown`、代码块字体。
- **要求：** 只关连字，不改字体家族。
- **DoD：** 含 `!==` 或同类序列的代码块截图不再显示误导连字；03 after。
- **证据：** 03 代码区域 before/after（可另附特写，但仍要有整页原图）。

---

## 9. 回传给 Gadzan 的模板

实现完成后，把下面填好交给 **Gadzan**。由他转交视觉验收。不要写「已联系设计师 / 幕僚长 / 某 bot」，不要把实现完成写成 UI 验收通过。

```
# 方案 B 回传

## 范围
- 仓库：https://github.com/gadzan/xacpx
- 工作分支 / 远程（若有）：
- base SHA：
- head SHA：
- 相对 5b89cab95ab95fd412da7341418738f369dcf289 的差异摘要（commit 列表或统计）：
- 已完成工作包：
- 未做或只做了部分的工作包及原因：

## 测试
- Node / Bun / Playwright 版本：
- 命令与结果：
  - bun run test:web：
  - bun run test:e2e（chromium-desktop / chromium-mobile）：
  - WebKit：
  - 新增或扩展的 spec：
- 已知失败（改代码前就有 / 新引入）：

## 截图证据
- 证据包路径（相对仓库）：artifacts/ui-upgrade-b/
- before/after 是否同一 fixture、同一 CSS 视口：
- 矩阵覆盖（视口 1440×900 与 390×844、浅/深、引擎）：
- DPR 记录位置：
- 未拍到的场景：

## 预览服务（可选）
- 是否提供：是 / 否
- 绑定地址与端口（应为测试环境，默认 127.0.0.1）：
- 健康检查命令与当时结果：
- 入口路径与如何切到各 fixture：
- 有效时段与如何停止：
- 访问方式：请 Gadzan 转发（执行者未对公网暴露 / 未开隧道 / 未写凭据）
- 说明：localhost 对验收人不可达，离线请直接看截图包

## 剩余风险与需要视觉判断的点
- 需视觉验收的包（至少 WP-5 / 9 / 10 / 12 / 15 / 16 / 17）：
- 热区是否改变了布局或视觉高度：
- 17px→现有 token、危险深色文字色、玻璃合成对比度等实测结论：
- Composer 动画是否被触碰（应为否，若例外必须说明）：
- 真实 Safari 是否未测：

## 声明
实现已按方案 B 完成到上述范围，但不等于 UI 验收通过。请 Gadzan 将本回传与证据包转交视觉验收。未获合并或部署授权。
```

---

## 10. 附录：常用 data-test 与主题键（当时树中已出现，执行时复核）

- 主题：`localStorage.relay-theme`；语言：`localStorage.relay-locale`（`en` / `zh-CN`）
- 登录：`token-input`、`signin`
- 会话：`session-row`、`session-name`、`fab-new-session`
- 分段：`instance-nav-bots`、`instance-nav-groups`（会话分段以当前树为准）
- 行：`bot-row`、`group-row`
- 手机：`mobile-session-bar`、`mobile-back`、`mobile-more`、`mobile-more-sheet`、`sheet-close`
- 对话：`conversation-timeline-scroller`、`timeline-handoff`、`timeline-open-detail`、`transcript-speaker`、`conversation-status-bar`、`conversation-stop-all`、`round-strip`、`copy-button`
- 输入：`composer-send`、`group-composer-textarea`、`group-send-prompt-button`；Direct 补全常见 `textarea[role="combobox"]` 与 `role="option"`
- 抽屉：`group-detail-card` / `group-detail-sheet`、`group-run-detail`
- 设置入口：`settings-link`（手机会话里可能隐藏，改走设置路由或首页入口）

若当前树改了 testid，以当前树为准，并更新 manifest。
