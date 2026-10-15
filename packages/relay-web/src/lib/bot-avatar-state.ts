import type { ConversationRunDto, InteractionRequestDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";

export type BotAvatarState = "idle" | "queued" | "working" | "streaming" | "waiting" | "completed" | "failed" | "cancelled" | "indeterminate" | "offline" | "retired";

type TaskState = ConversationRunDto["state"] | MemberTurnSummaryDto["state"];

function isTerminalTask(state: TaskState | undefined): state is "completed" | "failed" | "cancelled" | "indeterminate" {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "indeterminate";
}

export function botAvatarState(input: {
  retired?: boolean;
  online?: boolean;
  runState?: ConversationRunDto["state"];
  memberState?: MemberTurnSummaryDto["state"];
  liveStatus?: "working" | "streaming";
  waiting?: boolean;
}): BotAvatarState {
  if (input.retired) return "retired";
  if (input.online === false) return "offline";
  if (isTerminalTask(input.memberState)) return input.memberState;
  if (isTerminalTask(input.runState)) return input.runState;
  const state = input.memberState ?? input.runState;
  if (input.waiting || state === "waiting-human") return "waiting";
  if (state === "running") return input.liveStatus === "streaming" ? "streaming" : "working";
  if (state === "queued" || state === "dispatched") return "queued";
  return "idle";
}

export function avatarHasOpenInteraction(
  interaction: { instanceId: string; outcome: string | null; request: InteractionRequestDto } | null | undefined,
  scope: { instanceId: string | null | undefined; botId: string | undefined; run: ConversationRunDto | null; memberTurnId?: string },
): boolean {
  const correlation = interaction?.request.conversation;
  return !!interaction && interaction.outcome === null && !!scope.run && !!scope.instanceId && !!scope.botId && !!correlation
    && interaction.instanceId === scope.instanceId && correlation.botId === scope.botId
    && correlation.conversationId === scope.run.conversationId && correlation.topicId === scope.run.topicId
    && correlation.runId === scope.run.id
    && (scope.memberTurnId === undefined || correlation.memberTurnId === scope.memberTurnId);
}
