import { expect, spyOn, test } from "bun:test";
import { harness, deferred, until, HUMAN } from "./fixtures/concurrency-harness";
import { CLAUDE_READ_ONLY_POLICY, isReadOnlyAgentArgv, supportsEnforcedReadOnly } from "../../../src/adapters/conversation-effect-policy";
import { parseMemberPolicies } from "../../../src/conversations/conversation-effect-request";
import { parseState } from "../../../src/state/state-store";
import { parseRoutingDecision } from "../../../src/conversations/conversation-router-types";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";

test("a Router cannot submit an effect request or mint enforcement provenance", () => {
  for (const forged of [{ effectProvenance: "declared-enforced" }, { effectProvenance: "human" }, { trustedReadOnly: true }, { effect: "read-only" }]) {
    expect(() => parseRoutingDecision({ type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: "b", task: "review", dependsOn: [], triggerMessageIds: [], ...forged },
    ] })).toThrow();
  }
});

async function accept(h: Awaited<ReturnType<typeof harness>>, groupId: string, topicId: string,
  effects: ("read-only" | "read-write")[], id = "policy-request", human = true) {
  return h.service.acceptGroupPrompt({ conversationId: groupId, topicId, requestId: id, text: "review this tree",
    target: { mode: "members", botIds: h.ids.slice(0, effects.length) },
    memberPolicies: effects.map((filesystem, i) => ({ botId: h.ids[i]!, filesystem })),
    ...(human ? { humanIngress: HUMAN } : {}),
  });
}

for (const isolation of ["shared", "shared-single-writer"] as const) {
  test(`${isolation}: three production-accepted enforced readers use two physical slots`, async () => {
    const h = await harness(); const { group, topic } = await h.group(2);
    h.state.conversation_topics[topic.id]!.executionTarget!.isolation = isolation;
    const a = await accept(h, group.id, topic.id, ["read-only", "read-only", "read-only"]);
    expect(a.memberTurns.every((m) => m.effect === "read-only" && m.effectProvenance === "declared-enforced")).toBe(true);
    const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 2);
    expect(h.runner.active).toBe(2);
    h.runner.finish(0); await until(() => h.runner.calls.length === 3);
    expect(h.runner.active).toBe(2); expect(h.runner.peak).toBe(2);
    h.runner.finish(1); h.runner.finish(2); await drain;
    expect(h.store.getRun(a.run.id)?.state).toBe("completed");
    expect(h.store.listMemberTurns(a.run.id).map((m) => [m.id, m.batch])).toEqual(a.memberTurns.map((m) => [m.id, m.batch]));
    expect(h.runner.calls.every((call) => call.executionOrigin === "human")).toBe(true);
    for (const session of Object.values(h.state.sessions)) {
      expect(session.execution_policy).toBe(CLAUDE_READ_ONLY_POLICY);
      expect(isReadOnlyAgentArgv(h.sessions.getResolvedSessionByInternalAlias(session.alias)!.agentArgv!)).toBe(true);
    }
    h.store.close();
  });

  for (const effects of [["read-only", "read-write"], ["read-write", "read-only"]] as const) {
    test(`${isolation}: ${effects.join(" then ")} never overlap or deadlock`, async () => {
      const h = await harness(); const { group, topic } = await h.group(8);
      h.state.conversation_topics[topic.id]!.executionTarget!.isolation = isolation;
      const a = await accept(h, group.id, topic.id, [...effects]);
      const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
      await new Promise((r) => setTimeout(r, 15)); expect(h.runner.calls).toHaveLength(1);
      h.runner.finish(0); await until(() => h.runner.calls.length === 2); h.runner.finish(1); await drain;
      expect(h.runner.peak).toBe(1); expect(h.store.getRun(a.run.id)?.state).toBe("completed"); h.store.close();
    });
  }
}

test("a filesystem-held writer is not a reader and cannot deadlock later readers", async () => {
  const h = await harness(); const { group, topic } = await h.group(4);
  await accept(h, group.id, topic.id, ["read-only", "read-only", "read-write", "read-only"]);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 3);
  expect(h.runner.calls.map((c) => c.botId)).toEqual([h.ids[0], h.ids[1], h.ids[3]]);
  expect(h.runner.peak).toBe(3);
  h.runner.finish(0); h.runner.finish(1); h.runner.finish(2);
  await until(() => h.runner.calls.length === 4);
  expect(h.runner.calls[3]!.botId).toBe(h.ids[2]); expect(h.runner.active).toBe(1);
  h.runner.finish(3); await drain; h.store.close();
});

for (const text of ["Reviewer", "do not edit files", "read only"]) {
  test(`${text} is presentation/text and never enforcement proof`, async () => {
    const h = await harness(); const { group, topic } = await h.group(8);
    await h.bots.updateBot(h.ids[0]!, { name: text, instructions: text });
    const a = await h.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: text, text, target: { mode: "members", botIds: h.ids.slice(0, 2) } });
    expect(a.memberTurns.every((m) => m.effect !== "read-only" && m.effectProvenance === undefined)).toBe(true);
    const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
    expect(Object.values(h.state.sessions)[0]!.execution_policy).toBeUndefined();
    h.runner.finish(0); await until(() => h.runner.calls.length === 2); h.runner.finish(1); await drain;
    expect(h.runner.peak).toBe(1); h.store.close();
  });
}

for (const agent of [{ driver: "codex" }, { driver: "hermes" }, { driver: "claude", command: "custom" },
  { driver: "claude", argv: ["custom"] }]) {
  test(`unsupported launch ${JSON.stringify(agent)} cannot mint read-only`, async () => {
    const h = await harness(); const { group, topic } = await h.group(2);
    h.config.agents.codex = agent;
    await expect(accept(h, group.id, topic.id, ["read-only"])).rejects.toMatchObject({ code: "effect_policy_unsupported" });
    expect(h.store.listRuns({ conversationId: group.id, topicId: topic.id })).toHaveLength(0); h.store.close();
  });
}

for (const transport of [{ adapterVersions: { claude: "0.77.0" } }, { adapterRegistry: "https://registry.example.test" }]) {
  test(`unverified managed adapter ${JSON.stringify(transport)} stays unsupported`, () => {
    expect(supportsEnforcedReadOnly({ driver: "claude" }, transport)).toBe(false);
  });
}

for (const value of [[{ botId: "a", filesystem: "read-only", effectProvenance: "declared-enforced" }],
  [{ botId: "a", filesystem: "read-only", trustedReadOnly: true }],
  [{ botId: "a", filesystem: "read-only" }, { botId: "a", filesystem: "read-write" }], []]) {
  test(`policy cannot mint proof or ambiguous selection: ${JSON.stringify(value)}`, () => {
    expect(() => parseMemberPolicies(value)).toThrow();
  });
}

for (const phase of ["beforeRuntimeMaterialize", "beforeExecutionStart"] as const) {
  test(`adapter drift at ${phase} makes zero provider calls`, async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({ hooks: { [phase]: async () => { h.config.agents.codex!.driver = "codex"; } } });
    const { group, topic } = await h.group(2); const a = await accept(h, group.id, topic.id, ["read-only"]);
    await h.dispatcher.kick(); expect(h.runner.calls).toHaveLength(0);
    expect(h.store.getMemberTurn(a.memberTurns[0]!.id)?.failureReason).toBe("runtime_revision_mismatch"); h.store.close();
  });
}

test("a writable owned session is physically released before read-only materialization and vice versa", async () => {
  const h = await harness(); const { group, topic } = await h.group(1);
  const execute = async (effect: "read-only" | "read-write", id: string) => {
    const a = await accept(h, group.id, topic.id, [effect], id, false);
    const drain = h.dispatcher.kick(); const index = h.runner.calls.length;
    await until(() => h.runner.calls.length > index); h.runner.finish(index); await drain;
    return h.store.getMemberTurn(a.memberTurns[0]!.id)!;
  };
  const writable = await execute("read-write", "writable");
  const reader = await execute("read-only", "reader");
  expect(reader.logicalSessionId).not.toBe(writable.logicalSessionId);
  const readerAgain = await execute("read-only", "reader-again");
  expect(readerAgain.logicalSessionId).toBe(reader.logicalSessionId);
  const writableAgain = await execute("read-write", "writable-again");
  expect(writableAgain.logicalSessionId).not.toBe(reader.logicalSessionId);
  expect(h.runner.calls.every((c) => c.executionOrigin === "orchestration")).toBe(true); h.store.close();
});

for (const unknownFirst of [false, true]) {
  test(`legacy mixed unknown/reader batch, unknown first=${unknownFirst}, remains exclusive`, async () => {
    const h = await harness(); const { group, topic } = await h.group(4);
    const a = h.accept(group.id, topic.id, 2, true);
    const { createSqlDriver } = await import("../../../src/conversations/sql-driver");
    const sql = await createSqlDriver(h.path);
    sql.run("UPDATE member_turns SET effect = 'unknown', effect_provenance = NULL WHERE id = ?", [a.memberTurns[unknownFirst ? 0 : 1]!.id]); sql.close();
    const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1);
    h.runner.finish(0); await until(() => h.runner.calls.length === 2); h.runner.finish(1); await drain;
    expect(h.runner.peak).toBe(1); h.store.close();
  });
}

test("persisted owned session ceiling survives parsing; malformed ceiling is quarantined", async () => {
  const h = await harness(); const { group, topic } = await h.group(1);
  await accept(h, group.id, topic.id, ["read-only"]);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 1); h.runner.finish(0); await drain;
  const session = Object.values(h.state.sessions)[0]!;
  expect(parseState(structuredClone(h.state)).sessions[session.alias]?.execution_policy).toBe(CLAUDE_READ_ONLY_POLICY);
  const raw = structuredClone(h.state);
  (raw.sessions[session.alias] as unknown as Record<string, unknown>).execution_policy = "writable-fallback";
  expect(parseState(raw).sessions[session.alias]).toBeUndefined(); h.store.close();
});

test("policy replay cannot turn an old writable request into a read-only acknowledgement", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  await h.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: "same", text: "old", target: { botId: h.ids[0]! } });
  await expect(accept(h, group.id, topic.id, ["read-only"], "same")).rejects.toMatchObject({ code: "effect_policy_conflict" });
  expect(h.runner.calls).toHaveLength(0); h.store.close();
});

for (const replay of [
  { name: "omits an accepted writer", indices: [0], effects: ["read-only"] },
  { name: "replaces an accepted writer with another Bot", indices: [0, 2], effects: ["read-only", "read-write"] },
] as const) {
  test(`policy replay rejects a member set that ${replay.name}`, async () => {
    const h = await harness(); const { group, topic } = await h.group(2);
    try {
      const accepted = await accept(h, group.id, topic.id, ["read-only", "read-write"], "same");
      expect(accepted.memberTurns.map((m) => [m.botId, m.effect, m.effectProvenance])).toEqual([
        [h.ids[0], "read-only", "declared-enforced"], [h.ids[1], "mutating", undefined],
      ]);
      await expect(h.service.acceptGroupPrompt({
        conversationId: group.id, topicId: topic.id, requestId: "same", text: "review this tree",
        target: { mode: "members", botIds: replay.indices.map((index) => h.ids[index]!) },
        memberPolicies: replay.indices.map((index, i) => ({ botId: h.ids[index]!, filesystem: replay.effects[i]! })),
        humanIngress: HUMAN,
      })).rejects.toMatchObject({ code: "effect_policy_conflict" });
      expect(h.store.listRuns(group.id, topic.id).map((run) => run.id)).toEqual([accepted.run.id]);
      expect(h.store.listMemberTurns(accepted.run.id)).toEqual(accepted.memberTurns);
      expect(h.runner.calls).toHaveLength(0);
    } finally { h.store.close(); }
  });
}

test("exact policy replay uses durable members after live membership and adapter changes", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  try {
    const accepted = await accept(h, group.id, topic.id, ["read-only", "read-write"], "same");
    await h.service.cancelRun(accepted.run.id);
    await h.bots.updateGroup(group.id, { botIds: [h.ids[0]!, h.ids[2]!] });
    h.config.agents.codex!.driver = "codex";
    const durable = h.store.getAcceptedRequest(group.id, topic.id, "same")!;
    const replayed = await h.service.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "same", text: "review this tree",
      target: { mode: "members", botIds: [h.ids[0]!, h.ids[1]!] },
      memberPolicies: [{ botId: h.ids[1]!, filesystem: "read-write" }, { botId: h.ids[0]!, filesystem: "read-only" }],
      humanIngress: HUMAN,
    });
    expect(replayed.reused).toBe(true);
    expect(replayed.run.id).toBe(accepted.run.id);
    expect(replayed).toEqual(durable);
    expect(replayed.memberTurns.map((m) => m.id)).toEqual(accepted.memberTurns.map((m) => m.id));
    expect(h.store.listRuns(group.id, topic.id)).toHaveLength(1);
    expect(h.runner.calls).toHaveLength(0);
  } finally { h.store.close(); }
});

for (const targetIndex of [0, 2]) {
  test(`original policy replay survives public handoff to ${targetIndex === 0 ? "an original Bot" : "a new Bot"} and reopen`, async () => {
    const h = await harness(); const { group, topic } = await h.group(2);
    const handoffs = new GroupHandoffService({ store: h.store, bots: h.bots, state: h.state, now: h.now,
      wake: () => { void h.dispatcher.kick(); } });
    h.dispatcher.setHandoffService(handoffs);
    const accepted = await accept(h, group.id, topic.id, ["read-only", "read-write"]);
    const drain = h.dispatcher.kick();
    try {
      await until(() => h.runner.calls.length === 1); h.runner.finish(0);
      await until(() => h.runner.calls.length === 2);
      const receipt = await handoffs.send({ executionToken: h.runner.calls[1]!.groupExecutionToken!, invocationId: "append",
        args: { to: h.ids[targetIndex], task: "additional work" } });
      expect(receipt.memberTurn.assignmentId).toBeDefined();
      expect(h.store.getMemberTurn(receipt.memberTurn.id)!.effect ?? "unknown").toBe("unknown");
      const replay = await accept(h, group.id, topic.id, ["read-only", "read-write"]);
      expect(replay.reused).toBe(true); expect(replay.run.id).toBe(accepted.run.id);
      expect(replay.memberTurns).toHaveLength(3);
      expect(replay.memberTurns.slice(0, 2).map((m) => m.id)).toEqual(accepted.memberTurns.map((m) => m.id));
      h.runner.finish(1); await until(() => h.runner.calls.length === 3); h.runner.finish(2); await drain;
      const reopened = await harness({ path: h.path, state: parseState(structuredClone(h.state)) });
      try {
        const replayAfterReopen = await accept(reopened, group.id, topic.id, ["read-only", "read-write"]);
        expect(replayAfterReopen.reused).toBe(true);
        expect(replayAfterReopen.run.id).toBe(accepted.run.id);
        expect(replayAfterReopen.memberTurns.map((m) => m.id)).toEqual(replay.memberTurns.map((m) => m.id));
        expect(reopened.runner.calls).toHaveLength(0);
      } finally { reopened.store.close(); }
    } finally { await h.service.cancelRun(accepted.run.id); await drain; handoffs.close(); h.store.close(); }
  });
}

for (const kind of ["direct", "group"] as const) for (const filesystem of ["read-only", "read-write"] as const) {
  test(`${kind}: ordinary replay cannot discard an accepted ${filesystem} policy`, async () => {
    const h = await harness();
    try {
      if (kind === "group") {
        const { group, topic } = await h.group(2);
        const accepted = await accept(h, group.id, topic.id, [filesystem]);
        await expect(h.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
          requestId: accepted.run.requestId, text: "review this tree", target: { botId: h.ids[0]! } }))
          .rejects.toMatchObject({ code: "effect_policy_conflict" });
      } else {
        const input = { botId: h.ids[0]!, requestId: "same", content: "review this tree" };
        await h.service.acceptDirectPrompt({ ...input, memberPolicies: [{ botId: h.ids[0]!, filesystem }] });
        await expect(h.service.acceptDirectPrompt(input)).rejects.toMatchObject({ code: "effect_policy_conflict" });
      }
      expect(h.runner.calls).toHaveLength(0);
    } finally { h.store.close(); }
  });
}

for (const winnerIndex of [0, 1]) for (const path of ["store-replay", "unique-fallback"] as const) {
  test(`concurrent disjoint policy accepts validate ${path}, winner=${winnerIndex}`, async () => {
    const entered = deferred(), release = [deferred(), deferred()]; let arrivals = 0;
    const h = await harness({ beforeAcceptPersist: async () => {
      const index = arrivals++; if (arrivals === 2) entered.resolve(); await release[index]!.promise;
    } });
    const { group, topic } = await h.group(2);
    const requests = (["read-only", "read-write"] as const).map((filesystem, index) => h.service.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "race", text: "work",
      target: { botId: h.ids[index]! }, memberPolicies: [{ botId: h.ids[index]!, filesystem }], humanIngress: HUMAN,
    }));
    const outcomes = Promise.allSettled(requests); let staleRead: ReturnType<typeof spyOn> | undefined;
    try {
      await entered.promise; expect(h.store.listRuns(group.id, topic.id)).toHaveLength(0);
      release[winnerIndex]!.resolve(); const winner = await requests[winnerIndex]!;
      if (path === "unique-fallback") staleRead = spyOn(h.store, "getRunByRequestId").mockImplementationOnce(() => undefined);
      release[1 - winnerIndex]!.resolve();
      const settled = await outcomes;
      expect(settled[winnerIndex]).toMatchObject({ status: "fulfilled", value: { reused: false } });
      expect(settled[1 - winnerIndex]).toMatchObject({ status: "rejected", reason: { code: "effect_policy_conflict" } });
      expect(h.store.listRuns(group.id, topic.id).map((r) => r.id)).toEqual([winner.run.id]);
      expect(h.store.listMemberTurns(winner.run.id)).toEqual(winner.memberTurns);
      expect(h.runner.calls).toHaveLength(0);
    } finally { staleRead?.mockRestore(); release.forEach((gate) => gate.resolve()); await outcomes; h.store.close(); }
  });
}

for (const winnerIndex of [0, 1]) {
  test(`concurrent policy and ordinary accepts cannot share an id, winner=${winnerIndex}`, async () => {
    const entered = deferred(), release = [deferred(), deferred()]; let arrivals = 0;
    const h = await harness({ beforeAcceptPersist: async () => {
      const index = arrivals++; if (arrivals === 2) entered.resolve(); await release[index]!.promise;
    } });
    const { group, topic } = await h.group(2);
    const requests = [0, 1].map((index) => h.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: "race", text: "work", target: { botId: h.ids[index]! },
      ...(index === 0 ? { memberPolicies: [{ botId: h.ids[0]!, filesystem: "read-only" as const }] } : {}),
    }));
    const outcomes = Promise.allSettled(requests);
    try {
      await entered.promise; release[winnerIndex]!.resolve(); const winner = await requests[winnerIndex]!;
      release[1 - winnerIndex]!.resolve();
      expect((await outcomes)[1 - winnerIndex]).toMatchObject({ status: "rejected", reason: { code: "effect_policy_conflict" } });
      expect(h.store.listRuns(group.id, topic.id).map((r) => r.id)).toEqual([winner.run.id]);
      expect(h.runner.calls).toHaveLength(0);
    } finally { release.forEach((gate) => gate.resolve()); await outcomes; h.store.close(); }
  });
}

test("Direct policy acceptance validates a competing durable store result after its final await", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness({ beforeAcceptPersist: async () => { entered.resolve(); await release.promise; } });
  const pending = h.service.acceptDirectPrompt({ botId: h.ids[0]!, requestId: "race", content: "review",
    memberPolicies: [{ botId: h.ids[0]!, filesystem: "read-only" }] });
  const outcome = Promise.allSettled([pending]);
  try {
    await entered.promise;
    const winner = h.store.acceptRequest({ conversationId: createDirectConversationId(h.ids[0]!),
      topicId: createDirectTopicId(h.ids[0]!), requestId: "race", botId: h.ids[0]!, content: "write",
      profileSnapshot: snapshotBotProfile(h.bots.getBot(h.ids[0]!), h.now().toISOString()),
      primaryMember: { effect: "mutating" }, now: h.now().toISOString() });
    release.resolve();
    expect((await outcome)[0]).toMatchObject({ status: "rejected", reason: { code: "effect_policy_conflict" } });
    expect(h.store.getRun(winner.run.id)?.state).toBe("queued");
    expect(h.runner.calls).toHaveLength(0);
  } finally { release.resolve(); await outcome; h.store.close(); }
});

test("a filesystem-held writer retains its durable capacity slot ahead of a compatible reader", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  const accepted = await accept(h, group.id, topic.id, ["read-only", "read-write", "read-only"]);
  const drain = h.dispatcher.kick();
  try {
    await until(() => h.runner.calls.length === 1 && h.store.getDispatchForMemberTurn(accepted.memberTurns[1]!.id)?.state === "claimed");
    expect(h.store.getMemberTurn(accepted.memberTurns[1]!.id)?.startedAt).toBeUndefined();
    expect(h.store.getDispatchForMemberTurn(accepted.memberTurns[2]!.id)?.state).toBe("pending");
    expect(h.runner.peak).toBe(1);
  } finally { await h.service.cancelRun(accepted.run.id); await drain; h.store.close(); }
});

for (const action of ["cancel", "teardown"] as const) {
  test(`read-only Bot-gate waiter vs ${action} cannot start or strand capacity`, async () => {
    const h = await harness(); const { group, topic } = await h.group(1);
    const a = await accept(h, group.id, topic.id, ["read-only", "read-only"]);
    const entered = deferred(), release = deferred();
    const gate = h.bots.runLifecycle(h.ids[0]!, async () => { entered.resolve(); await release.promise; });
    await entered.promise; const drain = h.dispatcher.kick();
    await until(() => h.store.getDispatchForMemberTurn(a.memberTurns[0]!.id)?.state === "claimed");
    const stopping = action === "cancel" ? h.service.cancelRun(a.run.id) : h.service.teardownGroupTopic(group.id, topic.id);
    if (action === "cancel") await until(() => h.store.getRun(a.run.id)?.state === "cancelled");
    release.resolve(); await gate; await stopping; await drain;
    expect(h.runner.calls).toHaveLength(0); h.store.close();
  });
}

for (const crash of ["before claim", "after claim", "after start"] as const) {
  test(`production read-only acceptance survives restart ${crash} with the same ceiling`, async () => {
    const first = await harness(); const { group, topic } = await first.group(2);
    const a = await accept(first, group.id, topic.id, ["read-only", "read-only", "read-only"]);
    if (crash !== "before claim") {
      const claim = first.store.claimNextDispatch({ owner: "dead", now: "2026-10-07T00:00:00.000Z", leaseExpiresAt: "2026-10-07T00:01:00.000Z" })!;
      if (crash === "after start") first.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "dead", generation: claim.dispatch.generation,
        runId: a.run.id, memberTurnId: claim.memberTurn.id, sessionAlias: "retired", logicalSessionId: "retired", sourceTurnId: "retired", now: "2026-10-07T00:00:00.000Z" });
    }
    const state = parseState(JSON.parse(JSON.stringify(first.state))); first.store.close();
    const second = await harness({ path: first.path, state, ownerId: "new" });
    const drain = second.service.activateAfterConsumerLock(); await until(() => second.runner.calls.length === 2);
    expect(second.store.listMemberTurns(a.run.id).every((m) => m.effect === "read-only" && m.effectProvenance === "declared-enforced")).toBe(true);
    expect((await accept(second, group.id, topic.id, ["read-only", "read-only", "read-only"], a.run.requestId)).reused).toBe(true);
    second.runner.finish(0); await until(() => second.runner.calls.length === 3);
    second.runner.finish(1); second.runner.finish(2); await drain;
    expect(second.runner.peak).toBe(2); expect(second.runner.calls.every((c) => c.executionOrigin === "orchestration")).toBe(true);
    expect(second.store.getMemberTurn(a.memberTurns[0]!.id)?.attempt).toBe(crash === "after start" ? 2 : 1); second.store.close();
  });
}

for (const action of ["cancel", "teardown"] as const) {
  test(`mixed reader/writer completion races ${action} without refilling cancelled work`, async () => {
    const h = await harness(); const { group, topic } = await h.group(4);
    const a = await accept(h, group.id, topic.id, ["read-only", "read-only", "read-write", "read-only"]);
    const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 3);
    const stopping = action === "cancel" ? h.service.cancelRun(a.run.id) : h.service.teardownGroupTopic(group.id, topic.id);
    h.runner.finish(0); h.runner.finish(1); h.runner.finish(2);
    await stopping; await drain;
    expect(h.runner.calls.some((c) => c.botId === h.ids[2])).toBe(false);
    expect(h.runner.peak).toBe(3); h.store.close();
  });
}

test("two reader completions refill at most two slots and keep the pending writer exclusive", async () => {
  const h = await harness(); const { group, topic } = await h.group(2);
  await accept(h, group.id, topic.id, ["read-only", "read-only", "read-only", "read-write"]);
  const drain = h.dispatcher.kick(); await until(() => h.runner.calls.length === 2);
  h.runner.finish(0); h.runner.finish(1); await until(() => h.runner.calls.length === 3);
  expect(h.runner.calls[2]!.botId).toBe(h.ids[2]); expect(h.runner.active).toBe(1);
  h.runner.finish(2); await until(() => h.runner.calls.length === 4);
  expect(h.runner.active).toBe(1); h.runner.finish(3); await drain;
  expect(h.runner.peak).toBe(2); h.store.close();
});

for (const action of ["disable", "reconfigure"] as const) {
  test(`accepted read-only materialization vs Bot ${action} never reaches a writable provider`, async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({ hooks: { beforeRuntimeMaterialize: async () => {
      await h.bots.updateBot(h.ids[0]!, action === "disable" ? { enabled: false } : { agent: "unsupported" });
    } } });
    // Register a writable, unsupported adapter for the reconfiguration case.
    (h.config.agents as Record<string, unknown>).unsupported = { driver: "codex" };
    const { group, topic } = await h.group(2); await accept(h, group.id, topic.id, ["read-only"]);
    await h.dispatcher.kick(); expect(h.runner.calls).toHaveLength(0); h.store.close();
  });
}

test("read-only recovery re-proves the current runtime instead of falling back after drift", async () => {
  const first = await harness(); const { group, topic } = await first.group(2);
  const a = await accept(first, group.id, topic.id, ["read-only"]);
  const c = first.store.claimNextDispatch({ owner: "dead", now: "2026-10-07T00:00:00.000Z", leaseExpiresAt: "2026-10-07T00:01:00.000Z" })!;
  first.store.markExecutionStarted({ dispatchId: c.dispatch.id, owner: "dead", generation: c.dispatch.generation, runId: a.run.id,
    memberTurnId: c.memberTurn.id, sessionAlias: "old", logicalSessionId: "old", sourceTurnId: "old", now: "2026-10-07T00:00:00.000Z" });
  const state = parseState(first.state); first.store.close();
  const second = await harness({ path: first.path, state, ownerId: "new" }); second.config.agents.codex!.driver = "codex";
  await second.service.activateAfterConsumerLock(); expect(second.runner.calls).toHaveLength(0);
  expect(second.store.getMemberTurn(a.memberTurn.id)).toMatchObject({ effect: "read-only", effectProvenance: "declared-enforced", origin: "recovery", failureReason: "runtime_revision_mismatch" });
  second.store.close();
});
