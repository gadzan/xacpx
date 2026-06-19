// packages/relay-web/src/__tests__/dashboard.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Stub the WS client so jsdom needs no real socket.
// Capture the (onEvent, onStatus) callbacks so tests can drive reconnects.
const disconnect = vi.fn();
const captured: { onEvent?: (e: unknown) => void; onStatus?: (online: boolean) => void } = {};
vi.mock("../api/events", () => ({
  connectEvents: (onEvent: (e: unknown) => void, onStatus?: (online: boolean) => void) => {
    captured.onEvent = onEvent;
    captured.onStatus = onStatus;
    return disconnect;
  },
}));

// DashboardView now uses useRouter()/<router-link>; mock to avoid a real router.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import DashboardView from "../views/DashboardView.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { i18n } from "../i18n";

beforeEach(() => {
  setActivePinia(createPinia());
  captured.onEvent = undefined;
  captured.onStatus = undefined;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
});

test("dashboard renders three columns and loads instances on mount", async () => {
  const store = useInstancesStore();
  const spy = vi.spyOn(store, "loadInstances");
  const wrapper = mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();
  expect(spy).toHaveBeenCalled();
  expect(wrapper.findAll('[data-test="column"]').length).toBe(3);
});

test("selecting a session routes it into the chat store", async () => {
  const chat = useChatStore();
  const wrapper = mount(DashboardView, { global: { stubs: { ChatPane: true, "router-link": true } } });
  await flushPromises();
  wrapper.findComponent({ name: "InstanceTree" }).vm.$emit("select", "i1", "backend");
  expect(chat.instanceId).toBe("i1");
  expect(chat.sessionAlias).toBe("backend");
});

test("nav aria-labels localize to the active locale", async () => {
  i18n.global.locale.value = "zh-CN";
  try {
    const wrapper = mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
    await flushPromises();
    expect(wrapper.get('[data-test="global-search"]').attributes("aria-label")).toBe("搜索");
    expect(wrapper.get('[data-test="open-instances"]').attributes("aria-label")).toBe("打开实例");
  } finally {
    i18n.global.locale.value = "en";
  }
});

test("re-pulls the snapshot on reconnect", async () => {
  const store = useInstancesStore();
  const spy = vi.spyOn(store, "loadInstances").mockResolvedValue();
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();
  // onMounted's initial connect + load has settled; the captured onStatus is available.
  expect(captured.onStatus).toBeTypeOf("function");
  spy.mockClear();

  // First connect (online) must NOT re-pull (onMounted already loaded).
  captured.onStatus?.(true);
  await flushPromises();
  expect(spy).not.toHaveBeenCalled();

  // Drop then reconnect → snapshot re-pull.
  captured.onStatus?.(false);
  captured.onStatus?.(true);
  await flushPromises();
  expect(spy).toHaveBeenCalled();
});
