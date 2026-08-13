// packages/relay-web/src/__tests__/dashboard-center-tabs.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Stub the WS client so jsdom needs no real socket.
vi.mock("../api/events", () => ({
  connectEvents: () => vi.fn(),
  sendWebClientMessage: vi.fn(),
  sendSubscribe: vi.fn(),
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
// DashboardView uses useRouter()/<router-link>; mock to avoid a real router.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import DashboardView from "../views/DashboardView.vue";
import TerminalTab from "../components/TerminalTab.vue";
import FileViewer from "../components/FileViewer.vue";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useInstancesStore, type InstanceView } from "../stores/instances";
import { useTerminalStore, terminalLocalKey } from "../stores/terminal";
import { initialRecoveryState } from "../lib/terminal-recovery";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

const stubs = {
  ChatPane: { template: '<div data-test="stub-chat"/>' },
  FileViewer: { template: '<div data-test="stub-file"/>' },
  TerminalTab: { template: '<div data-test="stub-term"/>' },
  CenterTabStrip: { template: '<div data-test="stub-strip"/>' },
  InstanceTree: true,
  TaskPanel: true,
  FilesPanel: true,
  "router-link": true,
};

beforeEach(() => {
  setActivePinia(createPinia());
  // center-tabs now persists to sessionStorage (task 2); clear it too so tabs opened in one
  // test don't leak into the next test's store via hydrate().
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
});

function mountDash() {
  return mount(DashboardView, { global: { stubs } });
}

function selectSession(): string {
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  return sessionKey("i1", "demo");
}

test("with a selected session, chat shows and no file/terminal panes are mounted", async () => {
  const wrapper = mountDash();
  await flushPromises();
  selectSession();
  await flushPromises();

  expect(wrapper.find('[data-test="stub-chat"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="stub-file"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="stub-term"]').exists()).toBe(false);
  // The tab strip only renders once a session is selected.
  expect(wrapper.find('[data-test="stub-strip"]').exists()).toBe(true);
});

test("opening a file via center-tabs mounts a FileViewer pane", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const key = selectSession();
  await flushPromises();

  const centerTabs = useCenterTabsStore();
  centerTabs.openFile(key, "a.ts");
  await flushPromises();

  const file = wrapper.find('[data-test="stub-file"]');
  expect(file.exists()).toBe(true);
  // Visible (v-show), not display:none, since it's the active tab for the current session.
  expect(file.attributes("style") ?? "").not.toContain("display: none");
  // Chat pane is still mounted underneath but hidden.
  const chat = wrapper.find('[data-test="stub-chat"]');
  expect(chat.exists()).toBe(true);
  expect(chat.attributes("style") ?? "").toContain("display: none");
});

test("opening a terminal via center-tabs mounts a TerminalTab pane", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const key = selectSession();
  await flushPromises();

  const centerTabs = useCenterTabsStore();
  centerTabs.openTerminal(key);
  await flushPromises();

  const term = wrapper.find('[data-test="stub-term"]');
  expect(term.exists()).toBe(true);
  expect(term.attributes("style") ?? "").not.toContain("display: none");
});

test("the header terminal button opens/focuses the current session's terminal tab", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    instances: [{
      id: "i1",
      name: "pc",
      online: true,
      lastSeenAt: null,
      capabilities: [RELAY_CAPABILITIES.terminalRmuxRecoveryV1, RELAY_CAPABILITIES.terminalMultiViewV1],
    }],
  }), { status: 200 })));
  const wrapper = mountDash();
  await flushPromises();
  const key = selectSession();
  await flushPromises();

  const btn = wrapper.find('[data-test="toggle-terminal"]');
  expect(btn.attributes("disabled")).toBeUndefined();

  const centerTabs = useCenterTabsStore();
  const spy = vi.spyOn(centerTabs, "openTerminal");

  await btn.trigger("click");
  await flushPromises();

  expect(spy).toHaveBeenCalledWith(key);
  expect(wrapper.find('[data-test="stub-term"]').exists()).toBe(true);
});

test("hidden panes for a non-current session don't error (workspace resolution)", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const key = selectSession();
  await flushPromises();

  const centerTabs = useCenterTabsStore();
  // Open a file tab in a DIFFERENT (unresolvable) session — not the current one.
  const otherKey = sessionKey("i2", "other");
  centerTabs.openFile(otherKey, "b.ts");
  await flushPromises();

  // It mounts (allOpenTabs spans all sessions) but stays hidden since it isn't current.
  const files = wrapper.findAll('[data-test="stub-file"]');
  expect(files.length).toBe(1);
  expect(files[0].attributes("style") ?? "").toContain("display: none");
  // The current session's chat is unaffected.
  expect(wrapper.find('[data-test="stub-chat"]').attributes("style") ?? "").not.toContain("display: none");
  void key; // currentKey unaffected by the other session's tab
});

function makeInstance(overrides: Partial<InstanceView> & { id: string }): InstanceView {
  return {
    name: overrides.id, online: true, lastSeenAt: null,
    sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
    ...overrides,
  };
}

test("out-of-band session removal prunes that session's center-tabs, but leaves other sessions and still-loading instances alone", async () => {
  const wrapper = mountDash();
  await flushPromises();

  const instances = useInstancesStore();
  instances.instances = [
    makeInstance({ id: "i1", sessions: [{ alias: "demo", agent: "a", workspace: "w", transportSession: "t", running: true, archived: false }] }),
    makeInstance({ id: "i2", sessions: [{ alias: "keep", agent: "a", workspace: "w", transportSession: "t", running: true, archived: false }] }),
    // Sessions never fetched for this instance — a key referencing it must never be pruned
    // just because it isn't (yet) in an empty `sessions` list.
    makeInstance({ id: "i3", sessions: [], sessionsLoaded: false }),
  ];
  await flushPromises();

  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  const goneKey = sessionKey("i1", "demo");
  const keepKey = sessionKey("i2", "keep");
  const loadingKey = sessionKey("i3", "ghost");

  const centerTabs = useCenterTabsStore();
  centerTabs.openFile(goneKey, "a.ts");
  centerTabs.openTerminal(goneKey);
  centerTabs.openFile(keepKey, "b.ts");
  centerTabs.openFile(loadingKey, "c.ts");
  await flushPromises();
  expect(centerTabs.tabsFor(goneKey).length).toBe(2);

  const terminals = useTerminalStore();
  const detachSpy = vi.spyOn(terminals, "detach");

  // Simulate a SERVER-driven removal (deleted from the CLI / WeChat / another browser):
  // the session vanishes from i1's list, but sessionsLoaded stays true — exactly what a
  // real `applyEvent` -> `loadSessions` reload leaves behind.
  instances.instances[0].sessions = [];
  await flushPromises();

  expect(centerTabs.tabsFor(goneKey)).toEqual([]); // reconciled away
  expect(centerTabs.tabsFor(keepKey).length).toBe(1); // untouched — still a valid session
  expect(centerTabs.tabsFor(loadingKey).length).toBe(1); // guarded — instance still loading
  // Browser detaches only; channel-relay owns resource retirement.
  expect(detachSpy).toHaveBeenCalledWith(terminalLocalKey("i1", "demo"));
});

// Terminal close is a confirmed global terminate — cancel leaves the tab; confirm terminates.
test("closing a terminal tab confirms then terminates the shared resource", async () => {
  const termStub = { name: "TerminalTab", template: '<div data-test="stub-term" />', emits: ["close"] };
  const wrapper = mount(DashboardView, { global: { stubs: { ...stubs, TerminalTab: termStub } } });
  await flushPromises();
  const key = selectSession();
  await flushPromises();
  const centerTabs = useCenterTabsStore();
  centerTabs.openTerminal(key);
  await flushPromises();
  const terminals = useTerminalStore();
  const localKey = terminalLocalKey("i1", "demo");
  // Seed an attachment so terminate has identity to send.
  terminals.attachments.set(localKey, {
    localKey,
    instanceId: "i1",
    sessionAlias: "demo",
    cols: 80,
    rows: 24,
    terminalId: "t1",
    generation: "g1",
    attachmentId: "a1",
    role: "controller",
    viewerCount: 1,
    recovery: initialRecoveryState("g1"),
    active: true,
    terminatePending: false,
    terminateRetryable: false,
  });
  const terminateSpy = vi.spyOn(terminals, "terminate").mockResolvedValue({ status: "terminated" });
  vi.spyOn(window, "confirm").mockReturnValue(true);

  wrapper.findComponent(TerminalTab).vm.$emit("close");
  await flushPromises();

  expect(terminateSpy).toHaveBeenCalledWith(localKey);
  expect(centerTabs.tabsFor(key).some((t) => t.kind === "terminal")).toBe(false);
});

test("closing a terminal tab that never opened just drops the tab", async () => {
  const termStub = { name: "TerminalTab", template: '<div data-test="stub-term" />', emits: ["close"] };
  const wrapper = mount(DashboardView, { global: { stubs: { ...stubs, TerminalTab: termStub } } });
  await flushPromises();
  const key = selectSession();
  await flushPromises();
  const centerTabs = useCenterTabsStore();
  centerTabs.openTerminal(key);
  await flushPromises();
  const terminals = useTerminalStore();
  const terminateSpy = vi.spyOn(terminals, "terminate");
  const confirmSpy = vi.spyOn(window, "confirm");

  wrapper.findComponent(TerminalTab).vm.$emit("close");
  await flushPromises();

  expect(confirmSpy).not.toHaveBeenCalled();
  expect(terminateSpy).not.toHaveBeenCalled();
  expect(centerTabs.tabsFor(key).some((t) => t.kind === "terminal")).toBe(false);
});

test("canceling terminal close confirm does not terminate", async () => {
  const termStub = { name: "TerminalTab", template: '<div data-test="stub-term" />', emits: ["close"] };
  const wrapper = mount(DashboardView, { global: { stubs: { ...stubs, TerminalTab: termStub } } });
  await flushPromises();
  const key = selectSession();
  await flushPromises();
  const centerTabs = useCenterTabsStore();
  centerTabs.openTerminal(key);
  await flushPromises();
  const terminals = useTerminalStore();
  const localKey = terminalLocalKey("i1", "demo");
  terminals.attachments.set(localKey, {
    localKey,
    instanceId: "i1",
    sessionAlias: "demo",
    cols: 80,
    rows: 24,
    terminalId: "t1",
    generation: "g1",
    attachmentId: "a1",
    role: "controller",
    viewerCount: 1,
    recovery: initialRecoveryState("g1"),
    active: true,
    terminatePending: false,
    terminateRetryable: false,
  });
  const terminateSpy = vi.spyOn(terminals, "terminate");
  vi.spyOn(window, "confirm").mockReturnValue(false);

  wrapper.findComponent(TerminalTab).vm.$emit("close");
  await flushPromises();

  expect(terminateSpy).not.toHaveBeenCalled();
  expect(centerTabs.tabsFor(key).some((t) => t.kind === "terminal")).toBe(true);
});

test("closing a FILE tab does not terminate any terminal", async () => {
  const fileStub = { name: "FileViewer", template: '<div data-test="stub-file" />', emits: ["close", "dirty-change"] };
  const wrapper = mount(DashboardView, { global: { stubs: { ...stubs, FileViewer: fileStub } } });
  await flushPromises();
  const key = selectSession();
  await flushPromises();
  const centerTabs = useCenterTabsStore();
  centerTabs.openFile(key, "a.ts");
  await flushPromises();
  const terminals = useTerminalStore();
  const terminateSpy = vi.spyOn(terminals, "terminate");

  wrapper.findComponent(FileViewer).vm.$emit("close");
  await flushPromises();

  expect(terminateSpy).not.toHaveBeenCalled();
  expect(centerTabs.tabsFor(key)).toEqual([]);
});

// Regression: CenterTabStrip X must route through requestCloseTerminal (confirm + terminate).
test("clicking the tab strip's own X button terminates after confirm", async () => {
  const { CenterTabStrip: _stubbedStrip, ...stubsWithoutStrip } = stubs;
  const wrapper = mount(DashboardView, { global: { stubs: stubsWithoutStrip } });
  await flushPromises();
  const key = selectSession();
  await flushPromises();
  const centerTabs = useCenterTabsStore();
  centerTabs.openTerminal(key);
  await flushPromises();
  const terminals = useTerminalStore();
  const localKey = terminalLocalKey("i1", "demo");
  terminals.attachments.set(localKey, {
    localKey,
    instanceId: "i1",
    sessionAlias: "demo",
    cols: 80,
    rows: 24,
    terminalId: "t1",
    generation: "g1",
    attachmentId: "a1",
    role: "controller",
    viewerCount: 1,
    recovery: initialRecoveryState("g1"),
    active: true,
    terminatePending: false,
    terminateRetryable: false,
  });
  const terminateSpy = vi.spyOn(terminals, "terminate").mockResolvedValue({ status: "terminated" });
  vi.spyOn(window, "confirm").mockReturnValue(true);

  const closeButtons = wrapper.findAll('[data-test="tab-close"]');
  expect(closeButtons.length).toBeGreaterThan(0);
  await closeButtons[0].trigger("click");
  await flushPromises();

  expect(terminateSpy).toHaveBeenCalledWith(localKey);
});
