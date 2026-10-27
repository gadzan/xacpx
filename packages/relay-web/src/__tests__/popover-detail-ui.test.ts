import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  BotSummaryDto,
  ConversationRunDto,
  GroupSummaryDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import GroupTranscript from "../components/GroupTranscript.vue";
import AgentThinkingBubble from "../components/AgentThinkingBubble.vue";
import GroupRunDetailContent from "../components/GroupRunDetailContent.vue";
import MobileSheet from "../components/MobileSheet.vue";
import { useGroupsStore } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
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

function seedEnvironment() {
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
  useDirectBotsStore().botsByInstance["i1"] = BOTS;
  return groups;
}

function turnOf(overrides: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
    botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
    state: "running", createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:01.000Z", assignmentId: "step-1", task: "Review",
    expectedOutput: "A reviewed patch",
    ...overrides,
  };
}

function runOf(overrides: Partial<ConversationRunDto> = {}): ConversationRunDto {
  return {
    id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
    requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
    profileRevision: 1, createdAt: "2026-09-01T00:00:00.000Z", startedAt: "2026-09-01T00:00:01.000Z",
    ...overrides,
  };
}

function seedLiveRun(): void {
  const groups = useGroupsStore();
  groups.activeRun = runOf();
  groups.memberTurnsById = { turn_a: turnOf() };
  groups.messages = [
    { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
  ];
}

function seedTracePage(attempt: number, page: Record<string, unknown>): void {
  const groups = useGroupsStore();
  groups.tracePages[`i1:conversation_g:topic_1:turn_a:${attempt}`] = {
    events: [], hasMore: false, loading: false, error: null, recordingState: "complete",
    ...page,
  } as never;
}

function mountTranscript(): VueWrapper {
  return mount(GroupTranscript, {
    props: { bots: BOTS },
    attachTo: document.body,
  });
}

async function openFirstBubble(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-test="agent-thinking-bubble"]').trigger("click");
  await flushPromises();
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-test="group-detail-card"]');
}

function sheet(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-test="group-detail-sheet"]');
}

/** Whichever detail surface is mounted: the mobile sheet or the desktop card. */
function surface(): HTMLElement | null {
  return sheet() ?? card();
}

function setViewportWidth(width: number): void {
  window.innerWidth = width;
  window.dispatchEvent(new Event("resize"));
}

async function closeSurface(): Promise<void> {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flushPromises();
}

let intersectionCallback: IntersectionObserverCallback | null = null;
let observerProto: typeof IntersectionObserver | undefined;

/** The shared setup stubs IntersectionObserver as a no-op; popover tests need
 *  the callback so the off-screen close path is exercised deterministically. */
function installIntersectionProbe(): void {
  intersectionCallback = null;
  observerProto = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
  } as unknown as typeof IntersectionObserver;
}

function fireOffscreen(target: Element): void {
  const entry = { target, isIntersecting: false } as IntersectionObserverEntry;
  intersectionCallback?.([entry], {} as IntersectionObserver);
}

describe("GroupThinkingBubbles UI", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    window.innerWidth = 1024;
    installIntersectionProbe();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.innerWidth = 1024;
    if (observerProto) globalThis.IntersectionObserver = observerProto;
    vi.restoreAllMocks();
  });

  it("wires aria-controls to the actual unique detail id and toggles closed", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await flushPromises();
    const trigger = wrapper.get('[data-test="agent-thinking-bubble"]');
    expect(trigger.attributes("aria-controls")).toBeUndefined();
    await trigger.trigger("click");
    await flushPromises();
    const detail = card();
    expect(detail).not.toBeNull();
    const id = detail!.getAttribute("id") ?? "";
    expect(id).toMatch(/^group-detail-/);
    expect(trigger.attributes("aria-controls")).toBe(id);
    expect(trigger.attributes("aria-expanded")).toBe("true");
    await trigger.trigger("click");
    await flushPromises();
    expect(card()).toBeNull();
    expect(trigger.attributes("aria-controls")).toBeUndefined();
    wrapper.unmount();
  });

  it("closes on Escape (global), restores focus to the trigger, and does not trap focus", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(card()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(wrapper.get('[data-test="agent-thinking-bubble"]').element);
    wrapper.unmount();
  });

  it("closes on an outside pointerdown but keeps pointer interaction inside", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    card()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await flushPromises();
    expect(card()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await flushPromises();
    expect(card()).toBeNull();
    wrapper.unmount();
  });

  it("returns focus to the exact trigger when closed by the X button", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const trigger = wrapper.get('[data-test="agent-thinking-bubble"]');
    const focus = vi.spyOn(trigger.element as HTMLElement, "focus");
    (document.body.querySelector('[data-test="group-detail-close"]') as HTMLElement).click();
    await flushPromises();
    expect(card()).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it("closes from an outside pointerdown without moving the reader's focus", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await flushPromises();
    expect(card()).toBeNull();
    // The reader's focus stays untouched: nothing is pulled back to the bubble.
    expect(document.activeElement).toBe(document.body);
    expect(wrapper.get('[data-test="agent-thinking-bubble"]').element).not.toBe(document.activeElement);
    wrapper.unmount();
  });

  it("keeps one open detail and points aria-controls at the newly opened member", async () => {
    const groups = seedEnvironment();
    groups.activeRun = runOf();
    groups.memberTurnsById = {
      turn_a: turnOf(),
      turn_b: turnOf({ id: "turn_b", botId: "bot_b", memberIndex: 1, state: "completed" }),
    };
    groups.messages = [
      { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
    ];
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await flushPromises();
    const bubbles = wrapper.findAll('[data-test="agent-thinking-bubble"]');
    expect(bubbles).toHaveLength(2);
    await bubbles[0]!.trigger("click");
    await flushPromises();
    expect(document.body.querySelectorAll('[data-test="group-detail-card"]')).toHaveLength(1);
    await bubbles[1]!.trigger("click");
    await flushPromises();
    expect(document.body.querySelectorAll('[data-test="group-detail-card"]')).toHaveLength(1);
    expect(bubbles[1]!.attributes("aria-controls")).toBe(card()!.getAttribute("id"));
    expect(card()!.getAttribute("data-member-turn-id")).toBe("turn_b");
    wrapper.unmount();
  });

  it("closes the detail when the trigger leaves the scroller", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(card()).not.toBeNull();
    const bubble = wrapper.get('[data-test="agent-thinking-bubble"]').element as HTMLElement;
    bubble.remove();
    fireOffscreen(bubble);
    await flushPromises();
    expect(card()).toBeNull();
    wrapper.unmount();
  });

  it("closes when the transcript scope changes and clears the open-trace registration", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    const openTrace = vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(openTrace).toHaveBeenCalledWith("turn_a", 1);
    groups.activeTopicId = "topic_2";
    await flushPromises();
    expect(card()).toBeNull();
    expect(openTrace).toHaveBeenLastCalledWith(null, undefined);
    wrapper.unmount();
  });

  it("uses a modal sheet below 1024px and preserves the selected attempt on resize", async () => {
    setViewportWidth(390);
    const groups = seedEnvironment();
    seedLiveRun();
    seedTracePage(1, { attempts: [1, 2], events: [{ seq: 1, createdAt: "now", kind: "text", payload: { text: "First attempt process" } }] });
    seedTracePage(2, { attempts: [1, 2], events: [{ seq: 1, createdAt: "now", kind: "text", payload: { text: "Second attempt process" } }] });
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    const trigger = wrapper.get('[data-test="agent-thinking-bubble"]').element as HTMLButtonElement;
    trigger.focus();
    await openFirstBubble(wrapper);
    expect(card()).toBeNull();
    expect(sheet()?.getAttribute("aria-modal")).toBe("true");
    expect(sheet()?.id).toBe(trigger.getAttribute("aria-controls"));
    expect(sheet()?.getAttribute("data-member-turn-id")).toBe("turn_a");
    const select = sheet()!.querySelector<HTMLSelectElement>('[data-test="group-detail-attempt"]')!;
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();
    expect(surface()?.textContent).toContain("Second attempt process");
    expect(surface()?.querySelector('[data-test="group-detail-state"]')).toBeNull();
    setViewportWidth(1024);
    await flushPromises();
    expect(sheet()).toBeNull();
    expect(card()?.textContent).toContain("Second attempt process");
    setViewportWidth(1023);
    await flushPromises();
    expect(card()).toBeNull();
    expect(sheet()?.textContent).toContain("Second attempt process");
    await closeSurface();
    expect(surface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    wrapper.unmount();
  });

  it("keeps first-control focus for sheets without an explicit initial target", async () => {
    const wrapper = mount(MobileSheet, {
      props: { title: "Other sheet" },
      slots: { header: '<button data-test="first-control">First action</button><button>Second action</button>' },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-test="first-control"]').element);
    wrapper.unmount();
  });

  it("focuses the mobile close control before Stop and restores focus without cancelling", async () => {
    setViewportWidth(390);
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({ status: "blocked", scope: null, runId: null, reason: "ownership" });
    const wrapper = mountTranscript();
    const trigger = wrapper.get('[data-test="agent-thinking-bubble"]').element as HTMLButtonElement;
    trigger.focus();
    await openFirstBubble(wrapper);
    const detail = sheet()!;
    const close = detail.querySelector<HTMLButtonElement>('[data-test="group-detail-close"]')!;
    expect(detail.querySelector("button")?.getAttribute("data-test")).toBe("group-stop-run-button");
    expect(document.activeElement).toBe(close);
    expect(detail.querySelector('[data-test="group-stop-run-explanation"]')?.textContent)
      .toContain("all participating members are cancelled");
    expect(cancel).not.toHaveBeenCalled();
    close.click();
    await flushPromises();
    expect(surface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(cancel).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("closes the mobile sheet from its backdrop and keeps Stop scoped to the active run", async () => {
    setViewportWidth(390);
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({ status: "blocked", scope: null, runId: null, reason: "ownership" });
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    (sheet()!.querySelector('[data-test="group-stop-run-button"]') as HTMLElement).click();
    await flushPromises();
    expect(cancel).toHaveBeenCalled();
    (document.querySelector('[data-test="sheet-backdrop"]') as HTMLElement).click();
    await flushPromises();
    expect(surface()).toBeNull();
    wrapper.unmount();
  });

  it("renders duration, expected output, and the run-level stop explanation", async () => {
    const groups = seedEnvironment();
    groups.activeRun = runOf({ state: "completed", finishedAt: "2026-09-01T00:01:01.000Z", worktree: { runId: "run_1", baseCommitSha: "abc", disposition: "pending", revision: 1, resources: [] } });
    groups.memberTurnsById = {
      turn_a: turnOf({ state: "completed", startedAt: "2026-09-01T00:00:01.000Z", finishedAt: "2026-09-01T00:01:01.000Z" }),
    };
    groups.messages = [
      { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
    ];
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(card()!.textContent).toContain("Duration 1:00");
    expect(card()!.textContent).toContain("A reviewed patch");
    expect(card()!.textContent).toContain("isolated per-member Git worktree");
    expect(card()!.textContent).not.toContain("Stop this run");
    expect(card()!.querySelector('[data-test="group-stop-run-button"]')).toBeNull();
    wrapper.unmount();
  });

  it("uses the shared single-writer note when the run has no worktree", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(card()!.textContent).toContain("shares the conversation workspace");
    expect(card()!.querySelector('[data-test="group-stop-run-button"]')?.getAttribute("title"))
      .toContain("all participating members are cancelled");
    wrapper.unmount();
  });

  it("hides Stop when topic ownership is uncertain and shows it only after agreement", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(document.body.querySelector('[data-test="group-stop-run-button"]')).not.toBeNull();
    groups.ownershipUncertain = true;
    await flushPromises();
    expect(document.body.querySelector('[data-test="group-stop-run-button"]')).toBeNull();
    groups.ownershipUncertain = false;
    groups.topicReady = false;
    await flushPromises();
    expect(document.body.querySelector('[data-test="group-stop-run-button"]')).toBeNull();
    groups.topicReady = true;
    await flushPromises();
    expect(document.body.querySelector('[data-test="group-stop-run-button"]')).not.toBeNull();
    wrapper.unmount();
  });

  it("keeps zero-member terminal automatic runs reachable without a stopped-run action", async () => {
    const groups = seedEnvironment();
    groups.activeRun = runOf({
      id: "run_route", mode: "automatic", state: "failed", routingState: "done",
      routingReason: "Automatic route to Tester", completionReason: "no-member",
    });
    groups.messages = [
      { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
    ];
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await flushPromises();
    expect(wrapper.find('[data-test="group-routing-row"]').exists()).toBe(true);
    await openFirstBubble(wrapper);
    expect(card()!.textContent).toContain("Automatic route to Tester");
    expect(document.body.querySelector('[data-test="group-stop-run-button"]')).toBeNull();
    wrapper.unmount();
  });

  it("shows trace completeness, partial windows, and failure truthfully with partial parts", async () => {
    const groups = seedEnvironment();
    groups.activeRun = runOf({ state: "completed" });
    groups.memberTurnsById = { turn_a: turnOf({ state: "completed", finishedAt: "2026-09-01T00:03:00.000Z" }) };
    groups.messages = [
      { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
    ];
    seedTracePage(1, {
      recordingState: "complete",
      hasMore: true,
      hasEarlier: true,
      completenessReason: "Older events were pruned from the cache",
      events: [
        { seq: 1, createdAt: "now", kind: "text", payload: { text: "Partial visible output" } },
        { seq: 2, createdAt: "now", kind: "terminal", payload: { ok: false, errorMessage: "tool failed" } },
      ],
    });
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const status = document.body.querySelector('[data-test="group-trace-status"]')!;
    expect(status.textContent).toContain("Recorded process (complete)");
    expect(status.textContent).toContain("Older events were pruned from the cache");
    expect(status.textContent).toContain("tool failed");
    expect(status.textContent).toContain("Load more");
    expect(status.textContent).toContain("Load earlier");
    expect(card()!.textContent).toContain("Partial visible output");
    wrapper.unmount();
  });

  it("selects an earlier attempt without reusing live parts from the current attempt", async () => {
    const groups = seedEnvironment();
    const turn = turnOf({ attempt: 2, state: "completed", finishedAt: "2026-09-01T00:02:00.000Z" });
    groups.activeRun = runOf({ state: "completed", finishedAt: "2026-09-01T00:02:00.000Z" });
    groups.memberTurnsById = { turn_a: turn };
    groups.messages = [
      { id: "msg_1", conversationId: "conversation_g", topicId: "topic_1", seq: 1, role: "human", content: "Ship it", createdAt: "now" },
    ];
    seedTracePage(2, { events: [], attempts: [1, 2], recordingState: "complete" });
    seedTracePage(1, {
      events: [{ seq: 1, createdAt: "now", kind: "text", payload: { text: "attempt one output" } }],
      attempts: [1, 2], recordingState: "complete",
    });
    const live = vi.spyOn(groups, "liveTurnForMember").mockReturnValue({
      parts: [{ type: "text", text: "attempt two live output" } as never],
      status: "streaming", startedAt: 1, revision: 3, attempt: 2,
    });
    const openTrace = vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    expect(card()!.textContent).toContain("attempt two live output");
    const select = document.body.querySelector<HTMLSelectElement>('[data-test="group-detail-attempt"]')!;
    expect(select.options).toHaveLength(2);
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(openTrace).toHaveBeenCalledWith("turn_a", 1);
    const text = card()!.textContent ?? "";
    expect(text).toContain("attempt one output");
    expect(text).not.toContain("attempt two live output");
    live.mockRestore();
    wrapper.unmount();
  });

  it("load-more, load-earlier and retry request the selected attempt's page", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    seedTracePage(1, { hasMore: true, hasEarlier: true, error: "connector outdated" });
    const ensure = vi.spyOn(groups, "ensureTracePage").mockResolvedValue(undefined);
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const status = () => document.body.querySelector('[data-test="group-trace-status"]')!;
    (status().querySelector('[data-test="group-trace-load-more"]') as HTMLElement).click();
    await flushPromises();
    expect(ensure).toHaveBeenCalledWith("turn_a", 1, undefined);
    (status().querySelector('[data-test="group-trace-load-earlier"]') as HTMLElement).click();
    await flushPromises();
    expect(ensure).toHaveBeenCalledWith("turn_a", 1, 0);
    (status().querySelector('[data-test="group-trace-retry"]') as HTMLElement).click();
    await flushPromises();
    expect(ensure).toHaveBeenCalledWith("turn_a", 1, undefined);
    expect(status().textContent).toContain("connector outdated");
    wrapper.unmount();
  });

  it("explains contradictory member identity without loading a trace or offering Stop", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    // Two distinct durable turns claiming the same source prompt is the
    // contradiction the projection can actually observe (ids stay unique).
    groups.memberTurnsById = {
      turn_a: turnOf({ id: "turn_a", promptRequestId: "source-1" }),
      turn_b: turnOf({ id: "turn_b", botId: "bot_b", memberIndex: 1, promptRequestId: "source-1" }),
    };
    const ensure = vi.spyOn(groups, "ensureTracePage").mockResolvedValue(undefined);
    const openTrace = vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const detail = card()!;
    expect(detail.querySelector('[data-test="group-detail-explanation"]')?.textContent).toBeTruthy();
    expect(detail.querySelector('[data-test="group-stop-run-button"]')).toBeNull();
    expect(detail.querySelector('[data-test="group-trace-status"]')).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    expect(openTrace).not.toHaveBeenCalledWith("turn_a", 1);
    wrapper.unmount();
  });

  it("detail content renders the identity explanation and hides trace/stop", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: {
        run: runOf(),
        memberTurn: turnOf(),
        memberName: "Reviewer",
        attempt: 1,
        attempts: [1, 2],
        explanation: "This reply could not be linked to exactly one member turn, so no process is attached.",
      },
    });
    expect(wrapper.find('[data-test="group-detail-explanation"]').text()).toContain("could not be linked");
    expect(wrapper.find('[data-test="group-trace-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-stop-run-button"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders exactly one explanation and one duration in the content", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: {
        run: runOf({ state: "completed", finishedAt: "2026-09-01T00:01:01.000Z" }),
        explanation: "This reply could not be linked to exactly one member turn, so no process is attached.",
      },
    });
    const el = wrapper.find('[data-test="group-run-detail"]').element as HTMLElement;
    expect(el.querySelectorAll('[data-test="group-detail-explanation"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-test="group-detail-duration"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("describes per-member runs as parallel across Bot workspaces", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: { run: runOf(), workspaceMode: "per-member" },
    });
    expect(wrapper.find('[data-test="group-detail-workspace"]').text()).toContain("each member's own Bot workspace");
    wrapper.unmount();
  });

  it("confirms a cancelled run at the top of the detail", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: {
        run: runOf({ state: "cancelled" }),
        memberTurn: turnOf({ state: "cancelled" }),
        memberName: "Reviewer",
        attempt: 1,
        attempts: [1],
      },
    });
    const detail = wrapper.find('[data-test="group-run-detail"]').element as HTMLElement;
    const note = detail.querySelector<HTMLElement>('[data-test="group-detail-stopped"]');
    expect(note?.textContent).toContain("Run stopped");
    wrapper.unmount();
  });

  it("labels a live running member as recording while no durable trace page exists", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    vi.spyOn(groups, "ensureTracePage").mockImplementation(() => {});
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    vi.spyOn(groups, "liveTurnForMember").mockReturnValue({
      parts: [], status: "streaming", startedAt: 1, revision: 1,
    } as never);
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const status = document.body.querySelector('[data-test="group-trace-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Recording now");
    wrapper.unmount();
  });

  it("prefers the durable page's state over a live recording label", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    seedTracePage(1, { recordingState: "unavailable", error: "connector outdated" });
    vi.spyOn(groups, "setOpenTrace").mockImplementation(() => {});
    vi.spyOn(groups, "liveTurnForMember").mockReturnValue({
      parts: [], status: "streaming", startedAt: 1, revision: 1,
    } as never);
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const status = document.body.querySelector('[data-test="group-trace-status"]')!;
    expect(status.textContent).toContain("Process was not recorded for this run");
    expect(status.textContent).toContain("connector outdated");
    expect(status.textContent).not.toContain("Recording now");
    wrapper.unmount();
  });

  it("AgentThinkingBubble emits its own element and announces the dialog relationship", async () => {
    const wrapper = mount(AgentThinkingBubble, {
      props: { status: "running", label: "Open process for Reviewer", controls: "group-detail-x", expanded: true },
    });
    await wrapper.get('[data-test="agent-thinking-bubble"]').trigger("click");
    const emitted = wrapper.emitted("toggle")?.[0]?.[0];
    expect(emitted).toBe(wrapper.get('[data-test="agent-thinking-bubble"]').element);
    expect(wrapper.get('[data-test="agent-thinking-bubble"]').attributes("aria-haspopup")).toBe("dialog");
    expect(wrapper.get('[data-test="agent-thinking-bubble"]').attributes("aria-controls")).toBe("group-detail-x");
    wrapper.unmount();
  });

  it("AgentThinkingBubble shows the retry count only after the first attempt", () => {
    const first = mount(AgentThinkingBubble, { props: { status: "running", label: "Open process for Reviewer", attempt: 1 } });
    expect(first.find(".group-bubble-attempt").exists()).toBe(false);
    first.unmount();
    const retried = mount(AgentThinkingBubble, { props: { status: "running", label: "Open process for Reviewer", attempt: 2 } });
    expect(retried.find(".group-bubble-attempt").text()).toBe("2");
    retried.unmount();
  });
  it("resumes the remembered trace position when the same member reopens", async () => {
    const groups = seedEnvironment();
    seedLiveRun();
    seedTracePage(1, {
      events: Array.from({ length: 3 }, (_, index) => ({
        seq: index + 1, createdAt: "now", kind: "text" as const, payload: { text: `recorded chunk ${index + 1}` },
      })),
    });
    const wrapper = mountTranscript();
    await openFirstBubble(wrapper);
    const scroller = document.body.querySelector<HTMLElement>(".group-detail-scroll")!;
    const inherited = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    let remembered = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => remembered,
      set: (value: number) => { remembered = value; inherited?.set?.call(scroller, value); },
    });
    remembered = 120;
    scroller.dispatchEvent(new Event("scroll"));
    await flushPromises();
    // Toggle the same bubble: close, then reopen onto a fresh scroll element.
    await openFirstBubble(wrapper);
    expect(card()).toBeNull();
    await openFirstBubble(wrapper);
    const reopened = document.body.querySelector<HTMLElement>(".group-detail-scroll")!;
    expect(reopened.scrollTop).toBe(120);
    wrapper.unmount();
  });
});
