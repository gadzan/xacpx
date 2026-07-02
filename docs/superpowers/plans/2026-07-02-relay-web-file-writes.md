# relay-web 文件树写能力（子项目 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 relay-web 文件树支持工作区内的新文件 / 新建文件夹 / 重命名 / 复制副本 / 删除（永久 + 二次确认）/ 下载（≤5 MiB），写操作由默认关闭的 config 门控保护。

**Architecture:** 复用子项目 A 已建立的五个面——`WorkspaceFs`（后端 fs，`src/control/workspace-fs.ts`）、`ControlService`（结构化门面，`src/control/control-service.ts`）、`relay-protocol`（线协议）、`channel-relay/control-bridge.ts`（连接器分发）、`relay-web`（Vue/Pinia 前端）。所有新路径穿过 A 的 `resolve()` 单一收窄点（或新增的 `resolveParent()`）做容器隔离；写门控照抄 `terminal.enabled` 范式。

**Tech Stack:** TypeScript（Node `fs/promises`）、relay-protocol（additive → 0.1.x）、Vue 3 + Pinia、vitest（前端）/ bun test（后端 + 协议）。

## Global Constraints

- **写门控默认关：** `AppConfig.files?: FilesConfig { writeEnabled: boolean }`；`filesWriteEnabled(config)` = `config.files?.writeEnabled === true`（默认 false）。所有写操作（create/rename/delete/copy）在触盘前经门控，关闭时抛 `Error("files-write-disabled")`。**下载不门控**（读操作）。
- **容器隔离不可绕过：** 任何新 fs 方法必须经 `WorkspaceFs.resolve()` 或新增 `resolveParent()`；两者都做 workspace 白名单 → realpath → `abs === root || abs.startsWith(root + sep)` 校验。绝不接受绝对路径、绝不让 `..` 或符号链接逃逸。
- **协议 additive：** 只新增 `MSG.fs*` 类型与 payload/result，不改既有形状 → relay-protocol 停在 0.1.x；改后必须 `bun run build:relay-protocol` 重建 dist。
- **门控 UX 照抄 terminal：** 前端不感知门控状态（无 capabilities 线）；写菜单项常显，调用失败时显示 `files.writeEnabled` 未启用文案。
- **不走 shell：** 后端子进程一律 argv 数组；`duplicate` 用 `fs.cp` 而非 shell。
- **稳定错误码：** 写方法在越权/非法输入时抛带稳定 `message` 的 `Error`（`files-write-disabled` / `already-exists` / `bad-target` / `refuse-delete-root` / `file-too-large`，外加 `resolve()` 既有码）。绝不静默成功。
- **回复中文；release/CHANGELOG 用英文。**
- **依赖同步：** 若新增 npm 依赖，`npm install --package-lock-only` 同步根 package-lock.json（本计划不预期新依赖）。
- **relay-web 测试用 vitest：** `cd packages/relay-web && npx vitest run`（不能 bun test）。后端/协议用 `bun test <file>`。

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/control/workspace-fs.ts` | 新增 `resolveParent()` + `copyName()` + 6 个写/读方法 | 1, 2, 3 |
| `src/config/types.ts` | `FilesConfig` + `filesWriteEnabled()` | 4 |
| `packages/relay-protocol/src/messages.ts` + `dtos.ts`（无 dtos 改动）+ dist | 5 个 `MSG.fs*` + payload/result | 5 |
| `src/control/control-service.ts` | `filesWriteEnabled` dep + 5 门面方法 | 6 |
| `src/main.ts` | 传 `filesWriteEnabled: () => filesWriteEnabled(config)` | 6 |
| `packages/channel-relay/src/control-bridge.ts` | 5 个 dispatch case | 7 |
| `packages/relay-web/src/stores/files.ts` | 6 个写/下载 action | 8 |
| `packages/relay-web/src/i18n/messages/{en,zh-CN}.ts` | `files.menu` 写项键 | 9 |
| `packages/relay-web/src/components/FileTreeNode.vue` | 菜单写项 + 内联输入 + 删除确认 + 下载 | 10 |
| `packages/relay-web/src/components/FilesPanel.vue` | 根级"新文件/新建文件夹"按钮 | 11 |
| `docs/relay-web-module.md` + `docs/config-reference.md` | 文档 | 12 |

**测试文件：**
- Create: `tests/unit/control/workspace-fs-writes.test.ts`（任务 1-3）
- Modify/Create: `tests/unit/control/control-service-files-gate.test.ts`（任务 6）
- relay-web: `packages/relay-web/tests/unit/file-tree-writes.test.ts`（任务 10-11）

---

### Task 1: `resolveParent()` + 末段校验（后端安全基座）

**Files:**
- Modify: `src/control/workspace-fs.ts`（在 `resolve()` 之后新增 private `resolveParent()`）
- Test: `tests/unit/control/workspace-fs-writes.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 private `resolve(workspace, relPath) → {root, abs, rel}`；模块已 import `resolve as pathResolve`? 不——文件顶部是 `import { isAbsolute, relative, resolve, sep } from "node:path"`，`resolve` 是 path.resolve。新增需要 `dirname`、`basename`：改这行为 `import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"`。
- Produces:
```ts
// private
async resolveParent(workspace: string, relPath: string): Promise<{ root: string; parentAbs: string; name: string; targetAbs: string; rel: string }>
```
  `rel` = 目标（未来将创建）的规范化 workspace-relative 路径（posix 分隔）。

**背景：** `resolve()` 对目标 `realpath()`，目标不存在即抛 `not-found`。新建/重命名目标不存在 → 需先解析已存在的父目录再拼末段。父经 realpath+containment，末段无分隔符 → 目标必留容器内。

- [ ] **Step 1: 写失败测试**

在新文件 `tests/unit/control/workspace-fs-writes.test.ts` 顶部搭一个真实临时工作区（bun test，用 `node:fs`/`node:os`/`node:path`；参照现有 `tests/unit/control/` 里 workspace-fs 测试的建法——若无则如下自建）：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFs } from "../../../src/control/workspace-fs";

let rootDir: string;      // realpath'd workspace root
let fs: WorkspaceFs;

beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(join(tmpdir(), "wfs-w-")));
  await mkdir(join(rootDir, "sub"));
  await writeFile(join(rootDir, "a.txt"), "hello");
  fs = new WorkspaceFs(() => [{ name: "ws", cwd: rootDir }]);
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

// resolveParent is private — exercise it through the public write methods (Task 2/3).
// This task's tests assert the *containment + name validation* behavior those methods inherit.
test("createFile rejects an absolute target path", async () => {
  await expect(fs.createFile("ws", "/etc/passwd")).rejects.toThrow("path-must-be-relative");
});
test("createFile rejects a parent that escapes via ..", async () => {
  await expect(fs.createFile("ws", "../escape.txt")).rejects.toThrow("path-escapes-workspace");
});
test("createFile rejects a name containing a path separator", async () => {
  await expect(fs.createFile("ws", "sub/deep/x.txt")).rejects.toThrow(); // parent "sub/deep" missing → not-found
  await expect(fs.createFile("ws", "a/b")).rejects.toThrow();
});
test("createFile rejects '.' and '..' as the final segment", async () => {
  await expect(fs.createFile("ws", ".")).rejects.toThrow("bad-target");
  await expect(fs.createFile("ws", "..")).rejects.toThrow();
});
test("createFile rejects creating at the workspace root (empty path)", async () => {
  await expect(fs.createFile("ws", "")).rejects.toThrow("bad-target");
});
```

> 注：`createFile` 在 Task 2 才实现。本任务先让 `resolveParent` 就位（Task 2 的方法调用它）。若想本任务独立通过，可临时加一个最小 `createFile` 桩仅调用 `resolveParent` 并 `writeFile`；Task 2 再补全语义。推荐做法：本任务同时落 `resolveParent` + 一个最小 `createFile`（wx 写空文件），让上面测试全绿，Task 2 再加 `already-exists` 显式映射与 `createDir`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: FAIL（`fs.createFile is not a function` 或 resolveParent 未定义）

- [ ] **Step 3: 实现 `resolveParent` + 最小 `createFile`**

改 import 行加 `basename, dirname`。在 `resolve()` 方法后新增：

```ts
/** Resolve the PARENT directory of a to-be-created/renamed target. Parent must exist
 *  and be contained; the final segment is validated (non-empty, no separators, not
 *  "."/".."). Because parent is realpath'd+contained and name has no separator, the
 *  join target stays inside the workspace root. */
private async resolveParent(
  workspace: string,
  relPath: string,
): Promise<{ root: string; parentAbs: string; name: string; targetAbs: string; rel: string }> {
  if (relPath && isAbsolute(relPath)) throw new Error("path-must-be-relative");
  const trimmed = (relPath ?? "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("bad-target"); // cannot create at/above the root
  const name = basename(trimmed);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("bad-target");
  }
  const parentRel = dirname(trimmed);
  // Resolve the parent through the existing choke point (realpath + containment).
  const { root, abs: parentAbs, rel: parentRelNorm } = await this.resolve(
    workspace,
    parentRel === "." ? undefined : parentRel,
  );
  const targetAbs = resolve(parentAbs, name);
  const rel = (parentRelNorm ? `${parentRelNorm}/${name}` : name);
  return { root, parentAbs, name, targetAbs, rel };
}

async createFile(workspace: string, relPath: string): Promise<{ path: string }> {
  const { targetAbs, rel } = await this.resolveParent(workspace, relPath);
  await writeFile(targetAbs, "", { flag: "wx" }); // wx → fail if exists
  return { path: rel };
}
```

加 `writeFile` 到顶部 `node:fs/promises` import（现为 `readdir, realpath, stat, open, readFile`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: PASS（5 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs-writes.test.ts
git commit -m "feat(control): resolveParent path-safety base + createFile"
```

---

### Task 2: `createFile` 语义补全 + `createDir`

**Files:**
- Modify: `src/control/workspace-fs.ts`
- Test: `tests/unit/control/workspace-fs-writes.test.ts`（追加）

**Interfaces:**
- Consumes: `resolveParent`（Task 1）
- Produces:
```ts
async createFile(workspace: string, relPath: string): Promise<{ path: string }> // already-exists 映射
async createDir(workspace: string, relPath: string): Promise<{ path: string }>
```

- [ ] **Step 1: 写失败测试（追加到同文件）**

```ts
test("createFile creates an empty file and returns its rel path", async () => {
  const r = await fs.createFile("ws", "sub/new.txt");
  expect(r.path).toBe("sub/new.txt");
  const listed = await readdir(join(rootDir, "sub"));
  expect(listed).toContain("new.txt");
});
test("createFile on an existing path throws already-exists", async () => {
  await expect(fs.createFile("ws", "a.txt")).rejects.toThrow("already-exists");
});
test("createDir creates a directory", async () => {
  const r = await fs.createDir("ws", "sub/kid");
  expect(r.path).toBe("sub/kid");
  const listed = await readdir(join(rootDir, "sub"));
  expect(listed).toContain("kid");
});
test("createDir on an existing path throws already-exists", async () => {
  await expect(fs.createDir("ws", "sub")).rejects.toThrow("already-exists");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: FAIL（`already-exists` 未映射 / `createDir` 未定义）

- [ ] **Step 3: 实现**

把 Task 1 的最小 `createFile` 替换为带显式映射的版本，并加 `createDir`：

```ts
async createFile(workspace: string, relPath: string): Promise<{ path: string }> {
  const { targetAbs, rel } = await this.resolveParent(workspace, relPath);
  try {
    await writeFile(targetAbs, "", { flag: "wx" });
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") throw new Error("already-exists");
    throw e;
  }
  return { path: rel };
}

async createDir(workspace: string, relPath: string): Promise<{ path: string }> {
  const { targetAbs, rel } = await this.resolveParent(workspace, relPath);
  try {
    await mkdir(targetAbs); // recursive:false → EEXIST if present
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") throw new Error("already-exists");
    throw e;
  }
  return { path: rel };
}
```

加 `mkdir` 到 `node:fs/promises` import。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs-writes.test.ts
git commit -m "feat(control): createFile already-exists mapping + createDir"
```

---

### Task 3: `rename` / `duplicate`（+`copyName`）/ `remove` / `readFileBytes`

**Files:**
- Modify: `src/control/workspace-fs.ts`
- Test: `tests/unit/control/workspace-fs-writes.test.ts`（追加）

**Interfaces:**
- Consumes: `resolve`、`resolveParent`
- Produces:
```ts
export function copyName(existing: Set<string>, name: string): string  // module-level, exported
async rename(workspace: string, relPath: string, newName: string): Promise<{ path: string }>
async duplicate(workspace: string, relPath: string): Promise<{ path: string }>
async remove(workspace: string, relPath: string): Promise<{ path: string }>
async readFileBytes(workspace: string, relPath: string): Promise<{ path: string; base64: string; size: number; mimeType: string }>
```
- 新增常量 `const DOWNLOAD_MAX = 5 * 1024 * 1024;`

- [ ] **Step 1: 写失败测试（追加）**

```ts
import { copyName } from "../../../src/control/workspace-fs";

test("copyName inserts 'copy' before the extension and avoids collisions", () => {
  expect(copyName(new Set(["a.txt"]), "a.txt")).toBe("a copy.txt");
  expect(copyName(new Set(["a.txt", "a copy.txt"]), "a.txt")).toBe("a copy 2.txt");
  expect(copyName(new Set(["notes"]), "notes")).toBe("notes copy");     // no extension
  expect(copyName(new Set([".env"]), ".env")).toBe(".env copy");        // dotfile: no ext split
});

test("rename changes a file's name in the same directory", async () => {
  const r = await fs.rename("ws", "a.txt", "b.txt");
  expect(r.path).toBe("b.txt");
  const listed = await readdir(rootDir);
  expect(listed).toContain("b.txt");
  expect(listed).not.toContain("a.txt");
});
test("rename rejects when the target name already exists", async () => {
  await writeFile(join(rootDir, "c.txt"), "x");
  await expect(fs.rename("ws", "a.txt", "c.txt")).rejects.toThrow("already-exists");
});
test("rename rejects the workspace root", async () => {
  await expect(fs.rename("ws", "", "x")).rejects.toThrow();
});
test("rename rejects a newName with a separator", async () => {
  await expect(fs.rename("ws", "a.txt", "../evil")).rejects.toThrow("bad-target");
});

test("duplicate creates a sibling copy", async () => {
  const r = await fs.duplicate("ws", "a.txt");
  expect(r.path).toBe("a copy.txt");
  const listed = await readdir(rootDir);
  expect(listed).toContain("a copy.txt");
});
test("duplicate copies a directory recursively", async () => {
  await writeFile(join(rootDir, "sub", "inner.txt"), "deep");
  const r = await fs.duplicate("ws", "sub");
  expect(r.path).toBe("sub copy");
  const listed = await readdir(join(rootDir, "sub copy"));
  expect(listed).toContain("inner.txt");
});

test("remove deletes a file", async () => {
  await fs.remove("ws", "a.txt");
  const listed = await readdir(rootDir);
  expect(listed).not.toContain("a.txt");
});
test("remove deletes a directory recursively", async () => {
  await fs.remove("ws", "sub");
  const listed = await readdir(rootDir);
  expect(listed).not.toContain("sub");
});
test("remove refuses to delete the workspace root", async () => {
  await expect(fs.remove("ws", "")).rejects.toThrow("refuse-delete-root");
});

test("readFileBytes returns base64 + size + mimeType", async () => {
  const r = await fs.readFileBytes("ws", "a.txt");
  expect(Buffer.from(r.base64, "base64").toString("utf8")).toBe("hello");
  expect(r.size).toBe(5);
  expect(r.mimeType).toBe("text/plain");
});
test("readFileBytes rejects a file over 5 MiB", async () => {
  await writeFile(join(rootDir, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
  await expect(fs.readFileBytes("ws", "big.bin")).rejects.toThrow("file-too-large");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: FAIL（方法/`copyName` 未定义）

- [ ] **Step 3: 实现**

在类内加 4 方法，模块尾（与 `escapeRe` 等并列）加 `copyName` 与 mime 助手；顶部常量区加 `DOWNLOAD_MAX`；`node:fs/promises` import 加 `rename as fsRename, cp, rm, readdir`（`readdir` 已在）。

```ts
async rename(workspace: string, relPath: string, newName: string): Promise<{ path: string }> {
  const src = await this.resolve(workspace, relPath);           // must exist + contained
  if (!src.rel) throw new Error("bad-target");                  // refuse renaming the root
  // Validate the new name as a same-directory final segment by resolving the parent of
  // the destination: dirname(src.rel)/newName. Reuse resolveParent for the name checks.
  const destRelInput = src.rel.includes("/") ? `${src.rel.slice(0, src.rel.lastIndexOf("/"))}/${newName}` : newName;
  const dest = await this.resolveParent(workspace, destRelInput);
  try {
    await stat(dest.targetAbs);
    throw new Error("already-exists");                          // target present
  } catch (e) {
    if ((e as Error).message === "already-exists") throw e;
    // ENOENT → free to rename
  }
  await fsRename(src.abs, dest.targetAbs);
  return { path: dest.rel };
}

async duplicate(workspace: string, relPath: string): Promise<{ path: string }> {
  const src = await this.resolve(workspace, relPath);
  if (!src.rel) throw new Error("bad-target");                  // refuse duplicating the root
  const parent = await this.resolveParent(workspace, src.rel);  // parent.parentAbs = src's dir; parent.name = basename(src)
  const siblings = new Set(await readdir(parent.parentAbs));
  const newBase = copyName(siblings, parent.name);
  const destAbs = resolve(parent.parentAbs, newBase);
  await cp(src.abs, destAbs, { recursive: true });
  const destRel = parent.rel.includes("/")
    ? `${parent.rel.slice(0, parent.rel.lastIndexOf("/"))}/${newBase}`
    : newBase;
  return { path: destRel };
}

async remove(workspace: string, relPath: string): Promise<{ path: string }> {
  const { abs, rel } = await this.resolve(workspace, relPath);
  if (!rel) throw new Error("refuse-delete-root");
  await rm(abs, { recursive: true, force: false });
  return { path: rel };
}

async readFileBytes(workspace: string, relPath: string): Promise<{ path: string; base64: string; size: number; mimeType: string }> {
  const { abs, rel } = await this.resolve(workspace, relPath);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error("not-a-file");
  if (info.size > DOWNLOAD_MAX) throw new Error("file-too-large");
  const buf = await readFile(abs);
  return { path: rel, base64: buf.toString("base64"), size: info.size, mimeType: mimeForName(basename(abs)) };
}
```

模块级助手：

```ts
/** First free "NAME copy", "NAME copy 2"… inserting before the extension. Dotfiles
 *  (leading dot, no other dot) and extension-less names get no split. */
export function copyName(existing: Set<string>, name: string): string {
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0; // dot at index 0 (dotfile) is not an extension
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  let candidate = `${base} copy${ext}`;
  let n = 2;
  while (existing.has(candidate)) candidate = `${base} copy ${n++}${ext}`;
  return candidate;
}

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".js": "text/javascript", ".ts": "text/plain", ".html": "text/html",
  ".css": "text/css", ".csv": "text/csv", ".xml": "application/xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".pdf": "application/pdf", ".zip": "application/zip",
};
function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs-writes.test.ts
git commit -m "feat(control): rename/duplicate/remove/readFileBytes + copyName"
```

---

### Task 4: config 门控（`FilesConfig` + `filesWriteEnabled`）

**Files:**
- Modify: `src/config/types.ts:50-55`（`TerminalConfig` 之后加 `FilesConfig`）、`:117-133`（`AppConfig` 加字段 + helper）
- Test: `tests/unit/config/files-config.test.ts`（新建）

**Interfaces:**
- Produces:
```ts
export interface FilesConfig { writeEnabled: boolean; }
export function filesWriteEnabled(config: AppConfig): boolean;
```

- [ ] **Step 1: 写失败测试**

`tests/unit/config/files-config.test.ts`：
```ts
import { test, expect } from "bun:test";
import { filesWriteEnabled, type AppConfig } from "../../../src/config/types";

const base = {} as AppConfig; // helper only touches `.files`
test("filesWriteEnabled defaults to false when unset", () => {
  expect(filesWriteEnabled(base)).toBe(false);
});
test("filesWriteEnabled is true only when writeEnabled === true", () => {
  expect(filesWriteEnabled({ ...base, files: { writeEnabled: true } })).toBe(true);
  expect(filesWriteEnabled({ ...base, files: { writeEnabled: false } })).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/config/files-config.test.ts`
Expected: FAIL（`filesWriteEnabled` 未导出）

- [ ] **Step 3: 实现**

`TerminalConfig` 块之后加：
```ts
export interface FilesConfig {
  /** Default false. When false, all fs write ops (new/rename/delete/copy) are rejected
   *  before touching disk. Download is a read and stays available regardless. */
  writeEnabled: boolean;
}
```
`AppConfig` 加字段（`terminal?` 之后）：`files?: FilesConfig;`
`terminalEnabled` helper 之后加：
```ts
export function filesWriteEnabled(config: AppConfig): boolean {
  return config.files?.writeEnabled === true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/config/files-config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config/types.ts tests/unit/config/files-config.test.ts
git commit -m "feat(config): files.writeEnabled gate (default off)"
```

---

### Task 5: 协议 —— `MSG.fs*` 写类型 + payload/result + dist 重建

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts`（`MSG` 常量 + payload/result 接口）
- Test: `packages/relay-protocol/`（若有 `tests/` 约定则加往返/存在性；否则用编译 + assert 覆盖）

**Interfaces:**
- Produces（`MSG` 内，`fsSearch` 行之后）：
```ts
fsCreate: "control.fs.create",
fsRename: "control.fs.rename",
fsDelete: "control.fs.delete",
fsCopy:   "control.fs.copy",
fsDownload: "control.fs.download",
```
  接口（`FsSearchResult` 之后）：
```ts
export interface FsCreatePayload { workspace: string; path: string; kind: "file" | "dir"; }
export interface FsRenamePayload { workspace: string; path: string; newName: string; }
export interface FsDeletePayload { workspace: string; path: string; }
export interface FsCopyPayload { workspace: string; path: string; }
export interface FsDownloadPayload { workspace: string; path: string; }
export interface FsMutateResult { path: string; }
export interface FsDownloadResult { path: string; base64: string; size: number; mimeType: string; }
```

- [ ] **Step 1: 写存在性测试**

先看有无既有协议测试：`ls packages/relay-protocol/tests 2>/dev/null || echo none`。
- 若有 `tests/`：新建 `packages/relay-protocol/tests/fs-write-messages.test.ts`：
```ts
import { test, expect } from "bun:test";
import { MSG } from "../src/messages";
test("fs write message types exist", () => {
  expect(MSG.fsCreate).toBe("control.fs.create");
  expect(MSG.fsRename).toBe("control.fs.rename");
  expect(MSG.fsDelete).toBe("control.fs.delete");
  expect(MSG.fsCopy).toBe("control.fs.copy");
  expect(MSG.fsDownload).toBe("control.fs.download");
});
```
- 若无 `tests/`：跳过测试文件，靠 Step 4 的 `bun run build:relay-protocol`（tsc + assert）作为验证闸门。

- [ ] **Step 2: 跑测试确认失败（有 tests/ 时）**

Run: `bun test packages/relay-protocol/tests/fs-write-messages.test.ts`
Expected: FAIL（`MSG.fsCreate` 为 undefined）

- [ ] **Step 3: 实现 + 重建 dist**

按 Interfaces 加常量与接口。然后：

Run: `bun run build:relay-protocol`
Expected: 构建成功、assert 通过（导出非空——见 [[bun barrel build emits empty exports]] 该包用 tsc 构建 dist）

- [ ] **Step 4: 跑测试/构建确认通过**

Run: `bun test packages/relay-protocol/tests/fs-write-messages.test.ts`（有 tests/ 时）+ `bun run build:relay-protocol`
Expected: PASS + 构建绿

- [ ] **Step 5: 提交**

```bash
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/dist packages/relay-protocol/tests 2>/dev/null
git commit -m "feat(relay-protocol): fs write message types + payloads (additive, 0.1.x)"
```

---

### Task 6: `ControlService` 门面方法 + `main.ts` 接线

**Files:**
- Modify: `src/control/control-service.ts`（`ControlServiceDeps` 加 dep + import + 5 方法）、`src/main.ts:837` 附近（deps 传值）
- Test: `tests/unit/control/control-service-files-gate.test.ts`（新建）

**Interfaces:**
- Consumes: `WorkspaceFs.createFile/createDir/rename/duplicate/remove/readFileBytes`（Task 1-3）；`filesWriteEnabled`（Task 4）
- Produces（`ControlService` public）：
```ts
async fsCreate(workspace: string, path: string, kind: "file" | "dir"): Promise<{ path: string }>
async fsRename(workspace: string, path: string, newName: string): Promise<{ path: string }>
async fsDelete(workspace: string, path: string): Promise<{ path: string }>
async fsCopy(workspace: string, path: string): Promise<{ path: string }>
async fsDownload(workspace: string, path: string): Promise<{ path: string; base64: string; size: number; mimeType: string }>
```
  `ControlServiceDeps` 加 `filesWriteEnabled: () => boolean;`

- [ ] **Step 1: 写失败测试**

`tests/unit/control/control-service-files-gate.test.ts`——用最小 deps 构 ControlService，只关心门控与转发（其余 deps 传 `{} as any` / 最小桩，参照现有 control-service 测试的构造法）：
```ts
import { test, expect } from "bun:test";
import { ControlService } from "../../../src/control/control-service";

function make(enabled: boolean, calls: string[]) {
  // Point one real workspace at a temp dir so WorkspaceFs.resolve() succeeds; but we
  // assert the GATE, so a disabled service must never reach WorkspaceFs. We spy by
  // pointing the workspace list at a non-existent dir: if the gate lets the call
  // through it fails with a WorkspaceFs error (not "files-write-disabled").
  const deps: any = {
    workspaces: { list: () => [{ name: "ws", cwd: "/nonexistent-xacpx-test" }] },
    filesWriteEnabled: () => enabled,
    events: { emit() {}, subscribe() { return () => {}; } },
  };
  return new ControlService(deps);
}

test("fsCreate is rejected with files-write-disabled when the gate is off", async () => {
  const svc = make(false, []);
  await expect(svc.fsCreate("ws", "x.txt", "file")).rejects.toThrow("files-write-disabled");
});
test("fsDelete/fsRename/fsCopy are gated too", async () => {
  const svc = make(false, []);
  await expect(svc.fsDelete("ws", "x.txt")).rejects.toThrow("files-write-disabled");
  await expect(svc.fsRename("ws", "x.txt", "y.txt")).rejects.toThrow("files-write-disabled");
  await expect(svc.fsCopy("ws", "x.txt")).rejects.toThrow("files-write-disabled");
});
test("fsDownload is NOT gated (reaches WorkspaceFs, fails on missing workspace root)", async () => {
  const svc = make(false, []);
  // gate off, but download must still attempt the read → WorkspaceFs error, NOT the gate error
  await expect(svc.fsDownload("ws", "x.txt")).rejects.not.toThrow("files-write-disabled");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/control-service-files-gate.test.ts`
Expected: FAIL（方法未定义 / dep 缺失）

- [ ] **Step 3: 实现**

`control-service.ts`：`ControlServiceDeps` 在 `terminalEnabled: () => boolean;` 之后加 `filesWriteEnabled: () => boolean;`。在 `searchWorkspace` 之后加：
```ts
async fsCreate(workspace: string, path: string, kind: "file" | "dir"): Promise<{ path: string }> {
  if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
  return kind === "dir" ? this.workspaceFs.createDir(workspace, path) : this.workspaceFs.createFile(workspace, path);
}
async fsRename(workspace: string, path: string, newName: string): Promise<{ path: string }> {
  if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
  return this.workspaceFs.rename(workspace, path, newName);
}
async fsDelete(workspace: string, path: string): Promise<{ path: string }> {
  if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
  return this.workspaceFs.remove(workspace, path);
}
async fsCopy(workspace: string, path: string): Promise<{ path: string }> {
  if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
  return this.workspaceFs.duplicate(workspace, path);
}
async fsDownload(workspace: string, path: string): Promise<{ path: string; base64: string; size: number; mimeType: string }> {
  return this.workspaceFs.readFileBytes(workspace, path); // read op — intentionally NOT gated
}
```
`main.ts`：import `filesWriteEnabled`（与 `terminalEnabled` 同一 `./config/types` import 行），在 ControlService deps（`terminalEnabled: () => terminalEnabled(config),` 附近，约 :837）加 `filesWriteEnabled: () => filesWriteEnabled(config),`。

- [ ] **Step 4: 跑测试确认通过 + 全量 tsc**

Run: `bun test tests/unit/control/control-service-files-gate.test.ts && npx tsc --noEmit`
Expected: PASS + tsc rc=0

- [ ] **Step 5: 提交**

```bash
git add src/control/control-service.ts src/main.ts tests/unit/control/control-service-files-gate.test.ts
git commit -m "feat(control): fs write facade methods + write gate wiring"
```

---

### Task 7: 连接器 dispatch —— 5 个 `MSG.fs*` case

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts`（import 加类型；`dispatchControlRequest` 加 case；`fsSearch` case 之后、`sessionModelGet` 之前）
- Test: `packages/channel-relay/`（若有 bridge 测试则加；否则靠 tsc + 后续前端集成）

**Interfaces:**
- Consumes: `ControlService.fsCreate/fsRename/fsDelete/fsCopy/fsDownload`（Task 6）；`FsCreatePayload` 等（Task 5）

- [ ] **Step 1: 写失败测试（有 bridge 测试约定时）**

先查：`ls packages/channel-relay/tests 2>/dev/null || echo none`。
- 若有：新建 `packages/channel-relay/tests/control-bridge-fs-write.test.ts`，构造一个 stub `ControlService`（只实现 5 个 fs 方法记录调用），断言 `MSG.fsCreate` 等 envelope 被路由到对应方法、必填校验返回 `bad-request`：
```ts
import { test, expect } from "bun:test";
import { MSG } from "@ganglion/xacpx-relay-protocol";
import { createControlBridge } from "../src/control-bridge";

function bridgeWith(stub: any) {
  const b = createControlBridge(stub as any);
  return (type: string, payload: unknown) => new Promise((res) => b({ type, payload } as any, res));
}
test("fsCreate routes to control.fsCreate", async () => {
  const calls: any[] = [];
  const call = bridgeWith({ fsCreate: (...a: any) => { calls.push(a); return { path: "x.txt" }; } });
  const r = await call(MSG.fsCreate, { workspace: "ws", path: "x.txt", kind: "file" });
  expect(r).toEqual({ path: "x.txt" });
  expect(calls[0]).toEqual(["ws", "x.txt", "file"]);
});
test("fsCreate without workspace/path returns bad-request", async () => {
  const call = bridgeWith({});
  const r: any = await call(MSG.fsCreate, { workspace: "", path: "" });
  expect(r.error.code).toBe("bad-request");
});
```
- 若无 `tests/`：跳过，靠 Step 4 tsc + 前端集成验证。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/channel-relay/tests/control-bridge-fs-write.test.ts`（有时）
Expected: FAIL（case 未加 → `unknown-type`）

- [ ] **Step 3: 实现**

import 块加 `type FsCreatePayload, type FsRenamePayload, type FsDeletePayload, type FsCopyPayload, type FsDownloadPayload`。在 `case MSG.fsSearch:` 块之后加：
```ts
case MSG.fsCreate: {
  const i = payload as FsCreatePayload;
  if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
  if (i.kind !== "file" && i.kind !== "dir") return errorPayload("bad-request", "kind must be file or dir");
  return await control.fsCreate(i.workspace, i.path, i.kind);
}
case MSG.fsRename: {
  const i = payload as FsRenamePayload;
  if (!i.workspace || !i.path || !i.newName) return errorPayload("bad-request", "workspace, path and newName are required");
  return await control.fsRename(i.workspace, i.path, i.newName);
}
case MSG.fsDelete: {
  const i = payload as FsDeletePayload;
  if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
  return await control.fsDelete(i.workspace, i.path);
}
case MSG.fsCopy: {
  const i = payload as FsCopyPayload;
  if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
  return await control.fsCopy(i.workspace, i.path);
}
case MSG.fsDownload: {
  const i = payload as FsDownloadPayload;
  if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
  return await control.fsDownload(i.workspace, i.path);
}
```

- [ ] **Step 4: 跑测试/构建确认通过**

Run: `bun test packages/channel-relay/tests/control-bridge-fs-write.test.ts`（有时）+ `npx tsc --noEmit`
Expected: PASS + tsc rc=0

- [ ] **Step 5: 提交**

```bash
git add packages/channel-relay/src/control-bridge.ts packages/channel-relay/tests 2>/dev/null
git commit -m "feat(channel-relay): route fs write rpc types to ControlService"
```

---

### Task 8: 前端 store —— 6 个写/下载 action

**Files:**
- Modify: `packages/relay-web/src/stores/files.ts`
- Test: `packages/relay-web/tests/unit/file-tree-writes.test.ts`（新建；vitest）

**Interfaces:**
- Consumes: `api.rpc`（既有）；`MSG` 字符串直用（store 里 A 用字符串字面量 `"control.fs.list"`，保持一致用字面量）
- Produces（store return 里新增）：
```ts
createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>
renameEntry(rel: string, newName: string): Promise<void>
deleteEntry(rel: string): Promise<void>
duplicateEntry(rel: string): Promise<void>
downloadEntry(rel: string): Promise<void>
```
  写后刷新助手 `refreshDir(parentDir)`（重列 + `loadStatus`）。

- [ ] **Step 1: 写失败测试（vitest）**

`packages/relay-web/tests/unit/file-tree-writes.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useFilesStore } from "../../src/stores/files";
import { api } from "../../src/api/client";

beforeEach(() => { setActivePinia(createPinia()); });

describe("file-tree write actions", () => {
  it("createEntry posts control.fs.create with the joined path and refreshes", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws";
    const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_i, type: string) => {
      if (type === "control.fs.create") return { path: "sub/x.txt" } as any;
      if (type === "control.fs.list") return { workspace: "ws", path: "sub", entries: [], root: "/r", sep: "/" } as any;
      if (type === "control.fs.diff") return { workspace: "ws", files: [] } as any;
      return {} as any;
    });
    await store.createEntry("sub", "x.txt", "file");
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.create", { workspace: "ws", path: "sub/x.txt", kind: "file" });
  });

  it("deleteEntry posts control.fs.delete", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws";
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ path: "a.txt" } as any);
    await store.deleteEntry("a.txt");
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.delete", { workspace: "ws", path: "a.txt" });
  });

  it("createEntry surfaces a disabled error into store.error", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws";
    vi.spyOn(api, "rpc").mockResolvedValue({ error: { code: "internal", message: "files-write-disabled" } } as any);
    await store.createEntry("", "x.txt", "file");
    expect(store.error).toContain("files-write-disabled");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run tests/unit/file-tree-writes.test.ts`
Expected: FAIL（`createEntry` 不是函数）

- [ ] **Step 3: 实现**

在 `files.ts` 的 `search` 之后（`loadDiff` 之前）加：
```ts
/** Re-list one directory layer + refresh git badges after a write. */
async function refreshDir(dir: string): Promise<void> {
  await listTree(dir);
  await loadStatus();
}
function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

async function createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
  if (!instanceId.value || !workspace.value || !name.trim()) return;
  error.value = "";
  const p = dir ? `${dir}/${name}` : name;
  try {
    unwrap(await api.rpc(instanceId.value, "control.fs.create", { workspace: workspace.value, path: p, kind }));
    await refreshDir(dir);
  } catch (e) { error.value = e instanceof Error ? e.message : "create-failed"; }
}
async function renameEntry(rel: string, newName: string): Promise<void> {
  if (!instanceId.value || !workspace.value || !newName.trim()) return;
  error.value = "";
  try {
    unwrap(await api.rpc(instanceId.value, "control.fs.rename", { workspace: workspace.value, path: rel, newName }));
    await refreshDir(parentOf(rel));
  } catch (e) { error.value = e instanceof Error ? e.message : "rename-failed"; }
}
async function deleteEntry(rel: string): Promise<void> {
  if (!instanceId.value || !workspace.value) return;
  error.value = "";
  try {
    unwrap(await api.rpc(instanceId.value, "control.fs.delete", { workspace: workspace.value, path: rel }));
    await refreshDir(parentOf(rel));
  } catch (e) { error.value = e instanceof Error ? e.message : "delete-failed"; }
}
async function duplicateEntry(rel: string): Promise<void> {
  if (!instanceId.value || !workspace.value) return;
  error.value = "";
  try {
    unwrap(await api.rpc(instanceId.value, "control.fs.copy", { workspace: workspace.value, path: rel }));
    await refreshDir(parentOf(rel));
  } catch (e) { error.value = e instanceof Error ? e.message : "copy-failed"; }
}
async function downloadEntry(rel: string): Promise<void> {
  if (!instanceId.value || !workspace.value) return;
  error.value = "";
  try {
    const r = unwrap(await api.rpc<{ path: string; base64: string; size: number; mimeType: string }>(
      instanceId.value, "control.fs.download", { workspace: workspace.value, path: rel }));
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: r.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = rel.split("/").pop() ?? "download";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { error.value = e instanceof Error ? e.message : "download-failed"; }
}
```
在 return 对象里加：`createEntry, renameEntry, deleteEntry, duplicateEntry, downloadEntry,`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/relay-web && npx vitest run tests/unit/file-tree-writes.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/stores/files.ts packages/relay-web/tests/unit/file-tree-writes.test.ts
git commit -m "feat(relay-web): file store write + download actions"
```

---

### Task 9: i18n —— `files.menu` 写项键（en + zh 对齐）

**Files:**
- Modify: `packages/relay-web/src/i18n/messages/en.ts`、`packages/relay-web/src/i18n/messages/zh-CN.ts`（`files.menu` 块）
- Test: 复用既有 i18n 对齐测试（如有 `i18n-parity` 测试则自动覆盖；否则靠构建）

**Interfaces:**
- Produces（`files.menu` 下新增键）：`newFile`、`newFolder`、`duplicate`、`rename`、`delete`、`download`、`confirmDelete`（带 `{name}`）、`writeDisabled`

- [ ] **Step 1: 查既有对齐测试**

Run: `ls packages/relay-web/tests/unit | grep -i i18n || echo none`
若有 parity 测试：它会在缺键时失败——即本任务的失败测试。

- [ ] **Step 2: 加 zh 键、跑 parity 确认失败（en 缺）**

`zh-CN.ts` 的 `menu:` 块（现含 `copyPath/copyRelativePath/searchInFolder`）加：
```ts
newFile: "新文件",
newFolder: "新建文件夹",
duplicate: "复制",
rename: "重命名",
delete: "删除",
download: "下载",
confirmDelete: "确定删除「{name}」？此操作不可撤销。",
writeDisabled: "文件写入未启用，请在实例 config 中开启 `files.writeEnabled`。",
```
Run（有 parity 测试时）: `cd packages/relay-web && npx vitest run <i18n-parity-file>`
Expected: FAIL（en 缺这些键）

- [ ] **Step 3: 加 en 键**

`en.ts` 的 `menu:` 块加：
```ts
newFile: "New File",
newFolder: "New Folder",
duplicate: "Duplicate",
rename: "Rename",
delete: "Delete",
download: "Download",
confirmDelete: "Delete “{name}”? This cannot be undone.",
writeDisabled: "File writes are disabled. Enable `files.writeEnabled` in the instance config.",
```

- [ ] **Step 4: 跑 parity/构建确认通过**

Run: `cd packages/relay-web && npx vitest run`（或 parity 文件）
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "i18n(relay-web): file-tree write menu strings (en/zh)"
```

---

### Task 10: `FileTreeNode.vue` —— 菜单写项 + 内联输入 + 删除确认 + 下载

**Files:**
- Modify: `packages/relay-web/src/components/FileTreeNode.vue`
- Test: `packages/relay-web/tests/unit/file-tree-writes.test.ts`（追加组件用例）

**Interfaces:**
- Consumes: store `createEntry/renameEntry/deleteEntry/duplicateEntry/downloadEntry`（Task 8）；i18n 键（Task 9）；既有 `ContextMenu.vue`（通用 `{key,label}[]`，无需改）
- Produces: 组件行为——菜单项按 dir/file 差异渲染；`newFile`/`newFolder`/`rename` 进入内联 `<input>`；`delete` 走 `window.confirm`；`download`/`duplicate` 直接调 store。

- [ ] **Step 1: 写失败测试（组件）**

追加到 `file-tree-writes.test.ts`（用 `@vue/test-utils` mount，参照 A 的 FileTreeNode 测试构造；stub store）：
```ts
import { mount } from "@vue/test-utils";
import FileTreeNode from "../../src/components/FileTreeNode.vue";
// … i18n plugin + pinia 装配同 A 的既有组件测试 …

it("file menu includes duplicate/rename/delete/download but not newFile", async () => {
  // right-click a file row → open ContextMenu → assert menu-<key> buttons
  // menu-duplicate, menu-rename, menu-delete, menu-download present; menu-newFile absent
});
it("delete calls window.confirm then store.deleteEntry when confirmed", async () => {
  // stub window.confirm = () => true; click menu-delete; expect deleteEntry called with rel
});
it("newFile enters an inline input and submits via createEntry on Enter", async () => {
  // folder row → menu-newFile → an <input data-test='inline-name'> appears; type + Enter → createEntry(dir, name, "file")
});
```
> 实现者：按 A 现有 `FileTreeNode` 测试的确切装配方式（i18n/pinia/mount）落这三条；断言用 `data-test` 选择器。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run tests/unit/file-tree-writes.test.ts`
Expected: FAIL（菜单无写项 / 无内联输入）

- [ ] **Step 3: 实现**

`FileTreeNode.vue` `<script setup>`：
- 加内联输入状态：
```ts
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const inlineMode = ref<null | { kind: "file" | "dir" | "rename" }>(null);
const inlineName = ref("");
function startCreate(kind: "file" | "dir") {
  if (!files.expanded.has(rel.value)) void files.toggleExpand(rel.value); // ensure open
  inlineMode.value = { kind }; inlineName.value = "";
}
function startRename() { inlineMode.value = { kind: "rename" }; inlineName.value = props.entry.name; }
async function submitInline() {
  const m = inlineMode.value; const name = inlineName.value.trim();
  inlineMode.value = null;
  if (!m || !name) return;
  if (m.kind === "rename") await files.renameEntry(rel.value, name);
  else await files.createEntry(rel.value, name, m.kind); // create INSIDE this folder
}
function cancelInline() { inlineMode.value = null; }
```
- 扩展 `onMenuSelect`：
```ts
async function onMenuSelect(key: string) {
  if (key === "copyPath") await navigator.clipboard?.writeText(files.absPath(rel.value)).catch(() => {});
  else if (key === "copyRelativePath") await navigator.clipboard?.writeText(rel.value).catch(() => {});
  else if (key === "searchInFolder") files.searchOpts.path = rel.value;
  else if (key === "newFile") startCreate("file");
  else if (key === "newFolder") startCreate("dir");
  else if (key === "rename") startRename();
  else if (key === "duplicate") await files.duplicateEntry(rel.value);
  else if (key === "download") await files.downloadEntry(rel.value);
  else if (key === "delete") {
    if (window.confirm(t("files.menu.confirmDelete", { name: props.entry.name }))) await files.deleteEntry(rel.value);
  }
  menu.value = null;
}
```
- `:items` 改为按 dir/file 组装（含分隔——ContextMenu 无分隔渲染，直接顺序排）：
```ts
// dir menu:
[{key:'newFile',label:$t('files.menu.newFile')},{key:'newFolder',label:$t('files.menu.newFolder')},
 {key:'duplicate',label:$t('files.menu.duplicate')},{key:'rename',label:$t('files.menu.rename')},
 {key:'delete',label:$t('files.menu.delete')},{key:'download',label:$t('files.menu.download')},
 {key:'copyPath',label:$t('files.menu.copyPath')},{key:'copyRelativePath',label:$t('files.menu.copyRelativePath')},
 {key:'searchInFolder',label:$t('files.menu.searchInFolder')}]
// 注：文件夹「下载」也可保留（zip? 否 → 去掉 download from dir）。决策：文件夹菜单不含 download（后端 readFileBytes 仅文件）。
```
  修正——**文件夹菜单去掉 `download`**（后端只下载文件）。文件菜单：
```ts
[{key:'duplicate',...},{key:'rename',...},{key:'delete',...},{key:'download',...},
 {key:'copyPath',...},{key:'copyRelativePath',...}]
```
- template：在展开子层顶部插入内联输入（当 `inlineMode?.kind !== 'rename'`）与重命名替换行（当 `=== 'rename'`）：
```html
<!-- rename: replace the label with an input in-place -->
<input v-if="inlineMode?.kind === 'rename'" data-test="inline-name" v-model="inlineName"
       @keyup.enter="submitInline" @keyup.esc="cancelInline" @blur="cancelInline"
       class="flex-1 rounded border border-border bg-raised px-1 text-[12px]" />
<!-- create: new-name input at top of the expanded children -->
<div v-if="isDir && isOpen">
  <input v-if="inlineMode && inlineMode.kind !== 'rename'" data-test="inline-name" v-model="inlineName"
         @keyup.enter="submitInline" @keyup.esc="cancelInline" @blur="cancelInline"
         :style="{ marginLeft: (depth + 1) * 12 + 16 + 'px' }"
         class="my-0.5 rounded border border-border bg-raised px-1 text-[12px]" />
  <FileTreeNode v-for="c in visibleChildren" ... />
  ...
</div>
```
> 实现者：内联输入 `@blur="cancelInline"` 与 `@keyup.enter="submitInline"` 可能竞态（enter 触发 blur）——把 rename 的 input 用一个 `submitting` 守卫，或 enter 时先置 `inlineMode=null` 再执行（如上 `submitInline` 已先清 mode，blur 后 `inlineMode` 已 null → cancelInline 无副作用）。保持上面的顺序即可。

- [ ] **Step 4: 跑测试确认通过 + 构建**

Run: `cd packages/relay-web && npx vitest run tests/unit/file-tree-writes.test.ts && npm run build`
Expected: PASS + build 成功

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/components/FileTreeNode.vue packages/relay-web/tests/unit/file-tree-writes.test.ts
git commit -m "feat(relay-web): file-tree node write menu + inline create/rename + delete confirm + download"
```

---

### Task 11: `FilesPanel.vue` —— 根级"新文件/新建文件夹"按钮

**Files:**
- Modify: `packages/relay-web/src/components/FilesPanel.vue`（树头部）
- Test: `packages/relay-web/tests/unit/file-tree-writes.test.ts`（追加）

**Interfaces:**
- Consumes: store `createEntry`（对根 `dir=""`）
- Produces: 树头两个按钮，点击进入根级内联输入（或直接 prompt-less 输入行）。

**背景：** 根目录没有可右键的父节点，所以根级新建入口放在面板头部。

- [ ] **Step 1: 写失败测试（追加）**

```ts
it("root new-file button creates at workspace root", async () => {
  // mount FilesPanel with a stubbed store; click [data-test=root-new-file];
  // an inline input appears; type "top.txt" + Enter → createEntry("", "top.txt", "file")
});
```
> 实现者：按 A 现有 FilesPanel 测试装配；断言 `data-test="root-new-file"` / `root-new-folder` 存在且提交调用 `createEntry("", name, kind)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/relay-web && npx vitest run tests/unit/file-tree-writes.test.ts`
Expected: FAIL（按钮不存在）

- [ ] **Step 3: 实现**

`FilesPanel.vue` 树区头部（Files tab 的树容器上方）加：
```html
<div class="mb-1 flex items-center gap-1">
  <button data-test="root-new-file" class="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-raised"
          @click="rootInline = 'file'" :title="$t('files.menu.newFile')">＋{{ $t('files.menu.newFile') }}</button>
  <button data-test="root-new-folder" class="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-raised"
          @click="rootInline = 'dir'" :title="$t('files.menu.newFolder')">＋{{ $t('files.menu.newFolder') }}</button>
</div>
<input v-if="rootInline" data-test="root-inline-name" v-model="rootName"
       @keyup.enter="submitRoot" @keyup.esc="rootInline = null" @blur="rootInline = null"
       class="mb-1 w-full rounded border border-border bg-raised px-1 text-[12px]" />
```
`<script setup>`：
```ts
const rootInline = ref<null | "file" | "dir">(null);
const rootName = ref("");
async function submitRoot() {
  const kind = rootInline.value; const name = rootName.value.trim();
  rootInline.value = null; rootName.value = "";
  if (kind && name) await files.createEntry("", name, kind);
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量 vitest**

Run: `cd packages/relay-web && npx vitest run && npm run build`
Expected: PASS（含 A 的既有用例）+ build 成功

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/components/FilesPanel.vue packages/relay-web/tests/unit/file-tree-writes.test.ts
git commit -m "feat(relay-web): root-level new file/folder entry in FilesPanel"
```

---

### Task 12: 文档

**Files:**
- Modify: `docs/relay-web-module.md`（Files 面板节补写能力 + 门控）、`docs/config-reference.md`（`files.writeEnabled`）

**Interfaces:** 无代码接口。

- [ ] **Step 1: 更新 `docs/relay-web-module.md`**

在 A 的"文件树浏览器（Files 面板 / 子项目 A）"节后追加"文件写能力（子项目 B）"小节：列 5 个写操作 + 下载、门控 `files.writeEnabled`（默认关）、删除永久+二次确认、下载 5 MiB 上限、安全模型复用 `resolveParent()` 容器隔离。

- [ ] **Step 2: 更新 `docs/config-reference.md`**

在 `terminal` 配置说明附近加 `files.writeEnabled`（boolean，默认 false；开启后允许 relay-web 文件树的新建/重命名/删除/复制；下载不受此开关影响）。

- [ ] **Step 3: 提交**

```bash
git add docs/relay-web-module.md docs/config-reference.md
git commit -m "docs: relay-web file writes + files.writeEnabled config"
```

---

## Self-Review Notes（写完自查）

- **Spec 覆盖：** 新文件=Task 2/6/10；新建文件夹=Task 2/6/10/11；重命名=Task 3/6/10；复制副本=Task 3/6/10；删除=Task 3/6/10；下载=Task 3/6/8/10；门控=Task 4/6；协议=Task 5；连接器=Task 7；i18n=Task 9；根级新建=Task 11；文档=Task 12。全覆盖，无「在 OS 打开」（spec 已明确范围外）。
- **类型一致：** `{ path: string }`（FsMutateResult）贯穿 create/rename/delete/copy；`readFileBytes`/`fsDownload` 返回 `{path,base64,size,mimeType}`（FsDownloadResult）一致；`copyName(existing: Set<string>, name)` 在 Task 3 定义并测试；store action 名与 Task 8 return 一致，组件（Task 10/11）消费同名。
- **门控划分：** 写方法（fsCreate/fsRename/fsDelete/fsCopy）门控；fsDownload 明确不门控（Task 6 注释 + 测试断言）。
- **安全：** 所有写经 `resolve()`/`resolveParent()`；`remove` 拒根；`rename`/`duplicate` 拒根；末段无分隔符校验（Task 1）。
