# relay-web 目录选择器（跨实例）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** relay-web 新建会话「新路径」模式与 Workspaces 管理器新增工作区表单，各加一个「选择目录」按钮，打开浏览目标实例文件系统的目录选择弹窗，确认后回填绝对路径。

**Architecture:** 新增 config-global RPC `control.fs.browse`（daemon `ControlService.browseDirectories` 列目录-only，不经 `WorkspaceFs` 的 workspace 白名单），hub 既有 `/api/instances/:id/rpc` 透传；Web 端新组件 `DirectoryPicker.vue`（导航即进入 + 底部确认当前目录）。设计 spec：`docs/superpowers/specs/2026-08-20-relay-web-directory-picker-design.md`。

**Tech Stack:** TypeScript (Bun workspace)、Bun test（根 monorepo）、Vue 3 + Pinia + vue-i18n + Vitest（packages/relay-web）。

## Global Constraints

- MSG 常量值 verbatim：`fsBrowse: "control.fs.browse"`；config-global（非 chat-scoped），hub 无需改动。
- 上限 `MAX_BROWSE_ENTRIES = 1000`，超出 `truncated: true`。
- 只返回目录名+路径，不返回文件、内容、mtime、权限。
- 排序 locale 无关：先 `toLowerCase()` 比较，再原串比较（稳定）。
- `~`/`~/` 展开为实例 home；空/缺省 path = home；相对路径 `resolve(home, p)`。
- `parent` 在文件系统根（`dirname(p) === p`）时为 `null`。
- i18n 新增 key 必须同时进 `en.ts` 与 `zh-CN.ts`（`i18n-parity.test.ts` 强制）。
- 每步 TDD：先测试（红）→ 实现（绿）→ commit。
- 根 monorepo 测试命令：`npm test`（typecheck + 全部 unit）；relay-web：`bun run test:web`。

---

### Task 1: 协议 — `control.fs.browse` 常量 + DTO + payload validator

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts`（MSG 对象 ~line 61；DTO 在 `FsListResult` 后 ~line 501）
- Modify: `packages/relay-protocol/src/payload-validators.ts`（import、validator、`ControlRpcType` union、registry）
- Test: `tests/unit/packages/relay-protocol/messages.test.ts`

**Interfaces:**
- Consumes: 无（首任务）。
- Produces: `MSG.fsBrowse`、`FsBrowsePayload { path?: string }`、`FsBrowseEntry { name: string; path: string }`、`FsBrowseResult { path: string; sep: "/" | "\\"; parent: string | null; home: string; dirs: FsBrowseEntry[]; truncated: boolean }`、`parseControlPayload(MSG.fsBrowse, payload)`。Task 2/3/5 消费这些类型。

- [ ] **Step 1: Write the failing test**

在 `tests/unit/packages/relay-protocol/messages.test.ts` 现有 `expect(MSG.workspacesRemove).toBe("control.workspaces.remove");` 的 test 块（~line 39）内追加两行断言：

```ts
  expect(MSG.fsBrowse).toBe("control.fs.browse");
```

并在文件末尾追加新 test：

```ts
test("fsBrowse payload validator accepts empty and path payloads, rejects non-string path", () => {
  const { parseControlPayload, MSG } = ... // 用文件顶部已有的导入方式，勿重复 import
  expect(parseControlPayload(MSG.fsBrowse, {})).toEqual({});
  expect(parseControlPayload(MSG.fsBrowse, { path: "/srv" })).toEqual({ path: "/srv" });
  expect(parseControlPayload(MSG.fsBrowse, { path: "~" })).toEqual({ path: "~" });
  expect(parseControlPayload(MSG.fsBrowse, { path: 42 })).toBeNull();
  expect(parseControlPayload(MSG.fsBrowse, "nope")).toBeNull();
});
```

（打开该测试文件确认顶部 import 形态后按其现有方式引用 `parseControlPayload`/`MSG`；该文件已 import `MSG`。）

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay-protocol/messages.test.ts`
Expected: FAIL — `MSG.fsBrowse` 为 `undefined`（常量未加）。

- [ ] **Step 3: Implement protocol**

`packages/relay-protocol/src/messages.ts` — MSG 对象里 `fsList: "control.fs.list",`（line 61）之后加：

```ts
  fsBrowse: "control.fs.browse",
```

`FsListResult` 接口（line 492-501）之后加 DTO：

```ts
// --- instance directory picker (NOT scoped to a configured workspace; lists
// directories anywhere on the instance host, for choosing a workspace cwd) ---
export interface FsBrowsePayload {
  /** Absolute directory path on the instance host. Empty/omitted = home; `~` and
   *  `~/` expand to home; relative paths resolve against home. */
  path?: string;
}
export interface FsBrowseEntry {
  name: string;
  /** Absolute path of this directory. */
  path: string;
}
export interface FsBrowseResult {
  /** Normalized absolute path (no trailing separator; roots are "/" or "C:\"). */
  path: string;
  /** Host path separator. */
  sep: "/" | "\\";
  /** Parent absolute path; null at a filesystem root (POSIX "/", Windows drive root). */
  parent: string | null;
  /** Instance user home directory (for the "home" shortcut). */
  home: string;
  /** Subdirectories including hidden ones (client filters display); sorted
   *  locale-independently by name. */
  dirs: FsBrowseEntry[];
  /** True when the directory count hit the cap and the list was truncated. */
  truncated: boolean;
}
```

`packages/relay-protocol/src/payload-validators.ts`：
1. import 块加 `type FsBrowsePayload,`（在 `type FsListPayload,` 前，按字母序）。
2. `validateFsList`（line 200-203）之后加：

```ts
const validateFsBrowse: Validator<FsBrowsePayload> = (p) => {
  const o = fields(p);
  return o && optStr(o.path) ? (o as unknown as FsBrowsePayload) : null;
};
```

3. `ControlRpcType` union 的 `| typeof MSG.fsList`（line 370）改为 `| typeof MSG.fsList | typeof MSG.fsBrowse`。
4. `CONTROL_PAYLOAD_VALIDATORS` 里 `[MSG.fsList]: validateFsList,`（line 408）之后加 `[MSG.fsBrowse]: validateFsBrowse,`。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/packages/relay-protocol/messages.test.ts && npx tsc --noEmit`
Expected: PASS / 无类型错误（`satisfies Record<ControlRpcType, …>` 两向锁定已同步）。

- [ ] **Step 5: Commit**

```bash
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/src/payload-validators.ts tests/unit/packages/relay-protocol/messages.test.ts
git commit -m "feat(relay-protocol): add control.fs.browse RPC contract"
```

---

### Task 2: Daemon — `browseDirectories`（目录-only、跨盘、上限 1000）

**Files:**
- Modify: `src/control/workspace-fs.ts`（`expandHome` 加 `export` ~line 12；文件头部加类型与模块函数）
- Modify: `src/control/control-service.ts`（imports + 方法，放在 `listDirectory` ~line 405-407 之后）
- Test: `tests/unit/control/control-service-browse.test.ts`（新建）

**Interfaces:**
- Consumes: `FsBrowseResult`/`FsBrowseEntry`（Task 1）。
- Produces: `ControlService.browseDirectories(path?: string): Promise<FsBrowseResult>`（Task 3 bridge 调用）；`workspace-fs.ts` 导出 `expandHome`、`browseDirectories`（模块函数，ControlService 委托）。

- [ ] **Step 1: Write the failing test**

新建 `tests/unit/control/control-service-browse.test.ts`（bun:test 风格，参照 `control-service-config.test.ts`；用真实 tmpdir）：

```ts
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep, dirname } from "node:path";
import { ControlService } from "../../../src/control/control-service";
import { homedir } from "node:os";

const deps = {} as never; // browseDirectories touches no deps

test("browseDirectories defaults to home and reports home/sep/parent", async () => {
  const control = new ControlService(deps);
  const r = await control.browseDirectories();
  expect(r.path).toBe(homedir());
  expect(r.home).toBe(homedir());
  expect(r.sep).toBe(sep === "\\" ? "\\" : "/");
  expect(r.parent).toBe(dirname(homedir()));
});

test("browseDirectories lists only directories, sorted, including hidden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-"));
  await mkdir(join(dir, "b-dir"));
  await mkdir(join(dir, "A-dir"));
  await mkdir(join(dir, ".hidden"));
  await mkdir(join(dir, "sub", "nested")); // nested only visible inside sub
  await writeFile(join(dir, "file.txt"), "x");
  const control = new ControlService(deps);
  const r = await control.browseDirectories(dir);
  expect(r.dirs.map((d) => d.name)).toEqual([".hidden", "A-dir", "b-dir", "sub"]);
  expect(r.dirs.every((d) => d.path.startsWith(dir))).toBe(true);
  expect(r.truncated).toBe(false);
});

test("browseDirectories expands ~ and resolves relative against home", async () => {
  const control = new ControlService(deps);
  const r = await control.browseDirectories("~");
  expect(r.path).toBe(homedir());
});

test("browseDirectories follows symlinks to directories, skips broken ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-link-"));
  await mkdir(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "alias"));
  await symlink(join(dir, "nowhere"), join(dir, "broken"));
  const control = new ControlService(deps);
  const r = await control.browseDirectories(dir);
  expect(r.dirs.map((d) => d.name).sort()).toEqual(["alias", "real"]);
});

test("browseDirectories truncates at 1000 entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-cap-"));
  // 1000 dirs + 1 over cap; mkdir 1001 tiny dirs is fast enough (~50ms)
  await Promise.all(Array.from({ length: 1001 }, (_, i) => mkdir(join(dir, `d${String(i).padStart(5, "0")}`))));
  const control = new ControlService(deps);
  const r = await control.browseDirectories(dir);
  expect(r.dirs.length).toBe(1000);
  expect(r.truncated).toBe(true);
});

test("browseDirectories reports null parent at a filesystem root", async () => {
  const control = new ControlService(deps);
  const r = await control.browseDirectories(sep);
  expect(r.parent).toBeNull();
});

test("browseDirectories throws ENOENT for a missing path", async () => {
  const control = new ControlService(deps);
  const missing = join(tmpdir(), "browse-nope-" + Date.now());
  await expect(control.browseDirectories(missing)).rejects.toThrow(/ENOENT|no such file/i);
});
```

注：EACCES 用例在 root 环境（CI 容器常 root，chmod 000 不拦 root）不可靠，跳过——ENOENT 已覆盖错误透传路径。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/control/control-service-browse.test.ts`
Expected: FAIL — `control.browseDirectories is not a function`。

- [ ] **Step 3: Implement**

`src/control/workspace-fs.ts`：
1. line 12 `function expandHome(` → `export function expandHome(`（仅加 `export`，其余不动）。
2. 文件 imports 区确认已有 `homedir`（来自 `node:os`）、`resolve`/`sep`（来自 `node:path`）；补 `readdir, stat`（来自 `node:fs/promises`，若尚未导入）。头部 import 形态参照文件现状。
3. `WorkspaceRef` 接口（~line 111）之前加：

```ts
// --- instance directory picker (workspace-independent) ---
// Unlike the WorkspaceFs methods above, browseDirectories is NOT scoped to a
// configured workspace: its purpose is choosing a cwd for a NEW workspace, so
// the workspace whitelist cannot apply. Directory names only, capped, no metadata.
export interface BrowseDirsResult {
  path: string;
  sep: "/" | "\\";
  parent: string | null;
  home: string;
  dirs: Array<{ name: string; path: string }>;
  truncated: boolean;
}

const MAX_BROWSE_ENTRIES = 1000;

export async function browseDirectories(input?: string): Promise<BrowseDirsResult> {
  const raw = (input ?? "").trim();
  const dir = resolve(homedir(), expandHome(raw));
  const dirents = await readdir(dir, { withFileTypes: true });
  const out: Array<{ name: string; path: string }> = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      out.push({ name: d.name, path: join(dir, d.name) });
      continue;
    }
    if (d.isSymbolicLink()) {
      try {
        if ((await stat(join(dir, d.name))).isDirectory()) {
          out.push({ name: d.name, path: join(dir, d.name) });
        }
      } catch {
        /* broken link — skip */
      }
    }
  }
  out.sort((a, b) => {
    const la = a.name.toLowerCase(), lb = b.name.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const truncated = out.length > MAX_BROWSE_ENTRIES;
  if (truncated) out.length = MAX_BROWSE_ENTRIES;
  const parent = dirname(dir);
  return {
    path: dir,
    sep: sepChar(),
    parent: parent === dir ? null : parent,
    home: homedir(),
    dirs: out,
    truncated,
  };
}

function sepChar(): "/" | "\\" {
  return sep === "\\" ? "\\" : "/";
}
```

（`join` 来自 `node:path`，如未导入则加入该 import。）

`src/control/control-service.ts`：
1. 从 `./workspace-fs` 的 import 里追加 `browseDirectories as browseDirs, type BrowseDirsResult,`（保留现有项）。
2. `listDirectory` 方法（line 405-407）之后加：

```ts
  // Directory-only picker over the WHOLE instance host (not workspace-scoped) —
  // used by the relay-web "choose directory" dialog to pick a cwd for a new
  // workspace. Directory names only; capped at 1000; no file contents/metadata.
  browseDirectories(path?: string): Promise<BrowseDirsResult> {
    return browseDirs(path);
  }
```

`BrowseDirsResult` 与 Task 1 的 `FsBrowseResult` 结构相同（bridge 直接透传，TS 结构化兼容）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/control/control-service-browse.test.ts && npx tsc --noEmit`
Expected: 全部 PASS；无类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/control/workspace-fs.ts src/control/control-service.ts tests/unit/control/control-service-browse.test.ts
git commit -m "feat(control): add browseDirectories for instance-wide directory picking"
```

---

### Task 3: Bridge — `case MSG.fsBrowse` 映射

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts`（fs family，`case MSG.fsList` 块 ~line 473-483 之后）
- Test: `tests/unit/packages/channel-relay/control-bridge.test.ts`

**Interfaces:**
- Consumes: `MSG.fsBrowse`、`parseControlPayload`（Task 1）；`control.browseDirectories(path?)`（Task 2）。
- Produces: hub→connector 通道对 `control.fs.browse` 的响应（`FsBrowseResult` 或 `{error:{code:"invalid-payload"|"internal",message}}`）。Task 5 的 Web 端消费。

- [ ] **Step 1: Write the failing test**

在 `tests/unit/packages/channel-relay/control-bridge.test.ts` 的 fake control 对象（`makeFakeControl` 内，`listWorkspaces` 之后）加：

```ts
    browseDirectories: async (path?: string) => {
      record("browseDirectories", path);
      return {
        path: path ?? "/home",
        sep: "/",
        parent: path ? dirname(path) : "/",
        home: "/home",
        dirs: [{ name: "proj", path: `${path ?? "/home"}/proj` }],
        truncated: false,
      };
    },
```

（文件顶部 `import { dirname } from "node:path";` 补上。）文件末尾追加 test：

```ts
test("fsBrowse maps to browseDirectories and rejects malformed payloads", async () => {
  const { control, calls } = makeBridge(); // 打开文件确认现有 harness 辅助函数名并复用
  const ok = await dispatch(req(MSG.fsBrowse, { path: "/srv" }));
  expect(calls.browseDirectories).toEqual(["/srv"]);
  expect((ok as { path: string }).path).toBe("/srv");
  const bad = await dispatch(req(MSG.fsBrowse, { path: 7 }));
  expect(bad).toMatchObject({ error: { code: "invalid-payload" } });
  expect(await dispatch(req(MSG.fsBrowse, {}))).toMatchObject({ path: "/home" });
});
```

（打开该文件确认现有「构造 bridge + dispatch envelope」的辅助写法——已有测试大量采用，照抄同款调用方式，勿发明新 harness。）

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/channel-relay/control-bridge.test.ts`
Expected: FAIL — fake control 无 `browseDirectories` 或 dispatch 返回 `unknown-type`。

- [ ] **Step 3: Implement**

`packages/channel-relay/src/control-bridge.ts`，`case MSG.fsList: { … }` 块结束（`return await control.listDirectory(input.workspace, input.path); }` ~line 483）之后加：

```ts
    case MSG.fsBrowse: {
      const input = parseControlPayload(MSG.fsBrowse, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsBrowse}: malformed payload`,
        );
      return await control.browseDirectories(input.path); // BrowseDirsResult ≅ FsBrowseResult
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/packages/channel-relay/control-bridge.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/channel-relay/src/control-bridge.ts tests/unit/packages/channel-relay/control-bridge.test.ts
git commit -m "feat(channel-relay): bridge control.fs.browse to ControlService"
```

---

### Task 4: i18n — en + zh-CN 镜像 key

**Files:**
- Modify: `packages/relay-web/src/i18n/messages/en.ts`（`session:` 段 ~line 112、`workspaces:` 段 ~line 347）
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts`（同 key 镜像位置）

**Interfaces:**
- Consumes: 无。
- Produces: `$t("dirPicker.*")`、`$t("session.browsePath")`、`$t("workspaces.browsePath")`（Task 5/6 消费）。

- [ ] **Step 1: Add keys to en.ts**

`session` 段内（`pathPlaceholder: "/abs/path",` ~line 130 之后）加：

```ts
    browsePath: "Browse directories on the instance",
```

`workspaces` 段内（`pathPlaceholder: "/abs/path",` ~line 353 之后）加：

```ts
    browsePath: "Browse directories on the instance",
```

与 `workspaces` 段平级（其后）加新段：

```ts
  dirPicker: {
    title: "Choose directory",
    chooseCurrent: "Choose this directory",
    home: "Home",
    up: "Up one level",
    showHidden: "Show hidden directories",
    empty: "No subdirectories",
    truncated: "Too many directories — list truncated",
    loadFailed: "Failed to load directory",
    pathPlaceholder: "Path (Enter to open)",
  },
```

- [ ] **Step 2: Mirror keys in zh-CN.ts**

`zh-CN.ts` 对应段同位置加（key 完全一致）：

```ts
    browsePath: "浏览实例上的目录",
```

（session 与 workspaces 两处同值）；新段：

```ts
  dirPicker: {
    title: "选择目录",
    chooseCurrent: "选择此目录",
    home: "主目录",
    up: "上一级",
    showHidden: "显示隐藏目录",
    empty: "没有子目录",
    truncated: "目录过多 — 列表已截断",
    loadFailed: "目录加载失败",
    pathPlaceholder: "路径（回车打开）",
  },
```

- [ ] **Step 3: Run parity + smoke tests**

Run: `bun run --cwd packages/relay-web test -- src/__tests__/i18n-parity.test.ts src/__tests__/i18n-smoke.test.ts`
Expected: PASS（两份 key 集合一致、无空串）。

- [ ] **Step 4: Commit**

```bash
git add packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "feat(relay-web): i18n keys for the directory picker"
```

---

### Task 5: `DirectoryPicker.vue` 组件

**Files:**
- Create: `packages/relay-web/src/components/DirectoryPicker.vue`
- Test: `packages/relay-web/src/__tests__/directory-picker.test.ts`（新建）

**Interfaces:**
- Consumes: `api.rpc`（`../api/client`）、`isErrorPayload`/`FsBrowseResult`（`@ganglion/xacpx-relay-protocol`，Task 1）、`useModalA11y`、i18n key（Task 4）。
- Produces: 组件 props `{ instanceId: string; initialPath?: string }`，emits `confirm(path: string)` / `close`（Task 6 消费）。

- [ ] **Step 1: Write the failing test**

新建 `packages/relay-web/src/__tests__/directory-picker.test.ts`（vitest，参照 `newsessiondialog.test.ts` 的 mount/teleport-stub 风格）：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DirectoryPicker from "../components/DirectoryPicker.vue";
import { api } from "../api/client";
import { i18n } from "../i18n";

function result(over: Partial<Parameters<typeof api.rpc>[2]> = {}) { return over; }
type Browse = {
  path: string; sep: "/" | "\\"; parent: string | null; home: string;
  dirs: Array<{ name: string; path: string }>; truncated: boolean;
};
const home: Browse = {
  path: "/home/me", sep: "/", parent: "/home", home: "/home/me",
  dirs: [
    { name: "proj", path: "/home/me/proj" },
    { name: ".config", path: "/home/me/.config" },
  ],
  truncated: false,
};

function mountPicker(initialPath?: string) {
  return mount(DirectoryPicker, {
    props: { instanceId: "i1", ...(initialPath ? { initialPath } : {}) },
    global: { stubs: { teleport: true } },
  });
}

describe("DirectoryPicker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("loads home on mount when no initialPath", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.browse", {});
    expect(w.get('[data-test="dp-path"]').attributes("value") ?? w.get('[data-test="dp-path"]').element.value).toBe("/home/me");
  });

  it("navigates into a directory on row click", async () => {
    const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_i, _t, p = {}) => {
      const path = (p as { path?: string }).path;
      return (path === "/home/me/proj"
        ? { ...home, path: "/home/me/proj", parent: "/home/me", dirs: [{ name: "src", path: "/home/me/proj/src" }] }
        : home) as never;
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-dir-proj"]').trigger("click");
    await flushPromises();
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.browse", { path: "/home/me/proj" });
    expect(w.find('[data-test="dp-dir-src"]').exists()).toBe(true);
  });

  it("hides dot-directories until toggled", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    expect(w.find('[data-test="dp-dir-.config"]').exists()).toBe(false);
    await w.get('[data-test="dp-show-hidden"]').trigger("click");
    expect(w.find('[data-test="dp-dir-.config"]').exists()).toBe(true);
  });

  it("confirm emits the current absolute path and closes", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-confirm"]').trigger("click");
    expect(w.emitted("confirm")).toEqual([["/home/me"]]);
    expect(w.emitted("close")).toBeTruthy();
  });

  it("up button navigates to parent; home button to home", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ ...home, path: "/home/me/proj", parent: "/home/me" } as never);
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-up"]').trigger("click");
    await w.get('[data-test="dp-home"]').trigger("click");
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.browse", { path: "/home/me" });
  });

  it("path input Enter navigates to the typed path", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/srv");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.browse", { path: "/srv" });
  });

  it("discards a stale response that resolves after a newer navigation", async () => {
    let resolveFirst!: (v: unknown) => void;
    const rpc = vi.spyOn(api, "rpc").mockImplementation((_i, _t, p = {}) => {
      const path = (p as { path?: string }).path;
      if (path === "/slow") return new Promise((res) => { resolveFirst = res; });
      return Promise.resolve({ ...home, path: path ?? home.path } as never);
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/slow");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await w.get('[data-test="dp-path"]').setValue("/fast");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await flushPromises();
    resolveFirst({ ...home, path: "/slow" });
    await flushPromises();
    expect(w.get('[data-test="dp-path"]').element.value).toBe("/fast");
  });

  it("shows an inline error and keeps the last list on failure", async () => {
    const rpc = vi.spyOn(api, "rpc").mockImplementation((_i, _t, p = {}) => {
      const path = (p as { path?: string }).path;
      if (path === "/nope") return Promise.resolve({ error: { code: "ENOENT", message: "no such directory" } });
      return Promise.resolve(home as never);
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/nope");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(w.get('[data-test="dp-error"]').text()).toContain("no such directory");
    expect(w.find('[data-test="dp-dir-proj"]').exists()).toBe(true);
  });

  it("shows the truncated notice when the result is truncated", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue({ ...home, truncated: true } as never);
    const w = mountPicker();
    await flushPromises();
    expect(w.find('[data-test="dp-truncated"]').exists()).toBe(true);
  });

  it("initialPath seeds the first navigation", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    mountPicker("/home/me/proj");
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.browse", { path: "/home/me/proj" });
  });
});
```

（若 `i18n` 未被组件测试默认注入，参照 `newsessiondialog.test.ts` 是否需要 `global.plugins`；照该文件现状对齐。）

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/relay-web test -- src/__tests__/directory-picker.test.ts`
Expected: FAIL — 组件文件不存在。

- [ ] **Step 3: Implement the component**

新建 `packages/relay-web/src/components/DirectoryPicker.vue`：

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X, Folder, Home, ArrowUp, Loader2 } from "lucide-vue-next";
import { isErrorPayload, type FsBrowseResult } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { useModalA11y } from "../lib/use-modal-a11y";

// System-style directory picker that browses the TARGET INSTANCE's filesystem
// via control.fs.browse (the instance may be a remote machine — that's why the
// browser's native showDirectoryPicker can't be used). Not workspace-scoped:
// its whole purpose is choosing a cwd for a workspace that doesn't exist yet.
const props = defineProps<{ instanceId: string; initialPath?: string }>();
const emit = defineEmits<{ confirm: [path: string]; close: [] }>();
const { t } = useI18n();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) throw new Error(result.error.message || result.error.code);
  return result;
}

const result = ref<FsBrowseResult | null>(null);
const pathInput = ref("");
const loading = ref(false);
const error = ref("");
const showHidden = ref(false); // reset per open; not persisted
const highlight = ref(0);

let seq = 0;
async function navigate(p: string): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const r = unwrap(await api.rpc<FsBrowseResult>(
      props.instanceId, "control.fs.browse", p ? { path: p } : {},
    ));
    if (mine !== seq) return; // superseded by a newer navigation
    result.value = r;
    pathInput.value = r.path;
    highlight.value = 0;
  } catch (e) {
    if (mine !== seq) return;
    error.value = e instanceof Error ? e.message : t("dirPicker.loadFailed");
  } finally {
    if (mine === seq) loading.value = false;
  }
}
onMounted(() => void navigate(props.initialPath ?? ""));

const visibleDirs = computed(() => {
  const dirs = result.value?.dirs ?? [];
  return showHidden.value ? dirs : dirs.filter((d) => !d.name.startsWith("."));
});

// Breadcrumbs: cumulative joins of the path segments (POSIX root "/" yields
// ["", "home", …] filtered to segment labels; each crumb navigates on click).
const crumbs = computed(() => {
  const r = result.value;
  if (!r) return [];
  const parts = r.path.split(r.sep).filter(Boolean);
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join(r.sep) }));
});

function submitPath(): void {
  const p = pathInput.value.trim();
  if (p) void navigate(p);
}
function up(): void {
  const parent = result.value?.parent;
  if (parent) void navigate(parent);
}
function home(): void {
  const h = result.value?.home;
  if (h) void navigate(h);
}
function choose(): void {
  if (!result.value) return;
  emit("confirm", result.value.path);
  emit("close");
}
function onListKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlight.value = Math.min(highlight.value + 1, visibleDirs.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlight.value = Math.max(highlight.value - 1, 0);
  } else if (e.key === "Enter") {
    const d = visibleDirs.value[highlight.value];
    if (d) { e.preventDefault(); void navigate(d.path); }
  } else if (e.key === "Backspace") {
    e.preventDefault();
    up();
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
      <div ref="dialogEl" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="dp-title"
           class="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-border bg-raised shadow-xl focus:outline-none"
           data-test="dp-dialog">
        <header class="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id="dp-title" class="text-sm font-semibold text-fg">{{ $t("dirPicker.title") }}</h2>
          <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label='$t("session.close")'
                  @click="emit('close')"><X :size="16" /></button>
        </header>

        <div class="flex items-center gap-1.5 px-5 pt-3">
          <input v-model="pathInput" data-test="dp-path" :placeholder='$t("dirPicker.pathPlaceholder")'
                 class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                 @keydown.enter.prevent="submitPath" />
          <button type="button" data-test="dp-home" :title='$t("dirPicker.home")' :aria-label='$t("dirPicker.home")'
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-fg-muted hover:bg-fg/5 hover:text-fg"
                  @click="home"><Home :size="14" /></button>
          <button type="button" data-test="dp-up" :title='$t("dirPicker.up")' :aria-label='$t("dirPicker.up")'
                  :disabled="!result?.parent"
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-fg-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
                  @click="up"><ArrowUp :size="14" /></button>
        </div>

        <nav v-if="crumbs.length" class="flex flex-wrap gap-0.5 px-5 pt-2 text-xs text-fg-muted" aria-label="breadcrumb">
          <button v-for="c in crumbs" :key="c.path" type="button"
                  class="rounded px-1 hover:bg-fg/5 hover:text-fg" @click="navigate(c.path)">{{ c.label }}</button>
        </nav>

        <div class="mt-2 min-h-[12rem] flex-1 overflow-y-auto border-y border-border px-2 py-1"
             role="listbox" :aria-label='$t("dirPicker.title")' tabindex="0" @keydown="onListKeydown">
          <div v-if="loading" class="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
            <Loader2 :size="16" class="animate-spin" /> {{ $t("session.loadingOptions") }}
          </div>
          <template v-else>
            <button v-for="(d, i) in visibleDirs" :key="d.path" type="button" role="option"
                    :data-test="`dp-dir-${d.name}`" :aria-selected="i === highlight"
                    class="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm"
                    :class="i === highlight ? 'bg-accent/15 text-fg' : 'text-fg hover:bg-fg/5'"
                    @click="navigate(d.path)" @mousemove="highlight = i">
              <Folder :size="14" class="shrink-0 text-fg-muted" />
              <span class="truncate font-mono text-xs">{{ d.name }}</span>
            </button>
            <p v-if="!visibleDirs.length" class="py-8 text-center text-sm text-fg-muted">{{ $t("dirPicker.empty") }}</p>
            <p v-if="result?.truncated" data-test="dp-truncated" class="px-3 py-2 text-xs italic text-fg-muted">
              {{ $t("dirPicker.truncated") }}
            </p>
          </template>
        </div>

        <label class="flex items-center gap-2 px-5 pt-2 text-xs text-fg-muted">
          <input v-model="showHidden" data-test="dp-show-hidden" type="checkbox" class="accent-accent" />
          {{ $t("dirPicker.showHidden") }}
        </label>
        <p v-if="error" data-test="dp-error" class="mx-5 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{{ error }}</p>

        <footer class="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button class="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5" @click="emit('close')">{{ $t("common.cancel") }}</button>
          <button data-test="dp-confirm" :disabled="!result"
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-hover disabled:opacity-40"
                  @click="choose">{{ $t("dirPicker.chooseCurrent") }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/relay-web test -- src/__tests__/directory-picker.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/components/DirectoryPicker.vue packages/relay-web/src/__tests__/directory-picker.test.ts
git commit -m "feat(relay-web): add DirectoryPicker dialog over control.fs.browse"
```

---

### Task 6: 集成 — 新建会话「新路径」+ Workspaces 管理器

**Files:**
- Modify: `packages/relay-web/src/components/NewSessionDialog.vue`（path 输入块 ~line 395-396；script 加 `browsing` 状态与 FolderOpen import——`FolderOpen` 已在 lucide import 里吗？当前只 import 了 `X, Loader2, AlertTriangle, ChevronDown`，需加）
- Modify: `packages/relay-web/src/components/WorkspacesManager.vue`（新增表单 path 输入 ~line 80；script 加 `browsing` 与 FolderOpen import）
- Test: `packages/relay-web/src/__tests__/newsessiondialog.test.ts`、`packages/relay-web/src/__tests__/managers.test.ts`

**Interfaces:**
- Consumes: `DirectoryPicker`（Task 5）、`$t("session.browsePath")` / `$t("workspaces.browsePath")`（Task 4）。
- Produces: 无（终端 UI）。

- [ ] **Step 1: Write the failing tests**

`newsessiondialog.test.ts` 追加（describe 内）：

```ts
  it("browse button fills the path field from the picker's confirm", async () => {
    const { wrapper } = mountDialog();
    await flushPromises();
    await wrapper.get('[data-test="ns-ws-mode-path"]').trigger("click");
    await wrapper.get('[data-test="ns-ws-browse"]').trigger("click");
    expect(wrapper.findComponent({ name: "DirectoryPicker" }).exists()).toBe(true);
    await wrapper.findComponent({ name: "DirectoryPicker" }).vm.$emit("confirm", "/srv/app");
    await flushPromises();
    expect((wrapper.get('[data-test="ns-ws-path"]').element as HTMLInputElement).value).toBe("/srv/app");
    // picker closed after confirm
    expect(wrapper.findComponent({ name: "DirectoryPicker" }).exists()).toBe(false);
  });
```

`managers.test.ts` 追加（照该文件现有 describe/mount 辅助，追加同形 test）：

```ts
  it("workspace form browse button fills the path field", async () => {
    const { wrapper } = mountManagers(); // 打开文件确认现有 mount 辅助名，照抄
    await wrapper.get('[data-test="wm-add-toggle"]').trigger("click");
    await wrapper.get('[data-test="wm-browse"]').trigger("click");
    await wrapper.findComponent({ name: "DirectoryPicker" }).vm.$emit("confirm", "/data/ws");
    await flushPromises();
    expect((wrapper.get('[data-test="wm-path"]').element as HTMLInputElement).value).toBe("/data/ws");
  });
```

（先打开 `managers.test.ts` 对齐其 mount 辅助与 store seed 方式再落笔。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd packages/relay-web test -- src/__tests__/newsessiondialog.test.ts src/__tests__/managers.test.ts`
Expected: FAIL — `ns-ws-browse` / `wm-browse` 找不到。

- [ ] **Step 3: Implement integrations**

`NewSessionDialog.vue`：
1. lucide import 行改为 `import { X, Loader2, AlertTriangle, ChevronDown, FolderOpen } from "lucide-vue-next";`
2. script（`const workspacePath = ref("");` ~line 34 之后）加：

```ts
const browsing = ref(false);
```

3. 顶部组件 import 区加 `import DirectoryPicker from "./DirectoryPicker.vue";`
4. path 输入（line 395-396）替换为输入+按钮行，并在该 `div.block` 结束后挂 picker：

```html
            <div v-else class="flex gap-2">
              <input v-model="workspacePath" data-test="ns-ws-path" :placeholder='$t("session.pathPlaceholder")'
                     class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
              <button type="button" data-test="ns-ws-browse" :title='$t("session.browsePath")' :aria-label='$t("session.browsePath")'
                      class="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg border border-border text-fg-muted hover:bg-fg/5 hover:text-fg"
                      @click="browsing = true"><FolderOpen :size="16" /></button>
            </div>
```

（原输入框的 v-else 语义保留：existing 模式仍渲染 SelectMenu。）workspace `div.block`（line 380-397）结束标签后加：

```html
          <DirectoryPicker v-if="browsing" :instance-id="instanceId" :initial-path="workspacePath.trim() || undefined"
                           @confirm="workspacePath = $event" @close="browsing = false" />
```

`WorkspacesManager.vue`：
1. import 行加 `FolderOpen`；组件 import `DirectoryPicker`。
2. script 加 `const browsing = ref(false);`。
3. path 输入（line 80）包进 flex 行并加按钮；表单 `div`（line 77-88）结束后挂：

```html
    <div class="flex gap-2">
      <input v-model="path" data-test="wm-path" :placeholder='$t("workspaces.pathPlaceholder")'
             class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button type="button" data-test="wm-browse" :title='$t("workspaces.browsePath")' :aria-label='$t("workspaces.browsePath")'
              class="grid h-8 w-8 shrink-0 place-items-center rounded border border-border text-fg-muted hover:bg-fg/5 hover:text-fg"
              @click="browsing = true"><FolderOpen :size="14" /></button>
    </div>
```

（三列 grid 变两行：name/description 一行，path 单独一行——把原 `grid grid-cols-1 sm:grid-cols-3` 中 path 移出、grid 改 `sm:grid-cols-2`，只动 path 相关布局。）

```html
    <DirectoryPicker v-if="browsing" :instance-id="instanceId" :initial-path="path.trim() || undefined"
                     @confirm="path = $event" @close="browsing = false" />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd packages/relay-web test -- src/__tests__/newsessiondialog.test.ts src/__tests__/managers.test.ts src/__tests__/directory-picker.test.ts`
Expected: PASS（含既有用例不回归）。

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/components/NewSessionDialog.vue packages/relay-web/src/components/WorkspacesManager.vue packages/relay-web/src/__tests__/newsessiondialog.test.ts packages/relay-web/src/__tests__/managers.test.ts
git commit -m "feat(relay-web): directory-picker buttons on new-session path and workspace form"
```

---

### Task 7: 文档 + 全量验证

**Files:**
- Modify: `docs/relay-module.md`（control/bridge RPC 列表，`control.workspaces.*` 附近 ~line 43-55）
- Modify: `docs/relay-web-module.md`（会话创建对话框小节 ~line 155-171、实例配置管理 Modal 小节 ~line 201-209）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 文档与全绿验证（交付门）。

- [ ] **Step 1: Update docs**

`docs/relay-module.md` RPC 清单加一行（`control.workspaces.remove` 条目后）：

```markdown
  - `control.fs.browse {path?}`：config-global、目录-only 的实例文件系统浏览（供 Web
    目录选择器选新 workspace cwd）；空/`~` 为 home，相对路径按 home 解析；只返回目录
    名+绝对路径，上限 1000（`truncated` 标记），不返回文件/内容/元数据。不经
    WorkspaceFs 的 workspace 白名单（选择尚未注册的目录是其目的），仍受 hub 账号-持有
    实例门约束。
```

`docs/relay-web-module.md` 会话创建对话框小节「workspace 选或输路径」条目后补：

```markdown
- **目录选择器（`DirectoryPicker.vue`）**：「新路径」输入框旁的文件夹按钮打开一个浏览
  **目标实例文件系统**的目录选择弹窗（RPC `control.fs.browse`，跨实例——实例在哪台机器
  上就浏览哪台）；路径框 Enter 跳转、面包屑/主目录/上一级快捷键、隐藏目录开关、
  ↑/↓/Enter/Backspace 键盘导航；导航即进入、底部「选择此目录」确认当前目录并回填。
  迟到响应按导航序号丢弃，错误内联显示。Manage 弹窗 Workspaces 管理器的新增表单同款按钮。
```

- [ ] **Step 2: Full verification**

```bash
npm test                                   # typecheck + 全部根 monorepo unit（含 bridge/protocol/control 新测试）
bun run test:web                            # relay-web Vitest 全量
bun run build:packages                      # relay-protocol + channel-relay 构建产物
```

Expected: 全部 PASS / 构建成功。若 `npm test` 因无关既有用例失败，确认新用例单独全绿并在交付说明中列出既有失败。

- [ ] **Step 3: Commit**

```bash
git add docs/relay-module.md docs/relay-web-module.md
git commit -m "docs: control.fs.browse RPC and relay-web directory picker"
```

---

## Self-Review

- **Spec coverage**：协议（Task 1）、daemon browseDirectories + expandHome 复用 + 排序/cap/symlink/parent-null（Task 2）、bridge 映射 + invalid-payload（Task 3）、i18n 双语（Task 4）、picker 组件（导航即进入、面包屑、路径框、home/up、隐藏开关、键盘、seq 守卫、truncated、错误内联、initialPath）（Task 5）、两处集成按钮（Task 6）、文档（Task 7）——spec 各节均有对应任务。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤给全量代码；两处「打开文件对齐现有 harness」是防漂移指令而非占位（harness 名以现场为准，测试逻辑已完整给出）。
- **Type consistency**：`FsBrowseResult`（协议）与 `BrowseDirsResult`（daemon）字段逐一相同（`path/sep/parent/home/dirs/truncated`），bridge 结构化兼容；`browseDirectories(path?: string)` 在 Task 2（实现）、Task 3（fake+dispatch）、Task 5（`api.rpc` type 字符串）一致；`dp-*` data-test 前缀 Task 5 定义、Task 6 只消费组件 emit 不触碰内部。
