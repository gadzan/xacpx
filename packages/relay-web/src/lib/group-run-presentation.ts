import type {
  ConversationMessageDto,
  ConversationRunDto,
  ConversationRunTraceEventDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  ToolStepDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";

/** One scoped Run with its known MemberTurns for projection. */
export interface GroupRunRecord {
  run: ConversationRunDto;
  memberTurns: MemberTurnSummaryDto[];
}

export type UnresolvedReason = "ambiguous-owner" | "owner-mismatch" | "missing-run" | "no-member";
type ActivityExplanation = UnresolvedReason | "missing-request" | "request-mismatch";

/** Discriminated transcript items. Keys are stable across promotions. */
export type GroupTranscriptItem =
  | {
    kind: "message";
    key: string;
    message: ConversationMessageDto;
    /** Owning MemberTurn when exactly proven; set only on bot replies. */
    memberTurn?: MemberTurnSummaryDto;
    run?: GroupRunRecord;
    /** True only on the earliest proven owning reply of the member. */
    bubbleAnchor: boolean;
  }
  | {
    kind: "member-activity";
    key: string;
    memberTurn: MemberTurnSummaryDto;
    run: GroupRunRecord;
    requestMessageId: string | undefined;
    explanation?: ActivityExplanation;
  }
  | {
    kind: "routing";
    key: string;
    run: GroupRunRecord;
    requestMessageId: string | undefined;
    explanation?: ActivityExplanation;
  }
  | {
    kind: "unresolved";
    key: string;
    message: ConversationMessageDto;
    run?: GroupRunRecord;
    explanation: UnresolvedReason;
  };

export interface GroupProjectionInput {
  messages: ConversationMessageDto[];
  runs: Record<string, GroupRunRecord>;
}

function memberProblem(record: GroupRunRecord, turn: MemberTurnSummaryDto): UnresolvedReason | undefined {
  if (turn.runId !== record.run.id ||
    turn.conversationId !== record.run.conversationId ||
    turn.topicId !== record.run.topicId || !turn.id || !turn.botId || turn.promptRequestId === "") {
    return "owner-mismatch";
  }
  if (record.memberTurns.filter((candidate) => candidate.id === turn.id).length !== 1) {
    return "ambiguous-owner";
  }
  if (turn.promptRequestId !== undefined &&
    record.memberTurns.filter((candidate) => candidate.promptRequestId === turn.promptRequestId).length !== 1) {
    return "ambiguous-owner";
  }
  return undefined;
}

/** Exact source ownership, with a unique same-bot fallback for legacy replies. */
export function resolveMemberOwner(
  record: GroupRunRecord | undefined,
  message: ConversationMessageDto,
): { owner?: MemberTurnSummaryDto; problem?: UnresolvedReason } {
  if (message.role !== "bot" || message.handoff || !message.runId) return {};
  if (!record) return { problem: "missing-run" };
  if (
    record.run.id !== message.runId ||
    record.run.conversationId !== message.conversationId ||
    record.run.topicId !== message.topicId ||
    !message.senderBotId || message.promptRequestId === ""
  ) {
    return { problem: "owner-mismatch" };
  }
  const candidates = record.memberTurns.filter((turn) => message.promptRequestId !== undefined
    ? turn.promptRequestId === message.promptRequestId
    : turn.botId === message.senderBotId);
  if (candidates.length > 1) return { problem: "ambiguous-owner" };
  const owner = candidates[0];
  if (!owner) return { problem: message.promptRequestId !== undefined ? "owner-mismatch" : "no-member" };
  const problem = memberProblem(record, owner);
  if (problem) return { problem };
  if (owner.botId !== message.senderBotId) return { problem: "owner-mismatch" };
  return { owner };
}

export function projectGroupTranscript(input: GroupProjectionInput): GroupTranscriptItem[] {
  const seenMessages = new Set<string>();
  const messages = [...input.messages].sort((a, b) => a.seq - b.seq).filter((message) => {
    const key = `${message.conversationId}\u0000${message.topicId}\u0000${message.id}`;
    if (seenMessages.has(key)) return false;
    seenMessages.add(key);
    // A settled MemberTurn that ended with nothing public to say keeps an
    // empty evidence row so its result can still be resolved. That row is not
    // something the Group asked to see: drawing it would show an empty bubble
    // and hide the member's own activity row. Attachment-only rows stay.
    return !(message.role === "bot" && message.content.trim() === "" && !message.attachments?.length);
  });
  const owners = new Map<ConversationMessageDto, MemberTurnSummaryDto>();
  const problems = new Map<ConversationMessageDto, UnresolvedReason>();
  const memberRepliesByOwner = new Map<GroupRunRecord, Map<string, ConversationMessageDto>>();
  // Latest message per Run, the anchor every synthesized row of that Run closes
  // on. Built once: the projection re-runs on each live message. A falsy
  // `runId` is skipped rather than used as a key, matching the output loop,
  // which only attributes a message to a Run when the id is truthy.
  const lastMessageByRun = new Map<string, ConversationMessageDto>();
  for (const message of messages) {
    if (message.runId) lastMessageByRun.set(message.runId, message);
  }
  const memberProblems: Record<string, UnresolvedReason> = {};
  const orphanCandidates: ConversationMessageDto[] = [];
  for (const message of messages) {
    if (message.role !== "bot" || message.handoff || !message.runId) continue;
    const record = input.runs[message.runId];
    const resolved = resolveMemberOwner(record, message);
    const owner = resolved.owner;
    const problem = resolved.problem;
    if (owner && record) {
      let memberReplies = memberRepliesByOwner.get(record);
      if (!memberReplies) {
        memberReplies = new Map();
        memberRepliesByOwner.set(record, memberReplies);
      }
      if (!memberReplies.has(owner.id)) memberReplies.set(owner.id, message);
      owners.set(message, owner);
      delete memberProblems[owner.id];
    } else if (owner) {
      owners.set(message, owner);
    } else if (problem) {
      problems.set(message, problem);
      if (problem !== "no-member") {
        const candidate = record?.memberTurns.filter((turn) => message.senderBotId
          ? turn.botId === message.senderBotId
          : true)[0];
        if (candidate?.id) memberProblems[candidate.id] = problem;
      }
    }
  }
  const pending: { anchor?: ConversationMessageDto; items: GroupTranscriptItem[] }[] = [];
  const records = Object.entries(input.runs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [runId, record] of records) {
    const matchingIds = messages.filter((message) => message.id === record.run.requestMessageId);
    const requests = matchingIds.filter((message) => message.role === "human" && !message.handoff &&
      message.conversationId === record.run.conversationId && message.topicId === record.run.topicId);
    const request = requests.length === 1 ? requests[0] : undefined;
    const requestProblem = request ? undefined : matchingIds.length === 0 ? "missing-request" : "request-mismatch";
    const items: GroupTranscriptItem[] = [];
    const ordered = [...record.memberTurns].sort((a, b) => a.batch - b.batch ||
      (a.memberIndex ?? 0) - (b.memberIndex ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seen = new Set<string>();
    for (const turn of ordered) {
      if (seen.has(turn.id)) continue;
      seen.add(turn.id);
      const problem = runId !== record.run.id ? "owner-mismatch" : memberProblem(record, turn) ?? memberProblems[turn.id];
      if (!problem && memberRepliesByOwner.get(record)?.has(turn.id)) continue;
      items.push({
        kind: "member-activity",
        key: `activity:${record.run.id}:${turn.id}`,
        memberTurn: turn,
        run: record,
        requestMessageId: request?.id,
        explanation: problem ?? requestProblem,
      });
    }
    if (ordered.length === 0) {
      items.push({
        kind: "routing",
        key: `routing:${record.run.id}`,
        run: record,
        requestMessageId: request?.id,
        explanation: runId !== record.run.id ? "owner-mismatch" : requestProblem,
      });
    }
    // Synthesized rows close out their Run's block: anchoring them on the human
    // request instead would float a still-running member above everything the
    // leader said after dispatching it, then drop it below on completion.
    const anchor = lastMessageByRun.get(record.run.id);
    if (items.length > 0) pending.push({ anchor, items });
  }

  const out: GroupTranscriptItem[] = [];
  for (const message of messages) {
    const record = message.runId ? input.runs[message.runId] : undefined;
    const owner = owners.get(message);
    const problem = problems.get(message);
    if (problem) {
      out.push({ kind: "unresolved", key: `unresolved:${message.id}`, message, run: record, explanation: problem });
    } else if (owner && !message.handoff) {
      out.push({
        kind: "message",
        key: `msg:${message.id}`,
        message,
        memberTurn: owner,
        run: record,
        bubbleAnchor: record !== undefined && memberRepliesByOwner.get(record)?.get(owner.id) === message,
      });
    } else {
      out.push({ kind: "message", key: `msg:${message.id}`, message, run: record, bubbleAnchor: false });
    }
    for (const group of pending) {
      if (group.anchor === message) out.push(...group.items);
    }
  }
  for (const group of pending) {
    if (!group.anchor) out.push(...group.items);
  }
  return out;
}

/** Recording states the durable store reports for one member/attempt trace. */
export type TraceReplayStatus = "recording" | "complete" | "interrupted" | "unavailable";

/** Reduce ordered durable trace events into renderable TurnParts. Text and
 *  reasoning coalesce adjacently (order-preserving); tool updates upsert by
 *  toolCallId; plan events are replace-latest and returned separately. */
export function traceEventsToParts(events: ConversationRunTraceEventDto[]): {
  parts: TurnPartDto[];
  plan: PlanEntryDto[] | undefined;
  terminal: { ok: boolean; cancelled?: boolean; errorMessage?: string } | undefined;
} {
  const parts: TurnPartDto[] = [];
  let plan: PlanEntryDto[] | undefined;
  let terminal: { ok: boolean; cancelled?: boolean; errorMessage?: string } | undefined;
  const upsertTool = (step: ToolStepDto): void => {
    const i = parts.findIndex((p) => p.type === "tool" && p.step.toolCallId === step.toolCallId);
    if (i >= 0) parts[i] = { type: "tool", step };
    else parts.push({ type: "tool", step });
  };
  for (const event of events) {
    if (event.kind === "text") {
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text += event.payload.text;
      else parts.push({ type: "text", text: event.payload.text });
    } else if (event.kind === "reasoning") {
      const last = parts[parts.length - 1];
      if (last?.type === "reasoning") last.text += event.payload.text;
      else if (event.payload.text.trim()) parts.push({ type: "reasoning", text: event.payload.text });
    } else if (event.kind === "tool") {
      upsertTool(event.payload.step);
    } else if (event.kind === "plan") {
      plan = event.payload.entries;
    } else if (event.kind === "terminal") {
      terminal = event.payload;
    }
  }
  return { parts, plan, terminal };
}

/**
 * Merge the durable replay parts of one member/attempt with the live hub's
 * parts for the same turn (drawer freshness contract, 150ms).
 *
 * Durable pages are authoritative for history but lag the hub by a refetch
 * window; the live channel has the freshest tail. Both channels describe the
 * same event stream, so this is a selection, not a concatenation. Order always
 * follows the durable page, with genuinely live-only events appended at the
 * tail:
 *
 * - tools upsert by `toolCallId`. A durable terminal status (`success`/`error`)
 *   is the audited record and is never regressed by a lagging live frame; a
 *   durable `running` snapshot always loses to the fresher live frame;
 * - prose (`text`/`reasoning`) is matched per block in channel order: an exact
 *   text match is the same block, a live block containing the durable text is
 *   the grown superset, and a live fragment already contained in the durable
 *   block is a late-subscription duplicate. Anything else is a genuinely new
 *   block and is appended once. This keeps `[text, tool, text]` aligned block
 *   by block instead of collapsing prose to "the last block";
 * - when the member is terminal and the durable page has content, the page is
 *   authoritative and any stale live tail is dropped. A terminal member with
 *   an empty page (not recorded / unavailable) keeps the live fallback.
 */
export function mergeLiveTraceParts(
  replay: readonly TurnPartDto[] | undefined,
  live: readonly TurnPartDto[] | undefined,
  options?: { terminal?: boolean },
): TurnPartDto[] | undefined {
  if (options?.terminal === true && replay !== undefined && replay.length > 0) return [...replay];
  if (!live || live.length === 0) return replay ? [...replay] : replay;
  if (!replay || replay.length === 0) return [...live];
  const merged = replay.map((part) => (part.type === "tool" ? { ...part, step: part.step } : { ...part }));
  const consumed = new Array<boolean>(merged.length).fill(false);
  for (const part of live) {
    if (part.type === "tool") {
      const index = merged.findIndex((candidate) =>
        candidate.type === "tool" && candidate.step.toolCallId === part.step.toolCallId);
      if (index < 0) {
        merged.push({ type: "tool", step: part.step });
        consumed.push(true);
        continue;
      }
      const current = merged[index]!;
      // A durable terminal status is final; a durable `running` snapshot is
      // stale the moment the live frame disagrees.
      if (current.type === "tool" && current.step.status === "running") {
        merged[index] = { type: "tool", step: part.step };
      }
      continue;
    }
    const match = (predicate: (text: string) => boolean): number => {
      for (let index = 0; index < merged.length; index++) {
        if (consumed[index] === true) continue;
        const candidate = merged[index]!;
        if (candidate.type !== part.type || !predicate(candidate.text)) continue;
        return index;
      }
      return -1;
    };
    // The same block, streamed through both channels.
    const exact = match((text) => text === part.text);
    if (exact >= 0) {
      consumed[exact] = true;
      continue;
    }
    // The same block, grown further on the live channel.
    const grown = match((text) => part.text.includes(text));
    if (grown >= 0) {
      merged[grown] = { type: part.type, text: part.text };
      consumed[grown] = true;
      continue;
    }
    // A fragment the durable page already contains (late subscription).
    const contained = match((text) => text.includes(part.text));
    if (contained >= 0) {
      consumed[contained] = true;
      continue;
    }
    // Genuinely new prose: one block, appended once.
    merged.push({ type: part.type, text: part.text });
    consumed.push(true);
  }
  return merged;
}

/** Viewport-safe popover placement for the anchored detail layer. Pure. */
export interface PopoverRect {
  top: number;
  left: number;
  width: number;
  height: number;
}
export interface PopoverPlacement {
  top: number;
  left: number;
  maxHeight: number;
  placement: "below" | "above";
}
export function computePopoverPlacement(
  anchor: PopoverRect,
  viewport: { width: number; height: number },
  popover: { width: number; height: number },
  gap = 8,
): PopoverPlacement {
  const width = Math.min(popover.width, Math.max(0, viewport.width - 16));
  let left = anchor.left;
  // Prefer aligning the popover's left edge with the anchor, then shift.
  if (left + width > viewport.width - 8) left = viewport.width - 8 - width;
  if (left < 8) left = 8;
  const belowTop = anchor.top + anchor.height + gap;
  const aboveTop = anchor.top - gap - popover.height;
  const belowFits = belowTop + popover.height <= viewport.height - 8;
  if (belowFits || aboveTop < 8) {
    const top = Math.max(8, Math.min(belowTop, viewport.height - 8));
    return {
      top,
      left,
      maxHeight: Math.max(96, viewport.height - top - 8),
      placement: "below",
    };
  }
  const top = Math.max(8, aboveTop);
  return { top, left, maxHeight: Math.max(96, anchor.top - gap - top), placement: "above" };
}
