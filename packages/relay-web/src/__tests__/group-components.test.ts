import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
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

    it("shows the agent icon for members whose agent is in the catalog", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      // `codex` is in the seeded instance's agent catalog with driver `codex`,
      // so every member row renders its agent icon (not the generic glyph).
      const icons = wrapper.findAllComponents({ name: "AgentIcon" });
      expect(icons.length).toBeGreaterThan(0);
      // An unknown agent falls back to the generic Bot glyph instead.
      const wrapper2 = mount(GroupComposer, {
        props: { bots: [{ ...BOTS[0]!, agent: "mystery" }] },
        global: { plugins: [i18n] },
      });
      await wrapper2.find('[data-test="group-target-button"]').trigger("click");
      expect(wrapper2.findAllComponents({ name: "AgentIcon" })).toHaveLength(0);
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
      // The send carries the typed text for the resolved target; the store
      // assertion above is what pins the routing contract.
      expect(wrapper.emitted("send")?.[0]).toEqual(["@everyone, please review"]);
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
        Array.from(scrollerEl.querySelectorAll<HTMLElement>("[data-message-id]"));
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
        if (selector === "[data-message-id]") found.forEach(patchRow);
        return found;
      }) as typeof scrollerEl.querySelectorAll;
      const originalQueryOne = scrollerEl.querySelector.bind(scrollerEl);
      scrollerEl.querySelector = ((selector: string, ...rest: unknown[]) => {
        const found = (originalQueryOne as (...a: unknown[]) => HTMLElement | null)(selector, ...rest);
        if (found && selector.startsWith("[data-message-id")) patchRow(found);
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
