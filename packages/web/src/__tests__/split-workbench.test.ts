import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  paneKeyFor,
  primaryKeyFor,
  useSplitLayoutStore,
  type SplitPaneTarget,
} from "../stores/split-layout";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import SplitWorkbench from "../components/SplitWorkbench.vue";
import ChatPane from "../components/ChatPane.vue";
import DirectBotPane from "../components/DirectBotPane.vue";
import MessageList from "../components/MessageList.vue";
import PromptInput from "../components/PromptInput.vue";
import DashboardView from "../views/DashboardView.vue";
import { api } from "../api/client";

// DashboardView drives on real browser APIs; copy the behavioral-suite harness:
// stub the WS client (capturing its callbacks), the router and the brand icons.
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
  isRetryableTerminalError: (code: string) =>
    code === "instance-offline" || code === "events-offline"
    || code === "terminal-timeout" || code === "instance-reconnected",
  TerminalRequestError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

const sessionTarget = (alias: string, instanceId = "i1"): SplitPaneTarget => ({
  kind: "session",
  instanceId,
  sessionAlias: alias,
});
const botTarget = (botId: string, instanceId = "i1"): SplitPaneTarget => ({
  kind: "bot",
  instanceId,
  botId,
});

function seedInstance(extraSessions: string[] = ["a1", "a2"]): void {
  const instances = useInstancesStore();
  instances.instances = [
    {
      id: "i1",
      name: "pc",
      online: true,
      lastSeenAt: null,
      sessions: extraSessions.map((alias) => ({ alias, agent: "codex", workspace: "w" })),
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "w", cwd: "/w" }],
      agentCatalog: [],
    } as never,
  ];
  const directBots = useDirectBotsStore();
  directBots.botsByInstance["i1"] = [
    { id: "b1", name: "Bee", agent: "codex", workspace: "w", enabled: true, updatedAt: "now" },
  ];
  directBots.botsLoaded["i1"] = true;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
  captured.onEvent = undefined;
  captured.onStatus = undefined;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("1024"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("split workbench store flows", () => {
  it("auto-open on a dispatched session appends a bot-dispatch column and focuses it", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(botTarget("b1"));
    store.ensureLayout(primary);
    const opened = store.autoOpenDispatchedSession(primary, "i1", "s9");
    expect(opened).not.toBeNull();
    expect(opened!.source).toBe("bot-dispatch");
    const layout = store.layoutFor(primary);
    expect(layout.columns).toHaveLength(2);
    expect(layout.focusedColumnId).toBe(opened!.id);
  });

  it("auto-open at the 4-column cap refuses without touching the layout", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(botTarget("b1"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("a"));
    store.addColumn(primary, sessionTarget("b"));
    store.addColumn(primary, sessionTarget("c"));
    expect(store.layoutFor(primary).columns).toHaveLength(4);
    expect(store.autoOpenDispatchedSession(primary, "i1", "s9")).toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(4);
  });

  it("dismissed sessions do not reopen until manually reopened", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(botTarget("b1"));
    store.ensureLayout(primary);
    const opened = store.autoOpenDispatchedSession(primary, "i1", "s9")!;
    store.removeColumn(primary, opened.id, { dismiss: true });
    expect(store.layoutFor(primary).dismissedSessionKeys).toContain("session::i1::s9");
    // Dismissed: no reopen.
    expect(store.autoOpenDispatchedSession(primary, "i1", "s9")).toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(1);
    // Manual reopen un-dismisses, re-adds and focuses.
    const reopened = store.reopenDispatchedSession(primary, "i1", "s9")!;
    expect(store.layoutFor(primary).dismissedSessionKeys).toHaveLength(0);
    expect(store.layoutFor(primary).columns).toHaveLength(2);
    expect(store.layoutFor(primary).focusedColumnId).toBe(reopened.id);
    // Reopen focuses the already-open column instead of duplicating it.
    const again = store.reopenDispatchedSession(primary, "i1", "s9")!;
    expect(again.id).toBe(reopened.id);
    expect(store.layoutFor(primary).columns).toHaveLength(2);
  });

  it("promoteToPrimary moves the columns under the new key", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a1"));
    store.ensureLayout(primary);
    const second = store.addColumn(primary, sessionTarget("a2"), "manual")!;
    const next = store.promoteToPrimary(primary, second.id);
    expect(next).toBe(primaryKeyFor(sessionTarget("a2")));
    expect(store.layoutsByPrimary[primary]).toBeUndefined();
    const moved = store.layoutFor(next);
    expect(moved.columns[0]!.id).toBe(second.id);
    expect(moved.focusedColumnId).toBe(second.id);
  });

  it("resizeAdjacentColumns shifts the pair fraction and clamps the minimum", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a1"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("a2"));
    store.resizeAdjacentColumns(primary, 0, 0.1);
    let columns = store.layoutFor(primary).columns;
    expect(columns[0]!.widthFraction).toBeCloseTo(0.6);
    expect(columns[1]!.widthFraction).toBeCloseTo(0.4);
    store.resizeAdjacentColumns(primary, 0, -10);
    columns = store.layoutFor(primary).columns;
    expect(columns[0]!.widthFraction).toBeCloseTo(0.05);
    expect(columns[1]!.widthFraction).toBeCloseTo(0.95);
  });

  it("paneKeyFor covers bot topics while primaryKeyFor stays per bot", () => {
    expect(primaryKeyFor({ kind: "bot", instanceId: "i1", botId: "b1", topicId: "t1" })).toBe("bot::i1::b1");
    expect(paneKeyFor({ kind: "bot", instanceId: "i1", botId: "b1", topicId: "t1" })).toBe("bot::i1::b1#t1");
  });
});

describe("SplitWorkbench.vue", () => {
  function mountWorkbench(primary: SplitPaneTarget = sessionTarget("a1")) {
    return mount(SplitWorkbench, {
      props: { primary },
      global: { stubs: { ChatPane: true, DirectBotPane: true } },
    });
  }

  it("renders the primary session column with explicit target props", async () => {
    seedInstance();
    const wrapper = mountWorkbench();
    await flushPromises();
    const columns = wrapper.findAll('[data-test="split-column"]');
    expect(columns).toHaveLength(1);
    const chatPane = wrapper.findComponent({ name: "ChatPane" });
    expect(chatPane.exists()).toBe(true);
    expect(chatPane.props("instanceId")).toBe("i1");
    expect(chatPane.props("sessionAlias")).toBe("a1");
    expect(chatPane.props("paneMode")).toBe("split");
  });

  it("the picker adds a session column and close dismisses it", async () => {
    seedInstance();
    const wrapper = mountWorkbench();
    await flushPromises();
    await wrapper.find('[data-test="split-add"]').trigger("click");
    expect(wrapper.find('[data-test="split-picker"]').exists()).toBe(true);
    // The open session is excluded from the picker; the other one is listed.
    expect(wrapper.findAll('[data-test="split-pick-session"]')).toHaveLength(1);
    await wrapper.find('[data-test="split-pick-session"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-test="split-column"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="split-picker"]').exists()).toBe(false);
    const store = useSplitLayoutStore();
    expect(store.layoutFor(primaryKeyFor(sessionTarget("a1"))).columns).toHaveLength(2);
    // Closing the non-primary column removes it and records the dismissal.
    await wrapper.find('[data-test="split-close"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-test="split-column"]')).toHaveLength(1);
    expect(store.layoutFor(primaryKeyFor(sessionTarget("a1"))).dismissedSessionKeys)
      .toContain("session::i1::a2");
  });

  it("the picker lists enabled bots and opens a bot column", async () => {
    seedInstance();
    const wrapper = mountWorkbench();
    await flushPromises();
    await wrapper.find('[data-test="split-add"]').trigger("click");
    expect(wrapper.findAll('[data-test="split-pick-bot"]')).toHaveLength(1);
    await wrapper.find('[data-test="split-pick-bot"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-test="split-column"]')).toHaveLength(2);
    const botPane = wrapper.findComponent({ name: "DirectBotPane" });
    expect(botPane.exists()).toBe(true);
    expect(botPane.props("instanceId")).toBe("i1");
    expect(botPane.props("botId")).toBe("b1");
  });

  it("a fifth column is refused at the 4-column cap", async () => {
    seedInstance(["a1", "a2", "a3", "a4", "a5"]);
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a1"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("a2"), "manual");
    store.addColumn(primary, sessionTarget("a3"), "manual");
    store.addColumn(primary, sessionTarget("a4"), "manual");
    const wrapper = mountWorkbench();
    await flushPromises();
    expect(wrapper.findAll('[data-test="split-column"]')).toHaveLength(4);
    await wrapper.find('[data-test="split-add"]').trigger("click");
    await wrapper.find('[data-test="split-pick-session"]').trigger("click");
    await flushPromises();
    expect(store.layoutFor(primary).columns).toHaveLength(4);
    // The failed pick keeps the picker open instead of silently swallowing it.
    expect(wrapper.find('[data-test="split-picker"]').exists()).toBe(true);
  });

  it("divider dblclick equalizes uneven columns", async () => {
    seedInstance();
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a1"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("a2"), "manual");
    store.resizeAdjacentColumns(primary, 0, 0.3);
    const wrapper = mountWorkbench();
    await flushPromises();
    let columns = store.layoutFor(primary).columns;
    expect(columns[0]!.widthFraction).toBeCloseTo(0.8);
    await wrapper.find('[data-test="split-divider"]').trigger("dblclick");
    columns = store.layoutFor(primary).columns;
    expect(columns[0]!.widthFraction).toBeCloseTo(0.5);
    expect(columns[1]!.widthFraction).toBeCloseTo(0.5);
  });

  it("divider drag resizes adjacent columns by pointer delta over width", async () => {
    seedInstance();
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a1"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("a2"), "manual");
    const wrapper = mountWorkbench();
    await flushPromises();
    const container = wrapper.find('[data-test="split-workbench"]');
    Object.defineProperty(container.element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0 }),
    });
    const divider = wrapper.find('[data-test="split-divider"]');
    await divider.trigger("pointerdown", { pointerId: 7, clientX: 500 });
    await divider.trigger("pointermove", { pointerId: 7, clientX: 600 });
    const columns = store.layoutFor(primary).columns;
    expect(columns[0]!.widthFraction).toBeCloseTo(0.6);
    expect(columns[1]!.widthFraction).toBeCloseTo(0.4);
  });

  it("set-as-primary emits the column target for the parent to select", async () => {
    seedInstance();
    const wrapper = mountWorkbench();
    await flushPromises();
    await wrapper.find('[data-test="split-add"]').trigger("click");
    await wrapper.find('[data-test="split-pick-session"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="split-promote"]').trigger("click");
    const emitted = wrapper.emitted("promote");
    expect(emitted).toBeTruthy();
    expect(emitted![0]![0]).toEqual(sessionTarget("a2"));
  });
});

describe("ChatPane split props", () => {
  function seedChatSession(): void {
    const instances = useInstancesStore();
    instances.instances.push({
      id: "i1", name: "pc", online: true, lastSeenAt: null,
      sessions: [{ alias: "backend", agent: "codex", workspace: "gaia" }],
      agents: [], workspaces: [], agentCatalog: [],
    } as never);
  }

  it("renders scoped messages without a global selection and passes pane keys down", async () => {
    seedChatSession();
    const chat = useChatStore();
    chat.getSessionState("i1", "backend").messages = [
      { instanceId: "i1", sessionAlias: "backend", direction: "out", text: "scoped hello", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const ensureSpy = vi.spyOn(chat, "ensureSessionLoaded").mockResolvedValue(undefined);
    const wrapper = mount(ChatPane, { props: { instanceId: "i1", sessionAlias: "backend", paneMode: "split" } });
    await flushPromises();
    expect(chat.instanceId).toBeNull();
    expect(ensureSpy).toHaveBeenCalledWith("i1", "backend");
    const list = wrapper.findComponent(MessageList);
    expect(list.exists()).toBe(true);
    expect(list.props("messages")).toHaveLength(1);
    expect(list.props("sessionKey")).toBe("i1\0backend");
    expect(list.props("scrollPaneKey")).toBe(paneKeyFor(sessionTarget("backend")));
  });

  it("send in scoped mode delegates to sendPromptFor for that session", async () => {
    seedChatSession();
    const chat = useChatStore();
    vi.spyOn(chat, "ensureSessionLoaded").mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(chat, "sendPromptFor").mockResolvedValue(undefined);
    const wrapper = mount(ChatPane, { props: { instanceId: "i1", sessionAlias: "backend", paneMode: "split" } });
    await flushPromises();
    await wrapper.findComponent(PromptInput).vm.$emit("send", "hello");
    expect(sendSpy).toHaveBeenCalledWith("i1", "backend", "hello", [], undefined);
  });
});

describe("DirectBotPane dispatched sessions", () => {
  function seedBotConversation(): void {
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1", name: "Local", online: true, lastSeenAt: null, sessions: [],
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
        agentCatalog: [],
        capabilities: ["conversations.timeline.v1"],
      } as never,
    ];
    const directBots = useDirectBotsStore();
    directBots.instanceId = "i1";
    directBots.selectedBotId = "b1";
    directBots.activeConversationId = "c1";
    directBots.activeTopicId = "t1";
    directBots.botsByInstance["i1"] = [
      { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
    ];
    directBots.topicsByConversation["i1:c1"] = [
      { id: "t1", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" },
    ];
    directBots.messages = [
      {
        id: "m1", conversationId: "c1", topicId: "t1", seq: 1, role: "system",
        content: "dispatched", createdAt: "2026-01-01T00:00:00.000Z",
        dispatchedSession: { sessionAlias: "s9", agent: "codex", workspace: "w" },
      } as never,
    ];
  }

  it("shows the dispatched menu and opens the session in a split column", async () => {
    seedBotConversation();
    vi.spyOn(api, "rpc").mockRejectedValue(new Error("offline"));
    const instances = useInstancesStore();
    vi.spyOn(instances, "loadSessions").mockResolvedValue(undefined);
    const wrapper = mount(DirectBotPane);
    await flushPromises();
    const button = wrapper.find('[data-test="dispatched-menu-button"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("1");
    await button.trigger("click");
    expect(wrapper.find('[data-test="dispatched-menu"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="dispatched-row"]').text()).toContain("s9");
    await wrapper.find('[data-test="dispatched-open"]').trigger("click");
    await flushPromises();
    const store = useSplitLayoutStore();
    const layout = store.layoutFor(primaryKeyFor(botTarget("b1")));
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[1]!.target).toEqual(sessionTarget("s9"));
    expect(instances.loadSessions).toHaveBeenCalledWith("i1");
  });

  it("focuses the already-open column instead of duplicating it", async () => {
    seedBotConversation();
    vi.spyOn(api, "rpc").mockRejectedValue(new Error("offline"));
    const instances = useInstancesStore();
    vi.spyOn(instances, "loadSessions").mockResolvedValue(undefined);
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(botTarget("b1"));
    store.ensureLayout(primary);
    const opened = store.reopenDispatchedSession(primary, "i1", "s9")!;
    store.focusColumn(primary, store.layoutFor(primary).columns[0]!.id);
    const wrapper = mount(DirectBotPane);
    await flushPromises();
    await wrapper.find('[data-test="dispatched-menu-button"]').trigger("click");
    expect(wrapper.find('[data-test="dispatched-focus"]').exists()).toBe(true);
    await wrapper.find('[data-test="dispatched-focus"]').trigger("click");
    expect(store.layoutFor(primary).columns).toHaveLength(2);
    expect(store.layoutFor(primary).focusedColumnId).toBe(opened.id);
  });

  it("hides the menu when the pane is a background split column", async () => {
    seedBotConversation();
    vi.spyOn(api, "rpc").mockRejectedValue(new Error("offline"));
    const wrapper = mount(DirectBotPane, { props: { instanceId: "i1", botId: "other", paneMode: "split" } });
    await flushPromises();
    expect(wrapper.find('[data-test="bot-background-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="dispatched-menu-button"]').exists()).toBe(false);
  });
});

describe("DashboardView split workbench wiring", () => {
  function seedBotSelection(): void {
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [],
        agents: [], workspaces: [], agentCatalog: [],
      } as never,
    ];
    const directBots = useDirectBotsStore();
    directBots.instanceId = "i1";
    directBots.selectedBotId = "b1";
    directBots.activeConversationId = "c1";
    directBots.activeTopicId = "t1";
  }

  function dispatchedEvent(topicId: string, alias: string): unknown {
    return {
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "conversation-message",
        message: {
          id: "m9", conversationId: "c1", topicId, seq: 9, role: "system",
          content: "dispatched", createdAt: "2026-01-01T00:00:00.000Z",
          dispatchedSession: { sessionAlias: alias, agent: "codex", workspace: "w" },
        },
      },
    };
  }

  it("renders the workbench on desktop and auto-opens dispatched sessions", async () => {
    seedBotSelection();
    const instances = useInstancesStore();
    const loadSpy = vi.spyOn(instances, "loadSessions").mockResolvedValue(undefined);
    const wrapper = mount(DashboardView, {
      global: { stubs: { ChatPane: true, InstanceTree: true, SplitWorkbench: true, "router-link": true } },
    });
    await flushPromises();
    const workbench = wrapper.findComponent({ name: "SplitWorkbench" });
    expect(workbench.exists()).toBe(true);
    expect(workbench.props("primary")).toEqual(botTarget("b1"));
    // The legacy single panes step aside while the workbench owns the column.
    expect(wrapper.findComponent(DirectBotPane).exists()).toBe(false);

    captured.onEvent!(dispatchedEvent("t1", "s9"));
    await flushPromises();
    const store = useSplitLayoutStore();
    const layout = store.layoutFor(primaryKeyFor(botTarget("b1")));
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[1]!.target).toEqual(sessionTarget("s9"));
    expect(loadSpy).toHaveBeenCalledWith("i1");
  });

  it("ignores dispatched sessions from a topic that is not visible", async () => {
    seedBotSelection();
    const instances = useInstancesStore();
    vi.spyOn(instances, "loadSessions").mockResolvedValue(undefined);
    mount(DashboardView, {
      global: { stubs: { ChatPane: true, InstanceTree: true, SplitWorkbench: true, "router-link": true } },
    });
    await flushPromises();
    captured.onEvent!(dispatchedEvent("other-topic", "s9"));
    await flushPromises();
    expect(useSplitLayoutStore().layoutFor(primaryKeyFor(botTarget("b1"))).columns).toHaveLength(1);
  });

  it("promoting a split column selects it as the new primary", async () => {
    seedInstance(["a1", "s9"]);
    const directBots = useDirectBotsStore();
    directBots.instanceId = "i1";
    directBots.selectedBotId = "b1";
    directBots.activeConversationId = "c1";
    directBots.activeTopicId = "t1";
    const instances = useInstancesStore();
    vi.spyOn(instances, "loadSessions").mockResolvedValue(undefined);
    const wrapper = mount(DashboardView, {
      global: { stubs: { ChatPane: true, InstanceTree: true, SplitWorkbench: true, "router-link": true } },
    });
    await flushPromises();
    // Start on the bot primary, then promote a dispatched session column.
    const store = useSplitLayoutStore();
    const botPrimary = primaryKeyFor(botTarget("b1"));
    store.ensureLayout(botPrimary);
    store.addColumn(botPrimary, sessionTarget("s9"), "bot-dispatch");
    const workbench = wrapper.findComponent({ name: "SplitWorkbench" });
    expect(workbench.exists()).toBe(true);
    workbench.vm.$emit("promote", sessionTarget("s9"));
    await flushPromises();
    const chat = useChatStore();
    expect(chat.instanceId).toBe("i1");
    expect(chat.sessionAlias).toBe("s9");
    expect(workbench.props("primary")).toEqual(sessionTarget("s9"));
  });
});
