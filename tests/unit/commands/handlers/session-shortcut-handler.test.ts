import { beforeEach, expect, test } from "bun:test";
import { handleSessionShortcutCommand } from "../../../../src/commands/handlers/session-shortcut-handler";
import type { CommandRouterContext, SessionShortcutOps } from "../../../../src/commands/router-types";
import { toDisplaySessionAlias } from "../../../../src/channels/channel-scope";
import { setLocale, t } from "../../../../src/i18n";
import { SessionService } from "../../../../src/sessions/session-service";
import {
  MemoryConfigStore,
  MemoryStateStore,
  createConfig,
  createEmptyState,
  createTransport,
} from "../command-router-test-support";
function build(deleteSessionImpl?: (session: never) => Promise<void>) {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const calls: string[] = [];
  let attachedAlias = "";
  const realAttach = sessions.attachSession.bind(sessions);
  sessions.attachSession = (async (...args: Parameters<typeof realAttach>) => {
    const persisted = await realAttach(...args);
    attachedAlias = persisted.alias;
    return persisted;
  }) as typeof realAttach;
  const realRemove = sessions.removeSession.bind(sessions);
  sessions.removeSession = (async (alias: string) => {
    calls.push("removeSession");
    return realRemove(alias);
  }) as typeof realRemove;
  transport.deleteSession = (async (session: never) => {
    calls.push("deleteSession");
    if (deleteSessionImpl) await deleteSessionImpl(session);
  }) as typeof transport.deleteSession;
  const ops: SessionShortcutOps = {
    resolveSession: (alias, agent, workspace, transportSession, options) =>
      sessions.resolveSession(alias, agent, workspace, transportSession, options),
    reserveTransportSession: async () => async () => {},
    ensureTransportSession: async () => {
      throw new Error("daemon timeout");
    },
    checkTransportSession: async () => true,
    refreshSessionTransportAgentCommand: async () => {},
  };
  const context = {
    config,
    configStore: new MemoryConfigStore(config),
    sessions,
    transport,
    logger: {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    },
  } as unknown as CommandRouterContext;
  return { context, ops, sessions, calls, attachedAlias: () => attachedAlias };
}

test("/ss ensure reject converges the provisional owner before dropping the row", async () => {
  const { context, ops, sessions, calls, attachedAlias } = build();
  const reply = await handleSessionShortcutCommand(
    context,
    ops,
    "wx:user",
    "codex",
    { workspace: "backend" },
    true,
  );
  const display = toDisplaySessionAlias(attachedAlias());
  expect(reply.text).toBe(
    [
      t().shortcut.creationFailed(display),
      t().shortcut.creationFailedReusedWorkspace("backend"),
      t().shortcut.creationFailedSession,
    ].join("\n"),
  );
  // Verified transport teardown strictly precedes the logical row drop.
  expect(calls).toEqual(["deleteSession", "removeSession"]);
  expect(sessions.getResolvedSessionByInternalAlias(attachedAlias())).toBeNull();
});

test("/ss ensure reject with failing cleanup keeps the row and propagates", async () => {
  const { context, ops, sessions, attachedAlias } = build(async () => {
    throw new Error("bridge gone");
  });
  await expect(
    handleSessionShortcutCommand(context, ops, "wx:user", "codex", { workspace: "backend" }, true),
  ).rejects.toThrow(/could not be verified cleaned up/);
  // Retry handle kept: the provisional owner may still be alive.
  expect(sessions.getResolvedSessionByInternalAlias(attachedAlias())).not.toBeNull();
});
