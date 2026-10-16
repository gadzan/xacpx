import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

const disconnect = vi.fn();
const captured: { onEvent?: (e: unknown) => void; onStatus?: (online: boolean) => void } = {};
vi.mock("../api/events", () => ({
  connectEvents: (onEvent: (e: unknown) => void, onStatus?: (online: boolean) => void) => {
    captured.onEvent = onEvent;
    captured.onStatus = onStatus;
    return disconnect;
  },
  sendSubscribe: vi.fn(),
  sendWebClientMessage: vi.fn(),
  isRetryableTerminalError: () => false,
  TerminalRequestError: class extends Error {},
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import DashboardView from "../views/DashboardView.vue";
import { useChatStore } from "../stores/chat";
import { triggerNotificationClick } from "../lib/local-notification";

const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, TerminalTab: true, "router-link": true };

const capableInstance = {
  id: "i1",
  name: "pc",
  online: true,
  lastSeenAt: null,
  capabilities: [RELAY_CAPABILITIES.terminalRmuxRecoveryV1, RELAY_CAPABILITIES.terminalMultiViewV1],
};

interface BackTag {
  layer: string;
  id: string;
  depth: number;
}

function isBackTag(value: unknown): value is BackTag {
  return typeof value === "object" && value !== null
    && "layer" in value && typeof value.layer === "string"
    && "id" in value && typeof value.id === "string"
    && "depth" in value && typeof value.depth === "number";
}

function tag(): BackTag | null {
  const state: unknown = window.history.state;
  if (typeof state !== "object" || state === null || !("xacpx" in state)) return null;
  const raw: unknown = state.xacpx;
  return isBackTag(raw) ? raw : null;
}

/** Await the popstate a back-driven action produces (jsdom delivers it on its own task). */
async function backAndSettle(action: () => Promise<void> | void): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.addEventListener("popstate", () => resolve(), { once: true });
  await action();
  await promise;
  await flushPromises();
}

/** Simulate the system back gesture (Android key / iOS swipe). */
async function systemBack(): Promise<void> {
  await backAndSettle(() => window.history.back());
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
  captured.onEvent = undefined;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [capableInstance] }), { status: 200 })));
});

function mountDash() {
  return mount(DashboardView, { global: { stubs } });
}

async function selectSession(alias = "demo") {
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = alias;
  await flushPromises();
}

describe("mobile back navigation", () => {
  test("entering a session pushes one pane entry; ← pops it and returns home", async () => {
    const wrapper = mountDash();
    await flushPromises();
    expect(tag()).toBeNull(); // home owns no entry of its own

    await selectSession();
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });

    await backAndSettle(() => wrapper.find('[data-test="mobile-back"]').trigger("click"));
    expect(tag()).toBeNull();
    expect(useChatStore().instanceId).toBeNull();
    expect(wrapper.find('[data-test="fab-new-session"]').exists()).toBe(true);
  });

  test("opening and closing an overlay N times leaves no dead entry; one back returns home", async () => {
    const wrapper = mountDash();
    await flushPromises();
    await selectSession();

    for (let i = 0; i < 3; i++) {
      await wrapper.find('[data-test="mobile-more"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(true);
      expect(tag()?.layer).toBe("modal");
      const depth = tag()!.depth;
      // Close through the sheet's own X: the entry is popped, not left behind.
      await backAndSettle(() => wrapper.find('[data-test="sheet-close"]').trigger("click"));
      expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(false);
      expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });
      expect(depth).toBe(2);
    }

    await backAndSettle(() => wrapper.find('[data-test="mobile-back"]').trigger("click"));
    expect(tag()).toBeNull();
    expect(useChatStore().instanceId).toBeNull();
  });

  test("an overlay stacked on a full-screen layer closes one layer per back", async () => {
    const wrapper = mountDash();
    await flushPromises();
    await selectSession();

    // Full-screen layer: the files drawer opened from the ⋯ sheet.
    await wrapper.find('[data-test="mobile-more"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="sheet-files"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-drawer="right"]').classes()).toContain("translate-x-0");
    expect(tag()).toEqual({ layer: "full", id: "right", depth: 2 });

    // Overlay on top of it.
    await wrapper.find('[data-test="mobile-more"]').trigger("click");
    await flushPromises();
    expect(tag()?.layer).toBe("modal");
    expect(tag()?.depth).toBe(3);

    await systemBack();
    expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(false);
    expect(wrapper.find('[data-drawer="right"]').classes()).toContain("translate-x-0");
    expect(tag()).toEqual({ layer: "full", id: "right", depth: 2 });

    await systemBack();
    expect(wrapper.find('[data-drawer="right"]').classes()).toContain("translate-x-full");
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });

    await systemBack();
    expect(tag()).toBeNull();
    expect(useChatStore().instanceId).toBeNull();
  });

  test("sheet over sheet: the first back closes only the top sheet", async () => {
    const wrapper = mountDash();
    await flushPromises();
    await selectSession();

    await wrapper.find('[data-test="mobile-more"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="sheet-open-tabs"]').trigger("click");
    await flushPromises();
    // The tabs sheet REPLACED the ⋯ sheet (same kind): still one entry.
    expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="open-tabs-sheet"]').exists()).toBe(true);
    expect(tag()).toEqual({ layer: "modal", id: "open-tabs-sheet", depth: 2 });

    await systemBack();
    expect(wrapper.find('[data-test="open-tabs-sheet"]').exists()).toBe(false);
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });
  });

  test("deep-link cold start claims a home entry below the pane, so ← returns home", async () => {
    window.history.replaceState({}, "", "/?instanceId=i1&sessionAlias=demo");
    const wrapper = mountDash();
    await flushPromises();
    // The deep link opened the session and cleared the query.
    expect(window.location.search).toBe("");
    expect(useChatStore().sessionAlias).toBe("demo");
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });

    await backAndSettle(() => wrapper.find('[data-test="mobile-back"]').trigger("click"));
    expect(tag()).toBeNull();
    expect(useChatStore().instanceId).toBeNull();
    expect(window.location.search).toBe("");
  });

  test("a notification click switches target with replace, so one back returns home", async () => {
    // jsdom does not implement window.focus, which the notification path calls.
    vi.spyOn(window, "focus").mockImplementation(() => {});
    const wrapper = mountDash();
    await flushPromises();
    await selectSession("demo");
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });

    triggerNotificationClick("i1", "other");
    await flushPromises();
    expect(useChatStore().sessionAlias).toBe("other");
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::other", depth: 1 });

    await backAndSettle(() => wrapper.find('[data-test="mobile-back"]').trigger("click"));
    expect(tag()).toBeNull();
    expect(useChatStore().instanceId).toBeNull();
    expect(wrapper.find('[data-test="fab-new-session"]').exists()).toBe(true);
  });

  test("a refresh on a modal entry silently returns to the pane entry", async () => {
    const wrapper = mountDash();
    await flushPromises();
    await selectSession();
    await wrapper.find('[data-test="mobile-more"]').trigger("click");
    await flushPromises();
    expect(tag()?.layer).toBe("modal");

    // Reload semantics: the sheet is gone, the pane selection is restored.
    wrapper.unmount();
    await flushPromises();
    const fresh = mountDash();
    await flushPromises();
    await selectSession();
    await systemBack();
    expect(tag()).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });
    expect(fresh.find('[data-test="mobile-session-bar"]').exists()).toBe(true);
  });

  test("desktop adds no entries at all", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(min-width: 1024px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const wrapper = mountDash();
    await flushPromises();
    await selectSession();
    await wrapper.find('[data-test="mobile-more"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="mobile-more-sheet"]').exists()).toBe(true);
    expect(tag()).toBeNull();
    vi.unstubAllGlobals();
  });

  test("popstate does not remount the dashboard", async () => {
    let mounts = 0;
    const counting = { name: "ChatPane", setup() { mounts++; }, template: "<div/>" };
    const wrapper = mount(DashboardView, {
      global: { stubs: { ...stubs, ChatPane: counting } },
    });
    await flushPromises();
    await selectSession();
    expect(mounts).toBe(1);

    await systemBack();
    expect(mounts).toBe(1);
    expect(useChatStore().instanceId).toBeNull();
  });
});
