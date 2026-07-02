# relay-web 文件树写能力（子项目 B）设计

> 子项目 A（只读文件树浏览，PR #108）的续作。B 在 A 的树/右键菜单骨架之上，加入工作区内的文件写操作与下载，全部复用 A 的 `WorkspaceFs.resolve()` 安全闸门。**本设计不含「在 OS 文件浏览器打开」**（评审时砍掉：宿主常无桌面、且是唯一在宿主起进程的高危面）。

**目标：** 让 relay-web 文件树支持工作区内的新文件 / 新建文件夹 / 重命名 / 复制副本 / 删除（永久 + 二次确认）/ 下载（≤5 MiB），写操作由默认关闭的 config 门控保护。

**架构：** 复用 A 已建立的四个面——`WorkspaceFs`（后端 fs）、`ControlService`（结构化门面）、`relay-protocol`（线协议）、`channel-relay/control-bridge`（连接器分发）、`relay-web`（前端）。不新增子系统。所有新路径穿过 A 的 `resolve()` 单一收窄点做容器隔离；写门控照抄 `terminal.enabled` 范式。

**Tech Stack：** TypeScript（Node fs/promises）、relay-protocol（additive → 保持 0.1.x）、Vue 3 + Pinia（relay-web）、vitest（前端）/ bun test（后端/协议）。

## Global Constraints

- **写门控默认关：** 新增 `AppConfig.files?: FilesConfig { writeEnabled: boolean }`；`filesWriteEnabled(config)` 返回 `config.files?.writeEnabled === true`（默认 false）。所有**写**操作（create/rename/delete/copy）在触盘前经门控，关闭时抛 `Error("files-write-disabled")`。**下载不门控**（是读操作，只把 256KB 预览上限提到 5 MiB 的显式读）。
- **容器隔离不可绕过：** 任何新 fs 方法必须经 `WorkspaceFs.resolve()` 或新增的 `resolveParent()`；两者都做 workspace 白名单 → realpath → `abs === root || abs.startsWith(root + sep)` 校验。绝不接受绝对路径、绝不让 `..` 或符号链接逃逸。
- **协议 additive：** 只新增 `MSG.fs*` 类型与 payload/result，不改既有形状 → relay-protocol 停在 0.1.x；改后必须 `bun run build:relay-protocol` 重建 dist。
- **门控 UX 照抄 terminal：** 前端不感知门控状态（无 capabilities 线）；写菜单项常显，调用失败时显示"文件写入未启用，请在实例 config 中开启 `files.writeEnabled`"。
- **不走 shell：** 后端任何子进程一律 argv 数组（本设计砍掉 OS-open 后已无子进程新增，此约束对 duplicate 的递归 cp 仍适用——用 fs API 而非 shell）。
- **回复中文；release/CHANGELOG 用英文。**
- **依赖同步：** 若新增 npm 依赖，必须 `npm install --package-lock-only` 同步根 package-lock.json（本设计不预期新依赖）。

## 分层设计

### 1. 后端：`WorkspaceFs` 写方法（`src/control/workspace-fs.ts`）

现有 `resolve(workspace, relPath)` 对**目标**做 `realpath()`，目标不存在即抛 `not-found` —— 新建/重命名的目标不存在，需新增姊妹方法：

```ts
/** Resolve the PARENT directory of a to-be-created/renamed target. The parent must
 *  exist and be contained; the final segment `name` is validated (non-empty, no path
 *  separators, not "."/".."). Returns the parent's realpath'd abs + the safe join target.
 *  Because parent is canonical+contained and name has no separator, the target stays
 *  inside the workspace root. Throws on unknown workspace, absolute input, missing
 *  parent, escaping parent, or an illegal final segment. */
private async resolveParent(workspace: string, relPath: string): Promise<{ root: string; parentAbs: string; name: string; targetAbs: string; rel: string }>
```

校验规则（`name`）：非空、`!name.includes("/")`、`!name.includes("\\")`、`name !== "."`、`name !== ".."`。`relPath` 为空或指向根 → 抛 `bad-target`（不能在根之上创建）。

新增公开方法（均返回受影响项的规范化 rel，供前端刷新定位）：

| 方法 | 签名 | 语义 / 安全 |
|---|---|---|
| `createFile` | `(workspace, relPath) → Promise<{ path: string }>` | `resolveParent` → 若 `targetAbs` 已存在抛 `already-exists` → `writeFile(targetAbs, "", { flag: "wx" })` |
| `createDir` | `(workspace, relPath) → Promise<{ path: string }>` | `resolveParent` → `mkdir(targetAbs)`（`recursive:false`，已存在则 mkdir 抛 EEXIST → 映射 `already-exists`） |
| `rename` | `(workspace, relPath, newName) → Promise<{ path: string }>` | `resolve(源,须存在+contained)` + 对**同目录** `newName` 做末段校验；目标 = `join(dirname(源abs), newName)`，须在容器内且不存在 → `rename`。拒改根（源 rel==="" 抛 `bad-target`） |
| `duplicate` | `(workspace, relPath) → Promise<{ path: string }>` | `resolve(源,须存在)` → 同级找空位名 `x copy` / `x copy 2` …（`base` 与扩展名之间插入，如 `a.txt` → `a copy.txt`）→ `cp(src, dst, { recursive: true })`（Node fs.cp）。拒复制根 |
| `remove` | `(workspace, relPath) → Promise<{ path: string }>` | `resolve(目标,须存在+contained)` → 拒删根（rel==="" 抛 `refuse-delete-root`）→ **永久** `rm(abs, { recursive: true, force: false })` |
| `readFileBytes` | `(workspace, relPath) → Promise<{ path: string; base64: string; size: number; mimeType: string }>` | `resolve` → `stat` 须是文件 → 超 `DOWNLOAD_MAX`(5 MiB) 抛 `file-too-large` → 读全字节 → base64；mimeType 由扩展名映射（小表，缺省 `application/octet-stream`） |

新增常量：`const DOWNLOAD_MAX = 5 * 1024 * 1024;`

`duplicate` 命名助手（模块级纯函数，可单测）：
```ts
/** Given an existing sibling set and a name, return the first free "NAME copy",
 *  "NAME copy 2"… inserting before the extension. */
export function copyName(existing: Set<string>, name: string): string
```
规则：拆出 `base`/`ext`（`ext` = 最后一个 `.` 起，无点则空）；候选 `${base} copy${ext}`，冲突则 `${base} copy 2${ext}`、`3`…直到不在 `existing`。

**错误码约定**（`Error.message`，前端映射文案）：`files-write-disabled`（门控，在 ControlService 层抛）、`already-exists`、`bad-target`、`refuse-delete-root`、`file-too-large`、以及 `resolve()` 既有的 `unknown-workspace`/`path-must-be-relative`/`not-found`/`path-escapes-workspace`。

### 2. 门面：`ControlService`（`src/control/control-service.ts`）

- `ControlServiceDeps` 新增 `filesWriteEnabled: () => boolean;`（`main.ts` 处传 `() => filesWriteEnabled(config)`）。
- 新增方法，写方法首行门控：
```ts
async fsCreate(workspace, path, kind: "file" | "dir"): Promise<{ path: string }> {
  if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
  return kind === "dir" ? this.workspaceFs.createDir(workspace, path) : this.workspaceFs.createFile(workspace, path);
}
async fsRename(workspace, path, newName): Promise<{ path: string }> { /* gate */ return this.workspaceFs.rename(...); }
async fsDelete(workspace, path): Promise<{ path: string }> { /* gate */ return this.workspaceFs.remove(...); }
async fsCopy(workspace, path): Promise<{ path: string }> { /* gate */ return this.workspaceFs.duplicate(...); }
async fsDownload(workspace, path): Promise<{ path; base64; size; mimeType }> { /* NO gate */ return this.workspaceFs.readFileBytes(...); }
```
写操作成功后**无需** emit 事件（前端主动重列受影响目录即可，与 A 的 refresh 一致；文件树不是多客户端强一致视图）。

### 3. 协议：`relay-protocol`（`src/messages.ts` + `src/dtos.ts` + dist）

`MSG` 新增 5 个（沿用 `control.fs.*` 命名）：
```ts
fsCreate: "control.fs.create",
fsRename: "control.fs.rename",
fsDelete: "control.fs.delete",
fsCopy:   "control.fs.copy",
fsDownload: "control.fs.download",
```
新增 payload/result：
```ts
export interface FsCreatePayload { workspace: string; path: string; kind: "file" | "dir"; }
export interface FsRenamePayload { workspace: string; path: string; newName: string; }
export interface FsDeletePayload { workspace: string; path: string; }
export interface FsCopyPayload { workspace: string; path: string; }
export interface FsDownloadPayload { workspace: string; path: string; }
export interface FsMutateResult { path: string; }         // create/rename/delete/copy 共用：受影响项 rel
export interface FsDownloadResult { path: string; base64: string; size: number; mimeType: string; }
```
改后 `bun run build:relay-protocol` 重建 dist 并 assert。

### 4. 连接器：`channel-relay/control-bridge.ts`

`dispatchControlRequest` 新增 5 个 case，做基本必填校验后转发（镜像现有 `fsRead`/`fsSearch` 风格）：
```ts
case MSG.fsCreate: {
  const i = payload as FsCreatePayload;
  if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
  if (i.kind !== "file" && i.kind !== "dir") return errorPayload("bad-request", "kind must be file or dir");
  return await control.fsCreate(i.workspace, i.path, i.kind);
}
case MSG.fsRename: { /* workspace + path + newName 必填 */ return await control.fsRename(...); }
case MSG.fsDelete: { /* workspace + path 必填 */ return await control.fsDelete(...); }
case MSG.fsCopy:   { /* workspace + path 必填 */ return await control.fsCopy(...); }
case MSG.fsDownload:{ /* workspace + path 必填 */ return await control.fsDownload(...); }
```
门控失败的 `files-write-disabled` 会经 `createControlBridge` 的 catch 变成 `errorPayload("internal", "files-write-disabled")`，前端按 message 文本映射文案（与 terminal 的 `terminal-disabled` 同路径）。

### 5. 配置：`src/config/types.ts`

```ts
export interface FilesConfig {
  /** Default false. When false, all fs write ops (new/rename/delete/copy) are rejected
   *  before touching disk. Download is a read and stays available regardless. */
  writeEnabled: boolean;
}
// AppConfig 增字段： files?: FilesConfig;
export function filesWriteEnabled(config: AppConfig): boolean {
  return config.files?.writeEnabled === true;
}
```
`main.ts` import `filesWriteEnabled` 并在 ControlService deps 传 `filesWriteEnabled: () => filesWriteEnabled(config)`。config-reference 文档补 `files.writeEnabled` 说明。

### 6. 前端：`relay-web`（复用 A 骨架）

**store `stores/files.ts`** 新增 action（均在成功后重列受影响父目录 + 刷新 badge）：
```ts
async function createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>  // path = dir? `${dir}/${name}` : name
async function renameEntry(rel: string, newName: string): Promise<void>
async function deleteEntry(rel: string): Promise<void>
async function duplicateEntry(rel: string): Promise<void>
async function downloadEntry(rel: string): Promise<void>  // 取 base64 → Blob → a[download] 触发浏览器下载
```
写后刷新助手：`await listTree(parentDir); await loadStatus();`（`parentDir` = rel 去掉末段；根用 `""`）。写失败把 `error.value` 设为 message，`FilesPanel` 顶部已有 error 展示位。下载失败同样入 `error`。

**组件：**
- `ContextMenu.vue`：无需改（已是通用 `{key,label}[]`）。
- `FileTreeNode.vue`：`onMenuSelect` 加分支处理 `newFile`/`newFolder`（进入内联输入态）、`rename`（内联输入态，预填当前名）、`duplicate`/`delete`（`delete` 弹确认）、`download`。菜单 `:items` 追加写项：文件夹菜单 = `[新文件, 新建文件夹, 复制, 重命名, 删除, 下载, ─, 复制路径, 复制相对路径, 在此文件夹搜索]`；文件菜单 = `[复制, 重命名, 删除, 下载, ─, 复制路径, 复制相对路径]`（"新文件/新建文件夹"仅文件夹）。
  - **内联输入**：节点内条件渲染一个 `<input>`（`v-model` 到本地 ref），回车提交 / Esc 取消 / blur 取消；新建输入行插在该文件夹展开子层顶部（新建前自动展开该目录）。
  - **删除确认**：`window.confirm($t("files.menu.confirmDelete", { name }))` —— 简单可靠、无新组件（YAGNI）。
- **根级新建**：`FilesPanel.vue` 树头部加"新文件/新建文件夹"两个小按钮（对根 `dir=""`），因为根没有可右键的父节点。

**i18n**（`en.ts` + `zh-CN.ts`，`files.menu` 下补键，保持 en/zh 对齐）：
`newFile`/`newFolder`/`duplicate`/`rename`/`delete`/`download`/`confirmDelete`（带 `{name}`）/`writeDisabled`（"文件写入未启用，请在实例 config 中开启 `files.writeEnabled`"）。

## 错误处理

- 后端所有写方法在越权/非法输入时抛带**稳定错误码**的 `Error`（见上表），绝不静默成功。
- 门控在 ControlService 层最先判断，PTY/fs 均不触达。
- 前端把后端 message 映射为本地化文案；`files-write-disabled` → `writeDisabled` 文案，其余原样显示 message（与 A 一致）。
- 下载超限（`file-too-large`）前端提示改用别的方式获取。

## 测试

**后端 `bun test tests/unit/control/workspace-fs*.test.ts`（新增用例文件或扩展现有）：**
- `resolveParent`：拒绝绝对路径、`..` 逃逸、符号链接父逃逸、含 `/` 或 `\` 的末段、`.`/`..`、空名、根之上创建。
- `createFile`/`createDir`：正常建、已存在抛 `already-exists`、越权抛。
- `rename`：同目录改名、目标已存在拒、拒改根、越权拒。
- `duplicate` + `copyName`：`a.txt`→`a copy.txt`→`a copy 2.txt`；无扩展名；目录递归。
- `remove`：删文件/目录、拒删根、不存在抛。
- `readFileBytes`：正常 base64、超 5 MiB 抛 `file-too-large`、非文件抛、mimeType 映射。

**协议 `bun test`：** 新 DTO/MSG 存在性 + 往返（若有协议测试约定）。

**门控（`tests/unit/control/control-service*.test.ts`）：** `filesWriteEnabled` 返回 false 时 `fsCreate`/`fsRename`/`fsDelete`/`fsCopy` 抛 `files-write-disabled` 且不触达 WorkspaceFs（mock 验证未调用）；`fsDownload` 不受门控。

**前端 `cd packages/relay-web && npx vitest run`：** 菜单项按 dir/file 渲染差异；内联输入提交调用 `createEntry`/`renameEntry`；`delete` 走 confirm（stub `window.confirm`）；门控错误显示 `writeDisabled` 文案；`downloadEntry` 触发 Blob/a-click（stub）。

**集成校验：** 全量 `npx tsc --noEmit` 绿；`bun run build:relay-protocol` assert 通过；relay-web `npm run build` 成功。

## 范围外（未来子项目）

- 「在 OS 文件浏览器打开」（宿主起进程，本期砍掉）。
- 移动/剪切-粘贴跨目录（本期 rename 仅同目录改名）。
- 多选批量操作、拖拽移动。
- OS 回收站 / 工作区 `.trash`（本期永久删除 + 二次确认）。
- 大文件分块下载 / 直传通道（本期 5 MiB base64 上限）。
