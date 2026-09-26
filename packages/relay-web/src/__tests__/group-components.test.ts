import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import GroupPane from "../components/GroupPane.vue";
import GroupComposer from "../components/GroupComposer.vue";
import GroupTranscript from "../components/GroupTranscript.vue";
import InstanceTree from "../components/InstanceTree.vue";

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_off", name: "Sleeper", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
];

const GROUP: GroupSummaryDto = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: ["bot_a", "bot_b"],
  leadBotId: "bot_a",
  createdAt: "now",
  updatedAt: "now",
};

function seedInstance() {
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
}

function seedGroupSelection() {
  const groups = useGroupsStore();
  groups.instanceId = "i1";
  groups.selectedGroupId = "conversation_g";
  groups.activeConversationId = "conversation_g";
  groups.activeTopicId = "topic_1";
  groups.topicReady = true;
  groups.groupsByInstance["i1"] = [GROUP];
  groups.groupDetails["i1:conversation_g"] = { ...GROUP, topics: [] };
  groups.topicsByConversation["i1:conversation_g"] = [
    { id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" },
  ];
  const direct = useDirectBotsStore();
  direct.botsByInstance["i1"] = BOTS;
  return groups;
}

describe("Group Components", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedInstance();
  });

  describe("GroupComposer.vue", () => {
    it("defaults the target button to the lead Bot", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(wrapper.find('[data-test="group-target-button"]').text()).toContain("Reviewer");
    });

    it("keeps the typed draft when the target is empty", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      // Deselect the only member: the target becomes empty.
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-member-bot_a"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("please review this");
      // Send must be disabled and must not clear the typed text.
      expect(wrapper.find('[data-test="group-send-prompt-button"]').attributes("disabled")).toBeDefined();
      expect(wrapper.find('[data-test="group-retry-prompt-button"]').exists()).toBe(false);
      await textarea.trigger("keydown", { key: "Enter" });
      expect((textarea.element as HTMLTextAreaElement).value).toBe("please review this");
    });

    it("Lead shortcut never selects a disabled Bot", async () => {
      const groups = seedGroupSelection();
      groups.groupsByInstance["i1"] = [{ ...GROUP, leadBotId: "bot_off", botIds: ["bot_off", "bot_a"] }];
      groups.groupDetails["i1:conversation_g"] = { ...GROUP, leadBotId: "bot_off", botIds: ["bot_off", "bot_a"], topics: [] } as never;
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-lead"]').trigger("click");
      // The disabled lead must fall through to an executable member.
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });

    it("toggles members and switches to everyone", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-member-bot_b"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a", "bot_b"] });
      await wrapper.find('[data-test="group-target-everyone"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
      expect(wrapper.find('[data-test="group-target-button"]').text()).toContain("Everyone");
    });

    it("disables rows for disabled members", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      const off = wrapper.find('[data-test="group-target-member-bot_off"]');
      expect(off.exists()).toBe(true);
      expect(off.attributes("disabled")).toBeDefined();
    });

    it("typing @Ann into @Anna never selects Ann first", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: [] };
      // Both Ann and Anna are enabled members: the prefix is a real, valid
      // target while it is being typed, so only the committed token may route.
      const wrapper = mount(GroupComposer, {
        props: {
          bots: [
            { id: "bot_a", name: "Ann", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            { id: "bot_b", name: "Anna", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          ],
        },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // True char-by-char typing: each setValue leaves the caret at EOF, which
      // must NOT commit the current prefix. Asserting at every step is what
      // keeps a reintroduced "select Ann, then replace with Anna" bug red — a
      // single post-loop assertion would still pass once the final text resolves.
      for (const step of ["@", "@A", "@An", "@Ann", "@Ann", "@Anna"]) {
        await textarea.setValue(step);
        expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      }
      // The trailing space terminates the token: only Anna is selected, and the
      // intermediate Ann prefix never polluted the target.
      await textarea.setValue("@Anna ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("commits a quoted mention even when punctuation follows the closing quote", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: {
          bots: [
            { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            { id: "bot_c", name: "Code Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          ],
        },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // The closing quote is itself the delimiter: no trailing whitespace needed.
      await textarea.setValue('@"Code Reviewer"');
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_c"] });
      await textarea.trigger("blur");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_c"] });
    });

    it("routes a quoted mention followed by punctuation at send time", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: {
          bots: [
            { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            { id: "bot_c", name: "Code Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          ],
        },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Punctuation directly after the quote used to leave the target on Bot A.
      await textarea.setValue('@"Code Reviewer": please review');
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_c"] });
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")).toEqual([['@"Code Reviewer": please review']]);
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_c"] });
      // Same for a comma: the punctuation must not demote the token.
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      await textarea.setValue('wait @"Code Reviewer", please');
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_c"] });
    });

    it("typing @everyones leaves everyone behind when the token does not match", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Real char-by-char input through the exact keyword: no prefix commits
      // while typing, because the caret sits at EOF the whole time.
      let value = "";
      for (const ch of ["@", "e", "v", "e", "r", "y", "o", "n", "e"]) {
        value += ch;
        await textarea.setValue(value);
        expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      }
      // One more character makes the token not match: still unchanged.
      await textarea.setValue(`${value}s`);
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      // Backspacing to the keyword is still pending (no terminator yet).
      await textarea.setValue(value);
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      // The terminating space commits it.
      await textarea.setValue(`${value} `);
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
    });

    it("commits the pending token when the text is sent", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Typed to the exact keyword with no terminator, then sent: the boundary
      // commit must apply the target that the send actually resolves.
      await textarea.setValue("@everyone");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")).toEqual([["@everyone"]]);
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
    });

    it("commits the pending token on blur", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@Tester");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      await textarea.trigger("blur");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("commits @everyone once the token is terminated", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@everyone ");
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
      await textarea.setValue("@everyone please review");
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
    });

    it("supports CJK names and quoted spaced names", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: [] };
      const wrapper = mount(GroupComposer, {
        props: {
          bots: [
            { id: "bot_a", name: "张三", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            { id: "bot_b", name: "Code Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          ],
        },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Unquoted CJK token contains no whitespace, so it terminates at end-of-text.
      await textarea.setValue("@张三 ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      // Spaced names need the quoted form: the unquoted prefix stays ambiguous.
      groups.targetSelection = { mode: "members", botIds: [] };
      await textarea.setValue("@Code ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      await textarea.setValue('@"Code Reviewer" ');
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("replaces rather than appends when the mention set changes", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: [] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@Reviewer ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      await textarea.setValue("@Tester ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("resolves @Name only for a unique enabled member", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_b"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Token must be terminated: end-of-text counts, then whitespace.
      await textarea.setValue("@Tester ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
      // Disabled Sleeper is not routable even though its name is exact.
      groups.targetSelection = { mode: "members", botIds: [] };
      await textarea.setValue("@Sleeper ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      // Ambiguous duplicate name: never auto-pick the first row.
      const dup = [
        { ...BOTS[0]!, id: "bot_a", name: "Same" },
        { ...BOTS[1]!, id: "bot_b", name: "Same" },
      ];
      await wrapper.setProps({ bots: dup });
      await textarea.setValue("@Same ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      // Unique match still routes after the ambiguity is removed.
      await wrapper.setProps({ bots: [dup[0]!] });
      await textarea.setValue("@Same ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });
  });

  describe("GroupTranscript.vue", () => {
    it("renders one Run card row per member with exact statuses", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "completed", createdAt: "now",
        },
        turn_b: {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, memberIndex: 1, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(wrapper.find('[data-test="group-run-card"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="group-run-card"]').attributes("data-run-id")).toBe("run_1");
      const rows = wrapper.findAll('[data-test="group-member-row"]');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.attributes("data-bot-id")).toBe("bot_a");
      expect(rows[0]?.attributes("data-state")).toBe("completed");
      expect(rows[1]?.attributes("data-bot-id")).toBe("bot_b");
      expect(rows[1]?.attributes("data-state")).toBe("running");
    });

    it("expands member activity on toggle", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      groups.liveTurnsByMember = {
        turn_a: { parts: [{ type: "text", text: "hello" }], status: "streaming", startedAt: Date.now(), revision: 1 },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      expect(wrapper.find('[data-test="group-member-activity"]').exists()).toBe(false);
      await wrapper.find('[data-test="group-member-toggle"]').trigger("click");
      expect(wrapper.find('[data-test="group-member-activity"]').exists()).toBe(true);
    });

    it("stops the exact active run from the card", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_stop", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      const spy = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue(undefined);
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-stop-run-button"]').trigger("click");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe("GroupPane.vue", () => {
    it("binds transcript, composer, and topic strip without touching Direct state", async () => {
      seedGroupSelection();
      const direct = useDirectBotsStore();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="group-topic-pill"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="group-send-prompt-button"]').exists()).toBe(true);
      expect(direct.isBotSelected).toBe(false);
    });

    it("disables the composer and marks the pill on an archived Topic", async () => {
      seedGroupSelection();
      const groups = useGroupsStore();
      groups.topicsByConversation["i1:conversation_g"] = [
        { id: "topic_1", conversationId: "conversation_g", title: "Old", status: "archived", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ];
      groups.activeTopicId = "topic_1";
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="group-topic-pill"]').attributes("data-topic-status")).toBe("archived");
      expect(wrapper.find('[data-test="group-composer-textarea"]').attributes("disabled")).toBeDefined();
      expect(wrapper.find('[data-test="group-send-prompt-button"]').exists()).toBe(true);
    });
  });

  describe("InstanceTree.vue groups nav", () => {
    it("lists groups and emits selectGroup", async () => {
      seedInstance();
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      groups.groupsLoaded["i1"] = true;
      const wrapper = mount(InstanceTree, { global: { plugins: [i18n] } });
      await wrapper.find('[data-test="instance-nav-groups"]').trigger("click");
      const rows = wrapper.findAll('[data-test="group-row"]');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text()).toContain("Release Team");
      await rows[0]?.find("button").trigger("click");
      expect(wrapper.emitted("selectGroup")).toEqual([["i1", "conversation_g"]]);
      expect(wrapper.emitted("selectBot")).toBeUndefined();
    });
  });
});
