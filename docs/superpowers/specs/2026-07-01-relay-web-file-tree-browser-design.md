# relay-web 文件树浏览器（子项目 A：只读树 + 高级搜索 + gitignore 感知）

状态：设计已确认，待评审
日期：2026-07-01
分支：feat/relay-web-file-tree（off main ff05dae）

## 范围拆分

原始需求（6 条）拆成两份 spec，本 spec 只覆盖 **A（只读浏览体验）**：

- **A（本 spec）**：树视图、gitignore/点文件 样式+切换、高级搜索（文件名 + 内容 grep）、移动端满宽、右键菜单里**无副作用**的项（复制路径/复制相对路径/在此文件夹搜索）。全部**只读**，无文件系统写入，不新增 config 门。
- **B（另开 spec）**：写/执行能力——新建文件、新建文件夹、复制(副本)、重命名、删除、下载、在 OS 文件浏览器打开。安全门控（默认关）。A 把右键菜单骨架搭好，B 往里加项。

## 背景

当前 Files 面板（`FilesPanel.vue` + `stores/files.ts`）是**逐目录扁平列表** + 面包屑 + 向上按钮；搜索是相对路径子串扁平匹配；无 gitignore/点文件 感知；整条 `control.fs.*` 链只读。后端 `WorkspaceFs.resolve()` 是唯一收口（workspace 名白名单 + realpath 包含检查，符号链接安全），所有方法都走它。

## 目标 / 非目标

**目标**
- Files tab 改为懒加载**树视图**（去面包屑/向上按钮），文件夹展开/折叠图标 + 按扩展名的多类型文件图标。
- gitignore 命中项与点文件：默认隐藏，两个切换可显示；显示时以**低透明度 + 斜体**呈现（视觉"被忽略"感）。
- 高级搜索：**精确大小写 / 匹配整词 / 正则** 三开关 + **包含/排除 glob** 两字段 + **[文件名 | 内容]** 模式切换；内容模式为 grep。
- 右键菜单（A 子集）：复制路径（主机绝对路径）、复制相对路径（workspace 根相对）、在此文件夹搜索（文件夹）。
- 移动端右栏抽屉满屏宽。

**非目标（留给 B）**
- 任何文件系统写入（新建/重命名/删除/复制副本）、下载、在 OS 打开。
- 内容搜索命中的语法高亮、跨文件替换。
- 跳转到具体行（FileViewer 若不支持行定位，A 只负责打开该文件，跳行尽力而非必须）。

## 架构

relay-web 前端为主 + 少量**只读**后端扩展。数据路径不变：relay-web `files` store → `control.fs.*` RPC → hub `/rpc`（ownership 门）→ connector `control-bridge` → core `ControlService` → `WorkspaceFs`。安全模型三道闸沿用（account-owns-instance → workspace 名白名单 → realpath 包含）。**本子项目只读，不加 config 门。**

新增/变化的后端能力全部作为 `WorkspaceFs` 上的新逻辑或现有方法的扩展，复用同一 `resolve()`，不另开路径。

## 组件与数据流

### 1. 树视图（需求 1）

- **前端**：`FilesPanel.vue` 的 Files tab 用递归树组件（新增 `FileTree.vue` + 递归 `FileTreeNode.vue`，或 `FilesPanel` 内递归渲染）。根 = workspace 根目录（进入即列根层）。展开一个文件夹时，若其子项未加载，调用现有 `control.fs.list({workspace, path})` 拉该目录一层，缓存到节点。折叠只隐藏、不丢缓存。
- 去掉面包屑区块与 `data-test="fs-up"` 向上按钮及 `upOne()`。保留顶部 workspace 标签 + 刷新按钮（刷新=清树缓存并重列已展开层）。Changes tab 完全不动。
- **图标**：文件夹展开态 `FolderOpen`、折叠态 `Folder`，前置 `ChevronDown`/`ChevronRight`。文件按扩展名映射 lucide 图标，新增 `src/lib/file-icons.ts`（纯函数 `iconForFile(name) → Component`），覆盖约 18 类：ts/js/tsx/jsx→FileCode、json→FileJson、md→FileText、png/jpg/svg/gif/webp→FileImage、css/scss→FileType、html/vue→FileCode、yml/yaml/toml/ini/env→FileCog、lock→FileLock、sh→FileTerminal、zip/tar/gz→FileArchive、pdf→FileText、默认→File。零新依赖（全来自 lucide-vue-next）。
- **展开态持久化**：按 workspace 存 `localStorage["xacpx.fileTree.expanded.<ws>"]`（展开目录相对路径集合）。挂载时恢复并预拉这些层。
- 点文件 → 仍走 `files.open(entry)` 在中间 FileViewer 打开（不变）。选中项高亮沿用现有 accent 样式；git 状态点徽标沿用现有 `changed` 逻辑，按树节点相对路径匹配。

### 2. gitignore / 点文件（需求 2、5）

- **后端**：`FsEntryDto` 增加可选 `ignored?: boolean`。`WorkspaceFs.listDirectory` 在 readdir 后，对本层条目批量跑 `git check-ignore -z --stdin`（cwd = workspace 根），命中者标 `ignored:true`；workspace 非 git 仓库或 git 缺失 → 全部 `ignored` 省略（视为未忽略），不报错。dotfile **不**由后端标记——前端按 `name.startsWith(".")` 判定。
- **前端**：两个切换 `showDotfiles`、`showGitignored`，**默认关**，各存 localStorage。过滤规则：`ignored` 项在 `showGitignored=false` 时隐藏；dotfile 在 `showDotfiles=false` 时隐藏（两条件独立，一个项可能既是 dotfile 又 ignored，任一开关关闭即隐藏其对应维度——实现为"要显示该项，需满足 (非 ignored 或 showGitignored) 且 (非 dotfile 或 showDotfiles)"）。
- **样式**：显示出来的 ignored 或 dotfile 项，行文字用**低透明度**（如 `opacity-45` / `text-fg-muted/50`，视觉融入背景）**+ 斜体**（`italic`）。两类可共用同一"淡化"样式类。
- 默认隐藏使 `node_modules`（通常 gitignored）与 `.git`（dotfile）自然不出现在树里，避免大目录卡顿。

### 3. 高级搜索（需求 3）

- **UI**（Files tab 顶部搜索区扩展）：主查询输入框 + 三个可点亮开关按钮 **Aa（精确大小写）/ ￧（匹配整词）/ .\*（正则）**（沿 VSCode 惯例，放输入框右侧），下方两个小输入 **包含(glob)** / **排除(glob)**，以及一个模式切换 **[文件名 | 内容]**。开关/模式状态存 localStorage。查询 250ms 防抖。
- **协议**：`FsSearchPayload` 扩展为 `{ workspace, query, mode: "name" | "content", matchCase?: boolean, wholeWord?: boolean, regex?: boolean, include?: string, exclude?: string, path?: string }`（`path` = 作用域基目录，供"在此文件夹搜索"；缺省=整个 workspace）。`FsSearchResult` 扩展为 `{ workspace, query, matches: string[], hits: FsSearchHitDto[], truncated: boolean }`，其中 `FsSearchHitDto = { path: string; line: number; text: string }`；名字模式只填 `matches`，内容模式只填 `hits`。
- **后端**（`WorkspaceFs.search`）：
  - `mode:"name"`：现有 BFS 路径匹配的增强——支持 `matchCase`/`wholeWord`/`regex` 应用于路径，`include`/`exclude` 作为 glob 过滤，`path` 限定起始目录。上限沿用（扫描/结果 cap）。
  - `mode:"content"`：优先 `git grep`（`git grep -n --column -I --no-color`，`-i` ←!matchCase 时加、`-w` ←wholeWord、`-E`/`-F` ←regex 与否，pathspec 追加 `-- <path 或 .>` 及 include/exclude 转成的 `:(glob)`/`:(exclude,glob)`）；非 git 仓库或 git 缺失时**回退**手写走查（复用现有 BFS + 逐行匹配，跳过 `.git`/`node_modules`、不跟符号链接、尊重 read cap）。结果 cap（如 ≤200 文件、≤500 命中，超出置 `truncated`）。
  - 两模式都不返回 ignored/大二进制文件的内容命中（`-I` 跳二进制；回退路径按现有 binary 判定跳过）。
- **前端渲染**：名字模式=现有扁平列表（复用）。内容模式=按文件分组，组内列出 `行号: 行预览`，点某命中 → `files.openFile(path)` 打开该文件（跳行尽力）。`truncated` 时显示"仅显示前 N 条"。
- **在此文件夹搜索**（右键项）：设 `path` = 该目录相对路径 + 聚焦搜索框（默认内容模式），把作用域限定到该子树。

### 4. 右键菜单骨架（需求 4 的只读子集）

- 新增通用右键菜单组件（`ContextMenu.vue`，绝对定位、点击外部/Esc 关闭、贴边翻转防溢出），供树节点使用；设计成可注入菜单项数组，B 复用同一组件追加写操作项。
- **A 的菜单项**：
  - 文件 & 文件夹：**复制路径**（主机绝对路径）、**复制相对路径**（workspace 根相对路径）。
  - 文件夹另加：**在此文件夹搜索**。
- **复制路径 = 主机绝对路径**：需要主机绝对根。`FsListResult` 增加 `root: string`（`resolve()` 已 realpath 的工作区绝对根）与 `sep: "/" | "\\"`（主机分隔符）。前端"复制路径" = `root + sep + relPath.split("/").join(sep)`；"复制相对路径" = `relPath`（workspace 根相对，内部用 `/`）。二者经 `navigator.clipboard.writeText`，失败静默。
  - **安全说明**：这会向已通过 ownership 的属主暴露 connector 主机的绝对目录布局。属主本就能浏览该 workspace 内容，风险等同现状 + 主机路径前缀；用户明确要此行为。不改变任何写能力。

### 5. 移动端满宽（需求 6）

- `DashboardView.vue` 右栏抽屉（`data-drawer="right"`）在 `<lg`（移动端抽屉态）宽度从 `w-72 max-w-[85%]` 改为**满屏宽**（`w-full`，去掉 `max-w-[85%]` 上限；`lg:` 静态列宽度与拖拽逻辑不变）。左栏与 backdrop 不动。

## 协议变更汇总（relay-protocol）

- `dtos.ts`：`FsEntryDto` 增 `ignored?: boolean`；新增 `FsSearchHitDto { path: string; line: number; text: string }`。
- `messages.ts`：`FsListResult` 增 `root: string`、`sep: "/" | "\\"`；`FsSearchPayload` 增 `mode/matchCase/wholeWord/regex/include/exclude/path`（除 `mode` 外均可选；`mode` 缺省视为 `"name"` 以兼容）；`FsSearchResult` 增 `hits: FsSearchHitDto[]`（`matches` 保留）。
- 全部**向后兼容增量**（新字段可选/有缺省），protocol 保持 0.1.x（沿用 `^0.1.0` range，见 [[reference_release_version_coupling]]）。

## 边界与文件结构

- `src/lib/file-icons.ts`（新）：`iconForFile(name)` 纯函数，单一职责=扩展名→lucide 组件。
- `FileTree.vue` / `FileTreeNode.vue`（新）：递归树渲染 + 展开/折叠 + 懒加载调用；节点样式（选中/ignored/dotfile 淡化/git 徽标）。
- `ContextMenu.vue`（新）：通用菜单，菜单项由父组件注入。
- `FilesPanel.vue`（改）：Files tab 换成树 + 新搜索区；去面包屑/向上；Changes tab 不动。
- `stores/files.ts`（改）：树节点缓存与展开态、搜索参数与 hits、`root`/`sep`。保持 store 为唯一数据/RPC 入口。
- `src/control/workspace-fs.ts`（改）：listDirectory 加 ignored 标记 + 返回 root/sep；search 加 mode/flags/include/exclude/path 与内容 grep。
- `packages/channel-relay/src/control-bridge.ts`（改）：透传扩展后的 search payload 字段（list 无需改签名）。

## 测试计划

- **后端（bun，tests/unit/control/workspace-fs.test.ts 扩展）**：
  - listDirectory 在 git 仓库里对 gitignored 条目标 `ignored:true`；非 git 仓库不标、不报错；返回的 `root` 为绝对 realpath、`sep` 合理。
  - search name 模式：matchCase/wholeWord/regex/include/exclude/path 各自生效；content 模式：git grep 命中返回 {path,line,text}，非 git 回退走查命中，二进制跳过，超限置 truncated。
  - path-traversal 守卫对新 search path 仍生效（`..`/符号链接不越界）。
- **前端（vitest，cwd=packages/relay-web）**：
  - 树：展开触发懒加载 list、折叠保留缓存、展开态持久化恢复；文件夹开/合图标切换；`iconForFile` 映射若干扩展名。
  - ignored/dotfile：默认隐藏；开关打开后出现且带淡化+斜体类；组合过滤逻辑正确。
  - 搜索：三开关 + include/exclude + 模式切换驱动正确的 `control.fs.search` payload；内容 hits 分组渲染；名字 matches 渲染；truncated 提示。
  - 右键菜单：复制路径=`root+sep+relpath`、复制相对路径=relpath（mock clipboard 断言写入值）；文件夹"在此文件夹搜索"设置作用域 path。
  - DashboardView：移动端右栏抽屉满宽（`w-full`、无 `max-w-[85%]`）。
- i18n：新增 en/zh 键（树/搜索开关/菜单项/切换标签），`i18n-parity` 守卫。

## 风险与缓解

- **git check-ignore 每次展开一调**：懒加载下每目录一次，可接受；结果随该层缓存，折叠再展开不重调（除非刷新）。非 git/无 git 静默跳过。
- **内容 grep 体量**：`git grep` 天然尊重 gitignore、快；回退走查有扫描/结果 cap + 二进制/大文件跳过，避免拉爆。命中 cap + truncated 提示。
- **主机绝对路径暴露**：属主可见、经 ownership 门，用户明确要；不引入任何写能力。
- **大目录**：默认隐藏 gitignored+dotfiles 使 node_modules/.git 不进树；单层仍受 `MAX_ENTRIES=2000` 保护。
- **跳转到行**：FileViewer 现不支持行定位，A 只保证打开文件，跳行为尽力（不阻塞）。

## 版本 / 发布

随下一个 core/relay 版本发布（web 静态资源由 hub 提供）。协议增量兼容、保持 0.1.x。B 子项目另开分支/spec。
