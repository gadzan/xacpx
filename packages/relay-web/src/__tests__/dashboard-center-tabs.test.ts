// packages/relay-web/src/__tests__/dashboard-center-tabs.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Stub the WS client so jsdom needs no real socket.
vi.mock("../api/events", () => ({
  connectEvents: () => vi.fn(),
}));
// DashboardView uses useRouter()/<router-link>; mock to avoid a real router.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import DashboardView from "../views/DashboardView.vue";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useInstancesStore, type InstanceView } from "../stores/instances";

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
  const wrapper = mountDash();
  await flushPromises();
  const key = selectSession();
  await flushPromises();

  const centerTabs = useCenterTabsStore();
  const spy = vi.spyOn(centerTabs, "openTerminal");

  await wrapper.find('[data-test="toggle-terminal"]').trigger("click");
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

  // Simulate a SERVER-driven removal (deleted from the CLI / WeChat / another browser):
  // the session vanishes from i1's list, but sessionsLoaded stays true — exactly what a
  // real `applyEvent` -> `loadSessions` reload leaves behind.
  instances.instances[0].sessions = [];
  await flushPromises();

  expect(centerTabs.tabsFor(goneKey)).toEqual([]); // reconciled away
  expect(centerTabs.tabsFor(keepKey).length).toBe(1); // untouched — still a valid session
  expect(centerTabs.tabsFor(loadingKey).length).toBe(1); // guarded — instance still loading
});
