import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type {
  BotSummaryDto,
  ConversationHistoryResponseDto,
  ConversationPromptResponseDto,
  ConversationRunDto,
  GroupSummaryDto,
} from "@ganglion/xacpx-relay-protocol";

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

  it("falls back to deterministic first-by-ID member when no lead is set", async () => {
    const store = useGroupsStore();
    const noLead: GroupSummaryDto = { ...GROUP, leadBotId: undefined, botIds: ["bot_b", "bot_a"] };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [noLead] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
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
    store.currentDraftRequestId = "req_draft_everyone";
    store.lastPromptText = "all hands";
    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_draft_everyone",
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
    expect(store.targetSelection).toEqual({ mode: "everyone" });
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
});
