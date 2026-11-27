// Sidebar visual treatment: the raised selected row, the segmented mode control,
// and the sidebar brand / footer split with the global header.
import { setActivePinia, createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";

vi.mock("../api/events", () => ({
  connectEvents: () => () => {},
  subscribeWebEvents: () => () => {},
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

function instanceRow(id: string, name: string, alias: string) {
  return {
    id, name, online: true, lastSeenAt: null,
    sessions: [{ alias, agent: "codex", workspace: "repo", transportSession: `${id}-t`, running: false, archived: false }],
    sessionsLoaded: true,
    agents: [{ name: "codex", driver: "codex" }],
    workspaces: [{ name: "repo", cwd: "/repo" }],
    agentCatalog: [],
  };
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
    await w.find('[data-test="instance-nav-bots"]').trigger("click");
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

  it("draws a 32px rail with a 28px raised segment and a 44px hit box", async () => {
    seedInstance();
    const w = mount(InstanceTree);
    await flushPromises();

    const track = w.find('[data-test="instance-nav-track"]');
    expect(track.exists()).toBe(true);
    // The recessed fill is the rail, not the row: on a coarse pointer the row
    // takes real 44px layout space while the rail keeps its 32px height.
    const rail = w.find('[data-test="instance-nav-rail"]');
    expect(rail.classes()).toContain("bg-fill-track");
    expect(rail.classes()).toContain("rounded-btn");
    expect(rail.classes()).toContain("h-8");
    expect(track.classes()).toContain("[@media(pointer:coarse)]:h-11");
    // Uniform 2px visual inset: 2 + 28 + 2 vertically, 2px left/right for the
    // first and last pill. The padding lives on the track's content box, so the
    // halves are computed after it — never with a negative margin.
    expect(track.classes()).toContain("px-0.5");
    expect(track.classes()).not.toContain("-mx-0.5");
    // The two segments are adjacent: the sliding indicator supplies the
    // separation a gap used to, so the halves are exactly half the content box.
    expect(track.classes()).not.toContain("gap-0.5");

    // The active segment is a raised 28px pill inside the 44px button.
    const sessions = w.find('[data-test="instance-nav-sessions"]');
    expect(sessions.classes()).toContain("h-7");
    expect(sessions.classes()).toContain("[@media(pointer:coarse)]:h-11");
    expect(sessions.classes()).toContain("font-semibold");
    expect(sessions.classes()).toContain("text-fg");
    // The 44 hit box stays unpainted: the raised fill is only the 28px pill.
    for (const bg of ["bg-raised", "bg-surface", "bg-bg"]) expect(sessions.classes()).not.toContain(bg);

    // The selected fill is ONE sliding indicator under both segments — the
    // segments themselves stay unpainted, so switching modes moves the fill
    // instead of swapping two backgrounds.
    const indicator = w.find('[data-test="instance-nav-indicator"]');
    expect(indicator.classes()).toEqual(expect.arrayContaining([
      "bg-raised", "shadow-press", "rounded-sm", "h-7",
      "transition-transform", "duration-150", "ease-ui", "motion-reduce:transition-none",
    ]));
    expect(indicator.classes()).toContain("translate-x-0");
    expect(indicator.classes()).toContain("w-[calc(50%_-_2px)]"); // half the content box

    const sessionsPill = sessions.find('[data-test="instance-nav-pill"]');
    expect(sessionsPill.classes()).toContain("rounded-sm");
    expect(sessionsPill.classes()).toContain("h-7");
    expect(sessionsPill.classes()).not.toContain("bg-raised");
    expect(sessionsPill.classes()).not.toContain("bg-accent-soft");

    const bots = w.find('[data-test="instance-nav-bots"]');
    expect(bots.classes()).toContain("text-fg-muted");
    const botsPill = bots.find('[data-test="instance-nav-pill"]');
    expect(botsPill.classes()).toContain("hover:bg-fill-hover");
    expect(botsPill.classes()).not.toContain("bg-raised");

    // Picking a segment slides the one indicator; no pill box ever moves.
    for (const mode of ["instance-nav-sessions", "instance-nav-bots"]) {
      await w.find(`[data-test="${mode}"]`).trigger("click");
      await flushPromises();
      expect(w.find('[data-test="instance-nav-indicator"]').classes())
        .toContain(mode === "instance-nav-bots" ? "translate-x-full" : "translate-x-0");
      for (const segment of ["instance-nav-sessions", "instance-nav-bots"]) {
        const button = w.find(`[data-test="${segment}"]`);
        const pill = button.find('[data-test="instance-nav-pill"]');
        expect(pill.classes()).toContain("h-7");
        expect(button.classes().concat(pill.classes()).some((c) => c.includes("translate"))).toBe(false);
      }
    }
  });

  it("switches every instance card from the one global track", async () => {
    const instances = useInstancesStore();
    instances.instances = [instanceRow("i1", "pc-one", "backend"), instanceRow("i2", "pc-two", "frontend")] as never;
    const direct = useDirectBotsStore();
    direct.botsByInstance["i1"] = [{ ...BOT, name: "Reviewer" }];
    direct.botsByInstance["i2"] = [{ ...BOT, id: "bot_b", name: "Builder" }];
    direct.botsLoaded["i1"] = true;
    direct.botsLoaded["i2"] = true;

    const w = mount(InstanceTree);
    await flushPromises();

    // One tab row for the whole sidebar, however many instances render.
    expect(w.findAll('[data-test="instance-nav-track"]')).toHaveLength(1);
    expect(w.findAll('[data-test="session-row"]').map((r) => r.find('[data-test="session-name"]').text()))
      .toEqual(["backend", "frontend"]);

    await w.find('[data-test="instance-nav-bots"]').trigger("click");
    await flushPromises();
    expect(w.findAll('[data-test="bot-name"]').map((n) => n.text())).toEqual(["Reviewer", "Builder"]);
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(0);

    await w.find('[data-test="instance-nav-sessions"]').trigger("click");
    await flushPromises();
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(2);
  });
});

describe("sidebar brand and footer", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A 1280px viewport: DashboardView reads `(min-width: 1024px)` for `isDesktop`. */
  function stubDesktopViewport(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  }

  it("keeps exactly one brand and only the theme / settings entries in the sidebar", async () => {
    const w = mount(DashboardView, { global: { stubs: { ChatPane: true, "router-link": true } } });
    await flushPromises();

    // Below lg there is no sidebar head, so the bar carries the one brand.
    const brands = w.findAll('[data-test="global-brand"]');
    expect(brands).toHaveLength(1);
    expect(w.find('[data-test="global-bar"] [data-test="global-brand"]').exists()).toBe(true);
    expect(brands[0]!.find('[data-test="brand-x"]').exists()).toBe(true);
    expect(w.find('[data-test="sidebar-brand"]').exists()).toBe(false);

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

    expect(w.find('[data-test="global-search"]').exists()).toBe(true);
    expect(w.find('[data-test="toggle-terminal"]').exists()).toBe(true);
  });

  it("moves the brand into the sidebar head on desktop and back into the bar when the sidebar collapses", async () => {
    stubDesktopViewport();
    const w = mount(DashboardView, { global: { stubs: { ChatPane: true, "router-link": true } } });
    await flushPromises();

    const sidebar = () => w.find('[data-test="column"][data-drawer="left"]');
    // One brand in the whole document, and on desktop it lives in the sidebar.
    expect(w.findAll('[data-test="global-brand"]')).toHaveLength(1);
    expect(sidebar().find('[data-test="global-brand"]').exists()).toBe(true);
    expect(w.find('[data-test="global-bar"] [data-test="global-brand"]').exists()).toBe(false);

    // Collapsing the sidebar hands the brand back to the bar: the mark never
    // disappears and never exists twice.
    await w.find('[data-test="toggle-left"]').trigger("click");
    await flushPromises();
    expect(w.findAll('[data-test="global-brand"]')).toHaveLength(1);
    expect(w.find('[data-test="global-bar"] [data-test="global-brand"]').exists()).toBe(true);
    expect(sidebar().find('[data-test="global-brand"]').exists()).toBe(false);
  });

  it("keeps the global search trigger at 48px on mobile", async () => {
    const w = mount(DashboardView, { global: { stubs: { ChatPane: true, "router-link": true } } });
    await flushPromises();
    const search = w.find('[data-test="global-search"]');
    expect(search.classes()).toContain("h-12");
    expect(search.classes()).toContain("lg:h-8");
  });
});
