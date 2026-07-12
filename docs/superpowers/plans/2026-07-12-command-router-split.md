# command-router 拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/commands/command-router.ts`（1189 行）的 transport-调用封装 与 会话-CRUD 两簇抽成 `TransportInvoker` 与 `SessionControlService`，零行为变更。

**Architecture:** 先建黑盒有序调用-日志 oracle（用假协作者 + 真 SessionService，记录 transport/sessions/orchestration/reply/logger 的有序调用序 + 入口返回/抛出），在重构前 commit 独立 worktree 录基线；再自底向上抽两个单元（TransportInvoker 先、SessionControlService 组合它），每步靠 oracle + 现有测试全绿 + 变异验证守。

**Tech Stack:** TypeScript, Bun test runner (`bun test`), 现有 `tests/unit/commands/command-router-test-support.ts` 的假件（`createConfig`/`createTransport`/`createOrchestrationService`/`createLogger`/`MemoryStateStore`）。

## Global Constraints

- **零行为变更**：Task 0 在基线 commit `10099b9` 录的 oracle fixture 必须跨重构字节一致。
- **现有测试一字不改**：`tests/unit/commands/command-router-*.test.ts`、`command-router-test-support.ts`、`handlers/**`、`session-archive-delete.test.ts` 等全部不动、全程绿（次级判据）。
- **公开 API 签名不变**：门面保留 `handle` + 6 个 CRUD（`createSessionWithTransport` / `removeSessionWithTransport` / `archiveSessionWithTransport` / `unarchiveSession` / `listNativeSessionsForControl` / `attachNativeSessionWithTransport`）的公开签名，转发给 `SessionControlService`。`main.ts` / `control-service.ts` / `console-agent.ts` 三调用点一字不改。
- **不 value-import 回门面**：新单元从 `src/commands/router-types.ts`（已存在的中立类型模块）`import type`，绝不从 `command-router.ts` import 值/类。
- **逐文件 `bun test`**，never 整目录（模块状态泄漏→假失败）。
- **`GOLDEN_UPDATE=1` 只在 Task 0 的基线 worktree 出现**；重构阶段绝不设。
- **子代理 git 卫生**：实现子代理不跑任何 git；controller 自己 `git log` 核实；改文件的评审子代理用 `isolation: "worktree"`。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `tests/unit/commands/golden/router-oracle-harness.ts`（新） | 构造带记录探针的 `CommandRouter`，把 transport/sessions/orchestration/reply/logger 的调用按序 append 到单一 `record: string[]`；跑一个场景，产出 `{ record, outcome }` 归一化快照。 |
| `tests/unit/commands/golden/router-oracle.test.ts`（新） | 18 场景，`GOLDEN_UPDATE` 录/比 fixture。 |
| `tests/unit/commands/golden/fixtures/*.json`（新） | 基线快照，Task 0 在 `10099b9` 录。 |
| `src/commands/transport-invoker.ts`（新） | transport 调用封装层（Task 1）。 |
| `src/commands/session-control-service.ts`（新） | 会话 CRUD（Task 2，组合 TransportInvoker）。 |
| `src/commands/command-router.ts`（改） | 两簇迁出，保留 dispatch + ops 工厂 + 公开转发。 |
| `src/commands/router-types.ts`（已存在，可能追加） | 新单元的入参/依赖形状类型。 |

**依赖方向**：`TransportInvoker` ← `SessionControlService` ← `CommandRouter`（门面组合两者）。单向，无环。

---

## Task 0：黑盒有序调用-日志 oracle harness + 基线 fixture

**Files:**
- Create: `tests/unit/commands/golden/router-oracle-harness.ts`
- Create: `tests/unit/commands/golden/router-oracle.test.ts`
- Create: `tests/unit/commands/golden/fixtures/` (18 个 json，录基线时生成)

**Interfaces:**
- Consumes: `createConfig` / `createTransport` / `createOrchestrationService`（from `tests/unit/commands/command-router-test-support.ts`）、`SessionService`、`MemoryStateStore`、`createEmptyState`、`CommandRouter`。
- Produces: `runRouterOracle(scenario): Promise<{ record: string[]; outcome: unknown }>` —— 供 test 录/比。

- [ ] **Step 1: 写 harness —— 单一有序 record + 记录探针**

`tests/unit/commands/golden/router-oracle-harness.ts`：

```ts
import { CommandRouter } from "../../../../src/commands/command-router";
import { SessionService } from "../../../../src/sessions/session-service";
import { createEmptyState } from "../../../../src/state/types";
import type { AppLogger } from "../../../../src/logging/app-logger";
import type { SessionTransport, ResolvedSession } from "../../../../src/transport/types";
import type { OrchestrationRouterOps } from "../../../../src/commands/router-types";
import { createConfig } from "../command-router-test-support";

// One ordered log across every collaborator the router touches. Call order = execution
// order (the router awaits each collaborator call in sequence). Time-varying fields are
// normalized so fixtures are deterministic.
function makeRecorder() {
  const record: string[] = [];
  const push = (line: string) => record.push(line);
  return { record, push };
}

// Compact one arg into a stable, human-diffable token. Sessions/objects collapse to a
// short shape; long strings truncate; the volatile transportSession id is kept verbatim
// because it IS behaviourally load-bearing (dedup / reserve keying).
function summ(v: unknown): string {
  if (v === undefined) return "∅";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 40 ? JSON.stringify(v.slice(0, 40) + "…") : JSON.stringify(v);
  if (typeof v === "function") return "fn";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("alias" in o && "transportSession" in o) return `session(${o.alias}/${o.transportSession})`;
    return "{…}";
  }
  return String(v);
}

// Wrap any collaborator so every method call appends `label.method(args)` before delegating
// to the real implementation (keeps behaviour real = faithful characterization).
function recordProxy<T extends object>(label: string, target: T, push: (l: string) => void): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const orig = Reflect.get(obj, prop, receiver);
      if (typeof orig !== "function" || typeof prop === "symbol") return orig;
      return (...args: unknown[]) => {
        push(`${label}.${String(prop)}(${args.map(summ).join(", ")})`);
        return (orig as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

// A logger whose 5 levels append `logger.<level>(event)` (event name only — messages/fields
// are noise; the event name is the stable behavioural marker, esp. for best-effort catches).
function recordingLogger(push: (l: string) => void): AppLogger {
  const at = (lvl: string) => async (event: string) => push(`logger.${lvl}(${event})`);
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => recordingLogger(push) } as unknown as AppLogger;
}
```

- [ ] **Step 2: 写 `runRouterOracle` —— 场景描述 → 构造 router → 驱动 → 归一化快照**

续 `router-oracle-harness.ts`：

```ts
export interface RouterOracleScenario {
  name: string;
  // Seed the real SessionService before the run (attach existing sessions, mark archived…).
  seed?: (sessions: SessionService) => Promise<void>;
  // Optional transport-behaviour overrides (e.g. hasSession → false, resumeAgentSession absent).
  transport?: Partial<SessionTransport>;
  // Optional orchestration presence/behaviour override.
  orchestration?: Partial<OrchestrationRouterOps> | null;
  activeTurnsRunning?: boolean;
  // The action under test. Receives the router + a recording `reply`.
  run: (router: CommandRouter, reply: (t: string) => Promise<void>) => Promise<unknown>;
}

export async function runRouterOracle(scenario: RouterOracleScenario): Promise<{ record: string[]; outcome: unknown }> {
  const { record, push } = makeRecorder();
  const config = createConfig();
  const baseTransport: SessionTransport = {
    ensureSession: async () => {},
    prompt: async (s: ResolvedSession, text: string) => ({ text: `agent:${s.alias}:${text}` }),
    setMode: async () => {},
    cancel: async () => ({ cancelled: true, message: "cancelled" }),
    hasSession: async () => true,
    tailSessionHistory: async () => ({ text: "" }),
    listAgentSessions: async () => ({ source: "agent" as const, sessions: [] }),
    resumeAgentSession: async () => {},
    deleteSession: async () => {},
    freeWarmProcess: async () => {},
    ...scenario.transport,
  };
  const sessions = new SessionService(config, { save: async () => {} } as never, createEmptyState());
  const recordedSessions = recordProxy("sessions", sessions, push);
  const recordedTransport = recordProxy("transport", baseTransport, push);
  await scenario.seed?.(sessions); // seed on the REAL instance (not the proxy) so setup isn't logged

  // Minimal orchestration fake (best-effort methods the CRUD paths hit). null = omit entirely.
  const orchestration = scenario.orchestration === null ? undefined : recordProxy("orchestration", {
    listSessionBlockingTasks: async () => [],
    purgeSessionReferences: async () => {},
    reserveLogicalTransportSession: async () => async () => {},
    ...scenario.orchestration,
  } as OrchestrationRouterOps, push);

  const activeTurns = { isActiveAnywhere: () => scenario.activeTurnsRunning ?? false } as never;
  const router = new CommandRouter(
    recordedSessions as unknown as SessionService,
    recordedTransport,
    config,
    undefined,
    recordingLogger(push),
    undefined,
    orchestration,
    undefined,
    undefined,
    undefined,
    undefined,
    activeTurns,
  );
  const reply = async (t: string) => { push(`reply(${summ(t)})`); };
  let outcome: unknown;
  try {
    outcome = { ok: await scenario.run(router, reply) };
  } catch (err) {
    outcome = { threw: err instanceof Error ? err.message : String(err) };
  }
  return { record, outcome: normalize(outcome) };
}

// Strip nondeterminism from the returned value (timestamps, generated ids the fixture
// shouldn't pin). Records themselves already avoid time via recordingLogger/summ.
function normalize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === "string" ? val.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>") : val,
  ));
}
```

> **实现者注意（防 flaky fixture）**：`createProgressHandler` 的进度 reply 里内嵌 elapsed 秒数（`agentInitializing(agent, elapsed)` 等），会让 `record` 里的 `reply(...)` 行随机变动。`push` 落 `reply(...)` 前必须对文本做数字归一化（如把 `/\d+s\b/` → `<n>s`、`/\belapsed \d+/` → `elapsed <n>`），照 turn oracle 的 UUID/时间戳 scrub 手法（control-service 拆分时正是漏 scrub 导致 fixture flaky）。任何在 record 里可能出现的时间/秒数一律 scrub，否则 fixture 会假失败。
>
> **实现者注意**：`SessionService` 的真实构造签名请以 `src/sessions/session-service.ts:73` 的 constructor 为准（本 plan 用 `(config, stateStore, state)`，与现有测试 `new SessionService(createConfig(), new MemoryStateStore(), createEmptyState())` 一致）。`SessionTransport` 的可选方法（`freeWarmProcess`/`deleteSession`/`resumeAgentSession`/`listAgentSessions`/`getSessionModel`/`setModel`）以 `src/transport/types.ts` 为准，缺哪个补哪个到 `baseTransport`。若某场景要"transport 不支持某能力"，用 `transport: { resumeAgentSession: undefined }` 覆盖（Proxy 对 undefined 成员不拦截，router 的 `if (!this.transport.resumeAgentSession)` 分支即触发）。

- [ ] **Step 3: 写 test 骨架 + 18 场景（record/replay）**

`tests/unit/commands/golden/router-oracle.test.ts`：

```ts
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runRouterOracle, type RouterOracleScenario } from "./router-oracle-harness";

const FIX = join(import.meta.dir, "fixtures");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

async function check(scenario: RouterOracleScenario) {
  const got = await runRouterOracle(scenario);
  const path = join(FIX, `${scenario.name}.json`);
  const serialized = JSON.stringify(got, null, 2);
  if (UPDATE) {
    if (!existsSync(FIX)) mkdirSync(FIX, { recursive: true });
    writeFileSync(path, serialized + "\n");
    return;
  }
  expect(serialized + "\n").toBe(readFileSync(path, "utf8"));
}

// --- scenarios (see spec §场景集, 18 total). Each is one `test`. ---
test("create-normal", () => check({
  name: "create-normal",
  run: (r) => r.createSessionWithTransport("relay:demo", "codex", "backend"),
}));
// … 其余 17 个场景（见下方"场景清单"），每个一个 test，name 与 fixture 文件名一致。
```

**场景清单**（`name` → 驱动，全部照 spec §等价性判据 的 18 条）：
1. `create-normal` → `createSessionWithTransport("relay:demo","codex","backend")`
2. `create-refresh-fails` → 同上，但 `transport` 让 refresh 链路（`resolveSessionAgentCommand`）无碍、改用 orchestration 无关；实际让 refresh 失败最简单做法：留待实现者用 `sessions` seed 使 `getSession` 返回后 `resolveSessionAgentCommand` 默认解析器返回 undefined → 不写 command（无 error）。**若无法自然触发 refresh 抛错，改为断言正常 best-effort 路径不抛**，并在 fixture 里体现（实现者按真实基线行为录，不臆造）。
3. `create-alias-exists` → seed 一个同 alias 逻辑会话，再 `createSessionWithTransport` 同 alias → 期望 throw、`transport.ensureSession` 不出现在 record。
4. `remove-blocking-guard` → `orchestration.listSessionBlockingTasks` 返回非空；`removeSessionWithTransport` → throw、`sessions.removeSession` 不在 record。
5. `remove-normal` → seed 会话；`removeSessionWithTransport`；断言 record 序：`listSessionBlockingTasks` → `countAliasesSharingTransport` → `removeSession` → `purgeSessionReferences` → `transport.deleteSession`。
6. `remove-shared` → seed 两个 alias 共享同一 transportSession；`removeSessionWithTransport` 其一 → record **无** `transport.deleteSession`。
7. `remove-purge-throws` → `orchestration.purgeSessionReferences` 抛；record 里有 `logger.error(...)` 且仍到 `transport.deleteSession`、方法整体不 throw。
8. `archive-active-turn` → `activeTurnsRunning: true`；`archiveSessionWithTransport` → throw、record 无 `transport.cancel`/`sessions.setArchived`。
9. `archive-normal` → seed 非共享会话；record 序：`transport.cancel` → `transport.freeWarmProcess` → `sessions.setArchived(…, true)`。
10. `archive-shared` → seed 共享；record 无 `cancel`/`freeWarmProcess`，直接 `sessions.setArchived(…, true)`。
11. `attach-native-unsupported` → `transport: { resumeAgentSession: undefined }`；`attachNativeSessionWithTransport` → throw。
12. `attach-native-normal` → record 序：`reserveLogicalTransportSession` → `transport.resumeAgentSession` → `transport.hasSession` → `sessions.attachNativeSession` → refresh。
13. `list-native-none` → `transport: { listAgentSessions: undefined }`；`listNativeSessionsForControl("codex","backend")` → outcome `[]`。
14. `handle-session-new` → `router.handle("wx:u","/ss new demo --agent codex --ws backend")`；断言经 TransportInvoker 的 ensure/verify/attach 链。
15. `handle-mode-set` → seed 当前会话；`handle("wx:u","/mode 1")`（或真实 mode.set 语法）→ record 一次 `transport.setMode`。
16. `handle-prompt-normal` → seed 当前会话；`handle("wx:u","hello")` → record 有 `transport.prompt`。
17. `handle-prompt-preaborted` → 传一个已 abort 的 `AbortSignal`（经 `handle` 的 `abortSignal` 形参）→ throw AbortError、record 无 `transport.prompt`。
18. `handle-ensure-autoinstall` → `transport.ensureSession` 首次抛 `MissingOptionalDepError`，注入 `__setAutoInstallForTest` / `__setDiscoverPathsForTest` 走恢复路径 → record 有 reply 提示 + 重试。

> **实现者注意**：场景 2/14/15/16/18 的精确命令语法与 seed 方式请对照现有 `command-router-session.test.ts` / `command-router-interaction.test.ts` / `command-router-recovery.test.ts` 的既有用法照抄，不要臆造命令字符串。场景 18 的 `MissingOptionalDepError` 构造与 `__setAutoInstallForTest` 注入照 `command-router-recovery.test.ts`。**所有 fixture 一律按基线真实行为录，任何"期望"描述与基线冲突时以基线为准。**

- [ ] **Step 4: 在基线 commit 独立 worktree 录 fixture**

```bash
# 从主工作树创建一个 detached worktree 停在重构前 commit
git worktree add --detach /tmp/router-oracle-baseline 10099b9
# 把 Task 0 新增的三个未提交文件复制进去（它们此刻在工作树里，未提交）
cp -r tests/unit/commands/golden /tmp/router-oracle-baseline/tests/unit/commands/
cd /tmp/router-oracle-baseline
GOLDEN_UPDATE=1 bun test tests/unit/commands/golden/router-oracle.test.ts
# 把录好的 fixtures 拷回主工作树
cp -r /tmp/router-oracle-baseline/tests/unit/commands/golden/fixtures tests/unit/commands/golden/
cd -  # 回主工作树
git worktree remove --force /tmp/router-oracle-baseline
```
Expected: 18 个 `fixtures/*.json` 生成。

- [ ] **Step 5: 回主工作树自我复现（不带 GOLDEN_UPDATE 必须全绿）**

Run: `env -u GOLDEN_UPDATE bun test tests/unit/commands/golden/router-oracle.test.ts`
Expected: 18 pass（基线 = 当前 HEAD `10099b9`，行为一致）。

- [ ] **Step 6: Commit**

```bash
git add tests/unit/commands/golden
git commit -m "test(commands): black-box ordered-call-log oracle for command-router (baseline)"
```

---

## Task 1：抽 `TransportInvoker`

**Files:**
- Create: `src/commands/transport-invoker.ts`
- Modify: `src/commands/command-router.ts`（transport 封装方法迁出，ops 工厂改委派）

**Interfaces:**
- Consumes: `SessionTransport`、`AppLogger`、`AppConfig`、`SessionService`、`SessionAgentCommandResolver`、`ResolvedSession`、`EnsureSessionProgress`、`PromptMediaInput`/`ReplyQuotaContext`/`ToolUseEvent`/`PlanEntry`/`PromptUsage`/`AgentCommand`（全部 `import type`）、auto-install 依赖（`AutoInstallFn`/`DiscoverPathsFn`、`MissingOptionalDepError`/`AutoInstallFailedError`）、`translateAcpxNote`、`summarizeTransport*`、`resolveRuntimeAgentCommand`、`stableCoordinatorSession`。
- Produces: `class TransportInvoker`，构造 `{ transport, logger, config?, sessions, resolveSessionAgentCommand, autoInstall, discoverPaths }`；公开方法（签名与门面原私有方法一致）：`ensureTransportSession(session, reply?, perfSpan?)`、`checkTransportSession(session)`、`promptTransportSession(session, text, reply?, replyContext?, media?, abortSignal?, onToolEvent?, onThought?, perfSpan?, onPlan?, onUsage?, onCommands?)`、`setModeTransportSession(session, modeId)`、`setModelTransportSession(session, modelId)`、`getModelTransportSession(session)`、`cancelTransportSession(session)`、`refreshSessionTransportAgentCommand(alias)`。

- [ ] **Step 1: 建 `transport-invoker.ts`，把封装方法整体搬入**

新建 `src/commands/transport-invoker.ts`，`class TransportInvoker`，构造函数接收上面 Produces 列的依赖。把 `command-router.ts` 现有的这些方法**方法体逐字搬入**（只改 `this.transport`→`this.transport`、`this.logger`→`this.logger`、`this.config`→`this.config`、`this.sessions`→`this.sessions`、`this.resolveSessionAgentCommand`→`this.resolveSessionAgentCommand`、`this.autoInstall`/`this.discoverPaths` 保持）：`measureTransportCall`（私有）、`createProgressHandler`（私有）、`ensureTransportSession`、`checkTransportSession`、`promptTransportSession`、`setModeTransportSession`、`setModelTransportSession`、`getModelTransportSession`、`cancelTransportSession`、`refreshSessionTransportAgentCommand`。文件级函数 `isAbortError`、`inferTransportKind` 一并搬到本文件底部。`summarizeTransport*` 从原 import 源同样 `import`。

> DRY：方法体一字不改（含所有 best-effort catch、perf.mark、日志字段）。这是行为等价重构的核心——任何"顺手优化"都可能破坏 oracle。

- [ ] **Step 2: 门面持有 `TransportInvoker` 实例，删除已迁方法，ops 工厂改委派**

`command-router.ts`：
1. import `TransportInvoker`（值导入 —— 门面 → 新单元方向安全，无环）。
2. 构造函数末尾建实例：
```ts
this.transportInvoker = new TransportInvoker({
  transport: this.transport,
  logger: this.logger,
  config: this.config,
  sessions: this.sessions,
  resolveSessionAgentCommand: this.resolveSessionAgentCommand,
  autoInstall: this.autoInstall,
  discoverPaths: this.discoverPaths,
});
```
（`autoInstall`/`discoverPaths` 是门面现有的私有字段，来自 `__setAutoInstallForTest`/构造默认 —— 传引用，保 `__setAutoInstallForTest` 仍能改；若它们是可变字段，改传 `(...a) => this.autoInstall(...a)` 形式的转发 lambda 以保住 late-binding。实现者按 `command-router.ts` 现有 `autoInstall`/`discoverPaths` 定义决定。）
3. 删掉门面里已迁的 9 个方法 + `isAbortError`/`inferTransportKind`。
4. 把 `createSessionLifecycleOps`/`createSessionInteractionOps`/`createSessionResetOps`/`createSessionShortcutOps` 里对 `this.ensureTransportSession(...)` / `this.checkTransportSession(...)` / `this.promptTransportSession(...)` / `this.setModeTransportSession(...)` / `this.setModelTransportSession(...)` / `this.getModelTransportSession(...)` / `this.cancelTransportSession(...)` / `this.refreshSessionTransportAgentCommand(...)` 的调用改成 `this.transportInvoker.<same>(...)`。**参数顺序一字不改。**
5. `ensureTransportSession` 的 reply/perfSpan 默认值逻辑（ops 工厂里 `replyOverride ?? reply` 那层）留在 ops 工厂，只把最终调用指向 `this.transportInvoker.ensureTransportSession`。

- [ ] **Step 3: 跑 oracle + 现有 command 测试 + tsc**

Run:
```bash
env -u GOLDEN_UPDATE bun test tests/unit/commands/golden/router-oracle.test.ts
for f in $(git ls-files 'tests/unit/commands/*.test.ts'); do env -u GOLDEN_UPDATE bun test "$f"; done
npx tsc --noEmit
```
Expected: oracle 18/18 字节一致；现有 command 测试全绿；tsc 0。

- [ ] **Step 4: 变异验证（证 oracle 真守 transport 层）**

对每个变异：`cp` 备份 → 施加 → `grep` 确认应用 → 跑 oracle → 还原。
- 变异 T1：`promptTransportSession` 里删掉 `if (abortRequested) throw ...` 前的检查（让预-abort 也 dispatch prompt）→ 场景 `handle-prompt-preaborted` 必红。
- 变异 T2：`measureTransportCall` 的成功 `logger.info` 改成不发 → 多个场景 record 少一行、必红。
记录命中用例；任一变异全绿 = 该处无守护，补场景。

- [ ] **Step 5: Commit**

```bash
git add src/commands/transport-invoker.ts src/commands/command-router.ts
git commit -m "refactor(commands): extract TransportInvoker for the transport-call wrapping layer"
```

---

## Task 2：抽 `SessionControlService`（组合 TransportInvoker）

**Files:**
- Create: `src/commands/session-control-service.ts`
- Modify: `src/commands/command-router.ts`（6 CRUD 迁出，门面保留公开转发）

**Interfaces:**
- Consumes: Task 1 的 `TransportInvoker`（用其 `ensureTransportSession`/`checkTransportSession`/`refreshSessionTransportAgentCommand`）、`SessionService`、`SessionTransport`、`OrchestrationRouterOps`、`ActiveTurnRegistry`、`AppConfig`、`AppLogger`、`ResolvedSession`/`AgentSession`、`resolveRuntimeAgentCommand`、`reserveLogicalTransportSession` 回调。
- Produces: `class SessionControlService`，构造 `{ sessions, transport, orchestration?, activeTurns?, config?, logger, invoker, reserveLogicalTransportSession }`；公开方法签名**与门面原方法字节一致**：`createSessionWithTransport(internalAlias, agent, workspace, model?)`、`removeSessionWithTransport(internalAlias)`、`archiveSessionWithTransport(internalAlias)`、`unarchiveSession(internalAlias)`、`listNativeSessionsForControl(agent, workspace)`、`attachNativeSessionWithTransport(internalAlias, agent, workspace, agentSessionId, nativeMeta?)`。

- [ ] **Step 1: 建 `session-control-service.ts`，把 6 CRUD 整体搬入**

新建 `src/commands/session-control-service.ts`。把 `command-router.ts` 的 6 个方法体**逐字搬入**，只改依赖引用：
- `this.sessions`→`this.sessions`、`this.transport`→`this.transport`、`this.orchestration`→`this.orchestration`、`this.activeTurns`→`this.activeTurns`、`this.config`→`this.config`、`this.logger`→`this.logger`。
- `this.ensureTransportSession(...)`→`this.invoker.ensureTransportSession(...)`、`this.checkTransportSession(...)`→`this.invoker.checkTransportSession(...)`、`this.refreshSessionTransportAgentCommand(...)`→`this.invoker.refreshSessionTransportAgentCommand(...)`。
- `this.reserveLogicalTransportSession(...)`→`this.reserveLogicalTransportSession(...)`（作为注入的回调字段调用）。

> best-effort catch、错误消息、`countAliasesSharingTransport` 守卫、`sharedAliasCount===0` 短路一字不改。

- [ ] **Step 2: 门面持有 `SessionControlService`，删除已迁方法，公开方法改转发**

`command-router.ts`：
1. import `SessionControlService`（值导入，门面→单元方向）。
2. 构造函数建实例：
```ts
this.sessionControl = new SessionControlService({
  sessions: this.sessions,
  transport: this.transport,
  orchestration: this.orchestration,
  activeTurns: this.activeTurns,
  config: this.config,
  logger: this.logger,
  invoker: this.transportInvoker,
  reserveLogicalTransportSession: (ts) => this.reserveLogicalTransportSession(ts),
});
```
3. 把 6 个原方法体删掉，替换为**保留公开签名的薄转发**：
```ts
async createSessionWithTransport(internalAlias: string, agent: string, workspace: string, model?: string): Promise<ResolvedSession> {
  return this.sessionControl.createSessionWithTransport(internalAlias, agent, workspace, model);
}
async removeSessionWithTransport(internalAlias: string) {
  return this.sessionControl.removeSessionWithTransport(internalAlias);
}
async archiveSessionWithTransport(internalAlias: string): Promise<void> {
  return this.sessionControl.archiveSessionWithTransport(internalAlias);
}
async unarchiveSession(internalAlias: string): Promise<void> {
  return this.sessionControl.unarchiveSession(internalAlias);
}
async listNativeSessionsForControl(agent: string, workspace: string): Promise<AgentSession[]> {
  return this.sessionControl.listNativeSessionsForControl(agent, workspace);
}
async attachNativeSessionWithTransport(internalAlias: string, agent: string, workspace: string, agentSessionId: string, nativeMeta?: { title?: string | null; updatedAt?: string }): Promise<ResolvedSession> {
  return this.sessionControl.attachNativeSessionWithTransport(internalAlias, agent, workspace, agentSessionId, nativeMeta);
}
```
4. `handle` 的 `case "session.archive"` 里 `(internalAlias) => this.archiveSessionWithTransport(internalAlias)` 无需改（转发方法仍在）。

- [ ] **Step 3: 跑 oracle + 现有测试 + tsc**

Run:
```bash
env -u GOLDEN_UPDATE bun test tests/unit/commands/golden/router-oracle.test.ts
for f in $(git ls-files 'tests/unit/commands/*.test.ts'); do env -u GOLDEN_UPDATE bun test "$f"; done
npx tsc --noEmit
```
Expected: oracle 18/18 字节一致；现有测试全绿；tsc 0。

- [ ] **Step 4: 变异验证（证 CRUD 序 + best-effort 分支真守）**

- 变异 S1：`removeSessionWithTransport` 把 `removeSession` 挪到 `listSessionBlockingTasks` 守卫**之前** → 场景 `remove-blocking-guard` 必红（守卫失败时 removeSession 不该出现）。
- 变异 S2：`removeSessionWithTransport` 删掉 `sharedAliasCount === 0` 短路（总是 deleteSession）→ 场景 `remove-shared` 必红。
- 变异 S3：`createSessionWithTransport` 把 refresh 的 best-effort catch 改成外抛 → 场景 `create-refresh-fails`（若基线是"吞掉"）必红。
记录命中用例。

- [ ] **Step 5: Commit**

```bash
git add src/commands/session-control-service.ts src/commands/command-router.ts
git commit -m "refactor(commands): extract SessionControlService; router keeps public forwarders"
```

---

## Task 3：收尾 —— 死代码、类型归位、行数核对

**Files:**
- Modify: `src/commands/command-router.ts`、`src/commands/router-types.ts`（若有新共享类型）

- [ ] **Step 1: 核对门面无孤儿 import / 无残留私有方法**

Run:
```bash
grep -nE "measureTransportCall|createProgressHandler|isAbortError|inferTransportKind" src/commands/command-router.ts
grep -nE "^import" src/commands/command-router.ts
```
Expected: 上述已迁符号在门面出现 0 次；`translateAcpxNote`/`summarizeTransport*`/`MissingOptionalDepError`/`AutoInstallFailedError`/`stableCoordinatorSession`/`resolveRuntimeAgentCommand`/`PromptCommandError` 等只被两个新单元用的 import 已从门面删除（`import type` 擦除 + `noUnusedLocals` 关，tsc 抓不到孤儿，手动删）。逐个确认门面仍用到的才留。

- [ ] **Step 2: 新共享类型归 `router-types.ts`**

若 Task 1/2 为 `TransportInvoker`/`SessionControlService` 的构造入参定义了 interface（如 `TransportInvokerDeps`/`SessionControlDeps`），且被多于一个文件引用，移到 `src/commands/router-types.ts`；仅单文件用则留在各自文件。**新单元绝不从 `command-router.ts` 值导入。**

Run: `grep -rn "from \"./command-router\"" src/commands/transport-invoker.ts src/commands/session-control-service.ts` → Expected: 空（无回引门面）。

- [ ] **Step 3: 全量核对**

Run:
```bash
env -u GOLDEN_UPDATE bun test tests/unit/commands/golden/router-oracle.test.ts
for f in $(git ls-files 'tests/unit/commands/*.test.ts'); do env -u GOLDEN_UPDATE bun test "$f"; done
npx tsc --noEmit
wc -l src/commands/command-router.ts src/commands/transport-invoker.ts src/commands/session-control-service.ts
git status --porcelain tests/unit/commands/golden/fixtures/
```
Expected: 全 pass；tsc 0；`command-router.ts` 显著变短（1189 → ~450）；fixtures 无 M（相对 Task 0 commit 未改）。

- [ ] **Step 4: Commit**

```bash
git add src/commands/command-router.ts src/commands/router-types.ts
git commit -m "refactor(commands): drop dead code, settle shared types after router split"
```

---

## 全套验证（每 Task 后 controller 核对）

```bash
env -u GOLDEN_UPDATE bun test tests/unit/commands/golden/router-oracle.test.ts   # 18 pass, fixtures unchanged
for f in $(git ls-files 'tests/unit/commands/*.test.ts'); do env -u GOLDEN_UPDATE bun test "$f"; done
npx tsc --noEmit
git status tests/unit/commands/golden/fixtures/   # 相对 Task 0 commit 无 M
```

**公开 API 回归自检**（三调用点未受影响）：
```bash
npx tsc --noEmit   # main.ts / control-service.ts / console-agent.ts 若签名漂移，tsc 立报
```
