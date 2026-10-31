import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import BotAvatar from "../components/BotAvatar.vue";
import GroupAvatarStack from "../components/GroupAvatarStack.vue";
import InstanceTree from "../components/InstanceTree.vue";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";

function bot(id: string, name: string, extra: Partial<BotSummaryDto> = {}): BotSummaryDto {
  return { id, name, agent: "codex", workspace: "repo", enabled: true, updatedAt: "now", ...extra };
}

/** Each item carries its bot id, so the render order is readable from the DOM. */
const LETTERS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];

function members(count: number): BotSummaryDto[] {
  return Array.from({ length: count }, (_, i) => bot(`bot_${i}`, LETTERS[i % LETTERS.length]!));
}

interface StackProps {
  bots: BotSummaryDto[];
  size: number;
  name: string;
  totalCount: number;
  disabledCount: number;
  leadBotId?: string;
  activityBotIds?: string[];
  decorative?: boolean;
  instanceId?: string;
}

function mountStack(props: Partial<StackProps>): VueWrapper {
  return mount(GroupAvatarStack, {
    props: { bots: [], size: 36, name: "Release Team", totalCount: 0, disabledCount: 0, ...props },
    global: { plugins: [i18n] },
  });
}

function items(wrapper: VueWrapper) {
  return wrapper.findAll('[data-test="group-avatar-item"]');
}

function styleOf(element: DOMWrapper<Element>): string {
  return element.attributes("style") ?? "";
}

function markerText(wrapper: VueWrapper): string {
  return wrapper.find('[data-test="group-avatar-more"]').exists()
    ? wrapper.find('[data-test="group-avatar-more"]').text()
    : "";
}

describe("GroupAvatarStack", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useInstancesStore().instances = [
      { id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true,
        agents: [{ name: "codex", driver: "codex" }], workspaces: [], agentCatalog: [] } as never,
    ];
  });

  it("draws one member as a single circle filling the container", () => {
    const wrapper = mountStack({ bots: members(1), size: 36, totalCount: 1 });

    expect(items(wrapper)).toHaveLength(1);
    expect(styleOf(items(wrapper)[0]!)).toContain("width: 36px");
    expect(styleOf(items(wrapper)[0]!)).toContain("left: 50%");
    expect(styleOf(items(wrapper)[0]!)).toContain("top: 50%");
    expect(markerText(wrapper)).toBe("");
  });

  it("draws two members diagonally at 31% and 69%", () => {
    const wrapper = mountStack({ bots: members(2), size: 36, totalCount: 2 });
    const rendered = items(wrapper);

    expect(rendered).toHaveLength(2);
    expect(styleOf(rendered[0]!)).toContain("left: 31%");
    expect(styleOf(rendered[0]!)).toContain("top: 31%");
    expect(styleOf(rendered[1]!)).toContain("left: 69%");
    expect(styleOf(rendered[1]!)).toContain("top: 69%");
    // 59% of a 36px container.
    expect(styleOf(rendered[0]!)).toContain("width: 21px");
  });

  it("draws three members as two on top and one below", () => {
    const wrapper = mountStack({ bots: members(3), size: 36, totalCount: 3 });
    const rendered = items(wrapper);

    expect(rendered).toHaveLength(3);
    expect(styleOf(rendered[0]!)).toContain("left: 29%");
    expect(styleOf(rendered[0]!)).toContain("top: 29%");
    expect(styleOf(rendered[1]!)).toContain("left: 71%");
    expect(styleOf(rendered[1]!)).toContain("top: 29%");
    expect(styleOf(rendered[2]!)).toContain("left: 50%");
    expect(styleOf(rendered[2]!)).toContain("top: 71%");
    expect(markerText(wrapper)).toBe("");
  });

  it("draws four members in a 2x2 grid at 36px and 44px", () => {
    for (const size of [36, 44]) {
      const wrapper = mountStack({ bots: members(4), size, totalCount: 4 });
      const rendered = items(wrapper);

      expect(rendered).toHaveLength(4);
      expect(styleOf(rendered[0]!)).toContain("left: 29%");
      expect(styleOf(rendered[0]!)).toContain("top: 29%");
      expect(styleOf(rendered[1]!)).toContain("left: 71%");
      expect(styleOf(rendered[1]!)).toContain("top: 29%");
      expect(styleOf(rendered[2]!)).toContain("left: 29%");
      expect(styleOf(rendered[2]!)).toContain("top: 71%");
      expect(styleOf(rendered[3]!)).toContain("left: 71%");
      expect(styleOf(rendered[3]!)).toContain("top: 71%");
      expect(markerText(wrapper)).toBe("");
    }
  });

  it("draws four members at 32px as three avatars plus +1", () => {
    const wrapper = mountStack({ bots: members(4), size: 32, totalCount: 4 });
    const rendered = items(wrapper);

    expect(rendered).toHaveLength(3);
    expect(markerText(wrapper)).toBe("+1");
    // 59% of 32px.
    expect(styleOf(rendered[0]!)).toContain("width: 19px");
    // No ring: the members' own outlines separate them.
    expect(styleOf(rendered[0]!)).not.toContain("box-shadow");
  });

  it("draws five members as three avatars plus +2", () => {
    const wrapper = mountStack({ bots: members(5), size: 36, totalCount: 5 });
    const rendered = items(wrapper);

    expect(rendered).toHaveLength(3);
    expect(markerText(wrapper)).toBe("+2");
    expect(styleOf(wrapper.find('[data-test="group-avatar-more"]'))).toContain("left: 79.5%");
    expect(styleOf(wrapper.find('[data-test="group-avatar-more"]'))).toContain("top: 72%");
    expect(styleOf(wrapper.find('[data-test="group-avatar-more"]'))).toContain("font-size: 14px");
  });

  it("caps the overflow label at 99+ with the smaller type", () => {
    const bots = Array.from({ length: 103 }, (_, i) => bot(`bot_${i}`, `Member ${i}`));
    const wrapper = mountStack({ bots, size: 36, totalCount: 103 });

    expect(items(wrapper)).toHaveLength(3);
    expect(markerText(wrapper)).toBe("99+");
    expect(styleOf(wrapper.find('[data-test="group-avatar-more"]'))).toContain("font-size: 10px");
  });

  it("keeps disabled and retired members out of the collage and counts them in the label", () => {
    const wrapper = mountStack({
      bots: [
        bot("bot_a", "Alpha"),
        bot("bot_b", "Bravo", { enabled: false }),
        bot("bot_c", "Charlie", { retired: true }),
      ],
      size: 36,
      totalCount: 3,
      disabledCount: 2,
    });

    expect(items(wrapper)).toHaveLength(1);
    expect(wrapper.attributes("aria-label")).toBe("Release Team · 3 members (2 disabled)");
  });

  it("keeps the label to the member count when nobody is disabled", () => {
    const wrapper = mountStack({ bots: members(2), size: 36, totalCount: 2 });

    expect(wrapper.attributes("aria-label")).toBe("Release Team · 2 members");
    expect(wrapper.attributes("role")).toBe("img");
  });

  it("falls back to the group glyph when no member is eligible", () => {
    const wrapper = mountStack({
      bots: [bot("bot_a", "Alpha", { enabled: false })],
      size: 36,
      totalCount: 1,
      disabledCount: 1,
    });

    expect(items(wrapper)).toHaveLength(0);
    expect(wrapper.find("svg").exists()).toBe(true);
  });

  it("draws a member without an avatar as the default bot avatar, as the transcript does", () => {
    const wrapper = mountStack({ bots: [bot("bot_a", "Alpha")], size: 36, totalCount: 1, instanceId: "i1" });

    const avatar = wrapper.findComponent(BotAvatar);
    expect(avatar.attributes("data-avatar-kind")).toBe("default");
    // The instance maps the agent name to its driver, the same lookup the transcript uses.
    expect(avatar.props("driver")).toBe("codex");
    expect(wrapper.find('[data-test="group-avatar-tile"]').exists()).toBe(false);
  });

  it("renders a configured avatar through BotAvatar", () => {
    const wrapper = mountStack({
      bots: [bot("bot_a", "Alpha", { avatar: { version: 1, kind: "text", value: "AB" } })],
      size: 36,
      totalCount: 1,
    });

    expect(wrapper.find('[data-test="bot-avatar"]').attributes("data-avatar-kind")).toBe("text");
  });

  it("puts the lead first, then the members by most recent activity", () => {
    const wrapper = mountStack({
      bots: [bot("bot_a", "Alpha"), bot("bot_b", "Bravo"), bot("bot_c", "Charlie")],
      size: 36,
      totalCount: 3,
      leadBotId: "bot_c",
      activityBotIds: ["bot_b", "bot_a"],
    });

    expect(items(wrapper).map((item) => item.attributes("data-bot-id"))).toEqual(["bot_c", "bot_b", "bot_a"]);
  });

  it("falls back to the given order when nobody has spoken", () => {
    const wrapper = mountStack({
      bots: [bot("bot_a", "Alpha"), bot("bot_b", "Bravo"), bot("bot_c", "Charlie")],
      size: 36,
      totalCount: 3,
      leadBotId: "bot_b",
    });

    expect(items(wrapper).map((item) => item.attributes("data-bot-id"))).toEqual(["bot_b", "bot_a", "bot_c"]);
  });

  it("stays silent in a row that already states the name and the count", () => {
    const wrapper = mountStack({ bots: members(2), size: 36, totalCount: 2, decorative: true });

    expect(wrapper.attributes("aria-hidden")).toBe("true");
    expect(wrapper.attributes("role")).toBeUndefined();
    expect(wrapper.attributes("aria-label")).toBeUndefined();
  });
});

describe("GroupAvatarStack call sites", () => {
  const GROUP: GroupSummaryDto = {
    id: "conversation_g",
    kind: "group",
    title: "Release Team",
    botIds: ["bot_a", "bot_b"],
    leadBotId: "bot_a",
    createdAt: "now",
    updatedAt: "now",
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    useInstancesStore().instances = [
      {
        id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [],
        sessionsLoaded: true, agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }], agentCatalog: [],
      } as never,
    ];
    useDirectBotsStore().botsByInstance["i1"] = [bot("bot_a", "Alpha"), bot("bot_b", "Bravo")];
  });

  it("draws the group's members in the sidebar row", async () => {
    const groups = useGroupsStore();
    groups.groupsByInstance["i1"] = [GROUP];
    groups.groupsLoaded["i1"] = true;

    const wrapper = mount(InstanceTree, { global: { plugins: [i18n] } });
    await wrapper.find('[data-test="instance-nav-groups"]').trigger("click");
    await flushPromises();

    const collage = wrapper.find('[data-test="group-row"] [data-test="group-avatar-stack"]');
    expect(collage.exists()).toBe(true);
    expect(collage.findAll('[data-test="group-avatar-item"]')).toHaveLength(2);
    // The row states the name and the count, so the collage stays silent.
    expect(collage.attributes("aria-hidden")).toBe("true");
  });
});
