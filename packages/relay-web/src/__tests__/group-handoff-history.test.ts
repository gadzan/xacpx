import { createPinia, setActivePinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MSG,
  type ConversationMessageDto,
  type ConversationRunDetailDto,
  type GroupSummaryDto,
  type MemberTurnSummaryDto,
  type TopicSummaryDto,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
const getRun = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: { rpc: (instanceId: string, type: string, payload: unknown) => mockRpc(instanceId, type, payload) },
}));

import { useGroupsStore } from "../stores/groups";

const GROUP: GroupSummaryDto = {
  id: "conversation_g", kind: "group", title: "Release team", botIds: ["bot_a", "bot_b"],
  leadBotId: "bot_a", createdAt: "now", updatedAt: "now",
};

function handoffMessage(overrides: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return {
    id: "handoff_old", conversationId: "conversation_g", topicId: "topic_1", runId: "run_old",
    seq: 7, role: "bot", senderBotId: "bot_a", content: "", createdAt: "now",
    handoff: {
      senderMemberTurnId: "turn_sender", to: "bot_b", assignmentId: "assignment_old",
      memberTurnId: "turn_old", task: "Review the first change", expectedOutput: "A review",
    },
    ...overrides,
  };
}

function runDetail(message = handoffMessage(), turnOverrides: Partial<MemberTurnSummaryDto> = {}): ConversationRunDetailDto {
  return {
    id: message.runId!, conversationId: message.conversationId, topicId: message.topicId,
    requestId: "request_old", requestMessageId: "request_message_old", mode: "explicit",
    state: "completed", profileRevision: 1, createdAt: "now",
    memberTurns: [{
      id: message.handoff!.memberTurnId, conversationId: message.conversationId, topicId: message.topicId,
      runId: message.runId!, botId: message.handoff!.to, assignmentId: message.handoff!.assignmentId,
      promptRequestId: "prompt_old", batch: 1, attempt: 1, origin: "handoff", state: "completed",
      createdAt: "now", ...turnOverrides,
    }],
  };
}

function topic(conversationId = "conversation_g", id = "topic_1"): TopicSummaryDto {
  return { id, conversationId, title: id, status: "active", createdAt: "now", updatedAt: "now" };
}

describe("read-only Group handoff Run history", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockRpc.mockReset();
    getRun.mockReset();
    getRun.mockResolvedValue({ run: runDetail() });
    mockRpc.mockImplementation(async (instanceId: string, type: string, payload: unknown) => {
      const scope = payload as { conversationId: string; topicId: string };
      if (type === MSG.groupsList) return { groups: [GROUP, { ...GROUP, id: "conversation_other" }] };
      if (type === MSG.botsList) return { bots: [
        { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ] };
      if (type === MSG.topicsList) return { topics: [topic(scope.conversationId), topic(scope.conversationId, "topic_2")] };
      if (type === MSG.conversationHistory) return {
        conversationId: scope.conversationId, topicId: scope.topicId,
        messages: [handoffMessage({ conversationId: scope.conversationId, topicId: scope.topicId })],
        oldestSeq: 7, newestSeq: 7, hasMoreBefore: true, hasMoreAfter: false,
      };
      if (type === MSG.runsList) return { conversationId: scope.conversationId, topicId: scope.topicId, runs: [] };
      if (type === MSG.runsGet) return getRun(instanceId, payload);
      if (type === MSG.topicsTeardown || type === MSG.groupsDelete) return { ok: true };
      if (type === MSG.topicsClear) return { topic: topic(scope.conversationId, scope.topicId) };
      throw new Error(`Unexpected RPC ${type}`);
    });
  });

  it("returns historical detail without changing execution, composer, plan, transcript or cursors", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const live = runDetail(handoffMessage({ runId: "run_live" }), { id: "turn_live", state: "running" });
    store.activeRun = { ...live, state: "running" };
    store.memberTurnsById = { turn_live: live.memberTurns[0]! };
    store.applyEvent({ kind: "control-event", instanceId: "inst_1", event: {
      type: "plan", chatKey: "chat_live", sessionAlias: "session_live",
      conversation: { conversationId: GROUP.id, topicId: "topic_1", runId: "run_live", memberTurnId: "turn_live" },
      entries: [{ content: "Keep the current plan", status: "in_progress", priority: "high" }],
    } });
    store.liveTurnsByMember.turn_live!.parts = [{ type: "text", text: "Current output" }];
    store.runParts = { turn_live: [{ type: "text", text: "Current completed trace" }] };
    store.cancellingRunId = "run_live";
    store.cancelUncertaintyRunId = "run_live";
    store.cancelError = "cancelUnknown";
    store.ownershipUncertain = true;
    store.promptInFlight = true;
    store.promptError = "promptPendingConfirmation";
    store.uncertainPrompt = { requestId: "request_live", text: "Keep this draft", target: { mode: "members", botIds: ["bot_a"] }, media: [] };
    const before = JSON.stringify(store.$state);

    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({
      id: "run_old", conversationId: "conversation_g", topicId: "topic_1", state: "completed",
      memberTurns: [{ id: "turn_old", botId: "bot_b", promptRequestId: "prompt_old", state: "completed" }],
    });
    expect(JSON.stringify(store.$state)).toBe(before);
    expect(store.activeRun?.id).toBe("run_live");
    expect(store.cancelUncertaintyRunId).toBe("run_live");
    expect(store.uncertainPromptText).toBe("Keep this draft");
    expect(store.planEntries).toEqual([{ content: "Keep the current plan", status: "in_progress", priority: "high" }]);
    expect(store.oldestSeq).toBe(7);
    expect(store.newestSeq).toBe(7);
    expect(store.hasMoreBefore).toBe(true);
    expect(store.isRunActive).toBe(true);
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ id: "run_old", state: "completed" });
    expect(JSON.stringify(store.$state)).toBe(before);
  });

  it("coalesces two assignments in the same Run and reuses their actual detail", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const second = handoffMessage({
      id: "handoff_second", seq: 8,
      handoff: { ...handoffMessage().handoff!, memberTurnId: "turn_second", assignmentId: "assignment_second" },
    });
    const detail = runDetail();
    detail.memberTurns.push(runDetail(second, { promptRequestId: "prompt_second" }).memberTurns[0]!);
    const gate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    getRun.mockReturnValue(gate.promise);
    const firstRequest = store.loadHandoffRunDetail(handoffMessage());
    const secondRequest = store.loadHandoffRunDetail(second);
    gate.resolve({ run: detail });
    for (const result of await Promise.all([firstRequest, secondRequest])) {
      expect(result).toMatchObject({ id: "run_old", memberTurns: [
        { id: "turn_old", assignmentId: "assignment_old", promptRequestId: "prompt_old" },
        { id: "turn_second", assignmentId: "assignment_second", promptRequestId: "prompt_second" },
      ] });
    }
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith("inst_1", { runId: "run_old" });
    expect(await store.loadHandoffRunDetail(second)).toEqual(detail);
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it.each(["topic", "group", "instance", "clear"])("discards a pending response after a %s selection change", async (change) => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const gate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    getRun.mockReturnValueOnce(gate.promise);
    const request = store.loadHandoffRunDetail(handoffMessage());
    if (change === "topic") await store.switchTopic("topic_2");
    if (change === "group") await store.selectGroup("inst_1", "conversation_other");
    if (change === "instance") await store.selectGroup("inst_2", GROUP.id);
    if (change === "clear") store.clearSelection();
    gate.resolve({ run: runDetail() });
    expect(await request).toBeNull();
    await store.selectGroup("inst_1", GROUP.id);
    getRun.mockResolvedValueOnce({ run: runDetail(undefined, { promptRequestId: "prompt_fresh" }) });
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({
      id: "run_old", memberTurns: [{ promptRequestId: "prompt_fresh" }],
    });
    expect(store.activeRun).toBeNull();
    expect(store.messages[0]?.id).toBe("handoff_old");
  });

  it("fences ABA navigation without letting an old request retire its replacement", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const oldGate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    const newGate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    getRun.mockReturnValueOnce(oldGate.promise).mockReturnValueOnce(newGate.promise);
    const oldRequest = store.loadHandoffRunDetail(handoffMessage());
    await store.switchTopic("topic_2");
    await store.switchTopic("topic_1");
    const newRequest = store.loadHandoffRunDetail(handoffMessage());
    oldGate.resolve({ run: runDetail(undefined, { promptRequestId: "prompt_stale" }) });
    expect(await oldRequest).toBeNull();
    const coalesced = store.loadHandoffRunDetail(handoffMessage());
    newGate.resolve({ run: runDetail(undefined, { promptRequestId: "prompt_fresh" }) });
    expect(await newRequest).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_fresh" }] });
    expect(await coalesced).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_fresh" }] });
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("also fences synchronous scope ABA changes", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const gate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    getRun.mockReturnValueOnce(gate.promise);
    const request = store.loadHandoffRunDetail(handoffMessage());
    store.activeTopicId = "topic_2";
    store.activeTopicId = "topic_1";
    gate.resolve({ run: runDetail() });
    expect(await request).toBeNull();
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ id: "run_old", topicId: "topic_1" });
  });

  it("does not share identical Run IDs across instances, Topics or Groups", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_old" }] });
    await store.selectGroup("inst_2", GROUP.id);
    getRun.mockResolvedValueOnce({ run: runDetail(undefined, { promptRequestId: "prompt_inst_2" }) });
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_inst_2" }] });
    await store.switchTopic("topic_2");
    const topicMessage = handoffMessage({ topicId: "topic_2" });
    getRun.mockResolvedValueOnce({ run: runDetail(topicMessage, { promptRequestId: "prompt_topic_2" }) });
    expect(await store.loadHandoffRunDetail(topicMessage)).toMatchObject({ topicId: "topic_2", memberTurns: [{ promptRequestId: "prompt_topic_2" }] });
    expect(await store.loadHandoffRunDetail(handoffMessage())).toBeNull();
    await store.selectGroup("inst_2", "conversation_other");
    const groupMessage = handoffMessage({ conversationId: "conversation_other" });
    getRun.mockResolvedValueOnce({ run: runDetail(groupMessage, { promptRequestId: "prompt_other_group" }) });
    expect(await store.loadHandoffRunDetail(groupMessage)).toMatchObject({
      conversationId: "conversation_other", memberTurns: [{ promptRequestId: "prompt_other_group" }],
    });
  });

  it.each(["transport", "RPC error", "missing", "Run ID", "conversation", "Topic", "member list"])(
    "returns null for a %s failure and allows a later explicit expansion", async (failure) => {
      const store = useGroupsStore();
      await store.selectGroup("inst_1", GROUP.id);
      const before = JSON.stringify(store.$state);
      if (failure === "transport") getRun.mockRejectedValueOnce(new Error("offline"));
      if (failure === "RPC error") getRun.mockResolvedValueOnce({ error: { code: "run_not_found", message: "Deleted" } });
      if (failure === "missing") getRun.mockResolvedValueOnce({ run: null });
      if (failure === "Run ID") getRun.mockResolvedValueOnce({ run: { ...runDetail(), id: "wrong_run" } });
      if (failure === "conversation") getRun.mockResolvedValueOnce({ run: { ...runDetail(), conversationId: "wrong_group" } });
      if (failure === "Topic") getRun.mockResolvedValueOnce({ run: { ...runDetail(), topicId: "wrong_topic" } });
      if (failure === "member list") getRun.mockResolvedValueOnce({ run: { ...runDetail(), memberTurns: undefined } });
      expect(await store.loadHandoffRunDetail(handoffMessage())).toBeNull();
      expect(JSON.stringify(store.$state)).toBe(before);
      getRun.mockResolvedValueOnce({ run: runDetail(undefined, { promptRequestId: "prompt_recovered" }) });
      expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({
        id: "run_old", memberTurns: [{ id: "turn_old", promptRequestId: "prompt_recovered" }],
      });
      expect(JSON.stringify(store.$state)).toBe(before);
      expect(getRun).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["missing", "duplicate", "Run ID", "conversation", "Topic", "Bot", "assignment"])(
    "rejects a %s target correlation without caching it as valid", async (conflict) => {
      const store = useGroupsStore();
      await store.selectGroup("inst_1", GROUP.id);
      const invalid = runDetail();
      if (conflict === "missing") invalid.memberTurns = [];
      if (conflict === "duplicate") invalid.memberTurns.push({ ...invalid.memberTurns[0]!, promptRequestId: "conflicting_prompt" });
      if (conflict === "Run ID") invalid.memberTurns[0]!.runId = "wrong_run";
      if (conflict === "conversation") invalid.memberTurns[0]!.conversationId = "wrong_group";
      if (conflict === "Topic") invalid.memberTurns[0]!.topicId = "wrong_topic";
      if (conflict === "Bot") invalid.memberTurns[0]!.botId = "bot_a";
      if (conflict === "assignment") invalid.memberTurns[0]!.assignmentId = "wrong_assignment";
      getRun.mockResolvedValueOnce({ run: invalid });
      expect(await store.loadHandoffRunDetail(handoffMessage())).toBeNull();
      expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({
        id: "run_old", memberTurns: [{ id: "turn_old", botId: "bot_b", promptRequestId: "prompt_old" }],
      });
    },
  );

  it("accepts absent optional assignment and prompt evidence without inventing it", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    getRun.mockResolvedValueOnce({ run: runDetail(undefined, { assignmentId: undefined, promptRequestId: undefined, state: "indeterminate" }) });
    const result = await store.loadHandoffRunDetail(handoffMessage());
    expect(result).toMatchObject({ id: "run_old", memberTurns: [{ id: "turn_old", state: "indeterminate" }] });
    expect(result?.memberTurns[0]?.assignmentId).toBeUndefined();
    expect(result?.memberTurns[0]?.promptRequestId).toBeUndefined();
    expect(store.memberTurnsById).toEqual({});
  });

  it("bounds completed details and refetches the oldest evicted Run", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const reads: Record<string, number> = {};
    getRun.mockImplementation(async (_instanceId: string, { runId }: { runId: string }) => {
      reads[runId] = (reads[runId] ?? 0) + 1;
      return { run: runDetail(handoffMessage({ runId }), { promptRequestId: `prompt_${runId}_${reads[runId]}` }) };
    });
    for (let index = 0; index < 21; index += 1) {
      const runId = `run_${index}`;
      expect(await store.loadHandoffRunDetail(handoffMessage({ runId }))).toMatchObject({
        id: runId, memberTurns: [{ promptRequestId: `prompt_${runId}_1` }],
      });
    }
    expect(await store.loadHandoffRunDetail(handoffMessage({ runId: "run_20" }))).toMatchObject({
      id: "run_20", memberTurns: [{ promptRequestId: "prompt_run_20_1" }],
    });
    expect(await store.loadHandoffRunDetail(handoffMessage({ runId: "run_0" }))).toMatchObject({
      id: "run_0", memberTurns: [{ promptRequestId: "prompt_run_0_2" }],
    });
    expect(getRun).toHaveBeenCalledTimes(22);
  });

  it.each(["run", "started", "finished", "message", "Topic", "snapshot", "status", "reconnect", "coarse", "clear"])(
    "invalidates cached detail on %s changes and exposes fresh data", async (change) => {
      const store = useGroupsStore();
      await store.selectGroup("inst_1", GROUP.id);
      store.activeRun = { ...runDetail(handoffMessage({ runId: "run_live" })), state: "running" };
      expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_old" }] });
      const revision = store.handoffDetailRevision;
      const run = runDetail();
      const memberTurn = run.memberTurns[0]!;
      let event: WebServerEvent | undefined;
      if (change === "run") event = { kind: "control-event", instanceId: "inst_1", event: { type: "conversation-run-changed", run } };
      if (change === "started") event = { kind: "control-event", instanceId: "inst_1", event: { type: "member-turn-started", run, memberTurn } };
      if (change === "finished") event = { kind: "control-event", instanceId: "inst_1", event: { type: "member-turn-finished", run, memberTurn } };
      if (change === "message") event = { kind: "control-event", instanceId: "inst_1", event: { type: "conversation-message", message: handoffMessage({ id: "replayed_handoff" }) } };
      if (change === "Topic") event = { kind: "control-event", instanceId: "inst_1", event: { type: "conversation-topic-changed", topic: topic() } };
      if (change === "snapshot") event = { kind: "state-snapshot", instanceId: "inst_1", turns: [], usage: [], commands: [] };
      if (change === "status") event = { kind: "instance-status", instanceId: "inst_1", online: true };
      if (change === "coarse") event = { kind: "control-event", instanceId: "inst_1", event: { type: "conversations-changed" } };
      if (event) store.applyEvent(event);
      if (change === "reconnect") await store.reconcileOnReconnect();
      if (change === "clear") await store.clearTopic("inst_1", GROUP.id, "topic_1", "clear_request");
      await flushPromises();
      expect(store.handoffDetailRevision).toBeGreaterThan(revision);
      getRun.mockResolvedValueOnce({ run: runDetail(undefined, { promptRequestId: "prompt_refreshed", state: "indeterminate" }) });
      expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({
        id: "run_old", memberTurns: [{ promptRequestId: "prompt_refreshed", state: "indeterminate" }],
      });
    },
  );

  it("discards an in-flight snapshot invalidated by a MemberTurn event", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    store.activeRun = { ...runDetail(handoffMessage({ runId: "run_live" })), state: "running" };
    const gate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    getRun.mockReturnValueOnce(gate.promise);
    const request = store.loadHandoffRunDetail(handoffMessage());
    const run = runDetail();
    store.applyEvent({ kind: "control-event", instanceId: "inst_1", event: {
      type: "member-turn-finished", run, memberTurn: run.memberTurns[0]!,
    } });
    gate.resolve({ run });
    expect(await request).toBeNull();
    getRun.mockResolvedValueOnce({ run: runDetail(undefined, { promptRequestId: "prompt_after_event" }) });
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_after_event" }] });
    expect(store.activeRun?.id).toBe("run_live");
  });

  it("does not invalidate the current cached detail for other instances or Topics", async () => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_old" }] });
    const revision = store.handoffDetailRevision;
    store.applyEvent({ kind: "control-event", instanceId: "inst_2", event: { type: "conversation-run-changed", run: runDetail() } });
    store.applyEvent({ kind: "control-event", instanceId: "inst_1", event: { type: "conversation-run-changed", run: runDetail(handoffMessage({ topicId: "topic_2" })) } });
    expect(store.handoffDetailRevision).toBe(revision);
    expect(await store.loadHandoffRunDetail(handoffMessage())).toMatchObject({ memberTurns: [{ promptRequestId: "prompt_old" }] });
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it.each(["Topic", "Group"])("does not resurrect detail after local %s deletion", async (deletion) => {
    const store = useGroupsStore();
    await store.selectGroup("inst_1", GROUP.id);
    const gate = Promise.withResolvers<{ run: ConversationRunDetailDto }>();
    getRun.mockReturnValueOnce(gate.promise);
    const request = store.loadHandoffRunDetail(handoffMessage());
    if (deletion === "Topic") await store.teardownTopic("inst_1", GROUP.id, "topic_1", "delete_request");
    else await store.deleteGroup("inst_1", GROUP.id);
    gate.resolve({ run: runDetail() });
    expect(await request).toBeNull();
    expect(await store.loadHandoffRunDetail(handoffMessage())).toBeNull();
    if (deletion === "Topic") {
      await flushPromises();
      const next = handoffMessage({ topicId: "topic_2" });
      getRun.mockResolvedValueOnce({ run: runDetail(next) });
      expect(await store.loadHandoffRunDetail(next)).toMatchObject({ id: "run_old", topicId: "topic_2" });
    } else {
      expect(store.instanceId).toBeNull();
      expect(store.activeConversationId).toBeNull();
      await store.selectGroup("inst_2", "conversation_other");
      const next = handoffMessage({ conversationId: "conversation_other" });
      getRun.mockResolvedValueOnce({ run: runDetail(next) });
      expect(await store.loadHandoffRunDetail(next)).toMatchObject({ id: "run_old", conversationId: "conversation_other" });
    }
  });
});
