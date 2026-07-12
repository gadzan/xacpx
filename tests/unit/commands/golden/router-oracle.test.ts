import { test, expect } from "bun:test";
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
    run: (r) => r.createSessionWithTransport("relay:demo", "codex", "backend"),
  }));

// 2. Create whose best-effort agent-command refresh throws: the create still succeeds and the
//    failure is swallowed + logged (session.agent_command_refresh_failed).
test("create-refresh-fails", () =>
  check({
    name: "create-refresh-fails",
    resolveSessionAgentCommand: async () => {
      throw new Error("refresh boom");
    },
    run: (r) => r.createSessionWithTransport("relay:demo", "codex", "backend"),
  }));

// 3. Create onto an already-bound alias: throws before any transport work.
test("create-alias-exists", () =>
  check({
    name: "create-alias-exists",
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    run: (r) => r.createSessionWithTransport("relay:demo", "codex", "backend"),
  }));

// 4. Remove blocked by an in-flight orchestration task: throws before sessions.removeSession.
test("remove-blocking-guard", () =>
  check({
    name: "remove-blocking-guard",
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    orchestration: {
      listSessionBlockingTasks: async () => [{}] as never,
    },
    run: (r) => r.removeSessionWithTransport("relay:demo"),
  }));

// 5. Normal remove: guard → count → removeSession → purge → transport.deleteSession.
test("remove-normal", () =>
  check({
    name: "remove-normal",
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    run: (r) => r.removeSessionWithTransport("relay:demo"),
  }));

// 6. Remove of an alias whose transport session is shared by another alias: no transport teardown.
test("remove-shared", () =>
  check({
    name: "remove-shared",
    seed: async (s) => {
      await s.attachSession("relay:demo", "codex", "backend", "backend:shared");
      await s.attachSession("relay:other", "codex", "backend", "backend:shared");
    },
    run: (r) => r.removeSessionWithTransport("relay:demo"),
  }));

// 7. Remove whose orchestration purge throws: error is logged, teardown still runs, no rethrow.
test("remove-purge-throws", () =>
  check({
    name: "remove-purge-throws",
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    orchestration: {
      purgeSessionReferences: async () => {
        throw new Error("purge boom");
      },
    },
    run: (r) => r.removeSessionWithTransport("relay:demo"),
  }));

// 8. Archive refused while a turn is running: throws before cancel / setArchived.
test("archive-active-turn", () =>
  check({
    name: "archive-active-turn",
    activeTurnsRunning: true,
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    run: (r) => r.archiveSessionWithTransport("relay:demo"),
  }));

// 9. Normal archive of a non-shared session: cancel → freeWarmProcess → setArchived(true).
test("archive-normal", () =>
  check({
    name: "archive-normal",
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    run: (r) => r.archiveSessionWithTransport("relay:demo"),
  }));

// 10. Archive of a shared session: skips cancel/freeWarmProcess, only setArchived(true).
test("archive-shared", () =>
  check({
    name: "archive-shared",
    seed: async (s) => {
      await s.attachSession("relay:demo", "codex", "backend", "backend:shared");
      await s.attachSession("relay:other", "codex", "backend", "backend:shared");
    },
    run: (r) => r.archiveSessionWithTransport("relay:demo"),
  }));

// 11. Native attach when the transport can't resume native sessions: throws immediately.
test("attach-native-unsupported", () =>
  check({
    name: "attach-native-unsupported",
    transport: { resumeAgentSession: undefined },
    run: (r) => r.attachNativeSessionWithTransport("relay:demo", "codex", "backend", "sess-1"),
  }));

// 12. Normal native attach: reserve → resumeAgentSession → verify → attachNativeSession → refresh.
test("attach-native-normal", () =>
  check({
    name: "attach-native-normal",
    run: (r) => r.attachNativeSessionWithTransport("relay:demo", "codex", "backend", "sess-1"),
  }));

// 13. Native listing when the transport can't list: returns [] without touching config/transport.
test("list-native-none", () =>
  check({
    name: "list-native-none",
    transport: { listAgentSessions: undefined },
    run: (r) => r.listNativeSessionsForControl("codex", "backend"),
  }));

// 14. Full handle() path for `/session new` (parse → authorize → ensure/verify/attach lifecycle).
//     The ensureSession fake drives its progress-handler argument (createProgressHandler) so the
//     progress/heartbeat reply path is recorded: `spawn` emits an agent-spawning reply; the
//     immediately-following `initializing` is deterministically suppressed by the 3s debounce
//     (0ms < DEBOUNCE_MS), so exactly one reply lands regardless of wall-clock.
test("handle-session-new", () =>
  check({
    name: "handle-session-new",
    transport: {
      ensureSession: async (_session, onProgress) => {
        onProgress?.("spawn");
        onProgress?.("initializing");
      },
    },
    run: (r, reply) => r.handle("wx:user", "/session new demo --agent codex --ws backend", reply),
  }));

// 15. handle() `/mode plan`: getCurrentSession → transport.setMode → setCurrentSessionMode.
test("handle-mode-set", () =>
  check({
    name: "handle-mode-set",
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r) => r.handle("wx:user", "/mode plan"),
  }));

// 16. handle() plain prompt with a current session: reaches transport.prompt. A recording
//     perfSpan is threaded into handle() (11th positional arg) so the spec's perf-mark order
//     (router.authorized → transport.prompt_dispatched → transport.prompt_done) is pinned.
//     transport.first_chunk never marks: the prompt fake resolves without invoking onSegment.
test("handle-prompt-normal", () =>
  check({
    name: "handle-prompt-normal",
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r, reply, perfSpan) =>
      r.handle(
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
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r, reply) => {
      const controller = new AbortController();
      controller.abort();
      return r.handle(
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
    run: async (r, reply) => {
      r.__setDiscoverPathsForTest(async (_pkg, seed) => (seed ? [{ path: seed, manager: "npm" as const }] : []));
      r.__setAutoInstallForTest(async (_pkg, _paths, opts) => {
        const verified = opts?.verify ? await opts.verify() : true;
        return { ok: verified, errors: [], logPath: "/log" };
      });
      return await r.handle("wx:user", "/session new demo --agent codex --ws backend", reply);
    },
  });
});

// --- Coverage-gap scenarios added after Codex review (spec §等价性判据 场景集). ---

// 19. unarchiveSession on a seeded-archived session: single sessions.setArchived(alias, false).
//     (Spec "6 CRUD 直接驱动" — unarchive had no scenario.)
test("unarchive-normal", () =>
  check({
    name: "unarchive-normal",
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
      await s.setArchived("relay:demo", true);
    },
    run: (r) => r.unarchiveSession("relay:demo"),
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
    run: (r) => r.listNativeSessionsForControl("codex", "backend"),
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
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r) => r.handle("wx:user", "/model gpt-5.2[high]"),
  }));

// 22. handle() `/cancel`: getCurrentSession → cancelTransportSession (measureTransportCall →
//     transport.cancel).
test("handle-cancel", () =>
  check({
    name: "handle-cancel",
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r) => r.handle("wx:user", "/cancel"),
  }));

// 23. handle() `/clear` (session.reset): resolve fresh reset session → ensure/verify via invoker
//     → attachSession → refresh → useSession. The reset transport session name embeds Date.now();
//     the harness scrubs `reset-<n>` so the fixture is byte-stable.
test("handle-session-reset", () =>
  check({
    name: "handle-session-reset",
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r) => r.handle("wx:user", "/clear"),
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
    seed: async (s) => {
      await s.createSession("relay:demo", "codex", "backend");
    },
    run: (r) => r.archiveSessionWithTransport("relay:demo"),
  }));
