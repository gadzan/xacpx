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

const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, "router-link": true };

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

test("the center column shows the chat by default and the file viewer when a file is open", async () => {
  const wrapper = mountDash();
  await flushPromises();
  expect(wrapper.findComponent(ChatPane).exists()).toBe(true);
  expect(wrapper.findComponent(FileViewer).exists()).toBe(false);
  // Opening a file from the rail takes over the center column.
  const files = useFilesStore();
  files.file = { workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false };
  await flushPromises();
  expect(wrapper.findComponent(FileViewer).exists()).toBe(true);
  expect(wrapper.findComponent(ChatPane).exists()).toBe(false);
});

test("the sidebar toggle collapses the instances column on desktop", async () => {
  const wrapper = mountDash();
  await flushPromises();
  const left = wrapper.find('[data-drawer="left"]');
  expect(left.classes()).toContain("lg:w-[248px]");
  await wrapper.find('[data-test="toggle-left"]').trigger("click");
  expect(left.classes()).toContain("lg:w-0");
  expect(left.classes()).not.toContain("lg:w-[248px]");
});
