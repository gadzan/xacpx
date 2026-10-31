// Sidebar visual treatment: the raised selected row, the segmented mode control,
// and the sidebar brand / footer split with the global header.
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";

vi.mock("../api/events", () => ({
  connectEvents: () => () => {},
  sendSubscribe: vi.fn(),
  sendWebClientMessage: vi.fn(),
  isRetryableTerminalError: () => false,
  TerminalRequestError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

import InstanceTree from "../components/InstanceTree.vue";
import DashboardView from "../views/DashboardView.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";

const BOT: BotSummaryDto = {
  id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo",
  enabled: true, updatedAt: "now", profileRevision: 1,
};
// DashboardView uses useRouter() (the back stack); stub it so no real router
// is needed.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const GROUP: GroupSummaryDto = {
  id: "conversation_g", kind: "group", title: "Release Team",
  botIds: ["bot_a"], leadBotId: "bot_a", createdAt: "now", updatedAt: "now",
};

function seedInstance(): void {
  useInstancesStore().instances = [
    {
      id: "i1", name: "pc", online: true, lastSeenAt: null,
      sessions: [
        { alias: "backend", agent: "codex", workspace: "repo", transportSession: "t1", running: false, archived: false },
        { alias: "frontend", agent: "codex", workspace: "repo", transportSession: "t2", running: false, archived: false },
      ],
      sessionsLoaded: true,
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "repo", cwd: "/repo" }],
      agentCatalog: [],
    } as never,
  ];
}

/** The element that carries the raised treatment, searched in the row INCLUDING
 *  its root (the bot / group / session rows all paint the raised background on
 *  the row itself, outside the session row's swipe clip layer). */
function raisedElement(row: { element: Element; findAll: (s: string) => Array<{ classes: () => string[] }> }): boolean {
  const root = row.element as HTMLElement;
  if (root.classList.contains("bg-raised") && root.classList.contains("shadow-select")) return true;
  return row.findAll("*").some((el) => {
    const cls = el.classes();
    return cls.includes("bg-raised") && cls.includes("shadow-select");
  });
}

describe("sidebar selection treatment", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders a selected session row as a raised card with no accent stripe", async () => {
    seedInstance();
    useChatStore().select("i1", "backend");
    const w = mount(InstanceTree);
    await flushPromises();

    const rows = w.findAll('[data-test="session-row"]');
    const selected = rows.find((r) => r.find('[data-test="session-name"]').text() === "backend");
    expect(selected).toBeDefined();
    // Raised card treatment.
    expect(raisedElement(selected!)).toBe(true);
    // No stripe: neither the row nor anything inside it carries a left border.
    const all = [selected!.element as HTMLElement, ...Array.from(selected!.element.querySelectorAll("*"))];
    expect(all.some((el) => el.classList.contains("border-l"))).toBe(false);
    // The name is emphasized, not blue.
    const name = selected!.find('[data-test="session-name"]');
    expect(name.classes()).toContain("font-semibold");
    expect(name.classes()).toContain("text-fg");
    expect(name.classes()).not.toContain("text-accent");

    // An unselected row keeps only the translucent hover fill.
    const other = rows.find((r) => r.find('[data-test="session-name"]').text() === "frontend");
    expect(other).toBeDefined();
    expect(other!.findAll("*").some((el) => el.classes().includes("bg-raised"))).toBe(false);
  });

  it("renders a selected bot row as a raised card", async () => {
    seedInstance();
    const direct = useDirectBotsStore();
    direct.botsByInstance["i1"] = [BOT];
    direct.botsLoaded["i1"] = true;
    direct.instanceId = "i1";
    direct.selectedBotId = BOT.id;

    const w = mount(InstanceTree);
    await flushPromises();
    await w.find('[data-test="instance-nav-bots"]').trigger("click");
    await flushPromises();

    const row = w.find('[data-test="bot-row"]');
    expect(row.exists()).toBe(true);
    expect(raisedElement(row)).toBe(true);
    const name = row.find('[data-test="bot-name"]');
    expect(name.classes()).toContain("font-semibold");
    expect(name.classes()).toContain("text-fg");
    expect(name.classes()).not.toContain("text-accent");
  });

  it("renders a selected group row as a raised card", async () => {
    seedInstance();
    const groups = useGroupsStore();
    groups.groupsByInstance["i1"] = [GROUP];
    groups.groupsLoaded["i1"] = true;
    groups.instanceId = "i1";
    groups.selectedGroupId = GROUP.id;

    const w = mount(InstanceTree);
    await flushPromises();
    await w.find('[data-test="instance-nav-groups"]').trigger("click");
    await flushPromises();

    const row = w.find('[data-test="group-row"]');
    expect(row.exists()).toBe(true);
    expect(raisedElement(row)).toBe(true);
    const name = row.find('[data-test="group-name"]');
    expect(name.classes()).toContain("font-semibold");
    expect(name.classes()).toContain("text-fg");
    expect(name.classes()).not.toContain("text-accent");
  });
});

describe("sidebar mode segmented control", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders a track with a raised selected segment", async () => {
    seedInstance();
    const w = mount(InstanceTree);
    await flushPromises();

    const track = w.find('[data-test="instance-nav-track"]');
    expect(track.exists()).toBe(true);
    // The track is a visible recessed fill, not a bare flex row.
    expect(track.classes()).toContain("bg-fill-track");
    expect(track.classes()).toContain("rounded-btn");
    expect(track.classes()).toContain("p-0.5");

    // The active segment is raised; the others are muted.
    const sessions = w.find('[data-test="instance-nav-sessions"]');
    expect(sessions.classes()).toContain("bg-raised");
    expect(sessions.classes()).toContain("shadow-press");
    expect(sessions.classes()).toContain("font-semibold");
    expect(sessions.classes()).toContain("text-fg");
    expect(sessions.classes()).not.toContain("bg-accent-soft");
    // 6px segment (rounded-sm) inside the 8px track's 2px padding, 24px tall.
    expect(sessions.classes()).toContain("rounded-sm");
    expect(sessions.classes()).toContain("h-6");
    const bots = w.find('[data-test="instance-nav-bots"]');
    expect(bots.classes()).toContain("text-fg-muted");
    expect(bots.classes()).toContain("hover:bg-fill-hover");
    expect(bots.classes()).not.toContain("bg-raised");

    // Switching the mode moves the raised segment.
    await bots.trigger("click");
    await flushPromises();
    expect(w.find('[data-test="instance-nav-bots"]').classes()).toContain("bg-raised");
    expect(w.find('[data-test="instance-nav-sessions"]').classes()).not.toContain("bg-raised");
  });
});

describe("sidebar brand and footer", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
  });

  it("moves the brand, theme toggle and settings link into the sidebar on desktop", async () => {
    const w = mount(DashboardView, { global: { stubs: { ChatPane: true, "router-link": true } } });
    await flushPromises();

    // The sidebar carries the brand block.
    const brand = w.find('[data-test="sidebar-brand"]');
    expect(brand.exists()).toBe(true);
    expect(brand.find('[data-test="brand-x"]').exists()).toBe(true);

    // ...and a footer with the theme toggle and the settings link.
    const footer = w.find('[data-test="sidebar-footer"]');
    expect(footer.exists()).toBe(true);
    expect(footer.classes()).toContain("border-t");
    expect(footer.find('[data-test="sidebar-theme-toggle"]').exists()).toBe(true);
    expect(footer.find('[data-test="sidebar-settings-link"]').exists()).toBe(true);

    // The global header keeps them for mobile only, so they are not duplicated
    // on desktop.
    const headerToggle = w.find('[data-test="theme-toggle"]');
    expect(headerToggle.exists()).toBe(true);
    expect(headerToggle.classes()).toContain("lg:hidden");
    const headerSettings = w.find('[data-test="settings-link"]');
    expect(headerSettings.exists()).toBe(true);
    expect(headerSettings.classes()).toContain("lg:hidden");

    // The global search trigger and the terminal / desktop toggles stay in the
    // desktop header.
    expect(w.find('[data-test="global-search"]').exists()).toBe(true);
    expect(w.find('[data-test="toggle-terminal"]').exists()).toBe(true);
  });

  it("keeps the global search trigger at 48px on mobile", async () => {
    const w = mount(DashboardView, { global: { stubs: { ChatPane: true, "router-link": true } } });
    await flushPromises();
    const search = w.find('[data-test="global-search"]');
    expect(search.classes()).toContain("h-12");
    expect(search.classes()).toContain("lg:h-8");
  });
});
