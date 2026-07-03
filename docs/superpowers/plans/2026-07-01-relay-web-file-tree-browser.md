# relay-web 文件树浏览器（子项目 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 relay-web Files 面板从"逐目录扁平列表"升级成懒加载树视图 + gitignore/点文件 感知（默认隐藏、显示时淡化+斜体）+ 高级搜索（文件名 + 内容 grep，含大小写/整词/正则/包含/排除）+ 右键复制路径/在此搜索 + 移动端满宽。全部只读。

**Architecture:** relay-web 前端为主 + 少量只读后端扩展（`WorkspaceFs`：`git check-ignore` 标记 ignored、返回主机绝对 root/sep、`git grep` 内容搜索 + 非 git 回退）。数据路径不变（`control.fs.*` RPC → hub ownership 门 → connector → core → WorkspaceFs.resolve() 三道闸）。无写操作、无新 config 门。

**Tech Stack:** Vue 3 `<script setup>` + Pinia + Tailwind + lucide-vue-next；core TypeScript + node:child_process git；bun test（后端）/ vitest（relay-web）。

## Global Constraints

- 只读子项目：不新增任何文件系统写操作、不新增 config 门。写/下载/在 OS 打开留给 B。
- 后端新能力必须作为 `WorkspaceFs` 方法、复用现有 `resolve()`（workspace 名白名单 + realpath 包含），不另开路径。
- git 相关全部 `execFile`/`spawn` 传 argv 数组，绝不走 shell。非 git 仓库/ git 缺失一律静默降级（不报错）。
- 协议改动为**增量向后兼容**（新字段可选或有缺省），relay-protocol 保持 0.1.x，`^0.1.0` range 不变。
- relay-protocol 构建用 `bun run build:relay-protocol`（bun build + tsc + assert，三步都要）。
- relay-web 测试 cwd=`packages/relay-web`，`npx vitest run <file>`；**不要**用 bun test（缺 jsdom 假失败）。后端/连接器测试用 `bun test <file>`。
- en/zh 两个 i18n catalog 必须键平价（`i18n-parity.test.ts` 自动校验）；无空串。
- 复制路径="主机绝对路径"= `root + sep + relPath`（按主机 sep）；复制相对路径= workspace 根相对（内部 `/`）。
- gitignore/点文件默认**隐藏**，两个 localStorage 开关显示；显示时行文字低透明度 + 斜体。

---

### Task 1: 后端 `WorkspaceFs.listDirectory` — ignored 标记 + 绝对 root/sep

**Files:**
- Modify: `src/control/workspace-fs.ts`（`FsEntry`/`DirListing` 接口 + `listDirectory` + 新增 `gitCheckIgnore` 私有方法）
- Test: `tests/unit/control/workspace-fs.test.ts`（追加用例）

**Interfaces:**
- Produces:
  - `FsEntry` 增 `ignored?: boolean`。
  - `DirListing` 增 `root: string`（主机绝对 realpath 根）、`sep: "/" | "\\"`。
  - `listDirectory(workspace, relPath?)` 返回值含上述字段；对本层被 gitignore 命中的条目标 `ignored:true`（非 git 仓库不标）。

- [ ] **Step 1: 写失败测试（追加到 workspace-fs.test.ts）**

在文件末尾追加一个 describe（用真实 git 仓库夹具）：

```ts
describe("WorkspaceFs listing: ignored flag + root/sep", () => {
  let gitRoot: string;
  let gfs: WorkspaceFs;
  beforeAll(() => {
    gitRoot = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    execFileSync("git", ["init", "-q"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitRoot });
    writeFileSync(join(gitRoot, ".gitignore"), "ignored.log\ndist/\n");
    writeFileSync(join(gitRoot, "keep.ts"), "export const x = 1;\n");
    writeFileSync(join(gitRoot, "ignored.log"), "noise\n");
    mkdirSync(join(gitRoot, "dist"));
    writeFileSync(join(gitRoot, "dist", "out.js"), "1\n");
    gfs = new WorkspaceFs(() => [{ name: "g", cwd: gitRoot }]);
  });
  afterAll(() => rmSync(gitRoot, { recursive: true, force: true }));

  test("marks gitignored entries and returns absolute root + sep", async () => {
    const r = await gfs.listDirectory("g", "");
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(byName["ignored.log"].ignored).toBe(true);
    expect(byName["dist"].ignored).toBe(true);
    expect(byName["keep.ts"].ignored).toBeUndefined();
    expect(r.root).toBe(require("node:fs").realpathSync(gitRoot));
    expect(r.sep).toBe(require("node:path").sep);
  });

  test("non-git workspace lists without ignored flags and still returns root/sep", async () => {
    const r = await fs.listDirectory("ws", "");
    expect(r.entries.every((e) => e.ignored === undefined)).toBe(true);
    expect(typeof r.root).toBe("string");
    expect(r.sep).toBe(require("node:path").sep);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: FAIL — `r.root`/`r.sep` undefined、`ignored` 未标。

- [ ] **Step 3: 实现**

3a. 顶部 `import { sep } from "node:path";` 已存在；确认还导入了 `spawn`：把第 1 行改为
```ts
import { execFile, spawn } from "node:child_process";
```

3b. 接口加字段：
```ts
export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
  /** True when git check-ignore matches this entry (omitted in non-git workspaces). */
  ignored?: boolean;
}
export interface DirListing {
  workspace: string;
  path: string;
  entries: FsEntry[];
  /** Absolute realpath'd workspace root on the connector host. */
  root: string;
  /** Host path separator, so the client can render an absolute host path. */
  sep: "/" | "\\";
}
```

3c. 新增私有方法（`git check-ignore` 批量，喂 stdin，退出码 1=无命中，其它错误=非 git→空集）：
```ts
  /** Return the subset of the given root-relative paths that git considers ignored.
   *  Uses `check-ignore -z --stdin` (bounded by the caller's MAX_ENTRIES listing).
   *  Any git error (not a repo, git missing) yields an empty set — callers degrade to
   *  "nothing ignored". Never throws. */
  private gitCheckIgnore(root: string, relPaths: string[]): Promise<Set<string>> {
    return new Promise((resolvePromise) => {
      if (!relPaths.length) return resolvePromise(new Set());
      const ignored = new Set<string>();
      let out = "";
      let child;
      try {
        child = spawn("git", ["-C", root, "check-ignore", "-z", "--stdin"], { stdio: ["pipe", "pipe", "ignore"] });
      } catch {
        return resolvePromise(ignored);
      }
      child.on("error", () => resolvePromise(ignored)); // git missing
      child.stdout.on("data", (b) => { out += b.toString(); });
      child.on("close", () => {
        for (const p of out.split("\0")) { if (p) ignored.add(p); }
        resolvePromise(ignored);
      });
      child.stdin.on("error", () => {}); // ignore EPIPE if git bails early
      child.stdin.end(relPaths.join("\0") + "\0");
    });
  }
```

3d. `listDirectory`：在排序后、返回前，计算 ignored 集并标注，返回 root/sep：
```ts
  async listDirectory(workspace: string, relPath?: string): Promise<DirListing> {
    const { root, abs, rel } = await this.resolve(workspace, relPath);
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      if (d.isDirectory()) {
        entries.push({ name: d.name, type: "dir" });
      } else if (d.isFile()) {
        let size: number | undefined;
        try {
          size = (await stat(resolve(abs, d.name))).size;
        } catch {
          size = undefined;
        }
        entries.push({ name: d.name, type: "file", size });
      }
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    // Mark gitignored entries (dirs are checked with a trailing slash so `dist/` rules match).
    const relOf = (name: string, isDir: boolean) => (rel ? `${rel}/${name}` : name) + (isDir ? "/" : "");
    const ignoredSet = await this.gitCheckIgnore(root, entries.map((e) => relOf(e.name, e.type === "dir")));
    for (const e of entries) {
      if (ignoredSet.has(relOf(e.name, e.type === "dir"))) e.ignored = true;
    }
    return { workspace, path: rel, entries, root, sep: sep as "/" | "\\" };
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: PASS（原有用例 + 2 新用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs.test.ts
git commit -m "feat(control): workspace-fs listing marks gitignored entries + returns host root/sep"
```

---

### Task 2: 后端 `WorkspaceFs.search` — 模式/开关/include/exclude/path + 内容 grep

**Files:**
- Modify: `src/control/workspace-fs.ts`（`SearchResult` 接口 + `search` 签名与实现 + 新增 `contentGrep` 私有方法）
- Test: `tests/unit/control/workspace-fs.test.ts`（追加用例）

**Interfaces:**
- Consumes: `resolve()`（Task 1 之前已存在）。
- Produces:
  - `SearchHit { path: string; line: number; text: string }`。
  - `SearchResult` 增 `hits: SearchHit[]`（保留 `matches`）。
  - `SearchOptions = { query: string; mode?: "name" | "content"; matchCase?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string; path?: string }`。
  - `search(workspace, opts: SearchOptions): Promise<SearchResult>`（**签名从 `(workspace, query)` 改为 `(workspace, opts)`**）。

- [ ] **Step 1: 写失败测试（追加到 workspace-fs.test.ts）**

复用上一个 describe 的 `gitRoot`/`gfs`（若在同文件）。追加：

```ts
describe("WorkspaceFs search: modes + flags", () => {
  test("name mode: regex + include filter on relative path", async () => {
    const r = await fs.search("ws", { query: "\\.ts$", mode: "name", regex: true });
    expect(r.matches).toContain("src/a.ts");
    expect(r.matches.every((m) => m.endsWith(".ts"))).toBe(true);
    expect(r.hits).toEqual([]);
  });

  test("name mode: exclude glob drops matches", async () => {
    const r = await fs.search("ws", { query: "a", mode: "name", exclude: "src/**" });
    expect(r.matches.some((m) => m.startsWith("src/"))).toBe(false);
  });

  test("content mode: finds a line and returns path/line/text", async () => {
    const r = await fs.search("ws", { query: "export const a", mode: "content" });
    const hit = r.hits.find((h) => h.path === "src/a.ts");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1);
    expect(hit!.text).toContain("export const a");
    expect(r.matches).toEqual([]);
  });

  test("content mode: case-sensitive miss vs case-insensitive hit", async () => {
    const sensitive = await fs.search("ws", { query: "EXPORT", mode: "content", matchCase: true });
    expect(sensitive.hits.length).toBe(0);
    const insensitive = await fs.search("ws", { query: "EXPORT", mode: "content", matchCase: false });
    expect(insensitive.hits.length).toBeGreaterThan(0);
  });

  test("empty query returns nothing", async () => {
    const r = await fs.search("ws", { query: "   ", mode: "content" });
    expect(r.hits).toEqual([]);
    expect(r.matches).toEqual([]);
  });
});
```

> 说明：`ws` 夹具（非 git，来自文件顶部 beforeAll）走**内容 grep 的回退路径**（手写走查），正好覆盖非 git 分支。

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: FAIL — `search` 不接受 opts 对象 / 无 `hits`。

- [ ] **Step 3: 实现**

3a. 顶部新增读取文件用的 import（已存在 `open`；新增 `readFile` 风格用现有 `open`+read，或直接用 `node:fs/promises` 的 `readFile`）。把第 4 行改为：
```ts
import { readdir, realpath, stat, open, readFile } from "node:fs/promises";
```
并新增常量（放在 SEARCH_* 附近）：
```ts
const SEARCH_CONTENT_MAX_HITS = 500;
const SEARCH_CONTENT_MAX_FILE = 1024 * 1024; // skip files > 1 MiB in the fallback walker
```

3b. 接口：
```ts
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}
export interface SearchResult {
  workspace: string;
  query: string;
  matches: string[];
  hits: SearchHit[];
  truncated: boolean;
}
export interface SearchOptions {
  query: string;
  mode?: "name" | "content";
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Glob to restrict matches (relative to workspace root). */
  include?: string;
  /** Glob to drop matches. */
  exclude?: string;
  /** Base directory (relative) to scope the search; defaults to the whole workspace. */
  path?: string;
}
```

3c. 重写 `search`（名字模式=增强路径匹配；内容模式=git grep + 回退）：
```ts
  async search(workspace: string, opts: SearchOptions): Promise<SearchResult> {
    const { root, abs: base } = await this.resolve(workspace, opts.path);
    const query = opts.query.trim();
    const empty: SearchResult = { workspace, query, matches: [], hits: [], truncated: false };
    if (!query) return empty;

    if ((opts.mode ?? "name") === "content") {
      return this.contentGrep(workspace, root, base, opts, query);
    }

    // name mode: walk relative paths, apply matcher + include/exclude globs.
    const matcher = buildMatcher(query, opts);
    const inc = opts.include ? globToRegExp(opts.include) : null;
    const exc = opts.exclude ? globToRegExp(opts.exclude) : null;
    const matches: string[] = [];
    let scanned = 0;
    let truncated = false;
    const queue: string[] = [base];
    while (queue.length) {
      const dir = queue.shift()!;
      let dirents;
      try { dirents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        if (++scanned > SEARCH_MAX_SCAN) { truncated = true; break; }
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) {
          if (!SEARCH_SKIP_DIRS.has(d.name)) queue.push(resolve(dir, d.name));
        } else if (d.isFile()) {
          const rel = relative(root, resolve(dir, d.name)).split(sep).join("/");
          if (inc && !inc.test(rel)) continue;
          if (exc && exc.test(rel)) continue;
          if (matcher(rel)) {
            matches.push(rel);
            if (matches.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
          }
        }
      }
      if (truncated) break;
    }
    matches.sort();
    return { workspace, query, matches, hits: [], truncated };
  }
```

3d. 新增内容 grep（git grep 优先，非 git 回退手写走查）：
```ts
  private async contentGrep(workspace: string, root: string, base: string, opts: SearchOptions, query: string): Promise<SearchResult> {
    // Try git grep first: it's fast and respects .gitignore. Args are argv (never a shell).
    const inGit = await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { maxBuffer: GIT_MAX_BUFFER })
      .then(() => true).catch(() => false);
    if (inGit) {
      const args = ["-C", root, "grep", "-n", "--column", "-I", "--no-color"];
      if (!opts.matchCase) args.push("-i");
      if (opts.wholeWord) args.push("-w");
      args.push(opts.regex ? "-E" : "-F");
      args.push("-e", query, "--");
      const scope = opts.path ? opts.path : ".";
      args.push(scope);
      if (opts.include) args.push(`:(glob)${opts.include}`);
      if (opts.exclude) args.push(`:(exclude,glob)${opts.exclude}`);
      let stdout = "";
      try {
        stdout = (await execFileAsync("git", args, { maxBuffer: GIT_MAX_BUFFER })).stdout;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 1) stdout = ""; // no matches
        else { const out = (e as { stdout?: string }).stdout; stdout = typeof out === "string" ? out : ""; }
      }
      const hits: SearchHit[] = [];
      let truncated = false;
      for (const raw of stdout.split("\n")) {
        if (!raw) continue;
        // format: <path>:<line>:<column>:<text>
        const m = raw.match(/^(.*?):(\d+):(\d+):(.*)$/);
        if (!m) continue;
        hits.push({ path: m[1].split(sep).join("/"), line: Number(m[2]), text: m[4].slice(0, 400) });
        if (hits.length >= SEARCH_CONTENT_MAX_HITS) { truncated = true; break; }
      }
      return { workspace, query, matches: [], hits, truncated };
    }

    // Fallback (non-git): bounded manual walk + per-line match.
    const matcher = buildLineMatcher(query, opts);
    const inc = opts.include ? globToRegExp(opts.include) : null;
    const exc = opts.exclude ? globToRegExp(opts.exclude) : null;
    const hits: SearchHit[] = [];
    let scanned = 0;
    let truncated = false;
    const queue: string[] = [base];
    while (queue.length) {
      const dir = queue.shift()!;
      let dirents;
      try { dirents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        if (++scanned > SEARCH_MAX_SCAN) { truncated = true; break; }
        if (d.isSymbolicLink()) continue;
        const full = resolve(dir, d.name);
        if (d.isDirectory()) { if (!SEARCH_SKIP_DIRS.has(d.name)) queue.push(full); continue; }
        if (!d.isFile()) continue;
        const rel = relative(root, full).split(sep).join("/");
        if (inc && !inc.test(rel)) continue;
        if (exc && exc.test(rel)) continue;
        let info; try { info = await stat(full); } catch { continue; }
        if (info.size > SEARCH_CONTENT_MAX_FILE) continue;
        let text; try { text = await readFile(full, "utf8"); } catch { continue; }
        if (text.includes(" ")) continue; // binary
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            hits.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400) });
            if (hits.length >= SEARCH_CONTENT_MAX_HITS) { truncated = true; break; }
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    return { workspace, query, matches: [], hits, truncated };
  }
```

3e. 在文件底部（class 外）加纯函数辅助（matcher/glob）：
```ts
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Build a path/name matcher for name-mode search. */
function buildMatcher(query: string, opts: SearchOptions): (s: string) => boolean {
  return buildLineMatcher(query, opts, /*substringDefault*/ true);
}
/** Build a per-line/string matcher honoring regex/wholeWord/matchCase. In non-regex
 *  mode it's a substring test; wholeWord wraps with \b boundaries. */
function buildLineMatcher(query: string, opts: SearchOptions, _substringDefault = true): (s: string) => boolean {
  const flags = opts.matchCase ? "" : "i";
  let pattern: string;
  if (opts.regex) pattern = query;
  else pattern = escapeRe(query);
  if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
  let re: RegExp | null = null;
  try { re = new RegExp(pattern, flags); } catch { re = null; }
  if (!re) {
    // Invalid user regex → fall back to case-adjusted substring so search never throws.
    const needle = opts.matchCase ? query : query.toLowerCase();
    return (s) => (opts.matchCase ? s : s.toLowerCase()).includes(needle);
  }
  return (s) => re!.test(s);
}
/** Minimal glob → RegExp for include/exclude (supports **, *, ?). Anchored full-match. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escapeRe(c);
  }
  re += "$";
  try { return new RegExp(re); } catch { return /$^/; }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: PASS（含新的 name/content/case/empty 用例；非 git `ws` 走回退路径）。

- [ ] **Step 5: 提交**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs.test.ts
git commit -m "feat(control): workspace-fs search modes (name+content grep) with case/word/regex/include/exclude/path"
```

---

### Task 3: 协议 DTO/message 扩展 + dist 重建

**Files:**
- Modify: `packages/relay-protocol/src/dtos.ts`（`FsEntryDto` + 新增 `FsSearchHitDto`）
- Modify: `packages/relay-protocol/src/messages.ts`（`FsListResult` + `FsSearchPayload` + `FsSearchResult`）
- Test: `tests/unit/packages/relay-protocol/web-dtos.test.ts` 或相邻 protocol 测试（若无针对 fs 的断言，则加最小断言）
- Build: `bun run build:relay-protocol`

**Interfaces:**
- Consumes: Task 1/2 的后端返回形状（root/sep/ignored/hits）。
- Produces: 供 connector（Task 4）与 relay-web（Task 6+）使用的类型。

- [ ] **Step 1: 改 dtos.ts**

`FsEntryDto` 加 `ignored?`；新增 `FsSearchHitDto`：
```ts
export interface FsEntryDto {
  name: string;
  type: "dir" | "file";
  /** File size in bytes; omitted for directories. */
  size?: number;
  /** True when git considers the entry ignored (omitted in non-git workspaces). */
  ignored?: boolean;
}

/** One content-search match line (mode:"content"). */
export interface FsSearchHitDto {
  path: string;
  line: number;
  text: string;
}
```

- [ ] **Step 2: 改 messages.ts**

2a. `FsListResult` 加 root/sep：
```ts
export interface FsListResult {
  workspace: string;
  path: string;
  entries: FsEntryDto[];
  /** Absolute realpath'd workspace root on the connector host. */
  root: string;
  /** Host path separator. */
  sep: "/" | "\\";
}
```

2b. `FsSearchPayload` 扩展（`query` 保留必填；其余可选，`mode` 缺省视为 "name"）：
```ts
export interface FsSearchPayload {
  workspace: string;
  query: string;
  mode?: "name" | "content";
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Glob to restrict matches (relative to workspace root). */
  include?: string;
  /** Glob to drop matches. */
  exclude?: string;
  /** Base directory (relative) to scope the search. */
  path?: string;
}
```

2c. `FsSearchResult` 加 hits，并把 import 行补上 `FsSearchHitDto`：
```ts
export interface FsSearchResult {
  workspace: string;
  query: string;
  /** File paths (name mode). */
  matches: string[];
  /** Content matches (content mode). */
  hits: FsSearchHitDto[];
  truncated: boolean;
}
```
messages.ts 第 1 行的 import 追加 `FsSearchHitDto`：
```ts
import type { AgentCatalogEntryDto, AgentDto, ControlEventDto, FsDiffFileDto, FsEntryDto, FsSearchHitDto, OrchestrationTaskDto, ScheduledTaskDto, SessionDto, WorkspaceDto } from "./dtos.js";
```

- [ ] **Step 3: 加/更新 protocol 断言测试**

在 `tests/unit/packages/relay-protocol/web-dtos.test.ts` 追加一个编译期形状断言（该测试文件用 bun test）：
```ts
import { test, expect } from "bun:test";
import type { FsListResult, FsSearchPayload, FsSearchResult, FsSearchHitDto, FsEntryDto } from "../../../../packages/relay-protocol/src/messages";

test("fs DTOs carry the tree-browser additions", () => {
  const entry: FsEntryDto = { name: "a", type: "file", ignored: true };
  const list: FsListResult = { workspace: "w", path: "", entries: [entry], root: "/abs", sep: "/" };
  const hit: FsSearchHitDto = { path: "a.ts", line: 3, text: "x" };
  const payload: FsSearchPayload = { workspace: "w", query: "x", mode: "content", regex: true, include: "**/*.ts", path: "src" };
  const result: FsSearchResult = { workspace: "w", query: "x", matches: [], hits: [hit], truncated: false };
  expect(list.root).toBe("/abs");
  expect(list.sep).toBe("/");
  expect(payload.mode).toBe("content");
  expect(result.hits[0].line).toBe(3);
});
```
（若 `web-dtos.test.ts` 从 `messages` 导入路径不同，按同目录既有 import 风格对齐。）

- [ ] **Step 4: 构建 dist + 跑测试 + 断言导出**

Run:
```bash
bun run build:relay-protocol
bun test tests/unit/packages/relay-protocol/web-dtos.test.ts
```
Expected: 构建成功（bun build + tsc + assert 三步 0 退出）；测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-protocol/src/dtos.ts packages/relay-protocol/src/messages.ts packages/relay-protocol/dist tests/unit/packages/relay-protocol/web-dtos.test.ts
git commit -m "feat(relay-protocol): fs tree-browser DTOs (ignored, root/sep, search modes+hits)"
```

---

### Task 4: 连接器 + control-service 透传扩展搜索

**Files:**
- Modify: `src/control/control-service.ts`（`searchWorkspace` 签名）
- Modify: `packages/channel-relay/src/control-bridge.ts`（`fsSearch` case 传新字段）
- Test: `tests/unit/packages/channel-relay/control-bridge.test.ts`（若存在则加 fsSearch passthrough 用例；若不存在则新建最小文件）

**Interfaces:**
- Consumes: `WorkspaceFs.search(workspace, opts)`（Task 2）、`FsSearchPayload`（Task 3）。
- Produces: `ControlService.searchWorkspace(workspace, opts: SearchOptions)`。

- [ ] **Step 1: 改 control-service.ts**

把 `searchWorkspace` 从 `(workspace, query)` 改为透传 opts。先在文件顶部的 `WorkspaceFs` 相关 import 里补 `SearchOptions` 类型导入（与 `DirListing`/`FileContent` 等同处）：
```ts
// 在现有 `import { ... } from "./workspace-fs";` 里追加 SearchOptions（若该文件用 type-only import 就放同一处）
```
然后：
```ts
  searchWorkspace(workspace: string, opts: import("./workspace-fs").SearchOptions): Promise<SearchResult> {
    return this.workspaceFs.search(workspace, opts);
  }
```
（若文件已具名导入 workspace-fs 类型，改为在那条 import 里加 `SearchOptions` 并写 `opts: SearchOptions`，避免 inline import。）

- [ ] **Step 2: 改 control-bridge.ts 的 fsSearch case**

```ts
    case MSG.fsSearch: {
      const input = payload as FsSearchPayload;
      if (!input.workspace) return errorPayload("bad-request", "workspace is required");
      return await control.searchWorkspace(input.workspace, {
        query: input.query ?? "",
        mode: input.mode,
        matchCase: input.matchCase,
        wholeWord: input.wholeWord,
        regex: input.regex,
        include: input.include,
        exclude: input.exclude,
        path: input.path,
      }); // SearchResult ≅ FsSearchResult
    }
```

- [ ] **Step 3: 写 passthrough 测试**

若 `tests/unit/packages/channel-relay/control-bridge.test.ts` 存在，追加；否则新建：
```ts
import { test, expect } from "bun:test";
import { dispatchControlRequest } from "../../../../packages/channel-relay/src/control-bridge";
import { MSG } from "@ganglion/xacpx-relay-protocol";

test("fsSearch passes advanced options through to control.searchWorkspace", async () => {
  let received: unknown;
  const control = {
    searchWorkspace: async (_ws: string, opts: unknown) => { received = opts; return { workspace: "w", query: "x", matches: [], hits: [], truncated: false }; },
  } as never;
  await dispatchControlRequest(control, MSG.fsSearch, { workspace: "w", query: "x", mode: "content", regex: true, include: "**/*.ts", exclude: "dist/**", path: "src", matchCase: true, wholeWord: true });
  expect(received).toEqual({ query: "x", mode: "content", matchCase: true, wholeWord: true, regex: true, include: "**/*.ts", exclude: "dist/**", path: "src" });
});
```
> 若 `dispatchControlRequest` 的实际导出名/签名不同，按 control-bridge.ts 的真实导出对齐（explore 记录其为 `dispatchControlRequest(control, type, payload)`）。

- [ ] **Step 4: 运行 + typecheck**

Run:
```bash
bun test tests/unit/packages/channel-relay/control-bridge.test.ts
npx tsc --noEmit
```
Expected: 测试 PASS；tsc 0 错误（含 control-service 新签名、connector 引用）。

- [ ] **Step 5: 提交**

```bash
git add src/control/control-service.ts packages/channel-relay/src/control-bridge.ts tests/unit/packages/channel-relay/control-bridge.test.ts
git commit -m "feat(control,channel-relay): thread advanced fs search options through the bridge"
```

---

### Task 5: i18n — 文件树/搜索/菜单/切换 文案（en + zh）

**Files:**
- Modify: `packages/relay-web/src/i18n/messages/en.ts`（`files` 块扩展）
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts`（`files` 块扩展）

**Interfaces:**
- Produces: 键 `files.tree.*`、`files.search.*`、`files.menu.*`、`files.toggle.*`（en/zh 平价）。

- [ ] **Step 1: 基线平价绿**

Run: `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts`
Expected: PASS。

- [ ] **Step 2: 在 en.ts 的 `files` 对象内追加子块**

在 `files: { ... }` 内（保留现有键）追加：
```ts
    tree: { expand: "Expand", collapse: "Collapse", emptyFolder: "Empty folder" },
    search: {
      matchCase: "Match case",
      wholeWord: "Match whole word",
      regex: "Use regular expression",
      include: "files to include",
      exclude: "files to exclude",
      byName: "By name",
      byContent: "By content",
      noContentMatches: "No matches in files",
    },
    menu: {
      copyPath: "Copy path",
      copyRelativePath: "Copy relative path",
      searchInFolder: "Search in this folder",
    },
    toggle: { showDotfiles: "Show dotfiles", showGitignored: "Show git-ignored" },
```

- [ ] **Step 3: 在 zh-CN.ts 的 `files` 对象内追加同结构**

```ts
    tree: { expand: "展开", collapse: "折叠", emptyFolder: "空文件夹" },
    search: {
      matchCase: "精确大小写",
      wholeWord: "匹配整词",
      regex: "使用正则",
      include: "要包含的文件",
      exclude: "要排除的文件",
      byName: "按文件名",
      byContent: "按内容",
      noContentMatches: "文件中无匹配",
    },
    menu: {
      copyPath: "复制路径",
      copyRelativePath: "复制相对路径",
      searchInFolder: "在此文件夹搜索",
    },
    toggle: { showDotfiles: "显示点文件", showGitignored: "显示 Git 忽略文件" },
```

- [ ] **Step 4: 平价校验**

Run: `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts`
Expected: PASS（en/zh 键一致、无空串）。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "i18n(relay-web): file tree browser strings (tree/search/menu/toggle, en+zh)"
```

---

### Task 6: 前端 — `file-icons.ts` 扩展名→lucide 图标

**Files:**
- Create: `packages/relay-web/src/lib/file-icons.ts`
- Test: `packages/relay-web/src/__tests__/file-icons.test.ts`

**Interfaces:**
- Produces: `iconForFile(name: string): Component`（lucide 组件）。

- [ ] **Step 1: 写失败测试**

Create `packages/relay-web/src/__tests__/file-icons.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FileCode, FileJson, FileImage, File as FileIcon } from "lucide-vue-next";
import { iconForFile } from "../lib/file-icons";

describe("iconForFile", () => {
  it("maps known extensions", () => {
    expect(iconForFile("main.ts")).toBe(FileCode);
    expect(iconForFile("data.json")).toBe(FileJson);
    expect(iconForFile("logo.svg")).toBe(FileImage);
    expect(iconForFile("photo.PNG")).toBe(FileImage); // case-insensitive
  });
  it("falls back to a generic file icon", () => {
    expect(iconForFile("mystery.xyz")).toBe(FileIcon);
    expect(iconForFile("noext")).toBe(FileIcon);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/file-icons.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `packages/relay-web/src/lib/file-icons.ts`:
```ts
import type { Component } from "vue";
import {
  File as FileIcon, FileCode, FileJson, FileText, FileImage, FileType,
  FileCog, FileLock, FileTerminal, FileArchive,
} from "lucide-vue-next";

const EXT_ICON: Record<string, Component> = {
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode, mjs: FileCode, cjs: FileCode,
  vue: FileCode, py: FileCode, rs: FileCode, go: FileCode, java: FileCode, rb: FileCode,
  c: FileCode, h: FileCode, cpp: FileCode, cs: FileCode, php: FileCode, swift: FileCode,
  html: FileCode, htm: FileCode,
  json: FileJson,
  md: FileText, mdx: FileText, txt: FileText, pdf: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, ico: FileImage, avif: FileImage,
  css: FileType, scss: FileType, sass: FileType, less: FileType,
  yml: FileCog, yaml: FileCog, toml: FileCog, ini: FileCog, env: FileCog, conf: FileCog,
  lock: FileLock,
  sh: FileTerminal, bash: FileTerminal, zsh: FileTerminal, fish: FileTerminal,
  zip: FileArchive, tar: FileArchive, gz: FileArchive, tgz: FileArchive, rar: FileArchive, "7z": FileArchive,
};

/** Pick a lucide icon component for a filename, by extension (case-insensitive). */
export function iconForFile(name: string): Component {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return FileIcon;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_ICON[ext] ?? FileIcon;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/file-icons.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/lib/file-icons.ts packages/relay-web/src/__tests__/file-icons.test.ts
git commit -m "feat(relay-web): file-type icon map (lucide by extension)"
```

---

### Task 7: 前端 — files store 树状态 + 搜索参数/hits + root/sep

**Files:**
- Modify: `packages/relay-web/src/stores/files.ts`
- Test: `packages/relay-web/src/__tests__/files.test.ts`（追加用例）

**Interfaces:**
- Consumes: `control.fs.list`（返回 root/sep/entries[].ignored）、`control.fs.search`（新 payload/hits）。
- Produces（store 新增）：
  - `root: Ref<string>`、`sep: Ref<"/" | "\\">`。
  - `tree: Ref<Record<string, FsEntryDto[]>>`（dir relPath → children，`""`=根）、`expanded: Ref<Set<string>>`、`loadingDirs: Ref<Set<string>>`。
  - `listTree(dir: string): Promise<void>`（拉某目录一层进 `tree`，并写 root/sep）。
  - `toggleExpand(dir: string): Promise<void>`（展开时若未缓存则 listTree；持久化 expanded）。
  - 搜索：`searchOpts: Ref<{ mode; matchCase; wholeWord; regex; include; exclude; path }>`、`hits: Ref<FsSearchHitDto[]>`；`search(query, optsOverride?)` 用 searchOpts 组 payload，回填 `matches`/`hits`。
  - `absPath(rel: string): string`（= root + sep + rel 按 sep）。

- [ ] **Step 1: 写失败测试（追加到 files.test.ts）**

```ts
describe("files store: tree + advanced search", () => {
  it("listTree caches a directory layer and records root/sep", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [{ name: "src", type: "dir" }], root: "/abs/ws", sep: "/" });
    const s = useFilesStore();
    s.instanceId = "i1"; s.workspace = "ws";
    await s.listTree("");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.list", { workspace: "ws", path: "" });
    expect(s.tree[""].map((e) => e.name)).toEqual(["src"]);
    expect(s.root).toBe("/abs/ws");
    expect(s.absPath("src/a.ts")).toBe("/abs/ws/src/a.ts");
  });

  it("toggleExpand lazy-loads then toggles without refetching", async () => {
    const s = useFilesStore();
    s.instanceId = "i1"; s.workspace = "ws";
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src", entries: [{ name: "a.ts", type: "file", size: 3 }], root: "/abs/ws", sep: "/" });
    await s.toggleExpand("src");
    expect(s.expanded.has("src")).toBe(true);
    expect(s.tree["src"].length).toBe(1);
    rpc.mockClear();
    await s.toggleExpand("src"); // collapse — no fetch
    expect(s.expanded.has("src")).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("content search sends advanced options and fills hits", async () => {
    const s = useFilesStore();
    s.instanceId = "i1"; s.workspace = "ws";
    s.searchOpts.mode = "content"; s.searchOpts.regex = true; s.searchOpts.include = "**/*.ts";
    rpc.mockResolvedValueOnce({ workspace: "ws", query: "foo", matches: [], hits: [{ path: "a.ts", line: 2, text: "foo" }], truncated: false });
    await s.search("foo");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.search", { workspace: "ws", query: "foo", mode: "content", matchCase: false, wholeWord: false, regex: true, include: "**/*.ts", exclude: "", path: "" });
    expect(s.hits[0].line).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/files.test.ts`
Expected: FAIL — `listTree`/`toggleExpand`/`searchOpts`/`hits`/`absPath` 不存在。

- [ ] **Step 3: 实现（在 files.ts 中新增，不破坏现有导出）**

3a. import 增补类型：
```ts
import { isErrorPayload, type FsDiffResult, type FsEntryDto, type FsListResult, type FsReadResult, type FsSearchResult, type FsSearchHitDto } from "@ganglion/xacpx-relay-protocol";
```

3b. 新增 state（放在现有 ref 附近）：
```ts
  const root = ref("");
  const sepChar = ref<"/" | "\\">("/");
  const tree = ref<Record<string, FsEntryDto[]>>({});
  const expanded = ref<Set<string>>(new Set());
  const loadingDirs = ref<Set<string>>(new Set());
  const hits = ref<FsSearchHitDto[]>([]);
  const searchOpts = ref<{ mode: "name" | "content"; matchCase: boolean; wholeWord: boolean; regex: boolean; include: string; exclude: string; path: string }>({
    mode: "name", matchCase: false, wholeWord: false, regex: false, include: "", exclude: "", path: "",
  });
```

3c. 新增 actions：
```ts
  function expandedKey(): string { return `xacpx.fileTree.expanded.${workspace.value ?? ""}`; }

  async function listTree(dir: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    loadingDirs.value = new Set(loadingDirs.value).add(dir);
    try {
      const r = unwrap(await api.rpc<FsListResult>(instanceId.value, "control.fs.list", { workspace: workspace.value, path: dir }));
      root.value = r.root; sepChar.value = r.sep;
      tree.value = { ...tree.value, [dir]: r.entries };
    } catch (e) {
      error.value = e instanceof Error ? e.message : "list-failed";
    } finally {
      const next = new Set(loadingDirs.value); next.delete(dir); loadingDirs.value = next;
    }
  }

  async function toggleExpand(dir: string): Promise<void> {
    const next = new Set(expanded.value);
    if (next.has(dir)) {
      next.delete(dir);
    } else {
      next.add(dir);
      if (!tree.value[dir]) await listTree(dir);
    }
    expanded.value = next;
    try { localStorage.setItem(expandedKey(), JSON.stringify([...next])); } catch { /* ignore */ }
  }

  function absPath(rel: string): string {
    const s = sepChar.value;
    return root.value + s + rel.split("/").join(s);
  }
```

3d. `selectWorkspace`：重置树并恢复展开态、拉根层。把现有 `selectWorkspace` 体末尾的 `await list("");` 替换为：
```ts
    tree.value = {}; hits.value = [];
    try { expanded.value = new Set(JSON.parse(localStorage.getItem(expandedKey()) ?? "[]") as string[]); } catch { expanded.value = new Set(); }
    await listTree("");
    // Re-hydrate previously expanded layers (best-effort).
    for (const dir of [...expanded.value]) { if (dir && !tree.value[dir]) await listTree(dir).catch(() => {}); }
```
（保留其上方对 file/diff/changed/query/results 的清理不变。删除对旧 `list("")` 的调用。）

3e. 重写 `search` 用 searchOpts 组 payload：
```ts
  async function search(q: string): Promise<void> {
    query.value = q;
    if (!instanceId.value || !workspace.value || !q.trim()) {
      results.value = []; hits.value = []; searchTruncated.value = false; return;
    }
    searching.value = true; error.value = "";
    try {
      const o = searchOpts.value;
      const r = unwrap(await api.rpc<FsSearchResult>(instanceId.value, "control.fs.search", {
        workspace: workspace.value, query: q,
        mode: o.mode, matchCase: o.matchCase, wholeWord: o.wholeWord, regex: o.regex,
        include: o.include, exclude: o.exclude, path: o.path,
      }));
      results.value = r.matches; hits.value = r.hits ?? []; searchTruncated.value = r.truncated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "search-failed";
    } finally {
      searching.value = false;
    }
  }
```

3f. `refresh`（Files tab 分支）改为清树缓存 + 重列已展开层：
```ts
    // 在 tab==="files" 分支里，替换 `await list(path.value); await loadStatus(); ...`：
    tree.value = {};
    await listTree("");
    for (const dir of [...expanded.value]) { if (dir) await listTree(dir).catch(() => {}); }
    await loadStatus();
    await loadGitSummary(instanceId.value, workspace.value);
```

3g. `reset()` 里追加 `tree.value = {}; expanded.value = new Set(); hits.value = []; root.value = ""; `（保持原有清理）。

3h. 导出追加：`return { ...(现有), root, sep: sepChar, tree, expanded, loadingDirs, hits, searchOpts, listTree, toggleExpand, absPath };`
> 注意：对外键名用 `sep`（映射到 `sepChar`），避免与 node 无关；`return` 里写 `sep: sepChar`。

> 旧的逐目录 `list`/`open(dir)`/`up` 保留（Changes tab 与 openFile 仍用；树视图改用 listTree/toggleExpand）。`open(file)` 打开文件的分支保持不变。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/files.test.ts`
Expected: PASS（现有 + 3 新用例）。若现有用例因 selectWorkspace 改动而依赖 `entries`，注意现有测试仍调用 `list`/`open`——它们不变；新树状态是并列新增。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/stores/files.ts packages/relay-web/src/__tests__/files.test.ts
git commit -m "feat(relay-web): files store tree state + advanced search params/hits + absPath"
```

---

### Task 8: 前端 — `ContextMenu.vue` + `FileTreeNode.vue`（递归树节点 + 右键菜单）

**Files:**
- Create: `packages/relay-web/src/components/ContextMenu.vue`
- Create: `packages/relay-web/src/components/FileTreeNode.vue`
- Test: `packages/relay-web/src/__tests__/filetree.test.ts`

**Interfaces:**
- Consumes: `useFilesStore()`（Task 7：tree/expanded/toggleExpand/absPath/open/searchOpts/search）、`iconForFile`（Task 6）、i18n（Task 5）。
- Produces:
  - `ContextMenu.vue`：props `{ x: number; y: number; items: { key: string; label: string }[] }`，emit `select(key)`、`close`。
  - `FileTreeNode.vue`：props `{ entry: FsEntryDto; dir: string; depth: number; showDotfiles: boolean; showGitignored: boolean }`，递归渲染子节点；emit `openFile(rel)`。

- [ ] **Step 1: 写失败测试**

Create `packages/relay-web/src/__tests__/filetree.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

const rpc = vi.fn();
vi.mock("../api/client", () => ({ api: { rpc: (id: string, t: string, p?: unknown) => rpc(id, t, p) } }));

import FileTreeNode from "../components/FileTreeNode.vue";
import { useFilesStore } from "../stores/files";

const g = { global: { mocks: { $t: (k: string) => k } } };

beforeEach(() => { setActivePinia(createPinia()); rpc.mockReset(); Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }); });

describe("FileTreeNode", () => {
  it("renders a dir row with a chevron and lazy-expands on click", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs"; s.sep = "/";
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src", entries: [{ name: "a.ts", type: "file", size: 3 }], root: "/abs", sep: "/" });
    const w = mount(FileTreeNode, { props: { entry: { name: "src", type: "dir" }, dir: "", depth: 0, showDotfiles: false, showGitignored: false }, ...g });
    await w.find('[data-test="tree-row"]').trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.list", { workspace: "ws", path: "src" });
    expect(s.expanded.has("src")).toBe(true);
  });

  it("hides dotfiles and gitignored children unless toggled on", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs"; s.sep = "/";
    s.tree[""] = [
      { name: "keep.ts", type: "file" },
      { name: ".env", type: "file" },
      { name: "dist", type: "dir", ignored: true },
    ] as never;
    // depth 0 rendered by a parent; here mount each child via a wrapper list is simpler:
    const rows = (showDot: boolean, showIgn: boolean) => mount({
      components: { FileTreeNode },
      template: `<div><FileTreeNode v-for="e in entries" :key="e.name" :entry="e" dir="" :depth="0" :show-dotfiles="sd" :show-gitignored="si" /></div>`,
      data: () => ({ entries: s.tree[""], sd: showDot, si: showIgn }),
    }, g);
    expect(rows(false, false).findAll('[data-test="tree-row"]').length).toBe(1); // only keep.ts
    expect(rows(true, true).findAll('[data-test="tree-row"]').length).toBe(3);
  });

  it("context menu copy path writes the absolute host path", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs/ws"; s.sep = "/";
    const w = mount(FileTreeNode, { props: { entry: { name: "a.ts", type: "file" }, dir: "src", depth: 1, showDotfiles: true, showGitignored: true }, ...g });
    await w.find('[data-test="tree-row"]').trigger("contextmenu");
    await w.find('[data-test="menu-copyPath"]').trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/abs/ws/src/a.ts");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/filetree.test.ts`
Expected: FAIL — 组件不存在。

- [ ] **Step 3: 实现 ContextMenu.vue**

Create `packages/relay-web/src/components/ContextMenu.vue`:
```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
defineProps<{ x: number; y: number; items: { key: string; label: string }[] }>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();
function onDocClick() { emit("close"); }
function onKey(e: KeyboardEvent) { if (e.key === "Escape") emit("close"); }
onMounted(() => { document.addEventListener("click", onDocClick); document.addEventListener("keydown", onKey); });
onBeforeUnmount(() => { document.removeEventListener("click", onDocClick); document.removeEventListener("keydown", onKey); });
</script>
<template>
  <div data-test="context-menu" class="fixed z-50 min-w-40 rounded-md border border-border bg-surface py-1 text-[12.5px] shadow-lg"
       :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
    <button v-for="it in items" :key="it.key" :data-test="`menu-${it.key}`"
            class="block w-full px-3 py-1.5 text-left text-fg hover:bg-raised"
            @click="emit('select', it.key); emit('close')">{{ it.label }}</button>
  </div>
</template>
```

- [ ] **Step 4: 实现 FileTreeNode.vue**

Create `packages/relay-web/src/components/FileTreeNode.vue`:
```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-vue-next";
import type { FsEntryDto } from "@ganglion/xacpx-relay-protocol";
import { useFilesStore } from "../stores/files";
import { iconForFile } from "../lib/file-icons";
import ContextMenu from "./ContextMenu.vue";

const props = defineProps<{ entry: FsEntryDto; dir: string; depth: number; showDotfiles: boolean; showGitignored: boolean }>();
const emit = defineEmits<{ openFile: [rel: string] }>();
const files = useFilesStore();

const rel = computed(() => (props.dir ? `${props.dir}/${props.entry.name}` : props.entry.name));
const isDir = computed(() => props.entry.type === "dir");
const isDot = computed(() => props.entry.name.startsWith("."));
const dim = computed(() => isDot.value || props.entry.ignored === true);
const isOpen = computed(() => files.expanded.has(rel.value));
const children = computed(() => files.tree[rel.value] ?? []);

// A child is visible when it passes both toggles.
function visible(e: FsEntryDto): boolean {
  if (e.ignored && !props.showGitignored) return false;
  if (e.name.startsWith(".") && !props.showDotfiles) return false;
  return true;
}
const visibleChildren = computed(() => children.value.filter(visible));

function onRowClick() {
  if (isDir.value) void files.toggleExpand(rel.value);
  else emit("openFile", rel.value);
}

// context menu (items are built inline in the template via i18n — see :items below)
const menu = ref<{ x: number; y: number } | null>(null);
function openMenu(e: MouseEvent) { menu.value = { x: e.clientX, y: e.clientY }; }
async function onMenuSelect(key: string) {
  if (key === "copyPath") await navigator.clipboard?.writeText(files.absPath(rel.value)).catch(() => {});
  else if (key === "copyRelativePath") await navigator.clipboard?.writeText(rel.value).catch(() => {});
  else if (key === "searchInFolder") { files.searchOpts.path = rel.value; }
  menu.value = null;
}
</script>

<template>
  <div>
    <button data-test="tree-row"
            class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-raised"
            :style="{ paddingLeft: depth * 12 + 4 + 'px' }"
            @click="onRowClick" @contextmenu.prevent="openMenu">
      <component :is="isOpen ? ChevronDown : ChevronRight" v-if="isDir" :size="12" class="shrink-0 text-fg-muted" />
      <span v-else class="w-3 shrink-0" />
      <component :is="isDir ? (isOpen ? FolderOpen : Folder) : iconForFile(entry.name)" :size="13"
                 class="shrink-0" :class="isDir ? 'text-warn' : 'text-fg-muted'" />
      <span class="flex-1 truncate text-[12px]" :class="[dim ? 'opacity-45 italic' : '', isDir ? 'text-fg font-medium' : 'text-fg-muted']">{{ entry.name }}</span>
    </button>

    <div v-if="isDir && isOpen">
      <FileTreeNode v-for="c in visibleChildren" :key="c.name" :entry="c" :dir="rel" :depth="depth + 1"
                    :show-dotfiles="showDotfiles" :show-gitignored="showGitignored" @open-file="emit('openFile', $event)" />
      <div v-if="!visibleChildren.length && files.tree[rel]" class="py-0.5 text-[11px] text-fg-muted" :style="{ paddingLeft: (depth + 1) * 12 + 16 + 'px' }">{{ $t("files.tree.emptyFolder") }}</div>
    </div>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y"
                 :items="isDir
                   ? [{ key: 'copyPath', label: $t('files.menu.copyPath') }, { key: 'copyRelativePath', label: $t('files.menu.copyRelativePath') }, { key: 'searchInFolder', label: $t('files.menu.searchInFolder') }]
                   : [{ key: 'copyPath', label: $t('files.menu.copyPath') }, { key: 'copyRelativePath', label: $t('files.menu.copyRelativePath') }]"
                 @select="onMenuSelect" @close="menu = null" />
  </div>
</template>
```
> 删除上面 `menuItems`/`base` 那段占位（它是误留），菜单项直接在模板里按 i18n 生成——实现时不要保留 `menuItems` computed。（见模板内 `:items`。）

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/filetree.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/relay-web/src/components/ContextMenu.vue packages/relay-web/src/components/FileTreeNode.vue packages/relay-web/src/__tests__/filetree.test.ts
git commit -m "feat(relay-web): recursive file tree node + context menu (copy path/rel/search-in-folder)"
```

---

### Task 9: 前端 — `FilesPanel.vue` 接入树 + 高级搜索 UI + 切换（去面包屑/向上）

**Files:**
- Modify: `packages/relay-web/src/components/FilesPanel.vue`
- Test: `packages/relay-web/src/__tests__/filespanel.test.ts`（更新/追加用例）

**Interfaces:**
- Consumes: `FileTreeNode.vue`（Task 8）、files store（Task 7）、i18n（Task 5）。

- [ ] **Step 1: 写/更新失败测试**

在 `filespanel.test.ts` 追加（并移除对 `fs-up`/breadcrumb 的旧断言，若有）：
```ts
it("renders the tree root (no breadcrumb / up button)", async () => {
  // mount FilesPanel with a stubbed store root layer
  const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.tree[""] = [{ name: "src", type: "dir" }] as never;
  // ...mount per existing filespanel.test harness...
  // expect no fs-up:
  // expect(w.find('[data-test="fs-up"]').exists()).toBe(false);
  // expect a tree row for src:
  // expect(w.find('[data-test="tree-row"]').exists()).toBe(true);
});
it("search toggles drive searchOpts", async () => {
  // click data-test="search-regex" → s.searchOpts.regex === true
  // click data-test="search-mode-content" → s.searchOpts.mode === "content"
});
it("dotfile/gitignore toggles persist and filter", async () => {
  // click data-test="toggle-dotfiles" → localStorage xacpx.files.showDotfiles === "1"
});
```
> 按 `filespanel.test.ts` 现有挂载 harness（mock store 或真实 pinia）补全断言主体；关键断言：无 `fs-up`、有 `tree-row`、`search-regex`/`search-mode-content` 改 `searchOpts`、`toggle-dotfiles`/`toggle-gitignored` 改状态并写 localStorage。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/filespanel.test.ts`
Expected: FAIL。

- [ ] **Step 3: 改 FilesPanel.vue（Files tab 部分）**

3a. script：新增 import `FileTreeNode`；新增 dotfile/gitignore 切换（localStorage 持久化）+ 搜索开关处理；删除 `crumbs`/`atRoot`/`upOne`。
```ts
import FileTreeNode from "./FileTreeNode.vue";
// dotfile / gitignore toggles
const showDotfiles = ref(localStorage.getItem("xacpx.files.showDotfiles") === "1");
const showGitignored = ref(localStorage.getItem("xacpx.files.showGitignored") === "1");
watch(showDotfiles, (v) => localStorage.setItem("xacpx.files.showDotfiles", v ? "1" : "0"));
watch(showGitignored, (v) => localStorage.setItem("xacpx.files.showGitignored", v ? "1" : "0"));
// visible root children (same predicate as FileTreeNode)
const rootChildren = computed(() => (files.tree[""] ?? []).filter((e) =>
  (!e.ignored || showGitignored.value) && (!e.name.startsWith(".") || showDotfiles.value)));
function openTreeFile(rel: string) { files.diffPath = null; void files.openFile(rel); }
// re-run search when opts change while a query is active
watch(() => ({ ...files.searchOpts }), () => { if (files.query.trim()) void files.search(files.query); }, { deep: true });
```

3b. template：把"browsing: 面包屑 + 目录 ul"整块（现 `<template v-else> ... </template>`，含 `fs-up` 按钮与 `<ul class="... file listing ...">`）替换为树：
```html
<template v-else>
  <div class="flex shrink-0 items-center gap-3 border-b border-border px-2.5 py-1 text-[11px] text-fg-muted">
    <label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" data-test="toggle-dotfiles" v-model="showDotfiles" class="accent-accent" />{{ $t("files.toggle.showDotfiles") }}</label>
    <label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" data-test="toggle-gitignored" v-model="showGitignored" class="accent-accent" />{{ $t("files.toggle.showGitignored") }}</label>
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto thin-scroll py-1 font-mono">
    <FileTreeNode v-for="e in rootChildren" :key="e.name" :entry="e" dir="" :depth="0"
                  :show-dotfiles="showDotfiles" :show-gitignored="showGitignored" @open-file="openTreeFile" />
    <div v-if="!rootChildren.length && !files.loading" class="px-3 py-1 text-xs text-fg-muted">{{ $t("files.emptyDirectory") }}</div>
  </div>
</template>
```

3c. 搜索区：在现有搜索 input 行右侧加三个开关按钮 + 下方 include/exclude + 模式切换。把搜索 `<div class="... px-2 py-1">` 块扩展：
```html
<div class="shrink-0 border-b border-border px-2 py-1 space-y-1">
  <div class="flex items-center gap-1">
    <input v-model="searchInput" data-test="fs-search" :placeholder="$t('files.searchPlaceholder')"
           class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg placeholder:text-fg-muted" @input="onSearchInput" />
    <button data-test="search-matchcase" :title="$t('files.search.matchCase')" @click="files.searchOpts.matchCase = !files.searchOpts.matchCase"
            class="grid h-6 w-6 place-items-center rounded text-[11px]" :class="files.searchOpts.matchCase ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">Aa</button>
    <button data-test="search-wholeword" :title="$t('files.search.wholeWord')" @click="files.searchOpts.wholeWord = !files.searchOpts.wholeWord"
            class="grid h-6 w-6 place-items-center rounded text-[11px]" :class="files.searchOpts.wholeWord ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">W</button>
    <button data-test="search-regex" :title="$t('files.search.regex')" @click="files.searchOpts.regex = !files.searchOpts.regex"
            class="grid h-6 w-6 place-items-center rounded font-mono text-[11px]" :class="files.searchOpts.regex ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">.*</button>
    <button v-if="searchInput" :aria-label="$t('files.clearSearch')" class="text-fg-muted hover:text-fg" @click="clearSearch"><X :size="14" /></button>
  </div>
  <div class="flex items-center gap-1">
    <input v-model="files.searchOpts.include" data-test="search-include" :placeholder="$t('files.search.include')" class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-fg placeholder:text-fg-muted" />
    <input v-model="files.searchOpts.exclude" data-test="search-exclude" :placeholder="$t('files.search.exclude')" class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-fg placeholder:text-fg-muted" />
  </div>
  <div class="flex items-center gap-1 text-[11px]">
    <button data-test="search-mode-name" @click="files.searchOpts.mode = 'name'" class="rounded px-2 py-0.5" :class="files.searchOpts.mode === 'name' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">{{ $t("files.search.byName") }}</button>
    <button data-test="search-mode-content" @click="files.searchOpts.mode = 'content'" class="rounded px-2 py-0.5" :class="files.searchOpts.mode === 'content' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">{{ $t("files.search.byContent") }}</button>
  </div>
</div>
```

3d. 搜索结果：内容模式渲染 hits（按文件分组），名字模式沿用现有 results 列表。在现有 `fs-results` 块加内容分支：
```html
<div v-if="files.query.trim()" data-test="fs-results" class="min-h-0 flex-1 overflow-y-auto thin-scroll">
  <template v-if="files.searchOpts.mode === 'content'">
    <div v-if="!files.hits.length && !files.searching" class="px-3 py-1 text-xs text-fg-muted">{{ $t("files.search.noContentMatches") }}</div>
    <ul class="p-2 text-[11px] font-mono leading-5">
      <li v-for="(h, i) in files.hits" :key="i">
        <button data-test="fs-hit" class="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-raised" @click="openSearchResult(h.path)">
          <span class="shrink-0 text-fg-muted/70">{{ h.path }}:{{ h.line }}</span>
          <span class="truncate text-fg-muted">{{ h.text }}</span>
        </button>
      </li>
    </ul>
    <div v-if="files.searchTruncated" class="px-2.5 pb-1 text-xs text-warn">{{ $t("files.showingFirstMatches") }}</div>
  </template>
  <template v-else>
    <!-- existing name-mode results list unchanged -->
  </template>
</div>
```
（保留现有名字模式 `<ul>` 结果块，移入 `v-else`。）

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `cd packages/relay-web && npx vitest run src/__tests__/filespanel.test.ts && npx vue-tsc --noEmit -p tsconfig.json`
Expected: PASS；tsc 干净（无 `crumbs`/`upOne`/`fs-up` 残留引用）。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/components/FilesPanel.vue packages/relay-web/src/__tests__/filespanel.test.ts
git commit -m "feat(relay-web): FilesPanel tree view + advanced search UI + dotfile/gitignore toggles (drop breadcrumb/up)"
```

---

### Task 10: 前端 — 移动端右栏抽屉满宽

**Files:**
- Modify: `packages/relay-web/src/views/DashboardView.vue`（右栏 `data-drawer="right"` 的 class）
- Test: `packages/relay-web/src/__tests__/dashboard-responsive.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**

追加：
```ts
test("right drawer is full-width on mobile (no 85% cap)", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("w-full");
  expect(right.classes()).not.toContain("max-w-[85%]");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-responsive.test.ts`
Expected: FAIL — 右栏仍是 `w-72 max-w-[85%]`。

- [ ] **Step 3: 改 DashboardView.vue（第 331 行右栏 class）**

把右栏 `data-drawer="right"` 的 class 中的 `w-72 max-w-[85%]` 改为 `w-full`（其余不变，`lg:w-[296px] lg:max-w-none` 保留）：
```
class="fixed inset-y-0 right-0 z-40 flex w-full shrink-0 transform flex-col overflow-hidden border-l border-border bg-surface shadow-lg transition-transform pt-[env(safe-area-inset-top)] lg:relative lg:z-auto lg:w-[296px] lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none lg:pt-0"
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-responsive.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/__tests__/dashboard-responsive.test.ts
git commit -m "feat(relay-web): right drawer full-width on mobile"
```

---

### Task 11: 全量回归 + 构建验证 + 文档

**Files:**
- Modify: `docs/relay-web-module.md`（加"Files/文件树浏览器"小节）

- [ ] **Step 1: 后端/连接器/协议回归**

Run:
```bash
bun test tests/unit/control/workspace-fs.test.ts tests/unit/packages/relay-protocol/web-dtos.test.ts tests/unit/packages/channel-relay/control-bridge.test.ts
npx tsc --noEmit
```
Expected: 全绿；tsc 0 错误。

- [ ] **Step 2: relay-web 全量单测**

Run: `cd packages/relay-web && npx vitest run`
Expected: 全绿（含 file-icons/files/filetree/filespanel/dashboard-responsive/i18n-parity）。

- [ ] **Step 3: 真实构建**

Run: `bun run build:relay-web`
Expected: 成功（vue-tsc 干净 + vite build）。

- [ ] **Step 4: 文档小节**

在 `docs/relay-web-module.md` 增加一节，说明 Files tab 现为懒加载树（`control.fs.list` 逐层）、gitignore/点文件 默认隐藏可切换、高级搜索（name/content、大小写/整词/正则/include/exclude/path）、右键复制路径/相对路径/在此搜索、移动端右栏满宽；并注明写操作在子项目 B。

- [ ] **Step 5: 提交**

```bash
git add docs/relay-web-module.md
git commit -m "docs(relay-web): document file tree browser (sub-project A)"
```

---

## Self-Review

**Spec coverage：**
- 需求 1 树视图/图标/去面包屑 → Task 6（图标）/8（节点）/9（面板+去面包屑）✅
- 需求 2 gitignore/点文件 淡化+斜体 → Task 1（后端 ignored）/8（节点淡化样式）✅
- 需求 3 高级搜索（include/exclude/大小写/整词/正则 + 内容 grep）→ Task 2（后端）/3（协议）/4（透传）/7（store）/9（UI）✅
- 需求 5 显示点文件/显示 gitignore 切换 → Task 9（切换 + 持久化）/8（过滤谓词）✅
- 需求 6 移动端满宽 → Task 10 ✅
- 需求 4 只读子集（复制路径/复制相对路径/在此文件夹搜索）→ Task 8（菜单）；复制路径=主机绝对路径依赖 Task 1 的 root/sep + Task 7 的 absPath ✅
- 写操作/下载/在 OS 打开 → 明确留给 B（本计划非目标）✅

**Placeholder scan：** 各 code 步给出完整代码；Task 8 的 `menuItems` 占位已移除（菜单项在模板 `:items` 内按 i18n 生成）。Task 9 的 filespanel 测试主体依赖现有 harness，已给出关键断言与 data-test 契约（挂载样板对齐现有文件），实现者按现有 filespanel.test.ts 的挂载方式补全测试体。

**Type consistency：** `FsEntryDto.ignored`、`FsListResult.root/sep`、`FsSearchHitDto{path,line,text}`、`FsSearchPayload`/`FsSearchResult.hits`、`SearchOptions`、store 的 `searchOpts`/`hits`/`absPath`/`listTree`/`toggleExpand`、组件 props 跨任务一致。store 对外键 `sep`（内部 `sepChar`）已注明。`search(workspace, opts)` 新签名在 Task 2 定义、Task 4 消费一致。

## 备注
- gitignore 标记与内容 grep 都在非 git/ git 缺失时静默降级；内容 grep 默认（git grep）不搜被忽略文件，符合"忽略"语义。
- 跳转到具体行为尽力（FileViewer 现不支持行定位），A 只保证打开文件。
- B 子项目（写/下载/OS 打开）另开分支与 spec，复用本计划的 ContextMenu/树骨架与后端 resolve()。
