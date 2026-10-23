import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, ConversationMessageDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";
import GroupTranscript from "../components/GroupTranscript.vue";
import { i18n } from "../i18n";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";

const profiles: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_c", name: "Builder", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];

function handoffMessage(index: number): ConversationMessageDto {
  return {
    id: `handoff_${index}`,
    conversationId: "group_1",
    topicId: "topic_1",
    runId: "run_1",
    seq: index * 2,
    role: "system",
    senderBotId: "bot_a",
    content: "Public handoff",
    createdAt: "now",
    handoff: {
      senderMemberTurnId: "turn_a",
      to: index === 1 ? "bot_b" : "bot_c",
      assignmentId: `assignment_${index}`,
      memberTurnId: `turn_member_${index}`,
      task: `Review assignment ${index}`,
    },
  };
}

function memberTurn(
  id: string,
  botId: string,
  state: MemberTurnSummaryDto["state"],
  over: Partial<MemberTurnSummaryDto> = {},
): MemberTurnSummaryDto {
  return {
    id,
    conversationId: "group_1",
    topicId: "topic_1",
    runId: "run_1",
    botId,
    batch: 1,
    attempt: 1,
    origin: id === "turn_a" ? "human-explicit" : "handoff",
    state,
    createdAt: "now",
    ...over,
  };
}

function seed(messages: ConversationMessageDto[], turns: MemberTurnSummaryDto[]) {
  setActivePinia(createPinia());
  const instances = useInstancesStore();
  instances.instances = [{
    id: "instance_1", name: "Local", online: true, lastSeenAt: null, sessions: [],
    capabilities: [], agents: [{ name: "codex", driver: "codex" }], workspaces: [{ name: "repo", cwd: "/repo" }],
    agentCatalog: [],
  } as never];
  vi.spyOn(instances, "loadRouterAvailability").mockResolvedValue(undefined);
  vi.spyOn(instances, "loadJevSettings").mockResolvedValue(undefined);
  const groups = useGroupsStore();
  groups.instanceId = "instance_1";
  groups.selectedGroupId = groups.activeConversationId = "group_1";
  groups.activeTopicId = "topic_1";
  groups.topicReady = true;
  groups.messages = messages;
  groups.memberTurnsById = Object.fromEntries(turns.map((t) => [t.id, t]));
  groups.activeRun = {
    id: "run_1", conversationId: "group_1", topicId: "topic_1", requestMessageId: "request_message",
    requestId: "request", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now",
  };
  return groups;
}

describe("scratch", () => {
  it("dumps the stopped leader transcript", async () => {
    seed(
      [
        { id: "leader_msg", conversationId: "group_1", topicId: "topic_1", runId: "run_1", seq: 1, role: "bot", senderBotId: "bot_a", promptRequestId: "prompt_leader", content: "Dispatching two reviews", createdAt: "now" },
        handoffMessage(1),
        handoffMessage(2),
      ],
      [
        { ...memberTurn("turn_a", "bot_a", "cancelled", { cancellationReason: "human-cancelled" }), promptRequestId: "prompt_leader" },
        memberTurn("turn_member_1", "bot_b", "completed"),
        memberTurn("turn_member_2", "bot_c", "completed"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    console.log(wrapper.html());
    expect(true).toBe(true);
  });
});
