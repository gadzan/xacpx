import { setActivePinia, createPinia } from "pinia";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Stub the WS client so jsdom needs no real socket.
const disconnect = vi.fn();
vi.mock("../api/events", () => ({
  connectEvents: () => disconnect,
  sendSubscribe: vi.fn(),
  sendWebClientMessage: vi.fn(),
  isRetryableTerminalError: () => false,
  TerminalRequestError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// InstanceTree -> AgentIcon at module evaluation time; stub the raw SVG catalog so this
// behavioral suite does not depend on the host being able to open every icon file.
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import DashboardView from "../views/DashboardView.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { i18n } from "../i18n";

const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, TerminalTab: true, "router-link": true };

function stubDesktopMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  localStorage.clear();
  stubDesktopMatchMedia();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
});
afterEach(() => { i18n.global.locale.value = "en"; });

const session = (alias: string) => ({
  alias, agent: "codex", workspace: "/w", transportSession: `t-${alias}`, running: false, archived: false,
});

function seedInstances(perInstance: Record<string, number> = { i1: 2, i2: 1 }, onlineIds: string[] = ["i1", "i2"]): void {
  const store = useInstancesStore();
  store.instances = [
    { id: "i1", name: "pc", online: onlineIds.includes("i1"), lastSeenAt: null, sessionsLoaded: true, agents: [{ name: "codex", driver: "codex" }], workspaces: [], agentCatalog: [],
      sessions: Array.from({ length: perInstance.i1 ?? 0 }, (_, n) => session(`backend${n}`)) },
    { id: "i2", name: "lab", online: onlineIds.includes("i2"), lastSeenAt: null, sessionsLoaded: true, agents: [{ name: "codex", driver: "codex" }], workspaces: [], agentCatalog: [],
      sessions: Array.from({ length: perInstance.i2 ?? 0 }, (_, n) => session(`spike${n}`)) },
    { id: "i3", name: "off", online: false, lastSeenAt: null, sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
      sessions: [session("ghost")] },
  ] as never;
}

function mountDesktop(extraStubs: Record<string, unknown> = {}) {
  return mount(DashboardView, { global: { stubs: { ...stubs, ...extraStubs } } });
}

test("desktop with nothing selected shows the empty state, hides the right column, and lists recent sessions", async () => {
  const w = mountDesktop();
  await flushPromises();
  seedInstances();
  await flushPromises();

  expect(w.find('[data-test="empty-session-state"]').exists()).toBe(true);
  expect(w.find('[data-test="empty-state-title"]').text()).toBe("Continue where you left off");
  expect(w.findAll('[data-test="recent-session-name"]').map((r) => r.text())).toEqual(["backend0", "backend1", "spike0"]);
  expect(w.findAll('[data-test="recent-session-instance"]').map((r) => r.text())).toEqual(["pc", "pc", "lab"]);
  expect(w.find('[data-drawer="right"]').exists()).toBe(false);
});

test("the persisted last-opened session leads the recent list", async () => {
  localStorage.setItem("xrelay.selectedSession", JSON.stringify({ instanceId: "i2", alias: "spike0" }));
  const w = mountDesktop();
  await flushPromises();
  seedInstances();
  await flushPromises();
  expect(w.findAll('[data-test="recent-session-name"]').map((r) => r.text())).toEqual(["spike0", "backend0", "backend1"]);
});

test("the recent list caps at five sessions", async () => {
  const w = mountDesktop();
  await flushPromises();
  seedInstances({ i1: 7, i2: 0 });
  await flushPromises();
  expect(w.findAll('[data-test="recent-session-name"]')).toHaveLength(5);
});

test("localizes the empty-state title in zh-CN", async () => {
  i18n.global.locale.value = "zh-CN";
  const w = mountDesktop();
  await flushPromises();
  seedInstances();
  await flushPromises();
  expect(w.find('[data-test="empty-state-title"]').text()).toBe("继续上次的工作");
});

test("tapping a recent row selects that session and brings the right column back", async () => {
  const chat = useChatStore();
  const loadHistory = vi.spyOn(chat, "loadHistory").mockResolvedValue();
  const w = mountDesktop();
  await flushPromises();
  seedInstances();
  await flushPromises();

  await w.findAll('[data-test="recent-session"]')[1]!.trigger("click");
  await flushPromises();
  expect(chat.instanceId).toBe("i1");
  expect(chat.sessionAlias).toBe("backend1");
  expect(loadHistory).toHaveBeenCalled();
  expect(w.find('[data-test="empty-session-state"]').exists()).toBe(false);
  expect(w.find('[data-drawer="right"]').exists()).toBe(true);
});

test("the right column returns to the persisted collapsed state after a session opens", async () => {
  localStorage.setItem("xacpx.rightCollapsed", "1");
  const w = mountDesktop();
  await flushPromises();
  seedInstances();
  await flushPromises();
  expect(w.find('[data-drawer="right"]').exists()).toBe(false);

  await w.find('[data-test="recent-session"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-drawer="right"]').exists()).toBe(false);
  expect(w.find('[data-test="expand-right"]').exists()).toBe(true);

  await w.find('[data-test="expand-right"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-drawer="right"]').exists()).toBe(true);
  expect(localStorage.getItem("xacpx.rightCollapsed")).toBe("0");
});

test("the right column close button collapses the desktop column and the edge handle restores it", async () => {
  const chat = useChatStore();
  vi.spyOn(chat, "loadHistory").mockResolvedValue();
  const w = mountDesktop();
  await flushPromises();
  seedInstances();
  await flushPromises();
  await w.find('[data-test="recent-session"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-drawer="right"]').exists()).toBe(true);

  await w.find('[data-test="close-tasks"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-drawer="right"]').exists()).toBe(false);
  expect(localStorage.getItem("xacpx.rightCollapsed")).toBe("1");
  expect(w.find('[data-test="expand-right"]').exists()).toBe(true);

  await w.find('[data-test="expand-right"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-drawer="right"]').exists()).toBe(true);
});

test("the new-session button with one online instance opens that instance's create dialog", async () => {
  const nsStub = { name: "NewSessionDialog", props: ["instanceId"], template: '<div data-test="ns-stub">{{ instanceId }}</div>' };
  const w = mountDesktop({ NewSessionDialog: nsStub });
  await flushPromises();
  seedInstances({ i1: 1, i2: 0 }, ["i1"]);
  await flushPromises();

  await w.find('[data-test="empty-new-session"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-test="empty-instance-option"]').exists()).toBe(false);
  expect(w.find('[data-test="ns-stub"]').text()).toBe("i1");
});

test("the new-session button with several online instances opens the inline instance picker", async () => {
  const nsStub = { name: "NewSessionDialog", props: ["instanceId"], template: '<div data-test="ns-stub">{{ instanceId }}</div>' };
  const w = mountDesktop({ NewSessionDialog: nsStub });
  await flushPromises();
  seedInstances();
  await flushPromises();

  await w.find('[data-test="empty-new-session"]').trigger("click");
  await flushPromises();
  const options = w.findAll('[data-test="empty-instance-option"]');
  expect(options.map((o) => o.text())).toEqual(["pc", "lab"]);

  await options[1]!.trigger("click");
  await flushPromises();
  expect(w.find('[data-test="empty-instance-option"]').exists()).toBe(false);
  expect(w.find('[data-test="ns-stub"]').text()).toBe("i2");
});

test("the new-session button is disabled with no online instance", async () => {
  const w = mountDesktop();
  await flushPromises();
  seedInstances({ i1: 0, i2: 0 }, []);
  await flushPromises();
  expect(w.find('[data-test="empty-new-session"]').attributes("disabled")).toBeDefined();
  expect(w.find('[data-test="recent-session"]').exists()).toBe(false);
});

describe("mobile", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {},
    }));
  });

  test("with no session the right column still renders as the off-canvas drawer", async () => {
    const w = mountDesktop();
    await flushPromises();
    seedInstances();
    await flushPromises();
    const right = w.find('[data-drawer="right"]');
    expect(right.exists()).toBe(true);
    expect(right.classes()).toContain("translate-x-full");
  });
});
