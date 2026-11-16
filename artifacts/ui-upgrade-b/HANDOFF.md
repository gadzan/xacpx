# 方案 B 回传

## 范围

- 仓库：https://github.com/gadzan/xacpx
- 工作分支 / 远程（若有）：`ui-upgrade-b`，已推送；PR 为 https://github.com/gadzan/xacpx/pull/590。**未合并、未部署。**
- base SHA：`5b89cab95ab95fd412da7341418738f369dcf289`（与审计快照一致，开跑时核对无漂移）
- head SHA（代码）：`616e2ef8`，即把 `origin/main` 的两个新提交（`cf1f0a10` #585、`f45f76d6` #586）并入后的合并提交。之后的提交只含证据、注释清理与本文档；`git log -1` 给出分支最终 head。
- 相对审计快照的差异摘要：32 个提交到合并提交（其后为证据/清理提交）；`packages/relay-web` 约 113 文件 +2500/−1240；证据全在 `artifacts/ui-upgrade-b/`
- 已完成工作包：WP-1 … WP-18，**18/18**
- 未做或只做了部分的工作包及原因：无整包未做。偏差如下，均在证据里写明：
  1. **WebKit 未测**：`packages/relay-web/playwright.config.ts` 只有 `chromium-desktop` / `chromium-mobile`，没有 webkit project。真实 Safari 完全未测。
  2. **手机截图是 Pixel 7（412×839 CSS，DPR 2.625），不是 390×844**：before 包与 after 包同一形态，所以对比有效；390×844 用**实测**覆盖（热区、顶栏控件不重叠），没有另拍一套图片。`manifest.json` 的 `matrix.stated_viewport_gap` 记了这条差别。
  3. **`06-group` 与 `07-drawer` 没有 before 图**：这两个场景在基线拍完之后才进 harness。before 状态以代码 `c38f4b69` 为准；`manifest.json` 的 `shots.after_only` 列了全部只有 after 的场景。
  4. `.glass-1` 暂无使用者：三条手机顶栏按 WP-10 保留实底行 + 其上玻璃控件，没有为了凑使用点改布局。
  5. 桌面会话头仍用 `bg-glass-strong` 工具类（与 `.glass-2` 同一套 token），未强行改成类名。

## 测试

- Node / Bun / Playwright：node v24.21.0、bun 1.4.4、@playwright/test 1.62.1（chromium）
- 命令与结果：
  - `bunx vitest run`（`packages/relay-web`）：**213 文件 / 2977 测试通过**（合并 `main` 后的 head，含 `main` 带来的 1 文件 / 3 测试）。基线 211 / 2969。
  - `bunx vue-tsc --noEmit`：通过。
  - `bunx playwright test`（两个 project 全量，在合并后的 head 上）：**187 passed / 0 failed / 51 skipped**，14.0m。skipped 全部是「只在某个 project 有意义」的用例（手机专属、或未设 `UI_SHOTS_DIR` 的取证 harness）。CI 在 PR head 上另跑一遍，见 PR 检查列表。
  - WebKit：**未运行**（无 project）。
  - 新增 / 扩展的 spec：
    - 新增 `e2e/direct-empty-starters.spec.ts`：空 Bot 页有 / 无广告两态，点 chip 只填不发（desktop + mobile）。
    - 扩展 `e2e/conversation-timeline.spec.ts`：交接行可见文本；新增 390×844 一轮热区测试，含顶栏四项两两不重叠、pill 不超出其槽位。
    - 扩展 `e2e/mobile-layout.spec.ts`：设置页六项热区在 412×839 与 390×844 各测一遍。
    - 扩展 `e2e/run-detail-drawer.spec.ts`：抽屉里运行状态只出现一次。
    - 扩展 `e2e/ui-upgrade-before.spec.ts`：场景 11 增加「有起步 chip」一帧。
- 验证期间发现并修掉的真实缺陷（详见 `decision-log.tsv` 与 `measurements/touch-targets-wp4.txt`）：
  1. **`expectTouchTarget` 把落空记成命中**：`elementFromPoint(...)?.closest(...) !== null` 在元素不在视口时返回 `undefined !== null`，恒为 `true`。因此提交 `9ed5a7e8` 里「42 targets、0 miss、0 overlap」的说法**作废**；本包用修好的实现重测，`touch-targets-wp4.{jsonl,txt}` 已整体重写。
  2. **`-my-2` 让 `transcript-speaker` 的 44px 热区压到上一行下面**：顶边中点在上一行上。已去掉负 margin（触屏该行变高 24px）。
  3. **群组顶栏成员盘只有 36×36**：已改为触屏 44。
  4. **群组顶栏话题 pill 比槽位宽 10px，右缘压在 `⋯` 下面**：已被 `[&_button]:max-w-full` + `overflow-hidden` 限制，并加断言。
  5. **玻璃包住了话题触发器**：`backdrop-filter` 祖先会成为 fixed 后代的包含块，把话题弹层/行菜单困住，导致 5 个 fork 用例失败。已改为非玻璃槽位。
  6. **加空态插槽时丢了 `:fork-message` 绑定**：消息行的分叉入口消失。已恢复。
  7. **取证 harness 的相对默认路径**在普通 `playwright test` 时把假「before」图写进 `packages/artifacts/`。现在未设 `UI_SHOTS_DIR` 就整体 skip，误写目录已删除。
- 已知失败（改代码前就有 / 新引入）：上述 7 条都是本轮引入并在本轮修掉，无遗留。
- 合并 `main` 之后的一轮独立复核（5 条互不通气的 lane：重跑门禁、真实界面取证、diff 审计、方案合规、注释/清洁度）又找出 7 处，全部在本分支修掉：
  1. **WP-12 的过程入口仍单独占一行**：图标被 `TranscriptRow` 的 `#meta` 块级排布挤到时间戳下一行，变成一个没有标签的 16px 头像。已移进 `ConversationMeta` 的默认插槽，与时间戳、复制/分叉同一行。
  2. **抽屉里同一条失败原因打印三次**（成员行、选中成员行、过程内容）。现在只在过程内容不显示它的情况下（历史尝试、裸内核原因码）才在正文补一行，其余交给过程内容。
  3. **`dialog-shell.spec.ts` 默认往已提交的证据目录写截图**：任何一次普通 `playwright test` 都会改动仓库。已改为只在设了 `UI_SHOTS_DIR` 时写。
  4. **`tooltip.test.ts` 合并时被砍掉一半**：`Tooltip.vue` 本身未改，但定位/翻边/贴边钳制/滚动重算/监听器回收的断言消失。已把上游那组测试原样并回来。
  5. **`tailwind.config.js` 留了一个零调用的 `menu` 圆角 token**，注释还声称「WP-13/14 会采用」。已删 token、改注释。
  6. **WP-13 例外清单漏了三个 `role="dialog"` 面**（`BotAvatarQuickView`、`FueCallout`、`MermaidViewer`），其中头像预览还在用字面 `z-[60]` / `bg-black/60`。已补进 `measurements/dialog-shell-wp13.txt`，并把那两处换成 `z-dialog-nested` / `bg-scrim`。
  7. **本文件与 `manifest.json` 的 head / 提交数 / 单测数过期**（指向 `478929a4`、29 提交、212/2974），且偏差项只写了 `07-drawer` 缺 before 图。已更正，并补上 `06-group`。
- 已知失败（改代码前就有 / 新引入）：**无**。

## 截图证据

- 证据包路径：`artifacts/ui-upgrade-b/`
- before/after 是否同一 fixture、同一 CSS 视口：是。同一个 `e2e/ui-upgrade-before.spec.ts`、同一套 mock fixture、同一视口与 DPR；before 在 base 提交、after 在 head 提交各跑一次。
- 矩阵覆盖：1440×900（DPR 1）与 Pixel 7 412×839（DPR 2.625），浅 / 深各一套，chromium；每个视口每套 20 张。
- DPR 记录位置：`manifest.json` 的 `matrix.dpr`，以及 `touch-targets-wp4.jsonl` 每条记录里的 `deviceScaleFactor`。
- 未拍到的场景：抽屉的 before（见上）；交互表单的「进行中」状态（fixture 里没有 elicitation；表单改版由组件测试的 class 断言 + 07 after 覆盖）；真实 Safari；真实设备。

## 预览服务（可选）

- 是否提供：否。
- 说明：没有对外服务、没有隧道、没有改防火墙、没有写凭据。验收请直接看截图包与仓库。
- 本地复现：`node ./scripts/verify-stack.mjs up --router-ready` 起隔离栈；截图用
  `UI_SHOTS_DIR=../../artifacts/ui-upgrade-b/after/m390 UI_THEME=light bunx playwright test e2e/ui-upgrade-before.spec.ts --project=chromium-mobile`（`d1440` + `chromium-desktop` 同理）。

## 剩余风险与需要视觉判断的点

- 需视觉验收的包（至少这几个）：**WP-5**（发丝边 / 代码凹面）、**WP-9**（玻璃三档）、**WP-10**（三条手机顶栏）、**WP-12**（交接行与 tooltip）、**WP-15**（空 Bot 页）、**WP-16**（设置分组卡）、**WP-17**（抽屉与交互表单）。其余是 token 迁移与组件收敛，可走代码审。
- 热区是否改变了布局或视觉高度：**是**，已写明。触屏下：`copy-button` 22→44（真实占位变大）、`instance-nav-*` 分段 24→44 高、`transcript-speaker` 行高 +24、群组顶栏成员盘 36→44（胶囊随之变高，仍在 52px 栏内）。桌面细指针完全不变（全部写在 `@media (pointer: coarse)` 内）。
- 17px→现有 token 的映射、危险深色文字、玻璃合成背景上的次要比度：均见 `measurements/contrast-wp{1,2,3,5}.txt`、`type-wp8.txt`。都是实测值。
- Composer 动画是否被触碰：**否**。`ConversationComposer.vue` 的动画、过渡属性、时长、缓动、圆角变换全未改。WP-15 只给 `ConversationPromptInput` 增加了 `fillDraft()`（写草稿、置光标、收起补全），不发送。
- 真实 Safari 是否未测：**是**，未测。

## 声明

实现已按方案 B 完成到上述范围，但不等于 UI 验收通过。请 Gadzan 将本回传与证据包转交视觉验收。未获合并或部署授权。
