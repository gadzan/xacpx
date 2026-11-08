import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { api } from "../api/client";
import { MSG } from "@ganglion/xacpx-relay-protocol";
import { groupDraftKey, loadDraft } from "../lib/composer-drafts";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useConversationCommandsStore } from "../stores/conversation-commands";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useComposerStore } from "../stores/composer";
import { useInstancesStore } from "../stores/instances";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import GroupPane from "../components/GroupPane.vue";
import GroupComposer from "../components/GroupComposer.vue";
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
      capabilities: [RELAY_CAPABILITIES.conversationTimelineV1],
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
    // Drafts persist in sessionStorage: without a reset a previous test's text
    // would be restored into the next composer and shift the mention caret.
    sessionStorage.clear();
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
    it("uses the short single-line placeholder below 640px", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const width = window.innerWidth;
      window.innerWidth = 390;
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      try {
        expect(wrapper.find('[data-test="group-composer-textarea"]').attributes("placeholder")).toBe("Message members… (@ to mention)");
        i18n.global.locale.value = "zh-CN";
        await wrapper.vm.$nextTick();
        expect(wrapper.find('[data-test="group-composer-textarea"]').attributes("placeholder")).toBe("发消息给成员…（@ 指定）");
      } finally {
        wrapper.unmount();
        i18n.global.locale.value = "en";
        window.innerWidth = width;
      }
    });

    it("renders the lead-named composer placeholder in both locales", async () => {
      seedGroupSelection();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      // A plain Group message targets the lead implicitly; the placeholder names it.
      expect(wrapper.find('[data-test="group-composer-textarea"]').attributes("placeholder")).toBe("Message Reviewer");
      i18n.global.locale.value = "zh-CN";
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[data-test="group-composer-textarea"]').attributes("placeholder")).toBe("发消息给 Reviewer");
      i18n.global.locale.value = "en";
      const compileErrors = [...errors.mock.calls, ...warns.mock.calls]
        .filter((args) => String(args[0]).includes("compilation error"));
      expect(compileErrors).toEqual([]);
      errors.mockRestore();
      warns.mockRestore();
    });

    it("sends a plain message with no wire target so the server resolves the lead", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("please review this");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      // `null` is the implicit lead: no target picker, no client-side lead choice.
      expect(wrapper.emitted("send")?.[0]).toEqual(["please review this", [], null]);
    });

    it("keeps the typed draft when the text is empty", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // No target is required any more, so only an empty draft blocks Send.
      expect(wrapper.find('[data-test="group-send-prompt-button"]').attributes("disabled")).toBeDefined();
      await textarea.trigger("keydown", { key: "Enter" });
      expect((textarea.element as HTMLTextAreaElement).value).toBe("");
    });

    it("names the disabled lead in the placeholder and lets the server refuse", async () => {
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
      // No substitution in the UI: the backend owns the refusal with bot_disabled.
      expect(wrapper.find('[data-test="group-composer-textarea"]').attributes("placeholder")).toBe("Message Sleeper");
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("hello");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")?.[0]?.[2]).toBeNull();
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

    it("never renders its own Stop: Stop all belongs to the status bar", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false);
      await textarea.setValue("steer this");
      // One Stop control exists, above the composer. A second one inside the
      // card would compete for the same Run.
      expect(wrapper.find('[data-test="group-stop-run-button"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-send-prompt-button"]').exists()).toBe(true);
    });

    it("keeps sending allowed while a Run is active (the prompt queues)", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("queue this");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")?.[0]).toEqual(["queue this", [], null]);
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


    it("the @ chip opens the member menu and sends the members it selects in parallel", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-mention-chip"]').trigger("click");
      const row = wrapper.find('[data-test="group-mention-item"][data-bot-id="bot_b"]');
      expect(row.exists()).toBe(true);
      await row.trigger("click");
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("@Tester please review");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      // A member mention is an explicit parallel target.
      expect(wrapper.emitted("send")?.[0]).toEqual([
        "@Tester please review",
        [],
        { mode: "members", botIds: ["bot_b"] },
      ]);
    });

    it("marks a disabled member unavailable in the mention menu", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-mention-chip"]').trigger("click");
      const off = wrapper.find('[data-test="group-mention-item"][data-bot-id="bot_off"]');
      expect(off.exists()).toBe(true);
      expect(off.attributes("aria-disabled")).toBe("true");
    });

    it("treats a member's own dedicated workspace as runnable in the mention menu", async () => {
      const groups = seedGroupSelection();
      groups.groupsByInstance["i1"] = [{ ...GROUP, botIds: ["bot_a", "bot_b", "bot_isolated"] }];
      groups.groupDetails["i1:conversation_g"] = {
        ...GROUP, botIds: ["bot_a", "bot_b", "bot_isolated"], topics: [],
      } as never;
      const isolated: BotSummaryDto = {
        id: "bot_isolated",
        name: "Isolated",
        agent: "codex",
        workspace: "Isolated",
        dedicatedWorkspace: { name: "Isolated", path: "/home/u/.xacpx/bots/Isolated" },
        enabled: true,
        updatedAt: "now",
      };
      const wrapper = mount(GroupComposer, {
        // The instance's registered workspaces deliberately omit the dedicated
        // directory: the Bot's own marker is the only availability record.
        props: { bots: [...BOTS, isolated] },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-mention-chip"]').trigger("click");
      const row = wrapper.find('[data-test="group-mention-item"][data-bot-id="bot_isolated"]');
      expect(row.attributes("aria-disabled")).toBe("false");
      expect(row.text()).not.toContain(i18n.global.t("group.target.noRuntime"));
      await row.trigger("click");
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("@Isolated please review");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")?.[0]?.[2]).toEqual({ mode: "members", botIds: ["bot_isolated"] });
    });

    it("reports No runtime for a workspace that is neither registered nor the Bot's own", async () => {
      const groups = seedGroupSelection();
      groups.groupsByInstance["i1"] = [{ ...GROUP, botIds: ["bot_a", "bot_b", "bot_stray"] }];
      groups.groupDetails["i1:conversation_g"] = {
        ...GROUP, botIds: ["bot_a", "bot_b", "bot_stray"], topics: [],
      } as never;
      const stray: BotSummaryDto = {
        id: "bot_stray",
        name: "Stray",
        agent: "codex",
        workspace: "gone",
        enabled: true,
        updatedAt: "now",
      };
      const wrapper = mount(GroupComposer, {
        props: { bots: [...BOTS, stray] },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-mention-chip"]').trigger("click");
      const row = wrapper.find('[data-test="group-mention-item"][data-bot-id="bot_stray"]');
      expect(row.attributes("aria-disabled")).toBe("true");
      expect(row.text()).toContain(i18n.global.t("group.target.noRuntime"));
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
      expect(wrapper.emitted("send")?.[0]).toEqual(["@everyone, please review", [], { mode: "everyone" }]);
      wrapper.unmount();
    });

    it("sends a staged image with empty text and clears the chip once the prompt is durable", async () => {
      sessionStorage.clear();
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, sendOutcome: () => Promise.resolve("accepted" as GroupSendOutcome) },
        global: { plugins: [i18n] },
      });
      const composer = useComposerStore();
      composer.bindInstance("i1", JSON.stringify(["group", "i1", "conversation_g", "topic_1"]));
      composer.pending.push({
        id: "local-1",
        uploadId: "u1",
        filename: "shot.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        filePath: "/uploads/u1/shot.png",
        status: "ready",
      });
      await flushPromises();
      const send = wrapper.find('[data-test="group-send-prompt-button"]');
      expect(send.attributes("disabled")).toBeUndefined();
      await send.trigger("click");
      await flushPromises();
      expect(wrapper.emitted("send")?.[0]).toEqual(["", [
        expect.objectContaining({ id: "u1", filePath: "/uploads/u1/shot.png", kind: "image" }),
      ], null]);
      expect(composer.pending).toHaveLength(0);
      wrapper.unmount();
    });

    it("ignores a second send while the first outcome is pending", async () => {
      seedGroupSelection();
      const gate = Promise.withResolvers<GroupSendOutcome>();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, sendOutcome: () => gate.promise },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("please review this");
      const send = wrapper.find('[data-test="group-send-prompt-button"]');
      await send.trigger("click");
      await send.trigger("click");
      // The first send owns the draft; a second click never mints a second request.
      expect(wrapper.emitted("send")).toHaveLength(1);
      gate.resolve("accepted");
      await flushPromises();
    });

    it("blocks Send and offers Retry while a prompt awaits confirmation", async () => {
      const groups = seedGroupSelection();
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
      expect(wrapper.find('[data-test="group-retry-prompt-button"]').exists()).toBe(true);
    });

    it("commits an unterminated mention at send time", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // Typing stops at EOF, so the mention is still uncommitted when Send runs.
      await textarea.setValue("@Tester please review");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      // The boundary commit runs before the target is derived; the per-message
      // payload is the authoritative target (the store resets afterwards).
      expect(wrapper.emitted("send")?.[0]?.[2]).toEqual({ mode: "members", botIds: ["bot_b"] });
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

    it("offers the lead's slash commands by default and keeps a rejected draft", async () => {
      seedGroupSelection();
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
      // No mention: the Group lead is the implicit slash target.
      await textarea.setValue("/co");
      expect(wrapper.find('[data-test="group-cmd-item"]').text()).toContain("/compact");
      await textarea.trigger("keydown", { key: "Enter" });
      expect(wrapper.emitted("send")).toBeUndefined();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("/compact ");
      await textarea.setValue("keep me");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      gate.resolve("rejected");
      await flushPromises();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("keep me");
    });

    it("resolves a slash command's target from the leading mention", async () => {
      seedGroupSelection();
      const commands = useConversationCommandsStore();
      commands.remember({
        instanceId: "i1", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a",
      }, [{ name: "compact", description: "Compact" }]);
      commands.remember({
        instanceId: "i1", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_b",
      }, [{ name: "diff", description: "Diff" }]);
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => b.enabled) },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      // The mention selects Tester's catalog; the command follows it.
      await textarea.setValue("@Tester /d");
      await flushPromises();
      expect(wrapper.find('[data-test="group-cmd-item"]').text()).toContain("/diff");
      await textarea.trigger("keydown", { key: "Enter" });
      expect(wrapper.emitted("send")).toBeUndefined();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("@Tester /diff ");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")?.[0]?.[2]).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("never broadcasts a slash command: @everyone still sends it to one Bot", async () => {
      seedGroupSelection();
      const commands = useConversationCommandsStore();
      commands.remember({
        instanceId: "i1", conversationId: "conversation_g", topicId: "topic_1", botId: "bot_a",
      }, [{ name: "compact", description: "Compact" }]);
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => b.enabled) },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("@everyone /compact");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      // The command is per-Bot: the lead is the only target, no confirm dialog.
      expect(wrapper.emitted("send")?.[0]?.[2]).toEqual({ mode: "members", botIds: ["bot_a"] });
    });

    it("has no target picker and no per-send automatic switch", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      // Automatic routing is a Group setting (P2), never a composer mode.
      expect(wrapper.find('[data-test="group-target-button"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-target-automatic"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-mention-chip"]').exists()).toBe(true);
    });

    it("hides the discussion chip when the instance lacks roundtable v1", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      expect(wrapper.find('[data-test="group-discuss-chip"]').exists()).toBe(false);
    });

    it("offers the discussion chip once roundtable v1 is advertised", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.roundtableV1];
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      expect(wrapper.find('[data-test="group-discuss-chip"]').exists()).toBe(true);
    });

    it("sends a one-round roundtable over all enabled members when discussing", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.roundtableV1];
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("compare the options");
      await wrapper.find('[data-test="group-discuss-chip"]').trigger("click");
      // Lead first, then the remaining enabled member; one round.
      expect(wrapper.emitted("send")?.[0]).toEqual([
        "compare the options",
        [],
        { mode: "roundtable", botIds: ["bot_a", "bot_b"], rounds: 1 },
      ]);
    });

    it("sends @everyone as a parallel everyone target, never a roundtable", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.roundtableV1];
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS, instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("@everyone please review");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      // Everyone confirms through the dialog; the target is parallel members.
      (document.body.querySelector('[data-test="composer-confirm-send"]') as HTMLElement).click();
      await flushPromises();
      expect(wrapper.emitted("send")?.[0]?.[2]).toEqual({ mode: "everyone" });
      // The selection is per message: the send clears it, so the next plain
      // message goes back to the implicit lead instead of everyone.
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("plain follow-up");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")?.[1]?.[2]).toBeNull();
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

    it("sends an @member draft to exactly that member", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-composer-textarea"]').setValue("@Tester check this ");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      expect(wrapper.emitted("send")?.[0]?.[2]).toEqual({ mode: "members", botIds: ["bot_b"] });
    });

    it("blocks an unresolvable @token: names it, keeps the draft, sends nothing", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@Nobody check this ");
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      await flushPromises();
      // The dialog names the token, not the member roster; nothing is sent.
      expect(document.body.querySelector('[data-test="group-unresolved-token"]')?.textContent).toBe("@Nobody");
      expect(wrapper.emitted("send")).toBeUndefined();
      expect((textarea.element as HTMLTextAreaElement).value).toBe("@Nobody check this ");
      // Dismissing keeps the block and the draft.
      (document.body.querySelector('[data-test="composer-confirm-cancel"]') as HTMLElement).click();
      await flushPromises();
      await wrapper.find('[data-test="group-send-prompt-button"]').trigger("click");
      await flushPromises();
      expect(wrapper.emitted("send")).toBeUndefined();
    });

    it("renders the mention chip without a second literal @", () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const chip = wrapper.find('[data-test="group-mention-chip"]');
      // The icon carries the glyph; the literal text is screen-reader only.
      expect(chip.text().replace("@", "")).toBe("");
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
      useInstancesStore().instances[0]!.capabilities = [
        RELAY_CAPABILITIES.conversationTimelineV1,
        RELAY_CAPABILITIES.groupTopicIsolationV1,
      ];
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

    it("zero Topics: composer disabled with a create-topic placeholder, no target picker", async () => {
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
        expect(wrapper.text()).not.toContain("@名称 添加成员");
        // The centre CTA stays the only primary action.
        expect(wrapper.find('[data-test="group-first-topic-button"]').exists()).toBe(true);
        wrapper.unmount();
      }
    });

    it("with a Topic the lead-named placeholder and the chips come back", async () => {
      seedGroupSelection();
      window.innerWidth = 1280;
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      const textarea = wrapper.find('[data-test="group-composer-textarea"]').element as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe("Message Reviewer");
      expect(wrapper.find('[data-test="group-target-button"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-mention-chip"]').exists()).toBe(true);
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

    it("shows one upgrade notice and disables writes without conversations.timeline.v1", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [];
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="timeline-upgrade-required"]').text())
        .toContain("This daemon is too old");
      expect(wrapper.find('[data-test="conversation-timeline-scroller"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="conversation-status-bar"]').exists()).toBe(false);
      const send = wrapper.find('[data-test="group-send-prompt-button"]');
      expect(send.exists()).toBe(true);
      expect(send.attributes("disabled")).toBeDefined();
      wrapper.unmount();
    });

    it("leaves no legacy transcript module behind to import", async () => {
      // Old daemons are unsupported, so the fallback modules are deleted
      // outright: nothing in the tree may resolve them again.
      for (const specifier of [
        "../components/GroupTranscript.vue",
        "../components/ConversationMessageList.vue",
        "../components/GroupDispatchRow.vue",
        "../components/GroupAgentTurnRow.vue",
        "../components/GroupWorkingRow.vue",
        "../components/GroupDispatchLeaderStop.vue",
        "../components/AgentThinkingBubble.vue",
      ]) {
        await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow();
      }
    });

    it("renders the one ConversationTimeline and status bar when the timeline capability exists", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type) => {
        if (type !== MSG.conversationTimeline) throw new Error(`unexpected ${String(type)}`);
        return {
          conversationId: "conversation_g",
          topicId: "topic_1",
          entries: [{
            kind: "message",
            key: "message:m1",
            anchorSeq: 1,
            message: {
              id: "m1", conversationId: "conversation_g", topicId: "topic_1", seq: 1,
              role: "human", content: "ship it", createdAt: "now",
            },
          }],
          hasMoreBefore: false,
          hasMoreAfter: false,
        } as never;
      });
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="conversation-timeline-scroller"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="timeline-upgrade-required"]').exists()).toBe(false);
      // No Run is active: the status bar stays out of the way.
      expect(wrapper.find('[data-test="conversation-status-bar"]').exists()).toBe(false);
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("opens the same Run-wide drawer from meta, avatar, speaker label and the status bar", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [
        RELAY_CAPABILITIES.conversationTimelineV1,
        RELAY_CAPABILITIES.runsCancelMemberV1,
      ];
      const run = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m_req", requestId: "req_1", mode: "explicit" as const,
        shape: "fanout" as const, state: "running" as const, profileRevision: 1,
        maxMemberTurns: 4, consumedMemberTurns: 1, createdAt: "now",
      };
      groups.activeRun = run;
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g",
            topicId: "topic_1",
            entries: [
              {
                kind: "message", key: "message:m_req", anchorSeq: 1,
                message: {
                  id: "m_req", conversationId: "conversation_g", topicId: "topic_1",
                  seq: 1, role: "human", content: "ship it", createdAt: "now",
                },
              },
              {
                kind: "message", key: "message:m_bot", anchorSeq: 2,
                runId: "run_1", memberTurnId: "turn_a", ownership: "exact",
                message: {
                  id: "m_bot", conversationId: "conversation_g", topicId: "topic_1",
                  seq: 2, role: "bot", senderBotId: "bot_a", memberTurnId: "turn_a",
                  runId: "run_1", content: "done", createdAt: "now",
                },
              },
            ],
            hasMoreBefore: false,
            hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) return { runs: [], missingRunIds: ["run_1"] } as never;
        if (type === MSG.runsTraceGet) return { events: [], hasMore: false } as never;
        return {} as never;
      });
      const wrapper = mount(GroupPane, {
        attachTo: document.body,
        global: { plugins: [i18n] },
      });
      await flushPromises();

      const openers = [
        '[data-test="timeline-open-detail"]',
        '[data-test="timeline-open-detail-avatar"]',
        '[data-test="transcript-speaker"]',
        '[data-test="conversation-status-speaker"]',
      ];
      for (const selector of openers) {
        const trigger = wrapper.find(selector);
        expect(trigger.exists(), selector).toBe(true);
        await trigger.trigger("click");
        await flushPromises();
        const card = document.body.querySelector('[data-test="group-detail-card"]');
        expect(card, selector).not.toBeNull();
        expect(card!.querySelector('[data-test="run-detail"]'), selector).not.toBeNull();
        expect(card!.querySelector('[data-test="run-member-list"]'), selector).not.toBeNull();
        // Stop all stays in the status bar; the drawer exposes only the
        // scoped Stop for the running fanout member.
        expect(card!.querySelector('[data-test="group-stop-run-button"]'), selector).toBeNull();
        expect(card!.querySelector('[data-test="run-stop-member"]'), selector).not.toBeNull();
        (card!.querySelector('[data-test="group-detail-close"]') as HTMLElement).click();
        await flushPromises();
        expect(document.body.querySelector('[data-test="group-detail-card"]'), selector).toBeNull();
      }
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("opens and closes the Run-wide drawer as a mobile sheet", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m_req", requestId: "req_1", mode: "explicit",
        shape: "fanout", state: "running", profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g",
            topicId: "topic_1",
            entries: [
              {
                kind: "message", key: "message:m_bot", anchorSeq: 2,
                runId: "run_1", memberTurnId: "turn_a", ownership: "exact",
                message: {
                  id: "m_bot", conversationId: "conversation_g", topicId: "topic_1",
                  seq: 2, role: "bot", senderBotId: "bot_a", memberTurnId: "turn_a",
                  runId: "run_1", content: "done", createdAt: "now",
                },
              },
            ],
            hasMoreBefore: false,
            hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) return { runs: [], missingRunIds: ["run_1"] } as never;
        if (type === MSG.runsTraceGet) return { events: [], hasMore: false } as never;
        return {} as never;
      });
      window.innerWidth = 500;
      const wrapper = mount(GroupPane, {
        attachTo: document.body,
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find('[data-test="timeline-open-detail"]').trigger("click");
      await flushPromises();
      const sheet = document.body.querySelector('[data-test="group-detail-sheet"]');
      expect(sheet).not.toBeNull();
      expect(sheet!.querySelector('[data-test="run-detail"]')).not.toBeNull();
      (sheet!.querySelector('[data-test="group-detail-close"]') as HTMLElement).click();
      await flushPromises();
      expect(document.body.querySelector('[data-test="group-detail-sheet"]')).toBeNull();
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("opens the drawer when the Run detail arrives after an uncached click", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      // No active Run and no cached history: the click must stash the target
      // and open once the batch read lands.
      const detail = {
        id: "run_uncached", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m_req", requestId: "req_1", mode: "explicit",
        shape: "fanout", state: "running", profileRevision: 1, createdAt: "now",
        memberTurns: [{
          id: "turn_u", runId: "run_uncached", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        }],
      };
      const batchGate = Promise.withResolvers<{ runs: (typeof detail)[]; missingRunIds: string[] }>();
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g",
            topicId: "topic_1",
            entries: [{
              kind: "message", key: "message:m_bot", anchorSeq: 2,
              runId: "run_uncached", memberTurnId: "turn_u", ownership: "exact",
              message: {
                id: "m_bot", conversationId: "conversation_g", topicId: "topic_1",
                seq: 2, role: "bot", senderBotId: "bot_a", memberTurnId: "turn_u",
                runId: "run_uncached", content: "done", createdAt: "now",
              },
            }],
            hasMoreBefore: false,
            hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) return batchGate.promise as never;
        if (type === MSG.runsTraceGet) return { events: [], hasMore: false } as never;
        return {} as never;
      });
      const wrapper = mount(GroupPane, {
        attachTo: document.body,
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find('[data-test="timeline-open-detail"]').trigger("click");
      // The click landed while the Run was still uncached: nothing may open yet.
      await flushPromises();
      expect(document.body.querySelector('[data-test="group-detail-card"]')).toBeNull();
      // The batch lands now and the pending open must be retried.
      batchGate.resolve({ runs: [detail], missingRunIds: [] });
      await flushPromises();
      await flushPromises();
      const card = document.body.querySelector('[data-test="group-detail-card"]');
      expect(card).not.toBeNull();
      expect(card!.querySelector('[data-test="run-detail"]')).not.toBeNull();
      expect(card!.querySelector('[data-test="run-member-name"]')?.textContent).toContain("Reviewer");
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("shows Run detail unavailable for a missing Run, and only Retry refetches it", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const detail = {
        id: "run_late", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m_req", requestId: "req_1", mode: "explicit",
        shape: "fanout", state: "running", profileRevision: 1, createdAt: "now",
        memberTurns: [{
          id: "turn_l", runId: "run_late", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        }],
      };
      const batches: string[][] = [];
      let missing = true;
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type, payload) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g",
            topicId: "topic_1",
            entries: [{
              kind: "message", key: "message:m_bot", anchorSeq: 2,
              runId: "run_missing", memberTurnId: "turn_m", ownership: "exact",
              message: {
                id: "m_bot", conversationId: "conversation_g", topicId: "topic_1",
                seq: 2, role: "bot", senderBotId: "bot_a", memberTurnId: "turn_m",
                runId: "run_missing", content: "done", createdAt: "now",
              },
            }],
            hasMoreBefore: false,
            hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) {
          const ids = (payload as { runIds: string[] }).runIds;
          batches.push(ids);
          if (ids.includes("run_missing")) {
            return (missing
              ? { runs: [], missingRunIds: ["run_missing"] }
              : { runs: [{ ...detail, id: "run_missing", memberTurns: detail.memberTurns.map((turn) => ({ ...turn, runId: "run_missing" })) }], missingRunIds: [] }) as never;
          }
          return { runs: [], missingRunIds: [] } as never;
        }
        if (type === MSG.runsTraceGet) return { events: [], hasMore: false } as never;
        return {} as never;
      });
      const wrapper = mount(GroupPane, {
        attachTo: document.body,
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const missingCalls = () => batches.filter((ids) => ids.includes("run_missing")).length;
      expect(missingCalls()).toBe(1);
      await wrapper.find('[data-test="timeline-open-detail"]').trigger("click");
      await flushPromises();
      expect(document.body.querySelector('[data-test="group-detail-card"]')).toBeNull();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(true);
      // An unrelated adopt bumps the revision but must not refetch the miss.
      groups.ensureRunDetails(["run_other"], true);
      await flushPromises();
      expect(missingCalls()).toBe(1);
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(true);
      // Retry is the one path that clears the entry: exactly one refetch.
      missing = false;
      await wrapper.find('[data-test="run-detail-retry"]').trigger("click");
      await flushPromises();
      await flushPromises();
      expect(missingCalls()).toBe(2);
      expect(document.body.querySelector('[data-test="group-detail-card"]')).not.toBeNull();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(false);
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("shows one upgrade notice with zero Topics and offers no create or send path", async () => {
      const groups = seedGroupSelection();
      groups.activeTopicId = null;
      groups.topicsByConversation["i1:conversation_g"] = [];
      useInstancesStore().instances[0]!.capabilities = [];
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      // Topic state never masks the minimum-version break: exactly one notice.
      expect(wrapper.findAll('[data-test="timeline-upgrade-required"]')).toHaveLength(1);
      expect(wrapper.find('[data-test="timeline-upgrade-required"]').text()).toContain("This daemon is too old");
      // No create-first-Topic CTA, no Topic entry point, no timeline.
      expect(wrapper.find('[data-test="group-first-topic"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-first-topic-button"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-topic-pill"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="conversation-timeline-scroller"]').exists()).toBe(false);
      // Writes are present but inert, never a control that looks usable.
      const send = wrapper.find('[data-test="group-send-prompt-button"]');
      expect(send.exists()).toBe(true);
      expect(send.attributes("disabled")).toBeDefined();
      wrapper.unmount();
    });

    it("retires the unavailable banner when another Run opens or the Topic switches", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const entry = (runId: string, turnId: string, seq: number) => ({
        kind: "message" as const,
        key: `message:m_${runId}`,
        anchorSeq: seq,
        runId,
        memberTurnId: turnId,
        ownership: "exact" as const,
        message: {
          id: `m_${runId}`, conversationId: "conversation_g", topicId: "topic_1",
          seq, role: "bot" as const, senderBotId: "bot_a", memberTurnId: turnId,
          runId, content: `done ${runId}`, createdAt: "now",
        },
      });
      const detail = (runId: string, turnId: string) => ({
        id: runId, conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m_req", requestId: `req_${runId}`, mode: "explicit",
        shape: "fanout", state: "completed", profileRevision: 1, createdAt: "now",
        memberTurns: [{
          id: turnId, runId, conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "completed", createdAt: "now",
        }],
      });
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type, payload) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g", topicId: "topic_1",
            entries: [entry("run_missing", "turn_m", 2), entry("run_ok", "turn_ok", 3)],
            hasMoreBefore: false, hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) {
          const ids = (payload as { runIds: string[] }).runIds;
          const runs = ids.includes("run_ok") ? [detail("run_ok", "turn_ok")] : [];
          return { runs, missingRunIds: ids.includes("run_missing") ? ["run_missing"] : [] } as never;
        }
        if (type === MSG.runsTraceGet) return { events: [], hasMore: false } as never;
        return {} as never;
      });
      const wrapper = mount(GroupPane, { attachTo: document.body, global: { plugins: [i18n] } });
      await flushPromises();
      const triggers = wrapper.findAll('[data-test="timeline-open-detail"]');
      expect(triggers).toHaveLength(2);
      await triggers[0]!.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(true);

      // Opening a different, valid Run retires the stale notice with it.
      await triggers[1]!.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(false);
      expect(document.body.querySelector('[data-test="group-detail-card"] [data-test="run-detail"]')).not.toBeNull();
      (document.body.querySelector('[data-test="group-detail-close"]') as HTMLElement).click();
      await flushPromises();

      // Raise it again, then leave the scope: a Topic switch clears it too.
      await triggers[0]!.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(true);
      groups.topicsByConversation["i1:conversation_g"]!.push({
        id: "topic_2", conversationId: "conversation_g", title: "Release", status: "active", createdAt: "now", updatedAt: "now",
      });
      groups.activeTopicId = "topic_2";
      await flushPromises();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(false);
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("reopens the clicked member after Retry", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const members = [
        {
          id: "turn_running", runId: "run_click", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
        {
          id: "turn_clicked", runId: "run_click", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, memberIndex: 1, attempt: 1, origin: "handoff",
          state: "completed", createdAt: "now",
        },
      ];
      let missing = true;
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g", topicId: "topic_1",
            entries: [{
              kind: "message", key: "message:m_click", anchorSeq: 2,
              runId: "run_click", memberTurnId: "turn_clicked", ownership: "exact",
              message: {
                id: "m_click", conversationId: "conversation_g", topicId: "topic_1",
                seq: 2, role: "bot", senderBotId: "bot_b", memberTurnId: "turn_clicked",
                runId: "run_click", content: "done", createdAt: "now",
              },
            }],
            hasMoreBefore: false, hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) {
          return missing
            ? { runs: [], missingRunIds: ["run_click"] } as never
            : {
                runs: [{
                  id: "run_click", conversationId: "conversation_g", topicId: "topic_1",
                  requestMessageId: "m_req", requestId: "req_click", mode: "explicit",
                  shape: "fanout", state: "running", profileRevision: 1, createdAt: "now",
                  memberTurns: members,
                }],
                missingRunIds: [],
              } as never;
        }
        if (type === MSG.runsTraceGet) return { events: [], hasMore: false } as never;
        return {} as never;
      });
      const wrapper = mount(GroupPane, { attachTo: document.body, global: { plugins: [i18n] } });
      await flushPromises();
      await wrapper.find('[data-test="timeline-open-detail"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="run-detail-unavailable"]').exists()).toBe(true);

      missing = false;
      await wrapper.find('[data-test="run-detail-retry"]').trigger("click");
      await flushPromises();
      await flushPromises();
      const selected = document.body.querySelector('[data-test="run-selected-member"]');
      // The clicked member wins over the running one the drawer would otherwise pick.
      expect(selected?.getAttribute("data-member-turn-id")).toBe("turn_clicked");
      rpc.mockRestore();
      wrapper.unmount();
    });
    it("moves the followed trace when the drawer switches attempt", async () => {
      seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const turn = {
        id: "turn_retry", runId: "run_retry", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
        state: "completed", createdAt: "now",
      };
      const traceAttempts: number[] = [];
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type, payload) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g", topicId: "topic_1",
            entries: [{
              kind: "message", key: "message:m_retry", anchorSeq: 2,
              runId: "run_retry", memberTurnId: "turn_retry", ownership: "exact",
              message: {
                id: "m_retry", conversationId: "conversation_g", topicId: "topic_1",
                seq: 2, role: "bot", senderBotId: "bot_a", memberTurnId: "turn_retry",
                runId: "run_retry", content: "done", createdAt: "now",
              },
            }],
            hasMoreBefore: false, hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.runsDetailsBatch) {
          return {
            runs: [{
              id: "run_retry", conversationId: "conversation_g", topicId: "topic_1",
              requestMessageId: "m_req", requestId: "req_retry", mode: "explicit",
              shape: "fanout", state: "completed", profileRevision: 1, createdAt: "now",
              memberTurns: [turn],
            }],
            missingRunIds: [],
          } as never;
        }
        if (type === MSG.runsTraceGet) {
          const attempt = (payload as { attempt?: number }).attempt ?? 1;
          traceAttempts.push(attempt);
          return {
            memberTurnId: "turn_retry", attempt, recordingState: "complete",
            events: [{ seq: 1, createdAt: "now", kind: "text", payload: { text: `Attempt ${attempt} trace` } }],
            nextSeq: 1, hasMore: false, attempts: [1, 2], plan: [],
          } as never;
        }
        return {} as never;
      });
      const wrapper = mount(GroupPane, { attachTo: document.body, global: { plugins: [i18n] } });
      await flushPromises();
      await wrapper.find('[data-test="timeline-open-detail"]').trigger("click");
      await flushPromises();
      await flushPromises();
      const card = () => document.body.querySelector('[data-test="group-detail-card"]')!;
      expect(card().textContent).toContain("Attempt 1 trace");
      expect(traceAttempts).toContain(1);

      // Selecting the retried attempt must follow it: the cursor moves, the
      // trace re-reads, and the render switches with it.
      const select = card().querySelector('[data-test="group-detail-attempt"]') as HTMLSelectElement;
      expect(select).not.toBeNull();
      select.value = "2";
      select.dispatchEvent(new Event("change"));
      await flushPromises();
      await flushPromises();
      expect(traceAttempts.at(-1)).toBe(2);
      expect(card().textContent).toContain("Attempt 2 trace");
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("re-arms the drawer follow after a Topic round-trip", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const turn = {
        id: "turn_follow", runId: "run_follow", conversationId: "conversation_g", topicId: "topic_1",
        botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
        state: "running", createdAt: "now",
      };
      groups.activeRun = {
        id: "run_follow", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m_req", requestId: "req_follow", mode: "explicit",
        shape: "fanout", state: "running", profileRevision: 1, createdAt: "now",
      } as never;
      groups.memberTurnsById = { turn_follow: turn as never };
      const tracePayloads: Array<{ memberTurnId?: string; attempt?: number; afterSeq?: number }> = [];
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type, payload) => {
        if (type === MSG.conversationTimeline) {
          const topicId = (payload as { topicId?: string }).topicId ?? "topic_1";
          // The other Topic is empty: switching away offers nothing to open.
          const entries = topicId === "topic_1"
            ? [{
                kind: "activity", key: "activity:turn_follow", anchorSeq: 2,
                runId: "run_follow", memberTurn: turn,
              }]
            : [];
          return { conversationId: "conversation_g", topicId, entries, hasMoreBefore: false, hasMoreAfter: false } as never;
        }
        if (type === MSG.runsDetailsBatch) {
          return {
            runs: [{
              id: "run_follow", conversationId: "conversation_g", topicId: "topic_1",
              requestMessageId: "m_req", requestId: "req_follow", mode: "explicit",
              shape: "fanout", state: "running", profileRevision: 1, createdAt: "now",
              memberTurns: [turn],
            }],
            missingRunIds: [],
          } as never;
        }
        if (type === MSG.runsTraceGet) {
          tracePayloads.push(payload as { memberTurnId?: string; attempt?: number; afterSeq?: number });
          return {
            memberTurnId: "turn_follow", attempt: 1, recordingState: "recording",
            events: [{ seq: 1, createdAt: "now", kind: "text", payload: { text: "First frame" } }],
            nextSeq: 1, hasMore: false, attempts: [1], plan: [],
          } as never;
        }
        return {} as never;
      });
      const wrapper = mount(GroupPane, { attachTo: document.body, global: { plugins: [i18n] } });
      await flushPromises();
      await wrapper.find('[data-test="timeline-activity"] [data-test="transcript-speaker"]').trigger("click");
      await flushPromises();
      await flushPromises();

      // Leave the scope and come back: the store drops the follow, and the
      // pane's own cursor must drop with it or the reopened drawer is inert.
      groups.topicsByConversation["i1:conversation_g"]!.push({
        id: "topic_2", conversationId: "conversation_g", title: "Other", status: "active", createdAt: "now", updatedAt: "now",
      });
      groups.activeTopicId = "topic_2";
      await flushPromises();
      groups.activeTopicId = "topic_1";
      await flushPromises();
      await wrapper.find('[data-test="timeline-activity"] [data-test="transcript-speaker"]').trigger("click");
      await flushPromises();
      await flushPromises();
      const before = tracePayloads.length;

      // A committed frame for the followed member now pulls the trace page.
      groups.applyEvent({
        kind: "control-event",
        instanceId: "i1",
        event: {
          type: "tool-event",
          chatKey: "c",
          sessionAlias: "s",
          conversation: {
            conversationId: "conversation_g", topicId: "topic_1",
            runId: "run_follow", memberTurnId: "turn_follow", botId: "bot_a", attempt: 1,
          },
          step: { toolCallId: "tool_1", toolName: "read_file", kind: "read", status: "success", title: "Read", startedAt: Date.now() },
        },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await flushPromises();
      expect(tracePayloads.length).toBeGreaterThan(before);
      expect(tracePayloads.at(-1)!.afterSeq).toBe(1);
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("marks a prompt queued behind the Topic owner on the timeline", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      const owner = {
        id: "run_owner", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m1", requestId: "req_owner", mode: "explicit" as const, state: "running" as const,
        profileRevision: 1, createdAt: "now",
      };
      groups.activeRun = owner;
      const queuedMessage = {
        id: "m_queued", conversationId: "conversation_g", topicId: "topic_1", seq: 2,
        runId: "run_queued", role: "human" as const, content: "next", createdAt: "now",
      };
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id, type) => {
        if (type === MSG.conversationTimeline) {
          return {
            conversationId: "conversation_g",
            topicId: "topic_1",
            entries: [{
              kind: "message",
              key: "message:m_queued",
              anchorSeq: 2,
              runId: "run_queued",
              message: queuedMessage,
            }],
            hasMoreBefore: false,
            hasMoreAfter: false,
          } as never;
        }
        if (type === MSG.conversationPrompt) {
          return {
            reused: false,
            conversationId: "conversation_g",
            topicId: "topic_1",
            requestId: "req_queued",
            message: queuedMessage,
            run: {
              id: "run_queued", conversationId: "conversation_g", topicId: "topic_1",
              requestMessageId: "m_queued", requestId: "req_queued", mode: "explicit",
              state: "queued", profileRevision: 1, createdAt: "now",
            },
            memberTurns: [],
            activeRunId: "run_owner",
          } as never;
        }
        return {} as never;
      });
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      await groups.sendPromptTo("next", null);
      await flushPromises();
      // The accepted Run is queued behind the standing owner: its prompt is
      // durable but has not started, so the timeline marks it as waiting.
      expect(wrapper.find('[data-test="queued-prompt"]').exists()).toBe(true);
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("keeps exactly one Stop: the status bar on timeline daemons", async () => {
      const groups = seedGroupSelection();
      useInstancesStore().instances[0]!.capabilities = [RELAY_CAPABILITIES.conversationTimelineV1];
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "m1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      const rpc = vi.spyOn(api, "rpc").mockResolvedValue({
        conversationId: "conversation_g", topicId: "topic_1",
        entries: [], hasMoreBefore: false, hasMoreAfter: false,
      } as never);
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="conversation-stop-all"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="group-stop-run-button"]').exists()).toBe(false);
      rpc.mockRestore();
      wrapper.unmount();
    });

    it("loads the agent and workspace catalogs a fresh session has not fetched", async () => {
      seedGroupSelection();
      const instances = useInstancesStore();
      instances.instances = instances.instances.map((row) => ({
        ...row,
        agents: [],
        workspaces: [],
      }));
      const loadFormOptions = vi.spyOn(instances, "loadFormOptions").mockResolvedValue();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(loadFormOptions).toHaveBeenCalledWith("i1");
      loadFormOptions.mockRestore();
      wrapper.unmount();
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
