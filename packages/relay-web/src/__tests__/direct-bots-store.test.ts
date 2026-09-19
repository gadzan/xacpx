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
    it("deduplicates topic when conversation-topic-changed event arrives before createTopic RPC resolves", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";

      const newTopic: TopicSummaryDto = {
        id: "top_dup",
        conversationId: "conv_1",
        title: "Sprint Review",
        status: "active",
        createdAt: "now",
        updatedAt: "now",
      };

      const { promise: rpcPromise, resolve: resolveRpc } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.topics.create") return rpcPromise;
        if (type === "control.conversation.history") return Promise.resolve({ conversationId: "conv_1", topicId: "top_dup", messages: [] });
        return Promise.resolve({});
      });

      const createCall = store.createTopic("inst_1", "conv_1", "Sprint Review");

      // WS event arrives BEFORE the HTTP RPC resolves
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-topic-changed",
          topic: newTopic,
        } as never,
      });
      expect(store.topicsByConversation["inst_1:conv_1"]).toHaveLength(1);

      // Now HTTP RPC resolves
      resolveRpc({ topic: newTopic });
      await createCall;
      await flushPromises();

      // Topic MUST NOT be duplicated!
      expect(store.topicsByConversation["inst_1:conv_1"]).toHaveLength(1);
      expect(store.topicsByConversation["inst_1:conv_1"]?.[0]?.id).toBe("top_dup");
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
    it("loads newest-first tail history then recovers the durable active run", async () => {
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
      const durableRun: ConversationRunDto = {
        id: "run_tail",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_1",
        requestId: "req_tail",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };
      const durableDetail: ConversationRunDetailDto = {
        ...durableRun,
        memberTurns: [
          {
            id: "turn_tail",
            runId: "run_tail",
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            batch: 1,
            attempt: 1,
            origin: "human",
            state: "running",
            createdAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      };
      mockRpc.mockImplementation((instanceId: string, type: string) => {
        if (type === "control.conversation.history") return Promise.resolve(mockHistory);
        if (type === "control.runs.list") {
          return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", runs: [durableRun], activeRunId: "run_tail" });
        }
        if (type === "control.runs.get") return Promise.resolve({ run: durableDetail });
        return Promise.reject(new Error(`unexpected rpc ${type}`));
      });

      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.conversation.history", {
        conversationId: "conv_1",
        topicId: "top_1",
        limit: 50,
        direction: "newest-first",
      });
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.runs.list", {
        conversationId: "conv_1",
        topicId: "top_1",
      });
      expect(store.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(store.oldestSeq).toBe(1);
      expect(store.newestSeq).toBe(2);
      expect(store.hasMoreBefore).toBe(true);
      expect(store.activeRun?.id).toBe("run_tail");
      expect(store.activeMemberTurn?.id).toBe("turn_tail");
      expect(store.isRunActive).toBe(true);
      // A second prompt must fence against the recovered durable Run.
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      store.selectedBotId = "bot_1";
      await store.sendPrompt("second prompt while recovered run active");
      expect(store.promptError).toContain("already in progress");
    });

    it("drops a stale recovery when a newer recovery supersedes it", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      const runA: ConversationRunDto = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_A",
        requestId: "req_A",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };
      const runB: ConversationRunDto = {
        id: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_B",
        requestId: "req_B",
        mode: "explicit",
        state: "queued",
        profileRevision: 1,
        createdAt: "2026-09-18T00:01:00.000Z",
      };
      let resolveListA!: (value: unknown) => void;
      const listGateA = new Promise<unknown>((resolve) => { resolveListA = resolve; });
      let listCalls = 0;
      mockRpc.mockImplementation((instanceId: string, type: string) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          listCalls += 1;
          if (listCalls === 1) return listGateA;
          return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", runs: [runA, runB], activeRun: runB, activeRunId: "run_B" });
        }
        if (type === "control.runs.get") {
          return Promise.resolve({ run: { ...runB, memberTurns: [] } });
        }
        return Promise.reject(new Error(`unexpected rpc ${type}`));
      });
      // H1 starts recovery; H2 supersedes it before H1's runs.list resolves.
      // History resolves immediately so both recoveries race at runs.list.
      // H2 runs fully (history + runs.list + runs.get) before H1's slow
      // discovery resolves, so H1 must lose on the recovery generation.
      const stale = store.loadHistory("inst_1", "conv_1", "top_1");
      await flushPromises();
      await store.loadHistory("inst_1", "conv_1", "top_1");
      await flushPromises();
      await flushPromises();
      await flushPromises();
      // H1's slow discovery (stale A running) resolves last and must lose.
      resolveListA({ conversationId: "conv_1", topicId: "top_1", runs: [runA], activeRun: runA, activeRunId: "run_A" });
      await stale;
      await flushPromises();
      await flushPromises();
      await flushPromises();
      expect(store.activeRun?.id).toBe("run_B");
      expect(store.isRunActive).toBe(true);
    });

    it("recovers the durable Run past a stale terminal activeRun (lost accept response)", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_old",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_old",
        requestId: "req_old",
        mode: "explicit",
        state: "completed",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };
      const durableRun: ConversationRunDto = {
        id: "run_new",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_new",
        requestId: "req_new",
        mode: "explicit",
        state: "queued",
        profileRevision: 1,
        createdAt: "2026-09-18T00:01:00.000Z",
      };
      mockRpc.mockImplementation((instanceId: string, type: string) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", runs: [durableRun], activeRunId: "run_new" });
        }
        if (type === "control.runs.get") {
          return Promise.resolve({ run: { ...durableRun, memberTurns: [] } });
        }
        return Promise.reject(new Error(`unexpected rpc ${type}`));
      });
      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.activeRun?.id).toBe("run_new");
      expect(store.isRunActive).toBe(true);
    });

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
      mockRpc.mockImplementation((instanceId: string, type: string, payload?: unknown) => {
        if (type === "control.conversation.history") return Promise.resolve(mockHistory);
        if (type === "control.runs.list") {
          return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", runs: [], activeRunId: undefined });
        }
        return Promise.reject(new Error(`unexpected rpc ${type}: ${String(instanceId)} ${JSON.stringify(payload)}`));
      });

      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(store.oldestSeq).toBe(1);
      expect(store.newestSeq).toBe(2);
      expect(store.hasMoreBefore).toBe(true);
    });

    it("drops a stale same-view history page when a newer reload started", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      let resolveFirst!: (value: unknown) => void;
      const firstGate = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
      let calls = 0;
      mockRpc.mockImplementation((instanceId: string, type: string) => {
        if (type === "control.conversation.history") {
          calls += 1;
          if (calls === 1) return firstGate;
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [
              { id: "msg_new", conversationId: "conv_1", topicId: "top_1", seq: 9, role: "human", content: "new", createdAt: "now" },
            ],
            oldestSeq: 9,
            newestSeq: 9,
            hasMoreBefore: true,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", runs: [] });
        }
        return Promise.reject(new Error(`unexpected rpc ${type}`));
      });
      const stale = store.loadHistory("inst_1", "conv_1", "top_1");
      // A live message lands while the first page is in flight.
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-message",
          message: { id: "msg_live", conversationId: "conv_1", topicId: "top_1", seq: 10, role: "human", content: "live", createdAt: "now" },
        },
      } as never);
      // A second reload starts (convergent retry); the stale first page must lose.
      void store.loadHistory("inst_1", "conv_1", "top_1");
      resolveFirst({
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [
          { id: "msg_stale", conversationId: "conv_1", topicId: "top_1", seq: 1, role: "human", content: "stale", createdAt: "now" },
        ],
        oldestSeq: 1,
        newestSeq: 1,
        hasMoreBefore: false,
        hasMoreAfter: false,
      });
      await stale;
      await flushPromises();
      await flushPromises();
      // The stale seq-1 page never clobbers the newer transcript. The live
      // seq-10 row arrived while the first page was in flight, so the first
      // request convergently retries; a later authoritative page re-merges it.
      // Here the retry's seq-9 page wins over the stale seq-1 page.
      expect(store.messages.map((m) => m.seq)).toEqual([9]);
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
    it("adopts pending-prompt run when queued run-changed arrives but HTTP accept is lost", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      store.activeRun = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_A",
        requestId: "req_A",
        mode: "explicit",
        state: "completed",
        profileRevision: 1,
        createdAt: "now",
      };

      const deferred = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") return deferred.promise;
        return Promise.resolve({});
      });

      const sendCall = store.sendPrompt("Prompt B");
      const pendingRequestId = store.currentDraftRequestId;
      expect(pendingRequestId).toBeTruthy();

      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: {
            id: "run_B",
            conversationId: "conv_1",
            topicId: "top_1",
            requestMessageId: "msg_B",
            requestId: pendingRequestId,
            mode: "explicit",
            state: "queued",
            profileRevision: 1,
            createdAt: "now",
          },
        } as never,
      });

      expect(store.activeRun?.id).toBe("run_B");
      expect(store.activeRun?.state).toBe("queued");
      expect(store.isRunActive).toBe(true);
      expect(store.promptInFlight).toBe(true);

      await store.sendPrompt("Prompt C");
      expect(store.promptError).toContain("already in progress");
      expect(store.activeRun?.id).toBe("run_B");

      // The HTTP prompt ultimately fails, but the durable Run B must survive.
      // WS already proved durable accept, so submission state converges to
      // success: no transport error, no retry identity.
      deferred.reject(new Error("Network disconnect"));
      await sendCall;
      expect(store.activeRun?.id).toBe("run_B");
      expect(store.activeRun?.state).toBe("queued");
      expect(store.isRunActive).toBe(true);
      // The transient "already in progress" gate error from Prompt C must not
      // survive the durable outcome; Prompt C never sent, so no retry exists.
      expect(store.promptError).toBeNull();
      expect(store.currentDraftRequestId).toBeNull();
      expect(store.lastPromptText).toBe("");
    });
    it("blocks prompt while topic recovery discovery is still in flight", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      store.topicReady = false;

      await store.sendPrompt("too early");
      expect(mockRpc).not.toHaveBeenCalledWith(
        "inst_1",
        "control.conversation.prompt",
        expect.anything(),
      );
      expect(store.promptError).toContain("still recovering");

      store.topicReady = true;
      mockRpc.mockResolvedValueOnce({
        message: {
          id: "msg_1", conversationId: "conv_1", topicId: "top_1", seq: 1,
          role: "human", content: "too early", createdAt: "now",
        },
        run: {
          id: "run_1", conversationId: "conv_1", topicId: "top_1",
          requestMessageId: "msg_1", requestId: "req_1", mode: "explicit",
          state: "queued", profileRevision: 1, createdAt: "now",
        },
        memberTurn: {
          id: "turn_1", runId: "run_1", conversationId: "conv_1", topicId: "top_1",
          botId: "bot_1", batch: 1, attempt: 1, origin: "human",
          state: "queued", createdAt: "now",
        },
      });
      await store.sendPrompt("too early");
      expect(mockRpc).toHaveBeenCalledWith(
        "inst_1",
        "control.conversation.prompt",
        expect.objectContaining({ text: "too early" }),
      );
    });
    it("keeps admission closed when history fails so no prompt owns an unknown run", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.history") {
          return Promise.reject(new Error("history offline"));
        }
        return Promise.resolve({});
      });

      store.topicReady = false;
      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.historyError).toContain("history offline");
      expect(store.topicReady).toBe(false);

      await store.sendPrompt("must not send");
      expect(mockRpc).not.toHaveBeenCalledWith(
        "inst_1",
        "control.conversation.prompt",
        expect.anything(),
      );
      expect(store.promptError).toContain("still recovering");
    });
    it("keeps admission closed when runs.list discovery fails after history success", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          return Promise.resolve({ error: { code: "discovery-offline", message: "discovery offline" } });
        }
        return Promise.resolve({});
      });

      await store.loadHistory("inst_1", "conv_1", "top_1");
      // History rendered, but the owner is unproven: admission stays closed
      // with a discovery error, not a silent open gate.
      expect(store.historyError).toContain("Run discovery failed");
      expect(store.topicReady).toBe(false);

      await store.sendPrompt("must not own an unseen run");
      expect(mockRpc).not.toHaveBeenCalledWith(
        "inst_1",
        "control.conversation.prompt",
        expect.anything(),
      );
      expect(store.promptError).toContain("still recovering");
    });
    it("marks the bot identity-locked immediately on first durable accept", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Fresh", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      expect(store.currentBot?.hasRuntime).toBeUndefined();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") {
          return Promise.resolve({
            message: {
              id: "msg_1", conversationId: "conv_1", topicId: "top_1", seq: 1,
              role: "human", content: "first", createdAt: "now",
            },
            run: {
              id: "run_1", conversationId: "conv_1", topicId: "top_1",
              requestMessageId: "msg_1", requestId: "req_1", mode: "explicit",
              state: "queued", profileRevision: 1, createdAt: "now",
            },
            memberTurn: {
              id: "turn_1", runId: "run_1", conversationId: "conv_1", topicId: "top_1",
              botId: "bot_1", batch: 1, attempt: 1, origin: "human",
              state: "queued", createdAt: "now",
            },
          });
        }
        return Promise.resolve({});
      });

      await store.sendPrompt("first");
      // No list/detail refetch happened, yet the lifecycle UI converges.
      expect(mockRpc).not.toHaveBeenCalledWith("inst_1", "control.bots.list", expect.anything());
      expect(store.currentBot?.hasRuntime).toBe(true);
      expect(store.botDetails["inst_1:bot_1"]?.hasRuntime).toBeUndefined();
    });
    it("marks the bot identity-locked on WS-proven accept when HTTP is lost", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Fresh", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      const deferred = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") return deferred.promise;
        return Promise.resolve({});
      });

      const sendCall = store.sendPrompt("first");
      const pendingRequestId = store.currentDraftRequestId;
      expect(pendingRequestId).toBeTruthy();
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: {
            id: "run_B",
            conversationId: "conv_1",
            topicId: "top_1",
            requestMessageId: "msg_B",
            requestId: pendingRequestId,
            mode: "explicit",
            state: "queued",
            profileRevision: 1,
            createdAt: "now",
          },
        },
      } as never);
      // WS proof converges lifecycle UI even though HTTP never resolves.
      expect(store.currentBot?.hasRuntime).toBe(true);

      deferred.reject(new Error("Network disconnect"));
      await sendCall;
      expect(store.currentBot?.hasRuntime).toBe(true);
    });
    it("does not forge a discovery failure when a terminal event refreshes history during deferred runs.get", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      const durableRun = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_A",
        requestId: "req_A",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      const terminalRun = { ...durableRun, state: "completed" };
      let resolveRunsGet!: (value: unknown) => void;
      const runsGetGate = new Promise<unknown>((resolve) => { resolveRunsGet = resolve; });
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            runs: [durableRun],
            activeRunId: "run_A",
            activeRun: durableRun,
          });
        }
        if (type === "control.runs.get") {
          return runsGetGate;
        }
        return Promise.resolve({});
      });

      // Foreground discovery adopts Run A, then defers on runs.get(A).
      const loadCall = store.loadHistory("inst_1", "conv_1", "top_1");
      await flushPromises();
      expect(store.activeRun?.id).toBe("run_A");

      // WS reports A terminal while runs.get(A) is still deferred. The
      // terminal branch fires a background transcript refresh (proving the
      // race from the review): it must not invalidate the foreground
      // recovery or forge a discovery failure.
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: { type: "conversation-run-changed", run: terminalRun },
      } as never);
      await flushPromises();

      resolveRunsGet({
        run: {
          ...terminalRun,
          memberTurns: [
            {
              id: "turn_A",
              runId: "run_A",
              conversationId: "conv_1",
              topicId: "top_1",
              botId: "bot_1",
              batch: 1,
              attempt: 1,
              origin: "human",
              state: "completed",
              createdAt: "now",
            },
          ],
        },
      });
      await loadCall;
      await flushPromises();

      // Recovery converges on the terminal Run: the terminal event retires
      // A, and the handoff re-discovery confirms no next owner, so the gate
      // opens with no discovery failure and the live turn clears.
      expect(store.activeRun?.id).toBe("run_A");
      expect(store.activeRun?.state).toBe("completed");
      expect(store.historyError).toBeNull();
      expect(store.topicReady).toBe(true);
      expect(store.liveTurn).toBeNull();
    });
    it("hands ownership to queued B after A terminal and keeps the composer blocked", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      const runA = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_A",
        requestId: "req_A",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      const runBQueued = {
        id: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_B",
        requestId: "req_B",
        mode: "explicit",
        state: "queued",
        profileRevision: 1,
        createdAt: "now",
      };
      const terminalA = { ...runA, state: "completed" };
      let handoffArmed = false;
      mockRpc.mockImplementation((instId: string, type: string, payload?: unknown) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          // Before the terminal handoff, discovery sees A running; the
          // terminal handoff re-discovery sees B as the authoritative next
          // owner.
          if (!handoffArmed) {
            return Promise.resolve({
              conversationId: "conv_1",
              topicId: "top_1",
              runs: [runA],
              activeRunId: "run_A",
              activeRun: runA,
            });
          }
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            runs: [runBQueued],
            activeRunId: "run_B",
            activeRun: runBQueued,
          });
        }
        if (type === "control.runs.get") {
          const requestedId = (payload as { runId?: string } | undefined)?.runId;
          const row = requestedId === "run_B" ? runBQueued : runA;
          return Promise.resolve({ run: { ...row, memberTurns: [] } });
        }
        return Promise.resolve({});
      });

      // Initial load adopts A; the composer stays blocked while A runs.
      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.activeRun?.id).toBe("run_A");
      expect(store.isRunActive).toBe(true);

      // A completes on the wire. The handoff must close admission and
      // re-discover before any new prompt can take ownership.
      handoffArmed = true;
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: { type: "conversation-run-changed", run: terminalA },
      } as never);
      expect(store.topicReady).toBe(false);
      expect(store.promptError).toBeNull();

      await flushPromises();
      await flushPromises();

      // Queued B is now the authoritative owner; the composer stays blocked
      // and a new prompt is fenced against the recovered Run.
      expect(store.activeRun?.id).toBe("run_B");
      expect(store.isRunActive).toBe(true);
      expect(store.topicReady).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.runs.list", {
        conversationId: "conv_1",
        topicId: "top_1",
      });
      await store.sendPrompt("prompt C while B queued");
      expect(store.promptError).toContain("already in progress");
      expect(store.activeRun?.id).toBe("run_B");
      expect(mockRpc).not.toHaveBeenCalledWith(
        "inst_1",
        "control.conversation.prompt",
        expect.anything(),
      );
    });
    it("rediscovers when a foreign queued Run arrives after a no-candidate handoff", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      const runA = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_A",
        requestId: "req_A",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      const terminalA = { ...runA, state: "completed" };
      const runBQueued = {
        id: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_B",
        requestId: "req_foreign_B",
        mode: "explicit",
        state: "queued",
        createdAt: "now",
      };
      // Discovery first tracks A, then the terminal handoff proves an
      // authoritative no-candidate. A foreign B queued afterwards must not
      // stay invisible behind the reopened gate.
      let phase: "running-A" | "no-candidate" | "foreign-B" = "running-A";
      mockRpc.mockImplementation((instId: string, type: string, payload?: unknown) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          if (phase === "running-A") {
            return Promise.resolve({
              conversationId: "conv_1",
              topicId: "top_1",
              runs: [runA],
              activeRunId: "run_A",
              activeRun: runA,
            });
          }
          if (phase === "no-candidate") {
            return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", runs: [] });
          }
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            runs: [runBQueued],
            activeRunId: "run_B",
            activeRun: runBQueued,
          });
        }
        if (type === "control.runs.get") {
          const requestedId = (payload as { runId?: string } | undefined)?.runId;
          const row = requestedId === "run_B" ? runBQueued : runA;
          return Promise.resolve({ run: { ...row, memberTurns: [] } });
        }
        return Promise.resolve({});
      });

      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.activeRun?.id).toBe("run_A");

      phase = "no-candidate";
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: { type: "conversation-run-changed", run: terminalA },
      } as never);
      await flushPromises();
      await flushPromises();
      expect(store.activeRun?.id).toBe("run_A");
      expect(store.activeRun?.state).toBe("completed");
      expect(store.topicReady).toBe(true);

      // Another client queues B after the handoff completed. The foreign
      // nonterminal event must synchronously close admission and elect B via
      // authoritative discovery — never adopt blindly, never stay open.
      phase = "foreign-B";
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: { type: "conversation-run-changed", run: runBQueued },
      } as never);
      expect(store.topicReady).toBe(false);
      await flushPromises();
      await flushPromises();
      expect(store.activeRun?.id).toBe("run_B");
      expect(store.isRunActive).toBe(true);
      expect(store.topicReady).toBe(true);
      await store.sendPrompt("prompt C while foreign B queued");
      expect(store.promptError).toContain("already in progress");
      expect(store.activeRun?.id).toBe("run_B");
      expect(mockRpc).not.toHaveBeenCalledWith(
        "inst_1",
        "control.conversation.prompt",
        expect.anything(),
      );
    });
    it("does not let pre-terminal B stream events steal ownership before handoff discovery", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      const runA = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_A",
        requestId: "req_A",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      const terminalA = { ...runA, state: "completed" };
      const runBQueued = {
        id: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_B",
        requestId: "req_B",
        mode: "explicit",
        state: "queued",
        profileRevision: 1,
        createdAt: "now",
      };
      const memberBStarted = {
        id: "turn_B",
        runId: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        botId: "bot_1",
        batch: 1,
        attempt: 1,
        origin: "human",
        state: "running",
        createdAt: "now",
      };
      let handoffArmed = false;
      mockRpc.mockImplementation((instId: string, type: string, payload?: unknown) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          if (!handoffArmed) {
            return Promise.resolve({
              conversationId: "conv_1",
              topicId: "top_1",
              runs: [runA],
              activeRunId: "run_A",
              activeRun: runA,
            });
          }
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            runs: [runBQueued],
            activeRunId: "run_B",
            activeRun: runBQueued,
          });
        }
        if (type === "control.runs.get") {
          const requestedId = (payload as { runId?: string } | undefined)?.runId;
          const row = requestedId === "run_B" ? runBQueued : runA;
          return Promise.resolve({ run: { ...row, memberTurns: [] } });
        }
        return Promise.resolve({});
      });

      await store.loadHistory("inst_1", "conv_1", "top_1");
      expect(store.activeRun?.id).toBe("run_A");

      // B starts streaming before the terminal handoff for A is processed:
      // all pre-terminal B events stay fenced on the old owner id.
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "member-turn-started",
          run: runBQueued,
          memberTurn: memberBStarted,
        },
      } as never);
      expect(store.activeRun?.id).toBe("run_A");
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: { ...runBQueued, state: "running" },
        } as never,
      });
      expect(store.activeRun?.id).toBe("run_A");

      // A's terminal event hands off: discovery adopts B exactly once.
      handoffArmed = true;
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: { type: "conversation-run-changed", run: terminalA },
      } as never);
      await flushPromises();
      await flushPromises();
      expect(store.activeRun?.id).toBe("run_B");
      expect(store.isRunActive).toBe(true);
      expect(store.topicReady).toBe(true);
    });
    it("clears a ghost bot selection when the authoritative list no longer contains it", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_gone";
      store.activeConversationId = "conv_gone";
      store.activeTopicId = "top_gone";
      store.botDetails["inst_1:bot_gone"] = {
        id: "bot_gone", name: "Gone", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 1, createdAt: "now", updatedAt: "now",
      };
      try {
        localStorage.setItem(
          "xrelay.selectedBot",
          JSON.stringify({ instanceId: "inst_1", botId: "bot_gone" }),
        );
      } catch { /* ignore */ }
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.bots.list") {
          return Promise.resolve({
            bots: [
              { id: "bot_other", name: "Other", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            ],
          });
        }
        return Promise.resolve({});
      });

      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: { type: "bots-changed" },
      } as never);
      await flushPromises();
      await flushPromises();

      expect(store.selectedBotId).toBeNull();
      expect(store.activeConversationId).toBeNull();
      expect(store.activeTopicId).toBeNull();
      expect(store.botDetails["inst_1:bot_gone"]).toBeUndefined();
      expect(localStorage.getItem("xrelay.selectedBot")).toBeNull();
    });
    it("reconnect drops a ghost bot instead of restoring its pane", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_gone";
      store.activeConversationId = "conv_gone";
      store.activeTopicId = "top_gone";
      store.botDetails["inst_1:bot_gone"] = {
        id: "bot_gone", name: "Gone", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 1, createdAt: "now", updatedAt: "now",
      };
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.bots.list") {
          return Promise.resolve({
            bots: [
              { id: "bot_other", name: "Other", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            ],
          });
        }
        return Promise.resolve({});
      });

      await store.reconcileOnReconnect();

      expect(store.selectedBotId).toBeNull();
      expect(store.activeConversationId).toBeNull();
      expect(store.activeTopicId).toBeNull();
      expect(store.botDetails["inst_1:bot_gone"]).toBeUndefined();
      expect(mockRpc).not.toHaveBeenCalledWith("inst_1", "control.bots.get", expect.anything());
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
    it("refuses to send prompt when a run is already in progress", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_active",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      await store.sendPrompt("Second prompt while running");
      expect(mockRpc).not.toHaveBeenCalled();
      expect(store.promptError).toContain("already in progress");
    });

    it("preserves live stream parts that arrived before prompt RPC resolved", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      const { promise: promptPromise, resolve: resolvePrompt } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") return promptPromise;
        return Promise.resolve({});
      });

      const sendCall = store.sendPrompt("Explain code");

      // Before prompt RPC resolves, turn events stream in over WebSocket
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-started",
          chatKey: "rk",
          sessionAlias: "brt_1",
          startedAt: 1000,
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_stream", memberTurnId: "m1" },
        } as never,
      });
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-thought",
          chatKey: "rk",
          sessionAlias: "brt_1",
          chunk: "Early thought",
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_stream", memberTurnId: "m1" },
        } as never,
      });
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-output",
          chatKey: "rk",
          sessionAlias: "brt_1",
          chunk: "Early text",
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_stream", memberTurnId: "m1" },
        } as never,
      });

      expect(store.liveTurn?.parts).toHaveLength(2);

      // Now prompt RPC resolves
      resolvePrompt({
        reused: false,
        conversationId: "conv_1",
        topicId: "top_1",
        requestId: store.currentDraftRequestId!,
        message: { id: "msg_h", conversationId: "conv_1", topicId: "top_1", seq: 1, role: "human", content: "Explain code", createdAt: "now" },
        run: { id: "run_stream", conversationId: "conv_1", topicId: "top_1", requestMessageId: "msg_h", requestId: "r", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now" },
        memberTurn: { id: "m1", runId: "run_stream", conversationId: "conv_1", topicId: "top_1", botId: "bot_1", batch: 1, attempt: 1, origin: "human", state: "running", createdAt: "now" },
      });
      await sendCall;
      await flushPromises();

      // Pre-arrived streaming parts MUST be preserved, not wiped!
      expect(store.liveTurn?.parts).toHaveLength(2);
      expect(store.liveTurn?.parts[0]).toEqual({ type: "reasoning", text: "Early thought" });
      expect(store.liveTurn?.parts[1]).toEqual({ type: "text", text: "Early text" });
      expect(store.runParts["run_stream"]).toHaveLength(2);
    });
    it("does not regress running or completed Run state when delayed fresh queued RPC response arrives", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      const { promise: promptPromise, resolve: resolvePrompt } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") return promptPromise;
        return Promise.resolve({});
      });

      const sendCall = store.sendPrompt("Test prompt");

      // Before prompt RPC resolves, WebSocket events advance the run to running
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: {
            id: "run_1",
            conversationId: "conv_1",
            topicId: "top_1",
            requestMessageId: "m1",
            requestId: "r1",
            mode: "explicit",
            state: "running",
            profileRevision: 1,
            createdAt: "now",
          },
        } as never,
      });

      expect(store.activeRun?.state).toBe("running");

      // Then delayed prompt RPC returns initial "queued" state
      resolvePrompt({
        reused: false,
        conversationId: "conv_1",
        topicId: "top_1",
        requestId: store.currentDraftRequestId!,
        message: { id: "m1", conversationId: "conv_1", topicId: "top_1", seq: 1, role: "human", content: "Test prompt", createdAt: "now" },
        run: { id: "run_1", conversationId: "conv_1", topicId: "top_1", requestMessageId: "m1", requestId: "r1", mode: "explicit", state: "queued", profileRevision: 1, createdAt: "now" },
        memberTurn: { id: "turn_1", runId: "run_1", conversationId: "conv_1", topicId: "top_1", botId: "bot_1", batch: 1, attempt: 1, origin: "human", state: "queued", createdAt: "now" },
      });
      await sendCall;
      await flushPromises();

      // Active run state MUST NOT regress to "queued"!
      expect(store.activeRun?.state).toBe("running");
      expect(store.isRunActive).toBe(true);
    });

    it("directly converges to terminal state and loads history when prompt RPC returns reused completed run", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") {
          return Promise.resolve({
            reused: true,
            conversationId: "conv_1",
            topicId: "top_1",
            requestId: "req_retry",
            message: { id: "m1", conversationId: "conv_1", topicId: "top_1", seq: 1, role: "human", content: "Retry prompt", createdAt: "now" },
            run: { id: "run_finished", conversationId: "conv_1", topicId: "top_1", requestMessageId: "m1", requestId: "req_retry", mode: "explicit", state: "completed", profileRevision: 1, createdAt: "now" },
            memberTurn: { id: "turn_1", runId: "run_finished", conversationId: "conv_1", topicId: "top_1", botId: "bot_1", batch: 1, attempt: 1, origin: "human", state: "completed", createdAt: "now" },
          });
        }
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [
              { id: "m1", conversationId: "conv_1", topicId: "top_1", seq: 1, role: "human", content: "Retry prompt", createdAt: "now" },
              { id: "m2", conversationId: "conv_1", topicId: "top_1", seq: 2, role: "bot", content: "Already answered", createdAt: "now" },
            ],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        return Promise.resolve({});
      });

      store.currentDraftRequestId = "req_retry";
      await store.sendPrompt("Retry prompt");
      await flushPromises();

      // Must be terminal completed, no liveTurn spinner, and history loaded
      expect(store.activeRun?.state).toBe("completed");
      expect(store.isRunActive).toBe(false);
      expect(store.liveTurn).toBeNull();
      expect(store.messages).toHaveLength(2);
      expect(store.messages[1]?.content).toBe("Already answered");
    });

    it("preserves pre-arrived plan entries when prompt RPC resolves", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      const { promise: promptPromise, resolve: resolvePrompt } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") return promptPromise;
        return Promise.resolve({});
      });

      const sendCall = store.sendPrompt("Plan prompt");

      // Plan event arrives over WebSocket before prompt RPC resolves
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "plan",
          chatKey: "rk",
          sessionAlias: "brt_1",
          entries: [{ content: "Step 1: Check repo", priority: "high", status: "in_progress" }],
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_plan", memberTurnId: "m1" },
        } as never,
      });

      expect(store.planEntries).toHaveLength(1);

      // Prompt RPC resolves
      resolvePrompt({
        reused: false,
        conversationId: "conv_1",
        topicId: "top_1",
        requestId: store.currentDraftRequestId!,
        message: { id: "m1", conversationId: "conv_1", topicId: "top_1", seq: 1, role: "human", content: "Plan prompt", createdAt: "now" },
        run: { id: "run_plan", conversationId: "conv_1", topicId: "top_1", requestMessageId: "m1", requestId: "r", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now" },
        memberTurn: { id: "m1", runId: "run_plan", conversationId: "conv_1", topicId: "top_1", botId: "bot_1", batch: 1, attempt: 1, origin: "human", state: "running", createdAt: "now" },
      });
      await sendCall;
      await flushPromises();

      // Pre-arrived plan entries MUST be preserved!
      expect(store.planEntries).toHaveLength(1);
      expect(store.planEntries[0]?.content).toBe("Step 1: Check repo");
    });
    it("isolates plan entries between runs and does not leak Run A plan into Run B", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      // Run A is active and receives Plan A
      store.activeRun = {
        id: "run_A",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "mA",
        requestId: "rA",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };

      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "plan",
          chatKey: "rk",
          sessionAlias: "brt_1",
          entries: [{ content: "Plan A task", priority: "high", status: "in_progress" }],
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_A", memberTurnId: "mA1" },
        } as never,
      });
      expect(store.planEntries).toHaveLength(1);
      expect(store.planEntries[0]?.content).toBe("Plan A task");

      // Run A completes. No queued next Run exists in this scenario, so the
      // terminal handoff re-discovers an authoritative no-candidate and
      // reopens admission.
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.history") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            messages: [],
            hasMoreBefore: false,
            hasMoreAfter: false,
          });
        }
        if (type === "control.runs.list") {
          return Promise.resolve({
            conversationId: "conv_1",
            topicId: "top_1",
            runs: [],
          });
        }
        return Promise.resolve({});
      });
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: { ...store.activeRun, state: "completed" },
        } as never,
      });
      expect(store.isRunActive).toBe(false);
      await flushPromises();
      await flushPromises();
      expect(store.topicReady).toBe(true);

      // User starts Run B (which does not emit any plan)
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversation.prompt") {
          return Promise.resolve({
            reused: false,
            conversationId: "conv_1",
            topicId: "top_1",
            requestId: "rB",
            message: { id: "mB", conversationId: "conv_1", topicId: "top_1", seq: 3, role: "human", content: "Prompt B", createdAt: "now" },
            run: { id: "run_B", conversationId: "conv_1", topicId: "top_1", requestMessageId: "mB", requestId: "rB", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now" },
            memberTurn: { id: "mB1", runId: "run_B", conversationId: "conv_1", topicId: "top_1", botId: "bot_1", batch: 1, attempt: 1, origin: "human", state: "running", createdAt: "now" },
          });
        }
        return Promise.resolve({});
      });

      await store.sendPrompt("Prompt B");
      await flushPromises();

      expect(store.activeRun?.id).toBe("run_B");
      // Plan A MUST NOT leak into Run B!
      expect(store.planEntries).toEqual([]);
    });
  });

  describe("Streaming and Turn Events correlation", () => {
    it("ignores member-turn-finished for a stale Run instead of stealing the active Run", () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "msg_B",
        requestId: "req_B",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      store.activeMemberTurn = {
        id: "turn_B",
        runId: "run_B",
        conversationId: "conv_1",
        topicId: "top_1",
        botId: "bot_1",
        batch: 1,
        attempt: 1,
        origin: "human",
        state: "running",
        createdAt: "now",
      };
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "member-turn-finished",
          run: {
            id: "run_A",
            conversationId: "conv_1",
            topicId: "top_1",
            requestMessageId: "msg_A",
            requestId: "req_A",
            mode: "explicit",
            state: "completed",
            profileRevision: 1,
            createdAt: "now",
          },
          memberTurn: {
            id: "turn_A",
            runId: "run_A",
            conversationId: "conv_1",
            topicId: "top_1",
            botId: "bot_1",
            batch: 1,
            attempt: 1,
            origin: "human",
            state: "completed",
            createdAt: "now",
          },
        },
      } as never);
      expect(store.activeRun?.id).toBe("run_B");
      expect(store.activeRun?.state).toBe("running");
      expect(store.activeMemberTurn?.id).toBe("turn_B");
      expect(store.liveTurn).toBeNull();
    });

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
    it("ignores a second concurrent cancel dispatch while the first is in flight", async () => {
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
      let cancelCalls = 0;
      let resolveCancel!: (value: unknown) => void;
      const cancelGate = new Promise<unknown>((resolve) => { resolveCancel = resolve; });
      mockRpc.mockImplementation((instanceId: string, type: string) => {
        if (type === "control.runs.cancel") {
          cancelCalls += 1;
          return cancelGate;
        }
        return Promise.resolve({});
      });
      const first = store.cancelCurrentRun();
      await flushPromises();
      await store.cancelCurrentRun();
      expect(cancelCalls).toBe(1);
      resolveCancel({ ok: true, run: { ...store.activeRun, state: "cancelled", memberTurns: [] } });
      await first;
      expect(store.activeRun?.state).toBe("cancelled");
    });

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

    it("handles cancel transport failure: keeps activeRun active, blocks new prompt, and converges on background runs.get", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
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
      store.botsByInstance["inst_1"] = [
        { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      const { promise: runsGetPromise, resolve: resolveRunsGet } = Promise.withResolvers<unknown>();
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.runs.cancel") return Promise.reject(new Error("Network disconnect"));
        if (type === "control.runs.get") return runsGetPromise;
        if (type === "control.conversation.history") return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", messages: [] });
        return Promise.resolve({});
      });

      // User clicks Cancel, but cancel RPC encounters a network failure
      await store.cancelCurrentRun();

      expect(store.activeRun?.state).toBe("running");
      expect(store.isRunActive).toBe(true);
      expect(store.cancelError).toContain("Cancellation outcome unknown");
      expect(store.promptError).toBeNull();

      // Because isRunActive is still true, user CANNOT send a second prompt
      await store.sendPrompt("Second prompt while cancel pending");
      expect(store.promptError).toContain("already in progress");
      expect(store.cancelError).toContain("Cancellation outcome unknown");

      // Now background runs.get resolves with server authoritative cancelled state
      resolveRunsGet({
        run: {
          id: "run_target",
          conversationId: "conv_1",
          topicId: "top_1",
          requestMessageId: "msg_1",
          requestId: "req_1",
          mode: "explicit",
          state: "cancelled",
          profileRevision: 1,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
      });
      await runsGetPromise;
      await flushPromises();

      // Now it cleanly converges to the authoritative cancelled terminal state!
      expect(store.activeRun?.state).toBe("cancelled");
      expect(store.isRunActive).toBe(false);
      expect(store.liveTurn).toBeNull();
      expect(store.cancelError).toBeNull();
    });

    it("clears stale prompt error when switching Bot or Topic after a failed prompt", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_A";
      store.activeConversationId = "conv_A";
      store.activeTopicId = "top_A";
      store.botsByInstance["inst_1"] = [
        { id: "bot_A", name: "Bot A", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];

      mockRpc.mockRejectedValueOnce(new Error("Network timeout"));
      await store.sendPrompt("Prompt on Bot A");
      expect(store.promptError).toBe("Network timeout");
      expect(store.lastPromptText).toBe("Prompt on Bot A");

      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversations.list") {
          return Promise.resolve({ conversations: [{ id: "conv_B", botId: "bot_B", defaultTopicId: "top_B" }] });
        }
        if (type === "control.topics.list") {
          return Promise.resolve({ topics: [{ id: "top_B", conversationId: "conv_B", title: "Topic B" }] });
        }
        if (type === "control.conversation.history") {
          return Promise.resolve({ conversationId: "conv_B", topicId: "top_B", messages: [], hasMoreBefore: false, hasMoreAfter: false });
        }
        return Promise.resolve({});
      });

      await store.selectBot("inst_1", "bot_B");
      expect(store.promptError).toBeNull();
      expect(store.lastPromptText).toBe("");
      expect(store.currentDraftRequestId).toBeNull();
    });

    it("clears cancel uncertainty when a retried cancel RPC succeeds with a terminal run", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
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
        createdAt: "now",
      };

      let cancelCalls = 0;
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.runs.cancel") {
          cancelCalls += 1;
          if (cancelCalls === 1) return Promise.reject(new Error("Network disconnect"));
          return Promise.resolve({
            ok: true,
            run: {
              id: "run_target",
              conversationId: "conv_1",
              topicId: "top_1",
              requestMessageId: "msg_1",
              requestId: "req_1",
              mode: "explicit",
              state: "cancelled",
              profileRevision: 1,
              createdAt: "now",
            },
          });
        }
        if (type === "control.runs.get") return Promise.reject(new Error("Network disconnect"));
        return Promise.resolve({});
      });

      await store.cancelCurrentRun();
      await flushPromises();
      expect(store.cancelError).toContain("Cancellation outcome unknown");
      expect(store.activeRun?.state).toBe("running");

      await store.cancelCurrentRun();
      expect(store.activeRun?.state).toBe("cancelled");
      expect(store.isRunActive).toBe(false);
      expect(store.cancelError).toBeNull();
      expect(store.liveTurn).toBeNull();
    });

    it("clears activeRun when switching Bot or Topic while a run is active", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_A";
      store.activeConversationId = "conv_A";
      store.activeTopicId = "top_A";
      store.activeRun = {
        id: "run_A",
        conversationId: "conv_A",
        topicId: "top_A",
        requestMessageId: "mA",
        requestId: "rA",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      store.liveTurn = { parts: [], status: "working", startedAt: Date.now() };

      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.conversations.list") {
          return Promise.resolve({ conversations: [{ id: "conv_B", botId: "bot_B", defaultTopicId: "top_B" }] });
        }
        if (type === "control.topics.list") {
          return Promise.resolve({ topics: [{ id: "top_B", conversationId: "conv_B", title: "Topic B" }] });
        }
        if (type === "control.conversation.history") {
          return Promise.resolve({ conversationId: "conv_B", topicId: "top_B", messages: [], hasMoreBefore: false, hasMoreAfter: false });
        }
        return Promise.resolve({});
      });

      await store.selectBot("inst_1", "bot_B");
      expect(store.activeRun).toBeNull();
      expect(store.activeMemberTurn).toBeNull();
      expect(store.liveTurn).toBeNull();
      expect(store.isRunActive).toBe(false);

      store.activeConversationId = "conv_B";
      store.activeTopicId = "top_A";
      store.activeRun = {
        id: "run_BA",
        conversationId: "conv_B",
        topicId: "top_A",
        requestMessageId: "mBA",
        requestId: "rBA",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "now",
      };
      await store.switchTopic("top_B");
      expect(store.activeRun).toBeNull();
      expect(store.isRunActive).toBe(false);
    });

    it("clears cancel uncertainty when authoritative WS terminal event arrives after runs.get failure", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.selectedBotId = "bot_1";
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
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.runs.cancel") return Promise.reject(new Error("Network disconnect"));
        if (type === "control.runs.get") return Promise.reject(new Error("Network disconnect"));
        return Promise.resolve({});
      });

      await store.cancelCurrentRun();
      await flushPromises();

      expect(store.activeRun?.state).toBe("running");
      expect(store.cancelError).toContain("Cancellation outcome unknown");
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: {
            id: "run_target",
            conversationId: "conv_1",
            topicId: "top_1",
            requestMessageId: "msg_1",
            requestId: "req_1",
            mode: "explicit",
            state: "cancelled",
            profileRevision: 1,
            createdAt: "2026-09-18T00:00:00.000Z",
          },
        } as never,
      });

      expect(store.activeRun?.state).toBe("cancelled");
      expect(store.isRunActive).toBe(false);
      expect(store.cancelError).toBeNull();
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
    it("clears cancellingRunId and does not leave it stuck when view switches during cancel", async () => {
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
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.runs.cancel") return cancelPromise;
        if (type === "control.conversations.list") {
          return Promise.resolve({ conversations: [{ id: "conv_2", botId: "bot_2", defaultTopicId: "top_2" }] });
        }
        if (type === "control.topics.list") {
          return Promise.resolve({ topics: [{ id: "top_2", conversationId: "conv_2", title: "Topic 2" }] });
        }
        return Promise.resolve({});
      });

      const cancelCall = store.cancelCurrentRun();
      expect(store.cancellingRunId).toBe("run_old");

      // User switches to Bot 2
      await store.selectBot("inst_1", "bot_2");
      // cancellingRunId is cleared on switch
      expect(store.cancellingRunId).toBeNull();

      // Old cancel resolves late
      resolveCancel({
        ok: true,
        run: { id: "run_old", conversationId: "conv_1", topicId: "top_1", state: "cancelled" },
      });
      await cancelCall;
      await flushPromises();

      // cancellingRunId must NOT get stuck on run_old!
      expect(store.cancellingRunId).toBeNull();
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

    it("restores correlated live turn and activeRun from state snapshot in directBotsStore", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";

      const runDetail: ConversationRunDetailDto = {
        id: "run_1",
        conversationId: "conv_1",
        topicId: "top_1",
        requestMessageId: "req_msg_1",
        requestId: "req_1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        memberTurns: [
          {
            id: "m_1",
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
        ],
      };
      mockRpc.mockImplementation((instId: string, type: string, payload: unknown) => {
        if (type === "control.runs.get") return Promise.resolve({ run: runDetail });
        if (type === "control.runs.cancel") return Promise.resolve({ ok: true, run: { ...runDetail, state: "cancelled" } });
        if (type === "control.conversation.history") return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", messages: [] });
        return Promise.resolve({});
      });

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

      // Synchronously, activeRun is immediately restored and isRunActive is true
      expect(store.liveTurn).toBeTruthy();
      expect(store.liveTurn?.parts).toEqual([{ type: "text", text: "recovered stream" }]);
      expect(store.liveTurn?.status).toBe("streaming");
      expect(store.activeRun?.id).toBe("run_1");
      expect(store.isRunActive).toBe(true);

      // Asynchronous runs.get resolves and populates member turns
      await flushPromises();
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.runs.get", { runId: "run_1" });
      expect(store.activeMemberTurn?.id).toBe("m_1");

      // Stop button calling cancelCurrentRun cancels the restored run
      await store.cancelCurrentRun();
      expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.runs.cancel", { runId: "run_1" });
      expect(store.activeRun?.state).toBe("cancelled");
      expect(store.isRunActive).toBe(false);
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
    it("does not regress completed Run state when stale runs.get active response arrives after terminal event", async () => {
      const store = useDirectBotsStore();
      store.instanceId = "inst_1";
      store.activeConversationId = "conv_1";
      store.activeTopicId = "top_1";
      store.activeRun = {
        id: "run_1",
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
      mockRpc.mockImplementation((instId: string, type: string) => {
        if (type === "control.runs.get") return runsGetPromise;
        if (type === "control.conversation.history") return Promise.resolve({ conversationId: "conv_1", topicId: "top_1", messages: [] });
        return Promise.resolve({});
      });

      // Snapshot triggers runs.get for run_1
      store.applyEvent({
        kind: "state-snapshot",
        instanceId: "inst_1",
        turns: [],
        usage: [],
        commands: [],
      });

      // While runs.get is in flight, WebSocket receives conversation-run-changed(completed)
      store.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-run-changed",
          run: {
            id: "run_1",
            conversationId: "conv_1",
            topicId: "top_1",
            requestMessageId: "m1",
            requestId: "r1",
            mode: "explicit",
            state: "completed",
            profileRevision: 1,
            createdAt: "now",
          },
        } as never,
      });

      expect(store.activeRun?.state).toBe("completed");
      expect(store.isRunActive).toBe(false);

      // Now the stale runs.get resolves returning "running"
      resolveRunsGet({
        run: {
          id: "run_1",
          conversationId: "conv_1",
          topicId: "top_1",
          requestMessageId: "m1",
          requestId: "r1",
          mode: "explicit",
          state: "running",
          profileRevision: 1,
          createdAt: "now",
          memberTurns: [],
        },
      });
      await runsGetPromise;
      await flushPromises();

      // The completed run MUST NOT be regressed back to running!
      expect(store.activeRun?.state).toBe("completed");
      expect(store.isRunActive).toBe(false);
      expect(store.liveTurn).toBeNull();
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
      // 4. loadHistory tail (exercises newest-first direction) plus durable
      // runs discovery: newest active run query returns no other Run, so the
      // stale completed detail below is the authority for run_1.
      mockRpc.mockResolvedValueOnce({
        conversationId: "conv_1",
        topicId: "top_1",
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      });
      mockRpc.mockResolvedValueOnce({
        conversationId: "conv_1",
        topicId: "top_1",
        runs: [],
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
      // 6. loadHistory tail to converge on completion, plus its runs discovery.
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
      mockRpc.mockResolvedValueOnce({
        conversationId: "conv_1",
        topicId: "top_1",
        runs: [],
      });

      await store.reconcileOnReconnect();

      expect(store.activeRun?.state).toBe("completed");
      expect(store.liveTurn).toBeNull();
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]?.content).toBe("Finished answer");
    });
  });
});
