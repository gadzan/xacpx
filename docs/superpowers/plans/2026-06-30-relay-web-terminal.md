# relay-web 远程实例终端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 relay-web 看板给选中会话开一个真·交互式终端,直连实例机器 shell,字节流经现有 relay 链路实时双向传输,前端用 ghostty-web 渲染。

**Architecture:** 方案 C(混合双向):低频 `control.terminal.create` 走现有 RPC 代理(要响应);高频按键/resize/close 走「浏览器 `/ws` 上行帧 → hub 校验 instance 归属 → 网关 `kind=event` 下行帧 → 连接器入站路由 → PTY」的有序快速路;PTY 输出走「TerminalService 直发 ControlEventBus → 连接器泛透传 → hub 无条件 web 广播 → ghostty」的现有下行流。核心新增 `TerminalService` 管理 PTY 生命周期。

**Tech Stack:** TypeScript;`node-pty`(已是 dep)做 PTY;`ghostty-web@^0.4.0`(MIT,~400KB WASM,xterm API 兼容)前端渲染;Vue 3 + Pinia;relay 协议信封(`@ganglion/xacpx-relay-protocol`)。

## Global Constraints

- **设计文档**:`docs/superpowers/specs/2026-06-30-relay-web-terminal-design.md` 是权威来源。
- **平台**:v1 仅 macOS/Linux。`node-pty-helper.ts` 在 `win32` 返回 null;`TerminalService.create` 在 win32 抛 `terminal-unsupported-platform`。
- **安全默认关**:`config.terminal.enabled` 缺省 `false`;`createTerminal` 第一件事查它,关则抛 `terminal-disabled`,**不 spawn PTY**。
- **不做命令/路径白名单**(交互 shell 本质可绕);力气放在默认关 + 身份隔离 + env 脱敏 + 空闲超时。
- **env 脱敏**:spawn env 剔除 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XACPX_*` 等敏感键(集中常量 `SENSITIVE_ENV_KEYS`),注入 `TERM=xterm-256color`、`LANG`。
- **terminal 事件不走「三处穿透」**:`terminal-output`/`terminal-exit` 由 `TerminalService` **直接** `events.emit()`(非 agent turn 回调),连接器现有泛透传 + web-dtos 闸门即可下行。**不要**改 command-router/handlers/router-types。
- **身份隔离**:上行 `terminal-*` 帧在 hub 校验 `deps.instances.getOwned(instanceId, account.id)`,不通过即丢。
- **空闲超时**:PTY 在 `idleTimeoutSeconds`(缺省 900)无 I/O 后自动 kill + 发 `terminal-exit`。
- **协议 dist 必须 tsc 构建**:改 `packages/relay-protocol` 后跑 `bun run build:relay-protocol`(不能用 bun build 桶文件,会 tree-shake 成空导出运行时崩)。
- **加 relay-web 依赖后必须同步根 lock**:`npm install --package-lock-only`(否则 CI `npm ci` 在 Install 步挂 "Missing ghostty-web from lock file")。
- **relay-web 测试用 vitest**:`npx vitest run`(bun test 会因缺 jsdom 假失败);核心/协议/连接器/hub 测试用 bun,经 `node tests/run-tests.mjs <file>` 逐文件隔离跑。
- **git 卫生(子代理)**:只提交本任务相关文件;不得 `git push`/`rebase`/`amend`;不得把 lockfile 误入无关提交;每任务结束 controller 自查 `git log`。

### 共享契约(跨任务类型,逐字一致)

```typescript
// 核心 ControlEvent 新变体(src/control/control-event-bus.ts)
| { type: "terminal-output"; terminalId: string; seq: number; data: string }
| { type: "terminal-exit"; terminalId: string; code: number }

// 协议 ControlEventDto 新变体(packages/relay-protocol/src/dtos.ts)—— 形状镜像上面
| { type: "terminal-output"; terminalId: string; seq: number; data: string }
| { type: "terminal-exit"; terminalId: string; code: number }

// 协议 MSG 新增(packages/relay-protocol/src/messages.ts)
terminalCreate: "control.terminal.create",      // RPC(浏览器→hub→连接器,要响应)
terminalInput:  "instance.terminal.input",       // 网关下行 event(hub→连接器)
terminalResize: "instance.terminal.resize",      // 网关下行 event
terminalClose:  "instance.terminal.close",       // 网关下行 event

// 协议 web→hub 上行帧(packages/relay-protocol/src/web-dtos.ts)
export const WEB_CLIENT_TYPE = "web.client";
export type WebClientMessage =
  | { kind: "terminal-input"; instanceId: string; terminalId: string; data: string }
  | { kind: "terminal-resize"; instanceId: string; terminalId: string; cols: number; rows: number }
  | { kind: "terminal-close"; instanceId: string; terminalId: string };

// TerminalService 接口(src/control/terminal-service.ts)
export interface TerminalCreateInput { cwd: string; cols: number; rows: number }
export interface TerminalService {
  create(input: TerminalCreateInput): { terminalId: string };  // 同步返回 id,异步发事件
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  disposeAll(): void;
}

// ControlService 新方法(src/control/control-service.ts)
async createTerminal(chatKey: string, sessionAlias: string, cols: number, rows: number): Promise<{ terminalId: string }>
writeTerminal(terminalId: string, data: string): void
resizeTerminal(terminalId: string, cols: number, rows: number): void
closeTerminal(terminalId: string): void
```

---

### Task 1: terminal 配置位(默认关)

**Files:**
- Modify: `src/config/types.ts`(在 `TransportConfig` 后、`AppConfig` 中加 `terminal`)
- Modify: `src/config/parse-config.ts`(解析 terminal 段;若解析逻辑在别处,以 `parseConfig` 实际所在文件为准)
- Test: `tests/unit/config/terminal-config.test.ts`

**Interfaces:**
- Produces: `TerminalConfig { enabled: boolean; idleTimeoutSeconds?: number }`;`AppConfig.terminal?: TerminalConfig`;helper `terminalEnabled(config: AppConfig): boolean`(缺省 false)、`terminalIdleTimeoutSeconds(config: AppConfig): number`(缺省 900)。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/config/terminal-config.test.ts
import { test, expect } from "bun:test";
import { parseConfig } from "../../../src/config/parse-config";
import { terminalEnabled, terminalIdleTimeoutSeconds } from "../../../src/config/types";

const base = { transport: { permissionMode: "approve-all", nonInteractivePermissions: "deny" }, agents: {}, workspaces: {} };

test("terminal defaults to disabled when absent", () => {
  const cfg = parseConfig({ ...base });
  expect(cfg.terminal).toBeUndefined();
  expect(terminalEnabled(cfg)).toBe(false);
  expect(terminalIdleTimeoutSeconds(cfg)).toBe(900);
});

test("terminal.enabled parses true and custom idle timeout", () => {
  const cfg = parseConfig({ ...base, terminal: { enabled: true, idleTimeoutSeconds: 120 } });
  expect(cfg.terminal).toEqual({ enabled: true, idleTimeoutSeconds: 120 });
  expect(terminalEnabled(cfg)).toBe(true);
  expect(terminalIdleTimeoutSeconds(cfg)).toBe(120);
});

test("terminal.enabled false keeps helper false", () => {
  const cfg = parseConfig({ ...base, terminal: { enabled: false } });
  expect(terminalEnabled(cfg)).toBe(false);
  expect(terminalIdleTimeoutSeconds(cfg)).toBe(900);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/run-tests.mjs tests/unit/config/terminal-config.test.ts`
Expected: FAIL（`terminalEnabled` 未导出 / parseConfig 丢弃 terminal）

- [ ] **Step 3: 实现**

在 `src/config/types.ts`,`TransportConfig` 定义之后加:

```typescript
export interface TerminalConfig {
  /** Default false. When false, control.terminal.create is rejected before any PTY spawns. */
  enabled: boolean;
  /** Idle seconds before a terminal PTY is auto-killed. Defaults to 900 (15 min). */
  idleTimeoutSeconds?: number;
}
```

在 `AppConfig` 接口里(`language?: Locale;` 同级)加一行:

```typescript
  terminal?: TerminalConfig;
```

在 `src/config/types.ts` 末尾加两个读取 helper:

```typescript
export function terminalEnabled(config: AppConfig): boolean {
  return config.terminal?.enabled === true;
}

export function terminalIdleTimeoutSeconds(config: AppConfig): number {
  const v = config.terminal?.idleTimeoutSeconds;
  return typeof v === "number" && v > 0 ? v : 900;
}
```

在 `parseConfig`(`src/config/parse-config.ts`)里,把 terminal 段透传进结果(找到组装返回对象那段,加 terminal 字段)。最小实现:

```typescript
  // inside parseConfig, when building the parsed AppConfig:
  ...(raw.terminal && typeof raw.terminal === "object"
    ? { terminal: { enabled: (raw.terminal as { enabled?: unknown }).enabled === true,
                    ...(typeof (raw.terminal as { idleTimeoutSeconds?: unknown }).idleTimeoutSeconds === "number"
                        ? { idleTimeoutSeconds: (raw.terminal as { idleTimeoutSeconds: number }).idleTimeoutSeconds } : {}) } }
    : {}),
```

> 若 `parseConfig` 用的是 schema 校验(zod 等),改为在 schema 里加 `terminal: z.object({ enabled: z.boolean(), idleTimeoutSeconds: z.number().optional() }).optional()`。先 `command grep -n "export function parseConfig" src/config/*.ts` 定位实际文件与风格。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/run-tests.mjs tests/unit/config/terminal-config.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/config/types.ts src/config/parse-config.ts tests/unit/config/terminal-config.test.ts
git commit -m "feat(config): add terminal.enabled gate (default off)"
```

---

### Task 2: TerminalService(核心 PTY 生命周期管理器)

**Files:**
- Create: `src/control/terminal-service.ts`
- Test: `tests/unit/control/terminal-service.test.ts`

**Interfaces:**
- Consumes: `ControlEventBus`(`src/control/control-event-bus.ts`,Task 不改它的实现,只 emit)。注意本任务**先**在 control-event-bus.ts 里加 `terminal-output`/`terminal-exit` 两个 union 变体(见 Global Constraints 共享契约),否则 emit 处 tsc 报错。
- Produces: `createTerminalService(deps)` 返回 `TerminalService`(见共享契约)。`deps = { events: ControlEventBus; idleTimeoutSeconds: () => number; spawn?: PtySpawn; platform?: NodeJS.Platform; now?: () => number }`。`PtySpawn` 形状:`(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string,string> }) => PtyHandle`;`PtyHandle = { onData(cb:(d:string)=>void): void; onExit(cb:(e:{exitCode:number})=>void): void; write(d:string): void; resize(c:number,r:number): void; kill(): void }`(node-pty 的 IPty 子集)。
- 安全:`SENSITIVE_ENV_KEYS` 常量 + env 脱敏在本服务内实现。

- [ ] **Step 1: 先给 ControlEvent 加变体**

在 `src/control/control-event-bus.ts` 的 `ControlEvent` union 里(`| { type: "orchestration-changed" };` 之前)加:

```typescript
  // Interactive terminal byte stream (web terminal). Emitted directly by
  // TerminalService — NOT an agent-turn callback, so it does not traverse
  // command-router/handlers. `seq` is a per-terminal monotonic counter for v2 replay.
  | { type: "terminal-output"; terminalId: string; seq: number; data: string }
  | { type: "terminal-exit"; terminalId: string; code: number }
```

- [ ] **Step 2: 写失败测试**

```typescript
// tests/unit/control/terminal-service.test.ts
import { test, expect, mock } from "bun:test";
import { createTerminalService, type PtyHandle } from "../../../src/control/terminal-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";

function fakePty() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const handle: PtyHandle & { emitData: (d: string) => void; emitExit: (c: number) => void } = {
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    write: mock(() => {}),
    resize: mock(() => {}),
    kill: mock(() => {}),
    emitData: (d) => dataCb(d),
    emitExit: (c) => exitCb({ exitCode: c }),
  };
  return handle;
}

function setup(opts?: { idle?: number; platform?: NodeJS.Platform }) {
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
    now: () => 0,
  });
  return { svc, pty, spawn, captured };
}

test("create spawns a PTY with scrubbed env + cwd and returns a terminalId", () => {
  const { svc, spawn } = setup();
  process.env.ANTHROPIC_API_KEY = "secret";
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 100, rows: 30 });
  expect(typeof terminalId).toBe("string");
  expect(terminalId.length).toBeGreaterThan(0);
  const call = (spawn as ReturnType<typeof mock>).mock.calls[0];
  const opts = call[2] as { cwd: string; cols: number; rows: number; env: Record<string, string> };
  expect(opts.cwd).toBe("/tmp/ws");
  expect(opts.cols).toBe(100);
  expect(opts.rows).toBe(30);
  expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(opts.env.TERM).toBe("xterm-256color");
  delete process.env.ANTHROPIC_API_KEY;
});

test("PTY data emits terminal-output with monotonic seq", () => {
  const { svc, pty, captured } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("hello");
  pty.emitData("world");
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<ControlEvent, { type: "terminal-output" }>[];
  expect(outs.map((o) => [o.terminalId, o.seq, o.data])).toEqual([
    [terminalId, 0, "hello"],
    [terminalId, 1, "world"],
  ]);
});

test("write/resize/close proxy to the PTY; exit emits terminal-exit", () => {
  const { svc, pty, captured } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  svc.write(terminalId, "ls\n");
  expect((pty.write as ReturnType<typeof mock>).mock.calls[0][0]).toBe("ls\n");
  svc.resize(terminalId, 120, 40);
  expect((pty.resize as ReturnType<typeof mock>).mock.calls[0]).toEqual([120, 40]);
  svc.close(terminalId);
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  pty.emitExit(0);
  const exit = captured.find((e) => e.type === "terminal-exit") as Extract<ControlEvent, { type: "terminal-exit" }>;
  expect(exit).toEqual({ type: "terminal-exit", terminalId, code: 0 });
});

test("write/resize/close on an unknown terminalId are no-ops (no throw)", () => {
  const { svc } = setup();
  expect(() => svc.write("nope", "x")).not.toThrow();
  expect(() => svc.resize("nope", 1, 1)).not.toThrow();
  expect(() => svc.close("nope")).not.toThrow();
});

test("create throws terminal-unsupported-platform on win32", () => {
  const { svc } = setup({ platform: "win32" });
  expect(() => svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 })).toThrow("terminal-unsupported-platform");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node tests/run-tests.mjs tests/unit/control/terminal-service.test.ts`
Expected: FAIL（`createTerminalService` 不存在）

- [ ] **Step 4: 实现 `src/control/terminal-service.ts`**

```typescript
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn as spawnPty } from "node-pty";
import { resolveNodePtyHelperPath, ensureNodePtyHelperExecutable } from "../transport/acpx-cli/node-pty-helper";
import type { ControlEventBus } from "./control-event-bus";

const require = createRequire(import.meta.url);

/** Secret-bearing env keys stripped before handing the shell its environment. */
export const SENSITIVE_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN",
];

export interface PtyHandle {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyHandle;

export interface TerminalCreateInput { cwd: string; cols: number; rows: number }

export interface TerminalService {
  create(input: TerminalCreateInput): { terminalId: string };
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  disposeAll(): void;
}

export interface TerminalServiceDeps {
  events: ControlEventBus;
  idleTimeoutSeconds: () => number;
  spawn?: PtySpawn;
  platform?: NodeJS.Platform;
  now?: () => number;
}

function scrubEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV_KEYS.includes(k) || k.startsWith("XACPX_")) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.LANG = out.LANG ?? "en_US.UTF-8";
  return out;
}

function defaultShell(platform: NodeJS.Platform): string {
  if (process.env.SHELL) return process.env.SHELL;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function realPtySpawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyHandle {
  const helperPath = resolveNodePtyHelperPath(require.resolve("node-pty/package.json"), process.platform, process.arch);
  void ensureNodePtyHelperExecutable(helperPath);
  return spawnPty(file, args, opts) as unknown as PtyHandle;
}

interface Session { handle: PtyHandle; seq: number; idleTimer: ReturnType<typeof setTimeout> | null }

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const spawn = deps.spawn ?? realPtySpawn;
  const platform = deps.platform ?? process.platform;
  const sessions = new Map<string, Session>();

  const resetIdle = (terminalId: string) => {
    const s = sessions.get(terminalId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const ms = deps.idleTimeoutSeconds() * 1000;
    s.idleTimer = setTimeout(() => { try { s.handle.kill(); } catch { /* already gone */ } }, ms);
    if (typeof s.idleTimer.unref === "function") s.idleTimer.unref();
  };

  return {
    create({ cwd, cols, rows }) {
      if (platform === "win32") throw new Error("terminal-unsupported-platform");
      const terminalId = randomUUID();
      const handle = spawn(defaultShell(platform), [], { name: "xterm-256color", cols, rows, cwd, env: scrubEnv() });
      const session: Session = { handle, seq: 0, idleTimer: null };
      sessions.set(terminalId, session);
      handle.onData((data) => {
        deps.events.emit({ type: "terminal-output", terminalId, seq: session.seq++, data });
        resetIdle(terminalId);
      });
      handle.onExit(({ exitCode }) => {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        sessions.delete(terminalId);
        deps.events.emit({ type: "terminal-exit", terminalId, code: exitCode });
      });
      resetIdle(terminalId);
      return { terminalId };
    },
    write(terminalId, data) {
      const s = sessions.get(terminalId);
      if (!s) return;
      s.handle.write(data);
      resetIdle(terminalId);
    },
    resize(terminalId, cols, rows) {
      sessions.get(terminalId)?.handle.resize(cols, rows);
    },
    close(terminalId) {
      const s = sessions.get(terminalId);
      if (!s) return;
      try { s.handle.kill(); } catch { /* already gone */ }
    },
    disposeAll() {
      for (const s of sessions.values()) { try { s.handle.kill(); } catch { /* ignore */ } }
    },
  };
}
```

> 注:`createRequire(import.meta.url)` 镜像 `acpx-cli-transport.ts` 既有写法(static import,无顶层 await)。先看 `src/control/*.ts` 现有 import 风格对齐(若该目录用 CommonJS `require` 直接可用,删掉这两行)。

- [ ] **Step 5: 跑测试确认通过**

Run: `node tests/run-tests.mjs tests/unit/control/terminal-service.test.ts`
Expected: PASS（6/6,含 control-event-bus 变体已加故 tsc 不报)

- [ ] **Step 6: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/control/terminal-service.ts src/control/control-event-bus.ts tests/unit/control/terminal-service.test.ts
git commit -m "feat(control): TerminalService manages PTY lifecycle, emits terminal-output/exit"
```

---

### Task 3: ControlService 终端方法 + main.ts 接线

**Files:**
- Modify: `src/control/control-service.ts`(`ControlServiceDeps` 加 `terminal`;加 4 个方法)
- Modify: `src/main.ts`(构造 TerminalService 并注入 ControlService deps;接 disposeAll 到清理)
- Test: `tests/unit/control/control-service-terminal.test.ts`

**Interfaces:**
- Consumes: `TerminalService`(Task 2);`resolveControlSession(chatKey, alias): Promise<ResolvedSession | null>`(control-service.ts:212,已存在,`ResolvedSession` 有 `cwd`);`terminalEnabled(config)`(Task 1)。
- Produces: `ControlService.createTerminal/writeTerminal/resizeTerminal/closeTerminal`(见共享契约)。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/control/control-service-terminal.test.ts
import { test, expect, mock } from "bun:test";
import { ControlService, type ControlServiceDeps } from "../../../src/control/control-service";

function makeDeps(over: { enabled: boolean; session?: { cwd: string } | null }): ControlServiceDeps {
  const terminal = {
    create: mock(() => ({ terminalId: "term-1" })),
    write: mock(() => {}),
    resize: mock(() => {}),
    close: mock(() => {}),
    disposeAll: mock(() => {}),
  };
  // Minimal deps: only what createTerminal touches. Cast the rest.
  return {
    sessions: {
      resolveAliasForChat: mock(async (_c: string, a: string) => a),
      getSession: mock(async (_a: string) => (over.session === null ? null : { cwd: over.session?.cwd ?? "/tmp/ws" })),
    },
    terminal,
    terminalEnabled: () => over.enabled,
    events: { subscribe: () => () => {}, emit: () => {} },
  } as unknown as ControlServiceDeps & { _terminal: typeof terminal };
}

test("createTerminal rejects when terminal disabled (no PTY spawn)", async () => {
  const deps = makeDeps({ enabled: false });
  const svc = new ControlService(deps);
  await expect(svc.createTerminal("relay:acc", "demo", 80, 24)).rejects.toThrow("terminal-disabled");
  expect((deps.terminal.create as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("createTerminal resolves session cwd and delegates to TerminalService", async () => {
  const deps = makeDeps({ enabled: true, session: { cwd: "/home/me/proj" } });
  const svc = new ControlService(deps);
  const r = await svc.createTerminal("relay:acc", "demo", 100, 30);
  expect(r).toEqual({ terminalId: "term-1" });
  expect((deps.terminal.create as ReturnType<typeof mock>).mock.calls[0][0]).toEqual({ cwd: "/home/me/proj", cols: 100, rows: 30 });
});

test("createTerminal throws when session not found", async () => {
  const deps = makeDeps({ enabled: true, session: null });
  const svc = new ControlService(deps);
  await expect(svc.createTerminal("relay:acc", "ghost", 80, 24)).rejects.toThrow("session-not-found");
});

test("write/resize/close delegate to TerminalService", () => {
  const deps = makeDeps({ enabled: true });
  const svc = new ControlService(deps);
  svc.writeTerminal("term-1", "ls\n");
  svc.resizeTerminal("term-1", 90, 20);
  svc.closeTerminal("term-1");
  expect((deps.terminal.write as ReturnType<typeof mock>).mock.calls[0]).toEqual(["term-1", "ls\n"]);
  expect((deps.terminal.resize as ReturnType<typeof mock>).mock.calls[0]).toEqual(["term-1", 90, 20]);
  expect((deps.terminal.close as ReturnType<typeof mock>).mock.calls[0]).toEqual(["term-1"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/run-tests.mjs tests/unit/control/control-service-terminal.test.ts`
Expected: FAIL（`createTerminal` 不存在 / deps 无 terminal）

- [ ] **Step 3: 实现**

`src/control/control-service.ts`,`ControlServiceDeps`(69-117)末尾(`uploadStore: UploadStore;` 之后)加:

```typescript
  // Interactive terminal PTY manager (web terminal). Optional gate read from live config.
  terminal: import("./terminal-service").TerminalService;
  terminalEnabled: () => boolean;
```

在 `ControlService` 类里(范式参考 prompt/executeCommand)加 4 个方法:

```typescript
  /** Open an interactive terminal in the session's workspace cwd. Rejected when terminal is disabled. */
  async createTerminal(chatKey: string, sessionAlias: string, cols: number, rows: number): Promise<{ terminalId: string }> {
    if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled");
    const session = await this.resolveControlSession(chatKey, sessionAlias);
    if (!session) throw new Error("session-not-found");
    return this.deps.terminal.create({ cwd: session.cwd, cols, rows });
  }

  writeTerminal(terminalId: string, data: string): void {
    this.deps.terminal.write(terminalId, data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.deps.terminal.resize(terminalId, cols, rows);
  }

  closeTerminal(terminalId: string): void {
    this.deps.terminal.close(terminalId);
  }
```

`src/main.ts`:找到 `new ControlService({...})`(或组装 ControlServiceDeps 处),在其前构造 TerminalService 并注入:

```typescript
import { createTerminalService } from "./control/terminal-service";
import { terminalEnabled, terminalIdleTimeoutSeconds } from "./config/types";

// where `config` (AppConfig) and the ControlEventBus (`controlEvents`/`events`) are in scope:
const terminalService = createTerminalService({
  events: controlEvents,
  idleTimeoutSeconds: () => terminalIdleTimeoutSeconds(config),
});
// ...inside the ControlServiceDeps object literal:
  terminal: terminalService,
  terminalEnabled: () => terminalEnabled(config),
```

并在进程清理处(找现有 transport/daemon dispose 的地方,如 `run-console.ts` 的 cleanup)加 `terminalService.disposeAll();`。
> 先 `command grep -n "new ControlService" src/main.ts` 与 `command grep -rn "ControlEventBus\|createControlEventBus" src/main.ts` 定位变量真实名字(可能叫 `events`/`controlEventBus`),对齐再写。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/run-tests.mjs tests/unit/control/control-service-terminal.test.ts`
Expected: PASS（4/4）

- [ ] **Step 5: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/control/control-service.ts src/main.ts tests/unit/control/control-service-terminal.test.ts
git commit -m "feat(control): ControlService terminal methods + wire TerminalService in main"
```

---

### Task 4: 协议 DTO(事件下行 + RPC + web→hub 上行帧 + 网关下行类型)

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts`
- Modify: `packages/relay-protocol/src/dtos.ts`
- Modify: `packages/relay-protocol/src/web-dtos.ts`
- Test: `tests/unit/packages/relay-protocol/terminal-dtos.test.ts`

**Interfaces:**
- Produces: `MSG.terminalCreate/terminalInput/terminalResize/terminalClose`;`ControlEventDto` 的 terminal-output/exit 变体;`WEB_CLIENT_TYPE`、`WebClientMessage`、`parseWebClientMessage(envelope): WebClientMessage | null`、`webClientEnvelope(msg): RelayEnvelope`。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/packages/relay-protocol/terminal-dtos.test.ts
import { test, expect } from "bun:test";
import {
  MSG, parseWebServerEvent, webEventEnvelope, parseWebClientMessage, webClientEnvelope,
  type ControlEventDto, type WebClientMessage,
} from "../../../../packages/relay-protocol/src/index";

test("MSG has the terminal types", () => {
  expect(MSG.terminalCreate).toBe("control.terminal.create");
  expect(MSG.terminalInput).toBe("instance.terminal.input");
  expect(MSG.terminalResize).toBe("instance.terminal.resize");
  expect(MSG.terminalClose).toBe("instance.terminal.close");
});

test("terminal-output survives the web event gate", () => {
  const event: ControlEventDto = { type: "terminal-output", terminalId: "t1", seq: 3, data: "hi" };
  const env = webEventEnvelope({ kind: "control-event", instanceId: "i1", event });
  const parsed = parseWebServerEvent(env);
  expect(parsed).not.toBeNull();
  expect((parsed as { event: ControlEventDto }).event).toEqual(event);
});

test("terminal-exit survives the web event gate", () => {
  const event: ControlEventDto = { type: "terminal-exit", terminalId: "t1", code: 0 };
  const parsed = parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i1", event }));
  expect(parsed).not.toBeNull();
});

test("malformed terminal-output is rejected by the gate", () => {
  const bad = webEventEnvelope({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: "nope", data: "x" } as unknown as ControlEventDto });
  expect(parseWebServerEvent(bad)).toBeNull();
});

test("parseWebClientMessage round-trips terminal-input/resize/close", () => {
  const msgs: WebClientMessage[] = [
    { kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" },
    { kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 120, rows: 40 },
    { kind: "terminal-close", instanceId: "i1", terminalId: "t1" },
  ];
  for (const m of msgs) expect(parseWebClientMessage(webClientEnvelope(m))).toEqual(m);
});

test("parseWebClientMessage rejects wrong envelope/shape", () => {
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "web.client", payload: { kind: "nope" } } as never)).toBeNull();
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "other", payload: {} } as never)).toBeNull();
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "web.client", payload: { kind: "terminal-input", instanceId: "i1", terminalId: "t1" } } as never)).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run build:relay-protocol && node tests/run-tests.mjs tests/unit/packages/relay-protocol/terminal-dtos.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`messages.ts`,`MSG` 对象里(`sessionModelSet` 之后)加:

```typescript
  terminalCreate: "control.terminal.create",
  terminalInput: "instance.terminal.input",
  terminalResize: "instance.terminal.resize",
  terminalClose: "instance.terminal.close",
```

`dtos.ts`,`ControlEventDto` union 里(`| { type: "orchestration-changed" };` 之前)加:

```typescript
  | { type: "terminal-output"; terminalId: string; seq: number; data: string }
  | { type: "terminal-exit"; terminalId: string; code: number }
```

`web-dtos.ts`:`CONTROL_EVENT_TYPES` 集合加 `"terminal-output"`、`"terminal-exit"`;`validControlEvent` 在 `return true;` 之前加分支:

```typescript
  if (c.type === "terminal-output")
    return typeof c.terminalId === "string" && typeof c.seq === "number" && typeof c.data === "string";
  if (c.type === "terminal-exit")
    return typeof c.terminalId === "string" && typeof c.code === "number";
```

`web-dtos.ts` 末尾加 web→hub 上行帧(新方向,无先例):

```typescript
export const WEB_CLIENT_TYPE = "web.client";

export type WebClientMessage =
  | { kind: "terminal-input"; instanceId: string; terminalId: string; data: string }
  | { kind: "terminal-resize"; instanceId: string; terminalId: string; cols: number; rows: number }
  | { kind: "terminal-close"; instanceId: string; terminalId: string };

export function webClientEnvelope(msg: WebClientMessage): RelayEnvelope {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_CLIENT_TYPE, payload: msg };
}

export function parseWebClientMessage(envelope: RelayEnvelope): WebClientMessage | null {
  if (envelope.kind !== "event" || envelope.type !== WEB_CLIENT_TYPE) return null;
  const p = envelope.payload;
  if (typeof p !== "object" || p === null) return null;
  const c = p as Record<string, unknown>;
  if (typeof c.instanceId !== "string" || typeof c.terminalId !== "string") return null;
  if (c.kind === "terminal-input") return typeof c.data === "string" ? (p as WebClientMessage) : null;
  if (c.kind === "terminal-resize") return typeof c.cols === "number" && typeof c.rows === "number" ? (p as WebClientMessage) : null;
  if (c.kind === "terminal-close") return p as WebClientMessage;
  return null;
}
```

确认 `RELAY_PROTOCOL_VERSION`、`RelayEnvelope` 在 web-dtos.ts 已 import(否则从 `./envelope` 补);并确认 `packages/relay-protocol/src/index.ts` 导出了这些新符号(barrel 一般 `export * from "./web-dtos"`,自动带出)。

- [ ] **Step 4: 重建 dist + 跑测试确认通过**

Run: `bun run build:relay-protocol && node tests/run-tests.mjs tests/unit/packages/relay-protocol/terminal-dtos.test.ts`
Expected: PASS（6/6）

- [ ] **Step 5: typecheck + 提交**

```bash
npx tsc --noEmit
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/src/dtos.ts packages/relay-protocol/src/web-dtos.ts packages/relay-protocol/dist tests/unit/packages/relay-protocol/terminal-dtos.test.ts
git commit -m "feat(protocol): terminal DTOs (control-event downstream + web→hub client frames)"
```

---

### Task 5: 连接器(create dispatch + 入站 event 路由)

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts`(dispatchControlRequest 加 terminalCreate;新增 dispatchControlEvent)
- Modify: `packages/channel-relay/src/relay-client.ts`(handleMessage 加 kind=event 下行分支 + `onEvent` option)
- Modify: `packages/channel-relay/src/channel.ts`(接线 client.onEvent → dispatchControlEvent)
- Test: `tests/unit/packages/channel-relay/terminal-bridge.test.ts`

**Interfaces:**
- Consumes: `ControlService.createTerminal/writeTerminal/resizeTerminal/closeTerminal`(Task 3);`MSG.terminalCreate/Input/Resize/Close`(Task 4)。
- Produces: `dispatchControlEvent(control, envelope): void`(导出供测试);`RelayClientOptions.onEvent?: (envelope: RelayEnvelope) => void`。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/packages/channel-relay/terminal-bridge.test.ts
import { test, expect, mock } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "@ganglion/xacpx-relay-protocol";
import { dispatchControlEvent } from "../../../../packages/channel-relay/src/control-bridge";

function fakeControl() {
  return {
    createTerminal: mock(async () => ({ terminalId: "t1" })),
    writeTerminal: mock(() => {}),
    resizeTerminal: mock(() => {}),
    closeTerminal: mock(() => {}),
  };
}

test("dispatchControlEvent routes terminal.input to writeTerminal", () => {
  const control = fakeControl();
  const env: RelayEnvelope = { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalInput, payload: { terminalId: "t1", data: "ls\n" } };
  dispatchControlEvent(control as never, env);
  expect((control.writeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1", "ls\n"]);
});

test("dispatchControlEvent routes terminal.resize and terminal.close", () => {
  const control = fakeControl();
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalResize, payload: { terminalId: "t1", cols: 90, rows: 20 } });
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalClose, payload: { terminalId: "t1" } });
  expect((control.resizeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1", 90, 20]);
  expect((control.closeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1"]);
});

test("dispatchControlEvent ignores unrelated event types", () => {
  const control = fakeControl();
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "instance.something", payload: {} });
  expect((control.writeTerminal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run build:relay-protocol && node tests/run-tests.mjs tests/unit/packages/channel-relay/terminal-bridge.test.ts`
Expected: FAIL（`dispatchControlEvent` 未导出）

- [ ] **Step 3: 实现**

`control-bridge.ts`,`dispatchControlRequest` 的 switch 里(`case MSG.upload:` 之前)加:

```typescript
    case MSG.terminalCreate: {
      const input = payload as { chatKey: string; sessionAlias: string; cols?: number; rows?: number };
      if (!input.sessionAlias) return errorPayload("bad-request", "sessionAlias is required");
      return await control.createTerminal(input.chatKey, input.sessionAlias, input.cols ?? 80, input.rows ?? 24);
    }
```

`control-bridge.ts` 末尾(`subscribeControlEvents` 旁)加 export:

```typescript
/** Routes hub→connector downward terminal event frames to the ControlService. Fire-and-forget. */
export function dispatchControlEvent(control: ControlService, envelope: RelayEnvelope): void {
  const p = (envelope.payload ?? {}) as { terminalId?: string; data?: string; cols?: number; rows?: number };
  if (!p.terminalId) return;
  switch (envelope.type) {
    case MSG.terminalInput:
      if (typeof p.data === "string") control.writeTerminal(p.terminalId, p.data);
      return;
    case MSG.terminalResize:
      if (typeof p.cols === "number" && typeof p.rows === "number") control.resizeTerminal(p.terminalId, p.cols, p.rows);
      return;
    case MSG.terminalClose:
      control.closeTerminal(p.terminalId);
      return;
    default:
      return;
  }
}
```

`relay-client.ts`:`RelayClientOptions`(接口定义处)加 `onEvent?: (envelope: RelayEnvelope) => void;`。`handleMessage` 里,在 `relay.protocol-error` 分支(141-153)之后、`res/HANDSHAKE_ID` 分支之前,加:

```typescript
    if (envelope.kind === "event") {
      this.options.onEvent?.(envelope);
      return;
    }
```

`channel.ts`:client 构造处(传 `onRequest` 那里,约 83 行附近)加 `onEvent`:

```typescript
import { createControlBridge, subscribeControlEvents, dispatchControlEvent } from "./control-bridge.js";
// ...在 new RelayClient({...}) 的 options 里:
  onEvent: (envelope) => dispatchControlEvent(input.control, envelope),
```

> 确认 channel.ts 里 ControlService 实例变量名(`input.control`),对齐 subscribeControlEvents 用的同一个。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/run-tests.mjs tests/unit/packages/channel-relay/terminal-bridge.test.ts`
Expected: PASS（4/4）

- [ ] **Step 5: typecheck + 提交**

```bash
npx tsc --noEmit
git add packages/channel-relay/src/control-bridge.ts packages/channel-relay/src/relay-client.ts packages/channel-relay/src/channel.ts tests/unit/packages/channel-relay/terminal-bridge.test.ts
git commit -m "feat(connector): dispatch terminal.create + route inbound terminal events to PTY"
```

---

### Task 6: Hub(网关下行 sendEvent + /ws 上行 + create 盖章)

**Files:**
- Modify: `packages/relay/src/gateway/instance-gateway.ts`(加 `sendEvent`)
- Create: `packages/relay/src/gateway/web-inbound.ts`(`handleWebClientMessage`,独立小文件避免单测 import server.ts 副作用)
- Modify: `packages/relay/src/server.ts`(/ws upgrade 挂 message handler → 调 `handleWebClientMessage`)
- Modify: `packages/relay/src/http/app.ts`(CHAT_SCOPED_TYPES += terminalCreate)
- Test: `tests/unit/packages/relay/terminal-gateway.test.ts`、`tests/unit/packages/relay/terminal-web-inbound.test.ts`

**Interfaces:**
- Consumes: `MSG.terminalInput/Resize/Close/terminalCreate`、`parseWebClientMessage`(Task 4);`InstanceStore.getOwned`(已存在,app.ts 用过)。
- Produces: `InstanceGateway.sendEvent(instanceId, type, payload): boolean`;`handleWebClientMessage(deps: WebClientDeps, accountId, raw): void`(`web-inbound.ts` 导出)。

- [ ] **Step 1: 写失败测试(网关下行)**

```typescript
// tests/unit/packages/relay/terminal-gateway.test.ts
import { test, expect } from "bun:test";
import { InstanceGateway } from "../../../../packages/relay/src/gateway/instance-gateway";
import { decodeEnvelope, MSG, RELAY_PROTOCOL_VERSION } from "@ganglion/xacpx-relay-protocol";

function fakeSocket() {
  const sent: string[] = [];
  let msg: ((d: unknown) => void) | null = null;
  return {
    sent,
    fire: (d: unknown) => msg?.(d),
    send: (d: string) => sent.push(d),
    close: () => {},
    on(ev: string, cb: never) { if (ev === "message") msg = cb as unknown as (d: unknown) => void; return undefined; },
  };
}

function authedGateway() {
  const gw = new InstanceGateway({
    instances: { redeemPairingToken: () => null as never, registerInstanceForAccount: () => ({ instanceId: "i1", accountId: "a1", credential: "c" }) as never, verifyCredential: () => ({ id: "i1", accountId: "a1" }) as never, touch: () => {} },
    accounts: { resolveLoginToken: () => null },
  });
  const socket = fakeSocket();
  gw.handleConnection(socket as never);
  socket.fire(JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h", type: MSG.instanceAuth, payload: { instanceId: "i1", credential: "c" } }));
  socket.sent.length = 0; // drop handshake res
  return { gw, socket };
}

test("sendEvent pushes a kind=event frame with no pending request/timeout", () => {
  const { gw, socket } = authedGateway();
  const ok = gw.sendEvent("i1", MSG.terminalInput, { terminalId: "t1", data: "ls\n" });
  expect(ok).toBe(true);
  const env = decodeEnvelope(socket.sent[0]);
  expect(env.ok && env.envelope.kind).toBe("event");
  expect(env.ok && env.envelope.type).toBe(MSG.terminalInput);
  expect(env.ok && env.envelope.id).toBeUndefined();
  expect(env.ok && env.envelope.payload).toEqual({ terminalId: "t1", data: "ls\n" });
});

test("sendEvent to an offline instance returns false", () => {
  const { gw } = authedGateway();
  expect(gw.sendEvent("nope", MSG.terminalInput, {})).toBe(false);
});
```

- [ ] **Step 2: 写失败测试(/ws 上行归属校验)**

```typescript
// tests/unit/packages/relay/terminal-web-inbound.test.ts
import { test, expect, mock } from "bun:test";
import { handleWebClientMessage } from "../../../../packages/relay/src/gateway/web-inbound";
import { webClientEnvelope, encodeEnvelope, MSG } from "@ganglion/xacpx-relay-protocol";

function deps(owned: boolean) {
  return {
    instances: { getOwned: mock((id: string, acc: string) => (owned && id === "i1" && acc === "a1" ? { id: "i1" } : undefined)) },
    gateway: { sendEvent: mock(() => true) },
  };
}

test("owned terminal-input is forwarded as a gateway event", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls[0]).toEqual(["i1", MSG.terminalInput, { terminalId: "t1", data: "ls\n" }]);
});

test("non-owned instance is dropped (no forward)", () => {
  const d = deps(false);
  handleWebClientMessage(d as never, "a1", encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "x" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("resize/close map to their gateway event types", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", encodeEnvelope(webClientEnvelope({ kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 90, rows: 20 })));
  handleWebClientMessage(d as never, "a1", encodeEnvelope(webClientEnvelope({ kind: "terminal-close", instanceId: "i1", terminalId: "t1" })));
  const calls = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls;
  expect(calls[0]).toEqual(["i1", MSG.terminalResize, { terminalId: "t1", cols: 90, rows: 20 }]);
  expect(calls[1]).toEqual(["i1", MSG.terminalClose, { terminalId: "t1" }]);
});

test("garbage upstream frame is ignored", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", "not json");
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run build:relay-protocol && node tests/run-tests.mjs tests/unit/packages/relay/terminal-gateway.test.ts && node tests/run-tests.mjs tests/unit/packages/relay/terminal-web-inbound.test.ts`
Expected: FAIL（`sendEvent`/`handleWebClientMessage` 不存在）

- [ ] **Step 4: 实现**

`instance-gateway.ts`,`sendRequest` 之后加:

```typescript
  /** Fire-and-forget downward event to a connector. No pending/timeout. Returns false if offline. */
  sendEvent(instanceId: string, type: string, payload: unknown): boolean {
    const connection = this.connections.get(instanceId);
    if (!connection) return false;
    connection.socket.send(encodeEnvelope({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type, payload }));
    return true;
  }
```

新建 `packages/relay/src/gateway/web-inbound.ts`:

```typescript
import { decodeEnvelope, MSG, parseWebClientMessage } from "@ganglion/xacpx-relay-protocol";

export interface WebClientDeps {
  instances: { getOwned(id: string, accountId: string): unknown };
  gateway: { sendEvent(instanceId: string, type: string, payload: unknown): boolean };
}

/** Decode + authorize + forward a browser→hub terminal frame as a connector event. */
export function handleWebClientMessage(deps: WebClientDeps, accountId: string, raw: string): void {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return;
  const msg = parseWebClientMessage(decoded.envelope);
  if (!msg) return;
  if (!deps.instances.getOwned(msg.instanceId, accountId)) return; // ownership gate
  if (msg.kind === "terminal-input") deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, { terminalId: msg.terminalId, data: msg.data });
  else if (msg.kind === "terminal-resize") deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
  else if (msg.kind === "terminal-close") deps.gateway.sendEvent(msg.instanceId, MSG.terminalClose, { terminalId: msg.terminalId });
}
```

`server.ts` 顶部 import 加 `import { handleWebClientMessage } from "./gateway/web-inbound";`。`server.ts` 的 `/ws` upgrade(290-307)里,把 register 那行改为同时挂 message handler:

```typescript
    webWss.handleUpgrade(req, socket, head, (ws) => {
      runtime.webGateway.register(account.id, ws);
      ws.on("message", (data: unknown) => handleWebClientMessage({ instances: runtime.instances, gateway: runtime.gateway }, account.id, String(data)));
    });
```

`http/app.ts`,`CHAT_SCOPED_TYPES`(51-63)加 `MSG.terminalCreate,`(终端 create 带 sessionAlias,需服务端盖 chatKey)。

> 确认 `runtime.instances` 暴露了 `getOwned`(app.ts 用 `deps.instances.getOwned`,server.ts 里对应 `runtime.instances`/`runtime.stores.instances`,以实际为准),`runtime.gateway` 即 InstanceGateway 实例。

- [ ] **Step 5: 跑测试确认通过**

Run: `node tests/run-tests.mjs tests/unit/packages/relay/terminal-gateway.test.ts && node tests/run-tests.mjs tests/unit/packages/relay/terminal-web-inbound.test.ts`
Expected: PASS（gateway 2/2 + inbound 4/4）

- [ ] **Step 6: typecheck + 提交**

```bash
npx tsc --noEmit
git add packages/relay/src/gateway/instance-gateway.ts packages/relay/src/server.ts packages/relay/src/http/app.ts tests/unit/packages/relay/terminal-gateway.test.ts tests/unit/packages/relay/terminal-web-inbound.test.ts
git commit -m "feat(hub): gateway downward sendEvent + /ws inbound terminal frames with ownership gate"
```

---

### Task 7: relay-web 终端 adapter(ghostty-web 封装 + 依赖)

**Files:**
- Create: `packages/relay-web/src/lib/terminal-adapter.ts`
- Modify: `packages/relay-web/package.json`(加 `ghostty-web`)
- Modify: 根 `package-lock.json`(经 `npm install --package-lock-only`)
- Test: `packages/relay-web/src/__tests__/terminal-adapter.test.ts`

**Interfaces:**
- Produces: `createTerminalAdapter(el: HTMLElement, opts: { cols: number; rows: number; onData: (d: string) => void }): TerminalAdapter`;`TerminalAdapter = { write(d: string): void; resize(cols: number, rows: number): void; dispose(): void; cols(): number; rows(): number }`。内部用 ghostty-web,注入式 `factory` 供测试。

- [ ] **Step 1: 加依赖 + 同步根 lock**

```bash
cd /Users/maijiazhen/Projects/workspace-a
npm pkg set dependencies.ghostty-web="^0.4.0" --prefix packages/relay-web
npm install --package-lock-only
```
Expected: `packages/relay-web/package.json` 出现 `ghostty-web`,根 `package-lock.json` 含其条目。

- [ ] **Step 2: 写失败测试**

```typescript
// packages/relay-web/src/__tests__/terminal-adapter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTerminalAdapter } from "../lib/terminal-adapter";

function fakeTerminal() {
  const onData = vi.fn();
  return {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    onData: (cb: (d: string) => void) => { onData(cb); (fakeTerminal as never as { _cb: typeof cb })._cb = cb; },
    cols: 80,
    rows: 24,
    _onData: onData,
  };
}

describe("terminal-adapter", () => {
  it("opens the ghostty terminal on the element and wires onData", () => {
    const term = fakeTerminal();
    const onData = vi.fn();
    const el = document.createElement("div");
    createTerminalAdapter(el, { cols: 100, rows: 30, onData, factory: () => term as never });
    expect(term.open).toHaveBeenCalledWith(el);
    expect(term._onData).toHaveBeenCalled();
  });

  it("write/resize/dispose proxy to the underlying terminal", () => {
    const term = fakeTerminal();
    const a = createTerminalAdapter(document.createElement("div"), { cols: 80, rows: 24, onData: () => {}, factory: () => term as never });
    a.write("hi");
    a.resize(120, 40);
    a.dispose();
    expect(term.write).toHaveBeenCalledWith("hi");
    expect(term.resize).toHaveBeenCalledWith(120, 40);
    expect(term.dispose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run packages/relay-web/src/__tests__/terminal-adapter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `packages/relay-web/src/lib/terminal-adapter.ts`**

```typescript
// Thin wrapper over ghostty-web (xterm.js-compatible API). Isolating it here means a
// future swap back to @xterm/xterm only touches this file. ghostty-web docs confirm
// open()/write()/onData(); resize()/cols/rows are assumed xterm-compatible — if an
// addon/API gap bites, replace `defaultFactory` here, not the call sites.
export interface GhosttyTerminalLike {
  open(el: HTMLElement): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  cols: number;
  rows: number;
}

export interface TerminalAdapter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  cols(): number;
  rows(): number;
}

export interface TerminalAdapterOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  /** Test seam. Defaults to constructing a real ghostty-web Terminal. */
  factory?: (cols: number, rows: number) => GhosttyTerminalLike;
}

async function defaultFactory(cols: number, rows: number): Promise<GhosttyTerminalLike> {
  const mod = await import("ghostty-web");
  const Terminal = (mod as { Terminal: new (o: { cols: number; rows: number }) => GhosttyTerminalLike }).Terminal;
  return new Terminal({ cols, rows });
}

export function createTerminalAdapter(el: HTMLElement, opts: TerminalAdapterOptions): TerminalAdapter {
  // Synchronous path for tests (factory provided). Production uses the async import
  // via a microtask; the component awaits readiness before first write.
  const term = opts.factory ? opts.factory(opts.cols, opts.rows) : undefined;
  const ready = term ? Promise.resolve(term) : defaultFactory(opts.cols, opts.rows);
  let live: GhosttyTerminalLike | undefined = term;
  void ready.then((t) => {
    live = t;
    t.open(el);
    t.onData(opts.onData);
  });
  if (term) { term.open(el); term.onData(opts.onData); }
  return {
    write: (d) => live?.write(d),
    resize: (c, r) => live?.resize(c, r),
    dispose: () => live?.dispose(),
    cols: () => live?.cols ?? opts.cols,
    rows: () => live?.rows ?? opts.rows,
  };
}
```

> 实现注意:测试用 `factory` 同步注入;production 走 `defaultFactory` 动态 import。`open`/`onData` 在两条路都只调一次(test 路在构造末尾,prod 路在 `ready.then`)——为避免 double-open,实现里 test 路(`term` 存在)直接 open,prod 路在 then 里 open;`ready.then` 对 test 路因 `term` 已 resolve 也会再跑一次 → 实现需 guard。**修正**:把两路统一为只在 `ready.then` open,并在 test 里 `await` 一个 microtask。调整测试为 `await Promise.resolve()` 后再断言 `open`。实现以「只在 ready.then 内 open + onData」为准,删掉构造末尾的同步 open 那两行。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run packages/relay-web/src/__tests__/terminal-adapter.test.ts`
Expected: PASS（2/2）

- [ ] **Step 6: typecheck + 提交**

```bash
npx tsc --noEmit -p packages/relay-web/tsconfig.json || npx vue-tsc --noEmit -p packages/relay-web
git add packages/relay-web/src/lib/terminal-adapter.ts packages/relay-web/src/__tests__/terminal-adapter.test.ts packages/relay-web/package.json package-lock.json
git commit -m "feat(relay-web): ghostty-web terminal adapter behind a thin swappable wrapper"
```

---

### Task 8: relay-web 终端 store + /ws 上行 send

**Files:**
- Modify: `packages/relay-web/src/api/events.ts`(暴露上行 `sendWebClientMessage`)
- Create: `packages/relay-web/src/stores/terminal.ts`
- Test: `packages/relay-web/src/__tests__/terminal-store.test.ts`

**Interfaces:**
- Consumes: `api.rpc`(client.ts);`webClientEnvelope`/`WebClientMessage`(Task 4);`WebServerEvent`。
- Produces: `events.ts` 导出 `sendWebClientMessage(msg: WebClientMessage): void`;`useTerminalStore()` 带 `create(instanceId, sessionAlias, cols, rows)`、`input(instanceId, terminalId, data)`、`resize(...)`、`close(...)`、`applyEvent(event)`,以及 `onOutput(cb)` 让组件订阅写入 ghostty。

- [ ] **Step 1: events.ts 暴露上行 send**

在 `packages/relay-web/src/api/events.ts` 顶部加 import 与模块级 socket 引用,并导出 send:

```typescript
import { parseWebServerEvent, decodeEnvelope, encodeEnvelope, webClientEnvelope, type WebServerEvent, type WebClientMessage } from "@ganglion/xacpx-relay-protocol";

let activeSocket: WebSocket | null = null;

/** Send a browser→hub frame up the live /ws socket. No-op if disconnected. */
export function sendWebClientMessage(msg: WebClientMessage): void {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(encodeEnvelope(webClientEnvelope(msg)));
  }
}
```

在 `open()` 内 `socket = new WebSocket(...)` 之后设 `activeSocket = socket;`;在 `socket.onclose` 内 `onStatus?.(false);` 之后设 `activeSocket = null;`。

- [ ] **Step 2: 写失败测试**

```typescript
// packages/relay-web/src/__tests__/terminal-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));
vi.mock("../api/events", () => ({ sendWebClientMessage: vi.fn() }));

import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";
import { useTerminalStore } from "../stores/terminal";

describe("terminal store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("create calls control.terminal.create and stores terminalId", async () => {
    const s = useTerminalStore();
    const id = await s.create("i1", "demo", 100, 30);
    expect(id).toBe("t1");
    expect(api.rpc).toHaveBeenCalledWith("i1", "control.terminal.create", { sessionAlias: "demo", cols: 100, rows: 30 });
  });

  it("input/resize/close send web client frames", () => {
    const s = useTerminalStore();
    s.input("i1", "t1", "ls\n");
    s.resize("i1", "t1", 90, 20);
    s.close("i1", "t1");
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" });
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 90, rows: 20 });
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "terminal-close", instanceId: "i1", terminalId: "t1" });
  });

  it("applyEvent forwards terminal-output to onOutput subscribers and clears on exit", () => {
    const s = useTerminalStore();
    const out = vi.fn();
    const exit = vi.fn();
    s.onOutput(out);
    s.onExit(exit);
    s.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: 0, data: "hi" } } as never);
    s.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-exit", terminalId: "t1", code: 0 } } as never);
    expect(out).toHaveBeenCalledWith("t1", "hi");
    expect(exit).toHaveBeenCalledWith("t1", 0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run packages/relay-web/src/__tests__/terminal-store.test.ts`
Expected: FAIL（store 不存在）

- [ ] **Step 4: 实现 `packages/relay-web/src/stores/terminal.ts`**

```typescript
import { defineStore } from "pinia";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";

type OutputCb = (terminalId: string, data: string) => void;
type ExitCb = (terminalId: string, code: number) => void;

export const useTerminalStore = defineStore("terminal", () => {
  const outputCbs = new Set<OutputCb>();
  const exitCbs = new Set<ExitCb>();

  async function create(instanceId: string, sessionAlias: string, cols: number, rows: number): Promise<string> {
    const { terminalId } = await api.rpc<{ terminalId: string }>(instanceId, "control.terminal.create", { sessionAlias, cols, rows });
    return terminalId;
  }
  function input(instanceId: string, terminalId: string, data: string): void {
    sendWebClientMessage({ kind: "terminal-input", instanceId, terminalId, data });
  }
  function resize(instanceId: string, terminalId: string, cols: number, rows: number): void {
    sendWebClientMessage({ kind: "terminal-resize", instanceId, terminalId, cols, rows });
  }
  function close(instanceId: string, terminalId: string): void {
    sendWebClientMessage({ kind: "terminal-close", instanceId, terminalId });
  }
  function onOutput(cb: OutputCb): () => void { outputCbs.add(cb); return () => outputCbs.delete(cb); }
  function onExit(cb: ExitCb): () => void { exitCbs.add(cb); return () => exitCbs.delete(cb); }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind !== "control-event") return;
    const e = event.event;
    if (e.type === "terminal-output") for (const cb of outputCbs) cb(e.terminalId, e.data);
    else if (e.type === "terminal-exit") for (const cb of exitCbs) cb(e.terminalId, e.code);
  }

  return { create, input, resize, close, onOutput, onExit, applyEvent };
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run packages/relay-web/src/__tests__/terminal-store.test.ts`
Expected: PASS（3/3）

- [ ] **Step 6: typecheck + 提交**

```bash
npx vue-tsc --noEmit -p packages/relay-web
git add packages/relay-web/src/api/events.ts packages/relay-web/src/stores/terminal.ts packages/relay-web/src/__tests__/terminal-store.test.ts
git commit -m "feat(relay-web): terminal store + /ws upstream send"
```

---

### Task 9: relay-web TerminalTab + 右栏接线 + i18n

**Files:**
- Create: `packages/relay-web/src/components/TerminalTab.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue`(rightTab 加 terminal;按钮;条件渲染;事件分发加 terminals.applyEvent)
- Modify: `packages/relay-web/src/i18n/messages/en.ts` + `zh-CN.ts`(terminal 命名空间)
- Test: `packages/relay-web/src/__tests__/terminal-tab.test.ts`

**Interfaces:**
- Consumes: `createTerminalAdapter`(Task 7);`useTerminalStore`(Task 8);`useChatStore`(取 `instanceId`/选中 `sessionAlias`)。

- [ ] **Step 1: i18n 加文案两份**

`en.ts` 在 `tasks` 命名空间后加:

```typescript
  terminal: {
    title: "Terminal",
    disabled: "Terminal is disabled. Enable `terminal.enabled` in the instance config.",
    unsupported: "Terminal is unsupported on this instance platform (v1: macOS/Linux only).",
    offline: "Instance is offline.",
    noSession: "Select a session to open a terminal.",
    exited: "Terminal exited (code {code}).",
  },
```

`zh-CN.ts` 对应:

```typescript
  terminal: {
    title: "终端",
    disabled: "终端未启用。请在实例 config 中开启 `terminal.enabled`。",
    unsupported: "该实例平台不支持终端(v1 仅 macOS/Linux)。",
    offline: "实例已离线。",
    noSession: "选择一个会话以打开终端。",
    exited: "终端已退出(退出码 {code})。",
  },
```

并在 `DashboardView.vue` 的 `nav` 命名空间加 `terminal: "Terminal"` / `终端`(右栏 tab 按钮文案,若复用 `terminal.title` 则跳过)。

- [ ] **Step 2: 写失败测试**

```typescript
// packages/relay-web/src/__tests__/terminal-tab.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

const adapter = { write: vi.fn(), resize: vi.fn(), dispose: vi.fn(), cols: () => 80, rows: () => 24 };
vi.mock("../lib/terminal-adapter", () => ({ createTerminalAdapter: vi.fn(() => adapter) }));
vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));
vi.mock("../api/events", () => ({ sendWebClientMessage: vi.fn() }));

import TerminalTab from "../components/TerminalTab.vue";
import { createTerminalAdapter } from "../lib/terminal-adapter";

const i18n = { global: { mocks: { $t: (k: string) => k } } } as never;

describe("TerminalTab", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("creates a terminal and mounts the adapter when a session is selected", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: i18n.global });
    await new Promise((r) => setTimeout(r, 0));
    expect(createTerminalAdapter).toHaveBeenCalled();
  });

  it("shows the no-session hint when sessionAlias is empty", () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "" }, global: i18n.global });
    expect(w.text()).toContain("terminal.noSession");
    expect(createTerminalAdapter).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run packages/relay-web/src/__tests__/terminal-tab.test.ts`
Expected: FAIL（组件不存在）

- [ ] **Step 4: 实现 `packages/relay-web/src/components/TerminalTab.vue`**

```vue
<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { createTerminalAdapter, type TerminalAdapter } from "../lib/terminal-adapter";
import { useTerminalStore } from "../stores/terminal";

const props = defineProps<{ instanceId: string; sessionAlias: string }>();
const terminals = useTerminalStore();
const host = ref<HTMLDivElement | null>(null);
const status = ref<"idle" | "connecting" | "open" | "exited" | "error">("idle");
const errorKey = ref<string>("");

let adapter: TerminalAdapter | null = null;
let terminalId = "";
let offOutput: (() => void) | null = null;
let offExit: (() => void) | null = null;
let resizeObs: ResizeObserver | null = null;

function teardown() {
  offOutput?.(); offExit?.();
  resizeObs?.disconnect(); resizeObs = null;
  if (terminalId) terminals.close(props.instanceId, terminalId);
  adapter?.dispose(); adapter = null; terminalId = "";
}

async function start() {
  teardown();
  if (!props.sessionAlias || !host.value) { status.value = "idle"; return; }
  status.value = "connecting";
  adapter = createTerminalAdapter(host.value, {
    cols: 80, rows: 24,
    onData: (d) => { if (terminalId) terminals.input(props.instanceId, terminalId, d); },
  });
  offOutput = terminals.onOutput((id, data) => { if (id === terminalId) adapter?.write(data); });
  offExit = terminals.onExit((id, code) => { if (id === terminalId) { status.value = "exited"; errorKey.value = String(code); } });
  try {
    terminalId = await terminals.create(props.instanceId, props.sessionAlias, adapter.cols(), adapter.rows());
    status.value = "open";
    resizeObs = new ResizeObserver(() => { if (terminalId && adapter) terminals.resize(props.instanceId, terminalId, adapter.cols(), adapter.rows()); });
    if (host.value) resizeObs.observe(host.value);
  } catch (e) {
    status.value = "error";
    const msg = e instanceof Error ? e.message : "";
    errorKey.value = msg === "terminal-disabled" ? "terminal.disabled"
      : msg === "terminal-unsupported-platform" ? "terminal.unsupported"
      : msg === "instance-offline" ? "terminal.offline" : "terminal.offline";
  }
}

watch(() => [props.instanceId, props.sessionAlias], () => void start(), { immediate: true });
onBeforeUnmount(teardown);
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="!props.sessionAlias" class="p-4 text-sm text-fg-muted">{{ $t("terminal.noSession") }}</div>
    <div v-else-if="status === 'error'" class="p-4 text-sm text-fg-muted">{{ $t(errorKey) }}</div>
    <div v-else-if="status === 'exited'" class="p-4 text-sm text-fg-muted">{{ $t("terminal.exited", { code: errorKey }) }}</div>
    <div ref="host" class="min-h-0 flex-1 overflow-hidden bg-black" data-test="terminal-host"></div>
  </div>
</template>
```

> `bg-black`/`text-fg-muted` 等用本仓既有 token;对齐 FilesPanel/TaskPanel 的容器类。

`DashboardView.vue`:
- 改 `const rightTab = ref<"tasks" | "files">("tasks");` → 加 `| "terminal"`(38 行);`openRight` 签名同步(43 行)。
- 在 tasks 按钮(328-333)后加 Terminal 按钮:

```html
          <button data-test="right-tab-terminal"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="rightTab === 'terminal' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'terminal'">
            <SquareTerminal :size="13" />{{ $t("terminal.title") }}
          </button>
```

- 在条件渲染(337-340)加:

```html
          <TaskPanel v-if="rightTab === 'tasks'" />
          <TerminalTab v-else-if="rightTab === 'terminal'" :instance-id="chat.instanceId" :session-alias="chat.sessionAlias" />
          <FilesPanel v-else :instance-id="chat.instanceId" />
```

- import `SquareTerminal`(lucide-vue-next)、`TerminalTab`;事件分发(174-179)加 `terminals.applyEvent(event);`,并在 setup 取 `const terminals = useTerminalStore();`。
> 确认 `chat.sessionAlias` 是选中会话别名的真实字段名(看 chat store);若叫 `selectedAlias` 之类则对齐。

- [ ] **Step 5: 跑测试 + i18n parity + 全套 web 测试**

Run: `npx vitest run packages/relay-web/src/__tests__/terminal-tab.test.ts packages/relay-web/src/__tests__/i18n-parity.test.ts`
Expected: PASS（terminal-tab 2/2 + i18n parity 通过）

- [ ] **Step 6: vue-tsc + 提交**

```bash
npx vue-tsc --noEmit -p packages/relay-web
git add packages/relay-web/src/components/TerminalTab.vue packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/terminal-tab.test.ts
git commit -m "feat(relay-web): TerminalTab + right-panel terminal tab + i18n"
```

---

## 最终校验(所有任务后)

- [ ] 全量类型检查:`npx tsc --noEmit`
- [ ] 核心 + 协议 + 连接器 + hub 单测:`npm test`(EXIT 0)
- [ ] relay-web 单测:`bun run test:web`(或 `npx vitest run packages/relay-web`)
- [ ] 协议 dist 是否提交:`git status packages/relay-protocol/dist`(必须含本次新导出)
- [ ] 根 lock 是否含 ghostty-web:`command grep -c ghostty-web package-lock.json`(>0)
- [ ] **手工 smoke(真 relay + 真 PTY)**:`terminal.enabled=true` 开会话终端、`ls`/`vim`/`top`、容器拉伸 resize、`exit` 退出、空闲超时;以及 `terminal.enabled=false` 时前端显示禁用提示。沙箱联调坑见 spec「测试」节(连接器是 plugin home 安装副本,需重打包+重装+重启 console;嵌套 relay-protocol 副本会遮蔽,需 `rm -rf` 回退)。

## v2 预留缝(本计划不实现,仅记录)

- `terminalId` 服务端生成 + `terminal-output.seq` 单调 → v2 hub 环形缓冲按 seq 回放。
- 「/ws 断开即 kill」改「保活待重连」(本 v1 靠 web 显式 close + 空闲超时;hub 侧 ws-close→terminal 追踪清理留给 v2,与重连保活一起做)。
- 多 viewer 共享同一 PTY(terminalId 已按 instance 命名空间,天然可扩)。
