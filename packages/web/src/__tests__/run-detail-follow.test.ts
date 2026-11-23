import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type { ConversationRunDetailDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { MSG } from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload),
  },
}));

import { useGroupsStore } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";

const scope = { conversationId: "conversation_g", topicId: "topic_1" } as const;

function member(id: string, patch: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    ...scope,
    id,
    runId: "run_1",
    botId: "bot_a",
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "human-explicit",
    state: "running",
    createdAt: "now",
    ...patch,
  };
}

function runDetail(id = "run_1", memberTurns: MemberTurnSummaryDto[] = [member("turn_a")]): ConversationRunDetailDto {
  return {
    ...scope,
    id,
    requestMessageId: "m_req",
    requestId: "req_1",
    mode: "explicit",
    shape: "fanout",
    state: "running",
    profileRevision: 1,
    createdAt: "now",
    memberTurns,
  } as ConversationRunDetailDto;
}

function seedScope(): ReturnType<typeof useGroupsStore> {
  const store = useGroupsStore();
  store.instanceId = "i1";
  store.selectedGroupId = "conversation_g";
  store.activeConversationId = "conversation_g";
  store.activeTopicId = "topic_1";
  store.topicReady = true;
  useInstancesStore().instances = [{
    id: "i1",
    name: "Local",
    online: true,
    lastSeenAt: null,
    sessions: [],
    sessionsLoaded: true,
    agents: [{ name: "codex", driver: "codex" }],
    workspaces: [{ name: "repo", cwd: "/repo" }],
    agentCatalog: [],
    capabilities: [],
  } as never];
  return store;
}

function traceCalls() {
  return mockRpc.mock.calls.filter(([, type]) => type === MSG.runsTraceGet);
}

function batchCalls() {
  return mockRpc.mock.calls.filter(([, type]) => type === MSG.runsDetailsBatch);
}

describe("Run-detail trace follow", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
    vi.useRealTimers();
  });

  it("arms one immediate read, then coalesces frames into one throttled fetch", async () => {
    const store = seedScope();
    mockRpc.mockImplementation(async (_id: string, type: string) => {
      if (type === MSG.runsDetailsBatch) return { runs: [runDetail()], missingRunIds: [] };
      if (type === MSG.runsTraceGet) {
        return { memberTurnId: "turn_a", attempt: 1, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [] };
      }
      return {};
    });
    store.ensureRunDetails(["run_1"]);
    await flushPromises();
    mockRpc.mockClear();

    vi.useFakeTimers();
    store.setTraceFollow("turn_a", 1);
    // Opening a process reads at once; it is not blank until the next frame.
    expect(traceCalls()).toHaveLength(1);
    await flushPromises();
    expect(traceCalls()).toHaveLength(1);

    // A burst of frames inside the throttle window collapses into one read.
    store.followTraceFrame("turn_a", 1);
    store.followTraceFrame("turn_a", 1);
    store.followTraceFrame("turn_a", 1);
    expect(traceCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(2);
  });

  it("flushes a terminal frame without waiting for the throttle", async () => {
    const store = seedScope();
    mockRpc.mockImplementation(async (_id: string, type: string) => {
      if (type === MSG.runsDetailsBatch) return { runs: [runDetail()], missingRunIds: [] };
      if (type === MSG.runsTraceGet) {
        return { memberTurnId: "turn_a", attempt: 1, recordingState: "complete", events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [] };
      }
      return {};
    });
    store.ensureRunDetails(["run_1"]);
    await flushPromises();
    mockRpc.mockClear();

    vi.useFakeTimers();
    store.setTraceFollow("turn_a", 1);
    await flushPromises();
    store.followTraceFrame("turn_a", 1);
    expect(traceCalls()).toHaveLength(1);
    store.followTraceFrame("turn_a", 1, true);
    expect(traceCalls()).toHaveLength(2);
    // The pending throttled read was retired, not left to fire twice.
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(2);
  });

  it("ignores frames of another member or attempt", async () => {
    const store = seedScope();
    mockRpc.mockImplementation(async (_id: string, type: string) => {
      if (type === MSG.runsDetailsBatch) {
        return { runs: [runDetail("run_1", [member("turn_a"), member("turn_b", { memberIndex: 1 })])], missingRunIds: [] };
      }
      if (type === MSG.runsTraceGet) {
        return { memberTurnId: "turn_a", attempt: 1, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1, 2], plan: [] };
      }
      return {};
    });
    store.ensureRunDetails(["run_1"]);
    await flushPromises();
    mockRpc.mockClear();

    vi.useFakeTimers();
    store.setTraceFollow("turn_a", 1);
    await flushPromises();
    const armed = traceCalls().length;
    store.followTraceFrame("turn_b", 1);
    store.followTraceFrame("turn_a", 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(armed);
  });

  it("moves the cursor when the drawer switches attempt, both ways", async () => {
    const store = seedScope();
    mockRpc.mockImplementation(async (_id: string, type: string, payload?: unknown) => {
      if (type === MSG.runsDetailsBatch) return { runs: [runDetail()], missingRunIds: [] };
      if (type === MSG.runsTraceGet) {
        const attempt = (payload as { attempt?: number })?.attempt ?? 1;
        return { memberTurnId: "turn_a", attempt, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1, 2], plan: [] };
      }
      return {};
    });
    store.ensureRunDetails(["run_1"]);
    await flushPromises();
    mockRpc.mockClear();

    vi.useFakeTimers();
    store.setTraceFollow("turn_a", 1);
    await flushPromises();
    // Attempt 2 is a different trace: the old cursor rejects its frames…
    store.followTraceFrame("turn_a", 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls().every(([, , payload]) => (payload as { attempt?: number }).attempt === 1)).toBe(true);

    // …until the drawer re-arms on the selected attempt.
    store.setTraceFollow("turn_a", 2);
    expect((traceCalls().at(-1)![2] as { attempt?: number }).attempt).toBe(2);
    mockRpc.mockClear();
    store.followTraceFrame("turn_a", 2);
    await vi.advanceTimersByTimeAsync(500);
    expect((traceCalls().at(-1)![2] as { attempt?: number }).attempt).toBe(2);

    // Switching back re-arms again instead of keeping the stale attempt.
    store.setTraceFollow("turn_a", 1);
    expect((traceCalls().at(-1)![2] as { attempt?: number }).attempt).toBe(1);
    mockRpc.mockClear();
    store.followTraceFrame("turn_a", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect((traceCalls().at(-1)![2] as { attempt?: number }).attempt).toBe(1);
  });

  it("stops reading once the drawer closes or the scope changes", async () => {
    const store = seedScope();
    mockRpc.mockImplementation(async (_id: string, type: string) => {
      if (type === MSG.runsDetailsBatch) return { runs: [runDetail()], missingRunIds: [] };
      if (type === MSG.runsTraceGet) {
        return { memberTurnId: "turn_a", attempt: 1, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [] };
      }
      return {};
    });
    store.ensureRunDetails(["run_1"]);
    await flushPromises();
    mockRpc.mockClear();

    vi.useFakeTimers();
    store.setTraceFollow("turn_a", 1);
    await flushPromises();
    const armed = traceCalls().length;
    store.clearTraceFollow();
    store.followTraceFrame("turn_a", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(armed);

    // A scope change clears the follow as well: a frame after the switch is inert.
    store.setTraceFollow("turn_a", 1);
    await flushPromises();
    const rearmed = traceCalls().length;
    store.activeTopicId = "topic_2";
    store.followTraceFrame("turn_a", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(rearmed);
  });

  it("recovers a negatively cached Run on an explicit refresh", async () => {
    const store = seedScope();
    let missing = true;
    mockRpc.mockImplementation(async (_id: string, type: string, payload?: unknown) => {
      if (type === MSG.runsDetailsBatch) {
        const ids = (payload as { runIds: string[] }).runIds;
        return {
          runs: [
            ...(ids.includes("run_other") ? [runDetail("run_other", [member("turn_o", { runId: "run_other" })])] : []),
            ...(!missing && ids.includes("run_1") ? [runDetail()] : []),
          ],
          missingRunIds: missing && ids.includes("run_1") ? ["run_1"] : [],
        };
      }
      return {};
    });

    store.ensureRunDetails(["run_1"]);
    await flushPromises();
    expect(store.isRunDetailMissing("run_1")).toBe(true);
    expect(batchCalls()).toHaveLength(1);

    // An unrelated adopt bumps the revision but must not refetch the miss.
    const beforeRevision = store.runHistoryDetailRevision;
    store.ensureRunDetails(["run_other"], true);
    await flushPromises();
    expect(store.runHistoryDetailRevision).toBeGreaterThan(beforeRevision);
    expect(batchCalls().filter(([, , payload]) => (payload as { runIds: string[] }).runIds.includes("run_1"))).toHaveLength(1);

    // A reconnect refresh is the recovery path: it bypasses the negative entry.
    missing = false;
    store.refreshRunDetails();
    await flushPromises();
    expect(batchCalls().filter(([, , payload]) => (payload as { runIds: string[] }).runIds.includes("run_1"))).toHaveLength(2);
    expect(store.isRunDetailMissing("run_1")).toBe(false);
  });
});

describe("Direct trace follow", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
    vi.useRealTimers();
  });

  it("refetches the open process after a committed frame", async () => {
    const direct = useDirectBotsStore();
    direct.instanceId = "i1";
    direct.selectedBotId = "bot_a";
    direct.activeConversationId = "conversation_b";
    direct.activeTopicId = "topic_b";
    direct.activeRun = {
      id: "run_d", conversationId: "conversation_b", topicId: "topic_b",
      requestMessageId: "m1", requestId: "r1", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now",
    } as never;
    mockRpc.mockImplementation(async (_id: string, type: string, payload?: unknown) => {
      if (type === MSG.runsTraceGet) {
        const attempt = (payload as { attempt?: number })?.attempt ?? 1;
        return { memberTurnId: "turn_d", attempt, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1, 2], plan: [] };
      }
      return {};
    });

    vi.useFakeTimers();
    direct.setDirectTraceFollow("run_d", "turn_d", 1);
    direct.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "tool-event",
        chatKey: "c",
        sessionAlias: "s",
        conversation: {
          conversationId: "conversation_b", topicId: "topic_b",
          runId: "run_d", memberTurnId: "turn_d", botId: "bot_a", attempt: 1,
        },
        step: { toolCallId: "t1", toolName: "read_file", kind: "read", status: "success", title: "Read", startedAt: Date.now() },
      },
    } as never);
    expect(traceCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(1);
    expect((traceCalls()[0]![2] as { attempt?: number }).attempt).toBe(1);
  });

  it("follows the attempt the drawer actually shows", async () => {
    const direct = useDirectBotsStore();
    direct.instanceId = "i1";
    direct.selectedBotId = "bot_a";
    direct.activeConversationId = "conversation_b";
    direct.activeTopicId = "topic_b";
    direct.activeRun = {
      id: "run_d", conversationId: "conversation_b", topicId: "topic_b",
      requestMessageId: "m1", requestId: "r1", mode: "explicit", state: "running",
      profileRevision: 1, createdAt: "now",
    } as never;
    mockRpc.mockImplementation(async (_id: string, type: string, payload?: unknown) => {
      if (type === MSG.runsTraceGet) {
        const attempt = (payload as { attempt?: number })?.attempt ?? 1;
        return { memberTurnId: "turn_d", attempt, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1, 2], plan: [] };
      }
      return {};
    });
    const frame = (attempt: number) => ({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "tool-event",
        chatKey: "c",
        sessionAlias: "s",
        conversation: {
          conversationId: "conversation_b", topicId: "topic_b",
          runId: "run_d", memberTurnId: "turn_d", botId: "bot_a", attempt,
        },
        step: { toolCallId: `t${attempt}`, toolName: "read_file", kind: "read", status: "success", title: "Read", startedAt: Date.now() },
      },
    });

    vi.useFakeTimers();
    direct.setDirectTraceFollow("run_d", "turn_d", 1);
    direct.applyEvent(frame(2) as never);
    await vi.advanceTimersByTimeAsync(500);
    // Attempt 1 is followed, so attempt 2's frame is a mismatch, not a read.
    expect(traceCalls()).toHaveLength(0);

    direct.setDirectTraceFollow("run_d", "turn_d", 2);
    direct.applyEvent(frame(2) as never);
    await vi.advanceTimersByTimeAsync(500);
    expect(traceCalls()).toHaveLength(1);
    expect((traceCalls()[0]![2] as { attempt?: number }).attempt).toBe(2);
  });
});
