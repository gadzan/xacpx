import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));

import ChatPane from "../components/ChatPane.vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";

// jsdom has no scrollIntoView; the plan panel calls it on update.
(window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { vi.unstubAllGlobals(); roCallback = null; });

// Minimal ResizeObserver stand-in: captures the callback so tests drive widths by hand.
// Unlike a real RO it does NOT auto-report the initial size on observe() — every width
// change must come from an explicit resize() call.
let roCallback: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
const roDisconnect = vi.fn();
class FakeRO {
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) { roCallback = cb; }
  observe() {}
  disconnect() { roDisconnect(); }
}

function seedInstance(sessions: unknown[] = [{ alias: "backend", agent: "codex", workspace: "gaia" }]) {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions, agents: [], workspaces: [], agentCatalog: [],
  } as never);
}

function seedPlan(chat: ReturnType<typeof useChatStore>) {
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "plan", sessionAlias: "backend",
    entries: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }],
  } } as never);
}

async function resize(w: ReturnType<typeof mount>, width: number) {
  roCallback?.([{ contentRect: { width } }]);
  await w.vm.$nextTick();
}

it("keeps the plan panel in the composer when ResizeObserver is unavailable (jsdom fallback)", async () => {
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  seedPlan(chat);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  expect(w.find('[data-test="plan-side-col"]').exists()).toBe(false);
  expect(w.find('[data-test="composer-area"] [data-test="plan-panel"]').exists()).toBe(true);
});

it("moves the plan panel to the side column on wide panes and back on narrow ones", async () => {
  vi.stubGlobal("ResizeObserver", FakeRO);
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  seedPlan(chat);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  // Wide pane → side column hosts the panel, composer copy disappears.
  await resize(w, 1400);
  const side = w.find('[data-test="plan-side-col"]');
  expect(side.exists()).toBe(true);
  expect(side.find('[data-test="plan-panel"]').exists()).toBe(true);
  expect(w.find('[data-test="composer-area"] [data-test="plan-panel"]').exists()).toBe(false);
  // Narrow pane → back to the composer area.
  await resize(w, 800);
  expect(w.find('[data-test="plan-side-col"]').exists()).toBe(false);
  expect(w.find('[data-test="composer-area"] [data-test="plan-panel"]').exists()).toBe(true);
});

it("preserves the manual expand/collapse state across the placement switch", async () => {
  vi.stubGlobal("ResizeObserver", FakeRO);
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  seedPlan(chat);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  // Inline + not busy → starts collapsed; expand it by hand.
  const toggle = w.find('[data-test="composer-area"] [data-test="plan-toggle"]');
  expect(toggle.attributes("aria-expanded")).toBe("false");
  await toggle.trigger("click");
  expect(w.find('[data-test="composer-area"] [data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
  // Cross into the side column: the remounted panel keeps the expanded state.
  await resize(w, 1400);
  expect(w.find('[data-test="plan-side-col"] [data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
  // And back to inline again.
  await resize(w, 800);
  expect(w.find('[data-test="composer-area"] [data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
});

it("renders no side column on a wide pane when the session has no plan", async () => {
  vi.stubGlobal("ResizeObserver", FakeRO);
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  await resize(w, 1400);
  expect(w.find('[data-test="plan-side-col"]').exists()).toBe(false);
});

it("renders no side column while the session is still booting", async () => {
  vi.stubGlobal("ResizeObserver", FakeRO);
  seedInstance([{ alias: "backend", agent: "codex", workspace: "gaia", transportSession: "", running: false, archived: false, creating: true, creatingSince: Date.now() }]);
  const chat = useChatStore();
  chat.select("i1", "backend");
  seedPlan(chat);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  await resize(w, 1400);
  expect(w.find('[data-test="session-booting"]').exists()).toBe(true);
  expect(w.find('[data-test="plan-side-col"]').exists()).toBe(false);
});

it("disconnects the observer on unmount", async () => {
  vi.stubGlobal("ResizeObserver", FakeRO);
  roDisconnect.mockClear();
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  w.unmount();
  expect(roDisconnect).toHaveBeenCalled();
});
