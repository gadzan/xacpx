import { test, expect, mock } from "bun:test";
import {
  ControlService,
  type ControlServiceDeps,
} from "../../../src/control/control-service";

function makeDeps(over: {
  enabled: boolean;
  session?: { cwd: string } | null;
}): ControlServiceDeps {
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
      getSession: mock(async (_a: string) =>
        over.session === null ? null : { cwd: over.session?.cwd ?? "/tmp/ws" },
      ),
    },
    terminal,
    terminalEnabled: () => over.enabled,
    events: { subscribe: () => () => {}, emit: () => {} },
  } as unknown as ControlServiceDeps & { _terminal: typeof terminal };
}

test("createTerminal rejects when terminal disabled (no PTY spawn)", async () => {
  const deps = makeDeps({ enabled: false });
  const svc = new ControlService(deps);
  await expect(svc.createTerminal("relay:acc", "demo", 80, 24)).rejects.toThrow(
    "terminal-disabled",
  );
  expect(
    (deps.terminal.create as ReturnType<typeof mock>).mock.calls.length,
  ).toBe(0);
});

test("createTerminal resolves session cwd and delegates to TerminalService", async () => {
  const deps = makeDeps({ enabled: true, session: { cwd: "/home/me/proj" } });
  const svc = new ControlService(deps);
  const r = await svc.createTerminal("relay:acc", "demo", 100, 30);
  expect(r).toEqual({ terminalId: "term-1" });
  expect(
    (deps.terminal.create as ReturnType<typeof mock>).mock.calls[0][0],
  ).toEqual({ cwd: "/home/me/proj", cols: 100, rows: 30 });
});

test("createTerminal throws when session not found", async () => {
  const deps = makeDeps({ enabled: true, session: null });
  const svc = new ControlService(deps);
  await expect(
    svc.createTerminal("relay:acc", "ghost", 80, 24),
  ).rejects.toThrow("session-not-found");
});

test("write/resize/close delegate to TerminalService", () => {
  const deps = makeDeps({ enabled: true });
  const svc = new ControlService(deps);
  svc.writeTerminal("term-1", "ls\n");
  svc.resizeTerminal("term-1", 90, 20);
  svc.closeTerminal("term-1");
  expect(
    (deps.terminal.write as ReturnType<typeof mock>).mock.calls[0],
  ).toEqual(["term-1", "ls\n"]);
  expect(
    (deps.terminal.resize as ReturnType<typeof mock>).mock.calls[0],
  ).toEqual(["term-1", 90, 20]);
  expect(
    (deps.terminal.close as ReturnType<typeof mock>).mock.calls[0],
  ).toEqual(["term-1"]);
});

test("getTerminalSettings returns the persisted value with restartRequired", async () => {
  const deps = makeDeps({ enabled: true });
  const svc = new ControlService({
    ...deps,
    relayTerminalSettings: {
      get: async () => ({ enabled: true, restartRequired: true as const }),
      update: async (enabled: boolean) => ({ enabled, restartRequired: true as const }),
    },
  });
  expect(await svc.getTerminalSettings()).toEqual({ enabled: true, restartRequired: true });
});

test("updateTerminalSettings persists the flip and always reports restartRequired", async () => {
  const seen: boolean[] = [];
  const deps = makeDeps({ enabled: true });
  const svc = new ControlService({
    ...deps,
    relayTerminalSettings: {
      get: async () => ({ enabled: false, restartRequired: true as const }),
      update: async (enabled: boolean) => {
        seen.push(enabled);
        return { enabled, restartRequired: true as const };
      },
    },
  });
  expect(await svc.updateTerminalSettings(true)).toEqual({ enabled: true, restartRequired: true });
  expect(await svc.updateTerminalSettings(false)).toEqual({ enabled: false, restartRequired: true });
  expect(seen).toEqual([true, false]);
});

test("terminal settings fail closed without the wired dep", async () => {
  const svc = new ControlService(makeDeps({ enabled: true }));
  await expect(svc.getTerminalSettings()).rejects.toMatchObject({ code: "terminal_settings_unavailable" });
  await expect(svc.updateTerminalSettings(true)).rejects.toMatchObject({ code: "terminal_settings_unavailable" });
});
