import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { BotService } from "../../../src/bots/bot-service";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { snapshotGroupMemberProfile } from "../../../src/bots/bot-types";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import { GroupHandoffService, parseGroupSend } from "../../../src/conversations/group-handoff";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import type { ConversationTurnRunInput, ConversationTurnRunResult, ConversationTurnCancelInput, ConversationTurnCancelResult } from "../../../src/conversations/conversation-turn-runner";
import type { ConversationProductEvent } from "../../../src/conversations/conversation-product-events";
import { ConversationRouterEngine } from "../../../src/conversations/conversation-router-engine";
import type { ConversationRouter } from "../../../src/conversations/conversation-router-types";
import type { AppConfig } from "../../../src/config/types";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { createEmptyState, type AppState } from "../../../src/state/types";
import { toConversationMessage, toConversationRun } from "../../../src/control/conversation-control-dtos";
import { validControlEvent } from "@ganglion/xacpx-relay-protocol";
import { createDirectConversationId } from "../../../src/domain/ids";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T00:01:00.000Z", EXPIRED = "2026-10-05T00:02:00.000Z";
const A = "bot_a", B = "bot_b", C = "bot_c";
const RESTRICTED = { toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true,
  permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true, structuredOutputOnly: true } as const;

async function harness(options: { onRun?: (input: ConversationTurnRunInput) => Promise<ConversationTurnRunResult>;
  enforcedReaders?: boolean;
  onCancel?: (input: ConversationTurnCancelInput) => Promise<ConversationTurnCancelResult>;
  beforeCommitGates?: () => Promise<void>; router?: ConversationRouter; pr8Fixture?: "queued" | "claimed" } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-pr9-")), "conversations.sqlite");
  if (options.pr8Fixture) {
    const db = await createSqlDriver(path);
    try { db.exec(readFileSync(join(import.meta.dir, "fixtures", `pr8-explicit-${options.pr8Fixture}.sql`), "utf8")); }
    finally { db.close(); }
  }
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const config = { agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: tmpdir() } },
    transport: { type: "acpx-cli" }, channel: { type: "weixin" }, channels: [], plugins: [] } as unknown as AppConfig;
  const stateStore = { async save(_state: AppState) {}, async saveNow(_state: AppState) {} };
  if (options.enforcedReaders) {
    config.agents.codex!.driver = "claude";
    config.transport.adapterVersions = { claude: "0.78.0" };
  }
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: {
    async deleteSession() {}, async releaseLogicalSession() {},
  } });
  let nextId = 0;
  const bots = new BotService(config, state, stateStore, { stateMutex, createId: () => [A, B, C][nextId++]! });
  for (const name of ["A", "B", "C"]) await bots.createBot({ name, agent: "codex", workspace: "backend" });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, { stateMutex, releaseOwnedSession });
  const calls: ConversationTurnRunInput[] = [], events: ConversationProductEvent[] = [];
  const runner = { async run(input: ConversationTurnRunInput) {
    calls.push(input); return options.onRun ? await options.onRun(input) : { status: "completed" as const, text: `result ${input.memberTurnId}` };
  }, async cancel(input: ConversationTurnCancelInput) { return options.onCancel ? await options.onCancel(input) : { outcome: "cancelled" as const }; } };
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions,
    { ownerId: "owner-a", authorityEpoch: "human-epoch", onProductEvent: (event) => events.push(event) });
  const engine = options.router ? new ConversationRouterEngine(options.router, { store,
    readGroup: (id) => state.conversations[id], readTopic: (_id, id) => state.conversation_topics[id], readBot: (id) => bots.getBot(id),
    runLifecycleAll: (ids, critical) => bots.runLifecycleAll(ids, critical), now: () => new Date(NOW) }) : undefined;
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore,
    { stateMutex, releaseOwnedSession, autoKick: false, routerEngine: engine,
      ...(options.pr8Fixture ? { createTopicId: () => "topic_pr8_explicit" } : {}) });
  const handoffs = new GroupHandoffService({ store, bots, state, beforeCommitGates: options.beforeCommitGates,
    onProductEvent: (event) => events.push(event), wake: () => { void dispatcher.kick(); } });
  dispatcher.setHandoffService(handoffs);
  dispatcher.setAutomaticRoutingHandler((id) => service.trackAutomaticRouting(id));
  const group = await bots.createGroup({ title: "PR9", botIds: [A, B, C] });
  if (options.pr8Fixture) {
    delete state.conversations[group.id]; group.id = "conversation_pr8_explicit"; state.conversations[group.id] = group;
  }
  const topic = await service.createGroupTopic(group.id, "Public", { workspace: "backend", isolation: "shared-single-writer" });
  const accept = async (requestId = "human-request") => await service.acceptGroupPrompt({ conversationId: group.id,
    topicId: topic.id, requestId, text: "INITIAL HUMAN REQUEST", target: { botId: A },
    humanIngress: { chatKey: "relay:test", senderId: "human", chatType: "direct" } });
  const send = async (input: ConversationTurnRunInput, invocationId = "call-1", args: unknown = { to: B, task: "HANDOFF TASK", expectedOutput: "EXPECTED OUTPUT" }) =>
    await handoffs.send({ executionToken: input.groupExecutionToken!, invocationId, args });
  return { path, store, state, bots, runtime, calls, events, sessions, service, handoffs, dispatcher, group, topic, accept, send, engine };
}

type Harness = Awaited<ReturnType<typeof harness>>;

test("public handoff and explicit siblings share the existing single-writer scheduler", async () => {
  let h!: Harness, active = 0, peak = 0;
  h = await harness({ onRun: async (input) => {
    active++; peak = Math.max(peak, active);
    try {
      if (input.botId === A) await h.send(input);
      await Promise.resolve();
      return { status: "completed", text: `public ${input.botId}` };
    } finally { active--; }
  } });
  try {
    const accepted = await h.service.acceptGroupPrompt({ conversationId: h.group.id, topicId: h.topic.id,
      requestId: "siblings", text: "public request", target: { mode: "members", botIds: [A, C] } });
    await h.dispatcher.kick();
    expect(h.calls.map((call) => call.botId)).toEqual([A, C, B]); expect(peak).toBe(1);
    expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
    const target = h.store.listMemberTurns(accepted.run.id)[2]!;
    expect(target.origin).toBe("handoff"); expect(target.effect ?? "unknown").toBe("unknown");
    expect(h.calls[2]?.text).not.toContain(`Bot ${C}: public ${C}`);
  } finally { h.store.close(); }
});

test("human cancel physically cancels the exact active handoff and late output stays evidence only", async () => {
  const entered = Promise.withResolvers<ConversationTurnRunInput>();
  const settlement = Promise.withResolvers<ConversationTurnRunResult>();
  const cancels: ConversationTurnCancelInput[] = [];
  let h!: Harness;
  h = await harness({ onRun: async (input) => {
    if (input.botId === A) { await h.send(input); return { status: "completed", text: "healthy sender" }; }
    entered.resolve(input); return await settlement.promise;
  }, onCancel: async (input) => { cancels.push(input); settlement.resolve({ status: "completed", text: "late target evidence" });
    return { outcome: "completed", text: "late target evidence" }; } });
  try {
    const accepted = await h.accept(); const draining = h.dispatcher.kick(); const target = await entered.promise;
    await h.service.cancelRun(accepted.run.id); await draining;
    expect(cancels).toHaveLength(1); expect(cancels[0]?.promptRequestId).toBe(target.promptRequestId);
    // Existing cancel policy retains a proven completed physical outcome;
    // the terminal Run still cannot accept or schedule any downstream work.
    expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
    expect(h.store.getMemberResult(h.store.getMemberTurn(target.memberTurnId)!)?.content).toBe("late target evidence");
    expect(h.store.listMemberTurns(accepted.run.id)).toHaveLength(2);
    await expect(h.send(target, "after-cancel")).rejects.toBeDefined();
    expect(h.calls.map((call) => call.botId)).toEqual([A, B]);
  } finally { h.store.close(); }
});

async function scenario(body: (input: ConversationTurnRunInput, h: Harness) => Promise<void>, beforeCommitGates?: () => Promise<void>) {
  let h!: Harness;
  let failure: { error: unknown } | undefined;
  h = await harness({ beforeCommitGates, onRun: async (input) => {
    if (input.botId === A) {
      try { await body(input, h); } catch (error) { failure = { error }; throw error; }
    }
    return { status: "completed", text: `public result ${input.memberTurnId}` };
  } });
  const accepted = await h.accept();
  try { await h.dispatcher.kick(); if (failure) throw failure.error; return { h, accepted }; }
  catch (error) { h.handoffs.close(); h.store.close(); throw error; }
}

for (const field of ["from", "runId", "conversationId", "topicId", "authorityEpoch", "humanIngress", "senderMemberTurnId", "executionToken"]) {
  test(`group_send rejects model-controlled identity field ${field}`, () => {
    expect(() => parseGroupSend({ to: B, task: "task", [field]: "spoof" })).toThrow("accepts only");
  });
}
for (const args of [null, [], {}, { to: B, task: " " }, { to: 4, task: "task" }, { to: "x".repeat(129), task: "task" },
  { to: B, task: "x".repeat(16_001) }, { to: B, task: "task", expectedOutput: "x".repeat(8_001) }, { to: B, task: "a\u0000b" }]) {
  test(`bounded malformed group_send rejects ${JSON.stringify(args).slice(0, 80)}`, () => {
    expect(() => parseGroupSend(args)).toThrow();
  });
}

test("sender is derived from live execution and one invocation commits exactly once", async () => {
  const { h, accepted } = await scenario(async (input, h) => {
    const first = await h.send(input);
    const repeat = await h.send(input);
    expect(repeat.reused).toBe(true);
    expect(repeat.memberTurn.id).toBe(first.memberTurn.id);
    expect(repeat.message.id).toBe(first.message.id);
    expect(first.message.senderBotId).toBe(A);
    expect(first.message.handoff).toMatchObject({ senderMemberTurnId: input.memberTurnId, to: B });
    expect(h.store.listMemberTurns(input.runId)).toHaveLength(2);
    expect(first.run.id).toBe(input.runId);
    expect(h.store.listRuns(h.group.id)).toHaveLength(1);
    expect(h.store.getDispatchForMemberTurn(first.memberTurn.id)).toMatchObject({ state: "pending" });
    expect(h.store.getDispatchForMemberTurn(first.memberTurn.id)?.authorityEpoch).toBeUndefined();
    expect(h.store.getDispatchForMemberTurn(first.memberTurn.id)?.humanIngress).toBeUndefined();
  });
  try {
    expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
    expect(h.calls.map((call) => call.botId)).toEqual([A, B]);
    expect(h.calls[1]?.executionOrigin).toBe("orchestration");
    expect(h.calls[1]?.permissionRoute).toBeUndefined();
    expect(h.calls[1]?.text).toContain("Task:\nHANDOFF TASK");
    expect(h.calls[1]?.text).toContain("Expected output:\nEXPECTED OUTPUT");
    const envelopes = h.store.listMessages({ conversationId: h.group.id, topicId: h.topic.id, limit: 100 }).filter((m) => m.handoff);
    expect(envelopes).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "conversation-message" && e.message.handoff)).toHaveLength(1);
    expect(validControlEvent({ type: "conversation-message", message: toConversationMessage(envelopes[0]!) })).toBe(true);
    expect(h.events.some((e) => JSON.stringify(e).includes("group-execution:"))).toBe(false);
  } finally { h.store.close(); }
});

test("reusing invocation with different arguments fails closed", async () => {
  const { h } = await scenario(async (input, h) => {
    await h.send(input);
    await expect(h.send(input, "call-1", { to: B, task: "different" })).rejects.toMatchObject({ code: "handoff_idempotency_conflict" });
    expect(h.store.listMemberTurns(input.runId)).toHaveLength(2);
  }); h.store.close();
});

test("handoff commit rejects a corrupted human request snapshot", async () => {
  const { h } = await scenario(async (input, h) => {
    const request = h.store.getRun(input.runId)!.requestMessageId;
    h.store.directWriteForTest("messages", request, { role: "bot" });
    try { await expect(h.send(input)).rejects.toMatchObject({ code: "request_snapshot_mismatch" }); }
    finally { h.store.directWriteForTest("messages", request, { role: "human" }); }
    expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
  }); h.store.close();
});

test("handoff replay proves exact durable sender source identity", async () => {
  const { h } = await scenario(async (input, h) => {
    const receipt = await h.send(input);
    h.store.directWriteForTest("member_turns", input.memberTurnId, { source_turn_id: "corrupt-source" });
    try { await expect(h.send(input)).rejects.toMatchObject({ code: "handoff_envelope_mismatch" }); }
    finally { h.store.directWriteForTest("member_turns", input.memberTurnId, { source_turn_id: input.promptRequestId }); }
    expect(h.store.listMemberTurns(input.runId)).toHaveLength(2);
    expect((await h.send(input)).message.id).toBe(receipt.message.id);
  }); h.store.close();
});

test("public handoff cannot bypass Run quarantine or change global Bot enabled state", async () => {
  const { h } = await scenario(async (input, h) => {
    h.store.directWriteForTest("runs", input.runId, { quarantined_bot_ids_json: JSON.stringify([B]) });
    await expect(h.send(input)).rejects.toMatchObject({ code: "handoff_quarantined_member" });
    expect(h.bots.getBot(B).enabled).toBe(true); expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
  }); h.store.close();
});

for (const corrupt of ["{", "null", "{}", "true", '"bot_b"', '["bot_b",17]', "", " "]) {
  test(`corrupt quarantine rejects handoff without work or budget debit: ${JSON.stringify(corrupt)}`, async () => {
    const { h } = await scenario(async (input, h) => {
      const before = h.store.getRun(input.runId)!;
      h.store.directWriteForTest("runs", input.runId, { quarantined_bot_ids_json: corrupt });
      try { await expect(h.send(input)).rejects.toMatchObject({ code: "run_corrupt" }); }
      finally { h.store.directWriteForTest("runs", input.runId, { quarantined_bot_ids_json: JSON.stringify([B]) }); }
      expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
      expect(h.store.getRun(input.runId)?.consumedMemberTurns).toBe(before.consumedMemberTurns);
      expect(h.bots.getBot(B).enabled).toBe(true);
      expect(h.store.listMessages({ conversationId: h.group.id, topicId: h.topic.id, limit: 100 }).filter((m) => m.handoff)).toHaveLength(0);
    }); h.store.close();
  });

  test(`corrupt quarantine blocks Router before a model decision: ${JSON.stringify(corrupt)}`, async () => {
    let decisions = 0;
    const h = await harness({ router: { capabilityRestriction: RESTRICTED, async decide() {
      decisions++; return { type: "dispatch", mode: "single", assignments: [{ id: "B", botId: B, task: "unsafe", triggerMessageIds: [] }] };
    } } });
    try {
      const accepted = h.store.acceptRequest({ conversationId: h.group.id, topicId: h.topic.id,
        requestId: "automatic", botId: A, content: "request", mode: "automatic", members: [], now: NOW,
        profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(A), h.topic.executionTarget!, NOW) });
      h.store.directWriteForTest("runs", accepted.run.id, { quarantined_bot_ids_json: corrupt });
      await expect(h.engine!.route(accepted.run.id)).rejects.toMatchObject({ code: "run_corrupt" });
      expect(decisions).toBe(0); expect(h.calls).toHaveLength(0);
      expect(h.store.listMemberTurns(accepted.run.id)).toHaveLength(0);
    } finally { h.store.close(); }
  });

  test(`corrupt quarantine blocks the durable execution-start fence: ${JSON.stringify(corrupt)}`, async () => {
    const h = await harness();
    try {
      const accepted = await h.accept();
      const claim = h.store.claimNextDispatch({ owner: "test", authorityEpoch: "human-epoch", now: NOW, leaseExpiresAt: LEASE })!;
      h.store.directWriteForTest("runs", accepted.run.id, { quarantined_bot_ids_json: corrupt });
      expect(() => h.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "test", generation: claim.dispatch.generation,
        runId: accepted.run.id, memberTurnId: accepted.memberTurn!.id, sessionAlias: "must-not-start",
        logicalSessionId: "logical", sourceTurnId: "source", now: NOW })).toThrow("malformed quarantine");
      expect(h.store.getMemberTurn(accepted.memberTurn!.id)?.startedAt).toBeUndefined();
      expect(h.store.getMemberTurn(accepted.memberTurn!.id)?.sourceTurnId).toBeUndefined();
      expect(h.calls).toHaveLength(0);
    } finally { h.store.close(); }
  });
}

test("distinct nonmember targets never enter lifecycle gates or spend Run budget", async () => {
  const { h } = await scenario(async (input, h) => {
    const gate = spyOn(h.bots, "runLifecycleAll");
    try {
      const before = h.store.getRun(input.runId)!;
      for (let i = 0; i < 256; i++) {
        await expect(h.send(input, `invalid-${i}`, { to: `bot_nonmember_${i}`, task: "task" }))
          .rejects.toMatchObject({ code: "handoff_not_member" });
      }
      expect(gate).not.toHaveBeenCalled();
      expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
      expect(h.store.getRun(input.runId)?.consumedMemberTurns).toBe(before.consumedMemberTurns);
      await h.send(input, "valid-target");
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate.mock.calls[0]?.[0]).toEqual([A, B]);
    } finally { gate.mockRestore(); }
  }); h.store.close();
});

test("a missing target Bot cannot allocate a lifecycle gate through stale membership", async () => {
  const { h } = await scenario(async (input, h) => {
    const gate = spyOn(h.bots, "runLifecycleAll"), target = h.state.bots[B]!;
    delete h.state.bots[B];
    try {
      await expect(h.send(input)).rejects.toMatchObject({ code: "bot_not_found" });
      expect(gate).not.toHaveBeenCalled(); expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
    } finally { h.state.bots[B] = target; gate.mockRestore(); }
  }); h.store.close();
});

for (const recovery of ["owner", "lease"] as const) {
  test(`corrupt quarantine survives restart and blocks ${recovery} claim recovery`, async () => {
    const h = await harness();
    const accepted = await h.accept();
    const claim = h.store.claimNextDispatch({ owner: "old-owner", authorityEpoch: "human-epoch", now: NOW, leaseExpiresAt: LEASE })!;
    h.store.directWriteForTest("runs", accepted.run.id, { quarantined_bot_ids_json: "[" });
    h.store.close();
    const reopened = await SqliteConversationStore.open(h.path);
    try {
      expect(() => reopened.getRun(accepted.run.id)).toThrow("malformed quarantine");
      expect(() => recovery === "owner" ? reopened.convergePreviousOwnerClaims("new-owner", EXPIRED)
        : reopened.recoverExpiredClaims(EXPIRED)).toThrow("malformed quarantine");
      expect(reopened.getDispatchForMemberTurn(accepted.memberTurn!.id)).toMatchObject({
        state: claim.dispatch.state, generation: claim.dispatch.generation, owner: claim.dispatch.owner,
      });
      expect(reopened.getMemberTurn(accepted.memberTurn!.id)?.startedAt).toBeUndefined();
      expect(h.calls).toHaveLength(0);
    } finally { reopened.close(); }
  });
}

for (const status of ["completed", "failed"] as const) {
test(`explicit unknown evidence dominates a contradictory ${status} runner label`, async () => {
  let h!: Harness;
  h = await harness({ onRun: async (input) => {
    if (input.botId === A) { await h.send(input); return { status: "completed", text: "healthy" }; }
    return { status, unknown: true, text: "not proven", error: "not proven" };
  } });
  try {
    const accepted = await h.accept(); await h.dispatcher.kick(); await h.dispatcher.kick();
    expect(h.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
    expect(h.calls).toHaveLength(2);
    expect(h.store.listMemberTurns(accepted.run.id)[1]?.state).toBe("indeterminate");
  } finally { h.store.close(); }
});
}

for (const race of ["nonmember", "removed", "disabled", "deleted", "topic-delete", "conversation-delete", "binding", "cancel"] as const) {
  test(`handoff ${race} race rejects before any new durable work`, async () => {
    let hRef: Harness | undefined;
    const { h } = await scenario(async (input, h) => {
      hRef = h;
      const args = race === "nonmember" ? { to: "bot_outside", task: "task" } : undefined;
      if (race === "binding") h.state.sessions[input.sessionAlias]!.owner!.botId = C;
      if (race === "cancel") h.store.cancelRun(input.runId, NOW);
      await expect(h.send(input, "call-1", args)).rejects.toBeDefined();
      expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
      expect(h.store.listMessages({ conversationId: h.group.id, topicId: h.topic.id, limit: 100 }).filter((m) => m.handoff)).toHaveLength(0);
    }, async () => {
      const h = hRef!;
      if (race === "removed") await h.bots.updateGroup(h.group.id, { botIds: [A, C] });
      if (race === "disabled") await h.bots.updateBot(B, { enabled: false });
      if (race === "deleted") { await h.bots.updateGroup(h.group.id, { botIds: [A, C] }); await h.bots.deleteBot(B); }
      if (race === "topic-delete") h.store.markTopicDeleting(h.topic.id, h.group.id, NOW);
      if (race === "conversation-delete") h.store.markConversationDeleting(h.group.id, NOW);
    }); h.store.close();
  });
}

test("old execution capability cannot identify a later turn on the same Bot", async () => {
  let token = "";
  const { h } = await scenario(async (input, h) => { token = input.groupExecutionToken!; await h.send(input); });
  try { await expect(h.handoffs.send({ executionToken: token, invocationId: "late", args: { to: B, task: "late" } }))
    .rejects.toMatchObject({ code: "group_execution_unknown" }); } finally { h.store.close(); }
});

test("handoff target sees exact current Run evidence without queued/private/other-Topic context", async () => {
  const { h } = await scenario(async (input, h) => {
    await h.service.acceptDirectPrompt({ botId: B, requestId: "private", content: "DIRECT SECRET" });
    const other = await h.service.createGroupTopic(h.group.id, "Other", { workspace: "backend", isolation: "shared" });
    await h.service.acceptGroupPrompt({ conversationId: h.group.id, topicId: other.id, requestId: "other", text: "OTHER TOPIC SECRET", target: { botId: C } });
    await h.service.acceptGroupPrompt({ conversationId: h.group.id, topicId: h.topic.id, requestId: "queued", text: "QUEUED FUTURE REQUEST", target: { botId: C } });
    await h.send(input);
  });
  try {
    const target = h.calls.find((call) => call.botId === B && call.conversationId === h.group.id)!;
    expect(target.text).toContain("HANDOFF TASK");
    expect(target.text).not.toContain("DIRECT SECRET");
    expect(target.text).not.toContain("OTHER TOPIC SECRET");
    expect(target.text).not.toContain("QUEUED FUTURE REQUEST");
  } finally { h.store.close(); }
});

test("handoff permission denial persists structured blocked reason on explicit Runs", async () => {
  let h!: Harness;
  h = await harness({ onRun: async (input) => {
    if (input.botId === A) { await h.send(input); return { status: "completed", text: "healthy sender" }; }
    return { status: "failed", error: "denied", blockedReason: "human-authority-unknown" };
  } });
  try {
    const accepted = await h.accept(); await h.dispatcher.kick();
    const turns = h.store.listMemberTurns(accepted.run.id);
    expect(turns[1]).toMatchObject({ origin: "handoff", state: "failed", blockedReason: "human-authority-unknown" });
    expect(h.store.getMemberResult(turns[0]!)?.content).toBe("healthy sender");
    expect(h.store.getRun(accepted.run.id)?.quarantinedBotIds).toEqual([B]);
    expect(h.bots.getBot(B).enabled).toBe(true);
    expect(toConversationRun(h.store.getRun(accepted.run.id)!)).toMatchObject({ quarantinedBotIds: [B] });
  } finally { h.store.close(); }
});

test("A to B to A handoffs are serialized and retain distinct exact results", async () => {
  let h!: Harness;
  h = await harness({ onRun: async (input) => {
    if (h.calls.length < 3) await h.send(input, "same-id-in-each-execution", { to: input.botId === A ? B : A, task: `TASK ${h.calls.length}` });
    return { status: "completed", text: `RESULT ${h.calls.length}` };
  } });
  try {
    const accepted = await h.accept(); await h.dispatcher.kick();
    const members = h.store.listMemberTurns(accepted.run.id);
    expect(h.calls.map((call) => call.botId)).toEqual([A, B, A]);
    expect(members.map((turn) => h.store.getMemberResult(turn)?.content)).toEqual(["RESULT 1", "RESULT 2", "RESULT 3"]);
    expect(new Set(members.map((turn) => turn.sourceTurnId)).size).toBe(3);
    expect(h.calls[2]?.text).toContain("RESULT 1");
    expect(h.calls[2]?.text).not.toContain("RESULT 2");
  } finally { h.store.close(); }
});

test("durable budget stops an A B handoff loop and survives reopen", async () => {
  let h!: Harness;
  h = await harness({ onRun: async (input) => {
    try { await h.send(input, "loop", { to: input.botId === A ? B : A, task: "continue" }); }
    catch (error) { expect(error).toMatchObject({ code: "budget-exhausted" }); }
    return { status: "completed", text: "done" };
  } });
  const accepted = await h.accept(); h.store.directWriteForTest("runs", accepted.run.id, { max_member_turns: "3" });
  await h.dispatcher.kick();
  expect(h.calls).toHaveLength(3);
  expect(h.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", completionReason: "budget-exhausted", consumedMemberTurns: 3 });
  h.store.close(); const reopened = await SqliteConversationStore.open(h.path);
  try { expect(reopened.getRun(accepted.run.id)?.completionReason).toBe("budget-exhausted"); expect(reopened.listMemberTurns(accepted.run.id)).toHaveLength(3); }
  finally { reopened.close(); }
});

async function startedStore(effect: "unknown" | "read-only" = "unknown", proof = false, max = 4) {
  const h = await harness({ enforcedReaders: effect === "read-only" && proof });
  const accepted = h.store.acceptRequest({ conversationId: h.group.id, topicId: h.topic.id, requestId: "store-request", botId: A,
    content: "human", profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(A), h.topic.executionTarget!, NOW),
    maxMemberTurns: max, primaryMember: { provenance: "router", assignmentId: "original", task: "ORIGINAL TASK", expectedOutput: "ORIGINAL OUTPUT",
      effect, ...(proof ? { effectProvenance: "declared-enforced" as const } : {}) }, now: NOW });
  const claim = h.store.claimNextDispatch({ owner: "dead-owner", authorityEpoch: "old", now: NOW, leaseExpiresAt: LEASE })!;
  const member = h.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "dead-owner", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: claim.memberTurn.id, sessionAlias: "old-session", logicalSessionId: "logical", sourceTurnId: "old-source", now: NOW });
  return { h, accepted, claim, member };
}

for (const recover of ["lease", "owner"] as const) {
  test(`potential writer started unknown ${recover} recovery seals and never retries`, async () => {
    const { h, accepted } = await startedStore();
    const rows = recover === "owner" ? h.store.convergePreviousOwnerClaims("new-owner", EXPIRED) : h.store.recoverExpiredClaims(EXPIRED);
    expect(rows[0]?.outcome).toBe("indeterminate");
    expect(h.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
    h.store.close(); const reopened = await SqliteConversationStore.open(h.path);
    try {
      expect(reopened.getRun(accepted.run.id)?.state).toBe("indeterminate");
      expect(reopened.claimNextDispatch({ owner: "new", authorityEpoch: "new", now: NOW, leaseExpiresAt: NOW })).toBeUndefined();
      expect(reopened.automaticRunsAwaitingRouting()).toEqual([]);
    } finally { reopened.close(); }
  });
  test(`enforced read-only ${recover} recovery retries once with assignment and authority intact`, async () => {
    const { h, accepted, member } = await startedStore("read-only", true);
    const recoverNow = () => recover === "owner" ? h.store.convergePreviousOwnerClaims("new-owner", EXPIRED) : h.store.recoverExpiredClaims(EXPIRED);
    expect(recoverNow()[0]?.outcome).toBe("requeued");
    const retry = h.store.getMemberTurn(member.id)!;
    expect(retry).toMatchObject({ assignmentId: "original", task: "ORIGINAL TASK", expectedOutput: "ORIGINAL OUTPUT", origin: "recovery", effect: "read-only", effectProvenance: "declared-enforced", attempt: 2 });
    expect(retry.triggerMessageIds).toEqual(member.triggerMessageIds);
    expect(h.store.getDispatchForMemberTurn(member.id)?.humanIngress).toBeUndefined();
    expect(h.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
    expect(recoverNow()).toEqual([]);
    const claim = h.store.claimNextDispatch({ owner: "dead-again", authorityEpoch: "new", now: NOW, leaseExpiresAt: LEASE })!;
    h.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "dead-again", generation: claim.dispatch.generation, runId: accepted.run.id,
      memberTurnId: member.id, sessionAlias: "old-session", logicalSessionId: "logical", sourceTurnId: "second-source", now: NOW });
    expect(recoverNow()[0]?.outcome).toBe("indeterminate");
    h.store.close();
  });
}

test("read-only declaration without enforced proof does not authorize retry", async () => {
  const { h, accepted } = await startedStore("read-only", false);
  h.store.convergePreviousOwnerClaims("new-owner", NOW);
  expect(h.store.getRun(accepted.run.id)?.state).toBe("indeterminate"); h.store.close();
});

test("cancellation blocks read-only recovery assignment creation", async () => {
  const { h, accepted } = await startedStore("read-only", true);
  h.store.cancelRun(accepted.run.id, NOW); h.store.convergePreviousOwnerClaims("new-owner", NOW);
  expect(h.store.getMemberTurn(accepted.memberTurn!.id)?.origin).toBe("router");
  expect(h.store.claimNextDispatch({ owner: "new", authorityEpoch: "new", now: NOW, leaseExpiresAt: NOW })).toBeUndefined(); h.store.close();
});

test("not-started recovery requeues without losing assignment task or spending again", async () => {
  const { h, accepted, member } = await startedStore();
  h.store.directWriteForTest("member_turns", member.id, { started_at: null, source_turn_id: null, state: "dispatched", blocked_reason: "human-authority-unknown", depends_on_json: '["dependency"]' });
  expect(h.store.recoverExpiredClaims(EXPIRED)[0]?.outcome).toBe("requeued");
  expect(h.store.getMemberTurn(member.id)).toMatchObject({ assignmentId: "original", task: "ORIGINAL TASK", expectedOutput: "ORIGINAL OUTPUT", dependsOn: ["dependency"], blockedReason: "human-authority-unknown", origin: "recovery" });
  expect(h.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(0); h.store.close();
});

test("handoff transaction rollback creates no stranded assignment or public envelope", async () => {
  let injected = false;
  const { h } = await scenario(async (input, h) => {
    const db = await createSqlDriver(h.path);
    db.exec("CREATE TRIGGER reject_handoff BEFORE INSERT ON pending_dispatches WHEN NEW.member_turn_id <> '' BEGIN SELECT RAISE(ABORT, 'crash before handoff commit'); END");
    try { await expect(h.send(input)).rejects.toBeDefined(); injected = true; }
    finally { db.exec("DROP TRIGGER reject_handoff"); db.close(); }
    expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
    expect(h.store.getPublicHandoff(input.promptRequestId, "call-1", { to: B, task: "HANDOFF TASK", expectedOutput: "EXPECTED OUTPUT" })).toBeUndefined();
  }); expect(injected).toBe(true); h.store.close();
});

for (const crashWindow of ["pending", "claimed-not-started"] as const) {
test(`committed handoff survives lost response/reopen ${crashWindow} and dropped result notification`, async () => {
  const { h, accepted } = await scenario(async (input, h) => {
    const receipt = await h.send(input);
    // Crash representation: current sender has durable completion; target is
    // still not started. Stop current drain before it can claim the target.
    h.dispatcher.stop();
    expect(receipt.memberTurn.startedAt).toBeUndefined();
  });
  const target = h.store.listMemberTurns(accepted.run.id)[1]!;
  const sender = h.store.listMemberTurns(accepted.run.id)[0]!;
  if (crashWindow === "claimed-not-started") {
    const claim = h.store.claimNextDispatch({ owner: "dead-target-owner", authorityEpoch: "old", now: NOW, leaseExpiresAt: LEASE })!;
    expect(claim.memberTurn.id).toBe(target.id); expect(claim.memberTurn.startedAt).toBeUndefined();
  }
  h.store.close(); const reopened = await SqliteConversationStore.open(h.path);
  try {
    reopened.convergePreviousOwnerClaims("restarted", NOW);
    const receipt = reopened.getPublicHandoff(sender.sourceTurnId!, "call-1", { to: B, task: "HANDOFF TASK", expectedOutput: "EXPECTED OUTPUT" })!;
    expect(receipt.memberTurn.id).toBe(target.id); expect(receipt.reused).toBe(true);
    const dispatcher = new ConversationDispatcher(reopened, h.runtime, { async run(input) { h.calls.push(input); return { status: "completed", text: "target done" }; }, async cancel() { return { outcome: "cancelled" }; } }, h.sessions,
      { ownerId: "restarted", onProductEvent: () => { throw new Error("notification connection dropped"); } });
    await dispatcher.kick(); await dispatcher.kick();
    expect(h.calls.filter((call) => call.memberTurnId === target.id)).toHaveLength(1);
    expect(reopened.listMessages({ conversationId: h.group.id, topicId: h.topic.id, limit: 100 }).filter((m) => m.handoff)).toHaveLength(1);
    expect(reopened.getRun(accepted.run.id)?.consumedMemberTurns).toBe(2);
    const result = reopened.getMemberResult(reopened.getMemberTurn(target.id)!)!;
    reopened.completeExecution({ runId: accepted.run.id, memberTurnId: target.id, content: "duplicate", sourceTurn: result.sourceTurn!, now: NOW });
    expect(reopened.listMessages({ conversationId: h.group.id, topicId: h.topic.id, limit: 100 }).filter((m) => m.senderBotId === B && m.role === "bot")).toHaveLength(1);
  } finally { reopened.close(); }
});
}

test("started recovery attempt requires exact physical failure and cancel identity", async () => {
  const { h, accepted, member } = await startedStore("read-only", true);
  try {
    h.store.convergePreviousOwnerClaims("new", NOW);
    const claim = h.store.claimNextDispatch({ owner: "new", authorityEpoch: "new", now: NOW, leaseExpiresAt: LEASE })!;
    h.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "new", generation: claim.dispatch.generation,
      runId: accepted.run.id, memberTurnId: member.id, sessionAlias: "new-session", logicalSessionId: "logical", sourceTurnId: "new-source", now: NOW });
    const failure = { runId: accepted.run.id, memberTurnId: member.id, reason: "failed", now: NOW };
    expect(() => h.store.failExecution(failure)).toThrow("current physical attempt");
    expect(() => h.store.failExecution({ ...failure, sourceTurnId: "old-source" })).toThrow("current physical attempt");
    expect(() => h.store.completeCancel(accepted.run.id, member.id, NOW, false, true, "old-source")).toThrow("current physical attempt");
    expect(h.store.getMemberTurn(member.id)?.state).toBe("running");
    expect(h.store.failExecution({ ...failure, sourceTurnId: "new-source" }).state).toBe("failed");
    expect(h.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(2);
  } finally { h.store.close(); }
});

test("quarantined automatic member fails over through the existing stateless Router", async () => {
  let calls = 0;
  const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide(input) {
    if (calls++ === 0) return { type: "dispatch", mode: "single", assignments: [{ id: "A", botId: A, task: "work", triggerMessageIds: [] }] };
    if (calls === 2) {
      expect(input.memberMetadata.find((m) => m.botId === A)?.enabled).toBe(false);
      expect(input.completedAssignments[0]?.outcome).toBe("failed");
      return { type: "dispatch", mode: "single", assignments: [{ id: "B", botId: B, task: "recover", expectedOutput: "safe result", triggerMessageIds: [] }] };
    }
    return { type: "complete", reason: "recovered" };
  } };
  const h = await harness({ router, onRun: async (input) => input.botId === A ? { status: "failed", error: "failed A" } : { status: "completed", text: "healthy B" } });
  try {
    const accepted = await h.service.acceptGroupPrompt({ conversationId: h.group.id, topicId: h.topic.id, requestId: "automatic", text: "human", target: { mode: "automatic" } });
    await h.service.awaitRouting(); await h.dispatcher.kick(); await h.service.awaitRouting(); await h.dispatcher.kick(); await h.service.awaitRouting();
    expect(h.store.getRun(accepted.run.id)).toMatchObject({ state: "completed", quarantinedBotIds: [A], consumedMemberTurns: 2 });
    expect(h.store.listMemberTurns(accepted.run.id)[1]).toMatchObject({ origin: "recovery", task: "recover", expectedOutput: "safe result" });
    expect(h.bots.getBot(A).enabled).toBe(true);
  } finally { h.store.close(); }
});

test("safe recovery rejects retired source evidence before and after the new start", async () => {
  const { h, accepted, member } = await startedStore("read-only", true);
  try {
    h.store.convergePreviousOwnerClaims("new", NOW);
    const stale = () => h.store.completeExecution({ runId: accepted.run.id, memberTurnId: member.id, content: "STALE RESULT",
      sourceTurn: { sessionAlias: "old-session", turnId: "old-source" }, now: NOW });
    expect(stale).toThrow("retired recovery attempt");
    const staleFailure = () => h.store.failExecution({ runId: accepted.run.id, memberTurnId: member.id,
      sourceTurnId: "old-source", reason: "STALE FAILURE", now: NOW });
    expect(staleFailure).toThrow("current physical attempt");
    await h.dispatcher.kick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.text).toContain("Task:\nORIGINAL TASK");
    expect(h.calls[0]?.text).toContain("Expected output:\nORIGINAL OUTPUT");
    expect(h.calls[0]?.executionOrigin).toBe("orchestration");
    expect(h.calls[0]?.permissionRoute).toBeUndefined();
    expect(h.store.getMemberResult(h.store.getMemberTurn(member.id)!)?.content).not.toBe("STALE RESULT");
    expect(stale).toThrow("retired recovery attempt");
    expect(staleFailure).toThrow("current physical attempt");
  } finally { h.store.close(); }
});

test("human cancel cancels pending handoff and late tool work cannot revive scheduling", async () => {
  const { h, accepted } = await scenario(async (input, h) => {
    const first = await h.send(input);
    await h.service.cancelRun(input.runId);
    expect(h.store.getMemberTurn(first.memberTurn.id)?.state).toBe("cancelled");
    await expect(h.send(input, "late-new-call")).rejects.toBeDefined();
    expect((await h.send(input)).memberTurn.id).toBe(first.memberTurn.id);
  });
  try { expect(h.store.getRun(accepted.run.id)?.state).toBe("cancelled"); expect(h.calls.map((c) => c.botId)).toEqual([A]); }
  finally { h.store.close(); }
});

test("accepted target disabled before start fails durably without stranded dispatch", async () => {
  const { h, accepted } = await scenario(async (input, h) => { await h.send(input); await h.bots.updateBot(B, { enabled: false }); });
  try {
    const target = h.store.listMemberTurns(accepted.run.id)[1]!;
    expect(target.state).toBe("failed"); expect(h.calls.map((c) => c.botId)).toEqual([A]);
    expect(h.store.getDispatchForMemberTurn(target.id)?.state).toBe("completed");
  } finally { h.store.close(); }
});

test("accepted target removed/deleted through corrupt external state still settles fail closed", async () => {
  const { h, accepted } = await scenario(async (input, h) => {
    await h.send(input);
    h.state.conversations[h.group.id]!.botIds = [A, C]; delete h.state.bots[B];
  });
  try {
    const target = h.store.listMemberTurns(accepted.run.id)[1]!;
    expect(target.state).toBe("failed");
    expect(h.store.getDispatchForMemberTurn(target.id)?.state).toBe("completed");
    expect(h.calls.map((c) => c.botId)).toEqual([A]);
  } finally { h.store.close(); }
});

test("lifecycle removal gate refuses an accepted pending handoff", async () => {
  const { h } = await scenario(async (input, h) => {
    await h.send(input);
    await expect(h.bots.updateGroup(h.group.id, { botIds: [A, C] })).rejects.toMatchObject({ code: "group_member_has_work" });
    expect(h.bots.getGroup(h.group.id).botIds).toContain(B);
  }); h.store.close();
});

test("Promise.reject(undefined) before commit cannot publish handoff work", async () => {
  const { h } = await scenario(async (input, h) => {
    let rejected = false;
    try { await h.send(input); } catch (error) { rejected = true; expect(error).toBeUndefined(); }
    expect(rejected).toBe(true); expect(h.store.listMemberTurns(input.runId)).toHaveLength(1);
  }, async () => { throw undefined; }); h.store.close();
});

test("crash after handoff insert and sender start seals downstream pending work", async () => {
  const { h, accepted, member, claim } = await startedStore();
  const receipt = h.store.acceptPublicHandoff({ senderMemberTurnId: member.id, sourceTurnId: member.sourceTurnId!, dispatchId: claim.dispatch.id,
    owner: "dead-owner", generation: claim.dispatch.generation, invocationId: "durable", args: { to: B, task: "downstream" },
    profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(B), h.topic.executionTarget!, NOW), now: NOW });
  h.store.close(); const reopened = await SqliteConversationStore.open(h.path);
  try {
    reopened.convergePreviousOwnerClaims("new", NOW);
    expect(reopened.getRun(accepted.run.id)?.state).toBe("indeterminate");
    expect(reopened.getMemberTurn(receipt.memberTurn.id)?.startedAt).toBeUndefined();
    expect(reopened.claimNextDispatch({ owner: "new", authorityEpoch: "new", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
    expect(reopened.getPublicHandoff("old-source", "durable", { to: B, task: "downstream" })?.message.id).toBe(receipt.message.id);
  } finally { reopened.close(); }
});

test("enforced read-only sender that already handed off cannot blindly replay orchestration", async () => {
  const { h, accepted, member, claim } = await startedStore("read-only", true);
  h.store.acceptPublicHandoff({ senderMemberTurnId: member.id, sourceTurnId: member.sourceTurnId!, dispatchId: claim.dispatch.id,
    owner: "dead-owner", generation: claim.dispatch.generation, invocationId: "durable", args: { to: B, task: "may write" },
    profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(B), h.topic.executionTarget!, NOW), now: NOW });
  h.store.convergePreviousOwnerClaims("new", NOW);
  expect(h.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  expect(h.store.getMemberTurn(member.id)?.attempt).toBe(1); h.store.close();
});

test("recovery retry budget and task survive restart before redispatch", async () => {
  const { h, accepted, member } = await startedStore("read-only", true, 2);
  h.store.convergePreviousOwnerClaims("new", NOW); h.store.close();
  const reopened = await SqliteConversationStore.open(h.path);
  try {
    expect(reopened.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
    expect(reopened.getMemberTurn(member.id)).toMatchObject({ task: "ORIGINAL TASK", expectedOutput: "ORIGINAL OUTPUT", origin: "recovery" });
    const claimed = reopened.claimNextDispatch({ owner: "new", authorityEpoch: "new", now: NOW, leaseExpiresAt: LEASE })!;
    reopened.markExecutionStarted({ dispatchId: claimed.dispatch.id, owner: "new", generation: claimed.dispatch.generation, runId: accepted.run.id,
      memberTurnId: member.id, sessionAlias: "session", logicalSessionId: "logical", sourceTurnId: "recovery-source", now: NOW });
    expect(() => reopened.acceptPublicHandoff({ senderMemberTurnId: member.id, sourceTurnId: "recovery-source", dispatchId: claimed.dispatch.id,
      owner: "new", generation: claimed.dispatch.generation, invocationId: "extra", args: { to: B, task: "overflow" },
      profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(B), h.topic.executionTarget!, NOW), now: NOW })).toThrow("budget is exhausted");
    expect(reopened.listMemberTurns(accepted.run.id)).toHaveLength(1);
  } finally { reopened.close(); }
});

for (const pr8Fixture of ["queued", "claimed"] as const) {
  test(`real PR8 ${pr8Fixture} explicit Run migrates budget and executes its first handoff`, async () => {
    let h!: Harness;
    h = await harness({ pr8Fixture, onRun: async (input) => {
      if (input.botId === A) await h.send(input);
      return { status: "completed", text: `upgraded ${input.botId}` };
    } });
    try {
      expect(h.store.listMemberTurns("run_pr8_explicit")).toHaveLength(1);
      expect(h.store.getRun("run_pr8_explicit")?.maxMemberTurns).toBe(24);
      await h.service.activateAfterConsumerLock();
      expect(h.calls.map((input) => input.botId)).toEqual([A, B]);
      expect(h.calls[0]?.text).toContain("PR8 HUMAN REQUEST");
      expect(h.calls[1]?.text).toContain("HANDOFF TASK");
      expect(h.store.getRun("run_pr8_explicit")).toMatchObject({ state: "completed", consumedMemberTurns: 2 });
      expect(h.store.getRun("run_pr8_explicit")?.completionReason).not.toBe("budget-exhausted");
      expect(h.store.listMessages({ conversationId: h.group.id, topicId: h.topic.id, limit: 100 }).filter((m) => m.handoff)).toHaveLength(1);
    } finally { h.store.close(); }
  });
}

async function realPr8Database() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-pr8-upgrade-")), "conversations.sqlite");
  const db = await createSqlDriver(path);
  db.exec(readFileSync(join(import.meta.dir, "fixtures", "pr8-explicit-queued.sql"), "utf8"));
  expect(db.get<{ max_member_turns: number }>("SELECT max_member_turns FROM runs")?.max_member_turns).toBe(1);
  expect(db.all<{ name: string }>("PRAGMA table_info(runs)").some((c) => c.name === "budget_exhausted")).toBe(false);
  return { path, db };
}

for (const state of ["queued", "running", "waiting-human", "completed", "failed", "cancelled", "indeterminate"] as const) {
  test(`PR8 explicit budget migration handles ${state} without reopening sealed work`, async () => {
    const { path, db } = await realPr8Database();
    db.run("UPDATE runs SET state = ?", [state]); db.close();
    const store = await SqliteConversationStore.open(path);
    try {
      expect(store.getRun("run_pr8_explicit")?.state).toBe(state);
      expect(store.getRun("run_pr8_explicit")?.maxMemberTurns).toBe(["queued", "running", "waiting-human"].includes(state) ? 24 : 1);
    } finally { store.close(); }
  });
}

for (const variant of ["larger", "automatic", "direct"] as const) {
  test(`PR8 migration preserves ${variant} budget`, async () => {
    const { path, db } = await realPr8Database();
    if (variant === "larger") db.run("UPDATE runs SET max_member_turns = 64");
    if (variant === "automatic") db.run("UPDATE runs SET mode = 'automatic', max_member_turns = 2");
    if (variant === "direct") db.run("UPDATE runs SET conversation_id = ?", [createDirectConversationId(A)]);
    db.close(); const store = await SqliteConversationStore.open(path);
    try { expect(store.getRun("run_pr8_explicit")?.maxMemberTurns).toBe(variant === "larger" ? 64 : variant === "automatic" ? 2 : 1); }
    finally { store.close(); }
  });
}

test("PR9 schema reopen never replenishes a migrated Run budget or consumption", async () => {
  const { path, db } = await realPr8Database(); db.close();
  const migrated = await SqliteConversationStore.open(path);
  expect(migrated.getRun("run_pr8_explicit")?.maxMemberTurns).toBe(24); migrated.close();
  const updated = await createSqlDriver(path);
  updated.run("UPDATE runs SET max_member_turns = 2, consumed_member_turns = 1, budget_exhausted = 1"); updated.close();
  const reopened = await SqliteConversationStore.open(path);
  try { expect(reopened.getRun("run_pr8_explicit")).toMatchObject({ maxMemberTurns: 2, consumedMemberTurns: 1 }); }
  finally { reopened.close(); }
  const inspect = await createSqlDriver(path);
  try { expect(inspect.get<{ budget_exhausted: number }>("SELECT budget_exhausted FROM runs")?.budget_exhausted).toBe(1); }
  finally { inspect.close(); }
});

test("PR8 budget backfill failure rolls back the PR9 schema marker before retry", async () => {
  const { path, db } = await realPr8Database();
  db.exec("CREATE TRIGGER fail_budget_upgrade BEFORE UPDATE OF max_member_turns ON runs BEGIN SELECT RAISE(ABORT, 'upgrade interrupted'); END;");
  db.close(); await expect(SqliteConversationStore.open(path)).rejects.toThrow("upgrade interrupted");
  const inspect = await createSqlDriver(path);
  try {
    expect(inspect.all<{ name: string }>("PRAGMA table_info(runs)").some((c) => c.name === "budget_exhausted")).toBe(false);
    expect(inspect.get("SELECT name FROM sqlite_master WHERE name = 'recovery_attempts'")).toBeUndefined();
    inspect.exec("DROP TRIGGER fail_budget_upgrade");
  } finally { inspect.close(); }
  const retried = await SqliteConversationStore.open(path);
  try { expect(retried.getRun("run_pr8_explicit")?.maxMemberTurns).toBe(24); }
  finally { retried.close(); }
});

test("ghost-topic Group teardown removes recovery attempt audit before deleting its root", async () => {
  const { h, accepted } = await startedStore("read-only", true);
  try {
    expect(h.store.convergePreviousOwnerClaims("new-owner", EXPIRED)[0]?.outcome).toBe("requeued");
    const inspect = await createSqlDriver(h.path);
    try { expect(inspect.get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_attempts")?.n).toBe(1); }
    finally { inspect.close(); }
    delete h.state.conversation_topics[h.topic.id];
    await h.service.teardownGroupConversation(h.group.id);
    expect(h.state.conversations[h.group.id]).toBeUndefined();
    expect(h.store.getRun(accepted.run.id)).toBeUndefined(); expect(h.store.hasDurableGroupWork(h.group.id)).toBe(false);
    const after = await createSqlDriver(h.path);
    try { expect(after.get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_attempts")?.n).toBe(0); }
    finally { after.close(); }
    expect(h.calls).toHaveLength(0);
  } finally { h.store.close(); }
});

test("a corrupted handoff trigger borrowing a later Run fails before target provider start", async () => {
  let h!: Harness;
  h = await harness({ onRun: async (input) => {
    if (input.botId === A) {
      const receipt = await h.send(input);
      const later = await h.accept("later-human-request");
      h.store.directWriteForTest("member_turns", receipt.memberTurn.id, { trigger_message_ids_json: JSON.stringify([later.message.id]) });
      // Keep Run B queued so the corruption check counts only Run A calls.
      await h.service.cancelRun(later.run.id);
    }
    return { status: "completed", text: "healthy sender" };
  } });
  try {
    const accepted = await h.accept(); await h.dispatcher.kick();
    expect(h.calls.filter((input) => input.runId === accepted.run.id && input.botId === B)).toHaveLength(0);
    const target = h.store.listMemberTurns(accepted.run.id).find((turn) => turn.botId === B)!;
    expect(target.startedAt).toBeUndefined(); expect(target.state).toBe("failed");
    expect(target.failureReason).toBe("trigger_message_not_found");
    expect(h.store.getMemberResult(h.store.listMemberTurns(accepted.run.id)[0]!)?.content).toBe("healthy sender");
  } finally { h.store.close(); }
});

test("a corrupted explicit trigger borrowing a later Run starts no provider", async () => {
  const h = await harness();
  try {
    const current = await h.accept(), later = await h.accept("later-human-request");
    h.store.directWriteForTest("member_turns", current.memberTurn!.id, { trigger_message_ids_json: JSON.stringify([later.message.id]) });
    await h.service.cancelRun(later.run.id); await h.dispatcher.kick();
    expect(h.calls).toHaveLength(0);
    expect(h.store.getMemberTurn(current.memberTurn!.id)).toMatchObject({ state: "failed", failureReason: "trigger_message_not_found" });
    expect(h.store.getMemberTurn(current.memberTurn!.id)?.startedAt).toBeUndefined();
  } finally { h.store.close(); }
});

test("Router durable commit rejects a later same-Topic Run trigger before creating work", async () => {
  const h = await harness();
  try {
    const current = h.store.acceptRequest({ conversationId: h.group.id, topicId: h.topic.id,
      requestId: "automatic", botId: A, content: "current request", mode: "automatic", members: [], now: NOW,
      profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(A), h.topic.executionTarget!, NOW) });
    const later = await h.accept("later-human-request");
    const routing = h.store.markRoutingState(current.run.id, "routing", NOW);
    expect(() => h.store.applyRoutingDecision({ runId: routing.id, requestMessageId: current.message.id,
      routingGeneration: routing.routingGeneration, now: NOW,
      decision: { type: "dispatch", mode: "single", assignments: [{ id: "assignment", botId: A, task: "must not start",
        triggerMessageIds: [current.message.id, later.message.id],
        profileSnapshot: snapshotGroupMemberProfile(h.bots.getBot(A), h.topic.executionTarget!, NOW) }] },
    })).toThrow("outside this run's topic");
    expect(h.store.listMemberTurns(current.run.id)).toHaveLength(0);
    expect(h.store.listDispatchesForRun(current.run.id)).toHaveLength(0); expect(h.calls).toHaveLength(0);
  } finally { h.store.close(); }
});

test("mixed PR9 column migration and Topic teardown preserve accepted ownership", async () => {
  const h = await harness(); const accepted = await h.accept(); h.store.close();
  const db = await createSqlDriver(h.path);
  db.exec("DROP INDEX idx_handoff_invocation; DROP INDEX idx_handoff_envelope; ALTER TABLE messages DROP COLUMN handoff_json; ALTER TABLE member_turns DROP COLUMN handoff_source_turn_id; ALTER TABLE member_turns DROP COLUMN handoff_invocation_id; ALTER TABLE runs DROP COLUMN quarantined_bot_ids_json; ALTER TABLE runs DROP COLUMN budget_exhausted; DROP TABLE recovery_attempts;");
  db.close(); const reopened = await SqliteConversationStore.open(h.path);
  try {
    expect(reopened.getAcceptedRequest(h.group.id, h.topic.id, accepted.run.requestId)?.run.id).toBe(accepted.run.id);
    expect(reopened.getRun(accepted.run.id)?.quarantinedBotIds).toBeUndefined();
    reopened.deleteTopicRows(h.group.id, h.topic.id); expect(reopened.hasDurableGroupWork(h.group.id)).toBe(false);
  } finally { reopened.close(); }
});
