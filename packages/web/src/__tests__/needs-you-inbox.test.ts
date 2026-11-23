// UX1 cross-instance "Needs you" inbox: the account-wide open-interaction view,
// its rendering and deep links, and the dashboard badge wiring.
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type {
  BotSummaryDto,
  GroupSummaryDto,
  InteractionRequestDto,
  WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
const mockApiGet = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload),
    get: (path: string) => mockApiGet(path),
  },
}));

// DashboardView opens a socket on mount; stub it so jsdom needs no server.
const disconnect = vi.fn();
const captured: { onEvent?: (e: unknown) => void; onStatus?: (online: boolean) => void } = {};
const { sendSubscribe } = vi.hoisted(() => ({ sendSubscribe: vi.fn() }));
vi.mock("../api/events", () => ({
  connectEvents: (onEvent: (e: unknown) => void, onStatus?: (online: boolean) => void) => {
    captured.onEvent = onEvent;
    captured.onStatus = onStatus;
    return disconnect;
  },
  subscribeWebEvents: () => () => {},
  sendSubscribe,
  isRetryableTerminalError: () => false,
  TerminalRequestError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { i18n } from "../i18n";
import NeedsYouInbox from "../components/NeedsYouInbox.vue";
import ConversationInteractionForm from "../components/ConversationInteractionForm.vue";
import DashboardView from "../views/DashboardView.vue";

const BOT_A: BotSummaryDto = {
  id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo",
  enabled: true, updatedAt: "now", profileRevision: 1,
};
const GROUP_G1: GroupSummaryDto = {
  id: "g1", kind: "group", title: "Release Team",
  botIds: ["bot_a"], leadBotId: "bot_a", createdAt: "now", updatedAt: "now",
};

function seedCatalogs(): void {
  useInstancesStore().instances = [
    {
      id: "inst_A", name: "alpha", online: true, lastSeenAt: null,
      sessions: [{ alias: "backend", agent: "codex", workspace: "repo", transportSession: "t-a", running: false, archived: false }],
      sessionsLoaded: true,
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "repo", cwd: "/repo" }],
      agentCatalog: [],
    },
    {
      id: "inst_B", name: "beta", online: true, lastSeenAt: null,
      sessions: [{ alias: "backend", agent: "codex", workspace: "repo", transportSession: "t-b", running: false, archived: false }],
      sessionsLoaded: true,
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "repo", cwd: "/repo" }],
      agentCatalog: [],
    },
  ] as never;
  useDirectBotsStore().botsByInstance = { inst_A: [BOT_A], inst_B: [] };
  useDirectBotsStore().conversationsByInstance = {
    inst_A: [{ id: "c9", kind: "bot", title: "Cached", botId: "bot_a", createdAt: "now", updatedAt: "now" }],
    inst_B: [],
  };
  useGroupsStore().groupsByInstance = { inst_A: [GROUP_G1], inst_B: [] };
}

function formRequest(requestId: string, overrides: Partial<InteractionRequestDto> = {}): InteractionRequestDto {
  return {
    requestId,
    kind: "elicitation",
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form",
      agent: { name: "codex" },
      message: "Which environment?",
      fields: [{ kind: "text", key: "note", title: "Note", required: false }],
    },
    conversation: { conversationId: "c1", topicId: "t1", botId: "bot_a" },
    ...overrides,
  };
}

function sessionRequest(requestId: string, alias: string): InteractionRequestDto {
  return formRequest(requestId, { conversation: undefined, sessionAlias: alias });
}

function openedEvent(request: InteractionRequestDto, instanceId: string, sessionAlias = ""): WebServerEvent {
  return {
    kind: "control-event",
    instanceId,
    event: {
      type: "interaction-opened",
      chatKey: "bot:c1:t1",
      sessionAlias,
      instanceId,
      interaction: request,
    },
  } as unknown as WebServerEvent;
}

function closedEvent(requestId: string, instanceId: string): WebServerEvent {
  return {
    kind: "control-event",
    instanceId,
    event: {
      type: "interaction-closed",
      chatKey: "bot:c1:t1",
      instanceId,
      requestId,
      reason: "resolved",
      action: "accept",
    },
  } as unknown as WebServerEvent;
}

function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  setActivePinia(createPinia());
  mockRpc.mockReset();
  mockApiGet.mockReset();
  mockApiGet.mockResolvedValue({ instances: [] });
  // Catalog preloads from the inbox hit the network only when the loaded flag
  // is unset; fail them so tests stay hermetic and fall back to seeded rows.
  mockRpc.mockRejectedValue(new Error("offline"));
  sendSubscribe.mockClear();
  setViewport(1024);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
});

describe("openInteractions view", () => {
  it("lists a session interaction on an unselected instance with its instance and alias", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(sessionRequest("req-session", "backend"), "inst_B", "backend"));
    expect(store.openInteractions).toHaveLength(1);
    expect(store.openInteractions[0]!.instanceId).toBe("inst_B");
    expect(store.openInteractions[0]!.sessionAlias).toBe("backend");
    expect(store.openInteractionCount).toBe(1);
  });

  it("orders by expiry, then by arrival", () => {
    const store = useDirectBotsStore();
    const now = Date.now();
    store.applyEvent(openedEvent(formRequest("req-slow", { expiresAt: now + 90_000 }), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-fast", { expiresAt: now + 10_000 }), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-mid", { expiresAt: now + 60_000 }), "inst_A"));
    expect(store.openInteractions.map((e) => e.request.requestId)).toEqual(["req-fast", "req-mid", "req-slow"]);
    // Equal deadlines keep arrival order (stable sort).
    store.applyEvent(openedEvent(formRequest("req-tie-a", { expiresAt: now + 30_000 }), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-tie-b", { expiresAt: now + 30_000 }), "inst_A"));
    const ids = store.openInteractions.map((e) => e.request.requestId);
    expect(ids.indexOf("req-tie-a")).toBeLessThan(ids.indexOf("req-tie-b"));
  });

  it("hides expired entries from the list and the count without retiring them", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    expect(store.openInteractionCount).toBe(1);
    store.inboxNowMs = Date.now() + 120_000;
    expect(store.openInteractions).toHaveLength(0);
    expect(store.openInteractionCount).toBe(0);
    // The store itself is untouched: expiry without a close/snapshot event is
    // hidden, not retired, by the view.
    expect(store.requestStillHeld("req-1")).toBe(true);
  });

  it("a duplicate open frame neither duplicates the row nor clears the draft", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    store.setInteractionAnswer("note", "draft text", store.openInteractions[0]!);
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    expect(store.openInteractions).toHaveLength(1);
    expect(store.openInteractionCount).toBe(1);
    expect(store.openInteractions[0]!.answers).toMatchObject({ note: "draft text" });
  });

  it("a close event removes the row and the count", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-2"), "inst_A"));
    store.applyEvent(closedEvent("req-1", "inst_A"));
    expect(store.openInteractions.map((e) => e.request.requestId)).toEqual(["req-2"]);
    expect(store.openInteractionCount).toBe(1);
  });

  it("a snapshot retires rows the hub no longer holds", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-2"), "inst_A"));
    store.applyEvent({
      kind: "interaction-snapshot",
      instanceId: "inst_A",
      interactions: [
        {
          chatKey: "bot:c1:t1",
          sessionAlias: "",
          interaction: formRequest("req-2"),
        },
      ],
    } as never);
    expect(store.openInteractions.map((e) => e.request.requestId)).toEqual(["req-2"]);
    expect(store.openInteractionCount).toBe(1);
    expect(store.terminalInteractionOutcome("req-1")).toBe("gone");
  });

  it("keeps cross-instance rows isolated when aliases collide", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(sessionRequest("req-a", "backend"), "inst_A", "backend"));
    store.applyEvent(openedEvent(sessionRequest("req-b", "backend"), "inst_B", "backend"));
    expect(store.openInteractionCount).toBe(2);
    const byId = new Map(store.openInteractions.map((e) => [e.request.requestId, e.instanceId]));
    expect(byId.get("req-a")).toBe("inst_A");
    expect(byId.get("req-b")).toBe("inst_B");
  });

  it("never lists terminal outcomes", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-2"), "inst_A"));
    store.applyEvent(closedEvent("req-1", "inst_A"));
    expect(store.terminalInteractionCount).toBe(1);
    expect(store.openInteractions.map((e) => e.request.requestId)).toEqual(["req-2"]);
  });
});

describe("NeedsYouInbox component", () => {
  it("empty state is one calm sentence", async () => {
    seedCatalogs();
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    expect(wrapper.find('[data-test="needs-you-popover"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test="needs-you-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="needs-you-empty"]').text()).toBe("Nothing needs you right now.");
  });

  it("renders every open interaction once with its instance and destination", async () => {
    seedCatalogs();
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(sessionRequest("req-session", "backend"), "inst_A", "backend"));
    store.applyEvent(openedEvent(formRequest("req-direct"), "inst_A"));
    store.applyEvent(openedEvent(
      formRequest("req-group", { conversation: { conversationId: "g1", topicId: "t9", botId: "bot_a" } }),
      "inst_A",
    ));
    // No botId on the wire: the cached Direct conversation row still resolves it.
    store.applyEvent(openedEvent(
      formRequest("req-cached", { conversation: { conversationId: "c9", topicId: "t9" } }),
      "inst_A",
    ));
    store.applyEvent(openedEvent(formRequest("req-nowhere", { conversation: undefined, sessionAlias: "" }), "inst_A"));
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    const rows = wrapper.findAll('[data-test="needs-you-row"]');
    expect(rows).toHaveLength(5);
    const text = wrapper.text();
    expect(text).toContain("alpha");
    expect(text).toContain("Session backend");
    expect(text).toContain("Bot Reviewer");
    expect(text).toContain("Group Release Team");
    expect(text).toContain("Answer here");
    expect(text).toContain("Which environment?");
    // One-line time left on every row.
    for (const row of rows) expect(row.text()).toMatch(/left/);
    // Only the placed entries offer an open button.
    expect(wrapper.findAll('[data-test="needs-you-open"]')).toHaveLength(4);
  });

  it("emits the entry's own instance when aliases collide", async () => {
    seedCatalogs();
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(sessionRequest("req-a", "backend"), "inst_A", "backend"));
    store.applyEvent(openedEvent(sessionRequest("req-b", "backend"), "inst_B", "backend"));
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    await wrapper.find('[data-request-id="req-b"] [data-test="needs-you-open"]').trigger("click");
    expect(wrapper.emitted("open-session")).toEqual([["inst_B", "backend"]]);
  });

  it("deep-links a direct entry to the named topic", async () => {
    seedCatalogs();
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-direct"), "inst_A"));
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    await wrapper.find('[data-request-id="req-direct"] [data-test="needs-you-open"]').trigger("click");
    expect(wrapper.emitted("open-bot")).toEqual([["inst_A", "bot_a", "c1", "t1"]]);
  });

  it("deep-links a group entry to the named group topic", async () => {
    seedCatalogs();
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(
      formRequest("req-group", { conversation: { conversationId: "g1", topicId: "t9", botId: "bot_a" } }),
      "inst_A",
    ));
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    await wrapper.find('[data-request-id="req-group"] [data-test="needs-you-open"]').trigger("click");
    expect(wrapper.emitted("open-group")).toEqual([["inst_A", "g1", "g1", "t9"]]);
  });

  it("answers from the inbox through the shared entry and drops the row on close", async () => {
    seedCatalogs();
    mockRpc.mockResolvedValue({});
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    const form = wrapper.findComponent(ConversationInteractionForm);
    expect(form.exists()).toBe(true);
    await form.vm.$emit("answer", "note", "from the inbox");
    expect(store.openInteractions[0]!.answers).toMatchObject({ note: "from the inbox" });
    await form.vm.$emit("submit");
    await flushPromises();
    expect(mockRpc).toHaveBeenCalledWith(
      "inst_A",
      "control.interaction.respond",
      expect.objectContaining({ requestId: "req-1" }),
    );
    store.applyEvent(closedEvent("req-1", "inst_A"));
    await flushPromises();
    expect(wrapper.findAll('[data-test="needs-you-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="needs-you-empty"]').exists()).toBe(true);
  });

  it("mobile 390px keeps the row and the form usable", async () => {
    setViewport(390);
    seedCatalogs();
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest("req-1", { expiresAt: Date.now() + 45_000 }), "inst_A"));
    const wrapper = mount(NeedsYouInbox);
    await flushPromises();
    expect(wrapper.find('[data-test="needs-you-sheet"]').exists()).toBe(true);
    const row = wrapper.find('[data-test="needs-you-row"]');
    expect(row.exists()).toBe(true);
    expect(row.classes().join(" ")).toContain("min-w-0");
    const question = row.findAll("p").at(-1)!;
    expect(question.classes().join(" ")).toContain("break-words");
    expect(wrapper.find('[data-test="interaction-form"]').exists()).toBe(true);
    expect(row.text()).toContain("45s left");
  });

  it("renders the zh-CN strings", async () => {
    seedCatalogs();
    try {
      i18n.global.locale.value = "zh-CN";
      const wrapper = mount(NeedsYouInbox);
      await flushPromises();
      expect(wrapper.find('[data-test="needs-you-empty"]').text()).toBe("暂无需要你处理的事情。");
    } finally {
      i18n.global.locale.value = "en";
    }
  });
});

describe("DashboardView inbox wiring", () => {
  function mountDashboard() {
    return mount(DashboardView, {
      global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } },
    });
  }

  it("shows the badge count, and no count affordance when empty", async () => {
    const wrapper = mountDashboard();
    await flushPromises();
    useInstancesStore().instances = [
      { id: "inst_A", name: "alpha", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
    ] as never;
    const store = useDirectBotsStore();
    expect(wrapper.find('[data-test="needs-you-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="needs-you-count"]').exists()).toBe(false);
    store.applyEvent(openedEvent(formRequest("req-1"), "inst_A"));
    store.applyEvent(openedEvent(formRequest("req-2"), "inst_A"));
    await flushPromises();
    expect(wrapper.find('[data-test="needs-you-count"]').text()).toBe("2");
    store.applyEvent(closedEvent("req-1", "inst_A"));
    store.applyEvent(closedEvent("req-2", "inst_A"));
    await flushPromises();
    expect(wrapper.find('[data-test="needs-you-count"]').exists()).toBe(false);
  });

  it("opens a session entry on its own instance", async () => {
    seedCatalogs();
    const wrapper = mountDashboard();
    await flushPromises();
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(sessionRequest("req-b", "backend"), "inst_B", "backend"));
    await flushPromises();
    await wrapper.find('[data-test="needs-you-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-request-id="req-b"] [data-test="needs-you-open"]').trigger("click");
    await flushPromises();
    // The collision entry routes to instance B, never to A.
    expect(useChatStore().instanceId).toBe("inst_B");
    expect(useChatStore().sessionAlias).toBe("backend");
  });

  it("opens a direct entry on the named topic, and never a mismatched conversation", async () => {
    seedCatalogs();
    const wrapper = mountDashboard();
    await flushPromises();
    const bots = useDirectBotsStore();
    bots.applyEvent(openedEvent(formRequest("req-direct"), "inst_A"));
    const selectSpy = vi.spyOn(bots, "selectBot").mockImplementation(async (iid: string, bid: string) => {
      bots.instanceId = iid;
      bots.selectedBotId = bid;
      bots.activeConversationId = "c1";
    });
    const switchSpy = vi.spyOn(bots, "switchTopic").mockResolvedValue(undefined);
    await flushPromises();
    await wrapper.find('[data-test="needs-you-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-request-id="req-direct"] [data-test="needs-you-open"]').trigger("click");
    await flushPromises();
    expect(selectSpy).toHaveBeenCalledWith("inst_A", "bot_a");
    expect(switchSpy).toHaveBeenCalledWith("t1");
  });

  it("refuses to steer a direct entry onto another conversation", async () => {
    seedCatalogs();
    const wrapper = mountDashboard();
    await flushPromises();
    const bots = useDirectBotsStore();
    bots.applyEvent(openedEvent(formRequest("req-direct"), "inst_A"));
    vi.spyOn(bots, "selectBot").mockImplementation(async (iid: string, bid: string) => {
      bots.instanceId = iid;
      bots.selectedBotId = bid;
      // Landed somewhere else (stale bot conversation): the interaction's
      // topic must not be forced onto it.
      bots.activeConversationId = "other-conversation";
    });
    const switchSpy = vi.spyOn(bots, "switchTopic").mockResolvedValue(undefined);
    await flushPromises();
    await wrapper.find('[data-test="needs-you-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-request-id="req-direct"] [data-test="needs-you-open"]').trigger("click");
    await flushPromises();
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it("opens a group entry on the named group topic", async () => {
    seedCatalogs();
    const wrapper = mountDashboard();
    await flushPromises();
    const bots = useDirectBotsStore();
    bots.applyEvent(openedEvent(
      formRequest("req-group", { conversation: { conversationId: "g1", topicId: "t9", botId: "bot_a" } }),
      "inst_A",
    ));
    const groups = useGroupsStore();
    const selectSpy = vi.spyOn(groups, "selectGroup").mockImplementation(async (iid: string, gid: string) => {
      groups.instanceId = iid;
      groups.selectedGroupId = gid;
      groups.activeConversationId = "g1";
      groups.activeTopicId = "other-topic";
    });
    const switchSpy = vi.spyOn(groups, "switchTopic").mockResolvedValue(undefined);
    await flushPromises();
    await wrapper.find('[data-test="needs-you-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-request-id="req-group"] [data-test="needs-you-open"]').trigger("click");
    await flushPromises();
    expect(selectSpy).toHaveBeenCalledWith("inst_A", "g1");
    expect(switchSpy).toHaveBeenCalledWith("t9");
  });
});
