import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  ConversationRunDto,
  InteractionRequestDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import ConversationRunDetailContent from "../components/ConversationRunDetailContent.vue";
import TraceOverlay from "../components/TraceOverlay.vue";
import type { PendingInteractionState } from "../stores/direct-bots";
import type { RoomParticipant } from "../lib/room-view";

const NOW = "2026-11-08T00:00:00.000Z";
const scope = { conversationId: "conversation_1", topicId: "topic_1" };

const participants: RoomParticipant[] = [
  { botId: "bot_a", name: "Ada", enabled: true },
  { botId: "bot_b", name: "Bob", enabled: true },
  { botId: "bot_c", name: "Cara", enabled: true },
];

function run(patch: Partial<ConversationRunDto> = {}): ConversationRunDto {
  return {
    ...scope,
    id: "run_1",
    requestMessageId: "m1",
    requestId: "req_1",
    mode: "explicit",
    shape: "fanout",
    state: "running",
    profileRevision: 1,
    maxMemberTurns: 6,
    consumedMemberTurns: 3,
    budgetEpoch: 1,
    activeBatch: 2,
    createdAt: NOW,
    ...patch,
  } as ConversationRunDto;
}

function member(id: string, botId: string, patch: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    ...scope,
    id,
    runId: "run_1",
    botId,
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "human-explicit",
    state: "completed",
    createdAt: NOW,
    ...patch,
  };
}

const members = [
  member("turn_a", "bot_a", { memberIndex: 0, origin: "human-explicit" }),
  member("turn_b", "bot_b", { memberIndex: 1, origin: "handoff", state: "running", task: "Check the lock" }),
  member("turn_c", "bot_c", { memberIndex: 2, origin: "roundtable", roundIndex: 1, speakerIndex: 1, state: "failed", failureReason: "driver crashed" }),
];

function interaction(): PendingInteractionState {
  const request: InteractionRequestDto = {
    requestId: "int_1",
    kind: "elicitation",
    expiresAt: Date.now() + 60_000,
    conversation: { ...scope, runId: "run_1", botId: "bot_b", memberTurnId: "turn_b", attempt: 1 },
    elicitation: {
      mode: "form",
      message: "May I edit the lock file?",
      fields: [{ kind: "text", key: "note", title: "Note", required: false }],
      agent: { name: "Bob" },
    },
  };
  return {
    instanceId: "i1",
    sessionAlias: "",
    request,
    kind: "elicitation",
    answers: {},
    outcome: null,
    submitting: false,
    errorCode: null,
  };
}

function mountContent(overrides: Record<string, unknown> = {}) {
  return mount(ConversationRunDetailContent, {
    props: {
      run: run(),
      memberTurns: members,
      selectedMemberTurnId: "turn_b",
      participants,
      budget: { consumed: 3, max: 6, epoch: 1, activeBatch: 2 },
      capability: { cancelMember: true },
      parts: [],
      ...overrides,
    },
    global: { plugins: [i18n] },
  });
}

describe("ConversationRunDetailContent.vue", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("shows Run status, completion reason, failure and the consumed/max budget", () => {
    const wrapper = mountContent({
      run: run({ state: "failed", completionReason: "execution-failed" }),
    });
    expect(wrapper.find('[data-test="run-detail-state"]').text().toLowerCase()).toContain("fail");
    expect(wrapper.find('[data-test="run-detail-completion"]').text()).toContain("A member failed");
    expect(wrapper.find('[data-test="run-detail-failure"]').text()).toContain("A member failed");
    expect(wrapper.find('[data-test="run-detail-budget"]').text()).toContain("3/6 member turns");
    expect(wrapper.find('[data-test="run-detail-budget"]').text()).toContain("Budget epoch 1");
    wrapper.unmount();
  });

  it("lists every member with state, origin, round position, speaker and failure", () => {
    const wrapper = mountContent();
    const rows = wrapper.findAll('[data-test="run-member-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.find('[data-test="run-member-name"]').text()).toBe("Ada");
    expect(rows[0]!.find('[data-test="run-member-state"]').text()).toBe(i18n.global.t("group.run.memberCompleted"));
    expect(rows[0]!.find('[data-test="run-member-origin"]').text()).toBe("Direct");
    expect(rows[1]!.attributes("data-selected")).toBe("true");
    expect(rows[1]!.find('[data-test="run-member-origin"]').text()).toBe("Handoff");
    expect(rows[2]!.find('[data-test="run-member-round"]').text()).toContain("#2");
    expect(rows[2]!.find('[data-test="run-member-failure"]').text()).toContain("driver crashed");
    expect(wrapper.find('[data-test="run-member-selected-failure"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="run-selected-member"]').attributes("data-member-turn-id")).toBe("turn_b");
    wrapper.unmount();
  });

  it("selects another member through the Run-wide member list", async () => {
    const wrapper = mountContent();
    await wrapper.findAll('[data-test="run-member-row"]')[2]!.trigger("click");
    expect(wrapper.emitted("selectMember")?.[0]).toEqual(["turn_c"]);
    wrapper.unmount();
  });

  it("offers a scoped Stop for a running fanout member only", async () => {
    const wrapper = mountContent();
    const stop = wrapper.find('[data-test="run-stop-member"]');
    expect(stop.exists()).toBe(true);
    expect(stop.text()).toContain("Stop Bob");
    await stop.trigger("click");
    expect(wrapper.emitted("stopMember")?.[0]).toEqual(["turn_b"]);
    wrapper.unmount();

    const roundtable = mountContent({ run: run({ shape: "roundtable", rounds: 1 }) });
    expect(roundtable.find('[data-test="run-stop-member"]').exists()).toBe(false);
    roundtable.unmount();

    const noCapability = mountContent({ capability: { cancelMember: false } });
    expect(noCapability.find('[data-test="run-stop-member"]').exists()).toBe(false);
    noCapability.unmount();
  });

  it("embeds an approval form and reports every decision with its request id", async () => {
    const wrapper = mountContent({ interactions: [interaction()] });
    expect(wrapper.find('[data-test="run-interactions"]').exists()).toBe(true);
    const form = wrapper.find('[data-test="run-interaction"]');
    expect(form.find('[data-test="interaction-form"]').exists()).toBe(true);
    expect(form.text()).toContain("May I edit the lock file?");

    await form.find('[data-test="interaction-input-note"]').setValue("looks good");
    expect(wrapper.emitted("interactionAnswer")?.[0]).toEqual(["int_1", "note", "looks good"]);

    await form.find('[data-test="interaction-submit"]').trigger("click");
    expect(wrapper.emitted("interactionSubmit")?.[0]).toEqual(["int_1"]);
    await form.find('[data-test="interaction-decline"]').trigger("click");
    expect(wrapper.emitted("interactionDecline")?.[0]).toEqual(["int_1"]);
    await form.find('[data-test="interaction-cancel"]').trigger("click");
    expect(wrapper.emitted("interactionCancel")?.[0]).toEqual(["int_1"]);
    wrapper.unmount();
  });

  it("hides the budget when the wire carried none", () => {
    const wrapper = mountContent({
      run: run({ consumedMemberTurns: undefined, maxMemberTurns: undefined, budgetEpoch: undefined, activeBatch: undefined }),
      budget: undefined,
    });
    expect(wrapper.find('[data-test="run-detail-budget"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("never invents consumption: max-only names the cap, a real zero renders as 0", () => {
    const maxOnly = mountContent({ budget: { max: 6 } });
    const maxText = maxOnly.find('[data-test="run-detail-budget"]').text();
    expect(maxText).toContain("6");
    expect(maxText).not.toContain("0");
    expect(maxText).not.toContain("undefined");
    maxOnly.unmount();

    const realZero = mountContent({
      run: run({ consumedMemberTurns: 0, maxMemberTurns: 6 }),
      budget: { consumed: 0, max: 6 },
    });
    expect(realZero.find('[data-test="run-detail-budget"]').text()).toContain("0/6 member turns");
    realZero.unmount();
  });
});

describe("TraceOverlay.vue run-wide mode", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.innerWidth = 1280;
  });

  it("renders the Run drawer without a duplicate Run-level Stop", () => {
    const wrapper = mount(TraceOverlay, {
      attachTo: document.body,
      props: {
        id: "run-drawer-test",
        run: run(),
        memberTurns: members,
        selectedMemberTurnId: "turn_b",
        participants,
        capability: { cancelMember: true },
        budget: { consumed: 3, max: 6 },
        anchorEl: null,
      },
      global: { plugins: [i18n] },
    });
    const body = document.body;
    expect(body.querySelector('[data-test="group-detail-card"]')).not.toBeNull();
    expect(body.querySelector('[data-test="run-detail"]')).not.toBeNull();
    expect(body.querySelector('[data-test="run-member-list"]')).not.toBeNull();
    // Stop all stays in the status bar; the drawer only offers the scoped stop.
    expect(body.querySelector('[data-test="group-stop-run-button"]')).toBeNull();
    expect(body.querySelector('[data-test="run-stop-member"]')).not.toBeNull();
    wrapper.unmount();
  });

  it("offers the run-level fork entry on desktop when forking is available", () => {
    const wrapper = mount(TraceOverlay, {
      attachTo: document.body,
      props: {
        id: "run-drawer-fork-test",
        run: run({ state: "completed" }),
        memberTurns: members,
        selectedMemberTurnId: "turn_b",
        participants,
        capability: { cancelMember: true },
        budget: { consumed: 3, max: 6 },
        anchorEl: null,
        forkAvailable: true,
      },
      global: { plugins: [i18n] },
    });
    const button = document.body.querySelector('[data-test="group-fork-run-button"]');
    expect(button).not.toBeNull();
    (button as HTMLButtonElement).click();
    expect(wrapper.emitted("fork")).toHaveLength(1);
    wrapper.unmount();
  });

  it("hides the run-level fork entry on desktop when forking is unavailable", () => {
    const wrapper = mount(TraceOverlay, {
      attachTo: document.body,
      props: {
        id: "run-drawer-no-fork-test",
        run: run({ state: "completed" }),
        memberTurns: members,
        selectedMemberTurnId: "turn_b",
        participants,
        capability: { cancelMember: true },
        budget: { consumed: 3, max: 6 },
        anchorEl: null,
      },
      global: { plugins: [i18n] },
    });
    expect(document.body.querySelector('[data-test="group-fork-run-button"]')).toBeNull();
    wrapper.unmount();
  });
});
