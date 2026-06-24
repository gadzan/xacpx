# relay-web 「改动」交互重构 — 设计文档

- 日期：2026-06-24
- 状态：待评审
- 范围：relay-web 工作空间「改动 / Changes」面板 + 文件查看器；core 端 `workspace-fs` git 解析。
- 参考实现：`/Users/maijiazhen/Projects/hapi/web/`（Shiki 高亮 + 结构化 diff），及既有竞品分析 `docs/superpowers/specs/2026-06-15-hapi-borrow-analysis-and-spec.md`（本次正是兑现其中 deferred 的两项：staged/unstaged 分离视图 + syntax 高亮）。

## 1. 目标

把 relay-web 左侧「改动」与文件查看体验从「粗糙」提升到可日常使用：

1. **修正 CJK 文件名乱码与点击失效**：非 ASCII 文件名（如 `src/首页.ts`）当前显示成 `\351\246\226…` 八进制转义串，点击后 `git diff -- <转义串>` 匹配不到 → 报「not found」/空 diff。
2. **暂存 / 已改 / 未跟踪分组展示**：当前是一个扁平列表，仅展示原始 2 字符 `XY` 码徽标。
3. **更友好的文件查看与 diff 查看**：
   - 文件查看：Shiki 语法高亮（这是 Shiki 的主场）。
   - diff 查看：从「扁平 `<pre>` 逐行着色」升级为结构化、带双行号的 tinted 行视图（**对齐 HAPI：diff 不做语法高亮**）。
4. **长路径不再溢出，且有完整路径 tooltip**。

## 2. 根因（当前实现）

- `src/control/workspace-fs.ts:203` 执行 `git -C <root> status --porcelain`（**未带** `core.quotePath=false`/`-z`），非 ASCII 路径被 git 八进制转义并加引号；解析后原样回传前端。后续单文件 diff 用这个转义路径去 `git diff --` 匹配不到。Files 标签的角标（同一份 `changed` 映射）也因此对 CJK 文件失效。
- `FilesPanel.vue:265-275`：改动列表是单一扁平 `v-for`，徽标直接显示 `f.status.trim()`（原始 `XY`）。行用 `truncate` 且**无 `title`**，长路径被截断且无法看全。
- `FileViewer.vue:80-85`：单文件 diff 仅把 unified diff 文本 `split('\n')` 后逐行套颜色 class，放进 `<pre>`，无行号、无 hunk 结构。
- 未跟踪文件：`git diff HEAD -- <untracked>` 输出为空，点击未跟踪文件看到空 diff。

## 3. 非目标（YAGNI / 范围护栏）

- **不**做 staged-vs-unstaged 的**独立 diff**（点击任一文件统一展示「相对 HEAD」的 diff；未跟踪文件特殊处理见下）。分组仅作信息呈现。
- **不**做并排 side-by-side diff。
- **不**对 diff 行做语法高亮（对齐 HAPI 的取舍：unified diff 高亮需重建每个 hunk 的 old/new 块再回填 token，复杂且流式下有性能成本，收益有限）。
- **不**在面板内做文件编辑 / 暂存 / 提交等写操作。
- **不**做文件搜索（`rg --files`）。

## 4. 分层设计

### 4.1 Core：`src/control/workspace-fs.ts`（根因层，最高优先）

**(a) 路径编码修复（核心）**：把 git status 调用改为
`git -C <root> -c core.quotePath=false status --porcelain -z`，并按 `NUL` 分割解析（而非 `\n`）。`-z` 输出永不加引号 / 转义，CJK 路径原样返回。

- `-z` 下重命名/复制项为「两个 NUL 字段」（先 `new\0old` 之后还有一段），解析时需正确消费第二个字段，取 `new` 作为展示路径。
- `status` 仍是行首 2 字符 `XY`；`path` 为其后内容（去掉 1 个分隔空格）。

这一处同时修复：乱码文件名、点击→not-found（回传路径现与 `git diff -- <path>` 一致）、Files 标签角标。

**(b) 未跟踪文件 diff**：`gitDiff(workspace, path)` 中，当目标单文件属于未跟踪（status `??`）且常规 `git diff HEAD -- <rel>` 为空时，回退为
`git -C <root> -c core.quotePath=false diff --no-index -- /dev/null <abs>`，并**容忍 git 「有差异返回码 1」**（execFile 会 reject，需捕获并取其 stdout）。使未跟踪文件以「全增行」形式渲染。仍受 512 KiB `DIFF_CAP` 约束。

**(c) 协议不变**：`WorkspaceDiff` / `FsDiffFileDto`（`{path, status}`，2 字符 `XY`）已足够前端分组，**无需改 relay-protocol、control-bridge、control-service**。

### 4.2 Files store：`packages/relay-web/src/stores/files.ts`

- 不改变 RPC（仍 `control.fs.diff`）。新增由 `files[].status` 推导的分组 getter（见 4.3 的 `XY` 规则），供 `FilesPanel` 消费。
- 文件查看器需要语言推断：在 store 或组件层提供「路径 → 语言」解析（见 4.4）。

### 4.3 改动列表：`packages/relay-web/src/components/FilesPanel.vue`

**三段分组**（解析每文件的 `XY`：`X`=暂存区/index，`Y`=工作区）：

- **Staged**：`X ∈ {M,A,D,R,C}`
- **Changes**：`Y ∈ {M,D}`（含 `T` 等价并入 M 视情况）
- **Untracked**：`status === "??"`

一个既暂存又有未暂存改动的文件会**同时**出现在 Staged 与 Changes（与 git 自身心智一致）。每段：

- 折叠/展开（`<details>` 或自管状态），段标题带计数，空段隐藏。
- 折叠状态持久化到 `localStorage`，沿用既有 `xacpx.*` 键命名（如 `xacpx.changes.collapsed`）。

**文件行**：

- 文件名（basename）正常字重 + 目录前缀 muted/小字，单行 `truncate`。
- 真实 `title` 属性承载**完整相对路径**（tooltip）。
- 一个小状态字形（A/M/D/R/?）带语义色，取代原始 2 字符徽标。

**Files 标签角标**：`entryStatus()` 复用同一份（现已正确解码的）`changed` 映射，CJK 文件自动恢复正常。

### 4.4 文件查看 + Shiki：`packages/relay-web/src/components/FileViewer.vue` + 新建 `src/lib/shiki.ts`

**依赖**（对齐 HAPI v3）：`shiki` + `@shikijs/langs` + `@shikijs/themes`（`^3.x`）。

**`src/lib/shiki.ts`（高亮层，单例 + 懒加载）**：

- 用 `createHighlighterCore`（`shiki/core`）+ **`createJavaScriptRegexEngine({ forgiving: true })`** —— **JS 正则引擎，不引入 WASM**（直接回应体积顾虑）。
- 单例 `highlighterPromise`，首次使用时创建。
- 语言：参照 HAPI 选取一组常用语言（shell/powershell/json/yaml/toml/xml/ini/markdown/html/css/scss/js/ts/jsx/tsx/sql/graphql/c/rust/go/java/kotlin/python/php/swift/csharp/dockerfile/make/diff 等），以 `import('@shikijs/langs/<x>')` 动态导入数组传入。
- 主题：`{ light: 'github-light', dark: 'github-dark' }`，`defaultColor: false`，输出 Shiki 双主题 CSS 变量。
  - 代码 token 用 github 主题（约定俗成、可读）；**不**强行套品牌蓝绿色（品牌色用于 UI chrome，不用于语法 token）。
- 渲染：`codeToHast` + Vue 渲染（或对 Vue 更简单的 `codeToHtml` + `v-html`，二者择一，实现时定）。`structure: 'inline'`。
- 语言推断：路径扩展名 → 语言别名表（`ts→typescript`、`py→python`、`rs→rust`、`yml→yaml`…），未知 / 无扩展名回退纯文本（不高亮，原样显示）。
- **未加载语言优雅降级**：`getLoadedLanguages()` 不含目标语言时回退纯文本。
- **整个 `src/lib/shiki.ts` 经动态 `import()` 引入**（code-split），不进入初始 bundle；首次打开文件/diff 时才拉取该 chunk。
- 借鉴 HAPI：高亮可做 **~150ms 防抖**（降低快速更新时的 CPU 压力）。

**FileViewer 文件查看**：

- 沿用「行号 gutter + 内容」两列结构与 `LINE_GUTTER_LIMIT = 5000` 上限（超限仍降级为纯 `<pre>` 不高亮）。
- 内容列改为 Shiki 高亮输出（保留 gutter 列）。
- **CodeBlock 折叠**（借鉴 HAPI）：超长文件折叠到固定高度 + 渐隐 + 「展开」提示（阈值参考 HAPI：约 18 行 / 1800 字符 → 折叠高度 ~260px）。binary / truncated 徽标保留。

**FileViewer diff 查看**（对齐 HAPI，结构化但**不高亮**）：

- 新增小型 **unified-diff 解析器**：把后端 unified diff 文本解析为 hunk，每行 `{type: add|del|context|hunk, oldNo, newNo, text}`。
- 渲染为 tinted 行：双行号列（old / new）+ `+`/`-`/` ` 前缀列 + 内容；add/del 行用语义背景色（沿用现有 `text-run`/`text-danger` 对应的 bg 语义或新增 `--diff-*` 变量）。
- `@@` hunk 头渲染为 muted 分隔行。
- 头部 `+N/−N` 统计徽标（从解析结果统计）。
- 保留 >5000 行 `<pre>` 快速降级路径与 `truncated` 徽标。

### 4.5 主题 CSS：relay-web 暗色机制对齐

relay-web 用 Tailwind `darkMode: "class"`——`.dark` 类挂在 `documentElement`（`stores/theme.ts` 切换）。Shiki 双主题 CSS 变量覆盖选择器须用 **`.dark`** 而非 HAPI 的 `html[data-theme=dark]`：

```css
.shiki, .shiki span { color: var(--shiki-light); }
.dark .shiki, .dark .shiki span { color: var(--shiki-dark); }
```

### 4.6 i18n

`packages/relay-web/src/i18n/messages/{en,zh-CN}.ts` 新增：

- 分组标题：`changes.staged` / `changes.changes` / `changes.untracked`。
- 折叠/展开、完整路径 tooltip、代码折叠「展开 / truncated」等文案。

## 5. 体积闸门（size gate）

实现的**第一步**先量化：接入 Shiki（fine-grained + JS 引擎 + code-split）后构建 relay-web，报告实际 chunk 体积。预期：

- 初始 bundle delta ≈ 0（高亮层走独立懒加载 chunk）。
- 首次打开文件触发的高亮 chunk gz 目标 < ~200 KB。

若超出预算，回退到 highlight.js（curated 语言）。HAPI 已用 JS 引擎规避 WASM 并接受其体积，预期无需回退。

## 6. 测试

**Core**（`tests/unit/control/workspace-fs.test.ts`，真实临时 git 仓库）：

- 非 ASCII 文件名（如 `src/首页.ts`）在 `files[].path` 中**原样、未转义**返回。
- 未跟踪文件单文件 diff 非空（呈现为增行）。
- 重命名项在 `-z` 解析下取 `new` 路径、不串字段。

**Frontend**（vitest，`npx vitest run`）：

- unified-diff 解析器：hunk / 双行号计算正确（add 不增 old 号、del 不增 new 号、context 双增）。
- `XY` → 三段分组的桶分类（含「既 staged 又 changed」同时入两段、`??` 入 Untracked）。
- 文件行 `title` 承载完整相对路径。
- 未跟踪文件点击渲染为增行。
- Shiki 层：未知/无扩展名回退纯文本；（高亮渲染本身可做轻量 smoke，避免在 jsdom 跑重引擎可 mock）。

## 7. 发布 / 回滚

- 本改动横跨 core（`workspace-fs`）与 relay-web。core 侧改动需随 core 版本发布；relay-web 为 hub 静态资源，随对应包发布。具体版本号与发布顺序遵循既有版本耦合约定（`package.json` + `package-metadata.test.ts` + `weacpx-compat`），实现/发布阶段确认。
- 风险点：`-z` 解析逻辑（重命名字段）、`--no-index` 返回码 1 的捕获、Shiki 懒加载 chunk 体积。均有对应测试 / 闸门兜底。
- CHANGELOG 用英文（沿用项目约定）。

## 8. 关键取舍小结

| 决策 | 选择 | 理由 |
|---|---|---|
| 文件名编码 | `-z` + `core.quotePath=false` | 永不转义，根治 CJK 乱码 + 点击失效 |
| 列表分组 | 三段 Staged/Changes/Untracked | 贴合 git 心智，满足需求 |
| 高亮库 | Shiki v3 + JS 正则引擎（无 WASM） | 文件查看主场；对齐 HAPI；规避 WASM 体积 |
| 高亮加载 | 单例 + 动态 import code-split + 150ms 防抖 | 初始 bundle ≈0，性能可控 |
| diff 高亮 | **不**做（仅结构化 tinted 行） | 对齐 HAPI；复杂度/性能不划算 |
| 主题 | github-light/dark 双主题 CSS 变量，`.dark` 选择器 | 对齐 relay-web class 暗色机制 |
| 未跟踪 diff | `git diff --no-index /dev/null <file>` | 让未跟踪文件可见为增行 |
