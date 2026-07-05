# 终端 Windows 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 放开内置终端的 Windows 门禁,使 win32 实例也能开终端,shell 走 pwsh→PowerShell→cmd 并支持跨平台 `terminal.shell` 覆盖。

**Architecture:** 把 shell 选择抽成可注入 `exists` 的纯函数 `resolveShell`(取代 `defaultShell`),ubuntu CI 以注入 `platform="win32"` 全覆盖;删 `terminal-service.ts` 的 win32 throw;`TerminalConfig.shell?` 经 deps 回调串入;前端只改 i18n 文案;新增最小 windows-latest CI leg(装依赖 + 终端单测 + 真 ConPTY smoke)。

**Tech Stack:** TypeScript(core `src/`)、node-pty ^1.1.0(自带 Windows ConPTY 预构建)、bun:test(core 单测)、Vitest(relay-web i18n)、GitHub Actions。

## Global Constraints

- 只改 core `src/` + `.github/workflows/test.yml` + `packages/relay-web` 的 i18n;**不改** connector(`channel-relay`)/ hub(`relay`)/ control-service(纯透传)。
- shell 优先级(所有平台):`terminal.shell` 配置 → 平台默认。unix 默认:`SHELL` → darwin `/bin/zsh` / 其它 `/bin/bash`(**行为不变**)。win32 默认:**忽略 `SHELL`** → 扫 PATH `pwsh.exe` → `powershell.exe` → 回落 `%ComSpec%` → `cmd.exe`。
- shell 解析永不抛(始终有值)。
- core 单测跑法:`bun test tests/unit/control/terminal-service.test.ts`(**单文件,勿整目录**——整目录 bun test 有状态泄漏假失败)。类型检查:`npx tsc --noEmit` 必须 0 报错(`npm test` 会先 typecheck 再跑全 unit)。
- relay-web i18n:改文案 en.ts + zh-CN.ts 同步,过 `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts`;类型 `cd packages/relay-web && npx vue-tsc --noEmit`。
- smoke(`tests/smoke/**`)默认不入 `npm test`(仅 tests/unit);Windows CI leg 显式调用。
- 前端保留 `terminal-unsupported-platform` → `terminal.unsupported` 映射作防御兜底,**不删**。
- **不在 Windows CI 跑全量单测**(从未在 Windows 跑过、会因无关差异红掉);只跑终端单测 + smoke。

---

### Task 1: `resolveShell` 纯函数

在 `terminal-service.ts` 内新增可注入、导出的 shell 解析函数,取代 `defaultShell()`。本任务只加函数 + 单测,**不**改 `create()`(下个任务放开门禁时才切换调用)。

**Files:**
- Modify: `src/control/terminal-service.ts`(新增 `resolveShell` + `defaultExists`;暂保留 `defaultShell` 不删,Task 2 删)
- Test: `tests/unit/control/terminal-service.test.ts`(新增 resolveShell 用例)

**Interfaces:**
- Consumes: `node:fs` 的 `statSync`。
- Produces:
  - `export interface ResolveShellArgs { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; shellOverride?: string; exists?: (p: string) => boolean }`
  - `export function resolveShell(args: ResolveShellArgs): string`

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/control/terminal-service.test.ts` 顶部 import 追加 `resolveShell`(与既有 import 合并):

```ts
import { createTerminalService, resolveShell, type PtyHandle } from "../../../src/control/terminal-service";
```

在文件末尾追加(bun:test 风格,与既有用例一致):

```ts
// ── resolveShell ─────────────────────────────────────────────────────────────
const noExist = () => false;

test("resolveShell: explicit shellOverride wins on any platform", () => {
  expect(resolveShell({ platform: "win32", env: {}, shellOverride: "C:/tools/nu.exe", exists: noExist })).toBe("C:/tools/nu.exe");
  expect(resolveShell({ platform: "darwin", env: { SHELL: "/bin/zsh" }, shellOverride: "/bin/fish" })).toBe("/bin/fish");
  // blank override is ignored (falls through to platform default)
  expect(resolveShell({ platform: "linux", env: { SHELL: "/bin/bash" }, shellOverride: "   " })).toBe("/bin/bash");
});

test("resolveShell: unix honors SHELL then falls to zsh(darwin)/bash(other) — unchanged", () => {
  expect(resolveShell({ platform: "darwin", env: { SHELL: "/opt/homebrew/bin/fish" } })).toBe("/opt/homebrew/bin/fish");
  expect(resolveShell({ platform: "darwin", env: {} })).toBe("/bin/zsh");
  expect(resolveShell({ platform: "linux", env: {} })).toBe("/bin/bash");
});

test("resolveShell: win32 IGNORES SHELL and scans PATH pwsh -> powershell -> ComSpec -> cmd", () => {
  const PATH = "C:\\Windows\\System32;C:\\PS7";
  // SHELL set to an MSYS path (git-bash) must be ignored on win32
  const env = { SHELL: "/usr/bin/bash", PATH, ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  // pwsh present anywhere in PATH wins
  const pwshExists = (p: string) => p === "C:\\PS7\\pwsh.exe";
  expect(resolveShell({ platform: "win32", env, exists: pwshExists })).toBe("C:\\PS7\\pwsh.exe");
  // no pwsh, powershell present in System32
  const psExists = (p: string) => p === "C:\\Windows\\System32\\powershell.exe";
  expect(resolveShell({ platform: "win32", env, exists: psExists })).toBe("C:\\Windows\\System32\\powershell.exe");
  // neither present -> ComSpec
  expect(resolveShell({ platform: "win32", env, exists: noExist })).toBe("C:\\Windows\\System32\\cmd.exe");
  // neither present and no ComSpec -> literal cmd.exe
  expect(resolveShell({ platform: "win32", env: { PATH }, exists: noExist })).toBe("cmd.exe");
});

test("resolveShell: win32 prefers pwsh over powershell when both exist", () => {
  const env = { PATH: "C:\\A;C:\\B" };
  const bothExist = (p: string) => p === "C:\\B\\pwsh.exe" || p === "C:\\A\\powershell.exe";
  expect(resolveShell({ platform: "win32", env, exists: bothExist })).toBe("C:\\B\\pwsh.exe");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: FAIL — `resolveShell` 未导出(import 报错 / 用例未定义)。

- [ ] **Step 3: 实现 `resolveShell`**

在 `src/control/terminal-service.ts` 顶部 import 加 `statSync`:

```ts
import { statSync } from "node:fs";
```

在 `defaultShell`(:67）**之后**新增(暂不删 `defaultShell`):

```ts
function defaultExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolveShellArgs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Explicit override from config terminal.shell — wins on every platform. */
  shellOverride?: string;
  /** Injectable executable-existence predicate (defaults to fs statSync). */
  exists?: (p: string) => boolean;
}

/** Pick the shell to spawn. Priority: explicit override -> platform default.
 *  win32 deliberately ignores SHELL (git-bash sets it to an MSYS path that
 *  node-pty can't spawn on Windows) and scans PATH for pwsh -> powershell,
 *  falling back to %ComSpec% (cmd.exe). Never throws — always returns a value. */
export function resolveShell(args: ResolveShellArgs): string {
  const { platform, env, shellOverride } = args;
  const exists = args.exists ?? defaultExists;
  if (shellOverride && shellOverride.trim()) return shellOverride;
  if (platform === "win32") {
    const pathValue = env.PATH ?? env.Path ?? "";
    const dirs = pathValue.split(";").filter(Boolean);
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      for (const dir of dirs) {
        const full = `${dir}\\${name}`;
        if (exists(full)) return full;
      }
    }
    return env.ComSpec ?? "cmd.exe";
  }
  if (env.SHELL) return env.SHELL;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: PASS — 新增 4 个 resolveShell 用例全绿;既有用例(含仍在的 "win32 throws" 用例)仍绿。

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/control/terminal-service.ts tests/unit/control/terminal-service.test.ts
git commit -m "feat(terminal): resolveShell — cross-platform shell selection (pwsh/powershell/cmd on win32)"
```

---

### Task 2: 放开 win32 门禁 + `terminal.shell` 配置串联

删 `create()` 的 win32 throw、改用 `resolveShell`、删旧 `defaultShell`;新增 `TerminalConfig.shell` + `terminalShell()` 访问器 + `TerminalServiceDeps.shell` 回调 + `main.ts` 布线;更新既有 "win32 throws" 用例。

**Files:**
- Modify: `src/control/terminal-service.ts:104-107`(create 放开 + 用 resolveShell)、删 `defaultShell`、`TerminalServiceDeps` 加 `shell?`
- Modify: `src/config/types.ts`(`TerminalConfig.shell?` + `terminalShell()`)
- Modify: `src/main.ts:17,768-771`(import + 布线 `shell`)
- Test: `tests/unit/control/terminal-service.test.ts`(改 win32 用例;扩 `setup` 支持 shell)

**Interfaces:**
- Consumes: `resolveShell`(Task 1)、`terminalShell(config)`。
- Produces:
  - `TerminalConfig` 加 `shell?: string`
  - `export function terminalShell(config: AppConfig): string | undefined`
  - `TerminalServiceDeps` 加 `shell?: () => string | undefined`
  - `create()` 在所有平台(含 win32)可用。

- [ ] **Step 1: 写失败的测试**

改 `tests/unit/control/terminal-service.test.ts` 的 `setup` 支持注入 `shell`(改现有 setup):

```ts
function setup(opts?: { idle?: number; platform?: NodeJS.Platform; shell?: () => string | undefined }) {
  const events = createControlEventBus();
  const captured: ControlEvent[] = [];
  events.subscribe((e) => captured.push(e));
  const pty = fakePty();
  const spawn = mock(() => pty);
  const svc = createTerminalService({
    events,
    idleTimeoutSeconds: () => opts?.idle ?? 900,
    spawn: spawn as never,
    platform: opts?.platform ?? "darwin",
    shell: opts?.shell,
  });
  return { svc, pty, spawn, captured };
}
```

把既有用例 `test("create throws terminal-unsupported-platform on win32", ...)` **替换**为:

```ts
test("create no longer throws on win32 and spawns the resolved shell", () => {
  const { svc, spawn } = setup({ platform: "win32", shell: () => "C:/win/pwsh.exe" });
  expect(() => svc.create({ cwd: "C:/ws", cols: 80, rows: 24 })).not.toThrow();
  const call = (spawn as ReturnType<typeof mock>).mock.calls[0];
  expect(call[0]).toBe("C:/win/pwsh.exe"); // shellOverride from config wins
});

test("create uses resolveShell (darwin default /bin/zsh) when no override", () => {
  const { svc, spawn } = setup(); // darwin, no shell override, no SHELL guaranteed? force it
  const prev = process.env.SHELL;
  delete process.env.SHELL;
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  const call = (spawn as ReturnType<typeof mock>).mock.calls[0];
  expect(call[0]).toBe("/bin/zsh");
  if (prev !== undefined) process.env.SHELL = prev;
});
```

> 说明:win32 用例用 `shell` 覆盖让 spawn 收到的 file 确定(不依赖测试宿主 PATH);shell 选择的分支逻辑已由 Task 1 的 resolveShell 单测覆盖。darwin 用例临时删 `process.env.SHELL` 以断言默认 `/bin/zsh`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: FAIL — win32 仍 throw(旧 create 未改)、`setup` 传的 `shell` 未被消费。

- [ ] **Step 3: 改 config 类型**

`src/config/types.ts` 的 `TerminalConfig`(:50)加字段:

```ts
export interface TerminalConfig {
  /** Default false. When false, control.terminal.create is rejected before any PTY spawns. */
  enabled: boolean;
  /** Idle seconds before a terminal PTY is auto-killed. Defaults to 900 (15 min). */
  idleTimeoutSeconds?: number;
  /** Explicit shell override (absolute path or bare name). Cross-platform: wins over SHELL / platform default. */
  shell?: string;
}
```

在 `terminalIdleTimeoutSeconds` 之后加访问器:

```ts
export function terminalShell(config: AppConfig): string | undefined {
  const v = config.terminal?.shell;
  return typeof v === "string" && v.trim() ? v : undefined;
}
```

- [ ] **Step 4: 改 TerminalService — deps + create**

`src/control/terminal-service.ts`:`TerminalServiceDeps`(:45-53)加 `shell` 回调:

```ts
export interface TerminalServiceDeps {
  events: ControlEventBus;
  idleTimeoutSeconds: () => number;
  /** Optional explicit shell override from config (terminal.shell). */
  shell?: () => string | undefined;
  spawn?: PtySpawn;
  platform?: NodeJS.Platform;
  /** Injectable timer primitives; defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}
```

`create()`（:104-107)删 win32 throw、用 resolveShell:

```ts
    create({ cwd, cols, rows }) {
      const shell = resolveShell({ platform, env: process.env, shellOverride: deps.shell?.() });
      const terminalId = randomUUID();
      const handle = spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: scrubEnv() });
```

删掉现在已无引用的 `defaultShell` 函数(:67-70)。

- [ ] **Step 5: 布线 main.ts**

`src/main.ts:17` import 加 `terminalShell`:

```ts
import { terminalEnabled, terminalIdleTimeoutSeconds, terminalShell, filesWriteEnabled } from "./config/types";
```

`src/main.ts:768-771` 构造加 `shell`:

```ts
  const terminalService = createTerminalService({
    events: controlEvents,
    idleTimeoutSeconds: () => terminalIdleTimeoutSeconds(config),
    shell: () => terminalShell(config),
  });
```

- [ ] **Step 6: 跑测试确认通过 + 类型 + 提交**

Run: `bun test tests/unit/control/terminal-service.test.ts && npx tsc --noEmit`
Expected: PASS(win32 不再 throw、用解析 shell;darwin 默认 zsh)+ tsc 0 报错。

```bash
git add src/control/terminal-service.ts src/config/types.ts src/main.ts tests/unit/control/terminal-service.test.ts
git commit -m "feat(terminal): open win32 gate; thread terminal.shell config into shell selection"
```

---

### Task 3: 前端 i18n 文案(去掉"仅 mac/Linux"暗示)

后端不再抛 unsupported,前端保留映射作兜底,但文案不该再暗示"仅 mac/Linux"。

**Files:**
- Modify: `packages/relay-web/src/i18n/messages/en.ts:347`
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts:345`
- Test: `packages/relay-web/src/__tests__/i18n-parity.test.ts`(既有,验同步)

**Interfaces:**
- Consumes/Produces:无代码接口变化,仅文案键值。

- [ ] **Step 1: 改文案**

`packages/relay-web/src/i18n/messages/en.ts` 的 `terminal.unsupported`:

```ts
    unsupported: "Terminal is not supported on this instance platform.",
```

`packages/relay-web/src/i18n/messages/zh-CN.ts` 的 `terminal.unsupported`:

```ts
    unsupported: "该实例平台不支持终端。",
```

- [ ] **Step 2: 跑 i18n parity + 类型**

Run: `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts && npx vue-tsc --noEmit`
Expected: PASS(en/zh 键仍同步)+ vue-tsc 0 报错。
（注意:持久盘 shell cwd 在 `cd 仓库根 && git…` 后会漂回根,跑 vitest/vue-tsc 前先 `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web`。)

- [ ] **Step 3: 提交**

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "i18n(relay-web): terminal.unsupported no longer implies macOS/Linux-only"
```

---

### Task 4: 真 ConPTY / PTY smoke 测试

新建一个用**真** node-pty spawn 的 smoke,验证终端在真实平台上能起 shell、字节流往返、退出。放在 `tests/smoke/`(默认不入 `npm test`),Windows CI leg 显式调用;在 macOS/Linux 上跑也应通过(真 PTY)。

**Files:**
- Create: `tests/smoke/terminal-pty-smoke.test.ts`

**Interfaces:**
- Consumes:`createTerminalService`(Task 1+2 后 create 跨平台可用)、`createControlEventBus`。

- [ ] **Step 1: 写 smoke(先跑,应在本机 macOS 通过)**

Create `tests/smoke/terminal-pty-smoke.test.ts`:

```ts
// Real-PTY smoke: spawns an actual shell via node-pty (no injected spawn) and asserts the
// byte stream round-trips. NOT run by `npm test` (tests/unit only) — invoked explicitly by
// the windows-latest CI leg to validate ConPTY, and runnable locally on macOS/Linux.
import { test, expect } from "bun:test";
import { createTerminalService } from "../../src/control/terminal-service";
import { createControlEventBus, type ControlEvent } from "../../src/control/control-event-bus";

const MARKER = "__PTY_SMOKE_OK__";

test("spawns a real shell and round-trips output", async () => {
  const events = createControlEventBus();
  let buf = "";
  events.subscribe((e: ControlEvent) => {
    if (e.type === "terminal-output") buf += e.data;
  });
  const svc = createTerminalService({ events, idleTimeoutSeconds: () => 900 });
  const { terminalId } = svc.create({ cwd: process.cwd(), cols: 80, rows: 24 });

  // `echo <marker>` prints the marker in pwsh / powershell / cmd / bash / zsh alike.
  // The trailing CR submits the line.
  svc.write(terminalId, `echo ${MARKER}\r`);

  const deadline = Date.now() + 15000;
  while (!buf.includes(MARKER) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(buf).toContain(MARKER);

  expect(() => svc.close(terminalId)).not.toThrow();
}, 20000);
```

- [ ] **Step 2: 本机跑通(macOS 真 PTY)**

Run: `bun test tests/smoke/terminal-pty-smoke.test.ts`
Expected: PASS(本机 zsh 起来、输出含 `__PTY_SMOKE_OK__`)。若本机因沙箱无法起 PTY,记在报告里(不阻塞——真价值在 Windows CI)。

- [ ] **Step 3: 确认 smoke 不污染默认单测**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: PASS(smoke 在 tests/smoke,不被此命令收录;确认无跨文件泄漏)。

- [ ] **Step 4: 提交**

```bash
git add tests/smoke/terminal-pty-smoke.test.ts
git commit -m "test(terminal): real-PTY smoke (ConPTY validation for the windows CI leg)"
```

---

### Task 5: windows-latest CI leg

在 `.github/workflows/test.yml` 新增 `terminal-windows` job(与既有 `test` 并列),只做聚焦验证。

**Files:**
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes:`tests/unit/control/terminal-service.test.ts`(Task 1+2)、`tests/smoke/terminal-pty-smoke.test.ts`(Task 4)。

- [ ] **Step 1: 加 windows job**

在 `.github/workflows/test.yml` 的 `jobs:` 下、`test:` job **之后**追加(与 `test` 同级缩进):

```yaml
  terminal-windows:
    runs-on: windows-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: 'npm'

      # Installs node-pty, resolving its Windows prebuilt binary (ConPTY). A failure here
      # means the prebuild didn't resolve for this Node ABI on Windows.
      - name: Install dependencies
        run: npm ci

      # Focused terminal coverage only — NOT the full unit suite (never run on Windows).
      - name: Terminal unit tests
        run: bun test tests/unit/control/terminal-service.test.ts

      # Real ConPTY: spawns a live shell and asserts the byte stream round-trips.
      - name: Terminal PTY smoke (ConPTY)
        run: bun test tests/smoke/terminal-pty-smoke.test.ts
```

- [ ] **Step 2: 校验 workflow YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yml')); print('yaml ok')"`
Expected: `yaml ok`(语法有效;新增 job 缩进正确)。

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add minimal windows-latest terminal leg (install + terminal tests + ConPTY smoke)"
```

---

## 收尾(全部任务完成后)

- 核心回归:`bun test tests/unit/control/terminal-service.test.ts` 绿 + `npx tsc --noEmit` 0;relay-web `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts` 绿 + `npx vue-tsc --noEmit` 0。
- windows-latest leg 的真机效果在 PR 的 CI 上首次可见(装依赖 + 终端单测 + ConPTY smoke)。
- **发布(不在本计划的编码范围,收尾时按 runbook 处理)**:改了 core(`src/`)→ 需发 **core beta**(带 terminal Windows 能力);注意 core 版本耦合——`tests/unit/packages/package-metadata.test.ts` 硬编码版本断言 + `weacpx-compat` shim 的 version/dep 需同步(镜像 root.version)。前端只改 i18n 文案,relay-web 打进 hub → 视需要连带 hub beta。版本号/发布顺序在收尾时定。
- 实机验收(Windows,hub beta):`terminal.enabled=true` 的 Windows 实例开终端 → 起 pwsh/PowerShell → 输入/输出/resize/退出正常;设 `terminal.shell` 覆盖生效;git-bash 机器 `SHELL=/usr/bin/bash` 不影响(仍起 PowerShell)。
