import { describe, expect, it } from "vitest";
import type { BotSummaryDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";
import {
  GROUP_DISPATCH_AVATAR_LIMIT,
  presentGroupDispatch,
  type GroupDispatchEntry,
  type GroupDispatchLeader,
  type GroupDispatchPresentationInput,
} from "../lib/group-dispatch-presentation";

const BOTS: BotSummaryDto[] = [
  { id: "bot_lead", name: "Leader", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_c", name: "Builder", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_d", name: "Auditor", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_e", name: "Planner", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];

function turn(botId: string, state: MemberTurnSummaryDto["state"], over: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    id: `turn_${botId}`,
    runId: "run_1",
    conversationId: "conv_g",
    topicId: "topic_1",
    botId,
    batch: 1,
    attempt: 1,
    origin: "handoff",
    state,
    createdAt: "now",
    ...over,
  };
}

function entry(
  botId: string,
  state: MemberTurnSummaryDto["state"],
  over: { task?: string; reply?: { id: string; content: string } | null; turn?: Partial<MemberTurnSummaryDto> } = {},
): GroupDispatchEntry {
  return {
    handoff: {
      senderMemberTurnId: "turn_leader",
      to: botId,
      assignmentId: `assignment_${botId}`,
      memberTurnId: `turn_${botId}`,
      task: over.task ?? `Do the ${botId} work`,
    },
    memberTurn: turn(botId, state, over.turn),
    reply: over.reply ?? null,
  };
}

function leader(over: Partial<GroupDispatchLeader> = {}): GroupDispatchLeader {
  return { botId: "bot_lead", memberTurnId: "turn_leader", state: "running", ...over };
}

function present(over: Partial<GroupDispatchPresentationInput> = {}): GroupDispatchPresentationInput {
  return {
    leader: leader(),
    dispatches: [],
    bots: BOTS,
    drivers: { bot_a: "codex" },
    supportsCancelMember: true,
    ...over,
  };
}

describe("presentGroupDispatch", () => {
  it("aggregates one leader round into running rows with the task text once", () => {
    const result = presentGroupDispatch(present({
      dispatches: [
        entry("bot_a", "running", { task: "Review the diff", reply: { id: "msg_a", content: "Looks good\nsecond line" } }),
        entry("bot_b", "queued", { task: "Review the diff" }),
      ],
    }));

    expect(result.instructions).toBe("Review the diff");
    expect(result.members.map((member) => [member.botId, member.name, member.status])).toEqual([
      ["bot_a", "Reviewer", "running"],
      ["bot_b", "Tester", "queued"],
    ]);
    expect(result.counts).toEqual({ running: 1, queued: 1, completed: 0, cancelled: 0, failed: 0, indeterminate: 0 });
    expect(result.summary).toBe("running");
    expect(result.leaderStopped).toBe(false);
    expect(result.members[0]?.replyPreview).toBe("Looks good");
    expect(result.members[0]?.replyId).toBe("msg_a");
    expect(result.members[1]?.replyPreview).toBe("");
    expect(result.members[1]?.replyId).toBe("");
    expect(result.capability).toEqual({ canStopMember: true, leaderStopAction: "leader-only", anyActive: true });
  });

  it("reports done when every dispatched member completed", () => {
    const result = presentGroupDispatch(present({
      dispatches: [entry("bot_a", "completed"), entry("bot_b", "completed")],
    }));

    expect(result.summary).toBe("done");
    expect(result.counts.completed).toBe(2);
    expect(result.capability.anyActive).toBe(false);
  });

  it("reports cancelled only when every dispatched member was cancelled", () => {
    const result = presentGroupDispatch(present({
      dispatches: [entry("bot_a", "cancelled"), entry("bot_b", "cancelled")],
    }));

    expect(result.summary).toBe("cancelled");
    expect(result.counts.cancelled).toBe(2);
  });

  it("reports mixed when completed and cancelled members are combined", () => {
    const result = presentGroupDispatch(present({
      dispatches: [entry("bot_a", "completed"), entry("bot_b", "cancelled")],
    }));

    expect(result.summary).toBe("mixed");
    expect(result.counts.completed).toBe(1);
    expect(result.counts.cancelled).toBe(1);
  });

  it("reports an empty round as done rather than a mixed outcome", () => {
    const result = presentGroupDispatch(present());

    expect(result.members).toEqual([]);
    expect(result.summary).toBe("done");
    expect(result.instructions).toBe("");
    expect(result.avatars).toEqual({ items: [], overflow: 0 });
    expect(result.capability.anyActive).toBe(false);
  });

  it("counts failed members without inventing a failed summary", () => {
    const result = presentGroupDispatch(present({
      dispatches: [entry("bot_a", "completed"), entry("bot_b", "failed")],
    }));

    expect(result.counts.failed).toBe(1);
    expect(result.summary).toBe("mixed");
    expect(result.members[1]?.status).toBe("failed");
  });

  it("keeps a stopped leader's completed members as done", () => {
    const result = presentGroupDispatch(present({
      leader: leader({ state: "completed", cancellationReason: "human-cancelled" }),
      dispatches: [entry("bot_a", "completed"), entry("bot_b", "completed")],
    }));

    expect(result.summary).toBe("done");
    expect(result.leaderStopped).toBe(true);
    expect(result.counts.completed).toBe(2);
  });

  it("falls back to stop-all on a core without scoped member cancellation", () => {
    const result = presentGroupDispatch(present({
      supportsCancelMember: false,
      dispatches: [entry("bot_a", "running"), entry("bot_b", "queued")],
    }));

    expect(result.capability).toEqual({ canStopMember: false, leaderStopAction: "stop-all", anyActive: true });
    expect(result.members.every((member) => !member.canStop)).toBe(true);
  });

  it("collapses avatars past the limit into an overflow count", () => {
    const dispatches = ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e"].map((botId) => entry(botId, "completed"));
    const result = presentGroupDispatch(present({ dispatches }));

    expect(result.avatars.items).toHaveLength(GROUP_DISPATCH_AVATAR_LIMIT);
    expect(result.avatars.items.map((avatar) => avatar.botId)).toEqual(["bot_a", "bot_b", "bot_c", "bot_d"]);
    expect(result.avatars.overflow).toBe(1);
    expect(result.members).toHaveLength(5);
  });

  it("reports no active member once every dispatch settled", () => {
    const result = presentGroupDispatch(present({
      dispatches: [entry("bot_a", "completed"), entry("bot_b", "cancelled")],
    }));

    expect(result.capability.anyActive).toBe(false);
  });
});
