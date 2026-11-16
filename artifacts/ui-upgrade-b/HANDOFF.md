# 方案 B 回传

## 范围

- 仓库：https://github.com/gadzan/xacpx
- 工作分支 / 远程（若有）：本地分支 `ui-upgrade-b`。**未推送、未建远程、未合并、未部署。**
- base SHA：`5b89cab95ab95fd412da7341418738f369dcf289`（与审计快照一致，开跑时核对无漂移）
- head SHA（代码）：`478929a4`。证据包与本文件在它之后的提交里（`git log -1` 即本提交）。
- 相对审计快照的差异摘要：29 个提交（代码 head `478929a4`）；`packages/relay-web` 112 文件 +2456/−1228；证据全在 `artifacts/ui-upgrade-b/`
- 已完成工作包：WP-1 … WP-18，**18/18**
- 未做或只做了部分的工作包及原因：无整包未做。偏差如下，均在证据里写明：
  1. **WebKit 未测**：`packages/relay-web/playwright.config.ts` 只有 `chromium-desktop` / `chromium-mobile`，没有 webkit project。真实 Safari 完全未测。
  2. **手机截图是 Pixel 7（412×839 CSS，DPR 2.625），不是 390×844**：before 包与 after 包同一形态，所以对比有效；390×844 用**实测**覆盖（热区、顶栏控件不重叠），没有另拍一套图片。`manifest.json` 的 `matrix.stated_viewport_gap` 记了这条差别。
  3. **`07-drawer` 没有 before 图**：抽屉场景在基线拍完之后才进 harness。before 状态以代码 `c38f4b69` 为准。
  4. `.glass-1` 暂无使用者：三条手机顶栏按 WP-10 保留实底行 + 其上玻璃控件，没有为了凑使用点改布局。
  5. 桌面会话头仍用 `bg-glass-strong` 工具类（与 `.glass-2` 同一套 token），未强行改成类名。

## 测试

- Node / Bun / Playwright：node v24.21.0、bun 1.4.4、@playwright/test 1.62.1（chromium）
- 命令与结果：
  - `bunx vitest run`（`packages/relay-web`）：**212 文件 / 2974 测试通过**，159s。基线 211 / 2969。
  - `bunx vue-tsc --noEmit`：通过。
  - `bunx playwright test`（两个 project 全量，head 上）：**187 passed / 0 failed / 51 skipped**，12.2m。skipped 全部是「只在某个 project 有意义」的用例（手机专属、或未设 `UI_SHOTS_DIR` 的取证 harness）。
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
- 已知失败（改代码前就有 / 新引入）：**无**。上述 7 条都是本轮引入并在本轮修掉。

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
