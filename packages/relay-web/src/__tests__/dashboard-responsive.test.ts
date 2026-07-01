import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Stub the WS client so jsdom needs no real socket.
const disconnect = vi.fn();
vi.mock("../api/events", () => ({
  connectEvents: () => disconnect,
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import DashboardView from "../views/DashboardView.vue";
import ChatPane from "../components/ChatPane.vue";
import FileViewer from "../components/FileViewer.vue";
import { useChatStore } from "../stores/chat";
import { useFilesStore } from "../stores/files";

const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, TerminalTab: true, "router-link": true };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
});

function mountDash() {
  return mount(DashboardView, { global: { stubs } });
}

test("renders mobile drawer controls", async () => {
  const wrapper = mountDash();
  await flushPromises();
  expect(wrapper.find('[data-test="open-instances"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="open-tasks"]').exists()).toBe(true);
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

test("instance drawer starts off-canvas and opens via the hamburger", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const left = wrapper.find('[data-drawer="left"]');
  expect(left.classes()).toContain("-translate-x-full");
  expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(false);

  await wrapper.find('[data-test="open-instances"]').trigger("click");
  expect(left.classes()).toContain("translate-x-0");
  expect(left.classes()).not.toContain("-translate-x-full");
  expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(true);
});

test("the mobile bar exposes a discoverable Files button that opens the Files drawer on the files tab", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const filesBtn = wrapper.find('[data-test="open-files"]');
  expect(filesBtn.exists()).toBe(true);
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("translate-x-full");

  await filesBtn.trigger("click");
  // Drawer is open...
  expect(right.classes()).toContain("translate-x-0");
  expect(right.classes()).not.toContain("translate-x-full");
  // ...and showing the Files tab as active.
  const filesTab = wrapper.find('[data-test="right-tab-files"]');
  expect(filesTab.classes()).toContain("text-accent");
  expect(filesTab.classes()).toContain("font-semibold");
});

test("file viewer Back returns to the file list (drawer reopens) and Close returns to the conversation", async () => {
  const files = useFilesStore();
  // Replace the FileViewer stub with a minimal one that re-emits back/close so we can
  // exercise DashboardView's nav handlers (rightTab/rightOpen are internal refs, so we
  // assert via observable drawer DOM).
  const fvStub = { name: "FileViewer", template: "<div data-test=\"fv-stub\" />", emits: ["back", "close"] };
  const wrapper = mount(DashboardView, {
    global: { stubs: { ChatPane: true, TaskPanel: true, "router-link": true, FileViewer: fvStub } },
  });
  await flushPromises();
  const right = wrapper.find('[data-drawer="right"]');

  // Open a file so the (stubbed) FileViewer renders.
  files.file = { workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false };
  await flushPromises();
  expect(wrapper.findComponent(FileViewer).exists()).toBe(true);

  // Back -> file list: file cleared AND right drawer open on files.
  wrapper.findComponent(FileViewer).vm.$emit("back");
  await flushPromises();
  expect(files.file).toBeNull();
  expect(right.classes()).toContain("translate-x-0");
  expect(right.classes()).not.toContain("translate-x-full");

  // Re-open a file, then Close -> conversation: file cleared AND right drawer NOT open.
  files.file = { workspace: "ws", path: "b.ts", content: "y", size: 1, truncated: false, binary: false };
  await flushPromises();
  wrapper.findComponent(FileViewer).vm.$emit("close");
  await flushPromises();
  expect(files.file).toBeNull();
  expect(right.classes()).toContain("translate-x-full");
});

test("tasks drawer opens via the Tasks button", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const right = wrapper.find('[data-drawer="right"]');
  expect(right.classes()).toContain("translate-x-full");

  await wrapper.find('[data-test="open-tasks"]').trigger("click");
  expect(right.classes()).toContain("translate-x-0");
  expect(right.classes()).not.toContain("translate-x-full");
});

test("backdrop click closes an open drawer", async () => {
  const wrapper = mountDash();
  await flushPromises();
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
  await wrapper.find('[data-test="open-instances"]').trigger("click");
  expect(wrapper.find('[data-drawer="left"]').classes()).toContain("translate-x-0");

  wrapper.findComponent({ name: "InstanceTree" }).vm.$emit("select", "i1", "backend");
  await flushPromises();
  expect(chat.instanceId).toBe("i1");
  expect(wrapper.find('[data-drawer="left"]').classes()).toContain("-translate-x-full");
});

test("opening a file overlays the viewer but keeps the chat mounted+laid out (inert) so scroll is preserved without re-layout jank", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const chatBefore = wrapper.findComponent(ChatPane);
  expect(chatBefore.exists()).toBe(true);
  // Bound inert is false when no file is open (the stub surfaces the raw bound value; on the
  // real single-root ChatPane Vue drops the attribute entirely when false).
  expect(chatBefore.attributes("inert")).toBe("false");
  expect(wrapper.findComponent(FileViewer).exists()).toBe(false);
  // Opening a file overlays the FileViewer on top. ChatPane is NOT unmounted or hidden via
  // display:none — it stays laid out underneath (just `inert`), so its scroll position is
  // preserved and returning is a cheap repaint, not a full re-layout.
  const files = useFilesStore();
  files.file = { workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false };
  await flushPromises();
  expect(wrapper.findComponent(FileViewer).exists()).toBe(true);
  const chat = wrapper.findComponent(ChatPane);
  expect(chat.exists()).toBe(true);
  expect(chat.attributes("inert")).toBe("true"); // occluded → disabled for focus/interaction
  // Not hidden via display:none (that's what caused the reveal jank).
  expect(chat.attributes("style") ?? "").not.toContain("display: none");
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

test("terminal toggle is disabled without a session and enabled with one", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const btn = wrapper.find('[data-test="toggle-terminal"]');
  expect(btn.exists()).toBe(true);
  expect(btn.attributes("disabled")).toBeDefined();

  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();
  expect(wrapper.find('[data-test="toggle-terminal"]').attributes("disabled")).toBeUndefined();
});

test("toggling the terminal opens a center overlay and is mutually exclusive with the file viewer", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  const files = useFilesStore();
  files.file = { workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false };
  await flushPromises();

  await wrapper.find('[data-test="toggle-terminal"]').trigger("click");
  await flushPromises();
  // Terminal overlay is mounted (VTU renders a `true` stub as <terminal-tab-stub>)...
  expect(wrapper.find("terminal-tab-stub").exists()).toBe(true);
  // ...and opening it cleared the file viewer (mutual exclusion).
  expect(files.file).toBeNull();
});

test("the right rail no longer exposes a Terminal tab", async () => {
  const wrapper = mountDash();
  await flushPromises();
  expect(wrapper.find('[data-test="right-tab-terminal"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="right-tab-files"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="right-tab-tasks"]').exists()).toBe(true);
});
