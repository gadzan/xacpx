import { expect, mock, test } from "bun:test";

import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  assertNativeSessionAddressable,
  filterAddressableNativeSessions,
  inspectProductOwnedNativeSessions,
  nativeCatalogIdentity,
  sameNativeCatalog,
  type NativeCatalogIdentity,
} from "../../../src/sessions/native-session-guard";
import { createBotDirectOwner, type LogicalSession } from "../../../src/state/types";
import type { ResolvedSession } from "../../../src/transport/types";

function record(overrides: Partial<LogicalSession> & Pick<LogicalSession, "alias">): LogicalSession {
  return {
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${overrides.alias}`,
    logical_session_id: `id-${overrides.alias}`,
    created_at: "2026-09-16T12:00:00.000Z",
    last_used_at: "2026-09-16T12:00:00.000Z",
    ...overrides,
  };
}

const BACKEND = nativeCatalogIdentity({
  cwd: "/tmp/backend",
  driver: "codex",
  acpxAgent: "codex",
});

const FRONTEND = nativeCatalogIdentity({
  cwd: "/tmp/frontend",
  driver: "claude",
  acpxAgent: "claude",
});

function lookup(opts: {
  records: LogicalSession[];
  catalogs?: Record<string, NativeCatalogIdentity>;
  nativeIds?: Record<string, string | undefined>;
  getAgentSessionId?: (session: ResolvedSession) => Promise<string | undefined>;
  omitGetAgentSessionId?: boolean;
  unresolved?: string[];
}) {
  const unresolved = new Set(opts.unresolved ?? []);
  const getAgentSessionId = opts.omitGetAgentSessionId
    ? undefined
    : mock(opts.getAgentSessionId ?? (async (session: ResolvedSession) => opts.nativeIds?.[session.alias]));
  return {
    sessions: {
      listLogicalSessionRecords: () => opts.records,
      getResolvedSessionByInternalAlias: (alias: string) => {
        if (unresolved.has(alias)) return null;
        const found = opts.records.find((session) => session.alias === alias);
        if (!found) return null;
        const catalog = opts.catalogs?.[alias] ?? BACKEND;
        return {
          alias: found.alias,
          agent: found.agent,
          workspace: found.workspace,
          cwd: catalog.cwd,
          driver: catalog.driver,
          agentCommand: catalog.agentCommand,
          acpxAgent: catalog.acpxAgent,
          rawCommand: catalog.rawCommand,
        } as ResolvedSession;
      },
    },
    transport: {
      ...(getAgentSessionId ? { getAgentSessionId } : {}),
    },
    getAgentSessionId,
  };
}

const OWNER = createBotDirectOwner({
  bindingId: "bind_1",
  botId: "bot_1",
  conversationId: "conversation_1",
  topicId: "topic_1",
});

test("sameNativeCatalog is cwd path-equivalence plus launch identity, not labels", () => {
  expect(sameNativeCatalog(BACKEND, nativeCatalogIdentity({
    cwd: "/tmp/./backend",
    driver: "codex",
    acpxAgent: "codex",
  }))).toBe(true);
  expect(sameNativeCatalog(BACKEND, nativeCatalogIdentity({
    cwd: "/tmp/backend",
    driver: "codex",
    acpxAgent: "codex2",
  }))).toBe(false);
  expect(sameNativeCatalog(BACKEND, FRONTEND)).toBe(false);
});

test("persisted product-owned native IDs are proven without reverse lookup", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect([...inspected.ownedIds]).toEqual(["N1"]);
  expect(inspected.unproven).toBe(false);
  expect(ctx.getAgentSessionId).toBeDefined();
  expect(ctx.getAgentSessionId?.mock.calls.length).toBe(0);

  const listed = await filterAddressableNativeSessions(ctx, BACKEND, [
    { sessionId: "N1" },
    { sessionId: "N2" },
  ]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);

  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2")).resolves.toBeUndefined();
});

test("missing persisted id reverse-looks up via getAgentSessionId", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    nativeIds: { brt_hidden: "N1" },
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect([...inspected.ownedIds]).toEqual(["N1"]);
  expect(inspected.unproven).toBe(false);
  expect(ctx.getAgentSessionId?.mock.calls.length).toBe(1);

  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N1"))
    .rejects.toBeInstanceOf(ConversationError);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2")).resolves.toBeUndefined();
});

test("unproven product-owned candidate fail-closes attach instead of guessing", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    omitGetAgentSessionId: true,
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(true);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
  const listed = await filterAddressableNativeSessions(ctx, BACKEND, [{ sessionId: "N2" }]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
});

test("getAgentSessionId failure is unproven, not a free pass", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    getAgentSessionId: async () => {
      throw new Error("show failed");
    },
  });
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
});

test("unresolvable product-owned session fail-closes rather than assuming a different catalog", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
    unresolved: ["brt_hidden"],
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(true);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
});

test("ordinary sessions and other native catalogs do not occupy this catalog", async () => {
  const ctx = lookup({
    records: [
      record({ alias: "plain", agent_session_id: "N1" }),
      record({
        alias: "brt_other",
        agent: "claude",
        workspace: "frontend",
        owner: OWNER,
        agent_session_id: "N1",
      }),
    ],
    catalogs: {
      plain: BACKEND,
      brt_other: FRONTEND,
    },
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(false);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N1")).resolves.toBeUndefined();
});

test("workspace labels that share cwd occupy the same native catalog", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", workspace: "backend", owner: OWNER, agent_session_id: "N1" })],
  });
  const viaAlias = nativeCatalogIdentity({
    cwd: "/tmp/backend",
    driver: "codex",
    acpxAgent: "codex",
  });
  const listed = await filterAddressableNativeSessions(ctx, viaAlias, [
    { sessionId: "N1" },
    { sessionId: "N2" },
  ]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
  await expect(assertNativeSessionAddressable(ctx, viaAlias, "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  await expect(assertNativeSessionAddressable(ctx, viaAlias, "N2")).resolves.toBeUndefined();
});

test("agent aliases that share launch identity occupy the same native catalog", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", agent: "codex", owner: OWNER, agent_session_id: "N1" })],
  });
  const otherAlias = nativeCatalogIdentity({
    cwd: "/tmp/backend",
    driver: "codex",
    acpxAgent: "codex",
    agentCommand: BACKEND.agentCommand,
  });
  await expect(assertNativeSessionAddressable(ctx, otherAlias, "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  const listed = await filterAddressableNativeSessions(ctx, otherAlias, [{ sessionId: "N1" }, { sessionId: "N2" }]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
});

test("a different cwd is a different native catalog even with the same agent label", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
  });
  const otherCwd = nativeCatalogIdentity({
    cwd: "/tmp/other",
    driver: "codex",
    acpxAgent: "codex",
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, otherCwd);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(false);
  await expect(assertNativeSessionAddressable(ctx, otherCwd, "N1")).resolves.toBeUndefined();
});
