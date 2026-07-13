// packages/relay-web/src/__tests__/dashboard.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Stub the WS client so jsdom needs no real socket.
// Capture the (onEvent, onStatus) callbacks so tests can drive reconnects.
const disconnect = vi.fn();
const captured: { onEvent?: (e: unknown) => void; onStatus?: (online: boolean) => void } = {};
// `sendSubscribe` is read directly (not inside a deferred closure) when the
// factory below builds its returned object, so — unlike `disconnect`, which is
// only touched later inside a nested arrow function — it must be produced via
// `vi.hoisted` to avoid a TDZ ReferenceError against the hoisted `vi.mock` call.
const { sendSubscribe } = vi.hoisted(() => ({ sendSubscribe: vi.fn() }));
vi.mock("../api/events", () => ({
  connectEvents: (onEvent: (e: unknown) => void, onStatus?: (online: boolean) => void) => {
    captured.onEvent = onEvent;
    captured.onStatus = onStatus;
    return disconnect;
  },
  sendSubscribe,
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
  sendSubscribe.mockClear();
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

test("subscribes to the active instance on connect and on instance change", async () => {
  const chat = useChatStore();
  const loadActiveTurns = vi.spyOn(chat, "loadActiveTurns").mockResolvedValue(undefined);
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();

  // On connect, with no instance selected yet, subscribe to the empty set.
  captured.onStatus?.(true);
  expect(sendSubscribe).toHaveBeenLastCalledWith([]);

  // Clear the mount-time loadActiveTurns call (onMounted seeds it once) so the assertion below
  // isolates the SWITCH-triggered re-seed — otherwise the check passes even if the watch's
  // loadActiveTurns call were reverted.
  loadActiveTurns.mockClear();

  // Selecting an instance re-scopes the socket to it, and re-seeds any in-flight turns that
  // were dropped for this socket while it was subscribed elsewhere (loadActiveTurns is the
  // global in-flight snapshot — the real self-heal on switch).
  chat.select("iA", "backend");
  await flushPromises();
  expect(sendSubscribe).toHaveBeenLastCalledWith(["iA"]);
  expect(loadActiveTurns).toHaveBeenCalledTimes(1);
});
