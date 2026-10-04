import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type {
  BotSummaryDto,
  ConversationHistoryResponseDto,
  ConversationPromptResponseDto,
  ConversationRunDetailDto,
  ConversationRunDto,
  GroupSummaryDto,
  MemberTurnSummaryDto,
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
import { useDirectBotsStore } from "../stores/direct-bots";

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

  it("discards a prompt still in flight when the Topic switches underneath it", async () => {
    const store = useGroupsStore();
    const aGate = Promise.withResolvers<void>();
    mockRpc.mockImplementation(async (inst: string, type: string, payload?: unknown) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        const conversationId = (payload as { conversationId: string }).conversationId;
        return { topics: [
          { id: "topic_1", conversationId, title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" },
          { id: "topic_2", conversationId, title: "Post", status: "active", createdAt: "now", updatedAt: "now" },
        ] };
      }
      if (type === "control.bots.list") {
        return { bots: [
          { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        ] };
      }
      if (type === "control.conversation.history") {
        return historyWith([
          { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "hi", createdAt: "now" },
        ]);
      }
      if (type === "control.runs.list") return { runs: [] };
      if (type === "control.conversation.prompt") {
        await aGate.promise;
        return {
          reused: false, conversationId: "conversation_g", topicId: "topic_1",
          requestId: "req_1",
          message: { id: "msg_2", conversationId: "conversation_g", topicId: "topic_1", seq: 2, role: "human", content: "deploy", createdAt: "now" },
          run: { id: "run_1", conversationId: "conversation_g", topicId: "topic_1", requestMessageId: "msg_2", requestId: "req_1", mode: "explicit", state: "queued", profileRevision: 1, createdAt: "now" },
          memberTurns: [],
        };
      }
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    expect(store.activeTopicId).toBe("topic_1");

    // The prompt RPC is issued but never settles.
    const send = store.sendPrompt("deploy");
    await flushPromises();
    expect(store.promptInFlight).toBe(true);

    // The user switches to another Topic while it is still in flight.
    await store.switchTopic("topic_2");
    expect(store.activeTopicId).toBe("topic_2");
    // The old prompt must not pin the new Topic's composer.
    expect(store.promptInFlight).toBe(false);

    // The Topic A response lands now: it may well have been durably accepted,
    // but it must project nothing and leave the new Topic usable.
    aGate.resolve();
    expect(await send).toBe("orphaned");
    await flushPromises();
    expect(store.activeRun).toBeNull();
    expect(store.promptInFlight).toBe(false);
    expect(store.isRunActive).toBe(false);
    expect(store.topicReady).toBe(true);
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

  it("records a failed groups listing as an error, never as an authoritative empty list", async () => {
    const store = useGroupsStore();
    mockRpc.mockRejectedValueOnce(new Error("connector offline"));
    await expect(store.loadGroups("inst_1")).rejects.toThrow("connector offline");
    // The failure is recorded: it must NOT load as loaded-with-nothing.
    expect(store.groupsLoaded["inst_1"]).not.toBe(true);
    expect(store.groupsByInstance["inst_1"] ?? []).toEqual([]);
    expect(store.groupsListErrorByInstance["inst_1"]).toBe("connector offline");
    // Retry clears the failure and lands the rows.
    mockRpc.mockResolvedValueOnce({ groups: [GROUP] });
    await expect(store.loadGroups("inst_1")).resolves.toEqual([GROUP]);
    expect(store.groupsListErrorByInstance["inst_1"]).toBeUndefined();
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

  it("keeps terminal member evidence when a stale running row arrives late", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    const run: ConversationRunDto = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now",
    };
    store.activeRun = run;
    // The terminal row arrives first (live event): failed WITH its evidence.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-finished",
        run: { ...run, state: "failed" },
        memberTurn: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "failed",
          promptRequestId: "sturn_a", failureReason: "timeout", createdAt: "now",
        },
      },
    } as never);
    expect(store.memberTurnsById["turn_a"]?.state).toBe("failed");
    expect(store.memberTurnsById["turn_a"]?.failureReason).toBe("timeout");
    expect(store.memberTurnsById["turn_a"]?.promptRequestId).toBe("sturn_a");
    // A delayed runs.get / recovery snapshot then delivers the OLDER running
    // row for the same turn. The event run it carries is `failed` (matching
    // the stored run) so the started-event path reaches the merge; only the
    // MEMBER row regresses, which is exactly the reported defect — the merge
    // must not let the older member row erase the newer terminal evidence.
    // (Verified red-first: with the old `{...incoming}` base this loses
    // failureReason/promptRequestId; the started-event path does merge here
    // because the stored activeRun id matches the event run id.)
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-started",
        run: { ...run, state: "running" },
        memberTurn: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "running",
          createdAt: "now", startedAt: "then",
        },
      },
    } as never);
    const kept = store.memberTurnsById["turn_a"];
    expect(kept?.state).toBe("failed");
    expect(kept?.failureReason).toBe("timeout");
    expect(kept?.promptRequestId).toBe("sturn_a");
  });

  it("refines indeterminate member evidence when post-seal proof arrives via events", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    const base: ConversationRunDto = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now",
    };
    store.activeRun = { ...base, state: "indeterminate", completionReason: "started_result_unknown", failedBotIds: [] };
    store.memberTurnsById = {
      turn_a: {
        id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit",
        state: "indeterminate", createdAt: "now", startedAt: "then",
      },
      turn_b: {
        id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit",
        state: "indeterminate", createdAt: "now", startedAt: "then",
      },
    };
    // B's proven completion arrives after the seal: member + message evidence
    // must refine while the Run stays indeterminate (A still unknown).
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-finished",
        run: { ...base, state: "indeterminate", completionReason: "started_result_unknown" },
        memberTurn: {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "completed",
          createdAt: "now", startedAt: "then", finishedAt: "later",
        },
      },
    } as never);
    expect(store.memberTurnsById["turn_b"]?.state).toBe("completed");
    expect(store.activeRun?.state).toBe("indeterminate");
    // Reset B to the sealed baseline to exercise the failure path
    // independently (a completed member never transitions to failed).
    store.memberTurnsById = {
      ...store.memberTurnsById,
      turn_b: {
        id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit",
        state: "indeterminate", createdAt: "now", startedAt: "then",
      },
    };
    // B's proven failure refines the same way, carrying failure evidence.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-finished",
        run: { ...base, state: "indeterminate", completionReason: "started_result_unknown", failedBotIds: ["bot_b"] },
        memberTurn: {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "failed",
          failureReason: "proven B boom", createdAt: "now", startedAt: "then", finishedAt: "later",
        },
      },
    } as never);
    expect(store.memberTurnsById["turn_b"]?.state).toBe("failed");
    expect(store.memberTurnsById["turn_b"]?.failureReason).toBe("proven B boom");
    expect(store.activeRun?.failedBotIds).toContain("bot_b");
    // The seal never reopens scheduling: a stale running row still loses.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-started",
        run: { ...base, state: "running" },
        memberTurn: {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "running",
          createdAt: "now", startedAt: "then",
        },
      },
    } as never);
    expect(store.memberTurnsById["turn_b"]?.state).toBe("failed");
    // Full reclassification when the last unknown member gets proof.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "member-turn-finished",
        run: { ...base, state: "failed", completionReason: "execution-failed", failedBotIds: ["bot_a", "bot_b"] },
        memberTurn: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "failed",
          failureReason: "proven A boom", createdAt: "now", startedAt: "then", finishedAt: "later",
        },
      },
    } as never);
    expect(store.memberTurnsById["turn_a"]?.state).toBe("failed");
    expect(store.activeRun?.state).toBe("failed");
  });

  it("refines a cached indeterminate run from a runs.get snapshot", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    store.activeRun = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "indeterminate",
      completionReason: "started_result_unknown", profileRevision: 1, createdAt: "now",
    };
    store.memberTurnsById = {
      turn_b: {
        id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit",
        state: "indeterminate", createdAt: "now", startedAt: "then",
      },
    };
    const refined: ConversationRunDetailDto = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "indeterminate",
      completionReason: "started_result_unknown", profileRevision: 1, createdAt: "now",
      failedBotIds: ["bot_b"],
      memberTurns: [{
        id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "failed",
        failureReason: "proven B boom", createdAt: "now", startedAt: "then", finishedAt: "later",
      }],
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") {
        return { runs: [{ ...refined, memberTurns: undefined }], conversationId: "conversation_g", topicId: "topic_1" };
      }
      if (type === "control.runs.get") return { run: refined };
      throw new Error(`unexpected ${type}`);
    });
    await store.reconcileOnReconnect();
    await flushPromises();
    expect(store.memberTurnsById["turn_b"]?.state).toBe("failed");
    expect(store.memberTurnsById["turn_b"]?.failureReason).toBe("proven B boom");
    expect(store.activeRun?.failedBotIds).toContain("bot_b");
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

  it("replays the frozen tuple even while the Run is active", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.uncertainPrompt = {
      requestId: "req_active",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    };
    // Reconnect proved the Run is running, so isRunActive is true. The frozen
    // replay must still reach the wire: the backend's idempotent accept returns
    // the existing Run for this requestId, so no second Run can be created.
    store.activeRun = {
      id: "run_active", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_active", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    store.memberTurnsById = {
      turn_live: {
        id: "turn_live", runId: "run_active", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
        state: "running", createdAt: "now",
      },
    };
    mockRpc.mockResolvedValue({
      reused: true,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_active",
      message: {
        id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
        role: "human", content: "review", createdAt: "now",
      },
      run: {
        id: "run_active", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_active", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now", startedAt: "now",
      },
      memberTurn: {
        id: "turn_live", runId: "run_active", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
        state: "running", createdAt: "now",
      },
    });
    await store.retryUncertainPrompt();
    const promptCalls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.[2]).toMatchObject({
      requestId: "req_active",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    });
    expect(store.promptError).toBeNull();
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

  it("clears the uncertain tuple on execution_target_missing", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    // A legacy/pre-Group Topic can legitimately carry no execution target; the
    // backend rejects before acceptRequest, so nothing durable exists.
    mockRpc.mockResolvedValueOnce({ error: { code: "execution_target_missing", message: "no target" } });
    await store.sendPrompt("review");
    expect(store.hasUncertainPrompt).toBe(false);
    // The user is not locked out: a corrected request can be sent fresh.
    store.targetSelection = { mode: "members", botIds: ["bot_b"] };
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_after",
      message: { id: "msg_3", conversationId: "conversation_g", topicId: "topic_1", seq: 3, role: "human", content: "review", createdAt: "now" },
      run: { id: "run_3", conversationId: "conversation_g", topicId: "topic_1", requestMessageId: "msg_3", requestId: "req_after", mode: "explicit", state: "queued", profileRevision: 1, createdAt: "now" },
      memberTurn: { id: "turn_3", runId: "run_3", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now" },
    });
    await store.sendPrompt("review");
    const calls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toMatchObject({ target: { mode: "members", botIds: ["bot_b"] } });
  });

  it("releases the uncertain prompt when the Topic queue is full", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.targetSelection = { mode: "members", botIds: ["bot_a"] };
    // assertAcceptable() rejects BEFORE the accept transaction writes anything.
    mockRpc.mockResolvedValueOnce({ error: { code: "topic_queue_full", message: "queue full" } });
    await store.sendPrompt("review");
    expect(store.hasUncertainPrompt).toBe(false);
    // The refusal is reported as its own condition, and the user is not locked out.
    expect(store.promptError).toBe("topicQueueFull");
    store.targetSelection = { mode: "members", botIds: ["bot_b"] };
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_after_queue",
      message: { id: "msg_q", conversationId: "conversation_g", topicId: "topic_1", seq: 4, role: "human", content: "review", createdAt: "now" },
      run: { id: "run_q", conversationId: "conversation_g", topicId: "topic_1", requestMessageId: "msg_q", requestId: "req_after_queue", mode: "explicit", state: "queued", profileRevision: 1, createdAt: "now" },
      memberTurn: { id: "turn_q", runId: "run_q", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "queued", createdAt: "now" },
    });
    await store.sendPrompt("review");
    const calls = mockRpc.mock.calls.filter((c) => c[1] === "control.conversation.prompt");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toMatchObject({ target: { mode: "members", botIds: ["bot_b"] } });
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

  it("clears the uncertain prompt when reconnect proves the Run is ours", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    store.uncertainPrompt = {
      requestId: "req_lost",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    };
    const runningRun: ConversationRunDto = {
      id: "run_lost", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_lost", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.runs.get") return { run: runningRun };
      if (type === "control.runs.list") return { runs: [runningRun], conversationId: "conversation_g", topicId: "topic_1", activeRunId: runningRun.id, activeRun: runningRun };
      if (type === "control.conversation.history") return historyWith([]);
      throw new Error(`unexpected ${type}`);
    });
    // Reconnect sees a live turn for our lost request, then confirms it durably.
    store.applyEvent({
      kind: "state-snapshot",
      instanceId: "inst_1",
      turns: [{
        instanceId: "inst_1", sessionAlias: "s_a", status: "working", startedAt: 1,
        parts: [{ type: "text", text: "working" }],
        conversation: { conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a", runId: "run_lost", memberTurnId: "turn_lost" },
      }],
    } as never);
    await flushPromises();
    // The durable Run carries our requestId, so the pending prompt is resolved
    // without the user having to retry anything.
    expect(store.uncertainPrompt).toBeNull();
    expect(store.hasUncertainPrompt).toBe(false);
    expect(store.activeRun?.id).toBe("run_lost");
    expect(store.activeRun?.state).toBe("running");
  });

  it("clears the uncertain prompt on reconnect with no live turn (queued Run)", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    store.uncertainPrompt = {
      requestId: "req_queued",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    };
    const queuedRun: ConversationRunDto = {
      id: "run_queued", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_queued", mode: "explicit", state: "queued",
      profileRevision: 1, createdAt: "now",
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      // No live turn on the hub (the Run is still queued), so reconnect goes
      // through loadHistory -> recoverActiveRun, not the state-snapshot path.
      if (type === "control.runs.list") return { runs: [queuedRun], conversationId: "conversation_g", topicId: "topic_1", activeRunId: queuedRun.id };
      if (type === "control.runs.get") return { run: { ...queuedRun, memberTurns: [] } };
      throw new Error(`unexpected ${type}`);
    });
    await store.reconcileOnReconnect();
    await flushPromises();
    // Durable discovery through recoverActiveRun resolved the pending prompt:
    // the Run carries our requestId, so nothing is outcome-unknown any more.
    expect(store.hasUncertainPrompt).toBe(false);
    expect(store.activeRun?.id).toBe("run_queued");
  });

  it("clears the uncertain prompt when the Run completed while offline (no active owner)", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    store.uncertainPrompt = {
      requestId: "req_done",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    };
    const completedRun: ConversationRunDto = {
      id: "run_done", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_done", mode: "explicit", state: "completed",
      profileRevision: 1, createdAt: "now", finishedAt: "now",
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") {
        // The durable answer is already visible in history.
        return historyWith([
          { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "review", createdAt: "now" },
          { id: "msg_2", conversationId: "conversation_g", topicId: "topic_1", seq: 2, role: "bot", content: "reviewed", senderBotId: "bot_a", runId: "run_done", createdAt: "now" },
        ]);
      }
      // Terminal Run in runs[], and no active owner at all.
      if (type === "control.runs.list") return { runs: [completedRun], conversationId: "conversation_g", topicId: "topic_1" };
      if (type === "control.runs.get") return { run: { ...completedRun, memberTurns: [] } };
      throw new Error(`unexpected ${type}`);
    });
    await store.reconcileOnReconnect();
    await flushPromises();
    // The user can see the answer, so the composer must be usable again.
    expect(store.messages.some((m) => m.id === "msg_2")).toBe(true);
    expect(store.hasUncertainPrompt).toBe(false);
    expect(store.promptError).toBeNull();
  });

  it("clears its own uncertainty while a foreign Run owns the Topic", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    store.uncertainPrompt = {
      requestId: "req_mine_done",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    };
    const mineDone: ConversationRunDto = {
      id: "run_mine_done", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_mine_done", mode: "explicit", state: "completed",
      profileRevision: 1, createdAt: "now", finishedAt: "now",
    };
    const foreignRunning: ConversationRunDto = {
      id: "run_foreign", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_5", requestId: "req_foreign", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") {
        return { runs: [mineDone, foreignRunning], conversationId: "conversation_g", topicId: "topic_1", activeRunId: foreignRunning.id, activeRun: foreignRunning };
      }
      if (type === "control.runs.get") {
        return { run: { ...foreignRunning, memberTurns: [] } };
      }
      throw new Error(`unexpected ${type}`);
    });
    await store.reconcileOnReconnect();
    await flushPromises();
    // Our uncertainty is resolved by the durable list...
    expect(store.hasUncertainPrompt).toBe(false);
    // ...while the foreign Run still owns the Topic: the owner must not be
    // clobbered by our own reconciliation.
    expect(store.activeRun?.id).toBe("run_foreign");
    expect(store.activeRun?.state).toBe("running");
  });

  it("keeps the uncertain prompt when the discovered Run belongs to another request", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    store.uncertainPrompt = {
      requestId: "req_mine",
      text: "review",
      target: { mode: "members", botIds: ["bot_a"] },
    };
    const foreignRun: ConversationRunDto = {
      id: "run_other", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_9", requestId: "req_someone_else", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.runs.get") return { run: foreignRun };
      if (type === "control.runs.list") return { runs: [foreignRun], conversationId: "conversation_g", topicId: "topic_1", activeRunId: foreignRun.id };
      if (type === "control.conversation.history") return historyWith([]);
      throw new Error(`unexpected ${type}`);
    });
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversation-run-changed", run: foreignRun },
    } as never);
    await flushPromises();
    expect(store.uncertainPrompt?.requestId).toBe("req_mine");
  });

  it("releases a stale running owner when runs.list proves there is none and runs.get fails", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    const staleRunning: ConversationRunDto = {
      id: "run_stale", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_stale", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "2026-09-20T00:00:00.000Z", startedAt: "2026-09-20T00:00:00.000Z",
    };
    const settled: ConversationRunDto = {
      id: "run_stale", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_stale", mode: "explicit", state: "completed",
      profileRevision: 1, createdAt: "2026-09-20T00:00:00.000Z", startedAt: "2026-09-20T00:00:00.000Z", finishedAt: "2026-09-20T01:00:00.000Z",
    };
    // Local cache still thinks the Run is running.
    store.activeRun = staleRunning;
    store.memberTurnsById = {
      turn_stale: {
        id: "turn_stale", runId: "run_stale", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
        state: "running", createdAt: "2026-09-20T00:00:00.000Z",
      },
    };
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      // Durable truth: the Run is completed and there is NO active owner.
      if (type === "control.runs.list") return { runs: [settled], conversationId: "conversation_g", topicId: "topic_1" };
      // The detail enrichment deliberately fails.
      if (type === "control.runs.get") throw new Error("runs.get unavailable");
      throw new Error(`unexpected ${type}`);
    });
    expect(store.isRunActive).toBe(true);
    await store.reconcileOnReconnect();
    await flushPromises();
    // The list is the owner authority: a failing detail RPC must not leave the
    // composer disabled against a Run that finished long ago.
    expect(store.isRunActive).toBe(false);
    expect(store.topicReady).toBe(true);
    expect(store.activeRun?.state).toBe("completed");
  });

  it("releases a stale running owner through retryDiscovery too", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    const staleRunning: ConversationRunDto = {
      id: "run_stale2", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_stale2", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    store.activeRun = staleRunning;
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.retryDiscovery();
    await flushPromises();
    // No owner in the list and the Run is not in it either: drop ownership.
    expect(store.isRunActive).toBe(false);
    expect(store.activeRun).toBeNull();
    expect(store.ownershipUncertain).toBe(false);
  });

  it("unlocks the composer on a terminal list summary even when runs.get fails", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    const staleRunning: ConversationRunDto = {
      id: "run_term", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_term", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    store.activeRun = staleRunning;
    // Real wire shape: `listTopicRuns` only names `activeRunId` for
    // running/waiting-human (else queued). A terminal Run is therefore never the
    // owner, so the list reports no candidate and the no-owner path must run.
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.runs.list") {
        return {
          runs: [{ ...staleRunning, state: "completed" }],
          conversationId: "conversation_g",
          topicId: "topic_1",
        };
      }
      if (type === "control.runs.get") throw new Error("detail unavailable");
      throw new Error(`unexpected ${type}`);
    });
    await store.retryDiscovery();
    await flushPromises();
    expect(store.isRunActive).toBe(false);
    expect(store.topicReady).toBe(true);
    expect(store.activeRun?.state).toBe("completed");
  });

  it("recovers terminal member rows from the no-owner path when runs.get succeeds", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    const staleRunning: ConversationRunDto = {
      id: "run_term2", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_term2", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    store.activeRun = staleRunning;
    const detailTurns: MemberTurnSummaryDto[] = [
      { id: "turn_a", runId: "run_term2", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "completed", createdAt: "now" },
      { id: "turn_b", runId: "run_term2", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_b", batch: 1, attempt: 1, origin: "human-explicit", state: "failed", createdAt: "now" },
    ];
    const detailRun: ConversationRunDetailDto = { ...staleRunning, state: "completed", memberTurns: detailTurns };
    let getCalls = 0;
    mockRpc.mockImplementation(async (inst: string, type: string, payload?: unknown) => {
      if (type === "control.runs.list") {
        return {
          runs: [{ ...detailRun }],
          conversationId: "conversation_g",
          topicId: "topic_1",
        };
      }
      // The list summary is authoritative for the terminal state; the detail
      // carries the per-member rows it cannot.
      if (type === "control.runs.get") {
        getCalls += 1;
        expect((payload as { runId: string }).runId).toBe("run_term2");
        return { run: detailRun };
      }
      throw new Error(`unexpected ${type}`);
    });
    await store.retryDiscovery();
    await flushPromises();
    // Terminal ownership decided by the list; member rows restored by the detail.
    expect(store.activeRun?.state).toBe("completed");
    expect(store.isRunActive).toBe(false);
    expect(store.topicReady).toBe(true);
    expect(store.memberTurns.map((m) => m.state)).toEqual(["completed", "failed"]);
    expect(getCalls).toBe(1);
  });

  it("does not let a pending runs.get hold the composer after loadHistory settles", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.groupsByInstance["inst_1"] = [GROUP];
    const staleRunning: ConversationRunDto = {
      id: "run_term3", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_term3", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now", startedAt: "now",
    };
    // Local cache still thinks the Run is running.
    store.activeRun = staleRunning;
    // The detail hangs: a slow or stuck transport must not gate the composer.
    const detailGate = Promise.withResolvers<{ run: ConversationRunDto }>();
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.conversation.history") return historyWith([]);
      // Durable truth: the Run is completed and there is NO active owner.
      if (type === "control.runs.list") {
        return {
          runs: [{ ...staleRunning, state: "completed" }],
          conversationId: "conversation_g",
          topicId: "topic_1",
        };
      }
      if (type === "control.runs.get") return await detailGate.promise;
      throw new Error(`unexpected ${type}`);
    });
    const history = store.loadHistory("inst_1", "conversation_g", "topic_1");
    await flushPromises();
    // The key assertion: the composer is usable while the detail is STILL
    // pending. Ownership came from the list; the detail is display-only.
    expect(store.activeRun?.state).toBe("completed");
    expect(store.isRunActive).toBe(false);
    expect(store.topicReady).toBe(true);
    // Resolving the parked detail still enriches the card afterwards.
    const detailRun: ConversationRunDetailDto = { ...staleRunning, state: "completed", memberTurns: [
      { id: "turn_a3", runId: "run_term3", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a", batch: 1, attempt: 1, origin: "human-explicit", state: "completed", createdAt: "now" },
    ] };
    detailGate.resolve({ run: detailRun });
    await history;
    await flushPromises();
    expect(store.memberTurns.map((m) => m.id)).toEqual(["turn_a3"]);
    expect(store.topicReady).toBe(true);
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

  it("does not resurrect a torn-down Topic when a sibling Topic event lands mid-refresh", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    const deleted = { id: "topic_deleted", conversationId: "conversation_g", title: "Doomed", status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const surviving = { id: "topic_alive", conversationId: "conversation_g", title: "Alive", status: "active" as const, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
    store.topicsByConversation["inst_1:conversation_g"] = [deleted, surviving];
    store.activeTopicId = "topic_deleted";

    let releaseList!: () => void;
    const listHang = new Promise<void>((resolve) => { releaseList = resolve; });
    let listCalls = 0;
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        listCalls += 1;
        if (listCalls === 1) {
          // The coarse teardown refresh parks here.
          await listHang;
        }
        // Authoritative server state: the doomed Topic is gone.
        return { topics: [surviving] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_alive" };
      throw new Error(`unexpected ${type}`);
    });
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    await flushPromises();
    expect(listCalls).toBe(1);
    // A sibling Topic update lands while the refetch is in flight.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversation-topic-changed", topic: surviving },
    } as never);
    await flushPromises();
    // The list now resolves with the authoritative, tombstone-free snapshot.
    releaseList();
    await flushPromises();
    // The refresh must have re-fetched until it got an event-free window.
    expect(listCalls).toBeGreaterThan(1);
    const ids = store.currentTopics.map((t2) => t2.id);
    expect(ids).not.toContain("topic_deleted");
    expect(ids).toContain("topic_alive");
    // The active selection converges onto a Topic that still exists.
    expect(store.activeTopicId).toBe("topic_alive");
  });

  it("aborts teardown reconciliation when a Topic event lands on every attempt", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    const deleted = { id: "topic_deleted", conversationId: "conversation_g", title: "Doomed", status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const surviving = { id: "topic_alive", conversationId: "conversation_g", title: "Alive", status: "active" as const, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
    store.topicsByConversation["inst_1:conversation_g"] = [deleted, surviving];
    store.activeTopicId = "topic_deleted";
    let listCalls = 0;
    const topicEvent = () => ({
      kind: "control-event" as const,
      instanceId: "inst_1",
      event: { type: "conversation-topic-changed" as const, topic: surviving },
    });
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        listCalls += 1;
        // The event lands inside the request window: the reconciler sampled the
        // revision BEFORE awaiting, so this dirties its own comparison.
        if (listCalls <= 4) store.applyEvent(topicEvent());
        return { topics: [surviving] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_alive" };
      throw new Error(`unexpected ${type}`);
    });
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    // Let the bounded loop run to exhaustion.
    for (let i = 0; i < 8; i++) {
      await flushPromises();
    }
    // Bounded retry, then abort. Abort means "not reconciled": the stale cache is
    // kept unchanged (deleted still listed, still active) instead of committing
    // an unproven list — and critically, the retry never silently reports
    // success with a list it could not verify.
    expect(listCalls).toBeGreaterThan(1);
    expect(listCalls).toBeLessThanOrEqual(4);
    expect(store.currentTopics.map((t2) => t2.id)).toEqual(["topic_deleted", "topic_alive"]);
    expect(store.activeTopicId).toBe("topic_deleted");
  });

  it("stops a stale ordinary topics.list from resurrecting a torn-down Topic", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    const deleted = { id: "topic_deleted", conversationId: "conversation_g", title: "Doomed", status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const alive = { id: "topic_alive", conversationId: "conversation_g", title: "Alive", status: "active" as const, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
    store.topicsByConversation["inst_1:conversation_g"] = [deleted, alive];
    store.activeTopicId = "topic_alive";

    let releaseOrdinary!: () => void;
    const ordinaryHang = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    let ordinaryRequests = 0;
    mockRpc.mockImplementation(async (inst: string, type: string, payload?: unknown) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        ordinaryRequests += 1;
        if (ordinaryRequests === 1) {
          // An ordinary loadTopics (reconcile path) parks, still holding a
          // snapshot that contains the doomed Topic.
          await ordinaryHang;
          return { topics: [deleted, alive] };
        }
        // The coarse refresh sees the authoritative post-teardown state.
        return { topics: [alive] };
      }
      if (type === "control.conversation.history") {
        const conversationId = (payload as { conversationId: string }).conversationId;
        return historyWith([]);
      }
      if (type === "control.runs.list") {
        return { runs: [], conversationId: store.activeConversationId ?? "conversation_g", topicId: store.activeTopicId ?? "topic_alive" };
      }
      throw new Error(`unexpected ${type}`);
    });
    // Start the ordinary list (it parks).
    const ordinary = store.loadTopics("inst_1", "conversation_g");
    await flushPromises();
    // Another client tears the doomed Topic down: the coarse refresh reconciles
    // and removes it.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    await flushPromises();
    expect(store.currentTopics.map((t2) => t2.id)).toEqual(["topic_alive"]);
    // Now the stale ordinary response arrives. It predates the deletion, so it
    // must be discarded, never merged.
    releaseOrdinary();
    await ordinary;
    await flushPromises();
    expect(store.currentTopics.map((t2) => t2.id)).toEqual(["topic_alive"]);
    // The reconcile path's own view also converges (it discards, not merges).
    expect(store.activeTopicId).toBe("topic_alive");
  });

  it("stops a stale ordinary list from resurrecting a Topic a newer ordinary list deleted", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    const deleted = { id: "topic_deleted", conversationId: "conversation_g", title: "Doomed", status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const alive = { id: "topic_alive", conversationId: "conversation_g", title: "Alive", status: "active" as const, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
    store.topicsByConversation["inst_1:conversation_g"] = [deleted, alive];
    store.activeTopicId = "topic_alive";
    let releaseA!: () => void;
    const aHang = new Promise<void>((resolve) => { releaseA = resolve; });
    let listRequests = 0;
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.topics.list") {
        listRequests += 1;
        if (listRequests === 1) {
          // Older request: parks, holding a snapshot that still has the doomed
          // Topic.
          await aHang;
          return { topics: [deleted, alive] };
        }
        // Newer request: the server has already dropped the Topic.
        return { topics: [alive] };
      }
      throw new Error(`unexpected ${type}`);
    });
    // Two ordinary loadTopics calls, started in order.
    const first = store.loadTopics("inst_1", "conversation_g");
    await flushPromises();
    const second = store.loadTopics("inst_1", "conversation_g");
    await second;
    // The newer request observed the deletion and removed it from the cache.
    expect(store.currentTopics.map((t2) => t2.id)).toEqual(["topic_alive"]);
    // Release the stale older response: it predates the deletion, so the
    // deletion epoch captured by A must make it discard rather than merge.
    releaseA();
    await first;
    await flushPromises();
    expect(store.currentTopics.map((t2) => t2.id)).toEqual(["topic_alive"]);
  });

  it("keeps the newest coarse refresh when two arrive out of order", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.topicReady = true;
    store.groupsByInstance["inst_1"] = [GROUP];
    const t1 = { id: "topic_1", conversationId: "conversation_g", title: "One", status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const t2 = { id: "topic_2", conversationId: "conversation_g", title: "Two", status: "active" as const, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
    store.topicsByConversation["inst_1:conversation_g"] = [t1, t2];
    store.activeTopicId = "topic_2";
    // Two coarse refreshes: the first response parks (stale, still reports both
    // Topics), the second resolves immediately (both Topics gone).
    let releaseFirst!: () => void;
    const firstHang = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let listRequests = 0;
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        listRequests += 1;
        if (listRequests === 1) {
          await firstHang;
          // Stale window: this response predates the deletion the newer refresh
          // committed, so committing it would re-add both Topics.
          return { topics: [t1, t2] };
        }
        return { topics: [t2] };
      }
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    // First coarse refresh: parks inside topics.list.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    await flushPromises();
    expect(listRequests).toBe(1);
    // Second coarse refresh: resolves immediately and commits.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversations-changed" },
    } as never);
    await flushPromises();
    expect(listRequests).toBe(2);
    // The newer refresh removed one Topic but left an active one, so the
    // selection stays valid and the generation is NOT bumped — nothing but
    // request ordering can stop the older response from committing.
    expect(store.currentTopics.map((t3) => t3.id)).toEqual(["topic_2"]);
    // Now the first (older) refresh resolves with its stale snapshot.
    releaseFirst();
    await flushPromises();
    expect(store.currentTopics.map((t3) => t3.id)).toEqual(["topic_2"]);
    // Exactly two list requests: the aborted stale attempt issued no third
    // request, so the cache survives on ordering, not on a retry.
    expect(listRequests).toBe(2);
  });

  it("does not derive eligibility from a stale cache after a failed refresh", async () => {
    const store = useGroupsStore();
    const direct = useDirectBotsStore();
    // A previous catalog refresh succeeded and cached every member as disabled.
    direct.botsLoaded["inst_1"] = true;
    direct.botsByInstance["inst_1"] = [
      { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
      { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
    ];
    // Now bots.list fails AND the newest refresh marks the catalog unconfirmed,
    // while the stale rows remain cached. A non-empty cache is not evidence of
    // freshness.
    mockRpc.mockImplementation(async (inst: string, type: string) => {
      if (type === "control.groups.list") return { groups: [GROUP] };
      if (type === "control.topics.list") {
        return { topics: [{ id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" }] };
      }
      if (type === "control.bots.list") throw new Error("bots.list unavailable");
      if (type === "control.conversation.history") return historyWith([]);
      if (type === "control.runs.list") return { runs: [], conversationId: "conversation_g", topicId: "topic_1" };
      throw new Error(`unexpected ${type}`);
    });
    await store.selectGroup("inst_1", "conversation_g");
    // Stale all-disabled cache must NOT be treated as confirmed eligibility:
    // the default stays a single member and never widens to everyone.
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    // The composer's own authority agrees.
    expect(store.botCatalogKnown).toBe(false);
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

  it("PR8: automatic selection resolves to the automatic wire target", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    store.topicReady = true;
    store.setTarget({ mode: "automatic" });
    expect(store.targetSelection).toEqual({ mode: "automatic" });
    expect(store.targetResolvable).toBe(true);

    const promptResponse: ConversationPromptResponseDto = {
      reused: false,
      conversationId: "conversation_g",
      topicId: "topic_1",
      requestId: "req_automatic",
      message: {
        id: "msg_a", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
        role: "human", content: "ship it", createdAt: "now",
      },
      run: {
        id: "run_a", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_a", requestId: "req_automatic", mode: "automatic", state: "running",
        routingState: "dispatching", profileRevision: 1, createdAt: "now",
      },
      // An automatic accept carries ZERO members: the Router decides the
      // first batch, so there is no human-selected memberTurn to project.
      memberTurns: [],
      activeRunId: "run_a",
    };
    mockRpc.mockResolvedValueOnce(promptResponse);
    await store.sendPrompt("ship it");
    expect(mockRpc).toHaveBeenLastCalledWith("inst_1", "control.conversation.prompt", expect.objectContaining({
      target: { mode: "automatic" },
    }));
    // The automatic Run's routing substate is projected verbatim.
    expect(store.activeRun?.routingState).toBe("dispatching");
    expect(store.memberTurns).toEqual([]);
  });

  it("PR8: picking a member replaces an automatic selection", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.groupsByInstance["inst_1"] = [GROUP];
    store.groupDetails["inst_1:conversation_g"] = { ...GROUP, topics: [] };
    store.setTarget({ mode: "automatic" });
    expect(store.targetSelection).toEqual({ mode: "automatic" });
    store.toggleTargetMember("bot_a");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    // An explicit mention also narrows back: the Router may not keep deciding
    // after a human names somebody.
    store.setTarget({ mode: "automatic" });
    store.mentionBot("bot_b");
    expect(store.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
  });

  it("PR8: mergeRun keeps a stored routingState when a thinner snapshot omits it", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    const baseRun: ConversationRunDto = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "automatic", state: "running",
      routingState: "dispatching", profileRevision: 1, createdAt: "now",
    };
    store.activeRun = baseRun;
    const thinner: ConversationRunDto = { ...baseRun, consumedMemberTurns: undefined };
    delete (thinner as Partial<ConversationRunDto>).routingState;
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: { type: "conversation-run-changed", run: thinner },
    } as never);
    expect(store.activeRun?.routingState).toBe("dispatching");
  });

  it("preserves the waiting question for a thin reconnect and clears it on settlement", () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.selectedGroupId = "conversation_g";
    store.activeConversationId = "conversation_g";
    store.activeTopicId = "topic_1";
    const waiting: ConversationRunDto = {
      id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
      requestMessageId: "msg_1", requestId: "req_1", mode: "automatic", state: "waiting-human",
      routingState: "done", waitingQuestion: "Which branch ships?", profileRevision: 1, createdAt: "now",
    };
    const update = (run: ConversationRunDto) => store.applyEvent({ kind: "control-event",
      instanceId: "inst_1", event: { type: "conversation-run-changed", run } } as never);
    store.activeRun = waiting;
    const thin = { ...waiting };
    delete thin.waitingQuestion;
    update(thin);
    expect(store.activeRun?.waitingQuestion).toBe("Which branch ships?");
    update({ ...thin, state: "cancelled" });
    expect(store.activeRun?.waitingQuestion).toBeUndefined();
  });
});
