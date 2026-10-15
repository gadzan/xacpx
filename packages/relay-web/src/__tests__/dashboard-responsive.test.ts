import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

// Stub the WS client so jsdom needs no real socket.
const disconnect = vi.fn();
vi.mock("../api/events", () => ({
  connectEvents: () => disconnect,
  sendSubscribe: vi.fn(),
  sendWebClientMessage: vi.fn(),
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

import DashboardView from "../views/DashboardView.vue";
import ChatPane from "../components/ChatPane.vue";
import FileViewer from "../components/FileViewer.vue";
import { useChatStore } from "../stores/chat";
import { useConnectionStore } from "../stores/connection";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";

const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, TerminalTab: true, "router-link": true };

const capableInstance = {
  id: "i1",
  name: "pc",
  online: true,
  lastSeenAt: null,
  capabilities: [RELAY_CAPABILITIES.terminalRmuxRecoveryV1, RELAY_CAPABILITIES.terminalMultiViewV1],
};

beforeEach(() => {
  setActivePinia(createPinia());
  // center-tabs now persists to sessionStorage (task 2); clear it too so tabs opened in one
  // test don't leak into the next test's store via hydrate().
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [capableInstance] }), { status: 200 })));
});

function mountDash() {
  return mount(DashboardView, { global: { stubs } });
}

/** Select a session so the single mobile top bar (and its ⋯ sheet) is the active chrome. */
async function selectSession(alias = "demo") {
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = alias;
  await flushPromises();
}

test("renders the single mobile top bar with its more-sheet entries", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  // One bar: instances drawer, title/subtitle, ⋯ trigger. The old second bar's
  // files/tasks buttons are gone — they live in the sheet now.
  expect(wrapper.find('[data-test="mobile-session-bar"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="open-instances"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="open-files"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="open-tasks"]').exists()).toBe(false);

  await wrapper.find('[data-test="mobile-more"]').trigger("click");
  await flushPromises();
  const sheet = wrapper.find('[data-test="mobile-more-sheet"]');
  expect(sheet.exists()).toBe(true);
  for (const id of ["sheet-open-tabs", "sheet-files", "sheet-tasks", "sheet-terminal"]) {
    expect(sheet.find(`[data-test="${id}"]`).exists()).toBe(true);
  }
  // No separate 「工作区」 entry: 「文件」 already opens the files panel.
  expect(sheet.find('[data-test="sheet-workspace"]').exists()).toBe(false);
  // The model stays on the composer chip — never a sheet entry.
  expect(sheet.text()).not.toContain("model");
  expect(sheet.find('[data-test="sheet-model"]').exists()).toBe(false);
});

test("chat column is shrinkable (min-w-0) so wide tool content can't push the right panel off-screen", async () => {
  const wrapper = mountDash();
  await flushPromises();
  // The center column is the one without a drawer marker (the side panels are drawers).
  // Regression: without min-w-0 the flex-1 column grows to its widest content (a tool
  // card's command/diff line), shoving the fixed-width right panel out of the viewport.
  const center = wrapper.find('[data-test="column"]:not([data-drawer])');
  expect(center.exists()).toBe(true);
  expect(center.classes()).toContain("min-w-0");
});

test("instance drawer starts off-canvas and opens via the mobile bar's left button", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  const left = wrapper.find('[data-drawer="left"]');
  expect(left.classes()).toContain("-translate-x-full");
  expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(false);

  await wrapper.find('[data-test="open-instances"]').trigger("click");
  expect(left.classes()).toContain("translate-x-0");
  expect(left.classes()).not.toContain("-translate-x-full");
  expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(true);
});

test("the more sheet's Files entry opens the Files drawer on the files tab", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  await wrapper.find('[data-test="mobile-more"]').trigger("click");
  await flushPromises();
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("translate-x-full");

  await wrapper.find('[data-test="sheet-files"]').trigger("click");
  await flushPromises();
  // Drawer is open...
  expect(right.classes()).toContain("translate-x-0");
  expect(right.classes()).not.toContain("translate-x-full");
  // ...and showing the Files tab as active.
  const filesTab = wrapper.find('[data-test="right-tab-files"]');
  expect(filesTab.classes()).toContain("text-accent");
  expect(filesTab.classes()).toContain("font-semibold");
  // The sheet that launched it is gone.
  expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(false);
});

test("file viewer Close removes the tab and returns to chat", async () => {
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  const centerTabs = useCenterTabsStore();
  const key = sessionKey("i1", "demo");
  // Replace the FileViewer stub with a minimal one that re-emits close so we can
  // exercise DashboardView's close wiring.
  const fvStub = { name: "FileViewer", template: "<div data-test=\"fv-stub\" />", emits: ["close"] };
  const wrapper = mount(DashboardView, {
    global: { stubs: { ChatPane: true, TaskPanel: true, "router-link": true, FileViewer: fvStub } },
  });
  await flushPromises();

  // Open a file tab so the (stubbed) FileViewer renders.
  centerTabs.openFile(key, "a.ts");
  await flushPromises();
  expect(wrapper.findComponent(FileViewer).exists()).toBe(true);
  expect(centerTabs.activeFor(key)).toBe("file:a.ts");

  // Close -> the tab is actually removed and active falls back to chat.
  wrapper.findComponent(FileViewer).vm.$emit("close");
  await flushPromises();
  expect(centerTabs.tabsFor(key)).toEqual([]);
  expect(centerTabs.activeFor(key)).toBe("chat");
});

test("tasks drawer opens via the more sheet's Tasks entry", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("translate-x-full");

  await wrapper.find('[data-test="mobile-more"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-test="sheet-tasks"]').trigger("click");
  await flushPromises();
  expect(right.classes()).toContain("translate-x-0");
  expect(right.classes()).not.toContain("translate-x-full");
  expect(wrapper.find('[data-test="right-tab-tasks"]').classes()).toContain("text-accent");
});

test("backdrop click closes an open drawer", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  await wrapper.find('[data-test="open-instances"]').trigger("click");
  expect(wrapper.find('[data-drawer="left"]').classes()).toContain("translate-x-0");

  await wrapper.find('[data-test="drawer-backdrop"]').trigger("click");
  expect(wrapper.find('[data-drawer="left"]').classes()).toContain("-translate-x-full");
  expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(false);
});

test("selecting a session closes the instance drawer and routes to chat", async () => {
  const chat = useChatStore();
  const wrapper = mount(DashboardView, { global: { stubs: { ChatPane: true, TaskPanel: true, "router-link": true } } });
  await flushPromises();
  await selectSession();
  await wrapper.find('[data-test="open-instances"]').trigger("click");
  expect(wrapper.find('[data-drawer="left"]').classes()).toContain("translate-x-0");

  wrapper.findComponent({ name: "InstanceTree" }).vm.$emit("select", "i1", "backend");
  await flushPromises();
  expect(chat.instanceId).toBe("i1");
  expect(chat.sessionAlias).toBe("backend");
  expect(wrapper.find('[data-drawer="left"]').classes()).toContain("-translate-x-full");
});

test("opening a file overlays the viewer but keeps the chat mounted (inert) so scroll is preserved without re-layout jank", async () => {
  const chat0 = useChatStore();
  chat0.instanceId = "i1";
  chat0.sessionAlias = "demo";
  const centerTabs = useCenterTabsStore();
  const key = sessionKey("i1", "demo");
  const wrapper = mountDash();
  await flushPromises();
  const chatBefore = wrapper.findComponent(ChatPane);
  expect(chatBefore.exists()).toBe(true);
  // Bound inert is false when no tab is active (the stub surfaces the raw bound value; on
  // the real single-root ChatPane Vue drops the attribute entirely when false).
  expect(chatBefore.attributes("inert")).toBe("false");
  expect(wrapper.findComponent(FileViewer).exists()).toBe(false);
  // Opening a file tab mounts a FileViewer pane. ChatPane is NOT unmounted or hidden via
  // display:none in the sense of losing layout — v-show only toggles CSS display, so its
  // scroll position is preserved and returning is a cheap repaint, not a full re-layout.
  centerTabs.openFile(key, "a.ts");
  await flushPromises();
  const file = wrapper.findComponent(FileViewer);
  expect(file.exists()).toBe(true);
  expect(file.attributes("style") ?? "").not.toContain("display: none"); // the active tab is visible
  const chat = wrapper.findComponent(ChatPane);
  expect(chat.exists()).toBe(true);
  expect(chat.attributes("inert")).toBe("true"); // occluded → disabled for focus/interaction
  // Hidden via v-show (display:none) while a tab is active — NOT unmounted (still findable).
  expect(chat.attributes("style") ?? "").toContain("display: none");
});

test("the sidebar header toggle collapses the instances column, and the edge handle restores it", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const left = wrapper.find('[data-drawer="left"]');
  expect(left.classes()).toContain("lg:w-[248px]");
  // No expand handle while the sidebar is open.
  expect(wrapper.find('[data-test="expand-left"]').exists()).toBe(false);

  // Collapse via the control in the sidebar's own header.
  await wrapper.find('[data-test="toggle-left"]').trigger("click");
  expect(left.classes()).toContain("lg:w-0");
  expect(left.classes()).not.toContain("lg:w-[248px]");

  // Once collapsed, a slim edge handle appears and brings the sidebar back.
  const handle = wrapper.find('[data-test="expand-left"]');
  expect(handle.exists()).toBe(true);
  await handle.trigger("click");
  expect(left.classes()).toContain("lg:w-[248px]");
  expect(wrapper.find('[data-test="expand-left"]').exists()).toBe(false);
});

test("edge-swipe right from the left edge opens the instances drawer (mobile)", async () => {
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    const wrapper = mountDash();
    await flushPromises();
    await selectSession();
    const left = wrapper.find('[data-drawer="left"]');
    expect(left.classes()).toContain("-translate-x-full");

    await wrapper.trigger("touchstart", { touches: [{ clientX: 6, clientY: 200 }] });
    await wrapper.trigger("touchend", { changedTouches: [{ clientX: 110, clientY: 208 }] });

    expect(left.classes()).toContain("translate-x-0");
    expect(left.classes()).not.toContain("-translate-x-full");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  }
});

test("edge-swipe right does nothing on the mobile home, where the tree is already the main content", async () => {
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    const wrapper = mountDash();
    await flushPromises();
    await wrapper.trigger("touchstart", { touches: [{ clientX: 6, clientY: 200 }] });
    await wrapper.trigger("touchend", { changedTouches: [{ clientX: 110, clientY: 208 }] });
    expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(false);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  }
});

test("edge-swipe left from the right edge opens the tasks/files drawer (mobile)", async () => {
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    const wrapper = mountDash();
    await flushPromises();
    const right = wrapper.find('[data-drawer="right"]');
    expect(right.classes()).toContain("translate-x-full");

    await wrapper.trigger("touchstart", { touches: [{ clientX: 494, clientY: 200 }] });
    await wrapper.trigger("touchend", { changedTouches: [{ clientX: 380, clientY: 206 }] });

    expect(right.classes()).toContain("translate-x-0");
    expect(right.classes()).not.toContain("translate-x-full");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  }
});

test("terminal toggle is disabled without a capable session and enabled with one", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const chat = useChatStore();
  chat.instanceId = null;
  chat.sessionAlias = null;
  await flushPromises();
  const btn = wrapper.find('[data-test="toggle-terminal"]');
  expect(btn.exists()).toBe(true);
  expect(btn.attributes("disabled")).toBeDefined();

  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();
  expect(wrapper.find('[data-test="toggle-terminal"]').attributes("disabled")).toBeUndefined();
});

test("toggling the terminal activates the terminal tab and is mutually exclusive with the file tab (only one active at a time)", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  const centerTabs = useCenterTabsStore();
  const key = sessionKey("i1", "demo");
  centerTabs.openFile(key, "a.ts");
  await flushPromises();
  expect(centerTabs.activeFor(key)).toBe("file:a.ts");

  await wrapper.find('[data-test="toggle-terminal"]').trigger("click");
  await flushPromises();
  // Terminal overlay is mounted (VTU renders a `true` stub as <terminal-tab-stub>)...
  expect(wrapper.find("terminal-tab-stub").exists()).toBe(true);
  // ...and it becomes the sole active tab (mutual exclusion) — the file tab is untouched
  // (still open in the strip, just no longer active).
  expect(centerTabs.activeFor(key)).toBe("terminal");
  expect(centerTabs.tabsFor(key).map((t) => t.id)).toEqual(["file:a.ts", "terminal"]);
});

test("the right rail no longer exposes a Terminal tab", async () => {
  const wrapper = mountDash();
  await flushPromises();
  expect(wrapper.find('[data-test="right-tab-terminal"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="right-tab-files"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="right-tab-tasks"]').exists()).toBe(true);
});

test("deselecting the session hides (but keeps mounted) its terminal — it stays warm in the background and reappears on reselect", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();
  await wrapper.find('[data-test="toggle-terminal"]').trigger("click");
  await flushPromises();
  expect(wrapper.find("terminal-tab-stub").exists()).toBe(true);

  // Deselecting the session (not archiving/removing it) must NOT tear down the terminal's
  // PTY — the pane just hides. Unmounting only happens via closeTab/clearSession.
  chat.sessionAlias = null;
  await flushPromises();
  const hiddenTerm = wrapper.find("terminal-tab-stub");
  expect(hiddenTerm.exists()).toBe(true);
  expect(hiddenTerm.attributes("style") ?? "").toContain("display: none");

  // Reselecting the same session reveals the same (still-open) terminal tab again.
  chat.sessionAlias = "demo";
  await flushPromises();
  expect(wrapper.find("terminal-tab-stub").attributes("style") ?? "").not.toContain("display: none");
});

test("opening the terminal closes an already-open right drawer (rightOpen mutual exclusion)", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  await wrapper.find('[data-test="mobile-more"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-test="sheet-files"]').trigger("click");
  await flushPromises();
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("translate-x-0");
  await wrapper.find('[data-test="toggle-terminal"]').trigger("click");
  await flushPromises();
  expect(right.classes()).toContain("translate-x-full");
});

test("right drawer is full-width on mobile (no 85% cap)", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("w-full");
  expect(right.classes()).not.toContain("max-w-[85%]");
});

// ── Mobile layout (redesign PR4) ────────────────────────────────────────────────

function seedInstance(id: string, name: string, alias: string) {
  const instances = useInstancesStore();
  instances.instances = [{
    id, name, online: true, lastSeenAt: null,
    sessions: [{ alias, agent: "codex", driver: "codex", workspace: "/w", transportSession: "t", running: false, archived: false }],
    sessionsLoaded: true,
    agents: [{ name: "codex", driver: "codex" }],
    workspaces: [], agentCatalog: [],
  }];
}

test("mobile bar subtitle joins instance · agent · branch and never leads with a separator", async () => {
  const wrapper = mountDash();
  await flushPromises();
  seedInstance("i1", "pc", "demo");
  const files = useFilesStore();
  files.gitSummary = { workspace: "/w", changedCount: 0, branch: "feat/mobile" };
  await selectSession();

  const subtitle = wrapper.find('[data-test="mobile-session-subtitle"]');
  expect(subtitle.text()).toBe("pc · codex · feat/mobile");
  // The session's own name is the title; the subtitle carries the context only.
  expect(wrapper.find('[data-test="mobile-session-bar"]').text()).toContain("demo");

  // No branch loaded: the remaining parts still join without a leading/doubled "·".
  files.gitSummary = null;
  await flushPromises();
  expect(wrapper.find('[data-test="mobile-session-subtitle"]').text()).toBe("pc · codex");
});

test("connection strip shows only after the connection has been open once", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  // Cold start that never connected: no strip.
  expect(wrapper.find('[data-test="conn-strip"]').exists()).toBe(false);

  const conn = useConnectionStore();
  conn.setOnline(true);
  await flushPromises();
  expect(wrapper.find('[data-test="conn-strip"]').exists()).toBe(false);

  conn.setOnline(false);
  await flushPromises();
  expect(wrapper.find('[data-test="conn-strip"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="conn-strip"]').attributes("role")).toBe("status");
});

test("open-tabs sheet switches tabs and closes them through the guarded path", async () => {
  const wrapper = mountDash();
  await flushPromises();
  await selectSession();
  const centerTabs = useCenterTabsStore();
  const key = sessionKey("i1", "demo");
  centerTabs.openFile(key, "src/a.ts");
  await flushPromises();

  await wrapper.find('[data-test="mobile-more"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-test="sheet-open-tabs"]').trigger("click");
  await flushPromises();

  const sheet = wrapper.find('[data-test="open-tabs-sheet"]');
  expect(sheet.exists()).toBe(true);
  // Sheets are mutually exclusive: the tabs sheet replaces ⋯ instead of stacking on it.
  expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(false);
  expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
  const rows = sheet.findAll('[data-test="open-tab-row"]');
  expect(rows).toHaveLength(2); // pinned Chat + the open file
  expect(rows[0].attributes("data-tab-id")).toBe("chat");
  expect(rows[1].attributes("data-tab-id")).toBe("file:src/a.ts");
  // The active tab is the highlighted one.
  expect(rows[1].classes()).toContain("bg-accent-soft");
  expect(rows[1].classes()).toContain("text-accent");

  // Tapping Chat switches back and dismisses the sheet.
  await rows[0].find("button").trigger("click");
  await flushPromises();
  expect(centerTabs.activeFor(key)).toBe("chat");
  expect(wrapper.find('[data-test="open-tabs-sheet"]').exists()).toBe(false);
  // ...and does not fall back to the ⋯ sheet.
  expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(false);

  // Closing runs the same guarded path as the strip's X: a dirty file asks first.
  centerTabs.openFile(key, "src/a.ts");
  centerTabs.setDirty(key, "file:src/a.ts", true);
  await flushPromises();
  await wrapper.find('[data-test="mobile-more"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-test="sheet-open-tabs"]').trigger("click");
  await flushPromises();
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  await wrapper.find('[data-test="open-tab-close"]').trigger("click");
  await flushPromises();
  expect(confirmSpy).toHaveBeenCalled();
  expect(centerTabs.tabsFor(key)).toHaveLength(1); // declined → kept open

  confirmSpy.mockReturnValue(true);
  await wrapper.find('[data-test="open-tab-close"]').trigger("click");
  await flushPromises();
  expect(centerTabs.tabsFor(key)).toHaveLength(0);
  confirmSpy.mockRestore();
});

test("mobile home renders the tree as the main content plus the new-session FAB", async () => {
  const wrapper = mountDash();
  await flushPromises();
  expect(wrapper.find('[data-test="fab-new-session"]').exists()).toBe(true);
  // Same single tree instance, re-flowed into the main area below lg; the placeholder
  // column steps aside.
  const left = wrapper.find('[data-drawer="left"]');
  expect(left.classes()).toContain("max-lg:relative");
  expect(left.classes()).toContain("max-lg:w-full");
  expect(wrapper.find('[data-test="column"]:not([data-drawer])').classes()).toContain("max-lg:hidden");
  // The instance tree is rendered exactly once (drawer and main area share it).
  expect(wrapper.findAllComponents({ name: "InstanceTree" })).toHaveLength(1);
});

test("FAB with one online instance opens the create dialog for it directly", async () => {
  const nsStub = { name: "NewSessionDialog", props: ["instanceId"], template: '<div data-test="ns-stub">{{ instanceId }}</div>' };
  const wrapper = mount(DashboardView, { global: { stubs: { ...stubs, NewSessionDialog: nsStub } } });
  await flushPromises();
  // The fixture's single instance is online.
  await wrapper.find('[data-test="fab-new-session"]').trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-test="fab-instance-sheet"]').exists()).toBe(false);
  const dialog = wrapper.find('[data-test="ns-stub"]');
  expect(dialog.exists()).toBe(true);
  expect(dialog.text()).toBe("i1");
});

test("FAB with several online instances opens a picker with the last-used instance first", async () => {
  // Last used = the instance of the most recently opened session (DashboardView keeps it
  // under its own key because deselecting clears the persisted chat selection).
  localStorage.setItem("xacpx.lastInstance", "i2");
  const nsStub = { name: "NewSessionDialog", props: ["instanceId"], template: '<div data-test="ns-stub">{{ instanceId }}</div>' };
  const wrapper = mount(DashboardView, { global: { stubs: { ...stubs, NewSessionDialog: nsStub } } });
  await flushPromises();
  const instances = useInstancesStore();
  instances.instances = [
    { id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
    { id: "i2", name: "second", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
    { id: "i3", name: "asleep", online: false, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
  ];
  await flushPromises();

  await wrapper.find('[data-test="fab-new-session"]').trigger("click");
  await flushPromises();
  const sheet = wrapper.find('[data-test="fab-instance-sheet"]');
  expect(sheet.exists()).toBe(true);
  // Only online instances, last-used (i2) first.
  expect(sheet.findAll('[data-test="fab-instance-option"]').map((o) => o.text())).toEqual(["second", "pc"]);

  await sheet.findAll('[data-test="fab-instance-option"]')[0].trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-test="fab-instance-sheet"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="ns-stub"]').text()).toBe("i2");
});

test("opening a session records its instance as the FAB's last used", async () => {
  localStorage.removeItem("xacpx.lastInstance");
  mountDash();
  await flushPromises();
  await selectSession();
  expect(localStorage.getItem("xacpx.lastInstance")).toBe("i1");
});

test("FAB is disabled when no instance is online", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const instances = useInstancesStore();
  instances.instances = [
    { id: "i1", name: "pc", online: false, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
  ];
  await flushPromises();
  expect(wrapper.find('[data-test="fab-new-session"]').attributes("disabled")).toBeDefined();
});
