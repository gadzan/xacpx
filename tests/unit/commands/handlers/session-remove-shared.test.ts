import { beforeEach, expect, mock, test } from "bun:test";

import { CommandRouter } from "../../../../src/commands/command-router";
import { setLocale } from "../../../../src/i18n";
import { SessionService } from "../../../../src/sessions/session-service";
import type { ResolvedSession, SessionTransport } from "../../../../src/transport/types";
import {
  MemoryConfigStore,
  MemoryStateStore,
  createConfig,
  createEmptyState,
  createTransport,
} from "../command-router-test-support";

beforeEach(() => {
  setLocale("zh");
});

function buildSharedRouter() {
  const config = createConfig();
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);
  const transport = createTransport();
  const calls: Array<{ op: "release" | "delete"; logicalSessionId?: string; rowPresentAtCall: boolean }> = [];
  transport.releaseLogicalSession = mock(async (session: ResolvedSession) => {
    calls.push({
      op: "release",
      logicalSessionId: session.logicalSessionId,
      rowPresentAtCall: (await sessions.getSession(session.alias)) !== null,
    });
  });
  const innerDelete = transport.deleteSession as ReturnType<typeof mock>;
  transport.deleteSession = mock(async (session: ResolvedSession) => {
    calls.push({
      op: "delete",
      logicalSessionId: session.logicalSessionId,
      rowPresentAtCall: (await sessions.getSession(session.alias)) !== null,
    });
    await innerDelete(session);
  });
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  return { router, transport, sessions, state, calls };
}

async function makeSharedPair(router: CommandRouter, sessions: SessionService, state: ReturnType<typeof createEmptyState>) {
  await router.handle("wx:user", "/session new shr-a --agent codex --ws backend");
  const transportSession = sessions.getResolvedSessionByInternalAlias("shr-a")!.transportSession;
  await router.handle("wx:user", `/session attach shr-b --agent codex --ws backend --name ${transportSession}`);
  expect(sessions.getResolvedSessionByInternalAlias("shr-b")!.transportSession).toBe(transportSession);
  // Bind both aliases to the Runtime engine (white-box setup: affinity is
  // otherwise resolved from config + capability probe).
  state.sessions["shr-a"]!.transport_engine = "runtime";
  state.sessions["shr-b"]!.transport_engine = "runtime";
  return transportSession;
}

test("rm non-last shared alias releases Runtime LID state and keeps the physical session", async () => {
  const { router, transport, sessions, state, calls } = buildSharedRouter();
  await makeSharedPair(router, sessions, state);

  await router.handle("wx:user", "/session rm shr-a");

  expect(calls.filter((c) => c.op === "release")).toHaveLength(1);
  expect(calls.filter((c) => c.op === "delete")).toHaveLength(0);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect(await sessions.getSession("shr-a")).toBeNull();
  expect(await sessions.getSession("shr-b")).not.toBeNull();
});

test("rm last shared alias hard-deletes before the logical row disappears", async () => {
  const { router, transport, sessions, state, calls } = buildSharedRouter();
  await makeSharedPair(router, sessions, state);
  await router.handle("wx:user", "/session rm shr-a");
  expect(await sessions.getSession("shr-a")).toBeNull();

  await router.handle("wx:user", "/session rm shr-b");

  expect(calls.filter((c) => c.op === "delete")).toHaveLength(1);
  // The physical delete ran while the logical row still existed (retry
  // handle preserved until verified success).
  expect(calls.find((c) => c.op === "delete")!.rowPresentAtCall).toBe(true);
  expect(await sessions.getSession("shr-a")).toBeNull();
  expect(await sessions.getSession("shr-b")).toBeNull();
});

test("rm last shared alias keeps the logical row when the physical delete fails", async () => {
  const { router, transport, sessions, state } = buildSharedRouter();
  await makeSharedPair(router, sessions, state);
  await router.handle("wx:user", "/session rm shr-a");
  expect(await sessions.getSession("shr-a")).toBeNull();

  // The physical hard delete fails: the logical row must survive so the
  // user keeps a retry handle (previously this degraded to an unretryable
  // warning with the row already gone).
  (transport.deleteSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("physical delete boom");
  });
  await expect(router.handle("wx:user", "/session rm shr-b")).rejects.toThrow(/physical delete boom/);
  expect(await sessions.getSession("shr-b")).not.toBeNull();
});

test("rm non-last shared alias keeps the logical row when the Runtime release fails", async () => {
  const { router, transport, sessions, state } = buildSharedRouter();
  await makeSharedPair(router, sessions, state);

  // Active-turn-style refusal from the engine: the logical row stays.
  (transport.releaseLogicalSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("cannot release logical session while turn active");
  });
  await expect(router.handle("wx:user", "/session rm shr-a")).rejects.toThrow(/turn active/);
  expect(await sessions.getSession("shr-a")).not.toBeNull();
  expect(await sessions.getSession("shr-b")).not.toBeNull();
});
