import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher, type ConversationDispatcherHooks } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type { ConversationTurnRunInput } from "../../../src/conversations/conversation-turn-runner";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T00:01:00.000Z";
const A = "bot_a", B = "bot_b", C = "bot_c";

async function harness(hooks?: ConversationDispatcherHooks) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-quarantine-start-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = { async save(_state: AppState) {}, async saveNow(_state: AppState) {} };
  const stateMutex = new AsyncMutex();
  const config = { agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: tmpdir() } },
    transport: { type: "acpx-cli" }, channel: { type: "weixin" }, channels: [], plugins: [] } as unknown as AppConfig;
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: {
    async releaseLogicalSession() {}, async deleteSession() {},
  } });
  let nextId = 0;
  const bots = new BotService(config, state, stateStore, { stateMutex, createId: () => [A, B, C][nextId++]! });
  for (const name of ["A", "B", "C"]) await bots.createBot({ name, agent: "codex", workspace: "backend" });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, { stateMutex, releaseOwnedSession });
  const calls: ConversationTurnRunInput[] = [];
  let handoffs!: GroupHandoffService;
  const runner = { async run(input: ConversationTurnRunInput) {
    calls.push(input);
    if (input.botId === A) await handoffs.send({ executionToken: input.groupExecutionToken!,
      invocationId: "quarantine-target", args: { to: B, task: "downstream assignment" } });
    return { status: "completed" as const, text: `healthy ${input.botId}` };
  }, async cancel() { return { outcome: "cancelled" as const }; } };
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions,
    { now: () => new Date(NOW), ownerId: "owner", authorityEpoch: "epoch", hooks });
  const runs = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore,
    { stateMutex, releaseOwnedSession, autoKick: false });
  handoffs = new GroupHandoffService({ store, bots, state, now: () => new Date(NOW), wake: () => { void dispatcher.kick(); } });
  dispatcher.setHandoffService(handoffs);
  const group = await bots.createGroup({ title: "Start fences", botIds: [A, B, C] });
  const topic = await runs.createGroupTopic(group.id, "Public", { workspace: "backend", isolation: "shared-single-writer" });
  const accept = () => runs.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "request", text: "public request", target: { botId: A } });
  return { path, store, state, calls, dispatcher, handoffs, group, topic, accept };
}

test("valid durable quarantine rejects execution-start and rolls back start evidence", async () => {
  const h = await harness();
  try {
    const accepted = await h.accept();
    const work = h.store.claimNextDispatch({ owner: "owner", authorityEpoch: "epoch", now: NOW, leaseExpiresAt: LEASE })!;
    h.store.directWriteForTest("runs", accepted.run.id, { quarantined_bot_ids_json: JSON.stringify([A]) });
    expect(() => h.store.markExecutionStarted({ dispatchId: work.dispatch.id, owner: "owner", generation: work.dispatch.generation,
      runId: accepted.run.id, memberTurnId: work.memberTurn.id, sessionAlias: "alias", logicalSessionId: "logical", sourceTurnId: "source", now: NOW }))
      .toThrow(expect.objectContaining({ code: "member_quarantined" }));
    expect(h.store.getMemberTurn(work.memberTurn.id)).toMatchObject({ state: "dispatched" });
    expect(h.store.getMemberTurn(work.memberTurn.id)?.startedAt).toBeUndefined();
    expect(h.store.getMemberTurn(work.memberTurn.id)?.sourceTurnId).toBeUndefined();
    expect(h.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(0);
    expect(h.store.getDispatchForMemberTurn(work.memberTurn.id)?.state).toBe("claimed");
  } finally { h.handoffs.close(); h.store.close(); }
});

test("valid durable quarantine rejects runtime materialization authorization", async () => {
  const h = await harness();
  try {
    const accepted = await h.accept();
    const work = h.store.claimNextDispatch({ owner: "owner", authorityEpoch: "epoch", now: NOW, leaseExpiresAt: LEASE })!;
    h.store.directWriteForTest("runs", accepted.run.id, { quarantined_bot_ids_json: JSON.stringify([A]) });
    expect(() => h.store.assertLiveDispatchForMaterialize({ dispatchId: work.dispatch.id, owner: "owner", generation: work.dispatch.generation,
      runId: accepted.run.id, memberTurnId: work.memberTurn.id, conversationId: h.group.id, topicId: h.topic.id, now: NOW }))
      .toThrow(expect.objectContaining({ code: "member_quarantined" }));
    expect(Object.keys(h.state.sessions)).toHaveLength(0);
    expect(h.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(0);
  } finally { h.handoffs.close(); h.store.close(); }
});

for (const phase of ["beforeRuntimeMaterialize", "beforeExecutionStart"] as const) {
  test(`quarantine after claim at ${phase} prevents target execution and settles its claim`, async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({ [phase]: async (work) => {
      if (work.memberTurn.botId === B) {
        // Controlled durable-state restoration: normal same-Bot admission is
        // serialized, but neither awaited fence may trust the initial Run read.
        h.store.directWriteForTest("runs", work.run.id, { quarantined_bot_ids_json: JSON.stringify([B]) });
      }
    } });
    try {
      const accepted = await h.accept();
      await h.dispatcher.kick();
      expect(h.calls.map((input) => input.botId)).toEqual([A]);
      const members = h.store.listMemberTurns(accepted.run.id);
      expect(members).toHaveLength(2);
      expect(members[0]?.state).toBe("completed");
      expect(members[1]).toMatchObject({ botId: B, origin: "handoff", state: "failed", failureReason: "member_quarantined" });
      expect(members[1]?.startedAt).toBeUndefined();
      expect(members[1]?.sourceTurnId).toBeUndefined();
      expect(h.store.getDispatchForMemberTurn(members[1]!.id)?.state).toBe("completed");
      expect(h.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", consumedMemberTurns: 2, quarantinedBotIds: [B] });
      expect(h.store.getMemberResult(members[0]!)?.content).toBe("healthy bot_a");
      expect(Object.values(h.state.sessions).filter((session) => session.owner?.botId === B))
        .toHaveLength(phase === "beforeRuntimeMaterialize" ? 0 : 1);
      await h.dispatcher.kick();
      expect(h.calls.map((input) => input.botId)).toEqual([A]);
      const reopened = await SqliteConversationStore.open(h.path);
      try {
        expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: "failed", consumedMemberTurns: 2, quarantinedBotIds: [B] });
        expect(reopened.getDispatchForMemberTurn(members[1]!.id)?.state).toBe("completed");
      } finally { reopened.close(); }
    } finally { h.handoffs.close(); h.store.close(); }
  });
}

for (const quarantine of [[], [C]]) {
  test(`start fences preserve eligible members with quarantine ${JSON.stringify(quarantine)}`, async () => {
    const h = await harness();
    try {
      const accepted = await h.accept();
      h.store.directWriteForTest("runs", accepted.run.id, { quarantined_bot_ids_json: JSON.stringify(quarantine) });
      await h.dispatcher.kick();
      expect(h.calls.map((input) => input.botId)).toEqual([A, B]);
      expect(h.store.getRun(accepted.run.id)).toMatchObject({ state: "completed", consumedMemberTurns: 2 });
      expect(h.store.listMemberTurns(accepted.run.id).map((member) => member.state)).toEqual(["completed", "completed"]);
    } finally { h.handoffs.close(); h.store.close(); }
  });
}
