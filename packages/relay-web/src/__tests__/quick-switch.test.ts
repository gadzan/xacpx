import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";

// The WS client is stubbed so jsdom needs no real socket.
vi.mock("../api/events", () => ({
  connectEvents: () => () => {},
  sendSubscribe: vi.fn(),
  sendWebClientMessage: vi.fn(),
  isRetryableTerminalError: () => false,
  TerminalRequestError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
// The back stack writes its history entries through the router, so the stub has to
// touch the real history: push adds an entry, replace overwrites the current one.
vi.mock("vue-router", () => ({ useRouter: () => ({
  push: (to: { path?: string; state?: Record<string, unknown> }) => window.history.pushState(to.state ?? {}, "", to.path ?? window.location.pathname),
  replace: (to: { path?: string; state?: Record<string, unknown> }) => window.history.replaceState(to.state ?? {}, "", to.path ?? window.location.pathname),
}) }));

import DashboardView from "../views/DashboardView.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";

const stubs = { ChatPane: true, FileViewer: true, TaskPanel: true, TerminalTab: true, "router-link": true };

function session(alias: string, agent = "codex") {
  return { alias, agent, driver: agent, workspace: "/w", transportSession: `t-${alias}`, running: false, archived: false };
}
function bot(id: string, name: string, extra: Partial<BotSummaryDto> = {}): BotSummaryDto {
  return { id, name, agent: "codex", workspace: "repo", enabled: true, updatedAt: "now", profileRevision: 1, ...extra };
}
function group(id: string, title: string, botIds: string[] = ["bot_a"]): GroupSummaryDto {
  return { id, kind: "group", title, botIds, leadBotId: botIds[0], createdAt: "now", updatedAt: "now" };
}

function seedInstance(opts: { sessions?: number } = {}) {
  const count = opts.sessions ?? 2;
  useInstancesStore().instances = [
    {
      id: "i1", name: "pc", online: true, lastSeenAt: null,
      sessions: [
        session("demo"),
        ...Array.from({ length: Math.max(0, count - 1) }, (_, i) => session(`extra-${i}`)),
      ],
      sessionsLoaded: true,
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [], agentCatalog: [],
    },
  ] as never;
  useDirectBotsStore().botsByInstance = { i1: [bot("bot_a", "Reviewer"), bot("bot_b", "Planner", { role: "planner" })] };
  useGroupsStore().groupsByInstance = { i1: [group("conversation_g", "Release Team")] };
}

function mountDash(): VueWrapper {
  return mount(DashboardView, { global: { stubs } });
}

/** The conversation page's title is the quick-switch trigger. */
async function openQuickSwitch(wrapper: VueWrapper) {
  await wrapper.find('[data-test="mobile-session-title"]').trigger("click");
  await flushPromises();
}

/** Await the history traversal a back-driven close produced. jsdom delivers
 *  history.back()'s popstate on its own task, so a microtask flush alone is not
 *  enough — await the event itself, like the dashboard's own back tests do. */
async function withBack(action: () => void): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.addEventListener("popstate", () => resolve(), { once: true });
  action();
  await promise;
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, "");
  // jsdom has no matchMedia: the dashboard reads it for the lg breakpoint, so the
  // default (mobile) is "no matchMedia at all" — absent means "not desktop".
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
});

test("tapping the conversation title opens the quick-switch sheet below lg", async () => {
  const wrapper = mountDash();
  await flushPromises();
  seedInstance();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();

  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(false);
  await openQuickSwitch(wrapper);
  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(true);
  // The sheet is a modal layer of its own (it owns a history entry for ← / iOS swipe).
  expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
});

test("the sheet lists conversations, bots and groups of the current instance", async () => {
  const wrapper = mountDash();
  await flushPromises();
  seedInstance();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();

  await openQuickSwitch(wrapper);
  const sheet = wrapper.find('[data-test="quick-switch-sheet"]');

  // Three sections, in order: conversations, then bots, then groups.
  expect(sheet.find('[data-test="quick-switch-sessions-title"]').exists()).toBe(true);
  expect(sheet.find('[data-test="quick-switch-bots-title"]').exists()).toBe(true);
  expect(sheet.find('[data-test="quick-switch-groups-title"]').exists()).toBe(true);

  // The current instance's data.
  expect(sheet.findAll('[data-test="quick-switch-session-row"]')).toHaveLength(2);
  expect(sheet.find('[data-test="quick-switch-session-name"]').text()).toBe("demo");
  expect(sheet.findAll('[data-test="quick-switch-bot-row"]')).toHaveLength(2);
  expect(sheet.find('[data-test="quick-switch-bot-name"]').text()).toBe("Reviewer");
  expect(sheet.findAll('[data-test="quick-switch-group-row"]')).toHaveLength(1);
  expect(sheet.find('[data-test="quick-switch-group-name"]').text()).toBe("Release Team");

  // Touch targets: conversations 52px, the compact bot / group rows 46px.
  expect(sheet.find('[data-test="quick-switch-session-row"]').classes()).toContain("min-h-[52px]");
  expect(sheet.find('[data-test="quick-switch-bot-row"]').classes()).toContain("min-h-[46px]");
  expect(sheet.find('[data-test="quick-switch-group-row"]').classes()).toContain("min-h-[46px]");

  // The selected row carries the accent text check and a soft accent background —
  // and no left colour bar.
  const selected = sheet.findAll('[data-test="quick-switch-session-row"]')[0]!;
  expect(selected.classes()).toContain("bg-accent-soft");
  expect(selected.html()).toContain("text-accent-text");
  expect(selected.classes().some((c) => c.includes("border-l") || c.includes("border-r-"))).toBe(false);
});

test("picking a conversation row switches to it and closes the sheet", async () => {
  const wrapper = mountDash();
  await flushPromises();
  seedInstance();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();

  await openQuickSwitch(wrapper);
  const rows = wrapper.findAll('[data-test="quick-switch-session-row"]');
  expect(rows).toHaveLength(2);
  // Picking a row switches to it and closes the sheet through the back stack.
  await withBack(() => { void rows[1]!.trigger("click"); });

  expect(chat.instanceId).toBe("i1");
  expect(chat.sessionAlias).toBe("extra-0");
  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(false);
  // Closed once: the sheet is gone and stays gone.
  await flushPromises();
  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(false);
});

test("Escape closes the quick-switch sheet", async () => {
  const wrapper = mountDash();
  await flushPromises();
  seedInstance();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();

  await openQuickSwitch(wrapper);
  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(true);

  await withBack(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(false);
  // The conversation itself is untouched — only the sheet closed.
  expect(chat.sessionAlias).toBe("demo");
});

test("a section with more than eight rows grows a filter field that narrows the rows", async () => {
  const wrapper = mountDash();
  await flushPromises();
  seedInstance({ sessions: 10 });
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();

  await openQuickSwitch(wrapper);
  const sheet = wrapper.find('[data-test="quick-switch-sheet"]');
  // The conversation section outgrew the threshold → it gets its own filter.
  expect(sheet.find('[data-test="quick-switch-sessions-search"]').exists()).toBe(true);
  // The short sections do not.
  expect(sheet.find('[data-test="quick-switch-bots-search"]').exists()).toBe(false);
  expect(sheet.find('[data-test="quick-switch-groups-search"]').exists()).toBe(false);
  // The filter is 44px tall with 16px text.
  const field = sheet.find('[data-test="quick-switch-sessions-search"]');
  expect(field.classes()).toContain("text-base");
  expect(field.element.closest("div")!.className.split(/\s+/)).toContain("min-h-[44px]");
  // No keyboard focus steal on open: the field exists but is not focused.
  expect(document.activeElement).not.toBe(field.element);

  await field.setValue("extra-3");
  const rows = sheet.findAll('[data-test="quick-switch-session-row"]');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.attributes("data-alias")).toBe("extra-3");
});

test("on desktop the title tap does not open the quick-switch sheet", async () => {
  // lg and up: the sidebar is the navigation surface, so the title tap is inert.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener() {}, removeEventListener() {},
  }));
  const wrapper = mountDash();
  await flushPromises();
  seedInstance();
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "demo";
  await flushPromises();

  await wrapper.find('[data-test="mobile-session-title"]').trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-test="quick-switch-sheet"]').exists()).toBe(false);
  vi.unstubAllGlobals();
});
