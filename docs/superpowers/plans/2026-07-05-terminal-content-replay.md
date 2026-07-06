# 终端内容 replay(第 3 层)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web 刷新后恢复终端 scrollback 并接回同一 live shell(不再新开空 shell)。

**Architecture:** 后端给每个 PTY 加 256KB 输出 ring buffer;新增点对点 RPC `control.terminal.attach` 返回 `{buffer,lastSeq}`;前端持久化 terminalId,刷新挂载时先 attach(灌 buffer + 订阅 live + 按 lastSeq 去重),attach 不到才回落"启动新终端"占位;杀 PTY 从"刷新卸载"移到"显式关闭"。四包:relay-protocol / core / channel-relay / relay-web。

**Tech Stack:** TypeScript;bun:test(core/connector 单测)、Vitest(relay-web,jsdom)、node-pty、ghostty-web。

## Global Constraints

- 四包改动:relay-protocol(RPC 名+类型)、core `src/control`(ring buffer + attach + 门面)、channel-relay(转发 case)、relay-web(持久化 + attach 流 + 生命周期)。**hub 预期零改动**(attach 走 create 同款 RPC 转发路径)。
- ring buffer 上限 **256KB/终端**,超限从**最旧 `\n` 行边界**裁剪(避免切断 ANSI 转义序列);单行超限退化按字节硬裁。
- `attach` 返回 `TerminalAttachResult = { ok: false } | { ok: true; buffer: string; lastSeq: number }`;`lastSeq = seq - 1`(seq 是"下一个要发"计数;从未 emit 时为 -1)。
- `seq` 做去重:attach 快照返回 lastSeq,客户端丢弃 `seq ≤ lastSeq` 的 live 事件;attach handoff 顺序=订阅→排队→attach 返回后灌 buffer→冲 pending(seq>lastSeq)→转直写。
- PTY 死亡时机:**仅显式关闭(close 按钮 / center-tabs 关终端 tab / 剪枝 dead session)+ idle 超时**;刷新卸载**不杀**。
- terminalId 持久化:sessionStorage `xacpx.terminal-ids.v1`,按 `sessionKey`(`instanceId::alias`)。read/write try/catch,写失败静默。
- core 单测:`bun test tests/unit/control/<file>.test.ts`(**单文件,勿整目录**);`npx tsc --noEmit` 0 报错。
- relay-web 测试:`cd packages/relay-web && npx vitest run <file>`(**绝不 bun test**);`npx vue-tsc --noEmit` 0 报错。shell cwd 在 `cd 仓库根 && git…` 后漂回根,跑前先重新 `cd packages/relay-web`。
- relay-protocol 用 **tsc** 构建 dist(`export *` 桶被 bun tree-shake 成空);改协议后重建 dist + `assert:relay-protocol` 验运行时导出非空。
- 连接器(channel-relay)改动上真机要重打包 + 重装插件目录 + 重启 console(沙箱旧 tarball 坑)——本计划只保证单测;端到端在发布阶段验。
- 不改 output 广播路由、不改 input/resize/close 通道、不改 idle 策略。

---

### Task 1: 协议 — `terminalAttach` RPC + 类型

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts:48-51`(加 `terminalAttach`)
- Modify: `packages/relay-protocol/src/dtos.ts`(加 `TerminalAttachRequest` / `TerminalAttachResult` + 导出)
- Test: `packages/relay-protocol` 的既有断言脚本 `assert:relay-protocol`(验运行时导出)

**Interfaces:**
- Produces:
  - `MSG.terminalAttach = "control.terminal.attach"`
  - `TerminalAttachRequest = { terminalId: string }`
  - `TerminalAttachResult = { ok: false } | { ok: true; buffer: string; lastSeq: number }`

- [ ] **Step 1: 加 MSG 名**

`packages/relay-protocol/src/messages.ts`,在 `terminalClose` 后加:

```ts
  terminalCreate: "control.terminal.create",
  terminalAttach: "control.terminal.attach",
  terminalInput: "instance.terminal.input",
  terminalResize: "instance.terminal.resize",
  terminalClose: "instance.terminal.close",
```

- [ ] **Step 2: 加类型 + 导出**

`packages/relay-protocol/src/dtos.ts`,在终端相关 DTO(`terminal-output`/`terminal-exit` 联合,约 :216-217)附近加导出类型:

```ts
export interface TerminalAttachRequest {
  terminalId: string;
}
export type TerminalAttachResult =
  | { ok: false }
  | { ok: true; buffer: string; lastSeq: number };
```

确认这些类型经桶文件 `packages/relay-protocol/src/index.ts` 导出(dtos 若已 `export *` 则自动;否则补 `export type`)。

- [ ] **Step 3: 重建 dist + 断言运行时导出**

Run:
```bash
cd /Users/maijiazhen/Projects/workspace-a
bun run build:relay-protocol 2>/dev/null || npx tsc -p packages/relay-protocol/tsconfig.json
node -e "const m=require('./packages/relay-protocol/dist/index.js'); if(!m.MSG||m.MSG.terminalAttach!=='control.terminal.attach'){console.error('FATAL: terminalAttach missing from dist');process.exit(1)} console.log('MSG.terminalAttach OK:', m.MSG.terminalAttach)"
```
Expected: `MSG.terminalAttach OK: control.terminal.attach`(证明桶未被 tree-shake 成空、新 MSG 在 dist)。类型是 erased 的(编译期),运行时只验 MSG 值。

- [ ] **Step 4: 类型检查 + 提交**

```bash
cd /Users/maijiazhen/Projects/workspace-a
npx tsc --noEmit
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/src/dtos.ts packages/relay-protocol/dist
git commit -m "feat(protocol): terminalAttach RPC name + TerminalAttachRequest/Result types"
```

> 注:若 dist 是 gitignored(检查 `git check-ignore packages/relay-protocol/dist`),则不 add dist,只 add src;发布阶段会重建。以 `git status` 实际可见为准。

---

### Task 2: core — ring buffer + `attach` + control 门面

**Files:**
- Modify: `src/control/terminal-service.ts`(Session 加 buffer、onData 累积+裁剪、`attach`、interface)
- Modify: `src/control/control-service.ts:879-897`(加 `attachTerminal`)
- Test: `tests/unit/control/terminal-service.test.ts`

**Interfaces:**
- Consumes:无(core 结构上独立于 relay-protocol;结构匹配 Task 1 的 `TerminalAttachResult`)。
- Produces:
  - `TerminalService.attach(terminalId: string): TerminalAttachResult`,`TerminalAttachResult = { ok: false } | { ok: true; buffer: string; lastSeq: number }`(在 terminal-service.ts 导出)
  - `ControlService.attachTerminal(terminalId: string): TerminalAttachResult`

- [ ] **Step 1: 写失败的测试**

`tests/unit/control/terminal-service.test.ts`,先在 setup 后加一个能读 buffer 的辅助(用既有 `fakePty()` 的 `emitData`),然后追加:

```ts
test("attach returns ok:false for an unknown terminal", () => {
  const { svc } = setup();
  expect(svc.attach("nope")).toEqual({ ok: false });
});

test("attach returns buffered output + lastSeq for a live terminal", () => {
  const { svc, pty } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("hello\n");
  pty.emitData("world\n");
  const res = svc.attach(terminalId);
  expect(res).toEqual({ ok: true, buffer: "hello\nworld\n", lastSeq: 1 }); // seq 0,1 emitted → lastSeq 1
});

test("attach on a terminal with no output yet returns lastSeq -1", () => {
  const { svc } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  expect(svc.attach(terminalId)).toEqual({ ok: true, buffer: "", lastSeq: -1 });
});

test("attach returns ok:false after close", () => {
  const { svc, pty } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("x");
  pty.emitExit(0); // exit deletes the session
  expect(svc.attach(terminalId)).toEqual({ ok: false });
});

test("ring buffer trims oldest whole lines past 256KB (keeps tail, cuts at newline)", () => {
  const { svc, pty } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  // 300 lines of ~1KB each ≈ 300KB > 256KB cap
  for (let i = 0; i < 300; i++) pty.emitData("L" + i + ":" + "x".repeat(1000) + "\n");
  const res = svc.attach(terminalId);
  if (!res.ok) throw new Error("expected ok");
  expect(Buffer.byteLength(res.buffer, "utf8")).toBeLessThanOrEqual(256 * 1024);
  // oldest lines dropped, newest retained; buffer starts at a line boundary (no partial leading line)
  expect(res.buffer.startsWith("L")).toBe(true);
  expect(res.buffer.endsWith("\n")).toBe(true);
  expect(res.buffer).toContain("L299:");
  expect(res.buffer).not.toContain("L0:");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: FAIL — `svc.attach` 未定义。

- [ ] **Step 3: 改 terminal-service.ts — 类型 + Session + buffer helper**

`TerminalService` interface(:38-44)加 `attach`,并在文件内导出结果类型:

```ts
export type TerminalAttachResult =
  | { ok: false }
  | { ok: true; buffer: string; lastSeq: number };

export interface TerminalService {
  create(input: TerminalCreateInput): { terminalId: string };
  attach(terminalId: string): TerminalAttachResult;
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  disposeAll(): void;
}
```

`Session` 接口(现 `{ handle, seq, idleTimer }`)加 buffer 字段:

```ts
interface Session { handle: PtyHandle; seq: number; idleTimer: unknown; buffer: string; bufBytes: number }
```

在文件内(`createTerminalService` 外或内均可)加 buffer 常量 + 追加 helper:

```ts
const MAX_BUFFER_BYTES = 256 * 1024;

function appendToBuffer(session: Session, data: string): void {
  session.buffer += data;
  session.bufBytes += Buffer.byteLength(data, "utf8");
  if (session.bufBytes <= MAX_BUFFER_BYTES) return;
  // Drop oldest WHOLE lines (cut at "\n") to avoid slicing mid-escape-sequence.
  while (session.bufBytes > MAX_BUFFER_BYTES) {
    const nl = session.buffer.indexOf("\n");
    if (nl === -1) break; // single line longer than the cap → hard-cut below
    const removed = session.buffer.slice(0, nl + 1);
    session.buffer = session.buffer.slice(nl + 1);
    session.bufBytes -= Buffer.byteLength(removed, "utf8");
  }
  // Degenerate single huge line: hard-cut leading chars until within cap.
  while (session.bufBytes > MAX_BUFFER_BYTES && session.buffer.length > 0) {
    const ch = session.buffer[0]!;
    session.buffer = session.buffer.slice(1);
    session.bufBytes -= Buffer.byteLength(ch, "utf8");
  }
}
```

- [ ] **Step 4: 改 create()、加 attach()**

`create()` 内:Session 初值加 `buffer: "", bufBytes: 0`;`onData` 回调在 emit **之外**累积:

```ts
      const session: Session = { handle, seq: 0, idleTimer: null, buffer: "", bufBytes: 0 };
      sessions.set(terminalId, session);
      handle.onData((data) => {
        // NOTE: resetIdle is intentionally NOT called here (output ≠ user interaction).
        appendToBuffer(session, data);
        deps.events.emit({ type: "terminal-output", terminalId, seq: session.seq++, data });
      });
```

在 `create` 方法后加 `attach`(在返回的对象里,create 之后、write 之前):

```ts
    attach(terminalId) {
      const s = sessions.get(terminalId);
      if (!s) return { ok: false };
      resetIdle(terminalId); // reattaching counts as activity
      return { ok: true, buffer: s.buffer, lastSeq: s.seq - 1 };
    },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: PASS(新增 5 用例 + 既有全绿)。

- [ ] **Step 6: control-service `attachTerminal`**

`src/control/control-service.ts`,在 `closeTerminal`(:895)附近加(仿纯转发 + gate),并 import 类型:

```ts
  attachTerminal(terminalId: string): import("./terminal-service").TerminalAttachResult {
    if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled");
    return this.deps.terminal.attach(terminalId);
  }
```

（`ControlServiceDeps.terminal` 已是 `TerminalService`,新增的 `attach` 自动可用,无需改 deps 声明。）

- [ ] **Step 7: 类型 + 提交**

Run: `bun test tests/unit/control/terminal-service.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 0。

```bash
git add src/control/terminal-service.ts src/control/control-service.ts tests/unit/control/terminal-service.test.ts
git commit -m "feat(terminal): per-PTY 256KB ring buffer + attach() replay; control.attachTerminal"
```

---

### Task 3: connector — attach RPC 转发 case

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts`(`dispatchControlRequest` switch,`MSG.terminalCreate` case 后加 `MSG.terminalAttach`)
- Test: `tests/unit/packages/channel-relay/control-bridge.test.ts`(RPC 测试家所在;用既有 `makeFakeControl`/`dispatch`/`req` 助手)

**Interfaces:**
- Consumes:`MSG.terminalAttach`(Task 1);`control.attachTerminal(terminalId)`(Task 2)。

> 连接器 RPC 入口是 `createControlBridge(control): ControlBridge`(control-bridge.ts:78);内部 `dispatchControlRequest`(:88)switch 分发。测试用根目录 `tests/unit/packages/channel-relay/control-bridge.test.ts`(bun:test),助手:`req(type,payload)` 造 envelope、`dispatch(bridge, env)` = `new Promise(r => bridge(env, r))` 取响应、`makeFakeControl(overrides)` 造 mock control。`errorPayload` 形如 `{ error: { code, message } }`。

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/packages/channel-relay/control-bridge.test.ts` 末尾追加(复用文件顶部的 `req`/`dispatch`/`makeFakeControl`,`mock` 来自 `bun:test`):

```ts
test("terminal.attach RPC forwards to attachTerminal and returns its result", async () => {
  const { control } = makeFakeControl({ attachTerminal: mock((id: string) => ({ ok: true, buffer: "SCROLL", lastSeq: 3 })) });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.terminalAttach, { terminalId: "t1" }))).toEqual({ ok: true, buffer: "SCROLL", lastSeq: 3 });
  expect((control.attachTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1"]);
});

test("terminal.attach RPC without terminalId returns bad-request", async () => {
  const { control } = makeFakeControl({ attachTerminal: mock(() => ({ ok: false })) });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.terminalAttach, {}))).toEqual({ error: { code: "bad-request", message: "terminalId is required" } });
});
```
（`mock` 需在顶部 import 里:`import { expect, test, mock } from "bun:test";`——若文件顶部只 import 了 `expect, test`,补上 `mock`。）

- [ ] **Step 2: 跑到失败**

Run: `bun test tests/unit/packages/channel-relay/control-bridge.test.ts`
Expected: FAIL — `terminalAttach` case 不存在(落到 unknown-type),或 `control.attachTerminal` 未被调。

- [ ] **Step 3: 加 case**

`packages/channel-relay/src/control-bridge.ts` 的 `dispatchControlRequest` switch,在 `case MSG.terminalCreate:` 块后加:

```ts
    case MSG.terminalAttach: {
      const input = payload as { terminalId?: string };
      if (!input.terminalId) return errorPayload("bad-request", "terminalId is required");
      return control.attachTerminal(input.terminalId);
    }
```

- [ ] **Step 4: 跑到通过 + 类型 + 提交**

Run: `bun test tests/unit/packages/channel-relay/control-bridge.test.ts && npx tsc --noEmit`
Expected: PASS(2 新用例 + 既有全绿)+ tsc 0。

```bash
git add packages/channel-relay/src/control-bridge.ts tests/unit/packages/channel-relay/control-bridge.test.ts
git commit -m "feat(connector): forward control.terminal.attach RPC to attachTerminal"
```

---

### Task 4: relay-web — terminal-sessions lib + store attach + seq 透传

**Files:**
- Create: `packages/relay-web/src/lib/terminal-sessions.ts`
- Modify: `packages/relay-web/src/stores/terminal.ts`(加 `attach`;`applyEvent`/`OutputCb` 带 seq)
- Test: `packages/relay-web/src/__tests__/terminal-sessions.test.ts`(新建)、`terminal-store.test.ts`(扩充)

**Interfaces:**
- Consumes:`TerminalAttachResult`(Task 1,from `@ganglion/xacpx-relay-protocol`)。
- Produces:
  - `terminal-sessions.ts`:`saveTerminalId(sessionKey, id)` / `loadTerminalId(sessionKey): string | null` / `clearTerminalId(sessionKey)`
  - store:`attach(instanceId, terminalId): Promise<TerminalAttachResult>`;`OutputCb = (terminalId: string, data: string, seq: number) => void`

- [ ] **Step 1: 写失败的测试(terminal-sessions)**

Create `packages/relay-web/src/__tests__/terminal-sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveTerminalId, loadTerminalId, clearTerminalId } from "../lib/terminal-sessions";

beforeEach(() => sessionStorage.clear());

describe("terminal-sessions", () => {
  it("save then load round-trips the id", () => {
    saveTerminalId("i1::s1", "term-abc");
    expect(loadTerminalId("i1::s1")).toBe("term-abc");
  });
  it("returns null when absent", () => {
    expect(loadTerminalId("i1::none")).toBeNull();
  });
  it("clear removes the id", () => {
    saveTerminalId("i1::s1", "t");
    clearTerminalId("i1::s1");
    expect(loadTerminalId("i1::s1")).toBeNull();
  });
  it("tolerates corrupt storage", () => {
    sessionStorage.setItem("xacpx.terminal-ids.v1", "{bad");
    expect(loadTerminalId("i1::s1")).toBeNull();
  });
  it("swallows setItem quota errors", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("q", "QuotaExceededError"); });
    expect(() => saveTerminalId("i1::s1", "t")).not.toThrow();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑到失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-sessions.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 terminal-sessions.ts**

Create `packages/relay-web/src/lib/terminal-sessions.ts`(仿 file-drafts):

```ts
/** Per-session terminal-id persistence. A live PTY survives a browser reload (the backend keeps
 *  it until idle-timeout); persisting its terminalId lets the reloaded tab re-attach (replay
 *  scrollback + reconnect) instead of spawning a fresh shell. sessionStorage (tab-scoped) keyed
 *  by `${instanceId}::${alias}`. */
const KEY = "xacpx.terminal-ids.v1";
type Ids = Record<string, string>;

function read(): Ids {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Ids) : {};
  } catch {
    return {};
  }
}
function write(ids: Ids): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage full / disabled — best-effort */
  }
}

export function saveTerminalId(sessionKey: string, id: string): void {
  if (!sessionKey || !id) return;
  const ids = read();
  ids[sessionKey] = id;
  write(ids);
}
export function loadTerminalId(sessionKey: string): string | null {
  if (!sessionKey) return null;
  return read()[sessionKey] ?? null;
}
export function clearTerminalId(sessionKey: string): void {
  if (!sessionKey) return;
  const ids = read();
  delete ids[sessionKey];
  write(ids);
}
```

- [ ] **Step 4: 跑到通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-sessions.test.ts`
Expected: PASS(5 用例)。

- [ ] **Step 5: 写失败的测试(store attach + seq)**

在 `packages/relay-web/src/__tests__/terminal-store.test.ts` 加(用既有 mock 方式;`api.rpc` 已被 mock):

```ts
it("attach() calls control.terminal.attach and unwraps the result", async () => {
  vi.mocked(api.rpc).mockResolvedValueOnce({ ok: true, buffer: "scroll", lastSeq: 7 } as never);
  const store = useTerminalStore();
  const res = await store.attach("i1", "term-x");
  expect(api.rpc).toHaveBeenCalledWith("i1", "control.terminal.attach", { terminalId: "term-x" });
  expect(res).toEqual({ ok: true, buffer: "scroll", lastSeq: 7 });
});

it("applyEvent forwards seq to output callbacks", () => {
  const store = useTerminalStore();
  const seen: Array<[string, string, number]> = [];
  store.onOutput((id, data, seq) => seen.push([id, data, seq]));
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: 42, data: "hi" } } as never);
  expect(seen).toEqual([["t1", "hi", 42]]);
});
```
（对齐该文件既有的 import：`api`、`useTerminalStore` 等。）

- [ ] **Step 6: 跑到失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-store.test.ts`
Expected: FAIL — `attach` 未定义;`onOutput` 回调没收到 seq。

- [ ] **Step 7: 改 store**

`packages/relay-web/src/stores/terminal.ts`:import 加 `TerminalAttachResult`;`OutputCb` 带 seq;加 `attach`;`applyEvent` 传 seq:

```ts
import { isErrorPayload, type WebServerEvent, type TerminalAttachResult } from "@ganglion/xacpx-relay-protocol";
```
```ts
type OutputCb = (terminalId: string, data: string, seq: number) => void;
```
```ts
  async function attach(instanceId: string, terminalId: string): Promise<TerminalAttachResult> {
    const result = await api.rpc<TerminalAttachResult>(instanceId, "control.terminal.attach", { terminalId });
    return unwrap(result);
  }
```
`applyEvent` 的 terminal-output 分支:
```ts
    if (e.type === "terminal-output") {
      for (const cb of outputCbs) cb(e.terminalId, e.data, e.seq);
    }
```
`return` 里加 `attach`:`return { create, attach, input, resize, close, onOutput, onExit, applyEvent };`

- [ ] **Step 8: 跑到通过 + 类型 + 提交**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-sessions.test.ts src/__tests__/terminal-store.test.ts && npx vue-tsc --noEmit`
Expected: PASS + vue-tsc 0。
（`OutputCb` 从 2 参变 3 参**不会**破坏 TerminalTab 现有的 `onOutput((id, data) => ...)` 回调——TS 允许把少参数函数赋给多参数回调类型。本任务**不**动 TerminalTab.vue,vue-tsc 应直接 0。）

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/lib/terminal-sessions.ts packages/relay-web/src/stores/terminal.ts packages/relay-web/src/__tests__/terminal-sessions.test.ts packages/relay-web/src/__tests__/terminal-store.test.ts
git commit -m "feat(relay-web): terminal-sessions persistence + store attach() + seq passthrough"
```

---

### Task 5: relay-web — TerminalTab attach-on-mount + seq 去重 + 生命周期

**Files:**
- Modify: `packages/relay-web/src/components/TerminalTab.vue`
- Test: `packages/relay-web/src/__tests__/terminal-tab.test.ts`

**Interfaces:**
- Consumes:store `attach`/`onOutput(…,seq)`(Task 4);`loadTerminalId`/`saveTerminalId`/`clearTerminalId`(Task 4);`sessionKey` helper from `../stores/center-tabs`。

- [ ] **Step 1: 写失败的测试**

在 `packages/relay-web/src/__tests__/terminal-tab.test.ts`(`beforeEach` 已有 `sessionStorage.clear()`)加。既有 mock:`api.rpc` 返回 `{terminalId:"t1"}`、adapter mock 有 `write`。追加对 attach 的 mock 能力(按需在用例内 `vi.mocked(api.rpc).mockImplementation` 区分 create vs attach):

```ts
import { saveTerminalId, loadTerminalId } from "../lib/terminal-sessions";

it("on mount with a persisted terminalId, attaches and replays the buffer (no fresh create)", async () => {
  saveTerminalId("i1::demo", "term-persisted");
  vi.mocked(api.rpc).mockImplementation(async (_i, method) => {
    if (method === "control.terminal.attach") return { ok: true, buffer: "PRIOR SCROLLBACK", lastSeq: 5 } as never;
    return { terminalId: "should-not-create" } as never;
  });
  const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: false }, global: globalOpts });
  await tick();
  expect(api.rpc).toHaveBeenCalledWith("i1", "control.terminal.attach", { terminalId: "term-persisted" });
  expect(adapter.write).toHaveBeenCalledWith("PRIOR SCROLLBACK"); // scrollback replayed
  // did NOT create a fresh terminal
  expect(api.rpc).not.toHaveBeenCalledWith("i1", "control.terminal.create", expect.anything());
});

it("drops live output with seq <= lastSeq after attach (dedup)", async () => {
  saveTerminalId("i1::demo", "term-persisted");
  vi.mocked(api.rpc).mockImplementation(async (_i, method) =>
    method === "control.terminal.attach" ? ({ ok: true, buffer: "BUF", lastSeq: 5 } as never) : ({} as never));
  const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: false }, global: globalOpts });
  await tick();
  adapter.write.mockClear();
  // deliver live output via the store event path (reuse this file's helper if present, else applyEvent)
  const store = useTerminalStore();
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "term-persisted", seq: 5, data: "DUP" } } as never); // <= lastSeq → dropped
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "term-persisted", seq: 6, data: "NEW" } } as never); // > lastSeq → written
  await tick();
  expect(adapter.write).not.toHaveBeenCalledWith("DUP");
  expect(adapter.write).toHaveBeenCalledWith("NEW");
});

it("attach ok:false clears the id and falls back to the start placeholder", async () => {
  saveTerminalId("i1::demo", "gone");
  vi.mocked(api.rpc).mockImplementation(async (_i, method) =>
    method === "control.terminal.attach" ? ({ ok: false } as never) : ({} as never));
  const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: false }, global: globalOpts });
  await tick();
  expect(w.find('[data-test="term-restore"]').exists()).toBe(true); // placeholder
  expect(loadTerminalId("i1::demo")).toBeNull(); // stale id cleared
});

it("fresh create persists the terminalId", async () => {
  vi.mocked(api.rpc).mockResolvedValue({ terminalId: "t-new" } as never);
  mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: true }, global: globalOpts });
  await tick();
  expect(loadTerminalId("i1::demo")).toBe("t-new");
});

it("unmount (refresh) does NOT close the PTY", async () => {
  vi.mocked(api.rpc).mockResolvedValue({ terminalId: "t-new" } as never);
  const sent: unknown[] = [];
  vi.mocked(sendWebClientMessage).mockImplementation((m) => { sent.push(m); });
  const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo", autostart: true }, global: globalOpts });
  await tick();
  w.unmount();
  expect(sent.some((m: any) => m.kind === "terminal-close")).toBe(false); // no close on unmount
});
```
（`globalOpts`/`tick`/`adapter`/`api`/`sendWebClientMessage` 用该文件既有定义;`useTerminalStore` 从 stores 导入。若该文件没有直接 `applyEvent` 的入口,用它既有把 output 送进组件的 helper。)

- [ ] **Step 2: 跑到失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-tab.test.ts`
Expected: FAIL — attach 路径不存在、卸载仍发 close。

- [ ] **Step 3: 改 TerminalTab.vue — import + sessionKey + releaseFrontend**

import 区加:
```ts
import { sessionKey as makeSessionKey } from "../stores/center-tabs";
import { loadTerminalId, saveTerminalId, clearTerminalId } from "../lib/terminal-sessions";
import { computed } from "vue"; // 若已 import computed 则忽略
```
加 sessionKey computed(props 之后):
```ts
const sessionKey = computed(() => makeSessionKey(props.instanceId, props.sessionAlias));
```
把现有 `teardown()` **改名为 `releaseFrontend()` 并移除 PTY close**(关键):
```ts
function releaseFrontend() {
  epoch++;
  offOutput?.(); offOutput = null;
  offExit?.(); offExit = null;
  resizeObs?.disconnect(); resizeObs = null;
  adapter?.dispose(); adapter = null; terminalId = "";
  disarmMods();
}
```
把 `start()` 开头的 `teardown()` 调用改成 `releaseFrontend()`;把 `onBeforeUnmount` 里的 `teardown()` 改成 `releaseFrontend()`。（原 teardown 里的 `if (terminalId) terminals.close(...)` 一行**删除**——PTY 不再在卸载时被杀。）

- [ ] **Step 4: 改 TerminalTab.vue — create 持久化 id**

`start()` 成功分支,`terminalId = newId; status.value = "open";` 之后加:
```ts
      terminalId = newId;
      saveTerminalId(sessionKey.value, newId);
      status.value = "open";
```

- [ ] **Step 5: 改 TerminalTab.vue — attach-on-mount + handoff 去重**

加 `tryAttach`(放在 `start()` 附近):
```ts
async function tryAttach(id: string): Promise<boolean> {
  if (!host.value) return false;
  releaseFrontend();
  const myEpoch = epoch;
  status.value = "connecting";
  started = true;
  terminalId = id;
  const currentAdapter = createTerminalAdapter(host.value, { cols: 80, rows: 24, onData: handleData, theme: currentTheme() });
  adapter = currentAdapter;
  const pending: Array<{ data: string; seq: number }> = [];
  let queueing = true;
  let ignoreThroughSeq = -1;
  offOutput = terminals.onOutput((oid, data, seq) => {
    if (oid !== terminalId) return;
    if (queueing) { pending.push({ data, seq }); return; }
    if (seq <= ignoreThroughSeq) return;
    adapter?.write(data);
  });
  offExit = terminals.onExit((oid, code) => { if (oid === terminalId) { status.value = "exited"; errorKey.value = String(code); } });
  try {
    const res = await terminals.attach(props.instanceId, id);
    if (myEpoch !== epoch) { currentAdapter.dispose(); return true; } // superseded
    if (!res.ok) { releaseFrontend(); status.value = "idle"; return false; }
    ignoreThroughSeq = res.lastSeq;
    currentAdapter.write(res.buffer);            // replay scrollback
    queueing = false;
    for (const p of pending) if (p.seq > ignoreThroughSeq) currentAdapter.write(p.data); // flush queued live
    pending.length = 0;
    status.value = "open";
    resizeObs = new ResizeObserver(() => applyFit());
    if (host.value) resizeObs.observe(host.value);
    applyFit(myEpoch);
    return true;
  } catch {
    if (myEpoch !== epoch) return true;
    releaseFrontend(); status.value = "idle";
    return false;
  }
}
```
改挂载入口:把 `onMounted` 里的 `if (props.autostart) void start();` 换成 `void mount();`,并加 `mount()`:
```ts
async function mount() {
  const id = loadTerminalId(sessionKey.value);
  if (id) {
    const ok = await tryAttach(id);
    if (ok) return;
    clearTerminalId(sessionKey.value); // stale PTY → forget, fall through
  }
  if (props.autostart) void start();
  // else: showPlaceholder stays (status idle)
}
```
（prop-watch `watch([instanceId, sessionAlias], () => { if (started) void start(); })` 保持;它只在已 start 的活动终端上因 prop 变化重启,不影响 attach 首挂载。）

- [ ] **Step 6: 跑到通过**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-tab.test.ts`
Expected: PASS(5 新用例 + 既有终端用例;既有 autostart/占位用例应仍绿——autostart=true 无持久化 id 时 mount() 走 start())。

- [ ] **Step 7: 相邻回归 + 类型 + 提交**

Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-store.test.ts src/__tests__/dashboard-center-tabs.test.ts && npx vue-tsc --noEmit`
Expected: PASS + vue-tsc 0。

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/components/TerminalTab.vue packages/relay-web/src/__tests__/terminal-tab.test.ts
git commit -m "feat(relay-web): TerminalTab attaches to a live PTY on reload (replay + seq dedup); no PTY kill on unmount"
```

---

### Task 6: relay-web — 显式关闭杀 PTY + 清 id(DashboardView)

**Files:**
- Modify: `packages/relay-web/src/views/DashboardView.vue`(`requestCloseTab` + reconcile prune 的终端处理)
- Test: `packages/relay-web/src/__tests__/dashboard-center-tabs.test.ts`(或相应 dashboard 测试)

**Interfaces:**
- Consumes:`terminals.close`(既有 store)、`loadTerminalId`/`clearTerminalId`(Task 4)、`centerTabs.tabsFor`/`clearSession`(既有)。

- [ ] **Step 1: 写失败的测试**

`dashboard-center-tabs.test.ts` 里 TerminalTab 是 stub(`stub-term`),所以 close 要从**中置 tab 条**(未 stub)的关闭控件触发,而非终端 pane 内部。用该文件既有的 `mountDash()`/`selectSession()`/`useCenterTabsStore()`/`flushPromises()`,并对 terminal store 的 `close` 做 spy。追加:

```ts
// 顶部按需 import:import { saveTerminalId, loadTerminalId } from "../lib/terminal-sessions";
// import { useTerminalStore } from "../stores/terminal";

test("closing a terminal tab kills its PTY and clears the persisted id", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const key = selectSession();
  await flushPromises();
  const centerTabs = useCenterTabsStore();
  centerTabs.openTerminal(key);
  saveTerminalId(key, "tid-1");
  await flushPromises();
  const terminals = useTerminalStore();
  const closeSpy = vi.spyOn(terminals, "close");

  // 触发该终端 tab 的关闭:用中置 tab 条上该 tab 的关闭按钮(data-test 见 CenterTabStrip;
  // 对齐本文件既有触发方式;若文件已有关闭 helper 则复用)。
  await closeTerminalTabViaStrip(wrapper, key); // 用文件既有/tab 条的关闭控件

  expect(closeSpy).toHaveBeenCalledWith(expect.any(String), "tid-1"); // (instanceId, terminalId)
  expect(loadTerminalId(key)).toBeNull();
});

test("closing a FILE tab does not kill any terminal PTY", async () => {
  // open a file tab, spy terminals.close, close the file tab → close NOT called
  // (用 centerTabs.openFile + 文件 tab 的关闭控件;断言 closeSpy 未被调)
});
```

> `closeTerminalTabViaStrip` 是占位名——实现时用 `CenterTabStrip` 上该 tab 的关闭按钮的真实 `data-test`(读组件确认),或本测试文件既有的 tab 关闭助手,触发 `requestCloseTab(key, "terminal")`。核心断言不变:关终端 tab → `terminals.close(instanceId, "tid-1")` + `loadTerminalId(key)===null`;关文件 tab → `terminals.close` 不被调。

- [ ] **Step 2: 跑到失败**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-center-tabs.test.ts`
Expected: FAIL — 关终端 tab 没杀 PTY / 没清 id。

- [ ] **Step 3: 改 requestCloseTab**

`packages/relay-web/src/views/DashboardView.vue`。确保已有 `const terminals = useTerminalStore()`(没有则 import + 实例化)、import `loadTerminalId, clearTerminalId` from `../lib/terminal-sessions`。改 `requestCloseTab`(:154):

```ts
function requestCloseTab(key: string, id: string) {
  // Explicit close of a terminal tab kills its PTY and forgets the id (a refresh does NOT reach here).
  const tab = centerTabs.tabsFor(key).find((t) => t.id === id);
  if (tab?.kind === "terminal") {
    const tid = loadTerminalId(key);
    if (tid) terminals.close(keyInstance(key), tid);
    clearTerminalId(key);
  }
  centerTabs.closeTabGuarded(key, id, () => window.confirm(t("files.unsavedConfirm")));
}
```

- [ ] **Step 4: 改 reconcile 剪枝(dead session 也杀终端 + 清 id)**

在 `reconcileCenterTabs`(约 :170-182,`if (inst?.sessionsLoaded && !valid.has(key)) centerTabs.clearSession(key)` 处),剪枝前对该 session 的终端 tab 杀 PTY + 清 id:

```ts
    if (inst?.sessionsLoaded && !valid.has(key)) {
      const hasTerminal = centerTabs.tabsFor(key).some((t) => t.kind === "terminal");
      if (hasTerminal) {
        const tid = loadTerminalId(key);
        if (tid) terminals.close(keyInstance(key), tid);
        clearTerminalId(key);
      }
      centerTabs.clearSession(key);
    }
```

- [ ] **Step 5: 跑到通过 + 类型 + 提交**

Run: `cd packages/relay-web && npx vitest run src/__tests__/dashboard-center-tabs.test.ts && npx vue-tsc --noEmit`
Expected: PASS + vue-tsc 0。

```bash
cd /Users/maijiazhen/Projects/workspace-a
git add packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/__tests__/dashboard-center-tabs.test.ts
git commit -m "feat(relay-web): kill terminal PTY + clear id on explicit tab close / session prune"
```

---

## 收尾(全部任务完成后)

- 全量:core `bun test tests/unit/control/terminal-service.test.ts` + `npx tsc --noEmit` 0;relay-web `cd packages/relay-web && npx vitest run`(全绿)+ `npx vue-tsc --noEmit` 0;connector 测试绿;protocol dist 重建 + assert。
- **端到端(发布/真机阶段)**:连接器重打包 + 重装插件目录 + 重启 console(沙箱旧 tarball 坑);hub 若有 RPC 白名单补 `terminalAttach`(预期无需)。
- **发布(四包,按 runbook)**:relay-protocol(锁 0.1.x 保 ^0.1.0)→ core → channel-relay → relay(hub)。core 版本耦合:`tests/unit/packages/package-metadata.test.ts` 硬编码版本 + `weacpx-compat` shim 镜像 root.version。`npm install --package-lock-only` 同步 lock。可与已在 main 的 Windows 支持批发 core beta。
- 实机验收:开终端跑输出 → 硬刷新 → scrollback 恢复且接回同一 shell(跑到一半的进程还在);关 tab → PTY 真被杀(不泄漏);>15min idle 回收后刷新 → attach 不到 → 回落"启动新终端"占位;seq 去重无重复/丢行。
