import { test, expect, jest } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runRouterOracle, type RouterOracleScenario } from "./router-oracle-harness";
import { MissingOptionalDepError } from "../../../../src/recovery/errors";

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

// --- 18 black-box characterization scenarios. Each is one `test`; fixtures are RECORDINGS
// of the baseline's real behaviour, never assertions of expected behaviour. ---

// 1. Full transport lifecycle create through resolve → reserve → ensure → verify → attach → refresh.
test("create-normal", () =>
  check({
    name: "create-normal",
    run: (router) => router.createSessionWithTransport("relay:demo", "codex", "backend"),
  }));

// 2. Create whose best-effort agent-command refresh throws: the create still succeeds and the
//    failure is swallowed + logged (session.agent_command_refresh_failed).
test("create-refresh-fails", () =>
  check({
    name: "create-refresh-fails",
    resolveSessionAgentCommand: async () => {
      throw new Error("refresh boom");
    },
    run: (router) => router.createSessionWithTransport("relay:demo", "codex", "backend"),
  }));

// 3. Create onto an already-bound alias: throws before any transport work.
test("create-alias-exists", () =>
  check({
    name: "create-alias-exists",
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    run: (router) => router.createSessionWithTransport("relay:demo", "codex", "backend"),
  }));

// 4. Remove blocked by an in-flight orchestration task: throws before sessions.removeSession.
test("remove-blocking-guard", () =>
  check({
    name: "remove-blocking-guard",
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    orchestration: {
      listSessionBlockingTasks: async () => [{}] as never,
    },
    run: (router) => router.removeSessionWithTransport("relay:demo"),
  }));

// 5. Normal remove: guard → count → removeSession → purge → transport.deleteSession.
test("remove-normal", () =>
  check({
    name: "remove-normal",
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    run: (router) => router.removeSessionWithTransport("relay:demo"),
  }));

// 6. Remove of an alias whose transport session is shared by another alias: no transport teardown.
test("remove-shared", () =>
  check({
    name: "remove-shared",
    seed: async (sessions) => {
      await sessions.attachSession("relay:demo", "codex", "backend", "backend:shared");
      await sessions.attachSession("relay:other", "codex", "backend", "backend:shared");
    },
    run: (router) => router.removeSessionWithTransport("relay:demo"),
  }));

// 7. Remove whose orchestration purge throws: error is logged, teardown still runs, no rethrow.
test("remove-purge-throws", () =>
  check({
    name: "remove-purge-throws",
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    orchestration: {
      purgeSessionReferences: async () => {
        throw new Error("purge boom");
      },
    },
    run: (router) => router.removeSessionWithTransport("relay:demo"),
  }));

// 8. Archive refused while a turn is running: throws before cancel / setArchived.
test("archive-active-turn", () =>
  check({
    name: "archive-active-turn",
    activeTurnsRunning: true,
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    run: (router) => router.archiveSessionWithTransport("relay:demo"),
  }));

// 9. Normal archive of a non-shared session: cancel → freeWarmProcess → setArchived(true).
test("archive-normal", () =>
  check({
    name: "archive-normal",
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    run: (router) => router.archiveSessionWithTransport("relay:demo"),
  }));

// 10. Archive of a shared session: skips cancel/freeWarmProcess, only setArchived(true).
test("archive-shared", () =>
  check({
    name: "archive-shared",
    seed: async (sessions) => {
      await sessions.attachSession("relay:demo", "codex", "backend", "backend:shared");
      await sessions.attachSession("relay:other", "codex", "backend", "backend:shared");
    },
    run: (router) => router.archiveSessionWithTransport("relay:demo"),
  }));

// 11. Native attach when the transport can't resume native sessions: throws immediately.
test("attach-native-unsupported", () =>
  check({
    name: "attach-native-unsupported",
    transport: { resumeAgentSession: undefined },
    run: (router) => router.attachNativeSessionWithTransport("relay:demo", "codex", "backend", "sess-1"),
  }));

// 12. Normal native attach: reserve → resumeAgentSession → verify → attachNativeSession → refresh.
test("attach-native-normal", () =>
  check({
    name: "attach-native-normal",
    run: (router) => router.attachNativeSessionWithTransport("relay:demo", "codex", "backend", "sess-1"),
  }));

// 13. Native listing when the transport can't list: returns [] without touching config/transport.
test("list-native-none", () =>
  check({
    name: "list-native-none",
    transport: { listAgentSessions: undefined },
    run: (router) => router.listNativeSessionsForControl("codex", "backend"),
  }));

// 14. Full handle() path for `/session new` (parse → authorize → ensure/verify/attach lifecycle).
//     The ensureSession fake drives its progress-handler argument (createProgressHandler) so the
//     progress + heartbeat reply paths are recorded: `spawn` emits an agent-spawning reply; then
//     bun's fake timers advance exactly one 30s tick while the progress handler's setInterval is
//     still alive (createProgressHandler runs before ensureSession; `dispose`/clearInterval runs
//     after it resolves) so EXACTLY ONE `agentHeartbeat` reply fires (time-scrubbed to `waited
//     <n>s`); the immediately-following `initializing` is then suppressed by the 3s debounce.
test("handle-session-new", () =>
  check({
    name: "handle-session-new",
    transport: {
      ensureSession: async (_session, onProgress) => {
        onProgress?.("spawn");
        // Fire one 30s heartbeat interval deterministically (fake timers installed in `run`).
        jest.advanceTimersByTime(30_000);
        onProgress?.("initializing");
      },
    },
    run: async (router, reply) => {
      jest.useFakeTimers();
      try {
        return await router.handle("wx:user", "/session new demo --agent codex --ws backend", reply);
      } finally {
        jest.useRealTimers();
      }
    },
  }));

// 15. handle() `/mode plan`: getCurrentSession → transport.setMode → setCurrentSessionMode.
test("handle-mode-set", () =>
  check({
    name: "handle-mode-set",
    seed: async (sessions) => {
      await sessions.createSession("demo", "codex", "backend");
      await sessions.useSession("wx:user", "demo");
    },
    run: (router) => router.handle("wx:user", "/mode plan"),
  }));

// 16. handle() plain prompt with a current session: reaches transport.prompt. A recording
//     perfSpan is threaded into handle() (11th positional arg) so the spec's perf-mark order
//     (router.authorized → transport.prompt_dispatched → transport.prompt_done) is pinned.
//     The prompt fake drives its `onSegment` twice ("chunk-a"/"chunk-b") to exercise the
//     one-shot `firstChunkFired` guard: `transport.first_chunk` must mark EXACTLY ONCE.
test("handle-prompt-normal", () =>
  check({
    name: "handle-prompt-normal",
    transport: {
      prompt: async (s, text, _reply, _replyContext, options) => {
        await options?.onSegment?.("chunk-a");
        await options?.onSegment?.("chunk-b");
        return { text: `agent:${s.alias}:${text}` };
      },
    },
    seed: async (sessions) => {
      await sessions.createSession("demo", "codex", "backend");
      await sessions.useSession("wx:user", "demo");
    },
    run: (router, reply, perfSpan) =>
      router.handle(
        "wx:user",
        "hello there",
        reply,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        perfSpan,
      ),
  }));

// 17. handle() plain prompt with an already-aborted signal: throws AbortError before transport.prompt.
test("handle-prompt-preaborted", () =>
  check({
    name: "handle-prompt-preaborted",
    seed: async (sessions) => {
      await sessions.createSession("demo", "codex", "backend");
      await sessions.useSession("wx:user", "demo");
    },
    run: (router, reply) => {
      const controller = new AbortController();
      controller.abort();
      return router.handle(
        "wx:user",
        "hello there",
        reply,
        undefined,
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
    },
  }));

// 18. handle() `/session new` where ensureSession first throws MissingOptionalDepError, then the
//     auto-install recovery path retries and succeeds.
test("handle-ensure-autoinstall", () => {
  let ensureCalls = 0;
  return check({
    name: "handle-ensure-autoinstall",
    transport: {
      ensureSession: async () => {
        ensureCalls += 1;
        if (ensureCalls === 1) {
          throw new MissingOptionalDepError({
            package: "opencode-windows-x64",
            parentPackagePath: null,
            rawMessage: "boom",
          });
        }
      },
    },
    run: async (router, reply) => {
      router.__setDiscoverPathsForTest(async (_pkg, seed) => (seed ? [{ path: seed, manager: "npm" as const }] : []));
      router.__setAutoInstallForTest(async (_pkg, _paths, opts) => {
        const verified = opts?.verify ? await opts.verify() : true;
        return { ok: verified, errors: [], logPath: "/log" };
      });
      return await router.handle("wx:user", "/session new demo --agent codex --ws backend", reply);
    },
  });
});

// --- Coverage-gap scenarios added after Codex review (spec §等价性判据 场景集). ---

// 19. unarchiveSession on a seeded-archived session: single sessions.setArchived(alias, false).
//     (Spec "6 CRUD 直接驱动" — unarchive had no scenario.)
test("unarchive-normal", () =>
  check({
    name: "unarchive-normal",
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
      await sessions.setArchived("relay:demo", true);
    },
    run: (router) => router.unarchiveSession("relay:demo"),
  }));

// 20. listNativeSessionsForControl when the transport CAN list: resolves cwd from config and
//     records the `transport.listAgentSessions({… cwd, filterCwd …})` query. (Spec scenario 13's
//     "有则按 cwd 过滤查询" branch — only the empty `list-native-none` existed.)
test("list-native-cwd", () =>
  check({
    name: "list-native-cwd",
    transport: {
      listAgentSessions: async () => ({
        source: "agent" as const,
        sessions: [{ sessionId: "sess-1", cwd: "/tmp/backend", title: "demo", updatedAt: "<ts>" }],
      }),
    },
    run: (router) => router.listNativeSessionsForControl("codex", "backend"),
  }));

// 21. handle() `/model <id>`: getCurrentSession → setModelTransportSession (measureTransportCall
//     → transport.setModel) → setCurrentSessionModel. Valid id per parse-command-model.test.ts.
test("handle-model-set", () =>
  check({
    name: "handle-model-set",
    transport: {
      setModel: async () => {},
      getSessionModel: async () => ({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] }),
    },
    seed: async (sessions) => {
      await sessions.createSession("demo", "codex", "backend");
      await sessions.useSession("wx:user", "demo");
    },
    run: (router) => router.handle("wx:user", "/model gpt-5.2[high]"),
  }));

// 22. handle() `/cancel`: getCurrentSession → cancelTransportSession (measureTransportCall →
//     transport.cancel).
test("handle-cancel", () =>
  check({
    name: "handle-cancel",
    seed: async (sessions) => {
      await sessions.createSession("demo", "codex", "backend");
      await sessions.useSession("wx:user", "demo");
    },
    run: (router) => router.handle("wx:user", "/cancel"),
  }));

// 23. handle() `/clear` (session.reset): resolve fresh reset session → ensure/verify via invoker
//     → attachSession → refresh → useSession. The reset transport session name embeds Date.now();
//     the harness scrubs `reset-<n>` so the fixture is byte-stable.
test("handle-session-reset", () =>
  check({
    name: "handle-session-reset",
    seed: async (sessions) => {
      await sessions.createSession("demo", "codex", "backend");
      await sessions.useSession("wx:user", "demo");
    },
    run: (router) => router.handle("wx:user", "/clear"),
  }));

// 24. archiveSessionWithTransport, non-shared, where transport.freeWarmProcess THROWS: the
//     best-effort catch swallows it, logs session.free_warm_process_failed, and still reaches
//     sessions.setArchived(alias, true). (Spec scenario 9's best-effort branch.)
test("archive-freewarm-fails", () =>
  check({
    name: "archive-freewarm-fails",
    transport: {
      freeWarmProcess: async () => {
        throw new Error("free warm boom");
      },
    },
    seed: async (sessions) => {
      await sessions.createSession("relay:demo", "codex", "backend");
    },
    run: (router) => router.archiveSessionWithTransport("relay:demo"),
  }));
