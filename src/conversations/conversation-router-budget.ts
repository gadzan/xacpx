import { ConversationError } from "./conversation-error";
import {
  MAX_ROUTER_ASSIGNMENTS_PER_DECISION, MAX_ROUTER_DEPENDENCIES, MAX_ROUTER_INPUT_CHARACTERS,
  MAX_ROUTER_MEMBER_METADATA, MAX_ROUTER_REQUEST_LENGTH, MAX_ROUTER_RESULT_CHARACTERS,
  MAX_ROUTER_TRANSCRIPT_CHARACTERS, MAX_ROUTER_TRIGGER_MESSAGE_IDS,
  type RoutingInput,
} from "./conversation-router-types";

/** Prefix truncation is deterministic and keeps Unicode surrogate pairs intact. */
function prefix(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const end = value.charCodeAt(limit - 1);
  return value.slice(0, end >= 0xD800 && end <= 0xDBFF ? limit - 1 : limit);
}

/** Bound model context only: durable records and execution prompts remain complete. */
export function boundRoutingInput(input: RoutingInput): RoutingInput {
  if (input.completedAssignments.length > MAX_ROUTER_ASSIGNMENTS_PER_DECISION) {
    throw new ConversationError("router_input_too_large", "Router assignment history exceeds its snapshot budget");
  }
  const request = prefix(input.request, MAX_ROUTER_REQUEST_LENGTH);
  let transcriptLeft = MAX_ROUTER_TRANSCRIPT_CHARACTERS;
  const publicTranscript = input.publicTranscript.map((row) => {
    const content = prefix(row.content, Math.min(2_000, transcriptLeft));
    transcriptLeft -= content.length;
    return { ...row, content, ...(content !== row.content ? { contextTruncated: true as const } : {}) };
  });
  let resultLeft = MAX_ROUTER_RESULT_CHARACTERS;
  const completedAssignments = input.completedAssignments.map((assignment) => {
    const task = prefix(assignment.task, 1_000);
    const expectedOutput = assignment.expectedOutput === undefined ? undefined : prefix(assignment.expectedOutput, 500);
    const failureReason = assignment.failureReason === undefined ? undefined : prefix(assignment.failureReason, 512);
    const result = assignment.result === undefined ? undefined : prefix(assignment.result, Math.min(4_000, resultLeft));
    resultLeft -= result?.length ?? 0;
    const dependsOn = assignment.dependsOn.slice(0, MAX_ROUTER_DEPENDENCIES);
    const triggerMessageIds = assignment.triggerMessageIds.slice(0, MAX_ROUTER_TRIGGER_MESSAGE_IDS);
    const truncated = task !== assignment.task || expectedOutput !== assignment.expectedOutput
      || failureReason !== assignment.failureReason
      || result !== assignment.result || dependsOn.length !== assignment.dependsOn.length
      || triggerMessageIds.length !== assignment.triggerMessageIds.length;
    return { ...assignment, task, expectedOutput, failureReason, result, dependsOn, triggerMessageIds,
      ...(truncated ? { contextTruncated: true as const } : {}) };
  });
  const memberMetadata = input.memberMetadata.slice(0, MAX_ROUTER_MEMBER_METADATA).map((member) => {
    const name = prefix(member.name, 128);
    const role = member.role === undefined ? undefined : prefix(member.role, 256);
    return { ...member, name, role, ...(name !== member.name || role !== member.role ? { contextTruncated: true as const } : {}) };
  });
  const omittedMemberCount = (input.omittedMemberCount ?? 0) + input.memberMetadata.length - memberMetadata.length;
  const bounded: RoutingInput = { ...input, request, publicTranscript, completedAssignments, memberMetadata,
    ...(request !== input.request ? { requestTruncated: true } : {}),
    ...(omittedMemberCount > 0 ? { omittedMemberCount } : {}),
  };
  if (JSON.stringify(bounded).length > MAX_ROUTER_INPUT_CHARACTERS) {
    throw new ConversationError("router_input_too_large", "Router snapshot exceeds its serialized character budget");
  }
  return bounded;
}
