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
test("handle-session-new", () =>
  check({
    name: "handle-session-new",
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

// 16. handle() plain prompt with a current session: reaches transport.prompt.
test("handle-prompt-normal", () =>
  check({
    name: "handle-prompt-normal",
    seed: async (s) => {
      await s.createSession("demo", "codex", "backend");
      await s.useSession("wx:user", "demo");
    },
    run: (r, reply) => r.handle("wx:user", "hello there", reply),
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
