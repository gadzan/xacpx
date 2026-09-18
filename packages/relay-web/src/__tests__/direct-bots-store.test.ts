import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type {
  BotDetailDto,
  BotSummaryDto,
  ConversationDetailDto,
  ConversationHistoryResponseDto,
  ConversationMessageDto,
  ConversationPromptResponseDto,
  ConversationRunDetailDto,
  ConversationRunDto,
  ConversationSummaryDto,
  LiveTurnSnapshotDto,
  MemberTurnSummaryDto,
  TopicSummaryDto,
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

import { useDirectBotsStore } from "../stores/direct-bots";
import { useChatStore } from "../stores/chat";

describe("useDirectBotsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
    localStorage.clear();
  });

  describe("Bot CRUD RPC", () => {
    it("loads bots for an instance", async () => {
      const store = useDirectBotsStore();
      const mockBots: BotSummaryDto[] = [
        {
          id: "bot_1",
          name: "Reviewer",
          agent: "codex",
          workspace: "repo",
          enabled: true,
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];
      mockRpc.mockResolvedValueOnce({ bots: mockBots });

      const bots = await store.loadBots("inst_1");
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.bots.list", {});
      expect(bots).toEqual(mockBots);
      expect(store.botsByInstance["inst_1"]).toEqual(mockBots);
      expect(store.botsLoaded["inst_1"]).toBe(true);
    });

    it("gets bot detail", async () => {
      const store = useDirectBotsStore();
      const mockBot: BotDetailDto = {
        id: "bot_1",
        name: "Reviewer",
        agent: "codex",
        workspace: "repo",
        instructions: "Be thorough",
        profileRevision: 1,
        enabled: true,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      mockRpc.mockResolvedValueOnce({ bot: mockBot });

      const res = await store.loadBotDetail("inst_1", "bot_1");
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.bots.get", { id: "bot_1" });
      expect(res).toEqual(mockBot);
      expect(store.botDetails["inst_1:bot_1"]).toEqual(mockBot);
    });

    it("creates a bot and reloads bot list", async () => {
      const store = useDirectBotsStore();
      const createdBot: BotDetailDto = {
        id: "bot_new",
        name: "Architect",
        agent: "claude",
        workspace: "docs",
        enabled: true,
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      // create call
      mockRpc.mockResolvedValueOnce({ bot: createdBot });
      // reload bots call
      mockRpc.mockResolvedValueOnce({ bots: [createdBot] });

      const res = await store.createBot("inst_1", {
        name: "Architect",
        agent: "claude",
        workspace: "docs",
        enabled: true,
      });

      expect(mockRpc).toHaveBeenNthCalledWith(1, "inst_1", "control.bots.create", {
        name: "Architect",
        agent: "claude",
        workspace: "docs",
        enabled: true,
      });
      expect(res).toEqual(createdBot);
      expect(store.botsByInstance["inst_1"]).toEqual([createdBot]);
    });

    it("updates a bot and reloads bot list", async () => {
      const store = useDirectBotsStore();
      const updatedBot: BotDetailDto = {
        id: "bot_1",
        name: "Senior Reviewer",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      mockRpc.mockResolvedValueOnce({ bot: updatedBot });
      mockRpc.mockResolvedValueOnce({ bots: [updatedBot] });

      const res = await store.updateBot("inst_1", "bot_1", {
        name: "Senior Reviewer",
      });

      expect(mockRpc).toHaveBeenNthCalledWith(1, "inst_1", "control.bots.update", {
        id: "bot_1",
        name: "Senior Reviewer",
      });
      expect(res).toEqual(updatedBot);
    });

    it("deletes a bot and removes it from state", async () => {
      const store = useDirectBotsStore();
      store.botsByInstance["inst_1"] = [
        {
          id: "bot_1",
          name: "Reviewer",
          agent: "codex",
          workspace: "repo",
          enabled: true,
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];
      mockRpc.mockResolvedValueOnce({ ok: true });

      await store.deleteBot("inst_1", "bot_1");
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.bots.delete", { id: "bot_1" });
      expect(store.botsByInstance["inst_1"]).toEqual([]);
    });

    it("unwraps instance error and surfaces upgrade hint on unknown-type", async () => {
      const store = useDirectBotsStore();
      mockRpc.mockResolvedValueOnce({
        error: { code: "unknown-type", message: "unsupported rpc type: control.bots.list" },
      });

      await expect(store.loadBots("inst_1")).rejects.toThrow("needs a newer connector");
    });
  });

  describe("Conversations and Topics RPC", () => {
    it("loads conversations for instance / bot", async () => {
      const store = useDirectBotsStore();
      const mockConvs: ConversationSummaryDto[] = [
        {
          id: "conv_1",
          kind: "bot",
          title: "Reviewer",
          botId: "bot_1",
          defaultTopicId: "top_1",
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];
      mockRpc.mockResolvedValueOnce({ conversations: mockConvs });

      const res = await store.loadConversations("inst_1", { botId: "bot_1" });
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.conversations.list", { botId: "bot_1" });
      expect(res).toEqual(mockConvs);
      expect(store.conversationsByInstance["inst_1"]).toEqual(mockConvs);
    });

    it("loads topics for conversation", async () => {
      const store = useDirectBotsStore();
      const mockTopics: TopicSummaryDto[] = [
        {
          id: "top_1",
          conversationId: "conv_1",
          title: "Default",
          status: "active",
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];
      mockRpc.mockResolvedValueOnce({ topics: mockTopics });

      const res = await store.loadTopics("inst_1", "conv_1");
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.topics.list", { conversationId: "conv_1" });
      expect(res).toEqual(mockTopics);
      expect(store.topicsByConversation["inst_1:conv_1"]).toEqual(mockTopics);
    });

    it("creates a topic and adds to topics list", async () => {
      const store = useDirectBotsStore();
      const newTopic: TopicSummaryDto = {
        id: "top_2",
        conversationId: "conv_1",
        title: "Sprint 2",
        status: "active",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      mockRpc.mockResolvedValueOnce({ topic: newTopic });

      const res = await store.createTopic("inst_1", "conv_1", "Sprint 2");
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.topics.create", {
        conversationId: "conv_1",
        title: "Sprint 2",
      });
      expect(res).toEqual(newTopic);
      expect(store.topicsByConversation["inst_1:conv_1"]).toContainEqual(newTopic);
    });
    it("guards against race condition when two selectBot calls resolve in reverse order", async () => {
      const store = useDirectBotsStore();

      let resolveBotA: (v: unknown) => void;
      const botAPromise = new Promise((resolve) => { resolveBotA = resolve; });
      let resolveBotB: (v: unknown) => void;
      const botBPromise = new Promise((resolve) => { resolveBotB = resolve; });

      mockRpc.mockImplementation((instId: string, type: string, payload: unknown) => {
        if (type === "control.conversations.list") {
          const p = payload as { botId?: string };
          if (p?.botId === "bot_A") return botAPromise;
          if (p?.botId === "bot_B") return botBPromise;
        }
        if (type === "control.topics.list") {
          const p = payload as { conversationId: string };
          if (p?.conversationId === "conv_A") return Promise.resolve({ topics: [{ id: "top_A", conversationId: "conv_A", title: "Topic A" }] });
          if (p?.conversationId === "conv_B") return Promise.resolve({ topics: [{ id: "top_B", conversationId: "conv_B", title: "Topic B" }] });
        }
        if (type === "control.conversation.history") {
          return Promise.resolve({ conversationId: "c", topicId: "t", messages: [], hasMoreBefore: false, hasMoreAfter: false });
        }
        return Promise.resolve({});
      });

      // User rapidly selects Bot A, then Bot B
      const callA = store.selectBot("inst_1", "bot_A");
      const callB = store.selectBot("inst_1", "bot_B");

      // Bot B resolves FIRST
      resolveBotB!({
        conversations: [{ id: "conv_B", botId: "bot_B", title: "Bot B", defaultTopicId: "top_B" }],
      });
      await callB;

      expect(store.selectedBotId).toBe("bot_B");
      expect(store.activeConversationId).toBe("conv_B");
      expect(store.activeTopicId).toBe("top_B");

      // Bot A resolves LATER (out-of-order stale response)
      resolveBotA!({
        conversations: [{ id: "conv_A", botId: "bot_A", title: "Bot A", defaultTopicId: "top_A" }],
      });
      await callA;

      // Stale Bot A response MUST NOT overwrite Bot B!
      expect(store.selectedBotId).toBe("bot_B");
      expect(store.activeConversationId).toBe("conv_B");
      expect(store.activeTopicId).toBe("top_B");
    });
  });

  describe("History and Pagination", () => {
    it("loads history sorted by seq and deduplicates messages", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";

      const mockHistory: ConversationHistoryResponseDto = {
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [
          {
            id: "msg_2",
            conversationId: "conv_1",
            topicId: "top_1",
            seq: 2,
            role: "bot",
            content: "Hello back",
            createdAt: "2026-09-18T00:01:00.000Z",
          },
          {
            id: "msg_1",
            conversationId: "conv_1",
            topicId: "top_1",
            seq: 1,
            role: "human",
            content: "Hello",
            createdAt: "2026-09-18T00:00:00.000Z",
          },
        ],
        oldestSeq: 1,
        newestSeq: 2,
        hasMoreBefore: true,
        hasMoreAfter: false,
      };
      mockRpc.mockResolvedValueOnce(mockHistory);

      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(store.oldestSeq).toBe(1);
      expect(store.newestSeq).toBe(2);
      expect(store.hasMoreBefore).toBe(true);
    });

    it("loadOlder prepends older messages without duplicating existing ones", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.oldestSeq = 3;
      store.hasMoreBefore = true;
      store.messages = [
        {
          id: "msg_3",
          conversationId: "conv_1",
          topicId: "top_1",
          seq: 3,
          role: "human",
          content: "Third",
          createdAt: "2026-09-18T00:03:00.000Z",
        },
      ];

      const olderPage: ConversationHistoryResponseDto = {
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [
          {
            id: "msg_1",
            conversationId: "conv_1",
            topicId: "top_1",
            seq: 1,
            role: "human",
            content: "First",
            createdAt: "2026-09-18T00:01:00.000Z",
          },
          {
            id: "msg_2",
            conversationId: "conv_1",
            topicId: "top_1",
            seq: 2,
            role: "bot",
            content: "Second",
            createdAt: "2026-09-18T00:02:00.000Z",
          },
        ],
        oldestSeq: 1,
        newestSeq: 2,
        hasMoreBefore: false,
        hasMoreAfter: true,
      };
      mockRpc.mockResolvedValueOnce(olderPage);

      await store.loadOlder();
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.conversation.history", {
        conversationId: "conv_1",
        topicId: "top_1",
        beforeSeq: 3,
        limit: 50,
      });
      expect(store.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(store.oldestSeq).toBe(1);
      expect(store.hasMoreBefore).toBe(false);
    });
  });

  describe("Prompt sending and Idempotency", () => {
    it("reuses stable requestId on retry after prompt error", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        {
          id: "bot_1",
          name: "Reviewer",
          agent: "codex",
          workspace: "repo",
          enabled: true,
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];

      // First send attempt fails with network error
      mockRpc.mockRejectedValueOnce(new Error("Network timeout"));

      await store.sendPrompt("Help me debug");
      expect(store.promptError).toBe("Network timeout");
      const firstReqId = store.currentDraftRequestId;
      expect(firstReqId).toBeTruthy();

      // Retry with the exact same text
      const promptResponse: ConversationPromptResponseDto = {
        reused: false,
        conversationId: "conv_1",
        topicId: "top_1",
        requestId: firstReqId!,
        message: {
          id: "msg_human_1",
          conversationId: "conv_1",
          topicId: "top_1",
          seq: 1,
          role: "human",
          content: "Help me debug",
          createdAt: "2026-09-18T00:00:00.000Z",
        },
        run: {
          id: "run_1",
          conversationId: "conv_1",
          topicId: "top_1",
          requestMessageId: "msg_human_1",
          requestId: firstReqId!,
          mode: "explicit",
          state: "running",
          profileRevision: 1,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
        memberTurn: {
          id: "turn_1",
          runId: "run_1",
          conversationId: "conv_1",
          topicId: "top_1",
          botId: "bot_1",
          batch: 1,
          attempt: 1,
          origin: "human",
          state: "running",
          createdAt: "2026-09-18T00:00:00.000Z",
        },
      };
      mockRpc.mockResolvedValueOnce(promptResponse);

      await store.sendPrompt("Help me debug");
      expect(mockRpc).toHaveBeenLastCalledWith("inst_1", "control.conversation.prompt", {
        conversationId: "conv_1",
        topicId: "top_1",
        requestId: firstReqId,
        text: "Help me debug",
        target: { botId: "bot_1" },
      });

      expect(store.promptError).toBeNull();
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]?.id).toBe("msg_human_1");
      expect(store.activeRun?.id).toBe("run_1");
      expect(store.activeRun?.state).toBe("running");
      expect(store.liveTurn).toBeTruthy();
    });
    it("refuses to send prompt when bot is disabled", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        {
          id: "bot_1",
          name: "Reviewer",
          agent: "codex",
          workspace: "repo",
          enabled: false,
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];

      await store.sendPrompt("Hello");
      expect(mockRpc).not.toHaveBeenCalled();
      expect(store.promptError).toContain("Bot is disabled");
    });

    it("does not pollute switched Bot/Topic when in-flight sendPrompt resolves late", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_A";
      store.activeConversationId = "conv_A";
      store.activeTopicId = "top_A";
      store.botsByInstance["inst_1"] = [
        { id: "bot_A", name: "Bot A", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        { id: "bot_B", name: "Bot B", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      const { promise: promptPromise, resolve: resolvePrompt } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string, payload: unknown) => {
        if (type === "control.conversation.prompt") return promptPromise;
        if (type === "control.conversations.list") {
          return Promise.resolve({ conversations: [{ id: "conv_B", botId: "bot_B", defaultTopicId: "top_B" }] });
        }
        if (type === "control.topics.list") {
          return Promise.resolve({ topics: [{ id: "top_B", conversationId: "conv_B", title: "Topic B" }] });
        }
        if (type === "control.conversation.history") {
          return Promise.resolve({ conversationId: "c", topicId: "t", messages: [], hasMoreBefore: false, hasMoreAfter: false });
        }
        return Promise.resolve({});
      });

      // 1. Bot A sends prompt (in flight)
      const sendPromise = store.sendPrompt("Prompt for Bot A");

      // 2. User switches to Bot B
      await store.selectBot("inst_1", "bot_B");
      expect(store.selectedBotId).toBe("bot_B");
      expect(store.promptInFlight).toBe(false);

      // User starts typing on Bot B and mints a draft request ID for Bot B
      store.preparePromptRequestId("Prompt for Bot B");
      const botBReqId = store.currentDraftRequestId;
      expect(botBReqId).toBeTruthy();

      // 3. Bot A prompt RPC resolves late
      resolvePrompt({
        reused: false,
        conversationId: "conv_A",
        topicId: "top_A",
        requestId: "req_A",
        message: { id: "msg_A", conversationId: "conv_A", topicId: "top_A", seq: 1, role: "human", content: "Prompt for Bot A", createdAt: "now" },
        run: { id: "run_A", conversationId: "conv_A", topicId: "top_A", requestMessageId: "msg_A", requestId: "req_A", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now" },
        memberTurn: { id: "turn_A", runId: "run_A", conversationId: "conv_A", topicId: "top_A", botId: "bot_A", batch: 1, attempt: 1, origin: "human", state: "running", createdAt: "now" },
      });
      await sendPromise;
      await flushPromises();

      // Bot B must NOT be polluted!
      expect(store.selectedBotId).toBe("bot_B");
      expect(store.activeConversationId).toBe("conv_B");
      expect(store.activeTopicId).toBe("top_B");
      expect(store.messages).toEqual([]); // Bot A message not added to Bot B!
      expect(store.activeRun).toBeNull(); // Bot A run not added to Bot B!
      expect(store.liveTurn).toBeNull();
      expect(store.currentDraftRequestId).toBe(botBReqId); // Bot B's draft request ID preserved!
    });
  });

  describe("Streaming and Turn Events correlation", () => {
    it("accumulates live output, thought, tool-step, and plan strictly matching conversation correlation", () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_1",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };

      // Correlated turn events for run_1
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-started",
          chatKey: "rk",
          sessionAlias: "brt_1",
          startedAt: 1000,
          conversation: {
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            runId: "run_1",
            memberTurnId: "m_1",
          },
        },
      } as never);

      expect(store.liveTurn).toBeTruthy();
      expect(store.liveTurn?.startedAt).toBe(1000);

      // Reasoning
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-thought",
          chatKey: "rk",
          sessionAlias: "brt_1",
          chunk: "Thinking deeply",
          conversation: {
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            runId: "run_1",
            memberTurnId: "m_1",
          },
        },
      } as never);
      expect(store.liveTurn?.parts).toEqual([{ type: "reasoning", text: "Thinking deeply" }]);

      // Output chunk
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-output",
          chatKey: "rk",
          sessionAlias: "brt_1",
          chunk: "Result:",
          conversation: {
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            runId: "run_1",
            memberTurnId: "m_1",
          },
        },
      } as never);
      expect(store.liveTurn?.parts).toHaveLength(2);
      expect(store.liveTurn?.parts[1]).toEqual({ type: "text", text: "Result:" });

      // Tool event
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "tool-event",
          chatKey: "rk",
          sessionAlias: "brt_1",
          step: { toolCallId: "call_1", name: "git_diff", input: {}, status: "running" } as never,
          conversation: {
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            runId: "run_1",
            memberTurnId: "m_1",
          },
        },
      } as never);
      expect(store.liveTurn?.parts).toHaveLength(3);

      // Finish event retains parts under runParts[runId]
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-finished",
          chatKey: "rk",
          sessionAlias: "brt_1",
          conversation: {
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            runId: "run_1",
            memberTurnId: "m_1",
          },
        },
      } as never);
      expect(store.runParts["run_1"]).toHaveLength(3);

      // Event for a different conversation/topic must NOT update liveTurn
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-output",
          chatKey: "rk",
          sessionAlias: "brt_2",
          chunk: "Other bot output",
          conversation: {
            conversationId: "conv_other",
            topicId: "top_other",
            botId: "bot_2",
            runId: "run_other",
            memberTurnId: "m_other",
          },
        },
      } as never);
      expect(store.liveTurn?.parts[1]).toEqual({ type: "text", text: "Result:" });
    });
  });

  describe("Run Cancellation", () => {
    it("cancels run with exact runId and updates state", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_target",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };

      const cancelledDetail: ConversationRunDetailDto = {
        id: "run_target",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "cancelled",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        memberTurns: [],
      };
      mockRpc.mockResolvedValueOnce({ ok: true, run: cancelledDetail });
      // history load after cancel
      mockRpc.mockResolvedValueOnce({
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      });

      await store.cancelCurrentRun();
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.runs.cancel", { runId: "run_target" });
      expect(store.activeRun?.state).toBe("cancelled");
      expect(store.liveTurn).toBeNull();
    });

    it("marks run indeterminate on cancellation failure/timeout", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_target",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };

      mockRpc.mockRejectedValueOnce(new Error("cancellation timeout"));

      await store.cancelCurrentRun();
      expect(store.activeRun?.state).toBe("indeterminate");
    });
    it("does not overwrite activeRun when stale cancelCurrentRun resolves after user switched bot and started a new run", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_old",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };

      const { promise: cancelPromise, resolve: resolveCancel } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string, payload: unknown) => {
        if (type === "control.runs.cancel") return cancelPromise;
        if (type === "control.conversations.list") {
          return Promise.resolve({ conversations: [{ id: "conv_2", botId: "bot_2", defaultTopicId: "top_2" }] });
        }
        if (type === "control.topics.list") {
          return Promise.resolve({ topics: [{ id: "top_2", conversationId: "conv_2", title: "Topic 2" }] });
        }
        if (type === "control.conversation.history") {
          return Promise.resolve({ conversationId: "c", topicId: "t", messages: [], hasMoreBefore: false, hasMoreAfter: false });
        }
        return Promise.resolve({});
      });

      // 1. Cancel run_old
      const cancelCall = store.cancelCurrentRun();

      // 2. User switches to Bot 2 and starts run_new
      await store.selectBot("inst_1", "bot_2");
      store.activeRun = {
        id: "run_new",
        conversationId: "conv_2",
        topicId: "top_2",
        requestMessageId: "m2",
        requestId: "r2",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };

      // 3. Stale cancel for run_old resolves
      resolveCancel({
        ok: true,
        run: {
          id: "run_old",
          conversationId: "conv_1",
          topicId: "top_1",
          state: "cancelled",
        },
      });
      await cancelCall;
      await flushPromises();

      // run_new must remain untouched!
      expect(store.activeRun?.id).toBe("run_new");
      expect(store.activeRun?.state).toBe("running");
    });
  });

  describe("Isolation & Ordinary Session Fencing", () => {
    it("ensures ordinary useChatStore ignores conversation-correlated events and snapshots", () => {
      const chatStore = useChatStore();
      chatStore.select("inst_1", "ordinary_session");

      // Conversation-correlated turn event arriving at ordinary chat store
      chatStore.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-started",
          chatKey: "rk",
          sessionAlias: "brt_hidden",
          startedAt: 1000,
          conversation: {
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            runId: "run_1",
            memberTurnId: "m_1",
          },
        },
      } as never);

      // Ordinary chat store must NOT track this live turn
      expect(chatStore.runningSince("inst_1", "brt_hidden")).toBeNull();

      // State snapshot containing conversation-correlated turn
      chatStore.applyEvent({
        kind: "state-snapshot",
        instanceId: "inst_1",
        turns: [
          {
            instanceId: "inst_1",
            sessionAlias: "brt_hidden",
            parts: [{ type: "text", text: "bot content" }],
            status: "streaming",
            startedAt: 1000,
            conversation: {
              conversationId: "conv_1",
              topicId: "top_1",
              botId: "bot_1",
              runId: "run_1",
              memberTurnId: "m_1",
            },
          } as LiveTurnSnapshotDto,
        ],
        usage: [],
        commands: [],
      });

      expect(chatStore.runningSince("inst_1", "brt_hidden")).toBeNull();
    });

    it("restores correlated live turn from state snapshot in directBotsStore", () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";

      store.applyEvent({
        kind: "state-snapshot",
        instanceId: "inst_1",
        turns: [
          {
            instanceId: "inst_1",
            sessionAlias: "brt_hidden",
            parts: [{ type: "text", text: "recovered stream" }],
            status: "streaming",
            startedAt: 1234,
            conversation: {
              conversationId: "conv_1",
              topicId: "top_1",
              botId: "bot_1",
              runId: "run_1",
              memberTurnId: "m_1",
            },
          } as LiveTurnSnapshotDto,
        ],
        usage: [],
        commands: [],
      });

      expect(store.liveTurn).toBeTruthy();
      expect(store.liveTurn?.parts).toEqual([{ type: "text", text: "recovered stream" }]);
      expect(store.liveTurn?.status).toBe("streaming");
    });
    it("does not overwrite activeRun when stale snapshot runs.get resolves after user switched bot", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_old",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };

      const { promise: runsGetPromise, resolve: resolveRunsGet } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string, payload: unknown) => {
        if (type === "control.runs.get") return runsGetPromise;
        if (type === "control.conversation.history") {
          return Promise.resolve({ conversationId: "c", topicId: "t", messages: [], hasMoreBefore: false, hasMoreAfter: false });
        }
        if (type === "control.conversations.list") {
          return Promise.resolve({ conversations: [{ id: "conv_2", botId: "bot_2", defaultTopicId: "top_2" }] });
        }
        if (type === "control.topics.list") {
          return Promise.resolve({ topics: [{ id: "top_2", conversationId: "conv_2", title: "Topic 2" }] });
        }
        return Promise.resolve({});
      });

      // Snapshot arrives indicating run_old is no longer active in snapshot
      store.applyEvent({
        kind: "state-snapshot",
        instanceId: "inst_1",
        turns: [],
        usage: [],
        commands: [],
      });

      // While runs.get for run_old is in-flight, user switches to Bot 2
      await store.selectBot("inst_1", "bot_2");
      // And starts a new run on Bot 2
      store.activeRun = {
        id: "run_new",
        conversationId: "conv_2",
        topicId: "top_2",
        requestMessageId: "m2",
        requestId: "r2",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };

      // Now the old runs.get resolves with run_old completed
      resolveRunsGet({
        run: {
          id: "run_old",
          conversationId: "conv_1",
          topicId: "top_1",
          state: "completed",
        },
      });
      await runsGetPromise;
      await flushPromises();

      // Stale runs.get response MUST NOT overwrite run_new!
      expect(store.activeRun?.id).toBe("run_new");
      expect(store.activeRun?.state).toBe("running");
    });
  });

  describe("Reconnect Recovery", () => {
    it("reconciles bots, topics, history, and queries active run state", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_1",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };

      // 1. loadBots
      mockRpc.mockResolvedValueOnce({
        bots: [{ id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" }],
      });
      // 2. loadBotDetail
      mockRpc.mockResolvedValueOnce({
        bot: { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, profileRevision: 1, createdAt: "now", updatedAt: "now" },
      });
      // 3. loadTopics
      mockRpc.mockResolvedValueOnce({
        topics: [{ id: "top_1", conversationId: "conv_1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" }],
      });
      // 4. loadHistory
      mockRpc.mockResolvedValueOnce({
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      });
      // 5. runsGet (shows run completed offline)
      const finishedRun: ConversationRunDetailDto = {
        id: "run_1",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "completed",
        profileRevision: 1,
        createdAt: "now",
        memberTurns: [],
      };
      mockRpc.mockResolvedValueOnce({ run: finishedRun });
      // 6. loadHistory to converge on completion
      mockRpc.mockResolvedValueOnce({
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [
          {
            id: "msg_final",
            conversationId: "conv_1",
            topicId: "top_1",
            seq: 2,
            role: "bot",
            runId: "run_1",
            content: "Finished answer",
            createdAt: "now",
          },
        ],
        hasMoreBefore: false,
        hasMoreAfter: false,
      });

      await store.reconcileOnReconnect();

      expect(store.activeRun?.state).toBe("completed");
      expect(store.liveTurn).toBeNull();
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]?.content).toBe("Finished answer");
    });
  });
});
