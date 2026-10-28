import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { groupDraftKey, loadDraft } from "../lib/composer-drafts";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useConversationCommandsStore } from "../stores/conversation-commands";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
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
    vi.spyOn(useInstancesStore(), "loadRouterAvailability").mockResolvedValue(undefined);
    vi.spyOn(useInstancesStore(), "loadJevSettings").mockResolvedValue(undefined);
  });
  afterEach(() => {
    window.innerWidth = 1024;
  });

  /** Seed the Jev panel for `i1` the way the store's read lands it. */
  function seedJev(phase: "editable" | "read-only", keyConfigured: boolean): void {
    useInstancesStore().jevPanelById = {
      i1: phase === "editable"
        ? {
            phase: "editable",
            settings: {
              endpoint: "https://api.typesafe.ai/v1/systemone",
              model: "jev-1.13.0",
              keyConfigured,
              keyMasked: keyConfigured ? "sk-…abcd" : null,
            },
            save: { kind: "idle" },
            test: { kind: "idle" },
          }
        : { phase: "read-only", notice: "instance.jevUpgradeNotice" },
    };
  }

  describe("GroupComposer.vue", () => {
    it("renders the @name and @everyone hints literally in both locales", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      const placeholder = () => wrapper.find('[data-test="group-composer-textarea"]').attributes("placeholder");
      expect(wrapper.text()).toContain("@name adds a member · @everyone selects all");
      expect(placeholder()).toBe("Message the selected members... (@name, @everyone)");
      i18n.global.locale.value = "zh-CN";
      await wrapper.vm.$nextTick();
      expect(wrapper.text()).toContain("@名称 添加成员 · @everyone 全选");
      expect(placeholder()).toBe("给所选成员发消息...（@名称、@everyone）");
      i18n.global.locale.value = "en";
      const compileErrors = [...errors.mock.calls, ...warns.mock.calls]
        .filter((args) => String(args[0]).includes("compilation error"));
      expect(compileErrors).toEqual([]);
      errors.mockRestore();
      warns.mockRestore();
    });

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

    it("Lead shortcut stays on the lead Bot when the catalog is unconfirmed", async () => {
      const groups = seedGroupSelection();
      const direct = useDirectBotsStore();
      // An unconfirmed catalog is the Direct store's own state.
      direct.botsLoaded["i1"] = false;
      direct.botsByInstance["i1"] = [];
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        // The composer sees no Bot rows at all, exactly like a failed
        // bots.list with no cache.
        props: { bots: [] },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-lead"]').trigger("click");
      // A button labelled Lead must never widen the target to the whole Group.
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      // And the label must not disguise the real selection as empty.
      expect(wrapper.find('[data-test="group-target-button"]').text()).not.toContain("Select members");
    });

    it("Lead respects a Bot that was disabled after a successful background refresh", async () => {
      const groups = seedGroupSelection();
      const direct = useDirectBotsStore();
      // Catalog is confirmed but the lead Bot has since been disabled.
      direct.botsLoaded["i1"] = true;
      direct.botsByInstance["i1"] = BOTS;
      groups.groupsByInstance["i1"] = [{ ...GROUP, leadBotId: "bot_off", botIds: ["bot_off", "bot_a"] }];
      groups.groupDetails["i1:conversation_g"] = { ...GROUP, leadBotId: "bot_off", botIds: ["bot_off", "bot_a"], topics: [] } as never;
      groups.targetSelection = { mode: "members", botIds: ["bot_off"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-lead"]').trigger("click");
      // The disabled lead is not re-selected; an executable member is.
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });

    it("Lead converges back to eligibility-aware once the catalog refresh succeeds", async () => {
      const groups = seedGroupSelection();
      const direct = useDirectBotsStore();
      // bots.list failed: the catalog is unknown, so the composer is fail-narrow.
      direct.botsLoaded["i1"] = false;
      direct.botsByInstance["i1"] = [];
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: [] },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-lead"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      // A background bots-changed succeeds and reveals the lead is now disabled.
      direct.botsLoaded["i1"] = true;
      direct.botsByInstance["i1"] = BOTS;
      await wrapper.setProps({ bots: BOTS });
      await flushPromises();
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-lead"]').trigger("click");
      // Converged: the stale unknown state did not pin the disabled lead.
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });

    it("renders the queue-full refusal as translated text, not the raw code", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      groups.promptError = "topicQueueFull";
      groups.promptErrorDetail = null;
      await flushPromises();
      // The composer must translate structured codes; the raw identifier is a
      // presentation bug, not a user-facing message.
      expect(wrapper.text()).toContain("too many queued runs");
      expect(wrapper.text()).not.toContain("topicQueueFull");
    });

    describe("drafts are kept per Group + Topic", () => {
      beforeEach(() => sessionStorage.clear());
      const TOPICS = [
        { id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active" as const, createdAt: "now", updatedAt: "now" },
        { id: "topic_2", conversationId: "conversation_g", title: "Post", status: "active" as const, createdAt: "now", updatedAt: "now" },
      ];
      function mountComposer(outcome?: () => Promise<GroupSendOutcome>) {
        const wrapper = mount(GroupComposer, {
          props: { bots: BOTS, ...(outcome ? { sendOutcome: outcome } : {}) },
          global: { plugins: [i18n] },
        });
        const textarea = () => wrapper.find('[data-test="group-composer-textarea"]');
        const value = () => (textarea().element as HTMLTextAreaElement).value;
        return { wrapper, textarea, value };
      }
      function seedTwoTopics() {
        const groups = seedGroupSelection();
        groups.topicsByConversation["i1:conversation_g"] = TOPICS;
        return groups;
      }
      async function goTo(groups: ReturnType<typeof useGroupsStore>, conversationId: string, topicId: string) {
        groups.activeConversationId = conversationId;
        groups.selectedGroupId = conversationId;
        groups.activeTopicId = topicId;
        await flushPromises();
      }

      it("restores topic A's draft after visiting topic B, and B keeps its own", async () => {
        const groups = seedTwoTopics();
        const { textarea, value } = mountComposer();
        await textarea().setValue("draft for A");
        await goTo(groups, "conversation_g", "topic_2");
        expect(value()).toBe("");
        await textarea().setValue("draft for B");
        await goTo(groups, "conversation_g", "topic_1");
        expect(value()).toBe("draft for A");
        await goTo(groups, "conversation_g", "topic_2");
        expect(value()).toBe("draft for B");
      });

      it("keeps a separate draft for each Group + Topic when switching Groups", async () => {
        const groups = seedTwoTopics();
        const { textarea, value } = mountComposer();
        await textarea().setValue("group G, topic 1");
        // Switching Group passes through a topicless moment, then lands on the other Group's Topic.
        groups.activeTopicId = null;
        await goTo(groups, "conversation_h", "topic_1");
        expect(value()).toBe("");
        await textarea().setValue("group H, topic 1");
        groups.activeTopicId = null;
        await goTo(groups, "conversation_g", "topic_1");
        expect(value()).toBe("group G, topic 1");
        await goTo(groups, "conversation_h", "topic_1");
        expect(value()).toBe("group H, topic 1");
      });

      it("an accepted send clears only that Group + Topic's draft", async () => {
        const groups = seedTwoTopics();
        groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
        const { wrapper, textarea, value } = mountComposer(() => Promise.resolve("accepted"));
        await goTo(groups, "conversation_g", "topic_2");
        await textarea().setValue("B stays");
        await goTo(groups, "conversation_g", "topic_1");
        await textarea().setValue("ship A");
        await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
        await flushPromises();
        expect(value()).toBe("");
        await goTo(groups, "conversation_g", "topic_2");
        expect(value()).toBe("B stays");
        await goTo(groups, "conversation_g", "topic_1");
        expect(value()).toBe("");
      });

      it("a rejected send keeps the draft for that Topic", async () => {
        const groups = seedTwoTopics();
        groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
        const { wrapper, textarea, value } = mountComposer(() => Promise.resolve("rejected"));
        await textarea().setValue("try again later");
        await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
        await flushPromises();
        expect(value()).toBe("try again later");
        await goTo(groups, "conversation_g", "topic_2");
        await goTo(groups, "conversation_g", "topic_1");
        expect(value()).toBe("try again later");
      });

      it("a draft whose send is still in flight is not resurrected after leaving its Topic", async () => {
        const groups = seedTwoTopics();
        groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
        const gate = Promise.withResolvers<GroupSendOutcome>();
        const { wrapper, textarea, value } = mountComposer(() => gate.promise);
        await textarea().setValue("sent from A");
        await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
        await flushPromises();
        await goTo(groups, "conversation_g", "topic_2");
        gate.resolve("orphaned");
        await flushPromises();
        await goTo(groups, "conversation_g", "topic_1");
        expect(value()).toBe("");
      });

      it("a pending send that resolves after switching Topics does not clear the other Topic's draft", async () => {
        const groups = seedTwoTopics();
        groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
        const gate = Promise.withResolvers<GroupSendOutcome>();
        const { wrapper, textarea, value } = mountComposer(() => gate.promise);
        // Topic B already has a saved draft.
        await goTo(groups, "conversation_g", "topic_2");
        await textarea().setValue("B's own draft");
        await goTo(groups, "conversation_g", "topic_1");
        await textarea().setValue("sent from A");
        await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
        await flushPromises();
        // Switch to B while A's send is still pending, then the send resolves.
        await goTo(groups, "conversation_g", "topic_2");
        expect(value()).toBe("B's own draft");
        gate.resolve("accepted");
        await flushPromises();
        expect(value()).toBe("B's own draft");
        expect(loadDraft(groupDraftKey("i1", "conversation_g", "topic_2"))).toBe("B's own draft");
      });

      it("restores the current Topic's draft on remount (tab reload)", async () => {
        seedTwoTopics();
        const first = mountComposer();
        await first.textarea().setValue("survives reload");
        first.wrapper.unmount();
        const second = mountComposer();
        expect(second.value()).toBe("survives reload");
      });
    });

    it("discards the draft when the Topic switches under a pending send", async () => {
      const groups = seedGroupSelection();
      const gate = Promise.withResolvers<GroupSendOutcome>();
      // Seeded before mount: the outcome provider must hold the send from the
      // moment the composer can call it, so there is no window in which the
      // composer reads the store's real (immediately-settling) promise.
      vi.spyOn(groups, "sendPromptOutcomePromise", "get").mockReturnValue(gate.promise);
      const wrapper = mount(GroupPane, {
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("deploy");
      await flushPromises();
      // A resolvable target is what enables the send button.
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      await flushPromises();
      expect(groups.targetResolvable).toBe(true);
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      await flushPromises();
      // The draft survives while the outcome is pending.
      expect((textarea.element as HTMLTextAreaElement).value).toBe("deploy");
      // Switch to a second Topic while it is still in flight.
      groups.topicsByConversation["i1:conversation_g"] = [
        { id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" },
        { id: "topic_2", conversationId: "conversation_g", title: "Post", status: "active", createdAt: "now", updatedAt: "now" },
      ];
      await groups.switchTopic("topic_2");
      await flushPromises();
      // The draft must not follow the user into the new Topic.
      expect((textarea.element as HTMLTextAreaElement).value).toBe("");
      // The new Topic becomes ready (its history finished loading) and the user
      // starts typing there while the old send is still outstanding.
      groups.topicReady = true;
      await flushPromises();
      const liveTextarea = wrapper.find('[data-test="group-composer-textarea"]');
      expect((liveTextarea.element as HTMLTextAreaElement).disabled).toBe(false);
      await liveTextarea.setValue("do not deploy");
      await flushPromises();
      const draftNow = wrapper.findComponent(GroupComposer).vm as unknown as { promptText: string };
      expect(draftNow.promptText).toBe("do not deploy");
      // The topic_1 response lands now: it may have been durably accepted, but
      // its completion cannot mutate a draft that belongs to topic_2.
      gate.resolve("orphaned");
      await flushPromises();
      const composerVm = wrapper.findComponent(GroupComposer).vm as unknown as { promptText: string };
      expect(composerVm.promptText).toBe("do not deploy");
      // And the pending target from the old Topic is not projected either.
      expect(groups.promptInFlight).toBe(false);
    });

    it("re-derives a mention in the FIRST draft after an accepted send", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const gate = Promise.withResolvers<GroupSendOutcome>();
      const wrapper = mount(GroupComposer, {
        props: {
          bots: [
            { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          ],
          sendOutcome: () => gate.promise,
        },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@Tester ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
      // Accepted send: the draft is finished and its text is gone.
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      gate.resolve("accepted");
      await flushPromises();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("");
      // The user now picks a different Bot for the next message.
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      // The SAME mention in a NEW draft must re-derive, not inherit the
      // suppression from the sent draft and silently route to Bot A.
      await textarea.setValue("@Tester ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("renders an oversized everyone refusal as product copy, not backend English", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      groups.promptError = "targetTooLarge";
      groups.promptErrorDetail = null;
      await flushPromises();
      // The backend's message is "explicit Group target selects more than 64
      // members" — an English internal string that must never reach a zh UI.
      expect(wrapper.text()).toContain("more members than one run can handle");
      expect(wrapper.text()).not.toContain("explicit Group target");
      // A disabled member refusal uses the existing product copy too.
      groups.promptError = "botDisabled";
      await flushPromises();
      expect(wrapper.text()).toContain("Enable it before sending");
    });


    it("Lead shortcut never selects a disabled Bot", async () => {
      const groups = seedGroupSelection();
      const direct = useDirectBotsStore();
      direct.botsLoaded["i1"] = true;
      direct.botsByInstance["i1"] = BOTS;
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
      expect(off.attributes("aria-disabled")).toBe("true");
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
      await textarea.setValue('wait until done, then @"Code Reviewer", please');
      await textarea.trigger("blur");
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
          // Standalone mount: no RPC. Report a definitive refusal so the draft (and
          // therefore the mention) survives to be asserted.
          sendOutcome: () => Promise.resolve("rejected" as const),
        },
        global: { plugins: [i18n] },
      });
      // Flush the Topic watcher so the derived-suppression reset from mounting
      // does not land after the first mention is committed.
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Punctuation directly after the quote used to leave the target on Bot A:
      // the closing quote alone must be enough to commit the mention.
      await textarea.setValue('@"Code Reviewer": please review');
      await textarea.trigger("blur");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_c"] });
    });

    it("does not let punctuation after a quoted mention demote the token", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: {
          bots: [
            { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
            { id: "bot_c", name: "Code Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
          ],
          sendOutcome: () => Promise.resolve("rejected" as const),
        },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // A comma directly after the closing quote: the punctuation must not
      // demote the token back to the previously selected Bot.
      await textarea.setValue('wait until done, then @"Code Reviewer", please');
      await textarea.trigger("blur");
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

    it("commits a bare mention terminated by sentence punctuation", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // "@everyone," used to parse as the unknown name "everyone," and keep
      // the previous manual selection — a comma after the keyword must
      // commit it instead.
      await textarea.setValue("@everyone, please review");
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
    });

    it("commits a bare member mention terminated by a colon", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // "@Tester:" used to parse as the unknown name "Tester:" and silently
      // keep Bot A — the colon must terminate the token so Tester routes.
      await textarea.setValue("@Tester: please review");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("resolves the punctuation-terminated mention at send time, never the stale target", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: {
          bots: BOTS,
          sendOutcome: () => Promise.resolve("rejected" as const),
        },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Reviewer's scenario: Lead A selected, user types "@everyone, ...".
      // The send-time boundary must commit everyone BEFORE the parent
      // resolves the send target — Bot A must never be the silent fallback.
      await textarea.setValue("@everyone, please review");
      await textarea.trigger("keydown", { key: "Enter" });
      await flushPromises();
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
      // Everyone sends confirm through the modal: confirm, then the send
      // carries the typed text for the resolved target.
      (document.body.querySelector('[data-test="composer-confirm-send"]') as HTMLElement).click();
      await flushPromises();
      expect(wrapper.emitted("send")?.[0]).toEqual(["@everyone, please review"]);
      wrapper.unmount();
    });

    it("shows the translated target error on Enter with an empty selection, without clearing the draft or sending", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: [] };
      const wrapper = mount(GroupComposer, {
        props: {
          bots: BOTS,
          sendOutcome: () => Promise.resolve("rejected" as const),
        },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // No mention in the text: the boundary commit cannot rescue the target.
      await textarea.setValue("please review this");
      await textarea.trigger("keydown", { key: "Enter" });
      await flushPromises();
      // The banner renders a real sentence — never the raw key path.
      const banner = wrapper.find('[data-test="group-prompt-error"]');
      expect(banner.exists()).toBe(true);
      expect(banner.text()).toBe("Select at least one member before sending.");
      expect(banner.text()).not.toContain("bot.errors.targetEmpty");
      // Nothing was sent and the draft survives.
      expect(wrapper.emitted("send")).toBeUndefined();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("please review this");
    });

    it("locks the target selector and Send while a prompt awaits confirmation", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      groups.topicReady = true;
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("review this");
      expect(wrapper.find('[data-test="group-send-prompt-button"]').attributes("disabled")).toBeUndefined();
      // A prompt whose durable outcome is unknown: only Retry is allowed.
      groups.uncertainPrompt = {
        requestId: "req_uncertain",
        text: "review this",
        target: { mode: "members", botIds: ["bot_a"] },
        media: [],
      };
      // The banner (and therefore Retry) shows while the failure is reported.
      groups.promptError = "Network timeout";
      await flushPromises();
      expect(wrapper.find('[data-test="group-send-prompt-button"]').attributes("disabled")).toBeDefined();
      expect(wrapper.find('[data-test="group-target-button"]').attributes("disabled")).toBeDefined();
      expect(wrapper.find('[data-test="group-retry-prompt-button"]').exists()).toBe(true);
    });

    it("lets an EOF mention make this very send valid from an empty target", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: [] };
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Typing stops at EOF, so the mention is still uncommitted — which is why
      // Send looks disabled. It must not stay that way after the send attempt.
      await textarea.setValue("@Tester");
      expect(wrapper.find('[data-test="group-send-prompt-button"]').attributes("disabled")).toBeDefined();
      // Enter: the boundary commit must run BEFORE the target is judged.
      await textarea.trigger("keydown", { key: "Enter" });
      await flushPromises();
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
      await textarea.trigger("keydown", { key: "Enter" });
      await flushPromises();
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
      // The boundary commit applies the target before the send is attempted.
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

    it("refreshes slash commands when the selected member changes and keeps a rejected draft", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const commands = useConversationCommandsStore();
      commands.remember({
        instanceId: "i1", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a",
      }, [{ name: "compact", description: "Compact" }]);
      commands.remember({
        instanceId: "i1", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_b",
      }, [{ name: "diff", description: "Diff" }]);
      const gate = Promise.withResolvers<GroupSendOutcome>();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => b.enabled), sendOutcome: () => gate.promise },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("/co");
      expect(wrapper.find('[data-test="group-cmd-item"]').text()).toContain("/compact");
      await textarea.trigger("keydown", { key: "Enter" });
      expect(wrapper.emitted("send")).toBeUndefined();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("/compact ");
      groups.targetSelection = { mode: "members", botIds: ["bot_b"] };
      await textarea.setValue("/d");
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[data-test="group-cmd-item"]').text()).toContain("/diff");
      groups.targetSelection = { mode: "everyone" };
      await textarea.setValue("/compact");
      expect(wrapper.find('[data-test="group-slash-hint"]').exists()).toBe(true);
      await textarea.trigger("keydown", { key: "Enter" });
      expect(wrapper.emitted("send")).toBeUndefined();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      await textarea.setValue("keep me");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      gate.resolve("rejected");
      await flushPromises();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("keep me");
    });

    it("hides the automatic option entirely when automatic collaboration is off", async () => {
      const groups = seedGroupSelection();
      const instances = useInstancesStore();
      instances.routerAvailabilityById = {
        i1: {
          status: "disabled-by-config",
          configPath: "conversations.router",
          reason: { code: "disabled", message: "Automatic collaboration is off." },
        },
      };
      seedJev("editable", true);
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      // No disabled item with a reason: the option is not offered at all.
      expect(wrapper.find('[data-test="group-target-automatic"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-router-note"]').exists()).toBe(false);
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });

    it("hides the automatic option when the router is ready but no Jev key is configured", async () => {
      const groups = seedGroupSelection();
      const instances = useInstancesStore();
      instances.routerAvailabilityById = { i1: { status: "ready", configPath: "conversations.router" } };
      seedJev("editable", false);
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      expect(wrapper.find('[data-test="group-target-automatic"]').exists()).toBe(false);
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });

    it("hides the automatic option on an instance that cannot report Jev settings", async () => {
      const groups = seedGroupSelection();
      const instances = useInstancesStore();
      instances.routerAvailabilityById = { i1: { status: "ready", configPath: "conversations.router" } };
      seedJev("read-only", true);
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      expect(wrapper.find('[data-test="group-target-automatic"]').exists()).toBe(false);
    });

    it("selects automatic collaboration when the router is ready and a Jev key is configured", async () => {
      const groups = seedGroupSelection();
      const instances = useInstancesStore();
      instances.routerAvailabilityById = { i1: { status: "ready", configPath: "conversations.router" } };
      seedJev("editable", true);
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-automatic"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "automatic" });
      expect(wrapper.find('[data-test="group-target-button"]').text()).toContain("Automatic collaboration");
    });

    it("drops an in-progress automatic selection when the Jev key is cleared", async () => {
      const groups = seedGroupSelection();
      const instances = useInstancesStore();
      instances.routerAvailabilityById = { i1: { status: "ready", configPath: "conversations.router" } };
      seedJev("editable", true);
      groups.targetSelection = { mode: "automatic" };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(groups.targetSelection).toEqual({ mode: "automatic" });
      // Another tab clears the key: the option disappears and the draft target
      // falls back to the Group's eligible selection instead of stranding it.
      seedJev("editable", false);
      await flushPromises();
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      wrapper.unmount();
    });

    it("shows feedback for an unresolved mention and drops the previous target", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("@Nobody ");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      expect(groups.promptError).toBe("mentionUnresolved");
    });
  });

  describe("GroupTranscript.vue", () => {
    it("renders one Agent row and bubble per member with exact states", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
      ];
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
      // The old aggregate card is gone; one bubble row per MemberTurn remains.
      expect(wrapper.find('[data-test="group-run-card"]').exists()).toBe(false);
      const rows = wrapper.findAll('[data-test="agent-turn-row"]');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.attributes("data-member-turn-id")).toBe("turn_a");
      expect(rows[1]!.attributes("data-member-turn-id")).toBe("turn_b");
      const bubbles = wrapper.findAll('[data-test="agent-thinking-bubble"]');
      expect(bubbles).toHaveLength(2);
      expect(bubbles[0]!.classes()).toContain("is-done");
      expect(bubbles[1]!.classes()).toContain("is-running");
    });

    it("opens the anchored detail popover from one bubble and stops the exact active run from it", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
      ];
      groups.activeRun = {
        id: "run_stop", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_stop", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      const spy = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({ status: "blocked", scope: null, runId: "run_stop", reason: "ownership" });
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
        attachTo: document.body,
      });
      await wrapper.get('[data-test="agent-thinking-bubble"]').trigger("click");
      await flushPromises();
      const layer = document.body.querySelector('[data-test="group-detail-layer"]');
      expect(layer !== null).toBe(true);
      expect(layer!.textContent ?? "").toContain("Running");
      (document.body.querySelector('[data-test="group-stop-run-button"]') as HTMLElement).click();
      await flushPromises();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      wrapper.unmount();
    });

    it("keeps a neutral routing entry for an automatic run before members exist", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Plan the release", createdAt: "now" },
      ];
      groups.activeRun = {
        id: "run_route", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "automatic", state: "running",
        routingState: "routing", routingReason: "Jev picked Reviewer for this message (confidence 0.82).",
        maxMemberTurns: 24, consumedMemberTurns: 0, profileRevision: 1, createdAt: "now",
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
        attachTo: document.body,
      });
      await flushPromises();
      expect(wrapper.find('[data-test="group-run-card"]').exists()).toBe(false);
      const routing = wrapper.find('[data-test="group-routing-row"]');
      expect(routing.exists()).toBe(true);
      expect(routing.find('[data-test="group-bubble-status"]').text()).toBe("Choosing members");
      await wrapper.get('[data-test="agent-thinking-bubble"]').trigger("click");
      await flushPromises();
      expect(document.body.querySelector('[data-test="group-detail-layer"]') !== null).toBe(true);
      wrapper.unmount();
    });

    it("shows waiting-human with question and Stop inside the detail, not as a banner", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Which branch?", createdAt: "now" },
      ];
      groups.activeRun = {
        id: "run_wait", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "automatic", state: "waiting-human",
        routingState: "done", waitingQuestion: "Which branch ships?",
        maxMemberTurns: 24, consumedMemberTurns: 1, profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_wait", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "router",
          state: "failed", createdAt: "now", assignmentId: "step-1", task: "Review the patch",
          dependsOn: ["step-0"], blockedReason: "human-authority-unknown",
        },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
        attachTo: document.body,
      });
      await wrapper.get('[data-test="agent-thinking-bubble"]').trigger("click");
      await flushPromises();
      const html = document.body.innerHTML;
      expect(html).toContain("Which branch ships?");
      expect(html).toContain("Review the patch");
      expect(html).toContain("permission");
      expect(html).toContain("new run");
      expect(html).not.toContain("step-1");
      expect(html).not.toContain("Depends on");
      expect(html).not.toContain("Budget");
      expect(document.body.querySelector('[data-test="group-stop-run-button"]') !== null).toBe(true);
      expect(groups.activeRun?.state).toBe("waiting-human");
      wrapper.unmount();
    });
    // Every row must expose exactly one anchor: the unwrapped member activity
    // row anchors to its MemberTurn id, the bubble reply row to itself via the
    // exact message id, and only the request row keeps the request anchor.
    it("keeps every anchor unique with the activity row anchored to its member", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
        { id: "reply_2", conversationId: "conversation_g", topicId: "topic_1", seq: 3, role: "bot", senderBotId: "bot_b", runId: "run_1", promptRequestId: "p_1", content: "From Tester", createdAt: "now" },
      ];
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
        turn_b: {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, memberIndex: 1, attempt: 1, origin: "human-explicit",
          state: "completed", promptRequestId: "p_1", createdAt: "now",
        },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const anchors = wrapper.findAll("[data-anchor-id]").map((row) => row.attributes("data-anchor-id"));
      expect(anchors).toContain("turn_a");
      expect(anchors.filter((anchor) => anchor === "msg_1")).toHaveLength(1);
      expect(new Set(anchors).size).toBe(anchors.length);
      expect(wrapper.get('[data-anchor-id="turn_b"]').attributes("data-row-id")).toBe("reply_2");
      expect(wrapper.get('[data-anchor-id="turn_b"]').attributes("data-message-id")).toBe("reply_2");
      wrapper.unmount();
    });

    it("anchors the neutral routing row to its own routing key", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Plan the release", createdAt: "now" },
      ];
      groups.activeRun = {
        id: "run_route", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "automatic", state: "running",
        routingState: "routing", maxMemberTurns: 24, consumedMemberTurns: 0, profileRevision: 1, createdAt: "now",
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const routing = wrapper.find('[data-test="group-routing-row"]');
      expect(routing.attributes("data-anchor-id")).toBe("routing:run_route");
      expect(routing.attributes("data-row-id")).toBe("routing:run_route");
      wrapper.unmount();
    });

    it("jumps the dispatched member to the canonical reply bubble row", async () => {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
        {
          id: "handoff_2", conversationId: "conversation_g", topicId: "topic_1", seq: 2,
          role: "system", senderBotId: "bot_a", runId: "run_1", createdAt: "now",
          content: "Public handoff: Reviewer → Tester\nTask: Review patch\nExpected output: Findings",
          handoff: {
            senderMemberTurnId: "turn_a", to: "bot_b", assignmentId: "assignment_b",
            memberTurnId: "turn_b", task: "Review patch", expectedOutput: "Findings",
          },
        },
        { id: "reply_3", conversationId: "conversation_g", topicId: "topic_1", seq: 3, role: "bot", senderBotId: "bot_b", runId: "run_1", promptRequestId: "p_1", content: "Findings report", createdAt: "now" },
      ];
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
          botId: "bot_b", batch: 1, memberIndex: 1, attempt: 1, origin: "handoff",
          state: "completed", promptRequestId: "p_1", assignmentId: "assignment_b", createdAt: "now",
        },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
        attachTo: document.body,
      });
      await flushPromises();
      const scroller = wrapper.get('[data-test="group-transcript-scroller"]').element as HTMLElement;
      const row = wrapper.get('[data-message-id="reply_3"]');
      expect(row.attributes("data-anchor-id")).toBe("turn_b");
      expect(row.attributes("data-row-id")).toBe("reply_3");
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect);
      vi.spyOn(row.element as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 210 } as DOMRect);
      scroller.scrollTop = 25;
      // The lone dispatch renders the aggregate row; its member row carries the
      // jump to the member's own reply.
      await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
      await wrapper.get('[data-test="group-dispatch-member"]').trigger("click");
      await flushPromises();
      // The jump scrolls the bubble row to the viewport top and focuses it.
      expect(scroller.scrollTop).toBe(225);
      expect(document.activeElement).toBe(row.element);
      wrapper.unmount();
    });

  });

  describe("GroupTranscript.vue scroll behavior", () => {
    // jsdom has no layout engine, so scrollHeight/clientHeight stay 0 and any
    // scroll assertion is trivially true. Give the scroller a fake geometry:
    // 1000px of content, a 100px viewport, so scrollTop has real meaning.
    const VIEWPORT = 100;

    interface Geometry {
      /** Content height, mutable so a prepend or a stream can grow the list. */
      content: number;
      scrollTop: number;
      el: HTMLElement;
      grow(by: number): void;
    }

    /** Rows for the anchor functions. Each rendered message row pretends to be
     *  ROW_H tall, stacked without gaps, starting at the scroller's content top.
     *  `getBoundingClientRect` is geometry, not pixels: the scroller reads its
     *  own viewport origin and each row reads its list index, so prepends shift
     *  every row's top by exactly the inserted height while a tail append leaves
     *  the rows above it untouched.
     *
     *  jsdom returns zero rects for every element by default, so the stub must
     *  cover the exact call surface the component uses. Most importantly, the
     *  scroll-container getter MUST differ from the row getter: rows are
     *  positioned by list index, while the scroller itself just reports a fixed
     *  viewport origin. */
    const ROW_H = 60;
    function withRowGeometry(scrollerEl: HTMLElement, getScrollTop: () => number): void {
      const rowsOf = (): HTMLElement[] =>
        Array.from(scrollerEl.querySelectorAll<HTMLElement>("[data-message-id],[data-anchor-id]"));
      scrollerEl.getBoundingClientRect = () => (
        { top: 100, bottom: 200, left: 0, right: 0, width: 0, height: VIEWPORT, x: 0, y: 100, toJSON: () => ({}) } as DOMRect
      );
      const patchRow = (row: HTMLElement): void => {
        row.getBoundingClientRect = () => {
          const index = rowsOf().indexOf(row);
          const top = 100 + index * ROW_H - getScrollTop();
          return { top, bottom: top + ROW_H, left: 0, right: 0, width: 0, height: ROW_H, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
        };
      };
      // Patch rows as they render: the component queries them at capture and
      // restore time, so patching lazily on query keeps the indices live.
      // querySelectorAll covers captureAnchor; querySelector covers restoreAnchor.
      const originalQueryAll = scrollerEl.querySelectorAll.bind(scrollerEl);
      scrollerEl.querySelectorAll = ((selector: string, ...rest: unknown[]) => {
        const found = (originalQueryAll as (...a: unknown[]) => NodeListOf<HTMLElement>)(selector, ...rest);
        if (selector.includes("[data-message-id]") || selector.includes("[data-anchor-id]")) found.forEach(patchRow);
        return found;
      }) as typeof scrollerEl.querySelectorAll;
      const originalQueryOne = scrollerEl.querySelector.bind(scrollerEl);
      scrollerEl.querySelector = ((selector: string, ...rest: unknown[]) => {
        const found = (originalQueryOne as (...a: unknown[]) => HTMLElement | null)(selector, ...rest);
        if (found && (selector.includes("[data-message-id") || selector.includes("[data-anchor-id"))) patchRow(found);
        return found;
      }) as typeof scrollerEl.querySelector;
      // The container itself must never be treated as a row: guard the two
      // entry points against a selector that would match the scroller.
      if (scrollerEl.hasAttribute("data-message-id")) {
        throw new Error("test harness: scroller must not carry data-message-id");
      }
    }

    function withGeometry(el: HTMLElement): Geometry {
      const g: Geometry = { content: 1000, scrollTop: 0, el, grow: (by) => { g.content += by; } };
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollHeight", {
        get: () => g.content,
        configurable: true,
      });
      Object.defineProperty(el, "scrollTop", {
        // Emulate the browser clamp: scrollTop can never exceed
        // scrollHeight - clientHeight, which is what "at the bottom" means.
        get: () => Math.min(g.scrollTop, g.content - VIEWPORT),
        set: (v: number) => { g.scrollTop = v; },
        configurable: true,
      });
      withRowGeometry(el, () => g.scrollTop);
      return g;
    }

    function mountTranscript(): { wrapper: ReturnType<typeof mount>; geo: Geometry } {
      const wrapper = mount(GroupTranscript, { props: { bots: BOTS }, global: { plugins: [i18n] } });
      const geo = withGeometry(wrapper.find('[data-test="group-transcript-scroller"]').element as HTMLElement);
      return { wrapper, geo };
    }

    function seedMessages(count: number): void {
      const groups = useGroupsStore();
      groups.messages = Array.from({ length: count }, (_, i) => ({
        id: `msg_${i}`,
        conversationId: "conversation_g",
        topicId: "topic_1",
        seq: i + 1,
        role: i % 2 === 0 ? ("human" as const) : ("bot" as const),
        content: `message ${i}`,
        createdAt: "2026-09-01T00:00:00.000Z",
      }));
      groups.newestSeq = count;
      groups.oldestSeq = 1;
      groups.contiguousNewestSeq = count;
      groups.hasMoreBefore = true;
      groups.topicReady = true;
    }

    function scrollerOf(wrapper: ReturnType<typeof mount>): HTMLElement {
      return wrapper.find('[data-test="group-transcript-scroller"]').element as HTMLElement;
    }

    it("pins to the newest message when history lands", async () => {
      seedGroupSelection();
      const groups = useGroupsStore();
      groups.topicReady = false;
      const { wrapper, geo } = mountTranscript();
      // Content grows as history is loaded.
      geo.grow(500);
      seedMessages(20);
      await flushPromises();
      // Bottom means the reader is at scrollHeight - clientHeight. Asserted
      // against the live geometry rather than a hard-coded number so the check
      // stays meaningful when the content height moves.
      const el = scrollerOf(wrapper);
      expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
      expect(el.scrollTop).toBeGreaterThan(1200);
    });

    it("follows streaming output while already at the bottom", async () => {
      seedGroupSelection();
      const { wrapper, geo } = mountTranscript();
      seedMessages(4);
      await flushPromises();
      const el = scrollerOf(wrapper);
      // The initial history pin has already left the reader at the bottom.
      expect(el.scrollTop).toBe(900);
      const groups = useGroupsStore();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now", startedAt: "now",
      };
      groups.liveTurnsByMember = { turn_a: { parts: [], status: "streaming", startedAt: 1, revision: 1 } };
      await flushPromises();
      // Streaming output grows the transcript: without a follow, the reader is
      // left 120px short of the new bottom.
      geo.grow(120);
      groups.liveTurnsByMember = { turn_a: { parts: [], status: "streaming", startedAt: 1, revision: 2 } };
      await flushPromises();
      expect(el.scrollTop).toBe(1020);
    });

    it("does not yank a reader who scrolled up during streaming", async () => {
      seedGroupSelection();
      const { wrapper, geo } = mountTranscript();
      seedMessages(4);
      await flushPromises();
      const el = scrollerOf(wrapper);
      const groups = useGroupsStore();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now", startedAt: "now",
      };
      groups.liveTurnsByMember = { turn_a: { parts: [], status: "streaming", startedAt: 1, revision: 1 } };
      await flushPromises();
      // Reader scrolls up mid-transcript and stays there.
      el.scrollTop = 120;
      await wrapper.find('[data-test="group-transcript-scroller"]').trigger("scroll");
      // Content grows while the reader is reading up-transcript: a follow here
      // would yank them to 1020.
      geo.grow(120);
      groups.liveTurnsByMember = { turn_a: { parts: [], status: "streaming", startedAt: 1, revision: 9 } };
      await flushPromises();
      expect(el.scrollTop).toBe(120);
    });

    it("keeps the visible anchor when older history is prepended", async () => {
      seedGroupSelection();
      const { wrapper, geo } = mountTranscript();
      seedMessages(10);
      await flushPromises();
      const el = scrollerOf(wrapper);
      // Reader sits 520px above the bottom. The first visible row is msg_8:
      // rows are 60px tall and 10 of them start at scrollTop 480.
      el.scrollTop = 480;
      const loadSpy = vi.spyOn(useGroupsStore(), "loadOlder").mockImplementation(async () => {
        const g = useGroupsStore();
        // Prepending 5 rows grows the content by 300px, which is what makes
        // restoring the anchor necessary.
        geo.grow(300);
        g.messages = [
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `msg_old_${i}`, conversationId: "conversation_g", topicId: "topic_1", seq: -4 + i,
            role: "human" as const, content: "old", createdAt: "2026-08-01T00:00:00.000Z",
          })),
          ...g.messages,
        ];
      });
      await wrapper.find('[data-test="group-load-older-button"]').trigger("click");
      await flushPromises();
      await flushPromises();
      // The restore shifts scrollTop by exactly the prepended height, so the
      // anchored message keeps its viewport position.
      expect(el.scrollTop).toBe(780);
      loadSpy.mockRestore();
    });

    // Rows above a parked reader keep changing height after they render: a
    // content-visibility row swaps its 88px estimate for its real height when it
    // nears the viewport. The scroller opts out of browser scroll anchoring, so
    // the component itself must hold the reader's row through every resize.
    it("holds a parked reader's row when content above it changes height", async () => {
      const observers: Array<() => void> = [];
      vi.stubGlobal("ResizeObserver", class {
        constructor(cb: () => void) { observers.push(cb); }
        observe() {}
        unobserve() {}
        disconnect() {}
      });
      try {
        seedGroupSelection();
        const { wrapper, geo } = mountTranscript();
        seedMessages(10);
        await flushPromises();
        const el = scrollerOf(wrapper);
        el.scrollTop = 480;
        await wrapper.find('[data-test="group-transcript-scroller"]').trigger("scroll");
        // A row above the viewport settles 60px taller; the browser leaves
        // scrollTop alone, so msg_8 would slide down out of view.
        geo.grow(60);
        const groups = useGroupsStore();
        groups.messages = [
          { id: "msg_settled", conversationId: "conversation_g", topicId: "topic_1", seq: 0,
            role: "human" as const, content: "settled", createdAt: "2026-08-01T00:00:00.000Z" },
          ...groups.messages,
        ];
        await flushPromises();
        expect(el.scrollTop).toBe(480);
        observers.forEach((cb) => cb());
        expect(el.scrollTop).toBe(540);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // The member activity row sits between the request and the oldest plain
    // rows: the reader parked on it must survive the prepend too, and the
    // member row is the only anchor carrying the request id's neighbor.
    it("keeps the member activity row anchored when older history is prepended", async () => {
      seedGroupSelection();
      const groups = useGroupsStore();
      groups.messages = [
        { id: "msg_request", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "2026-09-01T00:00:00.000Z" },
      ];
      groups.newestSeq = 1;
      groups.oldestSeq = 1;
      groups.contiguousNewestSeq = 1;
      groups.hasMoreBefore = true;
      groups.topicReady = true;
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_request", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      const { wrapper, geo } = mountTranscript();
      await flushPromises();
      const el = scrollerOf(wrapper);
      // Viewport opens exactly on the activity row: the request row above is
      // out, so the MemberTurn's own row must be what the anchor locks onto.
      el.scrollTop = 60;
      await wrapper.find('[data-test="group-transcript-scroller"]').trigger("scroll");
      expect(el.querySelector<HTMLElement>('[data-anchor-id="turn_a"]')!.getBoundingClientRect().top).toBe(100);
      const anchors = Array.from(el.querySelectorAll<HTMLElement>("[data-anchor-id]"))
        .map((row) => row.getAttribute("data-anchor-id"));
      expect(anchors).toContain("turn_a");
      expect(new Set(anchors).size).toBe(anchors.length);
      const loadSpy = vi.spyOn(useGroupsStore(), "loadOlder").mockImplementation(async () => {
        const g = useGroupsStore();
        geo.grow(300);
        g.messages = [
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `msg_old_${i}`, conversationId: "conversation_g", topicId: "topic_1", seq: -4 + i,
            role: "human" as const, content: "old", createdAt: "2026-08-01T00:00:00.000Z",
          })),
          ...g.messages,
        ];
      });
      await wrapper.find('[data-test="group-load-older-button"]').trigger("click");
      await flushPromises();
      await flushPromises();
      expect(el.scrollTop).toBe(360);
      expect(el.querySelector<HTMLElement>('[data-anchor-id="turn_a"]')!.getBoundingClientRect().top).toBe(100);
      loadSpy.mockRestore();
    });

    // REGRESSION (red-first): a live tail message that lands BEFORE the
    // parked older page returns must not consume the pending anchor.
    //
    // The stubbed geometry reports row tops from list index minus the harness
    // scroll log, so the test tracks scrollTop writes: none at all for the
    // tail append, exactly one restore (+300) for the real prepend.
    it("does not move the reader when a live message lands during a parked Load Older", async () => {
      seedGroupSelection();
      const { wrapper, geo } = mountTranscript();
      seedMessages(10);
      await flushPromises();
      const el = scrollerOf(wrapper);
      // Count every scrollTop write the component performs.
      const writes: number[] = [];
      const scrollTopDesc = Object.getOwnPropertyDescriptor(el, "scrollTop");
      const origSet = scrollTopDesc?.set;
      const origGet = scrollTopDesc?.get;
      Object.defineProperty(el, "scrollTop", {
        get: origGet,
        set: (v: number) => { writes.push(v); origSet?.call(el, v); },
        configurable: true,
      });
      // Reader sits 520px above the bottom: scrollTop 480 shows rows 8..9 of
      // the 10 seeded rows (60px each), so the anchor must be msg_8. The write
      // below is harness setup, not component behavior. Record the reader's
      // real position first: without a scroll event the component still thinks
      // it is at the bottom, and a tail append would legitimately follow it.
      el.scrollTop = 480;
      await wrapper.find('[data-test="group-transcript-scroller"]').trigger("scroll");
      expect(writes).toEqual([480]);
      writes.length = 0;
      expect((wrapper.find('[data-test="group-load-older-button"]').element as HTMLButtonElement).disabled).toBe(false);
      // Park the older-page RPC BEFORE it projects anything: the store only
      // merges the older rows into `messages` after the network returns, so a
      // live message can (and here does) land first.
      const releaseLoad = Promise.withResolvers<void>();
      const loadSpy = vi.spyOn(useGroupsStore(), "loadOlder").mockImplementation(async () => {
        await releaseLoad.promise;
        const g = useGroupsStore();
        // The older page finally arrives: 5 rows (+300px) at the TOP.
        g.messages = [
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `msg_old_${i}`, conversationId: "conversation_g", topicId: "topic_1", seq: -4 + i,
            role: "human" as const, content: "old", createdAt: "2026-08-01T00:00:00.000Z",
          })),
          ...g.messages,
        ];
        geo.grow(300);
      });
      await wrapper.find('[data-test="group-load-older-button"]').trigger("click");
      await flushPromises();
      // A live message appends below the viewport while the older page is
      // still parked. The geometry grows, but the anchored row does not move —
      // and the parked anchor must survive this growth, so no write may happen.
      geo.grow(60);
      {
        const g = useGroupsStore();
        g.messages = [
          ...g.messages,
          { id: "msg_live", conversationId: "conversation_g", topicId: "topic_1", seq: 11, role: "bot", content: "live", createdAt: "2026-09-02T00:00:00.000Z" },
        ];
      }
      await flushPromises();
      await flushPromises();
      expect(writes).toEqual([]);
      // Release the parked page: the only legitimate shift is the 300px the
      // prepend added above the anchored row.
      releaseLoad.resolve();
      await flushPromises();
      await flushPromises();
      expect(writes).toEqual([780]);
      expect(geo.content).toBe(1360);
      loadSpy.mockRestore();
    });

    // A canonical reply promotes the member-activity row in place: the row
    // count is unchanged (activity -> msg:reply) and recovery/history fires no
    // live revision, so only the item keys can tell the transcript got taller.
    const canonicalReply = {
      id: "msg_reply", conversationId: "conversation_g", topicId: "topic_1", seq: 2,
      role: "bot" as const, runId: "run_1", senderBotId: "bot_a", promptRequestId: "src_t1",
      content: "Shipped", createdAt: "2026-09-01T00:00:01.000Z",
    };
    function seedPromotableActivity(): void {
      const groups = seedGroupSelection();
      groups.messages = [
        { id: "msg_req", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "2026-09-01T00:00:00.000Z" },
      ];
      groups.newestSeq = 1;
      groups.oldestSeq = 1;
      groups.contiguousNewestSeq = 1;
      groups.topicReady = true;
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_req", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          promptRequestId: "src_t1", state: "running", createdAt: "now",
        },
      };
    }
    function rowIds(el: HTMLElement): string[] {
      return Array.from(el.querySelectorAll<HTMLElement>("[data-row-id]"))
        .map((row) => row.getAttribute("data-row-id") ?? "");
    }

    it("follows the bottom when a member activity is promoted to its canonical reply", async () => {
      seedPromotableActivity();
      const { wrapper, geo } = mountTranscript();
      await flushPromises();
      const el = scrollerOf(wrapper);
      const groups = useGroupsStore();
      // The activity row stands in for the reply that has not landed yet.
      expect(rowIds(el)).toEqual(["msg_req", "turn_a"]);
      expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
      // The canonical row is taller than the activity row it replaces.
      geo.grow(60);
      groups.messages = [...groups.messages, canonicalReply];
      await flushPromises();
      // Same row count: only the item keys (and the height) changed.
      expect(rowIds(el)).toEqual(["msg_req", "msg_reply"]);
      expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
      expect(el.scrollTop).toBe(960);
    });

    it("keeps a parked reader in place when a member activity is promoted to its canonical reply", async () => {
      seedPromotableActivity();
      const { wrapper, geo } = mountTranscript();
      await flushPromises();
      const el = scrollerOf(wrapper);
      const groups = useGroupsStore();
      // Reader scrolls up out of the follow zone.
      el.scrollTop = 120;
      await wrapper.find('[data-test="group-transcript-scroller"]').trigger("scroll");
      geo.grow(60);
      groups.messages = [...groups.messages, canonicalReply];
      await flushPromises();
      expect(rowIds(el)).toEqual(["msg_req", "msg_reply"]);
      expect(el.scrollTop).toBe(120);
    });
  });

  describe("GroupPane.vue", () => {
    it("offers persisted worktree integration after reconnect without an active Run owner", async () => {
      const groups = seedGroupSelection(); groups.activeRun = null;
      groups.topicsByConversation["i1:conversation_g"]![0]!.executionTarget = { workspace: "repo", isolation: "worktree-per-member" };
      groups.messages = [{ id: "m", conversationId: "conversation_g", topicId: "topic_1", runId: "settled-run", role: "bot", seq: 1, content: "done", createdAt: "now" }];
      const wrapper = mount(GroupPane, { global: { plugins: [i18n], stubs: {
        ConversationWorktreePanel: { props: ["instanceId", "runId"], template: '<div data-test="restored-worktree">{{ runId }}</div>' },
      } } });
      await flushPromises(); expect(wrapper.find('[data-test="restored-worktree"]').text()).toBe("settled-run"); wrapper.unmount();
    });
    it("binds transcript, composer, and topic switcher without touching Direct state", async () => {
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

    it("mobile bar switches topics from the bottom sheet", async () => {
      const groups = seedGroupSelection();
      groups.topicsByConversation["i1:conversation_g"]!.push({ id: "topic_2", conversationId: "conversation_g", title: "Release", status: "active", createdAt: "now", updatedAt: "now" });
      const switchTopic = vi.spyOn(groups, "switchTopic").mockResolvedValue();
      window.innerWidth = 500;
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      await wrapper.find('[data-test="group-topic-pill"]').trigger("click");
      const sheet = wrapper.find('[data-test="group-topic-sheet"]');
      expect(sheet.exists()).toBe(true);
      expect(sheet.findAll('[data-test="topic-row"]')).toHaveLength(2);
      expect(sheet.find('[data-test="group-new-topic-button"]').exists()).toBe(true);
      await sheet.findAll('[data-test="topic-row"]')[1]!.find("button").trigger("click");
      expect(switchTopic).toHaveBeenCalledWith("topic_2");
      expect(wrapper.find('[data-test="group-topic-sheet"]').exists()).toBe(false);
    });

    it("desktop popover switches topics and keeps new-topic inside the panel", async () => {
      const groups = seedGroupSelection();
      groups.topicsByConversation["i1:conversation_g"]!.push({ id: "topic_2", conversationId: "conversation_g", title: "Release", status: "active", createdAt: "now", updatedAt: "now" });
      const switchTopic = vi.spyOn(groups, "switchTopic").mockResolvedValue();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      // Only the desktop header's pill is mounted from lg.
      expect(wrapper.findAll('[data-test="group-topic-pill"]')).toHaveLength(1);
      await wrapper.find('[data-test="group-topic-pill"]').trigger("click");
      const panel = wrapper.find('[data-test="topic-panel"]');
      expect(panel.exists()).toBe(true);
      expect(panel.find('[data-test="group-new-topic-button"]').exists()).toBe(true);
      await panel.findAll('[data-test="topic-row"]')[1]!.find("button").trigger("click");
      expect(switchTopic).toHaveBeenCalledWith("topic_2");
      expect(wrapper.find('[data-test="topic-panel"]').exists()).toBe(false);
    });

    it("row menu carries rename / archive / delete behind the trailing ⋯", async () => {
      const groups = seedGroupSelection();
      groups.topicsByConversation["i1:conversation_g"]!.push({ id: "topic_2", conversationId: "conversation_g", title: "Release", status: "active", createdAt: "now", updatedAt: "now" });
      const archiveTopic = vi.spyOn(groups, "archiveTopic").mockResolvedValue({} as never);
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      await wrapper.find('[data-test="group-topic-pill"]').trigger("click");
      const panel = wrapper.find('[data-test="topic-panel"]');
      await panel.findAll('[data-test="topic-row-more"]')[1]!.trigger("click");
      const menu = wrapper.find('[data-test="context-menu"]');
      expect(menu.find('[data-test="menu-rename"]').exists()).toBe(true);
      expect(menu.find('[data-test="menu-archive"]').exists()).toBe(true);
      expect(menu.find('[data-test="menu-delete"]').exists()).toBe(true);
      await menu.find('[data-test="menu-archive"]').trigger("click");
      expect(archiveTopic).toHaveBeenCalledWith("i1", "conversation_g", "topic_2");
    });

    it("offers the isolation switch only when the instance advertises it", async () => {
      seedGroupSelection();
      const groups = useGroupsStore();
      groups.topicsByConversation["i1:conversation_g"]![0]!.executionTarget = { workspace: "repo", isolation: "shared-single-writer" };
      const withoutCap = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      await withoutCap.find('[data-test="group-topic-pill"]').trigger("click");
      await withoutCap.find('[data-test="topic-panel"]').findAll('[data-test="topic-row-more"]')[0]!.trigger("click");
      expect(withoutCap.find('[data-test="menu-isolation"]').exists()).toBe(false);
      withoutCap.unmount();

      // An older core answers `unknown-type` for the RPC, which a user cannot act
      // on, so the entry only appears once the instance advertises the capability.
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.groupTopicIsolationV1];
      const withCap = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      await withCap.find('[data-test="group-topic-pill"]').trigger("click");
      await withCap.find('[data-test="topic-panel"]').findAll('[data-test="topic-row-more"]')[0]!.trigger("click");
      expect(withCap.find('[data-test="menu-isolation"]').exists()).toBe(true);
      withCap.unmount();
    });

    it("surfaces a failed row-menu action inside the panel", async () => {
      const groups = seedGroupSelection();
      groups.topicsByConversation["i1:conversation_g"]!.push({ id: "topic_2", conversationId: "conversation_g", title: "Release", status: "active", createdAt: "now", updatedAt: "now" });
      vi.spyOn(groups, "archiveTopic").mockRejectedValue(new Error("archive blew up"));
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      await wrapper.find('[data-test="group-topic-pill"]').trigger("click");
      await wrapper.find('[data-test="topic-panel"]').findAll('[data-test="topic-row-more"]')[1]!.trigger("click");
      await wrapper.find('[data-test="menu-archive"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="topic-action-error"]').text()).toBe("archive blew up");
    });

    it("mounts exactly one TopicSwitcher per breakpoint: the header's on desktop, the mobile bar's below lg", async () => {
      seedGroupSelection();
      window.innerWidth = 1280;
      const desktop = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(desktop.findAll('[data-test="group-topic-pill"]')).toHaveLength(1);
      expect(desktop.find('header [data-test="group-topic-pill"]').exists()).toBe(true);
      desktop.unmount();
      window.innerWidth = 500;
      const mobile = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(mobile.findAll('[data-test="group-topic-pill"]')).toHaveLength(1);
      expect(mobile.find('header [data-test="group-topic-pill"]').exists()).toBe(false);
      mobile.unmount();
    });

    it("shows Default on both mobile and desktop when no topic is active", async () => {
      const groups = seedGroupSelection();
      groups.activeTopicId = null;
      for (const width of [1280, 500]) {
        window.innerWidth = width;
        const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
        await flushPromises();
        const pills = wrapper.findAll('[data-test="group-topic-pill"]');
        expect(pills).toHaveLength(1);
        expect(pills[0]!.text()).toBe("Default");
        wrapper.unmount();
      }
    });

    it("renders no topic pill with zero Topics on desktop and mobile, keeping the Create first Topic CTA", async () => {
      const groups = seedGroupSelection();
      groups.activeTopicId = null;
      groups.topicsByConversation["i1:conversation_g"] = [];
      for (const width of [1280, 390]) {
        window.innerWidth = width;
        const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
        await flushPromises();
        expect(wrapper.findAll('[data-test="group-topic-pill"]')).toHaveLength(0);
        expect(wrapper.find('[data-test="group-first-topic"]').exists()).toBe(true);
        expect(wrapper.find('[data-test="group-first-topic-button"]').exists()).toBe(true);
        expect(wrapper.find('[data-test="group-pane-member-count"]').exists()).toBe(true);
        wrapper.unmount();
      }
    });

    it("zero Topics: composer disabled with a create-topic placeholder, no member selector or hint", async () => {
      const groups = seedGroupSelection();
      groups.activeTopicId = null;
      groups.topicsByConversation["i1:conversation_g"] = [];
      for (const width of [1280, 390]) {
        window.innerWidth = width;
        const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
        await flushPromises();
        const textarea = wrapper.find('[data-test="group-composer-textarea"]').element as HTMLTextAreaElement;
        expect(textarea.disabled).toBe(true);
        expect(textarea.placeholder).toBe(i18n.global.t("group.prompt.createTopicFirst"));
        // Visibly disabled: the whole composer card is dimmed with a not-allowed cursor.
        const surface = wrapper.find('[data-test="composer-surface"]');
        expect(surface.classes()).toEqual(expect.arrayContaining(["opacity-60", "cursor-not-allowed"]));
        expect(surface.attributes("aria-disabled")).toBe("true");
        expect(wrapper.find('[data-test="group-target-button"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(i18n.global.t("group.target.hint"));
        // The centre CTA stays the only primary action.
        expect(wrapper.find('[data-test="group-first-topic-button"]').exists()).toBe(true);
        wrapper.unmount();
      }
    });

    it("with a Topic the member selector and the normal placeholder come back", async () => {
      seedGroupSelection();
      window.innerWidth = 1280;
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]').element as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe(i18n.global.t("group.prompt.placeholder"));
      expect(wrapper.find('[data-test="group-target-button"]').exists()).toBe(true);
      // Enabled appearance is unchanged: no dimming on the card.
      const surface = wrapper.find('[data-test="composer-surface"]');
      expect(surface.classes()).not.toContain("opacity-60");
      expect(surface.classes()).not.toContain("cursor-not-allowed");
      wrapper.unmount();
    });

    it("pluralizes the member count (1 member / 2 members)", () => {
      i18n.global.locale.value = "en";
      expect(i18n.global.t("group.header.members", 1)).toBe("1 member");
      expect(i18n.global.t("group.header.members", 2)).toBe("2 members");
    });



    it("mobile ⋯ sheet opens the group editor and ← emits back", async () => {
      seedGroupSelection();
      window.innerWidth = 500;
      const wrapper = mount(GroupPane, { global: { plugins: [i18n], stubs: { teleport: true } } });
      await flushPromises();
      await wrapper.find('[data-test="mobile-group-more"]').trigger("click");
      const sheet = wrapper.find('[data-test="group-more-sheet"]');
      expect(sheet.exists()).toBe(true);
      await sheet.find('[data-test="sheet-group-edit"]').trigger("click");
      expect(wrapper.find('[data-test="group-dialog-title"]').exists()).toBe(true);
      await wrapper.find('[data-test="mobile-back"]').trigger("click");
      expect(wrapper.emitted("back")).toHaveLength(1);
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
