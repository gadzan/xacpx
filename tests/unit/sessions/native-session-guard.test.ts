import { expect, mock, test } from "bun:test";

import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  assertNativeSessionAddressable,
  filterAddressableNativeSessions,
  inspectProductOwnedNativeSessions,
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

function lookup(opts: {
  records: LogicalSession[];
  nativeIds?: Record<string, string | undefined>;
  getAgentSessionId?: (session: ResolvedSession) => Promise<string | undefined>;
  omitGetAgentSessionId?: boolean;
}) {
  const getAgentSessionId = opts.omitGetAgentSessionId
    ? undefined
    : mock(opts.getAgentSessionId ?? (async (session: ResolvedSession) => opts.nativeIds?.[session.alias]));
  return {
    sessions: {
      listLogicalSessionRecords: () => opts.records,
      getResolvedSessionByInternalAlias: (alias: string) => {
        const found = opts.records.find((session) => session.alias === alias);
        return found ? { alias: found.alias, agent: found.agent, workspace: found.workspace } as ResolvedSession : null;
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

test("persisted product-owned native IDs are proven without reverse lookup", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, "codex", "backend");
  expect([...inspected.ownedIds]).toEqual(["N1"]);
  expect(inspected.unproven).toBe(false);
  expect(ctx.getAgentSessionId).toBeDefined();
  expect(ctx.getAgentSessionId?.mock.calls.length).toBe(0);

  const listed = await filterAddressableNativeSessions(ctx, "codex", "backend", [
    { sessionId: "N1" },
    { sessionId: "N2" },
  ]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);

  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N2")).resolves.toBeUndefined();
});

test("missing persisted id reverse-looks up via getAgentSessionId", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    nativeIds: { brt_hidden: "N1" },
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, "codex", "backend");
  expect([...inspected.ownedIds]).toEqual(["N1"]);
  expect(inspected.unproven).toBe(false);
  expect(ctx.getAgentSessionId?.mock.calls.length).toBe(1);

  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N1"))
    .rejects.toBeInstanceOf(ConversationError);
  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N2")).resolves.toBeUndefined();
});

test("unproven product-owned candidate fail-closes attach instead of guessing", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    omitGetAgentSessionId: true,
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, "codex", "backend");
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(true);
  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
  const listed = await filterAddressableNativeSessions(ctx, "codex", "backend", [{ sessionId: "N2" }]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
});

test("getAgentSessionId failure is unproven, not a free pass", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    getAgentSessionId: async () => {
      throw new Error("show failed");
    },
  });
  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
});

test("ordinary sessions and other agent/workspace owners do not occupy the catalog", async () => {
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
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, "codex", "backend");
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(false);
  await expect(assertNativeSessionAddressable(ctx, "codex", "backend", "N1")).resolves.toBeUndefined();
});
