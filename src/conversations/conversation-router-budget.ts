import { durableCollaborationFacts } from "./collaboration-policy";
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

/** Bound Router snapshots only; durable public records remain complete. The
 *  assignment evidence is a recency window: older settled assignments stay in
 *  the store, are counted in `completedAssignmentTotal`, and are disclosed as
 *  omitted rather than dropped silently or treated as resolved. */
export function boundRoutingInput(input: RoutingInput): RoutingInput {
  const request = prefix(input.request, MAX_ROUTER_REQUEST_LENGTH);
  let transcriptLeft = MAX_ROUTER_TRANSCRIPT_CHARACTERS;
  const publicTranscript = [...input.publicTranscript];
  // Recency is carried by seq, not by the caller's array order. Allocate
  // newest-first, then leave each row in its original presentation position.
  const newestFirst = input.publicTranscript.map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.seq - a.row.seq);
  for (const { row, index } of newestFirst) {
    const content = prefix(row.content, Math.min(2_000, transcriptLeft));
    transcriptLeft -= content.length;
    publicTranscript[index] = { ...row, content, ...(content !== row.content ? { contextTruncated: true as const } : {}) };
  }
  // Recency is carried by batch, not the caller's array order: the window
  // keeps the newest assignments and restores the caller's order for them.
  const history = input.completedAssignments;
  const newestRows = history.map((assignment, index) => ({ assignment, index }))
    .sort((a, b) => b.assignment.batch - a.assignment.batch || a.index - b.index);
  const windowed = newestRows.slice(0, MAX_ROUTER_ASSIGNMENTS_PER_DECISION)
    .sort((a, b) => a.index - b.index).map(({ assignment }) => assignment);
  let omittedAssignmentCount = (input.omittedAssignmentCount ?? 0) + history.length - windowed.length;
  let completedAssignments = windowed;
  // Independence and recovery are cumulative Run facts. Derive them from the
  // full history here, before the window and the character budget drop rows:
  // afterwards a producer could verify its own artifact and recovery would
  // reset. An already-bounded snapshot keeps its own verdict.
  const durableCollaboration = input.durableCollaboration ?? durableCollaborationFacts(history);
  // Latest batches receive evidence first; retain the caller's history order.
  const newestAssignments = completedAssignments.map((assignment, index) => ({ assignment, index }))
    .sort((a, b) => b.assignment.batch - a.assignment.batch || a.index - b.index);
  let resultLeft = MAX_ROUTER_RESULT_CHARACTERS;
  for (const { assignment, index } of newestAssignments) {
    const task = prefix(assignment.task, 1_000);
    const expectedOutput = assignment.expectedOutput === undefined ? undefined : prefix(assignment.expectedOutput, 500);
    const failureReason = assignment.failureReason === undefined ? undefined : prefix(assignment.failureReason, 512);
    const result = assignment.result === undefined ? undefined : prefix(assignment.result, Math.min(4_000, resultLeft));
    // Preserve original content truth across re-bounding. An empty/whitespace
    // legacy prefix cannot prove the omitted original was itself blank.
    const originalResultKnown = !assignment.resultTruncated
      && (!assignment.contextTruncated || assignment.resultTruncated === false)
      && (assignment.resultCharacters === undefined || assignment.resultCharacters === assignment.result?.length);
    const resultHasContent = assignment.resultHasContent
      ?? (assignment.result?.trim() ? true : originalResultKnown ? false : undefined);
    resultLeft -= result?.length ?? 0;
    const dependsOn = assignment.dependsOn.slice(0, MAX_ROUTER_DEPENDENCIES);
    const triggerMessageIds = assignment.triggerMessageIds.slice(0, MAX_ROUTER_TRIGGER_MESSAGE_IDS);
    const truncated = task !== assignment.task || expectedOutput !== assignment.expectedOutput
      || failureReason !== assignment.failureReason
      || result !== assignment.result || dependsOn.length !== assignment.dependsOn.length
      || triggerMessageIds.length !== assignment.triggerMessageIds.length;
    completedAssignments[index] = { ...assignment, task, expectedOutput, failureReason, result, dependsOn, triggerMessageIds,
      ...(assignment.result !== undefined ? { resultCharacters: assignment.resultCharacters ?? assignment.result.length } : {}),
      ...(assignment.result !== undefined && resultHasContent !== undefined ? { resultHasContent } : {}),
      ...(truncated ? { contextTruncated: true as const, resultTruncated: assignment.resultTruncated === true || result !== assignment.result } : {}) };
  }
  const memberMetadata = input.memberMetadata.slice(0, MAX_ROUTER_MEMBER_METADATA).map((member) => {
    const name = prefix(member.name, 128);
    const role = member.role === undefined ? undefined : prefix(member.role, 256);
    return { ...member, name, role, ...(name !== member.name || role !== member.role ? { contextTruncated: true as const } : {}) };
  });
  const omittedMemberCount = (input.omittedMemberCount ?? 0) + input.memberMetadata.length - memberMetadata.length;
  const snapshot = (): RoutingInput => ({ ...input, request, publicTranscript, completedAssignments, memberMetadata,
    durableCollaboration,
    ...(request !== input.request ? { requestTruncated: true } : {}),
    ...(omittedMemberCount > 0 ? { omittedMemberCount } : {}),
    ...(omittedAssignmentCount > 0 ? { omittedAssignmentCount } : {}),
  });
  let bounded = snapshot();
  let size = JSON.stringify(bounded).length;
  // History length never fails a routing attempt on its own: when the fixed
  // evidence still exceeds the serialized budget, the oldest window rows leave
  // it first, and their removal stays disclosed through the omitted count.
  while (size > MAX_ROUTER_INPUT_CHARACTERS && completedAssignments.length > 0) {
    // The oldest batch leaves first; ties keep the earliest member position.
    const oldest = completedAssignments.reduce((drop, row, position) =>
      row.batch < completedAssignments[drop]!.batch ? position : drop, 0);
    completedAssignments = completedAssignments.toSpliced(oldest, 1);
    omittedAssignmentCount++;
    bounded = snapshot();
    size = JSON.stringify(bounded).length;
  }
  if (size > MAX_ROUTER_INPUT_CHARACTERS) {
    throw new ConversationError("router_input_too_large", "Router snapshot exceeds its serialized character budget");
  }
  return bounded;
}
