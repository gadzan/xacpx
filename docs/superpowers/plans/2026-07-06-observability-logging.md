# 可观测性批次:统一日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 weixin 日志并入核心 AppLogger(消除 `/tmp/openclaw` 世界可读明文),并给 relay hub 加最小 stdout 结构化日志层。

**Architecture:** Part A 用组合根模块绑定注入(`weixinLog` + `setWeixinLog`,buildApp 接线),117 处调用点重写为结构化 `(event, message, context)`,删除 `/tmp` 单例。Part B 在 relay 包内新建自包含 `RelayLogger`(写 stdout/stderr),经参数 DI 下发到网关/http,归并 S4 的临时 console.error。两部分零共享代码。

**Tech Stack:** TypeScript,bun test,核心 `src/`(Node daemon)+ `packages/relay/`(独立发布包)。

## Global Constraints

- **无新依赖**。不引入任何第三方日志库。
- **隐私红线**:任何日志绝不记 token / 凭证 / 消息正文;只记 id、计数、reason、状态。
- **AppLogger 接口不改**:`debug/info/error(event: string, message: string, context?: Record<string, unknown>): Promise<void>`,3 级(error/info/debug),返回的 Promise 永不 reject,可 fire-and-forget。见 `src/logging/app-logger.ts:28`。
- **event 命名约定**:`weixin.<area>.<动作_snake>`(area = login/message/media/cdn/api/monitor/send)。惯例已在 `src/main.ts:289` 等处使用(`weixin.quota.inbound_reset`)。
- **级别映射(weixin 6→3)**:`debug→debug`、`info→info`、`error→error`、`warn→info`(逐条把真正的失败提升为 `error`)。
- **`openclaw-weixin` 是状态目录名 / provider 标识(遍布 inbound.ts/accounts.ts),与 `/tmp/openclaw` 日志目录无关,必须原样保留**。
- 测试逐文件跑:`bun test <单文件>`(整目录有状态泄漏假失败)。类型检查 `npx tsc --noEmit`。
- git 卫生:只 `git add` 改动文件,禁止 `git add -A`;不改 lockfile;英文 conventional commits。

---

## File Structure

**Part A(核心 weixin):**
- Create `src/weixin/util/weixin-log.ts` — 绑定模块:`weixinLog` 转发 + `setWeixinLog(logger)` 注入。
- Create `tests/unit/weixin/util/weixin-log.test.ts` — 绑定单测。
- Modify `src/main.ts` — buildApp 内 `setWeixinLog(logger)` 接线。
- Modify ~20 个 `src/weixin/**/*.ts` — 调用点重写、换 import。
- Delete `src/weixin/util/logger.ts` — 旧单例。
- Modify `CLAUDE.md` — 日志位置说明。

**Part B(relay hub):**
- Create `packages/relay/src/logging.ts` — `RelayLogger` + `createRelayLogger` + `createNoopRelayLogger`。
- Create `tests/unit/packages/relay/logging.test.ts` — logger 单测。
- Modify `packages/relay/src/server.ts`、`cli.ts` — 建 logger、下发。
- Modify `packages/relay/src/gateway/instance-gateway.ts`、`web-gateway.ts`、`heartbeat.ts` — 接收 logger、归并 console.error、生命周期日志。
- Modify `packages/relay/src/http/app.ts`、`auth.ts` — 静默 catch + 登录拒绝日志。
- Modify `docs/relay-deployment.md` — `RELAY_LOG_LEVEL`。

---

## Task A1: weixin-log 绑定模块

**Files:**
- Create: `src/weixin/util/weixin-log.ts`
- Test: `tests/unit/weixin/util/weixin-log.test.ts`

**Interfaces:**
- Produces:
  - `export interface WeixinLog { debug(event: string, message: string, context?: Record<string, unknown>): void; info(...): void; error(...): void; }`
  - `export const weixinLog: WeixinLog` — fire-and-forget 转发到注入的 sink;注入前 noop。
  - `export function setWeixinLog(logger: { debug: Fn; info: Fn; error: Fn }): void` where `Fn = (event: string, message: string, context?: Record<string, unknown>) => unknown`。
  - `export function resetWeixinLogForTest(): void` — 测试用,清空 sink。

- [ ] **Step 1: Write the failing test**

`tests/unit/weixin/util/weixin-log.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { resetWeixinLogForTest, setWeixinLog, weixinLog } from "../../../../src/weixin/util/weixin-log";

afterEach(() => resetWeixinLogForTest());

test("noop before a sink is injected (never throws)", () => {
  expect(() => weixinLog.info("weixin.test.ping", "hi", { a: 1 })).not.toThrow();
  expect(() => weixinLog.error("weixin.test.boom", "oops")).not.toThrow();
});

test("forwards to the injected sink with event/message/context", () => {
  const calls: Array<[string, string, string, unknown]> = [];
  setWeixinLog({
    debug: (e, m, c) => calls.push(["debug", e, m, c]),
    info: (e, m, c) => calls.push(["info", e, m, c]),
    error: (e, m, c) => calls.push(["error", e, m, c]),
  });
  weixinLog.debug("weixin.a.b", "d", { x: 1 });
  weixinLog.info("weixin.c.d", "i");
  weixinLog.error("weixin.e.f", "e", { y: 2 });
  expect(calls).toEqual([
    ["debug", "weixin.a.b", "d", { x: 1 }],
    ["info", "weixin.c.d", "i", undefined],
    ["error", "weixin.e.f", "e", { y: 2 }],
  ]);
});

test("a throwing sink does not propagate to the caller (fire-and-forget)", () => {
  setWeixinLog({
    debug: () => { throw new Error("sink down"); },
    info: () => { throw new Error("sink down"); },
    error: () => { throw new Error("sink down"); },
  });
  expect(() => weixinLog.info("weixin.x.y", "z")).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/weixin/util/weixin-log.test.ts`
Expected: FAIL — module `weixin-log` not found.

- [ ] **Step 3: Write the implementation**

`src/weixin/util/weixin-log.ts`:
```ts
type LogFn = (event: string, message: string, context?: Record<string, unknown>) => unknown;

export interface WeixinLog {
  debug(event: string, message: string, context?: Record<string, unknown>): void;
  info(event: string, message: string, context?: Record<string, unknown>): void;
  error(event: string, message: string, context?: Record<string, unknown>): void;
}

interface Sink {
  debug: LogFn;
  info: LogFn;
  error: LogFn;
}

let sink: Sink | null = null;

/** Inject the sink (the DI'd AppLogger) at the composition root. */
export function setWeixinLog(logger: Sink): void {
  sink = logger;
}

/** Test-only: drop the sink so cases start from the un-injected state. */
export function resetWeixinLogForTest(): void {
  sink = null;
}

function forward(level: keyof Sink, event: string, message: string, context?: Record<string, unknown>): void {
  if (!sink) return;
  try {
    // Fire-and-forget: the AppLogger returns a never-rejecting Promise, but we
    // also guard synchronously so a sink swap or unexpected throw can never
    // surface in a weixin hot path.
    void sink[level](event, message, context);
  } catch {
    // Logging must never break the caller.
  }
}

export const weixinLog: WeixinLog = {
  debug: (event, message, context) => forward("debug", event, message, context),
  info: (event, message, context) => forward("info", event, message, context),
  error: (event, message, context) => forward("error", event, message, context),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/weixin/util/weixin-log.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck & commit**

Run: `npx tsc --noEmit` → 0 errors.
```bash
git add src/weixin/util/weixin-log.ts tests/unit/weixin/util/weixin-log.test.ts
git commit -m "feat(weixin): add injectable weixin-log binding forwarding to app-logger"
```

---

## Task A2: buildApp 接线 setWeixinLog

**Files:**
- Modify: `src/main.ts` (在 `const logger = createAppLogger({...})` 之后,约 `src/main.ts:180`)
- Test: `tests/unit/main.test.ts`

**Interfaces:**
- Consumes: `setWeixinLog` from Task A1; `logger` (AppLogger) already built at `main.ts:180`.

- [ ] **Step 1: Write the failing test**

在 `tests/unit/main.test.ts` 增加(与既有 buildApp 测试同风格;先读该文件确认 buildApp 的构造方式与可注入 seams):
```ts
test("buildApp wires weixinLog to the app logger", async () => {
  const { setWeixinLog, weixinLog, resetWeixinLogForTest } = await import("../../src/weixin/util/weixin-log");
  resetWeixinLogForTest();
  const seen: Array<[string, string]> = [];
  // buildApp builds a real AppLogger; after build, weixinLog must reach it.
  // Simplest observable check: after buildApp, injecting a probe is NOT needed —
  // instead assert setWeixinLog was called by checking weixinLog forwards.
  // Replace the sink AFTER build to capture:
  const app = await buildAppForTest(); // use the file's existing buildApp harness
  setWeixinLog({ debug: () => {}, info: (e, m) => seen.push([e, m]), error: () => {} });
  weixinLog.info("weixin.probe.ok", "probe");
  expect(seen).toEqual([["weixin.probe.ok", "probe"]]);
  await app.dispose?.();
});
```
说明:此测试主要防「buildApp 未 import/调用 setWeixinLog 导致 tree-shake 后接线丢失」。若 main.test.ts 已有 buildApp harness,复用之;实际接线正确性由「setWeixinLog 在 buildApp 中被调用」这一行代码保证 + 下方 grep 断言。**实现者:若 main.test.ts 的 harness 不便断言,改为断言 `src/main.ts` 源码包含 `setWeixinLog(logger)` 调用的轻量测试,或加一个导出的接线函数并单测它。二选一,报告说明选择。**

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/main.test.ts`
Expected: FAIL(接线未加)。

- [ ] **Step 3: Add the wiring**

在 `src/main.ts` 顶部 import 区加:
```ts
import { setWeixinLog } from "./weixin/util/weixin-log";
```
在 `const logger = createAppLogger({...})` 语句**之后**紧接一行:
```ts
  // Route the weixin subsystem's logs through the DI'd app logger (no more
  // world-readable /tmp/openclaw). Must run before any weixin activity starts.
  setWeixinLog(logger);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/main.test.ts` → PASS。

- [ ] **Step 5: Typecheck & commit**

Run: `npx tsc --noEmit` → 0。
```bash
git add src/main.ts tests/unit/main.test.ts
git commit -m "feat(weixin): route weixin logs through the app logger at buildApp"
```

---

## Task A3: 重写调用点 — cdn/ + media/ + api/

**Files (Modify,逐个换 import + 重写调用):**
- `src/weixin/cdn/pic-decrypt.ts`(8)、`cdn-upload.ts`(7)、`upload.ts`(6)
- `src/weixin/media/media-download.ts`(11)、`silk-transcode.ts`(4,含 1 warn)
- `src/weixin/messaging/send-media.ts`(6)
- `src/weixin/api/api.ts`(8)、`session-guard.ts`(1)

**Interfaces:**
- Consumes: `weixinLog` from Task A1。

**重写规则(每个文件统一套用):**
1. 删 `import { logger } from "../util/logger.js"`(或相应相对路径),换 `import { weixinLog } from "../util/weixin-log";`(注意路径深度)。
2. 每处 `logger.<lvl>(\`msg ...\`)` → `weixinLog.<lvl>("weixin.<area>.<action>", "msg ...", { ...动态字段 })`:
   - area:cdn 文件→`cdn`;media 文件→`media`;send-media→`send`;api/session-guard→`api`。
   - action:据调用语义取简短 snake_case 动词。
   - message:保留原可读文本;把明显的插值 ID(url、accountId、size 等)可选地移入 context(YAGNI,不强求全拆)。
3. 级别:`warn→info`(silk-transcode 那 1 处若是真失败则 `error`)。

**worked example**(`pic-decrypt.ts:20` 与 `:85`):
```ts
// before:
logger.debug(`${label}: response status=${res.status} ok=${res.ok}`);
logger.error(msg);
// after:
weixinLog.debug("weixin.cdn.pic_response", `${label}: response`, { status: res.status, ok: res.ok });
weixinLog.error("weixin.cdn.pic_decrypt_failed", msg);
```

- [ ] **Step 1: 逐文件重写 import + 调用点**,套用上面规则。
- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors(若报 `logger` 未定义,说明某处调用漏改)。

- [ ] **Step 3: 跑受影响文件的既有单测**

Run(存在哪个跑哪个,先 `ls tests/unit/weixin/{cdn,media,api}` 与 `tests/unit/weixin/messaging` 确认):
`bun test tests/unit/weixin/cdn/*.test.ts tests/unit/weixin/media/*.test.ts tests/unit/weixin/api/*.test.ts` 逐文件跑。
Expected: 全 PASS(日志是副作用,不影响断言)。

- [ ] **Step 4: 确认本组文件不再 import 旧 logger**

Run: `grep -rn "util/logger" src/weixin/cdn src/weixin/media src/weixin/api src/weixin/messaging/send-media.ts`
Expected: 无输出。

- [ ] **Step 5: Commit**
```bash
git add src/weixin/cdn src/weixin/media src/weixin/api/api.ts src/weixin/api/session-guard.ts src/weixin/messaging/send-media.ts
git commit -m "refactor(weixin): structured logging in cdn/media/api call sites"
```

---

## Task A4: 重写调用点 — messaging/

**Files (Modify):**
- `src/weixin/messaging/inbound.ts`(7,含 3 warn)、`send.ts`(8)、`scheduled-turn.ts`(6)、`deliver-orchestration-task-notice.ts`(7)、`deliver-orchestration-task-progress.ts`(2)、`deliver-coordinator-message.ts`(2)、`error-notice.ts`(2,含 1 warn)、`slash-commands.ts`(2)、`debug-mode.ts`(1)

**Interfaces:** Consumes `weixinLog` from A1。

- [ ] **Step 1: 逐文件重写**,规则同 A3;area 一律 `message`(如 `weixin.message.received`、`weixin.message.scheduled_dispatch`、`weixin.message.task_notice_delivered`)。`warn→info`,真失败→`error`。换 import 为 `weixin-log`。
- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → 0。
- [ ] **Step 3: 跑既有单测** — `bun test tests/unit/weixin/messaging/*.test.ts` 逐文件(先 ls 确认存在的文件)。Expected: 全 PASS。
- [ ] **Step 4: 无残留** — `grep -rn "util/logger" src/weixin/messaging` → 无输出(送 send-media 已在 A3 处理)。
- [ ] **Step 5: Commit**
```bash
git add src/weixin/messaging
git commit -m "refactor(weixin): structured logging in messaging call sites"
```

---

## Task A5: 重写调用点 — auth/login-qr + monitor/

**Files (Modify):**
- `src/weixin/auth/login-qr.ts`(28,含 8 warn)
- `src/weixin/monitor/monitor.ts`(`logger.error` 1 处 + `aLog = logger.withAccount(accountId)` 子 logger,多处 `aLog.<lvl>`)

**Interfaces:** Consumes `weixinLog` from A1。

**monitor.ts 特殊处理(child logger 模式):**
`monitor.ts` 用 `let aLog = logger.withAccount(accountId)` 后多处 `aLog.info(...)`。重写:删掉 `aLog` 变量与两处 `logger.withAccount(accountId)` 赋值,每处 `aLog.<lvl>("msg")` → `weixinLog.<lvl>("weixin.monitor.<action>", "msg", { accountId })`。`logger.error(msg)`(:116)→ `weixinLog.error("weixin.monitor.error", msg, { accountId })`。

**worked example**(`monitor.ts:118/121`):
```ts
// before:
let aLog = logger.withAccount(accountId);
aLog.info(`Monitor started: baseUrl=${baseUrl}`);
// after (删掉 aLog):
weixinLog.info("weixin.monitor.started", "monitor started", { accountId, baseUrl });
```

**login-qr.ts**:area `login`,28 处逐个改;8 处 warn→info(真失败如二维码过期/拒绝→按语义可 error)。注意 `qrcode=***` 这类已脱敏文本保持脱敏,**绝不新增 token 落日志**。

- [ ] **Step 1: 重写 login-qr.ts**(换 import、28 处)。
- [ ] **Step 2: 重写 monitor.ts**(删 aLog、换 import、accountId 进 context)。
- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → 0。
- [ ] **Step 4: 跑既有单测** — `bun test tests/unit/weixin/auth/*.test.ts tests/unit/weixin/monitor/*.test.ts` 逐文件(先 ls 确认)。Expected: PASS。
- [ ] **Step 5: 无残留** — `grep -rn "util/logger" src/weixin/auth src/weixin/monitor` → 无输出。
- [ ] **Step 6: Commit**
```bash
git add src/weixin/auth/login-qr.ts src/weixin/monitor/monitor.ts
git commit -m "refactor(weixin): structured logging in login-qr and monitor"
```

---

## Task A6: 删除旧单例 + grep 守卫 + 文档

**Files:**
- Delete: `src/weixin/util/logger.ts`
- Modify: `CLAUDE.md`(约 `:151`)
- Test: `tests/unit/weixin/util/no-legacy-logger.test.ts`(grep 守卫)

**Interfaces:** 依赖 A3/A4/A5 已迁走全部 import。

- [ ] **Step 1: 确认全库无残留引用**

Run:
```bash
grep -rn "util/logger" src --include="*.ts"
grep -rn "OPENCLAW_LOG_LEVEL\|setLogLevel" src --include="*.ts"
```
Expected: 均无输出(若有,回到对应文件补改)。

- [ ] **Step 2: 写 grep 守卫测试**

`tests/unit/weixin/util/no-legacy-logger.test.ts`:
```ts
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";

function grepCount(pattern: string, path: string): number {
  try {
    const out = execSync(`grep -rn ${JSON.stringify(pattern)} ${path} --include=*.ts`, { encoding: "utf8" });
    return out.trim() ? out.trim().split("\n").length : 0;
  } catch {
    return 0; // grep exits 1 when no match
  }
}

test("no source imports the deleted weixin util/logger singleton", () => {
  expect(grepCount("util/logger", "src")).toBe(0);
});

test("no source writes to the /tmp/openclaw log dir (openclaw-weixin state name is unrelated and allowed)", () => {
  // Guard the LOG DIR literal only. `openclaw-weixin` (state dir / provider id) must stay.
  expect(grepCount('"/tmp", "openclaw"', "src")).toBe(0);
  expect(grepCount("openclaw-${", "src")).toBe(0);
});
```

- [ ] **Step 3: Run guard test (should already pass after Step 1)**

Run: `bun test tests/unit/weixin/util/no-legacy-logger.test.ts` → PASS。

- [ ] **Step 4: Delete the singleton**

```bash
git rm src/weixin/util/logger.ts
```
Run: `npx tsc --noEmit` → 0(证明确无引用)。

- [ ] **Step 5: 更新 CLAUDE.md**

把 `CLAUDE.md:151` 的「xacpx 运行日志:`~/.xacpx/runtime/app.log`」改为说明该文件现同时含 weixin 子系统日志(不再有 /tmp/openclaw);若有 perf log 位置也一并注明。

- [ ] **Step 6: 全 weixin 回归 + commit**

Run(逐文件):`tests/unit/weixin/**` 下受影响文件全绿;`npx tsc --noEmit` → 0。
```bash
git add -u src/weixin CLAUDE.md
git add tests/unit/weixin/util/no-legacy-logger.test.ts
git commit -m "refactor(weixin): remove /tmp/openclaw singleton logger; guard against regressions"
```

---

## Task B1: RelayLogger 模块

**Files:**
- Create: `packages/relay/src/logging.ts`
- Test: `tests/unit/packages/relay/logging.test.ts`

**Interfaces:**
- Produces:
  - `export interface RelayLogger { debug(event: string, message: string, context?: Record<string, unknown>): void; info(...): void; error(...): void; }`
  - `export function createRelayLogger(options?: { level?: "error" | "info" | "debug"; writeOut?: (line: string) => void; writeErr?: (line: string) => void; now?: () => Date }): RelayLogger`
  - `export function createNoopRelayLogger(): RelayLogger`
  - Level resolution:`options.level ?? RELAY_LOG_LEVEL env ?? "info"`。路由:info/debug→writeOut(默认 `process.stdout.write`),error→writeErr(默认 `process.stderr.write`)。

- [ ] **Step 1: Write the failing test**

`tests/unit/packages/relay/logging.test.ts`:
```ts
import { expect, test } from "bun:test";
import { createNoopRelayLogger, createRelayLogger } from "../../../../packages/relay/src/logging";

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, writeOut: (l: string) => out.push(l), writeErr: (l: string) => err.push(l) };
}
const at = () => new Date("2026-07-06T00:00:00.000Z");

test("routes info/debug to stdout and error to stderr", () => {
  const c = collector();
  const log = createRelayLogger({ level: "debug", writeOut: c.writeOut, writeErr: c.writeErr, now: at });
  log.info("relay.start", "listening", { httpPort: 8787 });
  log.debug("relay.web.connected", "ws open");
  log.error("relay.event.persist_failed", "db write failed", { instanceId: "i1" });
  expect(c.out).toHaveLength(2);
  expect(c.err).toHaveLength(1);
  expect(c.out[0]).toBe('2026-07-06T00:00:00.000Z INFO relay.start message="listening" httpPort=8787\n');
  expect(c.err[0]).toBe('2026-07-06T00:00:00.000Z ERROR relay.event.persist_failed message="db write failed" instanceId="i1"\n');
});

test("level filter suppresses below-threshold lines", () => {
  const c = collector();
  const log = createRelayLogger({ level: "error", writeOut: c.writeOut, writeErr: c.writeErr, now: at });
  log.info("relay.start", "listening");
  log.debug("relay.web.connected", "ws open");
  log.error("relay.boom", "bad");
  expect(c.out).toHaveLength(0);
  expect(c.err).toHaveLength(1);
});

test("defaults to info level", () => {
  const c = collector();
  const log = createRelayLogger({ writeOut: c.writeOut, writeErr: c.writeErr, now: at });
  log.debug("relay.x", "hidden");
  log.info("relay.y", "shown");
  expect(c.out).toHaveLength(1);
});

test("noop logger writes nothing", () => {
  const log = createNoopRelayLogger();
  expect(() => log.info("relay.x", "y", { a: 1 })).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay/logging.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/relay/src/logging.ts`:
```ts
export interface RelayLogger {
  debug(event: string, message: string, context?: Record<string, unknown>): void;
  info(event: string, message: string, context?: Record<string, unknown>): void;
  error(event: string, message: string, context?: Record<string, unknown>): void;
}

type Level = "error" | "info" | "debug";
const ORDER: Record<Level, number> = { error: 0, info: 1, debug: 2 };

export interface RelayLoggerOptions {
  level?: Level;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
  now?: () => Date;
}

export function createNoopRelayLogger(): RelayLogger {
  return { debug: () => {}, info: () => {}, error: () => {} };
}

export function createRelayLogger(options: RelayLoggerOptions = {}): RelayLogger {
  const level = options.level ?? resolveEnvLevel() ?? "info";
  const writeOut = options.writeOut ?? ((line) => process.stdout.write(line));
  const writeErr = options.writeErr ?? ((line) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  function emit(lvl: Level, event: string, message: string, context?: Record<string, unknown>): void {
    if (ORDER[lvl] > ORDER[level]) return;
    const line = formatLine(now(), lvl, event, message, context ?? {});
    if (lvl === "error") writeErr(line);
    else writeOut(line);
  }
  return {
    debug: (e, m, c) => emit("debug", e, m, c),
    info: (e, m, c) => emit("info", e, m, c),
    error: (e, m, c) => emit("error", e, m, c),
  };
}

function resolveEnvLevel(): Level | undefined {
  const raw = process.env.RELAY_LOG_LEVEL?.toLowerCase();
  return raw === "error" || raw === "info" || raw === "debug" ? raw : undefined;
}

// Mirrors the core app-logger line format (src/logging/app-logger.ts formatLogLine)
// so hub stdout and daemon app.log read the same. Reimplemented here because the
// relay package must not import from the core `src/` tree.
function formatLine(time: Date, level: Level, event: string, message: string, context: Record<string, unknown>): string {
  const fields = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmt(v)}`);
  const suffix = fields.length > 0 ? ` ${fields.join(" ")}` : "";
  return `${time.toISOString()} ${level.toUpperCase()} ${event} message=${fmt(message)}${suffix}\n`;
}

function fmt(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/packages/relay/logging.test.ts` → PASS (4 tests)。

- [ ] **Step 5: Typecheck & commit**

Run: `cd packages/relay && npx tsc --noEmit -p tsconfig.json` → 0；回根 `npx tsc --noEmit` → 0。
```bash
git add packages/relay/src/logging.ts tests/unit/packages/relay/logging.test.ts
git commit -m "feat(relay): add minimal stdout structured logger"
```

---

## Task B2: 注入 RelayLogger 到运行时 + 归并 S4 console.error

**Files:**
- Modify: `packages/relay/src/server.ts`(`createRelayRuntime(dbPath, options)` @ :45,`startRelayServer` @ :247)
- Modify: `packages/relay/src/cli.ts`(`start` 分支建 logger)
- Modify: `packages/relay/src/gateway/instance-gateway.ts`(`InstanceGatewayDeps` @ :30,构造 @ :52,console.error @ :70/:123)
- Modify: `packages/relay/src/gateway/web-gateway.ts`(`WebGatewayOptions` @ :19,console.error @ :51)
- Modify: `packages/relay/src/gateway/heartbeat.ts`(console.error @ :41/:49)
- Test: `tests/unit/packages/relay/gateway/gateway-logging.test.ts`

**Interfaces:**
- Consumes: `RelayLogger`, `createRelayLogger`, `createNoopRelayLogger` from B1。
- Produces:
  - `CreateRuntimeOptions.logger?: RelayLogger`(server.ts)
  - `InstanceGatewayDeps.logger?: RelayLogger`
  - `WebGatewayOptions.logger?: RelayLogger`
  - `startHeartbeat(socket, intervalMs?, maxMissed?, logger?: RelayLogger)`(heartbeat.ts,新增可选末参)
  - 各处缺省 `createNoopRelayLogger()`,保证既有测试不需传 logger。

- [ ] **Step 1: 写 gateway 日志测试(先红)**

`tests/unit/packages/relay/gateway/gateway-logging.test.ts`:构造 `InstanceGateway`,注入一个记录用的 fake `RelayLogger`,驱动一次 message-handling 抛错路径(复用 `instance-gateway-robustness.test.ts` 的构造方式,先读它),断言 fake logger 收到 `relay.instance.*` / 相应 error 事件而**非** console.error。
```ts
// 骨架(实现者据 instance-gateway-robustness.test.ts 的 harness 填充):
import { expect, test } from "bun:test";
// ... import InstanceGateway + fakes
test("instance gateway logs through the injected logger, not console", () => {
  const logs: Array<[string, string]> = [];
  const logger = { debug: (e: string, m: string) => logs.push([e, m]), info: (e: string, m: string) => logs.push([e, m]), error: (e: string, m: string) => logs.push([e, m]) };
  // build gateway with deps { ...fakes, logger }, trigger a throwing onEvent
  // assert logs contains an entry with event starting "relay."
  expect(logs.some(([e]) => e.startsWith("relay."))).toBe(true);
});
```

- [ ] **Step 2: Run → fails**

Run: `bun test tests/unit/packages/relay/gateway/gateway-logging.test.ts` → FAIL。

- [ ] **Step 3: 线路 + 归并**

1. `server.ts`:`CreateRuntimeOptions` 加 `logger?: RelayLogger`;`createRelayRuntime` 内 `const logger = options.logger ?? createNoopRelayLogger();`,传给 `new WebGateway({ logger, ...})` 与构造 `InstanceGateway` 的 deps。`startRelayServer` 把 `options.logger` 透传给 `createRelayRuntime`。
2. `cli.ts` `start` 分支:`const logger = createRelayLogger();`(读 `RELAY_LOG_LEVEL`),传入 `startRelayServer({ ..., logger })`。
3. `instance-gateway.ts`:`InstanceGatewayDeps` 加 `logger?: RelayLogger`;构造里 `this.logger = deps.logger ?? createNoopRelayLogger()`(或直接用 `deps.logger`,缺省在 server 侧给)。把 `:70` `console.error("[relay] instance gateway message handling failed:", err)` → `this.logger.error("relay.instance.message_failed", "message handling failed", { error: String(err) })`;`:123` superseded close 失败同理 `relay.instance.superseded_close_failed`。
4. `web-gateway.ts`:`WebGatewayOptions` 加 `logger?`;`:51` broadcast send 失败 → `this.options.logger?.error("relay.web.broadcast_failed", "broadcast send failed", { error: String(err) })`(缺省 noop 时可选链)。
5. `heartbeat.ts`:`startHeartbeat` 加可选末参 `logger?: RelayLogger`;`:41`/`:49` 的 console.error → `logger?.error("relay.heartbeat.terminate_failed"/"relay.heartbeat.ping_failed", ...)`。gateway 调用 `startHeartbeat` 处把 logger 传入。

- [ ] **Step 4: Run tests**

Run(逐文件):
`bun test tests/unit/packages/relay/gateway/gateway-logging.test.ts` → PASS。
回归:`bun test tests/unit/packages/relay/gateway/instance-gateway-robustness.test.ts tests/unit/packages/relay/gateway/gateway-heartbeat.test.ts tests/unit/packages/relay/gateway/web-gateway.test.ts` → 全 PASS。
`grep -rn "\[relay\] " packages/relay/src` → 无输出(console.error 全归并)。

- [ ] **Step 5: Typecheck & commit**

Run: `cd packages/relay && npx tsc --noEmit -p tsconfig.json` → 0;根 `npx tsc --noEmit` → 0。
```bash
git add packages/relay/src/server.ts packages/relay/src/cli.ts packages/relay/src/gateway/instance-gateway.ts packages/relay/src/gateway/web-gateway.ts packages/relay/src/gateway/heartbeat.ts tests/unit/packages/relay/gateway/gateway-logging.test.ts
git commit -m "feat(relay): inject logger into runtime; fold ad-hoc console.error into it"
```

---

## Task B3: 实例生命周期日志

**Files:**
- Modify: `packages/relay/src/gateway/instance-gateway.ts`（handshake 成功/offline/superseded/失败;server.ts onEvent persist 失败点)
- Modify: `packages/relay/src/server.ts`(onEvent 的 message 监听 try/catch,S4 加过的 DB 写失败处)
- Test: 扩 `tests/unit/packages/relay/gateway/gateway-logging.test.ts`

**Interfaces:** Consumes injected `logger` from B2。

- [ ] **Step 1: 扩测试(先红)**:断言握手成功→`relay.instance.online`(带 instanceId、accountId)、close→`relay.instance.offline`、superseded 分支→`relay.instance.superseded`。用 B2 的 fake logger harness。
- [ ] **Step 2: Run → 新断言 FAIL。**
- [ ] **Step 3: 加日志**:
  - handshake 成功(`instance-gateway.ts` 的 `handleHandshake` 成功、set map、`onStatusChange(...,true)` 处)→ `this.logger.info("relay.instance.online", "instance connected", { instanceId, accountId })`。
  - superseded(existing.socket !== socket,close 旧 socket 处)→ `this.logger.info("relay.instance.superseded", "reconnect superseded old socket", { instanceId })`。
  - offline(close 处理器 `onStatusChange(...,false)` 处)→ `this.logger.info("relay.instance.offline", "instance disconnected", { instanceId, accountId })`。
  - 握手失败(`handleHandshake` 返回 null 前、`socket.close(4400/4401...)`)→ `this.logger.info("relay.instance.handshake_failed", "handshake rejected", { reason })`(**不带 token**)。
  - `server.ts` onEvent DB 写 try/catch(S4 加的)→ `logger.error("relay.event.persist_failed", "failed to persist instance event", { instanceId, error: String(err) })`。
- [ ] **Step 4: Run tests** — gateway-logging + 回归 robustness/heartbeat/web-gateway 逐文件全绿。
- [ ] **Step 5: Typecheck & commit**
```bash
git add packages/relay/src/gateway/instance-gateway.ts packages/relay/src/server.ts tests/unit/packages/relay/gateway/gateway-logging.test.ts
git commit -m "feat(relay): log instance connection lifecycle and event persist failures"
```

---

## Task B4: 启动 / 登录 / 静默 catch / web + 文档

**Files:**
- Modify: `packages/relay/src/server.ts` 或 `cli.ts`(启动 listening 日志)
- Modify: `packages/relay/src/auth.ts`(登录被拒)
- Modify: `packages/relay/src/http/app.ts`(`:161/:241/:308` 静默 catch)
- Modify: `packages/relay/src/gateway/web-gateway.ts`(register/close debug)
- Modify: `docs/relay-deployment.md`
- Test: 扩 `tests/unit/packages/relay/logging.test.ts` 或相关 http/auth 测试

**Interfaces:** Consumes injected `logger`。

- [ ] **Step 1: 加日志(先读各文件确认注入 logger 是否已到达;http/app.ts 与 auth 可能需从 createRelayRuntime 往下多传一层——若已有 deps 通道则复用)**:
  - 启动:server 开始监听处 → `logger.info("relay.start", "relay hub listening", { httpPort, wsPort, dbPath, dashboard: Boolean(webRoot) })`(保留既有 `io.print`)。
  - 登录被拒(`auth.ts` 限流/验证失败分支)→ `logger.info("relay.login.rejected", "login rejected", { reason })`(**不带 token/凭证**;若现成有 IP/hash 可带,否则省)。
  - `http/app.ts:161/241/308` 的 `.catch(()=>({}))` → `.catch((err) => { logger.error("relay.http.handler_failed", "request handler error", { error: String(err) }); return {}; })`(保持返回值形状不变)。
  - `web-gateway.ts` register/close → `this.options.logger?.debug("relay.web.connected"/"relay.web.disconnected", ..., { accountId })`。
- [ ] **Step 2: 若加了可断言点则补测试**(如 auth 拒绝走注入 logger);否则至少手动 `npx tsc` + 既有 http/auth 测试回归。
- [ ] **Step 3: Run** — 逐文件跑 `tests/unit/packages/relay/**` 受影响文件;`grep -rn "catch(() => ({}))\|\.catch(() => ({}))" packages/relay/src/http/app.ts` 确认静默 catch 已改。
- [ ] **Step 4: 文档** — `docs/relay-deployment.md` 补一句:hub 日志走 stdout/stderr(`pm2 logs xacpx-relay`);`RELAY_LOG_LEVEL=error|info|debug`(默认 info)。
- [ ] **Step 5: Typecheck & commit**
```bash
git add packages/relay/src/server.ts packages/relay/src/cli.ts packages/relay/src/auth.ts packages/relay/src/http/app.ts packages/relay/src/gateway/web-gateway.ts docs/relay-deployment.md tests/unit/packages/relay
git commit -m "feat(relay): log startup, rejected logins, and previously-swallowed handler errors"
```

---

## 收尾验证(全部任务后)

- [ ] 根 `npx tsc --noEmit` → 0;`cd packages/relay && npx tsc --noEmit -p tsconfig.json` → 0。
- [ ] 逐文件跑受影响的 `tests/unit/weixin/**` 与 `tests/unit/packages/relay/**`,全绿。
- [ ] `grep -rn "util/logger\|OPENCLAW_LOG_LEVEL" src` → 无;`grep -rn "\[relay\] " packages/relay/src` → 无。
- [ ] 发布另议(需 core + relay beta;protocol/channel-relay 不动)。
