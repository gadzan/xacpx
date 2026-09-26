import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type {
  BotSummaryDto,
  ConversationHistoryResponseDto,
  ConversationPromptResponseDto,
  ConversationRunDto,
  GroupSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import GroupTranscript from "../components/GroupTranscript.vue";

const mockRpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload),
  },
}));

import { useGroupsStore } from "../stores/groups";

const GROUP: GroupSummaryDto = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: ["bot_a", "bot_b"],
  leadBotId: "bot_a",
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];

function historyWith(messages: ConversationHistoryResponseDto["messages"]): ConversationHistoryResponseDto {
  return {
    conversationId: "conversation_g",
    topicId: "topic_1",
    messages,
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
}

describe("useGroupsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
    localStorage.clear();
  });

  it("loads groups for an instance", async () => {
    const store = useGroupsStore();
    mockRpc.mockResolvedValueOnce({ groups: [GROUP] });
    const groups = await store.loadGroups("inst_1");
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.groups.list", {});
    expect(groups).toEqual([GROUP]);
    expect(store.groupsByInstance["inst_1"]).toEqual([GROUP]);
    expect(store.groupsLoaded["inst_1"]).toBe(true);
  });

  it("selects a group with lead default target and converges history plus owner", async () => {
    const store = useGroupsStore();
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") {
        return historyWith([{
          id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
          role: "human", content: "hi", createdAt: "now",
        }]);
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        ] };
      }
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    expect(store.isGroupSelected).toBe(true);
    expect(store.activeConversationId).toBe("conversation_g");
    expect(store.activeTopicId).toBe("topic_1");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    expect(store.messages).toHaveLength(1);
    expect(store.topicReady).toBe(true);
  });

  it("does not let a slower Group selection overwrite a newer one", async () => {
    const store = useGroupsStore();
    const groupA: GroupSummaryDto = { ...GROUP, id: "conversation_a", title: "A", leadBotId: "bot_a", botIds: ["bot_a"] };
    const groupB: GroupSummaryDto = { ...GROUP, id: "conversation_b", title: "B", leadBotId: "bot_b", botIds: ["bot_b"] };
    // Group A's bots.list hangs until the test releases it.
    let releaseA!: () => void;
    const aHang = new Promise<void>((resolve) => { releaseA = resolve; });
    let aBotsRequested = false;
    mockRpc.mockImplementation(async (inst: string, type: string, payload?: unknown) => {
      if (type === "control.groups.list") return { groups: [groupA, groupB] };
      if (type === "control.topics.list") {
        const conversationId = (payload as { conversationId: string }).conversationId;
        return { topics: [{ id: `topic_${conversationId}`, conversationId, title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") {
        if (!aBotsRequested) {
          aBotsRequested = true;
          await aHang;
          return { bots: [{ id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" }] };
        }
        return { bots: [{ id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") {
        return { runs: [], conversationId: store.activeConversationId ?? "conversation_b", topicId: store.activeTopicId ?? "topic_conversation_b" };
      }
      throw new Error(`unexpected ${type}`);
    });
    // Select A (its bots request parks), then complete the selection of B.
    const selectingA = store.selectGroup("inst_1", "conversation_a");
    await flushPromises();
    expect(aBotsRequested).toBe(true);
    await store.selectGroup("inst_1", "conversation_b");
    // Now let A's slow response land: it must not touch B's selection.
    releaseA();
    await selectingA;
    await flushPromises();
    expect(store.selectedGroupId).toBe("conversation_b");
    expect(store.activeConversationId).toBe("conversation_b");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
  });

  it("opens the first active Topic, not the oldest archived one", async () => {
    const store = useGroupsStore();
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        // Oldest Topic is archived: the picker must skip it.
        return { topics: [
          { id: "topic_old", conversationId: "conversation_g", title: "Old", status: "archived", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "topic_new", conversationId: "conversation_g", title: "Current", status: "active", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
        ] };
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        ] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_new" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    expect(store.activeTopicId).toBe("topic_new");
    expect(store.currentTopic?.status).toBe("active");
  });

  it("skips a disabled lead and a disabled first member in the default target", async () => {
    const store = useGroupsStore();
    const disabledLead: GroupSummaryDto = { ...GROUP, leadBotId: "bot_a", botIds: ["bot_a", "bot_b"] };
    // Bot catalog marks the lead disabled and the first member disabled: the
    // default must fall to an executable member.
    const store1 = useGroupsStore();
    void store1;
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [disabledLead] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        ] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
  });

  it("default target falls back to everyone when every member is disabled", async () => {
    const store = useGroupsStore();
    const allDisabled: GroupSummaryDto = { ...GROUP, leadBotId: "bot_a", botIds: ["bot_a", "bot_b"] };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [allDisabled] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
        ] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    expect(store.targetSelection).toEqual({ mode: "everyone" });
  });

  it("falls back to deterministic first-by-ID member when no lead is set", async () => {
    const store = useGroupsStore();
    const noLead: GroupSummaryDto = { ...GROUP, leadBotId: undefined, botIds: ["bot_b", "bot_a"] };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [noLead] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        ] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
  });

  it("sends structured members target", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_a", "bot_a", "bot_b"] };

    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_1",
      message: {
        id: "msg_2", conversationId: "conversation_g", topicId: "topic_1", seq: 2,
        role: "human", content: "ship it", createdAt: "now",
      },
      run: {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_2", requestId: "req_1", mode: "explicit", state: "queued",
        profileRevision: 1, createdAt: "now",
      },
      memberTurn: {
        id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
      },
      memberTurns: [
        {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
        },
        {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
        },
      ],
    };
    mockRpc.mockResolvedValueOnce(promptResponse);
    await store.sendPrompt("ship it");
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.conversation.prompt", {
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: expect.any(String),
      text: "ship it",
      target: { mode: "members", botIds: ["bot_a", "bot_b"] },
    });
    expect(store.activeRun?.id).toBe("run_1");
    expect(store.memberTurns.map((t) => t.botId)).toEqual(["bot_a", "bot_b"]);
  });

  it("sends everyone target", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "everyone" };
    store.uncertainPrompt = null;
    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_everyone",
      message: {
        id: "msg_9", conversationId: "conversation_g", topicId: "topic_1", seq: 9,
        role: "human", content: "all hands", createdAt: "now",
      },
      run: {
        id: "run_9", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_9", requestId: "req_draft_everyone", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      },
      memberTurn: {
        id: "turn_9a", runId: "run_9", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "running", createdAt: "now",
      },
    };
    mockRpc.mockResolvedValueOnce(promptResponse);
    await store.sendPrompt("all hands");
    expect(mockRpc).toHaveBeenLastCalledWith("inst_1", "control.conversation.prompt", expect.objectContaining({
      target: { mode: "everyone" },
    }));
    expect(store.activeRun?.id).toBe("run_9");
  });

  it("mentionBot only adds eligible members and mentionEveryone selects all", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.groupsByInstance["inst_1"] = [GROUP];
    store.groupDetails["inst_1:conversation_g"] = { ...GROUP, topics: [] };
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    store.mentionBot("bot_b");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a", "bot_b"] });
    store.mentionBot("bot_ghost");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a", "bot_b"] });
    store.mentionEveryone();
    expect(store.targetSelection).toEqual({ mode: "everyone" });
    store.mentionBot("bot_a");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
  });

  it("display-name collision does not affect routing identity", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_b"] };
    mockRpc.mockResolvedValueOnce({
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_x",
      message: {
        id: "msg_x", conversationId: "conversation_g", topicId: "topic_1", seq: 9,
        role: "human", content: "hi Reviewer", createdAt: "now",
      },
      run: {
        id: "run_x", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_x", requestId: "req_x", mode: "explicit", state: "queued",
        profileRevision: 1, createdAt: "now",
      },
      memberTurn: {
        id: "turn_x", runId: "run_x", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
      },
    });
    await store.sendPrompt("hi Reviewer");
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.conversation.prompt", expect.objectContaining({
      target: { mode: "members", botIds: ["bot_b"] },
    }));
    expect(store.memberTurns.map((t) => t.botId)).toEqual(["bot_b"]);
  });

  it("joins member-turn events by exact runId and memberTurnId", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    const run: ConversationRunDto = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "queued",
      profileRevision: 1, createdAt: "now",
    };
    store.activeRun = run;
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-started",
        run: { ...run, state: "running" },
        memberTurn: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "running", createdAt: "now",
        },
      },
    } as never);
    expect(store.memberTurnsById["turn_a"]?.state).toBe("running");
    expect(store.liveTurnsByMember["turn_a"]).toBeTruthy();
    // Foreign run must not steal the active run.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-finished",
        run: { ...run, id: "run_foreign", state: "completed" },
        memberTurn: {
          id: "turn_z", runId: "run_foreign", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "completed", createdAt: "now",
        },
      },
    } as never);
    expect(store.activeRun?.id).toBe("run_1");
    expect(store.memberTurnsById["turn_z"]).toBeUndefined();
  });

  it("stops the exact active run by runId", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.activeRun = {
      id: "run_stop", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now",
    };
    mockRpc.mockResolvedValueOnce({
      ok: true,
      run: { ...store.activeRun, state: "cancelled" as const, memberTurns: [] },
    });
    await store.cancelCurrentRun();
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.runs.cancel", { runId: "run_stop" });
    expect(store.activeRun?.state).toBe("cancelled");
  });

  it("reconnect converges without duplicating messages", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") {
        return historyWith([{
          id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
          role: "human", content: "hi", createdAt: "now",
        }]);
      }
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.reconcileOnReconnect();
    await flushPromises();
    expect(store.messages.filter((m) => m.id === "msg_1")).toHaveLength(1);
    expect(store.topicReady).toBe(true);
  });

  it("senderNameFor resolves Bot display names without routing", async () => {
    const store = useGroupsStore();
    expect(store.senderNameFor("bot_a", BOTS)).toBe("Reviewer");
    expect(store.senderNameFor("bot_ghost", BOTS)).toBe("Bot");
    expect(store.senderNameFor(undefined, BOTS)).toBe("Bot");
  });

  it("keeps per-member TurnParts isolated inside one multi-member Run", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    const run: ConversationRunDto = {
      id: "run_multi", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now",
    };
    store.activeRun = run;
    for (const [turnId, botId, promptRequestId] of [
      ["turn_a", "bot_a", "src_a"],
      ["turn_b", "bot_b", "src_b"],
    ] as const) {
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "member-turn-started",
          run,
          memberTurn: {
            id: turnId, runId: "run_multi", conversationId: "conversation_g", topicId: "topic_1",
            botId, batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
            state: "running", createdAt: "now", startedAt: "now",
          },
        },
      } as never);
    }
    const corr = (memberTurnId: string, botId: string) => ({
      conversationId: "conversation_g", topicId: "topic_1", botId, runId: "run_multi", memberTurnId,
    });
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "turn-output",
        chatKey: "bot:conversation_g:topic_1",
        sessionAlias: "s_a",
        chunk: "review output",
        conversation: corr("turn_a", "bot_a"),
      },
    } as never);
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "tool-event",
        chatKey: "bot:conversation_g:topic_1",
        sessionAlias: "s_a",
        step: { toolCallId: "tc_a", toolName: "read", kind: "read", status: "completed", title: "a.ts" },
        conversation: corr("turn_a", "bot_a"),
      },
    } as never);
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "turn-output",
        chatKey: "bot:conversation_g:topic_1",
        sessionAlias: "s_b",
        chunk: "test output",
        conversation: corr("turn_b", "bot_b"),
      },
    } as never);
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "tool-event",
        chatKey: "bot:conversation_g:topic_1",
        sessionAlias: "s_b",
        step: { toolCallId: "tc_b", toolName: "bash", kind: "execute", status: "completed", title: "run tests" },
        conversation: corr("turn_b", "bot_b"),
      },
    } as never);
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "turn-finished",
        chatKey: "bot:conversation_g:topic_1",
        sessionAlias: "s_a",
        ok: true,
        conversation: corr("turn_a", "bot_a"),
      },
    } as never);
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "turn-finished",
        chatKey: "bot:conversation_g:topic_1",
        sessionAlias: "s_b",
        ok: true,
        conversation: corr("turn_b", "bot_b"),
      },
    } as never);

    // One complete entry per member, both still present after the second finish.
    expect(Object.keys(store.completeRunParts).sort()).toEqual(["turn_a", "turn_b"]);
    expect(store.completeRunParts["turn_a"].map((p) => p.type)).toEqual(["text", "tool"]);
    expect(store.completeRunParts["turn_b"].map((p) => p.type)).toEqual(["text", "tool"]);
    const partA = store.completeRunParts["turn_a"][1];
    const partB = store.completeRunParts["turn_b"][1];
    expect(partA).toMatchObject({ type: "tool", step: { toolCallId: "tc_a" } });
    expect(partB).toMatchObject({ type: "tool", step: { toolCallId: "tc_b" } });

    // Durable bot rows resolve to their own member trace, not the newest one.
    store.memberTurnsById = {
      turn_a: {
        id: "turn_a", runId: "run_multi", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
        state: "completed", createdAt: "now", promptRequestId: "src_a",
      },
      turn_b: {
        id: "turn_b", runId: "run_multi", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_b", batch: 1, memberIndex: 1, attempt: 1, origin: "human-explicit",
        state: "completed", createdAt: "now", promptRequestId: "src_b",
      },
    };
    const wrapper = mount(GroupTranscript, {
      props: { bots: BOTS },
      global: { plugins: [i18n] },
    });
    const rows = wrapper.findAll('[data-test="group-member-row"]');
    expect(rows).toHaveLength(2);
    await rows[0]!.find('[data-test="group-member-toggle"]').trigger("click");
    await rows[1]!.find('[data-test="group-member-toggle"]').trigger("click");
    const activities = wrapper.findAll('[data-test="group-member-activity"]');
    expect(activities[0]!.text()).toContain("review output");
    expect(activities[1]!.text()).toContain("test output");
    expect(activities[0]!.text()).not.toContain("test output");
    expect(activities[1]!.text()).not.toContain("review output");
  });

  it("keeps live member traces separate on reconnect state snapshots", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.runs.get") {
        return { run: { id: "run_re", conversationId: "conversation_g", topicId: "topic_1", requestMessageId: "msg_1", requestId: "req_re", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now", memberTurns: [] } };
      }
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    store.applyEvent({
      kind: "state-snapshot",
      instanceId: "inst_1",
      turns: [
        {
          instanceId: "inst_1", sessionAlias: "s_a", status: "working", startedAt: 1,
          parts: [{ type: "text", text: "alpha work" }],
          conversation: { conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a", runId: "run_re", memberTurnId: "turn_a" },
        },
        {
          instanceId: "inst_1", sessionAlias: "s_b", status: "working", startedAt: 2,
          parts: [{ type: "text", text: "beta work" }],
          conversation: { conversationId: "conversation_g", topicId: "topic_1", botId: "bot_b", runId: "run_re", memberTurnId: "turn_b" },
        },
      ],
    } as never);
    expect(Object.keys(store.runParts).sort()).toEqual(["turn_a", "turn_b"]);
    expect(store.runParts["turn_a"]).toEqual([{ type: "text", text: "alpha work" }]);
    expect(store.runParts["turn_b"]).toEqual([{ type: "text", text: "beta work" }]);
    const liveA = store.liveTurnsByMember["turn_a"];
    const liveB = store.liveTurnsByMember["turn_b"];
    expect(liveA?.parts).toEqual([{ type: "text", text: "alpha work" }]);
    expect(liveB?.parts).toEqual([{ type: "text", text: "beta work" }]);
  });

  it("retries an uncertain prompt with the frozen target, not the current one", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_frozen",
      message: {
        id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
        role: "human", content: "review", createdAt: "now",
      },
      run: {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_frozen", mode: "explicit", state: "queued",
        profileRevision: 1, createdAt: "now",
      },
      memberTurn: {
        id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
      },
    };
    // First send: server accepted (response lost — model the transport error).
    mockRpc.mockRejectedValueOnce(new Error("network down"));
    await store.sendPrompt("review");
    expect(store.uncertainPromptText).toBe("review");
    // The user re-points the UI at Bot B before retrying.
    store.targetSelection = { mode: "members", botIds: ["bot_b"] };
    mockRpc.mockResolvedValueOnce(promptResponse);
    await store.retryUncertainPrompt();
    // The retry must resend the ORIGINAL target: the durable accept is keyed on
    // that (conversation, topic, requestId) triple, so re-routing here would
    // show Bot B in the UI while the server keeps executing Bot A.
    const promptCalls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    const retryCall = promptCalls[promptCalls.length - 1];
    expect(retryCall?.[2]).toMatchObject({
      target: { mode: "members", botIds: ["bot_a"] },
    });
    // Same requestId as the original attempt: the server dedupes on it.
    const firstCall = promptCalls[0];
    expect(retryCall?.[2]).toMatchObject({ requestId: firstCall?.[2].requestId });
  });

  it("refuses a fresh send while an earlier prompt's outcome is unknown", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_first",
      message: {
        id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
        role: "human", content: "review", createdAt: "now",
      },
      run: {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_first", mode: "explicit", state: "queued",
        profileRevision: 1, createdAt: "now",
      },
      memberTurn: {
        id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
      },
    };
    // Server accepted, response lost: the tuple stays frozen.
    mockRpc.mockRejectedValueOnce(new Error("network down"));
    await store.sendPrompt("review");
    expect(store.hasUncertainPrompt).toBe(true);
    const frozenRequestId = store.uncertainPrompt?.requestId;
    // User re-points at Bot B and presses the ordinary Send.
    store.targetSelection = { mode: "members", botIds: ["bot_b"] };
    mockRpc.mockResolvedValue(promptResponse);
    await store.sendPrompt("review");
    // No second prompt may be sent: the original Run is executing and minting a
    // new request would execute Bot B as well.
    const promptCalls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.[2]).toMatchObject({
      target: { mode: "members", botIds: ["bot_a"] },
    });
    void promptResponse;
    expect(store.uncertainPrompt).toMatchObject({ requestId: frozenRequestId, text: "review" });
    expect(store.promptError).toBe("promptPendingConfirmation");
    // Same-text fresh send is blocked too: identity would be wrong for the new text.
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    await store.sendPrompt("another ask");
    expect(mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt")).toHaveLength(1);
    // Retrying the frozen tuple still resolves it.
    await store.retryUncertainPrompt().catch(() => {});
    const retryCalls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[1]?.[2]).toMatchObject({
      requestId: frozenRequestId,
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    });
  });

  it("clears the uncertain tuple on a definitive rejection so the user can correct and resend", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_ghost"] };
    // Server-side refusals arrive as a resolved error payload, not a rejection.
    mockRpc.mockResolvedValueOnce({ error: { code: "group_member_not_member", message: "not a member" } });
    await store.sendPrompt("review");
    expect(store.hasUncertainPrompt).toBe(false);
    expect(store.promptError).toBe("targetUnknownMember");
    // Correcting the target and sending fresh now works: the acceptance could
    // never have happened, so there is nothing to reconcile.
    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_fixed",
      message: {
        id: "msg_2", conversationId: "conversation_g", topicId: "topic_1", seq: 2,
        role: "human", content: "review", createdAt: "now",
      },
      run: {
        id: "run_2", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_2", requestId: "req_fixed", mode: "explicit", state: "queued",
        profileRevision: 1, createdAt: "now",
      },
      memberTurn: {
        id: "turn_fix", runId: "run_2", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now",
      },
    };
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.conversation.prompt") return promptResponse;
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.sendPrompt("review");
    const promptCalls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.[2]).toMatchObject({ target: { mode: "members", botIds: ["bot_a"] } });
  });

  it("keeps the uncertain tuple when the failure is only a transport error", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    // A plain network failure says nothing about the durable outcome.
    mockRpc.mockRejectedValueOnce(new Error("socket closed"));
    await store.sendPrompt("review");
    expect(store.hasUncertainPrompt).toBe(true);
    expect(store.promptError).toBe("socket closed");
  });

  it("does not let a stale Topic refresh overwrite a newly opened Group", async () => {
    const store = useGroupsStore();
    const groupA: GroupSummaryDto = { ...GROUP, id: "conversation_a", title: "A", botIds: ["bot_a"], leadBotId: "bot_a" };
    const groupB: GroupSummaryDto = { ...GROUP, id: "conversation_b", title: "B", botIds: ["bot_b"], leadBotId: "bot_b" };
    let releaseA!: () => void;
    const aHang = new Promise<void>((resolve) => { releaseA = resolve; });
    let topicsListCalls = 0;
    mockRpc.mockImplementation(async (inst: string, type: string, payload?: unknown) => {
      if (type === "control.groups.list") return { groups: [groupA, groupB] };
      if (type === "control.topics.list") {
        topicsListCalls += 1;
        const conversationId = (payload as { conversationId: string }).conversationId;
        // Call 1 is Group A's initial load (must resolve). Call 2 is the
        // coarse-change refresh, which parks until the test releases it.
        if (topicsListCalls === 2) {
          await aHang;
          return { topics: [] };
        }
        return { topics: [{ id: `topic_${conversationId}`, conversationId, title: "S", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        ] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") {
        return { runs: [], conversationId: store.activeConversationId ?? "conversation_b", topicId: store.activeTopicId ?? "topic_conversation_b" };
      }
      throw new Error(`unexpected ${type}`);
    });
    // Open Group A, which completes its initial topics.list.
    await store.selectGroup("inst_1", "conversation_a");
    // Reply with a coarse change for A whose refresh parks on the hanging call.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    await flushPromises();
    expect(topicsListCalls).toBe(2);
    // Open Group B fully.
    await store.selectGroup("inst_1", "conversation_b");
    expect(store.selectedGroupId).toBe("conversation_b");
    const bTopicId = store.activeTopicId;
    expect(bTopicId).toBe("topic_conversation_b");
    // Now A's stale response lands.
    releaseA();
    await flushPromises();
    expect(store.selectedGroupId).toBe("conversation_b");
    expect(store.activeConversationId).toBe("conversation_b");
    expect(store.activeTopicId).toBe(bTopicId);
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
  });

  it("never widens the default target to everyone when the bot catalog is unconfirmed", async () => {
    const store = useGroupsStore();
    const leadGroup: GroupSummaryDto = { ...GROUP, leadBotId: "bot_a" };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [leadGroup] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") throw new Error("bots.list unavailable");
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    // A read-only eligibility RPC must not widen execution from lead -> everyone.
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
  });

  it("drops an externally torn-down Topic from the list and the active selection", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.groupsByInstance["inst_1"] = [GROUP];
    store.topicReady = true;
    store.topicsByConversation["inst_1:conversation_g"] = [
      { id: "topic_1", conversationId: "conversation_g", title: "Gone", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    store.activeTopicId = "topic_1";
    store.activeConversationId = "conversation_g";
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") return { topics: [] };
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    // Another client tore the active Topic down: only the coarse broadcast lands.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    await flushPromises();
    expect(store.currentTopics).toEqual([]);
    expect(store.activeTopicId).toBeNull();
  });
});
