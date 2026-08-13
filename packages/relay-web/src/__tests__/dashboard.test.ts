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

// DashboardView now uses useRouter()/<router-link>; mock to avoid a real router.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Dashboard imports InstanceTree -> AgentIcon at module evaluation time. Stub the raw
// SVG catalog so this behavioral suite does not depend on Windows being able to open
// every optional @lobehub icon file (some hosts return EPERM for openclaw-color.svg).
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

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

test("mount auto-loads sessions for every online instance without user action", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : String(input);
    const body = url.includes("/rpc")
      ? { result: { sessions: [], hasMore: false } }
      : { instances: [
        { id: "i1", name: "pc", online: true, lastSeenAt: null },
        { id: "i2", name: "off", online: false, lastSeenAt: null },
      ] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();
  const store = useInstancesStore();
  // No "load sessions" click needed: the online instance's list loads on entry.
  expect(store.byId("i1")!.sessionsLoaded).toBe(true);
  expect(store.byId("i2")!.sessionsLoaded).toBe(false);
});

test("reconnect snapshot re-pull auto-loads sessions for online instances", async () => {
  // Instance is OFFLINE at mount, so the initial auto-load skips it; it comes online
  // only after a drop/reconnect cycle, and the re-pull must load it without user action.
  let online = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : String(input);
    const body = url.includes("/rpc")
      ? { result: { sessions: [], hasMore: false } }
      : { instances: [{ id: "i1", name: "pc", online, lastSeenAt: null }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();
  const store = useInstancesStore();
  expect(store.byId("i1")!.sessionsLoaded).toBe(false);

  online = true;
  // A real socket fires open-status on connect; everOnline gates the re-pull on it.
  captured.onStatus?.(true);
  captured.onStatus?.(false);
  captured.onStatus?.(true);
  await flushPromises();
  expect(store.byId("i1")!.sessionsLoaded).toBe(true);
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

test("subscribes to every owned instance and does not start an HTTP active-turn race", async () => {
  const chat = useChatStore();
  const loadActiveTurns = vi.spyOn(chat, "loadActiveTurns").mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    instances: [
      { id: "iA", name: "A", online: false, lastSeenAt: null },
      { id: "iB", name: "B", online: false, lastSeenAt: null },
    ],
  }), { status: 200 })));
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();

  captured.onStatus?.(true);
  expect(sendSubscribe).toHaveBeenLastCalledWith(["iA", "iB"]);
  expect(loadActiveTurns).not.toHaveBeenCalled();
});

test("re-subscribes on reconnect, not only on the first connect", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    instances: [{ id: "iA", name: "A", online: false, lastSeenAt: null }],
  }), { status: 200 })));
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();

  captured.onStatus?.(true);   // initial connect
  sendSubscribe.mockClear();

  // Drop, then reconnect. onStatus(true) on a RECONNECT must re-send the current subscription so
  // the hub re-scopes the fresh socket — otherwise a reconnected client silently receives every
  // instance's control-events (or none). A mutation that subscribed only on the first connect
  // would leave sendSubscribe uncalled here.
  captured.onStatus?.(false);
  captured.onStatus?.(true);
  await flushPromises();
  expect(sendSubscribe).toHaveBeenCalledTimes(1);
  expect(sendSubscribe).toHaveBeenLastCalledWith(["iA"]);
});

test("an ordered snapshot for the selected instance reloads completed history", async () => {
  const chat = useChatStore();
  vi.spyOn(chat, "loadActiveTurns").mockResolvedValue(undefined);
  const loadHistory = vi.spyOn(chat, "loadHistory").mockResolvedValue(undefined);
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();

  chat.select("iA", "backend");
  loadHistory.mockClear();
  captured.onEvent?.({ kind: "state-snapshot", instanceId: "iA", turns: [], usage: [], commands: [] });
  await flushPromises();
  expect(loadHistory).toHaveBeenCalledTimes(1);
});

test("an ordered snapshot does not race history against an active selected turn", async () => {
  const chat = useChatStore();
  const loadHistory = vi.spyOn(chat, "loadHistory").mockResolvedValue(undefined);
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();

  chat.select("iA", "backend");
  loadHistory.mockClear();
  captured.onEvent?.({
    kind: "state-snapshot",
    instanceId: "iA",
    turns: [{ instanceId: "iA", sessionAlias: "backend", status: "streaming", startedAt: 1, parts: [{ type: "text", text: "still working" }] }],
    usage: [],
    commands: [],
  });
  await flushPromises();
  expect(loadHistory).not.toHaveBeenCalled();
  expect(chat.streaming).toBe("still working");
});
