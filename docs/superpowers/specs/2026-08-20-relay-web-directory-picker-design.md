# relay-web 目录选择器（跨实例）设计

日期：2026-08-20
状态：待评审

## 背景与目标

relay-web 有两处需要输入实例上的**绝对路径**作为 workspace cwd，目前只能手敲：

1. `NewSessionDialog.vue` 的「新路径」模式（`wsMode === "path"`，提交时 `control.workspaces.create` 持久化）；
2. `ManageInstanceDialog → WorkspacesManager.vue` 的新增工作区表单（name + path + description）。

目标：两处路径输入框旁新增「选择目录」按钮，打开一个仿系统目录选择器的弹窗，**浏览目标实例的文件系统**、逐层进入目录并确认，把绝对路径回填输入框。实例可能在远程机器上，所以浏览器原生能力不可用，必须走实例 RPC——天然跨实例。

## 非目标

- 不改 `control.fs.list`（它按设计被 workspace 三道闸约束，见 `src/control/workspace-fs.ts` 头注释）；
- 不支持选文件（只要目录）；不提供新建目录；
- 不做收藏/最近路径持久化；
- 微信端不涉及。

## 方案取舍

- **浏览器原生 `showDirectoryPicker()`**：拿到的是浏览器所在机器的本地路径，远程实例上不存在该路径；且仅 Chromium、仅安全上下文。弃。
- **混合（原生优先 + RPC 兜底）**：Web 无法判断实例是否与浏览器同机，无法可靠分流。弃。
- **实例 RPC 目录浏览器（选定）**：新增 `control.fs.browse`，在实例侧列目录。账号本来就能 `control.workspaces.create` 指向任意 cwd 再 `fs.list` 它，浏览目录名不引入新的能力类别（详见「安全模型」）。

## 协议（packages/relay-protocol/src/messages.ts）

```ts
fsBrowse: "control.fs.browse"   // MSG 常量，config-global（非 chat-scoped，与 fs.* 一致）

export interface FsBrowsePayload {
  /** 实例上的绝对目录路径；空/省略 = 实例 home；支持 "~" 与 "~/" 展开；相对路径按 home 解析。 */
  path?: string;
}
export interface FsBrowseEntry { name: string; path: string; }
export interface FsBrowseResult {
  /** 规范化后的绝对路径（无尾分隔符；根为 "/"，Windows 盘根为 "C:\"）。 */
  path: string;
  sep: "/" | "\\";
  /** 上一级绝对路径；文件系统根处为 null。 */
  parent: string | null;
  /** 实例用户 home（供「主目录」快捷跳转）。 */
  home: string;
  /** 子目录（含隐藏目录；客户端自行过滤显示），name 排序（大小写不敏感、locale 无关）。 */
  dirs: FsBrowseEntry[];
  /** 目录数达到上限被截断时为 true。 */
  truncated: boolean;
}
```

`payload-validators.ts`：`validateFsBrowse = (p) => optStr(p.path) ? p : null`，注册进 `VALIDATORS`。

## 实例侧（src/control/control-service.ts）

新增 `browseDirectories(path?: string): Promise<FsBrowseResult>`：

- **不走 `WorkspaceFs`**——那个类的安全模型是 workspace 白名单 + realpath 包含，与「选一个还没注册的目录」目的相反。这是独立方法：
  - `home = os.homedir()`；空/`~` → home；展开 `~` 前缀（把 `workspace-fs.ts` 里模块私有的 `expandHome` 导出复用）；相对路径 `path.resolve(home, p)`；
  - `fs.readdir(dir, { withFileTypes: true })`，保留 `isDirectory()`，symlink 经 `stat` 判定目标是目录（坏链、stat 失败静默跳过）；
  - 排序 `localeCompare(undefined, {sensitivity:"base"})` 之外的稳定方式：`a.name.toLowerCase() < b.name.toLowerCase()`（locale 无关，避免实例间差异）；
  - 上限 `MAX_BROWSE_ENTRIES = 1000`，超出置 `truncated: true`；
  - `parent = path.dirname(p)`，当 `dirname(p) === p`（POSIX `/`、Windows 盘根）时为 `null`；
  - `sep = path.sep`。
- **错误**：ENOENT / ENOTDIR / EACCES 直接抛 `Error`（带 code），沿用 bridge 现有 catch → `errorPayload` 路径，客户端弹窗内联显示并停留在当前列表。

`packages/channel-relay/src/control-bridge.ts`：`case MSG.fsBrowse` → payload 校验 → `return await control.browseDirectories(input.path)`，与 `fsList` 同形。

### 安全模型

- hub `POST /api/instances/:id/rpc` 已有账号-持有实例门 + 只放行 `control.*`；browse 的可见范围与 `workspaces.create`（接受任意 cwd）+ `fs.list` 的既有信任面等价——账号被视为实例机器的信任方。
- 只返回**目录名**，不返回文件、不返回内容；响应上限 1000（服务端读取整目录后排序截断）；不含 mtime/权限等元数据，降低指纹价值。

## Web（packages/relay-web）

新组件 `src/components/DirectoryPicker.vue`：

- Props：`instanceId: string; initialPath?: string`；emits：`confirm(path: string)`、`close`。
- 集成处打开时把输入框已有值作为 `initialPath`（有值即直接定位该目录；为空走服务端默认 home）。
- `Teleport to body` + `useModalA11y`（同 `NewSessionDialog`：焦点圈定、Esc 关闭、焦点还原）。
- **导航即确认模型**（OS 选择器惯例）：点目录行 = 进入；底部主按钮「选择此目录」确认当前目录。移动端友好、无需双击。
- 顶部：可编辑路径框（Enter 跳转，`~` 展开、相对路径同服务端语义）+ 面包屑段可点；「主目录」快捷按钮（`result.home`）。
- 隐藏目录：客户端过滤 name 以 `.` 开头，默认隐藏，提供「显示隐藏目录」开关（每次打开重置为隐藏，不持久化）。
- 键盘：↑/↓ 移动高亮、Enter 进入、Backspace 上一级、Esc 关闭。
- 异步守卫：导航用递增 seq 丢弃迟到响应（同 `nativeSessions` 模式）；加载中显示 loader，错误内联显示且保留上一次列表。
- `truncated` 为真时列表尾部显示截断提示行。
- 数据获取：组件内直接 `unwrap(await api.rpc(instanceId, "control.fs.browse", { path }))`，不建 store（无跨组件共享状态）。

集成（均为纯 UI 增强，提交流程不变）：

- `NewSessionDialog.vue` 路径模式：输入框右侧 `FolderOpen` 图标按钮（`data-test="ns-ws-browse"`）打开 picker；确认回填 `workspacePath`。
- `WorkspacesManager.vue` 新增表单：path 输入框右侧同样按钮（`data-test="wm-browse"`）；确认回填 `path`。

## i18n（en + zh-CN 镜像，缺一即 parity 测试失败）

`dirPicker.title / chooseCurrent / home / up / showHidden / empty / truncated / loadFailed / pathPlaceholder` + 两处按钮 aria-label（`session.browsePath`、`workspaces.browsePath`）。

## 测试

- `tests/unit/packages/relay-protocol/messages.test.ts`：`fsBrowse` 常量 + payload validator。
- `tests/unit/control/control-service-browse.test.ts`（新）：默认 home、`~` 展开、相对路径解析、只列目录（文件被滤）、隐藏目录包含、排序、cap+truncated、symlink→目录包含、ENOENT/EACCES 抛错、根 parent 为 null（用真实 tmpdir）。
- `tests/unit/packages/channel-relay/control-bridge.test.ts`：fsBrowse 映射 + 非法 payload → `invalid-payload`。
- `packages/relay-web/src/__tests__/directory-picker.test.ts`（新）：mock `api.rpc`——首次加载、进入子目录、上一级、home 跳转、隐藏开关、choose 触发 `confirm(当前path)`、迟到响应丢弃、错误内联。
- `i18n-parity.test.ts` 自动覆盖新 key。

## 文档

- `docs/relay-module.md`：RPC 表补 `control.fs.browse`（config-global、目录-only、上限 1000）。
- `docs/relay-web-module.md`：NewSessionDialog 与 ManageInstanceDialog/WorkspacesManager 小节补目录选择器说明。
