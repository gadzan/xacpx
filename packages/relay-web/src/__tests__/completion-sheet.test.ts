import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, ConversationCompletions } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { i18n } from "../i18n";
import Input from "../components/ConversationPromptInput.vue";
import GroupComposer from "../components/GroupComposer.vue";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useDirectComposerStore } from "../stores/direct-composer";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";

// The completion selector is an inline popover at lg and a MobileSheet below it.
// The sheet teleports to the body, so its assertions go through document.
const realWidth = window.innerWidth;
let wrappers: VueWrapper[] = [];

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

function ready(scope = { conversationId: "c1", topicId: "t1", botId: "b1" }): ConversationCompletions {
  return {
    version: 1,
    scope,
    revision: "r1",
    commands: {
      status: "ready",
      items: [{ name: "review", description: "adapter" }, { name: "reload" }],
    },
    mentions: {
      status: "ready",
      items: [
        { handle: "agent:n:b2", displayName: "同名", agent: "codex", workspace: "backend" },
        { handle: "agent:n:b3", displayName: "同名", agent: "claude", workspace: "frontend" },
      ],
    },
  };
}

function seedDirect(): void {
  const s = useDirectBotsStore();
  s.instanceId = "i1";
  s.selectedBotId = "b1";
  s.activeConversationId = "c1";
  s.activeTopicId = "t1";
  s.topicReady = true;
  s.botsByInstance.i1 = [
    { id: "b1", name: "A", agent: "codex", workspace: "backend", enabled: true, updatedAt: "now", profileRevision: 1 },
  ];
}

const GROUP_BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];

const GROUP = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: ["bot_a", "bot_b"],
  leadBotId: "bot_a",
  createdAt: "now",
  updatedAt: "now",
} as const;

function seedGroup(): void {
  const instances = useInstancesStore();
  instances.instances = [
    {
      id: "i1",
      name: "Local",
      online: true,
      lastSeenAt: null,
      sessions: [],
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "repo", cwd: "/repo" }],
      agentCatalog: [],
    } as never,
  ];
  vi.spyOn(instances, "loadRouterAvailability").mockResolvedValue(undefined);
  vi.spyOn(instances, "loadJevSettings").mockResolvedValue(undefined);
  const groups = useGroupsStore();
  groups.instanceId = "i1";
  groups.selectedGroupId = "conversation_g";
  groups.activeConversationId = "conversation_g";
  groups.activeTopicId = "topic_1";
  groups.topicReady = true;
  groups.groupsByInstance["i1"] = [GROUP as never];
  groups.groupDetails["i1:conversation_g"] = { ...GROUP, topics: [] } as never;
  groups.topicsByConversation["i1:conversation_g"] = [
    { id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" },
  ] as never;
  useDirectBotsStore().botsByInstance["i1"] = GROUP_BOTS;
}

function mountDirect(): VueWrapper {
  const w = mount(Input, { global: { plugins: [i18n] }, attachTo: document.body });
  wrappers.push(w);
  return w;
}

function mountGroup(): VueWrapper {
  const w = mount(GroupComposer, {
    props: { bots: GROUP_BOTS.filter((b) => b.enabled) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  wrappers.push(w);
  return w;
}

/** Every row offered by the selector, whichever container rendered it. */
function rowClasses(selector: string): string[][] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).map((row) =>
    row.className.split(/\s+/),
  );
}

beforeEach(() => {
  setActivePinia(createPinia());
  seedDirect();
  vi.spyOn(api, "rpc").mockResolvedValue(ready());
});

afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  vi.restoreAllMocks();
  setWidth(realWidth);
  document.body.innerHTML = "";
});

describe("composer completion selector", () => {
  it("renders the selector inside a bottom sheet below lg, with 46px rows", async () => {
    setWidth(390);
    const w = mountDirect();
    const t = w.get("textarea");
    await t.setValue("@");
    await flushPromises();

    const sheet = document.querySelector<HTMLElement>('[data-test="direct-cmd-sheet"]');
    expect(sheet).not.toBeNull();
    // Grab handle + backdrop: the MobileSheet chrome, not a popover.
    expect(document.querySelector('[data-test="sheet-grabber"]')).not.toBeNull();
    expect(document.querySelector('[data-test="sheet-backdrop"]')).not.toBeNull();

    // The listbox (and its hooks) live inside the sheet.
    const listbox = document.querySelector<HTMLElement>('[data-test="direct-cmd-menu"]');
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute("role")).toBe("listbox");
    expect(sheet!.contains(listbox!)).toBe(true);
    // The inline popover branch is not rendered on mobile.
    expect(w.find('[data-test="direct-cmd-menu"]').exists()).toBe(false);

    // Rows are at least 46px tall; the combobox contract is intact.
    const rows = rowClasses('[data-test="direct-cmd-item"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const classes of rows) expect(classes).toContain("min-h-[46px]");
    expect(t.attributes("aria-activedescendant")).toBe("direct-completion-0");
    expect(t.attributes("aria-expanded")).toBe("true");
  });

  it("keeps the inline popover at lg", async () => {
    setWidth(1280);
    const w = mountDirect();
    const t = w.get("textarea");
    await t.setValue("@");
    await flushPromises();

    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).toBeNull();
    expect(document.querySelector('[data-test="sheet-grabber"]')).toBeNull();
    const popover = w.find('[data-test="direct-cmd-menu"]');
    expect(popover.exists()).toBe(true);
    expect(popover.classes()).toContain("absolute");
    const row = w.find('[data-test="direct-cmd-item"]');
    expect(row.classes()).toContain("h-8");
    expect(row.classes()).not.toContain("min-h-[46px]");
  });

  it("picking a sheet row commits the same mention the popover pick does", async () => {
    setWidth(390);
    const w = mountDirect();
    const t = w.get("textarea");
    await t.setValue("@");
    await flushPromises();
    const row = document.querySelectorAll<HTMLElement>('[data-test="direct-cmd-item"]')[0]!;
    expect(row.textContent).toContain("@同名");
    row.click();
    await flushPromises();

    expect((t.element as HTMLTextAreaElement).value).toBe("@同名 ");
    expect(
      useDirectComposerStore().get(JSON.stringify(["i1", "c1", "t1", "b1"])).mentions,
    ).toEqual([{ range: [0, 3], handle: "agent:n:b2" }]);
    // The sheet closed with the pick; the text is committed into the composer.
    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).toBeNull();
  });

  it("picking a popover row produces the identical result at lg", async () => {
    setWidth(1280);
    const w = mountDirect();
    const t = w.get("textarea");
    await t.setValue("@");
    await flushPromises();
    await w.findAll('[data-test="direct-cmd-item"]')[0]!.trigger("click");
    await flushPromises();

    expect((t.element as HTMLTextAreaElement).value).toBe("@同名 ");
    expect(
      useDirectComposerStore().get(JSON.stringify(["i1", "c1", "t1", "b1"])).mentions,
    ).toEqual([{ range: [0, 3], handle: "agent:n:b2" }]);
  });

  it("Escape closes the sheet, keeps the typed text and returns focus", async () => {
    setWidth(390);
    const w = mountDirect();
    const t = w.get("textarea");
    t.element.focus();
    await t.setValue("@");
    await flushPromises();
    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).not.toBeNull();

    await t.trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).toBeNull();
    expect(document.querySelector('[data-test="sheet-backdrop"]')).toBeNull();
    expect((t.element as HTMLTextAreaElement).value).toBe("@");
    expect(document.activeElement).toBe(t.element);
  });

  it("keeps the arrow/Enter keyboard contract inside the sheet", async () => {
    setWidth(390);
    const w = mountDirect();
    const t = w.get("textarea");
    await t.setValue("@");
    await flushPromises();

    // The textarea owns focus and drives the listbox via aria-activedescendant.
    expect(t.attributes("aria-activedescendant")).toBe("direct-completion-0");
    await t.trigger("keydown", { key: "ArrowDown" });
    expect(t.attributes("aria-activedescendant")).toBe("direct-completion-1");
    const active = document.querySelector<HTMLElement>('[data-test="direct-cmd-item"][id="direct-completion-1"]');
    expect(active?.getAttribute("aria-selected")).toBe("true");

    // Enter picks the active row and commits it like the desktop popover does.
    await t.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect((t.element as HTMLTextAreaElement).value).toBe("@同名 ");
    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).toBeNull();
  });

  it("tapping the scrim closes the sheet and keeps the typed text", async () => {
    setWidth(390);
    const w = mountDirect();
    const t = w.get("textarea");
    await t.setValue("@");
    await flushPromises();
    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).not.toBeNull();

    document.querySelector<HTMLElement>('[data-test="sheet-backdrop"]')!.click();
    await flushPromises();

    expect(document.querySelector('[data-test="direct-cmd-sheet"]')).toBeNull();
    expect(document.querySelector('[data-test="sheet-backdrop"]')).toBeNull();
    // The half-typed mention survives the close.
    expect((t.element as HTMLTextAreaElement).value).toBe("@");
  });

  it("the group composer renders its mention list in a sheet below lg", async () => {
    setWidth(390);
    seedGroup();
    const mobile = mountGroup();
    const ta = mobile.get('[data-test="group-composer-textarea"]');
    await ta.setValue("@Te");
    await mobile.vm.$nextTick();

    expect(document.querySelector('[data-test="group-cmd-sheet"]')).not.toBeNull();
    const rows = rowClasses('[data-test="group-mention-item"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const classes of rows) expect(classes).toContain("min-h-[46px]");
    // The inline popover is not also rendered below lg.
    expect(mobile.find('[data-test="group-mention-menu"]').exists()).toBe(false);
  });

  it("the group composer keeps its inline mention list at lg", async () => {
    setWidth(1280);
    seedGroup();
    const desktop = mountGroup();
    const ta = desktop.get('[data-test="group-composer-textarea"]');
    await ta.setValue("@Te");
    await desktop.vm.$nextTick();

    expect(document.querySelector('[data-test="group-cmd-sheet"]')).toBeNull();
    expect(desktop.find('[data-test="group-mention-menu"]').exists()).toBe(true);
    expect(desktop.find('[data-test="group-mention-item"]').classes()).toContain("h-8");
  });
});
