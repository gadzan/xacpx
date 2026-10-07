import { expect, test } from "bun:test";
import { parseState } from "../../../src/state/state-store";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import type { ConversationRouter, RoutingDecision } from "../../../src/conversations/conversation-router-types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { ConversationBindingService } from "../../../src/conversations/conversation-bindings";
import { harness, deferred, until, NOW } from "./fixtures/concurrency-harness";

for (const limit of [undefined, 1, 2, 64]) {
  test(`physical cap ${limit ?? "omitted (legacy)"} preserves one parallel batch`, async () => {
    const h = await harness();
    const { group, topic } = await h.group(limit);
    const accepted = h.accept(group.id, topic.id);
    const original = h.store.listMemberTurns(accepted.run.id);
    const drain = h.dispatcher.kick();
    const firstWave = limit === undefined ? 3 : Math.min(limit, 3);
    await until(() => h.runner.calls.length === firstWave);
    expect(h.runner.active).toBe(firstWave);
    if (firstWave < 3) {
      const pending = h.store.getDispatchForMemberTurn(original[2]!.id)!;
      expect(pending.state).toBe("pending");
      expect(pending.generation).toBe(1);
      expect(pending.humanIngress?.senderId).toBe("human");
      h.runner.finish(0);
      await until(() => h.runner.calls.length === firstWave + 1);
      // Refill must not wait for the other physical sibling (limit=2).
      expect(h.runner.active).toBe(firstWave);
    }
    for (let i = 0; i < 3; i++) {
      await until(() => h.runner.calls.length > i);
      h.runner.finish(i);
    }
    await drain;
    expect(h.runner.peak).toBe(firstWave);
    expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
    const final = h.store.listMemberTurns(accepted.run.id);
    expect(final.map((m) => [m.id, m.batch, m.memberIndex])).toEqual(original.map((m) => [m.id, m.batch, m.memberIndex]));
    expect(h.runner.calls.every((c) => c.executionOrigin === "human")).toBe(true);
    expect(h.runner.calls[2]!.text).not.toContain("result-0");
    h.store.close();
  });
}

test("two simultaneous completions refill exactly two reservations", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  const accepted = h.accept(group.id, topic.id, 4);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 2);
  h.runner.finish(0); h.runner.finish(1);
  await until(() => h.runner.calls.length === 4);
  expect(h.runner.active).toBe(2); expect(h.runner.peak).toBe(2);
  h.runner.finish(2); h.runner.finish(3); await drain;
  expect(h.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(4);
  h.store.close();
});

test("a free physical slot cannot bypass a dependency even with enforced read-only proof", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  const first = snapshotBotProfile(h.bots.getBot(h.ids[0]!), NOW);
  const second = snapshotBotProfile(h.bots.getBot(h.ids[1]!), NOW);
  const accepted = h.store.acceptRequest({ conversationId: group.id, topicId: topic.id, requestId: "dependencies",
    botId: h.ids[0]!, profileSnapshot: first, content: "sequence", now: NOW,
    primaryMember: { assignmentId: "a", task: "first", effect: "read-only", effectProvenance: "declared-enforced" },
    members: [{ botId: h.ids[1]!, profileSnapshot: second, assignmentId: "b", task: "second", dependsOn: ["a"],
      effect: "read-only", effectProvenance: "declared-enforced" }] });
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
  expect(h.store.getDispatchForMemberTurn(accepted.memberTurns[1]!.id)?.state).toBe("pending");
  await new Promise((r) => setTimeout(r, 10)); expect(h.runner.calls).toHaveLength(1);
  h.runner.finish(0); await until(() => h.runner.calls.length === 2);
  expect(h.runner.calls[1]!.text).toContain("result-0");
  h.runner.finish(1); await drain; expect(h.runner.peak).toBe(1); h.store.close();
});

for (const isolation of ["shared", "shared-single-writer"] as const) {
  for (const effect of ["unknown", "mutating", "read-only"] as const) {
    test(`${isolation} + ${effect} without proof serializes despite limit=8`, async () => {
      const h = await harness(); const { group, topic } = await h.group(8);
      topic.executionTarget!.isolation = isolation;
      h.state.conversation_topics[topic.id]!.executionTarget!.isolation = isolation;
      h.accept(group.id, topic.id, 2, false, "writers", { effect });
      const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
      await new Promise((r) => setTimeout(r, 10));
      expect(h.runner.active).toBe(1); expect(h.runner.calls).toHaveLength(1);
      h.runner.finish(0); await until(() => h.runner.calls.length === 2);
      h.runner.finish(1); await drain; expect(h.runner.peak).toBe(1); h.store.close();
    });
  }
}

for (const operation of ["cancel", "topic teardown", "group teardown", "execution cancellation", "terminal failure"] as const) {
  test(`${operation} racing completion cannot admit capacity-waiting work`, async () => {
    const h = await harness(); const { group, topic } = await h.group(2);
    const accepted = h.accept(group.id, topic.id);
    const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 2);
    let action: Promise<unknown>;
    if (operation === "topic teardown") action = h.service.teardownGroupTopic(group.id, topic.id);
    else if (operation === "group teardown") action = h.service.teardownGroupConversation(group.id);
    else if (operation === "execution cancellation") {
      h.runner.finish(0, { status: "cancelled" });
      await until(() => h.store.getRun(accepted.run.id)?.completionReason !== undefined);
      action = Promise.resolve();
    } else if (operation === "terminal failure") {
      // Unknown provider evidence seals the whole Run; pending work cannot start.
      h.runner.finish(0, { status: "failed", unknown: true, error: "lost result" });
      await until(() => h.store.getRun(accepted.run.id)?.state === "indeterminate");
      action = Promise.resolve();
    } else action = h.service.cancelRun(accepted.run.id);
    h.runner.finish(0); h.runner.finish(1);
    await action; await drain;
    expect(h.runner.calls).toHaveLength(2); expect(h.runner.peak).toBe(2);
    h.store.close();
  });
}

test("cancel while the only reserved member waits in a real Bot lifecycle gate frees unstarted capacity", async () => {
  const h = await harness(); const { group, topic } = await h.group(1);
  const accepted = h.accept(group.id, topic.id);
  const entered = deferred(); const release = deferred();
  const held = h.bots.runLifecycle(h.ids[0]!, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const drain = h.dispatcher.kick();
  await until(() => h.store.getDispatchForMemberTurn(accepted.memberTurns[0]!.id)?.state === "claimed");
  const cancel = h.service.cancelRun(accepted.run.id);
  await until(() => h.store.getRun(accepted.run.id)?.state === "cancelled");
  expect(h.store.listMemberTurns(accepted.run.id).every((m) => h.store.getDispatchForMemberTurn(m.id)?.state === "completed")).toBe(true);
  release.resolve(); await held; await cancel; await drain;
  expect(h.runner.calls).toHaveLength(0); h.store.close();
});

test("refill after a long sibling does not lease-recover a still-live execution", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  const accepted = h.accept(group.id, topic.id);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 2);
  h.jump(90_000); h.runner.finish(1);
  await until(() => h.runner.calls.length === 3);
  const a = h.store.getMemberTurn(accepted.memberTurns[0]!.id)!;
  expect(a.attempt).toBe(1); expect(a.state).toBe("running");
  expect(a.sourceTurnId).toBe(h.runner.calls[0]!.promptRequestId);
  h.runner.finish(0); h.runner.finish(2); await drain;
  expect(h.runner.peak).toBe(2); h.store.close();
});

for (const phase of ["before claim", "claimed before start", "started unknown", "started read-only"] as const) {
  test(`restart from ${phase} reconstructs durable capacity`, async () => {
    const old = await harness(); const { group, topic } = await old.group(2);
    const safe = phase !== "started unknown";
    const accepted = old.accept(group.id, topic.id, 3, safe);
    if (phase !== "before claim") {
      for (let i = 0; i < 2; i++) {
        const work = old.store.claimNextDispatch({ now: NOW, owner: "dead", authorityEpoch: old.dispatcher.authorityEpoch,
          leaseExpiresAt: "2099-01-01T00:00:00.000Z", topicConcurrencyLimits: { [topic.id]: 2 } })!;
        if (phase.startsWith("started")) old.store.markExecutionStarted({ dispatchId: work.dispatch.id, owner: "dead",
          generation: work.dispatch.generation, runId: work.run.id, memberTurnId: work.memberTurn.id,
          sessionAlias: "dead", logicalSessionId: "dead", sourceTurnId: `source-${i}`, now: NOW });
      }
    }
    const state = parseState(JSON.parse(JSON.stringify(old.state)), "state.json"); old.store.close();
    const h = await harness({ path: old.path, state, ownerId: "new-owner" });
    const activated = h.service.activateAfterConsumerLock();
    if (!safe) {
      await activated;
      expect(h.runner.calls).toHaveLength(0);
      expect(h.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
    } else {
      await until(() => h.runner.calls.length === 2);
      expect(h.runner.active).toBe(2);
      expect(h.store.getDispatchForMemberTurn(accepted.memberTurns[2]!.id)?.state).toBe("pending");
      h.runner.finish(0); await until(() => h.runner.calls.length === 3);
      h.runner.finish(1); h.runner.finish(2); await activated;
      expect(h.runner.peak).toBe(2);
      expect(h.runner.calls.every((c) => c.executionOrigin === "orchestration")).toBe(true);
      expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
    }
    h.store.close();
  });
}

test("shutdown at full capacity leaves the third member pending for the next consumer", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  const accepted = h.accept(group.id, topic.id);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 2);
  const shutdown = h.dispatcher.shutdown(); h.runner.finish(0); h.runner.finish(1);
  await shutdown; await drain;
  expect(h.runner.calls).toHaveLength(2);
  expect(h.store.getDispatchForMemberTurn(accepted.memberTurns[2]!.id)?.state).toBe("pending");
  h.store.close();
  const next = await harness({ path: h.path, state: parseState(h.state, "state.json") });
  const activate = next.service.activateAfterConsumerLock(); await until(() => next.runner.calls.length === 1);
  next.runner.finish(0); await activate; expect(next.runner.peak).toBe(1); next.store.close();
});

for (const value of [0, -1, 1.5, NaN, Infinity, 65, null, "2"]) {
  test(`invalid concurrency ${String(value)} fails creation and persisted decoding`, async () => {
    const h = await harness(); const { group, topic } = await h.group();
    const before = Object.keys(h.state.conversation_topics).length;
    await expect(h.service.createGroupTopic(group.id, "bad", { workspace: "backend", isolation: "shared" },
      { maxConcurrentMemberTurns: value as number })).rejects.toMatchObject({ code: "invalid_concurrency_limit" });
    const raw = structuredClone(h.state);
    (raw.conversation_topics[topic.id] as unknown as Record<string, unknown>).maxConcurrentMemberTurns = value;
    expect(parseState(raw, "state.json").conversation_topics[topic.id]).toBeUndefined();
    expect(Object.keys(h.state.conversation_topics)).toHaveLength(before); h.store.close();
  });
}

test("old Topic has no synthetic default; configured Topic survives AppState roundtrip", async () => {
  const h = await harness(); const old = await h.group(); const configured = await h.group(2);
  const parsed = parseState(JSON.parse(JSON.stringify(h.state)), "state.json");
  expect(parsed.conversation_topics[old.topic.id]).not.toHaveProperty("maxConcurrentMemberTurns");
  expect(parsed.conversation_topics[configured.topic.id]?.maxConcurrentMemberTurns).toBe(2);
  h.store.close();
});

test("two SQLite connections atomically reserve capacity, leave full work pending and isolate Topic counts", async () => {
  const h = await harness(); const a = await h.group(2); const b = await h.group(1);
  const ar = h.accept(a.group.id, a.topic.id); const br = h.accept(b.group.id, b.topic.id, 1);
  const directTopic = await h.service.createDirectTopic(h.ids[0]!, "Direct", { maxConcurrentMemberTurns: 1 });
  const direct = h.accept(directTopic.conversationId, directTopic.id, 1);
  const other = await SqliteConversationStore.open(h.path);
  const claim = { now: NOW, owner: "one", authorityEpoch: h.dispatcher.authorityEpoch,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", topicConcurrencyLimits: h.runtime.topicConcurrencyLimits() };
  const one = h.store.claimNextDispatch({ ...claim, runId: ar.run.id })!;
  const two = other.claimNextDispatch({ ...claim, owner: "two", runId: ar.run.id })!;
  expect(one.dispatch.id).not.toBe(two.dispatch.id);
  expect(other.claimNextDispatch({ ...claim, runId: ar.run.id })).toBeUndefined();
  expect(other.claimNextDispatch({ ...claim, runId: br.run.id })?.run.id).toBe(br.run.id);
  expect(other.claimNextDispatch({ ...claim, runId: direct.run.id })?.run.id).toBe(direct.run.id);
  expect(h.store.getDispatchForMemberTurn(ar.memberTurns[2]!.id)?.state).toBe("pending");
  other.close(); h.store.close();
});

test("configured Topics preserve the existing global cohort boundary and each uses its own limit", async () => {
  const h = await harness(); const a = await h.group(1); const b = await h.group(2);
  h.accept(a.group.id, a.topic.id, 2, true, "first");
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
  h.accept(b.group.id, b.topic.id, 3, true, "other"); void h.dispatcher.kick();
  expect(h.runner.calls[0]!.topicId).toBe(a.topic.id);
  h.runner.finish(0); await until(() => h.runner.calls.length === 2);
  expect(h.runner.calls[1]!.topicId).toBe(a.topic.id);
  h.runner.finish(1); await until(() => h.runner.calls.length === 4);
  expect(h.runner.calls.slice(2).every((c) => c.topicId === b.topic.id)).toBe(true);
  expect(h.runner.active).toBe(2);
  h.runner.finish(2); await until(() => h.runner.calls.length === 5);
  h.runner.finish(3); h.runner.finish(4); await drain; expect(h.runner.peak).toBe(2); h.store.close();
});

test("public handoff remains pending behind capacity and starts once with orchestration authority", async () => {
  const h = await harness(); const { group, topic } = await h.group(1);
  const handoffs = new GroupHandoffService({ store: h.store, bots: h.bots, state: h.state, now: h.now,
    wake: () => { void h.dispatcher.kick(); } });
  h.dispatcher.setHandoffService(handoffs);
  const accepted = h.accept(group.id, topic.id, 1);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
  const invocation = { executionToken: h.runner.calls[0]!.groupExecutionToken!, invocationId: "handoff-once",
    args: { to: h.ids[1], task: "handoff task" } };
  const receipt = await handoffs.send(invocation); const replay = await handoffs.send(invocation);
  expect(replay.reused).toBe(true); expect(receipt.reused).toBe(false);
  expect(h.runner.calls).toHaveLength(1);
  expect(h.store.listMemberTurns(accepted.run.id)).toHaveLength(2);
  h.runner.finish(0); await until(() => h.runner.calls.length === 2);
  expect(h.runner.calls[1]!.executionOrigin).toBe("orchestration");
  expect(h.runner.calls[1]!.permissionRoute).toBeUndefined();
  h.runner.finish(1); await drain; expect(h.runner.peak).toBe(1); handoffs.close(); h.store.close();
});

test("external human Stop cancels the configured Run without starting capacity-waiting members", async () => {
  const h = await harness(); const { group, topic } = await h.group(1);
  const bindings = new ConversationBindingService(h.store, h.service, h.bots);
  const chatKey = "discord:default:chat";
  await bindings.bind({ chatKey, conversationId: group.id, topicId: topic.id });
  const request = { conversationId: chatKey, accountId: "default", text: "work", metadata: {
    channel: "discord", channelMessageId: "prompt", origin: "human" as const,
    authenticatedHuman: true, senderId: "human", conversationTarget: { mode: "everyone" as const } } };
  const accepted = await bindings.accept("discord", request);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
  const stopRequest = { ...request, text: "/stop", metadata: { ...request.metadata, channelMessageId: "stop" } };
  const stop = bindings.acceptStop("discord", stopRequest);
  await bindings.stopSelected("discord", stopRequest, stop.targetRunIds);
  await drain;
  expect(h.runner.calls).toHaveLength(1);
  expect(h.store.getRun(accepted!.run.id)).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
  h.store.close();
});

const restricted = { toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true,
  permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true, structuredOutputOnly: true } as const;
for (const mode of ["parallel", "sequential"] as const) {
  test(`real Router ${mode} batch retains assignments/dependencies and completion under limit=2`, async () => {
    let decisions = 0; let ids: string[] = [];
    const router: ConversationRouter = { capabilityRestriction: restricted, async decide(): Promise<RoutingDecision> {
      if (decisions++ > 0) return { type: "complete", reason: "plan done" };
      return { type: "dispatch", mode, assignments: ids.slice(0, 3).map((botId, i) => ({ id: `a${i}`, botId,
        task: `task${i}`, triggerMessageIds: [], ...(mode === "sequential" && i > 0 ? { dependsOn: [`a${i - 1}`] } : {}) })) };
    } };
    const h = await harness({ router }); ids = h.ids;
    const { group, topic } = await h.group(2);
    const accepted = await h.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: mode, text: "router request", target: { mode: "automatic" } });
    await h.service.awaitRouting();
    const members = h.store.listMemberTurns(accepted.run.id);
    expect(members).toHaveLength(3); expect(new Set(members.map((m) => m.batch)).size).toBe(1);
    const drain = h.dispatcher.kick();
    for (let i = 0; i < 3; i++) {
      await until(() => h.runner.calls.length > i);
      expect(h.runner.active).toBe(1); // Router has no enforced read-only proof.
      if (mode === "sequential" && i > 0) expect(h.runner.calls[i]!.text).toContain(`result-${i - 1}`);
      h.runner.finish(i);
    }
    await drain; await h.service.awaitRouting();
    expect(decisions).toBe(2); expect(h.runner.peak).toBe(1);
    expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
    expect(h.runner.calls.every((c) => c.executionOrigin === "orchestration")).toBe(true);
    expect(h.store.listMemberTurns(accepted.run.id).map((m) => m.assignmentId)).toEqual(["a0", "a1", "a2"]);
    h.store.close();
  });
}
